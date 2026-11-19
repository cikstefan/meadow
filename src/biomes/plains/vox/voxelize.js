// Generic voxel pyramid builder (no dependencies: runs in the app, in node and inside
// the jose plant page during the capture bake).
//
//   const g = new VoxelGrid( min[3], vsz[3], res[3] );  // level-0 cells
//   g.add( x, y, z, r, g, b, nx, ny, nz, ao, glow );     // surface samples (linear colour)
//   const { levels, info } = g.build( { minCount, maxLevels } );
//
// Level 0 averages its samples; each coarser level merges 2x2x2 children with a
// coverage alpha (a 2x2x2 block shows ~4 child faces), so sparse foliage turns partly
// see-through instead of solid. Voxels walled in on all six sides are dropped.
// Packed per voxel (3 x u32):
//   0: x | y << 8 | z << 16 | glow << 24
//   1: sqrt-encoded r, g, b | coverage << 24
//   2: normal (x, y, z) * 0.5 + 0.5 | ao << 24

export class VoxelGrid {

	constructor( min, vsz, res ) {

		this.min = min; this.vsz = vsz; this.res = res;
		this.cells = new Map();

	}

	add( x, y, z, r, g, b, nx, ny, nz, ao, glow = 0, w = 1 ) {

		const ix = Math.floor( ( x - this.min[ 0 ] ) / this.vsz[ 0 ] ), iy = Math.floor( ( y - this.min[ 1 ] ) / this.vsz[ 1 ] ), iz = Math.floor( ( z - this.min[ 2 ] ) / this.vsz[ 2 ] );
		if ( ix < 0 || iy < 0 || iz < 0 || ix >= this.res[ 0 ] || iy >= this.res[ 1 ] || iz >= this.res[ 2 ] ) return;
		const key = ix | ( iy << 8 ) | ( iz << 16 );
		let e = this.cells.get( key );
		if ( ! e ) this.cells.set( key, e = new Float64Array( 11 ) );
		e[ 0 ] += r * w; e[ 1 ] += g * w; e[ 2 ] += b * w;
		e[ 3 ] += nx * w; e[ 4 ] += ny * w; e[ 5 ] += nz * w;
		e[ 6 ] += ao * w; e[ 7 ] += w;
		if ( glow === 1 ) e[ 8 ] += w;
		if ( glow === 2 ) e[ 9 ] += w;
		if ( glow === 3 ) e[ 10 ] += w;

	}

