// Black jaguar: a skinned, textured big-cat model driven by procedural
// quadruped locomotion and a calm idle behaviour.
//
// Model: "black panther" by kenchoo (Sketchfab), CC-BY-4.0
//   https://sketchfab.com/3d-models/black-panther-7fca11c89cca4362a525c891a8345112
//   optimised (WebP textures + meshopt), refined at load (subdivision with
//   blended skin weights, Taubin smoothing, welded smooth normals).
//
// Locomotion (the model has no walk/run clips) follows the structure of False
// Earth's character controller: speed -> 1D blend weights -> poses + footstep
// events, but the "clips" are procedural gaits on the real 47-bone rig:
//   walk   4-beat lateral sequence            LH  LF  RH  RF
//   trot   diagonal pairs                     LH+RF / RH+LF
//   canter 3-beat, diagonal pair together     RH, LH+RF, LF   (Shift)
//   gallop 4-beat rotary, footfalls spread    LH, RH, RF, LF  (Shift+Space)
// Stride amplitude is solved from speed and leg length (no foot sliding).
// At rest: slow look-around with long holds (critically damped springs, no
// clip loops -> no head snaps), breathing, ear flicks, tail; after 10 s it
// sits, after 20 s it lies down (sphinx), and stands up when asked to move.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
	vec2, vec3, vec4, output, positionWorld, positionGeometry, normalWorld, cameraPosition, normalize, dot, pow, clamp,
	float, max, mix, smoothstep, texture, uv, fwidth, length, materialColor
} from 'three/tsl';
import { U, applyFog, terrainHeightJS } from './tsl/world.js';
import { vnoise } from './tsl/noise.js';
import { subdivideSkinned, smoothNormals } from './meshsmooth.js';

const TAU = Math.PI * 2;
const lerp = THREE.MathUtils.lerp;
const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const smooth = ( a, b, x ) => {

	const t = clamp01( ( x - a ) / ( b - a ) );
	return t * t * ( 3 - 2 * t );

};

const angleDiff = ( a, b ) => Math.atan2( Math.sin( b - a ), Math.cos( b - a ) );

// critically damped spring toward a target (smooth, never overshoots/snaps)
class Spring {

	constructor( v = 0 ) {

		this.v = v; this.vel = 0;

	}

	step( target, dt, halfLife ) {

		const w = 1.386 / Math.max( halfLife, 1e-3 ); // ln(4)/halflife ~ critically damped
		const x = this.v - target;
		const e = Math.exp( - w * dt );
		const tmp = ( this.vel + w * x ) * dt;
		this.vel = ( this.vel - w * tmp ) * e;
		this.v = target + ( x + tmp ) * e;
		return this.v;

	}

}

const SIZE = 3.0; // model scale (~2.5x a real jaguar, as requested)
const CAD = 1 / Math.sqrt( SIZE / 1.2 ); // bigger animals step more slowly

// leg order: LH, RH, LF, RF
const GAITS = {
	// stride frequencies (Hz) for a ~2.5x-scale cat (Froude scaling: slower cadence, longer strides)
	walk: { beta: 0.64, freq: ( v ) => 0.55 + 0.17 * v, off: [ 0.0, 0.5, 0.25, 0.75 ], lift: 0.9, bob: 0.010, sway: 0.05, flex: 0.0 },
	trot: { beta: 0.46, freq: ( v ) => 1.0 + 0.08 * v, off: [ 0.0, 0.5, 0.5, 0.0 ], lift: 1.0, bob: 0.018, sway: 0.02, flex: 0.05 },
	canter: { beta: 0.42, freq: ( v ) => 1.25 + 0.03 * v, off: [ 0.33, 0.0, 0.66, 0.33 ], lift: 1.05, bob: 0.035, sway: 0.0, flex: 0.16 },
	gallop: { beta: 0.32, freq: ( v ) => 1.5 + 0.025 * v, off: [ 0.0, 0.18, 0.7, 0.52 ], lift: 1.15, bob: 0.05, sway: 0.0, flex: 0.3 },
};
const GAIT_NAMES = [ 'walk', 'trot', 'canter', 'gallop' ];

