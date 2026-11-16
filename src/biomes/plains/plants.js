// Plant definitions for the scrub (pure JS, no shaders): how each species
// grows, and how a grown plant becomes geometry for three LODs.

import * as THREE from 'three/webgpu';
import { TILE } from './atlas.js';
import { rng, growTree, branchAt, Builder, decimate } from './grow.js';

const V3 = THREE.Vector3;
const range = ( r, a, b ) => a + ( b - a ) * r();

// the westerlies flag every exposed crown: shoots heading into the wind stay short
const flag = ( k ) => ( d ) => d.x < - 0.25 ? 0.4 + 0.3 * ( 1 - k ) : d.x > 0.25 ? 1.15 : 1;

// --- species growth (nominal metres, local +X = downwind) -> { branches, leaves: [{p, d, n, s, kind, flower}] }

function growNotro( r ) {

	const lean = range( r, 0.15, 0.6 ); // tan of the lean angle
	const trunks = [];
	const nt = r() < 0.55 ? 1 : 2 + ( r() * 2 | 0 );
	for ( let i = 0; i < nt; i ++ ) {

		const a = r() * 6.28, o = i ? range( r, 0.05, 0.25 ) : 0;
		trunks.push( { p: new V3( Math.cos( a ) * o, 0, Math.sin( a ) * o ), d: new V3( lean + range( r, - 0.15, 0.15 ), 1, range( r, - 0.3, 0.3 ) ), len: range( r, 1.5, 2.4 ) * ( i ? 0.8 : 1 ), r: range( r, 0.06, 0.1 ) * ( i ? 0.75 : 1 ) } );

	}

	const trop = [ 0.18 + lean * 0.25, 0.1, 0 ];
	const branches = growTree( r, {
		trunks,
		lv: [
			{ segs: 9, bend: 0.22, swirl: 0.2, trop: [ lean * 0.12, 0.12, 0 ], taper: 0.75, flare: 0.5, curveV: 0.2 },
			{ dens: 2.6, range: [ 0.3, 0.97 ], down: [ 0.8, 0.3 ], len: [ 0.4, 0.7 ], up: 0.12, segs: 6, bend: 0.35, trop, rPow: 1.3, filter: flag( lean ) },
			{ dens: 5, range: [ 0.2, 1 ], down: [ 0.75, 0.3 ], len: [ 0.35, 0.6 ], up: 0.1, segs: 4, bend: 0.4, trop, filter: flag( lean ) },
			{ dens: 7, range: [ 0.35, 1 ], down: [ 0.7, 0.3 ], len: [ 0.35, 0.65 ], segs: 3, bend: 0.3, minLen: 0.06, trop: [ trop[ 0 ], 0.15, 0 ] },
		],
	} );
	const leaves = [];
	for ( const b of branches ) {

		if ( b.level < 2 || ( b.level === 2 && b.kids.length > 2 ) ) continue;
		for ( const f of b.level === 3 ? [ 0.2, 0.6, 1 ] : [ 0.45, 0.75, 1 ] ) {

			const q = branchAt( b, f );
			leaves.push( { p: q.p, d: q.T.clone().lerp( new V3( 0.25, 1, 0 ), 0.3 ).normalize(), s: range( r, 0.42, 0.58 ), seed: r() } );

		}

	}

	return { branches, leaves, bark: 0 };

}

function growCalafate( r ) {

	const trunks = [];
	const nt = 6 + ( r() * 5 | 0 );
	for ( let i = 0; i < nt; i ++ ) {

		const a = r() * 6.28, sp = range( r, 0.35, 0.8 );
		trunks.push( { p: new V3( range( r, - 0.06, 0.06 ), 0, range( r, - 0.06, 0.06 ) ), d: new V3( Math.cos( a ) * sp + 0.2, 1, Math.sin( a ) * sp ), len: range( r, 0.9, 1.45 ), r: range( r, 0.01, 0.017 ) } );

	}

	const branches = growTree( r, {
		trunks,
		lv: [
			// arching canes: they start upright and droop toward the end
			{ segs: 7, bend: 0.3, swirl: 0.3, trop: [ 0.12, - 0.32, 0 ], taper: 0.6 },
			{ dens: 6, range: [ 0.3, 1 ], down: [ 0.9, 0.35 ], len: [ 0.16, 0.34 ], segs: 3, bend: 0.3, trop: [ 0.1, 0.2, 0 ], minLen: 0.05, filter: flag( 0.4 ) },
		],
	} );
	const leaves = [];
	for ( const b of branches ) {

		const step = b.level ? 0.5 : 0.17 / b.len;
		for ( let f = b.level ? 0.5 : 0.3; f <= 1.0001; f += step ) {

			const q = branchAt( b, f );
			leaves.push( { p: q.p, d: q.T.clone().lerp( new V3( 0.15, 1, 0 ), 0.45 ).normalize(), s: range( r, 0.3, 0.42 ), seed: r() } );

		}

	}

	return { branches, leaves, bark: 1 };

}

