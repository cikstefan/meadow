// Patagonian scrub, grown rather than modelled:
//
//   notro (Embothrium coccineum): small, wind-flagged trees, 1.5-3.5 m, leaning
//     downwind with their crowns combed out to leeward, in scarlet bloom
//   calafate (Berberis microphylla): fans of arching spiny stems, tiny leaves,
//     yellow-orange cups
//   mata negra (Mulguraea tridens): dense, dark, wiry
//   mata barrosa (Mulinum spinosum): tight grey-green spiny cushions
//
// Each species has a few variants grown with grow.js (stems that sweep in
// S-curves, bend toward the prevailing westerlies and fork with collars),
// dressed with sprig cards from the scanned-leaf atlas at the twig tips. Wood
// and foliage share one instanced draw per species / variant / LOD; the LODs
// thin the cards (growing the survivors to keep the coverage) and drop the
// finer wood. Instances are scattered once on the CPU and re-bucketed as you
// walk; their yaw keeps every tree's lean pointing downwind of the prevailing
// wind, with some scatter.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, pow, sin, cos, dot, normalize, length, attribute, varying,
	cameraPosition, faceDirection, texture, uv, select, exp
} from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U, shadeFoliage } from '../../tsl/world.js';
import { landHeightJS, shrubDensityJS, trailDistJS, lakeDistJS, gravelPatchJS } from './terrain.js';
import { cloudShadowGround } from './index.js';
import { buildFoliageAtlas, TILE } from './atlas.js';
import { rng } from './grow.js';
import { SPECIES, plantLODs } from './plants.js';
import { PREVAILING_WIND } from './layout.js';

const BARK = ( () => {

	const t = new THREE.TextureLoader().load( new URL( '../../assets/plains/bark_willow_02_c.webp', import.meta.url ).href );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	return t;

} )();

const range = ( r, a, b ) => a + ( b - a ) * r();
const LOD_DIST = [ 15, 55, 260 ]; // m: hero (3D leaves + flowers) / detailed / mid / far
const RADIUS = 1050; // scatter radius around the origin

// scatter every species once (deterministic). Per instance: x, y, z, height, yaw, bloom, seed, width jitter
function scatter( density = 1 ) {

	const out = SPECIES.map( () => [] );
	const cell = 4.2;
	const n = Math.ceil( RADIUS / cell );
	const r = rng( 1234567 );
	const wind = THREE.MathUtils.degToRad( PREVAILING_WIND );
	for ( let gx = - n; gx <= n; gx ++ ) for ( let gz = - n; gz <= n; gz ++ ) {

		const x = ( gx + r() ) * cell, z = ( gz + r() ) * cell;
		const d0 = Math.hypot( x, z );
		if ( d0 > RADIUS ) continue;
		const dens = shrubDensityJS( x, z );
		const pick = r(), roll = r();
		// bushes crowd the path in places, keep back from it elsewhere
		if ( trailDistJS( x, z ) < 0.95 + 1.6 * vnoiseJS( x / 25 + 4, z / 25 ) || lakeDistJS( x, z ) < 10 ) continue;
		const gravel = gravelPatchJS( x, z );
		const m = vnoiseJS( x / 120 + 3, z / 120 + 8 );
		const w = [
			dens * ( 0.35 + 0.65 * m ) * 0.18, // tree-form notro (rarer than the notro mounds)
			( 0.12 + dens * 0.3 ) * ( 1.1 - m * 0.5 ), // calafate everywhere, sparser
			( 0.1 + dens * 0.35 ) * 0.8, // mata negra
			( 0.06 + gravel * 0.5 ) * 0.9, // mata barrosa on dry gravel
		];
		const total = w.reduce( ( a, b ) => a + b, 0 );
		const close = Math.max( 0, 1 - d0 / 260 ) * 0.35 + Math.max( 0, 1 - trailDistJS( x, z ) / 14 ) * 0.4;
		// (the mound scrub carries the cover now: these grown bushes / small trees are accents)
		if ( roll > total * ( 0.32 + close ) * density * 0.4 ) continue;
		let k = 0, acc = w[ 0 ] / total;
		while ( pick > acc && k < 3 ) {

			k ++; acc += w[ k ] / total;

		}

		const sp = SPECIES[ k ];
		const hh = sp.h[ 0 ] + ( sp.h[ 1 ] - sp.h[ 0 ] ) * Math.pow( r(), 0.8 ) * ( 0.7 + dens * 0.5 );
		const y = landHeightJS( x, z );
		const bloom = sp.bloom > 0 ? Math.min( 1, sp.bloom * ( 0.35 + r() * 1.1 ) ) : 0;
		// lean downwind (local +X -> wind direction), +-30 degrees
		const yaw = wind + ( r() - 0.5 ) * 1.05;
		out[ k ].push( x, y - hh * 0.02, z, hh, yaw, bloom, r(), 0.85 + r() * 0.3 );

	}

	return out.map( ( a ) => new Float32Array( a ) );

}