const SPEED = { walk: 2.8, canter: 9.0, gallop: 17 };

// rest poses (joint deltas in radians, drop as a fraction of model scale), solved so
// that paws, hocks and hips rest on the ground (see README: pose fitting)
export const POSE = {
	sit: { thigh: - 1.005, calf: 1.254, hock: - 0.976, foot: 2.196, ua: 0.273, fa: 0, hand: 0, pitch: 0.47, drop: 0.432 },
	lie: { thigh: - 1.071, calf: 1.352, hock: - 1.405, foot: 0.088, ua: 0.275, fa: - 1.659, hand: 0.274, pitch: 0.074, drop: 0.399 },
};

export class Jaguar {

	constructor() {

		this.group = new THREE.Group(); // world placement (yaw)
		this.body = new THREE.Group(); // slope pitch / roll / pose drop
		this.group.add( this.body );
		this.ready = false;

		this.pos = new THREE.Vector3();
		this.heading = 0; // 0 = facing -Z (camera yaw convention)
		this.speed = 0;
		this.targetSpeed = 0;
		this.turnRate = 0;
		this.phase = 0;
		this.steps = 0;
		this.weights = { idle: 1, walk: 0, trot: 0, canter: 0, gallop: 0 };
		this.lean = 0;
		this.pitch = 0;
		this._prevPhase = [ 0, 0, 0, 0 ];

		// rest behaviour
		this.restTime = 0;
		this.sitW = 0;
		this.lieW = 0;
		this.look = { yaw: new Spring(), pitch: new Spring(), tYaw: 0, tPitch: 0, timer: 2 };
		this.ear = { L: new Spring(), R: new Spring(), timer: 3 };
		this.tailFlick = { s: new Spring(), timer: 4 };
		this.time = 0;

		// autonomous wandering when not player-controlled
		this.wander = { target: new THREE.Vector3(), timer: 0, run: false, pause: 0 };

	}

