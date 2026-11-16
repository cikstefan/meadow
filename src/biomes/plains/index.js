// Torres del Paine: the windswept plains between Campamento Italiano and
// Paine Grande, above Lago Skottsberg, in late spring (mid-November) on a
// stormy golden evening.
//
// The biome reuses every meadow system (GPU grass rings, flowers, ground mesh,
// sky, pollen, post) with its own fields and palettes, and adds the systems the
// meadow doesn't have: the far landscape with Paine Grande and the Cuernos,
// the lake, the shrubs and the ghost forest of fire-killed lenga trees.

import { Fn, float, vec2, vec3, mix, smoothstep, clamp, max, pow } from 'three/tsl';
import { vnoise } from '../../tsl/noise.js';
import { U } from '../../tsl/uniforms.js';
import {
	terrainHeight, terrainHeightJS, fieldTall, fieldDry, fieldFlowers, fieldsJS, grassMask, trailDist, gravelPatch, trailPointJS,
} from './terrain.js';
import { TRAIL, FORWARD_AZ, WALK_RADIUS } from './layout.js';

// Dappled light: fast, broken cloud shadows projected along the (low) sun, so
// they stretch across the plains and race up the mountain flanks.
export const cloudShadowAt = ( xz, y ) => {

	const s = U.trueSunDir;
	const t = clamp( float( 1.0 ).div( max( s.y, 0.06 ) ), 0.0, 9.0 );
	const H = max( float( 1300.0 ).sub( y ), 0.0 );
	const p = xz.add( vec2( s.x, s.z ).mul( H.mul( t ) ).mul( 0.35 ) ).sub( U.cloudOffset );
	const c = vnoise( p.div( 380.0 ) ).mul( 0.58 )
		.add( vnoise( p.div( 130.0 ).add( vec2( 3.0, 8.0 ) ) ).mul( 0.3 ) )
		.add( vnoise( p.div( 42.0 ).add( vec2( 11.0, 2.0 ) ) ).mul( 0.12 ) );
	// soft-edged: cloud shadows have a penumbra of tens of metres
	const lit = smoothstep( U.cloudCover.sub( 0.07 ), U.cloudCover.add( 0.07 ), c );
	return mix( float( 0.1 ), float( 1.0 ), lit );

};

const cloudShadow = Fn( ( [ xz ] ) => cloudShadowAt( xz, float( 0 ) ) );

// trail gravel and bare schist patches on the ground
const groundAlbedo = Fn( ( [ xz, albedo, dist, toCanopy ] ) => {

	const d = trailDist( xz );
	const trail = float( 1.0 ).sub( smoothstep( TRAIL.halfWidth * 0.75, TRAIL.halfWidth + 0.25, d ) );
	const verge = float( 1.0 ).sub( smoothstep( TRAIL.halfWidth, TRAIL.halfWidth + TRAIL.verge + 0.4, d ) );
	const n1 = vnoise( xz.mul( 9.0 ) );
	const n2 = vnoise( xz.mul( 37.0 ).add( vec2( 5.0, 1.0 ) ) );
	const n3 = vnoise( xz.mul( 2.1 ).add( vec2( 9.0, 4.0 ) ) );
	// pale grey-brown gravel with darker pebbles and a few light quartz chips
	const gravel = mix( vec3( 0.24, 0.225, 0.2 ), vec3( 0.42, 0.4, 0.36 ), n1.mul( 0.55 ).add( n3.mul( 0.45 ) ) )
		.mul( mix( 0.72, 1.12, smoothstep( 0.35, 0.65, n2 ) ) );
	const soil = mix( vec3( 0.09, 0.075, 0.055 ), vec3( 0.15, 0.13, 0.1 ), n3 );
	const a = mix( albedo, soil, verge.mul( 0.55 ).mul( float( 1.0 ).sub( toCanopy ) ) ).toVar();
	a.assign( mix( a, gravel, trail ) );
	// schist / shale patches
	const gp = gravelPatch( xz ).mul( float( 1.0 ).sub( toCanopy.mul( 0.6 ) ) );
	const schist = mix( vec3( 0.12, 0.12, 0.11 ), vec3( 0.24, 0.23, 0.21 ), n1 ).mul( mix( 0.8, 1.1, n2 ) );
	a.assign( mix( a, schist, gp.mul( 0.85 ) ) );
	return a;

} );

