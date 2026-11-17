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
//
// Rock, snow and ice are shaded with photoscanned surfaces (Poly Haven, CC0)
// projected three ways at two scales (macro + detail) with their normal maps,
// so walls show real fracture and strata relief at every distance. Snow and
// glacier extent follow U.snow (the 'snow & ice' slider). Peaks cast real
// shadows: a heightmap of the landscape is ray-marched toward the sun, so at
// sunset the Cuernos and Paine Grande throw long shadows across each other.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, mix, smoothstep, clamp, max, pow, abs, dot, normalize, length, cameraPosition,
	attribute, varying, positionLocal, sin, fract, select, uniform, texture, min, exp
} from 'three/tsl';
import { vnoise } from '../../tsl/noise.js';
import { U, applyFog, windField, gustSheen } from '../../tsl/world.js';
import { landHeightJS, massifIdJS, lakeDistJS, mountainHeightJS, mountainHeight } from './terrain.js';
import { CUERNOS, PAINE_GRANDE, LAKE, polar } from './layout.js';
import { cloudShadowAt } from './index.js';
import { BIOME } from '../index.js';

const R0 = 40, R1 = 16000, NR = 520, NA = 1440;
const HM_SIZE = 512, HM_EXT = 9500; // shadow heightmap: texels, half extent (m)

const texURL = ( n ) => new URL( `../../assets/plains/${ n }.webp`, import.meta.url ).href;
function loadTex( n, srgb ) {

	const t = new THREE.TextureLoader().load( texURL( n ) );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.anisotropy = 8;
	if ( srgb ) t.colorSpace = THREE.SRGBColorSpace;
	return t;

}

export function buildBackdrop() {

	const t0 = performance.now();
	const nV = ( NR + 1 ) * NA;
	const pos = new Float32Array( nV * 3 );
	const info = new Float32Array( nV * 2 ); // massif id, lake distance
	const curv = new Float32Array( nV ); // convexity (ridges +, gullies -)
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

	// convexity from the grid neighbours (ridges +, gullies -), 2-ring stencil
	for ( let i = 2; i <= NR - 2; i ++ ) for ( let j = 0; j < NA; j ++ ) {

		const k = i * NA + j;
		const x = pos[ k * 3 ], z = pos[ k * 3 + 2 ];
		if ( Math.hypot( x, z ) < 900 ) continue;
		// isotropic Laplacian of the eroded heightmap (metres, ~2 cells)
		const e = 52, h0 = mountainHeightJS( x, z );
		const lap = ( mountainHeightJS( x + e, z ) + mountainHeightJS( x - e, z ) + mountainHeightJS( x, z + e ) + mountainHeightJS( x, z - e ) ) * 0.25 - h0;
		curv[ k ] = Math.max( - 1, Math.min( 1, - lap / 9 ) );

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
	geo.setAttribute( 'curv', new THREE.BufferAttribute( curv, 1 ) );
	geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );
	geo.computeVertexNormals();
	geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), R1 * 1.2 );
	console.log( `backdrop: ${ nV } vertices in ${ ( performance.now() - t0 ).toFixed( 0 ) } ms` );

	// shadow heightmap: resample the polar grid onto a square texture
	const hm = new Uint16Array( HM_SIZE * HM_SIZE );
	const lr = Math.log( R1 / R0 );
	for ( let j = 0; j < HM_SIZE; j ++ ) for ( let i = 0; i < HM_SIZE; i ++ ) {

		const x = ( ( i + 0.5 ) / HM_SIZE * 2 - 1 ) * HM_EXT, z = ( ( j + 0.5 ) / HM_SIZE * 2 - 1 ) * HM_EXT;
		const r = Math.hypot( x, z );
		let h;
		if ( r <= R0 ) h = landHeightJS( x, z );
		else {

			const a = ( Math.atan2( x, - z ) + Math.PI * 2 ) % ( Math.PI * 2 );
			const fi = Math.min( NR - 1e-3, Math.log( r / R0 ) / lr * NR ), fj = a / ( Math.PI * 2 ) * NA;
			const i0 = Math.floor( fi ), j0 = Math.floor( fj ) % NA, j1 = ( j0 + 1 ) % NA, ti = fi - i0, tj = fj - Math.floor( fj );
			const H = ( ii, jj ) => pos[ ( ii * NA + jj ) * 3 + 1 ];
			h = ( H( i0, j0 ) * ( 1 - tj ) + H( i0, j1 ) * tj ) * ( 1 - ti ) + ( H( i0 + 1, j0 ) * ( 1 - tj ) + H( i0 + 1, j1 ) * tj ) * ti;

		}

		hm[ j * HM_SIZE + i ] = THREE.DataUtils.toHalfFloat( h );

	}

	const hmTex = new THREE.DataTexture( hm, HM_SIZE, HM_SIZE, THREE.RedFormat, THREE.HalfFloatType );
	hmTex.magFilter = hmTex.minFilter = THREE.LinearFilter;
	hmTex.needsUpdate = true;

	const mesh = new THREE.Mesh( geo, backdropMaterial( hmTex ) );
	mesh.frustumCulled = false;
	mesh.renderOrder = 20; // after the near ground: hidden pixels fail early-z
	return mesh;

}