	async load() {

		// The GLB ships as a lazily loaded JS chunk (base64) and is parsed in
		// memory: works on any static host, including ones that won't serve .glb.
		const { default: dataUrl } = await import( './assets/jaguar.glb?inline' );
		const bin = atob( dataUrl.slice( dataUrl.indexOf( ',' ) + 1 ) );
		const bytes = new Uint8Array( bin.length );
		for ( let i = 0; i < bin.length; i ++ ) bytes[ i ] = bin.charCodeAt( i );
		const loader = new GLTFLoader();
		loader.setMeshoptDecoder( MeshoptDecoder );
		const gltf = await loader.parseAsync( bytes.buffer, '' );
		const model = gltf.scene;

		model.scale.setScalar( SIZE );
		this.scale = SIZE;
		this.body.add( model );
		model.updateMatrixWorld( true );

		// --- geometry refinement: rounder silhouette + seam-free smooth shading
		const skinned = [];
		model.traverse( ( o ) => {

			if ( o.isSkinnedMesh ) skinned.push( o );

		} );
		const eyes = skinned.find( ( o ) => o.name === 'Object_7' );
		for ( const m of skinned ) {

			const tris = ( m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count ) / 3;
			if ( m === eyes || tris < 1000 ) continue;
			const g = subdivideSkinned( m.geometry, { iterations: 2 } );
			m.geometry.dispose();
			m.geometry = g;

		}

		smoothNormals( skinned.filter( ( m ) => m !== eyes ), model );

		// --- materials
		model.traverse( ( o ) => {

			if ( ! o.isMesh ) return;
			o.frustumCulled = false;
			const src = o.material;
			const m = new THREE.MeshPhysicalNodeMaterial();
			m.fog = false;

			if ( o === eyes ) {

				// silver-blue eyes: bright iris with a wet, mirror-like cornea
				m.color = new THREE.Color( 0.42, 0.56, 0.7 );
				m.map = src.map;
				m.colorNode = texture( src.map, uv() ).rgb.mul( 0.35 ).add( vec3( 0.36, 0.5, 0.66 ) );
				m.roughness = 0.12;
				m.clearcoat = 1.0;
				m.clearcoatRoughness = 0.02;
				m.emissiveNode = vec3( 0.06, 0.1, 0.16 ).add( U.glowColor.mul( U.night.mul( 0.25 ) ) );

			} else {

				m.map = src.map;
				// melanistic coat: near-black albedo with fine fur strands; rosettes survive faintly
				m.color.copy( src.color ).multiplyScalar( 0.15 );
				const pg = positionGeometry;
				const arg = vec2( pg.x.add( pg.y.mul( 0.3 ) ).mul( 520.0 ), pg.z.mul( 46.0 ).add( pg.y.mul( 40.0 ) ) );
				const fade = float( 1.0 ).sub( smoothstep( 0.4, 1.2, length( fwidth( arg ) ) ) );
				const strands = mix( float( 1.0 ), mix( 0.72, 1.18, vnoise( arg ) ), fade );
				m.colorNode = texture( src.map, uv() ).mul( materialColor ).mul( strands );
				m.roughness = 0.78;
				m.roughnessNode = mix( float( 0.72 ), float( 0.86 ), vnoise( arg.mul( 0.5 ) ) );
				m.metalness = 0.0;
				m.sheen = 0.7;
				m.sheenRoughness = 0.55;
				m.sheenColor = new THREE.Color( 0.07, 0.075, 0.09 );
				m.specularIntensity = 0.16;
				// soft fur silhouette (fuzz) when backlit + faint bioluminescent fill at night
				const V = normalize( cameraPosition.sub( positionWorld ) );
				const rim = pow( clamp( float( 1.0 ).sub( max( dot( normalWorld, V ), 0.0 ) ), 0.0, 1.0 ), 2.6 );
				const back = clamp( dot( V.negate(), U.sunDir ).mul( 0.5 ).add( 0.5 ), 0.0, 1.0 );
				m.emissiveNode = U.sunColor.mul( rim.mul( mix( 0.01, 0.16, back ) ) )
					.add( U.glowColor.mul( U.night.mul( U.glow ).mul( rim ).mul( 0.05 ) ) );

			}

			m.outputNode = vec4( applyFog( output.rgb, positionWorld ), output.a );
			o.material = m;

		} );

		// --- bones / joints
		const bones = {};
		model.traverse( ( o ) => {

			if ( o.isBone ) bones[ o.name.replace( /_\d+$/, '' ) ] = o;

		} );
		this.bones = bones;
		model.updateMatrixWorld( true );

		// rotation axes (side = +X, up = +Y, fwd = +Z in model space) in each bone's parent space
		const modelInv = model.getWorldQuaternion( new THREE.Quaternion() ).invert();
		const axisIn = ( bone, a ) => {

			const pq = bone.parent.getWorldQuaternion( new THREE.Quaternion() ).premultiply( modelInv );
			return a.clone().applyQuaternion( pq.invert() ).normalize();

		};

		const X = new THREE.Vector3( 1, 0, 0 ), Y = new THREE.Vector3( 0, 1, 0 ), Z = new THREE.Vector3( 0, 0, 1 );
		this.joints = {};
		const names = [
			'Bip001', 'Bip001_Spine', 'Bip001_Spine1', 'Bip001_Spine2', 'Bip001_Spine3',
			'Bip001_Neck', 'Bip001_Neck1', 'Bip001_Neck2', 'Bip001_Head',
			'Bone001', 'Bone002', 'Bone003', 'Bone004', 'Bone005', 'Bone006',
			'Bip001_Ponytail1', 'Bip001_Ponytail2',
		];
		for ( const s of [ 'L', 'R' ] ) {

			names.push( `Bip001_${ s }_Clavicle`, `Bip001_${ s }_UpperArm`, `Bip001_${ s }_Forearm`, `Bip001_${ s }_Hand`, `Bip001_${ s }_Finger0` );
			names.push( `Bip001_${ s }_Thigh`, `Bip001_${ s }_Calf`, `Bip001_${ s }_HorseLink`, `Bip001_${ s }_Foot`, `Bip001_${ s }_Toe0` );

		}

		for ( const n of names ) {

			const b = bones[ n ];
			if ( ! b ) continue;
			this.joints[ n ] = { bone: b, x: axisIn( b, X ), y: axisIn( b, Y ), z: axisIn( b, Z ), rest: b.quaternion.clone() };

		}

		const wp = ( n ) => bones[ n ].getWorldPosition( new THREE.Vector3() ).sub( this.body.getWorldPosition( new THREE.Vector3() ) );
		this.hindLen = ( wp( 'Bip001_L_Thigh' ).y - wp( 'Bip001_L_Toe0' ).y ) / SIZE;
		this.foreLen = ( wp( 'Bip001_L_UpperArm' ).y - wp( 'Bip001_L_Finger0' ).y ) / SIZE;
		this.hip = wp( 'Bip001_Pelvis' ); // pivot for sitting (model at origin)

		this._q = new THREE.Quaternion();
		this.ready = true;

	}

