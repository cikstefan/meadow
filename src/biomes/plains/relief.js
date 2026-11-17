// The mountains as one eroded heightmap (the way landscape tools such as Gaea /
// World Machine feed Unreal landscapes): an uplift field from the massifs'
// crest lines and Cuernos towers, broken up by domain-warped ridged noise, then
// carved by droplet-based hydraulic erosion. Each droplet runs downhill with
// inertia, picks up sediment while it accelerates on steep ground and drops it
// where it slows, which cuts dendritic gullies, sharp aretes and sediment fans.
//
// The result (mountain height above the plains) lives in a Float32Array for
// the CPU (camera, scatter, backdrop mesh) and a half-float texture for the
// GPU terrain, so the ground you walk on and the far landscape are one and the
// same everywhere. Built lazily on first use (only the plains pay for it).

import * as THREE from 'three/webgpu';
import { texture, vec2, float } from 'three/tsl';

export const RELIEF_EXT = 10000; // half extent (m)
export const RELIEF_N = 768; // cells per side (~26 m)
const CELL = RELIEF_EXT * 2 / RELIEF_N;

let H = null, TEX = null, ID = null;

function rng( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

function erode( h, N, droplets, r ) {

	const inertia = 0.06, capacity = 6, minSlope = 0.02, depositK = 0.25, erodeK = 0.35, evap = 0.02, gravity = 6, maxSteps = 56;
	// erosion brush (radius 2): wider, smoother channels than single-cell erosion
	const BR = [];
	let wsum = 0;
	for ( let y = - 2; y <= 2; y ++ ) for ( let x = - 2; x <= 2; x ++ ) {

		const d = Math.hypot( x, y );
		if ( d <= 2.2 ) {

			const w = 2.2 - d; BR.push( x, y, w ); wsum += w;

		}

	}

	for ( let i = 2; i < BR.length; i += 3 ) BR[ i ] /= wsum;
	const at = ( x, y ) => h[ y * N + x ];

	for ( let d = 0; d < droplets; d ++ ) {

		// spawn on the mountains (rejection sampling)
		let x = 0, y = 0, ok = false;
		for ( let k = 0; k < 6 && ! ok; k ++ ) {

			x = 2 + r() * ( N - 5 ); y = 2 + r() * ( N - 5 );
			ok = at( x | 0, y | 0 ) > 1.5;

		}

		if ( ! ok ) continue;
		let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
		for ( let s = 0; s < maxSteps; s ++ ) {

			const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
			const i0 = iy * N + ix;
			const h00 = h[ i0 ], h10 = h[ i0 + 1 ], h01 = h[ i0 + N ], h11 = h[ i0 + N + 1 ];
			const gx = ( h10 - h00 ) * ( 1 - fy ) + ( h11 - h01 ) * fy;
			const gy = ( h01 - h00 ) * ( 1 - fx ) + ( h11 - h10 ) * fx;
			const hc = h00 * ( 1 - fx ) * ( 1 - fy ) + h10 * fx * ( 1 - fy ) + h01 * ( 1 - fx ) * fy + h11 * fx * fy;
			dx = dx * inertia - gx * ( 1 - inertia );
			dy = dy * inertia - gy * ( 1 - inertia );
			const len = Math.hypot( dx, dy );
			if ( len < 1e-6 ) break;
			dx /= len; dy /= len;
			x += dx; y += dy;
			if ( x < 2 || y < 2 || x >= N - 3 || y >= N - 3 ) break;
			const jx = x | 0, jy = y | 0, gx2 = x - jx, gy2 = y - jy, j0 = jy * N + jx;
			const hn = h[ j0 ] * ( 1 - gx2 ) * ( 1 - gy2 ) + h[ j0 + 1 ] * gx2 * ( 1 - gy2 ) + h[ j0 + N ] * ( 1 - gx2 ) * gy2 + h[ j0 + N + 1 ] * gx2 * gy2;
			const dh = hn - hc;
			const cap = Math.max( - dh, minSlope ) * speed * water * capacity;
			if ( sed > cap || dh > 0 ) {

				// deposit at the old position (fill pits first when going uphill)
				const dep = dh > 0 ? Math.min( dh, sed ) : ( sed - cap ) * depositK;
				sed -= dep;
				h[ i0 ] += dep * ( 1 - fx ) * ( 1 - fy ); h[ i0 + 1 ] += dep * fx * ( 1 - fy );
				h[ i0 + N ] += dep * ( 1 - fx ) * fy; h[ i0 + N + 1 ] += dep * fx * fy;

			} else {

				const er = Math.min( ( cap - sed ) * erodeK, - dh );
				for ( let b = 0; b < BR.length; b += 3 ) {

					const k = ( iy + BR[ b + 1 ] ) * N + ix + BR[ b ];
					const take = Math.min( h[ k ], er * BR[ b + 2 ] );
					h[ k ] -= take; sed += take;

				}

			}

			speed = Math.sqrt( Math.max( 0, speed * speed - dh * gravity ) );
			water *= 1 - evap;
			if ( water < 0.02 ) break;

		}

	}

}

/** Build (once) from the analytic mountain function m(x, z) -> metres above the plains. */
export function buildRelief( m ) {

	if ( H ) return H;
	const t0 = performance.now();
	const N = RELIEF_N;
	const h = new Float32Array( N * N );
	const hard = new Float32Array( N * N );
	ID = new Uint8Array( N * N );
	for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

		const x = ( ( i + 0.5 ) / N * 2 - 1 ) * RELIEF_EXT, z = ( ( j + 0.5 ) / N * 2 - 1 ) * RELIEF_EXT;
		h[ j * N + i ] = m( x, z ) / CELL; // erosion works in cell units
		ID[ j * N + i ] = m.id || 0; // which massif won (set by m)
		hard[ j * N + i ] = m.hard || 0;

	}

	const t1 = performance.now();
	const orig = new Float32Array( h );
	erode( h, N, 220000, rng( 90210 ) );
	// hard rock (the granite walls) keeps its shape: blend the uneroded height back
	// keep 55% of the carving everywhere (gullies, not knife-edge fins), and hard rock
	// (the granite walls) keeps its shape almost entirely
	for ( let k = 0; k < N * N; k ++ ) h[ k ] = orig[ k ] + ( h[ k ] - orig[ k ] ) * 0.55 * ( 1 - hard[ k ] * 0.85 );
	// thermal smoothing of single-cell spikes left by the droplets (one gentle pass)
	const o = new Float32Array( h );
	for ( let j = 1; j < N - 1; j ++ ) for ( let i = 1; i < N - 1; i ++ ) {

		const k = j * N + i;
		const avg = ( h[ k - 1 ] + h[ k + 1 ] + h[ k - N ] + h[ k + N ] ) * 0.25;
		o[ k ] = h[ k ] * 0.7 + avg * 0.3;

	}

	for ( let k = 0; k < N * N; k ++ ) o[ k ] = Math.max( 0, o[ k ] * CELL );
	H = o;
	console.log( `relief: ${ N }^2 heightmap ${ ( t1 - t0 ).toFixed( 0 ) } ms + erosion ${ ( performance.now() - t1 ).toFixed( 0 ) } ms` );
	return H;

}

