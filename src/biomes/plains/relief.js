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

export const RELIEF_EXT = 16000; // half extent (m)
export const RELIEF_N = 1536; // cells per side (~21 m)
const CELL = RELIEF_EXT * 2 / RELIEF_N;

let H = null, TEX = null, ID = null, AUX = null, AUXTEX = null;
let DEM = null; // real terrain (metres relative to the plains), when loaded

// The real Torres del Paine: a 1536^2 grid of SRTM-derived elevation (AWS open
// terrain tiles, Mapzen terrarium encoding) over +-16 km around the trail between
// Lago Skottsberg and Campamento Italiano, stored as decimetres + 400 m in the
// R (high byte) and G (low byte) of a lossless PNG. Like the webgl-mountains demo,
// the mountains are real terrain; the shading adds rock, snow and erosion detail.
export async function loadDEM() {

	if ( DEM ) return;
	const url = new URL( '../../assets/plains/dem.png', import.meta.url ).href;
	const blob = await ( await fetch( url ) ).blob();
	const bmp = await createImageBitmap( blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } );
	const c = document.createElement( 'canvas' );
	c.width = bmp.width; c.height = bmp.height;
	const g = c.getContext( '2d', { willReadFrequently: true } );
	g.drawImage( bmp, 0, 0 );
	const px = g.getImageData( 0, 0, bmp.width, bmp.height ).data;
	const N = bmp.width;
	DEM = new Float32Array( N * N );
	for ( let k = 0; k < N * N; k ++ ) DEM[ k ] = ( px[ k * 4 ] * 256 + px[ k * 4 + 1 ] ) / 10 - 400;

}
let FLOW = null;

// value noise for the amplification (self-contained)
function hash2( x, y ) {

	let h = Math.imul( x, 374761393 ) + Math.imul( y, 668265263 ) | 0;
	h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;

}

function vnoise2( x, y ) {

	const xi = Math.floor( x ), yi = Math.floor( y ), fx = x - xi, fy = y - yi;
	const sx = fx * fx * ( 3 - 2 * fx ), sy = fy * fy * ( 3 - 2 * fy );
	const a = hash2( xi, yi ), b = hash2( xi + 1, yi ), c = hash2( xi, yi + 1 ), d = hash2( xi + 1, yi + 1 );
	return ( a + ( b - a ) * sx ) * ( 1 - sy ) + ( c + ( d - c ) * sx ) * sy;

}

