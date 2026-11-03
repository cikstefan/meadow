// "Wind spirits": small glowing motes riding the wind across the meadow, each
// trailing a thin luminous thread — an homage to the flowing currents of Giant
// Squid's games (Abzû, Sword of the Sea).
//
// Fully analytic, no buffers or simulation: every spirit follows a closed-form
// flight path p(t) (wind drift + weave + ripple + occasional loops, hugging the
// terrain). Its trail is the same path sampled at earlier times, rebuilt in the
// vertex shader each frame; the head is a separate soft glow sprite.
// Life cycle: the mote fades in and its thread grows behind it; at the end the
// mote's glow fades first, then the thread dissolves from its tail toward the head.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, vec2, vec3, vec4, instanceIndex, uv, varying, mix, smoothstep, sin, cos, fract, floor,
	normalize, cross, length, cameraPosition, pow, select, max, exp, positionLocal
} from 'three/tsl';
import { pcg } from './tsl/noise.js';
import { U, terrainHeight } from './tsl/world.js';

const BOX = 150.0;

export class WindSpirits {

	constructor( count = 160, segments = 48 ) {

		this.u = { amount: uniform( 0.1 ), intensity: uniform( 1 ) };
		const u = this.u;

		// ---- shared flight model --------------------------------------------
		const path = ( t, r, base ) => {

			const W = vec2( U.windDir.x, U.windDir.y );
			const Wp = vec2( U.windDir.y.negate(), U.windDir.x );
			const drift = W.mul( t.mul( U.windSpeed.mul( mix( 0.55, 1.2, r.x ) ) ) );
			const weave = Wp.mul( sin( t.mul( mix( 0.35, 0.8, r.y ) ).add( r.z.mul( 6.28 ) ) ).mul( mix( 2.0, 6.0, r.w ) ) );
			const ripple = Wp.mul( sin( t.mul( mix( 1.8, 2.8, r.z ) ).add( r.y.mul( 11.0 ) ) ).mul( mix( 0.5, 1.2, r.x ) ) );
			const loopR = smoothstep( 0.72, 0.95, r.w ).mul( 3.5 );
			const loopA = t.mul( 1.6 ).add( r.x.mul( 9.0 ) );
			return base.add( drift ).add( weave ).add( ripple ).add( vec2( cos( loopA ), sin( loopA ) ).mul( loopR ) );

		};

		// per-instance life + random state (identical for trail and head)
		const lifeState = () => {

			const id = instanceIndex;
			const r = vec4( pcg( id ), pcg( id.add( 101 ) ), pcg( id.add( 202 ) ), pcg( id.add( 303 ) ) );
			const life = mix( 12.0, 20.0, r.y );
			const tt = U.time.add( r.x.mul( life ) );
			const cycle = floor( tt.div( life ) );
			const age = fract( tt.div( life ) );
			const tLocal = age.mul( life );
			const rc = vec4( pcg( id.add( cycle.mul( 977 ) ) ), pcg( id.add( cycle.mul( 131 ) ).add( 7 ) ), pcg( id.add( cycle.mul( 59 ) ).add( 3 ) ), pcg( id.add( cycle.mul( 17 ) ).add( 11 ) ) );
			const shown = select( pcg( id.add( 999 ) ).lessThan( u.amount ), float( 1.0 ), float( 0.0 ) );
			// spawn anywhere in a box around the camera; the whole spirit wraps as one
			const base0 = rc.xy.sub( 0.5 ).mul( BOX );
			const rel = cameraPosition.xz.sub( path( tLocal, rc, base0 ) );
			const base = base0.add( floor( rel.div( BOX ).add( 0.5 ) ).mul( BOX ) );
			const h0 = mix( 0.8, 4.5, pow( rc.w, 1.5 ) );
			const at = ( t ) => {

				const xz = path( t, rc, base );
				const y = terrainHeight( xz ).add( h0 ).add( sin( t.mul( 1.1 ).add( rc.x.mul( 20.0 ) ) ).mul( 0.6 ) )
					.add( sin( t.mul( 2.3 ).add( rc.y.mul( 30.0 ) ) ).mul( 0.35 ) );
				return vec3( xz.x, y, xz.y );

			};

			// mote: fades in, lives, then its glow fades (0.78 -> 0.86 of life)
			const headI = smoothstep( 0.0, 0.08, age ).mul( smoothstep( 0.86, 0.78, age ) );
			// thread: dissolves from the tail toward the head after the mote has faded
			const sMax = float( 1.0 ).sub( smoothstep( 0.84, 1.0, age ) );
			return { rc, age, tLocal, at, headI, sMax, shown };

		};

		const colour = () => {

			// day: warm filaments; twilight: rose-gold; night: bioluminescent blue
			const day = U.trueSunColor.mul( 0.22 ).add( U.horizonSun.mul( 0.25 ) ).add( vec3( 0.05 ) );
			return mix( day, U.glowColor.mul( 0.7 ), U.night );

		};

		// ---- trail: thin, long, faint ------------------------------------------
		{

			const vS = varying( float( 0 ), 'vSpS' );
			const vSide = varying( float( 0 ), 'vSpSide' );
			const vI = varying( float( 0 ), 'vSpI' );
			const vMax = varying( float( 1 ), 'vSpMax' );
			const geo = new THREE.PlaneGeometry( 1, 1, 1, segments );
			const mat = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide } );
			mat.fog = false;

