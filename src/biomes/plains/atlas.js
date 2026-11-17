// Foliage atlas for the scrub, composited once at load from photoscanned leaf
// cut-outs (CC0, see the jose plant generator: card_ovs / card_ov from
// ambientCG and treesDesigner scans, willow sprigs) plus drawn flowers.
// Each 256 px tile is a sprig as seen from outside the bush, its stem leaving
// the bottom edge of the tile so the cards can sit on the branch tips.
//
//   0,1 notro leaf sprays     2,3 notro in bloom (scarlet tubular racemes)
//   4 calafate leaves         5 calafate in bloom (small yellow-orange cups)
//   6 mata negra (tiny dark)  7 mata barrosa (spiny grey-green cushion)
//   8 bare twigs              9 young notro shoots (lighter)
//
// After drawing, colour is bled outward into the transparent area so the
// mipmaps never fringe dark, and the result is uploaded as a DataTexture.

import * as THREE from 'three/webgpu';
import { rng } from './grow.js';

const COLS = 8, ROWS = 2, T = 256;
export const TILE = { notro: 0, notro2: 1, notroFl: 2, notroFl2: 3, cala: 4, calaFl: 5, negra: 6, barrosa: 7, twigs: 8, notroYoung: 9, leaf: 10, leaf2: 11 };

const SRC = {
	ovs: new URL( '../../assets/plains/card_ovs.webp', import.meta.url ).href, // 4 elliptic glossy leaves (512 px each)
	ov: new URL( '../../assets/plains/card_ov_s.webp', import.meta.url ).href, // 4 rounder leaves (256 x 384)
	willow: new URL( '../../assets/plains/card_willow_s.webp', import.meta.url ).href, // 4 narrow-leaved sprigs (256)
};

function load( url ) {

	return new Promise( ( res, rej ) => {

		const im = new Image();
		im.onload = () => res( im );
		im.onerror = rej;
		im.src = url;

	} );

}

const hsl = ( h, s, l, a = 1 ) => `hsla(${ h },${ s }%,${ l }%,${ a })`;

// a curved twig from (x0,y0) to (x1,y1)
function twig( g, r, x0, y0, x1, y1, w, col ) {

	g.strokeStyle = col;
	g.lineWidth = w;
	g.lineCap = 'round';
	g.beginPath();
	g.moveTo( x0, y0 );
	const mx = ( x0 + x1 ) / 2 + ( r() - 0.5 ) * 20, my = ( y0 + y1 ) / 2 + ( r() - 0.5 ) * 14;
	g.quadraticCurveTo( mx, my, x1, y1 );
	g.stroke();
	return ( t ) => {

		const a = ( 1 - t ) * ( 1 - t ), b = 2 * ( 1 - t ) * t, c = t * t;
		return [ a * x0 + b * mx + c * x1, a * y0 + b * my + c * y1 ];

	};

}

// draw scanned leaf k of a strip image with its stalk at (x, y), pointing along `ang`
function scanLeaf( g, img, k, n, x, y, len, ang, squash, filter ) {

	const sw = img.width / n, sh = img.height;
	g.save();
	g.translate( x, y );
	g.rotate( ang + Math.PI / 2 );
	g.scale( squash, 1 );
	g.filter = filter;
	const h = len, w = len * sw / sh;
	g.drawImage( img, k * sw, 0, sw, sh, - w / 2, - h, w, h );
	g.restore();

}

// a spray of scanned leaves alternating along a curved twig
function leafSpray( g, r, img, n, o ) {

	const x0 = T * ( 0.5 + ( r() - 0.5 ) * 0.25 ), y0 = T * 0.995;
	const ang = - Math.PI / 2 + ( r() - 0.5 ) * o.spread;
	const L = T * range( r, o.reach[ 0 ], o.reach[ 1 ] );
	const at = twig( g, r, x0, y0, x0 + Math.cos( ang ) * L, y0 + Math.sin( ang ) * L, o.stemW, o.stem );
	for ( let i = 0; i < o.leaves; i ++ ) {

		const t = o.start + ( 1 - o.start ) * ( i / Math.max( 1, o.leaves - 1 ) ) + ( r() - 0.5 ) * 0.05;
		const [ x, y ] = at( Math.min( 1, t ) );
		const side = i % 2 ? 1 : - 1;
		const a = ang + side * range( r, o.angle[ 0 ], o.angle[ 1 ] ) * ( i === o.leaves - 1 ? 0.2 : 1 );
		const len = T * range( r, o.size[ 0 ], o.size[ 1 ] ) * ( 1 - t * o.shrink );
		scanLeaf( g, img, ( r() * n ) | 0, n, x, y, len, a, range( r, 0.55, 1 ), o.filter( r ) );

	}

}

