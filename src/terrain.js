// Ground mesh. Uses a non-uniform grid (dense near the camera, sparse far away)
// that follows the camera; heights come from the same analytic terrain function
// the grass compute uses. Close up it shows soil / thatch under the blades; far
// away it takes on the colour of the grass canopy (with the same dry patches)
// so the grass radius blends into the terrain invisibly.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, vec2, vec3, positionLocal, varying, mix, smoothstep, length, abs, dot, cameraPosition, normalize
} from 'three/tsl';
import { vnoise } from './tsl/noise.js';
import { U, terrainHeight, terrainNormal, fieldDry, fieldTall, cloudShadow, shadeFoliage } from './tsl/world.js';

export class Terrain {

	constructor( { grassRadius } ) {

		const half = 620;
		const seg = 320;
		const geo = new THREE.PlaneGeometry( 2, 2, seg, seg );
		geo.rotateX( - Math.PI / 2 );

		this.u = {
			offset: uniform( new THREE.Vector2() ),
			grassRadius: uniform( grassRadius ),
		};

		const vWorld = varying( vec3( 0 ), 'vTWorld' );
		const vNormal = varying( vec3( 0, 1, 0 ), 'vTNormal' );
		const vField = varying( vec2( 0 ), 'vTField' ); // dry, tall (low frequency -> per vertex)
		const mat = new THREE.MeshBasicNodeMaterial();
		mat.fog = false;

		mat.positionNode = Fn( () => {

			// quadratic remap -> fine resolution near the centre
			const p = positionLocal.xz;
			const q = p.mul( abs( p ) ).mul( 0.9 ).add( p.mul( 0.1 ) ).mul( half );
			const xz = q.add( this.u.offset );
			const y = terrainHeight( xz );
			const w = vec3( xz.x, y, xz.y );
			vWorld.assign( w );
			vNormal.assign( terrainNormal( xz ) );
			vField.assign( vec2( fieldDry( xz ), fieldTall( xz ) ) );
			return w;

		} )();

		mat.colorNode = Fn( () => {

			const P = vWorld;
			const xz = P.xz;
			const N = normalize( vNormal );
			const dist = length( P.sub( cameraPosition ) );

			// soil / thatch under the blades
			const n1 = vnoise( xz.mul( 1.7 ) );
			const n2 = vnoise( xz.mul( 6.0 ).add( vec2( 4, 9 ) ) );
			const soil = mix( vec3( 0.05, 0.04, 0.022 ), vec3( 0.11, 0.09, 0.05 ), n1.mul( 0.6 ).add( n2.mul( 0.4 ) ) );
			const thatch = mix( soil, vec3( 0.07, 0.09, 0.025 ), smoothstep( 0.3, 0.7, n2 ) );

			// canopy colour as seen from a distance: matches lit blade tips, with
			// clump-scale and patch-scale texture so it reads as grass, not paint
			const dry = vField.x;
			const tall = vField.y;
			const detail = float( 1.0 ).sub( smoothstep( 50.0, 220.0, dist ) );
			const c1 = vnoise( xz.mul( 0.9 ).add( vec2( 13, 2 ) ) );
			const c2 = vnoise( xz.mul( 3.3 ).add( vec2( 7, 41 ) ) );
			const c3 = vnoise( xz.mul( 0.21 ).add( vec2( 3, 5 ) ) );
			const tex = mix( float( 0.5 ), c1.mul( 0.65 ).add( c2.mul( 0.35 ) ), detail );
			const lush = mix( vec3( 0.085, 0.17, 0.03 ), vec3( 0.13, 0.2, 0.04 ), c3 );
			const straw = vec3( 0.36, 0.28, 0.13 );
			const canopy = mix( lush, straw, dry.mul( 0.8 ) )
				.mul( mix( 0.72, 1.1, tex ) )
				.mul( mix( 0.82, 1.05, tall ) );

			// looking steeply down into a canopy you see shaded stems and gaps;
			// at grazing angles only the lit tips -> view-dependent darkening
			const V = normalize( cameraPosition.sub( P ) );
			const steep = smoothstep( 0.15, 0.85, abs( dot( V, N ) ) );

			const toCanopy = smoothstep( this.u.grassRadius.mul( 0.35 ), this.u.grassRadius.mul( 0.8 ), dist );
			const albedo = mix( thatch, canopy, toCanopy );
			const ao = mix( 0.4, mix( 0.65, 0.95, tex ).mul( mix( 1.0, 0.55, steep ) ), toCanopy );

			// far: treat the canopy as a rough volume lit from above
			const Nf = normalize( mix( N, vec3( 0, 1, 0 ), toCanopy.mul( 0.25 ) ) );
			return shadeFoliage( albedo, Nf, P, ao, cloudShadow( xz ).mul( mix( 0.4, 1.0, toCanopy ) ), toCanopy.mul( mix( 0.75, 0.35, steep ) ), toCanopy.mul( 0.06 ), float( 0.4 ) );

		} )();

		this.mesh = new THREE.Mesh( geo, mat );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 10; // after grass/flowers: covered pixels fail early-z

	}

	update( camera ) {

		// snap to keep the near grid stable
		const s = 0.25;
		this.u.offset.value.set( Math.round( camera.position.x / s ) * s, Math.round( camera.position.z / s ) * s );

	}

}

