// A software rasterizer on the GPU for voxel foliage (compute shaders only).
//
//   clear  - per pixel: depth key = 0; resets the visible-list counter
//   cull   - per plant slot: frustum + distance band, picks the voxel level whose
//            voxels project to ~1 pixel, appends (slot, level) to a visible list
//   depth  - persistent workgroups walk the visible list, one plant per workgroup,
//            64 threads over its voxels: wind, project, atomicMax( 1/distance ) per pixel
//   colour - the same walk again; a voxel that won any of its pixels is shaded once (sun,
//            sky, cloud shadow, translucency, night glow, fog) and writes those pixels
//
// The post pass takes the voxel colour wherever it is nearer than the scene. WebGPU has
// no 64-bit atomics, so depth and payload can't be packed into one atomicMax: the
// two-pass depth-then-colour resolve is the standard workaround.
//
// Plants whose meshes are loaded hand over to them up close (see FADE_PX below).

import * as THREE from 'three/webgpu';
import {
	Fn, storage, uniform, float, uint, vec2, vec3, vec4, If, Loop, instanceIndex, atomicAdd, atomicMax, atomicStore,
	bitcast, max, min, clamp, floor, ceil, log2, dot, normalize, length, mix, smoothstep, sin, cos, pow, select, fract, int, ivec2, textureLoad
} from 'three/tsl';
import { pcg } from '../../../tsl/noise.js';
import { U, applyFogFrom } from '../../../tsl/world.js';
import { cloudShadowGround } from '../index.js';
import { MAXLV, packPrototypes } from './voxelize.js';
import { plantWind } from './wind.js';
import { SH_N, SH_EXT, shadowAtomic, sunViewProj, shadowOn, updateSunCamera, sunShadowAt } from './sunshadow.js';

const WG = 64, GROUPS = 8192, MAXVIS = 1 << 19, MAXVIS_SH = 1 << 18, GROUPS_SH = 4096;

// mesh <-> voxel hand-over: where a plant's level-0 voxel is about FADE_PX pixels wide
// (like Nanite, which switches to voxels at about a pixel), dissolving over FADE_W x that
// distance. The dissolve is keyed to the plant's own level-0 voxel cells: a cell is either
// mesh or voxel, never both and never neither, and the pattern is fixed to the plant (no
// screen-door crawl as the camera moves).
export const FADE_PX = 1.15, FADE_W = 1.3;

// HDR colour in one word: each channel x -> x / (1 + x), 11 / 11 / 10 bits
export const packColor = ( c ) => {

	const y = c.max( 0.0 ).div( c.max( 0.0 ).add( 1.0 ) );
	return uint( y.x.mul( 2047.0 ).add( 0.5 ) ).bitOr( uint( y.y.mul( 2047.0 ).add( 0.5 ) ).shiftLeft( uint( 11 ) ) ).bitOr( uint( y.z.mul( 1023.0 ).add( 0.5 ) ).shiftLeft( uint( 22 ) ) );

};
export const unpackColor = ( w ) => {

	const y = vec3( float( w.bitAnd( uint( 2047 ) ) ).div( 2047.0 ), float( w.shiftRight( uint( 11 ) ).bitAnd( uint( 2047 ) ) ).div( 2047.0 ), float( w.shiftRight( uint( 22 ) ) ).div( 1023.0 ) );
	return y.div( vec3( 1.0 ).sub( y ).max( 1e-3 ) );

};