	// rotate a joint about side (x), up (y) and forward (z) axes (radians)
	rot( name, ax, ay = 0, az = 0 ) {

		const j = this.joints[ name ];
		if ( ! j ) return;
		const q = this._q;
		if ( ax ) {

			q.setFromAxisAngle( j.x, ax );
			j.bone.quaternion.premultiply( q );

		}

		if ( ay ) {

			q.setFromAxisAngle( j.y, ay );
			j.bone.quaternion.premultiply( q );

		}

		if ( az ) {

			q.setFromAxisAngle( j.z, az );
			j.bone.quaternion.premultiply( q );

		}

	}

	place( x, z, heading ) {

		this.pos.set( x, terrainHeightJS( x, z ), z );
		this.heading = heading;

	}

	// ------------------------------------------------------------------ control

	/**
	 * @param input null (wander on its own) or { x, y, run, sprint } with (x,y)
	 *              the desired world-XZ move direction (camera-relative)
	 */
	update( dt, input, wanderCentre ) {

		if ( ! this.ready ) return;
		this.time += dt;

		let desired = null, run = false, sprint = false;
		if ( input ) {

			if ( input.x * input.x + input.y * input.y > 0.01 ) desired = Math.atan2( - input.x, - input.y );
			run = input.run; sprint = input.sprint && input.run;

		} else {

			const w = this.wander;
			w.timer -= dt;
			if ( w.timer <= 0 ) {

				const c = wanderCentre || this.pos;
				const a = Math.random() * TAU, r = 10 + Math.random() * 30;
				w.target.set( c.x + Math.cos( a ) * r, 0, c.z + Math.sin( a ) * r );
				w.run = Math.random() < 0.12;
				w.timer = 10 + Math.random() * 14;
				// often rests long enough to sit or lie down
				w.pause = Math.random() < 0.55 ? 6 + Math.random() * 30 : 0;

			}

			const dx = w.target.x - this.pos.x, dz = w.target.z - this.pos.z;
			if ( w.pause > 0 ) w.pause -= dt;
			else if ( dx * dx + dz * dz > 4 ) {

				desired = Math.atan2( - dx, - dz );
				run = w.run;

			}

		}

		// getting up from sitting / lying takes a moment before walking off
		const seated = Math.max( this.sitW, this.lieW );
		const prevHeading = this.heading;
		if ( desired !== null ) {

			this.restTime = 0;
			const d = angleDiff( this.heading, desired );
			const rate = lerp( 2.4, 1.1, smooth( 4, 16, this.speed ) ) * ( 1 - seated * 0.9 );
			this.heading += Math.sign( d ) * Math.min( Math.abs( d ), rate * dt );
			const turnPenalty = lerp( 1, 0.35, smooth( 0.6, 2.2, Math.abs( d ) ) );
			const top = sprint ? SPEED.gallop : run ? SPEED.canter : SPEED.walk;
			this.targetSpeed = top * ( input ? 1 : 0.85 ) * turnPenalty * ( 1 - smooth( 0.05, 0.6, seated ) );

		} else this.targetSpeed = 0;

		const accel = this.targetSpeed > this.speed ? ( sprint ? 10 : run ? 7.5 : 2.6 ) : 5.5;
		this.speed += Math.sign( this.targetSpeed - this.speed ) * Math.min( Math.abs( this.targetSpeed - this.speed ), accel * dt );
		this.turnRate = lerp( this.turnRate, angleDiff( prevHeading, this.heading ) / Math.max( dt, 1e-3 ), 1 - Math.exp( - dt * 6 ) );

		this.pos.x += - Math.sin( this.heading ) * this.speed * dt;
		this.pos.z += - Math.cos( this.heading ) * this.speed * dt;

		// rest states: sit after 10 s still, lie down after 20 s
		if ( this.speed < 0.05 && desired === null ) this.restTime += dt;
		else this.restTime = 0;
		const wantSit = this.restTime > 10 ? 1 : 0, wantLie = this.restTime > 20 ? 1 : 0;
		const kDown = 1 - Math.exp( - dt * 1.1 ), kUp = 1 - Math.exp( - dt * 3.2 );
		this.sitW += ( wantSit - this.sitW ) * ( wantSit > this.sitW ? kDown : kUp );
		this.lieW += ( wantLie - this.lieW ) * ( wantLie > this.lieW ? kDown * 0.8 : kUp );

		this.animate( dt );

	}

