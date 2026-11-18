// Rock occupancy: a coarse map of where boulders stand, so grass, the far grass
// carpet and the scrub never grow up through a stone. Filled by the rock scatter
// (rocks.js) and sampled by the grass mask (terrain.js). No imports from the rest
// of the biome, so it can sit under both without an import cycle.

import * as THREE from 'three/webgpu';
import { Fn, texture, float, vec2, smoothstep } from 'three/tsl';

export const RM_N = 2048, RM_EXT = 1100; // texels, half extent (m) -> ~1.07 m / texel
const data = new Uint8Array( RM_N * RM_N );
export const rockMaskTex = new THREE.DataTexture( data, RM_N, RM_N, THREE.RedFormat, THREE.UnsignedByteType );
rockMaskTex.magFilter = rockMaskTex.minFilter = THREE.LinearFilter;
rockMaskTex.wrapS = rockMaskTex.wrapT = THREE.ClampToEdgeWrapping;
rockMaskTex.needsUpdate = true;

// stamp one boulder footprint (centre x,z, radius in m) as a soft disc
export function stampRock( x, z, rad ) {

	const k = RM_N / ( 2 * RM_EXT ), cx = ( x + RM_EXT ) * k - 0.5, cz = ( z + RM_EXT ) * k - 0.5, rr = rad * k + 1.0;
	for ( let j = Math.max( 0, Math.floor( cz - rr ) ); j <= Math.min( RM_N - 1, Math.ceil( cz + rr ) ); j ++ ) {

		for ( let i = Math.max( 0, Math.floor( cx - rr ) ); i <= Math.min( RM_N - 1, Math.ceil( cx + rr ) ); i ++ ) {

			const d = Math.hypot( i - cx, j - cz );
			const v = Math.max( 0, Math.min( 1, ( rr - d ) / 1.0 ) ) * 255;
			const o = j * RM_N + i;
			if ( v > data[ o ] ) data[ o ] = v;

		}

	}

}

export function rockMaskDone() {

	rockMaskTex.needsUpdate = true;

}

// JS lookup (CPU scatter of scrub and shrubs): 1 = rock
export function rockAtJS( x, z ) {

	const k = RM_N / ( 2 * RM_EXT );
	const i = Math.round( ( x + RM_EXT ) * k - 0.5 ), j = Math.round( ( z + RM_EXT ) * k - 0.5 );
	if ( i < 0 || j < 0 || i >= RM_N || j >= RM_N ) return 0;
	return data[ j * RM_N + i ] / 255;

}

// grass multiplier: 0 inside a boulder's footprint
export const rockFree = Fn( ( [ xz ] ) => {

	const uvp = xz.div( 2 * RM_EXT ).add( 0.5 );
	return float( 1.0 ).sub( smoothstep( 0.3, 0.75, texture( rockMaskTex, vec2( uvp.x, uvp.y ) ).level( 0 ).r ) );

} );
