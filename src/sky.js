// Analytic sky dome sharing its radiance function with the fog (see world.js),
// procedural cumulus layer, HDR sun disk, and a time-of-day palette that drives
// every lighting uniform (sun colour, sky/ground ambient, horizon tints).

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, int, vec2, vec3, positionWorld, cameraPosition, normalize, mix, smoothstep, max, pow, dot, clamp,
	floor, fract, length, exp, sin, select, fwidth
} from 'three/tsl';
import { vnoise, hash2i } from './tsl/noise.js';
import { U, skyColor } from './tsl/world.js';

// elevation (deg) -> palette. Colours are linear-ish, hand tuned.
const KEYS = [
	// night: deep blue sky, cool blue ambient everywhere (the moon is handled separately)
	{ e: - 16, zen: [ 0.002, 0.005, 0.018 ], hor: [ 0.009, 0.016, 0.042 ], hsun: [ 0.01, 0.018, 0.045 ], sun: [ 0, 0, 0 ], amb: [ 0.016, 0.03, 0.075 ] },
	// twilight: deep indigo zenith, violet belt, blood-orange afterglow on the sun side
	{ e: - 8, zen: [ 0.006, 0.011, 0.04 ], hor: [ 0.045, 0.035, 0.08 ], hsun: [ 0.3, 0.08, 0.07 ], sun: [ 0.0, 0.0, 0.0 ], amb: [ 0.03, 0.04, 0.095 ] },
	{ e: - 4, zen: [ 0.018, 0.03, 0.1 ], hor: [ 0.24, 0.12, 0.2 ], hsun: [ 1.25, 0.28, 0.1 ], sun: [ 0.0, 0.0, 0.0 ], amb: [ 0.065, 0.06, 0.12 ] },
	{ e: - 1, zen: [ 0.035, 0.06, 0.17 ], hor: [ 0.5, 0.26, 0.3 ], hsun: [ 1.9, 0.52, 0.13 ], sun: [ 1.0, 0.26, 0.05 ], amb: [ 0.09, 0.08, 0.13 ] },
	{ e: 3, zen: [ 0.05, 0.1, 0.3 ], hor: [ 0.72, 0.45, 0.36 ], hsun: [ 1.85, 0.78, 0.28 ], sun: [ 2.6, 1.15, 0.38 ], amb: [ 0.14, 0.14, 0.21 ] },
	{ e: 9, zen: [ 0.07, 0.17, 0.46 ], hor: [ 0.6, 0.55, 0.52 ], hsun: [ 1.25, 0.78, 0.42 ], sun: [ 3.4, 2.15, 1.15 ], amb: [ 0.2, 0.24, 0.32 ] },
	{ e: 20, zen: [ 0.08, 0.22, 0.58 ], hor: [ 0.55, 0.64, 0.76 ], hsun: [ 0.95, 0.86, 0.72 ], sun: [ 3.3, 2.7, 2.0 ], amb: [ 0.2, 0.27, 0.38 ] },
	{ e: 40, zen: [ 0.07, 0.21, 0.6 ], hor: [ 0.5, 0.62, 0.8 ], hsun: [ 0.78, 0.8, 0.82 ], sun: [ 3.3, 3.0, 2.55 ], amb: [ 0.2, 0.27, 0.4 ] },
	{ e: 70, zen: [ 0.06, 0.19, 0.58 ], hor: [ 0.47, 0.6, 0.8 ], hsun: [ 0.72, 0.78, 0.84 ], sun: [ 3.35, 3.1, 2.75 ], amb: [ 0.2, 0.27, 0.41 ] },
];

function samplePalette( e ) {

	let a = KEYS[ 0 ], b = KEYS[ KEYS.length - 1 ];
	if ( e <= a.e ) b = a;
	else if ( e >= b.e ) a = b;
	else for ( let i = 0; i < KEYS.length - 1; i ++ ) if ( e >= KEYS[ i ].e && e <= KEYS[ i + 1 ].e ) {

		a = KEYS[ i ]; b = KEYS[ i + 1 ];
		break;

	}

	const t = a === b ? 0 : ( e - a.e ) / ( b.e - a.e );
	const s = t * t * ( 3 - 2 * t );
	const lerp = ( k ) => a[ k ].map( ( v, i ) => v + ( b[ k ][ i ] - v ) * s );
	return { zen: lerp( 'zen' ), hor: lerp( 'hor' ), hsun: lerp( 'hsun' ), sun: lerp( 'sun' ), amb: lerp( 'amb' ) };

}

export class Sky {

