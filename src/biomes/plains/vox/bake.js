// Voxel pyramids for the scrub (after Nanite Foliage's voxels: far away, foliage
// is drawn as sub-pixel voxels that inherit the material colours and keep the
// plant's volume from every side).
//
// Every prototype bush (species x variant) is built with the real leaf-card
// geometry used up close, its surface sampled densely (atlas colour, alpha test,
// canopy normal, AO), and binned into a 32^3 grid. Coarser levels (16, 8, 4, 2)
// average 2x2x2 children, with a coverage alpha (sparse cells become partly see-
// through, drawn stochastically). Voxels walled in on all six sides are dropped:
// they could never be seen.
//
// Packed per voxel (3 x u32):
//   0: x | y << 8 | z << 16 | glow << 24     (grid cell at that level; glow 1 red, 2 yellow)
//   1: sqrt-encoded r, g, b (8 bit each) | coverage << 24
//   2: normal x, y, z (8 bit each, *0.5+0.5) | ao << 24

import { vnoiseJS } from '../../../tsl/noise.js';
import { rng } from '../grow.js';
import { SCRUB, moundGeometry } from '../scrub.js';

export const RES = 32, LEVELS = 5, VARIANTS = 2;
// unit-bush box (x/z scaled by the instance radius, y by its height)
export const BOX = { min: [ - 1.9, - 0.25, - 1.9 ], size: [ 3.8, 2.2, 3.8 ] };