// night glow, shared by meshes and voxels: only some plants glow (each its own strength),
// and on those only some flowers, each a little brighter or dimmer; never leaf greens.
// lp: position in the prototype's own space (the same for a plant's mesh and voxels)
export function flowerGlow( albedo, isFlower, lp, seed ) {

	const sd = uint( seed.mul( 65535.0 ) );
	const plantOn = select( pcg( sd.add( uint( 7 ) ) ).lessThan( 0.42 ), float( 1.0 ), float( 0.0 ) );
	const plantK = mix( 0.35, 1.6, pcg( sd.add( uint( 13 ) ) ) );
	const cell = lp.div( 0.22 ).floor();
	const flowerK = smoothstep( 0.45, 0.95, cellHash( cell, seed.add( 0.37 ) ) ).mul( 1.6 );
	const greenish = albedo.y.greaterThanEqual( albedo.x.mul( 0.78 ) ).and( albedo.y.greaterThanEqual( albedo.z ) );
	const al = dot( albedo, vec3( 0.2126, 0.7152, 0.0722 ) );
	const own = mix( vec3( al ), albedo, 1.8 ).max( 0.0 ).div( max( albedo.x, max( albedo.y, albedo.z ) ).add( 0.03 ) ).mul( 0.25 );
	return select( isFlower.and( greenish.not() ), own, vec3( 0 ) ).mul( plantOn ).mul( plantK ).mul( flowerK );

}
export const cellHash = ( g, seed ) => pcg( uint( int( g.x ) ).mul( uint( 73856093 ) ).bitXor( uint( int( g.y ) ).mul( uint( 19349663 ) ) )
	.bitXor( uint( int( g.z ) ).mul( uint( 83492791 ) ) ).add( uint( seed.mul( 65535.0 ) ) ) );

export class VoxelRaster {

	/**
	 * @param {Array} protos voxel pyramids ({ levels, info, height })
	 * @param {number} slots plant slots, 8 floats each:
	 *   x y z sxz | sy yaw prototype (seed + 100 * lean)
	 *   (sxz, sy scale the prototype; lean: permanent downwind shear, per metre of height)
	 */
	constructor( protos, slots, { far = 1000 } = {} ) {

		const baked = packPrototypes( protos );
		protos.forEach( ( p, i ) => {

			baked.boxes[ i * 12 + 8 ] = 0; // meshes loaded: set later (setMeshReady)
			baked.boxes[ i * 12 + 9 ] = p.height;

		} );
		console.log( `voxel raster: ${ protos.length } prototypes, ${ baked.voxels.length / 3 } voxels` );

		this.slots = slots;
		// pixel buffers sized for the largest drawing buffer this screen can have
		const dpr = Math.min( window.devicePixelRatio || 1, 2 );
		this.resScale = 1; this.jitter = null; // set by the post pipeline (temporal upscaling)
		this.maxPix = Math.ceil( Math.max( screen.width, window.innerWidth ) * dpr ) * Math.ceil( Math.max( screen.height, window.innerHeight ) * dpr );

		this.instAttr = new THREE.StorageBufferAttribute( new Float32Array( slots * 8 ), 4 );
		this.inst = storage( this.instAttr, 'vec4', slots * 2 ).toReadOnly();
		// one buffer: the per-level ranges first, then the voxels (keeps the passes within
		// WebGPU's 8 storage buffers per stage)
		const RO = Math.ceil( baked.ranges.length / 3 ) * 3; // (voxels are 3 words: keep them aligned)
		const all = new Uint32Array( RO + baked.voxels.length );
		all.set( baked.ranges ); all.set( baked.voxels, RO );
		for ( let i = 0; i < baked.ranges.length; i += 2 ) all[ i ] += RO / 3; // voxel offsets past the table (in voxels of 3 words)
		this.RO = RO;
		this.vox = storage( new THREE.StorageBufferAttribute( all, 1 ), 'uint', all.length ).toReadOnly();
		this.table = this.vox;
		this.boxAttr = new THREE.StorageBufferAttribute( baked.boxes, 4 );
		this.boxes = storage( this.boxAttr, 'vec4', baked.boxes.length / 4 ).toReadOnly();
		this.vis = storage( new THREE.StorageBufferAttribute( new Uint32Array( MAXVIS ), 1 ), 'uint', MAXVIS );
		this.cntAttr = new THREE.StorageBufferAttribute( new Uint32Array( 4 ), 1 );
		this.cnt = storage( this.cntAttr, 'uint', 4 ).toAtomic();
		// (later dispatches read these plainly: no atomicLoad needed)
		this.cntRead = storage( this.cntAttr, 'uint', 4 ).toReadOnly();
		this.depthAttr = new THREE.StorageBufferAttribute( new Uint32Array( this.maxPix ), 1 );
		this.depth = storage( this.depthAttr, 'uint', this.maxPix ).toAtomic();
		// colour: one packed word per pixel (HDR 11-11-10, see packColor): a quarter of the
		// memory traffic of four floats
		this.colorAttr = new THREE.StorageBufferAttribute( new Uint32Array( this.maxPix ), 1 );
		this.color = storage( this.colorAttr, 'uint', this.maxPix );
		// read-only views for the post pass
		this.depthRead = storage( this.depthAttr, 'uint', this.maxPix ).toReadOnly();
		this.colorRead = storage( this.colorAttr, 'uint', this.maxPix ).toReadOnly();

		this.u = {
			viewProj: uniform( new THREE.Matrix4() ), eye: uniform( new THREE.Vector3() ),
			size: uniform( new THREE.Vector2( 1, 1 ) ), focal: uniform( 1000 ), far: uniform( far ),
		};
		this.shCntAttr = new THREE.StorageBufferAttribute( new Uint32Array( 4 ), 1 );
		this.shCnt = storage( this.shCntAttr, 'uint', 4 ).toAtomic();
		this.shCntRead = storage( this.shCntAttr, 'uint', 4 ).toReadOnly();
		this.shVis = storage( new THREE.StorageBufferAttribute( new Uint32Array( MAXVIS_SH ), 1 ), 'uint', MAXVIS_SH );
		this.build();
		this.buildShadow();

	}

