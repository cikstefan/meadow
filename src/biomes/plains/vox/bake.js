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
import { VoxelGrid } from './voxelize.js';

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
	const grid = new VoxelGrid( BOX.min, BOX.size.map( ( v ) => v / RES ), [ RES, RES, RES ] );
	const add = ( x, y, z, c, n, ao, glow ) => grid.add( x, y, z, c[ 0 ], c[ 1 ], c[ 2 ], n[ 0 ], n[ 1 ], n[ 2 ], ao, glow );

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

	return grid.build( { fullCount: 3, maxLevels: LEVELS } );

}

// all prototypes -> one voxel buffer + a table (offset, count) per prototype x level
// scrub prototypes (species x variant), level pyramids as packPrototypes() takes them
export function bakeScrubVoxels( atlas ) {

	const t0 = performance.now();
	const protos = [];
	for ( let sp = 0; sp < SCRUB.length; sp ++ ) for ( let v = 0; v < VARIANTS; v ++ ) protos.push( bakePrototype( sp, sp * VARIANTS + v, v, atlas ) );
	for ( const p of protos ) p.near = 50;
	console.log( `voxels: scrub prototypes in ${ ( performance.now() - t0 ) | 0 } ms; per level (proto 0): ${ protos[ 0 ].levels.map( ( l ) => l.length / 3 ).join( '/' ) }` );
	return protos;

}
