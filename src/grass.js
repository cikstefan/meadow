// GPU-driven procedural grass.
//
// - An N x N grid of blade "slots" is kept centred on the camera as a toroidal
//   (wrap-around) window over an infinite global blade lattice. Each slot
//   remembers which global cell it holds; when the camera moves and a slot's
//   expected cell changes, only that slot rebuilds its static data (terrain
//   height, Voronoi clump, shape). Everything else is reused frame to frame.
// - Every frame a compute pass culls slots against the view frustum + radius,
//   samples wind / cloud shadow / walker push once per blade, and appends the
//   blade to one of three LOD lists (atomic counter -> indirect draw args).
// - Blades are cubic Bezier spines generated in the vertex shader from the
//   per-blade data, so geometry is just a tiny subdivided strip per LOD.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, int, uint, vec2, vec3, vec4, If, instanceIndex, uv, varying, floor, fract,
	mix, smoothstep, clamp, max, min, pow, sin, cos, atan, dot, length, normalize, cross, abs, sqrt,
	cameraPosition, faceDirection, select, attribute
} from 'three/tsl';
import { hash2i, hash2i2, pcg, vnoise } from './tsl/noise.js';
import {
	U, terrainHeight, terrainNormal, fieldTall, fieldDry, fieldFlowers, windField, cloudShadow, shadeFoliage, gustSheen, flowerGlowLight, actorPush, actorShadowAt
} from './tsl/world.js';
import { storageVec, createLODs, createResetCompute, routeLOD, visibleSlot, disposeStorage } from './gpu.js';
import { BIOME } from './biomes/index.js';

const G = BIOME.grass;
const c3 = ( a ) => vec3( ...a );

const RENDER_ORDER = 0;

export const GRASS_DEFAULTS = {
	heightScale: 1.0,
	widthScale: 1.0,
	clumpSize: 1.1,
};

// sub-blades per instance: a biome can draw each blade as a small tuft
// (fanned blades of different heights), so the sward reads thick and bushy
const subBlades = ( segments ) => {

	const m = G.multi || 1;
	return segments >= 5 ? m : segments >= 2 ? Math.min( 2, m ) : 1;

};

function bladeGeometry( segments ) {

	const K = subBlades( segments );
	const g = new THREE.PlaneGeometry( 1, 1, 1, segments );
	g.translate( 0, 0.5, 0 );
	g.userData.K = K;
	if ( K === 1 ) return g;
	// K copies of the strip, tagged with their sub-blade index
	const P = g.attributes.position.array, UV = g.attributes.uv.array, I = g.index.array;
	const nv = P.length / 3;
	const pos = new Float32Array( P.length * K ), uvs = new Float32Array( UV.length * K ), sub = new Float32Array( nv * K ), idx = [];
	for ( let k = 0; k < K; k ++ ) {

		pos.set( P, k * P.length ); uvs.set( UV, k * UV.length ); sub.fill( k, k * nv, ( k + 1 ) * nv );
		for ( let i = 0; i < I.length; i ++ ) idx.push( I[ i ] + k * nv );

	}

	const out = new THREE.BufferGeometry();
	out.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
	out.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
	out.setAttribute( 'sub', new THREE.BufferAttribute( sub, 1 ) );
	out.setIndex( idx );
	out.userData.K = K;
	return out;

}

export class Grass {

