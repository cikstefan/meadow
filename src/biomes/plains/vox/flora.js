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
	screenCoordinate, Discard, If, dot, max, sin, cos
} from 'three/tsl';
import { vnoiseJS } from '../../../tsl/noise.js';
import { U, shadeFoliage } from '../../../tsl/world.js';
import { rng } from '../grow.js';
import { terrainHeightJS, trailDistJS, lakeDistJS, mountainHeightJS } from '../terrain.js';
import { rockAtJS } from '../rockmask.js';
import { cloudShadowGround } from '../index.js';
import { VoxelRaster, ign } from './raster.js';
import { plantWind } from './wind.js';
import { JOSE_SPECIES, pickJose, streamJoseMeshes, decodeLOD } from './jose.js';

const TILE_M = 32, FAR = 1000, CAP = 96; // plants per tile (max)
const FADE = [ 30, 38 ]; // meshes -> voxels cross-fade (m)
const LOD_D = [ 9, 20 ]; // mesh LOD0 / LOD1 / LOD2 distances
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
		this.raster = new VoxelRaster( jose.protos, slots * CAP, { far: FAR, fade: FADE } );
		this.empty = new Float32Array( CAP * 8 );
		this.material = this.makeMaterial();
		this.meshes = new Map(); // proto * 3 + lod -> InstancedMesh-like
		streamJoseMeshes( jose, ( i ) => {

			this.raster.setMeshReady( i );
			this.meshDirty = true;

		} );

	}

	makeMaterial() {

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;
		const vW = varying( vec3( 0 ), 'vFlW' ), vN = varying( vec3( 0 ), 'vFlN' ), vC = varying( vec4( 0 ), 'vFlC' ), vI = varying( vec4( 0 ), 'vFlI' );
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
			vI.assign( vec4( cloudShadowGround( A.xz ), length( A.xyz.sub( cameraPosition ) ), seed, 0 ) );
			return w;

		} )();
		mat.colorNode = Fn( () => {

			// cross-fade to the voxels: complementary dither (raster.js draws the other pixels)
			const sc = floor( screenCoordinate );
			If( ign( sc.x, sc.y ).greaterThanEqual( float( 1.0 ).sub( smoothstep( FADE[ 0 ], FADE[ 1 ], vI.y ) ) ), () => {

				Discard();

			} );
			const a = floor( vC.w.mul( 255.0 ).add( 0.5 ) );
			const kind = floor( a.div( 64.0 ) ), ao = a.sub( kind.mul( 64.0 ) ).div( 63.0 );
			const albedo = vC.xyz.mul( vC.xyz ).mul( mix( 0.9, 1.08, vI.z ) );
			const N = normalize( vN ).mul( faceDirection );
			const transmit = select( kind.lessThan( 0.5 ), float( 0.0 ), select( kind.lessThan( 1.5 ), float( 0.55 ), float( 0.75 ) ) );
			// night: flowers glow in their own colour
			const al = dot( albedo, vec3( 0.2126, 0.7152, 0.0722 ) );
			const own = mix( vec3( al ), albedo, 1.8 ).max( 0.0 ).div( max( albedo.x, max( albedo.y, albedo.z ) ).add( 0.03 ) ).mul( 0.22 );
			const emit = select( kind.greaterThan( 1.5 ), own, vec3( 0 ) ).mul( U.night.mul( U.glow ) );
			return shadeFoliage( albedo, N, vW, mix( 0.35, 1.0, ao ), vI.x, transmit, float( 0.12 ), float( 0.4 ), emit );

		} )();
		return mat;

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
		g.setIndex( new THREE.BufferAttribute( D.idx, 1 ) );
		const cap = 64;
		g.setAttribute( 'iA', new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setAttribute( 'iB', new THREE.InstancedBufferAttribute( new Float32Array( cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
		g.instanceCount = 0;
		m = new THREE.Mesh( g, this.material );
		m.frustumCulled = false;
		m.renderOrder = 7;
		m.userData = { cap, n: 0, A: [], B: [] };
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
		const R2 = ( FADE[ 1 ] + 6 ) ** 2, cosCut = Math.cos( THREE.MathUtils.degToRad( camera.fov * camera.aspect * 0.5 + 25 ) );
		for ( const T of this.tiles.values() ) {

			if ( ( T.cx - cp.x ) ** 2 + ( T.cz - cp.z ) ** 2 > ( FADE[ 1 ] + TILE_M ) ** 2 ) continue;
			const d = T.data;
			for ( let i = 0; i < d.length; i += 8 ) {

				const dx = d[ i ] - cp.x, dz = d[ i + 2 ] - cp.z, r2 = dx * dx + dz * dz;
				if ( r2 > R2 ) continue;
				const r = Math.sqrt( r2 );
				if ( r > 6 && ( dx * fwd.x + dz * fwd.z ) / r < cosCut ) continue; // outside the view
				const pi = d[ i + 6 ], p = jose.protos[ pi ];
				if ( ! p.mesh ) continue; // still streaming: the voxels draw it
				let l = r < LOD_D[ 0 ] ? 0 : r < LOD_D[ 1 ] ? 1 : 2;
				if ( ! p.mesh.lods[ l ] ) l = 1;
				const m = this.meshFor( pi, l );
				if ( ! m ) continue;
				const U2 = m.userData;
				U2.A.length = U2.n * 4 + 4; U2.B.length = U2.n * 4 + 4;
				U2.A.splice( U2.n * 4, 4, d[ i ], d[ i + 1 ], d[ i + 2 ], d[ i + 3 ] );
				U2.B.splice( U2.n * 4, 4, d[ i + 4 ], d[ i + 5 ], p.height, d[ i + 7 ] );
				U2.n ++;

			}

		}

		for ( const m of this.meshes.values() ) {

			const U2 = m.userData, g = m.geometry;
			if ( U2.n > U2.cap ) {

				U2.cap = Math.ceil( U2.n * 1.5 );
				g.setAttribute( 'iA', new THREE.InstancedBufferAttribute( new Float32Array( U2.cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );
				g.setAttribute( 'iB', new THREE.InstancedBufferAttribute( new Float32Array( U2.cap * 4 ), 4 ).setUsage( THREE.DynamicDrawUsage ) );

			}

			g.attributes.iA.array.set( U2.A.slice( 0, U2.n * 4 ) );
			g.attributes.iB.array.set( U2.B.slice( 0, U2.n * 4 ) );
			g.attributes.iA.needsUpdate = true; g.attributes.iB.needsUpdate = true;
			g.instanceCount = U2.n;
			m.visible = U2.n > 0;

		}

	}

}
