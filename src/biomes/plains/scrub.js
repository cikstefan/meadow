// The scrub mosaic: what actually covers the plains in every photo of the W
// trek. Rounded shrub mounds packed together (dark olive mata negra and
// calafate, bright green mounds, silver-grey cushions, notro bushes heavy with
// scarlet flowers in drifts) with fine grass between them.
//
// Placement works like a PCG graph (Unreal's Procedural Content Generation):
// a jittered point grid per 32 m tile, filtered by density fields (overall
// cover, species drifts), exclusions (trail, lake, steep high ground) and
// size rules. Tiles are generated deterministically around the camera as you
// walk (anywhere), and every mound is drawn as an inner volume (a lumpy dome
// shaded as dense foliage) with leafy cards on its surface for a ragged
// silhouette: three LODs, one instanced draw per LOD. Past the last LOD the
// ground shader paints the same fields (scrubFieldsTSL), so the mosaic carries
// on to the horizon.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp, pow, sin, cos, dot, normalize, length, attribute, varying,
	cameraPosition, faceDirection, texture, uv, select, exp
} from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U, shadeFoliage } from '../../tsl/world.js';
import { terrainHeightJS, trailDistJS, lakeDistJS, mountainHeightJS, gravelPatchJS } from './terrain.js';
import { cloudShadowAt } from './index.js';
import { TILE } from './atlas.js';
import { rng, Builder } from './grow.js';

const TILE_M = 32, RADIUS = 200, SPACING = 1.55;
const LOD_DIST = [ 32, 92 ];

// species: leaf tile, flower tile (-1 none), body colour, card tint
export const SCRUB = [
	{ name: 'mata negra', leaf: TILE.negra, flower: - 1, body: [ 0.03, 0.045, 0.018 ], tint: [ 0.95, 1.0, 0.9 ], r: [ 0.5, 1.45 ], h: [ 0.4, 1.0 ] },
	{ name: 'calafate', leaf: TILE.cala, flower: TILE.calaFl, body: [ 0.045, 0.065, 0.022 ], tint: [ 1.0, 1.05, 0.95 ], r: [ 0.45, 1.3 ], h: [ 0.45, 1.1 ] },
	{ name: 'mata verde', leaf: TILE.cala, flower: - 1, body: [ 0.06, 0.1, 0.03 ], tint: [ 1.25, 1.45, 0.85 ], r: [ 0.4, 0.95 ], h: [ 0.3, 0.7 ] },
	{ name: 'silver cushion', leaf: TILE.barrosa, flower: - 1, body: [ 0.1, 0.112, 0.088 ], tint: [ 1.15, 1.25, 1.12 ], r: [ 0.35, 0.8 ], h: [ 0.25, 0.55 ] },
	{ name: 'notro', leaf: TILE.notro, flower: TILE.notroFl2, body: [ 0.035, 0.05, 0.02 ], tint: [ 1.0, 1.0, 1.0 ], r: [ 0.7, 1.4 ], h: [ 0.8, 1.7 ] },
];

import { scrubFieldsJS, scrubFieldsTSL, speciesWeights } from './scrubfields.js';
export { scrubFieldsTSL };

