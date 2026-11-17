// Procedural woody growth shared by the scrub and the ghost forest (a compact
// port of the growTree / barkGeometry ideas from the jose plant generator).
//
// A plant is a list of branches, each a polyline with radii. Stems sweep in
// long S-curves (two slow sine bends about perpendicular axes), corkscrew a
// little (swirl), bend toward a tropism vector (light, and the prevailing
// westerlies that flag every exposed tree on the plains) and never dig into
// the ground. Children leave their parent along its flow, curve out to their
// own heading and swell into a branch collar where they join.
//
// Builder turns branches into merged tube geometry plus alpha cards; every
// vertex carries `card` (kind, seed, ao, height) and `cnorm` so the shrub and
// tree shaders can treat wood and foliage in one draw.

import * as THREE from 'three/webgpu';

export function rng( seed ) {

	let s = ( seed >>> 0 ) || 1;
	return () => {

		s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

const range = ( r, a, b ) => a + ( b - a ) * r();

const _up = new THREE.Vector3( 0, 1, 0 );
function perp( d ) {

	const t = Math.abs( d.y ) < 0.9 ? _up : new THREE.Vector3( 1, 0, 0 );
	return new THREE.Vector3().crossVectors( d, t ).normalize();

}

// point + tangent + radius at arc fraction f along a branch
export function branchAt( b, f ) {

	const c = b.cum, n = b.pts.length - 1;
	f = Math.min( 1, Math.max( 0, f ) );
	let i = 0;
	while ( i < n - 1 && c[ i + 1 ] < f ) i ++;
	const span = Math.max( 1e-6, c[ i + 1 ] - c[ i ] ), t = ( f - c[ i ] ) / span;
	const p = b.pts[ i ].clone().lerp( b.pts[ i + 1 ], t );
	const T = b.pts[ i + 1 ].clone().sub( b.pts[ i ] ).normalize();
	const r = b.rads[ i ] + ( b.rads[ i + 1 ] - b.rads[ i ] ) * t;
	return { p, T, r };

}

function arcCum( pts ) {

	const c = [ 0 ];
	for ( let i = 1; i < pts.length; i ++ ) c.push( c[ i - 1 ] + pts[ i ].distanceTo( pts[ i - 1 ] ) );
	const L = c[ c.length - 1 ] || 1;
	return c.map( ( v ) => v / L );

}

/**
 * Grow a branching plant.
 * P.trunks: [{ p: Vector3, d: Vector3, len, r }]
 * P.lv[level]: { segs, bend, curveV, swirl, trop: [x,y,z], taper, tipR,
 *   (children of this level use the NEXT entry:) dens, range: [a,b], down: [mean, var], len: [a,b],
 *   up, rPow, minLen, filter(dir, b, f, r) -> length multiplier (0 = skip) }
 * P.floor: lowest y a shoot may reach (default trunk base + 0.03)
 */
export function growTree( r, P ) {

	const branches = [];
	const floor = P.floor ?? ( P.trunks[ 0 ].p.y + 0.03 );

	const stem = ( O, d, len, L, pT ) => {

		const n = Math.max( 2, Math.round( L.segs || 6 ) );
		const pts = [ O.clone() ], goal = d.clone().normalize(), dir = goal.clone();
		const lead = pT ? ( L.lead ?? 0.45 ) : 0;
		if ( lead ) dir.lerp( pT, lead ).normalize();
		const swirl = ( L.swirl ?? 0.3 ) * range( r, 0.5, 1.2 ) * ( r() < 0.5 ? - 1 : 1 );
		const bend = L.bend ?? 0.3, w1 = range( r, 0.9, 2.1 ), w2 = range( r, 0.7, 1.8 ), p1 = range( r, 0, 6.28 ), p2 = range( r, 0, 6.28 ), b2 = range( r, 0.5, 1 );
		const bx = perp( dir ).applyAxisAngle( dir, range( r, 0, 6.28 ) );
		const tr = L.trop ? new THREE.Vector3( ...L.trop ) : null;
		const p = O.clone();
		for ( let i = 1; i <= n; i ++ ) {

			const f = i / n;
			bx.sub( dir.clone().multiplyScalar( bx.dot( dir ) ) ).normalize();
			dir.applyAxisAngle( bx, bend * Math.PI * w1 / n * Math.cos( Math.PI * w1 * f + p1 ) );
			dir.applyAxisAngle( dir.clone().cross( bx ).normalize(), bend * b2 * Math.PI * w2 / n * Math.cos( Math.PI * w2 * f + p2 ) );
			if ( swirl ) dir.applyAxisAngle( goal, swirl / n );
			if ( lead && f < 0.4 ) dir.lerp( goal, 0.42 * ( 1 - f / 0.4 ) + 0.08 ).normalize();
			if ( L.curveV ) dir.applyAxisAngle( perp( dir ).applyAxisAngle( dir, range( r, 0, 6.28 ) ), range( r, - 0.5, 0.5 ) * L.curveV / Math.sqrt( n ) );
			if ( tr ) dir.addScaledVector( tr, len / n ).normalize();
			// a shoot that would dip into the ground runs along it and turns up again
			if ( p.y + dir.y * len / n < floor ) {

				const lift = ( floor - p.y ) / ( len / n ) + 0.15;
				if ( dir.y < lift ) {

					dir.y = Math.min( 0.9, lift ); dir.normalize();

				}

			}

			p.addScaledVector( dir, len / n );
			pts.push( p.clone() );

		}

		return pts;

	};

	const make = ( parent, O, d, len, r0, level, pr, pT, at = 0 ) => {

		const L = P.lv[ level ];
		const pts = stem( O, d, len, L, pT );
		const cum = arcCum( pts );
		const taper = L.taper ?? 0.85, tipR = L.tipR ?? r0 * 0.15, flare = L.flare || 0;
		// branch collar: the wood swells where a limb leaves its parent
		const cB = parent ? Math.max( 1, Math.min( pr * 0.92, r0 * 1.8 ) / r0 ) : 1, cL = 0.45 * pr + 1.3 * r0;
		const rads = pts.map( ( _, i ) => {

			const s = cum[ i ] * len;
			let rr = Math.max( tipR, r0 * ( 1 - taper * cum[ i ] ) ) * ( 1 + flare * Math.exp( - s / Math.max( r0 * 3, 1e-3 ) ) );
			if ( parent ) rr *= 1 + ( cB - 1 ) * Math.exp( - s / cL );
			return rr;

		} );
		const b = { parent, f: at, level, pts, rads, cum, len, r0, kids: [], dir: pts[ pts.length - 1 ].clone().sub( pts[ 0 ] ).normalize() };
		branches.push( b );
		if ( parent ) parent.kids.push( b );
		const C = P.lv[ level + 1 ];
		if ( ! C || level + 1 > ( P.maxLevel ?? 9 ) ) return b;

		const [ ra, rb ] = C.range || [ 0.2, 1 ];
		const cnt = Math.round( ( C.count ? C.count( len, b, r ) : C.dens * len * ( rb - ra ) ) * range( r, 0.85, 1.15 ) );
		let phi = range( r, 0, 6.28 );
		for ( let j = 0; j < cnt; j ++ ) {

			const ff = Math.min( 0.995, ra + ( rb - ra ) * ( ( j + 0.5 + range( r, - 0.35, 0.35 ) ) / cnt ) );
			phi += ( C.rot ?? 2.4 ) + range( r, - 0.3, 0.3 );
			const q = branchAt( b, ff );
			const rad = perp( q.T ).applyAxisAngle( q.T, phi );
			const dn = C.down ? C.down[ 0 ] + range( r, - 1, 1 ) * C.down[ 1 ] : 0.8;
			const cd = q.T.clone().multiplyScalar( Math.cos( dn ) ).addScaledVector( rad, Math.sin( dn ) ).normalize();
			if ( C.up ) cd.lerp( _up, C.up ).normalize();
			let lc = len * ( C.len ? range( r, C.len[ 0 ], C.len[ 1 ] ) : 0.5 ) * ( C.shape ? C.shape( ff ) : 1 );
			if ( C.filter ) lc *= C.filter( cd, b, ff, r );
			if ( lc < ( C.minLen || 0.02 ) ) continue;
			const rc = Math.min( q.r * ( C.rMax ?? 0.8 ), Math.max( C.rMin || 0.0015, r0 * Math.pow( lc / len, C.rPow ?? 1.25 ) ) );
			make( b, q.p, cd, lc, rc, level + 1, q.r, q.T, ff );

		}

		return b;

	};

	for ( const tk of P.trunks ) make( null, tk.p, tk.d, tk.len, tk.r, tk.level || 0, 0, null );
	return branches;

}

// Merged geometry: bark tubes + alpha cards. Attributes:
//   position, uv, cnorm (surface / card normal), card = (kind, seed, ao, height frac)
//   kind < 0: wood; kind >= 0: atlas tile
export class Builder {

	constructor() {

		this.pos = []; this.uv = []; this.nrm = []; this.cardA = []; this.idx = [];

	}

	get vertexCount() {

		return this.pos.length / 3;

	}

	// tube along pts with radii; v runs along the length in metres, u around
	tube( pts, rads, sides, opt = {} ) {

		const base = this.vertexCount, n = pts.length;
		const H = opt.height || 1;
		let len = 0, prevN = null;
		const T = [];
		for ( let i = 0; i < n; i ++ ) T.push( pts[ Math.min( n - 1, i + 1 ) ].clone().sub( pts[ Math.max( 0, i - 1 ) ] ).normalize() );
		for ( let i = 0; i < n; i ++ ) {

			const t = T[ i ];
			if ( i > 0 ) len += pts[ i ].distanceTo( pts[ i - 1 ] );
			// parallel-transported frame (no twisting seams)
			let nx;
			if ( prevN ) {

				nx = prevN.clone().applyQuaternion( new THREE.Quaternion().setFromUnitVectors( T[ i - 1 ], t ) );
				nx.sub( t.clone().multiplyScalar( nx.dot( t ) ) ).normalize();

			} else nx = perp( t );
			prevN = nx;
			const bx = new THREE.Vector3().crossVectors( t, nx );
			// slope of the radius tilts the normal along the axis (tapering tube)
			const i0 = Math.max( 0, i - 1 ), i1 = Math.min( n - 1, i + 1 );
			const ds = pts[ i1 ].distanceTo( pts[ i0 ] );
			const sl = ds > 1e-6 ? Math.max( - 2, Math.min( 2, ( rads[ i1 ] - rads[ i0 ] ) / ds ) ) : 0;
			for ( let j = 0; j <= sides; j ++ ) {

				const a = j / sides * Math.PI * 2;
				const c = Math.cos( a ), s = Math.sin( a );
				const ox = nx.x * c + bx.x * s, oy = nx.y * c + bx.y * s, oz = nx.z * c + bx.z * s;
				let rr = rads[ i ] * ( opt.rFn ? opt.rFn( j / sides, len, i / ( n - 1 ) ) : 1 );
				let p = pts[ i ];
				// splintered break: the last ring tears into jagged spikes along the axis
				const endS = i === n - 1 ? opt.splinter : i === 0 ? opt.splinterStart : 0;
				if ( endS ) {

					const u = j % sides;
					const sp = Math.abs( Math.sin( u * 2.399 + ( opt.seed || 0 ) * 40 + i ) ) * Math.abs( Math.sin( u * 0.73 + 1.3 + i * 0.5 ) );
					p = p.clone().addScaledVector( t, ( i === 0 ? - 1 : 1 ) * rads[ i ] * endS * ( 0.2 + 2.6 * sp * sp ) );
					rr *= 0.35 + 0.65 * ( 1 - sp );

				}

				this.pos.push( p.x + ox * rr, p.y + oy * rr, p.z + oz * rr );
				const nn = new THREE.Vector3( ox - t.x * sl, oy - t.y * sl, oz - t.z * sl ).normalize();
				this.nrm.push( nn.x, nn.y, nn.z );
				this.uv.push( j / sides, len );
				this.cardA.push( opt.kind ?? - 1, opt.seed ?? 0, opt.ao ?? 1, Math.min( 1, Math.max( 0, p.y / H ) ) );

			}

		}

		for ( let i = 0; i + 1 < n; i ++ ) for ( let j = 0; j < sides; j ++ ) {

			const a = base + i * ( sides + 1 ) + j, b = a + 1, c = a + sides + 1, e = c + 1;
			this.idx.push( a, b, c, b, e, c );

		}

		// the start of a fallen log closes too (recessed, splintered heartwood)
		if ( opt.splinterStart ) {

			const c0 = pts[ 0 ].clone().addScaledVector( T[ 0 ], - rads[ 0 ] * 0.15 );
			const ci = this.vertexCount;
			this.pos.push( c0.x, c0.y, c0.z );
			this.nrm.push( - T[ 0 ].x, - T[ 0 ].y, - T[ 0 ].z );
			this.uv.push( 0.5, 0 );
			this.cardA.push( opt.kind ?? - 1, opt.seed ?? 0, 0.25, Math.min( 1, Math.max( 0, c0.y / H ) ) );
			for ( let j = 0; j < sides; j ++ ) this.idx.push( base + j + 1, base + j, ci );

		}

		// blunt end: the broken tip closes with a small cone
		if ( opt.cap ) {

			// splintered ends: a recessed, darker heartwood centre; otherwise a rounded tip
			const tip = pts[ n - 1 ].clone().addScaledVector( T[ n - 1 ], rads[ n - 1 ] * ( opt.splinter ? 0.15 : 0.8 ) );
			const ti = this.vertexCount;
			this.pos.push( tip.x, tip.y, tip.z );
			this.nrm.push( T[ n - 1 ].x, T[ n - 1 ].y, T[ n - 1 ].z );
			this.uv.push( 0.5, len + rads[ n - 1 ] );
			this.cardA.push( opt.kind ?? - 1, opt.seed ?? 0, opt.splinter ? 0.25 : ( opt.ao ?? 1 ), Math.min( 1, tip.y / H ) );
			const last = base + ( n - 1 ) * ( sides + 1 );
			for ( let j = 0; j < sides; j ++ ) this.idx.push( last + j, last + j + 1, ti );

		}

	}

	// an alpha card whose bottom-centre sits at `o`, extending along `d` (length s), width w, facing n
	card( o, d, n, s, w, kind, seed, ao, hFrac ) {

		const ax = new THREE.Vector3().crossVectors( n, d ).normalize();
		const nn = new THREE.Vector3().crossVectors( d, ax ).normalize();
		const base = this.vertexCount;
		const corners = [ [ - 0.5, 0 ], [ 0.5, 0 ], [ 0.5, 1 ], [ - 0.5, 1 ] ];
		for ( const [ qx, qy ] of corners ) {

			this.pos.push( o.x + ax.x * qx * w + d.x * qy * s, o.y + ax.y * qx * w + d.y * qy * s, o.z + ax.z * qx * w + d.z * qy * s );
			this.uv.push( qx + 0.5, 1 - qy );
			this.nrm.push( nn.x, nn.y, nn.z );
			this.cardA.push( kind, seed, ao, hFrac );

		}

		this.idx.push( base, base + 1, base + 2, base, base + 2, base + 3 );

	}

	// a single leaf folded along its midrib (two halves lifted by `fold`), base at o, along d
	leaf( o, d, n, len, w, kind, seed, ao, hFrac, fold = 0.35 ) {

		const ax = new THREE.Vector3().crossVectors( n, d ).normalize();
		const nn = new THREE.Vector3().crossVectors( d, ax ).normalize();
		const base = this.vertexCount;
		const lift = nn.clone().multiplyScalar( w * 0.5 * fold );
		const tip = o.clone().addScaledVector( d, len ).addScaledVector( nn, - len * 0.12 ); // the tip droops a little
		const V = [
			[ o.clone().addScaledVector( ax, - w / 2 ).add( lift ), 0, 1 ], [ o, 0.5, 1 ], [ o.clone().addScaledVector( ax, w / 2 ).add( lift ), 1, 1 ],
			[ tip.clone().addScaledVector( ax, - w / 2 ).add( lift ), 0, 0 ], [ tip, 0.5, 0 ], [ tip.clone().addScaledVector( ax, w / 2 ).add( lift ), 1, 0 ],
		];
		for ( const [ p, u, v ] of V ) {

			this.pos.push( p.x, p.y, p.z ); this.uv.push( u, v ); this.nrm.push( nn.x, nn.y, nn.z );
			this.cardA.push( kind, seed, ao, hFrac );

		}

		this.idx.push( base, base + 1, base + 4, base, base + 4, base + 3, base + 1, base + 2, base + 5, base + 1, base + 5, base + 4 );

	}

	// a real leaf surface (after jose's leafGeometry): nu=2 columns across, nv rows
	// along; width follows an elliptic profile with a drip tip, the blade cups
	// (u^2) and arches back (v^2); uv maps the scanned leaf tile. 4*nv triangles.
	leafCurved( o, d, n, len, wid, kind, seed, ao, hFrac, nv = 4, cup = 0.3, arch = 0.22 ) {

		const ax = new THREE.Vector3().crossVectors( n, d ).normalize();
		const nn = new THREE.Vector3().crossVectors( d, ax ).normalize();
		const base = this.vertexCount;
		for ( let j = 0; j <= nv; j ++ ) {

			const v = j / nv;
			const wf = Math.pow( Math.sin( Math.PI * Math.min( 1, v * 0.96 + 0.04 ) ), 0.6 ) * ( 1 - 0.3 * v );
			for ( let i = 0; i <= 2; i ++ ) {

				const u = i - 1; // -1, 0, 1
				// geometry spans the tile's leaf (scanned outline fills ~42% of the tile width)
				const x = u * wid * 0.5 * Math.max( 0.35, wf );
				const z = cup * wid * u * u * 0.5 - arch * v * v * len;
				const p = o.clone().addScaledVector( d, v * len ).addScaledVector( ax, x ).addScaledVector( nn, z );
				this.pos.push( p.x, p.y, p.z );
				this.uv.push( 0.5 + u * 0.5 * Math.max( 0.35, wf ), 1 - v );
				const nl = nn.clone().addScaledVector( ax, - u * cup * 0.8 ).addScaledVector( d, arch * v * 1.2 ).normalize();
				this.nrm.push( nl.x, nl.y, nl.z );
				this.cardA.push( kind, seed, ao, hFrac );

			}

		}

		for ( let j = 0; j < nv; j ++ ) for ( let i = 0; i < 2; i ++ ) {

			const a = base + j * 3 + i, b = a + 1, c = a + 3, e = c + 1;
			this.idx.push( a, b, e, a, e, c );

		}

	}

	// Embothrium inflorescence: ~14 curved scarlet tubes radiating from a short
	// raceme, each flaring at the mouth (the four recurved lobes) with the style
	// sticking out. kind marks flower tissue; card.y carries the cluster seed (bloom).
	flowerCluster( c, up, r, scale, kind, seed, ao, hFrac, n = 14 ) {

		const side0 = new THREE.Vector3( 1, 0, 0 ).cross( up ).lengthSq() > 1e-3 ? new THREE.Vector3( 1, 0, 0 ).cross( up ).normalize() : new THREE.Vector3( 0, 0, 1 );
		for ( let k = 0; k < n; k ++ ) {

			const phi = k * 2.399 + r() * 0.4, tilt = 0.5 + r() * 0.9;
			const out = side0.clone().applyAxisAngle( up, phi );
			const dir = up.clone().multiplyScalar( Math.cos( tilt ) ).addScaledVector( out, Math.sin( tilt ) ).normalize();
			const p0 = c.clone().addScaledVector( up, ( r() - 0.3 ) * 0.03 * scale ).addScaledVector( out, 0.008 * scale );
			const L = ( 0.032 + r() * 0.014 ) * scale;
			const bend = out.clone().multiplyScalar( - 0.35 ).add( up.clone().multiplyScalar( 0.2 ) );
			const pts = [], rads = [];
			for ( let i = 0; i <= 4; i ++ ) {

				const f = i / 4;
				pts.push( p0.clone().addScaledVector( dir, f * L ).addScaledVector( bend, f * f * L * 0.6 ) );
				rads.push( ( 0.0024 + f * 0.0012 + ( i === 4 ? 0.0028 : 0 ) ) * scale );

			}

			this.tube( pts, rads, 4, { kind, seed, ao, height: 1 } );
			// the style, protruding past the lobes
			const tip = pts[ 4 ], td = tip.clone().sub( pts[ 3 ] ).normalize();
			this.tube( [ tip, tip.clone().addScaledVector( td, 0.016 * scale ) ], [ 0.0006 * scale, 0.0005 * scale ], 3, { kind: kind + 1, seed, ao, height: 1 } );

		}

	}

	geometry( instanced = true ) {

		const g = instanced ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.pos, 3 ) );
		g.setAttribute( 'uv', new THREE.Float32BufferAttribute( this.uv, 2 ) );
		g.setAttribute( 'cnorm', new THREE.Float32BufferAttribute( this.nrm, 3 ) );
		g.setAttribute( 'card', new THREE.Float32BufferAttribute( this.cardA, 4 ) );
		g.setIndex( this.idx );
		return g;

	}

}

