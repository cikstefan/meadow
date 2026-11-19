// A software rasterizer on the GPU for voxel foliage (compute shaders only).
//
//   clear  - per pixel: depth key = 0; resets the visible-list counter
//   cull   - per bush slot: frustum + distance band, picks the voxel level whose
//            voxels project to ~1 pixel, appends (slot, level) to a visible list
//   depth  - persistent workgroups walk the visible list, one bush per workgroup,
//            64 threads over its voxels: project, atomicMax( 1/distance ) per pixel
//   colour - the same walk again; the voxel that won a pixel shades it (sun, sky,
//            cloud shadow, translucency, night glow, fog) and writes its colour
//
// The post pass then takes the voxel colour wherever it is nearer than the scene.
// WebGPU has no 64-bit atomics, so depth and payload can't be packed into one
// atomicMax: the two-pass depth-then-colour resolve is the standard workaround.

import * as THREE from 'three/webgpu';
import {
	Fn, storage, uniform, float, uint, vec2, vec3, vec4, If, Loop, instanceIndex, atomicAdd, atomicMax, atomicStore, atomicLoad,
	bitcast, max, min, clamp, floor, ceil, log2, sqrt, dot, normalize, length, mix, smoothstep, sin, cos, pow, select, exp2, int
} from 'three/tsl';
import { pcg } from '../../../tsl/noise.js';
import { U, windField, applyFogFrom } from '../../../tsl/world.js';
import { cloudShadowGround } from '../index.js';
import { MAXLV, packPrototypes } from './voxelize.js';

const WG = 64, GROUPS = 8192, MAXVIS = 1 << 19;

export class VoxelRaster {

