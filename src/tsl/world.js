// Shared "world" functions used by every system (grass, flowers, terrain, sky):
// terrain height, meadow patch fields, wind, cloud shadows, sky, fog and the
// custom foliage lighting model. Keeping them in one place guarantees that the
// grass roots sit on the terrain, that distant terrain is tinted like the grass
// canopy, and that fog matches the sky at the horizon (no seam).

import {
	Fn, float, vec2, vec3, mix, smoothstep, clamp, max, pow, exp, dot, normalize, length, cameraPosition, select, abs
} from 'three/tsl';
import { vnoise, vnoiseJS } from './noise.js';

import { U } from './uniforms.js';
import { BIOME } from '../biomes/index.js';
export { U };

// ---------------------------------------------------------------- terrain & fields (per biome)

export const terrainHeight = BIOME.terrainHeight;
export const terrainHeightJS = BIOME.terrainHeightJS;
export const fieldTall = BIOME.fieldTall;
export const fieldDry = BIOME.fieldDry;
export const fieldFlowers = BIOME.fieldFlowers;
export const fieldsJS = BIOME.fieldsJS;

export const terrainNormal = Fn( ( [ xz ] ) => {

	const e = 0.2;
	const h = terrainHeight( xz );
	const hx = terrainHeight( xz.add( vec2( e, 0 ) ) );
	const hz = terrainHeight( xz.add( vec2( 0, e ) ) );
	return normalize( vec3( h.sub( hx ), e, h.sub( hz ) ) );

} );

// ---------------------------------------------------------------- wind & clouds

// Travelling gust field -> 0..1 strength. Gust fronts roll across the meadow
// in the wind direction, which is what produces the "waves" in tall grass.
export const windField = Fn( ( [ xz ] ) => {

	const scroll = U.windOffset;
	const p = xz.sub( scroll );
	// big rolling waves (visible across the whole valley) + gusts + flutter
	const n0 = vnoise( xz.sub( scroll.mul( 0.85 ) ).div( 38.0 ).add( vec2( 31.0, 7.0 ) ) );
	const n1 = vnoise( p.div( 11.0 ) );
	const n2 = vnoise( xz.sub( scroll.mul( 1.35 ) ).div( 3.7 ).add( vec2( 17.0, 5.0 ) ) );
	const n = n0.mul( 0.4 ).add( n1.mul( 0.42 ) ).add( n2.mul( 0.18 ) );
	const gust = smoothstep( 0.28, 0.82, n );
	return U.windStrength.mul( float( 0.22 ).add( gust.mul( 0.78 ) ) );

} );

// CPU mirror of windField (drives the wind audio)
export function windFieldJS( x, z ) {

	const dx = U.windOffset.value.x, dz = U.windOffset.value.y;
	const n0 = vnoiseJS( ( x - dx * 0.85 ) / 38 + 31, ( z - dz * 0.85 ) / 38 + 7 );
	const n1 = vnoiseJS( ( x - dx ) / 11, ( z - dz ) / 11 );
	const n2 = vnoiseJS( ( x - dx * 1.35 ) / 3.7 + 17, ( z - dz * 1.35 ) / 3.7 + 5 );
	const n = n0 * 0.4 + n1 * 0.42 + n2 * 0.18;
	const g = Math.min( 1, Math.max( 0, ( n - 0.28 ) / 0.54 ) );
	const gust = g * g * ( 3 - 2 * g );
	return U.windStrength.value * ( 0.22 + gust * 0.78 );

}

// 0..1 multiplier for direct sunlight under drifting cloud shadows
const cloudShadowDefault = Fn( ( [ xz ] ) => {

	const p = xz.sub( U.cloudOffset );
	const c = vnoise( p.div( 85.0 ) ).mul( 0.7 ).add( vnoise( p.div( 27.0 ).add( vec2( 3.0, 8.0 ) ) ).mul( 0.3 ) );
	const lit = max( smoothstep( U.cloudCover.sub( 0.1 ), U.cloudCover.add( 0.1 ), c ), smoothstep( 0.2, 0.0, U.clouds ) );
	return mix( float( 1.0 ).sub( U.cloudDark ), float( 1.0 ), lit );

} );
export const cloudShadow = BIOME.cloudShadow || cloudShadowDefault;

// Push vector (xz, 0..1) that the animals' bodies apply to a plant at `xz`.
export const actorPush = ( xz, y ) => {

	let sum = vec2( 0 );
	for ( const a of U.actors ) {

		const pd = xz.sub( a.xz );
		const pl = length( pd );
		const near = smoothstep( 3.0, 1.0, abs( a.y.sub( y ) ) );
		const amt = smoothstep( a.w, 0.0, pl ).mul( near );
		sum = sum.add( select( pl.greaterThan( 0.001 ), pd.div( pl ), vec2( 0 ) ).mul( amt ) );

	}

	return sum;

};

