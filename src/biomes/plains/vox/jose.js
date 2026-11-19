// Plants from the jose specimen generator (tools/jose-bake): 12 species, several cultivars
// each (different flower colours, leaf forms), two growth stages. Each prototype has a voxel
// pyramid (far) and up to three mesh LODs (near: the grown geometry, vertex colours from
// jose's own shading). Voxels load first; meshes stream in per species afterwards.

import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { vnoiseJS } from '../../../tsl/noise.js';
import meta from '../../../assets/plains/vox/jose.json';

const FILES = import.meta.glob( '../../../assets/plains/vox/*.wasm', { query: '?url', import: 'default', eager: true } );
const fileUrl = ( name ) => FILES[ `../../../assets/plains/vox/jose-${ name }.wasm` ];

// placement: weight in the mix, drift scale (m: each species owns patches), wind lean
export const JOSE_SPECIES = {
	oleander: { w: 1.0, drift: 70, lean: 0.18 },
	gypso: { w: 0.8, drift: 35, lean: 0.05 },
	clero: { w: 0.55, drift: 45, lean: 0.1 },
	stipa: { w: 1.6, drift: 60, lean: 0.08 },
	hakone: { w: 0.9, drift: 50, lean: 0.06 },
	festuca: { w: 1.3, drift: 55, lean: 0.05 },
	benjamina: { w: 0.16, drift: 130, lean: 0.25 },
	plumeria: { w: 0.14, drift: 150, lean: 0.2 },
	cotinus: { w: 0.22, drift: 100, lean: 0.2 },
	olive: { w: 0.2, drift: 170, lean: 0.3 },
	echium: { w: 0.45, drift: 70, lean: 0.12 },
	mugo: { w: 0.3, drift: 110, lean: 0.35 },
};

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
	const bufs = await fetchAll( species.map( ( sp ) => fileUrl( sp + '.vox' ) ), onProgress );
	const vox = Object.fromEntries( species.map( ( sp, i ) => [ sp, bufs[ i ] ] ) );
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
	return { protos, bySp, species };

}

// stream every species' meshes in the background; onReady( protoIndex ) per prototype
export async function streamJoseMeshes( jose, onReady ) {

	for ( const sp of jose.species ) {

		let buf;
		try {

			buf = await fetchBuf( fileUrl( sp + '.mesh' ) );

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
	const vb = new Uint8Array( L.verts * 12 );
	MeshoptDecoder.decodeVertexBuffer( vb, L.verts, 12, p.mesh.buf.subarray( L.vOff, L.vOff + L.vLen ) );
	const idx = new Uint32Array( L.tris * 3 );
	MeshoptDecoder.decodeIndexBuffer( new Uint8Array( idx.buffer ), idx.length, 4, p.mesh.buf.subarray( L.iOff, L.iOff + L.iLen ) );
	const dv = new DataView( vb.buffer ), pos = new Float32Array( L.verts * 3 ), nrm = new Float32Array( L.verts * 3 ), col = new Uint8Array( L.verts * 4 );
	for ( let i = 0; i < L.verts; i ++ ) {

		for ( let a = 0; a < 3; a ++ ) pos[ i * 3 + a ] = L.min[ a ] + dv.getUint16( i * 12 + a * 2, true ) / 65535 * L.size[ a ];
		// octahedral normal
		let x = vb[ i * 12 + 6 ] / 255 * 2 - 1, z = vb[ i * 12 + 7 ] / 255 * 2 - 1;
		let y = 1 - Math.abs( x ) - Math.abs( z );
		if ( y < 0 ) {

			const ox = x;
			x = ( 1 - Math.abs( z ) ) * Math.sign( ox || 1 ); z = ( 1 - Math.abs( ox ) ) * Math.sign( z || 1 );

		}

		const l2 = Math.hypot( x, y, z ) || 1;
		nrm[ i * 3 ] = x / l2; nrm[ i * 3 + 1 ] = y / l2; nrm[ i * 3 + 2 ] = z / l2;
		for ( let a = 0; a < 4; a ++ ) col[ i * 4 + a ] = vb[ i * 12 + 8 + a ];

	}

	L.decoded = { pos, nrm, col, idx };
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
