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
	cameraPosition, faceDirection, select
} from 'three/tsl';
import { hash2i, hash2i2, pcg } from './tsl/noise.js';
import {
	U, terrainHeight, terrainNormal, fieldTall, fieldDry, fieldFlowers, windField, cloudShadow, shadeFoliage, gustSheen, flowerGlowLight
} from './tsl/world.js';
import { storageVec, createLODs, createResetCompute, routeLOD, visibleSlot, disposeStorage } from './gpu.js';

const RENDER_ORDER = 0;

export const GRASS_DEFAULTS = {
	heightScale: 1.0,
	widthScale: 1.0,
	clumpSize: 1.1,
};

function bladeGeometry( segments ) {

	const g = new THREE.PlaneGeometry( 1, 1, 1, segments );
	g.translate( 0, 0.5, 0 );
	return g;

}

export class Grass {

	constructor( { bladesPerAxis, area, lodScale = 1, innerRadius = 0, widthScale = 1, lods = null, renderOrder = RENDER_ORDER } ) {

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
			inner: uniform( innerRadius ), // > 0: ring system that starts where a nearer one ends
			widthMul: uniform( widthScale ),
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
			const cp = xz.div( u.clumpSize );
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
			const dry = fieldDry( xz );

			const h = mix( 0.14, 1.05, tall )
				.mul( mix( 0.72, 1.18, cH ) )
				.mul( mix( 0.7, 1.15, b0 ) )
				// blades at the clump centre are taller (tussock dome)
				.mul( mix( 0.78, 1.0, clamp( float( 1.0 ).sub( dC.mul( 1.1 ) ), 0, 1 ) ) )
				.mul( u.heightScale );

			const w = mix( 0.009, 0.024, cW ).mul( mix( 0.7, 1.3, b1 ) ).mul( mix( 1.0, 0.8, dry ) ).mul( u.widthScale ).mul( u.widthMul );
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
			const inRadius = distXZ.lessThan( u.radius ).and( distXZ.greaterThan( u.inner.mul( 0.7 ) ) );

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
				const push = select( pl.greaterThan( 0.001 ), pd.div( pl ), vec2( 0 ) ).mul( amt );

				dyn.element( idx ).assign( vec4( wind, cloud, push.x, push.y ) );

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
			const dj = distXZ.mul( float( 0.94 ).add( seed.mul( 0.12 ) ) );
			// outer fade, and (ring systems) inner fade-in where the nearer system fades out
			const edge = smoothstep( u.radius, u.radius.mul( 0.8 ), dj )
				.mul( clamp( dj.sub( u.inner.mul( 0.72 ) ).div( u.inner.mul( 0.26 ).add( 1e-3 ) ), 0.0, 1.0 ) );
			const h = A.w.mul( edge );
			const bend = B.y;
			const yaw = B.z;
			const wind = D.x;
			const push = D.zw;

			const t = uv().y;
			const s = uv().x.mul( 2.0 ).sub( 1.0 );

			const up = vec3( 0, 1, 0 );
			const fwd = vec3( sin( yaw ).negate(), 0, cos( yaw ) );
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const Wp = vec3( U.windDir.y.negate(), 0, U.windDir.x );

			// sway: a travelling phase (moves with the gust field) + per-blade flutter
			const phase = dot( root.xz, U.windDir ).mul( 0.42 ).sub( U.time.mul( U.windSpeed ).mul( 0.42 ) ).add( seed.mul( 1.5 ) );
			const flutter = sin( U.time.mul( mix( 2.2, 4.2, seed ) ).add( seed.mul( 61.0 ) ) );
			const wAmt = wind.mul( float( 1.0 ).add( sin( phase ).mul( 0.35 ) ) );
			const wh = wAmt.mul( h );

			// Bezier control points (relative to root)
			const p1 = up.mul( h.mul( 0.33 ) ).add( fwd.mul( h.mul( bend ).mul( 0.1 ) ) ).add( W.mul( wh.mul( 0.08 ) ) ).toVar();
			const p2 = up.mul( h.mul( 0.66 ) ).add( fwd.mul( h.mul( bend ).mul( 0.36 ) ) ).add( W.mul( wh.mul( 0.34 ) ) ).toVar();
			const p3 = up.mul( h.mul( float( 1.0 ).sub( bend.mul( 0.3 ) ) ) ).add( fwd.mul( h.mul( bend ).mul( 0.72 ) ) )
				.add( W.mul( wh.mul( 0.8 ) ) ).add( Wp.mul( flutter.mul( wh ).mul( 0.07 ) ) ).toVar();

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
			const w = B.x.mul( profile ).mul( widthBoost );

			const world = root.add( spine ).add( side.mul( s.mul( w ) ) );

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
			const lushBase = vec3( 0.025, 0.05, 0.012 );
			const lushTip = mix( vec3( 0.11, 0.23, 0.04 ), vec3( 0.17, 0.26, 0.05 ), cSeed ).toVar();
			lushTip.assign( mix( lushTip, vec3( 0.08, 0.22, 0.06 ), smoothstep( 0.75, 1.0, cSeed ) ) );
			const dryBase = vec3( 0.12, 0.1, 0.04 );
			const dryTip = mix( vec3( 0.42, 0.33, 0.15 ), vec3( 0.55, 0.45, 0.25 ), bSeed );

			// dead blades scattered everywhere + dry patches
			const dead = smoothstep( 0.9, 0.97, fract( bSeed.mul( 13.37 ) ) );
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

			// --- normal: rounded blade + blend toward ground normal (canopy
			// behaves like a volume, stabilises lighting at distance)
			const nB = normalize( vN.add( vR.mul( vS.mul( 0.55 ) ) ) ).mul( faceDirection );
			const far = smoothstep( 4.0, 40.0, vDist );
			const N = normalize( mix( nB, vGround, mix( 0.22, 0.65, far ) ) );

			// --- occlusion: dark near the ground, inside dense canopy
			const ao = mix( 0.2, 1.0, pow( t, 0.85 ) );

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
