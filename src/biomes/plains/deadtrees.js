// The ghost forest: silver-white trunks of lenga (Nothofagus pumilio) killed
// by the park's fires, standing as bare snags and lying in tangles across the
// plains and up the hillsides.
//
// A handful of procedural variants (tall snag with broken limbs, short snag,
// stump, fallen log, branch tangle) are built once as tapered tubes, then
// instanced with random scale / yaw / lean. Instances are scattered on the CPU
// from the ghost-forest density field and bucketed into a detailed near LOD
// and a lean far LOD as you walk.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, pow, sin, cos, dot, normalize, length, attribute, varying,
	cameraPosition, abs, texture
} from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U, applyFog } from '../../tsl/world.js';
import { landHeightJS, ghostDensityJS, trailDistJS, lakeDistJS } from './terrain.js';
import { cloudShadowAt } from './index.js';
import { rng, growTree, Builder, decimate, breakLimbs } from './grow.js';

const LOD_DIST = [ 140, 520 ];
const RADIUS = 1300;

const V3 = THREE.Vector3;
const range = ( r, a, b ) => a + ( b - a ) * r();
const SIDES = [ [ 3, 3 ], [ 5, 3, 3 ], [ 8, 6, 4, 3 ] ]; // per detail level and branch level
const RINGS = [ 3, 6, 99 ];
const MAXLV = [ 1, 2, 3 ];

// Dead lenga (Nothofagus pumilio): a straight-ish trunk whose limbs spread
// wide and ascend, snapped off by the wind years after the fire. Grown once
// per variant, then turned into tubes at three levels of detail.
function growSnag( seed, tall ) {

	const r = rng( seed );
	const H = tall ? range( r, 5.5, 8.5 ) : range( r, 2.4, 4.2 );
	const R = tall ? range( r, 0.15, 0.22 ) : range( r, 0.12, 0.18 );
	const trunk = { p: new V3( 0, - 0.35, 0 ), d: new V3( range( r, - 0.12, 0.12 ), 1, range( r, - 0.12, 0.12 ) ), len: H, r: R };
	const br = growTree( r, {
		trunks: [ trunk ], floor: - 0.4,
		lv: [
			{ segs: 10, bend: 0.12, swirl: 0.1, taper: 0.7, flare: 0.9, curveV: 0.15 },
			{ dens: tall ? 1.1 : 1.0, range: [ 0.3, 0.92 ], down: [ 1.05, 0.3 ], len: [ 0.3, 0.55 ], up: 0.1, segs: 7, bend: 0.35, curveV: 0.3, rPow: 1.2, trop: [ 0, 0.05, 0 ] },
			{ dens: 2.2, range: [ 0.25, 1 ], down: [ 0.8, 0.35 ], len: [ 0.3, 0.6 ], segs: 4, bend: 0.4, curveV: 0.4 },
			{ dens: 3, range: [ 0.3, 1 ], down: [ 0.7, 0.3 ], len: [ 0.3, 0.5 ], segs: 3, minLen: 0.12, bend: 0.3 },
		],
	} );
	// the top is usually snapped off too
	return breakLimbs( br, r, [ tall ? 0.6 : 0.85, 0.6, 0.7, 0.85 ], [ 0.45, 0.95 ] );

}

function growLog( seed ) {

	const r = rng( seed );
	const L = range( r, 3, 8 ), R = range( r, 0.12, 0.22 );
	const br = growTree( r, {
		trunks: [ { p: new V3( - L / 2, R * 0.55, 0 ), d: new V3( 1, 0.0, range( r, - 0.1, 0.1 ) ), len: L, r: R } ], floor: R * 0.4,
		lv: [
			{ segs: 8, bend: 0.06, swirl: 0, taper: 0.55, trop: [ 0, - 0.03, 0 ] },
			{ dens: 0.8, range: [ 0.2, 0.9 ], down: [ 1.0, 0.4 ], len: [ 0.2, 0.4 ], up: 0.5, segs: 3, bend: 0.3 },
		],
	} );
	return breakLimbs( br, r, [ 0, 0.8 ], [ 0.3, 0.8 ] );

}

