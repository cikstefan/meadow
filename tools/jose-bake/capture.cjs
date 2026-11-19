// Bake jose plants (the "plants" specimen generator) for the meadow's foliage renderer:
// near-field meshes (three LODs, posed geometry + vertex colours from jose's own shading)
// and far-field voxel pyramids.
//
// Serve a copy of plants/specimen.html whose `window.__dbg` also exposes SPECIES, shared
// and THREE (render loop removed), with `vox/` (this repo's src/biomes/plains/vox) and
// `libs/` (three/examples/jsm/libs) next to it, then:
//   node capture.cjs http://localhost:5177/specimen.html out/ [species,...]
//
// Voxels: the grown plant is rendered from 14 orthographic directions to float colour +
// depth under white light from the eye (≈ albedo); every depth hit is a surface sample
// (Nanite-style ray voxelization), AO from how many directions saw each cell.
// Meshes: every jose material is re-run as points with each vertex sent to its own pixel,
// writing the posed world position / normal (the shaders pose geometry from bone
// textures, so this is the only way to get the grown shape out); triangles are rebuilt
// from the index buffers, simplified with meshoptimizer, and each kept vertex takes its
// colour from the views that see it.
const { chromium } = require( 'playwright' );
const fs = require( 'fs' );
const path = require( 'path' );

// species: mature height (m), voxel resolution, seeds (each a different cultivar where the species has them)
const PLANTS = {
	oleander: { h: 2.6, res: 96, seeds: [ 'oleander-0', 'oleander-1', 'oleander-2', 'oleander-5' ] }, // pink, red, salmon, white
	gypso: { h: 0.8, res: 64, seeds: [ 'gypso-0', 'gypso-6' ] }, // white, pink 'Flamingo'
	clero: { h: 1.6, res: 80, seeds: [ 'clero-0', 'clero-7' ] },
	stipa: { h: 0.65, res: 64, seeds: [ 'stipa-0', 'stipa-4' ] },
	hakone: { h: 0.45, res: 48, seeds: [ 'hakone-0', 'hakone-2' ] },
	festuca: { h: 0.6, res: 48, seeds: [ 'festuca-0', 'festuca-3' ] },
	benjamina: { h: 3.6, res: 96, seeds: [ 'benjamina-0', 'benjamina-4', 'benjamina-10' ] },
	plumeria: { h: 4.2, res: 96, seeds: [ 'plumeria-0', 'plumeria-1', 'plumeria-2', 'plumeria-6' ] },
	cotinus: { h: 3.0, res: 96, seeds: [ 'cotinus-0', 'cotinus-5' ] },
	olive: { h: 5.0, res: 96, seeds: [ 'olive-0', 'olive-22' ] },
	echium: { h: 1.8, res: 80, seeds: [ 'echium-0', 'echium-1' ] },
	mugo: { h: 2.2, res: 96, seeds: [ 'mugo-0', 'mugo-4' ] },
};
const STAGES = [ 1.0, 0.62 ];
// near-field mesh budgets (triangles) per LOD
const LOD_TRIS = [ 150000, 40000, 10000 ];

if ( process.env.ONLY_SEED ) for ( const k of Object.keys( PLANTS ) ) PLANTS[ k ].seeds = PLANTS[ k ].seeds.filter( ( x ) => x === process.env.ONLY_SEED );
const url = process.argv[ 2 ], outDir = process.argv[ 3 ], only = process.argv[ 4 ] ? process.argv[ 4 ].split( ',' ) : null;
const b64 = ( s, T ) => {

	const buf = Buffer.from( s, 'base64' );
	return new T( buf.buffer, buf.byteOffset, buf.byteLength / T.BYTES_PER_ELEMENT );

};