	/**
	 * fadeIn / fadeOut: [start, end] distances (m) of a stochastic density crossfade.
	 * Overlapping rings use complementary bands, so blades keep their real height
	 * and only their *count* hands over from one ring to the next (no seam).
	 */
	constructor( { bladesPerAxis, area, lodScale = 1, widthScale = 1, lods = null, renderOrder = RENDER_ORDER,
		fadeIn = null, fadeOut = null, aoMin = 0.2, groundBlend = 0 } ) {

		this.N = bladesPerAxis;
		this.area = area;
		this.spacing = area / bladesPerAxis;
		this.count = this.N * this.N;

		this.u = {
			base: uniform( new THREE.Vector2() ),
			spacing: uniform( this.spacing ),
			radius: uniform( area * 0.5 ),
			viewProj: uniform( new THREE.Matrix4() ),
			cullPos: uniform( new THREE.Vector3() ),
			pusher: uniform( new THREE.Vector3( 0, - 1000, 0 ) ),
			pushRadius: uniform( 0.9 ),
			heightScale: uniform( GRASS_DEFAULTS.heightScale ),
			widthScale: uniform( GRASS_DEFAULTS.widthScale ),
			clumpSize: uniform( GRASS_DEFAULTS.clumpSize ),
			epoch: uniform( 0 ),
			fadeIn: uniform( new THREE.Vector2( ...( fadeIn || [ - 2, - 1 ] ) ) ),
			fadeOut: uniform( new THREE.Vector2( ...( fadeOut || [ area * 0.35, area * 0.485 ] ) ) ),
			widthMul: uniform( widthScale ),
			aoMin: uniform( aoMin ),
			groundBlend: uniform( groundBlend ),
		};

		const count = this.count;
		// interleaved static data, 4 x vec4 per slot: s0, s1, s2, keys
		this.st = storageVec( count * 4, 4, 'vec4', 1e9 );
		this.dyn = storageVec( count, 4, 'vec4' ); // wind, cloud shadow, push.xz

		const R = area * 0.5;
		this.lods = createLODs( ( lods || [
			{ segments: 12, maxDistance: Math.min( 7 * lodScale, R ) },
			{ segments: 5, maxDistance: Math.min( 20 * lodScale, R ) },
			{ segments: 2, maxDistance: Infinity },
		] ).map( ( l ) => ( { geometry: bladeGeometry( l.segments ), maxDistance: l.maxDistance } ) ), count );

		this.resetCompute = createResetCompute( this.lods );
		this.mainCompute = this.buildCompute().compute( count );

		this.group = new THREE.Group();
		this.meshes = this.lods.lods.map( ( lod, i ) => {

			const mesh = new THREE.Mesh( lod.geometry, this.buildMaterial( lod ) );
			mesh.frustumCulled = false;
			mesh.count = count;
			mesh.renderOrder = renderOrder + i;
			this.group.add( mesh );
			return mesh;

		} );

	}

	// ------------------------------------------------------------------ compute

