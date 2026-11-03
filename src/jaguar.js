// Black jaguar: a skinned, textured big-cat model driven by procedural
// quadruped locomotion.
//
// Model: "black panther" by kenchoo (Sketchfab), CC-BY-4.0
//   https://sketchfab.com/3d-models/black-panther-7fca11c89cca4362a525c891a8345112
//   (optimised: WebP textures + meshopt, 6.9 MB -> 0.54 MB)
//
// The model ships with a single showcase clip (idle, lie down, get up) but no
// walk / run cycles, so locomotion is generated here on its real 47-bone rig:
//   - a 1D blend tree on speed (idle / walk / trot / gallop), as in False Earth's
//     character controller, but blending *gaits* instead of baked clips
//   - per-leg phase offsets for each gait (lateral-sequence walk, diagonal trot,
//     rotary gallop), stance/swing timing, joint flexion during swing
//   - stride amplitude solved from speed and leg length so paws don't slide
//   - spine flexion (gallop), lateral sway (walk), head stabilisation, a tail
//     that lags behind the body, banking into turns, slope following
//   - footfall events (for audio) when each paw starts its stance
// Joint rotations are applied about the animal's side / up axes expressed in
// each bone's parent space, which keeps signs consistent on the Biped rig.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { vec4, output, positionWorld, normalWorld, cameraPosition, normalize, dot, pow, clamp, float, max, mix } from 'three/tsl';
import { U, applyFog } from './tsl/world.js';
import { terrainHeightJS } from './tsl/world.js';

const TAU = Math.PI * 2;
const lerp = THREE.MathUtils.lerp;
const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const smooth = ( a, b, x ) => {

	const t = clamp01( ( x - a ) / ( b - a ) );
	return t * t * ( 3 - 2 * t );

};

const angleDiff = ( a, b ) => Math.atan2( Math.sin( b - a ), Math.cos( b - a ) );

// Gaits: stance fraction, stride frequency f(v), phase offsets per leg
// (LH, RH, LF, RF), swing lift and body motion amounts.
const GAITS = {
	walk: { beta: 0.64, freq: ( v ) => 0.75 + 0.32 * v, off: [ 0.0, 0.5, 0.25, 0.75 ], lift: 0.9, bob: 0.012, sway: 0.05, flex: 0.0 },
	trot: { beta: 0.46, freq: ( v ) => 1.25 + 0.14 * v, off: [ 0.0, 0.5, 0.5, 0.0 ], lift: 1.0, bob: 0.02, sway: 0.025, flex: 0.06 },
	gallop: { beta: 0.32, freq: ( v ) => 1.9 + 0.045 * v, off: [ 0.0, 0.1, 0.52, 0.62 ], lift: 1.15, bob: 0.05, sway: 0.0, flex: 0.3 },
};

const SPEED = { walk: 1.7, run: 12.0 };

export class Jaguar {

	constructor() {

		this.group = new THREE.Group(); // world placement (yaw)
		this.body = new THREE.Group(); // slope pitch / roll
		this.group.add( this.body );
		this.ready = false;

		this.pos = new THREE.Vector3();
		this.heading = 0; // radians, 0 = facing -Z (same convention as the camera yaw)
		this.speed = 0;
		this.targetSpeed = 0;
		this.turnRate = 0;
		this.phase = 0;
		this.steps = 0;
		this.weights = { idle: 1, walk: 0, trot: 0, gallop: 0 };
		this.lean = 0;
		this.pitch = 0;
		this._prevPhase = [ 0, 0, 0, 0 ];

		// autonomous wandering when not player-controlled
		this.wander = { target: new THREE.Vector3(), timer: 0, run: false, pause: 0 };

	}