const range = ( r, a, b ) => a + ( b - a ) * r();

// Embothrium coccineum: racemes of curved scarlet tubes that split into four
// curled lobes, the long style sticking out past them
function notroRaceme( g, r, cx, cy, n, scale ) {

	for ( let k = 0; k < n; k ++ ) {

		const a = - Math.PI / 2 + ( r() - 0.5 ) * 3.6;
		const L = ( 26 + r() * 16 ) * scale;
		const sx = cx + ( r() - 0.5 ) * 10 * scale, sy = cy + ( r() - 0.5 ) * 10 * scale;
		const bend = ( r() - 0.5 ) * 1.2;
		const ex = sx + Math.cos( a ) * L, ey = sy + Math.sin( a ) * L;
		const mx = ( sx + ex ) / 2 + Math.cos( a + Math.PI / 2 ) * L * 0.25 * bend, my = ( sy + ey ) / 2 + Math.sin( a + Math.PI / 2 ) * L * 0.25 * bend;
		const w = ( 5 + r() * 2.5 ) * scale;
		const hue = 2 + r() * 10, li = 36 + r() * 10;
		// tube: dark side, body, highlight
		for ( const [ lw, l, off ] of [ [ w, li * 0.62, 0 ], [ w * 0.72, li, - 0.6 ], [ w * 0.28, li + 20, - 1.6 ] ] ) {

			g.strokeStyle = hsl( hue, 88, l );
			g.lineWidth = lw;
			g.lineCap = 'round';
			g.beginPath();
			g.moveTo( sx + off, sy + off * 0.5 );
			g.quadraticCurveTo( mx + off, my + off * 0.5, ex + off * 0.5, ey );
			g.stroke();

		}

		// four curled-back lobes at the mouth
		g.strokeStyle = hsl( hue + 4, 90, li + 8 );
		g.lineWidth = 1.6 * scale;
		for ( let j = 0; j < 3; j ++ ) {

			const b = a + ( j - 1 ) * 0.9 + ( r() - 0.5 ) * 0.4;
			g.beginPath();
			g.arc( ex + Math.cos( b ) * 3 * scale, ey + Math.sin( b ) * 3 * scale, 2.6 * scale, b, b + 3.5 );
			g.stroke();

		}

		// style + stigma
		g.strokeStyle = hsl( hue, 70, 30 );
		g.lineWidth = 1.1 * scale;
		g.beginPath();
		g.moveTo( ex, ey );
		const sl = ( 9 + r() * 7 ) * scale;
		g.lineTo( ex + Math.cos( a + bend * 0.3 ) * sl, ey + Math.sin( a + bend * 0.3 ) * sl );
		g.stroke();
		g.fillStyle = hsl( 40, 70, 45 );
		g.beginPath();
		g.arc( ex + Math.cos( a + bend * 0.3 ) * sl, ey + Math.sin( a + bend * 0.3 ) * sl, 1.4 * scale, 0, 6.3 );
		g.fill();

	}

}