// Soft contact / cast shadows of the animals on the meadow (multiplies direct light).
export const actorShadowAt = ( xz ) => {

	let lit = float( 1.0 );
	for ( const sh of U.actorShadows ) {

		lit = lit.mul( float( 1.0 ).sub( sh.z.mul( smoothstep( sh.w, sh.w.mul( 0.15 ), length( xz.sub( sh.xy ) ) ) ) ) );

	}

	return lit;

};

// Brightness lift of the canopy as a gust passes: bent blades expose their
// glossier, lighter faces. This is what makes wind waves readable far away.
export const gustSheen = ( wind ) => mix( 0.86, 1.22, clamp( wind.div( max( U.windStrength, 0.05 ) ).sub( 0.22 ).div( 0.78 ), 0.0, 1.0 ) );

// Light thrown onto grass / ground by glowing flowers at night.
// `flowers` is the flower-density field at that spot.
export const flowerGlowLight = ( flowers, height01 ) =>
	U.glowColor.mul( U.night.mul( U.glow ).mul( flowers.mul( flowers ) ).mul( mix( 0.02, 0.07, height01 ) ) );

// ---------------------------------------------------------------- sky & fog

// Sky radiance for a view direction, without sun disk / clouds.
export const skyColor = Fn( ( [ dir ] ) => {

	const y = max( dir.y, 0.0 );
	const col = mix( U.zenith, U.horizon, pow( float( 1.0 ).sub( y ), 4.0 ) ).toVar();
	const mu = max( dot( dir, U.trueSunDir ), 0.0 );
	// warm horizon glow on the sun side: much wider and stronger around sunrise / sunset
	const glowPow = mix( 5.0, 2.2, U.twilight );
	col.assign( mix( col, U.horizonSun, pow( mu, glowPow ).mul( pow( float( 1.0 ).sub( y ), mix( 4.0, 2.6, U.twilight ) ) ).mul( mix( 0.85, 0.95, U.twilight ) ) ) );
	// belt of Venus: pink band above the dark earth-shadow, opposite the sun
	const sunH = normalize( vec3( U.trueSunDir.x, 0.0, U.trueSunDir.z ).add( vec3( 1e-4, 0, 0 ) ) );
	const anti = pow( max( dot( normalize( vec3( dir.x, 0.0, dir.z ).add( vec3( 0, 0, 1e-4 ) ) ), sunH.negate() ), 0.0 ), 1.5 );
	const belt = smoothstep( 0.03, 0.1, y ).mul( smoothstep( 0.36, 0.12, y ) );
	const earthShadow = smoothstep( 0.07, 0.0, y );
	col.addAssign( vec3( 0.46, 0.2, 0.32 ).mul( U.twilight.mul( belt ).mul( anti ).mul( 0.55 ) ) );
	col.mulAssign( float( 1.0 ).sub( U.twilight.mul( earthShadow ).mul( anti ).mul( 0.35 ) ) );
	// mie halo
	col.addAssign( U.trueSunColor.mul( pow( mu, 12.0 ).mul( 0.045 ).add( pow( mu, 110.0 ).mul( 0.2 ) ) ) );
	// faint moon halo at night
	const muM = max( dot( dir, U.sunDir ), 0.0 );
	col.addAssign( U.sunColor.mul( pow( muM, 60.0 ).mul( 0.25 ).mul( U.night ) ) );
	// inversion: a bright band of mist lying along the horizon
	col.assign( mix( col, mistColor( dir ), U.mist.mul( smoothstep( 0.11, 0.0, y ) ).mul( 0.8 ) ) );
	return col;

} );

// Colour of sunlit mist seen in a direction (strong forward scattering toward the sun).
export const mistColor = Fn( ( [ dir ] ) => {

	const mu = max( dot( dir, U.trueSunDir ), 0.0 );
	return U.horizon.mul( 0.55 ).add( U.skyAmb.mul( 1.3 ) )
		.add( U.trueSunColor.mul( mix( 0.1, 0.5, pow( mu, 4.0 ) ) ) ).add( U.sunColor.mul( U.night.mul( 0.15 ) ) )
		.add( U.horizonSun.mul( U.twilight.mul( pow( mu, 2.0 ) ).mul( 0.4 ) ) );

} );