// --- geometry ------------------------------------------------------------------
// lumpy dome (unit radius / height) + leafy cards on its surface
function moundGeometry( seed, detail, cards ) {

	const r = rng( seed );
	const ico = new THREE.IcosahedronGeometry( 1, detail );
	const P = ico.attributes.position;
	const lobes = [ 0, 1, 2 ].map( () => new THREE.Vector3( r() - 0.5, r() * 0.5 + 0.2, r() - 0.5 ).normalize() );
	const pos = [], nrm = [], uvs = [], kind = [];
	const lump = ( v ) => {

		let k = 0.86;
		for ( const l of lobes ) k += Math.max( 0, v.dot( l ) ) * 0.12;
		k += ( vnoiseJS( v.x * 2.3 + seed, v.z * 2.3 + v.y * 1.7 ) - 0.5 ) * 0.22;
		return k;

	};

	for ( let i = 0; i < P.count; i += 3 ) {

		const tri = [ 0, 1, 2 ].map( ( k ) => new THREE.Vector3( P.getX( i + k ), P.getY( i + k ), P.getZ( i + k ) ) );
		if ( tri.every( ( v ) => v.y < - 0.25 ) ) continue; // below ground
		for ( const v of tri ) {

			const n = v.clone().normalize();
			const k = lump( n );
			pos.push( n.x * k, Math.max( - 0.2, n.y ) * k, n.z * k );
			nrm.push( n.x, Math.max( 0, n.y ) + 0.2, n.z );
			uvs.push( 0, 0 );
			kind.push( 0, n.y, r() );

		}

	}

	// cards: rooted just inside the surface, standing out along the normal, upper part favoured
	for ( let c = 0; c < cards; c ++ ) {

		const th = r() * Math.PI * 2, ph = Math.acos( 1 - r() * 1.15 );
		const n = new THREE.Vector3( Math.sin( ph ) * Math.cos( th ), Math.cos( ph ), Math.sin( ph ) * Math.sin( th ) );
		const k = lump( n );
		const o = n.clone().multiplyScalar( k * 0.82 );
		const d = n.clone().add( new THREE.Vector3( 0, 0.6, 0 ) ).add( new THREE.Vector3( r() - 0.5, 0, r() - 0.5 ).multiplyScalar( 0.6 ) ).normalize();
		const side = new THREE.Vector3().crossVectors( d, new THREE.Vector3( r() - 0.5, r() - 0.5, r() - 0.5 ) ).normalize();
		const s = ( 0.5 + r() * 0.3 ) * ( cards > 60 ? 1 : 1.35 ), w = s * ( 0.95 + r() * 0.35 );
		const top = n.y > 0.45 ? 2 : 1;
		const corners = [ [ - 0.5, 0, 0, 1 ], [ 0.5, 0, 1, 1 ], [ 0.5, 1, 1, 0 ], [ - 0.5, 1, 0, 0 ] ];
		const v = corners.map( ( [ a, b, u, vv ] ) => [ o.clone().addScaledVector( side, a * w ).addScaledVector( d, b * s ), u, vv ] );
		const seedc = r();
		for ( const idx of [ 0, 1, 2, 0, 2, 3 ] ) {

			const [ p, u, vv ] = v[ idx ];
			pos.push( p.x, p.y, p.z );
			nrm.push( n.x, n.y + 0.3, n.z );
			uvs.push( u, vv );
			kind.push( top, n.y, seedc );

		}

	}

	const g = new THREE.InstancedBufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( nrm, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	g.setAttribute( 'kind', new THREE.Float32BufferAttribute( kind, 3 ) );
	return g;

}

// 3D flower clusters on the upper half of a unit dome (notro mounds up close)
function flowerGeometry( seed, clusters ) {

	const r = rng( seed );
	const B = new Builder();
	for ( let c = 0; c < clusters; c ++ ) {

		const th = r() * Math.PI * 2, ph = Math.acos( 1 - r() * 0.95 );
		const n = new THREE.Vector3( Math.sin( ph ) * Math.cos( th ), Math.cos( ph ), Math.sin( ph ) * Math.sin( th ) );
		const up = n.clone().add( new THREE.Vector3( 0, 0.8, 0 ) ).normalize();
		B.flowerCluster( n.clone().multiplyScalar( 0.98 ), up, r, 1.7, 3, r(), 1, n.y, 10 + ( r() * 6 | 0 ) );

	}

	const g = new THREE.InstancedBufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( B.pos, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( B.nrm, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( B.uv, 2 ) );
	// kind 3 = flower tube, 4 = style; y = height on the dome; z = cluster seed (bloom)
	const kind = [];
	for ( let i = 0; i < B.cardA.length; i += 4 ) kind.push( B.cardA[ i ] === 3 ? 3 : 4, B.cardA[ i + 3 ], B.cardA[ i + 1 ] );
	g.setAttribute( 'kind', new THREE.Float32BufferAttribute( kind, 3 ) );
	g.setIndex( B.idx );
	return g;

}

// --- placement ---------------------------------------------------------------------
function tileInstances( tx, tz ) {

	const out = [];
	const r = rng( ( tx * 73856093 ) ^ ( tz * 19349663 ) ^ 0x5bd1e995 );
	const n = Math.round( TILE_M / SPACING );
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const x = ( tx + ( i + r() ) / n ) * TILE_M, z = ( tz + ( j + r() ) / n ) * TILE_M;
		const roll = r(), pick = r(), sz = r(), yaw = r() * 6.283, seed = r();
		const f = scrubFieldsJS( x, z );
		if ( roll > f.cover ) continue;
		const td = trailDistJS( x, z );
		if ( td < 1.1 + vnoiseJS( x / 9, z / 9 ) * 1.4 || lakeDistJS( x, z ) < 4 ) continue;
		const mh = mountainHeightJS( x, z );
		if ( mh > 220 || ( mh > 80 && roll > f.cover * ( 1 - ( mh - 80 ) / 140 ) ) ) continue;
		const gravel = gravelPatchJS( x, z );
		const w = speciesWeights( f, gravel );
		const tot = w.reduce( ( a, b ) => a + b, 0 );
		let k = 0, acc = w[ 0 ] / tot;
		while ( pick > acc && k < w.length - 1 ) {

			k ++; acc += w[ k ] / tot;

		}

		const sp = SCRUB[ k ];
		const g = Math.pow( sz, 0.8 );
		const rad = sp.r[ 0 ] + ( sp.r[ 1 ] - sp.r[ 0 ] ) * g, hh = sp.h[ 0 ] + ( sp.h[ 1 ] - sp.h[ 0 ] ) * g * ( 0.8 + 0.4 * r() );
		out.push( x, terrainHeightJS( x, z ) - hh * 0.08, z, rad, hh, yaw, k, seed );

	}

	return new Float32Array( out );

}

export class Scrub {

	constructor( atlas ) {

		this.atlas = atlas;
		this.tiles = new Map();
		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		this.lastTilePos = new THREE.Vector3( 1e9, 0, 0 );
		const mat = this.material();
		const LODS = [ { detail: 2, cards: 120, cap: 6000 }, { detail: 1, cards: 18, cap: 26000 }, { detail: 0, cards: 0, cap: 70000 } ];
		this.meshes = [ ...LODS, { flowers: 14, cap: 600 } ].map( ( L, l ) => {

			const g = L.flowers ? flowerGeometry( 777, L.flowers ) : moundGeometry( 4242 + l, L.detail, L.cards );
			const a = new THREE.InstancedBufferAttribute( new Float32Array( L.cap * 4 ), 4 );
			const b = new THREE.InstancedBufferAttribute( new Float32Array( L.cap * 4 ), 4 );
			a.setUsage( THREE.DynamicDrawUsage ); b.setUsage( THREE.DynamicDrawUsage );
			g.setAttribute( 'iA', a ); g.setAttribute( 'iB', b );
			g.instanceCount = 0;
			const m = new THREE.Mesh( g, mat );
			m.frustumCulled = false;
			m.renderOrder = 7;
			this.group.add( m );
			return m;

		} );

	}

	material() {

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;
		mat.alphaToCoverage = true;
		mat.alphaTest = 0.35;
		const vW = varying( vec3( 0 ), 'vScW' ), vN = varying( vec3( 0 ), 'vScN' );
		const vK = varying( vec4( 0 ), 'vScK' ); // kind, height frac, card seed, species
		const vI = varying( vec4( 0 ), 'vScI' ); // cloud, instance seed, distance, -
		const tex = this.atlas.texture, cols = this.atlas.cols, rows = this.atlas.rows;
		const spf = ( k, arr ) => {

			let v = vec3( ...arr[ SCRUB.length - 1 ] );
			for ( let i = SCRUB.length - 2; i >= 0; i -- ) v = select( k.lessThan( i + 0.5 ), vec3( ...arr[ i ] ), v );
			return v;

		};
		const spfs = ( k, arr ) => {

			let v = float( arr[ SCRUB.length - 1 ] );
			for ( let i = SCRUB.length - 2; i >= 0; i -- ) v = select( k.lessThan( i + 0.5 ), float( arr[ i ] ), v );
			return v;

		};

		mat.positionNode = Fn( () => {

			const A = attribute( 'iA', 'vec4' ), B = attribute( 'iB', 'vec4' ); // x y z radius | height yaw species seed
			const p = attribute( 'position', 'vec3' ), n = attribute( 'normal', 'vec3' ), K = attribute( 'kind', 'vec3' );
			const c = cos( B.y ), s = sin( B.y );
			const rot = ( v ) => vec3( v.x.mul( c ).sub( v.z.mul( s ) ), v.y, v.x.mul( s ).add( v.z.mul( c ) ) );
			const local = rot( vec3( p.x.mul( A.w ), p.y.mul( B.x ), p.z.mul( A.w ) ) );
			// wind: the dome barely moves, the leafy rim shivers
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const gust = vnoise( A.xz.sub( U.windOffset ).div( 13.0 ) ).mul( 0.7 ).add( 0.3 );
			const hk = clamp( p.y, 0.0, 1.2 );
			const flut = sin( U.time.mul( mix( 6.0, 11.0, K.z ) ).add( K.z.mul( 50.0 ) ) ).mul( select( K.x.greaterThan( 0.5 ), float( 0.04 ), float( 0.0 ) ) );
			const disp = W.mul( U.windStrength.mul( gust ).mul( hk ).mul( B.x ).mul( 0.03 ) ).add( normalize( rot( n ) ).mul( flut.mul( U.windStrength ).mul( B.x ) ) );
			// 3D flowers only on notro mounds, only the clusters within the bush's bloom
			const tubeOff = K.x.greaterThan( 2.5 ).and( B.z.lessThan( 3.5 ).or( K.z.greaterThan( mix( 0.35, 0.8, B.w ) ) ) );
			const w = select( tubeOff, A.xyz, A.xyz.add( local ).add( disp ) );
			vW.assign( w );
			vN.assign( normalize( rot( n ).mul( vec3( 1.0 / 1.0, 1.0, 1.0 ) ) ) );
			vK.assign( vec4( K.x, K.y, K.z, B.z ) );
			vI.assign( vec4( cloudShadowAt( A.xz, A.y ), B.w, length( A.xyz.sub( cameraPosition ) ), 0 ) );
			return w;

		} )();

		const isTube = vK.x.greaterThan( 2.5 );
		const isCard = vK.x.greaterThan( 0.5 ).and( isTube.not() );
		const sp = vK.w;
		// flower cards: top cards of flowering species, more of them on some bushes
		const flTile = spfs( sp, SCRUB.map( ( s ) => s.flower ) );
		const bloom = select( sp.greaterThan( 3.5 ), mix( 0.3, 0.7, vI.y ), mix( 0.0, 0.25, vI.y ) );
		const useFl = vK.x.greaterThan( 1.5 ).and( flTile.greaterThanEqual( 0.0 ) ).and( vK.z.lessThan( bloom ) );
		const tile = select( useFl, flTile, spfs( sp, SCRUB.map( ( s ) => s.leaf ) ) );
		const tuv = vec2( tile.mod( cols ).add( uv().x.clamp( 0.004, 0.996 ) ), tile.div( cols ).floor().add( uv().y.clamp( 0.004, 0.996 ) ) ).div( vec2( cols, rows ) );
		const smp = texture( tex, tuv );
		mat.opacityNode = select( isCard.and( isTube.not() ), smp.a.mul( float( 1.0 ).add( smoothstep( 5.0, 60.0, vI.z ).mul( 1.6 ) ) ), float( 1.0 ) );

		mat.colorNode = Fn( () => {

			const tint = spf( sp, SCRUB.map( ( s ) => s.tint ) ).mul( mix( 0.85, 1.12, vI.y ) );
			// the dome: dense foliage seen as a mass: species colour broken by leaf-scale
			// noise, darker deep inside and at the base, notro domes dotted with scarlet
			const P = vW;
			const leafN = vnoise( P.xz.mul( 9.0 ).add( P.y.mul( 7.0 ) ) ).mul( 0.6 ).add( vnoise( P.xz.mul( 31.0 ).add( vec2( P.y.mul( 23.0 ), 3.0 ) ) ).mul( 0.4 ) );
			// (mostly seen through gaps between the leaf cards: deep, shaded foliage)
			const body = spf( sp, SCRUB.map( ( s ) => s.body ) ).mul( tint ).mul( mix( 0.45, 1.25, leafN ) );
			const isNotro = sp.greaterThan( 3.5 );
			const redDots = smoothstep( 0.7, 0.8, vnoise( P.xz.mul( 22.0 ).add( P.y.mul( 17.0 ) ) ) ).mul( smoothstep( 0.2, 0.7, vK.y ) ).mul( select( isNotro, float( 1.0 ), float( 0.0 ) ) ).mul( mix( 0.4, 1.0, vI.y ) );
			const bodyCol = mix( body, vec3( 0.32, 0.03, 0.015 ), redDots.mul( 0.5 ) );
			const tubeCol = select( vK.x.greaterThan( 3.5 ), vec3( 0.55, 0.42, 0.12 ), mix( vec3( 0.45, 0.02, 0.012 ), vec3( 0.78, 0.08, 0.03 ), vK.z ) );
			const albedo = select( isTube, tubeCol, select( isCard, smp.rgb.mul( tint ), bodyCol ) ).toVar();
			const ao = select( isCard, mix( 0.55, 1.0, smoothstep( - 0.1, 0.7, vK.y ) ), mix( 0.3, 0.85, smoothstep( - 0.1, 0.8, vK.y ) ) );
			const N = normalize( vN ).mul( select( isCard, faceDirection.mul( 0.3 ).add( 0.7 ), float( 1.0 ) ) );
			const isRed = select( useFl.or( isTube ), float( 1.0 ), redDots );
			// night: the notro flowers glow softly, fading with distance
			const far = exp( vI.z.div( - 160.0 ) ).mul( 0.85 ).add( 0.15 );
			const wave = sin( P.x.mul( 0.045 ).add( P.z.mul( 0.03 ) ).sub( U.time.mul( 0.55 ) ) ).mul( 0.3 ).add( 0.7 );
			const glow = select( isTube, float( 1.0 ), smoothstep( 0.1, 0.35, albedo.r.sub( albedo.g.mul( 1.5 ) ) ) ).mul( isRed ).mul( select( isNotro, float( 1.0 ), float( 0.0 ) ) );
			const hot = smoothstep( 0.55, 0.8, albedo.r ).mul( glow );
			const emit = albedo.mul( vec3( 2.2, 1.2, 1.1 ) ).mul( glow ).add( vec3( 1.0, 0.2, 0.12 ).mul( hot.mul( 3.0 ) ) )
				.mul( U.night.mul( U.glow ).mul( far ).mul( wave ).mul( 0.11 ) );
			return shadeFoliage( albedo, N, P, ao, vI.x, select( isCard, float( 0.5 ), float( 0.25 ) ), float( 0.1 ), float( 0.45 ), emit );

		} )();

		return mat;

	}

	// keep the tiles around the camera generated; re-bucket instances into LODs
	update( renderer, camera ) {

		const cp = camera.position;
		if ( cp.distanceToSquared( this.lastTilePos ) > 16 * 16 ) {

			this.lastTilePos.copy( cp );
			const ctx = Math.floor( cp.x / TILE_M ), ctz = Math.floor( cp.z / TILE_M ), R = Math.ceil( RADIUS / TILE_M );
			const keep = new Set();
			let built = 0;
			for ( let j = - R; j <= R; j ++ ) for ( let i = - R; i <= R; i ++ ) {

				const tx = ctx + i, tz = ctz + j;
				const cxm = ( tx + 0.5 ) * TILE_M - cp.x, czm = ( tz + 0.5 ) * TILE_M - cp.z;
				if ( cxm * cxm + czm * czm > ( RADIUS + TILE_M ) ** 2 ) continue;
				const key = tx + ',' + tz;
				keep.add( key );
				if ( ! this.tiles.has( key ) ) {

					this.tiles.set( key, tileInstances( tx, tz ) );
					built ++;

				}

			}

			for ( const k of this.tiles.keys() ) if ( ! keep.has( k ) ) this.tiles.delete( k );
			if ( built ) this.lastPos.set( 1e9, 0, 0 );

		}

		if ( cp.distanceToSquared( this.lastPos ) < 4 ) return;
		this.lastPos.copy( cp );
		const L0 = LOD_DIST[ 0 ] ** 2, L1 = LOD_DIST[ 1 ] ** 2, R2 = RADIUS * RADIUS;
		const A = this.meshes.map( ( m ) => m.geometry.attributes.iA.array ), B = this.meshes.map( ( m ) => m.geometry.attributes.iB.array );
		const n = [ 0, 0, 0, 0 ];
		for ( const d of this.tiles.values() ) for ( let i = 0; i < d.length; i += 8 ) {

			const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z, r2 = dx * dx + dz * dz;
			if ( r2 > R2 ) continue;
			const l = r2 < L0 ? 0 : r2 < L1 ? 1 : 2;
			if ( d[ i + 6 ] > 3.5 && r2 < 225 && n[ 3 ] * 4 < A[ 3 ].length ) {

				const k = ( n[ 3 ] ++ ) * 4;
				A[ 3 ][ k ] = d[ i ]; A[ 3 ][ k + 1 ] = d[ i + 1 ]; A[ 3 ][ k + 2 ] = d[ i + 2 ]; A[ 3 ][ k + 3 ] = d[ i + 3 ];
				B[ 3 ][ k ] = d[ i + 4 ]; B[ 3 ][ k + 1 ] = d[ i + 5 ]; B[ 3 ][ k + 2 ] = d[ i + 6 ]; B[ 3 ][ k + 3 ] = d[ i + 7 ];

			}

			if ( n[ l ] * 4 >= A[ l ].length ) continue;
			const k = ( n[ l ] ++ ) * 4;
			A[ l ][ k ] = d[ i ]; A[ l ][ k + 1 ] = d[ i + 1 ]; A[ l ][ k + 2 ] = d[ i + 2 ]; A[ l ][ k + 3 ] = d[ i + 3 ];
			B[ l ][ k ] = d[ i + 4 ]; B[ l ][ k + 1 ] = d[ i + 5 ]; B[ l ][ k + 2 ] = d[ i + 6 ]; B[ l ][ k + 3 ] = d[ i + 7 ];

		}

		this.meshes.forEach( ( m, l ) => {

			m.geometry.instanceCount = n[ l ];
			m.visible = n[ l ] > 0;
			m.geometry.attributes.iA.needsUpdate = true;
			m.geometry.attributes.iB.needsUpdate = true;

		} );
		this.counts = n;

	}

}
