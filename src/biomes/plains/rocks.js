// Boulders: schist and granite erratics, half sunk in the turf, clustered
// along the trail edges (where the path bends round them) and scattered across
// the plain. A few noise-displaced variants (flattened, faceted, split), shaded
// with the scanned rock textures projected three ways, lichen on the tops and
// a damp dark rim where they meet the ground. Near / far LODs re-bucketed on
// the CPU as you walk, like the scrub.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, mix, smoothstep, clamp, max, pow, abs, dot, normalize, length, attribute, varying, cameraPosition, texture, sin, cos
} from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U, applyFog } from '../../tsl/world.js';
import { landHeightJS, trailDistJS, lakeDistJS, gravelPatchJS, mountainHeightJS } from './terrain.js';
import { cloudShadowGround } from './index.js';
import { sunShadowAt } from './vox/sunshadow.js';
import { rng } from './grow.js';
import { stampRock, rockMaskDone } from './rockmask.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const LOD_DIST = 90, RADIUS = 1100;
const tex = ( n, srgb ) => {

	const t = new THREE.TextureLoader().load( new URL( `../../assets/plains/${ n }.webp`, import.meta.url ).href );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	if ( srgb ) t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	return t;

};

// One boulder, after the jose plant generator's granite blocks (Pinus cembra scene):
// a welded icosphere pulled onto a soft-min of ~12 fracture planes (a bottom, a
// tilted top, ten sides spiralling round), so the block has flat joint faces with
// rounded, weathered arrises instead of facets, plus two octaves of 3D noise.
const n3 = ( x, y, z ) => ( vnoiseJS( x + z * 0.71, y - z * 0.37 ) + vnoiseJS( y + 13.1 + z * 0.53, x - 7.7 ) ) * 0.5;
function boulder( seed, detail ) {

	const r = rng( seed );
	const R = ( a, b ) => a + ( b - a ) * r();
	const N = [ new THREE.Vector3( 0, - 1, 0 ) ], D = [ 0.5 ], up = R( 0, 6.28 );
	N.push( new THREE.Vector3( R( - 0.25, 0.25 ), 1, R( - 0.25, 0.25 ) ).normalize() ); D.push( R( 0.55, 0.75 ) );
	for ( let i = 0; i < 10; i ++ ) {

		const a = up + i * 2.39996 + R( - 0.3, 0.3 ), e = R( - 0.25, 0.75 );
		N.push( new THREE.Vector3( Math.cos( a ) * Math.cos( e ), Math.sin( e ), Math.sin( a ) * Math.cos( e ) ).normalize() );
		D.push( R( 0.75, 1.0 ) * ( 1 + 0.25 * Math.abs( Math.cos( a ) ) ) );

	}

	const g0 = new THREE.IcosahedronGeometry( 1, detail );
	g0.deleteAttribute( 'uv' ); g0.deleteAttribute( 'normal' );
	const g = mergeVertices( g0 ), p = g.attributes.position, v = new THREE.Vector3(), sd = R( 0, 50 ), k = 9;
	for ( let i = 0; i < p.count; i ++ ) {

		v.fromBufferAttribute( p, i );
		let acc = 0;
		for ( let j = 0; j < N.length; j ++ ) {

			const c = v.dot( N[ j ] );
			if ( c > 1e-3 ) acc += Math.exp( - k * D[ j ] / c );

		}

		let rr = acc > 0 ? - Math.log( acc ) / k : 2;
		rr = Math.min( rr, 1.6 ) * ( 1 + 0.05 * ( n3( v.x * 3 + sd, v.y * 3, v.z * 3 ) - 0.5 ) * 2 + 0.018 * ( n3( v.x * 9, v.y * 9 + sd, v.z * 9 ) - 0.5 ) * 2 );
		p.setXYZ( i, v.x * rr * 1.15, v.y * rr * 0.85, v.z * rr );

	}

	g.computeVertexNormals();
	const ig = new THREE.InstancedBufferGeometry();
	ig.index = g.index;
	ig.setAttribute( 'position', g.attributes.position );
	ig.setAttribute( 'normal', g.attributes.normal );
	return ig;

}

