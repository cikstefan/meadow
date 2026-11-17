// Height and vegetation fields of the plains, written twice: in TSL for the GPU
// (grass, flowers, ground mesh) and in plain JS for the CPU (walking, scatter
// of shrubs and dead trees, the static far landscape). Both use the same
// bit-exact value noise, so every system agrees on where the ground is.
//
//   height = rolling plains + trail bed + lake basin       (GPU and CPU)
//          + eroded mountain relief (relief.js heightmap: CPU array + GPU texture),
//            so you can walk anywhere, onto the slopes and up the valleys

import { Fn, float, vec2, vec3, mix, smoothstep, clamp, max, min, abs, sqrt, sin, cos, dot, length, select } from 'three/tsl';
import { vnoise, vnoiseJS } from '../../tsl/noise.js';
import { U } from '../../tsl/uniforms.js';
import { TRAIL, LAKE, PAINE_GRANDE, CUERNOS, VALLEY_HEAD, FAR_HILLS, MOUNTAIN_FREE_RADIUS } from './layout.js';
import { buildRelief, reliefJS, relief, reliefIdJS } from './relief.js';

const D2R = Math.PI / 180;
const ss = ( a, b, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

// ---------------------------------------------------------------- rolling plains

// knolls, swales and gullies: 4 octaves of value noise
const OCT = [ [ 300, 26, 13.1, 7.7 ], [ 85, 7.5, 3.3, 91.2 ], [ 21, 1.3, 57.0, 21.0 ], [ 5.5, 0.22, 11.0, 3.0 ] ];

const rolling = ( xz ) => {

	let h = float( 0 );
	for ( const [ l, a, ox, oz ] of OCT ) h = h.add( vnoise( xz.div( l ).add( vec2( ox, oz ) ) ).sub( 0.5 ).mul( a ) );
	return h;

};

const rollingJS = ( x, z ) => {

	let h = 0;
	for ( const [ l, a, ox, oz ] of OCT ) h += ( vnoiseJS( x / l + ox, z / l + oz ) - 0.5 ) * a;
	return h;

};

// ---------------------------------------------------------------- trail

const TA = TRAIL.az * D2R;
const TF = [ Math.sin( TA ), - Math.cos( TA ) ]; // along
const TR = [ Math.cos( TA ), Math.sin( TA ) ]; // right

// distance (m) from the trail's centre line
export const trailDist = Fn( ( [ xz ] ) => {

	const a = dot( xz, vec2( ...TF ) );
	const l = dot( xz, vec2( ...TR ) );
	let c = float( 0 ), dc = float( 0 );
	for ( const [ amp, k ] of TRAIL.waves ) {

		c = c.add( sin( a.div( k ) ).mul( amp ) );
		dc = dc.add( cos( a.div( k ) ).mul( amp / k ) );

	}

	// the path pinches and widens along its length (worn wider where it's
	// muddy or braided), so distances are measured in units of the local width
	const wk = vnoise( vec2( a.div( 9.0 ), 3.3 ) ).mul( 1.1 ).add( vnoise( vec2( a.div( 3.1 ), 7.7 ) ).mul( 0.25 ) ).add( 0.6 );
	return abs( l.sub( c ) ).div( sqrt( dc.mul( dc ).add( 1.0 ) ) ).div( wk );

} );

export function trailDistJS( x, z ) {

	const a = x * TF[ 0 ] + z * TF[ 1 ];
	const l = x * TR[ 0 ] + z * TR[ 1 ];
	let c = 0, dc = 0;
	for ( const [ amp, k ] of TRAIL.waves ) {

		c += Math.sin( a / k ) * amp;
		dc += Math.cos( a / k ) * amp / k;

	}

	const wk = vnoiseJS( a / 9, 3.3 ) * 1.1 + vnoiseJS( a / 3.1, 7.7 ) * 0.25 + 0.6;
	return Math.abs( l - c ) / Math.sqrt( dc * dc + 1 ) / wk;

}

// trail centre point at along-coordinate a (for the tour / spawn)
export function trailPointJS( a ) {

	let c = 0;
	for ( const [ amp, k ] of TRAIL.waves ) c += Math.sin( a / k ) * amp;
	return [ TF[ 0 ] * a + TR[ 0 ] * c, TF[ 1 ] * a + TR[ 1 ] * c ];

}

const bedJS = ( d ) => - TRAIL.depth * ( 1 - ss( TRAIL.halfWidth * 0.6, TRAIL.halfWidth + 0.35, d ) );
const bed = ( d ) => float( 1.0 ).sub( smoothstep( TRAIL.halfWidth * 0.6, TRAIL.halfWidth + 0.35, d ) ).mul( - TRAIL.depth );

// ---------------------------------------------------------------- lake basin

// signed distance from the lake outline (negative inside the water)
const lakeSDF = ( xz ) => {

	const P = LAKE.axis, W = LAKE.halfWidth;
	let best = float( 1e9 );
	for ( let i = 0; i < P.length - 1; i ++ ) {

		const a = vec2( ...P[ i ] ), b = vec2( ...P[ i + 1 ] );
		const ab = b.sub( a );
		const t = clamp( dot( xz.sub( a ), ab ).div( dot( ab, ab ) ), 0.0, 1.0 );
		const d = length( xz.sub( a.add( ab.mul( t ) ) ) ).sub( mix( W[ i ], W[ i + 1 ], t ) );
		best = min( best, d );

	}

	return best;

};

function lakeSDFJS( x, z ) {

	const P = LAKE.axis, W = LAKE.halfWidth;
	let best = 1e9;
	for ( let i = 0; i < P.length - 1; i ++ ) {

		const [ ax, az ] = P[ i ], [ bx, bz ] = P[ i + 1 ];
		const abx = bx - ax, abz = bz - az;
		const t = Math.min( 1, Math.max( 0, ( ( x - ax ) * abx + ( z - az ) * abz ) / ( abx * abx + abz * abz ) ) );
		const dx = x - ( ax + abx * t ), dz = z - ( az + abz * t );
		best = Math.min( best, Math.hypot( dx, dz ) - ( W[ i ] + ( W[ i + 1 ] - W[ i ] ) * t ) );

	}

	return best;

}

// plains -> bluff -> shore -> lake bed
const basin = ( h, s ) => {

	const bank = smoothstep( 0.0, LAKE.bank, s );
	const shore = float( LAKE.level + 1.2 ).add( smoothstep( - 4.0, 30.0, s ).mul( 2.5 ) );
	const bedH = float( LAKE.level - LAKE.depth ).add( smoothstep( - 260.0, 0.0, s ).mul( LAKE.depth + 1 ) );
	const land = mix( shore, h, bank.mul( bank ).mul( float( 3.0 ).sub( bank.mul( 2.0 ) ) ) );
	return select( s.lessThan( 0.0 ), bedH, land );

};

const basinJS = ( h, s ) => {

	const bank = ss( 0, LAKE.bank, s );
	const shore = LAKE.level + 1.2 + ss( - 4, 30, s ) * 2.5;
	const bedH = LAKE.level - LAKE.depth + ss( - 260, 0, s ) * ( LAKE.depth + 1 );
	const land = shore + ( h - shore ) * ( bank * bank * ( 3 - 2 * bank ) );
	return s < 0 ? bedH : land;

};

// ---------------------------------------------------------------- terrain (GPU + CPU)

// the plains alone (no mountains)
function baseHeightJS( x, z ) {

	const h = rollingJS( x, z ) + bedJS( trailDistJS( x, z ) );
	return basinJS( h, lakeSDFJS( x, z ) );

}

const ensureRelief = () => buildRelief( mountainJS );

export const terrainHeight = Fn( ( [ xz ] ) => {

	ensureRelief();
	const h = rolling( xz ).add( bed( trailDist( xz ) ) );
	return basin( h, lakeSDF( xz ) ).add( relief( xz ) );

} );

export function terrainHeightJS( x, z ) {

	ensureRelief();
	return baseHeightJS( x, z ) + reliefJS( x, z );

}

// mountain height above the plains (eroded), for materials and masks
export const mountainHeight = ( xz ) => {

	ensureRelief();
	return relief( xz );

};
export function mountainHeightJS( x, z ) {

	ensureRelief();
	return reliefJS( x, z );

}

export const lakeDistJS = lakeSDFJS;
export const lakeDist = lakeSDF;

// ---------------------------------------------------------------- mountains (CPU only)

// ridged fbm, 0..1 (sharp crests)
function ridged( x, z, oct ) {

	let s = 0, a = 0.5, f = 1, norm = 0, prev = 1;
	for ( let i = 0; i < oct; i ++ ) {

		const n = 1 - Math.abs( vnoiseJS( x * f + i * 17.3, z * f + i * 5.1 ) * 2 - 1 );
		const r = n * n * prev;
		s += r * a; norm += a;
		prev = n;
		a *= 0.5; f *= 2.07;

	}

	return s / norm;

}

// nearest point on a crest polyline -> { d, h, s } (s: distance along the crest)
function crestDist( m, x, z ) {

	const P = m.crest;
	let best = 1e9, bh = 0, bs = 0, acc = 0;
	for ( let i = 0; i < P.length - 1; i ++ ) {

		const [ ax, az, ah ] = P[ i ], [ bx, bz, bh2 ] = P[ i + 1 ];
		const abx = bx - ax, abz = bz - az;
		const L2 = abx * abx + abz * abz, L = Math.sqrt( L2 );
		const t = Math.min( 1, Math.max( 0, ( ( x - ax ) * abx + ( z - az ) * abz ) / L2 ) );
		const d = Math.hypot( x - ( ax + abx * t ), z - ( az + abz * t ) );
		if ( d < best ) {

			best = d;
			const s = t * t * ( 3 - 2 * t );
			bh = ah + ( bh2 - ah ) * s;
			bs = acc + t * L;

		}

		acc += L;

	}

	return { d: best, h: bh, s: bs };

}

function massif( m, x, z, seed ) {

	// domain warp: crest lines and spurs wander instead of running ruler-straight
	const wx = x + ( vnoiseJS( x / 1400 + seed, z / 1400 ) - 0.5 ) * 700, wz = z + ( vnoiseJS( x / 1400 - 3, z / 1400 + seed ) - 0.5 ) * 700;
	const { d, h } = crestDist( m, wx, wz );
	const wob = 0.8 + 0.4 * vnoiseJS( wx / 1100 + seed, wz / 1100 - seed );
	const u = d / ( m.width * wob );
	if ( u >= 1 ) return 0;
	// uplift: steep massif profile; ridged multifractal relief (sharp aretes,
	// several summits of different heights), strongest high up
	const prof = Math.pow( 1 - u, m.steep );
	const rg = ridged( wx / 900 + seed, wz / 900 + seed * 0.7, 6 );
	const peaks = 0.62 + 0.55 * rg;
	return Math.max( 0, h * prof * peaks + ( rg - 0.5 ) * m.jag * h * 0.35 * Math.pow( 1 - u, 0.5 ) );

}

// Cuernos towers: sheer granite walls (steep plateau profile) topped by a
// pointed dark horn, all slightly irregular
const TOWERS = CUERNOS.towers.map( ( [ az, d, h, r, horn ] ) => {

	const a = az * Math.PI / 180;
	return { x: Math.sin( a ) * d, z: - Math.cos( a ) * d, h, r, horn };

} );

function towersJS( x, z ) {

	let m = 0;
	for ( const t of TOWERS ) {

		const dx = x - t.x, dz = z - t.z;
		const ang = Math.atan2( dz, dx );
		// irregular footprint (buttresses, chimneys)
		// irregular footprint: buttresses and chimneys run straight down the walls
		const rr = t.r * ( 0.8 + 0.25 * vnoiseJS( Math.cos( ang ) * 2.2 + t.x * 0.001, Math.sin( ang ) * 2.2 + 5 ) + 0.07 * Math.sin( ang * 5 ) + 0.05 * Math.sin( ang * 13 + t.z * 0.01 ) + 0.035 * Math.sin( ang * 29 ) );
		const d = Math.hypot( dx, dz ) / rr;
		if ( d > 2.2 ) continue;
		// walls: near-vertical between d 1.0 and 1.25, talus below
		const wall = 1 - ss( 0.85, 1.22, d );
		const talus = ( 1 - ss( 1.0, 2.2, d ) ) * 0.38;
		const top = t.h * Math.max( wall, talus * ( 1 - wall ) + wall );
		// the horn: a pointed cap on the summit plateau
		// the dark cap: a broad, jagged crown of sedimentary rock (several teeth,
		// not one cone), its own fractured profile
		const capR = Math.max( 0, 1 - d / 0.95 );
		const teeth = ridged( x / 110 + t.x * 0.01, z / 110, 4 );
		const horn = t.horn * Math.pow( capR, 0.55 ) * ( 0.35 + 0.75 * teeth ) * ( 0.8 + 0.3 * vnoiseJS( dx / 90, dz / 90 ) );
		const crag = ( ridged( x / 140, z / 140, 3 ) - 0.5 ) * 70 * wall;
		m = Math.max( m, top + horn + crag );

	}

	return m;

}

// analytic mountains (before erosion), metres above the plains
function mountainJS( x, z ) {

	const r = Math.hypot( x, z );
	const k = ss( MOUNTAIN_FREE_RADIUS, MOUNTAIN_FREE_RADIUS + 300, r );
	if ( k <= 0 ) return 0;
	const v = [ massif( PAINE_GRANDE, x, z, 3.1 ), Math.max( massif( CUERNOS, x, z, 7.7 ), towersJS( x, z ) ), massif( VALLEY_HEAD, x, z, 11.3 ), massif( FAR_HILLS, x, z, 19.9 ) ];
	let m = 0, id = 0;
	for ( let i = 0; i < 4; i ++ ) if ( v[ i ] > m ) {

		m = v[ i ]; id = v[ i ] > 20 ? i + 1 : 0;

	}

	mountainJS.id = id;
	return m * k;

}

// the whole landscape (plains + eroded mountains)
export function landHeightJS( x, z ) {

	return terrainHeightJS( x, z );

}

// which massif dominates at a point (for materials): 0 none, 1 Paine Grande, 2 Cuernos, 3 valley head, 4 hills
export function massifIdJS( x, z ) {

	ensureRelief();
	return reliefIdJS( x, z );

}

// ---------------------------------------------------------------- vegetation fields

// 0..1 tussock height (coirón tussocks, short-grazed hollows)
export const fieldTall = Fn( ( [ xz ] ) => {

	const a = smoothstep( 0.3, 0.9, vnoise( xz.div( 31 ).add( vec2( 41.0, 3.0 ) ) ) );
	const b = vnoise( xz.div( 7.5 ).add( vec2( 9.0, 77.0 ) ) );
	return a.mul( 0.62 ).add( b.mul( b ).mul( 0.38 ) );

} );

// 0..1 golden, last year's straw (most of the plain) vs fresh spring green
export const fieldDry = Fn( ( [ xz ] ) => {

	const a = vnoise( xz.div( 46 ).add( vec2( 101.0, 19.0 ) ) );
	const b = vnoise( xz.div( 9.0 ).add( vec2( 5.0, 33.0 ) ) );
	return smoothstep( 0.38, 0.8, a.mul( 0.72 ).add( b.mul( 0.28 ) ) ).mul( U.dry );

} );

// 0..1 small spring flowers: along the trail verges and in gravelly patches
export const fieldFlowers = Fn( ( [ xz ] ) => {

	const a = vnoise( xz.div( 19 ).add( vec2( 7.0, 140.0 ) ) );
	const b = vnoise( xz.div( 4.0 ).add( vec2( 66.0, 12.0 ) ) );
	const verge = smoothstep( 4.0, 0.8, trailDist( xz ) );
	return clamp( smoothstep( 0.55, 0.92, a.mul( 0.7 ).add( b.mul( 0.3 ) ) ).add( verge.mul( 0.45 ) ), 0.0, 1.0 );

} );

export function fieldsJS( x, z ) {

	const tb = vnoiseJS( x / 7.5 + 9, z / 7.5 + 77 );
	const tall = ss( 0.3, 0.9, vnoiseJS( x / 31 + 41, z / 31 + 3 ) ) * 0.62 + tb * tb * 0.38;
	const dry = ss( 0.38, 0.8, vnoiseJS( x / 46 + 101, z / 46 + 19 ) * 0.72 + vnoiseJS( x / 9 + 5, z / 9 + 33 ) * 0.28 ) * U.dry.value;
	const flowers = Math.min( 1, ss( 0.55, 0.92, vnoiseJS( x / 19 + 7, z / 19 + 140 ) * 0.7 + vnoiseJS( x / 4 + 66, z / 4 + 12 ) * 0.3 ) + ss( 4, 0.8, trailDistJS( x, z ) ) * 0.45 );
	return { tall, dry, flowers };

}

// bare gravel / schist patches where the grass thins out (0..1)
export const gravelPatch = Fn( ( [ xz ] ) => {

	const a = vnoise( xz.div( 23 ).add( vec2( 31.0, 61.0 ) ) );
	const b = vnoise( xz.div( 5.0 ).add( vec2( 3.0, 8.0 ) ) );
	return smoothstep( 0.68, 0.86, a.mul( 0.75 ).add( b.mul( 0.25 ) ) );

} );

export function gravelPatchJS( x, z ) {

	return ss( 0.68, 0.86, vnoiseJS( x / 23 + 31, z / 23 + 61 ) * 0.75 + vnoiseJS( x / 5 + 3, z / 5 + 8 ) * 0.25 );

}

// grass multiplier: none on the trail bed, sparse on the trampled verge and the
// gravel patches, none under water
export const grassMask = Fn( ( [ xz ] ) => {

	const d = trailDist( xz );
	const trail = smoothstep( TRAIL.halfWidth * 0.85, TRAIL.halfWidth + TRAIL.verge, d );
	const g = float( 1.0 ).sub( gravelPatch( xz ).mul( 0.75 ) );
	const wet = smoothstep( - 2.0, 3.0, lakeSDF( xz ) );
	// grass thins out up the mountain slopes (scree and rock above)
	const alp = smoothstep( 320.0, 70.0, mountainHeight( xz ) );
	return trail.mul( g ).mul( wet ).mul( alp );

} );

// shrub / dead-tree densities for the CPU scatter
export function shrubDensityJS( x, z ) {

	const a = vnoiseJS( x / 38 + 5, z / 38 + 71 );
	const b = vnoiseJS( x / 11 + 41, z / 11 + 9 );
	const n = a * 0.7 + b * 0.3;
	// thickets crowd the trail edges (photo: notro lining the path)
	const near = ss( 12, 3, trailDistJS( x, z ) ) * 0.35;
	return Math.min( 1, ss( 0.38, 0.75, n ) + near );

}

export function ghostDensityJS( x, z ) {

	// burnt stands on the hillsides: patchy, denser away from the trail
	const a = vnoiseJS( x / 140 + 13, z / 140 + 29 );
	const b = vnoiseJS( x / 35 + 3, z / 35 + 17 );
	return ss( 0.45, 0.8, a * 0.75 + b * 0.25 );

}