// nearest-cell massif id (0 none, 1 Paine Grande, 2 Cuernos, 3 valley head, 4 hills)
export function reliefIdJS( x, z ) {

	if ( ! ID ) return 0;
	const N = RELIEF_N;
	const i = Math.round( ( x / RELIEF_EXT * 0.5 + 0.5 ) * N - 0.5 ), j = Math.round( ( z / RELIEF_EXT * 0.5 + 0.5 ) * N - 0.5 );
	if ( i < 0 || j < 0 || i >= N || j >= N ) return 0;
	return ID[ j * N + i ];

}

// bilinear lookup (metres); 0 outside the map
export function reliefJS( x, z ) {

	if ( ! H ) return 0;
	const N = RELIEF_N;
	const fx = ( x / RELIEF_EXT * 0.5 + 0.5 ) * N - 0.5, fz = ( z / RELIEF_EXT * 0.5 + 0.5 ) * N - 0.5;
	if ( fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1 ) return 0;
	const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * N + i;
	return ( H[ k ] * ( 1 - tx ) + H[ k + 1 ] * tx ) * ( 1 - tz ) + ( H[ k + N ] * ( 1 - tx ) + H[ k + N + 1 ] * tx ) * tz;

}

export function reliefTexture() {

	if ( TEX ) return TEX;
	const N = RELIEF_N;
	const d = new Uint16Array( N * N );
	if ( H ) for ( let k = 0; k < N * N; k ++ ) d[ k ] = THREE.DataUtils.toHalfFloat( H[ k ] );
	TEX = new THREE.DataTexture( d, N, N, THREE.RedFormat, THREE.HalfFloatType );
	TEX.magFilter = TEX.minFilter = THREE.LinearFilter;
	TEX.wrapS = TEX.wrapT = THREE.ClampToEdgeWrapping;
	TEX.needsUpdate = true;
	return TEX;

}

// TSL: mountain height (m) at xz (explicit LOD so it also works in compute shaders)
export const relief = ( xz ) => texture( reliefTexture(), xz.div( RELIEF_EXT * 2 ).add( 0.5 ) ).level( 0 ).r;