function scatter() {

	const out = [];
	const r = rng( 77001 );
	const cell = 6;
	const n = Math.ceil( RADIUS / cell );
	for ( let gx = - n; gx <= n; gx ++ ) for ( let gz = - n; gz <= n; gz ++ ) {

		const x = ( gx + r() ) * cell, z = ( gz + r() ) * cell;
		const d0 = Math.hypot( x, z ), roll = r(), sz = r(), yaw = r() * 6.283, tint = r();
		if ( d0 > RADIUS ) continue;
		const td = trailDistJS( x, z );
		if ( td < 0.9 || lakeDistJS( x, z ) < 4 || mountainHeightJS( x, z ) > 60 ) continue;
		// clusters along the trail edges, outcrops in drifts, a scatter everywhere
		const nearTrail = Math.exp( - Math.pow( ( td - 1.6 ) / 1.4, 2 ) ) * 0.35;
		const outcrop = Math.max( 0, vnoiseJS( x / 60 + 5, z / 60 + 2 ) - 0.62 ) * 1.6;
		const p = nearTrail + outcrop * 0.5 + gravelPatchJS( x, z ) * 0.25 + 0.006;
		if ( roll > p ) continue;
		// a few big glacial erratics (rust-brown, photo 3) among the smaller stones
		const erratic = roll < 0.0035 + outcrop * 0.004;
		const s = erratic ? 1.6 + sz * 1.8 : ( 0.25 + Math.pow( sz, 3 ) * 1.4 ) * ( outcrop > 0.1 ? 1.4 : 1 );
		out.push( x, landHeightJS( x, z ) - s * 0.28, z, s, yaw, erratic ? 0.95 : tint * 0.85, 0, 0 );
		stampRock( x, z, s * 0.95 );

	}

	rockMaskDone();
	return new Float32Array( out );

}

export class Rocks {