function growTangle( seed ) {

	const r = rng( seed );
	const trunks = [];
	const n = 3 + ( r() * 4 | 0 );
	for ( let i = 0; i < n; i ++ ) {

		const a = r() * Math.PI;
		trunks.push( { p: new V3( range( r, - 0.8, 0.8 ), range( r, 0.05, 0.3 ), range( r, - 0.8, 0.8 ) ), d: new V3( Math.cos( a ), range( r, 0.05, 0.25 ), Math.sin( a ) ), len: range( r, 1.2, 3.2 ), r: range( r, 0.04, 0.07 ) } );

	}

	const br = growTree( r, {
		trunks, floor: 0.04,
		lv: [ { segs: 5, bend: 0.3, taper: 0.7 }, { dens: 1.2, range: [ 0.3, 0.9 ], down: [ 0.8, 0.3 ], len: [ 0.25, 0.45 ], segs: 3, bend: 0.4 } ],
	} );
	return breakLimbs( br, r, [ 0.4, 0.6 ], [ 0.4, 0.9 ] );

}

function woodGeometry( branches, detail, seed ) {

	const B = new Builder();
	for ( const b of branches ) {

		if ( b.level > MAXLV[ detail ] ) continue;
		const sides = SIDES[ detail ][ Math.min( b.level, SIDES[ detail ].length - 1 ) ];
		const [ pts, rads ] = decimate( b.pts, b.rads, b.level === 0 ? Math.max( RINGS[ detail ], 3 ) : RINGS[ detail ] );
		const k = detail === 0 ? 1.35 : 1; // far: slightly thicker so trunks don't vanish
		// irregular cross-section: dead wood splits along the grain
		const ph = seed * 7 + b.level;
		const rFn = detail === 2 && b.level < 2 ? ( u, len ) => 1 + 0.07 * Math.sin( u * 6.283 * 5 + ph + len * 0.6 ) + 0.04 * Math.sin( u * 6.283 * 11 + len * 2.1 ) : null;
		B.tube( pts, rads.map( ( v ) => v * k ), sides, { cap: b.broken || b.kids.length === 0, rFn, seed: Math.min( 0.99, b.level * 0.25 + 0.01 ) } );

	}

	return B.geometry( true );

}

// variant table: grower, share of instances, scale range, placement
const VARIANTS = [
	{ grow: ( s ) => growSnag( s, true ), share: 0.26, scale: [ 0.8, 1.3 ], upright: true },
	{ grow: ( s ) => growSnag( s + 1, true ), share: 0.16, scale: [ 0.75, 1.2 ], upright: true },
	{ grow: ( s ) => growSnag( s + 2, false ), share: 0.3, scale: [ 0.7, 1.3 ], upright: true },
	{ grow: ( s ) => growLog( s + 4 ), share: 0.16, scale: [ 0.8, 1.3 ], upright: false, near: 600 },
	{ grow: ( s ) => growTangle( s + 5 ), share: 0.12, scale: [ 0.8, 1.5 ], upright: false, near: 350 },
];

function scatter( density = 1 ) {

	const out = VARIANTS.map( () => [] );
	const r = rng( 424242 );
	const cell = 7.5;
	const n = Math.ceil( RADIUS / cell );
	for ( let gx = - n; gx <= n; gx ++ ) for ( let gz = - n; gz <= n; gz ++ ) {

		const x = ( gx + r() ) * cell, z = ( gz + r() ) * cell;
		const d0 = Math.hypot( x, z );
		const roll = r(), pick = r();
		if ( d0 > RADIUS ) continue;
		const dens = ghostDensityJS( x, z );
		if ( roll > ( dens * 0.85 + 0.035 ) * density ) continue;
		if ( trailDistJS( x, z ) < 2.5 || lakeDistJS( x, z ) < 12 ) continue;
		let k = 0, acc = VARIANTS[ 0 ].share;
		while ( pick > acc && k < VARIANTS.length - 1 ) {

			k ++; acc += VARIANTS[ k ].share;

		}

		const V = VARIANTS[ k ];
		if ( V.near && d0 > V.near ) continue;
		const y = landHeightJS( x, z );
		// no trees on the steep high walls
		if ( y > 70 || ( d0 > 1000 && r() < 0.6 ) ) continue;
		const sc = V.scale[ 0 ] + ( V.scale[ 1 ] - V.scale[ 0 ] ) * r();
		const lean = V.upright ? ( r() - 0.5 ) * 0.22 : 0;
		out[ k ].push( x, y, z, sc, r() * Math.PI * 2, lean, r(), ( r() - 0.5 ) * 0.2 );

	}

	return out.map( ( a ) => new Float32Array( a ) );

}

