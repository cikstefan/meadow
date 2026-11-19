// Pack the captured jose plants (capture.cjs output) into the app's assets:
//   node pack.cjs /tmp/jvox ../../src/assets/plains/vox
// jose.json: per prototype (species, seed, growth stage, cultivar, height in m): its voxel
// pyramid and three mesh LODs, as ranges of
// jose-<species>.vox.wasm / .mesh.wasm: meshoptimizer-compressed buffers (voxels load first, meshes stream in) (named .wasm only so static hosts serve
// the bytes untouched). Voxels: 12-byte words (see voxelize.js). Mesh vertices: 12 bytes =
// 16 bytes = position u16 x3 (in the LOD's box) | octahedral normal u8 x2 | colour sqrt-rgb u8 x3 | kind << 6 | ao
// | uv u16 x2 (in the LOD's uv box); triangles grouped by photo scan.
const fs = require( 'fs' );
const path = require( 'path' );

( async () => {

	const { MeshoptEncoder, MeshoptSimplifier } = await import( 'meshoptimizer' );
	await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
	const LOD0_MAX = 90000;
	const TEX_SRC = process.env.JOSE_TEX || '/home/user/jose/plants/tex', TEXS = {}; // triangles in the closest mesh LOD (mature plants only; young ones start at LOD1)
	const [ inDir, outDir ] = process.argv.slice( 2 );
	fs.mkdirSync( outDir, { recursive: true } );
	const files = fs.readdirSync( inDir ).filter( ( f ) => f.endsWith( '.json' ) ).sort();
	const protos = [], files2 = {};
	let chunks = null, off = 0, cur = null;
	const put = ( u8 ) => {

		const pad = ( 4 - u8.length % 4 ) % 4;
		const at = off;
		chunks.push( Buffer.from( u8.buffer, u8.byteOffset, u8.byteLength ), Buffer.alloc( pad ) );
		off += u8.length + pad;
		return [ at, u8.length ];

	};
	let raw = 0;
	for ( const f of files ) {

		const m = JSON.parse( fs.readFileSync( path.join( inDir, f ) ) );
		for ( const k of [ m.sp + '.vox', m.sp + '.mesh' ] ) if ( ! files2[ k ] ) files2[ k ] = { chunks: [], off: 0 };
		const use = ( k ) => {

			if ( chunks ) files2[ cur ].off = off;
			cur = k; chunks = files2[ k ].chunks; off = files2[ k ].off;

		};
		chunks = null; use( m.sp + '.vox' );
		const buf = fs.readFileSync( path.join( inDir, f.replace( '.json', '.raw' ) ) );
		raw += buf.length;
		const s = m.scale;
		// materials: photo scan (full-resolution file when there is one), card mode, colours
		const mats = ( m.texs || [] ).map( ( t ) => {

			let name = null;
			if ( t.name ) {

				const full = t.name.replace( /_s$/, '' );
				name = fs.existsSync( path.join( TEX_SRC, full + '.webp' ) ) ? full : t.name;
				TEXS[ name ] = { mean: t.mean, amt: t.amt };

			}

			return { tex: name, mode: t.mode || 'solid', amt: t.amt, mean: t.mean, base: t.base, edge: t.edge, outer: t.outer };

		} );
		let o = 0;
		const nvox = m.counts.reduce( ( a, b ) => a + b, 0 );
		const vox = new Uint8Array( buf.buffer, buf.byteOffset + o, nvox * 12 ); o += nvox * 12;
		const ve = MeshoptEncoder.encodeVertexBuffer( vox, nvox, 12 );
		const [ vOff, vLen ] = put( ve );
		use( m.sp + '.mesh' );
		const P = { file: m.sp, sp: m.sp, seed: m.seed, t: m.t, cultivar: m.cultivar, height: m.height * s,
			vox: { min: m.info.min.map( ( v ) => v * s ), vsz: m.info.vsz.map( ( v ) => v * s ), res: m.info.res, counts: m.counts, n: nvox, off: vOff, len: vLen }, lods: [] };
		m.lods.forEach( ( L, li ) => {

			const pos = new Float32Array( buf.buffer.slice( buf.byteOffset + o, buf.byteOffset + o + L.verts * 12 ) ); o += L.verts * 12;
			const nrm = new Float32Array( buf.buffer.slice( buf.byteOffset + o, buf.byteOffset + o + L.verts * 12 ) ); o += L.verts * 12;
			const col = new Uint8Array( buf.buffer.slice( buf.byteOffset + o, buf.byteOffset + o + L.verts * 4 ) ); o += Math.ceil( L.verts * 4 / 4 ) * 4;
			let idx = new Uint32Array( buf.buffer.slice( buf.byteOffset + o, buf.byteOffset + o + L.tris * 12 ) ); o += L.tris * 12;
			const uvA = new Float32Array( buf.buffer.slice( buf.byteOffset + o, buf.byteOffset + o + L.verts * 8 ) ); o += L.verts * 8;
			const slA = new Uint8Array( buf.buffer.slice( buf.byteOffset + o, buf.byteOffset + o + L.verts ) ); o += Math.ceil( L.verts / 4 ) * 4;
			if ( li === 0 && m.t < 1 ) {

				P.lods.push( null ); // young plants: LOD1 is detailed enough up close
				return;

			}

			let verts = L.verts, pos2 = pos, nrm2 = nrm, col2 = col, posS2 = null, uv2 = uvA, sl2 = slA;
			if ( li === 0 && L.tris > LOD0_MAX ) {

				const [ si ] = MeshoptSimplifier.simplify( idx, pos, 3, LOD0_MAX * 3, 0.01 );
				const remap = new Map(), P2 = [], N2 = [], C2 = [], UV2 = [], SL2 = [];
				const out = new Uint32Array( si.length );
				for ( let i = 0; i < si.length; i ++ ) {

					let n = remap.get( si[ i ] );
					if ( n === undefined ) {

						n = remap.size; remap.set( si[ i ], n );
						const v = si[ i ];
						P2.push( pos[ v * 3 ], pos[ v * 3 + 1 ], pos[ v * 3 + 2 ] ); N2.push( nrm[ v * 3 ], nrm[ v * 3 + 1 ], nrm[ v * 3 + 2 ] );
						C2.push( col[ v * 4 ], col[ v * 4 + 1 ], col[ v * 4 + 2 ], col[ v * 4 + 3 ] );
						UV2.push( uvA[ v * 2 ], uvA[ v * 2 + 1 ] ); SL2.push( slA[ v ] );

					}

					out[ i ] = n;

				}

				idx = out; verts = remap.size; pos2 = new Float32Array( P2 ); nrm2 = new Float32Array( N2 ); col2 = new Uint8Array( C2 );
				uv2 = new Float32Array( UV2 ); sl2 = new Uint8Array( SL2 );

			}
			const lo = [ 1e9, 1e9, 1e9 ], hi = [ - 1e9, - 1e9, - 1e9 ];
			const posS = new Float32Array( pos2.length );
			for ( let i = 0; i < pos2.length; i ++ ) {

				posS[ i ] = pos2[ i ] * s;
				lo[ i % 3 ] = Math.min( lo[ i % 3 ], posS[ i ] ); hi[ i % 3 ] = Math.max( hi[ i % 3 ], posS[ i ] );

			}

			const size = hi.map( ( h, a ) => Math.max( 1e-4, h - lo[ a ] ) );
			// reorder triangles / vertices for cache locality: compresses much better
			idx = new Uint32Array( idx );
			const [ remap, unique ] = MeshoptEncoder.reorderMesh( idx, true, true );
			{

				const P3 = new Float32Array( unique * 3 ), N3 = new Float32Array( unique * 3 ), C3 = new Uint8Array( unique * 4 ), UV3 = new Float32Array( unique * 2 ), SL3 = new Uint8Array( unique );
				for ( let v = 0; v < verts; v ++ ) {

					const n = remap[ v ];
					if ( n === 0xffffffff ) continue;
					for ( let a = 0; a < 3; a ++ ) {

						P3[ n * 3 + a ] = posS[ v * 3 + a ]; N3[ n * 3 + a ] = nrm2[ v * 3 + a ];

					}

					for ( let a = 0; a < 4; a ++ ) C3[ n * 4 + a ] = col2[ v * 4 + a ];
					UV3[ n * 2 ] = uv2[ v * 2 ]; UV3[ n * 2 + 1 ] = uv2[ v * 2 + 1 ]; SL3[ n ] = sl2[ v ];

				}

				verts = unique; pos2 = null;
				nrm2 = N3; col2 = C3; uv2 = UV3; sl2 = SL3;
				posS2 = P3;

			}

			const groups = [];
			{

				const bySlot = new Map();
				for ( let t = 0; t < idx.length; t += 3 ) {

					const k = sl2[ idx[ t ] ];
					if ( ! bySlot.has( k ) ) bySlot.set( k, [] );
					bySlot.get( k ).push( idx[ t ], idx[ t + 1 ], idx[ t + 2 ] );

				}

				const sorted = new Uint32Array( idx.length );
				let at = 0;
				for ( const [ k, list ] of [ ...bySlot ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] ) ) {

					sorted.set( list, at );
					groups.push( { mat: k ? mats[ k - 1 ] : { tex: null, mode: 'solid' }, start: at, count: list.length } );
					at += list.length;

				}

				idx = sorted;

			}

			const ulo = [ 1e9, 1e9 ], uhi = [ - 1e9, - 1e9 ];
			for ( let i = 0; i < verts * 2; i ++ ) {

				ulo[ i % 2 ] = Math.min( ulo[ i % 2 ], uv2[ i ] ); uhi[ i % 2 ] = Math.max( uhi[ i % 2 ], uv2[ i ] );

			}

			const usize = uhi.map( ( h, a ) => Math.max( 1e-4, h - ulo[ a ] ) );
			const vb = new Uint8Array( verts * 16 ), dv = new DataView( vb.buffer );
			for ( let i = 0; i < verts; i ++ ) {

				for ( let a = 0; a < 3; a ++ ) dv.setUint16( i * 16 + a * 2, Math.round( ( posS2[ i * 3 + a ] - lo[ a ] ) / size[ a ] * 65535 ), true );
				for ( let a = 0; a < 2; a ++ ) dv.setUint16( i * 16 + 12 + a * 2, Math.round( ( uv2[ i * 2 + a ] - ulo[ a ] ) / usize[ a ] * 65535 ), true );
				// octahedral normal
				let nx = nrm2[ i * 3 ], ny = nrm2[ i * 3 + 1 ], nz = nrm2[ i * 3 + 2 ];
				const l1 = Math.abs( nx ) + Math.abs( ny ) + Math.abs( nz ) || 1;
				nx /= l1; ny /= l1; nz /= l1;
				let ox = nx, oy = nz;
				if ( ny < 0 ) {

					ox = ( 1 - Math.abs( nz ) ) * Math.sign( nx || 1 ); oy = ( 1 - Math.abs( nx ) ) * Math.sign( nz || 1 );

				}

				vb[ i * 16 + 6 ] = Math.round( ( ox * 0.5 + 0.5 ) * 255 ); vb[ i * 16 + 7 ] = Math.round( ( oy * 0.5 + 0.5 ) * 255 );
				for ( let a = 0; a < 4; a ++ ) vb[ i * 16 + 8 + a ] = col2[ i * 4 + a ];

			}

			const [ a0, a1 ] = put( MeshoptEncoder.encodeVertexBuffer( vb, verts, 16 ) );
			const [ b0, b1 ] = put( MeshoptEncoder.encodeIndexBuffer( new Uint8Array( idx.buffer, idx.byteOffset, idx.byteLength ), idx.length, 4 ) );
			P.lods.push( { verts, tris: idx.length / 3, min: lo, size, uvMin: ulo, uvSize: usize, groups, vOff: a0, vLen: a1, iOff: b0, iLen: b1 } );

		} );

		files2[ cur ].off = off; chunks = null;
		protos.push( P );

	}

	for ( const f of fs.readdirSync( outDir ) ) if ( f.endsWith( '.wasm' ) ) fs.unlinkSync( path.join( outDir, f ) );
	let total = 0;
	for ( const [ sp, F ] of Object.entries( files2 ) ) {

		fs.writeFileSync( path.join( outDir, `jose-${ sp }.wasm` ), Buffer.concat( F.chunks ) );
		total += F.off;
		console.log( sp, ( F.off / 1e6 ).toFixed( 1 ), 'MB' );

	}

	// the photo scans (CC0, see jose's tex/README.md) the meshes use, with their linear mean colours
	fs.mkdirSync( path.join( outDir, 'tex' ), { recursive: true } );
	for ( const n of Object.keys( TEXS ) ) fs.copyFileSync( path.join( TEX_SRC, n + '.webp' ), path.join( outDir, 'tex', n + '.webp' ) );
	fs.writeFileSync( path.join( outDir, 'jose.json' ), JSON.stringify( { protos, textures: TEXS } ) );
	console.log( 'scans:', Object.keys( TEXS ).join( ' ' ) );
	console.log( protos.length, 'prototypes;', ( raw / 1e6 ).toFixed( 1 ), 'MB raw ->', ( total / 1e6 ).toFixed( 1 ), 'MB' );

} )();