			mat.positionNode = Fn( () => {

				const L = lifeState();
				const s = uv().y.oneMinus(); // 0 at the mote, 1 at the tail end
				const side = uv().x.sub( 0.5 ).mul( 2.0 );
				const tail = mix( 5.0, 8.0, L.rc.z );
				// the thread only exists where the mote has already been (it grows after birth)
				const ts = max( L.tLocal.sub( s.mul( tail ) ), 0.0 );
				const p = L.at( ts );
				const pn = L.at( ts.add( 0.05 ) );
				const tangent = normalize( pn.sub( p ).add( vec3( 1e-4, 0, 0 ) ) );
				const sideDir = normalize( cross( tangent, normalize( cameraPosition.sub( p ) ) ) );
				const dist = length( cameraPosition.sub( p ) );
				const width = mix( 0.012, 0.022, L.rc.y ).mul( pow( float( 1.0 ).sub( s ), 0.5 ) )
					.mul( mix( 1.0, 2.2, smoothstep( 15.0, 70.0, dist ) ) ); // keep a ~pixel-wide thread far away
				const edge = smoothstep( BOX * 0.5, BOX * 0.36, length( cameraPosition.xz.sub( p.xz ) ) );
				vS.assign( s );
				vSide.assign( side );
				vMax.assign( L.sMax );
				vI.assign( smoothstep( 0.0, 0.05, L.age ).mul( edge ).mul( L.shown ) );
				return p.add( sideDir.mul( side.mul( width ) ) );

			} )();

			mat.colorNode = Fn( () => {

				const core = float( 1.0 ).sub( vSide.mul( vSide ) );
				const along = pow( float( 1.0 ).sub( vS ), 1.3 );
				const dissolve = smoothstep( vMax, vMax.sub( 0.12 ), vS );
				const i = vI.mul( core ).mul( along ).mul( dissolve ).mul( 0.42 ).mul( u.intensity );
				return vec4( colour().mul( i ), 1.0 );

			} )();

			this.trail = new THREE.Mesh( geo, mat );
			this.trail.count = count;
			this.trail.frustumCulled = false;
			this.trail.renderOrder = 110;

		}

		// ---- head: a small bright mote with a soft halo ----------------------------
		{

			const vUV = varying( vec2( 0 ), 'vSpUV' );
			const vI = varying( float( 0 ), 'vSpHI' );
			const geo = new THREE.PlaneGeometry( 2, 2 );
			const mat = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } );
			mat.fog = false;
			this.camRight = uniform( new THREE.Vector3( 1, 0, 0 ) );
			this.camUp = uniform( new THREE.Vector3( 0, 1, 0 ) );

			mat.positionNode = Fn( () => {

				const L = lifeState();
				const p = L.at( L.tLocal );
				const halo = 0.55; // halo radius (m); the bright core is ~0.06 m
				const edge = smoothstep( BOX * 0.5, BOX * 0.36, length( cameraPosition.xz.sub( p.xz ) ) );
				vUV.assign( positionLocal.xy );
				vI.assign( L.headI.mul( edge ).mul( L.shown ) );
				return p.add( this.camRight.mul( positionLocal.x.mul( halo ) ) ).add( this.camUp.mul( positionLocal.y.mul( halo ) ) );

			} )();

			mat.colorNode = Fn( () => {

				const d = length( vUV ); // 0..1 across the halo
				const core = exp( d.mul( 9.0 ).pow( 2.0 ).negate() ).mul( 2.2 );
				const glow = exp( d.mul( 3.0 ).pow( 2.0 ).negate() ).mul( 0.25 );
				const i = vI.mul( core.add( glow ) ).mul( u.intensity );
				return vec4( colour().mul( 1.4 ).add( vec3( 0.05 ) ).mul( i ), 1.0 );

			} )();

			this.head = new THREE.Mesh( geo, mat );
			this.head.count = count;
			this.head.frustumCulled = false;
			this.head.renderOrder = 111;

		}

		this.mesh = new THREE.Group();
		this.mesh.add( this.trail, this.head );
		this.mesh.visible = false;

	}

	update( camera ) {

		this.camRight.value.setFromMatrixColumn( camera.matrixWorld, 0 );
		this.camUp.value.setFromMatrixColumn( camera.matrixWorld, 1 );

	}

}