	buildCompute() {

		const { st, dyn, lods, u } = this;
		const N = this.N;

		const rebuild = ( idx, gx, gz ) => {

			const j = hash2i2( gx, gz );
			const xz = vec2( float( gx ).add( j.x ), float( gz ).add( j.y ) ).mul( u.spacing ).toVar();
			const y = terrainHeight( xz );
			const n = terrainNormal( xz );

			// --- Voronoi clumps: find nearest + second nearest feature point
			// domain-warped clump cells: irregular tussock shapes, no grid look from above
			const warp = G.tussock ? vec2( vnoise( xz.mul( 0.31 ).add( vec2( 3.1, 7.7 ) ) ), vnoise( xz.mul( 0.31 ).add( vec2( 9.4, 1.3 ) ) ) ).sub( 0.5 ).mul( 1.6 ) : vec2( 0 );
			const cp = xz.add( warp ).div( u.clumpSize );
			const cell = floor( cp );
			const f = fract( cp );
			const d1 = float( 1e9 ).toVar();
			const d2 = float( 1e9 ).toVar();
			const id1 = vec2( 0 ).toVar();
			const toC = vec2( 0 ).toVar();
			for ( let oy = - 1; oy <= 1; oy ++ ) for ( let ox = - 1; ox <= 1; ox ++ ) {

				const cid = cell.add( vec2( ox, oy ) );
				const r = hash2i2( int( cid.x ).add( 311 ), int( cid.y ).add( 101 ) );
				const diff = vec2( ox, oy ).add( r ).sub( f );
				const dd = dot( diff, diff );
				If( dd.lessThan( d1 ), () => {

					d2.assign( d1 );
					d1.assign( dd );
					id1.assign( cid );
					toC.assign( diff );

				} ).ElseIf( dd.lessThan( d2 ), () => {

					d2.assign( dd );

				} );

			}

			const dC = sqrt( d1 );
			const edge = smoothstep( 0.0, 0.25, sqrt( d2 ).sub( dC ) ); // 0 at clump border
			const cix = int( id1.x ), ciz = int( id1.y );
			const cH = hash2i( cix.add( 17 ), ciz.add( 5 ) );
			const cW = hash2i( cix.add( 3 ), ciz.add( 91 ) );
			const cB = hash2i( cix.add( 71 ), ciz.add( 13 ) );
			const cSeed = hash2i( cix.add( 47 ), ciz.add( 31 ) );

			const b0 = hash2i( gx.add( 1 ), gz );
			const b1 = hash2i( gx.add( 2 ), gz );
			const b2 = hash2i( gx.add( 3 ), gz );
			const b3 = hash2i( gx.add( 4 ), gz );

			// --- meadow-scale variation
			const tall = fieldTall( xz );
			const dry0 = fieldDry( xz );

			// tussock grassland (plains): some clumps are tall golden tussocks,
			// the rest a short green sward between them
			// which clumps grow into tall tussocks: drifts of them at several scales
			// (not a per-clump coin toss, which reads as camouflage dots from above)
			// (smooth fields at three scales; the clump hash only nudges it)
			// (smooth, large drifts; the clump hash only nudges it)
			const tf = G.tussock ? vnoise( xz.div( 38.0 ).add( vec2( 4.2, 1.9 ) ) ).mul( 0.62 ).add( vnoise( xz.div( 12.0 ).add( vec2( 8.8, 3.3 ) ) ).mul( 0.3 ) ).add( cH.mul( 0.08 ) ) : cH;
			const tus = smoothstep( 0.3, 0.75, tf ).mul( G.tussock || 0 );
			// colour regions: greener swales and golden, wind-cured slopes (+ the tussocks' own straw)
			const region = G.tussock ? vnoise( xz.div( 55.0 ).add( vec2( 17.0, 5.0 ) ) ) : float( 0.5 );
			const dry = G.tussock ? clamp( dry0.mul( 0.35 ).add( tus.mul( 0.38 ) ).add( region.sub( 0.5 ).mul( 0.8 ) ).sub( 0.08 ), 0.0, 1.0 ) : dry0;
			const h = mix( G.hMin, G.hMax, tall )
				.mul( mix( 1.0, mix( 0.38, 1.3, tus ), G.tussock || 0 ) )
				// height varies smoothly across the plain (a gentle swell, not per clump)
				.mul( G.tussock ? mix( 0.72, 1.3, vnoise( xz.div( 14.0 ).add( vec2( 3.7, 9.1 ) ) ) ).mul( mix( 0.94, 1.06, cH ) ) : mix( 0.72, 1.18, cH ) )
				.mul( mix( 0.7, 1.15, b0 ) )
				// blades at the clump centre are taller (tussock dome)
				.mul( mix( 0.78, 1.0, clamp( float( 1.0 ).sub( dC.mul( 1.1 ) ), 0, 1 ) ) )
				.mul( u.heightScale )
				// biome mask (e.g. a trail through the plains)
				.mul( BIOME.grassMask ? BIOME.grassMask( xz ) : float( 1.0 ) )
				;

			const w = mix( G.wMin, G.wMax, cW ).mul( mix( 0.7, 1.3, b1 ) ).mul( mix( 1.0, 0.8, dry ) ).mul( u.widthScale ).mul( u.widthMul )
				// short sward between tussocks: fine blades, not leaf-like slivers
				.mul( mix( 1.0, mix( 0.55, 1.0, tus ), G.tussock || 0 ) );
			const bend = mix( 0.15, 0.6, cB ).mul( mix( 0.6, 1.35, b2 ) ).mul( float( 0.55 ).add( dC.mul( 0.9 ) ) ).add( dry.mul( 0.15 ) );

			// yaw: lean outward from clump centre, randomised near clump borders
			const outward = toC.negate();
			const yawOut = atan( outward.x.negate(), outward.y );
			const yaw = yawOut.add( b3.sub( 0.5 ).mul( mix( 3.14, 1.2, edge ) ) );

			st.element( idx.mul( 4 ).add( 0 ) ).assign( vec4( xz.x, y, xz.y, h ) );
			st.element( idx.mul( 4 ).add( 1 ) ).assign( vec4( w, bend, yaw, dry ) );
			st.element( idx.mul( 4 ).add( 2 ) ).assign( vec4( n.x, n.z, cSeed, b0 ) );
			st.element( idx.mul( 4 ).add( 3 ) ).assign( vec4( float( gx ), float( gz ), u.epoch, fieldFlowers( xz ) ) );

		};

		return Fn( () => {

			const idx = instanceIndex;
			const ix = int( idx.div( uint( N ) ) );
			const iz = int( idx.mod( uint( N ) ) );
			const bx = int( u.base.x ), bz = int( u.base.y );
			const gx = bx.add( ix.sub( bx ).mod( int( N ) ).add( int( N ) ).mod( int( N ) ) ).toVar();
			const gz = bz.add( iz.sub( bz ).mod( int( N ) ).add( int( N ) ).mod( int( N ) ) ).toVar();

			const key = st.element( idx.mul( 4 ).add( 3 ) );
			If( key.x.notEqual( float( gx ) ).or( key.y.notEqual( float( gz ) ) ).or( key.z.notEqual( u.epoch ) ), () => {

				rebuild( idx, gx, gz );

			} );

			const P = st.element( idx.mul( 4 ).add( 0 ) ).toVar();
			const pos = P.xyz;
			const h = P.w;

			const rel = pos.sub( u.cullPos );
			const distXZ = length( rel.xz );
			// stochastic crossfade: a blade survives while its stable per-cell hash < keep(distance)
			const keep = smoothstep( u.fadeIn.x, u.fadeIn.y, distXZ ).mul( float( 1.0 ).sub( smoothstep( u.fadeOut.x, u.fadeOut.y, distXZ ) ) );
			const inRadius = distXZ.lessThan( u.radius ).and( hash2i( int( key.x ).add( 5 ), int( key.y ) ).lessThan( keep ) );

			// sphere-vs-frustum test in clip space (conservative)
			const centre = vec3( pos.x, pos.y.add( h.mul( 0.5 ) ), pos.z );
			const clip = u.viewProj.mul( vec4( centre, 1.0 ) );
			const rad = h.mul( 0.9 ).add( 0.25 );
			const inFrustum = clip.w.greaterThan( rad.negate() )
				.and( abs( clip.x ).lessThan( clip.w.add( rad.mul( 2.0 ) ) ) )
				.and( abs( clip.y ).lessThan( clip.w.add( rad.mul( 2.0 ) ) ) );

			If( inRadius.and( inFrustum.or( distXZ.lessThan( 1.5 ) ) ).and( h.greaterThan( 0.02 ) ), () => {

				const xz = pos.xz;
				const wind = windField( xz );
				const cloud = cloudShadow( xz );

				// walker push (only when the pusher is near the ground)
				const pd = xz.sub( u.pusher.xz );
				const pl = length( pd );
				const near = smoothstep( 1.6, 0.6, abs( u.pusher.y.sub( pos.y ) ) );
				const amt = smoothstep( u.pushRadius, 0.0, pl ).mul( near );
				const push0 = select( pl.greaterThan( 0.001 ), pd.div( pl ), vec2( 0 ) ).mul( amt ).add( actorPush( xz, pos.y ) );
				const pushL = length( push0 );
				const push = select( pushL.greaterThan( 1.0 ), push0.div( pushL ), push0 );

				dyn.element( idx ).assign( vec4( wind, cloud.mul( actorShadowAt( xz ) ), push.x, push.y ) );

				const jitter = pcg( idx ).sub( 0.5 ).mul( 0.18 ).add( 1.0 );
				routeLOD( lods, length( rel ).mul( jitter ), idx );

			} );

		} )();

	}

