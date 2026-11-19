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
	cameraPosition, faceDirection, texture, uv, select, exp, fract
} from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U, shadeFoliage, windField } from '../../tsl/world.js';
import { rockAtJS } from './rockmask.js';
import { terrainHeightJS, trailDistJS, lakeDistJS, mountainHeightJS, gravelPatchJS } from './terrain.js';
import { cloudShadowGround } from './index.js';
import { TILE } from './atlas.js';
import { rng, Builder } from './grow.js';
import { bakeScrubVoxels } from './vox/bake.js';
import { VoxelRaster } from './vox/raster.js';
import { JOSE_SPECIES, pickJose } from './vox/jose.js';

// ?veg=raster: past VOX_NEAR every bush is drawn as voxels by a compute-shader
// rasterizer (vox/), out to VOX_FAR; the card meshes only keep the near field
export const VEG_RASTER = ( new URLSearchParams( location.search ).get( 'veg' ) ?? import.meta.env.VITE_VEG ) === 'raster';
const VOX_NEAR = 50, VOX_FAR = 1000, TILE_CAP = 640;

const TILE_M = 32, RADIUS = VEG_RASTER ? VOX_FAR : 420, SPACING = 1.55;
const LOD_DIST = VEG_RASTER ? [ 30, VOX_NEAR ] : [ 30, 100 ];
const MESH_RADIUS = VEG_RASTER ? VOX_NEAR : RADIUS;

// species: leaf tile, flower tile (-1 none), body colour, card tint
export const SCRUB = [
	{ name: 'mata negra', leaf: TILE.negra, flower: - 1, body: [ 0.03, 0.045, 0.018 ], tint: [ 0.95, 1.0, 0.9 ], r: [ 0.5, 1.45 ], h: [ 0.4, 1.0 ] },
	{ name: 'calafate', leaf: TILE.cala, flower: TILE.calaFl, body: [ 0.045, 0.065, 0.022 ], tint: [ 1.0, 1.05, 0.95 ], r: [ 0.45, 1.3 ], h: [ 0.45, 1.1 ] },
	{ name: 'mata verde', leaf: TILE.cala, flower: - 1, body: [ 0.06, 0.1, 0.03 ], tint: [ 1.25, 1.45, 0.85 ], r: [ 0.4, 0.95 ], h: [ 0.3, 0.7 ] },
	{ name: 'silver cushion', leaf: TILE.barrosa, flower: - 1, body: [ 0.07, 0.08, 0.06 ], tint: [ 0.85, 0.95, 0.82 ], r: [ 0.35, 0.8 ], h: [ 0.25, 0.55 ] },
	{ name: 'notro', leaf: TILE.notro, flower: TILE.notroFl2, body: [ 0.035, 0.05, 0.02 ], tint: [ 1.0, 1.0, 1.0 ], r: [ 0.7, 1.4 ], h: [ 0.8, 1.7 ] },
];

import { scrubFieldsJS, scrubFieldsTSL, speciesWeights } from './scrubfields.js';
export { scrubFieldsTSL };

