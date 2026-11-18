// Ground cover: the dense, low mat of short grass, cushion plants and herbs
// that fills every gap between the tussocks on the plains (no bare soil).
//
// Pre-made clumps (drawn once into a small atlas: fine grass tufts, a green
// cushion seen from above, a low herb rosette with tiny violet flowers) are
// instanced on a camera-centred grid entirely on the GPU: each instance hashes
// its global cell into a position, takes its height from the terrain function
// and draws three cards — two crossed, leaning outward, and one lying almost
// flat, so the cover reads as a volume from eye level AND from above. Clumps
// shrink away past the carpet radius, where the ground's canopy shading takes
// over.

import * as THREE from 'three/webgpu';
import {
	Fn, float, int, vec2, vec3, vec4, mix, smoothstep, clamp, sin, cos, dot, normalize, length, floor, attribute,
	varying, instanceIndex, cameraPosition, texture, uv, select, uniform, faceDirection, step
} from 'three/tsl';
import { hash2i, hash2i2, vnoise } from '../../tsl/noise.js';
import { U, shadeFoliage, windField, cloudShadow } from '../../tsl/world.js';
import { terrainHeight, grassMask, fieldDry } from './terrain.js';
import { rng } from './grow.js';
import { bleed } from './atlas.js';

const T = 256, COLS = 4;
const hsl = ( h, s, l, a = 1 ) => `hsla(${ h },${ s }%,${ l }%,${ a })`;

function drawTile( g, i ) {

	const r = rng( 3301 * ( i + 1 ) );
	g.clearRect( 0, 0, T, T );
	g.lineCap = 'round';
	if ( i === 0 || i === 1 ) {

		// a dense tuft of fine blades: darker and greener at the base, straw tips
		const n = i === 0 ? 150 : 120;
		for ( let k = 0; k < n; k ++ ) {

			const x0 = T * ( 0.5 + ( r() - 0.5 ) * 0.7 ), y0 = T;
			const h = T * ( 0.35 + r() * 0.6 ), lean = ( r() - 0.5 ) * T * 0.5;
			const dryK = i === 1 ? 0.4 + r() * 0.6 : r() * r() * 0.6;
			const hue = 78 - dryK * 30, sat = 45 - dryK * 15, lit = 22 + r() * 12 + dryK * 22;
			const grd = g.createLinearGradient( x0, y0, x0 + lean, y0 - h );
			grd.addColorStop( 0, hsl( hue + 8, sat, lit * 0.45 ) );
			grd.addColorStop( 0.6, hsl( hue, sat, lit ) );
			grd.addColorStop( 1, hsl( hue - 10, sat - 8, lit * 1.25 ) );
			g.strokeStyle = grd;
			g.lineWidth = 1.2 + r() * 1.6;
			g.beginPath();
			g.moveTo( x0, y0 );
			g.quadraticCurveTo( x0 + lean * 0.2, y0 - h * 0.6, x0 + lean, y0 - h );
			g.stroke();

		}

	} else if ( i === 2 ) {

		// cushion / moss mat seen from above: a disc packed with tiny leaves
		for ( let k = 0; k < 900; k ++ ) {

			const a = r() * Math.PI * 2, rr = Math.sqrt( r() ) * T * 0.46 * ( 0.85 + 0.15 * Math.sin( a * 5 ) );
			const x = T / 2 + Math.cos( a ) * rr, y = T / 2 + Math.sin( a ) * rr;
			const edge = rr / ( T * 0.46 );
			g.fillStyle = hsl( 82 + r() * 18, 35 + r() * 15, 14 + r() * 16 + ( 1 - edge ) * 8 );
			g.beginPath();
			g.ellipse( x, y, 2 + r() * 3, 1.2 + r() * 1.5, r() * 3, 0, Math.PI * 2 );
			g.fill();

		}

	} else {

		// low herb rosettes with a few tiny violet / white flowers (seen from above)
		for ( let c = 0; c < 5; c ++ ) {

			const cx = T * ( 0.2 + r() * 0.6 ), cy = T * ( 0.2 + r() * 0.6 );
			for ( let k = 0; k < 14; k ++ ) {

				const a = k / 14 * Math.PI * 2 + r() * 0.3, L = 18 + r() * 22;
				g.fillStyle = hsl( 90 + r() * 15, 30 + r() * 15, 18 + r() * 12 );
				g.save(); g.translate( cx, cy ); g.rotate( a );
				g.beginPath(); g.ellipse( L * 0.5, 0, L * 0.5, 4 + r() * 3, 0, 0, Math.PI * 2 ); g.fill();
				g.restore();

			}

			if ( r() < 0.7 ) for ( let f = 0; f < 4; f ++ ) {

				g.fillStyle = r() < 0.6 ? hsl( 275, 45, 62 ) : hsl( 50, 30, 88 );
				g.beginPath(); g.arc( cx + ( r() - 0.5 ) * 30, cy + ( r() - 0.5 ) * 30, 3 + r() * 2, 0, Math.PI * 2 ); g.fill();

			}

		}

	}

}