	async load( url ) {

		const loader = new GLTFLoader();
		loader.setMeshoptDecoder( MeshoptDecoder );
		const gltf = await loader.loadAsync( url );
		const model = gltf.scene;

		// real jaguar: ~1.6 m nose-to-rump, ~0.7 m at the shoulder
		const scale = 1.2;
		model.scale.setScalar( scale );
		this.scale = scale;
		this.body.add( model );

		// --- materials: velvety black fur with a sheen rim, fogged like the scene
		model.traverse( ( o ) => {

			if ( ! o.isMesh ) return;
			o.frustumCulled = false;
			const src = o.material;
			const m = new THREE.MeshPhysicalNodeMaterial();
			m.map = src.map;
			m.emissiveMap = null;
			// melanistic coat: near-black albedo; rosettes survive faintly in the texture
			m.color.copy( src.color ).multiplyScalar( 0.16 );
			m.roughness = 0.64;
			m.metalness = 0.0;
			m.sheen = 1.0;
			m.sheenRoughness = 0.35;
			m.sheenColor = new THREE.Color( 0.1, 0.11, 0.14 );
			m.specularIntensity = 0.3;
			// fur rim light when backlit + bioluminescent blue fill at night
			const V = normalize( cameraPosition.sub( positionWorld ) );
			const rim = pow( clamp( float( 1.0 ).sub( max( dot( normalWorld, V ), 0.0 ) ), 0.0, 1.0 ), 3.0 );
			const back = clamp( dot( V.negate(), U.sunDir ).mul( 0.5 ).add( 0.5 ), 0.0, 1.0 );
			m.emissiveNode = U.sunColor.mul( rim.mul( mix( 0.015, 0.22, back ) ) )
				.add( U.glowColor.mul( U.night.mul( U.glow ).mul( rim ).mul( 0.06 ) ) );
			m.outputNode = vec4( applyFog( output.rgb, positionWorld ), output.a );
			m.fog = false;
			o.material = m;

		} );

		// --- bones
		const bones = {};
		model.traverse( ( o ) => {

			if ( o.isBone ) bones[ o.name.replace( /_\d+$/, '' ) ] = o;

		} );
		this.bones = bones;

		// --- idle: first part of the baked clip, without root drift
		this.mixer = new THREE.AnimationMixer( model );
		const full = gltf.animations[ 0 ];
		if ( full ) {

			const idle = THREE.AnimationUtils.subclip( full, 'idle', 0, Math.round( 5.4 * 24 ), 24 );
			idle.tracks = idle.tracks.filter( ( t ) => ! ( /Bip001_48\.position|rootJoint/.test( t.name ) ) );
			const action = this.mixer.clipAction( idle );
			action.play();
			this.mixer.update( 0 );

		}

		model.updateMatrixWorld( true );

		// joint controls: rotation axes (side = +X, up = +Y, fwd = +Z in model space)
		// expressed in each bone's parent space
		const modelInv = new THREE.Quaternion().copy( model.getWorldQuaternion( new THREE.Quaternion() ) ).invert();
		const axisIn = ( bone, worldAxis ) => {

			const pq = bone.parent.getWorldQuaternion( new THREE.Quaternion() ).premultiply( modelInv );
			return worldAxis.clone().applyQuaternion( pq.invert() ).normalize();

		};

		const X = new THREE.Vector3( 1, 0, 0 ), Y = new THREE.Vector3( 0, 1, 0 ), Z = new THREE.Vector3( 0, 0, 1 );
		this.joints = {};
		const names = [
			'Bip001', 'Bip001_Spine', 'Bip001_Spine1', 'Bip001_Spine2', 'Bip001_Spine3',
			'Bip001_Neck', 'Bip001_Neck1', 'Bip001_Neck2', 'Bip001_Head',
			'Bone001', 'Bone002', 'Bone003', 'Bone004', 'Bone005', 'Bone006',
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

		// leg length (hip -> paw) for no-slip stride amplitude
		const wp = ( n ) => bones[ n ].getWorldPosition( new THREE.Vector3() );
		this.hindLen = wp( 'Bip001_L_Thigh' ).y - wp( 'Bip001_L_Toe0' ).y;
		this.foreLen = wp( 'Bip001_L_UpperArm' ).y - wp( 'Bip001_L_Finger0' ).y;
		this.bodyLen = wp( 'Bip001_Head' ).z - wp( 'Bip001_Pelvis' ).z;

		this._q = new THREE.Quaternion();
		this.ready = true;

	}

	// rotate a joint by angles (rad) about side (x), up (y) and forward (z) axes
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
	 * @param dt seconds
	 * @param input null (wander on its own) or { x, y, run } where (x,y) is the
	 *              desired move direction in world XZ (already camera-relative)
	 */
	update( dt, input, wanderCentre ) {

		if ( ! this.ready ) return;

		let desired = null, run = false;
		if ( input ) {

			if ( input.x * input.x + input.y * input.y > 0.01 ) desired = Math.atan2( - input.x, - input.y );
			run = input.run;

		} else {

			const w = this.wander;
			w.timer -= dt;
			if ( w.timer <= 0 ) {

				const c = wanderCentre || this.pos;
				const a = Math.random() * TAU, r = 6 + Math.random() * 18;
				w.target.set( c.x + Math.cos( a ) * r, 0, c.z + Math.sin( a ) * r );
				w.run = Math.random() < 0.15;
				w.timer = 8 + Math.random() * 10;
				w.pause = Math.random() < 0.4 ? 2 + Math.random() * 5 : 0;

			}

			const dx = w.target.x - this.pos.x, dz = w.target.z - this.pos.z;
			if ( w.pause > 0 ) w.pause -= dt;
			else if ( dx * dx + dz * dz > 1.5 ) {

				desired = Math.atan2( - dx, - dz );
				run = w.run;

			}

		}

		// steering (camera-relative in third person, like False Earth's solveCam)
		const prevHeading = this.heading;
		if ( desired !== null ) {

			const d = angleDiff( this.heading, desired );
			const rate = lerp( 3.2, 1.6, smooth( 3, 12, this.speed ) );
			this.heading += Math.sign( d ) * Math.min( Math.abs( d ), rate * dt );
			// slow down for sharp turns
			const turnPenalty = lerp( 1, 0.35, smooth( 0.6, 2.2, Math.abs( d ) ) );
			this.targetSpeed = ( run ? SPEED.run : SPEED.walk ) * ( input ? 1 : 0.8 ) * turnPenalty;

		} else this.targetSpeed = 0;

		const accel = this.targetSpeed > this.speed ? ( run ? 5.5 : 2.5 ) : 4.0;
		this.speed += Math.sign( this.targetSpeed - this.speed ) * Math.min( Math.abs( this.targetSpeed - this.speed ), accel * dt );
		this.turnRate = lerp( this.turnRate, angleDiff( prevHeading, this.heading ) / Math.max( dt, 1e-3 ), 1 - Math.exp( - dt * 8 ) );

		this.pos.x += - Math.sin( this.heading ) * this.speed * dt;
		this.pos.z += - Math.cos( this.heading ) * this.speed * dt;

		this.animate( dt );

	}

	// ------------------------------------------------------------------ locomotion

	blendWeights( v ) {

		// 1D blend tree on speed: idle -> walk -> trot -> gallop
		const t = { idle: 0, walk: 0, trot: 0, gallop: 0 };
		if ( v < 0.08 ) t.idle = 1;
		else if ( v < 0.9 ) {

			t.walk = smooth( 0.08, 0.9, v );
			t.idle = 1 - t.walk;

		} else if ( v < 2.6 ) t.walk = 1;
		else if ( v < 4.2 ) {

			t.trot = smooth( 2.6, 4.2, v );
			t.walk = 1 - t.trot;

		} else if ( v < 6.0 ) t.trot = 1;
		else {

			t.gallop = smooth( 6.0, 8.0, v );
			t.trot = 1 - t.gallop;

		}

		return t;

	}

	animate( dt ) {

		const v = this.speed;
		const k = 1 - Math.exp( - dt * 6 );
		const tw = this.blendWeights( v );
		for ( const g in this.weights ) this.weights[ g ] = lerp( this.weights[ g ], tw[ g ], k );
		const W = this.weights;
		const moveW = 1 - W.idle;

		// idle base pose from the baked clip (slowed down when moving). Joints the
		// clip doesn't animate are reset first so procedural deltas never accumulate.
		for ( const n in this.joints ) this.joints[ n ].bone.quaternion.copy( this.joints[ n ].rest );
		this.mixer.update( dt * ( 1 - moveW * 0.8 ) );

		// shared phase: blended stride frequency
		let f = 0, wsum = 0;
		for ( const g of [ 'walk', 'trot', 'gallop' ] ) {

			f += W[ g ] * GAITS[ g ].freq( Math.max( v, 0.6 ) );
			wsum += W[ g ];

		}

		f = wsum > 1e-3 ? f / wsum : 1;
		this.phase = ( this.phase + dt * f ) % 1;
		const P = this.phase;

		// per-gait leg angles, blended
		const legs = [ 'LH', 'RH', 'LF', 'RF' ];
		const ang = {};
		for ( const l of legs ) ang[ l ] = { swing: 0, lift: 0, push: 0 };
		let bob = 0, sway = 0, flex = 0, stanceStart = [ 0, 0, 0, 0 ];

		for ( const g of [ 'walk', 'trot', 'gallop' ] ) {

			const w = W[ g ];
			if ( w < 1e-3 ) continue;
			const G = GAITS[ g ];
			// no-slip amplitude: paw travel during stance == body travel
			const travel = v * G.beta / Math.max( f, 0.3 );
			for ( let i = 0; i < 4; i ++ ) {

				const p = ( P + G.off[ i ] ) % 1;
				const len = ( i < 2 ? this.hindLen : this.foreLen ) * this.scale;
				const A = Math.asin( Math.min( 0.75, travel / ( 2 * len ) ) );
				let swing, lift = 0, push = 0;
				if ( p < G.beta ) {

					const u = p / G.beta;
					swing = A * ( 1 - 2 * u );
					push = smooth( 0.6, 1.0, u ); // toe-off

				} else {

					const u = ( p - G.beta ) / ( 1 - G.beta );
					const e = u * u * ( 3 - 2 * u );
					swing = A * ( - 1 + 2 * e );
					lift = Math.sin( Math.PI * u ) * G.lift;

				}

				const a = ang[ legs[ i ] ];
				a.swing += swing * w;
				a.lift += lift * w;
				a.push += push * w;
				if ( p < 0.5 ) stanceStart[ i ] += w; // dominant-gait footfall bookkeeping

			}

			bob += w * G.bob * ( g === 'gallop' ? Math.sin( TAU * P ) : Math.sin( TAU * P * 2 ) );
			sway += w * G.sway * Math.sin( TAU * P );
			flex += w * G.flex * Math.sin( TAU * ( P - 0.15 ) );

		}

		// footfall events: a paw entering stance (phase wraps to 0 in its cycle)
		const dom = [ 'walk', 'trot', 'gallop' ].reduce( ( a, b ) => ( W[ b ] > W[ a ] ? b : a ), 'walk' );
		if ( moveW > 0.3 ) {

			for ( let i = 0; i < 4; i ++ ) {

				const p = ( P + GAITS[ dom ].off[ i ] ) % 1;
				if ( p < this._prevPhase[ i ] ) {

					this.steps ++;
					this.lastStepSide = i % 2 ? 1 : - 1;

				}

				this._prevPhase[ i ] = p;

			}

		}

		// ---- apply (angles: +x = paw / tip moves backward or nose down)
		const m = moveW;
		const turn = THREE.MathUtils.clamp( this.turnRate, - 2, 2 );
		const gal = W.gallop;

		for ( const s of [ 'L', 'R' ] ) {

			const H = ang[ s + 'H' ], F = ang[ s + 'F' ];
			// hind: hip swing, knee flexes forward, hock flexes back, paw follows
			this.rot( `Bip001_${ s }_Thigh`, m * ( - H.swing - H.lift * 0.25 ) );
			this.rot( `Bip001_${ s }_Calf`, m * ( - H.lift * 0.75 ) );
			this.rot( `Bip001_${ s }_HorseLink`, m * ( H.lift * 1.0 + H.push * 0.25 ) );
			this.rot( `Bip001_${ s }_Foot`, m * ( H.lift * 0.5 + H.swing * 0.4 ) );
			this.rot( `Bip001_${ s }_Toe0`, m * ( H.lift * 0.4 ) );
			// fore: shoulder blade + upper arm swing, elbow and wrist fold during swing
			this.rot( `Bip001_${ s }_Clavicle`, m * ( - F.swing * 0.35 ) );
			this.rot( `Bip001_${ s }_UpperArm`, m * ( - F.swing * 0.8 - F.lift * 0.15 ) );
			this.rot( `Bip001_${ s }_Forearm`, m * ( F.lift * 0.9 ) );
			this.rot( `Bip001_${ s }_Hand`, m * ( F.lift * 1.25 + F.swing * 0.55 + F.push * 0.2 ) );
			this.rot( `Bip001_${ s }_Finger0`, m * ( F.lift * 0.5 ) );

		}

		// spine: gallop flexion / extension wave, walk side-to-side, bend into turns
		const bend = turn * 0.06 * m;
		this.rot( 'Bip001_Spine', m * flex * 0.5, sway * m + bend );
		this.rot( 'Bip001_Spine1', m * flex * 0.8, - sway * 0.5 * m + bend );
		this.rot( 'Bip001_Spine2', m * - flex * 0.5, bend );
		this.rot( 'Bip001_Spine3', m * - flex * 0.6, bend );

		// head stays level and looks into the turn; lower, stalking head when galloping
		const headPitch = - flex * 0.6 + gal * 0.12 - bob * 2.0;
		this.rot( 'Bip001_Neck', m * headPitch * 0.4, turn * 0.08 * m );
		this.rot( 'Bip001_Neck1', m * headPitch * 0.3, turn * 0.06 * m );
		this.rot( 'Bip001_Head', m * headPitch * 0.3, turn * 0.05 * m );

		// tail: lags behind the body, rises for balance at speed
		const tailT = performance.now() / 1000;
		for ( let i = 1; i <= 6; i ++ ) {

			const lag = i * 0.55;
			const swayT = Math.sin( TAU * P - lag ) * ( 0.05 + 0.04 * i / 6 ) * m + Math.sin( tailT * 0.7 - i * 0.4 ) * 0.04 * ( 1 - m );
			// base of the tail is carried clear of the ground, tip curls up a little
			const carry = i === 1 ? - 0.28 : ( i === 2 ? - 0.1 : ( i >= 5 ? - 0.06 : 0 ) );
			const lift = carry - gal * 0.12 + Math.sin( TAU * P * 2 - lag ) * 0.04 * m;
			this.rot( `Bone00${ i }`, lift, swayT - turn * 0.05 * m );

		}

		// ---- body placement: follow terrain slope, bob, bank into turns
		const fwdX = - Math.sin( this.heading ), fwdZ = - Math.cos( this.heading );
		const half = 0.55 * this.scale;
		const hF = terrainHeightJS( this.pos.x + fwdX * half, this.pos.z + fwdZ * half );
		const hB = terrainHeightJS( this.pos.x - fwdX * half, this.pos.z - fwdZ * half );
		const ground = ( hF + hB ) * 0.5;
		this.pos.y = lerp( this.pos.y, ground, 1 - Math.exp( - dt * 12 ) );
		this.pitch = lerp( this.pitch, Math.atan2( hF - hB, 2 * half ), 1 - Math.exp( - dt * 8 ) );
		this.lean = lerp( this.lean, - turn * this.speed * 0.025, 1 - Math.exp( - dt * 5 ) );

		this.group.position.copy( this.pos );
		this.group.rotation.set( 0, this.heading + Math.PI, 0 ); // model faces +Z
		this.body.rotation.set( - this.pitch, 0, THREE.MathUtils.clamp( this.lean, - 0.3, 0.3 ) );
		this.body.position.y = bob * this.scale * m - gal * 0.04;

	}

}
