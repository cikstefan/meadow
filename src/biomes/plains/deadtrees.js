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
	cameraPosition, abs
} from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U, applyFog } from '../../tsl/world.js';
import { landHeightJS, ghostDensityJS, trailDistJS, lakeDistJS } from './terrain.js';
import { cloudShadowAt } from './index.js';

const LOD_DIST = [ 140, 520 ];
const RADIUS = 1300;

function rng( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

// --- tube builder: polyline with radii -> rings (attributes: position, normal, wood = (length m, angle, radius, tip))
class Builder {

	constructor() {

		this.pos = []; this.nrm = []; this.wood = []; this.idx = [];

	}

	tube( pts, radii, sides, cap = true ) {

		const base = this.pos.length / 3;
		let len = 0;
		const n = pts.length;
		let prevN = null;
		for ( let i = 0; i < n; i ++ ) {

			const p = pts[ i ];
			const t = new THREE.Vector3().subVectors( pts[ Math.min( i + 1, n - 1 ) ], pts[ Math.max( i - 1, 0 ) ] ).normalize();
			if ( i > 0 ) len += p.distanceTo( pts[ i - 1 ] );
			// stable frame
			let nx = prevN ? prevN.clone().sub( t.clone().multiplyScalar( prevN.dot( t ) ) ) : new THREE.Vector3( 1, 0, 0 ).sub( t.clone().multiplyScalar( t.x ) );
			if ( nx.lengthSq() < 1e-6 ) nx = new THREE.Vector3( 0, 0, 1 ).sub( t.clone().multiplyScalar( t.z ) );
			nx.normalize();
			prevN = nx;
			const ny = new THREE.Vector3().crossVectors( t, nx );
			for ( let k = 0; k <= sides; k ++ ) {

				const a = k / sides * Math.PI * 2;
				// irregular, fluted cross-section
				const fl = 1 + 0.12 * Math.sin( a * 3 + i * 0.7 ) + 0.06 * Math.sin( a * 7 );
				const d = nx.clone().multiplyScalar( Math.cos( a ) ).addScaledVector( ny, Math.sin( a ) );
				const q = p.clone().addScaledVector( d, radii[ i ] * fl );
				this.pos.push( q.x, q.y, q.z );
				this.nrm.push( d.x, d.y, d.z );
				this.wood.push( len, k / sides, radii[ i ], i / ( n - 1 ) );

			}

		}

		for ( let i = 0; i < n - 1; i ++ ) for ( let k = 0; k < sides; k ++ ) {

			const a = base + i * ( sides + 1 ) + k, b = a + sides + 1;
			this.idx.push( a, b, a + 1, a + 1, b, b + 1 );

		}

		if ( cap ) {

			// jagged broken end: collapse the last ring to a ragged point
			const last = base + ( n - 1 ) * ( sides + 1 );
			const tip = pts[ n - 1 ];
			const c = this.pos.length / 3;
			this.pos.push( tip.x, tip.y + radii[ n - 1 ] * 0.8, tip.z );
			this.nrm.push( 0, 1, 0 );
			this.wood.push( len + radii[ n - 1 ], 0, 0, 1 );
			for ( let k = 0; k < sides; k ++ ) this.idx.push( last + k, c, last + k + 1 );

		}

	}

	geometry() {

		const g = new THREE.InstancedBufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.pos, 3 ) );
		g.setAttribute( 'normal', new THREE.Float32BufferAttribute( this.nrm, 3 ) );
		g.setAttribute( 'wood', new THREE.Float32BufferAttribute( this.wood, 4 ) );
		g.setIndex( this.idx );
		return g;

	}

}

// a limb from p0 in direction dir, bending, tapering
function limb( b, r, p0, dir, L, r0, r1, segs, sides, droop = 0.0, wiggle = 0.25 ) {

	const pts = [], rad = [];
	const d = dir.clone().normalize();
	const p = p0.clone();
	for ( let i = 0; i <= segs; i ++ ) {

		pts.push( p.clone() );
		rad.push( r0 + ( r1 - r0 ) * ( i / segs ) );
		d.x += ( r() - 0.5 ) * wiggle; d.z += ( r() - 0.5 ) * wiggle; d.y += ( r() - 0.5 ) * wiggle * 0.6 - droop;
		d.normalize();
		p.addScaledVector( d, L / segs );

	}

	b.tube( pts, rad, sides );
	return pts;

}