function rng( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

function erode( h, N, droplets, r, flow ) {

	const inertia = 0.06, capacity = 6, minSlope = 0.02, depositK = 0.25, erodeK = 0.35, evap = 0.02, gravity = 6, maxSteps = 56;
	// erosion brush (radius 2): wider, smoother channels than single-cell erosion
	const BR = [];
	let wsum = 0;
	for ( let y = - 3; y <= 3; y ++ ) for ( let x = - 3; x <= 3; x ++ ) {

		const d = Math.hypot( x, y );
		if ( d <= 3.2 ) {

			const w = 3.2 - d; BR.push( x, y, w ); wsum += w;

		}

	}

	for ( let i = 2; i < BR.length; i += 3 ) BR[ i ] /= wsum;
	const at = ( x, y ) => h[ y * N + x ];

	for ( let d = 0; d < droplets; d ++ ) {

		// spawn on the mountains (rejection sampling)
		let x = 0, y = 0, ok = false;
		for ( let k = 0; k < 6 && ! ok; k ++ ) {

			x = 4 + r() * ( N - 9 ); y = 4 + r() * ( N - 9 );
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
			if ( x < 4 || y < 4 || x >= N - 5 || y >= N - 5 ) break;
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

			if ( flow ) flow[ i0 ] += water;
			speed = Math.sqrt( Math.max( 0, speed * speed - dh * gravity ) );
			water *= 1 - evap;
			if ( water < 0.02 ) break;

		}

	}

}

/** Build (once) from the analytic mountain function m(x, z) -> metres above the plains. */
function buildFromDEM( m ) {

	const t0 = performance.now();
	const N = RELIEF_N;
	H = new Float32Array( N * N );
	ID = new Uint8Array( N * N );
	const free = m.freeRadius || 950;
	for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

		const k = j * N + i;
		const x = ( ( i + 0.5 ) / N * 2 - 1 ) * RELIEF_EXT, z = ( ( j + 0.5 ) / N * 2 - 1 ) * RELIEF_EXT;
		const r = Math.hypot( x, z );
		// the walkable plains stay procedural; the real land rises around them
		const t = Math.min( 1, Math.max( 0, ( r - free ) / 900 ) ), w = t * t * ( 3 - 2 * t );
		let v = DEM[ k ];
		if ( v < 0 ) v = - 40 * ( 1 - Math.exp( v / 40 ) ); // valleys and lake basins: shallow floors
		H[ k ] = v * w;
		// massif ids for the materials: Paine Grande NW..N, the Cuernos / Almirante Nieto NNE..NE
		const az = Math.atan2( x, - z ) * 180 / Math.PI;
		ID[ k ] = H[ k ] < 60 ? 0 : az > - 100 && az < 12 ? 1 : az >= 12 && az < 60 && r > 4500 ? 2 : 4;

	}

	// terrain amplification: the 21 m data is smooth below ~60 m, so add ridged
	// sub-grid relief, scaled by slope (cliffs and steep flanks get the most), then let
	// hydraulic erosion carve it into gullies, ribs and debris fans
	const amp = ( x, z ) => {

		let s2 = 0, a = 1, f = 1 / 260, prev = 1, norm = 0;
		for ( let o = 0; o < 3; o ++ ) {

			const v = vnoise2( x * f + o * 7.3, z * f - o * 3.1 ) * 2 - 1;
			const n = 1 - Math.abs( v );
			s2 += n * n * prev * a; norm += a; prev = n;
			a *= 0.45; f *= 2.3;

		}

		return s2 / norm;

	};
	for ( let j = 1; j < N - 1; j ++ ) for ( let i = 1; i < N - 1; i ++ ) {

		const k = j * N + i;
		if ( H[ k ] < 40 ) continue;
		const gx = ( H[ k + 1 ] - H[ k - 1 ] ) / ( 2 * CELL ), gz = ( H[ k + N ] - H[ k - N ] ) / ( 2 * CELL );
		const sl = Math.min( 1.5, Math.hypot( gx, gz ) );
		const x = ( ( i + 0.5 ) / N * 2 - 1 ) * RELIEF_EXT, z = ( ( j + 0.5 ) / N * 2 - 1 ) * RELIEF_EXT;
		H[ k ] += ( amp( x, z ) - 0.35 ) * ( 10 + 38 * sl ) * Math.min( 1, H[ k ] / 200 );

	}

	// flow map + carving from droplets over the amplified relief
	const scratch = new Float32Array( N * N );
	for ( let k = 0; k < N * N; k ++ ) scratch[ k ] = Math.max( 0, H[ k ] ) / CELL;
	FLOW = new Float32Array( N * N );
	erode( scratch, N, 260000, rng( 90210 ), FLOW );
	// apply the carving smoothed over 5x5 cells (droplet paths are noisy pits otherwise)
	const dlt = new Float32Array( N * N );
	for ( let k = 0; k < N * N; k ++ ) dlt[ k ] = scratch[ k ] * CELL - Math.max( 0, H[ k ] );
	for ( let pass = 0; pass < 2; pass ++ ) {

		const t = new Float32Array( dlt );
		for ( let j = 1; j < N - 1; j ++ ) for ( let i = 1; i < N - 1; i ++ ) {

			const k = j * N + i;
			dlt[ k ] = t[ k ] * 0.36 + ( t[ k - 1 ] + t[ k + 1 ] + t[ k - N ] + t[ k + N ] ) * 0.12 + ( t[ k - N - 1 ] + t[ k - N + 1 ] + t[ k + N - 1 ] + t[ k + N + 1 ] ) * 0.04;

		}

	}

	for ( let k = 0; k < N * N; k ++ ) if ( H[ k ] > 30 ) H[ k ] += dlt[ k ] * 0.8;
	const orig = new Float32Array( N * N );
	for ( let k = 0; k < N * N; k ++ ) orig[ k ] = H[ k ] / CELL; // no sediment change
	bakeAux( orig, N );
	console.log( `relief: real terrain ${ N }^2 (${ ( performance.now() - t0 ).toFixed( 0 ) } ms)` );
	return H;

}

