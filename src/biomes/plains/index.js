// Torres del Paine: the windswept plains between Campamento Italiano and
// Paine Grande, above Lago Skottsberg, in late spring (mid-November) on a
// stormy golden evening.
//
// The biome reuses every meadow system (GPU grass rings, flowers, ground mesh,
// sky, pollen, post) with its own fields and palettes, and adds the systems the
// meadow doesn't have: the far landscape with Paine Grande and the Cuernos,
// the lake, the shrubs and the ghost forest of fire-killed lenga trees.

import * as THREE from 'three/webgpu';
import { Fn, float, int, vec2, vec3, mix, smoothstep, clamp, max, min, pow, floor, fract, dot, sqrt, If, texture } from 'three/tsl';
import { vnoise, vnoiseJS, hash2i, hash2i2 } from '../../tsl/noise.js';
import { U } from '../../tsl/uniforms.js';
import {
	terrainHeight, terrainHeightJS, fieldTall, fieldDry, fieldFlowers, fieldsJS, grassMask, trailDist, gravelPatch, trailPointJS,
} from './terrain.js';
import { TRAIL, FORWARD_AZ, WALK_RADIUS, PREVAILING_WIND } from './layout.js';

// Weather map shared by the volumetric clouds and their shadows on the ground:
// the raw field c (high = clear sky) at a point of the cloud layer.
const CLOUD_MID = 2400; // m: middle of the cloud slab (see sky.js)
const weather = ( p ) => vnoise( p.div( 700.0 ) ).mul( 0.58 )
	.add( vnoise( p.div( 240.0 ).add( vec2( 3.0, 8.0 ) ) ).mul( 0.3 ) )
	.add( vnoise( p.div( 78.0 ).add( vec2( 11.0, 2.0 ) ) ).mul( 0.12 ) );
const cloudAmount = () => smoothstep( 0.0, 0.2, U.clouds );

// 0..1 cloudiness of the layer above xz (1 = solid cloud)
export const cloudCoverageAt = ( xz ) => smoothstep( U.cloudCover.add( 0.14 ), U.cloudCover.sub( 0.1 ), weather( xz.sub( U.cloudOffset ) ) ).mul( cloudAmount() );

// Dappled light: the clouds' shadows, projected along the (low) sun from the
// cloud layer, so they stretch across the plains and race up the mountain flanks.
export const cloudShadowAt = ( xz, y ) => {

	const s = U.trueSunDir;
	const t = clamp( float( 1.0 ).div( max( s.y, 0.06 ) ), 0.0, 9.0 );
	const H = max( float( CLOUD_MID ).sub( y ), 0.0 );
	const p = xz.add( vec2( s.x, s.z ).mul( H.mul( t ) ) ).sub( U.cloudOffset );
	const c = weather( p );
	// soft-edged: cloud shadows have a penumbra of tens of metres
	const lit = max( smoothstep( U.cloudCover.sub( 0.07 ), U.cloudCover.add( 0.07 ), c ), float( 1.0 ).sub( cloudAmount() ) );
	return mix( float( 0.12 ), float( 1.0 ), lit );

};

const cloudShadow = Fn( ( [ xz ] ) => cloudShadowAt( xz, float( 0 ) ) );

// CPU mirror of the cloud-shadow noise (0..1 'lit' value before thresholding)
export function cloudFieldJS( x, z, y, offset ) {

	const s = U.trueSunDir.value;
	const t = Math.min( 9, 1 / Math.max( s.y, 0.06 ) );
	const H = Math.max( CLOUD_MID - y, 0 ) * t;
	const px = x + s.x * H - offset.x, pz = z + s.z * H - offset.y;
	return vnoiseJS( px / 700, pz / 700 ) * 0.58 + vnoiseJS( px / 240 + 3, pz / 240 + 8 ) * 0.3 + vnoiseJS( px / 78 + 11, pz / 78 + 2 ) * 0.12;

}

// photoscanned ground (Poly Haven, CC0; colour + height in alpha)
const groundTex = ( n ) => {

	const t = new THREE.TextureLoader().load( new URL( `../../assets/plains/${ n }.webp`, import.meta.url ).href );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 8;
	return t;

};
let GT = null; // created on first use (the meadow never loads these)
const scans = () => GT || ( GT = { trail: groundTex( 'rocky_trail_c' ), rocks: groundTex( 'dry_ground_rocks_c' ), litter: groundTex( 'withered_grass_c' ) } );

// two rotated, differently scaled samples: no visible tiling
const untiled = ( tex, xz, scale ) => {

	const a = texture( tex, xz.div( scale ) );
	const r = vec2( xz.x.mul( 0.8 ).sub( xz.y.mul( 0.6 ) ), xz.x.mul( 0.6 ).add( xz.y.mul( 0.8 ) ) );
	const b = texture( tex, r.div( scale * 2.7 ).add( vec2( 0.37, 0.71 ) ) );
	const m = smoothstep( 0.35, 0.65, vnoise( xz.div( scale * 3.0 ).add( vec2( 7, 3 ) ) ) );
	return mix( a, b, m.mul( 0.6 ) );

};

