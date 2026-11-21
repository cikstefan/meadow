// Patagonian landscapes, blended across the plain (the same field on the CPU, for the plant
// scatter, and on the GPU, for the grass):
//   forest — lenga woods (with ñirre at their edges) over a low green lawn and a green understorey
//   scrub  — the Torres del Paine trail country: notro in flower, quilembai, calafate, mata
//            negra and chaura among short tawny grass, a dead tree here and there
//   ghost  — burnt hills: many silver dead lengas and fallen logs, few notros, much green scrub
//   steppe — the open Argentine-side pampa: golden coirón tussocks and neneo cushions
// The start of the trail is always scrub (the photographs this was built from).
import { Fn, float, vec2, smoothstep, length } from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';

const ss = ( a, b, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

// field scales (m) and thresholds; the walkable disk is ~260 m across its radius, so
// each landscape spans one to two hundred metres
const F = { s: 150, o: [ 12.3, 4.1 ], a: 0.55, b: 0.66 };
const G = { s: 120, o: [ 33.7, 71.2 ], a: 0.61, b: 0.71 };
const S = { s: 190, o: [ 5.4, 90.6 ], a: 0.58, b: 0.7 };
let SPAWN = [ 0, 0 ];
export function setBiomeSpawn( x, z ) { SPAWN = [ x, z ]; }

export function biomeJS( x, z ) {

	const home = ss( 45, 110, Math.hypot( x - SPAWN[ 0 ], z - SPAWN[ 1 ] ) );
	const forest = ss( F.a, F.b, vnoiseJS( x / F.s + F.o[ 0 ], z / F.s + F.o[ 1 ] ) ) * home;
	const ghost = ss( G.a, G.b, vnoiseJS( x / G.s + G.o[ 0 ], z / G.s + G.o[ 1 ] ) ) * ( 1 - forest ) * home;
	const steppe = ss( S.a, S.b, vnoiseJS( x / S.s + S.o[ 0 ], z / S.s + S.o[ 1 ] ) ) * ( 1 - forest ) * ( 1 - ghost ) * home;
	return { forest, ghost, steppe, scrub: Math.max( 0, 1 - forest - ghost - steppe ) };

}

export const biomeSpawn = () => SPAWN;
export const biomeTSL = ( xz, spawn = vec2( SPAWN[ 0 ], SPAWN[ 1 ] ) ) => {

	const home = smoothstep( 45.0, 110.0, length( xz.sub( spawn ) ) );
	const n = ( P ) => vnoise( xz.div( P.s ).add( vec2( P.o[ 0 ], P.o[ 1 ] ) ) );
	const forest = smoothstep( F.a, F.b, n( F ) ).mul( home );
	const ghost = smoothstep( G.a, G.b, n( G ) ).mul( float( 1.0 ).sub( forest ) ).mul( home );
	const steppe = smoothstep( S.a, S.b, n( S ) ).mul( float( 1.0 ).sub( forest ) ).mul( float( 1.0 ).sub( ghost ) ).mul( home );
	return { forest, ghost, steppe, scrub: float( 1.0 ).sub( forest ).sub( ghost ).sub( steppe ).max( 0.0 ) };

};

// the grass in each landscape: height factor and how dry/golden it is
export const GRASS = {
	forest: { tall: 0.45, dry: - 0.6, tussock: 0.05 }, // a short green lawn under the beeches
	scrub: { tall: 0.62, dry: 0.28, tussock: 0.35 }, // short tawny sward between the bushes
	ghost: { tall: 0.7, dry: 0.32, tussock: 0.5 },
	steppe: { tall: 1.0, dry: 0.45, tussock: 1.0 }, // tall golden tussock grass
};

// grass height factor and dryness offset for a landscape mix
export const grassBiomeTSL = ( xz ) => {

	const b = biomeTSL( xz );
	const tall = b.forest.mul( GRASS.forest.tall ).add( b.scrub.mul( GRASS.scrub.tall ) ).add( b.ghost.mul( GRASS.ghost.tall ) ).add( b.steppe.mul( GRASS.steppe.tall ) );
	const dry = b.forest.mul( GRASS.forest.dry ).add( b.scrub.mul( GRASS.scrub.dry ) ).add( b.ghost.mul( GRASS.ghost.dry ) ).add( b.steppe.mul( GRASS.steppe.dry ) );
	const tussock = b.forest.mul( GRASS.forest.tussock ).add( b.scrub.mul( GRASS.scrub.tussock ) ).add( b.ghost.mul( GRASS.ghost.tussock ) ).add( b.steppe.mul( GRASS.steppe.tussock ) );
	return { tall, dry, tussock };

};
export function grassBiomeJS( x, z ) {

	const b = biomeJS( x, z );
	let tall = 0, dry = 0;
	for ( const k of [ 'forest', 'scrub', 'ghost', 'steppe' ] ) { tall += b[ k ] * GRASS[ k ].tall; dry += b[ k ] * GRASS[ k ].dry; }
	return { tall, dry };

}