	/**
	 * @param {{voxels:Uint32Array, ranges:Uint32Array, boxes:Float32Array}} baked (packPrototypes)
	 * @param {number} slots plant slots, 8 floats each:
	 *   x y z sxz | sy yaw prototype (seed + 100 * lean)
	 *   (sxz, sy scale the prototype's box; lean: permanent wind-bent shear per metre of height)
	 */
	constructor( protos, slots, { near = 50, far = 1000 } = {} ) {

		const baked = packPrototypes( protos );
		console.log( `voxel raster: ${ protos.length } prototypes, ${ baked.voxels.length / 3 } voxels` );

		this.slots = slots;
		// pixel buffers sized for the largest drawing buffer this screen can have
		const dpr = Math.min( window.devicePixelRatio || 1, 2 );
		this.maxPix = Math.ceil( Math.max( screen.width, window.innerWidth ) * dpr ) * Math.ceil( Math.max( screen.height, window.innerHeight ) * dpr );

		this.instAttr = new THREE.StorageBufferAttribute( new Float32Array( slots * 8 ), 4 );
		this.inst = storage( this.instAttr, 'vec4', slots * 2 ).toReadOnly();
		this.vox = storage( new THREE.StorageBufferAttribute( baked.voxels, 1 ), 'uint', baked.voxels.length ).toReadOnly();
		this.table = storage( new THREE.StorageBufferAttribute( baked.ranges, 1 ), 'uint', baked.ranges.length ).toReadOnly();
		this.boxes = storage( new THREE.StorageBufferAttribute( baked.boxes, 4 ), 'vec4', baked.boxes.length / 4 ).toReadOnly();
		this.vis = storage( new THREE.StorageBufferAttribute( new Uint32Array( MAXVIS ), 1 ), 'uint', MAXVIS );
		this.cntAttr = new THREE.StorageBufferAttribute( new Uint32Array( 4 ), 1 );
		this.cnt = storage( this.cntAttr, 'uint', 4 ).toAtomic();
		// (later dispatches read these plainly: no atomicLoad needed)
		this.cntRead = storage( this.cntAttr, 'uint', 4 ).toReadOnly();
		this.depthAttr = new THREE.StorageBufferAttribute( new Uint32Array( this.maxPix ), 1 );
		this.depth = storage( this.depthAttr, 'uint', this.maxPix ).toAtomic();
		this.colorAttr = new THREE.StorageBufferAttribute( new Float32Array( this.maxPix * 4 ), 4 );
		this.color = storage( this.colorAttr, 'vec4', this.maxPix );
		// read-only views for the post pass
		this.depthRead = storage( this.depthAttr, 'uint', this.maxPix ).toReadOnly();
		this.colorRead = storage( this.colorAttr, 'vec4', this.maxPix ).toReadOnly();

		this.u = {
			viewProj: uniform( new THREE.Matrix4() ), eye: uniform( new THREE.Vector3() ),
			size: uniform( new THREE.Vector2( 1, 1 ) ), focal: uniform( 1000 ), near: uniform( near ), far: uniform( far ),
		};
		this.build();

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

		this.cull = Fn( () => {

			const s = instanceIndex;
			If( s.lessThan( uint( this.slots ) ), () => {

				const A = inst.element( s.mul( 2 ) ), B = inst.element( s.mul( 2 ).add( 1 ) );
				If( A.w.greaterThan( 0.0 ), () => {

					const proto = uint( B.z );
					const b0 = boxes.element( proto.mul( 3 ) ), b1 = boxes.element( proto.mul( 3 ).add( 1 ) ), b2 = boxes.element( proto.mul( 3 ).add( 2 ) );
					const ext = b1.xyz.mul( b1.w ).mul( vec3( A.w, B.x, A.w ) );
					const c = A.xyz.add( vec3( 0, b0.y.mul( B.x ).add( ext.y.mul( 0.5 ) ), 0 ) );
					const d = length( c.sub( u.eye ) );
					const rr = max( ext.x, max( ext.y, ext.z ) ).mul( 0.75 );
					If( d.greaterThan( b2.x ).and( d.lessThan( u.far ) ), () => {

						const clip = u.viewProj.mul( vec4( c, 1.0 ) );
						const m = rr.mul( 2.0 );
						If( clip.w.greaterThan( rr.negate() ).and( clip.x.abs().lessThan( clip.w.add( m ) ) ).and( clip.y.abs().lessThan( clip.w.add( m ) ) ), () => {

							// level whose voxels project to ~1 pixel
							const px = max( ext.x, ext.y ).mul( u.focal ).div( d );
							const lv = clamp( log2( b1.w ).sub( ceil( log2( max( px, 1.0 ) ) ) ), 0.0, b0.w.sub( 1.0 ) );
							const k = atomicAdd( cnt.element( 0 ), uint( 1 ) );
							If( k.lessThan( uint( MAXVIS ) ), () => {

								vis.element( k ).assign( s.bitOr( uint( lv ).shiftLeft( uint( 28 ) ) ) );

							} );

						} );

					} );

				} );

			} );

		} )().compute( this.slots, [ 256 ] );

		// one walk over the visible bushes; `body( ctx )` runs per covered pixel
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
				const b0 = boxes.element( proto.mul( 3 ) ), b1 = boxes.element( proto.mul( 3 ).add( 1 ) );
				const boxMin = b0.xyz;
				const vsz = b1.xyz.mul( float( uint( 1 ).shiftLeft( lv ) ) );
				const seed = B.w.fract(), lean = B.w.floor().mul( 0.01 );
				const cs = cos( B.y ), sn = sin( B.y );
				const rot = ( v ) => vec3( v.x.mul( cs ).sub( v.z.mul( sn ) ), v.y, v.x.mul( sn ).add( v.z.mul( cs ) ) );
				// wind: the gust field bends the whole bush downwind, more toward the top
				const wind = windField( A.xz );
				const phase = dot( A.xz, U.windDir ).mul( 0.42 ).sub( U.windPhase.mul( 0.42 ) ).add( seed.mul( 6.0 ) );
				const sway = sin( phase ).mul( 0.35 ).add( 0.6 );
				const Wd = vec3( U.windDir.x, 0, U.windDir.y );
				const W0 = vec3( 0.96, 0, - 0.28 ); // prevailing westerly: permanent lean
				const pxScale = max( vsz.x.mul( A.w ), vsz.y.mul( B.x ) ).mul( u.focal );
				const shadow = shadePass ? cloudShadowGround( A.xz ).toVar() : null;
				const ext0y = b1.y.mul( b1.w ).mul( B.x );

				Loop( { start: lid, end: count, type: 'uint', condition: '<', update: uint( WG ) }, ( { i: vi } ) => {

					const base = off.add( vi ).mul( 3 );
					const w0 = vox.element( base ), w1 = vox.element( base.add( 1 ) );
					const cov = float( w1.shiftRight( uint( 24 ) ) ).div( 255.0 );
					// partial coverage drawn stochastically (stable per bush and voxel)
					const h = pcg( s.mul( uint( 2654435761 ) ).bitXor( vi.mul( uint( 40503 ) ) ).add( lv ) );
					If( h.lessThan( cov ), () => {

						const g = vec3( float( w0.bitAnd( uint( 255 ) ) ), float( w0.shiftRight( uint( 8 ) ).bitAnd( uint( 255 ) ) ), float( w0.shiftRight( uint( 16 ) ).bitAnd( uint( 255 ) ) ) );
						const lp = boxMin.add( g.add( 0.5 ).mul( vsz ) );
						const hgt = lp.y.mul( B.x ).max( 0.0 );
						const hk = pow( clamp( hgt.div( 1.5 ), 0.0, 1.0 ), 1.4 );
						// wind: live sway (more toward the top) + a permanent downwind lean
						// (wind-shaped growth, like Patagonia's flag trees)
						const P = A.xyz.add( rot( vec3( lp.x.mul( A.w ), hgt, lp.z.mul( A.w ) ) ) )
							.add( Wd.mul( wind.mul( sway ).mul( hk ).mul( 0.18 ) ) ).add( W0.mul( lean.mul( hgt ).mul( hgt.div( max( ext0y, 0.5 ) ) ) ) ).toVar();
						const clip = u.viewProj.mul( vec4( P, 1.0 ) );
						If( clip.w.greaterThan( 0.05 ), () => {

							const dist = length( P.sub( u.eye ) );
							const key = bitcast( float( 1.0 ).div( dist ), 'uint' );
							const sx = clip.x.div( clip.w ).mul( 0.5 ).add( 0.5 ).mul( W ), sy = float( 0.5 ).sub( clip.y.div( clip.w ).mul( 0.5 ) ).mul( H );
							const vpx = pxScale.div( dist );
							const foot = clamp( ceil( vpx.sub( 0.3 ) ), 1.0, 6.0 );
							const x0 = floor( sx.sub( foot.sub( 1.0 ).mul( 0.5 ) ) ), y0 = floor( sy.sub( foot.sub( 1.0 ).mul( 0.5 ) ) );

							let shaded = null;
							if ( shadePass ) shaded = Fn( () => {

								const w2 = vox.element( base.add( 2 ) );
								const dec = ( word, k ) => float( word.shiftRight( uint( k ) ).bitAnd( uint( 255 ) ) ).div( 255.0 );
								const tint = mix( 0.85, 1.12, seed );
								const albedo = vec3( dec( w1, 0 ), dec( w1, 8 ), dec( w1, 16 ) ).pow( 2.0 ).mul( tint ).mul( 1.12 );
								const N = normalize( rot( vec3( dec( w2, 0 ), dec( w2, 8 ), dec( w2, 16 ) ).mul( 2.0 ).sub( 1.0 ) ) );
								const ao = dec( w2, 24 );
								const L = U.sunDir;
								const V = normalize( u.eye.sub( P ) );
								const NdL = dot( N, L );
								const sunVis = shadow.mul( smoothstep( - 0.04, 0.06, L.y ) );
								const diff = clamp( NdL.add( 0.45 ).div( 1.45 ), 0.0, 1.0 );
								const ambient = mix( U.groundAmb, U.skyAmb, N.y.mul( 0.5 ).add( 0.5 ) ).mul( ao );
								const back = pow( clamp( dot( V.negate(), L ), 0.0, 1.0 ), 3.0 );
								const thru = back.mul( 0.6 ).add( clamp( NdL.negate(), 0.0, 1.0 ).mul( 0.35 ) );
								const trans = albedo.mul( vec3( 1.25, 1.3, 0.55 ) ).mul( U.sunColor ).mul( thru ).mul( 0.45 ).mul( sunVis );
								// night: notro flowers glow red, calafate cups yellow
								const glow = w0.shiftRight( uint( 24 ) );
								const varyF = mix( 0.25, 1.9, pcg( s.add( uint( 77 ) ) ).pow( 1.5 ) );
								// own-colour glow (jose flowers): saturated petal light, Pandora-like
								const al = dot( albedo, vec3( 0.2126, 0.7152, 0.0722 ) );
								const emitO = mix( vec3( al ), albedo, 1.8 ).max( 0.0 ).div( max( albedo.x, max( albedo.y, albedo.z ) ).add( 0.03 ) ).mul( 0.22 );
								const farK = smoothstep( 900.0, 300.0, dist ).mul( 0.55 ).add( 0.45 );
								const emitR = albedo.mul( vec3( 2.2, 1.2, 1.1 ) ).add( vec3( 0.6, 0.12, 0.07 ) ).mul( 0.16 );
								const emitY = vec3( 1.0, 0.75, 0.2 ).mul( 0.14 );
								const emit = select( glow.equal( uint( 1 ) ), emitR, select( glow.equal( uint( 2 ) ), emitY, select( glow.equal( uint( 3 ) ), emitO, vec3( 0 ) ) ) )
									.mul( U.night.mul( U.glow ).mul( farK ).mul( varyF ) );
								const col = albedo.mul( U.sunColor.mul( diff ).mul( sunVis ).add( ambient ) ).add( trans ).add( emit );
								return applyFogFrom( col, P, u.eye );

							} )().toVar();

							const fi = uint( foot );
							Loop( { start: uint( 0 ), end: fi, type: 'uint', condition: '<', name: 'oy' }, ( { oy } ) => {

								Loop( { start: uint( 0 ), end: fi, type: 'uint', condition: '<', name: 'ox' }, ( { ox } ) => {

									const x = x0.add( float( ox ) ), y = y0.add( float( oy ) );
									If( x.greaterThanEqual( 0.0 ).and( y.greaterThanEqual( 0.0 ) ).and( x.lessThan( W ) ).and( y.lessThan( H ) ), () => {

										const pi = uint( y ).mul( uint( W ) ).add( uint( x ) );
										if ( shadePass ) {

											If( depthRead.element( pi ).equal( key ), () => {

												color.element( pi ).assign( vec4( shaded, 1.0 ) );

											} );

										} else {

											atomicMax( depth.element( pi ), key );

										}

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

	// write bush slots [start, start + n) (n x 8 floats); zero rad = empty slot
	writeSlots( start, data ) {

		const a = this.instAttr.array;
		a.set( data, start * 8 );
		this.instAttr.addUpdateRange( start * 8, data.length );
		this.instAttr.needsUpdate = true;

	}

	// visible-bush count for the HUD (async readback, at most one in flight)
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

		const sz = renderer.getDrawingBufferSize( new THREE.Vector2() );
		if ( sz.x * sz.y > this.maxPix ) return false;
		this.u.size.value.copy( sz );
		this.u.focal.value = sz.y * 0.5 / Math.tan( THREE.MathUtils.degToRad( camera.fov ) * 0.5 );
		camera.updateMatrixWorld();
		this.u.viewProj.value.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		this.u.eye.value.copy( camera.position );
		renderer.compute( this.clear );
		renderer.compute( this.cull );
		renderer.compute( this.depthPass );
		renderer.compute( this.colorPass );
		return true;

	}

}