	// ------------------------------------------------------------------ locomotion

	blendWeights( v ) {

		// 1D blend tree on speed: idle -> walk -> trot -> canter -> gallop
		const t = { idle: 0, walk: 0, trot: 0, canter: 0, gallop: 0 };
		const bands = [ [ 'idle', 0 ], [ 'walk', 1.2 ], [ 'walk', 3.0 ], [ 'trot', 4.4 ], [ 'trot', 5.8 ], [ 'canter', 7.5 ], [ 'canter', 11.5 ], [ 'gallop', 14.5 ] ];
		if ( v <= 0.08 ) {

			t.idle = 1;
			return t;

		}

		for ( let i = 0; i < bands.length - 1; i ++ ) {

			const [ a, va ] = bands[ i ], [ b, vb ] = bands[ i + 1 ];
			if ( v <= vb ) {

				const k = smooth( va, vb, v );
				t[ a ] += 1 - k; t[ b ] += k;
				return t;

			}

		}

		t.gallop = 1;
		return t;

	}

	animate( dt ) {

		const v = this.speed;
		const k = 1 - Math.exp( - dt * 5 );
		const tw = this.blendWeights( v );
		for ( const g in this.weights ) this.weights[ g ] = lerp( this.weights[ g ], tw[ g ], k );
		const W = this.weights;
		const moveW = 1 - W.idle;
		const m = moveW;

		for ( const n in this.joints ) this.joints[ n ].bone.quaternion.copy( this.joints[ n ].rest );

		// ---- shared phase, blended stride frequency
		let f = 0, wsum = 0;
		for ( const g of GAIT_NAMES ) {

			f += W[ g ] * GAITS[ g ].freq( Math.max( v, 0.8 ) );
			wsum += W[ g ];

		}

		f = wsum > 1e-3 ? f / wsum : GAITS.walk.freq( 1 );
		this.phase = ( this.phase + dt * f ) % 1;
		const P = this.phase;

		const legs = [ 'LH', 'RH', 'LF', 'RF' ];
		const ang = {};
		for ( const l of legs ) ang[ l ] = { swing: 0, lift: 0, push: 0 };
		let bob = 0, sway = 0, flex = 0;

		for ( const g of GAIT_NAMES ) {

			const w = W[ g ];
			if ( w < 1e-3 ) continue;
			const G = GAITS[ g ];
			const travel = v * G.beta / Math.max( f, 0.3 ); // paw travel during stance == body travel
			for ( let i = 0; i < 4; i ++ ) {

				const p = ( P + G.off[ i ] ) % 1;
				const len = ( i < 2 ? this.hindLen : this.foreLen ) * SIZE;
				const A = Math.asin( Math.min( 0.85, travel / ( 2 * len ) ) );
				let swing, lift = 0, push = 0;
				if ( p < G.beta ) {

					const u = p / G.beta;
					swing = A * ( 1 - 2 * u );
					push = smooth( 0.6, 1.0, u );

				} else {

					const u = ( p - G.beta ) / ( 1 - G.beta );
					const e = u * u * ( 3 - 2 * u );
					swing = A * ( - 1 + 2 * e );
					lift = Math.sin( Math.PI * u ) * G.lift;

				}

				const a = ang[ legs[ i ] ];
				a.swing += swing * w; a.lift += lift * w; a.push += push * w;

			}

			const bound = g === 'gallop' || g === 'canter';
			bob += w * G.bob * ( bound ? Math.sin( TAU * P ) : Math.sin( TAU * P * 2 ) );
			sway += w * G.sway * Math.sin( TAU * P );
			flex += w * G.flex * Math.sin( TAU * ( P - 0.15 ) );

		}

		// footfall events (dominant gait)
		const dom = GAIT_NAMES.reduce( ( a, b ) => ( W[ b ] > W[ a ] ? b : a ), 'walk' );
		for ( let i = 0; i < 4; i ++ ) {

			const p = ( P + GAITS[ dom ].off[ i ] ) % 1;
			if ( m > 0.3 && p < this._prevPhase[ i ] ) this.steps ++;
			this._prevPhase[ i ] = p;

		}

		// ---- legs (+x = distal end moves backward)
		for ( const s of [ 'L', 'R' ] ) {

			const H = ang[ s + 'H' ], F = ang[ s + 'F' ];
			this.rot( `Bip001_${ s }_Thigh`, m * ( - H.swing - H.lift * 0.25 ) );
			this.rot( `Bip001_${ s }_Calf`, m * ( - H.lift * 0.75 ) );
			this.rot( `Bip001_${ s }_HorseLink`, m * ( H.lift * 1.0 + H.push * 0.25 ) );
			this.rot( `Bip001_${ s }_Foot`, m * ( H.lift * 0.5 + H.swing * 0.4 ) );
			this.rot( `Bip001_${ s }_Toe0`, m * ( H.lift * 0.4 ) );
			this.rot( `Bip001_${ s }_Clavicle`, m * ( - F.swing * 0.35 ) );
			this.rot( `Bip001_${ s }_UpperArm`, m * ( - F.swing * 0.8 - F.lift * 0.15 ) );
			this.rot( `Bip001_${ s }_Forearm`, m * ( F.lift * 0.9 ) );
			this.rot( `Bip001_${ s }_Hand`, m * ( F.lift * 1.25 + F.swing * 0.55 + F.push * 0.2 ) );
			this.rot( `Bip001_${ s }_Finger0`, m * ( F.lift * 0.5 ) );

		}

		// ---- spine: bound-gait flexion wave, walk sway, bend into turns
		const turn = THREE.MathUtils.clamp( this.turnRate, - 1.5, 1.5 );
		const bend = turn * 0.07 * m;
		this.rot( 'Bip001_Spine', m * flex * 0.5, sway * m + bend );
		this.rot( 'Bip001_Spine1', m * flex * 0.8, - sway * 0.5 * m + bend );
		this.rot( 'Bip001_Spine2', m * - flex * 0.5, bend );
		this.rot( 'Bip001_Spine3', m * - flex * 0.6, bend );

		// ---- rest behaviour: calm look-around, breathing, ears, tail
		this.restBehaviour( dt, m );

		// ---- head: when moving it looks straight ahead, leaning a little into turns
		const gal = W.gallop + W.canter * 0.6;
		const headPitch = - flex * 0.6 + gal * 0.1 - bob * 1.5;
		const lookYaw = this.look.yaw.v * ( 1 - m ), lookPitch = this.look.pitch.v * ( 1 - m );
		const turnLook = turn * 0.12 * m;
		this.rot( 'Bip001_Neck', m * headPitch * 0.4 + lookPitch * 0.35, lookYaw * 0.35 + turnLook * 0.5 );
		this.rot( 'Bip001_Neck1', m * headPitch * 0.3 + lookPitch * 0.3, lookYaw * 0.35 + turnLook * 0.3 );
		this.rot( 'Bip001_Neck2', lookPitch * 0.15, lookYaw * 0.15 );
		this.rot( 'Bip001_Head', m * headPitch * 0.3 + lookPitch * 0.2, lookYaw * 0.15 + turnLook * 0.2, - lookYaw * 0.12 );

		// ---- tail: carried, lags behind the body, rises at speed, slow sway at rest
		for ( let i = 1; i <= 6; i ++ ) {

			const lag = i * 0.55;
			const carry = i === 1 ? - 0.28 : ( i === 2 ? - 0.1 : ( i >= 5 ? - 0.06 : 0 ) );
			const rest = Math.max( this.sitW, this.lieW );
			const swayT = Math.sin( TAU * P - lag ) * ( 0.05 + 0.04 * i / 6 ) * m
				+ Math.sin( this.time * 0.55 - i * 0.45 ) * 0.035 * ( 1 - m )
				+ this.tailFlick.s.v * ( i / 6 ) * 0.35;
			// resting: tail lies on the ground curled around
			const restCurl = rest * ( i === 1 ? 0.55 : ( i <= 3 ? 0.08 : - 0.05 ) );
			const restSide = rest * ( i >= 2 ? 0.16 : 0 );
			const lift = carry * ( 1 - rest ) - gal * 0.12 + Math.sin( TAU * P * 2 - lag ) * 0.04 * m + restCurl;
			this.rot( `Bone00${ i }`, lift, swayT - turn * 0.05 * m + restSide );

		}

		// ---- sit / lie poses (applied as joint deltas + body drop/pitch)
		this.restPose();
		if ( this.debugRot ) for ( const n in this.debugRot ) this.rot( n, this.debugRot[ n ] );

		// ---- body placement: terrain slope, bob, banking, pose drop
		const fwdX = - Math.sin( this.heading ), fwdZ = - Math.cos( this.heading );
		const half = 0.55 * SIZE;
		const hF = terrainHeightJS( this.pos.x + fwdX * half, this.pos.z + fwdZ * half );
		const hB = terrainHeightJS( this.pos.x - fwdX * half, this.pos.z - fwdZ * half );
		const ground = ( hF + hB ) * 0.5;
		this.pos.y = lerp( this.pos.y, ground, 1 - Math.exp( - dt * 12 ) );
		this.pitch = lerp( this.pitch, Math.atan2( hF - hB, 2 * half ), 1 - Math.exp( - dt * 8 ) );
		this.lean = lerp( this.lean, - turn * this.speed * 0.012, 1 - Math.exp( - dt * 4 ) );

		this.group.position.copy( this.pos );
		this.group.rotation.set( 0, this.heading + Math.PI, 0 );

		// sitting tips the body up around the hips
		const sitW = this.sitW * ( 1 - this.lieW );
		const sitPitch = sitW * POSE.sit.pitch + this.lieW * POSE.lie.pitch;
		const drop = ( sitW * POSE.sit.drop + this.lieW * POSE.lie.drop ) * SIZE;
		const bodyPitch = - this.pitch - sitPitch;
		this.body.rotation.set( bodyPitch, 0, THREE.MathUtils.clamp( this.lean, - 0.25, 0.25 ) );
		// rotate about the hip pivot instead of the feet
		const hy = this.hip.y, hz = this.hip.z;
		const c = Math.cos( bodyPitch ), s = Math.sin( bodyPitch );
		const py = hy - ( hy * c - hz * s ), pz = hz - ( hy * s + hz * c );
		this.body.position.set( 0, py + bob * SIZE * m - gal * 0.03 * SIZE - drop, pz );

	}