export class DeadTrees {

	constructor() {

		const t0 = performance.now();
		this.data = scatter();
		this.density = 1;
		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		const mat = woodMaterial();
		this.meshes = VARIANTS.map( ( V, vi ) => {

			const br = V.grow( 1000 + vi * 31 );
			return [ 2, 1, 0 ].map( ( detail ) => {

			const geo = woodGeometry( br, detail, vi );
			const cap = Math.ceil( this.data[ vi ].length / 8 * 2.4 ) + 16;
			const a = new THREE.InstancedBufferAttribute( new Float32Array( Math.max( cap, 1 ) * 4 ), 4 );
			const b = new THREE.InstancedBufferAttribute( new Float32Array( Math.max( cap, 1 ) * 4 ), 4 );
			a.setUsage( THREE.DynamicDrawUsage ); b.setUsage( THREE.DynamicDrawUsage );
			geo.setAttribute( 'iA', a ); geo.setAttribute( 'iB', b );
			geo.instanceCount = 0;
			const mesh = new THREE.Mesh( geo, mat );
			mesh.frustumCulled = false;
			mesh.renderOrder = 7;
			this.group.add( mesh );
			return mesh;

			} );

		} );
		const n = this.data.reduce( ( s, d ) => s + d.length / 8, 0 );
		console.log( `trees: ${ n } ghost trees / logs (${ ( performance.now() - t0 ).toFixed( 0 ) } ms)` );

	}

	// re-scatter with a new density (0..2); buffers were sized for 2.4x the default
	setDensity( d ) {

		this.density = d;
		this.data = scatter( d );
		this.lastPos.set( 1e9, 0, 0 );

	}