function buildAtlas() {

	const c = document.createElement( 'canvas' );
	c.width = COLS * T; c.height = T;
	const g = c.getContext( '2d', { willReadFrequently: true } );
	const t = document.createElement( 'canvas' );
	t.width = t.height = T;
	const tg = t.getContext( '2d' );
	for ( let i = 0; i < COLS; i ++ ) {

		drawTile( tg, i );
		g.drawImage( t, i * T, 0 );

	}

	const img = g.getImageData( 0, 0, c.width, c.height );
	bleed( img.data, c.width, c.height );
	const tex = new THREE.DataTexture( new Uint8Array( img.data.buffer ), c.width, c.height, THREE.RGBAFormat );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.anisotropy = 4;
	tex.needsUpdate = true;
	return tex;

}

// one clump: two crossed upright cards (leaning out) + one flat card on top
function clumpGeometry() {

	const pos = [], uvs = [], kind = [], idx = [];
	const quad = ( corners, k ) => {

		const b = pos.length / 3;
		for ( const [ x, y, z, u, v ] of corners ) {

			pos.push( x, y, z ); uvs.push( u, v ); kind.push( k );

		}

		idx.push( b, b + 1, b + 2, b, b + 2, b + 3 );

	};

	for ( const a of [ 0, Math.PI / 2 ] ) {

		const c = Math.cos( a ) * 0.5, s = Math.sin( a ) * 0.5, lx = - Math.sin( a ) * 0.12, lz = Math.cos( a ) * 0.12;
		quad( [ [ - c, 0, - s, 0, 1 ], [ c, 0, s, 1, 1 ], [ c + lx, 1, s + lz, 1, 0 ], [ - c + lx, 1, - s + lz, 0, 0 ] ], 0 );

	}

	quad( [ [ - 0.55, 0.12, - 0.55, 0, 1 ], [ 0.55, 0.12, - 0.55, 1, 1 ], [ 0.55, 0.12, 0.55, 1, 0 ], [ - 0.55, 0.12, 0.55, 0, 0 ] ], 1 );

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	g.setAttribute( 'kind', new THREE.Float32BufferAttribute( kind, 1 ) );
	g.setIndex( idx );
	return g;

}

export class Carpet {

