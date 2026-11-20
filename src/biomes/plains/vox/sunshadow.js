// Sun shadows for the plains, cast by the plants. The voxel rasterizer splats every
// plant's voxels (with the same wind) into an orthographic depth map seen from the sun
// (raster.js: shadow passes); receivers look it up here. The voxels stand in for the
// leaves at every distance, so shadows are dappled like a crown's and sway in the wind.
//
// Depth key: atomicMax of the float bits of (1 - z), z the sun-view depth in 0..1, so the
// map keeps the caster nearest the sun.

import * as THREE from 'three/webgpu';
import { Fn, storage, uniform, float, vec2, vec4, uint, int, bitcast, clamp, smoothstep, max, min, select, If, Loop } from 'three/tsl';

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

// place the sun camera over the area in front of the viewer, snapped to whole texels
// (a shadow that slides with the camera shimmers at its edges)
export function updateSunCamera( camera, sunDir ) {

	const fwd = tmp.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
	fwd.y = 0; fwd.normalize();
	const c = tmp2.copy( camera.position ).addScaledVector( fwd, SH_EXT * 0.55 );
	const L = sunDir.clone().normalize();
	if ( L.y < 0.03 ) L.y = 0.03;
	cam.position.copy( c ).addScaledVector( L, 800 );
	cam.up.set( 0, 1, 0 );
	if ( Math.abs( L.y ) > 0.99 ) cam.up.set( 0, 0, 1 );
	cam.lookAt( c );
	cam.updateMatrixWorld( true );
	// snap: move the camera so the view-space origin lands on a texel
	const texel = SH_EXT * 2 / SH_N;
	const v = c.clone().applyMatrix4( cam.matrixWorldInverse );
	const dx = v.x - Math.round( v.x / texel ) * texel, dy = v.y - Math.round( v.y / texel ) * texel;
	const right = new THREE.Vector3().setFromMatrixColumn( cam.matrixWorld, 0 ), up = new THREE.Vector3().setFromMatrixColumn( cam.matrixWorld, 1 );
	cam.position.addScaledVector( right, dx ).addScaledVector( up, dy );
	cam.updateMatrixWorld( true );
	cam.updateProjectionMatrix();
	sunViewProj.value.multiplyMatrices( cam.projectionMatrix, cam.matrixWorldInverse );
	return cam;

}

// 0 (shadowed) .. 1 (lit) at a world position; soft 3x3 percentage-closer filter,
// fading out toward the map's edges
export const sunShadowAt = Fn( ( [ P ] ) => {

	const clip = sunViewProj.mul( vec4( P, 1.0 ) );
	const uvp = clip.xy.mul( 0.5 ).add( 0.5 );
	const z = clip.z;
	const r = float( 1.0 ).sub( z );
	const inside = uvp.x.greaterThan( 0.0 ).and( uvp.x.lessThan( 1.0 ) ).and( uvp.y.greaterThan( 0.0 ) ).and( uvp.y.lessThan( 1.0 ) );
	const lit = float( 1.0 ).toVar();
	If( inside.and( shadowOn.greaterThan( 0.5 ) ), () => {

		const px = uvp.mul( SH_N ).sub( 0.5 );
		const bias = float( 0.00018 );
		const acc = float( 0 ).toVar();
		for ( let j = - 1; j <= 1; j ++ ) for ( let i = - 1; i <= 1; i ++ ) {

			const x = clamp( px.x.add( i ).round(), 0.0, SH_N - 1 ), y = clamp( float( SH_N - 1 ).sub( px.y.add( j ).round() ), 0.0, SH_N - 1 );
			const s = bitcast( shadowRead.element( uint( y ).mul( uint( SH_N ) ).add( uint( x ) ) ), 'float' );
			acc.addAssign( select( s.greaterThan( r.add( bias ) ), float( 0.0 ), float( 1.0 ) ) );

		}

		const edge = smoothstep( 0.0, 0.08, min( min( uvp.x, uvp.y ), min( float( 1.0 ).sub( uvp.x ), float( 1.0 ).sub( uvp.y ) ) ) );
		lit.assign( mix1( acc.div( 9.0 ), edge ) );

	} );
	return lit;

} );

const mix1 = ( v, k ) => float( 1.0 ).sub( float( 1.0 ).sub( v ).mul( k ) );
