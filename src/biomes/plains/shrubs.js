// Patagonian scrub: notro (Chilean firebush) in scarlet bloom, calafate with
// tiny yellow flowers, dark mata negra and spiny grey mata barrosa cushions.
//
// Each bush is a cloud of small alpha-tested cards (leaf sprigs / flower
// clusters from the procedural atlas) filling an ellipsoid canopy; one
// instanced draw per species and LOD. Instances are scattered once on the CPU
// from the biome's fields and re-bucketed into near / far LODs as you walk.
// The vertex shader sways each bush with the travelling gusts and flutters its
// outer sprigs; lighting uses the shared foliage model with a canopy normal
// (bushes read as soft volumes, lit and translucent toward the sun).

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, pow, sin, cos, dot, normalize, length, attribute, varying,
	cameraPosition, faceDirection, texture, uv, select, uniform
} from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U, shadeFoliage } from '../../tsl/world.js';
import { landHeightJS, shrubDensityJS, trailDistJS, lakeDistJS, gravelPatchJS } from './terrain.js';
import { cloudShadowAt } from './index.js';
import { buildFoliageAtlas } from './atlas.js';

// height range (m), width / height, cards per LOD, card size (fraction of height), atlas tiles
const SPECIES = [
	{ name: 'notro', h: [ 1.0, 2.6 ], aspect: 1.05, cards: [ 260, 40, 9 ], card: 0.3, leaf: 0, flower: 1, bloom: 0.5, tint: [ 1, 1, 1 ] },
	{ name: 'calafate', h: [ 0.55, 1.25 ], aspect: 1.25, cards: [ 170, 26, 7 ], card: 0.32, leaf: 2, flower: 3, bloom: 0.55, tint: [ 1, 1, 1 ] },
	{ name: 'mata negra', h: [ 0.4, 0.95 ], aspect: 1.35, cards: [ 130, 20, 6 ], card: 0.34, leaf: 4, flower: 4, bloom: 0, tint: [ 1, 1, 1 ] },
	{ name: 'mata barrosa', h: [ 0.22, 0.5 ], aspect: 1.9, cards: [ 70, 12, 4 ], card: 0.42, leaf: 5, flower: 5, bloom: 0, tint: [ 1, 1, 1 ] },
];

const LOD_DIST = [ 75, 330 ]; // m: detailed / mid / far card clouds
const RADIUS = 1050; // scatter radius around the origin