export function buildRelief( m ) {

	if ( H ) return H;
	if ( DEM ) return buildFromDEM( m );
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
	FLOW = new Float32Array( N * N );
	erode( h, N, 220000, rng( 90210 ), FLOW );
	// hard rock (the granite walls) keeps its shape: blend the uneroded height back
	// keep 55% of the carving everywhere (gullies, not knife-edge fins), and hard rock
	// (the granite walls) keeps its shape almost entirely
	for ( let k = 0; k < N * N; k ++ ) h[ k ] = orig[ k ] + ( h[ k ] - orig[ k ] ) * 0.4 * ( 1 - hard[ k ] * 0.85 );
	// thermal smoothing of single-cell spikes left by the droplets (one gentle pass)
	const o = new Float32Array( h );
	for ( let j = 1; j < N - 1; j ++ ) for ( let i = 1; i < N - 1; i ++ ) {

		const k = j * N + i;
		const avg = ( h[ k - 1 ] + h[ k + 1 ] + h[ k - N ] + h[ k + N ] ) * 0.25;
		o[ k ] = h[ k ] * 0.7 + avg * 0.3;

	}

	for ( let k = 0; k < N * N; k ++ ) o[ k ] = Math.max( 0, o[ k ] * CELL );
	H = o;
	bakeAux( orig, N );
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

// Baked terrain maps (what tools like World Creator / Gaea export as splat maps):
//   R flow      - how much water ran over each cell (log): streaks, wet channels
//   G sediment  - deposited (>0.5) or carved (<0.5) by erosion: talus fans vs fresh rock
//   B occlusion - horizon-based sky visibility (8 directions): gullies and couloirs darken
//   A slope     - 0 flat .. 1 vertical
function bakeAux( orig, N ) {

	const t0 = performance.now();
	const d = new Uint8Array( N * N * 4 );
	// blur the flow a little (droplet paths are noisy) and log-compress it
	const f = new Float32Array( N * N );
	for ( let j = 1; j < N - 1; j ++ ) for ( let i = 1; i < N - 1; i ++ ) {

		const k = j * N + i;
		f[ k ] = FLOW[ k ] * 0.4 + ( FLOW[ k - 1 ] + FLOW[ k + 1 ] + FLOW[ k - N ] + FLOW[ k + N ] ) * 0.15;

	}

	const dirs = [];
	for ( let a = 0; a < 8; a ++ ) dirs.push( [ Math.cos( a * Math.PI / 4 ), Math.sin( a * Math.PI / 4 ) ] );
	for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

		const k = j * N + i;
		const h0 = H[ k ];
		d[ k * 4 ] = Math.min( 255, Math.log( 1 + f[ k ] ) * 55 );
		d[ k * 4 + 1 ] = Math.max( 0, Math.min( 255, 128 + ( H[ k ] - orig[ k ] * CELL ) * 2.5 ) ); // metres deposited (+) / carved (-)
		// sky visibility: mean over 8 directions of (1 - sin(horizon angle)), 10 steps out to ~800 m
		let vis = 0;
		if ( h0 > 2 ) {

			for ( const [ dx, dz ] of dirs ) {

				let maxT = 0;
				for ( let s = 1, dist = 1.5; s <= 10; s ++, dist *= 1.45 ) {

					const x = Math.round( i + dx * dist ), z = Math.round( j + dz * dist );
					if ( x < 0 || z < 0 || x >= N || z >= N ) break;
					const t = ( H[ z * N + x ] - h0 ) / ( dist * CELL );
					if ( t > maxT ) maxT = t;

				}

				vis += 1 - maxT / Math.sqrt( 1 + maxT * maxT );

			}

			vis /= 8;

		} else vis = 1;
		d[ k * 4 + 2 ] = Math.round( vis * 255 );
		const gx = ( H[ Math.min( N - 1, i + 1 ) + j * N ] - H[ Math.max( 0, i - 1 ) + j * N ] ) / ( 2 * CELL );
		const gz = ( H[ i + Math.min( N - 1, j + 1 ) * N ] - H[ i + Math.max( 0, j - 1 ) * N ] ) / ( 2 * CELL );
		d[ k * 4 + 3 ] = Math.round( Math.min( 1, 1 - 1 / Math.sqrt( 1 + gx * gx + gz * gz ) ) * 255 );

	}

	AUX = d;
	FLOW = null;
	console.log( `relief: baked flow / sediment / occlusion / slope maps (${ ( performance.now() - t0 ).toFixed( 0 ) } ms)` );

}

export function reliefAuxTexture() {

	if ( AUXTEX ) return AUXTEX;
	const N = RELIEF_N;
	AUXTEX = new THREE.DataTexture( AUX || new Uint8Array( N * N * 4 ), N, N, THREE.RGBAFormat );
	AUXTEX.magFilter = AUXTEX.minFilter = THREE.LinearFilter;
	AUXTEX.needsUpdate = true;
	return AUXTEX;

}

// TSL: the baked maps at xz (vec4, see bakeAux)
export const reliefAux = ( xz ) => texture( reliefAuxTexture(), xz.div( RELIEF_EXT * 2 ).add( 0.5 ) ).level( 0 );

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
	// two half-float channels: a coarse part (whole multiples of 16 m, exact in half
	// precision) + the fine remainder (0..16 m at ~1 cm). Linear filtering is linear,
	// so R + G filters exactly; a single half channel would quantise heights to ~1 m
	// up high (visible as contour-line terracing in the shading)
	const d = new Uint16Array( N * N * 2 );
	if ( H ) for ( let k = 0; k < N * N; k ++ ) {

		const c = Math.floor( H[ k ] / 16 ) * 16;
		d[ k * 2 ] = THREE.DataUtils.toHalfFloat( c ); d[ k * 2 + 1 ] = THREE.DataUtils.toHalfFloat( H[ k ] - c );

	}

	TEX = new THREE.DataTexture( d, N, N, THREE.RGFormat, THREE.HalfFloatType );
	TEX.magFilter = TEX.minFilter = THREE.LinearFilter;
	TEX.wrapS = TEX.wrapT = THREE.ClampToEdgeWrapping;
	TEX.needsUpdate = true;
	return TEX;

}

// TSL: mountain height (m) at xz (explicit LOD so it also works in compute shaders)
export const relief = ( xz ) => {

	const t = texture( reliefTexture(), xz.div( RELIEF_EXT * 2 ).add( 0.5 ) ).level( 0 );
	return t.r.add( t.g );

};

// (tests / tools: inject elevation without a browser)
export function setDEM( arr ) {

	DEM = arr;

}