	restBehaviour( dt, m ) {

		const L = this.look, still = 1 - m;
		L.timer -= dt;
		if ( L.timer <= 0 ) {

			// pick a new point of interest; sometimes hold a gaze for a long time
			const r = Math.random();
			if ( r < 0.35 ) {

				L.tYaw = 0; L.tPitch = ( Math.random() - 0.5 ) * 0.1; // forward

			} else {

				L.tYaw = ( Math.random() < 0.5 ? - 1 : 1 ) * ( 0.25 + Math.random() * 0.6 );
				L.tPitch = ( Math.random() - 0.6 ) * 0.25;

			}

			L.timer = r < 0.25 ? 9 + Math.random() * 9 : 3.5 + Math.random() * 5;

		}

		// slower, heavier motion when lying down
		const hl = lerp( 0.85, 1.4, this.lieW );
		L.yaw.step( L.tYaw * still, dt, hl );
		L.pitch.step( L.tPitch * still, dt, hl );

		// breathing
		const br = Math.sin( this.time * TAU * 0.24 ) * 0.012 * still;
		this.rot( 'Bip001_Spine1', br );
		this.rot( 'Bip001_Spine2', - br * 0.6 );

		// occasional ear flicks
		const E = this.ear;
		E.timer -= dt;
		if ( E.timer <= 0 ) {

			E.target = Math.random() < 0.5 ? 'L' : 'R';
			E.until = this.time + 0.18;
			E.timer = 2.5 + Math.random() * 6;

		}

		for ( const s of [ 'L', 'R' ] ) {

			const tgt = E.target === s && this.time < E.until ? 0.45 : 0;
			E[ s ].step( tgt, dt, 0.06 );

		}

		this.rot( 'Bip001_Ponytail1', 0, E.R.v * still );
		this.rot( 'Bip001_Ponytail2', 0, - E.L.v * still );

		// occasional slow tail flick
		const T = this.tailFlick;
		T.timer -= dt;
		if ( T.timer <= 0 ) {

			T.until = this.time + 0.9;
			T.dir = Math.random() < 0.5 ? - 1 : 1;
			T.timer = 5 + Math.random() * 9;

		}

		T.s.step( this.time < T.until ? T.dir * still : 0, dt, 0.35 );

	}

