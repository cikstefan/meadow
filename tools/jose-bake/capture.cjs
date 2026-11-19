// Bake voxel prototypes of jose plants (github: the "plants" specimen page) for the
// meadow's compute-shader voxel rasterizer.
//
// Serve a copy of plants/specimen.html whose `window.__dbg` also exposes SPECIES,
// shared, THREE (and with the render loop removed), with `vox/` (this repo's
// src/biomes/plains/vox) next to it, then:
//   node capture.cjs http://localhost:5177/specimen.html out/ [species,...]
// Each plant is grown to a stage and rendered from 14 orthographic directions to
// float colour + depth under neutral light from the eye (≈ albedo); every depth hit
// becomes a surface sample (like Nanite's voxelizer casting rays), AO comes from how
// many directions saw each cell, petals are flagged to glow at night.
const { chromium } = require( 'playwright' );
const fs = require( 'fs' );
const path = require( 'path' );

// species: mature height (m) in the plains, voxel resolution, stages, seeds
const PLANTS = {
	oleander: { h: 2.6, res: 64, seeds: [ 'riviera-311', 'wadi-702' ] },
	gypso: { h: 0.8, res: 48, seeds: [ 'cloud-118', 'veil-540' ] },
	clero: { h: 1.6, res: 48, seeds: [ 'lapis-233', 'flutter-871' ] },
	stipa: { h: 0.65, res: 40, seeds: [ 'pony-410', 'drift-907' ] },
	hakone: { h: 0.45, res: 40, seeds: [ 'cascade-151', 'brook-624' ] },
	festuca: { h: 0.6, res: 40, seeds: [ 'tussock-282', 'dune-735' ] },
	benjamina: { h: 3.6, res: 64, seeds: [ 'weeping-377', 'veil-914' ] },
	plumeria: { h: 4.2, res: 64, seeds: [ 'lei-164', 'coral-588' ] },
	cotinus: { h: 3.0, res: 64, seeds: [ 'smoke-221', 'ember-659' ] },
	olive: { h: 5.0, res: 64, seeds: [ 'grove-345', 'ancient-812' ] },
	echium: { h: 1.8, res: 56, seeds: [ 'madeira-142', 'pico-563' ] },
	mugo: { h: 2.2, res: 64, seeds: [ 'krummholz-275', 'ridge-690' ] },
};
const STAGES = [ 1.0, 0.75, 0.5 ];

const url = process.argv[ 2 ], outDir = process.argv[ 3 ], only = process.argv[ 4 ] ? process.argv[ 4 ].split( ',' ) : null;

( async () => {

	fs.mkdirSync( outDir, { recursive: true } );
	const b = await chromium.launch( { args: [ '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist' ] } );
	const p = await b.newPage( { viewport: { width: 400, height: 300 } } );
	p.on( 'pageerror', ( e ) => console.log( 'pageerror', e.message ) );
	p.on( 'console', ( m ) => {

		if ( m.type() === 'error' ) console.log( 'console', m.text().slice( 0, 300 ) );

	} );
	await p.goto( url );
	await p.waitForFunction( () => window.__dbg && window.__dbg.SPECIES, null, { timeout: 300000 } );
	await p.waitForTimeout( 8000 ); // scans load in the background
	await p.evaluate( async () => {

		window.__vox = await import( './vox/voxelize.js' );

	} );

	for ( const [ sp, cfg ] of Object.entries( PLANTS ) ) {

		if ( only && ! only.includes( sp ) ) continue;
		for ( const seed of cfg.seeds ) {

			let H1 = null;
			for ( const t of STAGES ) {

				const t0 = Date.now();
				const r = await p.evaluate( capture, { sp, seed, t, RES0: cfg.res, N: 256 } ).catch( ( e ) => ( { error: e.message } ) );
				if ( r.error ) {

					console.log( sp, seed, t, 'ERROR', r.error );
					continue;

				}

				if ( H1 === null ) H1 = r.height; // the mature plant sets the scale of its younger stages
				const scale = cfg.h / H1;
				const name = `${ sp }_${ seed }_${ Math.round( t * 100 ) }`;
				fs.writeFileSync( path.join( outDir, name + '.json' ), JSON.stringify( { sp, seed, t, scale, ...r } ) );
				console.log( name, `h ${ r.height.toFixed( 2 ) } -> ${ ( r.height * scale ).toFixed( 2 ) } m`, 'voxels/level', r.levels.map( ( l ) => l.length / 3 ).join( '/' ), `${ ( ( Date.now() - t0 ) / 1000 ) | 0 }s` );

			}

		}

	}

	await b.close();

} )();