export const PLAINS = {
	id: 'plains',
	name: 'Torres del Paine',
	terrainHeight, terrainHeightJS, fieldTall, fieldDry, fieldFlowers, fieldsJS, grassMask, cloudShadow, groundAlbedo,
	animals: false,
	// on-screen help (desktop) and credits: everything here is procedural
	help: '<b>drag</b> look · <b>WASD</b> move · <b>shift</b> run · <b>wheel / Q E</b> height · <b>M</b> sound',
	credit: '',

	// a low, dark storm deck racing east, breaking open along the horizon
	sky: { storm: 1 },

	defaults: {
		hour: 16.45, clouds: 0.58, wind: 2.0, windAngle: 6, grassHeight: 1.0, dryPatches: 0.48, mist: 0,
		particles: 0.3, spirits: false, spiritAmount: 0, shafts: true,
	},

	// you start on the trail looking up the French Valley
	spawn: { pos: trailPointJS( 0 ), az: FORWARD_AZ + 6, eye: 1.62 },
	walkRadius: WALK_RADIUS,

	// a clear Patagonian atmosphere: long views, a far camera plane
	atmosphere: { fogDensity: 0.000085, terrainFar: 1e6, far: 32000, skyRadius: 26000 },

	// coirón (golden tussock grass) mixed with fresh spring green
	grass: {
		hMin: 0.06, hMax: 0.42, wMin: 0.0045, wMax: 0.012, flutter: 0.16, tussock: 1, flutterHz: [ 4.5, 9.0 ],
		lushBase: [ 0.035, 0.05, 0.014 ], lushTipA: [ 0.15, 0.25, 0.05 ], lushTipB: [ 0.22, 0.3, 0.07 ], lushTipC: [ 0.11, 0.23, 0.055 ],
		dryBase: [ 0.13, 0.1, 0.045 ], dryTipA: [ 0.5, 0.38, 0.18 ], dryTipB: [ 0.66, 0.53, 0.3 ], dead: 0.8,
	},

	ground: {
		soilA: [ 0.06, 0.055, 0.03 ], soilB: [ 0.11, 0.1, 0.06 ], thatch: [ 0.085, 0.11, 0.035 ],
		lushA: [ 0.13, 0.17, 0.05 ], lushB: [ 0.21, 0.23, 0.08 ], straw: [ 0.44, 0.35, 0.17 ],
	},

	// spring flowers, low to the ground (5 slots):
	// capachito (Calceolaria uniflora), violet, white star, yellow senecio, pink oxalis
	flowers: {
		minH: [ 0.06, 0.05, 0.1, 0.17, 0.05 ], size: [ 1.1, 0.55, 0.62, 0.7, 0.72 ],
		petals: [ 2, 5, 8, 10, 5 ], length: [ 0.75, 0.7, 0.9, 0.85, 0.7 ], width: [ 0.95, 0.45, 0.2, 0.2, 0.5 ],
		cup: [ 1.1, 0.2, - 0.05, 0.05, 0.45 ], inner: [ 0.05, 0.15, 0.25, 0.3, 0.1 ],
		centreR: [ 0.14, 0.18, 0.26, 0.3, 0.16 ], dome: [ 0.06, 0.05, 0.12, 0.16, 0.05 ],
		petalCol: [ [ 0.86, 0.46, 0.015 ], [ 0.33, 0.17, 0.6 ], [ 0.82, 0.8, 0.74 ], [ 0.82, 0.6, 0.02 ], [ 0.66, 0.24, 0.45 ] ],
		centreCol: [ [ 0.45, 0.07, 0.02 ], [ 0.75, 0.66, 0.3 ], [ 0.75, 0.55, 0.08 ], [ 0.6, 0.4, 0.02 ], [ 0.62, 0.55, 0.2 ] ],
		glossy: 3, blotch: 0, daisy: 2, frilly: - 1, notched: - 1,
		density: 0.5, grassFollow: 0,
	},

	// systems the meadow doesn't have; loaded lazily so the meadow stays lean
	async createExtras( ctx ) {

		const { createPlainsExtras } = await import( './extras.js' );
		return createPlainsExtras( ctx );

	},
};
