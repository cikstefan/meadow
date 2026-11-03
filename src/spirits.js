// "Wind spirits": luminous ribbons that ride the wind across the meadow, an
// homage to the flowing currents of Giant Squid's games (Abzû, Sword of the Sea).
//
// Fully analytic, no buffers or simulation: every ribbon follows a closed-form
// flight path p(t) (wind drift + lateral weave + occasional loops, hugging the
// terrain). Its tail is the same path sampled at earlier times, so the strip is
// rebuilt in the vertex shader each frame. Ribbons live in cycles (fade in,
// fly, fade out, respawn elsewhere) inside a box that wraps around the camera.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, vec2, vec3, vec4, instanceIndex, uv, varying, mix, smoothstep, sin, cos, fract, floor,
	normalize, cross, length, cameraPosition, pow, select
} from 'three/tsl';
import { pcg } from './tsl/noise.js';
import { U, terrainHeight } from './tsl/world.js';

export class WindSpirits {

	constructor( count = 160, segments = 40 ) {

		this.u = { amount: uniform( 1 ), intensity: uniform( 1 ) };
		const BOX = 150.0;
		const geo = new THREE.PlaneGeometry( 1, 1, 1, segments ); // x: side, y: along the tail

		const vS = varying( float( 0 ), 'vSpS' );
		const vSide = varying( float( 0 ), 'vSpSide' );
		const vI = varying( float( 0 ), 'vSpI' );

		const mat = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide } );
		mat.fog = false;

		const path = ( t, r, base ) => {

			// wind drift (follows the live wind direction and speed)
			const W = vec2( U.windDir.x, U.windDir.y );
			const Wp = vec2( U.windDir.y.negate(), U.windDir.x );
			const speed = mix( 0.55, 1.2, r.x );
			const drift = W.mul( t.mul( U.windSpeed.mul( speed ) ) );
			// weave + occasional loop-the-loops
			const weave = Wp.mul( sin( t.mul( mix( 0.35, 0.8, r.y ) ).add( r.z.mul( 6.28 ) ) ).mul( mix( 2.0, 6.0, r.w ) ) );
			const loopR = smoothstep( 0.72, 0.95, r.w ).mul( 3.5 );
			const loopA = t.mul( 1.6 ).add( r.x.mul( 9.0 ) );
			const loop = vec2( cos( loopA ), sin( loopA ) ).mul( loopR );
			// faster ripple so even a short tail shows a flowing curve
			const ripple = Wp.mul( sin( t.mul( mix( 1.8, 2.8, r.z ) ).add( r.y.mul( 11.0 ) ) ).mul( mix( 0.5, 1.2, r.x ) ) );
			const xz = base.add( drift ).add( weave ).add( loop ).add( ripple );
			return xz;

		};

		mat.positionNode = Fn( () => {

			const id = instanceIndex;
			const r = vec4( pcg( id ), pcg( id.add( 101 ) ), pcg( id.add( 202 ) ), pcg( id.add( 303 ) ) );
			const life = mix( 9.0, 17.0, r.y );
			const tt = U.time.add( r.x.mul( life ) );
			const cycle = floor( tt.div( life ) );
			const age = fract( tt.div( life ) ); // 0..1 over this ribbon's life
			const tLocal = age.mul( life );
			const rc = vec4( pcg( id.add( cycle.mul( 977 ) ) ), pcg( id.add( cycle.mul( 131 ) ).add( 7 ) ), pcg( id.add( cycle.mul( 59 ) ).add( 3 ) ), pcg( id.add( cycle.mul( 17 ) ).add( 11 ) ) );
			const shown = pcg( id.add( 999 ) ).lessThan( this.u.amount );

			// spawn anywhere in a box around the camera; the whole ribbon wraps as one
			const base0 = rc.xy.sub( 0.5 ).mul( BOX );
			const headXZ0 = path( tLocal, rc, base0 );
			const rel = cameraPosition.xz.sub( headXZ0 );
			const wrap = floor( rel.div( BOX ).add( 0.5 ) ).mul( BOX );
			const base = base0.add( wrap );

			const s = uv().y.oneMinus(); // 0 at head, 1 at tail end
			const side = uv().x.sub( 0.5 ).mul( 2.0 );
			const tail = mix( 2.6, 4.2, rc.z );
			const ts = tLocal.sub( s.mul( tail ) );
			const h0 = mix( 0.8, 4.5, pow( rc.w, 1.5 ) );

			const at = ( t ) => {

				const xz = path( t, rc, base );
				const y = terrainHeight( xz ).add( h0 ).add( sin( t.mul( 1.1 ).add( rc.x.mul( 20.0 ) ) ).mul( 0.6 ) )
					.add( sin( t.mul( 2.3 ).add( rc.y.mul( 30.0 ) ) ).mul( 0.35 ) );
				return vec3( xz.x, y, xz.y );

			};

			const p = at( ts );
			const pn = at( ts.add( 0.05 ) );
			const tangent = normalize( pn.sub( p ).add( vec3( 1e-4, 0, 0 ) ) );
			const toCam = normalize( cameraPosition.sub( p ) );
			const sideDir = normalize( cross( tangent, toCam ) );
			const width = mix( 0.05, 0.13, rc.y ).mul( pow( float( 1.0 ).sub( s ), 0.7 ) ).mul( mix( 1.0, 1.6, smoothstep( 20.0, 70.0, length( cameraPosition.sub( p ) ) ) ) );

			// life envelope + fade at the wrap box edge
			const env = smoothstep( 0.0, 0.12, age ).mul( smoothstep( 1.0, 0.75, age ) );
			const edge = smoothstep( BOX * 0.5, BOX * 0.36, length( cameraPosition.xz.sub( p.xz ) ) );
			vS.assign( s );
			vSide.assign( side );
			vI.assign( env.mul( edge ).mul( select( shown, float( 1.0 ), float( 0.0 ) ) ) );
			return p.add( sideDir.mul( side.mul( width ) ) );

		} )();

		mat.colorNode = Fn( () => {

			const s = vS;
			const core = float( 1.0 ).sub( vSide.mul( vSide ) );
			const along = pow( float( 1.0 ).sub( s ), 1.6 ).mul( smoothstep( 0.0, 0.03, s ).mul( 0.6 ).add( 0.4 ) );
			const head = smoothstep( 0.06, 0.0, s ).mul( 1.5 );
			// day: warm sunlit filaments; twilight: rose-gold; night: bioluminescent blue
			const day = U.sunColor.mul( 0.22 ).add( U.horizonSun.mul( 0.25 ) ).add( vec3( 0.05 ) );
			const col = mix( day, U.glowColor.mul( 0.7 ), U.night );
			const i = vI.mul( core.mul( along ).add( head.mul( core ) ) ).mul( this.u.intensity );
			return vec4( col.mul( i ), 1.0 );

		} )();

		this.mesh = new THREE.Mesh( geo, mat );
		this.mesh.count = count;
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 110;
		this.mesh.visible = false;

	}

}

