// Torres del Paine: the windswept plains between Campamento Italiano and
// Paine Grande, above Lago Skottsberg, in late spring (mid-November) on a
// stormy golden evening.
//
// The biome reuses every meadow system (GPU grass rings, flowers, ground mesh,
// sky, pollen, post) with its own fields and palettes, and adds the systems the
// meadow doesn't have: the far landscape with Paine Grande and the Cuernos,
// the lake, the shrubs and the ghost forest of fire-killed lenga trees.

import * as THREE from 'three/webgpu';
import { Fn, float, int, vec2, vec3, mix, smoothstep, clamp, max, min, pow, floor, fract, dot, sqrt, If, texture, exp } from 'three/tsl';
import { vnoise, vnoiseJS, hash2i, hash2i2 } from '../../tsl/noise.js';
import { U } from '../../tsl/uniforms.js';
import { makeVolumetricClouds } from '../../tsl/clouds3d.js';
import {
	terrainHeight, terrainHeightJS, fieldTall, fieldDry, fieldFlowers, fieldsJS, grassMask, trailDist, gravelPatch, trailPointJS, mountainHeight,
} from './terrain.js';
import { TRAIL, FORWARD_AZ, WALK_RADIUS, PREVAILING_WIND } from './layout.js';

// Weather map shared by the volumetric clouds and their shadows on the ground:
// the raw field c (high = clear sky) at a point of the cloud layer.
const CLOUD_BASE = 1500, CLOUD_TOP = 3300, CLOUD_MID = 2000;
const weather = ( p ) => vnoise( p.div( 4800.0 ) ).mul( 0.55 )
	.add( vnoise( p.div( 1500.0 ).add( vec2( 3.0, 8.0 ) ) ).mul( 0.32 ) )
	.add( vnoise( p.div( 480.0 ).add( vec2( 11.0, 2.0 ) ) ).mul( 0.13 ) );
const cloudAmount = () => smoothstep( 0.0, 0.2, U.clouds );

// 0..1 cloudiness of the layer above xz (1 = solid cloud)
export const cloudCoverageAt = ( xz ) => {

	const w = weather( xz.sub( U.cloudOffset ) ).toVar();
	return smoothstep( U.cloudCover.add( 0.14 ), U.cloudCover.sub( 0.1 ), w ).mul( cloudAmount() );

};

// the volumetric cloud deck (raymarched by the sky)
export const CLOUDS = makeVolumetricClouds( ( xz ) => cloudCoverageAt( xz ), { base: CLOUD_BASE, top: CLOUD_TOP, steps: 56, lightSteps: 5 } );

// Dappled light: the real shadow of the cloud deck. Follow the sun ray up into
// the layer and sample the same 3D cloud density at two heights (Beer's law),
// so every shadow on the plains belongs to a cloud overhead.
export const cloudShadowAt = ( xz, y ) => {

	const s = U.trueSunDir;
	// the sun's projection is damped: in the sped-up day a grazing sun would sweep the
	// shadows across the plain far faster than the clouds themselves move
	const sy = max( s.y, 0.3 );
	const toward = vec2( s.x, s.z ).div( sy );
	const h1 = max( float( CLOUD_BASE + 300 ).sub( y ), 0.0 ), h2 = max( float( CLOUD_BASE + 750 ).sub( y ), 0.0 );
	const p1 = xz.add( toward.mul( h1.min( 9000.0 ) ) ), p2 = xz.add( toward.mul( h2.min( 9000.0 ) ) );
	const d1 = CLOUDS.density( vec3( p1.x, float( CLOUD_BASE + 300 ), p1.y ), true ).toVar();
	const d2 = CLOUDS.density( vec3( p2.x, float( CLOUD_BASE + 750 ), p2.y ), true ).toVar();
	const d = d1.add( d2 );
	// optical depth through ~1 km of cloud, softened (light scattered into the shadow)
	const T = exp( d.mul( - 0.5 * 600 * 0.011 ).div( sy ).max( - 30.0 ) );
	return mix( float( 0.14 ), float( 1.0 ), smoothstep( 0.0, 1.0, T ) );

};

const cloudShadow = Fn( ( [ xz ] ) => cloudShadowAt( xz, float( 0 ) ) );