	// cull: frustum, distance band, and (once setOcclusionDepth gave it last frame's scene
	// depth) occlusion: a plant whose crown top and both sides all lie behind the terrain
	// there is skipped
	buildCull( occ = null ) {

		const { inst, boxes, vis, cnt, u } = this;
		const box = ( proto ) => [ boxes.element( proto.mul( 3 ) ), boxes.element( proto.mul( 3 ).add( 1 ) ), boxes.element( proto.mul( 3 ).add( 2 ) ) ];
		const W = u.size.x, H = u.size.y;
		const hidden = ( p ) => {

			// (reversed depth: bigger is nearer; ~ near / distance, so a ratio is a distance ratio)
			const cl = u.viewProj.mul( vec4( p, 1.0 ) );
			const nd = cl.xyz.div( cl.w );
			const onScreen = cl.w.greaterThan( 0.1 ).and( nd.x.abs().lessThan( 0.98 ) ).and( nd.y.abs().lessThan( 0.98 ) );
			const px = ivec2( int( nd.x.mul( 0.5 ).add( 0.5 ).mul( W ) ), int( float( 0.5 ).sub( nd.y.mul( 0.5 ) ).mul( H ) ) );
			const ds = textureLoad( occ, px ).x;
			return onScreen.and( ds.greaterThan( nd.z.mul( 1.04 ) ) );

		};

		this.cull = Fn( () => {

			const s = instanceIndex;
			If( s.lessThan( uint( this.slots ) ), () => {

				const A = inst.element( s.mul( 2 ) ), B = inst.element( s.mul( 2 ).add( 1 ) );
				If( A.w.greaterThan( 0.0 ), () => {

					const [ b0, b1, b2 ] = box( uint( B.z ) );
					const ext = b1.xyz.mul( b1.w ).mul( vec3( A.w, B.x, A.w ) );
					const c = A.xyz.add( vec3( 0, b0.y.mul( B.x ).add( ext.y.mul( 0.5 ) ), 0 ) );
					const d = length( c.sub( u.eye ) );
					const rr = max( ext.x, max( ext.y, ext.z ) ).mul( 0.75 );
					// meshes draw it closer than its hand-over distance
					const near = select( b2.x.greaterThan( 0.5 ), clamp( b1.x.mul( A.w ).mul( u.focal ).div( FADE_PX ), 22.0, 140.0 ), float( 0.0 ) );
					If( d.greaterThan( near ).and( d.lessThan( u.far ) ), () => {

						const clip = u.viewProj.mul( vec4( c, 1.0 ) );
						const m = rr.mul( 2.0 );
						If( clip.w.greaterThan( rr.negate() ).and( clip.x.abs().lessThan( clip.w.add( m ) ) ).and( clip.y.abs().lessThan( clip.w.add( m ) ) ), () => {

							// occlusion against last frame's depth (crown top and its two sides)
							const top = vec3( c.x, A.y.add( ext.y.mul( 0.95 ) ), c.z );
							const sideV = vec3( u.viewProj.element( 0 ).x, 0, u.viewProj.element( 2 ).x ).normalize().mul( ext.x.mul( 0.45 ) );
							const occluded = occ ? hidden( top ).and( hidden( c.add( sideV ) ) ).and( hidden( c.sub( sideV ) ) ) : null;
							const pushIt = () => {

							// the level whose voxels project to ~1 pixel
							const px = max( ext.x, ext.y ).mul( u.focal ).div( d );
							const lv = clamp( log2( b1.w ).sub( ceil( log2( max( px, 1.0 ) ) ) ), 0.0, b0.w.sub( 1.0 ) );
							const k = atomicAdd( cnt.element( 0 ), uint( 1 ) );
							If( k.lessThan( uint( MAXVIS ) ), () => {

								vis.element( k ).assign( s.bitOr( uint( lv ).shiftLeft( uint( 28 ) ) ) );

							} );

							};
							if ( occ ) If( occluded.not(), pushIt );
							else pushIt();

						} );

					} );

				} );

			} );

		} )().compute( this.slots, [ 256 ] );

	}