const variantOf = ( seed, V ) => Math.min( V - 1, Math.floor( ( ( seed * 13.71 ) % 1 ) * V ) );

export class Shrubs {

	static async create() {

		const atlas = await buildFoliageAtlas();
		return new Shrubs( atlas );

	}

	constructor( atlas ) {

		const t0 = performance.now();
		this.atlas = atlas;
		this.data = scatter();
		this.density = 1;
		this.group = new THREE.Group();
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		let tris = 0;
		this.meshes = SPECIES.map( ( sp, si ) => {

			const mat = this.material( sp );
			const d = this.data[ si ];
			const per = new Array( sp.variants ).fill( 0 );
			for ( let i = 0; i < d.length; i += 8 ) per[ variantOf( d[ i + 6 ], sp.variants ) ] ++;
			return per.map( ( cnt, v ) => {

				const geos = plantLODs( sp, 1000 + si * 97 + v * 13 );
				tris += geos[ 0 ].index.count / 3;
				return geos.map( ( geo ) => {

					const cap = Math.ceil( cnt * 2.4 ) + 16;
					const a = new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 );
					const b = new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 );
					a.setUsage( THREE.DynamicDrawUsage ); b.setUsage( THREE.DynamicDrawUsage );
					geo.setAttribute( 'iA', a ); geo.setAttribute( 'iB', b );
					geo.instanceCount = 0;
					const mesh = new THREE.Mesh( geo, mat );
					mesh.frustumCulled = false;
					mesh.renderOrder = 8;
					this.group.add( mesh );
					return mesh;

				} );

			} );

		} );
		const counts = this.data.map( ( d, i ) => `${ SPECIES[ i ].name } ${ d.length / 8 }` ).join( ', ' );
		console.log( `shrubs: ${ counts }; near tris/variant avg ${ ( tris / 12 ) | 0 } (${ ( performance.now() - t0 ).toFixed( 0 ) } ms)` );

	}

	material( sp ) {

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;
		mat.alphaToCoverage = true;
		mat.alphaTest = 0.35;
		const vW = varying( vec3( 0 ), 'vSW' );
		const vN = varying( vec3( 0 ), 'vSN' );
		const vC = varying( vec4( 0 ), 'vSC' ); // tile (-1.. wood), ao, height, cloud
		const vT = varying( vec4( 1 ), 'vST' ); // instance tint, seed
		const tex = this.atlas.texture;
		const cols = this.atlas.cols, rows = this.atlas.rows;

		mat.positionNode = Fn( () => {

			const A = attribute( 'iA', 'vec4' ); // x, y, z, height
			const B = attribute( 'iB', 'vec4' ); // yaw, bloom, seed, width jitter
			const C = attribute( 'card', 'vec4' ); // kind, seed, ao, height frac
			const p = attribute( 'position', 'vec3' );
			const n0 = attribute( 'cnorm', 'vec3' );
			const h = A.w;
			const cy = cos( B.x ), sy = sin( B.x );
			const rot = ( v ) => vec3( v.x.mul( cy ).sub( v.z.mul( sy ) ), v.y, v.x.mul( sy ).add( v.z.mul( cy ) ) );
			const local = rot( vec3( p.x.mul( B.w ), p.y, p.z.mul( B.w ) ) ).mul( h );
			const base = A.xyz;
			const isWood = C.x.lessThan( 0.0 );

			// wind: the whole plant bends from the base with the travelling gusts,
			// outer sprigs flutter (cards only)
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const gust = vnoise( base.xz.sub( U.windOffset ).div( 13.0 ) ).mul( 0.7 ).add( 0.3 );
			const wAmt = U.windStrength.mul( gust );
			const hk = pow( clamp( p.y, 0.0, 1.0 ), 1.7 );
			const sway = sin( U.time.mul( mix( 1.1, 1.9, B.z ) ).add( B.z.mul( 30.0 ) ).add( dot( base.xz, U.windDir ).mul( 0.2 ) ) ).mul( 0.35 ).add( 0.65 );
			const flutter = sin( U.time.mul( mix( 6.0, 12.0, C.y ) ).add( C.y.mul( 60.0 ) ) ).mul( select( isWood, float( 0.0 ), float( 0.6 ) ) );
			const stiff = h.mul( 0.3 ).add( 0.7 ).reciprocal(); // tall trees bend relatively less
			const disp = W.mul( wAmt.mul( sway ).mul( hk ).mul( h ).mul( 0.075 ).mul( stiff ) )
				.add( rot( normalize( n0 ) ).mul( flutter.mul( wAmt ).mul( 0.025 ).mul( h.min( 1.5 ) ) ) )
				.add( vec3( 0, - 1, 0 ).mul( wAmt.mul( hk ).mul( h ).mul( 0.015 ) ) );
			// 3D flower tubes (hero LOD) only on bushes in bloom: others collapse them away
			const isTube = C.x.greaterThanEqual( 199.5 );
			const world = select( isTube.and( C.y.greaterThan( B.y ) ), base, base.add( local ).add( disp ) );

			vN.assign( normalize( rot( n0 ) ) );
			vW.assign( world );
			// flower cards: bloom per bush decides flower or leaf tile
			const isFl = C.x.greaterThanEqual( 100.0 ).and( C.x.lessThan( 199.5 ) );
			const fk = C.x.sub( 100.0 );
			const flTile = fk.div( 16.0 ).floor();
			const lfTile = fk.sub( flTile.mul( 16.0 ) );
			const tile = select( isFl, select( C.y.lessThan( B.y ), flTile, lfTile ), C.x );
			vC.assign( vec4( tile, C.z, C.w, cloudShadowGround( base.xz ) ) );
			vT.assign( vec4( mix( vec3( 0.84, 0.88, 0.8 ), vec3( 1.1, 1.06, 1.0 ), B.z ), C.y ) );
			return world;

		} )();

		const isWood = vC.x.lessThan( 0.0 );
		const tileUV = Fn( () => {

			const t = max( vC.x, 0.0 );
			const col = t.mod( cols ), row = t.div( cols ).floor();
			return vec2( col.add( uv().x.clamp( 0.004, 0.996 ) ), row.add( uv().y.clamp( 0.004, 0.996 ) ) ).div( vec2( cols, rows ) );

		} );
		const sample = texture( tex, tileUV() );
		const isTubeF = vC.x.greaterThanEqual( 199.5 );
		const dist = length( vW.sub( cameraPosition ) );
		// keep coverage at small mip levels (averaged alpha would fall below the cutoff)
		mat.opacityNode = select( isWood.or( isTubeF ), float( 1.0 ), sample.a.mul( float( 1.0 ).add( smoothstep( 6.0, 160.0, dist ).mul( 2.0 ) ) ) );

		const isNotroFl = vC.x.equal( float( TILE.notroFl ) ).or( vC.x.equal( float( TILE.notroFl2 ) ) );
		mat.colorNode = Fn( () => {

			// bark: notro smooth grey-brown, calafate yellow-brown, mata dark
			const barkK = vC.x.negate().sub( 1.0 );
			// scanned bark (relief in alpha darkens the fissures), tinted per species
			const bk = texture( BARK, uv().mul( vec2( 1.0, 2.6 ) ).add( vec2( vT.w.mul( 3.0 ), 0.0 ) ) );
			const bl = bk.rgb.dot( vec3( 0.3, 0.55, 0.15 ) ).div( 0.47 );
			const barkTint = select( barkK.lessThan( 0.5 ), vec3( 0.105, 0.09, 0.08 ), select( barkK.lessThan( 1.5 ), vec3( 0.15, 0.105, 0.065 ), vec3( 0.075, 0.065, 0.05 ) ) );
			const barkCol = barkTint.mul( bl.clamp( 0.4, 1.6 ) ).mul( mix( 0.6, 1.1, smoothstep( 0.2, 0.7, bk.a ) ) )
				// grey-green crustose lichen patches on the notro stems
				.add( vec3( 0.04, 0.05, 0.035 ).mul( smoothstep( 0.6, 0.8, vnoise( uv().mul( vec2( 4.0, 7.0 ) ).add( vT.w.mul( 9.0 ) ) ) ) ) );
			// 3D flowers: waxy scarlet tubes (deeper at the throat), pale yellow styles
			const isStyle = vC.x.greaterThan( 200.5 );
			const tubeCol = select( isStyle, vec3( 0.55, 0.42, 0.12 ), mix( vec3( 0.5, 0.05, 0.012 ), vec3( 0.85, 0.16, 0.03 ), vT.w ) );
			const albedo = select( isTubeF, tubeCol, select( isWood, barkCol, sample.rgb.mul( vT.xyz ) ) ).toVar();
			const ao = vC.y.mul( mix( 0.6, 1.0, vC.z ) );
			const N = select( isWood, normalize( vN ), normalize( vN ).mul( faceDirection.mul( 0.3 ).add( 0.7 ) ) );
			const transmit = select( isWood, float( 0.0 ), select( isNotroFl.or( isTubeF ), float( 0.75 ), float( 0.5 ) ) );
			const spec = select( isWood, float( 0.05 ), float( 0.16 ) ); // glossy leathery leaves
			// night: bioluminescent firebush. The flowers glow from within (hot core,
			// softer petals), breathing slowly; waves of light roll across the plain
			// from bush to bush; the leaves around them catch a faint warm halo.
			const red = select( isTubeF, float( 1.0 ), smoothstep( 0.08, 0.3, sample.r.sub( sample.g.mul( 1.4 ) ) ).mul( select( isNotroFl, float( 1.0 ), float( 0.0 ) ) ) );
			const core = select( isTubeF, float( 0.8 ), smoothstep( 0.45, 0.75, sample.r ).mul( red ) );
			const wave = sin( vW.x.mul( 0.045 ).add( vW.z.mul( 0.03 ) ).sub( U.time.mul( 0.55 ) ) ).mul( 0.5 ).add( 0.5 );
			const breathe = sin( U.time.mul( 0.7 ).add( vT.w.mul( 40.0 ) ) ).mul( 0.5 ).add( 0.5 );
			const pulse = mix( 0.45, 1.0, wave.mul( 0.6 ).add( breathe.mul( 0.4 ) ) );
			const V = normalize( cameraPosition.sub( vW ) );
			const rim = float( 1.0 ).sub( dot( normalize( vN ), V ).abs() ).pow( 2.0 );
			const glowCol = mix( vec3( 1.0, 0.12, 0.18 ), vec3( 1.0, 0.45, 0.25 ), core );
			const halo = select( isWood, float( 0.0 ), float( 1.0 ) ).mul( vC.z ).mul( 0.04 ).mul( sp.glow ); // leaves in the crown
			// softer overall, hot cores (bloom gives them a halo), fading with distance
			// so the far plain is a scatter of faint embers, not a field of lamps
			const far = exp( dist.div( - 160.0 ) ).mul( 0.85 ).add( 0.15 );
			// glow takes its colour and detail from the flower itself (no flat silhouettes);
			// small hot cores cross the bloom threshold and get a soft halo
			const flowerLight = albedo.mul( vec3( 2.2, 1.2, 1.1 ) ).add( glowCol.mul( 0.04 ) );
			const hot = core.mul( core ).mul( 3.0 );
			const emit = flowerLight.mul( red.mul( 0.9 ) ).add( glowCol.mul( hot ) ).mul( rim.mul( 0.4 ).add( 0.8 ) ).add( glowCol.mul( halo ) )
				.mul( U.night.mul( U.glow ).mul( pulse ).mul( far ).mul( sp.glow * 0.11 ) );
			return shadeFoliage( albedo, N, vW, ao, vC.w, transmit, spec, float( 0.35 ), emit );

		} )();

		return mat;

	}

	// re-scatter with a new density (0..2); buffers were sized for 2.4x the default
	setDensity( d ) {

		this.density = d;
		this.data = scatter( d );
		this.lastPos.set( 1e9, 0, 0 );

	}

	// re-bucket instances into variant / LOD when the camera has moved
	update( renderer, camera ) {

		const cp = camera.position;
		if ( cp.distanceToSquared( this.lastPos ) < 9 ) return;
		this.lastPos.copy( cp );
		const L0 = LOD_DIST[ 0 ] ** 2, L1 = LOD_DIST[ 1 ] ** 2, L2 = LOD_DIST[ 2 ] ** 2;
		this.data.forEach( ( d, si ) => {

			const V = SPECIES[ si ].variants;
			const ms = this.meshes[ si ];
			const n = ms.map( () => [ 0, 0, 0, 0 ] );
			for ( let i = 0; i < d.length; i += 8 ) {

				const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z;
				const r2 = dx * dx + dz * dz;
				const l = r2 < L0 ? 0 : r2 < L1 ? 1 : r2 < L2 ? 2 : 3;
				const v = variantOf( d[ i + 6 ], V );
				const m = ms[ v ][ l ];
				const a = m.geometry.attributes.iA.array, b = m.geometry.attributes.iB.array;
				if ( n[ v ][ l ] * 4 >= a.length ) continue;
				const k = ( n[ v ][ l ] ++ ) * 4;
				a[ k ] = d[ i ]; a[ k + 1 ] = d[ i + 1 ]; a[ k + 2 ] = d[ i + 2 ]; a[ k + 3 ] = d[ i + 3 ];
				b[ k ] = d[ i + 4 ]; b[ k + 1 ] = d[ i + 5 ]; b[ k + 2 ] = d[ i + 6 ]; b[ k + 3 ] = d[ i + 7 ];

			}

			ms.forEach( ( row, v ) => row.forEach( ( m, l ) => {

				m.geometry.instanceCount = n[ v ][ l ];
				m.visible = n[ v ][ l ] > 0;
				m.geometry.attributes.iA.needsUpdate = true;
				m.geometry.attributes.iB.needsUpdate = true;

			} ) );

		} );

	}

}
