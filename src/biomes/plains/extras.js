// Plains-only systems, created after the shared ones (see biomes/plains/index.js).

import { buildBackdrop } from './backdrop.js';
import { buildWater } from './water.js';
import { Shrubs } from './shrubs.js';
import { DeadTrees } from './deadtrees.js';
import { buildSummitClouds } from './summitclouds.js';
import { Carpet } from './carpet.js';
import { Rocks } from './rocks.js';
import { cloudFieldJS } from './index.js';
import { U } from '../../tsl/uniforms.js';
import { polar, FORWARD_AZ } from './layout.js';

export async function createPlainsExtras( { scene } ) {

	const backdrop = buildBackdrop();
	const water = buildWater();
	scene.add( backdrop, water );

	const shrubs = await Shrubs.create();
	scene.add( shrubs.group );
	const trees = new DeadTrees();
	scene.add( trees.group );
	const caps = buildSummitClouds();
	scene.add( caps.mesh );
	caps.mesh.visible = false; // the volumetric layer replaces the billboard summit clouds
	const carpet = new Carpet();
	scene.add( carpet.mesh );
	const rocks = new Rocks();
	scene.add( rocks.group );
	// first impression (once the sky has set the sun): start the drifting clouds so that the sun breaks through
	// on the plain ahead while the surroundings stay dappled
	const placeClouds = () => {

		const ahead = [ polar( FORWARD_AZ, 0 ), polar( FORWARD_AZ, 40 ), polar( FORWARD_AZ, 120 ) ];
		const off = new U.cloudOffset.value.constructor();
		let best = - 1, bestK = 0;
		for ( let k = 0; k < 400; k ++ ) {

			off.copy( U.windDir.value ).multiplyScalar( k * 23 );
			const lit = Math.min( ...ahead.map( ( [ x, z ] ) => cloudFieldJS( x, z, 0, off ) ) );
			if ( lit > best ) {

				best = lit; bestK = k;

			}

		}

		U.cloudOffset.value.copy( U.windDir.value ).multiplyScalar( bestK * 23 );

	};


	let first = true;
	const systems = [ shrubs, trees, caps, carpet, rocks ];
	return {
		backdrop, water, shrubs, trees, caps, carpet, systems,
		update( renderer, camera, dt ) {

			if ( first ) {

				first = false;
				placeClouds();

			}

			for ( const s of systems ) s.update( renderer, camera, dt );

		},
	};

}