function growNegra( r ) {

	const trunks = [];
	const nt = 9 + ( r() * 6 | 0 );
	for ( let i = 0; i < nt; i ++ ) {

		const a = r() * 6.28, sp = range( r, 0.15, 0.6 );
		trunks.push( { p: new V3( range( r, - 0.08, 0.08 ), 0, range( r, - 0.08, 0.08 ) ), d: new V3( Math.cos( a ) * sp + 0.12, 1, Math.sin( a ) * sp ), len: range( r, 0.6, 1.0 ), r: range( r, 0.008, 0.014 ) } );

	}

	const branches = growTree( r, {
		trunks,
		lv: [
			{ segs: 6, bend: 0.35, swirl: 0.4, trop: [ 0.1, 0.1, 0 ], taper: 0.6 },
			{ dens: 9, range: [ 0.35, 1 ], down: [ 0.55, 0.3 ], len: [ 0.2, 0.4 ], up: 0.2, segs: 3, bend: 0.3, minLen: 0.05, filter: flag( 0.3 ) },
		],
	} );
	const leaves = [];
	for ( const b of branches ) {

		if ( b.level === 0 && b.kids.length > 3 ) continue;
		for ( const f of b.level ? [ 1 ] : [ 0.65, 1 ] ) {

			const q = branchAt( b, f );
			leaves.push( { p: q.p, d: q.T.clone().lerp( new V3( 0, 1, 0 ), 0.3 ).normalize(), s: range( r, 0.3, 0.42 ), seed: r() } );

		}

	}

	return { branches, leaves, bark: 2 };

}

// a tight cushion: no visible wood, cards on a flattened dome
function growBarrosa( r ) {

	const leaves = [];
	const n = 70, R = range( r, 0.42, 0.6 );
	for ( let i = 0; i < n; i ++ ) {

		const th = r() * 6.28, ph = Math.acos( 1 - r() * 1.05 ), sh = 0.6 + 0.4 * Math.sqrt( r() );
		const nrm = new V3( Math.sin( ph ) * Math.cos( th ), Math.cos( ph ), Math.sin( ph ) * Math.sin( th ) );
		const p = new V3( nrm.x * R * sh, nrm.y * 0.4 * sh - 0.08, nrm.z * R * sh );
		leaves.push( { p, d: nrm.clone().lerp( new V3( 0, 1, 0 ), 0.4 ).normalize(), s: range( r, 0.22, 0.32 ), seed: r() } );

	}

	return { branches: [], leaves, bark: 2 };

}

export const SPECIES = [
	{ name: 'notro', h: [ 1.0, 3.2 ], variants: 4, grow: growNotro, leaf: [ TILE.notro, TILE.notro2, TILE.notroYoung ], flower: [ TILE.notroFl, TILE.notroFl2 ], bloom: 0.5, glow: 1, keep: [ 1, 0.24, 0.06 ], woodLv: [ 2, 1, 0 ] },
	{ name: 'calafate', h: [ 0.6, 1.35 ], variants: 3, grow: growCalafate, leaf: [ TILE.cala ], flower: [ TILE.calaFl ], bloom: 0.5, glow: 0, keep: [ 1, 0.25, 0.07 ], woodLv: [ 0, - 1, - 1 ] },
	{ name: 'mata negra', h: [ 0.45, 1.0 ], variants: 3, grow: growNegra, leaf: [ TILE.negra ], flower: [], bloom: 0, glow: 0, keep: [ 1, 0.25, 0.07 ], woodLv: [ 0, - 1, - 1 ] },
	{ name: 'mata barrosa', h: [ 0.22, 0.5 ], variants: 2, grow: growBarrosa, leaf: [ TILE.barrosa ], flower: [], bloom: 0, glow: 0, keep: [ 1, 0.3, 0.1 ], woodLv: [ - 1, - 1, - 1 ] },
];

const SIDES = [ [ 6, 4, 3, 3 ], [ 4, 3 ], [ 3 ] ]; // tube sides per LOD and branch level
const RINGS = [ 99, 4, 3 ];