	update( renderer, camera ) {

		const cp = camera.position;
		if ( cp.distanceToSquared( this.lastPos ) < 16 ) return;
		this.lastPos.copy( cp );
		const L0 = LOD_DIST[ 0 ] ** 2, L1 = LOD_DIST[ 1 ] ** 2;
		this.data.forEach( ( d, vi ) => {

			const ms = this.meshes[ vi ];
			const A = ms.map( ( m ) => m.geometry.attributes.iA.array ), B = ms.map( ( m ) => m.geometry.attributes.iB.array );
			const n = [ 0, 0, 0 ];
			for ( let i = 0; i < d.length; i += 8 ) {

				const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z;
				const r2 = dx * dx + dz * dz;
				const l = r2 < L0 ? 0 : r2 < L1 ? 1 : 2;
				if ( n[ l ] * 4 >= A[ l ].length ) continue;
				const k = ( n[ l ] ++ ) * 4;
				for ( let j = 0; j < 4; j ++ ) {

					A[ l ][ k + j ] = d[ i + j ]; B[ l ][ k + j ] = d[ i + 4 + j ];

				}

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

const BARK = ( () => {

	const t = new THREE.TextureLoader().load( new URL( '../../assets/plains/bark_willow_02_c.webp', import.meta.url ).href );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	return t;

} )();

function woodMaterial() {

	const mat = new THREE.MeshBasicNodeMaterial();
	mat.fog = false;
	const vW = varying( vec3( 0 ), 'vDW' );
	const vN = varying( vec3( 0 ), 'vDN' );
	const vWood = varying( vec4( 0 ), 'vDWood' );
	const vS = varying( vec2( 0 ), 'vDS' ); // seed, cloud

	mat.positionNode = Fn( () => {

		const A = attribute( 'iA', 'vec4' ); // x y z scale
		const B = attribute( 'iB', 'vec4' ); // yaw, lean, seed, roll
		const p = attribute( 'position', 'vec3' ).mul( A.w );
		const n = attribute( 'cnorm', 'vec3' );
		const cy = cos( B.x ), sy = sin( B.x ), cl = cos( B.y ), sl = sin( B.y );
		// lean about X, then yaw about Y
		const lean = ( v ) => vec3( v.x, v.y.mul( cl ).sub( v.z.mul( sl ) ), v.y.mul( sl ).add( v.z.mul( cl ) ) );
		const yaw = ( v ) => vec3( v.x.mul( cy ).sub( v.z.mul( sy ) ), v.y, v.x.mul( sy ).add( v.z.mul( cy ) ) );
		const world = A.xyz.add( yaw( lean( p ) ) );
		vW.assign( world );
		vN.assign( normalize( yaw( lean( n ) ) ) );
		const C = attribute( 'card', 'vec4' );
		vWood.assign( vec4( attribute( 'uv', 'vec2' ), C.y, 0 ) ); // around, along (m), branch level
		vS.assign( vec2( B.z, cloudShadowAt( A.xz, A.y ) ) );
		return world;

	} )();

	mat.colorNode = Fn( () => {

		const P = vW;
		const N = normalize( vN );
		const ang = vWood.x, len = vWood.y;
		const seed = vS.x;
		// scanned willow bark, bleached silver by years of sun and wind; the scan's
		// relief (alpha) darkens the cracks, long checks split the grain
		const tuv = vec2( ang.mul( 1.4 ).add( seed.mul( 3.0 ) ), len.mul( 0.45 ) );
		const bt = texture( BARK, tuv );
		const lum = dot( bt.rgb, vec3( 0.3, 0.5, 0.2 ) );
		const base = mix( vec3( 0.3, 0.3, 0.28 ), vec3( 0.72, 0.7, 0.66 ), smoothstep( 0.08, 0.5, lum ) ).mul( mix( 0.88, 1.08, seed ) ).toVar();
		base.mulAssign( mix( 0.55, 1.0, smoothstep( 0.15, 0.6, bt.a ) ) );
		const check = smoothstep( 0.74, 0.86, vnoise( vec2( ang.mul( 9.0 ), len.mul( 0.35 ) ).add( vec2( 11, 7 ) ) ) );
		base.mulAssign( float( 1.0 ).sub( check.mul( 0.5 ) ) );
		// earthy, weathered near the ground; orange lichen flecks
		const ground = smoothstep( 1.2, 0.0, P.y.sub( attribute( 'iA', 'vec4' ).y ) );
		base.assign( mix( base, vec3( 0.2, 0.17, 0.13 ), ground.mul( 0.45 ) ) );
		const lichen = smoothstep( 0.8, 0.9, vnoise( P.xz.mul( 6.0 ).add( vec2( P.y.mul( 5.0 ), 3 ) ) ) ).mul( 0.6 );
		base.assign( mix( base, vec3( 0.55, 0.32, 0.08 ), lichen.mul( 0.5 ) ) );

		const L = U.sunDir;
		const diff = clamp( dot( N, L ).add( 0.15 ).div( 1.15 ), 0.0, 1.0 );
		const sunVis = vS.y.mul( smoothstep( - 0.04, 0.06, L.y ) );
		const amb = mix( U.groundAmb, U.skyAmb, N.y.mul( 0.5 ).add( 0.5 ) );
		const V = normalize( cameraPosition.sub( P ) );
		const rim = pow( clamp( float( 1.0 ).sub( abs( dot( N, V ) ) ), 0.0, 1.0 ), 3.0 ).mul( 0.25 );
		const col = base.mul( U.sunColor.mul( diff ).mul( sunVis ).add( amb.mul( 1.1 ) ).add( U.sunColor.mul( rim ).mul( sunVis ).mul( 0.4 ) ) );
		return applyFog( col, P );

	} )();

	return mat;

}