// --- variants (unit: metres at scale 1)
function snag( seed, detail, tall ) {

	const r = rng( seed );
	const b = new Builder();
	const H = tall ? 6 + r() * 3 : 2.4 + r() * 1.8;
	const R = tall ? 0.16 + r() * 0.06 : 0.13 + r() * 0.06;
	const sides = [ 3, 4, 8 ][ detail ];
	const trunk = limb( b, r, new THREE.Vector3( 0, - 0.3, 0 ), new THREE.Vector3( ( r() - 0.5 ) * 0.15, 1, ( r() - 0.5 ) * 0.15 ), H, R, R * 0.35, [ 2, 4, 8 ][ detail ], sides, 0, 0.12 );
	// buttress flare at the base
	if ( detail === 2 ) b.tube( [ new THREE.Vector3( 0, - 0.3, 0 ), new THREE.Vector3( 0, 0.35, 0 ) ], [ R * 1.6, R * 1.05 ], sides, false );
	const limbs = detail === 0 ? ( tall ? 2 : 0 ) : tall ? 3 + ( r() * 4 | 0 ) : 1 + ( r() * 2 | 0 );
	for ( let i = 0; i < limbs; i ++ ) {

		const k = 0.35 + r() * 0.55;
		const at = trunk[ Math.min( trunk.length - 1, Math.round( k * ( trunk.length - 1 ) ) ) ];
		const a = r() * Math.PI * 2;
		const up = 0.35 + r() * 0.9; // lenga limbs spread wide, slightly up
		const L = ( tall ? 1.2 + r() * 2.2 : 0.5 + r() * 1.0 ) * ( 1.1 - k * 0.5 );
		const pts = limb( b, r, at, new THREE.Vector3( Math.cos( a ), up, Math.sin( a ) ), L, R * ( 0.45 - k * 0.2 ), R * 0.08, detail ? 4 : 1, [ 3, 3, 5 ][ detail ], 0.03 );
		// a broken twig or two
		if ( detail === 2 && r() < 0.7 ) {

			const a2 = a + ( r() - 0.5 ) * 1.6;
			limb( b, r, pts[ 2 ] || pts[ pts.length - 1 ], new THREE.Vector3( Math.cos( a2 ), 0.8 + r(), Math.sin( a2 ) ), L * 0.45, R * 0.1, R * 0.03, 2, 4, 0 );

		}

	}

	return b.geometry();

}

function stump( seed, detail ) {

	const r = rng( seed );
	const b = new Builder();
	const H = 0.5 + r() * 1.1, R = 0.2 + r() * 0.12;
	limb( b, r, new THREE.Vector3( 0, - 0.25, 0 ), new THREE.Vector3( ( r() - 0.5 ) * 0.3, 1, ( r() - 0.5 ) * 0.3 ), H, R, R * 0.75, detail ? 3 : 1, [ 3, 5, 9 ][ detail ], 0, 0.2 );
	return b.geometry();

}

function log( seed, detail ) {

	const r = rng( seed );
	const b = new Builder();
	const L = 3 + r() * 5, R = 0.12 + r() * 0.1;
	const sides = [ 3, 4, 7 ][ detail ];
	const pts = limb( b, r, new THREE.Vector3( - L / 2, R * 0.55, 0 ), new THREE.Vector3( 1, 0.02, ( r() - 0.5 ) * 0.2 ), L, R, R * 0.45, [ 1, 3, 6 ][ detail ], sides, 0.004, 0.08 );
	const stubs = detail === 0 ? 0 : 1 + ( r() * 4 | 0 );
	for ( let i = 0; i < stubs; i ++ ) {

		const at = pts[ 1 + ( r() * ( pts.length - 2 ) | 0 ) ];
		const a = ( r() - 0.5 ) * 2.4;
		limb( b, r, at, new THREE.Vector3( Math.sin( a ) * 0.5, 0.4 + r() * 0.8, Math.cos( a ) ), 0.4 + r() * 1.3, R * 0.35, R * 0.08, 2, detail === 2 ? 4 : 3, 0.02 );

	}

	return b.geometry();

}

function tangle( seed, detail ) {

	const r = rng( seed );
	const b = new Builder();
	const n = detail === 0 ? 2 : 3 + ( r() * 4 | 0 );
	for ( let i = 0; i < n; i ++ ) {

		const a = r() * Math.PI;
		limb( b, r, new THREE.Vector3( ( r() - 0.5 ) * 1.5, 0.05 + r() * 0.2, ( r() - 0.5 ) * 1.5 ), new THREE.Vector3( Math.cos( a ), 0.08 + r() * 0.15, Math.sin( a ) ), 1 + r() * 2.2, 0.045 + r() * 0.03, 0.012, detail ? 3 : 1, detail === 2 ? 5 : 3, 0.03, 0.3 );

	}

	return b.geometry();

}

