// CPU mesh refinement for skinned game models (run once at load):
//  - subdivideSkinned: 1->4 triangle split with interpolated UVs and blended
//    skin weights (union of both endpoints' influences, top 4 kept), followed by
//    Taubin smoothing (shrink-free Laplacian) with open-boundary vertices pinned
//    so seams between separate sub-meshes stay closed.
//  - smoothNormals: area-weighted vertex normals welded by position across
//    several meshes, removing faceting and hard seams in the shading.

import * as THREE from 'three/webgpu';

function readAttr( attr ) {

	const n = attr.count, k = attr.itemSize, out = new Float32Array( n * k );
	for ( let i = 0; i < n; i ++ ) for ( let c = 0; c < k; c ++ ) out[ i * k + c ] = attr.getComponent( i, c );
	return out;

}

function weldKeys( pos, n, scale ) {

	const map = new Map(), ids = new Int32Array( n );
	let next = 0;
	for ( let i = 0; i < n; i ++ ) {

		const key = Math.round( pos[ i * 3 ] * scale ) + ',' + Math.round( pos[ i * 3 + 1 ] * scale ) + ',' + Math.round( pos[ i * 3 + 2 ] * scale );
		let id = map.get( key );
		if ( id === undefined ) {

			id = next ++;
			map.set( key, id );

		}

		ids[ i ] = id;

	}

	return { ids, count: next };

}

export function subdivideSkinned( geometry, { iterations = 2, lambda = 0.5, mu = - 0.53 } = {} ) {

	const g = geometry;
	const pos0 = readAttr( g.attributes.position );
	const n0 = g.attributes.position.count;
	const uv0 = g.attributes.uv ? readAttr( g.attributes.uv ) : null;
	const uv10 = g.attributes.uv1 ? readAttr( g.attributes.uv1 ) : null;
	const si0 = readAttr( g.attributes.skinIndex );
	const sw0 = readAttr( g.attributes.skinWeight );
	const idx0 = g.index ? Array.from( g.index.array ) : [ ...Array( n0 ).keys() ];

	// ---- split edges
	const P = Array.from( pos0 ), UV = uv0 ? Array.from( uv0 ) : null, UV1 = uv10 ? Array.from( uv10 ) : null;
	const SI = Array.from( si0 ), SW = Array.from( sw0 );
	const edgeMid = new Map();
	const mid = ( a, b ) => {

		const key = a < b ? a * 1e7 + b : b * 1e7 + a;
		let m = edgeMid.get( key );
		if ( m !== undefined ) return m;
		m = P.length / 3;
		for ( let c = 0; c < 3; c ++ ) P.push( ( P[ a * 3 + c ] + P[ b * 3 + c ] ) * 0.5 );
		if ( UV ) for ( let c = 0; c < 2; c ++ ) UV.push( ( UV[ a * 2 + c ] + UV[ b * 2 + c ] ) * 0.5 );
		if ( UV1 ) for ( let c = 0; c < 2; c ++ ) UV1.push( ( UV1[ a * 2 + c ] + UV1[ b * 2 + c ] ) * 0.5 );
		// blend skin influences
		const w = new Map();
		for ( const v of [ a, b ] ) for ( let c = 0; c < 4; c ++ ) {

			const bi = SI[ v * 4 + c ], bw = SW[ v * 4 + c ] * 0.5;
			if ( bw > 0 ) w.set( bi, ( w.get( bi ) || 0 ) + bw );

		}

		const top = [ ...w.entries() ].sort( ( x, y ) => y[ 1 ] - x[ 1 ] ).slice( 0, 4 );
		const sum = top.reduce( ( s, e ) => s + e[ 1 ], 0 ) || 1;
		for ( let c = 0; c < 4; c ++ ) {

			SI.push( top[ c ] ? top[ c ][ 0 ] : 0 );
			SW.push( top[ c ] ? top[ c ][ 1 ] / sum : 0 );

		}

		edgeMid.set( key, m );
		return m;

	};

	const idx = [];
	for ( let t = 0; t < idx0.length; t += 3 ) {

		const a = idx0[ t ], b = idx0[ t + 1 ], c = idx0[ t + 2 ];
		const ab = mid( a, b ), bc = mid( b, c ), ca = mid( c, a );
		idx.push( a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca );

	}

	// ---- Taubin smoothing on welded positions, boundary pinned
	const n = P.length / 3;
	const bb = new THREE.Box3().setFromArray( P );
	const scale = 2e4 / Math.max( 1e-6, bb.getSize( new THREE.Vector3() ).length() );
	const { ids, count } = weldKeys( P, n, scale );
	const neigh = Array.from( { length: count }, () => new Set() );
	const edgeUse = new Map();
	for ( let t = 0; t < idx.length; t += 3 ) for ( let e = 0; e < 3; e ++ ) {

		const a = ids[ idx[ t + e ] ], b = ids[ idx[ t + ( e + 1 ) % 3 ] ];
		neigh[ a ].add( b ); neigh[ b ].add( a );
		const key = a < b ? a * 1e7 + b : b * 1e7 + a;
		edgeUse.set( key, ( edgeUse.get( key ) || 0 ) + 1 );

	}

	const pinned = new Uint8Array( count );
	for ( const [ key, uses ] of edgeUse ) if ( uses === 1 ) {

		pinned[ Math.floor( key / 1e7 ) ] = 1;
		pinned[ key % 1e7 ] = 1;

	}

	const W = new Float64Array( count * 3 );
	for ( let i = 0; i < n; i ++ ) for ( let c = 0; c < 3; c ++ ) W[ ids[ i ] * 3 + c ] = P[ i * 3 + c ];
	const step = ( f ) => {

		const D = new Float64Array( count * 3 );
		for ( let v = 0; v < count; v ++ ) {

			if ( pinned[ v ] || neigh[ v ].size === 0 ) continue;
			let x = 0, y = 0, z = 0;
			for ( const u of neigh[ v ] ) {

				x += W[ u * 3 ]; y += W[ u * 3 + 1 ]; z += W[ u * 3 + 2 ];

			}

			const k = 1 / neigh[ v ].size;
			D[ v * 3 ] = ( x * k - W[ v * 3 ] ) * f;
			D[ v * 3 + 1 ] = ( y * k - W[ v * 3 + 1 ] ) * f;
			D[ v * 3 + 2 ] = ( z * k - W[ v * 3 + 2 ] ) * f;

		}

		for ( let i = 0; i < W.length; i ++ ) W[ i ] += D[ i ];

	};

	for ( let it = 0; it < iterations; it ++ ) {

		step( lambda );
		step( mu );

	}

	for ( let i = 0; i < n; i ++ ) for ( let c = 0; c < 3; c ++ ) P[ i * 3 + c ] = W[ ids[ i ] * 3 + c ];

	const out = new THREE.BufferGeometry();
	out.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	if ( UV ) out.setAttribute( 'uv', new THREE.Float32BufferAttribute( UV, 2 ) );
	if ( UV1 ) out.setAttribute( 'uv1', new THREE.Float32BufferAttribute( UV1, 2 ) );
	out.setAttribute( 'skinIndex', new THREE.Uint16BufferAttribute( SI, 4 ) );
	out.setAttribute( 'skinWeight', new THREE.Float32BufferAttribute( SW, 4 ) );
	out.setIndex( idx );
	out.groups = [];
	return out;

}

