// Plains-only systems, created after the shared ones (see biomes/plains/index.js).

import { buildBackdrop } from './backdrop.js';
import { buildWater } from './water.js';
import { Shrubs } from './shrubs.js';
import { DeadTrees } from './deadtrees.js';
import { buildSummitClouds } from './summitclouds.js';
import { Carpet } from './carpet.js';
import { Rocks } from './rocks.js';
import { Scrub } from './scrub.js';
import { VEG_RASTER } from './vox/mode.js';
import { loadJose } from './vox/jose.js';
import { Flora } from './vox/flora.js';
import { cloudFieldJS, cloudShadowCompute, csCenter, CS_N, CS_EXT } from './index.js';
import { U } from '../../tsl/uniforms.js';
import { polar, FORWARD_AZ } from './layout.js';

export async function createPlainsExtras( { scene } ) {

	const backdrop = buildBackdrop();
	const water = buildWater();
	scene.add( backdrop, water );

	// voxel mode: the jose flora replaces the original plants (bushes, ghost trees, scrub)
	const shrubs = VEG_RASTER ? null : await Shrubs.create();
	if ( shrubs ) scene.add( shrubs.group );
	const trees = VEG_RASTER ? null : new DeadTrees();
	if ( trees ) scene.add( trees.group );
	const caps = buildSummitClouds();
	scene.add( caps.mesh );
	caps.mesh.visible = false; // the volumetric layer replaces the billboard summit clouds
	const carpet = new Carpet();
	scene.add( carpet.mesh );
	const rocks = new Rocks();
	scene.add( rocks.group );
	const scrub = VEG_RASTER ? null : new Scrub( shrubs.atlas );
	if ( scrub ) scene.add( scrub.group );
	const flora = VEG_RASTER ? new Flora( await loadJose() ) : null;
	if ( flora ) scene.add( flora.group );
	// first impression (once the sky has set the sun): start the drifting clouds so that the sun breaks through
	// on the plain ahead while the surroundings stay dappled
	const placeClouds = () => {

		// sun on the trail just ahead, cloud shadows already drifting across the plain
		// beyond and around (dappled light from the first frame)
		const near = polar( FORWARD_AZ, 30 );
		const ring = [ polar( FORWARD_AZ, 220 ), polar( FORWARD_AZ + 50, 160 ), polar( FORWARD_AZ - 45, 180 ), polar( FORWARD_AZ, 450 ) ];
		const off = new U.cloudOffset.value.constructor();
		const cover = U.cloudCover.value;
		let best = - 1e9, bestK = 0;
		for ( let k = 0; k < 600; k ++ ) {

			off.copy( U.windDir.value ).multiplyScalar( k * 19 );
			const litNear = cloudFieldJS( near[ 0 ], near[ 1 ], 0, off ) - cover;
			const shaded = ring.filter( ( [ x, z ] ) => cloudFieldJS( x, z, 0, off ) < cover - 0.03 ).length;
			const score = Math.min( 0.15, litNear ) * 4 + ( shaded >= 1 && shaded <= 3 ? 1 : 0 ) + shaded * 0.1;
			if ( score > best ) {

				best = score; bestK = k;

			}

		}

		U.cloudOffset.value.copy( U.windDir.value ).multiplyScalar( bestK * 19 );

	};



	let first = true;
	const systems = [ shrubs, trees, caps, carpet, rocks, scrub, flora ].filter( Boolean );
	return {
		backdrop, water, shrubs, trees, caps, carpet, rocks, scrub, flora, systems, vox: flora && flora.raster,
		update( renderer, camera, dt ) {

			if ( first ) {

				first = false;
				placeClouds();

			}

			const sd = U.trueSunDir.value, sy = Math.max( sd.y, 0.3 );
			U.shadowShift.value.set( sd.x / sy, sd.z / sy );
			// cloud shadow map around the camera (snapped to whole texels: no swimming)
			const texel = CS_EXT * 2 / CS_N;
			csCenter.value.set( Math.round( camera.position.x / texel ) * texel, Math.round( camera.position.z / texel ) * texel );
			renderer.compute( cloudShadowCompute );
			for ( const s of systems ) s.update( renderer, camera, dt );

		},
	};

}
