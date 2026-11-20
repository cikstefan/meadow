// The jose flora of the plains: oleanders, baby's breath, blue butterfly bush, feather
// grass, forest grass, fescue, weeping figs, plumerias, smoke bushes, olives, pride of
// Madeira, dwarf mountain pines, scattered in drifts out to FAR metres.
//
// Rendering follows Nanite Foliage: real geometry up close (three mesh LODs of the grown
// plant), voxels beyond (compute-shader rasterizer, raster.js), with a dithered cross-fade
// between them. Mesh and voxel share the same wind (wind.js), so they move as one.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec3, vec4, attribute, varying, cameraPosition, faceDirection, normalize, length, mix, smoothstep, select, floor,
	Discard, If, dot, max, sin, cos, texture, uv, uniform, uint, clamp, fwidth, log2, pow, dFdx, dFdy, cross, fract
} from 'three/tsl';
import { pcg } from '../../../tsl/noise.js';
import { vnoiseJS } from '../../../tsl/noise.js';
import { U, shadeFoliage } from '../../../tsl/world.js';
import { rng } from '../grow.js';
import { terrainHeightJS, trailDistJS, lakeDistJS, mountainHeightJS } from '../terrain.js';
import { rockAtJS } from '../rockmask.js';
import { cloudShadowGround } from '../index.js';
import { VoxelRaster, cellHash, FADE_PX, flowerGlow } from './raster.js';
import { plantWind } from './wind.js';
import { sunShadowAt, frameRot } from './sunshadow.js';
import { JOSE_SPECIES, pickJose, streamJoseMeshes, decodeLOD, scanInfo } from './jose.js';

const TILE_M = 32, FAR = 1000, CAP = 96; // plants per tile (max)
const LOD_D = [ 9, 22 ], LOD_BAND = 1.25; // mesh LOD0 / LOD1 / LOD2 distances; each switch dissolves over 25 %
const FADE_W = 1.3; // the dissolve runs from d0 to d0 * FADE_W
// meshes hand over to voxels where a level-0 voxel is about FADE_PX pixels: a plant's
// own distance, from its voxel size and the screen (Nanite switches at ~1 px too)
const fadeStart = ( vsz, s, focal ) => THREE.MathUtils.clamp( vsz * s * focal / FADE_PX, 22, 140 );
const GRID = 7; // candidate points per tile side

function tilePlants( tx, tz, jose ) {

	const out = [];
	const r = rng( ( tx * 73856093 ) ^ ( tz * 19349663 ) ^ 0x2c1b3c6d );
	for ( let j = 0; j < GRID; j ++ ) for ( let i = 0; i < GRID; i ++ ) {

		const x = ( tx + ( i + r() ) / GRID ) * TILE_M, z = ( tz + ( j + r() ) / GRID ) * TILE_M;
		const yaw = r() * 6.283, seed = r(), sz = r(), pickR = r();
		// open ground between the drifts (the plain is grassland first)
		if ( vnoiseJS( x / 23 + 5.1, z / 23 + 9.3 ) * 0.7 + pickR * 0.3 < 0.42 ) continue;
		const sp = pickJose( x, z, r, jose.bySp );
		if ( ! sp ) continue;
		if ( trailDistJS( x, z ) < 2.0 || lakeDistJS( x, z ) < 5 || rockAtJS( x, z ) > 0.1 || mountainHeightJS( x, z ) > 160 ) continue;
		const list = jose.bySp[ sp ];
		const p = list[ Math.floor( r() * list.length ) ];
		const lean = JOSE_SPECIES[ sp ].lean * ( 0.4 + 1.2 * r() );
		const s = 0.75 + sz * 0.5;
		out.push( x, terrainHeightJS( x, z ) - 0.03, z, s, s, yaw, p, Math.min( 0.999, seed ) + Math.floor( lean * 100 ) );

	}

	return new Float32Array( out.slice( 0, CAP * 8 ) );

}

export class Flora {

