// The original meadow: gently rolling hills of lush grass and wildflowers,
// infinite in every direction.

import { Fn, vec2, smoothstep } from 'three/tsl';
import { vnoise, vnoiseJS } from '../tsl/noise.js';
import { U } from '../tsl/uniforms.js';

// ---------------------------------------------------------------- terrain

const T1 = 150, T2 = 48, T3 = 13;
const A1 = 16, A2 = 4, A3 = 0.6;

export const terrainHeight = Fn( ( [ xz ] ) => {

	const h1 = vnoise( xz.div( T1 ).add( vec2( 13.1, 7.7 ) ) ).sub( 0.5 ).mul( A1 );
	const h2 = vnoise( xz.div( T2 ).add( vec2( 3.3, 91.2 ) ) ).sub( 0.5 ).mul( A2 );
	const h3 = vnoise( xz.div( T3 ).add( vec2( 57.0, 21.0 ) ) ).sub( 0.5 ).mul( A3 );
	return h1.add( h2 ).add( h3 );

} );

export function terrainHeightJS( x, z ) {

	return ( vnoiseJS( x / T1 + 13.1, z / T1 + 7.7 ) - 0.5 ) * A1 +
		( vnoiseJS( x / T2 + 3.3, z / T2 + 91.2 ) - 0.5 ) * A2 +
		( vnoiseJS( x / T3 + 57.0, z / T3 + 21.0 ) - 0.5 ) * A3;

}

// ---------------------------------------------------------------- meadow fields

// CPU mirrors (spawn-point search)
const ss = ( a, b, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

export function fieldsJS( x, z ) {

	const tall = ss( 0.2, 0.8, vnoiseJS( x / 26 + 41, z / 26 + 3 ) ) * 0.72 + vnoiseJS( x / 6.5 + 9, z / 6.5 + 77 ) * 0.28;
	const dry = ss( 0.6, 0.92, vnoiseJS( x / 38 + 101, z / 38 + 19 ) * 0.78 + vnoiseJS( x / 8 + 5, z / 8 + 33 ) * 0.22 ) * U.dry.value;
	const flowers = ss( 0.45, 0.9, vnoiseJS( x / 17 + 7, z / 17 + 140 ) * 0.75 + vnoiseJS( x / 5 + 66, z / 5 + 12 ) * 0.25 );
	return { tall, dry, flowers };

}

// 0..1 : how tall the grass is (tussocks / mown-looking hollows)
export const fieldTall = Fn( ( [ xz ] ) => {

	const a = smoothstep( 0.2, 0.8, vnoise( xz.div( 26 ).add( vec2( 41.0, 3.0 ) ) ) );
	const b = vnoise( xz.div( 6.5 ).add( vec2( 9.0, 77.0 ) ) );
	return a.mul( 0.72 ).add( b.mul( 0.28 ) );

} );

// 0..1 : dried, straw-coloured areas
export const fieldDry = Fn( ( [ xz ] ) => {

	const a = vnoise( xz.div( 38 ).add( vec2( 101.0, 19.0 ) ) );
	const b = vnoise( xz.div( 8.0 ).add( vec2( 5.0, 33.0 ) ) );
	return smoothstep( 0.6, 0.92, a.mul( 0.78 ).add( b.mul( 0.22 ) ) ).mul( U.dry );

} );

// 0..1 : wildflower density (drifts of flowers)
export const fieldFlowers = Fn( ( [ xz ] ) => {

	const a = vnoise( xz.div( 17 ).add( vec2( 7.0, 140.0 ) ) );
	const b = vnoise( xz.div( 5.0 ).add( vec2( 66.0, 12.0 ) ) );
	return smoothstep( 0.45, 0.9, a.mul( 0.75 ).add( b.mul( 0.25 ) ) );

} );


export const MEADOW = {
	id: 'meadow',
	name: 'Meadow',
	terrainHeight, terrainHeightJS, fieldTall, fieldDry, fieldFlowers, fieldsJS,
	animals: true,

	// settings defaults (URL parameters override)
	defaults: {
		hour: 4.55, clouds: 0.51, wind: 1.6, windAngle: 110, grassHeight: 1.71, dryPatches: 0, mist: 0,
		particles: 0.85, spirits: true, spiritAmount: 0.09, shafts: true,
	},

	// grass blades (linear albedo)
	grass: {
		hMin: 0.14, hMax: 1.05, wMin: 0.009, wMax: 0.024, flutter: 0.07,
		lushBase: [ 0.025, 0.05, 0.012 ], lushTipA: [ 0.11, 0.23, 0.04 ], lushTipB: [ 0.17, 0.26, 0.05 ], lushTipC: [ 0.08, 0.22, 0.06 ],
		dryBase: [ 0.12, 0.1, 0.04 ], dryTipA: [ 0.42, 0.33, 0.15 ], dryTipB: [ 0.55, 0.45, 0.25 ], dead: 0.9,
	},

	// ground under the blades and the distant canopy
	ground: {
		soilA: [ 0.05, 0.04, 0.022 ], soilB: [ 0.11, 0.09, 0.05 ], thatch: [ 0.07, 0.09, 0.025 ],
		lushA: [ 0.085, 0.17, 0.03 ], lushB: [ 0.13, 0.2, 0.04 ], straw: [ 0.36, 0.28, 0.13 ],
	},

	// wildflower species (5 slots): oxeye daisy, buttercup, poppy, cornflower, campion
	flowers: {
		minH: [ 0.32, 0.26, 0.38, 0.4, 0.4 ], size: [ 1.0, 0.75, 1.15, 0.85, 0.85 ],
		petals: [ 12, 5, 4, 8, 5 ], length: [ 1.0, 0.62, 1.05, 0.85, 0.85 ], width: [ 0.17, 0.42, 0.62, 0.22, 0.34 ],
		cup: [ - 0.12, 0.65, 0.55, 0.15, 0.08 ], inner: [ 0.28, 0.2, 0.15, 0.28, 0.12 ],
		centreR: [ 0.3, 0.22, 0.2, 0.26, 0.12 ], dome: [ 0.16, 0.12, 0.22, 0.2, 0.05 ],
		petalCol: [ [ 0.78, 0.78, 0.72 ], [ 0.82, 0.55, 0.012 ], [ 0.62, 0.025, 0.012 ], [ 0.07, 0.16, 0.62 ], [ 0.66, 0.16, 0.36 ] ],
		centreCol: [ [ 0.7, 0.4, 0.02 ], [ 0.55, 0.42, 0.03 ], [ 0.02, 0.02, 0.015 ], [ 0.08, 0.05, 0.22 ], [ 0.75, 0.6, 0.5 ] ],
		glossy: 1, blotch: 2, daisy: 0, frilly: 3, notched: 4, // which slot gets which petal detail
		density: 0.9, scaleWithGrass: true,
	},
};