	constructor() {

		this.data = scatter();
		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		const T = { rock: tex( 'mossy_rock_c', true ), cliff: tex( 'granite_face_c', true ) };
		const mat = this.material( T );
		const V = 4, cnt = this.data.length / 8;
		this.meshes = [ 0, 1, 2, 3 ].map( ( v ) => [ 5, 3 ].map( ( detail ) => {

			const geo = boulder( 500 + v * 17, detail );
			const cap = Math.ceil( cnt / V * 1.6 ) + 32;
			const a = new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 );
			const b = new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 );
			a.setUsage( THREE.DynamicDrawUsage ); b.setUsage( THREE.DynamicDrawUsage );
			geo.setAttribute( 'iA', a ); geo.setAttribute( 'iB', b );
			geo.instanceCount = 0;
			const m = new THREE.Mesh( geo, mat );
			m.frustumCulled = false;
			m.renderOrder = 6;
			this.group.add( m );
			return m;

		} ) );
		console.log( `rocks: ${ cnt } boulders` );

	}

	material( T ) {

		const mat = new THREE.MeshBasicNodeMaterial();
		mat.fog = false;
		const vW = varying( vec3( 0 ), 'vRkW' ), vN = varying( vec3( 0 ), 'vRkN' ), vI = varying( vec3( 0 ), 'vRkI' );
		mat.positionNode = Fn( () => {

			const A = attribute( 'iA', 'vec4' ), B = attribute( 'iB', 'vec4' );
			const p = attribute( 'position', 'vec3' ).mul( A.w ), n = attribute( 'normal', 'vec3' );
			const c = cos( B.x ), s = sin( B.x );
			const rot = ( v ) => vec3( v.x.mul( c ).sub( v.z.mul( s ) ), v.y, v.x.mul( s ).add( v.z.mul( c ) ) );
			const w = A.xyz.add( rot( p ) );
			vW.assign( w ); vN.assign( normalize( rot( n ) ) );
			vI.assign( vec3( B.y, A.y, cloudShadowGround( A.xz ) ) );
			return w;

		} )();
		mat.colorNode = Fn( () => {

			const P = vW, N = normalize( vN );
			const w = pow( abs( N ), vec3( 4.0 ) ).toVar();
			w.divAssign( w.x.add( w.y ).add( w.z ) );
			const tri = ( t, sc ) => texture( t, P.zy.mul( sc ) ).mul( w.x ).add( texture( t, P.xz.mul( sc ) ).mul( w.y ) ).add( texture( t, P.xy.mul( sc ) ).mul( w.z ) );
			// scanned lichen-crusted granite (Poly Haven mossy_rock, via jose) on the
			// tops and faces; the steepest faces and undersides show bare grey granite
			const m = tri( T.rock, 0.42 ), g = tri( T.cliff, 0.35 );
			const lum = ( c ) => dot( c, vec3( 0.3, 0.55, 0.15 ) );
			const bare = vec3( lum( g.rgb ) ).mul( vec3( 0.98, 0.96, 0.92 ) ).mul( 0.62 );
			const lichen = m.rgb.mul( 0.9 );
			const top = smoothstep( - 0.35, 0.55, N.y );
			const alb = mix( bare, lichen, top.mul( mix( 0.55, 1.0, vI.x ) ) ).toVar();
			// cavities from the scan's height (alpha): darker cracks
			alb.mulAssign( mix( 0.6, 1.08, m.a ) );
			// erratics: a slightly warmer, rustier granite (subtle)
			alb.mulAssign( mix( vec3( 1.0 ), vec3( 1.08, 0.94, 0.82 ), smoothstep( 0.88, 0.92, vI.x ) ) );
			alb.mulAssign( mix( 0.55, 1.0, smoothstep( 0.0, 0.25, P.y.sub( vI.y ) ) ) );
			const L = U.sunDir;
			const diff = clamp( dot( N, L ), 0.0, 1.0 ).mul( vI.z ).mul( smoothstep( - 0.04, 0.06, L.y ) ).mul( sunShadowAt( P.add( N.mul( 0.05 ) ) ) );
			const amb = mix( U.groundAmb, U.skyAmb, N.y.mul( 0.5 ).add( 0.5 ) ).mul( 1.1 );
			return applyFog( alb.mul( U.sunColor.mul( diff ).add( amb ) ), P );

		} )();
		return mat;

	}

	update( renderer, camera ) {

		const cp = camera.position;
		if ( cp.distanceToSquared( this.lastPos ) < 9 ) return;
		this.lastPos.copy( cp );
		const d = this.data, L2 = LOD_DIST * LOD_DIST;
		const n = this.meshes.map( () => [ 0, 0 ] );
		for ( let i = 0; i < d.length; i += 8 ) {

			const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z;
			const r2 = dx * dx + dz * dz;
			if ( r2 > 400 * 400 ) continue; // small at that range: the ground texture carries them
			const l = r2 < L2 ? 0 : 1;
			const v = Math.floor( ( d[ i + 5 ] * 7.3 % 1 ) * 4 );
			const m = this.meshes[ v ][ l ];
			const a = m.geometry.attributes.iA.array, b = m.geometry.attributes.iB.array;
			if ( n[ v ][ l ] * 4 >= a.length ) continue;
			const k = ( n[ v ][ l ] ++ ) * 4;
			a[ k ] = d[ i ]; a[ k + 1 ] = d[ i + 1 ]; a[ k + 2 ] = d[ i + 2 ]; a[ k + 3 ] = d[ i + 3 ];
			b[ k ] = d[ i + 4 ]; b[ k + 1 ] = d[ i + 5 ]; b[ k + 2 ] = 0; b[ k + 3 ] = 0;

		}

		this.meshes.forEach( ( row, v ) => row.forEach( ( m, l ) => {

			m.geometry.instanceCount = n[ v ][ l ];
			m.visible = n[ v ][ l ] > 0;
			m.geometry.attributes.iA.needsUpdate = true;
			m.geometry.attributes.iB.needsUpdate = true;

		} ) );

	}

}
