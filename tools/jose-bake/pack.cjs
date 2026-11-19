// Pack the captured jose voxel prototypes (capture.cjs output) into the app's assets:
//   node pack.cjs /tmp/jvox ../../src/assets/plains/vox
// jose.voxels.wasm: all voxel words (raw u32; named .wasm so static hosts serve it as binary) (u32), jose.json: per prototype species, seed, stage, box (m), level counts
const fs = require( 'fs' );
const path = require( 'path' );
const [ inDir, outDir ] = process.argv.slice( 2 );
fs.mkdirSync( outDir, { recursive: true } );
const files = fs.readdirSync( inDir ).filter( ( f ) => f.endsWith( '.json' ) ).sort();
const protos = [], words = [];
for ( const f of files ) {

	const d = JSON.parse( fs.readFileSync( path.join( inDir, f ) ) );
	const s = d.scale;
	protos.push( {
		sp: d.sp, seed: d.seed, t: d.t,
		min: d.info.min.map( ( v ) => v * s ), vsz: d.info.vsz.map( ( v ) => v * s ), res: d.info.res,
		counts: d.levels.map( ( l ) => l.length / 3 ), height: d.height * s,
	} );
	for ( const L of d.levels ) for ( const w of L ) words.push( w );

}

fs.writeFileSync( path.join( outDir, 'jose.voxels.wasm' ), Buffer.from( new Uint32Array( words ).buffer ) );
fs.writeFileSync( path.join( outDir, 'jose.json' ), JSON.stringify( protos ) );
console.log( protos.length, 'prototypes,', words.length / 3, 'voxels,', ( words.length * 4 / 1e6 ).toFixed( 1 ), 'MB' );
