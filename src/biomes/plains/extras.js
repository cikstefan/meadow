// Plains-only systems, created after the shared ones (see biomes/plains/index.js).

import { buildBackdrop } from './backdrop.js';
import { buildWater } from './water.js';

export async function createPlainsExtras( { scene } ) {

	const backdrop = buildBackdrop();
	const water = buildWater();
	scene.add( backdrop, water );

	const systems = [];
	return {
		backdrop, water, systems,
		update( renderer, camera, dt ) {

			for ( const s of systems ) s.update( renderer, camera, dt );

		},
	};

}