// trail gravel, bare schist patches and the litter under the tussocks
const groundAlbedo = Fn( ( [ xz, albedo, dist, toCanopy ] ) => {

	const T = scans();
	const d = trailDist( xz );
	const trail = float( 1.0 ).sub( smoothstep( TRAIL.halfWidth * 0.75, TRAIL.halfWidth + 0.25, d ) );
	const verge = float( 1.0 ).sub( smoothstep( TRAIL.halfWidth, TRAIL.halfWidth + TRAIL.verge + 0.4, d ) );
	const n1 = vnoise( xz.mul( 9.0 ) );
	const n3 = vnoise( xz.mul( 2.1 ).add( vec2( 9.0, 4.0 ) ) );
	const gp = gravelPatch( xz ).mul( float( 1.0 ).sub( toCanopy.mul( 0.6 ) ) );
	const detailK = smoothstep( 60.0, 15.0, dist );

	// distant / default appearance (cheap)
	const gravel = mix( vec3( 0.24, 0.225, 0.2 ), vec3( 0.36, 0.34, 0.3 ), n1 ).toVar();
	const schist = mix( vec3( 0.12, 0.12, 0.11 ), vec3( 0.24, 0.23, 0.21 ), n1 ).toVar();
	const litterK = float( 1.0 ).sub( toCanopy ).mul( detailK );
	const litter = vec3( 0 ).toVar();
	If( detailK.greaterThan( 0.0 ), () => {

		// scanned trail: packed dust and pebbles, cavities darkened by the scan's relief
		const tr = untiled( T.trail, xz, 1.7 );
		const tl = dot( tr.rgb, vec3( 0.3, 0.55, 0.15 ) );
		const trailCol = mix( vec3( tl ).mul( vec3( 1.0, 0.97, 0.92 ) ), tr.rgb, 0.35 ).mul( 0.52 ).mul( mix( 0.7, 1.08, smoothstep( 0.2, 0.7, tr.a ) ) );
		gravel.assign( mix( gravel, trailCol, detailK ) );
		// broken schist and stones on the bare patches (greyer than the scan)
		const rk = untiled( T.rocks, xz, 2.6 );
		const rl = dot( rk.rgb, vec3( 0.3, 0.55, 0.15 ) );
		const rockCol = mix( vec3( rl ), rk.rgb, 0.45 ).mul( 0.42 ).mul( mix( 0.65, 1.1, smoothstep( 0.15, 0.6, rk.a ) ) );
		schist.assign( mix( schist, rockCol, detailK ) );
		// dead grass litter and soil between the blades
		const lt = untiled( T.litter, xz, 1.4 );
		litter.assign( lt.rgb.mul( vec3( 0.12, 0.14, 0.065 ) ).mul( mix( 0.6, 1.1, smoothstep( 0.1, 0.6, lt.a ) ) ) );

	} );

	const a = mix( albedo, litter.add( albedo.mul( 0.35 ) ), litterK.mul( 0.75 ) ).toVar();
	const soil = mix( vec3( 0.09, 0.075, 0.055 ), vec3( 0.15, 0.13, 0.1 ), n3 );
	a.assign( mix( a, soil, verge.mul( 0.4 ).mul( float( 1.0 ).sub( toCanopy ) ) ) );
	a.assign( mix( a, gravel, trail ) );
	a.assign( mix( a, schist, gp.mul( 0.85 ) ) );
	return a;

} );

export const PLAINS = {
	id: 'plains',
	name: 'Torres del Paine',
	title: 'Torres del Paine — procedural WebGPU plains',
	loading: 'walking in from Italiano…',
	terrainHeight, terrainHeightJS, fieldTall, fieldDry, fieldFlowers, fieldsJS, grassMask, cloudShadow, groundAlbedo, cloudCoverage: cloudCoverageAt,
	animals: false,
	// the sun sets over the low south-western hills (not behind Paine Grande)
	sunAzOffset: - 24,
	// on-screen help (desktop) and credits: everything here is procedural
	help: '<b>drag</b> look · <b>WASD</b> move · <b>shift</b> run · <b>wheel / Q E</b> height · <b>M</b> sound',
	credit: '',

	// a low, dark storm deck racing east, breaking open along the horizon
	sky: { storm: 1, volumetric: 1 },

	defaults: {
		hour: 16.45, clouds: 0.58, wind: 2.0, windAngle: PREVAILING_WIND, grassHeight: 2.5, dryPatches: 0.48, mist: 0,
		particles: 0.3, spirits: false, spiritAmount: 0, shafts: true, glow: 3,
	},

	// you start on the trail looking up the French Valley
	spawn: { pos: trailPointJS( 0 ), az: FORWARD_AZ + 6, eye: 1.62 },
	walkRadius: WALK_RADIUS,

	// a clear Patagonian atmosphere: long views, a far camera plane
	atmosphere: { fogDensity: 0.000085, terrainFar: 1e6, far: 32000, skyRadius: 26000 },

	// coirón (golden tussock grass) mixed with fresh spring green
	grass: {
		hMin: 0.06, hMax: 0.46, wMin: 0.006, wMax: 0.016, flutter: 0.16, tussock: 1, multi: 3, flutterHz: [ 4.5, 9.0 ],
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

	// a GUI folder for the plains' own knobs
	buildGui( gui, extras ) {

		if ( ! extras ) return;
		const f = gui.addFolder( 'Plains' );
		const k = { scrub: 1, ghosts: 1 };
		f.add( U.snow, 'value', 0, 1, 0.01 ).name( 'snow & ice' );
		f.add( k, 'scrub', 0, 2, 0.05 ).name( 'scrub density' ).onFinishChange( ( v ) => extras.shrubs.setDensity( v ) );
		f.add( k, 'ghosts', 0, 2, 0.05 ).name( 'ghost forest' ).onFinishChange( ( v ) => extras.trees.setDensity( v ) );
		f.add( extras.caps.mesh, 'visible' ).name( 'summit clouds' );
		f.add( extras.water, 'visible' ).name( 'lake' );

	},

	// systems the meadow doesn't have; loaded lazily so the meadow stays lean
	async createExtras( ctx ) {

		const { createPlainsExtras } = await import( './extras.js' );
		return createPlainsExtras( ctx );

	},
};