	restPose() {

		const sit = this.sitW * ( 1 - this.lieW ), lie = this.lieW;
		if ( sit + lie < 1e-3 ) return;
		const S = POSE.sit, L = POSE.lie;
		const mixp = ( k ) => sit * S[ k ] + lie * L[ k ];
		for ( const s of [ 'L', 'R' ] ) {

			// hind legs folded under the hips, hocks and paws on the ground
			this.rot( `Bip001_${ s }_Thigh`, mixp( 'thigh' ) );
			this.rot( `Bip001_${ s }_Calf`, mixp( 'calf' ) );
			this.rot( `Bip001_${ s }_HorseLink`, mixp( 'hock' ) );
			this.rot( `Bip001_${ s }_Foot`, mixp( 'foot' ) );
			// front legs: vertical when sitting, forearms forward on the ground when lying
			this.rot( `Bip001_${ s }_UpperArm`, mixp( 'ua' ) );
			this.rot( `Bip001_${ s }_Forearm`, mixp( 'fa' ) );
			this.rot( `Bip001_${ s }_Hand`, mixp( 'hand' ) );

		}

		// keep the head level (+ = nose down): undo the sitting body pitch
		this.rot( 'Bip001_Neck', sit * 0.16 - lie * 0.32 );
		this.rot( 'Bip001_Neck1', sit * 0.12 - lie * 0.12 );
		this.rot( 'Bip001_Head', sit * 0.06 + lie * 0.22 );

	}

}
