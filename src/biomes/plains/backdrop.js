// The far landscape: one static, world-anchored polar mesh from just outside the
// walkable plains out to the horizon (16 km). Heights come from the CPU
// landscape function (plains + lake basin + mountain massifs), so near the
// plains it matches the camera-following ground mesh exactly; where that mesh
// exists, the backdrop sinks a little underneath it (no z-fighting).
//
// Materials (in one shader, per massif):
//   Paine Grande  dark rock with strata, snow ledges, the hanging Glaciar Francés
//   Cuernos       light granite bodies under a dark sedimentary cap
//   valley head   pale granite and snow, far away in the haze
//   plains/hills  the same golden/green canopy as the near ground

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, mix, smoothstep, clamp, max, pow, abs, dot, normalize, length, cameraPosition,
	attribute, varying, positionLocal, sin, fract, select, uniform
} from 'three/tsl';
import { vnoise } from '../../tsl/noise.js';
import { U, applyFog, windField, gustSheen } from '../../tsl/world.js';
import { landHeightJS, massifIdJS, lakeDistJS } from './terrain.js';
import { CUERNOS, PAINE_GRANDE, LAKE, polar } from './layout.js';
import { cloudShadowAt } from './index.js';
import { BIOME } from '../index.js';

const R0 = 470, R1 = 16000, NR = 300, NA = 1024;

export function buildBackdrop() {

	const t0 = performance.now();
	const nV = ( NR + 1 ) * NA;
	const pos = new Float32Array( nV * 3 );
	const info = new Float32Array( nV * 2 ); // massif id, lake distance
	for ( let i = 0; i <= NR; i ++ ) {

		const r = R0 * Math.pow( R1 / R0, i / NR );
		for ( let j = 0; j < NA; j ++ ) {

			const a = j / NA * Math.PI * 2;
			const x = Math.sin( a ) * r, z = - Math.cos( a ) * r;
			const k = i * NA + j;
			pos[ k * 3 ] = x; pos[ k * 3 + 1 ] = landHeightJS( x, z ); pos[ k * 3 + 2 ] = z;
			info[ k * 2 ] = r > 900 ? massifIdJS( x, z ) : 0;
			info[ k * 2 + 1 ] = lakeDistJS( x, z );

		}

	}

	const idx = new Uint32Array( NR * NA * 6 );
	let p = 0;
	for ( let i = 0; i < NR; i ++ ) for ( let j = 0; j < NA; j ++ ) {

		const a = i * NA + j, b = i * NA + ( j + 1 ) % NA, c = a + NA, d = b + NA;
		idx[ p ++ ] = a; idx[ p ++ ] = b; idx[ p ++ ] = c;
		idx[ p ++ ] = b; idx[ p ++ ] = d; idx[ p ++ ] = c;

	}

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
	geo.setAttribute( 'info', new THREE.BufferAttribute( info, 2 ) );
	geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );
	geo.computeVertexNormals();
	geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), R1 * 1.2 );
	console.log( `backdrop: ${ nV } vertices in ${ ( performance.now() - t0 ).toFixed( 0 ) } ms` );

	const mesh = new THREE.Mesh( geo, backdropMaterial() );
	mesh.frustumCulled = false;
	mesh.renderOrder = 20; // after the near ground: hidden pixels fail early-z
	return mesh;

}