// Aerial perspective: blend toward the sky colour seen in that direction,
// then integrate an exponential height fog (valley mist / inversion layer).
export const applyFog = Fn( ( [ color, worldPos ] ) => {

	const d = worldPos.sub( cameraPosition );
	const dist = length( d );
	const dir = d.div( max( dist, 0.001 ) );
	const fogDir = normalize( vec3( dir.x, max( dir.y, 0.0 ).mul( 0.35 ).add( 0.015 ), dir.z ) );
	const fogCol = skyColor( fogDir );
	const amt = float( 1.0 ).sub( exp( dist.mul( U.fogDensity ).negate() ) );
	const edge = smoothstep( U.terrainFar.mul( 0.62 ), U.terrainFar, dist );
	const fogged = mix( color, fogCol, max( amt, edge ) );

	// analytic integral of a * exp(-b (y - base)) along the view ray
	const b = 0.42;
	const base = float( - 1.0 );
	const a = U.mist.mul( 0.05 );
	const e0 = exp( max( cameraPosition.y.sub( base ), - 1.5 ).mul( - b ) );
	const k = dir.y.mul( dist ).mul( b );
	const term = select( abs( k ).greaterThan( 1e-3 ), float( 1.0 ).sub( exp( k.negate() ) ).div( k ), float( 1.0 ).sub( k.mul( 0.5 ) ) ).mul( dist );
	// drifting patchiness
	const patch = mix( 0.5, 1.3, vnoise( worldPos.xz.sub( U.windOffset.mul( 0.15 ) ).div( 70.0 ) ) );
	const mistAmt = float( 1.0 ).sub( exp( a.mul( e0 ).mul( term ).mul( patch ).negate() ) );
	return mix( fogged, mistColor( dir ), clamp( mistAmt, 0.0, 0.97 ) );

} );

// ---------------------------------------------------------------- lighting

// Foliage lighting model: wrapped diffuse, sky/ground ambient, translucency
// (light transmitted through thin leaves when the sun is behind them),
// a waxy specular sheen, cloud shadows and fog.
export const shadeFoliage = Fn( ( [ albedo, N, P, ao, shadow, transmit, specAmt, wrap, emit ] ) => {

	const V = normalize( cameraPosition.sub( P ) );
	const L = U.sunDir;
	const NdL = dot( N, L );
	// far away blades / leaf cards are sub-pixel: their glints and back-light flicker as
	// sparkles, so the sharp lobes fade out with distance
	const near = smoothstep( 160.0, 35.0, P.sub( cameraPosition ).length() );
	const diff = clamp( NdL.add( wrap ).div( float( 1.0 ).add( wrap ) ), 0.0, 1.0 );

	const sunVis = shadow.mul( smoothstep( - 0.04, 0.06, L.y ) );
	const direct = U.sunColor.mul( diff ).mul( sunVis );
	const ambient = mix( U.groundAmb, U.skyAmb, N.y.mul( 0.5 ).add( 0.5 ) ).mul( ao );

	// translucency: strongest looking toward the sun through the leaf
	const back = pow( clamp( dot( V.negate(), L ), 0.0, 1.0 ), 3.0 );
	const thru = back.mul( mix( 0.35, 1.4, near ) ).add( clamp( NdL.negate(), 0.0, 1.0 ).mul( 0.35 ) );
	const transCol = albedo.mul( vec3( 1.25, 1.3, 0.55 ) ).mul( U.sunColor ).mul( thru ).mul( transmit ).mul( sunVis );

	const H = normalize( L.add( V ) );
	const spec = pow( clamp( dot( N, H ), 0.0, 1.0 ), 48.0 ).mul( specAmt ).mul( sunVis ).mul( near );

	const col = albedo.mul( direct.add( ambient ) ).add( transCol ).add( U.sunColor.mul( spec ) ).add( emit );
	return applyFog( col, P );

} );


// Advance the integrated wind / cloud offsets (call once per frame).
export function advanceWind( dt ) {

	const d = U.windDir.value, sp = U.windSpeed.value;
	U.windOffset.value.addScaledVector( d, sp * dt );
	U.windPhase.value += sp * dt;
	// clouds drift (and churn) on their own, slower clock (a biome can slow them down)
	const cs = BIOME.cloudTimeScale ?? 1;
	U.cloudOffset.value.addScaledVector( d, U.cloudSpeed.value * dt * cs );
	U.skyOffset.value.addScaledVector( d, 0.0035 * dt * cs );
	U.cloudTime.value += dt * cs;
	const k = U.windStrength.value * dt;
	U.driftOffset.value.x += d.x * k;
	U.driftOffset.value.z += d.y * k;

}
