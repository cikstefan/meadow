// Integer hashing + value noise, implemented twice: once in TSL (GPU) and once in
// plain JS (CPU). Both use identical uint32 arithmetic so the CPU can query the
// exact same terrain the GPU renders (camera ground-follow, spawn points...).

import { Fn, uint, int, float, vec2, floor, fract, mix } from 'three/tsl';

// ---------------------------------------------------------------- GPU (TSL)

// PCG-style integer hash -> [0,1]
export const pcg = Fn( ( [ v ] ) => {

	const state = uint( v ).mul( uint( 747796405 ) ).add( uint( 2891336453 ) );
	const word = state.shiftRight( state.shiftRight( uint( 28 ) ).add( uint( 4 ) ) ).bitXor( state ).mul( uint( 277803737 ) );
	return float( word.shiftRight( uint( 22 ) ).bitXor( word ) ).div( 4294967295.0 );

} );

// hash of two ints (i32 nodes; negative values are fine, they are bit-cast)
export const hash2i = ( ix, iy ) => pcg( uint( ix ).mul( uint( 1597334677 ) ).add( uint( iy ).mul( uint( 3812015801 ) ) ) );

export const hash2i2 = ( ix, iy ) => vec2(
	pcg( uint( ix ).mul( uint( 1597334677 ) ).add( uint( iy ).mul( uint( 3812015801 ) ) ) ),
	pcg( uint( ix ).mul( uint( 3812015801 ) ).add( uint( iy ).mul( uint( 1597334677 ) ) ).add( uint( 1013904223 ) ) )
);

// 2D value noise with quintic fade, output [0,1]
export const vnoise = Fn( ( [ p ] ) => {

	const i = floor( p );
	const f = fract( p );
	const u = f.mul( f ).mul( f ).mul( f.mul( f.mul( 6.0 ).sub( 15.0 ) ).add( 10.0 ) );
	const ix = int( i.x ).toVar();
	const iy = int( i.y ).toVar();
	const a = hash2i( ix, iy );
	const b = hash2i( ix.add( 1 ), iy );
	const c = hash2i( ix, iy.add( 1 ) );
	const d = hash2i( ix.add( 1 ), iy.add( 1 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );

} );

// ---------------------------------------------------------------- CPU (JS)

export function pcgJS( v ) {

	const state = ( Math.imul( v >>> 0, 747796405 ) + 2891336453 ) >>> 0;
	const word = Math.imul( ( ( state >>> ( ( state >>> 28 ) + 4 ) ) ^ state ) >>> 0, 277803737 ) >>> 0;
	return ( ( ( word >>> 22 ) ^ word ) >>> 0 ) / 4294967295.0;

}

export function hash2iJS( ix, iy ) {

	return pcgJS( ( Math.imul( ix | 0, 1597334677 ) + Math.imul( iy | 0, 3812015801 | 0 ) ) >>> 0 );

}

export function vnoiseJS( x, y ) {

	const ix = Math.floor( x ), iy = Math.floor( y );
	const fx = x - ix, fy = y - iy;
	const ux = fx * fx * fx * ( fx * ( fx * 6 - 15 ) + 10 );
	const uy = fy * fy * fy * ( fy * ( fy * 6 - 15 ) + 10 );
	const a = hash2iJS( ix, iy ), b = hash2iJS( ix + 1, iy );
	const c = hash2iJS( ix, iy + 1 ), d = hash2iJS( ix + 1, iy + 1 );
	const ab = a + ( b - a ) * ux, cd = c + ( d - c ) * ux;
	return ab + ( cd - ab ) * uy;

}
