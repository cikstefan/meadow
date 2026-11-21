// Ground debris from scanned models (Fab / Quixel Megascans, Fab Standard License): dead
// stumps and fallen wood lying among the scrub, most of all on the burnt ghost-tree hills.
// The models live in src/assets/plains/fab as .glb.wasm (the preview host serves no .glb;
// kept out of the public repository); without
// them this does nothing.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { rng } from './grow.js';
import { biomeJS } from './biomes.js';
import { terrainHeightJS, trailDistJS, lakeDistJS } from './terrain.js';
import { rockAtJS } from './rockmask.js';

const FILES = import.meta.glob( '../../assets/plains/fab/*.glb.wasm', { eager: true, query: '?url', import: 'default' } );
const CELL = 12, R = 140, MAX = 600;
// chance of a piece per 12 m cell in each landscape
const DENSITY = { forest: 0.25, scrub: 0.1, ghost: 0.7, steppe: 0.04 };

export class Props {

	static async create() {

		const urls = Object.values( FILES );
		if ( ! urls.length ) return null;
		const loader = new GLTFLoader();
		const models = [];
		for ( const u of urls ) {

			const g = await loader.loadAsync( u );
			g.scene.traverse( ( o ) => { if ( o.isMesh ) models.push( o ); } );

		}
		return models.length ? new Props( models ) : null;

	}

	constructor( models ) {

		this.group = new THREE.Group();
		this.meshes = models.map( ( m ) => {

			const geo = m.geometry.clone();
			geo.applyMatrix4( m.matrixWorld );
			geo.scale( 0.01, 0.01, 0.01 ); // Megascans export in centimetres
			geo.computeBoundingBox();
			geo.translate( 0, - geo.boundingBox.min.y - 0.04, 0 ); // sits slightly into the ground
			geo.computeBoundingSphere();
			const mesh = new THREE.InstancedMesh( geo, m.material, MAX );
			mesh.count = 0; mesh.frustumCulled = false;
			this.group.add( mesh );
			return mesh;

		} );
		this.last = new THREE.Vector3( 1e9, 0, 0 );

	}

	update( renderer, camera ) {

		const p = camera.position;
		if ( Math.hypot( p.x - this.last.x, p.z - this.last.z ) < 10 ) return;
		this.last.copy( p );
		const counts = this.meshes.map( () => 0 );
		const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler();
		const c0x = Math.floor( ( p.x - R ) / CELL ), c1x = Math.floor( ( p.x + R ) / CELL );
		const c0z = Math.floor( ( p.z - R ) / CELL ), c1z = Math.floor( ( p.z + R ) / CELL );
		for ( let cz = c0z; cz <= c1z; cz ++ ) for ( let cx = c0x; cx <= c1x; cx ++ ) {

			const r = rng( ( cx * 92837111 ) ^ ( cz * 689287499 ) ^ 0x51ed27 );
			const x = ( cx + r() ) * CELL, z = ( cz + r() ) * CELL;
			if ( ( x - p.x ) ** 2 + ( z - p.z ) ** 2 > R * R ) continue;
			const b = biomeJS( x, z );
			const d = b.forest * DENSITY.forest + b.scrub * DENSITY.scrub + b.ghost * DENSITY.ghost + b.steppe * DENSITY.steppe;
			const roll = r(), k = Math.floor( r() * this.meshes.length ), yaw = r() * 6.283, s = 0.7 + r() * 0.6, tilt = ( r() - 0.5 ) * 0.12;
			if ( roll > d ) continue;
			if ( trailDistJS( x, z ) < 2.5 || lakeDistJS( x, z ) < 4 || rockAtJS( x, z ) > 0.1 ) continue;
			if ( counts[ k ] >= MAX ) continue;
			E.set( tilt, yaw, tilt * 0.6 ); Q.setFromEuler( E );
			S.setScalar( s ); P.set( x, terrainHeightJS( x, z ), z );
			M.compose( P, Q, S );
			this.meshes[ k ].setMatrixAt( counts[ k ] ++, M );

		}
		this.meshes.forEach( ( m, i ) => { m.count = counts[ i ]; m.instanceMatrix.needsUpdate = true; } );

	}

}