	constructor( jose ) {

		this.jose = jose;
		this.group = new THREE.Group();
		this.tiles = new Map();
		this.lastTilePos = new THREE.Vector3( 1e9, 0, 0 );
		this.lastPos = new THREE.Vector3( 1e9, 0, 0 );
		const slots = Math.ceil( Math.PI * ( ( FAR + TILE_M * 2 ) / TILE_M + 1 ) ** 2 );
		this.freeSlots = [];
		for ( let i = slots - 1; i >= 0; i -- ) this.freeSlots.push( i );
		this.raster = new VoxelRaster( jose.protos, slots * CAP, { far: FAR } );
		this.empty = new Float32Array( CAP * 8 );
		this.materials = new Map(); // photo scan -> material
		this.meshes = new Map(); // proto * 3 + lod -> instanced mesh (one group per scan)
		streamJoseMeshes( jose, ( i ) => {

			this.raster.setMeshReady( i );
			this.meshDirty = true;

		} );

	}

	// one material per photo scan: the captured vertex colour carries the plant's colour
	// (jose's own shading), the scan adds its real detail around its mean (bark fissures,
	// leaf veins, petal grain), the way jose applies them
	material( M ) {

		const key = JSON.stringify( M );
		let mat = this.materials.get( key );
		if ( mat ) return mat;
		mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;
		const focal = this.raster.u.focal;
		const vW = varying( vec3( 0 ), 'vFlW' ), vN = varying( vec3( 0 ), 'vFlN' ), vC = varying( vec4( 0 ), 'vFlC' ), vI = varying( vec4( 0 ), 'vFlI' ), vL = varying( vec3( 0 ), 'vFlL' );
		mat.positionNode = Fn( () => {

			const A = attribute( 'iA', 'vec4' ), B = attribute( 'iB', 'vec4' ); // x y z sxz | sy yaw height seed+lean
			const p = attribute( 'position', 'vec3' ), n = attribute( 'normal', 'vec3' );
			const cs = cos( B.y ), sn = sin( B.y );
			const rot = ( v ) => vec3( v.x.mul( cs ).sub( v.z.mul( sn ) ), v.y, v.x.mul( sn ).add( v.z.mul( cs ) ) );
			const seed = B.w.fract(), lean = B.w.floor().mul( 0.01 );
			const Hh = B.z.mul( B.x ).max( 0.05 );
			const hgt = p.y.mul( B.x ).max( 0.0 );
			const lw = rot( vec3( p.x.mul( A.w ), p.y.mul( B.x ), p.z.mul( A.w ) ) );
			const W0 = vec3( 0.96, 0, - 0.28 );
			const w = A.xyz.add( lw ).add( plantWind( vec3( lw.x, hgt, lw.z ), Hh, A.xz, seed ) ).add( W0.mul( lean.mul( hgt ).mul( hgt.div( Hh ) ) ) );
			vW.assign( w );
			vN.assign( normalize( rot( n ) ) );
			vC.assign( attribute( 'color', 'vec4' ) );
			vL.assign( p );
			vI.assign( vec4( cloudShadowGround( A.xz ), length( A.xyz.sub( cameraPosition ) ), seed, A.w ) );
			return w;

		} )();
		const S = M.tex ? scanInfo( M.tex ) : null;
		const tex = S ? this.scanTexture( M.tex, S.url ) : null;
		const mode = tex ? M.mode : 'solid';

		mat.colorNode = Fn( () => {

			// hand-over to the voxels: a dissolve keyed to the plant's own level-0 voxel cells
			// (raster.js keeps exactly the complementary cells), so the plant comes apart into
			// its voxels and back with no screen-door pattern and nothing doubled. Between mesh
			// LODs the same cells split the plant between the two LODs (iD: this LOD's range).
			const C = attribute( 'iC', 'vec4' ); // box min (proto space) | level-0 voxel size
			const R = attribute( 'iD', 'vec4' ); // cell range this LOD draws [x, y)
			const d0 = clamp( C.w.mul( vI.w ).mul( focal ).div( FADE_PX ), 22.0, 140.0 );
			const keep = float( 1.0 ).sub( smoothstep( d0, d0.mul( FADE_W ), vI.y ) );
			const g = vL.sub( C.xyz ).div( C.w ).floor();
			const h = cellHash( g, vI.z );
			If( h.greaterThanEqual( keep ).or( h.lessThan( R.x ) ).or( h.greaterThanEqual( R.y ) ), () => {

				Discard();

			} );
			const a = floor( vC.w.mul( 255.0 ).add( 0.5 ) );
			const kind = floor( a.div( 64.0 ) ), ao = a.sub( kind.mul( 64.0 ) ).div( 63.0 );
			const front = faceDirection.greaterThan( 0.0 );
			const vary = mix( 0.9, 1.08, vI.z );
			let albedo;
			if ( mode === 'solid' ) {

				albedo = vC.xyz.mul( vC.xyz ).mul( vary );
				if ( tex ) {

					// light, shade and relief from the scan, never its colour (as jose uses them)
					const meanL = Math.max( 0.01, 0.2126 * S.mean[ 0 ] + 0.7152 * S.mean[ 1 ] + 0.0722 * S.mean[ 2 ] );
					const detail = dot( pow( texture( tex, uv() ).rgb, vec3( 2.2 ) ), vec3( 0.2126, 0.7152, 0.0722 ) ).div( meanL ).clamp( 0.25, 2.2 );
					albedo = albedo.mul( mix( float( 1.0 ), detail, S.amt ?? 0.8 ) );

				}

			} else {

				// jose's alpha cards: the scan's own cut-out (kept as mips average it away), coloured
				// the way jose colours them
				const T = texture( tex, uv() );
				const fw = fwidth( uv() ).mul( 1024.0 );
				const cov = T.a.sub( 0.12 ).div( 0.88 ).mul( clamp( float( 1.0 ).add( log2( max( max( fw.x.mul( 0.25 ), fw.y ), 1.0 ) ).mul( 0.35 ) ), 1.0, 2.2 ) );
				If( cov.lessThan( 0.5 ), () => {

					Discard();

				} );
				const base = vec3( ...M.base ), edge = vec3( ...M.edge ), outer = vec3( ...M.outer );
				if ( mode === 'atlas' ) {

					// this plant's own leaf / petal, as jose renders it (shape, veins, colour)
					albedo = pow( T.rgb, vec3( 2.2 ) ).mul( select( front, vec3( 1.0 ), vec3( 1.1, 1.12, 0.94 ) ) );

				} else if ( mode === 'leaf' ) {

					// a photographed leaf (sprig) on jose's leaf: the photo's veins, serration and
					// light, around the colour jose's render gave this leaf; paler underneath
					const tl = pow( T.rgb, vec3( 2.2 ) ).div( vec3( ...S.mean.map( ( m ) => Math.max( m, 0.01 ) ) ) );
					const lr = dot( tl, vec3( 0.3, 0.55, 0.15 ) );
					const under = select( front, vec3( 1.0 ), vec3( 1.12, 1.14, 0.92 ) );
					albedo = vC.xyz.mul( vC.xyz ).mul( mix( vec3( lr ), tl, 0.55 ) ).mul( under );

				} else if ( mode === 'tint' ) {

					// a drawn floret: R light and shade, G the main colour's mask, B the eye
					albedo = T.r.mul( T.r ).mul( base.mul( T.g ).add( edge.mul( T.b ) ).add( vec3( float( 1.0 ).sub( T.g ).sub( T.b ).max( 0.0 ) ) ) ).mul( select( front, float( 1.0 ), float( 0.8 ) ) );

				} else {

					const tl = pow( T.rgb, vec3( 2.2 ) ).div( vec3( ...S.mean.map( ( m ) => Math.max( m, 0.01 ) ) ) );
					const lr = dot( tl, vec3( 0.3, 0.55, 0.15 ) );
					albedo = select( front, base, outer ).mul( mix( vec3( lr ), tl, mode === 'raw' ? 0.6 : 0.35 ) );

				}

				albedo = albedo.mul( vary );

			}

			const N0 = normalize( vN ).mul( faceDirection );
			// plasticity: the scan's relief as bump (screen-space derivatives), cards cupped
			// across their width; leaf veins and bark fissures catch the light
			let N = N0;
			// relief and cupping fade out with distance: beyond ~15 m they only alias into
			// glints that crawl from frame to frame
			const relief = smoothstep( 14.0, 3.0, length( cameraPosition.sub( vW ) ) );
			if ( tex ) {

				// (height from a blurrier mip: pixel-scale fissure detail differentiated per pixel
				// turned into black/white zebra stripes that crawl as you move)
				const T2 = texture( tex, uv() ).bias( 2.0 );
				const hgt = mode === 'solid' ? T2.a : dot( T2.rgb, vec3( 0.3, 0.55, 0.15 ) );
				const dPdx = dFdx( vW ), dPdy = dFdy( vW );
				const R1 = cross( dPdy, N0 ), R2 = cross( N0, dPdx );
				const det = dot( dPdx, R1 );
				const k = mode === 'solid' ? 0.008 : 0.006;
				const grad = R1.mul( dFdx( hgt ) ).add( R2.mul( dFdy( hgt ) ) ).mul( select( det.lessThan( 0.0 ), float( - 1.0 ), float( 1.0 ) ) ).mul( k ).mul( relief );
				// (tilt capped at ~35 deg: relief shades, it never flips a face away from the sun)
				const gl = length( grad ).max( 1e-12 ), cap = det.abs().mul( 0.7 );
				N = normalize( N0.mul( det.abs() ).sub( grad.mul( cap.div( gl ).min( 1.0 ) ) ) );
				if ( mode !== 'solid' ) {

					// tangent along u, then tilt the normal outward toward the card's edges
					const duvx = dFdx( uv() ), duvy = dFdy( uv() );
					const Tg = normalize( dPdx.mul( duvy.y ).sub( dPdy.mul( duvx.y ) ).add( 1e-6 ) );
					const cu = fract( uv().x.mul( 4.0 ) ).sub( 0.5 );
					N = normalize( N.add( Tg.mul( cu.mul( 0.9 ).mul( relief ) ) ) );

				}

			}

			// (thin photo leaves glow yellow-green when the sun is behind them)
			const transmit = select( kind.lessThan( 0.5 ), float( 0.0 ), select( kind.lessThan( 1.5 ), float( mode === 'leaf' || mode === 'atlas' ? 0.7 : 0.55 ), float( 0.4 ) ) );
			// night: some flowers of some plants glow in their own colour, each its own strength
			const emit = flowerGlow( albedo, kind.greaterThan( 1.5 ), vL, vI.z ).mul( U.night.mul( U.glow ) );
			// self-shadowing inside the crown: leaves the capture found hidden deep inside get
			// little direct sun as well as little sky (rich shade under the outer shell)
			const sunOcc = mix( 0.45, 1.0, ao ).mul( sunShadowAt( vW.add( N.mul( 0.04 ) ).add( U.sunDir.mul( 0.03 ) ), frameRot() ) );
			// wood: plain Lambert (round trunks, a real terminator); leaves: soft wrap, a glossy
			// sun-coloured sheen strongest at grazing angles (Fresnel)
			const isWood = kind.lessThan( 0.5 );
			const Vv = normalize( cameraPosition.sub( vW ) );
			const fres = float( 1.0 ).sub( dot( N, Vv ).abs() ).pow( 4.0 );
			// (kept modest: a leaf is glossy in spots, the whole crown never turns into a white mirror)
			const specK = select( isWood, float( 0.03 ), float( mode === 'solid' ? 0.08 : 0.12 ).mul( fres.mul( 1.2 ).add( 0.3 ) ) ).mul( mix( 0.2, 1.0, relief ) );
			return shadeFoliage( albedo, N, vW, mix( 0.3, 1.0, ao ), vI.x.mul( sunOcc ), transmit, specK, select( isWood, float( 0.0 ), float( 0.3 ) ), emit );

		} )();
		this.materials.set( key, mat );
		return mat;

	}

