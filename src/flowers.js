// GPU-driven wildflowers: oxeye daisy, buttercup, poppy, cornflower, campion.
// Same architecture as the grass (toroidal slot window, compute culling,
// LOD lists, indirect draws). Each flower is one small parametric mesh whose
// vertices are tagged as stem / petal / centre; the vertex shader bends the
// stem like a grass blade and builds a sun-tracking head on top of it.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, int, uint, vec2, vec3, vec4, If, instanceIndex, uv, varying, floor, fract,
	mix, smoothstep, clamp, max, pow, sin, cos, dot, length, normalize, cross, abs, select,
	cameraPosition, faceDirection, positionGeometry, PI
} from 'three/tsl';
import { hash2i, hash2i2, pcg, vnoise } from './tsl/noise.js';
import { U, terrainHeight, fieldTall, fieldFlowers, windField, cloudShadow, shadeFoliage, actorPush, actorShadowAt } from './tsl/world.js';
import { storageVec, createLODs, createResetCompute, routeLOD, visibleSlot, disposeStorage } from './gpu.js';

const TYPES = 5;
const RENDER_ORDER = 5; // 0 daisy, 1 buttercup, 2 poppy, 3 cornflower, 4 campion

// per-type value table -> nested select
const pick = ( type, values ) => {

	let r = float( values[ values.length - 1 ] );
	for ( let i = values.length - 2; i >= 0; i -- ) r = select( type.lessThan( i + 0.5 ), float( values[ i ] ), r );
	return r;

};

const pick3 = ( type, values ) => {

	let r = vec3( ...values[ values.length - 1 ] );
	for ( let i = values.length - 2; i >= 0; i -- ) r = select( type.lessThan( i + 0.5 ), vec3( ...values[ i ] ), r );
	return r;

};