// CPU mirror of the weather map (0..1, high = clear), sampled where the sun ray meets the deck
export function cloudFieldJS( x, z, y, offset ) {

	const s = U.trueSunDir.value;
	const H = Math.min( 9000, Math.max( CLOUD_MID - y, 0 ) / Math.max( s.y, 0.3 ) );
	const px = x + s.x * H - offset.x, pz = z + s.z * H - offset.y;
	return vnoiseJS( px / 4800, pz / 4800 ) * 0.55 + vnoiseJS( px / 1500 + 3, pz / 1500 + 8 ) * 0.32 + vnoiseJS( px / 480 + 11, pz / 480 + 2 ) * 0.13;

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
const scans = () => GT || ( GT = { trail: groundTex( 'rocky_trail_c' ), rocks: groundTex( 'dry_ground_rocks_c' ), litter: groundTex( 'aerial_grass_c' ) } );

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
	// ragged, grass-invaded edges; the path fades into the verge, no hard band
	const rag = vnoise( xz.mul( 1.7 ) ).sub( 0.5 ).mul( 0.35 ).add( vnoise( xz.mul( 6.0 ).add( vec2( 3, 9 ) ) ).sub( 0.5 ).mul( 0.15 ) );
	const trail = float( 1.0 ).sub( smoothstep( TRAIL.halfWidth * 0.55, TRAIL.halfWidth + 0.35, d.add( rag ) ) );
	const verge = float( 1.0 ).sub( smoothstep( TRAIL.halfWidth, TRAIL.halfWidth + TRAIL.verge + 0.4, d ) );
	const n1 = vnoise( xz.mul( 9.0 ) );
	const n3 = vnoise( xz.mul( 2.1 ).add( vec2( 9.0, 4.0 ) ) );
	const gp = gravelPatch( xz ).mul( float( 1.0 ).sub( toCanopy.mul( 0.6 ) ) );
	const detailK = smoothstep( 60.0, 15.0, dist );

	// distant / default appearance (cheap)
	const gravel = mix( vec3( 0.3, 0.29, 0.27 ), vec3( 0.42, 0.41, 0.38 ), n1 ).toVar();
	const schist = mix( vec3( 0.12, 0.12, 0.11 ), vec3( 0.24, 0.23, 0.21 ), n1 ).toVar();
	const litterK = float( 1.0 ).sub( toCanopy ).mul( detailK );
	const litter = vec3( 0 ).toVar();
	If( detailK.greaterThan( 0.0 ), () => {

		// scanned trail: packed dust and pebbles, cavities darkened by the scan's relief
		const tr = untiled( T.trail, xz, 1.7 );
		const tl = dot( tr.rgb, vec3( 0.3, 0.55, 0.15 ) );
		const trailCol = mix( vec3( tl ).mul( vec3( 1.0, 0.98, 0.95 ) ), tr.rgb, 0.25 ).mul( 0.66 ).mul( mix( 0.78, 1.05, smoothstep( 0.2, 0.7, tr.a ) ) );
		gravel.assign( mix( gravel, trailCol, detailK ) );
		// broken schist and stones on the bare patches (greyer than the scan)
		const rk = untiled( T.rocks, xz, 2.6 );
		const rl = dot( rk.rgb, vec3( 0.3, 0.55, 0.15 ) );
		const rockCol = mix( vec3( rl ), rk.rgb, 0.45 ).mul( 0.42 ).mul( mix( 0.65, 1.1, smoothstep( 0.15, 0.6, rk.a ) ) );
		schist.assign( mix( schist, rockCol, detailK ) );
		// dead grass litter and soil between the blades
		const lt = untiled( T.litter, xz, 3.4 );
		// the turf between the tussocks: short green-gold growth (scan luminance graded
		// into the grass palette, never bare mud)
		const ll = dot( lt.rgb, vec3( 0.3, 0.55, 0.15 ) );
		litter.assign( mix( vec3( 0.05, 0.075, 0.02 ), vec3( 0.2, 0.19, 0.08 ), smoothstep( 0.2, 0.75, ll ) ).mul( mix( 0.6, 1.1, smoothstep( 0.1, 0.6, lt.a ) ) ) );

	} );

	// distant canopy: the same tussock drifts and colour regions as the blades
	// (grass.js), so where the blades end the ground carries on seamlessly
	const tf = vnoise( xz.div( 38.0 ).add( vec2( 4.2, 1.9 ) ) ).mul( 0.62 ).add( vnoise( xz.div( 12.0 ).add( vec2( 8.8, 3.3 ) ) ).mul( 0.3 ) ).add( 0.04 );
	const tus = smoothstep( 0.3, 0.75, tf );
	const region = vnoise( xz.div( 55.0 ).add( vec2( 17.0, 5.0 ) ) );
	const dryE = clamp( fieldDry( xz ).mul( 0.55 ).add( tus.mul( 0.5 ) ).add( region.sub( 0.5 ).mul( 0.6 ) ), 0.0, 1.0 );
	const canopyM = mix( vec3( 0.12, 0.16, 0.045 ), vec3( 0.33, 0.27, 0.12 ), dryE ).mul( mix( 0.8, 1.05, tus ) );
	const a0 = mix( albedo, canopyM, toCanopy.mul( 0.85 ) );
	const a = mix( a0, litter, litterK.mul( 0.85 ) ).toVar();
	const soil = mix( vec3( 0.09, 0.075, 0.055 ), vec3( 0.15, 0.13, 0.1 ), n3 );
	a.assign( mix( a, soil, verge.mul( 0.4 ).mul( float( 1.0 ).sub( toCanopy ) ) ) );
	a.assign( mix( a, gravel, trail ) );
	a.assign( mix( a, schist, gp.mul( 0.85 ) ) );
	// up on the mountains: scree, then bare rock
	const mh = mountainHeight( xz );
	const scree = schist.mul( mix( 0.8, 1.15, n3 ) );
	a.assign( mix( a, scree, smoothstep( 90.0, 260.0, mh ) ) );
	return a;

} );

