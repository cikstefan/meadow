// Floating pollen / seed fluff: a few thousand camera-facing specks that drift
// with the wind inside a box wrapped around the camera. They are almost
// invisible front-lit and sparkle when backlit by a low sun. No compute or
// buffers: positions are a pure function of (instance hash, time).

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, vec3, vec4, instanceIndex, positionLocal, uv, varying, mod, sin, cos, pow, clamp,
	dot, normalize, length, smoothstep, mix, cameraPosition
} from 'three/tsl';
import { pcg } from './tsl/noise.js';
import { U } from './tsl/world.js';

export class Pollen {

	constructor( count = 2500 ) {

		this.u = {
			right: uniform( new THREE.Vector3( 1, 0, 0 ) ),
			up: uniform( new THREE.Vector3( 0, 1, 0 ) ),
			ground: uniform( 0 ),
		};

		const box = 22.0;
		const vFade = varying( float( 0 ), 'vPFade' );
		const vWorld = varying( vec3( 0 ), 'vPWorld' );

		const mat = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } );
		mat.fog = false;

		mat.positionNode = Fn( () => {

			const i = instanceIndex;
			const r = vec3( pcg( i ), pcg( i.add( 7919 ) ), pcg( i.add( 104729 ) ) );
			const seed = pcg( i.add( 15485863 ) );
			const t = U.time;
			const W = vec3( U.windDir.x, 0, U.windDir.y );

			// drift with the wind + lazy looping turbulence
			const vel = W.mul( U.windStrength.mul( mix( 1.2, 2.6, seed ) ) ).add( vec3( 0, mix( - 0.04, 0.06, r.y ), 0 ) );
			const swirl = vec3(
				sin( t.mul( mix( 0.3, 0.9, r.x ) ).add( seed.mul( 40.0 ) ) ),
				sin( t.mul( mix( 0.4, 1.1, r.z ) ).add( seed.mul( 13.0 ) ) ).mul( 0.4 ),
				cos( t.mul( mix( 0.3, 0.8, r.y ) ).add( seed.mul( 71.0 ) ) )
			).mul( 0.35 );
			const base = r.mul( box ).add( vel.mul( t ) ).add( swirl );

			// wrap into a box centred on the camera; keep near the ground
			const rel = mod( base.sub( cameraPosition ).add( box * 0.5 ), box ).sub( box * 0.5 );
			const p = vec3( cameraPosition.x.add( rel.x ), this.u.ground.add( r.y.mul( r.y ).mul( 3.2 ) ).add( 0.15 ).add( swirl.y ), cameraPosition.z.add( rel.z ) );

			const size = mix( 0.004, 0.011, pow( seed, 3.0 ) );
			const world = p.add( this.u.right.mul( positionLocal.x.mul( size ) ) ).add( this.u.up.mul( positionLocal.y.mul( size ) ) );

			const d = length( p.sub( cameraPosition ) );
			const edge = clamp( float( 1.0 ).sub( length( rel.xz ).div( box * 0.5 ) ), 0, 1 );
			vFade.assign( smoothstep( 0.0, 0.35, edge ).mul( smoothstep( 0.25, 0.9, d ) ) );
			vWorld.assign( p );
			return world;

		} )();

		mat.colorNode = Fn( () => {

			const c = uv().sub( 0.5 );
			const disc = smoothstep( 0.5, 0.0, length( c ) );
			const V = normalize( cameraPosition.sub( vWorld ) );
			const back = pow( clamp( dot( V.negate(), U.sunDir ), 0, 1 ), 6.0 );
			const lit = smoothstep( - 0.02, 0.08, U.sunDir.y );
			const col = U.sunColor.mul( back.mul( 1.6 ).add( 0.05 ) ).mul( lit ).add( U.skyAmb.mul( 0.15 ) );
			return vec4( col.mul( disc ).mul( vFade ), 1.0 );

		} )();

		const geo = new THREE.PlaneGeometry( 2, 2 );
		this.mesh = new THREE.Mesh( geo, mat );
		this.mesh.count = count;
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 100;

	}

	update( camera, groundY ) {

		this.u.right.value.setFromMatrixColumn( camera.matrixWorld, 0 );
		this.u.up.value.setFromMatrixColumn( camera.matrixWorld, 1 );
		this.u.ground.value = groundY;

	}

}