function tile( g, i, I ) {

	const r = rng( 7919 * ( i + 3 ) );
	g.clearRect( 0, 0, T, T );
	g.filter = 'none';
	// glossy, leathery, deep green; some sun-yellowed, some reddish when young
	const notroF = ( k ) => ( r ) => `brightness(${ ( 0.42 + r() * 0.16 ) * k }) saturate(${ 1.0 + r() * 0.3 }) hue-rotate(${ 6 + r() * 14 }deg) contrast(1.15)`;
	const notro = { leaves: 9, start: 0.18, reach: [ 0.55, 0.85 ], spread: 1.5, angle: [ 0.5, 1.1 ], size: [ 0.26, 0.38 ], shrink: 0.35, stemW: 2.2, stem: 'rgb(70,48,34)', filter: notroF( 1 ) };
	switch ( i ) {

		case TILE.notro:
		case TILE.notro2:
			for ( let k = 0; k < ( i === TILE.notro ? 4 : 5 ); k ++ ) leafSpray( g, r, I.ovs, 4, notro );
			break;
		case TILE.leaf:
		case TILE.leaf2:
			// one whole scanned leaf, stalk at the bottom centre (individual 3D leaves)
			scanLeaf( g, I.ovs, i === TILE.leaf ? 0 : 3, 4, T / 2, T, T * 1.0, - Math.PI / 2, 1.0, i === TILE.leaf ? 'brightness(0.5) saturate(1.1) hue-rotate(10deg) contrast(1.15)' : 'brightness(0.6) saturate(1.05) hue-rotate(4deg) contrast(1.1)' );
			break;
		case TILE.notroYoung:
			for ( let k = 0; k < 4; k ++ ) leafSpray( g, r, I.ovs, 4, { ...notro, filter: ( r ) => `brightness(${ 0.8 + r() * 0.2 }) saturate(1.15) hue-rotate(${ - 14 + r() * 10 }deg)` } );
			break;
		case TILE.notroFl:
		case TILE.notroFl2: {

			for ( let k = 0; k < 3; k ++ ) leafSpray( g, r, I.ovs, 4, { ...notro, leaves: 6, reach: [ 0.45, 0.7 ] } );
			const nr = i === TILE.notroFl ? 4 : 7;
			for ( let c = 0; c < nr; c ++ ) notroRaceme( g, r, T * range( r, 0.2, 0.8 ), T * range( r, 0.15, 0.65 ), 12 + ( r() * 9 | 0 ), i === TILE.notroFl ? 1.25 : 1.05 );
			break;

		}

		case TILE.cala:
		case TILE.calaFl: {

			// Berberis microphylla: arching spiny stems, fascicles of small obovate leaves at each node
			for ( let k = 0; k < 6; k ++ ) {

				const x0 = T * range( r, 0.25, 0.75 ), y0 = T;
				const a = - Math.PI / 2 + ( r() - 0.5 ) * 1.9, L = T * range( r, 0.6, 0.95 );
				const at = twig( g, r, x0, y0, x0 + Math.cos( a ) * L, y0 + Math.sin( a ) * L, 1.8, 'rgb(105,80,58)' );
				for ( let j = 1; j < 9; j ++ ) {

					const [ x, y ] = at( j / 9 );
					// three-parted spine
					g.strokeStyle = 'rgba(200,185,140,0.9)';
					g.lineWidth = 0.9;
					for ( let s = - 1; s <= 1; s ++ ) {

						const b = a + Math.PI * 0.5 * ( r() < 0.5 ? 1 : - 1 ) + s * 0.5;
						g.beginPath(); g.moveTo( x, y ); g.lineTo( x + Math.cos( b ) * 7, y + Math.sin( b ) * 7 ); g.stroke();

					}

					const nl = 3 + ( r() * 4 | 0 );
					for ( let l = 0; l < nl; l ++ ) scanLeaf( g, I.ov, ( r() * 4 ) | 0, 4, x, y, T * range( r, 0.07, 0.11 ), a + ( r() - 0.5 ) * 2.6, range( r, 0.6, 1 ),
						`brightness(${ 0.5 + r() * 0.18 }) saturate(0.85) hue-rotate(${ - 12 + r() * 10 }deg)` );
					if ( i === TILE.calaFl && r() < 0.6 ) {

						const fx = x + ( r() - 0.5 ) * 14, fy = y - 6 - r() * 8, fr = 4.2 + r() * 2;
						g.strokeStyle = 'rgba(120,90,30,0.9)'; g.lineWidth = 0.8;
						g.beginPath(); g.moveTo( x, y ); g.lineTo( fx, fy ); g.stroke();
						const grd = g.createRadialGradient( fx - fr * 0.3, fy - fr * 0.3, 0.5, fx, fy, fr );
						grd.addColorStop( 0, 'rgb(255,226,90)' ); grd.addColorStop( 0.6, 'rgb(244,170,30)' ); grd.addColorStop( 1, 'rgb(190,110,20)' );
						g.fillStyle = grd;
						g.beginPath(); g.arc( fx, fy, fr, 0, 6.3 ); g.fill();

					}

				}

			}

			break;

		}

		case TILE.negra:
			// Mulguraea tridens: wiry stems densely clad in tiny dark leaves
			for ( let k = 0; k < 10; k ++ ) {

				const x = T * range( r, 0.2, 0.8 ), y = T;
				scanLeaf( g, I.willow, ( r() * 4 ) | 0, 4, x, y, T * range( r, 0.55, 0.95 ), - Math.PI / 2 + ( r() - 0.5 ) * 1.4, range( r, 0.7, 1.1 ),
					`brightness(${ 0.36 + r() * 0.14 }) saturate(0.7) hue-rotate(${ 8 + r() * 14 }deg) contrast(1.15)` );

			}

			break;
		case TILE.barrosa:
			// Mulinum spinosum: stiff three-forked grey-green spiny leaves on a tight cushion
			for ( let c = 0; c < 16; c ++ ) {

				const cx = T * range( r, 0.1, 0.9 ), cy = T * range( r, 0.15, 0.95 );
				for ( let k = 0; k < 7; k ++ ) {

					const a = - Math.PI / 2 + ( r() - 0.5 ) * 2.8, L = 16 + r() * 22;
					const x1 = cx + Math.cos( a ) * L, y1 = cy + Math.sin( a ) * L;
					g.strokeStyle = hsl( 68 + r() * 18, 16 + r() * 10, 38 + r() * 18 );
					g.lineWidth = 2.4;
					g.lineCap = 'round';
					g.beginPath(); g.moveTo( cx, cy ); g.lineTo( x1, y1 ); g.stroke();
					g.lineWidth = 1.2;
					for ( const s of [ - 0.45, 0.45 ] ) {

						g.beginPath(); g.moveTo( x1, y1 ); g.lineTo( x1 + Math.cos( a + s ) * 8, y1 + Math.sin( a + s ) * 8 ); g.stroke();

					}

				}

			}

			break;
		case TILE.twigs:
			for ( let k = 0; k < 9; k ++ ) {

				const x0 = T * ( 0.2 + r() * 0.6 );
				twig( g, r, x0, T, x0 + ( r() - 0.5 ) * T * 0.8, T * r() * 0.4, 2.5, hsl( 30, 12, 45 + r() * 20 ) );

			}

			break;

	}

	g.filter = 'none';

}

