// Small helpers for GPU-driven instancing.
//
// WebGPU guarantees only 8 storage buffers per shader stage, so all LODs of a
// system share ONE indirect-args buffer (one drawIndexedIndirect record per
// LOD, addressed with a byte offset) and ONE visible-index buffer (LOD i owns
// the range [i * capacity, (i + 1) * capacity)).

import * as THREE from 'three/webgpu';
import { Fn, storage, struct, uint, float, If, atomicAdd, atomicStore } from 'three/tsl';

export function storageVec( count, itemSize, type, fill = 0 ) {

	const data = new Float32Array( count * itemSize );
	if ( fill !== 0 ) data.fill( fill );
	const attr = new THREE.StorageInstancedBufferAttribute( data, itemSize );
	return storage( attr, type, count );

}

// drawIndexedIndirect layout: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
const drawStruct = struct( {
	indexCount: 'uint',
	instanceCount: { type: 'uint', atomic: true },
	firstIndex: 'uint',
	baseVertex: 'uint',
	firstInstance: 'uint',
} );

/**
 * @param {Array<{geometry:THREE.BufferGeometry, maxDistance:number}>} defs
 * @param {number} capacity max instances per LOD
 */
export function createLODs( defs, capacity ) {

	const L = defs.length;
	const drawBuffer = new THREE.IndirectStorageBufferAttribute( new Uint32Array( 5 * L ), 5 );
	const draw = storage( drawBuffer, drawStruct, L );
	const indices = storage( new THREE.StorageInstancedBufferAttribute( new Uint32Array( capacity * L ), 1 ), 'uint', capacity * L );

	const lods = defs.map( ( def, i ) => {

		def.geometry.setIndirect( drawBuffer, i * 5 * 4 );
		return {
			...def,
			index: i,
			offset: i * capacity,
			indexCount: def.geometry.index.count,
		};

	} );

	return { lods, drawBuffer, draw, indices, capacity };

}

export function createResetCompute( set ) {

	return Fn( () => {

		for ( const lod of set.lods ) {

			const d = set.draw.element( lod.index );
			d.get( 'indexCount' ).assign( uint( lod.indexCount ) );
			atomicStore( d.get( 'instanceCount' ), uint( 0 ) );
			d.get( 'firstIndex' ).assign( uint( 0 ) );
			d.get( 'baseVertex' ).assign( uint( 0 ) );
			d.get( 'firstInstance' ).assign( uint( 0 ) );

		}

	} )().compute( 1 );

}

// Appends `index` to the visible list of the LOD band containing `dist`.
export function routeLOD( set, dist, index ) {

	const { lods } = set;
	const push = ( lod ) => {

		const slot = atomicAdd( set.draw.element( lod.index ).get( 'instanceCount' ), uint( 1 ) );
		set.indices.element( slot.add( uint( lod.offset ) ) ).assign( index );

	};

	const chain = ( i ) => {

		const lod = lods[ i ];
		if ( i === lods.length - 1 ) {

			push( lod );
			return;

		}

		If( dist.lessThan( float( lod.maxDistance ) ), () => push( lod ) ).Else( () => chain( i + 1 ) );

	};

	chain( 0 );

}

// visible instance -> slot index, for use in a LOD's vertex shader
export const visibleSlot = ( set, lod, instanceIndex ) => set.indices.element( instanceIndex.add( uint( lod.offset ) ) );

// release GPU buffers of storage nodes / attributes (quality switches rebuild everything)
export function disposeStorage( ...items ) {

	for ( const it of items ) {

		const attr = it && it.isNode ? it.value : it;
		if ( attr && attr.dispatchEvent ) attr.dispatchEvent( { type: 'dispose' } );

	}

}
