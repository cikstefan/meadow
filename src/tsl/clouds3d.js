// Volumetric clouds (raymarched), in the spirit of Horizon Zero Dawn's Nubis:
//
// - A tileable 64^3 noise volume is generated once on the CPU: R = Perlin-Worley
//   (billowy base shapes), G = Worley fbm (erosion detail).
// - Coverage comes from a 2D weather map, the same function that drives the
//   cloud shadows on the ground, so dappled light lines up with the clouds.
// - Each sky pixel marches the cloud slab (base..top) with a blue-noise style
//   jittered start, eroding the shape with detail noise near the edges and
//   lighting every sample with a short march toward the sun (Beer's law +
//   powder darkening), a two-lobe Henyey-Greenstein phase (silver linings when
//   looking toward the sun), sky ambient from above and warm bounce from the
//   sunset horizon below.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, min, exp, dot, normalize, fract, Loop, If, Break,
	texture3D, cameraPosition, screenCoordinate, pow, select
} from 'three/tsl';
import { U } from './uniforms.js';

const S = 64;

// tileable value noise (period p) and Worley noise (cells per tile n)
function makeVolume() {

	const hash = ( x, y, z ) => {

		let h = ( x * 374761393 + y * 668265263 + z * 1274126177 ) | 0;
		h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
		return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;

	};

	const valueNoise = ( x, y, z, p ) => {

		const xi = Math.floor( x ), yi = Math.floor( y ), zi = Math.floor( z );
		const fx = x - xi, fy = y - yi, fz = z - zi;
		const sx = fx * fx * ( 3 - 2 * fx ), sy = fy * fy * ( 3 - 2 * fy ), sz = fz * fz * ( 3 - 2 * fz );
		const m = ( v ) => ( ( v % p ) + p ) % p;
		const H = ( a, b, c ) => hash( m( xi + a ), m( yi + b ), m( zi + c ) );
		const l = ( a, b, t ) => a + ( b - a ) * t;
		return l( l( l( H( 0, 0, 0 ), H( 1, 0, 0 ), sx ), l( H( 0, 1, 0 ), H( 1, 1, 0 ), sx ), sy ),
			l( l( H( 0, 0, 1 ), H( 1, 0, 1 ), sx ), l( H( 0, 1, 1 ), H( 1, 1, 1 ), sx ), sy ), sz );

	};

	const worley = ( x, y, z, n ) => {

		const xi = Math.floor( x ), yi = Math.floor( y ), zi = Math.floor( z );
		let d = 9;
		for ( let a = - 1; a <= 1; a ++ ) for ( let b = - 1; b <= 1; b ++ ) for ( let c = - 1; c <= 1; c ++ ) {

			const cx = xi + a, cy = yi + b, cz = zi + c;
			const w = ( v ) => ( ( v % n ) + n ) % n;
			const hx = w( cx ), hy = w( cy ), hz = w( cz );
			const px = cx + hash( hx, hy, hz + 101 ), py = cy + hash( hx + 7, hy, hz + 31 ), pz = cz + hash( hx, hy + 13, hz + 57 );
			const dd = ( px - x ) ** 2 + ( py - y ) ** 2 + ( pz - z ) ** 2;
			if ( dd < d ) d = dd;

		}

		return 1 - Math.min( 1, Math.sqrt( d ) );

	};

	const data = new Uint8Array( S * S * S * 4 );
	for ( let z = 0; z < S; z ++ ) for ( let y = 0; y < S; y ++ ) for ( let x = 0; x < S; x ++ ) {

		const u = x / S, v = y / S, w = z / S;
		// fbm value noise (periodic)
		let pn = 0, a = 0.5, f = 4, norm = 0;
		for ( let o = 0; o < 4; o ++ ) {

			pn += a * valueNoise( u * f, v * f, w * f, f ); norm += a; a *= 0.5; f *= 2;

		}

		pn /= norm;
		const w1 = worley( u * 4, v * 4, w * 4, 4 ), w2 = worley( u * 8, v * 8, w * 8, 8 ), w3 = worley( u * 16, v * 16, w * 16, 16 );
		const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
		// Perlin-Worley: value noise remapped by the inverted Worley fbm (billows)
		const pw = Math.min( 1, Math.max( 0, ( pn - ( wf - 1 ) ) / ( 1 - ( wf - 1 ) ) ) );
		const dw = w2 * 0.5 + w3 * 0.35 + worley( u * 32, v * 32, w * 32, 32 ) * 0.15;
		const k = ( ( z * S + y ) * S + x ) * 4;
		data[ k ] = Math.round( Math.min( 1, Math.max( 0, pw ) ) * 255 ); // full range: coverage decides where clouds are, the shape only sculpts them
		data[ k + 1 ] = Math.round( dw * 255 );
		data[ k + 2 ] = Math.round( wf * 255 );
		data[ k + 3 ] = 255;

	}

	const tex = new THREE.Data3DTexture( data, S, S, S );
	tex.format = THREE.RGBAFormat;
	tex.type = THREE.UnsignedByteType;
	tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
	tex.minFilter = tex.magFilter = THREE.LinearFilter;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	return tex;

}