// one plant variant -> geometries for the 3 LODs (unit height, base at the origin)
export function plantLODs( sp, seed ) {

	const r = rng( seed );
	const pl = sp.grow( r );
	let H = 0.01;
	for ( const b of pl.branches ) for ( const p of b.pts ) H = Math.max( H, p.y );
	for ( const l of pl.leaves ) H = Math.max( H, l.p.y + l.s * 0.6 );
	// canopy centre (foliage centroid): cards take a soft radial normal from it
	const cen = new V3();
	for ( const l of pl.leaves ) cen.add( l.p );
	cen.multiplyScalar( 1 / Math.max( 1, pl.leaves.length ) );
	let rMax = 0.01;
	for ( const l of pl.leaves ) rMax = Math.max( rMax, l.p.distanceTo( cen ) );

	return [ 0, 1, 2 ].map( ( lod ) => {

		const B = new Builder();
		const lr = rng( seed * 31 + lod );
		const maxLv = sp.woodLv[ lod ];
		for ( const b of pl.branches ) {

			if ( b.level > maxLv ) continue;
			const sides = SIDES[ lod ][ Math.min( b.level, SIDES[ lod ].length - 1 ) ];
			const [ pts, rads ] = decimate( b.pts, b.rads, RINGS[ lod ] );
			// a lone far trunk needs to stay visible: thicken it a little
			const k = lod === 2 ? 1.6 : lod === 1 ? 1.2 : 1;
			B.tube( pts.map( ( p ) => p.clone().multiplyScalar( 1 / H ) ), rads.map( ( v ) => v * k / H ), sides,
				{ kind: - 1 - pl.bark, seed: lr(), ao: Math.min( 1, 0.45 + b.level * 0.2 ), height: 1 } );

		}

		const keep = sp.keep[ lod ], grow = 1 / Math.sqrt( keep );
		for ( const l of pl.leaves ) {

			if ( lr() > keep ) continue;
			const p = l.p.clone().multiplyScalar( 1 / H );
			const s = l.s / H * Math.min( grow, 3.2 );
			const out = l.p.clone().sub( cen ).multiplyScalar( 1 / rMax );
			const shell = Math.min( 1, out.length() );
			// card faces partly out of the canopy, random roll about its axis
			const radial = out.lengthSq() > 1e-6 ? out.clone().normalize() : new V3( 0, 1, 0 );
			const d = l.d.clone();
			const roll = new V3( lr() - 0.5, lr() - 0.5, lr() - 0.5 ).multiplyScalar( 1.4 );
			const n = radial.clone().add( roll ).normalize();
			const flower = sp.flower.length && p.y > 0.35 && shell > 0.5 && lr() < 0.7;
			const tiles = flower ? sp.flower : sp.leaf;
			const tile = tiles[ ( lr() * tiles.length ) | 0 ];
			// flower cards carry their tile + 100 so the bush's bloom can switch them to leaves
			const kind = flower ? 100 + tile * 16 + sp.leaf[ ( lr() * sp.leaf.length ) | 0 ] : tile;
			const ao = 0.35 + 0.65 * smooth( 0.2, 1.0, shell );
			// crossed pair (near LODs): the sprig has volume from every side, never a sliver
			const pair = lod < 2 ? 2 : 1;
			const w0 = s * range( lr, 0.85, 1.1 );
			// soft canopy normal shared by both cards (volume shading)
			const nn = n.clone().lerp( radial.clone().multiply( new V3( 1, 0.7, 1 ) ).add( new V3( 0, 0.35, 0 ) ).normalize(), 0.7 ).normalize();
			for ( let c = 0; c < pair; c ++ ) {

				const nc = c === 0 ? n : new V3().crossVectors( d, n ).normalize();
				B.card( p.clone().addScaledVector( d, - s * 0.08 ), d, nc, s * ( c ? 0.9 : 1 ), w0 * ( c ? 0.85 : 1 ), kind, ( l.seed + c * 0.37 ) % 1, ao, p.y );
				const at = B.nrm.length - 12;
				for ( let v = 0; v < 4; v ++ ) {

					B.nrm[ at + v * 3 ] = nn.x; B.nrm[ at + v * 3 + 1 ] = nn.y; B.nrm[ at + v * 3 + 2 ] = nn.z;

				}

			}

		}

		return B.geometry( true );

	} );

}

function smooth( a, b, x ) {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

}

