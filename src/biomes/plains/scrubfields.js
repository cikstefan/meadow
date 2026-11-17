// Density fields of the scrub mosaic, shared by the instanced mounds (scrub.js,
// CPU placement) and the ground shader that paints the same mosaic beyond them.

import { vec2, clamp } from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';

// --- density fields (bit-exact CPU / GPU pair) ------------------------------
// cover: fraction of ground under shrubs (0..~0.75); notro / silver / green drifts
export function scrubFieldsJS( x, z ) {

	const c = vnoiseJS( x / 45 + 3.1, z / 45 + 7.3 ) * 0.6 + vnoiseJS( x / 13 + 1.7, z / 13 + 9.2 ) * 0.4;
	const notro = vnoiseJS( x / 70 + 11.3, z / 70 + 2.9 );
	const silver = vnoiseJS( x / 38 + 5.5, z / 38 + 13.1 );
	const green = vnoiseJS( x / 52 + 21.7, z / 52 + 4.4 );
	return { cover: Math.max( 0, Math.min( 1, ( c - 0.24 ) / 0.42 ) ) * 0.88, notro, silver, green };

}
export const scrubFieldsTSL = ( xz ) => {

	const c = vnoise( xz.div( 45 ).add( vec2( 3.1, 7.3 ) ) ).mul( 0.6 ).add( vnoise( xz.div( 13 ).add( vec2( 1.7, 9.2 ) ) ).mul( 0.4 ) );
	return {
		cover: clamp( c.sub( 0.24 ).div( 0.42 ), 0.0, 1.0 ).mul( 0.88 ),
		notro: vnoise( xz.div( 70 ).add( vec2( 11.3, 2.9 ) ) ),
		silver: vnoise( xz.div( 38 ).add( vec2( 5.5, 13.1 ) ) ),
		green: vnoise( xz.div( 52 ).add( vec2( 21.7, 4.4 ) ) ),
	};

};

// species weights at a point (shared rule for CPU placement and GPU far painting)
export function speciesWeights( f, gravel ) {

	return [
		0.55, // mata negra: the matrix
		0.35, // calafate
		0.15 + Math.max( 0, f.green - 0.5 ) * 1.6, // bright green swales
		0.16 + Math.max( 0, f.silver - 0.5 ) * 2.4 + gravel * 0.8, // silver cushions on dry ground
		Math.max( 0, f.notro - 0.56 ) * 2.2, // notro in drifts
	];

}