const remap = ( v, a, b ) => clamp( v.sub( a ).div( max( b.sub( a ), 1e-4 ) ), 0.0, 1.0 );

/**
 * @param {Function} coverage (xz) -> 0..1 cloudiness of the weather map (1 = overcast)
 * @param {object} o { base, top, steps, lightSteps }
 * returns a TSL function (dir) -> vec4( scattered light, transmittance )
 */
export function makeVolumetricClouds( coverage, o = {} ) {

	let VOL = null; // built on first use (only biomes with volumetric skies pay for it)
	const vol = () => VOL || ( VOL = makeVolume() );
	const BASE = o.base ?? 1500, TOP = o.top ?? 2700, STEPS = o.steps ?? 40, LSTEPS = o.lightSteps ?? 4;
	const SIGMA = 0.011; // extinction per metre at density 1

	// Cloud density at a world point, after Unreal's Volumetric Cloud material /
	// Nubis: a weather map gives coverage and cloud type; the type picks a height
	// profile (flat stratus sheets low in the layer .. heaped cumulus filling it);
	// a large Perlin-Worley base shape is remapped by coverage, then eroded at its
	// edges by Worley detail noise (billows on top, torn wisps underneath).
	const density = ( p, cheap ) => {

		const cov = coverage( p.xz ).toVar();
		const q = p.sub( vec3( U.cloudOffset.x, 0.0, U.cloudOffset.y ) ).add( vec3( 0.0, U.cloudTime.mul( - 1.0 ), 0.0 ) );
		// regional variety: the cloud base rises and falls by several hundred metres and
		// the layer thins out to flat sheets in places, swells to deep heaps in others
		const big = texture3D( vol(), fract( vec3( q.x.div( 15000.0 ), 0.71, q.z.div( 15000.0 ) ) ) ).level( 0 );
		const baseY = float( BASE ).add( big.g.sub( 0.5 ).mul( 700.0 ) );
		const thick = mix( 0.25, 1.0, smoothstep( 0.3, 0.75, big.r ) );
		const hf = clamp( p.y.sub( baseY ).div( thick.mul( TOP - BASE ) ), 0.0, 1.0 );
		const type = texture3D( vol(), fract( vec3( q.x.div( 9000.0 ), 0.37, q.z.div( 9000.0 ) ) ) ).level( 0 ).b;
		const ctype = smoothstep( 0.35, 0.75, type );
		// height profiles: stratus 0..0.3 of the layer, cumulus 0..~1 (rounded top)
		const topH = mix( 0.22, 1.0, ctype );
		const profile = smoothstep( 0.0, 0.07, hf ).mul( smoothstep( topH, topH.mul( mix( 0.55, 0.35, ctype ) ), hf ) );
		const shape = texture3D( vol(), fract( q.mul( vec3( 1 / 4600, 1 / 1500, 1 / 4600 ) ) ) ).level( 0 ).r.toVar();
		const base = remap( shape.mul( profile ), float( 1.0 ).sub( cov.mul( 0.92 ) ), float( 1.0 ) ).mul( cov ).toVar();
		if ( ! cheap ) {

			const det = texture3D( vol(), fract( q.mul( vec3( 1 / 420, 1 / 300, 1 / 420 ) ).add( vec3( 0.0, U.cloudTime.mul( 0.0006 ), 0.0 ) ) ) ).level( 0 ).g;
			// billowy (inverted) on the tops, wispy toward the base
			const dn = mix( det, float( 1.0 ).sub( det ), smoothstep( 0.1, 0.45, hf ) );
			base.assign( remap( base, dn.mul( 0.38 ).mul( float( 1.0 ).sub( base ).max( 0.25 ) ), float( 1.0 ) ) );

		}

		return base.mul( 2.2 );

	};

	const hg = ( c, g ) => {

		const g2 = g * g;
		return float( 1 - g2 ).div( pow( float( 1 + g2 ).sub( c.mul( 2 * g ) ), 1.5 ) ).mul( 1 / ( 4 * Math.PI ) );

	};

	const march = Fn( ( [ dir ] ) => {

		const result = vec4( 0, 0, 0, 1 ).toVar();
		If( dir.y.greaterThan( 0.012 ), () => {

			const ro = cameraPosition;
			const t0 = float( BASE ).sub( ro.y ).div( dir.y );
			const t1 = min( float( TOP ).sub( ro.y ).div( dir.y ), t0.add( 8000.0 ) );
			const dt = t1.sub( t0 ).div( STEPS );
			// interleaved gradient noise: decorrelates the step positions per pixel
			const ign = fract( fract( dot( screenCoordinate.xy, vec2( 0.06711056, 0.00583715 ) ) ).mul( 52.9829189 ).add( U.time.mul( 60.0 ).floor().mul( 0.618034 ) ) );
			const L = U.sunDir;
			const mu = dot( dir, L );
			const phase = mix( hg( mu, - 0.25 ), hg( mu, 0.65 ), 0.55 ).mul( 4.0 * Math.PI ).add( 0.15 );
			const T = float( 1.0 ).toVar();
			const acc = vec3( 0 ).toVar();
			const ambTop = U.skyAmb.mul( 1.25 ).add( U.zenith.mul( 0.25 ) );
			const ambBot = U.groundAmb.mul( 1.2 ).add( U.horizonSun.mul( U.twilight.mul( 0.25 ) ) ).add( U.horizon.mul( 0.08 ) );
			const sunLit = smoothstep( - 0.08, 0.04, L.y );

			Loop( STEPS, ( { i } ) => {

				const t = t0.add( dt.mul( float( i ).add( ign ) ) );
				const p = ro.add( dir.mul( t ) );
				const d = density( p, false );
				If( d.greaterThan( 0.003 ), () => {

					// light march toward the sun (coarse, cheap density)
					const od = float( 0 ).toVar();
					for ( let k = 0; k < LSTEPS; k ++ ) {

						const ls = ( k + 0.5 ) * 90.0 * ( 1 + k * 0.7 );
						od.addAssign( density( p.add( L.mul( ls ) ), true ).mul( 90.0 * ( 1 + k * 0.7 ) ) );

					}

					// multiple scattering (Wrenninge / Frostbite / UE): octaves of light with
					// weaker extinction and a flatter phase -> luminous, soft interiors
					let ms = float( 0 );
					for ( let o = 0; o < 3; o ++ ) {

						const ka = Math.pow( 0.5, o ), kb = Math.pow( 0.45, o ), kc = Math.pow( 0.6, o );
						ms = ms.add( exp( od.mul( - SIGMA * kb ) ).mul( mix( float( 1.0 / ( 4 * Math.PI ) * 4 * Math.PI ), phase, kc ) ).mul( ka ) );

					}

					const powder = float( 1.0 ).sub( exp( d.mul( - 2.0 * 120.0 * SIGMA ) ) ).mul( 0.6 ).add( 0.4 );
					const hf = clamp( p.y.sub( BASE ).div( TOP - BASE ), 0.0, 1.0 );
					const sun = U.sunColor.mul( ms.mul( powder ).mul( 1.1 ) ).mul( sunLit );
					const beer = exp( od.mul( - SIGMA ) );
					const amb = mix( ambBot, ambTop, hf ).mul( mix( 0.3, 1.0, beer.mul( 0.5 ).add( hf.mul( 0.5 ) ) ) );
					const S = sun.add( amb );
					const a = float( 1.0 ).sub( exp( d.mul( dt ).mul( - SIGMA ) ) );
					acc.addAssign( S.mul( a ).mul( T ) );
					T.mulAssign( float( 1.0 ).sub( a ) );

				} );
				If( T.lessThan( 0.015 ), () => {

					Break();

				} );

			} );

			// aerial perspective: distant clouds sink into the horizon haze
			const fade = exp( t0.div( - 30000.0 ) );
			const haze = U.horizon.mul( float( 1.0 ).sub( T ) );
			result.assign( vec4( mix( haze, acc, fade ), T ) );

		} );

		return result;

	} );


	// Screen-space volume march (the cloud post pass, after ceddc's ArcGIS RenderNode
	// clouds): from the eye along `dir` up to `maxDist` (the visible surface from the
	// depth buffer, or the deck's far side over open sky), so clouds sit in front of
	// mountains too and summits vanish into them. Steps are spaced quadratically
	// (dense near the eye, where billows cover the most pixels) and sampled at their
	// midpoints: no dither pattern, no stripes, stable when paused.
	const marchView = Fn( ( [ ro, dir, maxDist ] ) => {

		const result = vec4( 0, 0, 0, 1 ).toVar();
		const dy = select( dir.y.abs().lessThan( 1e-4 ), float( 1e-4 ), dir.y );
		const tb = float( BASE - 350 ).sub( ro.y ).div( dy ), tt = float( TOP + 350 ).sub( ro.y ).div( dy );
		const tEnter = max( min( tb, tt ), 0.0 );
		const tExit = min( max( tb, tt ), tEnter.add( 14000.0 ) );
		const end = min( tExit, maxDist );
		If( end.greaterThan( tEnter.add( 1.0 ) ), () => {

			const L = U.sunDir;
			const mu = dot( dir, L );
			const phase = mix( hg( mu, - 0.25 ), hg( mu, 0.65 ), 0.55 ).mul( 4.0 * Math.PI ).add( 0.15 );
			const T = float( 1.0 ).toVar();
			const acc = vec3( 0 ).toVar();
			const ambTop = U.skyAmb.mul( 1.25 ).add( U.zenith.mul( 0.25 ) );
			const ambBot = U.groundAmb.mul( 1.2 ).add( U.horizonSun.mul( U.twilight.mul( 0.25 ) ) ).add( U.horizon.mul( 0.08 ) );
			const sunLit = smoothstep( - 0.08, 0.04, L.y );
			const span = end.sub( tEnter );

			Loop( STEPS, ( { i } ) => {

				const a = float( i ).div( STEPS ), b = float( i ).add( 1.0 ).div( STEPS );
				const dt = span.mul( b.mul( b ).sub( a.mul( a ) ) );
				const t = tEnter.add( span.mul( a.mul( a ) ) ).add( dt.mul( 0.5 ) );
				const p = ro.add( dir.mul( t ) );
				const d = density( p, false );
				If( d.greaterThan( 0.003 ), () => {

					// light: a short march toward the sun, strides growing x1.7
					const od = float( 0 ).toVar();
					let stride = 120.0, at = 0.0;
					for ( let k = 0; k < LSTEPS; k ++ ) {

						at += stride * 0.5;
						od.addAssign( density( p.add( L.mul( at ) ), true ).mul( stride ) );
						at += stride * 0.5;
						stride *= 1.7;

					}

					let ms = float( 0 );
					for ( let o = 0; o < 3; o ++ ) {

						const ka = Math.pow( 0.5, o ), kb = Math.pow( 0.45, o ), kc = Math.pow( 0.6, o );
						ms = ms.add( exp( od.mul( - SIGMA * kb ) ).mul( mix( float( 1.0 ), phase, kc ) ).mul( ka ) );

					}

					const powder = float( 1.0 ).sub( exp( d.mul( - 2.0 * 120.0 * SIGMA ) ) ).mul( 0.6 ).add( 0.4 );
					const hf = clamp( p.y.sub( BASE ).div( TOP - BASE ), 0.0, 1.0 );
					const sun = U.sunColor.mul( ms.mul( powder ).mul( 1.1 ) ).mul( sunLit );
					const beer = exp( od.mul( - SIGMA ) );
					const amb = mix( ambBot, ambTop, hf ).mul( mix( 0.3, 1.0, beer.mul( 0.5 ).add( hf.mul( 0.5 ) ) ) );
					// aerial perspective on the way to the eye
					const hz = float( 1.0 ).sub( exp( t.div( - 30000.0 ) ) );
					const S = mix( sun.add( amb ), U.horizon, hz.mul( 0.8 ) );
					const ab = float( 1.0 ).sub( exp( d.mul( dt ).mul( - SIGMA ) ) );
					acc.addAssign( S.mul( ab ).mul( T ) );
					T.mulAssign( float( 1.0 ).sub( ab ) );

				} );
				If( T.lessThan( 0.012 ), () => {

					Break();

				} );

			} );

			result.assign( vec4( acc, T ) );

		} );

		return result;

	} );

	return { march, marchView, density, BASE, TOP, SIGMA };

}