	constructor() {

		this.u = {
			skyCover: uniform( 0.6 ),
		};

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		mat.fog = false;

		mat.colorNode = Fn( () => {

			const dir = normalize( positionWorld.sub( cameraPosition ) );
			const col = skyColor( dir ).toVar();
			const mu = max( dot( dir, U.sunDir ), 0.0 );
			const y = dir.y;

			// cumulus layer projected on a plane
			const drift = U.skyOffset;
			const p = dir.xz.div( max( y, 0.0 ).add( 0.12 ) ).mul( 0.9 ).add( drift ).toVar();
			const f = vnoise( p ).mul( 0.5 )
				.add( vnoise( p.mul( 2.03 ).add( vec2( 3.1, 1.7 ) ) ).mul( 0.25 ) )
				.add( vnoise( p.mul( 4.1 ).add( vec2( 7.3, 2.1 ) ) ).mul( 0.125 ) )
				.add( vnoise( p.mul( 8.3 ).add( vec2( 1.3, 9.9 ) ) ).mul( 0.0625 ) )
				.div( 0.9375 );
			const dens = smoothstep( this.u.skyCover, this.u.skyCover.add( 0.3 ), f ).mul( smoothstep( 0.0, 0.18, y ) );
			// darker, thicker cores; bright sun-facing rims (silver lining)
			const core = smoothstep( this.u.skyCover.add( 0.08 ), this.u.skyCover.add( 0.45 ), f );
			const shadowCol = mix( U.skyAmb.mul( 1.6 ), U.horizon.mul( 0.7 ), 0.4 );
			// at sunrise / sunset clouds are lit from below: fiery near the sun, pink elsewhere
			const litCol = U.sunColor.mul( 0.32 ).add( U.horizon.mul( 0.55 ) )
				.add( U.horizonSun.mul( U.twilight.mul( pow( mu, 2.0 ).mul( 0.9 ).add( 0.12 ) ) ) )
				.add( vec3( 0.32, 0.12, 0.2 ).mul( U.twilight.mul( 0.35 ) ) );
			const cloudCol = mix( litCol, shadowCol, core.mul( 0.75 ) )
				.add( U.sunColor.mul( pow( mu, 6.0 ).mul( 0.35 ).mul( float( 1.0 ).sub( core ) ) ) );
			// --- night sky: stars + a faint milky way, hidden by clouds and haze
			const above = smoothstep( 0.0, 0.12, y );
			const bandN = normalize( vec3( 0.35, 0.5, 0.79 ) );
			const bandA = normalize( vec3( 0.79, 0.0, - 0.35 ) ); // in the band plane
			const bandB = normalize( vec3( - 0.175, 0.7, - 0.4 ).sub( bandN.mul( dot( vec3( - 0.175, 0.7, - 0.4 ), bandN ) ) ) );
			const band = exp( pow( dot( dir, bandN ).mul( 4.5 ), 2.0 ).negate() );
			const bandUV = vec2( dot( dir, bandA ), dot( dir, bandB ) );
			const sp = dir.mul( 420.0 );
			const ip = floor( sp );
			const ix = int( ip.x ), iy = int( ip.y ), iz = int( ip.z );
			const h = hash2i( ix.add( iz.mul( 4099 ) ), iy );
			const h2 = hash2i( ix.add( 17 ), iy.add( iz.mul( 131 ) ) );
			const h3 = hash2i( iz.add( 7 ), ix.add( iy.mul( 977 ) ) );
			const off = vec3( h2, h3, fract( h.mul( 31.7 ) ) ).sub( 0.5 ).mul( 0.6 );
			const dStar = length( fract( sp ).sub( 0.5 ).sub( off ) );
			// many faint stars, few bright ones (power law), denser in the milky way
			const thr = float( 0.984 ).sub( band.mul( 0.012 ) );
			const mag = clamp( h.sub( thr ).div( float( 1.0 ).sub( thr ) ), 0.0, 1.0 );
			const tw = sin( U.time.mul( mix( 1.2, 3.5, h2 ) ).add( h3.mul( 60.0 ) ) ).mul( 0.18 ).add( 0.85 );
			const starTint = mix( vec3( 1.0, 0.86, 0.72 ), vec3( 0.78, 0.86, 1.08 ), h3 );
			// pixel-sized gaussian points: radius from screen-space derivatives -> fine, round, antialiased
			const px = length( fwidth( sp ) ).mul( 0.55 );
			const r = max( px, 0.02 );
			const starCore = exp( dStar.div( r ).pow( 2.0 ).negate() );
			const bright = pow( mag, 3.0 ).mul( 1.5 ).add( mag.mul( 0.1 ) );
			const star = starCore.mul( select( mag.greaterThan( 0.0 ), bright, float( 0.0 ) ) ).mul( tw );
			const mwTex = vnoise( bandUV.mul( 7.0 ).add( dot( dir, bandN ).mul( 9.0 ) ) ).mul( 0.6 ).add( vnoise( bandUV.mul( 21.0 ).add( vec2( 5, 3 ) ) ).mul( 0.4 ) );
			// faint glow with darker dust lanes along the band
			const lanes = smoothstep( 0.45, 0.75, vnoise( bandUV.mul( 13.0 ).add( vec2( 11, 2 ) ) ) );
			const milky = vec3( 0.011, 0.014, 0.026 ).mul( band ).mul( smoothstep( 0.35, 0.9, mwTex ).mul( 1.4 ).add( 0.3 ) ).mul( float( 1.0 ).sub( lanes.mul( 0.6 ) ) );
			const nightSky = starTint.mul( star ).add( milky ).mul( U.night ).mul( above ).mul( float( 1.0 ).sub( dens ) );
			col.addAssign( nightSky );

			// distant clouds dissolve into the horizon haze
			const haze = smoothstep( 0.0, 0.35, y );
			col.assign( mix( col, mix( U.horizon, cloudCol, haze ), dens.mul( 0.92 ) ) );

			// sun disk (HDR, picked up by bloom), dimmed behind clouds
			// (at night the "sun" uniforms carry the moon: bigger, relatively brighter disk)
			const disk = smoothstep( mix( 0.99985, 0.99975, U.night ), mix( 0.99995, 0.9999, U.night ), mu ).mul( float( 1.0 ).sub( dens.mul( 0.85 ) ) );
			col.addAssign( U.sunColor.mul( disk ).mul( mix( 18.0, 30.0, U.night ) ) );

			// below horizon
			const below = smoothstep( 0.0, - 0.08, y );
			return mix( col, U.horizon.mul( 0.55 ), below );

		} )();

		this.mesh = new THREE.Mesh( new THREE.SphereGeometry( 1, 48, 24 ), mat );
		this.mesh.scale.setScalar( 3000 );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 50; // last among opaques: only visible sky pixels are shaded

		this.sunDir = new THREE.Vector3();

	}

