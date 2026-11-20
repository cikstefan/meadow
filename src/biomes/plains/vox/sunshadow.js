// Sun shadows for the plains, cast by the plants. The voxel rasterizer splats every
// plant's voxels (with the same wind) into an orthographic depth map seen from the sun
// (raster.js: shadow passes); receivers look it up here. The voxels stand in for the
// leaves at every distance, so shadows are dappled like a crown's and sway in the wind.
//
// Depth key: atomicMax of the float bits of (1 - z), z the sun-view depth in 0..1, so the
// map keeps the caster nearest the sun.

import * as THREE from 'three/webgpu';
import { Fn, storage, uniform, float, vec2, vec4, uint, int, bitcast, clamp, smoothstep, max, min, select, If, Loop, cos, sin, fract, dot, floor, screenCoordinate } from 'three/tsl';

export const SH_N = 2048, SH_EXT = 75; // texels, half extent (m) -> ~7 cm texels
const attr = new THREE.StorageBufferAttribute( new Uint32Array( SH_N * SH_N ), 1 );
export const shadowAtomic = storage( attr, 'uint', SH_N * SH_N ).toAtomic();
const shadowRead = storage( attr, 'uint', SH_N * SH_N ).toReadOnly();
export const sunViewProj = uniform( new THREE.Matrix4() );
export const shadowOn = uniform( 0 ); // 0 until the first map exists

const cam = new THREE.OrthographicCamera( - SH_EXT, SH_EXT, SH_EXT, - SH_EXT, 1, 1600 );
cam.coordinateSystem = THREE.WebGPUCoordinateSystem; // depth 0..1
cam.updateProjectionMatrix();
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

// Place the sun camera over the area around and ahead of the viewer. Stability is what
// matters (a shadow map that slides or turns by a fraction of a texel re-rasterizes every
// leaf a little differently, and the shadows crawl and flicker):
//  - the sun direction the map uses moves in small steps, not every frame;
//  - the map's centre moves in coarse steps of whole metres, not with every turn of the head;
//  - the centre is snapped to whole texels in the sun's own frame (world-fixed grid).
const Ls = new THREE.Vector3( 0, 1, 0 ), cs = new THREE.Vector3( 1e9, 0, 0 );
const STEP_ANGLE = 0, STEP_CENTRE = 6; // radians (0: the sun's direction follows smoothly), metres
export const shadowMoved = { v: true }; // the map's frame changed this frame
export function updateSunCamera( camera, sunDir ) {

	shadowMoved.v = false;
	const L = tmp.copy( sunDir ).normalize();
	if ( L.y < 0.03 ) { L.y = 0.03; L.normalize(); }
	if ( L.angleTo( Ls ) > STEP_ANGLE ) { Ls.copy( L ); shadowMoved.v = true; }
	const fwd = tmp2.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
	fwd.y = 0; if ( fwd.lengthSq() < 1e-6 ) fwd.set( 0, 0, - 1 ); fwd.normalize();
	const want = camera.position.clone().addScaledVector( fwd, SH_EXT * 0.4 );
	want.y = camera.position.y;
	if ( Math.hypot( want.x - cs.x, want.z - cs.z ) > STEP_CENTRE || Math.abs( want.y - cs.y ) > STEP_CENTRE ) {

		cs.set( Math.round( want.x / STEP_CENTRE ) * STEP_CENTRE, Math.round( want.y / STEP_CENTRE ) * STEP_CENTRE, Math.round( want.z / STEP_CENTRE ) * STEP_CENTRE );
		shadowMoved.v = true;

	}

	// the sun's frame: right / up / back(L), built from the stepped direction only
	const up0 = Math.abs( Ls.y ) > 0.99 ? new THREE.Vector3( 0, 0, 1 ) : new THREE.Vector3( 0, 1, 0 );
	const right = new THREE.Vector3().crossVectors( up0, Ls ).normalize();
	const up = new THREE.Vector3().crossVectors( Ls, right ).normalize();
	// snap the centre to whole texels on a grid fixed in the sun's frame
	const texel = SH_EXT * 2 / SH_N;
	const cr = Math.round( cs.dot( right ) / texel ) * texel, cu = Math.round( cs.dot( up ) / texel ) * texel, cl = cs.dot( Ls );
	const c = new THREE.Vector3().addScaledVector( right, cr ).addScaledVector( up, cu ).addScaledVector( Ls, cl );
	cam.position.copy( c ).addScaledVector( Ls, 800 );
	cam.quaternion.setFromRotationMatrix( new THREE.Matrix4().makeBasis( right, up, Ls ) );
	cam.updateMatrixWorld( true );
	cam.updateProjectionMatrix();
	sunViewProj.value.multiplyMatrices( cam.projectionMatrix, cam.matrixWorldInverse );
	return cam;

}