// variant table: builder, share of instances, scale range, placement
const VARIANTS = [
	{ make: ( s, d ) => snag( s, d, true ), share: 0.26, scale: [ 0.75, 1.35 ], upright: true },
	{ make: ( s, d ) => snag( s + 1, d, true ), share: 0.16, scale: [ 0.7, 1.2 ], upright: true },
	{ make: ( s, d ) => snag( s + 2, d, false ), share: 0.2, scale: [ 0.8, 1.3 ], upright: true },
	{ make: ( s, d ) => stump( s + 3, d ), share: 0.1, scale: [ 0.8, 1.4 ], upright: true },
	{ make: ( s, d ) => log( s + 4, d ), share: 0.16, scale: [ 0.8, 1.3 ], upright: false, near: 600 },
	{ make: ( s, d ) => tangle( s + 5, d ), share: 0.12, scale: [ 0.8, 1.5 ], upright: false, near: 350 },
];

function scatter() {

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
		if ( roll > dens * 0.85 + 0.035 ) continue;
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
		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		this.meshes = VARIANTS.map( ( V, vi ) => [ 2, 1, 0 ].map( ( detail ) => {

			const geo = V.make( 1000 + vi * 31, detail );
			const cap = this.data[ vi ].length / 8;
			const a = new THREE.InstancedBufferAttribute( new Float32Array( Math.max( cap, 1 ) * 4 ), 4 );
			const b = new THREE.InstancedBufferAttribute( new Float32Array( Math.max( cap, 1 ) * 4 ), 4 );
			a.setUsage( THREE.DynamicDrawUsage ); b.setUsage( THREE.DynamicDrawUsage );
			geo.setAttribute( 'iA', a ); geo.setAttribute( 'iB', b );
			geo.instanceCount = 0;
			const mesh = new THREE.Mesh( geo, woodMaterial() );
			mesh.frustumCulled = false;
			mesh.renderOrder = 7;
			this.group.add( mesh );
			return mesh;

		} ) );
		const n = this.data.reduce( ( s, d ) => s + d.length / 8, 0 );
		console.log( `trees: ${ n } ghost trees / logs (${ ( performance.now() - t0 ).toFixed( 0 ) } ms)` );

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
		const n = attribute( 'normal', 'vec3' );
		const cy = cos( B.x ), sy = sin( B.x ), cl = cos( B.y ), sl = sin( B.y );
		// lean about X, then yaw about Y
		const lean = ( v ) => vec3( v.x, v.y.mul( cl ).sub( v.z.mul( sl ) ), v.y.mul( sl ).add( v.z.mul( cl ) ) );
		const yaw = ( v ) => vec3( v.x.mul( cy ).sub( v.z.mul( sy ) ), v.y, v.x.mul( sy ).add( v.z.mul( cy ) ) );
		const world = A.xyz.add( yaw( lean( p ) ) );
		vW.assign( world );
		vN.assign( normalize( yaw( lean( n ) ) ) );
		vWood.assign( attribute( 'wood', 'vec4' ) );
		vS.assign( vec2( B.z, cloudShadowAt( A.xz, A.y ) ) );
		return world;

	} )();

	mat.colorNode = Fn( () => {

		const P = vW;
		const N = normalize( vN );
		const len = vWood.x, ang = vWood.y, rad = vWood.z, tip = vWood.w;
		const seed = vS.x;
		// bleached silver wood: long grain streaks, dark checks, warmer near the ground
		const grain = vnoise( vec2( ang.mul( 22.0 ).add( seed.mul( 50.0 ) ), len.mul( 1.4 ) ) );
		const fine = vnoise( vec2( ang.mul( 70.0 ), len.mul( 6.0 ) ).add( vec2( 5, 3 ) ) );
		const check = smoothstep( 0.72, 0.86, vnoise( vec2( ang.mul( 9.0 ), len.mul( 0.35 ) ).add( vec2( 11, 7 ) ) ) );
		const base = mix( vec3( 0.36, 0.355, 0.33 ), vec3( 0.6, 0.59, 0.56 ), grain.mul( 0.6 ).add( fine.mul( 0.4 ) ) ).mul( mix( 0.9, 1.08, seed ) ).toVar();
		base.mulAssign( float( 1.0 ).sub( check.mul( 0.55 ) ) );
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