function rng( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

// card cloud in unit space: height 0..1, radius 0.5 * aspect
function bushGeometry( sp, cards, cardScale, seed ) {

	const r = rng( seed );
	const pos = [], uvs = [], card = [], cn = [], idx = [];
	const R0 = 0.5 * sp.aspect;
	// 2-4 overlapping lobes -> irregular mounds instead of balls
	const nl = 2 + ( r() * 3 | 0 );
	const lobes = [];
	for ( let l = 0; l < nl; l ++ ) {

		const a = r() * Math.PI * 2, o = l === 0 ? 0 : R0 * ( 0.35 + r() * 0.35 );
		lobes.push( { x: Math.cos( a ) * o, z: Math.sin( a ) * o, s: l === 0 ? 1 : 0.6 + r() * 0.35, h: l === 0 ? 1 : 0.65 + r() * 0.35 } );

	}

	for ( let i = 0; i < cards; i ++ ) {

		const lb = lobes[ Math.min( nl - 1, Math.floor( Math.pow( r(), 1.3 ) * nl ) ) ];
		const R = R0 * lb.s * 0.8;
		// mostly in an outer shell, upper part of an ellipsoid sitting on the ground
		const u = r(), v = r();
		const th = u * Math.PI * 2;
		const ph = Math.acos( 1 - v * 1.15 ); // biased to the top
		const shell = 0.55 + 0.45 * Math.pow( r(), 0.5 );
		const nx = Math.sin( ph ) * Math.cos( th ), ny = Math.cos( ph ), nz = Math.sin( ph ) * Math.sin( th );
		const cx = lb.x + nx * R * shell, cy = ( 0.42 + ny * 0.58 * shell ) * lb.h, cz = lb.z + nz * R * shell;
		const t = Math.min( 1, Math.max( 0, cy ) );
		// card plane: faces roughly outward, random roll
		const n = new THREE.Vector3( nx + ( r() - 0.5 ) * 0.9, ny * 0.6 + ( r() - 0.3 ) * 0.6, nz + ( r() - 0.5 ) * 0.9 ).normalize();
		const tmp = Math.abs( n.y ) < 0.9 ? new THREE.Vector3( 0, 1, 0 ) : new THREE.Vector3( 1, 0, 0 );
		const ax = new THREE.Vector3().crossVectors( tmp, n ).normalize();
		const ay = new THREE.Vector3().crossVectors( n, ax ).normalize();
		const roll = ( r() - 0.5 ) * 1.2;
		const a1 = ax.clone().multiplyScalar( Math.cos( roll ) ).addScaledVector( ay, Math.sin( roll ) );
		const a2 = ay.clone().multiplyScalar( Math.cos( roll ) ).addScaledVector( ax, - Math.sin( roll ) );
		const s = sp.card * cardScale * ( 0.75 + r() * 0.5 );
		const flowerCand = sp.bloom > 0 && t > 0.35 && shell > 0.72 && r() < 0.9 ? 1 : 0;
		const seedc = r();
		const base = pos.length / 3;
		for ( const [ qx, qy ] of [ [ - 0.5, - 0.5 ], [ 0.5, - 0.5 ], [ 0.5, 0.5 ], [ - 0.5, 0.5 ] ] ) {

			pos.push( cx + ( a1.x * qx + a2.x * qy ) * s, cy + ( a1.y * qx + a2.y * qy ) * s, cz + ( a1.z * qx + a2.z * qy ) * s );
			uvs.push( qx + 0.5, 0.5 - qy );
			card.push( flowerCand, seedc, shell, t );
			cn.push( n.x, n.y, n.z );

		}

		idx.push( base, base + 1, base + 2, base, base + 2, base + 3 );

	}

	const g = new THREE.InstancedBufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	g.setAttribute( 'card', new THREE.Float32BufferAttribute( card, 4 ) );
	g.setAttribute( 'cnorm', new THREE.Float32BufferAttribute( cn, 3 ) );
	g.setIndex( idx );
	return g;

}

// scatter every species once (deterministic)
function scatter() {

	const out = SPECIES.map( () => [] );
	const cell = 4.2;
	const n = Math.ceil( RADIUS / cell );
	const r = rng( 1234567 );
	for ( let gx = - n; gx <= n; gx ++ ) for ( let gz = - n; gz <= n; gz ++ ) {

		const x = ( gx + r() ) * cell, z = ( gz + r() ) * cell;
		const d0 = Math.hypot( x, z );
		if ( d0 > RADIUS ) continue;
		const dens = shrubDensityJS( x, z );
		const pick = r(), roll = r();
		if ( trailDistJS( x, z ) < 1.7 || lakeDistJS( x, z ) < 10 ) continue;
		const gravel = gravelPatchJS( x, z );
		// species mix shifts across the plain (low-frequency noise)
		const m = vnoiseJS( x / 120 + 3, z / 120 + 8 );
		const w = [
			dens * ( 0.35 + 0.65 * m ) * 0.55, // notro thickets
			( 0.12 + dens * 0.3 ) * ( 1.1 - m * 0.5 ), // calafate everywhere, sparser
			( 0.1 + dens * 0.35 ) * 0.8, // mata negra
			( 0.06 + gravel * 0.5 ) * 0.9, // mata barrosa on dry gravel
		];
		const total = w.reduce( ( a, b ) => a + b, 0 );
		// overall acceptance: a lot of open grassland between bushes
		if ( roll > total * 0.32 ) continue;
		let k = 0, acc = w[ 0 ] / total;
		while ( pick > acc && k < 3 ) {

			k ++; acc += w[ k ] / total;

		}

		const sp = SPECIES[ k ];
		const hh = sp.h[ 0 ] + ( sp.h[ 1 ] - sp.h[ 0 ] ) * Math.pow( r(), 0.8 ) * ( 0.7 + dens * 0.5 );
		const y = landHeightJS( x, z );
		const bloom = sp.bloom > 0 ? Math.min( 1, sp.bloom * ( 0.55 + r() * 0.9 ) ) : 0;
		out[ k ].push( x, y - hh * 0.04, z, hh, r() * Math.PI * 2, bloom, r(), 0.85 + r() * 0.3 );

	}

	return out.map( ( a ) => new Float32Array( a ) );

}

export class Shrubs {

	constructor() {

		const t0 = performance.now();
		this.atlas = buildFoliageAtlas();
		this.data = scatter();
		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		this.meshes = SPECIES.map( ( sp, si ) => [ 0, 1, 2 ].map( ( lod ) => {

			const geo = bushGeometry( sp, sp.cards[ lod ], [ 1, 1.85, 3.4 ][ lod ], 99 + si * 7 + lod );
			const cap = this.data[ si ].length / 8;
			const a = new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 );
			const b = new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 );
			a.setUsage( THREE.DynamicDrawUsage ); b.setUsage( THREE.DynamicDrawUsage );
			geo.setAttribute( 'iA', a ); geo.setAttribute( 'iB', b );
			geo.instanceCount = 0;
			const mesh = new THREE.Mesh( geo, this.material( sp, lod ) );
			mesh.frustumCulled = false;
			mesh.renderOrder = 8;
			this.group.add( mesh );
			return mesh;

		} ) );
		const counts = this.data.map( ( d, i ) => `${ SPECIES[ i ].name } ${ d.length / 8 }` ).join( ', ' );
		console.log( `shrubs: ${ counts } (${ ( performance.now() - t0 ).toFixed( 0 ) } ms)` );

	}

	material( sp, lod ) {

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;
		mat.alphaToCoverage = true;
		mat.alphaTest = 0.35;
		const vW = varying( vec3( 0 ), 'vSW' );
		const vN = varying( vec3( 0 ), 'vSN' );
		const vC = varying( vec4( 0 ), 'vSC' ); // tile, shell, t, cloud
		const vT = varying( vec3( 1 ), 'vST' ); // instance tint
		const tex = this.atlas.texture;
		const cols = this.atlas.cols, rows = this.atlas.rows;

		mat.positionNode = Fn( () => {

			const A = attribute( 'iA', 'vec4' ); // x, y, z, height
			const B = attribute( 'iB', 'vec4' ); // yaw, bloom, seed, width jitter
			const C = attribute( 'card', 'vec4' ); // flower candidate, seed, shell, t
			const p = attribute( 'position', 'vec3' );
			const n0 = attribute( 'cnorm', 'vec3' );
			const h = A.w;
			const cy = cos( B.x ), sy = sin( B.x );
			const rot = ( v ) => vec3( v.x.mul( cy ).sub( v.z.mul( sy ) ), v.y, v.x.mul( sy ).add( v.z.mul( cy ) ) );
			const local = rot( vec3( p.x.mul( B.w ), p.y, p.z.mul( B.w ) ) ).mul( h );
			const base = A.xyz;

			// wind: whole-bush sway with the travelling gusts + flutter of outer sprigs
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const gust = vnoise( base.xz.sub( U.windOffset ).div( 13.0 ) ).mul( 0.7 ).add( 0.3 );
			const wAmt = U.windStrength.mul( gust );
			const hk = pow( clamp( p.y, 0.0, 1.0 ), 1.6 );
			const sway = sin( U.time.mul( mix( 1.3, 2.1, B.z ) ).add( B.z.mul( 30.0 ) ).add( dot( base.xz, U.windDir ).mul( 0.2 ) ) ).mul( 0.35 ).add( 0.65 );
			const flutter = sin( U.time.mul( mix( 7.0, 13.0, C.y ) ).add( C.y.mul( 60.0 ) ) ).mul( C.z ).mul( 0.6 );
			const disp = W.mul( wAmt.mul( sway ).mul( hk ).mul( h ).mul( 0.09 ) )
				.add( normalize( n0 ).mul( flutter.mul( wAmt ).mul( 0.03 ).mul( h ) ) )
				.add( vec3( 0, - 1, 0 ).mul( wAmt.mul( hk ).mul( h ).mul( 0.02 ) ) );
			const world = base.add( local ).add( disp );

			// canopy normal: outward from the bush centre, blended with the card's own
			const centre = base.add( vec3( 0, h.mul( 0.45 ), 0 ) );
			const radial = normalize( world.sub( centre ).mul( vec3( 1, 1.6, 1 ) ) );
			vN.assign( normalize( mix( rot( n0 ), radial, 0.72 ) ) );
			vW.assign( world );
			// flower cards bloom according to the bush's bloom amount
			const isFlower = C.x.greaterThan( 0.5 ).and( C.y.lessThan( B.y ) );
			const tile = select( isFlower, float( sp.flower ), float( sp.leaf ) );
			vC.assign( vec4( tile, C.z, C.w, cloudShadowAt( base.xz, base.y ) ) );
			vT.assign( mix( vec3( 0.82, 0.86, 0.78 ), vec3( 1.12, 1.08, 1.02 ), B.z ) );
			return world;

		} )();

		// atlas lookup
		const tileUV = Fn( () => {

			const t = vC.x;
			const col = t.mod( cols ), row = t.div( cols ).floor();
			return vec2( col.add( uv().x ), row.add( uv().y ) ).div( vec2( cols, rows ) );

		} );
		const sample = texture( tex, tileUV() );
		// keep coverage at small mip levels (averaged alpha would fall below the cutoff)
		const dist = length( vW.sub( cameraPosition ) );
		mat.opacityNode = sample.a.mul( float( 1.0 ).add( smoothstep( 6.0, 160.0, dist ).mul( 2.2 ) ) );

		mat.colorNode = Fn( () => {

			const albedo = sample.rgb.mul( vT ).toVar();
			const shell = vC.y, t = vC.z;
			const N = normalize( vN ).mul( faceDirection.mul( 0.3 ).add( 0.7 ) );
			const ao = mix( 0.28, 1.0, smoothstep( 0.5, 1.0, shell ) ).mul( mix( 0.55, 1.0, t ) );
			const isFlower = vC.x.equal( float( sp.flower ) ).and( float( sp.bloom ).greaterThan( 0 ) );
			const transmit = select( isFlower, float( 0.8 ), float( 0.45 ) );
			const spec = select( isFlower, float( 0.05 ), float( 0.14 ) ); // notro leaves are glossy
			return shadeFoliage( albedo, N, vW, ao, vC.w, transmit, spec, float( 0.35 ), vec3( 0 ) );

		} )();

		return mat;

	}

	// re-bucket instances into the near / far LOD when the camera has moved
	update( renderer, camera ) {

		const cp = camera.position;
		if ( cp.distanceToSquared( this.lastPos ) < 9 ) return;
		this.lastPos.copy( cp );
		const L0 = LOD_DIST[ 0 ] ** 2, L1 = LOD_DIST[ 1 ] ** 2;
		this.data.forEach( ( d, si ) => {

			const ms = this.meshes[ si ];
			const A = ms.map( ( m ) => m.geometry.attributes.iA.array ), B = ms.map( ( m ) => m.geometry.attributes.iB.array );
			const n = [ 0, 0, 0 ];
			for ( let i = 0; i < d.length; i += 8 ) {

				const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z;
				const r2 = dx * dx + dz * dz;
				const l = r2 < L0 ? 0 : r2 < L1 ? 1 : 2;
				const a = A[ l ], b = B[ l ], k = ( n[ l ] ++ ) * 4;
				a[ k ] = d[ i ]; a[ k + 1 ] = d[ i + 1 ]; a[ k + 2 ] = d[ i + 2 ]; a[ k + 3 ] = d[ i + 3 ];
				b[ k ] = d[ i + 4 ]; b[ k + 1 ] = d[ i + 5 ]; b[ k + 2 ] = d[ i + 6 ]; b[ k + 3 ] = d[ i + 7 ];

			}

			ms.forEach( ( m, l ) => {

				m.geometry.instanceCount = n[ l ];
				m.visible = n[ l ] > 0;
				m.geometry.attributes.iA.needsUpdate = true;
				m.geometry.attributes.iB.needsUpdate = true;

			} );

		} );

	}

}