function backdropMaterial( hmTex ) {

	const mat = new THREE.MeshBasicNodeMaterial();
	mat.fog = false;
	const vW = varying( vec3( 0 ), 'vBW' );
	const vN = varying( vec3( 0, 1, 0 ), 'vBN' );
	const vI = varying( vec2( 0 ), 'vBI' );
	const vK = varying( float( 0 ), 'vBK' );
	const nearHalf = uniform( 600 );

	mat.positionNode = Fn( () => {

		const p = positionLocal.toVar();
		// sink under the camera-following ground mesh (a square of half-size 620 m)
		const d = max( abs( p.x.sub( cameraPosition.x ) ), abs( p.z.sub( cameraPosition.z ) ) );
		p.y.subAssign( smoothstep( nearHalf.add( 15.0 ), nearHalf.sub( 25.0 ), d ).mul( 2.5 ) );
		vW.assign( positionLocal );
		vN.assign( attribute( 'normal', 'vec3' ) );
		vI.assign( attribute( 'info', 'vec2' ) );
		vK.assign( attribute( 'curv', 'float' ) );
		return p;

	} )();

	const G = BIOME.ground;
	const c3 = ( a ) => vec3( ...a );
	const T = {
		rockC: loadTex( 'dark_rock_c', true ), rockN: loadTex( 'dark_rock_n' ),
		cliffC: loadTex( 'granite_face_c', true ), cliffN: loadTex( 'granite_face_n' ),
		snowC: loadTex( 'snow_02_c', true ), snowN: loadTex( 'snow_02_n' ),
	};

	// triplanar projection weights (sharpened)
	const triW = ( N ) => {

		const w = pow( abs( N ), vec3( 4.0 ) );
		return w.div( w.x.add( w.y ).add( w.z ) );

	};
	const tri = ( tex, P, w, sc ) => texture( tex, P.zy.mul( sc ) ).mul( w.x )
		.add( texture( tex, P.xz.mul( sc ) ).mul( w.y ) )
		.add( texture( tex, P.xy.mul( sc ) ).mul( w.z ) );
	// whiteout-blended triplanar normal map (GL convention), strength k
	const triN = ( tex, P, N, w, sc, k ) => {

		const tx = texture( tex, P.zy.mul( sc ) ).xyz.mul( 2.0 ).sub( 1.0 );
		const ty = texture( tex, P.xz.mul( sc ) ).xyz.mul( 2.0 ).sub( 1.0 );
		const tz = texture( tex, P.xy.mul( sc ) ).xyz.mul( 2.0 ).sub( 1.0 );
		const nx = vec3( tx.xy.mul( k ).add( N.zy ), abs( tx.z ).mul( N.x ) );
		const ny = vec3( ty.xy.mul( k ).add( N.xz ), abs( ty.z ).mul( N.y ) );
		const nz = vec3( tz.xy.mul( k ).add( N.xy ), abs( tz.z ).mul( N.z ) );
		return normalize( vec3( nx.z, nx.y, nx.x ).mul( w.x ).add( vec3( ny.x, ny.z, ny.y ).mul( w.y ) ).add( nz.mul( w.z ) ) );

	};
	const hmap = ( q ) => texture( hmTex, q.div( HM_EXT * 2 ).add( 0.5 ) ).r;

	mat.colorNode = Fn( () => {

		const P = vW;
		const xz = P.xz;
		// per-pixel normal from the eroded heightmap: crisp gullies at any mesh density
		const eh = 18.0;
		const hxp = mountainHeight( xz.add( vec2( eh, 0 ) ) ), hxm = mountainHeight( xz.sub( vec2( eh, 0 ) ) );
		const hzp = mountainHeight( xz.add( vec2( 0, eh ) ) ), hzm = mountainHeight( xz.sub( vec2( 0, eh ) ) );
		const nRel = normalize( vec3( hxm.sub( hxp ), eh * 2, hzm.sub( hzp ) ) );
		const onMtn = smoothstep( 8.0, 40.0, hxp.add( hxm ).mul( 0.5 ) );
		const Ng = normalize( mix( normalize( vN ), nRel, onMtn ) );
		const id = vI.x;
		const h = P.y;
		const slope = float( 1.0 ).sub( Ng.y ); // 0 flat .. 1 vertical
		const dist = length( P.sub( cameraPosition ) );
		const isMtn = id.greaterThan( 0.5 ).and( id.lessThan( 3.5 ) );
		const isPG = id.greaterThan( 0.5 ).and( id.lessThan( 1.5 ) );
		const isCu = id.greaterThan( 1.5 ).and( id.lessThan( 2.5 ) );

		// --- plains canopy (matches the near ground's far shading)
		const c1 = vnoise( xz.mul( 0.05 ).add( vec2( 13, 2 ) ) );
		const c2 = vnoise( xz.mul( 0.013 ).add( vec2( 3, 5 ) ) );
		const dry = smoothstep( 0.38, 0.8, vnoise( xz.div( 46 ).add( vec2( 101.0, 19.0 ) ) ).mul( 0.72 ).add( 0.14 ) ).mul( U.dry );
		const canopy = mix( mix( c3( G.lushA ), c3( G.lushB ), c2 ), c3( G.straw ), dry.mul( 0.8 ) ).mul( mix( 0.75, 1.08, c1 ) ).toVar();
		const scrub = smoothstep( 0.45, 0.75, vnoise( xz.div( 160.0 ).add( vec2( 7, 9 ) ) ) );
		canopy.assign( mix( canopy, vec3( 0.045, 0.06, 0.025 ), scrub.mul( 0.55 ) ) );
		const ghosts = smoothstep( 0.82, 0.9, vnoise( xz.div( 7.0 ) ) ).mul( smoothstep( 0.4, 0.7, vnoise( xz.div( 140.0 ).add( vec2( 13, 29 ) ) ) ) );
		canopy.assign( mix( canopy, vec3( 0.36, 0.36, 0.34 ), ghosts.mul( smoothstep( 4000.0, 900.0, dist ) ).mul( smoothstep( 260.0, 60.0, h ) ).mul( 0.22 ) ) );

		// --- scanned rock: macro (~170 m) + detail (~38 m) projections
		const rockK = smoothstep( 30.0, 140.0, h ).mul( select( id.greaterThan( 0.5 ), float( 1.0 ), float( 0.0 ) ) );
		const w = triW( Ng );
		const sM = 1.0 / 170.0, sD = 1.0 / 38.0;
		const dk = smoothstep( 9000.0, 2500.0, dist ); // detail fades with distance
		const rockMacro = tri( T.rockC, P, w, sM ), rockDet = tri( T.rockC, P, w, sD );
		const cliffMacro = tri( T.cliffC, P, w, sM * 1.3 ), cliffDet = tri( T.cliffC, P, w, sD * 1.2 );
		const lum = ( c ) => dot( c, vec3( 0.3, 0.55, 0.15 ) );
		// relief of the scans (alpha = height): cracks and ledges
		const rockH = mix( rockMacro.a, rockMacro.a.mul( 0.5 ).add( rockDet.a.mul( 0.5 ) ), dk );
		const cliffH = mix( cliffMacro.a, cliffMacro.a.mul( 0.5 ).add( cliffDet.a.mul( 0.5 ) ), dk );
		const rockL = mix( lum( rockMacro.rgb ), lum( rockMacro.rgb ).mul( 0.5 ).add( lum( rockDet.rgb ).mul( 0.5 ) ), dk ).div( 0.11 );
		const cliffL = mix( lum( cliffMacro.rgb ), lum( cliffMacro.rgb ).mul( 0.5 ).add( lum( cliffDet.rgb ).mul( 0.5 ) ), dk ).div( 0.5 );

		// --- rock palettes
		const strata = vnoise( xz.div( 380.0 ).add( vec2( h.div( 260.0 ), 0.0 ) ) ); // broad tonal variation (no bands)
		const rn = vnoise( xz.div( 25.0 ).add( vec2( 41, 3 ) ) ).mul( 0.6 ).add( vnoise( xz.div( 7.0 ).add( vec2( 2, 9 ) ) ).mul( 0.4 ) );
		// Paine Grande: near-black sedimentary rock, faintly banded, rust-stained
		const darkRock = mix( vec3( 0.032, 0.03, 0.028 ), vec3( 0.075, 0.066, 0.056 ), rn.mul( 0.5 ).add( strata.mul( 0.5 ) ) )
			.mul( rockL.clamp( 0.35, 2.2 ) ).mul( mix( 0.75, 1.15, rockH ) );
		// Cuernos granite: pale cream-grey, streaked by meltwater
		const granite = mix( vec3( 0.3, 0.295, 0.28 ), vec3( 0.48, 0.465, 0.44 ), rn.mul( 0.4 ).add( strata.mul( 0.15 ) ).add( 0.2 ) )
			.mul( cliffL.clamp( 0.45, 1.6 ) ).mul( mix( 0.72, 1.12, cliffH ) )
			.mul( mix( 0.75, 1.0, vnoise( vec2( xz.x.add( xz.y ).div( 6.0 ), h.div( 160.0 ) ) ) ) );
		const capLine = float( CUERNOS.capBase ).add( vnoise( xz.div( 260.0 ) ).sub( 0.5 ).mul( 240.0 ) ).add( sin( xz.x.div( 70.0 ) ).mul( 25.0 ) );
		const capCol = mix( vec3( 0.03, 0.028, 0.026 ), vec3( 0.07, 0.06, 0.05 ), rn ).mul( rockL.clamp( 0.4, 2.0 ) );
		// lower flanks: lenga / ñirre scrub and grassy benches, mottled (the scrub mosaic
		// seen from kilometres away), grey ghost-forest snags here and there
		const mott = vnoise( xz.div( 38.0 ).add( vec2( 3, 7 ) ) ).mul( 0.6 ).add( vnoise( xz.div( 11.0 ) ).mul( 0.4 ) );
		const forest = mix( mix( vec3( 0.035, 0.05, 0.02 ), vec3( 0.09, 0.11, 0.04 ), mott ), vec3( 0.16, 0.15, 0.09 ), smoothstep( 0.7, 0.85, vnoise( xz.div( 90.0 ).add( vec2( 1, 9 ) ) ) ).mul( 0.5 ) );
		// talus and scree fans at the foot of the walls: lighter, broken
		const scree = mix( vec3( 0.1, 0.095, 0.085 ), vec3( 0.2, 0.19, 0.17 ), rn ).mul( rockL.clamp( 0.6, 1.6 ) );
		const talus = smoothstep( 0.35, 0.18, slope ).mul( smoothstep( 150.0, 300.0, h ) ).mul( smoothstep( 900.0, 600.0, h ) );

		// Paine Grande: scrub climbs high on the lower flanks; rock breaks through on the
		// steep spurs and takes over above ~500 m
		const rockiness = max( smoothstep( 380.0, 650.0, h.add( vnoise( xz.div( 160.0 ) ).sub( 0.5 ).mul( 260.0 ) ) ), smoothstep( 0.4, 0.62, slope ).mul( smoothstep( 80.0, 220.0, h ) ) );
		const pg = mix( mix( mix( canopy, forest, smoothstep( 20.0, 120.0, h ).mul( 0.8 ) ), darkRock, rockiness ), scree, talus.mul( 0.45 ) );
		// Cuernos: scrub and talus base, then the pale granite walls wherever it is steep
		const cuBase = mix( mix( canopy, forest, smoothstep( 20.0, 120.0, h ).mul( 0.85 ) ), scree, talus.mul( 0.6 ).add( smoothstep( 0.3, 0.5, slope ).mul( 0.4 ) ) );
		const cuBody = mix( cuBase, granite, smoothstep( 300.0, 480.0, h ).mul( smoothstep( 0.3, 0.55, slope ).mul( 0.7 ).add( 0.3 ) ) );
		const cu = mix( cuBody, capCol, smoothstep( capLine.sub( 20.0 ), capLine.add( 20.0 ), h ) );
		const vh = mix( mix( forest, darkRock, 0.5 ), granite.mul( 1.08 ), smoothstep( 300.0, 700.0, h ) );
		const hl = mix( canopy, mix( forest, darkRock, 0.4 ), smoothstep( 120.0, 500.0, h ).mul( 0.7 ) );

		const albedo = canopy.toVar();
		albedo.assign( select( isPG, pg, albedo ) );
		albedo.assign( select( isCu, cu, albedo ) );
		albedo.assign( select( id.greaterThan( 2.5 ).and( id.lessThan( 3.5 ) ), vh, albedo ) );
		albedo.assign( select( id.greaterThan( 3.5 ), hl, albedo ) );
		albedo.assign( mix( canopy, albedo, smoothstep( 25.0, 110.0, h ) ) );

		// --- normal: geometry + scanned relief (granite on the Cuernos bodies, dark rock elsewhere)
		const useCliff = isCu.and( h.lessThan( capLine ) ).and( h.greaterThan( 300.0 ) );
		const nRock = triN( T.rockN, P, Ng, w, sM, float( 1.2 ) );
		const nRockD = triN( T.rockN, P, Ng, w, sD, float( 0.9 ) );
		const nCliff = triN( T.cliffN, P, Ng, w, sM * 1.3, float( 1.3 ) );
		const nCliffD = triN( T.cliffN, P, Ng, w, sD * 1.2, float( 0.9 ) );
		const nR = normalize( mix( select( useCliff, nCliff, nRock ), select( useCliff, nCliffD, nRockD ), dk.mul( 0.5 ) ) );
		const N = normalize( mix( Ng, nR, rockK.mul( smoothstep( 22000.0, 4000.0, dist ) ) ) ).toVar();

		// snow collects in the eroded gullies (concave relief from the mesh)
		const groove = smoothstep( - 0.05, - 0.45, vK );

		// --- snow and ice, controlled by U.snow (0 = bare rock .. 1 = deep winter)
		const sAmt = U.snow;
		const snowLine = mix( float( 2100.0 ), float( 380.0 ), sAmt ).add( vnoise( xz.div( 260.0 ) ).sub( 0.5 ).mul( 360.0 ) ).add( vnoise( xz.div( 70.0 ).add( vec2( 9, 2 ) ) ).sub( 0.5 ).mul( 160.0 ) );
		// the westerlies strip the windward faces and load the lee slopes
		const lee = dot( Ng.xz, vec2( Math.cos( 0.1 ), Math.sin( 0.1 ) ) ).mul( 0.5 ).add( 0.5 );
		const holdSlope = mix( float( 0.18 ), float( 0.72 ), sAmt ); // how steep snow still sticks
		const flatEnough = smoothstep( holdSlope, holdSlope.sub( 0.2 ), slope );
		const snowN = vnoise( xz.div( 34.0 ).add( vec2( 5, 5 ) ) ).mul( 0.45 ).add( vnoise( xz.div( 130.0 ) ).mul( 0.55 ) );
		// snow settles on ledges and in hollows first: the scan relief breaks its edges
		const relH = select( useCliff, cliffH, rockH );
		const snowField = snowN.mul( 0.45 ).add( flatEnough.mul( 0.6 ) ).add( float( 0.5 ).sub( relH ).mul( 0.35 ) ).add( lee.sub( 0.5 ).mul( 0.3 ) );
		const snow = smoothstep( snowLine.sub( 120.0 ), snowLine.add( 220.0 ), h ).mul( smoothstep( 0.46, 0.54, snowField ) ).mul( smoothstep( 0.0, 0.06, sAmt ) ).toVar();
		const gl = polar( PAINE_GRANDE.glacier.az, PAINE_GRANDE.glacier.d );
		const gd = length( xz.sub( vec2( gl[ 0 ], gl[ 1 ] ) ) ).div( float( PAINE_GRANDE.glacier.size ).mul( mix( 0.25, 1.35, sAmt ) ) );
		const glacier = smoothstep( 1.0, 0.55, gd.add( vnoise( xz.div( 70.0 ) ).sub( 0.5 ).mul( 0.6 ) ) ).mul( smoothstep( mix( 900.0, 380.0, sAmt ), mix( 1100.0, 600.0, sAmt ), h ) )
			.mul( select( isPG, float( 1 ), float( 0 ) ) ).mul( smoothstep( 0.0, 0.1, sAmt ) );
		// glacier ice: blue, banded by ogives, split by crevasses running across the flow
		const flow = vec2( gl[ 0 ], gl[ 1 ] ).sub( xz );
		const across = dot( xz, normalize( vec2( flow.y, flow.x.negate() ).add( vec2( 1e-3, 0 ) ) ) );
		const along = dot( xz, normalize( flow.add( vec2( 1e-3, 0 ) ) ) );
		const crev = smoothstep( 0.85, 0.97, abs( sin( along.div( 9.0 ).add( vnoise( xz.div( 40.0 ) ).mul( 5.0 ) ) ) ) )
			.mul( smoothstep( 0.3, 0.7, vnoise( xz.div( 55.0 ).add( vec2( 3, 1 ) ) ) ) );
		const ogive = sin( along.div( 60.0 ).add( across.div( 400.0 ).mul( across.div( 400.0 ) ) ) ).mul( 0.5 ).add( 0.5 );
		const iceCol = mix( vec3( 0.42, 0.6, 0.72 ), vec3( 0.78, 0.84, 0.88 ), ogive.mul( 0.6 ).add( vnoise( xz.div( 9.0 ) ).mul( 0.4 ) ) )
			.mul( float( 1.0 ).sub( crev.mul( 0.65 ) ) );
		const snowTex = tri( T.snowC, P, w, 1.0 / 30.0 );
		// wind-packed snow: bright, faintly blue in its own shade, sastrugi ripples from the scan
		const snowCol = vec3( 0.9, 0.91, 0.94 ).mul( mix( 1.0, lum( snowTex.rgb ).div( 0.65 ).clamp( 0.88, 1.06 ), dk ) );
		// the Cuernos' dark caps are too steep to hold snow; their granite holds only a little
		snow.assign( select( isCu, snow.mul( 0.5 ).mul( smoothstep( capLine.add( 30.0 ), capLine.sub( 40.0 ), h ) ), snow ) );
		// snow lies in the couloirs and gully floors well below the general snow line
		const coul = groove.mul( smoothstep( snowLine.sub( 520.0 ), snowLine.sub( 120.0 ), h ) ).mul( smoothstep( 0.25, 0.45, slope ) )
			.mul( smoothstep( 0.0, 0.1, sAmt ) ).mul( select( isCu.and( h.greaterThan( capLine ) ), float( 0.3 ), float( 1.0 ) ) );
		snow.assign( max( snow, coul.mul( 0.9 ) ) );
		const snowAmt = select( isMtn, max( snow, glacier ), float( 0 ) );
		albedo.assign( mix( albedo, mix( snowCol, iceCol, glacier ), snowAmt ) );
		// snow surfaces: smoother normal (wind-packed), with the snow scan's ripples
		const nSnow = triN( T.snowN, P, Ng, w, 1.0 / 30.0, float( 0.6 ) );
		N.assign( normalize( mix( N, mix( Ng, nSnow, dk ), snowAmt.mul( 0.8 ) ) ) );

		// --- relief: gullies hold shadow and moisture, ridges and aretes catch light
		const relief = clamp( vK, - 1.0, 1.0 );
		const reliefAO = mix( 0.55, 1.15, smoothstep( - 0.8, 0.6, relief ) ).mul( mix( 0.7, 1.05, relH.mul( rockK ).add( float( 1.0 ).sub( rockK ).mul( 0.6 ) ) ) );
		albedo.mulAssign( select( id.greaterThan( 0.5 ), reliefAO, float( 1.0 ) ) );

		// --- cast shadows: march the heightmap toward the light
		const L = U.sunDir;
		const shadowK = smoothstep( nearHalf.add( 60.0 ), nearHalf.add( 500.0 ), length( xz.sub( cameraPosition.xz ) ) );
		const sh = float( 1.0 ).toVar();
		let t = 28.0;
		for ( let i = 0; i < 22; i ++ ) {

			const q = P.add( L.mul( t ) );
			const dh = q.y.sub( hmap( q.xz ) );
			sh.assign( min( sh, smoothstep( - 6.0, t * 0.035 + 10.0, dh ) ) );
			t *= 1.28;

		}

		const cast = mix( float( 1.0 ), sh, shadowK.mul( smoothstep( - 0.02, 0.03, L.y ) ) );

		// --- lighting
		const NdL = dot( N, L );
		const wrap = 0.1;
		const diff = clamp( NdL.add( wrap ).div( 1.0 + wrap ), 0.0, 1.0 );
		// distant cloud shadows: softer and less deep (scattered light fills them in)
		const sunVis = mix( cloudShadowAt( xz, h ), float( 0.7 ), smoothstep( 1500.0, 6000.0, dist ).mul( 0.6 ) ).max( 0.3 ).mul( smoothstep( - 0.04, 0.06, L.y ) ).mul( cast );
		const amb = mix( U.groundAmb, U.skyAmb, N.y.mul( 0.5 ).add( 0.5 ) ).mul( mix( 0.75, 1.0, smoothstep( 0.0, 0.5, N.y ) ) );
		const V = normalize( cameraPosition.sub( P ) );
		const Hh = normalize( L.add( V ) );
		// snow glitters a little; wet dark rock has a faint sheen; glacier ice is glossy
		const spec = pow( clamp( dot( N, Hh ), 0.0, 1.0 ), mix( 18.0, 60.0, glacier ) ).mul( snowAmt.mul( 0.22 ).add( glacier.mul( 0.25 ) ).add( rockK.mul( 0.03 ) ) );
		const sheen = mix( float( 1.0 ), gustSheen( windField( xz ) ), smoothstep( 40.0, 10.0, h ).mul( 0.6 ) );
		const col = albedo.mul( sheen ).mul( U.sunColor.mul( diff ).mul( sunVis ).add( amb ) ).add( U.sunColor.mul( spec ).mul( sunVis ) ).toVar();
		// snow in shade glows faintly blue (skylight scattered through the snowpack)
		col.addAssign( U.skyAmb.mul( vec3( 0.55, 0.8, 1.35 ) ).mul( snowAmt.mul( float( 1.0 ).sub( diff.mul( sunVis ) ) ).mul( 0.3 ) ) );
		// aerial perspective: distant rock goes cool blue-grey before the fog proper
		const air = float( 1.0 ).sub( exp( dist.div( - 22000.0 ) ) ).mul( 0.14 );
		const airCol = mix( U.horizon, U.skyAmb.mul( 2.5 ), 0.5 );
		return applyFog( mix( col, airCol, air ), P );

	} )();

	return mat;

}