/**
 * Smooth, seam-free normals across several meshes (welded in model space).
 * @param {THREE.Mesh[]} meshes meshes whose matrixWorld is relative to a common root
 */
export function smoothNormals( meshes, root ) {

	root.updateMatrixWorld( true );
	const rootInv = new THREE.Matrix4().copy( root.matrixWorld ).invert();
	const data = meshes.map( ( m ) => {

		const g = m.geometry;
		const M = new THREE.Matrix4().multiplyMatrices( rootInv, m.matrixWorld );
		const p = readAttr( g.attributes.position );
		const n = g.attributes.position.count;
		const w = new Float32Array( n * 3 );
		const v = new THREE.Vector3();
		for ( let i = 0; i < n; i ++ ) {

			v.fromArray( p, i * 3 ).applyMatrix4( M );
			v.toArray( w, i * 3 );

		}

		return { g, M, w, n };

	} );

	const all = data.reduce( ( s, d ) => s + d.n, 0 );
	const big = new Float32Array( all * 3 );
	let o = 0;
	for ( const d of data ) {

		big.set( d.w, o * 3 );
		d.offset = o;
		o += d.n;

	}

	const bb = new THREE.Box3().setFromArray( big );
	const { ids, count } = weldKeys( big, all, 2e4 / bb.getSize( new THREE.Vector3() ).length() );
	const acc = new Float64Array( count * 3 );
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
	for ( const d of data ) {

		const idx = d.g.index ? d.g.index.array : [ ...Array( d.n ).keys() ];
		for ( let t = 0; t < idx.length; t += 3 ) {

			a.fromArray( d.w, idx[ t ] * 3 ); b.fromArray( d.w, idx[ t + 1 ] * 3 ); c.fromArray( d.w, idx[ t + 2 ] * 3 );
			e1.subVectors( b, a ); e2.subVectors( c, a );
			const fn = e1.cross( e2 ); // area weighted
			for ( let k = 0; k < 3; k ++ ) {

				const id = ids[ d.offset + idx[ t + k ] ];
				acc[ id * 3 ] += fn.x; acc[ id * 3 + 1 ] += fn.y; acc[ id * 3 + 2 ] += fn.z;

			}

		}

	}

	for ( const d of data ) {

		const lin = new THREE.Matrix3().setFromMatrix4( d.M ).transpose(); // world -> local for normals
		const out = new Float32Array( d.n * 3 );
		const nv = new THREE.Vector3();
		for ( let i = 0; i < d.n; i ++ ) {

			const id = ids[ d.offset + i ];
			nv.set( acc[ id * 3 ], acc[ id * 3 + 1 ], acc[ id * 3 + 2 ] ).applyMatrix3( lin ).normalize();
			nv.toArray( out, i * 3 );

		}

		d.g.setAttribute( 'normal', new THREE.Float32BufferAttribute( out, 3 ) );

	}

}