// --- geometry ------------------------------------------------------------------
// lumpy dome (unit radius / height) + leafy cards on its surface
export function moundGeometry( seed, detail, cards, core ) {

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

	// the core: up close only a small, dark inner mass that keeps the bush from
	// looking hollow (hidden inside the foliage); far away the full dome stands for
	// the whole bush
	for ( let i = 0; core > 0 && i < P.count; i += 3 ) {

		const tri = [ 0, 1, 2 ].map( ( k ) => new THREE.Vector3( P.getX( i + k ), P.getY( i + k ), P.getZ( i + k ) ) );
		if ( tri.every( ( v ) => v.y < - 0.25 ) ) continue; // below ground
		for ( const v of tri ) {

			const n = v.clone().normalize();
			const k = lump( n ) * core;
			pos.push( n.x * k, Math.max( - 0.2, n.y ) * k, n.z * k );
			nrm.push( n.x, Math.max( 0, n.y ) + 0.2, n.z );
			uvs.push( 0, 0 );
			kind.push( 0, n.y, r() );

		}

	}

	// foliage: sprig cards filling the whole volume (more toward the outside, where
	// the light is), each rooted toward the centre and leaning outward and up, like
	// shoots growing out of the bush; soft canopy normals for volume shading
	for ( let c = 0; c < cards; c ++ ) {

		const th = r() * Math.PI * 2, ph = Math.acos( 1 - r() * 1.2 );
		const n = new THREE.Vector3( Math.sin( ph ) * Math.cos( th ), Math.cos( ph ), Math.sin( ph ) * Math.sin( th ) );
		const depth = Math.pow( r(), 0.45 ); // 0 centre .. 1 surface
		const k = lump( n );
		const o = n.clone().multiplyScalar( k * ( 0.25 + 0.6 * depth ) );
		o.y = Math.max( o.y, - 0.05 );
		const d = n.clone().multiplyScalar( 0.7 ).add( new THREE.Vector3( 0, 0.75, 0 ) ).add( new THREE.Vector3( r() - 0.5, r() * 0.3, r() - 0.5 ).multiplyScalar( 0.7 ) ).normalize();
		const side = new THREE.Vector3().crossVectors( d, new THREE.Vector3( r() - 0.5, r() - 0.5, r() - 0.5 ) ).normalize();
		const s = ( 0.34 + r() * 0.22 ) * ( cards > 80 ? 1 : 1.45 ), w = s * ( 0.9 + r() * 0.35 );
		const top = n.y > 0.45 && depth > 0.6 ? 2 : 1;
		const corners = [ [ - 0.5, 0, 0, 1 ], [ 0.5, 0, 1, 1 ], [ 0.5, 1, 1, 0 ], [ - 0.5, 1, 0, 0 ] ];
		const v = corners.map( ( [ a, b, u, vv ] ) => [ o.clone().addScaledVector( side, a * w ).addScaledVector( d, b * s ), u, vv ] );
		const seedc = r();
		const cn = n.clone().multiplyScalar( 0.6 + 0.4 * depth ).add( new THREE.Vector3( 0, 0.35, 0 ) ).normalize();
		for ( const idx of [ 0, 1, 2, 0, 2, 3 ] ) {

			const [ p, u, vv ] = v[ idx ];
			pos.push( p.x, p.y, p.z );
			nrm.push( cn.x, cn.y, cn.z );
			uvs.push( u, vv );
			// y: height on the bush (for wind + AO), z: card seed
			kind.push( top, Math.min( 1, p.y ) * ( 0.5 + 0.5 * depth ), seedc );

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
function tileInstances( tx, tz, jose ) {

	const out = [], jo = [];
	const r = rng( ( tx * 73856093 ) ^ ( tz * 19349663 ) ^ 0x5bd1e995 );
	const n = Math.round( TILE_M / SPACING );
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const x = ( tx + ( i + r() ) / n ) * TILE_M, z = ( tz + ( j + r() ) / n ) * TILE_M;
		const roll = r(), pick = r(), sz = r(), yaw = r() * 6.283, seed = r();
		const f = scrubFieldsJS( x, z );
		if ( roll > f.cover ) continue;
		const td = trailDistJS( x, z );
		// a grassy verge along the trail, then the scrub (bushes crowd in only here and there)
		if ( td < 1.9 + vnoiseJS( x / 9, z / 9 ) * 2.2 || lakeDistJS( x, z ) < 4 || rockAtJS( x, z ) > 0.25 ) continue;
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
		if ( jose && k === 4 && jose.bySp.oleander ) {

			// voxel test mode: a jose oleander where the firebush would grow
			joseAt( jo, jose, 'oleander', x, z, yaw, seed, r, 0.75 + g * 0.5 );
			continue;

		}

		out.push( x, terrainHeightJS( x, z ) - hh * 0.08, z, rad, hh, yaw, k, seed );

	}

	// the rest of the jose layer: drifts of grasses, flowering shrubs, a few trees
	if ( jose ) {

		const m = 10;
		for ( let j = 0; j < m; j ++ ) for ( let i = 0; i < m; i ++ ) {

			const x = ( tx + ( i + r() ) / m ) * TILE_M, z = ( tz + ( j + r() ) / m ) * TILE_M;
			const yaw = r() * 6.283, seed = r(), sz = r();
			const sp = pickJose( x, z, r, jose.bySp );
			if ( ! sp ) continue;
			if ( trailDistJS( x, z ) < 2.2 || lakeDistJS( x, z ) < 5 || rockAtJS( x, z ) > 0.1 || mountainHeightJS( x, z ) > 160 ) continue;
			joseAt( jo, jose, sp, x, z, yaw, seed, r, 0.75 + sz * 0.5 );

		}

	}

	const res = new Float32Array( out );
	res.jose = new Float32Array( jo );
	return res;

}

// one jose plant: a random seed / growth stage of the species, wind-bent by its exposure
function joseAt( jo, jose, sp, x, z, yaw, seed, r, size ) {

	const list = jose.bySp[ sp ];
	const p = list[ Math.floor( r() * list.length ) ];
	const lean = JOSE_SPECIES[ sp ].lean * ( 0.4 + 1.2 * r() );
	jo.push( x, terrainHeightJS( x, z ) - 0.03, z, size, size, yaw, jose.base + p, Math.min( 0.999, seed ) + Math.floor( lean * 100 ) );

}

export class Scrub {

	constructor( atlas, jose = null ) {

		this.atlas = atlas;
		this.tiles = new Map();
		if ( VEG_RASTER ) {

			const slots = Math.ceil( Math.PI * ( ( RADIUS + TILE_M * 2 ) / TILE_M + 1 ) ** 2 );
			this.freeSlots = [];
			for ( let i = slots - 1; i >= 0; i -- ) this.freeSlots.push( i );
			this.tileSlot = new Map();
			const protos = bakeScrubVoxels( atlas );
			if ( jose ) {

				jose.base = protos.length;
				for ( const p of jose.protos ) protos.push( p );
				this.jose = jose;

			}

			this.raster = new VoxelRaster( protos, slots * TILE_CAP, { near: VOX_NEAR, far: VOX_FAR } );
			this.empty = new Float32Array( TILE_CAP * 8 );

		}

		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		this.lastTilePos = new THREE.Vector3( 1e9, 0, 0 );
		const mat = this.material();
		const LODS = [ { detail: 1, cards: 210, cap: 6000, core: 0 }, { detail: 1, cards: 56, cap: 30000, core: 0.4 }, { detail: 0, cards: 0, cap: 160000, core: 1 } ];
		this.meshes = LODS.map( ( L, l ) => {

			const g = L.flowers ? flowerGeometry( 777, L.flowers ) : moundGeometry( 4242 + l, L.detail, L.cards, L.core );
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
			// wind, like the grass: the travelling gust field bends the whole bush
			// downwind (more toward the top and outside), each shoot sways on a slow,
			// wind-driven phase of its own: no repetitive per-card flicker
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const wind = windField( A.xz );
			const hk = clamp( K.y, 0.0, 1.0 ).pow( 1.4 );
			const phase = dot( A.xz, U.windDir ).mul( 0.42 ).sub( U.windPhase.mul( 0.42 ) ).add( K.z.mul( 6.0 ) );
			const sway = sin( phase ).mul( 0.35 ).add( sin( phase.mul( 2.3 ).add( K.z.mul( 13.0 ) ) ).mul( 0.12 ) ).add( 0.6 );
			const shoot = select( K.x.greaterThan( 0.5 ), float( 1.0 ), float( 0.25 ) );
			const disp = W.mul( wind.mul( sway ).mul( hk ).mul( B.x ).mul( 0.12 ).mul( shoot ) )
				.add( vec3( 0, - 1, 0 ).mul( wind.mul( hk ).mul( B.x ).mul( 0.03 ).mul( shoot ) ) );
			const w = A.xyz.add( local ).add( disp );
			vW.assign( w );
			vN.assign( normalize( rot( n ).mul( vec3( 1.0 / 1.0, 1.0, 1.0 ) ) ) );
			vK.assign( vec4( K.x, K.y, K.z, B.z ) );
			vI.assign( vec4( cloudShadowGround( A.xz ), B.w, length( A.xyz.sub( cameraPosition ) ), 0 ) );
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
			// far away (no cards) the dome stands for the whole bush: foliage tone, lit tops
			const farK = smoothstep( 30.0, 120.0, vI.z );
			const body = spf( sp, SCRUB.map( ( s ) => s.body ) ).mul( tint ).mul( mix( 0.45, 1.25, leafN ) )
				.mul( mix( float( 1.0 ), mix( 1.3, 2.3, smoothstep( 0.1, 0.9, vK.y ) ), farK ) );
			const isNotro = sp.greaterThan( 3.5 );
			const redDots = smoothstep( 0.7, 0.8, vnoise( P.xz.mul( 22.0 ).add( P.y.mul( 17.0 ) ) ) ).mul( smoothstep( 0.2, 0.7, vK.y ) ).mul( select( isNotro, float( 1.0 ), float( 0.0 ) ) ).mul( mix( 0.4, 1.0, vI.y ) );
			const bodyCol = mix( body, vec3( 0.32, 0.03, 0.015 ), redDots.mul( 0.5 ) );
			const tubeCol = select( vK.x.greaterThan( 3.5 ), vec3( 0.55, 0.42, 0.12 ), mix( vec3( 0.5, 0.05, 0.012 ), vec3( 0.85, 0.16, 0.03 ), vK.z ) );
			const albedo = select( isTube, tubeCol, select( isCard, smp.rgb.mul( tint ), bodyCol ) ).toVar();
			const ao = select( isCard, mix( 0.55, 1.0, smoothstep( - 0.1, 0.7, vK.y ) ), mix( 0.3, 0.85, smoothstep( - 0.1, 0.8, vK.y ) ) );
			const N = normalize( vN ).mul( select( isCard, faceDirection.mul( 0.3 ).add( 0.7 ), float( 1.0 ) ) );
			const isRed = select( useFl.or( isTube ), float( 1.0 ), redDots );
			// night: the notro flowers glow softly, fading with distance
			const far = smoothstep( 520.0, 300.0, vI.z ).mul( 0.55 ).add( 0.45 );
			const wave = sin( P.x.mul( 0.045 ).add( P.z.mul( 0.03 ) ).sub( U.time.mul( 0.55 ) ) ).mul( 0.3 ).add( 0.7 );
			const glow = select( isTube, float( 1.0 ), smoothstep( 0.1, 0.35, albedo.r.sub( albedo.g.mul( 1.5 ) ) ) ).mul( isRed ).mul( select( isNotro, float( 1.0 ), float( 0.0 ) ) );
			const hot = smoothstep( 0.55, 0.8, albedo.r ).mul( glow );
			const varyF = mix( 0.25, 1.9, fract( vK.z.mul( 37.3 ).add( vI.y.mul( 11.0 ) ) ).pow( 1.5 ) );
			// calafate's yellow cups (flower cards of species 1)
			const yel = smoothstep( 0.15, 0.4, albedo.r.add( albedo.g ).mul( 0.5 ).sub( albedo.b.mul( 1.2 ) ) ).mul( select( useFl.and( sp.greaterThan( 0.5 ) ).and( sp.lessThan( 1.5 ) ), float( 1.0 ), float( 0.0 ) ) );
			const emit = albedo.mul( vec3( 2.2, 1.2, 1.1 ) ).mul( glow ).add( vec3( 1.0, 0.2, 0.12 ).mul( hot.mul( 3.0 ) ) )
				.mul( U.night.mul( U.glow ).mul( far ).mul( wave ).mul( varyF ).mul( 0.11 ) )
				.add( vec3( 1.0, 0.75, 0.2 ).mul( yel.mul( U.night ).mul( U.glow ).mul( far ).mul( varyF ).mul( 0.12 ) ) );
			return shadeFoliage( albedo, N, P, ao, vI.x, select( isCard, float( 0.5 ), float( 0.25 ) ), float( 0.0 ), float( 0.45 ), emit );

		} )();

		return mat;

	}

	// keep the tiles around the camera generated; re-bucket instances into LODs
	update( renderer, camera ) {

		const cp = camera.position;
		if ( cp.distanceToSquared( this.lastTilePos ) > 16 * 16 || this.pending ) {

			if ( cp.distanceToSquared( this.lastTilePos ) > 16 * 16 ) this.lastTilePos.copy( cp );
			const ctx = Math.floor( cp.x / TILE_M ), ctz = Math.floor( cp.z / TILE_M ), R = Math.ceil( RADIUS / TILE_M );
			const keep = new Set(), todo = [];
			for ( let j = - R; j <= R; j ++ ) for ( let i = - R; i <= R; i ++ ) {

				const tx = ctx + i, tz = ctz + j;
				const cxm = ( tx + 0.5 ) * TILE_M - cp.x, czm = ( tz + 0.5 ) * TILE_M - cp.z;
				const d2 = cxm * cxm + czm * czm;
				if ( d2 > ( RADIUS + TILE_M ) ** 2 ) continue;
				const key = tx + ',' + tz;
				keep.add( key );
				if ( ! this.tiles.has( key ) ) todo.push( [ d2, tx, tz, key ] );

			}

			for ( const k of this.tiles.keys() ) if ( ! keep.has( k ) ) {

				this.tiles.delete( k );
				if ( this.raster ) {

					const slot = this.tileSlot.get( k );
					this.raster.writeSlots( slot * TILE_CAP, this.empty );
					this.tileSlot.delete( k );
					this.freeSlots.push( slot );

				}

			}

			// nearest tiles first, within a time budget per frame (the far field fills in)
			todo.sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
			const t0 = performance.now(), budget = this.raster ? ( this.tiles.size ? 5 : 40 ) : 1e9;
			let built = 0;
			for ( const [ , tx, tz, key ] of todo ) {

				if ( built && performance.now() - t0 > budget ) break;
				const d = tileInstances( tx, tz, this.jose );
				d.cx = ( tx + 0.5 ) * TILE_M; d.cz = ( tz + 0.5 ) * TILE_M;
				this.tiles.set( key, d );
				if ( this.raster ) {

					const slot = this.freeSlots.pop();
					this.tileSlot.set( key, slot );
					const buf = new Float32Array( TILE_CAP * 8 );
					buf.set( d.subarray( 0, Math.min( d.length, TILE_CAP * 8 ) ) );
					// species -> voxel prototype (two variants each)
					for ( let i = 6; i < buf.length; i += 8 ) if ( buf[ i - 3 ] > 0 ) buf[ i ] = buf[ i ] * 2 + ( buf[ i + 1 ] < 0.5 ? 0 : 1 );
					const ns = Math.min( d.length, TILE_CAP * 8 );
					if ( d.jose ) buf.set( d.jose.subarray( 0, Math.max( 0, Math.min( d.jose.length, TILE_CAP * 8 - ns ) ) ), ns );
					this.raster.writeSlots( slot * TILE_CAP, buf );

				}

				built ++;

			}

			this.pending = built < todo.length;
			if ( built ) this.lastPos.set( 1e9, 0, 0 );

		}

		if ( this.raster ) this.raster.render( renderer, camera );

		// re-bucket when the camera moved or turned (instances behind the view are skipped)
		const fwd = new THREE.Vector3( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		fwd.y = 0; fwd.normalize();
		this.lastFwd = this.lastFwd || new THREE.Vector3( 0, 0, 1 );
		if ( cp.distanceToSquared( this.lastPos ) < 4 && fwd.dot( this.lastFwd ) > 0.97 ) return;
		this.lastPos.copy( cp ); this.lastFwd.copy( fwd );
		const cosCut = Math.cos( 78 * Math.PI / 180 );
		const L0 = LOD_DIST[ 0 ] ** 2, L1 = LOD_DIST[ 1 ] ** 2, R2 = MESH_RADIUS * MESH_RADIUS;
		const TR2 = ( MESH_RADIUS + TILE_M ) ** 2;
		const A = this.meshes.map( ( m ) => m.geometry.attributes.iA.array ), B = this.meshes.map( ( m ) => m.geometry.attributes.iB.array );
		const n = [ 0, 0, 0 ];
		for ( const d of this.tiles.values() ) {

			if ( ( d.cx - cp.x ) ** 2 + ( d.cz - cp.z ) ** 2 > TR2 ) continue;
			for ( let i = 0; i < d.length; i += 8 ) {

			const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z, r2 = dx * dx + dz * dz;
			if ( r2 > R2 ) continue;
			if ( r2 > 900 && ( dx * fwd.x + dz * fwd.z ) < cosCut * Math.sqrt( r2 ) ) continue; // behind / outside the view
			const l = r2 < L0 ? 0 : r2 < L1 ? 1 : 2;
			if ( n[ l ] * 4 >= A[ l ].length ) continue;
			const k = ( n[ l ] ++ ) * 4;
			A[ l ][ k ] = d[ i ]; A[ l ][ k + 1 ] = d[ i + 1 ]; A[ l ][ k + 2 ] = d[ i + 2 ]; A[ l ][ k + 3 ] = d[ i + 3 ];
			B[ l ][ k ] = d[ i + 4 ]; B[ l ][ k + 1 ] = d[ i + 5 ]; B[ l ][ k + 2 ] = d[ i + 6 ]; B[ l ][ k + 3 ] = d[ i + 7 ];

			}

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
