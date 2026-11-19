// Plants from the jose specimen generator, voxelized offline (tools/jose-bake):
// each species at three growth stages and two seeds. Drawn only by the voxel
// rasterizer (no meshes), scattered over the plains in drifts.

import { vnoiseJS } from '../../../tsl/noise.js';

// placement: share of the jose layer, drift scale (m), size jitter, permanent wind lean
export const JOSE_SPECIES = {
	oleander: { w: 0, lean: 0.22 }, // replaces the firebush (notro) of the scrub
	gypso: { w: 0.9, drift: 30, lean: 0.05 },
	clero: { w: 0.6, drift: 40, lean: 0.12 },
	stipa: { w: 2.2, drift: 55, lean: 0.1, grass: true },
	hakone: { w: 1.2, drift: 45, lean: 0.08, grass: true },
	festuca: { w: 1.8, drift: 50, lean: 0.06, grass: true },
	benjamina: { w: 0.18, drift: 120, lean: 0.3 },
	plumeria: { w: 0.15, drift: 140, lean: 0.25 },
	cotinus: { w: 0.14, drift: 90, lean: 0.25 },
	olive: { w: 0.22, drift: 160, lean: 0.35 },
	echium: { w: 0.5, drift: 60, lean: 0.15 },
	mugo: { w: 0.35, drift: 100, lean: 0.4 },
};

export async function loadJose() {

	const [ meta, bin ] = await Promise.all( [
		fetch( new URL( '../../../assets/plains/vox/jose.json', import.meta.url ).href ).then( ( r ) => r.json() ),
		// (raw u32 voxel words; the .wasm name only makes static hosts serve the bytes untouched)
		fetch( new URL( '../../../assets/plains/vox/jose.voxels.wasm', import.meta.url ).href ).then( ( r ) => r.arrayBuffer() ),
	] );
	const words = new Uint32Array( bin );
	let o = 0;
	const protos = meta.map( ( m ) => {

		const levels = m.counts.map( ( c ) => {

			const L = words.subarray( o, o + c * 3 );
			o += c * 3;
			return L;

		} );
		return { levels, info: { min: m.min, vsz: m.vsz, res: m.res }, near: 0, sp: m.sp, t: m.t, seed: m.seed, height: m.height };

	} );
	// prototype lists per species (index within this list)
	const bySp = {};
	protos.forEach( ( p, i ) => ( bySp[ p.sp ] = bySp[ p.sp ] || [] ).push( i ) );
	return { protos, bySp };

}

// species picked by smooth drift fields (each species owns patches of the plain)
export function pickJose( x, z, r, bySp ) {

	let best = null, bw = 0;
	let k = 0;
	for ( const [ sp, S ] of Object.entries( JOSE_SPECIES ) ) {

		k ++;
		if ( ! S.w || ! bySp[ sp ] ) continue;
		const f = vnoiseJS( x / S.drift + k * 13.1, z / S.drift + k * 7.7 );
		const w = S.w * Math.pow( Math.max( 0, f - 0.35 ) / 0.65, 2 ) * ( 0.6 + 0.8 * r() );
		if ( w > bw ) {

			bw = w; best = sp;

		}

	}

	return bw > 0.08 ? best : null;

}