// resample a polyline to m points (keeps the shape, fewer rings for lower LODs)
export function decimate( pts, rads, m ) {

	const n = pts.length;
	if ( n <= m ) return [ pts, rads ];
	const P = [], R = [];
	for ( let i = 0; i < m; i ++ ) {

		const f = i / ( m - 1 ) * ( n - 1 ), k = Math.min( n - 2, Math.floor( f ) ), t = f - k;
		P.push( pts[ k ].clone().lerp( pts[ k + 1 ], t ) );
		R.push( rads[ k ] + ( rads[ k + 1 ] - rads[ k ] ) * t );

	}

	return [ P, R ];

}

// break a grown plant like a dead, storm-battered tree: limbs snap off at a random
// fraction (their own children past the break are lost); returns the survivors
export function breakLimbs( branches, r, odds = [ 0, 0.55, 0.75, 0.9 ], keep = [ 0.35, 0.9 ] ) {

	const dead = new Set();
	for ( const b of branches ) {

		if ( b.parent && ( dead.has( b.parent ) || ( b.parent.cut !== undefined && b.f > b.parent.cut ) ) ) {

			dead.add( b ); continue;

		}

		if ( r() < ( odds[ Math.min( b.level, odds.length - 1 ) ] || 0 ) ) {

			const cut = keep[ 0 ] + ( keep[ 1 ] - keep[ 0 ] ) * r();
			const n = Math.max( 2, Math.round( cut * ( b.pts.length - 1 ) ) + 1 );
			b.cut = b.cum[ n - 1 ];
			b.pts = b.pts.slice( 0, n ); b.rads = b.rads.slice( 0, n ); b.cum = b.cum.slice( 0, n );
			b.broken = true;

		}

	}

	return branches.filter( ( b ) => ! dead.has( b ) );

}