// bleed colour into transparent texels (a few dilation passes, then the mean)
export function bleed( d, W, H ) {

	const has = new Uint8Array( W * H );
	let sr = 0, sg = 0, sb = 0, sn = 0;
	for ( let i = 0; i < W * H; i ++ ) if ( d[ i * 4 + 3 ] > 24 ) {

		has[ i ] = 1; sr += d[ i * 4 ]; sg += d[ i * 4 + 1 ]; sb += d[ i * 4 + 2 ]; sn ++;

	}

	for ( let pass = 0; pass < 10; pass ++ ) {

		const next = has.slice();
		for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

			const i = y * W + x;
			if ( has[ i ] ) continue;
			let r = 0, g = 0, b = 0, n = 0;
			for ( const [ dx, dy ] of [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ] ) {

				const xx = x + dx, yy = y + dy;
				if ( xx < 0 || yy < 0 || xx >= W || yy >= H ) continue;
				const j = yy * W + xx;
				if ( ! has[ j ] ) continue;
				r += d[ j * 4 ]; g += d[ j * 4 + 1 ]; b += d[ j * 4 + 2 ]; n ++;

			}

			if ( n ) {

				d[ i * 4 ] = r / n; d[ i * 4 + 1 ] = g / n; d[ i * 4 + 2 ] = b / n; next[ i ] = 1;

			}

		}

		has.set( next );

	}

	if ( sn ) for ( let i = 0; i < W * H; i ++ ) if ( ! has[ i ] ) {

		d[ i * 4 ] = sr / sn; d[ i * 4 + 1 ] = sg / sn; d[ i * 4 + 2 ] = sb / sn;

	}

}

export async function buildFoliageAtlas() {

	const [ ovs, ov, willow ] = await Promise.all( [ load( SRC.ovs ), load( SRC.ov ), load( SRC.willow ) ] );
	const I = { ovs, ov, willow };
	const c = document.createElement( 'canvas' );
	c.width = COLS * T; c.height = ROWS * T;
	const g = c.getContext( '2d', { willReadFrequently: true } );
	const t = document.createElement( 'canvas' );
	t.width = t.height = T;
	const tg = t.getContext( '2d' );
	for ( let i = 0; i < COLS * ROWS; i ++ ) {

		tile( tg, i, I );
		g.drawImage( t, ( i % COLS ) * T, Math.floor( i / COLS ) * T );

	}

	const img = g.getImageData( 0, 0, c.width, c.height );
	bleed( img.data, c.width, c.height );
	const tex = new THREE.DataTexture( new Uint8Array( img.data.buffer ), c.width, c.height, THREE.RGBAFormat );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.anisotropy = 4;
	tex.flipY = false;
	tex.needsUpdate = true;
	return { texture: tex, cols: COLS, rows: ROWS, canvas: c };

}