	// ------------------------------------------------------------------ material

	buildMaterial( lod ) {

		const { st, dyn, lods, u } = this;

		const vT = varying( float( 0 ), 'vT' );
		const vS = varying( float( 0 ), 'vS' );
		const vN = varying( vec3( 0 ), 'vN' );
		const vR = varying( vec3( 0 ), 'vR' );
		const vWorld = varying( vec3( 0 ), 'vWorld' );
		const vGround = varying( vec3( 0, 1, 0 ), 'vGround' );
		const vInfo = varying( vec4( 0 ), 'vInfo' ); // dry, clumpSeed, bladeSeed, cloud
		const vExtra = varying( vec2( 0 ), 'vExtra' ); // wind, flower density
		const vDist = varying( float( 0 ), 'vDist' );

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;

		mat.positionNode = Fn( () => {

			const id = visibleSlot( lods, lod, instanceIndex );
			const A = st.element( id.mul( 4 ).add( 0 ) );
			const B = st.element( id.mul( 4 ).add( 1 ) );
			const C = st.element( id.mul( 4 ).add( 2 ) );
			const K = st.element( id.mul( 4 ).add( 3 ) );
			const D = dyn.element( id );

			const root = A.xyz;
			const camDist = length( cameraPosition.sub( root ) );
			const distXZ = length( cameraPosition.xz.sub( root.xz ) );
			const seed = C.w;

			// fade the outer ring by shrinking blades -> no visible boundary
			// density crossfade (see compute): blades grow in/out over a short margin
			// instead of popping; heights are otherwise untouched -> no visible seam
			const keep = smoothstep( u.fadeIn.x, u.fadeIn.y, distXZ ).mul( float( 1.0 ).sub( smoothstep( u.fadeOut.x, u.fadeOut.y, distXZ ) ) );
			const cellHash = hash2i( int( K.x ).add( 5 ), int( K.y ) );
			const h0 = A.w.mul( smoothstep( 0.0, 0.08, keep.sub( cellHash ) ) );
			const subK = lod.geometry.userData.K || 1;
			const sub = subK > 1 ? attribute( 'sub', 'float' ) : float( 0 );
			// sub-blades of a tuft: fanned out, shorter, bent differently, rooted a little apart
			const r1 = fract( seed.mul( sub.mul( 7.31 ).add( 13.7 ) ).add( sub.mul( 0.618 ) ) );
			const r2 = fract( seed.mul( sub.mul( 3.7 ).add( 29.3 ) ).add( sub.mul( 0.37 ) ) );
			const isSub = sub.greaterThan( 0.5 );
			const seedF = fract( seed.add( sub.mul( 0.371 ) ) );
			const h = h0.mul( select( isSub, mix( 0.55, 0.95, r2 ), float( 1.0 ) ) );
			const bend = B.y.mul( select( isSub, mix( 0.8, 1.5, r2 ), float( 1.0 ) ) );
			const yaw = B.z.add( select( isSub, sub.sub( ( subK - 1 ) * 0.5 + 0.5 ).mul( 1.9 ).add( r1.sub( 0.5 ).mul( 1.2 ) ), float( 0.0 ) ) );
			const wind = D.x;
			const push = D.zw;

			const t = uv().y;
			const s = uv().x.mul( 2.0 ).sub( 1.0 );

			const up = vec3( 0, 1, 0 );
			const fwd = vec3( sin( yaw ).negate(), 0, cos( yaw ) );
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const Wp = vec3( U.windDir.y.negate(), 0, U.windDir.x );

			// sway: a travelling phase (moves with the gust field) + per-blade flutter
			const phase = dot( root.xz, U.windDir ).mul( 0.42 ).sub( U.windPhase.mul( 0.42 ) ).add( seed.mul( 1.5 ) );
			const flutter = sin( U.time.mul( mix( ( G.flutterHz || [ 2.2, 4.2 ] )[ 0 ], ( G.flutterHz || [ 2.2, 4.2 ] )[ 1 ], seedF ) ).add( seedF.mul( 61.0 ) ) );
			const wAmt = wind.mul( float( 1.0 ).add( sin( phase ).mul( 0.35 ) ) );
			const wh = wAmt.mul( h );

			// Bezier control points (relative to root)
			const p1 = up.mul( h.mul( 0.33 ) ).add( fwd.mul( h.mul( bend ).mul( 0.1 ) ) ).add( W.mul( wh.mul( 0.08 ) ) ).toVar();
			const p2 = up.mul( h.mul( 0.66 ) ).add( fwd.mul( h.mul( bend ).mul( 0.36 ) ) ).add( W.mul( wh.mul( 0.34 ) ) ).toVar();
			const p3 = up.mul( h.mul( float( 1.0 ).sub( bend.mul( 0.3 ) ) ) ).add( fwd.mul( h.mul( bend ).mul( 0.72 ) ) )
				.add( W.mul( wh.mul( 0.8 ) ) ).add( Wp.mul( flutter.mul( wh ).mul( G.flutter ) ) ).toVar();

			// walker push: lay the blade over, away from the walker
			const pushLen = length( push );
			const pushDir = vec3( push.x, 0, push.y );
			p1.addAssign( pushDir.mul( h.mul( 0.08 ) ) );
			p2.addAssign( pushDir.mul( h.mul( 0.4 ) ).sub( up.mul( h.mul( pushLen ).mul( 0.18 ) ) ) );
			p3.addAssign( pushDir.mul( h.mul( 0.85 ) ).sub( up.mul( h.mul( pushLen ).mul( 0.4 ) ) ) );

			// keep blade length roughly constant when bent
			const chord = float( 1.0 ).sub( bend.mul( 0.18 ) ).mul( h );
			const k = chord.div( max( length( p3 ), 1e-4 ) );
			p3.mulAssign( k );
			p2.mulAssign( mix( 1.0, k, 0.6 ) );
			// never bend into the ground (it would be clipped by the terrain):
			// clamp against the local ground plane, not just y = 0
			const gn = vec3( C.x, sqrt( max( float( 0.05 ), float( 1 ).sub( C.x.mul( C.x ) ).sub( C.y.mul( C.y ) ) ) ), C.y );
			const groundAt = ( p ) => p.x.mul( gn.x ).add( p.z.mul( gn.z ) ).div( gn.y ).negate();
			p2.y.assign( max( p2.y, groundAt( p2 ).add( h.mul( 0.22 ) ).add( 0.02 ) ) );
			p3.y.assign( max( p3.y, groundAt( p3 ).add( h.mul( 0.14 ) ).add( 0.03 ) ) );

			const it = float( 1.0 ).sub( t );
			const spine = p1.mul( it.mul( it ).mul( t ).mul( 3.0 ) )
				.add( p2.mul( it.mul( t ).mul( t ).mul( 3.0 ) ) )
				.add( p3.mul( t.mul( t ).mul( t ) ) );
			const tangent = normalize(
				p1.mul( it.mul( it ).mul( 3.0 ) )
					.add( p2.sub( p1 ).mul( it.mul( t ).mul( 6.0 ) ) )
					.add( p3.sub( p2 ).mul( t.mul( t ).mul( 3.0 ) ) )
			);

			// width direction: blend toward camera-facing as distance grows so
			// edge-on blades don't vanish into sub-pixel slivers (shimmer).
			const side0 = vec3( cos( yaw ), 0, sin( yaw ) );
			const toCam = cameraPosition.sub( root );
			const vh = normalize( vec3( toCam.x, 0, toCam.z ).add( vec3( 1e-4, 0, 0 ) ) );
			const sideV = vec3( vh.z.negate(), 0, vh.x );
			const sideVf = sideV.mul( select( dot( side0, sideV ).lessThan( 0 ), float( - 1 ), float( 1 ) ) );
			const side = normalize( mix( side0, sideVf, mix( 0.2, 0.8, smoothstep( 1.5, 35.0, camDist ) ) ) );

			const widthBoost = float( 1.0 ).add( smoothstep( 6.0, u.radius, camDist ).mul( 1.6 ) );
			const profile = pow( it, 0.8 ).mul( mix( 0.55, 1.0, smoothstep( 0.0, 0.15, t ) ) );
			const w = B.x.mul( profile ).mul( widthBoost ).mul( select( isSub, float( 0.85 ), float( 1.0 ) ) );

			const rootOff = select( isSub, vec3( sin( yaw ).negate(), 0, cos( yaw ) ).mul( r1.mul( 0.025 ).add( 0.008 ) ), vec3( 0 ) );
			const world = root.add( rootOff ).add( spine ).add( side.mul( s.mul( w ) ) );

			vT.assign( t );
			vS.assign( s );
			vN.assign( normalize( cross( side, tangent ) ) );
			vR.assign( side );
			vWorld.assign( world );
			vGround.assign( gn );
			vInfo.assign( vec4( B.w, C.z, seed, D.y ) );
			vExtra.assign( vec2( D.x, K.w ) );
			vDist.assign( camDist );

			return world;

		} )();

		mat.colorNode = Fn( () => {

			const t = vT;
			const dryF = vInfo.x;
			const cSeed = vInfo.y;
			const bSeed = vInfo.z;
			const cloud = vInfo.w;

			// --- albedo (linear)
			const lushBase = c3( G.lushBase );
			const lushTip = mix( c3( G.lushTipA ), c3( G.lushTipB ), cSeed ).toVar();
			lushTip.assign( mix( lushTip, c3( G.lushTipC ), smoothstep( 0.75, 1.0, cSeed ) ) );
			const dryBase = c3( G.dryBase );
			const dryTip = mix( c3( G.dryTipA ), c3( G.dryTipB ), bSeed );

			// dead blades scattered everywhere + dry patches
			const dead = smoothstep( G.dead, G.dead + 0.07, fract( bSeed.mul( 13.37 ) ) );
			const dryness = clamp( dryF.mul( mix( 0.55, 1.0, bSeed ) ).add( dead.mul( 0.8 ) ), 0, 1 );

			const grad = smoothstep( 0.0, 1.0, pow( t, 0.75 ) );
			const lush = mix( lushBase, lushTip, grad );
			const dryC = mix( dryBase, dryTip, grad );
			const albedo = mix( lush, dryC, dryness ).toVar();
			// sun-burnt tips
			albedo.assign( mix( albedo, dryTip.mul( 0.85 ), smoothstep( 0.82, 1.0, t ).mul( float( 0.25 ).add( dryness.mul( 0.5 ) ) ) ) );
			albedo.mulAssign( mix( 0.8, 1.15, bSeed ) );
			// midrib: slightly lighter centre line
			albedo.mulAssign( mix( 1.12, 0.94, smoothstep( 0.0, 0.35, abs( vS ) ) ) );
			// fine parallel veins along the blade (close up only)
			albedo.mulAssign( sin( vS.mul( 17.0 ).add( bSeed.mul( 20.0 ) ) ).mul( 0.09 ).mul( smoothstep( 12.0, 2.0, vDist ) ).add( 1.0 ) );

			// --- normal: rounded blade + blend toward ground normal (canopy
			// behaves like a volume, stabilises lighting at distance)
			const nB = normalize( vN.add( vR.mul( vS.mul( 0.55 ) ) ) ).mul( faceDirection );
			const far = smoothstep( 4.0, 40.0, vDist );
			const N = normalize( mix( nB, vGround, clamp( mix( 0.22, 0.65, far ).add( u.groundBlend ), 0.0, 1.0 ) ) );

			// --- occlusion: dark near the ground, inside dense canopy
			const ao = mix( u.aoMin, 1.0, pow( t, 0.85 ) );

			const transmit = mix( 0.55, 1.0, t ).mul( mix( 1.0, 0.45, dryness ) );
			const spec = mix( 0.03, 0.18, t ).mul( mix( 1.0, 0.4, dryness ) );

			// wind waves: canopy brightens as a gust bends it
			const sheen = gustSheen( vExtra.x );
			albedo.mulAssign( sheen );

			// night: blue light from nearby glowing flowers, strongest mid-blade
			const glow = flowerGlowLight( vExtra.y, smoothstep( 0.0, 0.7, t ).mul( smoothstep( 1.0, 0.6, t ) ) );
			const emit = glow.mul( albedo.mul( 3.0 ).add( 0.12 ) );

			return shadeFoliage( albedo, N, vWorld, ao, cloud.mul( mix( 0.55, 1.0, t ) ), transmit, spec.mul( sheen ), float( 0.4 ), emit );

		} )();

		return mat;

	}

	// ------------------------------------------------------------------ frame

	// force every slot to rebuild its static data (after a parameter change)
	invalidate() {

		this.u.epoch.value ++;

	}


	update( renderer, camera, pusher ) {

		const N = this.N, sp = this.spacing;
		const cx = Math.floor( camera.position.x / sp );
		const cz = Math.floor( camera.position.z / sp );
		this.u.base.value.set( cx - N / 2, cz - N / 2 );
		this.u.cullPos.value.copy( camera.position );
		this.u.viewProj.value.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		if ( pusher ) this.u.pusher.value.copy( pusher );

		renderer.compute( this.resetCompute );
		renderer.compute( this.mainCompute );

	}

	dispose() {

		for ( const m of this.meshes ) {

			m.geometry.dispose();
			m.material.dispose();

		}

		this.mainCompute.dispose();
		this.resetCompute.dispose();
		disposeStorage( this.st, this.dyn, this.lods.indices, this.lods.drawBuffer );

		this.group.removeFromParent();

	}

}