	build( { minCount = 1, fullCount = 3, maxLevels = 7 } = {} ) {

		let level = new Map();
		for ( const [ key, e ] of this.cells ) {

			const c = e[ 7 ];
			if ( c < minCount ) continue;
			const nl = Math.hypot( e[ 3 ], e[ 4 ], e[ 5 ] ) || 1;
			const gl = Math.max( e[ 8 ], e[ 9 ], e[ 10 ] );
			level.set( key, {
				c: [ e[ 0 ] / c, e[ 1 ] / c, e[ 2 ] / c ], n: [ e[ 3 ] / nl, e[ 4 ] / nl, e[ 5 ] / nl ], ao: e[ 6 ] / c,
				a: Math.min( 1, c / fullCount ), w: c,
				glow: gl > c * 0.3 ? ( gl === e[ 8 ] ? 1 : gl === e[ 9 ] ? 2 : 3 ) : 0,
			} );

		}

		const levels = [ level ];
		let maxRes = Math.max( ...this.res );
		while ( maxRes > 1 && levels.length < maxLevels ) {

			const next = new Map();
			for ( const [ key, v ] of level ) {

				const x = ( key & 255 ) >> 1, y = ( ( key >> 8 ) & 255 ) >> 1, z = ( ( key >> 16 ) & 255 ) >> 1;
				const k2 = x | ( y << 8 ) | ( z << 16 );
				let e = next.get( k2 );
				if ( ! e ) next.set( k2, e = { c: [ 0, 0, 0 ], n: [ 0, 0, 0 ], ao: 0, a: 0, wa: 0, g: [ 0, 0, 0, 0 ], w: 0 } );
				const wa = v.a * v.w;
				for ( let i = 0; i < 3; i ++ ) {

					e.c[ i ] += v.c[ i ] * wa; e.n[ i ] += v.n[ i ] * wa;

				}

				e.ao += v.ao * wa; e.wa += wa; e.a += v.a; e.w += v.w; e.g[ v.glow ] += wa;

			}

			for ( const e of next.values() ) {

				const nl = Math.hypot( ...e.n ) || 1;
				e.c = e.c.map( ( q ) => q / e.wa ); e.n = e.n.map( ( q ) => q / nl ); e.ao /= e.wa;
				e.a = Math.min( 1, e.a / 4 );
				e.glow = 0;
				for ( let k = 1; k < 4; k ++ ) if ( e.g[ k ] > e.wa * 0.25 && e.g[ k ] >= e.g[ e.glow ] ) e.glow = k;

			}

			levels.push( next );
			level = next;
			maxRes = Math.ceil( maxRes / 2 );

		}

		const q = ( f ) => Math.max( 0, Math.min( 255, Math.round( f * 255 ) ) );
		const packed = levels.map( ( L ) => {

			const out = [];
			const opaque = ( x, y, z ) => {

				const v = L.get( x | ( y << 8 ) | ( z << 16 ) );
				return v && v.a > 0.9;

			};

			for ( const [ key, v ] of L ) {

				const x = key & 255, y = ( key >> 8 ) & 255, z = ( key >> 16 ) & 255;
				if ( x > 0 && y > 0 && z > 0 && opaque( x - 1, y, z ) && opaque( x + 1, y, z ) && opaque( x, y - 1, z ) && opaque( x, y + 1, z ) && opaque( x, y, z - 1 ) && opaque( x, y, z + 1 ) ) continue;
				out.push(
					( key | ( v.glow << 24 ) ) >>> 0,
					( q( Math.sqrt( v.c[ 0 ] ) ) | ( q( Math.sqrt( v.c[ 1 ] ) ) << 8 ) | ( q( Math.sqrt( v.c[ 2 ] ) ) << 16 ) | ( q( v.a ) << 24 ) ) >>> 0,
					( q( v.n[ 0 ] * 0.5 + 0.5 ) | ( q( v.n[ 1 ] * 0.5 + 0.5 ) << 8 ) | ( q( v.n[ 2 ] * 0.5 + 0.5 ) << 16 ) | ( q( v.ao ) << 24 ) ) >>> 0,
				);

			}

			return out;

		} );

		return { levels: packed, info: { min: this.min, vsz: this.vsz, res: this.res } };

	}

}

// many prototypes -> one voxel array, per-prototype boxes and per-level ranges
export const MAXLV = 7;
export function packPrototypes( protos ) {

	let n = 0;
	for ( const p of protos ) for ( const L of p.levels ) n += L.length;
	const voxels = new Uint32Array( n ), ranges = new Uint32Array( protos.length * MAXLV * 2 ), boxes = new Float32Array( protos.length * 8 );
	let o = 0;
	protos.forEach( ( p, i ) => {

		p.levels.forEach( ( L, l ) => {

			ranges[ ( i * MAXLV + l ) * 2 ] = o / 3; ranges[ ( i * MAXLV + l ) * 2 + 1 ] = L.length / 3;
			voxels.set( L, o ); o += L.length;

		} );
		const b = p.info;
		boxes.set( [ b.min[ 0 ], b.min[ 1 ], b.min[ 2 ], p.levels.length, b.vsz[ 0 ], b.vsz[ 1 ], b.vsz[ 2 ], Math.max( ...b.res ) ], i * 8 );

	} );
	return { voxels, ranges, boxes, count: protos.length };

}