// part: 0 stem, 1 petal, 2 centre. position = part-specific params, uv = (part, petal index)
function flowerGeometry( stemSegs, petals, petalSegs, ringSegs ) {

	const pos = [], uvs = [], idx = [];
	const vert = ( a, b, part, k ) => {

		pos.push( a, b, 0 );
		uvs.push( part, k );
		return pos.length / 3 - 1;

	};

	// stem strip
	const s0 = pos.length / 3;
	for ( let i = 0; i <= stemSegs; i ++ ) {

		vert( - 1, i / stemSegs, 0, 0 );
		vert( 1, i / stemSegs, 0, 0 );

	}

	for ( let i = 0; i < stemSegs; i ++ ) {

		const a = s0 + i * 2;
		idx.push( a, a + 1, a + 2, a + 1, a + 3, a + 2 );

	}

	// petals
	for ( let k = 0; k < petals; k ++ ) {

		const p0 = pos.length / 3;
		for ( let i = 0; i <= petalSegs; i ++ ) {

			vert( i / petalSegs, - 1, 1, k );
			vert( i / petalSegs, 1, 1, k );

		}

		for ( let i = 0; i < petalSegs; i ++ ) {

			const a = p0 + i * 2;
			idx.push( a, a + 1, a + 2, a + 1, a + 3, a + 2 );

		}

	}

	// centre: fan + one ring
	const c0 = vert( 0, 0, 2, 0 );
	const ring = ( r ) => {

		const first = pos.length / 3;
		for ( let i = 0; i < ringSegs; i ++ ) vert( r, i / ringSegs, 2, 0 );
		return first;

	};

	const r1 = ring( 0.55 ), r2 = ring( 1.0 );
	for ( let i = 0; i < ringSegs; i ++ ) {

		const j = ( i + 1 ) % ringSegs;
		idx.push( c0, r1 + i, r1 + j );
		idx.push( r1 + i, r2 + i, r2 + j, r1 + i, r2 + j, r1 + j );

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	g.setIndex( idx );
	return g;

}

export class Flowers {

	constructor( { perAxis, area } ) {

		this.N = perAxis;
		this.area = area;
		this.spacing = area / perAxis;
		this.count = this.N * this.N;

		this.u = {
			base: uniform( new THREE.Vector2() ),
			spacing: uniform( this.spacing ),
			radius: uniform( area * 0.5 ),
			viewProj: uniform( new THREE.Matrix4() ),
			cullPos: uniform( new THREE.Vector3() ),
			pusher: uniform( new THREE.Vector3( 0, - 1000, 0 ) ),
			heightScale: uniform( 1 ),
			density: uniform( 0.9 ),
			epoch: uniform( 0 ),
		};

		const count = this.count;
		// interleaved static data, 3 x vec4 per slot: s0, s1, keys
		this.st = storageVec( count * 3, 4, 'vec4', 1e9 );
		this.dyn = storageVec( count, 4, 'vec4' ); // wind, cloud, push.xz

		this.lods = createLODs( [
			{ geometry: flowerGeometry( 6, 12, 3, 10 ), maxDistance: 16 },
			{ geometry: flowerGeometry( 2, 6, 1, 5 ), maxDistance: Infinity },
		], count );

		this.resetCompute = createResetCompute( this.lods );
		this.mainCompute = this.buildCompute().compute( count );

		this.group = new THREE.Group();
		this.meshes = this.lods.lods.map( ( lod, i ) => {

			const mesh = new THREE.Mesh( lod.geometry, this.buildMaterial( lod, i ) );
			mesh.frustumCulled = false;
			mesh.count = count;
			mesh.renderOrder = RENDER_ORDER + i;
			this.group.add( mesh );
			return mesh;

		} );

	}

	buildCompute() {

		const { st, dyn, lods, u } = this;
		const N = this.N;

		const rebuild = ( idx, gx, gz ) => {

			const j = hash2i2( gx.add( 7 ), gz.add( 19 ) );
			const xz = vec2( float( gx ).add( j.x ), float( gz ).add( j.y ) ).mul( u.spacing ).toVar();
			const y = terrainHeight( xz );

			const r0 = hash2i( gx.add( 11 ), gz.add( 3 ) );
			const r1 = hash2i( gx.add( 5 ), gz.add( 29 ) );
			const r2 = hash2i( gx.add( 23 ), gz.add( 1 ) );
			const r3 = hash2i( gx.add( 2 ), gz.add( 41 ) );

			const dens = fieldFlowers( xz ).mul( 0.8 ).add( 0.06 ).mul( u.density );
			const accept = r0.lessThan( dens );

			// species form drifts: low-frequency noise + a little per-flower randomness
			const sp = vnoise( xz.div( 21.0 ).add( vec2( 300.0, 11.0 ) ) ).mul( 1.6 ).add( vnoise( xz.div( 6.0 ) ).mul( 0.4 ) ).add( r1.mul( 0.45 ) );
			const type = floor( fract( sp ).mul( TYPES ) );

			const grassH = mix( 0.14, 1.05, fieldTall( xz ) ).mul( u.heightScale );
			const minH = pick( type, [ 0.32, 0.26, 0.38, 0.4, 0.4 ] );
			const h = max( grassH.mul( mix( 0.95, 1.35, r2 ) ), minH.mul( mix( 0.9, 1.3, r2 ) ) );
			const size = pick( type, [ 1.0, 0.75, 1.15, 0.85, 0.85 ] ).mul( mix( 0.8, 1.2, r3 ) );

			st.element( idx.mul( 3 ).add( 0 ) ).assign( vec4( xz.x, y, xz.y, select( accept, h, float( 0 ) ) ) );
			st.element( idx.mul( 3 ).add( 1 ) ).assign( vec4( type, size, r1.mul( 6.2831 ), r3 ) );
			st.element( idx.mul( 3 ).add( 2 ) ).assign( vec4( float( gx ), float( gz ), u.epoch, 0 ) );

		};

		return Fn( () => {

			const idx = instanceIndex;
			const ix = int( idx.div( uint( N ) ) );
			const iz = int( idx.mod( uint( N ) ) );
			const bx = int( u.base.x ), bz = int( u.base.y );
			const gx = bx.add( ix.sub( bx ).mod( int( N ) ).add( int( N ) ).mod( int( N ) ) ).toVar();
			const gz = bz.add( iz.sub( bz ).mod( int( N ) ).add( int( N ) ).mod( int( N ) ) ).toVar();

			const key = st.element( idx.mul( 3 ).add( 2 ) );
			If( key.x.notEqual( float( gx ) ).or( key.y.notEqual( float( gz ) ) ).or( key.z.notEqual( u.epoch ) ), () => {

				rebuild( idx, gx, gz );

			} );

			const P = st.element( idx.mul( 3 ).add( 0 ) ).toVar();
			const pos = P.xyz;
			const h = P.w;
			const rel = pos.sub( u.cullPos );
			const distXZ = length( rel.xz );

			const centre = vec3( pos.x, pos.y.add( h.mul( 0.6 ) ), pos.z );
			const clip = u.viewProj.mul( vec4( centre, 1.0 ) );
			const rad = h.mul( 0.7 ).add( 0.2 );
			const inFrustum = clip.w.greaterThan( rad.negate() )
				.and( abs( clip.x ).lessThan( clip.w.add( rad.mul( 2.0 ) ) ) )
				.and( abs( clip.y ).lessThan( clip.w.add( rad.mul( 2.0 ) ) ) );

			If( h.greaterThan( 0.0 ).and( distXZ.lessThan( u.radius ) ).and( inFrustum ), () => {

				const xz = pos.xz;
				const pd = xz.sub( u.pusher.xz );
				const pl = length( pd );
				const near = smoothstep( 1.6, 0.6, abs( u.pusher.y.sub( pos.y ) ) );
				const amt = smoothstep( 0.9, 0.0, pl ).mul( near );
				const push0 = select( pl.greaterThan( 0.001 ), pd.div( pl ), vec2( 0 ) ).mul( amt ).add( actorPush( xz, pos.y ) );
				const pushL = length( push0 );
				const push = select( pushL.greaterThan( 1.0 ), push0.div( pushL ), push0 );
				dyn.element( idx ).assign( vec4( windField( xz ), cloudShadow( xz ).mul( actorShadowAt( xz ) ), push.x, push.y ) );
				const jitter = pcg( idx ).sub( 0.5 ).mul( 0.2 ).add( 1.0 );
				routeLOD( lods, length( rel ).mul( jitter ), idx );

			} );

		} )();

	}

	buildMaterial( lod, lodIndex ) {

		const { st, dyn, lods, u } = this;
		const vWorld = varying( vec3( 0 ), 'vFWorld' );
		const vN = varying( vec3( 0 ), 'vFN' );
		const vP = varying( vec4( 0 ), 'vFP' ); // part, type, petal u, petal v
		const vI = varying( vec4( 0 ), 'vFI' ); // seed, cloud, stem t, centre r

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;

		mat.positionNode = Fn( () => {

			const id = visibleSlot( lods, lod, instanceIndex );
			const A = st.element( id.mul( 3 ).add( 0 ) );
			const B = st.element( id.mul( 3 ).add( 1 ) );
			const D = dyn.element( id );
			const root = A.xyz;
			const type = B.x;
			const size = B.y;
			const yaw = B.z;
			const seed = B.w;
			const wind = D.x;
			const push = D.zw;

			const distXZ = length( cameraPosition.xz.sub( root.xz ) );
			const camDist = length( cameraPosition.sub( root ) );
			const edge = smoothstep( u.radius, u.radius.mul( 0.82 ), distXZ );
			const h = A.w.mul( edge );

			const part = uv().x;
			const k = uv().y;
			const g = positionGeometry;

			const up = vec3( 0, 1, 0 );
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const lean = vec3( cos( yaw ), 0, sin( yaw ) ).mul( mix( 0.04, 0.16, seed ) );

			// flower heads bob on their stems: slower, larger motion than blades
			const phase = dot( root.xz, U.windDir ).mul( 0.42 ).sub( U.windPhase.mul( 0.42 ) );
			const bobF = sin( U.time.mul( mix( 1.3, 2.4, seed ) ).add( seed.mul( 40.0 ) ) );
			const wh = wind.mul( h ).mul( float( 1.0 ).add( sin( phase ).mul( 0.4 ) ) );

			const p1 = up.mul( h.mul( 0.35 ) ).add( W.mul( wh.mul( 0.06 ) ) ).toVar();
			const p2 = up.mul( h.mul( 0.7 ) ).add( lean.mul( h ).mul( 0.6 ) ).add( W.mul( wh.mul( 0.28 ) ) ).toVar();
			const p3 = up.mul( h ).add( lean.mul( h ) ).add( W.mul( wh.mul( 0.62 ) ) )
				.add( vec3( U.windDir.y.negate(), 0, U.windDir.x ).mul( bobF.mul( wh ).mul( 0.1 ) ) ).toVar();
			const pushDir = vec3( push.x, 0, push.y );
			p2.addAssign( pushDir.mul( h.mul( 0.4 ) ) );
			p3.addAssign( pushDir.mul( h.mul( 0.85 ) ).sub( up.mul( h.mul( length( push ) ).mul( 0.5 ) ) ) );
			const kk = h.mul( 0.97 ).div( max( length( p3 ), 1e-4 ) );
			p3.mulAssign( kk );
			p2.mulAssign( mix( 1.0, kk, 0.6 ) );
			p2.y.assign( max( p2.y, h.mul( 0.25 ) ) );
			p3.y.assign( max( p3.y, h.mul( 0.2 ) ) );

			const bez = ( t ) => {

				const it = float( 1.0 ).sub( t );
				return p1.mul( it.mul( it ).mul( t ).mul( 3.0 ) ).add( p2.mul( it.mul( t ).mul( t ).mul( 3.0 ) ) ).add( p3.mul( t.mul( t ).mul( t ) ) );

			};

			const tan = ( t ) => {

				const it = float( 1.0 ).sub( t );
				return normalize( p1.mul( it.mul( it ).mul( 3.0 ) ).add( p2.sub( p1 ).mul( it.mul( t ).mul( 6.0 ) ) ).add( p3.sub( p2 ).mul( t.mul( t ).mul( 3.0 ) ) ) );

			};

			const world = vec3( 0 ).toVar();
			const nrm = vec3( 0, 1, 0 ).toVar();
			const pu = float( 0 ).toVar();
			const pv = float( 0 ).toVar();

			// head frame: follows stem tip, faces up and partly toward the sun
			const T = tan( float( 1.0 ) );
			const sunH = normalize( vec3( U.sunDir.x, 0, U.sunDir.z ).add( vec3( 1e-4, 0, 0 ) ) );
			const n = normalize( T.add( up.mul( 0.7 ) ).add( sunH.mul( mix( 0.25, 0.6, seed ) ) ).add( lean.mul( 2.0 ) ) );
			const ref = select( abs( n.z ).lessThan( 0.9 ), vec3( 0, 0, 1 ), vec3( 1, 0, 0 ) );
			const ax = normalize( cross( n, ref ) );
			const bx = cross( n, ax );
			const top = root.add( bez( float( 1.0 ) ) );

			const sz = size.mul( 0.026 ).mul( float( 1.0 ).add( smoothstep( 8.0, 40.0, camDist ).mul( 1.4 ) ) ); // grow a bit with distance (coverage)

			If( part.lessThan( 0.5 ), () => {

				// --- stem (camera-facing ribbon)
				const t = g.y;
				const sp = bez( t );
				const Ts = tan( t );
				const toCam = normalize( cameraPosition.sub( root.add( sp ) ) );
				const side = normalize( cross( Ts, toCam ) );
				const w = mix( 0.0035, 0.0022, t ).mul( float( 1.0 ).add( smoothstep( 5.0, 30.0, camDist ).mul( 2.0 ) ) );
				world.assign( root.add( sp ).add( side.mul( g.x.mul( w ) ) ) );
				nrm.assign( normalize( cross( side, Ts ) ) );
				pu.assign( t );

			} ).ElseIf( part.lessThan( 1.5 ), () => {

				// --- petal
				const count = pick( type, [ 12, 5, 4, 8, 5 ] ).mul( lodIndex === 0 ? 1 : 0.5 );
				const L = pick( type, [ 1.0, 0.62, 1.05, 0.85, 0.85 ] ).mul( sz );
				const Wd = pick( type, [ 0.17, 0.42, 0.62, 0.22, 0.34 ] ).mul( sz );
				const cup = pick( type, [ - 0.12, 0.65, 0.55, 0.15, 0.08 ] );
				const inner = pick( type, [ 0.28, 0.2, 0.15, 0.28, 0.12 ] ).mul( sz );
				const alive = k.lessThan( count );

				const a = k.add( fract( seed.mul( 7.0 ) ) ).div( max( count, 1.0 ) ).mul( PI.mul( 2.0 ) ).add( yaw );
				const dirA = ax.mul( cos( a ) ).add( bx.mul( sin( a ) ) );
				const perp = ax.mul( sin( a ).negate() ).add( bx.mul( cos( a ) ) );
				const pu0 = g.x;
				const shape = pow( sin( pu0.mul( 0.92 ).add( 0.08 ).mul( PI ) ), 0.55 );
				const lift = cup.mul( pu0.mul( pu0 ) ).mul( L );
				const p = top.add( n.mul( sz.mul( 0.12 ) ) ).add( dirA.mul( inner.add( pu0.mul( L ) ) ) )
					.add( perp.mul( g.y.mul( Wd ).mul( shape ) ) ).add( n.mul( lift ) );
				world.assign( select( alive, p, top ) );
				nrm.assign( normalize( n.sub( dirA.mul( cup.mul( pu0 ).mul( 2.0 ) ) ) ) );
				pu.assign( pu0 );
				pv.assign( g.y );

			} ).Else( () => {

				// --- centre disc / dome
				const r = g.x;
				const a = g.y.mul( PI.mul( 2.0 ) );
				const radial = ax.mul( cos( a ) ).add( bx.mul( sin( a ) ) );
				const cr = pick( type, [ 0.3, 0.22, 0.2, 0.26, 0.12 ] ).mul( sz );
				const dome = pick( type, [ 0.16, 0.12, 0.22, 0.2, 0.05 ] ).mul( sz );
				world.assign( top.add( radial.mul( r.mul( cr ) ) ).add( n.mul( float( 1.0 ).sub( r.mul( r ) ).mul( dome ).add( sz.mul( 0.08 ) ) ) ) );
				nrm.assign( normalize( n.add( radial.mul( r.mul( 0.9 ) ) ) ) );
				pu.assign( r );

			} );

			vWorld.assign( world );
			vN.assign( nrm );
			vP.assign( vec4( part, type, pu, pv ) );
			vI.assign( vec4( seed, D.y, pu, 0 ) );
			return world;

		} )();

		// petal outline mask (rounded tips, notched campion petals, frilly cornflowers)
		mat.opacityNode = Fn( () => {

			const part = vP.x, type = vP.y, pu = vP.z, pv = abs( vP.w );
			const notch = select( type.greaterThan( 3.5 ), smoothstep( 0.8, 1.0, pu ).mul( float( 1.0 ).sub( smoothstep( 0.0, 0.35, pv ) ) ), float( 0 ) );
			const frill = select( type.greaterThan( 2.5 ).and( type.lessThan( 3.5 ) ),
				smoothstep( 0.75, 1.0, pu ).mul( abs( sin( pv.mul( 9.0 ) ) ) ).mul( 0.8 ), float( 0 ) );
			const tip = smoothstep( 1.0, 0.82, pu.add( pv.mul( pv ).mul( 0.22 ) ) );
			const petal = tip.sub( notch ).sub( frill );
			return select( part.greaterThan( 0.5 ).and( part.lessThan( 1.5 ) ), petal.add( 0.5 ), float( 1.0 ) );

		} )();
		mat.alphaTest = 0.5;

		mat.colorNode = Fn( () => {

			const part = vP.x, type = vP.y, pu = vP.z, pv = vP.w;
			const seed = vI.x, cloud = vI.y;

			const petalCol = pick3( type, [
				[ 0.78, 0.78, 0.72 ], // daisy
				[ 0.82, 0.55, 0.012 ], // buttercup
				[ 0.62, 0.025, 0.012 ], // poppy
				[ 0.07, 0.16, 0.62 ], // cornflower
				[ 0.66, 0.16, 0.36 ], // campion
			] ).toVar();
			const centreCol = pick3( type, [
				[ 0.7, 0.4, 0.02 ],
				[ 0.55, 0.42, 0.03 ],
				[ 0.02, 0.02, 0.015 ],
				[ 0.08, 0.05, 0.22 ],
				[ 0.75, 0.6, 0.5 ],
			] );
			// petal details
			petalCol.mulAssign( mix( 0.85, 1.1, seed ) );
			const poppyBlotch = select( type.greaterThan( 1.5 ).and( type.lessThan( 2.5 ) ), smoothstep( 0.22, 0.05, pu ), float( 0 ) );
			petalCol.assign( mix( petalCol, vec3( 0.02, 0.015, 0.012 ), poppyBlotch ) );
			const daisyBase = select( type.lessThan( 0.5 ), smoothstep( 0.25, 0.0, pu ), float( 0 ) );
			petalCol.assign( mix( petalCol, vec3( 0.7, 0.62, 0.3 ), daisyBase.mul( 0.4 ) ) );
			// veins
			petalCol.mulAssign( float( 1.0 ).sub( smoothstep( 0.6, 1.0, abs( sin( pv.mul( 7.0 ) ) ) ).mul( 0.08 ) ) );

			const stemCol = mix( vec3( 0.03, 0.06, 0.015 ), vec3( 0.09, 0.17, 0.03 ), pu );

			const albedo = select( part.lessThan( 0.5 ), stemCol, select( part.lessThan( 1.5 ), petalCol, centreCol.mul( mix( 0.85, 1.1, vnoise( vWorld.xz.mul( 900.0 ) ) ) ) ) );
			const N = normalize( vN ).mul( faceDirection );
			const isPetal = part.greaterThan( 0.5 ).and( part.lessThan( 1.5 ) );
			const transmit = select( isPetal, float( 1.0 ), float( 0.4 ) );
			const spec = select( type.greaterThan( 0.5 ).and( type.lessThan( 1.5 ) ).and( isPetal ), float( 0.9 ), float( 0.12 ) );
			const ao = select( part.lessThan( 0.5 ), mix( 0.2, 1.0, pu ), float( 1.0 ) );

			// night: bioluminescent blue petals, brighter centres (picked up by bloom)
			const twinkle = sin( U.time.mul( mix( 0.6, 1.4, seed ) ).add( seed.mul( 50.0 ) ) ).mul( 0.25 ).add( 0.85 );
			const glowAmt = select( part.lessThan( 0.5 ), float( 0.06 ),
				select( part.lessThan( 1.5 ), mix( 0.75, 0.35, pu ), float( 1.1 ) ) );
			const emit = U.glowColor.mul( U.night.mul( U.glow ).mul( glowAmt ).mul( twinkle ) );
			// petals lose their day colour at night: the glow is the colour
			const nightAlbedo = mix( albedo, albedo.mul( vec3( 0.1, 0.25, 0.6 ) ), U.night.mul( 0.9 ) );

			return shadeFoliage( nightAlbedo, N, vWorld, ao, cloud, transmit, spec, float( 0.5 ), emit );

		} )();

		return mat;

	}

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