	// occlusion culling from last frame's scene depth (reversed depth only)
	setOcclusionDepth( depthTexture ) {

		this.buildCull( depthTexture );

	}

	// sun shadow passes: every plant (near ones too) splatted into the sun-view depth map
	buildShadow() {

		const { inst, vox, table, boxes, shVis, shCnt, shCntRead } = this;
		const texel = SH_EXT * 2 / SH_N;
		const box = ( proto ) => [ boxes.element( proto.mul( 3 ) ), boxes.element( proto.mul( 3 ).add( 1 ) ), boxes.element( proto.mul( 3 ).add( 2 ) ) ];
		this.shClear = Fn( () => {

			atomicStore( shadowAtomic.element( instanceIndex ), uint( 0 ) );
			If( instanceIndex.equal( uint( 0 ) ), () => {

				atomicStore( shCnt.element( 0 ), uint( 0 ) );

			} );

		} )().compute( SH_N * SH_N, [ 256 ] );
		this.shCull = Fn( () => {

			const s = instanceIndex;
			If( s.lessThan( uint( this.slots ) ), () => {

				const A = inst.element( s.mul( 2 ) ), B = inst.element( s.mul( 2 ).add( 1 ) );
				If( A.w.greaterThan( 0.0 ), () => {

					const [ b0, b1 ] = box( uint( B.z ) );
					const ext = b1.xyz.mul( b1.w ).mul( vec3( A.w, B.x, A.w ) );
					const c = A.xyz.add( vec3( 0, b0.y.mul( B.x ).add( ext.y.mul( 0.5 ) ), 0 ) );
					const clip = sunViewProj.mul( vec4( c, 1.0 ) );
					const m = max( ext.x, max( ext.y, ext.z ) ).div( SH_EXT );
					If( clip.x.abs().lessThan( m.add( 1.0 ) ).and( clip.y.abs().lessThan( m.add( 1.0 ) ) ), () => {

						// voxels about two shadow texels, splatted conservatively (below): as the
						// leaves sway, the map's coverage stays solid instead of sparkling
						const px = max( ext.x, ext.y ).div( texel * 2 );
						const lv = clamp( log2( b1.w ).sub( ceil( log2( max( px, 1.0 ) ) ) ), 0.0, b0.w.sub( 1.0 ) );
						const k = atomicAdd( shCnt.element( 0 ), uint( 1 ) );
						If( k.lessThan( uint( MAXVIS_SH ) ), () => {

							shVis.element( k ).assign( s.bitOr( uint( lv ).shiftLeft( uint( 28 ) ) ) );

						} );

					} );

				} );

			} );

		} )().compute( this.slots, [ 256 ] );
		this.shWalk = Fn( () => {

			const wg = instanceIndex.div( WG ), lid = instanceIndex.mod( WG );
			const n = min( shCntRead.element( 0 ), uint( MAXVIS_SH ) );
			Loop( { start: wg, end: n, type: 'uint', condition: '<', update: uint( GROUPS_SH ) }, ( { i: item } ) => {

				const e = shVis.element( item );
				const s = e.bitAnd( uint( 0x0fffffff ) ), lv = e.shiftRight( uint( 28 ) );
				const A = inst.element( s.mul( 2 ) ), B = inst.element( s.mul( 2 ).add( 1 ) );
				const proto = uint( B.z );
				const row = proto.mul( MAXLV ).add( lv );
				const off = table.element( row.mul( 2 ) ), count = table.element( row.mul( 2 ).add( 1 ) );
				const [ b0, b1, b2 ] = box( proto );
				const vsz = b1.xyz.mul( float( uint( 1 ).shiftLeft( lv ) ) );
				const seed = B.w.fract(), lean = B.w.floor().mul( 0.01 );
				const Hh = b2.y.mul( B.x ).max( 0.05 );
				const cs = cos( B.y ), sn = sin( B.y );
				const rot = ( v ) => vec3( v.x.mul( cs ).sub( v.z.mul( sn ) ), v.y, v.x.mul( sn ).add( v.z.mul( cs ) ) );
				const W0 = vec3( 0.96, 0, - 0.28 );
				// a voxel's extent in texels; it covers every texel it overlaps by more than a
				// quarter (at most 4x4)
				const half = max( vsz.x.mul( A.w ), vsz.y.mul( B.x ) ).div( texel ).mul( 0.5 ).min( 2.0 ).toVar();
				Loop( { start: lid, end: count, type: 'uint', condition: '<', update: uint( WG ) }, ( { i: vi } ) => {

					const base = off.add( vi ).mul( 3 );
					const w0 = vox.element( base ), w1 = vox.element( base.add( 1 ) );
					const cov = float( w1.shiftRight( uint( 24 ) ) ).div( 255.0 );
					// (keyed to the plant's own seed, not its slot: the pattern survives tile streaming)
					const h = pcg( uint( seed.mul( 16777216.0 ) ).mul( uint( 2654435761 ) ).bitXor( vi.mul( uint( 40503 ) ) ).add( lv ) );
					If( h.lessThan( cov ), () => {

						const g = vec3( float( w0.bitAnd( uint( 255 ) ) ), float( w0.shiftRight( uint( 8 ) ).bitAnd( uint( 255 ) ) ), float( w0.shiftRight( uint( 16 ) ).bitAnd( uint( 255 ) ) ) );
						const lp = b0.xyz.add( g.add( 0.5 ).mul( vsz ) );
						const hgt = lp.y.mul( B.x ).max( 0.0 );
						const lw = rot( vec3( lp.x.mul( A.w ), hgt, lp.z.mul( A.w ) ) ).toVar();
						const P = A.xyz.add( lw ).add( plantWind( lw, Hh, A.xz, seed ) ).add( W0.mul( lean.mul( hgt ).mul( hgt.div( Hh ) ) ) ).toVar();
						const clip = sunViewProj.mul( vec4( P, 1.0 ) );
						const key = bitcast( float( 1.0 ).sub( clip.z ), 'uint' );
						const sx = clip.x.mul( 0.5 ).add( 0.5 ).mul( SH_N ), sy = float( 0.5 ).sub( clip.y.mul( 0.5 ) ).mul( SH_N );
						const x0 = floor( sx.sub( half ).add( 0.25 ) ), y0 = floor( sy.sub( half ).add( 0.25 ) );
						const nx = uint( clamp( floor( sx.add( half ).sub( 0.25 ) ).sub( x0 ).add( 1.0 ), 1.0, 4.0 ) );
						const ny = uint( clamp( floor( sy.add( half ).sub( 0.25 ) ).sub( y0 ).add( 1.0 ), 1.0, 4.0 ) );
						Loop( { start: uint( 0 ), end: ny, type: 'uint', condition: '<', name: 'oy' }, ( { oy } ) => {

							Loop( { start: uint( 0 ), end: nx, type: 'uint', condition: '<', name: 'ox' }, ( { ox } ) => {

								const x = x0.add( float( ox ) ), y = y0.add( float( oy ) );
								If( x.greaterThanEqual( 0.0 ).and( y.greaterThanEqual( 0.0 ) ).and( x.lessThan( SH_N ) ).and( y.lessThan( SH_N ) ), () => {

									atomicMax( shadowAtomic.element( uint( y ).mul( uint( SH_N ) ).add( uint( x ) ) ), key );

								} );

							} );

						} );

					} );

				} );

			} );

		} )().compute( GROUPS_SH * WG, [ WG ] );

	}

