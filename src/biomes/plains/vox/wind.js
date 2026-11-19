// Wind for the jose flora, shared by the near meshes and the far voxels (so the two match
// where they cross-fade). Three layers, like a real plant:
//   trunk  - rooted: nothing moves at the base; the whole crown leans downwind on the
//            travelling gust field, slowly, growing with height squared
//   limbs  - each region of the crown (smooth noise of position: neighbouring leaves share
//            it, so nothing tears) sways on its own phase and a slightly different rate,
//            more the further it is from the trunk axis and the higher it is
//   twigs  - outermost foliage flutters fast and small
// Grasses (short plants) bend much more for their size than trees.

import { float, vec2, vec3, sin, cos, dot, clamp, smoothstep, mix, length, max } from 'three/tsl';
import { vnoise } from '../../../tsl/noise.js';
import { U, windField } from '../../../tsl/world.js';

/**
 * @param lp local position (m, already turned by the plant's yaw; y up from the ground)
 * @param H plant height (m)
 * @param xz plant position
 * @param seed 0..1
 */
export function plantWind( lp, H, xz, seed ) {

	const W = vec3( U.windDir.x, 0, U.windDir.y ), Wp = vec3( U.windDir.y.negate(), 0, U.windDir.x );
	const h = max( lp.y, 0.0 ).toVar(), hn = clamp( h.div( H ), 0.0, 1.0 ).toVar();
	const r = length( lp.xz ).toVar();
	const wind = windField( xz ).toVar();
	const t = U.time;
	const grass = smoothstep( 1.2, 0.4, H ).toVar(); // 1 for grasses
	// trunk / whole crown: slow lean on the travelling gusts
	const gust = dot( xz, U.windDir ).mul( 0.42 ).sub( U.windPhase.mul( 0.42 ) ).add( seed.mul( 6.0 ) );
	const lean = sin( gust ).mul( 0.35 ).add( sin( gust.mul( 0.37 ).add( 1.3 ) ).mul( 0.2 ) ).add( 0.55 );
	const prim = wind.mul( lean ).mul( H ).mul( mix( 0.03, 0.16, grass ) ).mul( hn.mul( hn ) ).toVar();
	// limbs: regional phase, stiffer near the trunk axis and low down
	const reg = vnoise( lp.xz.mul( 1.4 ).add( vec2( lp.y.mul( 0.9 ), seed.mul( 17.0 ) ) ) ).toVar();
	const stiff = mix( smoothstep( 0.04, 0.55, r.div( H.mul( 0.45 ).add( 0.15 ) ) ).mul( smoothstep( 0.12, 0.55, hn ) ), hn, grass ).toVar();
	const rate = mix( 1.4, 2.4, reg ).mul( mix( 0.85, 1.15, seed ) );
	const ph = reg.mul( 12.6 ).add( seed.mul( 31.0 ) );
	const a2 = wind.mul( 0.4 ).add( 0.06 ).mul( stiff ).mul( mix( 0.05, 0.03, grass ) ).mul( h.mul( 0.25 ).add( r.mul( 0.35 ) ).add( 0.15 ) );
	const sec = W.mul( sin( t.mul( rate ).add( ph ) ) ).add( Wp.mul( cos( t.mul( rate.mul( 0.83 ) ).add( ph.mul( 1.7 ) ) ).mul( 0.6 ) ) ).mul( a2 ).toVar();
	// twigs and leaves at the outside: quick flutter
	const tw = vnoise( lp.xz.mul( 6.0 ).add( vec2( lp.y.mul( 4.0 ), seed.mul( 9.0 ) ) ) ).toVar();
	const flut = vec3( sin( t.mul( 6.3 ).add( tw.mul( 25.0 ) ) ), sin( t.mul( 7.9 ).add( tw.mul( 31.0 ) ) ).mul( 0.6 ), cos( t.mul( 5.7 ).add( tw.mul( 19.0 ) ) ) )
		.mul( wind.mul( 0.7 ).add( 0.15 ).mul( stiff.mul( stiff ) ).mul( 0.012 ) );
	return W.mul( prim ).add( sec ).add( flut );

}
