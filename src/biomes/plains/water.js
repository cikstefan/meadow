// Lago Skottsberg: milky turquoise glacial water whipped by the westerlies.
//
// One plane at lake level; the terrain hides it wherever the ground is higher.
// The surface normal is built from three octaves of scrolling value noise (chop
// travelling downwind), darkened and roughened under passing gusts (cat's
// paws), with scattered whitecaps. Glacial flour makes the water scatter
// strongly, so the turquoise body colour dominates over the sky reflection.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, mix, smoothstep, clamp, max, pow, dot, normalize, length, reflect, cameraPosition,
	positionWorld
} from 'three/tsl';
import { vnoise } from '../../tsl/noise.js';
import { U, applyFog, skyColor, windField } from '../../tsl/world.js';
import { cloudShadowAt } from './index.js';
import { LAKE } from './layout.js';

export function buildWater() {

	// bounding box of the lake outline
	let x0 = 1e9, x1 = - 1e9, z0 = 1e9, z1 = - 1e9;
	LAKE.axis.forEach( ( [ x, z ], i ) => {

		const w = LAKE.halfWidth[ i ] + 200;
		x0 = Math.min( x0, x - w ); x1 = Math.max( x1, x + w );
		z0 = Math.min( z0, z - w ); z1 = Math.max( z1, z + w );

	} );
	const geo = new THREE.PlaneGeometry( x1 - x0, z1 - z0, 1, 1 );
	geo.rotateX( - Math.PI / 2 );
	geo.translate( ( x0 + x1 ) / 2, LAKE.level, ( z0 + z1 ) / 2 );

	const mat = new THREE.MeshBasicNodeMaterial();
	mat.fog = false;

	mat.colorNode = Fn( () => {

		const P = positionWorld;
		const xz = P.xz;
		const dist = length( P.sub( cameraPosition ) );
		const W = U.windDir;
		const scroll = U.windOffset;

		// gusts (cat's paws) roughen and darken the water as they race downwind
		const gust = smoothstep( 0.2, 0.9, windField( xz.mul( 0.35 ) ).div( max( U.windStrength, 0.1 ) ) );

		// height field: chop elongated across the wind, travelling downwind
		const across = vec2( W.y.negate(), W.x );
		const q = vec2( dot( xz, W ), dot( xz, across ) );
		const sc = dot( scroll, W );
		const hgt = ( p ) => {

			const a = vnoise( vec2( p.x.sub( sc.mul( 1.1 ) ).div( 2.2 ), p.y.div( 4.5 ) ) );
			const b = vnoise( vec2( p.x.sub( sc.mul( 0.8 ) ).div( 7.0 ), p.y.div( 13.0 ) ).add( vec2( 17, 3 ) ) );
			const c = vnoise( vec2( p.x.sub( sc.mul( 1.6 ) ).div( 0.7 ), p.y.div( 1.3 ) ).add( vec2( 5, 41 ) ) );
			return a.mul( 0.5 ).add( b.mul( 0.9 ) ).add( c.mul( 0.18 ) );

		};

		const e = 0.25;
		const h0 = hgt( q ), hx = hgt( q.add( vec2( e, 0 ) ) ), hz = hgt( q.add( vec2( 0, e ) ) );
		const amp = mix( 0.5, 1.1, gust ).mul( smoothstep( 2500.0, 200.0, dist ).mul( 0.85 ).add( 0.15 ) ).mul( clamp( U.windStrength, 0.2, 2.5 ) );
		const gq = vec2( h0.sub( hx ), h0.sub( hz ) ).div( e ).mul( amp ).mul( 0.35 );
		const g = W.mul( gq.x ).add( across.mul( gq.y ) );
		const N = normalize( vec3( g.x, 1.0, g.y ) );

		const V = normalize( cameraPosition.sub( P ) );
		const L = U.sunDir;
		const NdV = clamp( dot( N, V ), 0.0, 1.0 );
		const fres = float( 0.02 ).add( pow( float( 1.0 ).sub( NdV ), 5.0 ).mul( 0.98 ) );
		const R = reflect( V.negate(), N );
		const sky = skyColor( normalize( vec3( R.x, max( R.y, 0.02 ), R.z ) ) );

		const sun = cloudShadowAt( xz, float( LAKE.level ) ).mul( smoothstep( - 0.04, 0.06, L.y ) );
		// milky turquoise body (glacial flour scatters light back up)
		const bodyA = mix( vec3( 0.025, 0.25, 0.27 ), vec3( 0.02, 0.17, 0.2 ), gust.mul( 0.6 ) );
		const body = bodyA.mul( U.skyAmb.mul( 1.6 ).add( U.sunColor.mul( max( L.y, 0.0 ).mul( 0.55 ).add( 0.1 ) ).mul( sun ) ) );
		const glint = pow( clamp( dot( R, L ), 0.0, 1.0 ), 380.0 ).mul( 6.0 ).add( pow( clamp( dot( R, L ), 0.0, 1.0 ), 40.0 ).mul( 0.25 ) );
		const col = mix( body, sky, fres.mul( 0.55 ) ).add( U.sunColor.mul( glint ).mul( sun ) ).toVar();

		// whitecaps under strong gusts
		const foamN = vnoise( vec2( q.x.sub( sc.mul( 1.25 ) ).div( 3.0 ), q.y.div( 2.2 ) ).add( vec2( 9, 9 ) ) );
		const foam = smoothstep( 0.8, 0.93, foamN.mul( 0.7 ).add( gust.mul( 0.3 ) ) ).mul( smoothstep( 0.9, 1.8, U.windStrength ) ).mul( smoothstep( 1800.0, 300.0, dist ) );
		col.assign( mix( col, vec3( 0.7, 0.75, 0.75 ).mul( U.skyAmb.mul( 1.2 ).add( U.sunColor.mul( 0.3 ).mul( sun ) ) ), foam.mul( 0.7 ) ) );
		return applyFog( col, P );

	} )();

	const mesh = new THREE.Mesh( geo, mat );
	mesh.frustumCulled = false;
	mesh.renderOrder = 25;
	return mesh;

}