// the direction the map was made with (receivers offset along it)
export const shadowSunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
export function syncShadowDir() { shadowSunDir.value.copy( Ls ); }

// 0 (shadowed) .. 1 (lit) at a world position: a soft percentage-closer filter over a
// rotated 12-tap Poisson disc ~2.5 texels (~18 cm) across, so leaf shadows have soft,
// smooth edges instead of stair-stepped texels. The disc's rotation comes from `rot`
// (0..1): screen-space receivers pass a per-pixel noise that changes every frame (the
// temporal upscaler averages it into a clean blur); others get a fixed per-place rotation.
const DISC = [ [ - 0.326, - 0.406 ], [ - 0.840, - 0.074 ], [ - 0.696, 0.457 ], [ - 0.203, 0.621 ], [ 0.962, - 0.195 ], [ 0.473, - 0.480 ],
	[ 0.519, 0.767 ], [ 0.185, - 0.893 ], [ 0.507, 0.064 ], [ 0.896, 0.412 ], [ - 0.322, - 0.933 ], [ - 0.792, - 0.598 ] ];
const RADIUS = 2.5;
export const shadowFrame = uniform( 0 );
const shadowFn = Fn( ( [ P, rot ] ) => {

	const clip = sunViewProj.mul( vec4( P, 1.0 ) );
	const uvp = clip.xy.mul( 0.5 ).add( 0.5 );
	const z = clip.z;
	const r = float( 1.0 ).sub( z );
	const inside = uvp.x.greaterThan( 0.0 ).and( uvp.x.lessThan( 1.0 ) ).and( uvp.y.greaterThan( 0.0 ) ).and( uvp.y.lessThan( 1.0 ) );
	const lit = float( 1.0 ).toVar();
	If( inside.and( shadowOn.greaterThan( 0.5 ) ), () => {

		const px = uvp.x.mul( SH_N ), py = float( SH_N ).sub( uvp.y.mul( SH_N ) );
		const a = rot.mul( 6.2831853 );
		const ca = cos( a ).mul( RADIUS ), sa = sin( a ).mul( RADIUS );
		const bias = float( 0.00018 );
		const acc = float( 0 ).toVar();
		for ( const [ dx, dy ] of DISC ) {

			const ox = ca.mul( dx ).sub( sa.mul( dy ) ), oy = sa.mul( dx ).add( ca.mul( dy ) );
			const x = clamp( px.add( ox ).floor(), 0.0, SH_N - 1 ), y = clamp( py.add( oy ).floor(), 0.0, SH_N - 1 );
			const s = bitcast( shadowRead.element( uint( y ).mul( uint( SH_N ) ).add( uint( x ) ) ), 'float' );
			acc.addAssign( select( s.greaterThan( r.add( bias ) ), float( 0.0 ), float( 1.0 ) ) );

		}

		const edge = smoothstep( 0.0, 0.08, min( min( uvp.x, uvp.y ), min( float( 1.0 ).sub( uvp.x ), float( 1.0 ).sub( uvp.y ) ) ) );
		lit.assign( mix1( acc.div( DISC.length ), edge ) );

	} );
	return lit;

} );

// a fixed rotation per ~3 cm of ground (stable: no temporal noise)
const placeRot = ( P ) => fract( sin( dot( floor( P.xz.mul( 30.0 ) ), vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
// per pixel, new every frame (fragment shaders only)
export const frameRot = () => fract( fract( dot( screenCoordinate.xy.add( shadowFrame.mod( 64.0 ).mul( 5.588238 ) ), vec2( 0.06711056, 0.00583715 ) ) ).mul( 52.9829189 ) );
export const sunShadowAt = ( P, rot = null ) => shadowFn( P, rot ?? placeRot( P ) );

const mix1 = ( v, k ) => float( 1.0 ).sub( float( 1.0 ).sub( v ).mul( k ) );
