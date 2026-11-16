// Orographic clouds: the banner wrapped around Paine Grande's summit and the
// wisps streaming off the Cuernos' horns (photos: the peaks are rarely clear).
//
// Each cloud is a stream of soft billboard puffs that form on the windward
// side of a peak, drift downwind with the westerlies and dissolve on the lee
// side, so the banner keeps its shape while its texture flows. Puffs are lit
// from the sun direction with a pseudo-spherical normal (bright sun-facing
// rims, dark grey bellies) and fogged like everything else.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, pow, dot, normalize, length, attribute, varying, uv,
	cameraPosition, fract, positionLocal, uniform
} from 'three/tsl';
import { vnoise } from '../../tsl/noise.js';
import { U, applyFog } from '../../tsl/world.js';
import { polar } from './layout.js';
import { landHeightJS } from './terrain.js';

// [azimuth, distance, height, spread (m), puffs, puff size, travel length, opacity]
const BANNERS = [
	[ - 42, 2080, 1500, 700, 40, 760, 1500, 0.8 ], // Paine Grande summit cap
	[ - 28, 2150, 1320, 500, 18, 560, 1100, 0.6 ],
	[ - 60, 2150, 1380, 500, 14, 520, 1000, 0.55 ],
	[ 55, 3980, 1600, 260, 14, 380, 900, 0.55 ], // Cuerno Principal
	[ 70, 3900, 1640, 280, 14, 400, 1000, 0.55 ], // Cuerno Este
	[ 22, 7800, 1950, 900, 14, 900, 2200, 0.6 ], // valley head
];

function rng( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

export function buildSummitClouds() {

	const r = rng( 777 );
	const P = [], S = [];
	for ( const [ az, d, h, spread, n, size, travel, op ] of BANNERS ) {

		const [ x, z ] = polar( az, d );
		for ( let i = 0; i < n; i ++ ) {

			const ox = ( r() - 0.5 ) * spread, oz = ( r() - 0.5 ) * spread, oy = ( r() - 0.4 ) * spread * 0.35;
			const sz = size * ( 0.6 + r() * 0.8 );
			// keep the puff centre out of the rock
			const y = Math.max( h + oy, landHeightJS( x + ox, z + oz ) + sz * 0.25 );
			P.push( x + ox, y, z + oz, sz );
			S.push( r(), travel, op * ( 0.6 + r() * 0.4 ), r() );

		}

	}

	const quad = new THREE.PlaneGeometry( 1, 1 );
	const geo = new THREE.InstancedBufferGeometry();
	geo.index = quad.index;
	geo.setAttribute( 'position', quad.attributes.position );
	geo.setAttribute( 'uv', quad.attributes.uv );
	geo.setAttribute( 'iP', new THREE.InstancedBufferAttribute( new Float32Array( P ), 4 ) );
	geo.setAttribute( 'iS', new THREE.InstancedBufferAttribute( new Float32Array( S ), 4 ) );
	geo.instanceCount = P.length / 4;

	const mat = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false } );
	mat.fog = false;
	const camRight = uniform( new THREE.Vector3( 1, 0, 0 ) );
	const camUp = uniform( new THREE.Vector3( 0, 1, 0 ) );
	const vW = varying( vec3( 0 ), 'vCW' );
	const vA = varying( vec4( 0 ), 'vCA' ); // seed, life fade, opacity

	mat.positionNode = Fn( () => {

		const iP = attribute( 'iP', 'vec4' ), iS = attribute( 'iS', 'vec4' );
		// drift downwind along the travel length, looping; fade in / out at the ends
		const W = vec3( U.windDir.x, 0.0, U.windDir.y );
		const life = fract( U.time.mul( 0.012 ).mul( U.windSpeed.mul( 0.25 ).add( 0.5 ) ).add( iS.x ) );
		const centre = iP.xyz.add( W.mul( life.sub( 0.35 ).mul( iS.y ) ) ).add( vec3( 0, life.mul( 40.0 ), 0 ) );
		const fade = smoothstep( 0.0, 0.25, life ).mul( smoothstep( 1.0, 0.6, life ) );
		const size = iP.w.mul( mix( 0.8, 1.15, life ) );
		const world = centre.add( camRight.mul( positionLocal.x.mul( size ) ) ).add( camUp.mul( positionLocal.y.mul( size ).mul( 0.62 ) ) );
		vW.assign( world );
		vA.assign( vec4( iS.x, fade, iS.z, 0 ) );
		return world;

	} )();

	// puff shape + lighting (shared by colour and opacity)
	const q = uv().sub( 0.5 ).mul( 2.0 );
	const seed = vA.x;
	const t = U.time.mul( 0.03 );
	const n = vnoise( q.mul( 2.2 ).add( vec2( seed.mul( 40.0 ), t ) ) ).mul( 0.55 )
		.add( vnoise( q.mul( 5.1 ).add( vec2( t.mul( 1.7 ), seed.mul( 13.0 ) ) ) ).mul( 0.3 ) )
		.add( vnoise( q.mul( 11.0 ).add( vec2( seed.mul( 7.0 ), t.mul( 2.3 ) ) ) ).mul( 0.15 ) );
	const r2 = dot( q, q );
	const shape = smoothstep( 1.0, 0.2, r2.add( n.sub( 0.5 ).mul( 0.9 ) ) );
	mat.opacityNode = shape.mul( vA.y ).mul( vA.z ).mul( smoothstep( 0.25, 0.6, n ).mul( 0.6 ).add( 0.4 ) );

	mat.colorNode = Fn( () => {

		// pseudo-spherical normal of the puff -> sun-lit rims, dark grey bellies
		const nz = clamp( float( 1.0 ).sub( r2 ), 0.0, 1.0 ).sqrt();
		const toCam = normalize( cameraPosition.sub( vW ) );
		const N = normalize( camRight.mul( q.x ).add( camUp.mul( q.y ) ).add( toCam.mul( nz ) ) );
		const L = U.trueSunDir;
		const diff = clamp( dot( N, L ).mul( 0.6 ).add( 0.4 ), 0.0, 1.0 );
		const back = pow( clamp( dot( toCam.negate(), L ), 0.0, 1.0 ), 6.0 ).mul( smoothstep( 0.2, 1.0, r2 ) );
		const ambL = dot( U.skyAmb, vec3( 0.2126, 0.7152, 0.0722 ) );
		const dark = mix( vec3( ambL ), U.skyAmb, 0.3 ).mul( 0.5 );
		const col = dark.add( U.trueSunColor.mul( diff.mul( 0.13 ).add( back.mul( 0.4 ) ) ) ).mul( mix( 0.8, 1.15, n ) );
		return applyFog( col, vW );

	} )();

	const mesh = new THREE.Mesh( geo, mat );
	mesh.frustumCulled = false;
	mesh.renderOrder = 60;
	return {
		mesh,
		update( renderer, camera ) {

			camRight.value.setFromMatrixColumn( camera.matrixWorld, 0 );
			camUp.value.setFromMatrixColumn( camera.matrixWorld, 1 );

		},
	};

}