const srgb = ( v ) => Math.pow( v / 255, 2.2 );
const ss = ( a, b, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

function bakePrototype( sp, si, variant, atlas ) {

	const S = SCRUB[ sp ];
	const g = moundGeometry( 4242 + variant * 97, 1, 210, 0.45 );
	const P = g.attributes.position.array, N = g.attributes.normal.array, UV = g.attributes.uv.array, K = g.attributes.kind.array;
	const img = atlas.texture.image, W = img.width, H = img.height, D = img.data;
	const cols = atlas.cols, rows = atlas.rows;
	const r = rng( 9001 + si * 31 );
	const bloom = sp === 4 ? [ 0.2, 0.42 ][ variant ] : [ 0.03, 0.15 ][ variant ];
	const cells = new Map();
	const sx = RES / BOX.size[ 0 ], sy = RES / BOX.size[ 1 ], sz = RES / BOX.size[ 2 ];
	const add = ( x, y, z, c, n, ao, glow ) => {

		const ix = Math.floor( ( x - BOX.min[ 0 ] ) * sx ), iy = Math.floor( ( y - BOX.min[ 1 ] ) * sy ), iz = Math.floor( ( z - BOX.min[ 2 ] ) * sz );
		if ( ix < 0 || iy < 0 || iz < 0 || ix >= RES || iy >= RES || iz >= RES ) return;
		const key = ix | ( iy << 8 ) | ( iz << 16 );
		let e = cells.get( key );
		if ( ! e ) cells.set( key, e = [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] );
		e[ 0 ] += c[ 0 ]; e[ 1 ] += c[ 1 ]; e[ 2 ] += c[ 2 ];
		e[ 3 ] += n[ 0 ]; e[ 4 ] += n[ 1 ]; e[ 5 ] += n[ 2 ];
		e[ 6 ] += ao; e[ 7 ] ++;
		if ( glow === 1 ) e[ 8 ] ++;
		if ( glow === 2 ) e[ 9 ] ++;

	};

	const DENS = 900; // samples per unit^2 of card area
	for ( let t = 0; t < P.length / 9; t ++ ) {

		const o = t * 9, ou = t * 6, ok = t * 9;
		const ax = P[ o ], ay = P[ o + 1 ], az = P[ o + 2 ], bx = P[ o + 3 ], by = P[ o + 4 ], bz = P[ o + 5 ], cx = P[ o + 6 ], cy = P[ o + 7 ], cz = P[ o + 8 ];
		const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
		const area = 0.5 * Math.hypot( uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx );
		const kind = K[ ok ], hfrac = K[ ok + 1 ], seedc = K[ ok + 2 ];
		const isCard = kind > 0.5;
		const useFl = kind > 1.5 && S.flower >= 0 && seedc < bloom;
		const tile = useFl ? S.flower : S.leaf;
		const n = [ N[ o ], N[ o + 1 ], N[ o + 2 ] ];
		const ns = Math.max( 1, Math.round( area * DENS ) );
		for ( let k = 0; k < ns; k ++ ) {

			let a = r(), b = r();
			if ( a + b > 1 ) {

				a = 1 - a; b = 1 - b;

			}

			const x = ax + ux * a + vx * b, y = ay + uy * a + vy * b, z = az + uz * a + vz * b;
			let col, ao, glow = 0;
			if ( isCard ) {

				const u = UV[ ou ] + ( UV[ ou + 2 ] - UV[ ou ] ) * a + ( UV[ ou + 4 ] - UV[ ou ] ) * b;
				const v = UV[ ou + 1 ] + ( UV[ ou + 3 ] - UV[ ou + 1 ] ) * a + ( UV[ ou + 5 ] - UV[ ou + 1 ] ) * b;
				const px = Math.min( W - 1, Math.floor( ( ( tile % cols ) + Math.min( 0.996, Math.max( 0.004, u ) ) ) / cols * W ) );
				const py = Math.min( H - 1, Math.floor( ( Math.floor( tile / cols ) + Math.min( 0.996, Math.max( 0.004, v ) ) ) / rows * H ) );
				const q = ( py * W + px ) * 4;
				if ( D[ q + 3 ] < 0.35 * 255 ) continue; // alpha test, as the cards do
				col = [ srgb( D[ q ] ) * S.tint[ 0 ], srgb( D[ q + 1 ] ) * S.tint[ 1 ], srgb( D[ q + 2 ] ) * S.tint[ 2 ] ];
				ao = 0.55 + 0.45 * ss( - 0.1, 0.7, hfrac );
				if ( useFl ) glow = sp === 4 ? ( col[ 0 ] > col[ 1 ] * 2.5 ? 1 : 0 ) : ( sp === 1 && col[ 0 ] + col[ 1 ] > col[ 2 ] * 3 ? 2 : 0 );

			} else {

				// inner mass: deep, shaded foliage of the species colour
				const leafN = vnoiseJS( x * 9 + y * 7, z * 9 ) * 0.6 + vnoiseJS( x * 31 + 3, z * 31 + y * 23 ) * 0.4;
				const m = 0.45 + 0.8 * leafN;
				col = [ S.body[ 0 ] * S.tint[ 0 ] * m, S.body[ 1 ] * S.tint[ 1 ] * m, S.body[ 2 ] * S.tint[ 2 ] * m ];
				ao = 0.3 + 0.55 * ss( - 0.1, 0.8, hfrac );

			}

			add( x, y, z, col, n, ao, glow );

		}

	}

	// level 0 cells -> averaged voxels
	let level = new Map();
	for ( const [ key, e ] of cells ) {

		const c = e[ 7 ];
		const nl = Math.hypot( e[ 3 ], e[ 4 ], e[ 5 ] ) || 1;
		level.set( key, {
			c: [ e[ 0 ] / c, e[ 1 ] / c, e[ 2 ] / c ], n: [ e[ 3 ] / nl, e[ 4 ] / nl, e[ 5 ] / nl ], ao: e[ 6 ] / c,
			a: Math.min( 1, c / 3 ), glow: e[ 8 ] > c * 0.3 ? 1 : e[ 9 ] > c * 0.3 ? 2 : 0, w: c,
		} );

	}

	const levels = [ level ];
	for ( let l = 1; l < LEVELS; l ++ ) {

		const next = new Map();
		for ( const [ key, v ] of level ) {

			const x = ( key & 255 ) >> 1, y = ( ( key >> 8 ) & 255 ) >> 1, z = ( ( key >> 16 ) & 255 ) >> 1;
			const k2 = x | ( y << 8 ) | ( z << 16 );
			let e = next.get( k2 );
			if ( ! e ) next.set( k2, e = { c: [ 0, 0, 0 ], n: [ 0, 0, 0 ], ao: 0, a: 0, wa: 0, glow1: 0, glow2: 0, kids: 0, w: 0 } );
			const wa = v.a * v.w;
			for ( let i = 0; i < 3; i ++ ) {

				e.c[ i ] += v.c[ i ] * wa; e.n[ i ] += v.n[ i ] * wa;

			}

			e.ao += v.ao * wa; e.wa += wa; e.a += v.a; e.kids ++; e.w += v.w;
			if ( v.glow === 1 ) e.glow1 += wa;
			if ( v.glow === 2 ) e.glow2 += wa;

		}

		for ( const e of next.values() ) {

			const nl = Math.hypot( ...e.n ) || 1;
			e.c = e.c.map( ( q ) => q / e.wa ); e.n = e.n.map( ( q ) => q / nl ); e.ao /= e.wa;
			// a 2x2x2 block shows ~4 child faces to the eye
			e.a = Math.min( 1, e.a / 4 );
			e.glow = e.glow1 > e.wa * 0.25 ? 1 : e.glow2 > e.wa * 0.25 ? 2 : 0;

		}

		levels.push( next );
		level = next;

	}

	// drop interior voxels (opaque neighbours on all six sides) and pack
	return levels.map( ( L ) => {

		const out = [];
		const opaque = ( x, y, z ) => {

			const v = L.get( x | ( y << 8 ) | ( z << 16 ) );
			return v && v.a > 0.9;

		};

		for ( const [ key, v ] of L ) {

			const x = key & 255, y = ( key >> 8 ) & 255, z = ( key >> 16 ) & 255;
			if ( x > 0 && y > 0 && z > 0 && opaque( x - 1, y, z ) && opaque( x + 1, y, z ) && opaque( x, y - 1, z ) && opaque( x, y + 1, z ) && opaque( x, y, z - 1 ) && opaque( x, y, z + 1 ) ) continue;
			const q = ( f ) => Math.max( 0, Math.min( 255, Math.round( f * 255 ) ) );
			out.push(
				( key | ( v.glow << 24 ) ) >>> 0,
				( q( Math.sqrt( v.c[ 0 ] ) ) | ( q( Math.sqrt( v.c[ 1 ] ) ) << 8 ) | ( q( Math.sqrt( v.c[ 2 ] ) ) << 16 ) | ( q( v.a ) << 24 ) ) >>> 0,
				( q( v.n[ 0 ] * 0.5 + 0.5 ) | ( q( v.n[ 1 ] * 0.5 + 0.5 ) << 8 ) | ( q( v.n[ 2 ] * 0.5 + 0.5 ) << 16 ) | ( q( v.ao ) << 24 ) ) >>> 0,
			);

		}

		return out;

	} );

}

// all prototypes -> one voxel buffer + a table (offset, count) per prototype x level
export function bakeScrubVoxels( atlas ) {

	const t0 = performance.now();
	const all = [], table = [];
	for ( let sp = 0; sp < SCRUB.length; sp ++ ) for ( let v = 0; v < VARIANTS; v ++ ) {

		const lv = bakePrototype( sp, sp * VARIANTS + v, v, atlas );
		for ( const L of lv ) {

			table.push( all.length / 3, L.length / 3 );
			for ( let i = 0; i < L.length; i ++ ) all.push( L[ i ] );

		}

	}

	const counts = [];
	for ( let i = 0; i < table.length; i += 2 ) counts.push( table[ i + 1 ] );
	console.log( `voxels: ${ all.length / 3 } in ${ ( performance.now() - t0 ) | 0 } ms; per level (proto 0): ${ counts.slice( 0, LEVELS ).join( '/' ) }` );
	return { voxels: new Uint32Array( all ), table: new Uint32Array( table ) };

}