( async () => {

	fs.mkdirSync( outDir, { recursive: true } );
	const b = await chromium.launch( { args: [ '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=8192' ] } );
	const p = await b.newPage( { viewport: { width: 400, height: 300 } } );
	p.on( 'pageerror', ( e ) => console.log( 'pageerror', e.message ) );
	p.on( 'console', ( m ) => {

		if ( m.type() === 'error' || m.text().startsWith( '[bake]' ) ) console.log( 'console', m.text().slice( 0, 300 ) );

	} );
	await p.goto( url );
	await p.waitForFunction( () => window.__dbg && window.__dbg.SPECIES, null, { timeout: 300000 } );
	await p.waitForTimeout( 8000 ); // scans load in the background
	await p.evaluate( async () => {

		window.__vox = await import( './vox/voxelize.js' );
		window.__simp = ( await import( './libs/meshopt_simplifier.module.js' ) ).MeshoptSimplifier;
		await window.__simp.ready;

	} );

	for ( const [ sp, cfg ] of Object.entries( PLANTS ) ) {

		if ( only && ! only.includes( sp ) ) continue;
		for ( const seed of cfg.seeds ) {

			let H1 = null;
			for ( const t of STAGES ) {

				const done = path.join( outDir, `${ sp }_${ seed }_${ Math.round( t * 100 ) }.json` );
				if ( fs.existsSync( done ) ) {

					// resume: keep what is baked (the mature stage's height sets the scale)
					if ( H1 === null ) {

						const m = JSON.parse( fs.readFileSync( done ) );
						H1 = m.height;

					}

					continue;

				}

				const t0 = Date.now();
				const r = await p.evaluate( capture, { sp, seed, t, RES0: cfg.res, N: 512, LOD_TRIS } ).catch( ( e ) => ( { error: e.message } ) );
				if ( r.error ) {

					console.log( sp, seed, t, 'ERROR', r.error );
					continue;

				}

				if ( H1 === null ) H1 = r.height; // the mature plant sets the scale of its younger stage
				const scale = cfg.h / H1;
				const name = `${ sp }_${ seed }_${ Math.round( t * 100 ) }`;
				const lods = r.lods.map( ( L ) => ( { pos: b64( L.pos, Float32Array ), nrm: b64( L.nrm, Float32Array ), col: b64( L.col, Uint8Array ), idx: b64( L.idx, Uint32Array ), uv: b64( L.uv, Float32Array ), slot: b64( L.slot, Uint8Array ) } ) );
				const meta = { sp, seed, t, scale, cultivar: r.cultivar, texs: r.texs, info: r.info, height: r.height, counts: r.levels.map( ( l ) => l.length / 3 ), lods: lods.map( ( L ) => ( { verts: L.pos.length / 3, tris: L.idx.length / 3 } ) ) };
				fs.writeFileSync( path.join( outDir, name + '.json' ), JSON.stringify( meta ) );
				// raw payload: voxel words, then per LOD: pos f32, nrm f32, col u8 (padded to 4), idx u32
				const parts = [ Buffer.from( new Uint32Array( r.levels.flat() ).buffer ) ];
				for ( const L of lods ) {

					parts.push( Buffer.from( L.pos.buffer, L.pos.byteOffset, L.pos.byteLength ), Buffer.from( L.nrm.buffer, L.nrm.byteOffset, L.nrm.byteLength ) );
					const c = Buffer.alloc( Math.ceil( L.col.length / 4 ) * 4 );
					Buffer.from( L.col.buffer, L.col.byteOffset, L.col.byteLength ).copy( c );
					parts.push( c, Buffer.from( L.idx.buffer, L.idx.byteOffset, L.idx.byteLength ) );
					const sb = Buffer.alloc( Math.ceil( L.slot.length / 4 ) * 4 );
					Buffer.from( L.slot.buffer, L.slot.byteOffset, L.slot.byteLength ).copy( sb );
					parts.push( Buffer.from( L.uv.buffer, L.uv.byteOffset, L.uv.byteLength ), sb );

				}

				fs.writeFileSync( path.join( outDir, name + '.raw' ), Buffer.concat( parts ) );
				console.log( name, r.cultivar, `${ ( r.height * scale ).toFixed( 2 ) } m`, 'vox', meta.counts.join( '/' ), 'tris', meta.lods.map( ( l ) => l.tris ).join( '/' ), `(src ${ r.srcTris })`, `${ ( ( Date.now() - t0 ) / 1000 ) | 0 }s` );

			}

		}

	}

	await b.close();

} )();

