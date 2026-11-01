// Analytic sky dome sharing its radiance function with the fog (see world.js),
// procedural cumulus layer, HDR sun disk, and a time-of-day palette that drives
// every lighting uniform (sun colour, sky/ground ambient, horizon tints).

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, vec2, vec3, positionWorld, cameraPosition, normalize, mix, smoothstep, max, pow, dot, clamp
} from 'three/tsl';
import { vnoise } from './tsl/noise.js';
import { U, skyColor } from './tsl/world.js';

// elevation (deg) -> palette. Colours are linear-ish, hand tuned.
const KEYS = [
	{ e: - 8, zen: [ 0.012, 0.018, 0.05 ], hor: [ 0.06, 0.06, 0.1 ], hsun: [ 0.25, 0.1, 0.08 ], sun: [ 0.0, 0.0, 0.0 ], amb: [ 0.025, 0.03, 0.06 ] },
	{ e: - 1, zen: [ 0.04, 0.07, 0.17 ], hor: [ 0.35, 0.24, 0.26 ], hsun: [ 1.1, 0.4, 0.14 ], sun: [ 0.9, 0.25, 0.05 ], amb: [ 0.08, 0.08, 0.13 ] },
	{ e: 3, zen: [ 0.05, 0.11, 0.3 ], hor: [ 0.55, 0.42, 0.36 ], hsun: [ 1.35, 0.66, 0.28 ], sun: [ 2.6, 1.25, 0.45 ], amb: [ 0.14, 0.15, 0.22 ] },
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
			const drift = U.windDir.mul( U.time.mul( 0.0035 ) );
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
			const litCol = U.sunColor.mul( 0.32 ).add( U.horizon.mul( 0.55 ) );
			const cloudCol = mix( litCol, shadowCol, core.mul( 0.75 ) )
				.add( U.sunColor.mul( pow( mu, 6.0 ).mul( 0.35 ).mul( float( 1.0 ).sub( core ) ) ) );
			// distant clouds dissolve into the horizon haze
			const haze = smoothstep( 0.0, 0.35, y );
			col.assign( mix( col, mix( U.horizon, cloudCol, haze ), dens.mul( 0.92 ) ) );

			// sun disk (HDR, picked up by bloom), dimmed behind clouds
			const disk = smoothstep( 0.99985, 0.99995, mu ).mul( float( 1.0 ).sub( dens.mul( 0.85 ) ) );
			col.addAssign( U.sunColor.mul( disk ).mul( 18.0 ) );

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

		const el = THREE.MathUtils.degToRad( elevationDeg );
		const az = THREE.MathUtils.degToRad( azimuthDeg );
		this.sunDir.set( Math.sin( az ) * Math.cos( el ), Math.sin( el ), - Math.cos( az ) * Math.cos( el ) ).normalize();
		U.sunDir.value.copy( this.sunDir );

		const p = samplePalette( elevationDeg );
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

