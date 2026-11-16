// Plains-only systems, created after the shared ones (see biomes/plains/index.js).

import { buildBackdrop } from './backdrop.js';
import { buildWater } from './water.js';
import { Shrubs } from './shrubs.js';
import { DeadTrees } from './deadtrees.js';

export async function createPlainsExtras( { scene } ) {

	const backdrop = buildBackdrop();
	const water = buildWater();
	scene.add( backdrop, water );

	const shrubs = new Shrubs();
	scene.add( shrubs.group );
	const trees = new DeadTrees();
	scene.add( trees.group );
	const systems = [ shrubs, trees ];
	return {
		backdrop, water, shrubs, trees, systems,
		update( renderer, camera, dt ) {

			for ( const s of systems ) s.update( renderer, camera, dt );

		},
	};

}