// ---- runs in the page --------------------------------------------------------------------
async function capture( { sp, seed, t, RES0, N, LOD_TRIS } ) {

	const D = window.__dbg, THREE = D.THREE, R = D.renderer, sh = D.shared;
	const pl = D.SPECIES[ sp ].build( seed );
	pl.update( 1 ); pl.update( t );
	// jose loads each material's photo scan in the background: wait until they settle
	{

		const loaded = () => {

			let n = 0;
			pl.root.traverse( ( o ) => {

				const U = o.material && o.material.uniforms;
				if ( U && U.uTexMean && U.uTexMean.value.w > 0 ) n ++;

			} );
			return n;

		};
		let last = - 1, stable = 0;
		for ( let i = 0; i < 80 && stable < 12; i ++ ) {

			await new Promise( ( r ) => setTimeout( r, 100 ) );
			const n = loaded();
			stable = n === last ? stable + 1 : 0;
			last = n;

		}

	}

	// still air, no shadows, white light from the eye, a little fill: the colour seen ≈ albedo
	sh.uGWind.value.set( 0, 0, 1, 0 ); sh.uTime.value = 0;
	sh.uShadowMat.value = new THREE.Matrix4().makeTranslation( 10, 10, 0 );
	sh.uLampAmt.value = 0; sh.uDapple.value = 0; sh.uCaus.value = 0;
	sh.uRimCol.value.setRGB( 0, 0, 0 ); sh.uFill.value.setRGB( 0.28, 0.28, 0.28 ); sh.uKeyCol.value.setRGB( 1, 1, 1 );
	const scene = new THREE.Scene();
	scene.add( pl.root );
	pl.root.updateMatrixWorld( true );
	pl.root.traverse( ( o ) => {

		const U = o.material && o.material.uniforms;
		if ( U && U.uWind ) U.uWind.value.x = 0; // the plant's own breeze
		if ( U && U.uKeep ) U.uKeep.value = 1; // every organ (no screen-size LOD)

	} );
	// ground decoration some builders include (scree, soil, boulders): not part of the plant
	const GROUND_KINDS = [ 6, 15 ];
	pl.root.traverse( ( o ) => {

		const U = o.material && o.material.uniforms;
		if ( o.isMesh && U && U.uKind && GROUND_KINDS.includes( U.uKind.value ) ) o.visible = false;

	} );
	const sph = pl.interest( new THREE.Sphere() );
	const c = sph.center.clone(), rad = sph.radius * 1.25;
	const ground = pl.ground ?? - 3.4;
	const prevTM = R.toneMapping;
	R.toneMapping = THREE.NoToneMapping;

	// ---- 14 views: colour + depth -------------------------------------------------------------
	const rt = new THREE.WebGLRenderTarget( N, N, { type: THREE.FloatType } );
	rt.depthTexture = new THREE.DepthTexture( N, N, THREE.FloatType );
	const rt2 = new THREE.WebGLRenderTarget( N, N, { type: THREE.FloatType } );
	const quad = new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), new THREE.ShaderMaterial( {
		uniforms: { tD: { value: rt.depthTexture } },
		vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0., 1. ); }',
		fragmentShader: 'uniform sampler2D tD; varying vec2 vUv; void main(){ gl_FragColor = vec4( texture2D( tD, vUv ).x ); }',
	} ) );
	const qs = new THREE.Scene(); qs.add( quad );
	const qc = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
	const dirs = [];
	for ( const v of [ [ 1, 0, 0 ], [ - 1, 0, 0 ], [ 0, 1, 0 ], [ 0, - 1, 0 ], [ 0, 0, 1 ], [ 0, 0, - 1 ] ] ) dirs.push( v );
	for ( const x of [ - 1, 1 ] ) for ( const y of [ - 1, 1 ] ) for ( const z of [ - 1, 1 ] ) dirs.push( [ x, y * 0.7, z ] );
	const tmp = new Float32Array( N * N * 4 ), far = rad * 4;
	const views = [], S = [];
	dirs.forEach( ( dv, vi ) => {

		const d = new THREE.Vector3( ...dv ).normalize();
		sh.uKey.value.copy( d );
		const cam = new THREE.OrthographicCamera( - rad, rad, rad, - rad, 0.01, far );
		cam.position.copy( c ).addScaledVector( d, rad * 2 );
		cam.up.set( 0, Math.abs( d.y ) > 0.9 ? 0 : 1, Math.abs( d.y ) > 0.9 ? 1 : 0 );
		cam.lookAt( c );
		cam.updateMatrixWorld( true );
		const right = new THREE.Vector3().setFromMatrixColumn( cam.matrixWorld, 0 ), up = new THREE.Vector3().setFromMatrixColumn( cam.matrixWorld, 1 );
		const fwd = d.clone().negate();
		R.setRenderTarget( rt ); R.setClearColor( 0x000000, 0 ); R.clear(); R.render( scene, cam );
		R.readRenderTargetPixels( rt, 0, 0, N, N, tmp );
		const col = new Float32Array( N * N * 3 );
		for ( let i = 0; i < N * N; i ++ ) {

			col[ i * 3 ] = tmp[ i * 4 ]; col[ i * 3 + 1 ] = tmp[ i * 4 + 1 ]; col[ i * 3 + 2 ] = tmp[ i * 4 + 2 ];

		}

		R.setRenderTarget( rt2 ); R.render( qs, qc );
		R.readRenderTargetPixels( rt2, 0, 0, N, N, tmp );
		const dep = new Float32Array( N * N );
		for ( let i = 0; i < N * N; i ++ ) dep[ i ] = tmp[ i * 4 ] < 0.99999 ? 0.01 + tmp[ i * 4 ] * ( far - 0.01 ) : 1e9;
		views.push( { d, fwd, right, up, pos: cam.position.clone(), col, dep } );
		for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

			const k = j * N + i, vd = dep[ k ];
			if ( vd > 1e8 ) continue;
			const x = ( ( i + 0.5 ) / N * 2 - 1 ) * rad, y = ( ( j + 0.5 ) / N * 2 - 1 ) * rad;
			const px = cam.position.x + fwd.x * vd + right.x * x + up.x * y;
			const py = cam.position.y + fwd.y * vd + right.y * x + up.y * y;
			const pz = cam.position.z + fwd.z * vd + right.z * x + up.z * y;
			if ( py < ground - 0.02 ) continue;
			S.push( px, py - ground, pz, col[ k * 3 ], col[ k * 3 + 1 ], col[ k * 3 + 2 ], d.x, d.y, d.z, vi );

		}

	} );

	// ---- voxels ---------------------------------------------------------------------------------
	const lo = [ 1e9, 1e9, 1e9 ], hi = [ - 1e9, - 1e9, - 1e9 ];
	for ( let i = 0; i < S.length; i += 10 ) for ( let a = 0; a < 3; a ++ ) {

		lo[ a ] = Math.min( lo[ a ], S[ i + a ] ); hi[ a ] = Math.max( hi[ a ], S[ i + a ] );

	}

	lo[ 1 ] = Math.min( lo[ 1 ], 0 );
	const ext = Math.max( hi[ 0 ] - lo[ 0 ], hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ) * 1.001;
	const vsz = ext / RES0;
	const res = [ 0, 1, 2 ].map( ( a ) => Math.max( 1, Math.ceil( ( hi[ a ] - lo[ a ] ) / vsz ) ) );
	const cellOf = ( x, y, z ) => Math.max( 0, Math.min( res[ 0 ] - 1, Math.floor( ( x - lo[ 0 ] ) / vsz ) ) ) | ( Math.max( 0, Math.min( res[ 1 ] - 1, Math.floor( ( y - lo[ 1 ] ) / vsz ) ) ) << 8 ) | ( Math.max( 0, Math.min( res[ 2 ] - 1, Math.floor( ( z - lo[ 2 ] ) / vsz ) ) ) << 16 );
	const mask = new Map();
	for ( let i = 0; i < S.length; i += 10 ) {

		const k = cellOf( S[ i ], S[ i + 1 ], S[ i + 2 ] );
		mask.set( k, ( mask.get( k ) || 0 ) | ( 1 << S[ i + 9 ] ) );

	}

	const pop = ( m ) => {

		let n = 0;
		while ( m ) {

			n += m & 1; m >>>= 1;

		}

		return n;

	};
	const aoAt = ( x, y, z ) => {

		const m = mask.get( cellOf( x, y, z ) );
		return m ? Math.min( 1, 0.3 + pop( m ) / 6 ) : 0.3;

	};
	const LIT = 1.0 / 1.28; // white key from the eye + fill
	const isFlower = ( r, g, b ) => {

		const mx = Math.max( r, g, b ), mn = Math.min( r, g, b ), lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		const sat = ( mx - mn ) / ( mx + 1e-4 );
		// (never leaf greens or yellow-greens: those glowing made messy green specks at night)
		const greenish = g >= r * 0.78 && g >= b;
		return ! greenish && ( ( sat > 0.35 && lum > 0.06 ) || ( lum > 0.55 && sat < 0.2 ) );

	};
	const grid = new window.__vox.VoxelGrid( lo, [ vsz, vsz, vsz ], res );
	for ( let i = 0; i < S.length; i += 10 ) {

		const r = S[ i + 3 ] * LIT, g = S[ i + 4 ] * LIT, b = S[ i + 5 ] * LIT;
		grid.add( S[ i ], S[ i + 1 ], S[ i + 2 ], r, g, b, S[ i + 6 ], S[ i + 7 ], S[ i + 8 ], aoAt( S[ i ], S[ i + 1 ], S[ i + 2 ] ), isFlower( r, g, b ) ? 3 : 0 );

	}

	const vox = grid.build( { fullCount: 10 } );

	// ---- posed geometry: every vertex to its own pixel ------------------------------------------
	const meshes = [];
	pl.root.traverse( ( o ) => {

		if ( ! o.isMesh || ! o.material || ! o.material.isShaderMaterial ) return;
		let vis = o.visible;
		o.traverseAncestors( ( a ) => {

			if ( ! a.visible ) vis = false;

		} );
		if ( vis ) meshes.push( o );

	} );
	const P = [], NN = [], WOOD = [], IDX = [], UV = [], SLOT = [], TEXS = [], ORG = [];
	let srcTris = 0;
	const cs = new THREE.Scene(), ccam = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
	for ( const o of meshes ) {

		const g = o.geometry, nv = g.attributes.position.count, ni = o.isInstancedMesh ? o.count : 1, total = nv * ni;
		const W = 2048, H = Math.ceil( total / W );
		const m0 = o.material, vs = m0.vertexShader, k = vs.lastIndexOf( '}' );
		const vs2 = 'uniform float uCapW, uCapH, uCapN;\n' + vs.slice( 0, k ) +
			'\n{ float vid = float( gl_InstanceID ) * uCapN + float( gl_VertexID ); float py = floor( vid / uCapW ); float px = vid - py * uCapW;\n' +
			'  gl_Position = vec4( ( px + .5 ) / uCapW * 2. - 1., ( py + .5 ) / uCapH * 2. - 1., 0., 1. ); gl_PointSize = 1.; }\n' + vs.slice( k );
		const mat = new THREE.ShaderMaterial( {
			uniforms: Object.assign( {}, m0.uniforms, { uCapW: { value: W }, uCapH: { value: H }, uCapN: { value: nv }, uMode: { value: 0 } } ),
			vertexShader: vs2, defines: Object.assign( {}, m0.defines ), depthTest: false, depthWrite: false,
			fragmentShader: `uniform float uMode; varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec2 vV;
				void main(){
					vec2 tuv = vUv;
					#ifdef CARD
						// jose's alpha cards: one of four scan variants side by side, picked per organ
						float var = floor( fract( vV.y * 13.7 + .37 ) * 4. ); tuv = vec2( ( var + clamp( vUv.x, .002, .998 ) ) / 4., clamp( vUv.y, .002, .998 ) );
					#endif
					gl_FragColor = uMode < .5 ? vec4( vW, 1. ) : uMode < 1.5 ? vec4( normalize( vN ), 1. ) : vec4( tuv, 0., 1. ); }`,
		} );
		let pts;
		if ( o.isInstancedMesh ) {

			pts = new THREE.InstancedMesh( g, mat, o.count );
			pts.instanceMatrix = o.instanceMatrix;
			if ( o.instanceColor ) pts.instanceColor = o.instanceColor;

		} else pts = new THREE.Mesh( g, mat );
		pts.isMesh = false; pts.isPoints = true; // drawn as points
		pts.frustumCulled = false; pts.matrixAutoUpdate = false; pts.matrixWorld.copy( o.matrixWorld );
		cs.add( pts );
		const crt = new THREE.WebGLRenderTarget( W, H, { type: THREE.FloatType } );
		const pos = new Float32Array( W * H * 4 ), nrm = new Float32Array( W * H * 4 );
		R.setRenderTarget( crt ); R.setClearColor( 0x000000, 0 ); R.clear(); R.render( cs, ccam );
		R.readRenderTargetPixels( crt, 0, 0, W, H, pos );
		mat.uniforms.uMode.value = 1;
		R.clear(); R.render( cs, ccam );
		R.readRenderTargetPixels( crt, 0, 0, W, H, nrm );
		const uvb = new Float32Array( W * H * 4 );
		mat.uniforms.uMode.value = 2;
		R.clear(); R.render( cs, ccam );
		R.readRenderTargetPixels( crt, 0, 0, W, H, uvb );
		// the material: its photo scan (jose: tissue() -> scanTexture), card mode and colours
		const U0 = m0.uniforms, tv = U0.uTex && U0.uTex.value, src = tv && ( ( tv.image && tv.image.src ) || ( tv.source && tv.source.data && tv.source.data.src ) ) || '';
		const tm = src.match( /tex\/([a-z_0-9]+)\.webp/i );
		const texName = tm && U0.uTexMean && U0.uTexMean.value.w > 0 ? tm[ 1 ] : null;
		const D0 = m0.defines || {};
		const mode = 'CARD' in D0 ? ( 'CARD_TINT' in D0 ? 'tint' : 'CARD_RAW' in D0 ? 'raw' : 'card' ) : 'solid';
		const cc = ( n ) => U0[ n ] ? [ U0[ n ].value.r, U0[ n ].value.g, U0[ n ].value.b ] : [ 1, 1, 1 ];
		TEXS.push( { name: texName, amt: texName ? U0.uTexMean.value.w : 0, mean: texName ? [ U0.uTexMean.value.x, U0.uTexMean.value.y, U0.uTexMean.value.z ] : [ 0.5, 0.5, 0.5 ],
			mode, base: cc( 'uBase' ), edge: cc( 'uEdge' ), outer: cc( 'uOuter' ) } );
		const slot = TEXS.length; // one slot per material
		const organs = o.isInstancedMesh; // leaves, florets, cards: thinned per organ for far LODs
		const uvScale = mode === 'solid' && U0.uScale ? U0.uScale.value : 1;
		cs.remove( pts ); crt.dispose(); mat.dispose();

		const wood = /attribute float aB;/.test( vs ) ? 1 : 0;
		const base = P.length / 3;
		for ( let i = 0; i < total; i ++ ) {

			P.push( pos[ i * 4 ], pos[ i * 4 + 1 ] - ground, pos[ i * 4 + 2 ] );
			NN.push( nrm[ i * 4 ], nrm[ i * 4 + 1 ], nrm[ i * 4 + 2 ] );
			UV.push( uvb[ i * 4 ] * uvScale, uvb[ i * 4 + 1 ] * uvScale );
			SLOT.push( slot );
			ORG.push( organs ? slot * 1048576 + Math.floor( i / nv ) : - 1 );
			WOOD.push( pos[ i * 4 + 3 ] > 0.5 ? wood : 255 ); // 255: never written

		}

		const id = g.index ? g.index.array : null, nid = id ? id.length : nv;
		const dr = g.drawRange, s0 = Math.max( 0, dr.start ), s1 = Math.min( nid, dr.start + dr.count );
		for ( let inst = 0; inst < ni; inst ++ ) for ( let q = s0; q + 2 < s1; q += 3 ) {

			const a = base + inst * nv + ( id ? id[ q ] : q ), b = base + inst * nv + ( id ? id[ q + 1 ] : q + 1 ), cc = base + inst * nv + ( id ? id[ q + 2 ] : q + 2 );
			if ( WOOD[ a ] === 255 || WOOD[ b ] === 255 || WOOD[ cc ] === 255 ) continue;
			const ux = P[ b * 3 ] - P[ a * 3 ], uy = P[ b * 3 + 1 ] - P[ a * 3 + 1 ], uz = P[ b * 3 + 2 ] - P[ a * 3 + 2 ];
			const vx = P[ cc * 3 ] - P[ a * 3 ], vy = P[ cc * 3 + 1 ] - P[ a * 3 + 1 ], vz = P[ cc * 3 + 2 ] - P[ a * 3 + 2 ];
			const ar = ( uy * vz - uz * vy ) ** 2 + ( uz * vx - ux * vz ) ** 2 + ( ux * vy - uy * vx ) ** 2;
			if ( ar < 1e-14 ) continue; // organs not grown yet / fallen collapse to a point
			if ( P[ a * 3 + 1 ] < - 0.01 && P[ b * 3 + 1 ] < - 0.01 && P[ cc * 3 + 1 ] < - 0.01 ) continue; // roots: under the ground
			IDX.push( a, b, cc );

		}

	}

	srcTris = IDX.length / 3;

	// (alpha cards stay cards: their cut-out comes from the scan's alpha at runtime)

	R.setRenderTarget( null );
	R.toneMapping = prevTM;
	rt.dispose(); rt2.dispose();
	const cultivar = pl.info && pl.info.cultivar;
	if ( pl.dispose ) pl.dispose();

	// ---- LODs: simplify, compact, colour from the views -----------------------------------------
	const Pf = new Float32Array( P ), I0 = new Uint32Array( IDX );
	const simp = window.__simp;
	const view = ( v, x, y, z ) => {

		// position relative to ground -> world for the view cameras
		const wy = y + ground;
		const rx = x - v.pos.x, ry = wy - v.pos.y, rz = z - v.pos.z;
		const vd = rx * v.fwd.x + ry * v.fwd.y + rz * v.fwd.z;
		const sx = ( rx * v.right.x + ry * v.right.y + rz * v.right.z ) / rad, sy = ( rx * v.up.x + ry * v.up.y + rz * v.up.z ) / rad;
		return [ ( sx * 0.5 + 0.5 ) * N, ( sy * 0.5 + 0.5 ) * N, vd ];

	};
	const eps = 2.5 * 2 * rad / N + 0.004;
	const lods = [];
	// organs (leaves, florets, cards: instanced in jose) are thinned per organ for the
	// lighter LODs, the survivors grown a little to keep the crown's density (as jose's own
	// screen-size LOD does); only the wood is simplified. Every LOD keeps the real organs.
	const barkIdx = [], organTris = new Map();
	for ( let t = 0; t < I0.length; t += 3 ) {

		const o = ORG[ I0[ t ] ];
		if ( o < 0 ) barkIdx.push( I0[ t ], I0[ t + 1 ], I0[ t + 2 ] );
		else {

			if ( ! organTris.has( o ) ) organTris.set( o, [] );
			organTris.get( o ).push( I0[ t ], I0[ t + 1 ], I0[ t + 2 ] );

		}

	}

	const centre = new Map();
	for ( const [ o, list ] of organTris ) {

		let cx = 0, cy = 0, cz = 0;
		for ( const v of list ) {

			cx += Pf[ v * 3 ]; cy += Pf[ v * 3 + 1 ]; cz += Pf[ v * 3 + 2 ];

		}

		centre.set( o, [ cx / list.length, cy / list.length, cz / list.length ] );

	}

	let organCount = 0;
	for ( const list of organTris.values() ) organCount += list.length / 3;
	const B0 = new Uint32Array( barkIdx ), hashO = ( o ) => ( ( Math.imul( o + 1, 2654435761 ) ^ Math.imul( o + 7, 2246822519 ) ) >>> 0 ) / 4294967296;
	for ( let l = 0; l < LOD_TRIS.length; l ++ ) {

		const barkBudget = Math.min( B0.length / 3, [ 45000, 9000, 1800 ][ l ] );
		let bark = B0;
		if ( B0.length / 3 > barkBudget ) {

			[ bark ] = simp.simplify( B0, Pf, 3, barkBudget * 3, l === 0 ? 0.002 : 0.01, [] );
			if ( bark.length / 3 > barkBudget * 1.4 ) [ bark ] = simp.simplifySloppy( B0, Pf, 3, null, barkBudget * 3, 0.02 );

		}

		const keepK = Math.max( 0.03, Math.min( 1, ( LOD_TRIS[ l ] - bark.length / 3 ) / Math.max( 1, organCount ) ) );
		const grow = Math.min( 1.7, 1 / Math.sqrt( Math.max( keepK, 0.12 ) ) );
		const idxL = Array.from( bark ), orgScale = new Map();
		for ( const [ o, list ] of organTris ) if ( hashO( o ) < keepK ) {

			for ( const v of list ) idxL.push( v );
			orgScale.set( o, grow );

		}

		const idx = new Uint32Array( idxL );
		// compact
		const remap = new Map(), pos = [], nrm = [], col = [], uv = [], sl = [];
		const out = new Uint32Array( idx.length );
		for ( let i = 0; i < idx.length; i ++ ) {

			let n = remap.get( idx[ i ] );
			if ( n === undefined ) {

				n = remap.size; remap.set( idx[ i ], n );
				const v = idx[ i ];
				let x = Pf[ v * 3 ], y = Pf[ v * 3 + 1 ], z = Pf[ v * 3 + 2 ];
				const org = ORG[ v ], gs = org >= 0 ? orgScale.get( org ) || 1 : 1;
				if ( gs !== 1 ) {

					const c = centre.get( org );
					x = c[ 0 ] + ( x - c[ 0 ] ) * gs; y = c[ 1 ] + ( y - c[ 1 ] ) * gs; z = c[ 2 ] + ( z - c[ 2 ] ) * gs;

				}

				pos.push( x, y, z ); nrm.push( NN[ v * 3 ], NN[ v * 3 + 1 ], NN[ v * 3 + 2 ] ); uv.push( UV[ v * 2 ], UV[ v * 2 + 1 ] ); sl.push( SLOT[ v ] );
				// colour: the views that see this vertex (depth test), weighted toward facing views
				let r = 0, g = 0, bb = 0, w = 0;
				for ( const V of views ) {

					const [ px, py, vd ] = view( V, Pf[ v * 3 ], Pf[ v * 3 + 1 ], Pf[ v * 3 + 2 ] );
					const facing = NN[ v * 3 ] * V.d.x + NN[ v * 3 + 1 ] * V.d.y + NN[ v * 3 + 2 ] * V.d.z;
					for ( let oy = - 1; oy <= 1; oy ++ ) for ( let ox = - 1; ox <= 1; ox ++ ) {

						const ix = Math.floor( px ) + ox, iy = Math.floor( py ) + oy;
						if ( ix < 0 || iy < 0 || ix >= N || iy >= N ) continue;
						const q = iy * N + ix;
						if ( Math.abs( V.dep[ q ] - vd ) > eps ) continue;
						const ww = 0.15 + Math.abs( facing ) * ( ox === 0 && oy === 0 ? 1 : 0.5 );
						r += V.col[ q * 3 ] * ww; g += V.col[ q * 3 + 1 ] * ww; bb += V.col[ q * 3 + 2 ] * ww; w += ww;

					}

				}

				if ( w > 0 ) {

					r *= LIT / w; g *= LIT / w; bb *= LIT / w;

				} else {

					r = - 1; // unseen (inside the crown): filled from neighbours below

				}

				const q = ( f ) => Math.max( 0, Math.min( 255, Math.round( Math.sqrt( Math.max( 0, f ) ) * 255 ) ) );
				const ao = aoAt( x, y, z );
				const M = TEXS[ SLOT[ v ] - 1 ];
				const kind = WOOD[ v ] === 1 ? 0 : ( ( M && M.mode === 'tint' ) || ( r >= 0 && isFlower( r, g, bb ) ) ? 2 : 1 );
				col.push( r < 0 ? 0 : q( r ), r < 0 ? 0 : q( g ), r < 0 ? 0 : q( bb ), ( kind << 6 ) | Math.round( ao * 63 ), r < 0 ? 1 : 0 );

			}

			out[ i ] = n;

		}

		// unseen vertices: average of the seen vertices sharing their triangles (a few passes)
		const nvx = remap.size, C = new Uint8Array( nvx * 4 ), unseen = new Uint8Array( nvx );
		for ( let i = 0; i < nvx; i ++ ) {

			for ( let a = 0; a < 4; a ++ ) C[ i * 4 + a ] = col[ i * 5 + a ];
			unseen[ i ] = col[ i * 5 + 4 ];

		}

		for ( let pass = 0; pass < 4; pass ++ ) {

			const acc = new Float32Array( nvx * 4 );
			for ( let i = 0; i < out.length; i += 3 ) for ( let a = 0; a < 3; a ++ ) for ( let bq = 0; bq < 3; bq ++ ) {

				const u = out[ i + a ], v2 = out[ i + bq ];
				if ( unseen[ u ] && ! unseen[ v2 ] ) {

					acc[ u * 4 ] += C[ v2 * 4 ]; acc[ u * 4 + 1 ] += C[ v2 * 4 + 1 ]; acc[ u * 4 + 2 ] += C[ v2 * 4 + 2 ]; acc[ u * 4 + 3 ] ++;

				}

			}

			for ( let u = 0; u < nvx; u ++ ) if ( unseen[ u ] && acc[ u * 4 + 3 ] > 0 ) {

				for ( let a = 0; a < 3; a ++ ) C[ u * 4 + a ] = Math.round( acc[ u * 4 + a ] / acc[ u * 4 + 3 ] * 0.8 ); // a little darker: inside
				unseen[ u ] = 0;

			}

		}

		const enc = ( arr ) => {

			const u8 = new Uint8Array( arr.buffer, arr.byteOffset, arr.byteLength );
			let s = '';
			for ( let i = 0; i < u8.length; i += 0x8000 ) s += String.fromCharCode.apply( null, u8.subarray( i, i + 0x8000 ) );
			return btoa( s );

		};
		lods.push( { pos: enc( new Float32Array( pos ) ), nrm: enc( new Float32Array( nrm ) ), col: enc( C ), idx: enc( out ), uv: enc( new Float32Array( uv ) ), slot: enc( new Uint8Array( sl ) ) } );

	}

	return { levels: vox.levels, info: vox.info, height: hi[ 1 ], lods, srcTris, cultivar, texs: TEXS };

}