	renderShadow( renderer, camera ) {

		updateSunCamera( camera, U.sunDir.value );
		renderer.compute( this.shClear );
		renderer.compute( this.shCull );
		renderer.compute( this.shWalk );
		shadowOn.value = U.sunDir.value.y > - 0.02 ? 1 : 0;

	}

	// a prototype's meshes arrived: it hands over to them up close
	setMeshReady( i, ready = true ) {

		this.boxAttr.array[ i * 12 + 8 ] = ready ? 1 : 0;
		this.boxAttr.needsUpdate = true;

	}

	build() {

		const { inst, vox, table, boxes, vis, cnt, cntRead, depth, depthRead, color, u } = this;
		const W = u.size.x, H = u.size.y;

		this.clear = Fn( () => {

			const i = instanceIndex;
			If( i.lessThan( uint( W.mul( H ) ) ), () => {

				atomicStore( depth.element( i ), uint( 0 ) );

			} );
			If( i.equal( uint( 0 ) ), () => {

				atomicStore( cnt.element( 0 ), uint( 0 ) );

			} );

		} )().compute( this.maxPix, [ 256 ] );

		const box = ( proto ) => [ boxes.element( proto.mul( 3 ) ), boxes.element( proto.mul( 3 ).add( 1 ) ), boxes.element( proto.mul( 3 ).add( 2 ) ) ];

		this.buildCull();

		const walk = ( shadePass ) => Fn( () => {

			const wg = instanceIndex.div( WG ), lid = instanceIndex.mod( WG );
			const n = min( cntRead.element( 0 ), uint( MAXVIS ) );
			Loop( { start: wg, end: n, type: 'uint', condition: '<', update: uint( GROUPS ) }, ( { i: item } ) => {

				const e = vis.element( item );
				const s = e.bitAnd( uint( 0x0fffffff ) ), lv = e.shiftRight( uint( 28 ) );
				const A = inst.element( s.mul( 2 ) ), B = inst.element( s.mul( 2 ).add( 1 ) );
				const proto = uint( B.z );
				const row = proto.mul( MAXLV ).add( lv );
				const off = table.element( row.mul( 2 ) ), count = table.element( row.mul( 2 ).add( 1 ) );
				const [ b0, b1, b2 ] = box( proto );
				const boxMin = b0.xyz;
				const vsz = b1.xyz.mul( float( uint( 1 ).shiftLeft( lv ) ) );
				const seed = B.w.fract(), lean = B.w.floor().mul( 0.01 );
				const Hh = b2.y.mul( B.x ).max( 0.05 );
				const cs = cos( B.y ), sn = sin( B.y );
				const rot = ( v ) => vec3( v.x.mul( cs ).sub( v.z.mul( sn ) ), v.y, v.x.mul( sn ).add( v.z.mul( cs ) ) );
				const W0 = vec3( 0.96, 0, - 0.28 ); // the prevailing westerly: permanent lean
				const pxScale = max( vsz.x.mul( A.w ), vsz.y.mul( B.x ) ).mul( u.focal );
				// hand-over with the meshes: the cells they keep are theirs
				const dI = length( A.xyz.sub( u.eye ) );
				const d0 = clamp( b1.x.mul( A.w ).mul( u.focal ).div( FADE_PX ), 22.0, 140.0 );
				const meshK = select( b2.x.greaterThan( 0.5 ), float( 1.0 ).sub( smoothstep( d0, d0.mul( FADE_W ), dI ) ), float( 0.0 ) ).toVar();
				const lvS = float( uint( 1 ).shiftLeft( lv ) );
				const shadow = shadePass ? cloudShadowGround( A.xz ).toVar() : null;

				Loop( { start: lid, end: count, type: 'uint', condition: '<', update: uint( WG ) }, ( { i: vi } ) => {

					const base = off.add( vi ).mul( 3 );
					const w0 = vox.element( base ), w1 = vox.element( base.add( 1 ) );
					const cov = float( w1.shiftRight( uint( 24 ) ) ).div( 255.0 );
					// partial coverage drawn stochastically (stable per plant and voxel)
					// (keyed to the plant's own seed, not its slot: the pattern survives tile streaming)
					const h = pcg( uint( seed.mul( 16777216.0 ) ).mul( uint( 2654435761 ) ).bitXor( vi.mul( uint( 40503 ) ) ).add( lv ) );
					If( h.lessThan( cov ), () => {

						const g = vec3( float( w0.bitAnd( uint( 255 ) ) ), float( w0.shiftRight( uint( 8 ) ).bitAnd( uint( 255 ) ) ), float( w0.shiftRight( uint( 16 ) ).bitAnd( uint( 255 ) ) ) );
						const lp = boxMin.add( g.add( 0.5 ).mul( vsz ) );
						const mine = cellHash( g.mul( lvS ).add( lvS.mul( 0.5 ).floor() ), seed ).greaterThanEqual( meshK );
						const hgt = lp.y.mul( B.x ).max( 0.0 );
						const lw = rot( vec3( lp.x.mul( A.w ), hgt, lp.z.mul( A.w ) ) ).toVar();
						const P = A.xyz.add( lw ).add( plantWind( lw, Hh, A.xz, seed ) )
							.add( W0.mul( lean.mul( hgt ).mul( hgt.div( Hh ) ) ) ).toVar();
						const clip = u.viewProj.mul( vec4( P, 1.0 ) );
						If( clip.w.greaterThan( 0.05 ).and( mine ), () => {

							const dist = length( P.sub( u.eye ) );
							const key = bitcast( float( 1.0 ).div( dist ), 'uint' );
							const sx = clip.x.div( clip.w ).mul( 0.5 ).add( 0.5 ).mul( W ), sy = float( 0.5 ).sub( clip.y.div( clip.w ).mul( 0.5 ) ).mul( H );
							const foot = clamp( ceil( pxScale.div( dist ).sub( 0.3 ) ), 1.0, 6.0 );
							const x0 = floor( sx.sub( foot.sub( 1.0 ).mul( 0.5 ) ) ), y0 = floor( sy.sub( foot.sub( 1.0 ).mul( 0.5 ) ) );
							const fi = uint( foot );
							const footprint = ( body ) => Loop( { start: uint( 0 ), end: fi, type: 'uint', condition: '<', name: 'oy' }, ( { oy } ) => {

								Loop( { start: uint( 0 ), end: fi, type: 'uint', condition: '<', name: 'ox' }, ( { ox } ) => {

									const x = x0.add( float( ox ) ), y = y0.add( float( oy ) );
									If( x.greaterThanEqual( 0.0 ).and( y.greaterThanEqual( 0.0 ) ).and( x.lessThan( W ) ).and( y.lessThan( H ) )
										, () => {

										body( uint( y ).mul( uint( W ) ).add( uint( x ) ) );

									} );

								} );

							} );

							if ( ! shadePass ) {

								footprint( ( pi ) => {

									atomicMax( depth.element( pi ), key );

								} );
								return;

							}

							// shade only if this voxel won at least one of its pixels
							const won = uint( 0 ).toVar();
							footprint( ( pi ) => {

								If( depthRead.element( pi ).equal( key ), () => {

									won.assign( uint( 1 ) );

								} );

							} );
							If( won.equal( uint( 1 ) ), () => {

								const w2 = vox.element( base.add( 2 ) );
								const dec = ( word, k ) => float( word.shiftRight( uint( k ) ).bitAnd( uint( 255 ) ) ).div( 255.0 );
								const tint = mix( 0.9, 1.08, seed );
								const albedo = vec3( dec( w1, 0 ), dec( w1, 8 ), dec( w1, 16 ) ).pow( 2.0 ).mul( tint ).toVar();
								const N = normalize( rot( vec3( dec( w2, 0 ), dec( w2, 8 ), dec( w2, 16 ) ).mul( 2.0 ).sub( 1.0 ) ) ).toVar();
								const ao = dec( w2, 24 );
								// the same lighting as the meshes (shadeFoliage): no jump at the hand-over
								const L = U.sunDir;
								const V = normalize( u.eye.sub( P ) );
								const NdL = dot( N, L );
								const aoM = mix( 0.3, 1.0, ao );
								const sunVis = shadow.mul( smoothstep( - 0.04, 0.06, L.y ) ).mul( sunShadowAt( P.add( L.mul( 0.06 ) ) ) ).mul( mix( 0.45, 1.0, ao ) );
								const near = smoothstep( 160.0, 35.0, dist );
								const diff = clamp( NdL.add( 0.4 ).div( 1.4 ), 0.0, 1.0 );
								const ambient = mix( U.groundAmb, U.skyAmb, N.y.mul( 0.5 ).add( 0.5 ) ).mul( aoM );
								const back = pow( clamp( dot( V.negate(), L ), 0.0, 1.0 ), 3.0 );
								const thru = back.mul( mix( 0.35, 1.4, near ) ).add( clamp( NdL.negate(), 0.0, 1.0 ).mul( 0.35 ) );
								const trans = albedo.mul( vec3( 1.25, 1.3, 0.55 ) ).mul( U.sunColor ).mul( thru ).mul( 0.55 ).mul( sunVis );
								const glow = w0.shiftRight( uint( 24 ) );
								const emit = flowerGlow( albedo, glow.equal( uint( 3 ) ), lp, seed ).mul( U.night.mul( U.glow ) );
								const sunL = U.sunColor.mul( diff ).mul( sunVis );
								const col = applyFogFrom( albedo.mul( sunL.add( ambient ) ).add( trans ).add( emit ), P, u.eye ).toVar();
								footprint( ( pi ) => {

									If( depthRead.element( pi ).equal( key ), () => {

										color.element( pi ).assign( packColor( col ) );

									} );

								} );

							} );

						} );

					} );

				} );

			} );

		} )().compute( GROUPS * WG, [ WG ] );

		this.depthPass = walk( false );
		this.colorPass = walk( true );

	}

