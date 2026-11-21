// Plants from the jose specimen generator (tools/jose-bake): 12 species, several cultivars
// each (different flower colours, leaf forms), two growth stages. Each prototype has a voxel
// pyramid (far) and up to three mesh LODs (near: the grown geometry, vertex colours from
// jose's own shading). Voxels load first; meshes stream in per species afterwards.

import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { vnoiseJS } from '../../../tsl/noise.js';
import pack from '../../../assets/plains/vox/jose.json';

const meta = pack.protos;
// photo scans (jose's tex/, CC0) used by the meshes: url + linear mean colour + strength
const SCANS = import.meta.glob( '../../../assets/plains/vox/tex/*.webp', { query: '?url', import: 'default', eager: true } );
export const scanInfo = ( name ) => ( { url: SCANS[ `../../../assets/plains/vox/tex/${ name }.webp` ], ...pack.textures[ name ] } );

const FILES = import.meta.glob( '../../../assets/plains/vox/*.wasm', { query: '?url', import: 'default', eager: true } );
const fileUrl = ( name ) => FILES[ `../../../assets/plains/vox/jose-${ name }.wasm` ];

// placement: weight in the mix, drift scale (m: each species owns patches), wind lean
export const JOSE_SPECIES = {
	// jose's Patagonia library. `windBaked`: the plant grew under jose's westerly (windLean),
	// leaning toward its local +x; it is turned so that lean points downwind on the plains.
	// size: random scale range; drift: patch size (m) of the species' own drifts; k: its noise id
	notro: { drift: 70, lean: 0, windBaked: true, size: [ 0.75, 1.2 ] },
	calafate: { drift: 45, lean: 0, windBaked: true, size: [ 0.7, 1.2 ] },
	matanegra: { drift: 55, lean: 0, windBaked: true, size: [ 0.7, 1.25 ] },
	chaura: { drift: 30, lean: 0, windBaked: true, size: [ 0.7, 1.3 ] },
	neneo: { drift: 40, lean: 0, size: [ 0.7, 1.3 ] },
	chuquiraga: { drift: 50, lean: 0.05, size: [ 0.75, 1.2 ] },
	coiron: { drift: 35, lean: 0, windBaked: true, size: [ 0.7, 1.3 ] },
	lenga: { drift: 60, lean: 0, windBaked: true, size: [ 0.8, 1.15 ] },
	nirre: { drift: 50, lean: 0, windBaked: true, size: [ 0.75, 1.2 ] },
	snag: { drift: 45, lean: 0, windBaked: true, size: [ 0.8, 1.2 ] },
	sisyrinchium: { drift: 22, lean: 0.03, size: [ 0.8, 1.2 ] },
	anemona: { drift: 25, lean: 0.03, size: [ 0.8, 1.2 ] },
	chloraea: { drift: 25, lean: 0.02, size: [ 0.8, 1.2 ] },
	lupin: { drift: 40, lean: 0.06, size: [ 0.75, 1.25 ] }, // naturalised lupins: drifts of lilac, pink, purple and white spires
};
Object.values( JOSE_SPECIES ).forEach( ( S, i ) => ( S.k = i + 1 ) );

const fetchBuf = ( url ) => fetch( url ).then( ( r ) => r.arrayBuffer() ).then( ( b ) => new Uint8Array( b ) );

// fetch several files, reporting the fraction of all their bytes received
async function fetchAll( urls, onProgress ) {

	const got = urls.map( () => 0 ), size = urls.map( () => 0 );
	const report = () => {

		const total = size.reduce( ( a, b ) => a + b, 0 );
		if ( onProgress && total ) onProgress( got.reduce( ( a, b ) => a + b, 0 ) / total * ( size.every( Boolean ) ? 1 : 0.9 ) );

	};
	return Promise.all( urls.map( async ( url, i ) => {

		const r = await fetch( url );
		size[ i ] = + r.headers.get( 'content-length' ) || 0;
		if ( ! r.body || ! size[ i ] ) {

			const b = new Uint8Array( await r.arrayBuffer() );
			got[ i ] = size[ i ] = b.length; report();
			return b;

		}

		const out = new Uint8Array( size[ i ] ), reader = r.body.getReader();
		for ( ;; ) {

			const { done, value } = await reader.read();
			if ( done ) break;
			out.set( value, got[ i ] );
			got[ i ] += value.length; report();

		}

		return got[ i ] === size[ i ] ? out : out.subarray( 0, got[ i ] );

	} ) );

}