export const PLAINS = {
	id: 'plains',
	name: 'Torres del Paine',
	title: 'Torres del Paine — procedural WebGPU plains',
	loading: 'walking in from Italiano…',
	terrainHeight, terrainHeightJS, fieldTall, fieldDry, fieldFlowers, fieldsJS, grassMask, cloudShadow, groundAlbedo, clouds: CLOUDS, cloudTimeScale: 0.03, // clouds (and their shadows) drift ~8x slower than before
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

	// a clear Patagonian atmosphere: long views, a far camera plane
	atmosphere: { fogDensity: 0.000085, terrainFar: 1e6, far: 32000, skyRadius: 26000 },

	// coirón (golden tussock grass) mixed with fresh spring green
	grass: {
		hMin: 0.06, hMax: 0.46, wMin: 0.006, wMax: 0.016, flutter: 0.16, tussock: 1, multi: 3, flutterHz: [ 4.5, 9.0 ],
		lushBase: [ 0.022, 0.034, 0.008 ], lushTipA: [ 0.13, 0.22, 0.04 ], lushTipB: [ 0.2, 0.27, 0.05 ], lushTipC: [ 0.09, 0.19, 0.04 ],
		dryBase: [ 0.07, 0.06, 0.025 ], dryTipA: [ 0.4, 0.31, 0.12 ], dryTipB: [ 0.52, 0.41, 0.19 ], dead: 0.86,
	},

	ground: {
		soilA: [ 0.06, 0.055, 0.03 ], soilB: [ 0.11, 0.1, 0.06 ], thatch: [ 0.085, 0.11, 0.035 ],
		lushA: [ 0.11, 0.15, 0.04 ], lushB: [ 0.19, 0.21, 0.07 ], straw: [ 0.36, 0.29, 0.13 ],
	},

	// spring flowers, low to the ground (5 slots):
	// capachito (Calceolaria uniflora), violet, white star, yellow senecio, pink oxalis
	flowers: {
		// + Anemone multifida (cream), Sisyrinchium (yellow stars), Perezia (lilac-blue daisy)
		minH: [ 0.06, 0.05, 0.1, 0.17, 0.05, 0.12, 0.08, 0.1 ], size: [ 1.1, 0.55, 0.62, 0.7, 0.72, 0.78, 0.5, 0.66 ],
		petals: [ 2, 5, 8, 10, 5, 6, 6, 13 ], length: [ 0.75, 0.7, 0.9, 0.85, 0.7, 0.8, 0.75, 0.9 ], width: [ 0.95, 0.45, 0.2, 0.2, 0.5, 0.48, 0.32, 0.16 ],
		cup: [ 1.1, 0.2, - 0.05, 0.05, 0.45, 0.35, 0.1, 0.0 ], inner: [ 0.05, 0.15, 0.25, 0.3, 0.1, 0.12, 0.1, 0.28 ],
		centreR: [ 0.14, 0.18, 0.26, 0.3, 0.16, 0.24, 0.14, 0.3 ], dome: [ 0.06, 0.05, 0.12, 0.16, 0.05, 0.14, 0.05, 0.12 ],
		petalCol: [ [ 0.86, 0.46, 0.015 ], [ 0.33, 0.17, 0.6 ], [ 0.82, 0.8, 0.74 ], [ 0.82, 0.6, 0.02 ], [ 0.66, 0.24, 0.45 ], [ 0.86, 0.82, 0.6 ], [ 0.85, 0.68, 0.04 ], [ 0.44, 0.4, 0.74 ] ],
		centreCol: [ [ 0.45, 0.07, 0.02 ], [ 0.75, 0.66, 0.3 ], [ 0.75, 0.55, 0.08 ], [ 0.6, 0.4, 0.02 ], [ 0.62, 0.55, 0.2 ], [ 0.7, 0.62, 0.12 ], [ 0.38, 0.22, 0.03 ], [ 0.85, 0.8, 0.66 ] ],
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