	scanTexture( name, url ) {

		this.scans = this.scans || new Map();
		let t = this.scans.get( name );
		if ( ! t ) {

			t = new THREE.TextureLoader().load( url );
			t.colorSpace = THREE.NoColorSpace; // (decoded in the shader, as jose does)
			t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
			this.scans.set( name, t );

		}

		return t;

	}

	// instanced mesh of one prototype's LOD (built when first needed)
	meshFor( pi, l ) {

		const key = pi * 3 + l;
		let m = this.meshes.get( key );
		if ( m ) return m;
		const p = this.jose.protos[ pi ];
		const D = decodeLOD( p, l );
		if ( ! D ) return null;
		const g = new THREE.InstancedBufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( D.pos, 3 ) );
		g.setAttribute( 'normal', new THREE.BufferAttribute( D.nrm, 3 ) );
		g.setAttribute( 'color', new THREE.BufferAttribute( D.col, 4, true ) );
		g.setAttribute( 'uv', new THREE.BufferAttribute( D.uv, 2 ) );
		g.setIndex( new THREE.BufferAttribute( D.idx, 1 ) );
		const mats = [];
		for ( const G of D.groups ) {

			g.addGroup( G.start, G.count, mats.length );
			mats.push( this.material( G.mat ) );

		}
		const cap = 64;
		g.setAttribute( 'iA', new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setAttribute( 'iB', new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setAttribute( 'iC', new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setAttribute( 'iD', new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
		g.instanceCount = 0;
		m = new THREE.Mesh( g, mats );
		m.frustumCulled = false;
		m.renderOrder = 7;
		m.userData = { cap, n: 0, A: [], B: [], D: [], C: [ ...p.info.min, p.info.vsz[ 0 ] ] };
		this.group.add( m );
		this.meshes.set( key, m );
		return m;

	}

	update( renderer, camera ) {

		const cp = camera.position, jose = this.jose;
		// tiles around the camera: nearest first, a time budget per frame
		if ( cp.distanceToSquared( this.lastTilePos ) > 16 * 16 || this.pending ) {

			if ( cp.distanceToSquared( this.lastTilePos ) > 16 * 16 ) this.lastTilePos.copy( cp );
			const ctx = Math.floor( cp.x / TILE_M ), ctz = Math.floor( cp.z / TILE_M ), R = Math.ceil( FAR / TILE_M );
			const keep = new Set(), todo = [];
			for ( let j = - R; j <= R; j ++ ) for ( let i = - R; i <= R; i ++ ) {

				const tx = ctx + i, tz = ctz + j;
				const dx = ( tx + 0.5 ) * TILE_M - cp.x, dz = ( tz + 0.5 ) * TILE_M - cp.z, d2 = dx * dx + dz * dz;
				if ( d2 > ( FAR + TILE_M ) ** 2 ) continue;
				const key = tx + ',' + tz;
				keep.add( key );
				if ( ! this.tiles.has( key ) ) todo.push( [ d2, tx, tz, key ] );

			}

			for ( const [ k, T ] of this.tiles ) if ( ! keep.has( k ) ) {

				this.raster.writeSlots( T.slot * CAP, this.empty );
				this.freeSlots.push( T.slot );
				this.tiles.delete( k );

			}

			todo.sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
			const t0 = performance.now(), budget = this.tiles.size ? 4 : 60;
			let built = 0;
			for ( const [ , tx, tz, key ] of todo ) {

				if ( built && performance.now() - t0 > budget ) break;
				const data = tilePlants( tx, tz, jose );
				const slot = this.freeSlots.pop();
				const buf = new Float32Array( CAP * 8 );
				buf.set( data );
				this.raster.writeSlots( slot * CAP, buf );
				this.tiles.set( key, { data, slot, cx: ( tx + 0.5 ) * TILE_M, cz: ( tz + 0.5 ) * TILE_M } );
				built ++;

			}

			this.pending = built < todo.length;
			if ( built ) this.lastPos.set( 1e9, 0, 0 );

		}

		this.raster.render( renderer, camera );

		// near meshes: re-bucket when the camera moved or turned
		const fwd = new THREE.Vector3( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		this.lastFwd = this.lastFwd || new THREE.Vector3();
		if ( cp.distanceToSquared( this.lastPos ) < 0.25 && fwd.dot( this.lastFwd ) > 0.995 && ! this.meshDirty ) return;
		this.lastPos.copy( cp ); this.lastFwd.copy( fwd );
		this.meshDirty = false;
		for ( const m of this.meshes.values() ) m.userData.n = 0;
		const focal = this.raster.u.focal.value, maxEnd = 140 * FADE_W;
		const R2 = maxEnd ** 2, cosCut = Math.cos( THREE.MathUtils.degToRad( camera.fov * camera.aspect * 0.5 + 25 ) );
		for ( const T of this.tiles.values() ) {

			if ( ( T.cx - cp.x ) ** 2 + ( T.cz - cp.z ) ** 2 > ( maxEnd + TILE_M ) ** 2 ) continue;
			const d = T.data;
			for ( let i = 0; i < d.length; i += 8 ) {

				const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z, r2 = dx * dx + dz * dz;
				if ( r2 > R2 ) continue;
				const r = Math.sqrt( r2 );
				if ( r > 6 && ( dx * fwd.x + dz * fwd.z ) / r < cosCut ) continue; // outside the view
				const pi = d[ i + 6 ], p = jose.protos[ pi ];
				if ( ! p.mesh ) continue; // still streaming: the voxels draw it
				if ( r > fadeStart( p.info.vsz[ 0 ], d[ i + 3 ], focal ) * FADE_W ) continue; // the voxels have it
				// LOD bands: near a boundary the plant is split between both LODs by its cells
				const put = ( l, lo, hi ) => {

					if ( hi <= lo ) return;
					if ( ! p.mesh.lods[ l ] ) l = 1;
					const m = this.meshFor( pi, l );
					if ( ! m ) return;
					const U2 = m.userData, k4 = U2.n * 4;
					U2.A[ k4 ] = d[ i ]; U2.A[ k4 + 1 ] = d[ i + 1 ]; U2.A[ k4 + 2 ] = d[ i + 2 ]; U2.A[ k4 + 3 ] = d[ i + 3 ];
					U2.B[ k4 ] = d[ i + 4 ]; U2.B[ k4 + 1 ] = d[ i + 5 ]; U2.B[ k4 + 2 ] = p.height; U2.B[ k4 + 3 ] = d[ i + 7 ];
					U2.D[ k4 ] = lo; U2.D[ k4 + 1 ] = hi; U2.D[ k4 + 2 ] = 0; U2.D[ k4 + 3 ] = 0;
					U2.n ++;

				};
				const band = ( D ) => 1 - THREE.MathUtils.smoothstep( r, D, D * LOD_BAND );
				if ( r < LOD_D[ 0 ] * LOD_BAND ) {

					const b = band( LOD_D[ 0 ] );
					put( 0, 0, b ); put( 1, b, 1 );

				} else if ( r < LOD_D[ 1 ] * LOD_BAND ) {

					const b = r < LOD_D[ 1 ] ? 1 : band( LOD_D[ 1 ] );
					put( 1, 0, b ); put( 2, b, 1 );

				} else put( 2, 0, 1 );

			}

		}

		for ( const m of this.meshes.values() ) {

			const U2 = m.userData, g = m.geometry;
			if ( U2.n > U2.cap ) {

				U2.cap = Math.ceil( U2.n * 1.5 );
				g.setAttribute( 'iA', new THREE.InstancedBufferAttribute( new Float32Array( U2.cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
				g.setAttribute( 'iB', new THREE.InstancedBufferAttribute( new Float32Array( U2.cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
				g.setAttribute( 'iC', new THREE.InstancedBufferAttribute( new Float32Array( U2.cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
				g.setAttribute( 'iD', new THREE.InstancedBufferAttribute( new Float32Array( U2.cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );

			}

			g.attributes.iA.array.set( U2.A.slice( 0, U2.n * 4 ) );
			g.attributes.iB.array.set( U2.B.slice( 0, U2.n * 4 ) );
			const ca = g.attributes.iC.array;
			for ( let k = 0; k < U2.n; k ++ ) ca.set( U2.C, k * 4 );
			g.attributes.iD.array.set( U2.D.slice( 0, U2.n * 4 ) );
			g.attributes.iA.needsUpdate = true; g.attributes.iB.needsUpdate = true; g.attributes.iC.needsUpdate = true; g.attributes.iD.needsUpdate = true;
			g.instanceCount = U2.n;
			m.visible = U2.n > 0;

		}

	}

}