export async function loadJose( onProgress ) {

	await MeshoptDecoder.ready;
	const species = [ ...new Set( meta.map( ( m ) => m.sp ) ) ];
	// the voxels and the near-field meshes both load behind the loader (no voxel-only first
	// seconds on the plain)
	const bufs = await fetchAll( [ ...species.map( ( sp ) => fileUrl( sp + '.vox' ) ), ...species.map( ( sp ) => fileUrl( sp + '.mesh' ) ) ], onProgress );
	const vox = Object.fromEntries( species.map( ( sp, i ) => [ sp, bufs[ i ] ] ) );
	const meshBufs = Object.fromEntries( species.map( ( sp, i ) => [ sp, bufs[ species.length + i ] ] ) );
	const protos = meta.map( ( m ) => {

		const src = vox[ m.sp ].subarray( m.vox.off, m.vox.off + m.vox.len );
		const words = new Uint32Array( m.vox.n * 3 );
		MeshoptDecoder.decodeVertexBuffer( new Uint8Array( words.buffer ), m.vox.n, 12, src );
		let o = 0;
		const levels = m.vox.counts.map( ( c ) => {

			const L = words.subarray( o, o + c * 3 );
			o += c * 3;
			return L;

		} );
		return { levels, info: { min: m.vox.min, vsz: m.vox.vsz, res: m.vox.res }, height: m.height, sp: m.sp, t: m.t, seed: m.seed, cultivar: m.cultivar, meta: m, mesh: null };

	} );
	const bySp = {};
	protos.forEach( ( p, i ) => ( bySp[ p.sp ] = bySp[ p.sp ] || [] ).push( i ) );
	return { protos, bySp, species, meshBufs };

}

// stream every species' meshes in the background; onReady( protoIndex ) per prototype
export async function streamJoseMeshes( jose, onReady ) {

	for ( const sp of jose.species ) {

		let buf;
		try {

			buf = jose.meshBufs && jose.meshBufs[ sp ] ? jose.meshBufs[ sp ] : await fetchBuf( fileUrl( sp + '.mesh' ) );

		} catch ( e ) {

			console.warn( 'jose meshes', sp, e );
			continue;

		}

		for ( const i of jose.bySp[ sp ] ) {

			const p = jose.protos[ i ];
			p.mesh = { buf, lods: p.meta.lods };
			onReady( i );

		}

	}

}

// decode one mesh LOD into plain arrays (on first use)
export function decodeLOD( p, l ) {

	const L = p.mesh.lods[ l ];
	if ( ! L ) return null;
	if ( L.decoded ) return L.decoded;
	const S = 16;
	const vb = new Uint8Array( L.verts * S );
	MeshoptDecoder.decodeVertexBuffer( vb, L.verts, S, p.mesh.buf.subarray( L.vOff, L.vOff + L.vLen ) );
	const idx = new Uint32Array( L.tris * 3 );
	MeshoptDecoder.decodeIndexBuffer( new Uint8Array( idx.buffer ), idx.length, 4, p.mesh.buf.subarray( L.iOff, L.iOff + L.iLen ) );
	const dv = new DataView( vb.buffer ), pos = new Float32Array( L.verts * 3 ), nrm = new Float32Array( L.verts * 3 ), col = new Uint8Array( L.verts * 4 ), uv = new Float32Array( L.verts * 2 );
	for ( let i = 0; i < L.verts; i ++ ) {

		for ( let a = 0; a < 3; a ++ ) pos[ i * 3 + a ] = L.min[ a ] + dv.getUint16( i * S + a * 2, true ) / 65535 * L.size[ a ];
		for ( let a = 0; a < 2; a ++ ) uv[ i * 2 + a ] = L.uvMin[ a ] + dv.getUint16( i * S + 12 + a * 2, true ) / 65535 * L.uvSize[ a ];
		// octahedral normal
		let x = vb[ i * S + 6 ] / 255 * 2 - 1, z = vb[ i * S + 7 ] / 255 * 2 - 1;
		let y = 1 - Math.abs( x ) - Math.abs( z );
		if ( y < 0 ) {

			const ox = x;
			x = ( 1 - Math.abs( z ) ) * Math.sign( ox || 1 ); z = ( 1 - Math.abs( ox ) ) * Math.sign( z || 1 );

		}

		const l2 = Math.hypot( x, y, z ) || 1;
		nrm[ i * 3 ] = x / l2; nrm[ i * 3 + 1 ] = y / l2; nrm[ i * 3 + 2 ] = z / l2;
		for ( let a = 0; a < 4; a ++ ) col[ i * 4 + a ] = vb[ i * S + 8 + a ];

	}

	L.decoded = { pos, nrm, col, idx, uv, groups: L.groups };
	return L.decoded;

}

// species picked by smooth drift fields (each species owns patches of the plain)
export function pickJose( x, z, r, bySp ) {

	let best = null, bw = 0, k = 0;
	for ( const [ sp, S ] of Object.entries( JOSE_SPECIES ) ) {

		k ++;
		if ( ! S.w || ! bySp[ sp ] ) continue;
		const f = vnoiseJS( x / S.drift + k * 13.1, z / S.drift + k * 7.7 );
		const w = S.w * Math.pow( Math.max( 0, f - 0.35 ) / 0.65, 2 ) * ( 0.6 + 0.8 * r() );
		if ( w > bw ) {

			bw = w; best = sp;

		}

	}

	return bw > 0.1 ? best : null;

}
