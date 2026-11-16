// Procedural foliage atlas (canvas 2D, drawn once at load). Each tile is a
// twig-sized card of leaves or flowers seen from outside the bush; the shrub
// shader picks tiles per card. Alpha = coverage (alpha-to-coverage edges).
//
//   0 notro leaves      1 notro flowers (scarlet tubular clusters)
//   2 calafate leaves   3 calafate flowers (tiny yellow cups)
//   4 mata negra        5 mata barrosa (spiny grey-green cushion)
//   6 bare twigs        7 lenga / ñirre sprigs (fresh spring green)

import * as THREE from 'three/webgpu';

export const TILES = 8;
const COLS = 4, ROWS = 2, T = 256;

function rng( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

const hsl = ( h, s, l, a = 1 ) => `hsla(${ h },${ s }%,${ l }%,${ a })`;

function leaf( g, x, y, len, wid, ang, col, edge ) {

	g.save();
	g.translate( x, y );
	g.rotate( ang );
	g.beginPath();
	g.moveTo( 0, 0 );
	g.quadraticCurveTo( len * 0.45, - wid, len, 0 );
	g.quadraticCurveTo( len * 0.45, wid, 0, 0 );
	g.fillStyle = col;
	g.fill();
	if ( edge ) {

		g.strokeStyle = edge;
		g.lineWidth = 0.8;
		g.beginPath();
		g.moveTo( len * 0.1, 0 );
		g.lineTo( len * 0.85, 0 );
		g.stroke();

	}

	g.restore();

}

function twig( g, r, x0, y0, x1, y1, w, col ) {

	g.strokeStyle = col;
	g.lineWidth = w;
	g.lineCap = 'round';
	g.beginPath();
	g.moveTo( x0, y0 );
	const mx = ( x0 + x1 ) / 2 + ( r() - 0.5 ) * 18, my = ( y0 + y1 ) / 2 + ( r() - 0.5 ) * 18;
	g.quadraticCurveTo( mx, my, x1, y1 );
	g.stroke();

}

// a sprig: stem from the card's bottom edge with leaves along it
function sprig( g, r, opt ) {

	const { leaves, len, wid, hue, sat, light, spread, stem = 'rgba(60,40,25,1)', alt = false } = opt;
	const x0 = T * ( 0.3 + r() * 0.4 ), y0 = T * 0.98;
	const ang = - Math.PI / 2 + ( r() - 0.5 ) * spread;
	const L = T * ( 0.55 + r() * 0.35 );
	const x1 = x0 + Math.cos( ang ) * L, y1 = y0 + Math.sin( ang ) * L;
	twig( g, r, x0, y0, x1, y1, 2.2, stem );
	for ( let i = 0; i < leaves; i ++ ) {

		const t = 0.15 + 0.85 * ( i / leaves ) + ( r() - 0.5 ) * 0.05;
		const x = x0 + ( x1 - x0 ) * t, y = y0 + ( y1 - y0 ) * t;
		const side = alt ? ( i % 2 ? 1 : - 1 ) : ( r() < 0.5 ? 1 : - 1 );
		const a = ang + side * ( 0.6 + r() * 0.7 );
		const l = len * ( 0.7 + r() * 0.5 ) * ( 1 - t * 0.35 );
		leaf( g, x, y, l, wid * ( 0.8 + r() * 0.4 ), a, hsl( hue + ( r() - 0.5 ) * 10, sat + ( r() - 0.5 ) * 10, light * ( 0.75 + r() * 0.5 ) ),
			hsl( hue, sat, light * 0.6, 0.6 ) );

	}

}

function tile( g, i ) {

	const r = rng( 7919 * ( i + 1 ) );
	g.clearRect( 0, 0, T, T );
	switch ( i ) {

		case 0: // notro: glossy oblong leaves, mid green
			for ( let k = 0; k < 6; k ++ ) sprig( g, r, { leaves: 9, len: 40, wid: 10, hue: 95, sat: 38, light: 26, spread: 1.6 } );
			break;
		case 1: { // notro flowers: dense scarlet clusters of curved tubes with split tips

			for ( let k = 0; k < 3; k ++ ) sprig( g, r, { leaves: 6, len: 36, wid: 9, hue: 95, sat: 35, light: 24, spread: 1.4 } );
			for ( let c = 0; c < 5; c ++ ) {

				const cx = T * ( 0.18 + r() * 0.64 ), cy = T * ( 0.15 + r() * 0.6 );
				const n = 10 + ( r() * 8 ) | 0;
				for ( let k = 0; k < n; k ++ ) {

					const a = r() * Math.PI * 2, L = 18 + r() * 22;
					const x1 = cx + Math.cos( a ) * L, y1 = cy + Math.sin( a ) * L * 0.8;
					g.strokeStyle = hsl( 6 + r() * 9, 92, 44 + r() * 10 );
					g.lineWidth = 5 + r() * 3;
					g.lineCap = 'round';
					g.beginPath();
					g.moveTo( cx, cy );
					g.quadraticCurveTo( ( cx + x1 ) / 2 + ( r() - 0.5 ) * 10, ( cy + y1 ) / 2 - 6, x1, y1 );
					g.stroke();
					// split, curled tip (lighter)
					g.fillStyle = hsl( 8, 90, 55 );
					g.beginPath();
					g.arc( x1, y1, 2.6, 0, Math.PI * 2 );
					g.fill();

				}

			}

			break;

		}

		case 2: // calafate: small, stiff, dark-green obovate leaves in tufts + spines
			for ( let k = 0; k < 7; k ++ ) sprig( g, r, { leaves: 12, len: 20, wid: 7, hue: 88, sat: 30, light: 22, spread: 1.8, stem: 'rgba(90,60,35,1)' } );
			break;
		case 3: { // calafate in bloom: tiny round yellow-orange flowers on short stalks

			for ( let k = 0; k < 5; k ++ ) sprig( g, r, { leaves: 10, len: 18, wid: 6, hue: 85, sat: 30, light: 22, spread: 1.8, stem: 'rgba(90,60,35,1)' } );
			for ( let k = 0; k < 70; k ++ ) {

				const x = T * ( 0.1 + r() * 0.8 ), y = T * ( 0.08 + r() * 0.75 );
				g.fillStyle = hsl( 40 + r() * 10, 95, 48 + r() * 8 );
				g.beginPath();
				g.arc( x, y, 4 + r() * 3, 0, Math.PI * 2 );
				g.fill();
				g.fillStyle = hsl( 30, 90, 32 );
				g.beginPath();
				g.arc( x, y, 1.6, 0, Math.PI * 2 );
				g.fill();

			}

			break;

		}

		case 4: // mata negra: dense, very dark green narrow leaves
			for ( let k = 0; k < 9; k ++ ) sprig( g, r, { leaves: 16, len: 24, wid: 4, hue: 100, sat: 28, light: 15, spread: 1.9, alt: true, stem: 'rgba(40,35,25,1)' } );
			break;
		case 5: // mata barrosa: stiff grey-green spines radiating from tufts
			for ( let c = 0; c < 9; c ++ ) {

				const cx = T * ( 0.15 + r() * 0.7 ), cy = T * ( 0.2 + r() * 0.7 );
				for ( let k = 0; k < 22; k ++ ) {

					const a = - Math.PI / 2 + ( r() - 0.5 ) * 2.6, L = 18 + r() * 26;
					g.strokeStyle = hsl( 75 + r() * 15, 18, 40 + r() * 14 );
					g.lineWidth = 2.2;
					g.beginPath();
					g.moveTo( cx, cy );
					g.lineTo( cx + Math.cos( a ) * L, cy + Math.sin( a ) * L );
					g.stroke();

				}

			}

			break;
		case 6: // bare twigs
			for ( let k = 0; k < 9; k ++ ) {

				const x0 = T * ( 0.2 + r() * 0.6 ), y0 = T;
				twig( g, r, x0, y0, x0 + ( r() - 0.5 ) * T * 0.8, T * r() * 0.4, 2.5, hsl( 30, 12, 45 + r() * 20 ) );

			}

			break;
		case 7: // fresh spring sprigs (ñirre / lenga regrowth)
			for ( let k = 0; k < 6; k ++ ) sprig( g, r, { leaves: 9, len: 26, wid: 13, hue: 82, sat: 55, light: 36, spread: 1.6 } );
			break;

	}

}

export function buildFoliageAtlas() {

	const c = document.createElement( 'canvas' );
	c.width = COLS * T; c.height = ROWS * T;
	const g = c.getContext( '2d' );
	const t = document.createElement( 'canvas' );
	t.width = t.height = T;
	const tg = t.getContext( '2d' );
	for ( let i = 0; i < TILES; i ++ ) {

		tile( tg, i );
		g.drawImage( t, ( i % COLS ) * T, Math.floor( i / COLS ) * T );

	}

	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.anisotropy = 4;
	tex.flipY = false;
	return { texture: tex, cols: COLS, rows: ROWS, canvas: c };

}