	constructor( { spacing = 0.32, radius = 30 } = {} ) {

		const N = Math.ceil( radius * 2 / spacing );
		this.N = N;
		this.u = { base: uniform( new THREE.Vector2() ), spacing: uniform( spacing ), radius: uniform( radius ), height: uniform( 1 ) };
		const tex = buildAtlas();
		const vW = varying( vec3( 0 ), 'vCpW' );
		const vD = varying( vec4( 0 ), 'vCpD' ); // tile, dry, ao(height frac), cloud
		const vTint = varying( float( 1 ), 'vCpT' );

		const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
		mat.fog = false;
		mat.alphaToCoverage = true;
		mat.alphaTest = 0.4;
		const u = this.u;

		mat.positionNode = Fn( () => {

			const i = int( instanceIndex );
			const ix = i.mod( N ), iz = i.div( N );
			const gx = int( u.base.x ).add( ix ), gz = int( u.base.y ).add( iz );
			const j = hash2i2( gx.add( 71 ), gz.add( 13 ) );
			const h0 = hash2i( gx.add( 5 ), gz.add( 91 ) ), h1 = hash2i( gx.add( 33 ), gz.add( 7 ) );
			const xz = vec2( float( gx ).add( j.x ), float( gz ).add( j.y ) ).mul( u.spacing );
			const dist = length( xz.sub( cameraPosition.xz ) );
			const mask = grassMask( xz );
			// patchy: clumps thin out in drifts, never on the trail
			const keep = smoothstep( 0.25, 0.45, vnoise( xz.div( 3.3 ) ).mul( 0.6 ).add( h1.mul( 0.4 ) ) ).mul( mask );
			const size = mix( 0.22, 0.42, h0 ).mul( keep ).mul( smoothstep( u.radius, u.radius.mul( 0.7 ), dist ) ).mul( u.height.mul( 0.25 ).add( 0.75 ) );
			const yaw = h1.mul( 6.283 );
			const p = attribute( 'position', 'vec3' );
			const k = attribute( 'kind', 'float' );
			const cy = cos( yaw ), sy = sin( yaw );
			const lp = vec3( p.x.mul( cy ).sub( p.z.mul( sy ) ), p.y.mul( mix( 0.6, 1.1, h0 ) ), p.x.mul( sy ).add( p.z.mul( cy ) ) ).mul( size );
			// wind bends the tops of the upright cards
			const W = vec3( U.windDir.x, 0, U.windDir.y );
			const wind = windField( xz );
			const sway = sin( U.time.mul( 3.0 ).add( h0.mul( 30.0 ) ).add( dot( xz, U.windDir ).mul( 0.5 ) ) ).mul( 0.3 ).add( 0.7 );
			const bendK = p.y.mul( select( k.lessThan( 0.5 ), float( 1.0 ), float( 0.2 ) ) );
			const y = terrainHeight( xz );
			const world = vec3( xz.x, y.sub( 0.015 ), xz.y ).add( lp ).add( W.mul( wind.mul( sway ).mul( bendK ).mul( size ).mul( 0.35 ) ) );
			vW.assign( world );
			const tile = select( k.lessThan( 0.5 ), select( h1.lessThan( 0.55 ), float( 0 ), float( 1 ) ), select( h0.lessThan( 0.6 ), float( 2 ), float( 3 ) ) );
			vD.assign( vec4( tile, fieldDry( xz ), select( k.lessThan( 0.5 ), p.y, float( 0.8 ) ), cloudShadow( xz ) ) );
			vTint.assign( mix( 0.8, 1.15, h0 ) );
			return world;

		} )();

		const tuv = vec2( vD.x.add( uv().x.clamp( 0.004, 0.996 ) ).div( COLS ), uv().y );
		const s = texture( tex, tuv );
		const dist = length( vW.sub( cameraPosition ) );
		mat.opacityNode = s.a.mul( float( 1.0 ).add( smoothstep( 4.0, 25.0, dist ) ) );
		mat.colorNode = Fn( () => {

			// cured straw where the plains are dry, greener in the hollows
			const lum = dot( s.rgb, vec3( 0.3, 0.55, 0.15 ) );
			const straw = vec3( lum ).mul( vec3( 1.5, 1.25, 0.75 ) );
			const albedo = mix( s.rgb, straw, vD.y.mul( 0.55 ) ).mul( vTint ).mul( 0.85 );
			const N = normalize( mix( vec3( 0, 1, 0 ), vec3( 0, 1, 0 ).mul( faceDirection ), 0.0 ) );
			const ao = mix( 0.45, 1.0, vD.z );
			// night: the rosettes' tiny violet / cream flowers glow (violet and spirit-cyan
			// lights scattered across the far plain, like the meadow's glowing flowers)
			const fl = step( 2.5, vD.x ).mul( smoothstep( 0.28, 0.42, lum ) );
			const isViolet = step( s.b, s.r.add( 0.02 ) ).oneMinus().mul( step( s.g, s.b ) );
			const gc = mix( U.glowColor.mul( 1.4 ), vec3( 0.8, 0.25, 1.0 ), isViolet );
			const emit = gc.mul( fl ).mul( U.night ).mul( U.glow ).mul( 1.6 ).mul( vTint );
			return shadeFoliage( albedo, N, vW, ao, vD.w, float( 0.5 ), float( 0.04 ), float( 0.4 ), emit );

		} )();

		this.mesh = new THREE.Mesh( clumpGeometry(), mat );
		this.mesh.count = N * N;
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 4;

	}

	update( renderer, camera ) {

		const sp = this.u.spacing.value;
		this.u.base.value.set( Math.floor( camera.position.x / sp ) - this.N / 2, Math.floor( camera.position.z / sp ) - this.N / 2 );

	}

}