function backdropMaterial() {

	const mat = new THREE.MeshBasicNodeMaterial();
	mat.fog = false;
	const vW = varying( vec3( 0 ), 'vBW' );
	const vN = varying( vec3( 0, 1, 0 ), 'vBN' );
	const vI = varying( vec2( 0 ), 'vBI' );
	const nearHalf = uniform( 600 );

	mat.positionNode = Fn( () => {

		const p = positionLocal.toVar();
		// sink under the camera-following ground mesh (a square of half-size 620 m)
		const d = max( abs( p.x.sub( cameraPosition.x ) ), abs( p.z.sub( cameraPosition.z ) ) );
		p.y.subAssign( smoothstep( nearHalf.add( 15.0 ), nearHalf.sub( 25.0 ), d ).mul( 2.5 ) );
		vW.assign( positionLocal );
		vN.assign( attribute( 'normal', 'vec3' ) );
		vI.assign( attribute( 'info', 'vec2' ) );
		return p;

	} )();

	const G = BIOME.ground;
	const c3 = ( a ) => vec3( ...a );

	mat.colorNode = Fn( () => {

		const P = vW;
		const xz = P.xz;
		const Ng = normalize( vN );
		const id = vI.x;
		const h = P.y;
		const slope = float( 1.0 ).sub( Ng.y ); // 0 flat .. 1 vertical
		const dist = length( P.sub( cameraPosition ) );

		// --- detail normal: rock facets and gullies (fades with distance)
		const e = 3.0;
		const nf = ( q ) => vnoise( q.div( 38.0 ) ).mul( 0.6 ).add( vnoise( q.div( 11.0 ).add( vec2( 3, 7 ) ) ).mul( 0.4 ) );
		const n0 = nf( xz ), nx = nf( xz.add( vec2( e, 0 ) ) ), nz = nf( xz.add( vec2( 0, e ) ) );
		const bumpK = smoothstep( 9000.0, 1500.0, dist ).mul( 14.0 ).mul( smoothstep( 0.05, 0.4, slope ) );
		const N = normalize( Ng.add( vec3( n0.sub( nx ), 0, n0.sub( nz ) ).mul( bumpK ) ) );

		// --- plains canopy (matches the near ground's far shading)
		const c1 = vnoise( xz.mul( 0.05 ).add( vec2( 13, 2 ) ) );
		const c2 = vnoise( xz.mul( 0.013 ).add( vec2( 3, 5 ) ) );
		const dry = smoothstep( 0.32, 0.78, vnoise( xz.div( 46 ).add( vec2( 101.0, 19.0 ) ) ).mul( 0.72 ).add( 0.14 ) ).mul( U.dry );
		const canopy = mix( mix( c3( G.lushA ), c3( G.lushB ), c2 ), c3( G.straw ), dry.mul( 0.8 ) ).mul( mix( 0.75, 1.08, c1 ) ).toVar();
		// scrub and lenga thickets darken the lower slopes, ghost-forest flecks
		const scrub = smoothstep( 0.45, 0.75, vnoise( xz.div( 160.0 ).add( vec2( 7, 9 ) ) ) );
		canopy.assign( mix( canopy, vec3( 0.045, 0.06, 0.025 ), scrub.mul( 0.55 ) ) );
		const ghosts = smoothstep( 0.82, 0.9, vnoise( xz.div( 7.0 ) ) ).mul( smoothstep( 0.4, 0.7, vnoise( xz.div( 140.0 ).add( vec2( 13, 29 ) ) ) ) );
		canopy.assign( mix( canopy, vec3( 0.42, 0.42, 0.4 ), ghosts.mul( smoothstep( 6000.0, 900.0, dist ) ).mul( 0.5 ) ) );

		// --- rock palettes
		const strata = sin( h.mul( 0.11 ).add( vnoise( xz.div( 90.0 ) ).mul( 6.0 ) ) ).mul( 0.5 ).add( 0.5 );
		const rn = vnoise( xz.div( 25.0 ).add( vec2( 41, 3 ) ) );
		const darkRock = mix( vec3( 0.028, 0.027, 0.026 ), vec3( 0.075, 0.068, 0.06 ), rn.mul( 0.6 ).add( strata.mul( 0.4 ) ) );
		const granite = mix( vec3( 0.25, 0.245, 0.235 ), vec3( 0.42, 0.41, 0.39 ), rn.mul( 0.5 ).add( strata.mul( 0.2 ) ).add( 0.15 ) )
			// vertical water streaks on the walls
			.mul( mix( 0.78, 1.0, vnoise( vec2( xz.x.add( xz.y ).div( 6.0 ), h.div( 160.0 ) ) ) ) );
		const capLine = float( CUERNOS.capBase ).add( vnoise( xz.div( 260.0 ) ).sub( 0.5 ).mul( 240.0 ) ).add( sin( xz.x.div( 70.0 ) ).mul( 25.0 ) );
		const capCol = mix( vec3( 0.03, 0.028, 0.026 ), vec3( 0.07, 0.06, 0.05 ), rn );
		const forest = mix( vec3( 0.03, 0.045, 0.02 ), vec3( 0.07, 0.08, 0.035 ), c1 );

		// Paine Grande
		const pgLow = smoothstep( 120.0, 380.0, h );
		const pg = mix( mix( canopy, forest, 0.6 ), darkRock, pgLow.mul( smoothstep( 0.12, 0.3, slope ).mul( 0.6 ).add( 0.4 ) ) );
		// Cuernos: forested/dark base, granite body, dark cap
		const cuBody = mix( mix( forest, darkRock, 0.5 ), granite, smoothstep( 280.0, 520.0, h ) );
		const cu = mix( cuBody, capCol, smoothstep( capLine.sub( 20.0 ), capLine.add( 20.0 ), h ) );
		// valley head: pale granite
		const vh = mix( mix( forest, darkRock, 0.5 ), granite.mul( 1.08 ), smoothstep( 300.0, 700.0, h ) );
		// far hills: drier, scrubby
		const hl = mix( canopy, mix( forest, darkRock, 0.4 ), smoothstep( 120.0, 500.0, h ).mul( 0.7 ) );

		const albedo = canopy.toVar();
		albedo.assign( select( id.greaterThan( 0.5 ).and( id.lessThan( 1.5 ) ), pg, albedo ) );
		albedo.assign( select( id.greaterThan( 1.5 ).and( id.lessThan( 2.5 ) ), cu, albedo ) );
		albedo.assign( select( id.greaterThan( 2.5 ).and( id.lessThan( 3.5 ) ), vh, albedo ) );
		albedo.assign( select( id.greaterThan( 3.5 ), hl, albedo ) );
		// mountains' foothills blend into the plains below ~60 m
		albedo.assign( mix( canopy, albedo, smoothstep( 25.0, 110.0, h ) ) );

		// --- snow: ledges and gentle slopes high up; glacier below the summit
		// snow only on ledges and gentle slopes high up (the walls stay dark)
		const snowLine = float( 1020.0 ).add( vnoise( xz.div( 240.0 ) ).sub( 0.5 ).mul( 320.0 ) );
		const flatEnough = smoothstep( 0.5, 0.28, slope );
		const snowN = vnoise( xz.div( 34.0 ).add( vec2( 5, 5 ) ) ).mul( 0.45 ).add( vnoise( xz.div( 130.0 ) ).mul( 0.55 ) );
		const snow = smoothstep( snowLine, snowLine.add( 90.0 ), h ).mul( smoothstep( 0.45, 0.55, snowN.mul( 0.6 ).add( flatEnough.mul( 0.55 ) ) ) );
		const gl = polar( PAINE_GRANDE.glacier.az, PAINE_GRANDE.glacier.d );
		const gd = length( xz.sub( vec2( gl[ 0 ], gl[ 1 ] ) ) ).div( PAINE_GRANDE.glacier.size );
		const glacier = smoothstep( 1.0, 0.55, gd.add( vnoise( xz.div( 70.0 ) ).sub( 0.5 ).mul( 0.6 ) ) ).mul( smoothstep( 520.0, 760.0, h ) )
			.mul( select( id.greaterThan( 0.5 ).and( id.lessThan( 1.5 ) ), float( 1 ), float( 0 ) ) );
		const iceCol = mix( vec3( 0.55, 0.68, 0.78 ), vec3( 0.8, 0.84, 0.88 ), vnoise( xz.div( 9.0 ) ) )
			.mul( mix( 0.7, 1.0, smoothstep( 0.2, 0.6, abs( sin( xz.x.add( xz.y.mul( 0.4 ) ).div( 11.0 ) ) ) ) ) ); // crevasses
		const snowCol = vec3( 0.86, 0.87, 0.9 );
		const isMtn = id.greaterThan( 0.5 ).and( id.lessThan( 3.5 ) );
		const snowAmt = select( isMtn, max( snow, glacier ), float( 0 ) );
		albedo.assign( mix( albedo, mix( snowCol, iceCol, glacier ), snowAmt ) );

		// --- lighting
		const L = U.sunDir;
		const NdL = dot( N, L );
		const wrap = 0.12;
		const diff = clamp( NdL.add( wrap ).div( 1.0 + wrap ), 0.0, 1.0 );
		const sunVis = cloudShadowAt( xz, h ).mul( smoothstep( - 0.04, 0.06, L.y ) );
		const amb = mix( U.groundAmb, U.skyAmb, N.y.mul( 0.5 ).add( 0.5 ) ).mul( mix( 0.75, 1.0, smoothstep( 0.0, 0.5, N.y ) ) );
		const V = normalize( cameraPosition.sub( P ) );
		const H = normalize( L.add( V ) );
		const spec = pow( clamp( dot( N, H ), 0.0, 1.0 ), 30.0 ).mul( snowAmt.mul( 0.25 ).add( 0.02 ) );
		// wind sheen on the far plains canopy
		const sheen = mix( float( 1.0 ), gustSheen( windField( xz ) ), smoothstep( 40.0, 10.0, h ).mul( 0.6 ) );
		const col = albedo.mul( sheen ).mul( U.sunColor.mul( diff ).mul( sunVis ).add( amb ) ).add( U.sunColor.mul( spec ).mul( sunVis ) );
		return applyFog( col, P );

	} )();

	return mat;

}