// ---- runs in the page --------------------------------------------------------------------
async function capture( { sp, seed, t, RES0, N } ) {

	const D = window.__dbg, THREE = D.THREE, R = D.renderer, sh = D.shared;
	const pl = D.SPECIES[ sp ].build( seed );
	pl.update( 1 ); pl.update( t );
	// still air, no shadows, white light from the eye, a little fill: the colour seen ≈ albedo
	sh.uGWind.value.set( 0, 0, 1, 0 ); sh.uTime.value = 0;
	sh.uShadowMat.value = new THREE.Matrix4().makeTranslation( 10, 10, 0 );
	sh.uLampAmt.value = 0; sh.uDapple.value = 0; sh.uCaus.value = 0;
	sh.uRimCol.value.setRGB( 0, 0, 0 ); sh.uFill.value.setRGB( 0.28, 0.28, 0.28 ); sh.uKeyCol.value.setRGB( 1, 1, 1 );
	const scene = new THREE.Scene();
	scene.add( pl.root );
	pl.root.updateMatrixWorld( true );
	const sph = pl.interest( new THREE.Sphere() );
	const c = sph.center.clone(), rad = sph.radius * 1.25;
	const ground = pl.ground ?? - 3.4;

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
	const col = new Float32Array( N * N * 4 ), dep = new Float32Array( N * N * 4 );
	const S = []; // x y z r g b nx ny nz viewbit
	const prevTM = R.toneMapping;
	R.toneMapping = THREE.NoToneMapping;
	dirs.forEach( ( dv, vi ) => {

		const d = new THREE.Vector3( ...dv ).normalize();
		sh.uKey.value.copy( d );
		const cam = new THREE.OrthographicCamera( - rad, rad, rad, - rad, 0.01, rad * 4 );
		cam.position.copy( c ).addScaledVector( d, rad * 2 );
		cam.up.set( 0, Math.abs( d.y ) > 0.9 ? 0 : 1, Math.abs( d.y ) > 0.9 ? 1 : 0 );
		cam.lookAt( c );
		cam.updateMatrixWorld( true );
		const right = new THREE.Vector3().setFromMatrixColumn( cam.matrixWorld, 0 ), up = new THREE.Vector3().setFromMatrixColumn( cam.matrixWorld, 1 );
		const fwd = d.clone().negate();
		R.setRenderTarget( rt ); R.setClearColor( 0x000000, 0 ); R.clear(); R.render( scene, cam );
		R.readRenderTargetPixels( rt, 0, 0, N, N, col );
		R.setRenderTarget( rt2 ); R.render( qs, qc );
		R.readRenderTargetPixels( rt2, 0, 0, N, N, dep );
		for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

			const k = ( j * N + i ) * 4, z = dep[ k ];
			if ( ! ( z < 0.99999 ) ) continue;
			const x = ( ( i + 0.5 ) / N * 2 - 1 ) * rad, y = ( ( j + 0.5 ) / N * 2 - 1 ) * rad, vd = 0.01 + z * ( rad * 4 - 0.01 );
			const px = cam.position.x + fwd.x * vd + right.x * x + up.x * y;
			const py = cam.position.y + fwd.y * vd + right.y * x + up.y * y;
			const pz = cam.position.z + fwd.z * vd + right.z * x + up.z * y;
			if ( py < ground - 0.02 ) continue;
			S.push( px, py - ground, pz, col[ k ], col[ k + 1 ], col[ k + 2 ], d.x, d.y, d.z, vi );

		}

	} );
	R.toneMapping = prevTM;
	R.setRenderTarget( null );
	rt.dispose(); rt2.dispose();
	if ( pl.dispose ) pl.dispose();

	// bounds -> cubic level-0 voxels
	const lo = [ 1e9, 1e9, 1e9 ], hi = [ - 1e9, - 1e9, - 1e9 ];
	for ( let i = 0; i < S.length; i += 10 ) for ( let a = 0; a < 3; a ++ ) {

		lo[ a ] = Math.min( lo[ a ], S[ i + a ] ); hi[ a ] = Math.max( hi[ a ], S[ i + a ] );

	}

	lo[ 1 ] = Math.min( lo[ 1 ], 0 );
	const ext = Math.max( hi[ 0 ] - lo[ 0 ], hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ) * 1.001;
	const vsz = ext / RES0;
	const res = [ 0, 1, 2 ].map( ( a ) => Math.max( 1, Math.ceil( ( hi[ a ] - lo[ a ] ) / vsz ) ) );
	const key = ( i ) => Math.min( res[ 0 ] - 1, Math.floor( ( S[ i ] - lo[ 0 ] ) / vsz ) ) | ( Math.min( res[ 1 ] - 1, Math.floor( ( S[ i + 1 ] - lo[ 1 ] ) / vsz ) ) << 8 ) | ( Math.min( res[ 2 ] - 1, Math.floor( ( S[ i + 2 ] - lo[ 2 ] ) / vsz ) ) << 16 );
	// exposure: from how many directions each cell was seen
	const mask = new Map();
	for ( let i = 0; i < S.length; i += 10 ) {

		const k = key( i );
		mask.set( k, ( mask.get( k ) || 0 ) | ( 1 << S[ i + 9 ] ) );

	}

	const pop = ( m ) => {

		let n = 0;
		while ( m ) {

			n += m & 1; m >>>= 1;

		}

		return n;

	};
	const g = new window.__vox.VoxelGrid( lo, [ vsz, vsz, vsz ], res );
	const LIT = 1.0 / 1.28; // white key from the eye + fill
	for ( let i = 0; i < S.length; i += 10 ) {

		const r = S[ i + 3 ] * LIT, gg = S[ i + 4 ] * LIT, bb = S[ i + 5 ] * LIT;
		const mx = Math.max( r, gg, bb ), mn = Math.min( r, gg, bb ), lum = 0.2126 * r + 0.7152 * gg + 0.0722 * bb;
		const sat = ( mx - mn ) / ( mx + 1e-4 );
		// petals: saturated and not leaf green, or bright white
		const flower = ( sat > 0.35 && gg < mx * 0.97 && lum > 0.06 ) || ( lum > 0.55 && sat < 0.2 );
		const ao = Math.min( 1, 0.3 + pop( mask.get( key( i ) ) ) / 6 );
		g.add( S[ i ], S[ i + 1 ], S[ i + 2 ], r, gg, bb, S[ i + 6 ], S[ i + 7 ], S[ i + 8 ], ao, flower ? 3 : 0 );

	}

	const out = g.build( { fullCount: 10 } );
	return { levels: out.levels, info: out.info, height: hi[ 1 ], samples: S.length / 10 };

}