	/**
	 * @param {number} elevationDeg sun elevation
	 * @param {number} azimuthDeg sun azimuth (0 = -Z / north, clockwise)
	 * @param {number} cloudiness 0..1
	 */
	setAtmosphere( elevationDeg, azimuthDeg, cloudiness ) {

		// Below -4 deg the sun contributes nothing, so the directional light is
		// handed to the moon (opposite side of the sky) without a visible pop.
		const night = THREE.MathUtils.smoothstep( - elevationDeg, 2, 12 );
		U.night.value = night;
		U.twilight.value = Math.exp( - Math.pow( ( elevationDeg - 0.5 ) / 6.5, 2 ) );
		const isMoon = elevationDeg < - 4;
		const lightEl = isMoon ? 32 : elevationDeg;
		const lightAz = isMoon ? azimuthDeg + 180 + 25 : azimuthDeg;
		const el = THREE.MathUtils.degToRad( lightEl );
		const az = THREE.MathUtils.degToRad( lightAz );
		this.sunDir.set( Math.sin( az ) * Math.cos( el ), Math.sin( el ), - Math.cos( az ) * Math.cos( el ) ).normalize();
		U.sunDir.value.copy( this.sunDir );

		const p = samplePalette( elevationDeg );
		if ( isMoon ) {

			const k = THREE.MathUtils.smoothstep( - elevationDeg, 4, 10 );
			p.sun = [ 0.09, 0.13, 0.24 ].map( ( v ) => v * k );
			// moon-side horizon glow stays cool
			p.hsun = p.hor.map( ( v, i ) => v + [ 0.01, 0.02, 0.04 ][ i ] * k );

		}
		const overcast = cloudiness * cloudiness * 0.5;
		const grey = ( c, k ) => {

			const l = ( c[ 0 ] + c[ 1 ] + c[ 2 ] ) / 3;
			return c.map( ( v ) => v + ( l - v ) * k );

		};

		U.zenith.value.setRGB( ...grey( p.zen, overcast ) );
		U.horizon.value.setRGB( ...grey( p.hor, overcast * 0.6 ) );
		U.horizonSun.value.setRGB( ...grey( p.hsun, overcast ) );
		U.sunColor.value.setRGB( ...p.sun.map( ( v ) => v * ( 1 - overcast * 0.6 ) ) );
		U.skyAmb.value.setRGB( ...p.amb.map( ( v ) => v * ( 1 + overcast * 0.4 ) ) );
		// ground bounce: grassy, proportional to sun + sky
		const g = [ 0.09, 0.12, 0.04 ];
		U.groundAmb.value.setRGB( ...g.map( ( v, i ) => v * ( p.sun[ i ] * 0.12 + p.amb[ i ] * 0.6 ) ) );

		U.cloudCover.value = 0.15 + cloudiness * 0.6;
		U.cloudDark.value = 0.35 + cloudiness * 0.35;
		this.u.skyCover.value = THREE.MathUtils.lerp( 0.78, 0.3, cloudiness );

	}

	update( camera ) {

		this.mesh.position.copy( camera.position );

	}

}

