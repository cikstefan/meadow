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
import { cloudShadowAt } from './index.js';
import { rng } from './grow.js';

const LOD_DIST = 90, RADIUS = 1100;
const tex = ( n, srgb ) => {

	const t = new THREE.TextureLoader().load( new URL( `../../assets/plains/${ n }.webp`, import.meta.url ).href );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	if ( srgb ) t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	return t;

};

// one boulder: an icosphere pushed around by noise, squashed, with flat fracture faces
function boulder( seed, detail ) {

	const r = rng( seed );
	const g = new THREE.IcosahedronGeometry( 1, detail );
	const p = g.attributes.position;
	const sx = 0.8 + r() * 0.6, sy = 0.45 + r() * 0.35, sz = 0.7 + r() * 0.5;
	const cuts = [ 0, 1, 2 ].map( () => new THREE.Vector3( r() - 0.5, r() * 0.6 - 0.1, r() - 0.5 ).normalize() );
	const o = r() * 100;
	for ( let i = 0; i < p.count; i ++ ) {

		const v = new THREE.Vector3( p.getX( i ), p.getY( i ), p.getZ( i ) );
		let k = 1 + 0.22 * ( vnoiseJS( v.x * 1.7 + o, v.z * 1.7 + v.y * 1.3 ) - 0.5 ) + 0.08 * ( vnoiseJS( v.x * 5 + o, v.y * 5 - v.z * 3 ) - 0.5 );
		// fracture planes: clamp the surface to a few flat faces
		for ( const c of cuts ) k = Math.min( k, ( 0.72 + r() * 0.0 ) / Math.max( 0.05, v.dot( c ) ) );
		v.multiplyScalar( k );
		p.setXYZ( i, v.x * sx, v.y * sy, v.z * sz );

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
		const s = ( 0.25 + Math.pow( sz, 3 ) * 1.4 ) * ( outcrop > 0.1 ? 1.4 : 1 );
		out.push( x, landHeightJS( x, z ) - s * 0.28, z, s, yaw, tint, 0, 0 );

	}

	return new Float32Array( out );

}

export class Rocks {

	constructor() {

		this.data = scatter();
		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		const T = { rock: tex( 'dry_ground_rocks_c', true ), cliff: tex( 'cliff_side_c', true ), n: tex( 'cliff_side_n' ) };
		const mat = this.material( T );
		const V = 4, cnt = this.data.length / 8;
		this.meshes = [ 0, 1, 2, 3 ].map( ( v ) => [ 3, 1 ].map( ( detail ) => {

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
			vI.assign( vec3( B.y, A.y, cloudShadowAt( A.xz, A.y ) ) );
			return w;

		} )();
		mat.colorNode = Fn( () => {

			const P = vW, N = normalize( vN );
			const w = pow( abs( N ), vec3( 4.0 ) ).toVar();
			w.divAssign( w.x.add( w.y ).add( w.z ) );
			const tri = ( t, sc ) => texture( t, P.zy.mul( sc ) ).mul( w.x ).add( texture( t, P.xz.mul( sc ) ).mul( w.y ) ).add( texture( t, P.xy.mul( sc ) ).mul( w.z ) );
			const a = tri( T.cliff, 0.45 ), b = tri( T.rock, 0.6 );
			const lum = ( c ) => dot( c, vec3( 0.3, 0.55, 0.15 ) );
			// grey schist / pale granite, per boulder
			const grey = mix( vec3( lum( a.rgb ) ).mul( vec3( 0.95, 0.93, 0.9 ) ).mul( 0.55 ), vec3( lum( b.rgb ) ).mul( vec3( 1.0, 0.97, 0.92 ) ).mul( 0.62 ), vI.x );
			const alb = grey.mul( mix( 0.75, 1.1, a.a ) ).toVar();
			// yellow-green and orange lichen on the tops, a damp dark band at the ground
			const lich = smoothstep( 0.55, 0.75, vnoise( P.xz.mul( 3.0 ).add( P.y ) ) ).mul( smoothstep( 0.3, 0.9, N.y ) );
			alb.assign( mix( alb, mix( vec3( 0.3, 0.32, 0.12 ), vec3( 0.5, 0.3, 0.08 ), vnoise( P.xz.mul( 9.0 ) ) ), lich.mul( 0.55 ) ) );
			alb.mulAssign( mix( 0.55, 1.0, smoothstep( 0.0, 0.25, P.y.sub( vI.y ) ) ) );
			const L = U.sunDir;
			const diff = clamp( dot( N, L ).add( 0.1 ).div( 1.1 ), 0.0, 1.0 ).mul( vI.z ).mul( smoothstep( - 0.04, 0.06, L.y ) );
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
