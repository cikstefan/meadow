// Uniforms shared by every system (and by the biome definitions).

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

export const U = {
	time: uniform( 0 ),

	// sunDir / sunColor: the directional LIGHT (sun by day, moon at night) used for shading.
	// trueSunDir / trueSunColor: the actual sun, used by the sky (glow, halo, twilight
	// bands, mist scattering) so dusk and dawn never jump when the light hands over.
	sunDir: uniform( new THREE.Vector3( 0.3, 0.2, - 1 ).normalize() ),
	trueSunDir: uniform( new THREE.Vector3( 0.3, 0.2, - 1 ).normalize() ),
	trueSunColor: uniform( new THREE.Color( 1, 0.8, 0.6 ) ),
	sunColor: uniform( new THREE.Color( 1, 0.8, 0.6 ) ),
	zenith: uniform( new THREE.Color( 0.2, 0.4, 0.7 ) ),
	horizon: uniform( new THREE.Color( 0.7, 0.7, 0.7 ) ),
	horizonSun: uniform( new THREE.Color( 1.0, 0.7, 0.4 ) ),
	skyAmb: uniform( new THREE.Color( 0.3, 0.35, 0.45 ) ),
	groundAmb: uniform( new THREE.Color( 0.08, 0.09, 0.04 ) ),
	fogDensity: uniform( 0.0011 ),
	terrainFar: uniform( 560 ),

	windDir: uniform( new THREE.Vector2( 1, 0.35 ).normalize() ),
	windStrength: uniform( 0.55 ),
	windSpeed: uniform( 3.2 ),
	// integrated offsets (advanced on the CPU every frame) so wind / cloud speed
	// and direction can change smoothly without the whole field jumping
	windOffset: uniform( new THREE.Vector2() ), // ∫ windDir * windSpeed dt
	windPhase: uniform( 0 ), // ∫ windSpeed dt
	cloudOffset: uniform( new THREE.Vector2() ),
	skyOffset: uniform( new THREE.Vector2() ),
	driftOffset: uniform( new THREE.Vector3() ), // pollen drift ∫ W * strength dt
	particles: uniform( 0.6 ), // fraction of floating particles shown
	mist: uniform( 0.35 ), // morning inversion / valley mist amount
	twilight: uniform( 0 ), // 0..1 peaks around sunrise / sunset (belt of Venus, afterglow)
	// animals pushing plants aside: xyz + push radius; shadows: centre xz, strength, radius
	actors: [ 0, 1, 2, 3, 4 ].map( () => uniform( new THREE.Vector4( 0, - 1e4, 0, 1.2 ) ) ),
	actorShadows: [ 0, 1, 2, 3, 4 ].map( () => uniform( new THREE.Vector4( 0, 0, 0, 1 ) ) ),

	snow: uniform( 0.45 ), // snow & ice on the peaks (plains)
	clouds: uniform( 0.5 ), // raw cloud amount (0 = perfectly clear sky)
	cloudCover: uniform( 0.5 ),
	cloudDark: uniform( 0.45 ),
	cloudSpeed: uniform( 4.0 ),
	cloudTime: uniform( 0 ),
	shadowShift: uniform( new THREE.Vector2() ), // sun.xz / max(sun.y, floor): cloud-shadow projection per metre of height // seconds on the cloud clock (shape evolution)

	dry: uniform( 0 ), // amount of dry straw patches (0 = lush everywhere)
	night: uniform( 0 ), // 0 day .. 1 full night
	glowColor: uniform( new THREE.Color( 0.04, 0.32, 1.0 ) ), // bioluminescent flowers
	glow: uniform( 1 ),
};