	// write plant slots [start, start + n) (n x 8 floats); zero sxz = empty slot
	writeSlots( start, data ) {

		this.instAttr.array.set( data, start * 8 );
		this.instAttr.addUpdateRange( start * 8, data.length );
		this.instAttr.needsUpdate = true;

	}

	// visible-plant count for the HUD (async readback, at most one in flight)
	readStats( renderer ) {

		if ( this.reading ) return;
		this.reading = true;
		renderer.getArrayBufferAsync( this.cntAttr ).then( ( b ) => {

			this.visible = new Uint32Array( b )[ 0 ];
			this.reading = false;

		} ).catch( () => {

			this.reading = false;

		} );

	}

	render( renderer, camera ) {

		// (at the scene pass's reduced resolution when the plains upscale temporally, and with
		// the same sub-pixel jitter, so the upscaler accumulates the voxels like everything else)
		const sz = renderer.getDrawingBufferSize( new THREE.Vector2() );
		sz.set( Math.floor( sz.x * this.resScale ), Math.floor( sz.y * this.resScale ) );
		if ( sz.x * sz.y > this.maxPix ) return false;
		this.u.size.value.copy( sz );
		this.u.focal.value = sz.y * 0.5 / Math.tan( THREE.MathUtils.degToRad( camera.fov ) * 0.5 );
		camera.updateMatrixWorld();
		const j = this.jitter ? this.jitter() : null;
		if ( j ) camera.setViewOffset( sz.x, sz.y, j[ 0 ], j[ 1 ], sz.x, sz.y );
		this.u.viewProj.value.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		if ( j ) camera.clearViewOffset();
		this.u.eye.value.copy( camera.position );
		this.renderShadow( renderer, camera ); // first: this frame's voxels receive it too
		renderer.compute( this.clear );
		renderer.compute( this.cull );
		renderer.compute( this.depthPass );
		renderer.compute( this.colorPass );
		return true;

	}

}
