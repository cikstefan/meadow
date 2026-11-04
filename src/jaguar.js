// Black jaguar: a skinned, textured big-cat model driven by the artist's idle
// clip at rest and procedural quadruped locomotion when it moves.
//
// Model: "jaguar" by Ear.Rodriguez (Sketchfab), CC-BY-4.0
//   https://sketchfab.com/3d-models/jaguar-91c61c329d2a4668816f81f08dfcd492
//   converted FBX -> glTF (meshopt + WebP); coat repainted melanistic (a black
//   jaguar: the rosettes stay faintly visible in the black fur), eyes shaded
//   procedurally (silver-blue iris, round black pupil).
//
// The model ships with one idle clip (looking around, sniffing the ground,
// pawing). It is used as-is when the cat stands still and fades out as it
// starts to move or settles down.
//
// Locomotion follows the structure of False Earth's character controller:
// speed -> 1D blend weights -> poses + footstep events, with procedural gaits
// on the Advanced Skeleton rig. Footfall order follows real felids:
//   walk    lateral sequence       LH, LF, RH, RF   (duty ~0.65)
//   trot    diagonal pairs         LH+RF, RH+LF     (brief, between walk and run)
//   gallop  rotary, 4-beat         LH, RH, RF, LF   (Shift; Shift+Space sprints)
//           spine flexes (gathered) as the hind legs swing under the body
//           and extends as they push off; the head stays level.
// Stride amplitude is solved from speed and leg length; paws are planted on
// the terrain with 2-bone IK. At rest: idle clip + calm look-around, ear and
// tail flicks; after 10 s it sits, after 20 s it lies down (sphinx).

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
	vec3, vec4, output, positionWorld, positionGeometry, normalWorld, cameraPosition, normalize, dot, pow, clamp,
	float, max, mix, smoothstep, texture, uv, abs, normalGeometry, bumpMap, uniform, select, length, atan, sin, acos
} from 'three/tsl';
import { U, applyFog, terrainHeightJS } from './tsl/world.js';

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

		const w = 1.386 / Math.max( halfLife, 1e-3 );
		const x = this.v - target;
		const e = Math.exp( - w * dt );
		const tmp = ( this.vel + w * x ) * dt;
		this.vel = ( this.vel - w * tmp ) * e;
		this.v = target + ( x + tmp ) * e;
		return this.v;

	}

}

// model is in centimetres at life size; 1.8x a real jaguar
const SCALE = 0.018;
// legacy length unit for tuning constants (~ metres for this size)
const SIZE = 2.16;

// rig (Advanced Skeleton names)
const R = {
	root: 'Root_M',
	spine: [ 'Spine1_M', 'Spine2_M', 'Spine3_M', 'Chest_M' ],
	neck: [ 'Neck_M', 'Neck1_M', 'Neck2_M' ],
	head: 'Head_M',
	tail: [ 'Tail0_M', 'Tail7_M', 'Tail8_M', 'Tail9_M', 'Tail10_M', 'Tail11_M', 'Tail12_M', 'Tail13_M', 'Tail14_M', 'Tail15_M' ],
	ear: { L: 'Ear1_L', R: 'Ear4_R' },
	eye: { L: [ 'Eye_L', 'EyeEnd_L' ], R: [ 'Eye_R', 'EyeEnd_R' ] },
	leg: ( s ) => ( {
		clav: `Scapula_${ s }`, ua: `Shoulder_${ s }`, fa: `Elbow_${ s }`, hand: `Wrist_${ s }`, fing: `Fingers1_${ s }`,
		thigh: `Hip_${ s }`, calf: `Knee_${ s }`, hock: `Ankle_${ s }`, foot: `Toes1_${ s }`, toe: `Toes2_${ s }`,
	} ),
};
const LEG = { L: R.leg( 'L' ), R: R.leg( 'R' ) };

// Gaits. land = footfall phase of [LH, RH, LF, RF] within the stride.
// Stride frequencies are Froude-scaled for a 1.8x cat (slower cadence, longer strides).
const GAITS = {
	walk: {
		land: [ 0.0, 0.5, 0.25, 0.75 ], beta: () => 0.65, freq: ( v ) => 0.45 + 0.3 * v,
		lift: 0.1, bob: 0.006, sway: 0.035, flex: 0.0, shiftH: 0, shiftF: 0,
	},
	trot: {
		land: [ 0.0, 0.5, 0.5, 0.0 ], beta: () => 0.46, freq: ( v ) => 1.2 + 0.07 * v,
		lift: 0.15, bob: 0.012, sway: 0.015, flex: 0.03, shiftH: 0.02, shiftF: 0.02,
	},
	gallop: {
		land: [ 0.0, 0.12, 0.62, 0.5 ], beta: ( v ) => lerp( 0.38, 0.27, smooth( 7, 15, v ) ), freq: ( v ) => 1.8 + 0.045 * v,
		lift: 0.28, bob: 0.05, sway: 0.0, flex: 1.0, shiftH: 0.22, shiftF: 0.12,
	},
};
const GAIT_NAMES = [ 'walk', 'trot', 'gallop' ];
for ( const g of GAIT_NAMES ) GAITS[ g ].off = GAITS[ g ].land.map( ( l ) => ( 1 - l ) % 1 );

const SPEED = { walk: 1.7, run: 8.5, sprint: 15.0 };

// rest poses (joint deltas in radians, drop as a fraction of SIZE), solved so
// that paws, hocks and hips rest on the ground (see README: pose fitting)
export const POSE = {
	sit: { thigh: - 1.004, calf: 1.593, hock: - 1.12, foot: 1.112, ua: 0.89, fa: 0, hand: 0, pitch: 0.629, drop: 0.364 },
	lie: { thigh: - 1.091, calf: 1.678, hock: - 1.543, foot: 1.124, ua: 0.688, fa: - 1.483, hand: 0.9, pitch: 0.208, drop: 0.37 },
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
		this.weights = { idle: 1, walk: 0, trot: 0, gallop: 0 };
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
		this.model = model;

		const { default: furUrl } = await import( './assets/fur_detail.jpg?inline' );
		const furTex = await new THREE.TextureLoader().loadAsync( furUrl );
		furTex.wrapS = furTex.wrapT = THREE.RepeatWrapping;
		furTex.colorSpace = THREE.NoColorSpace;
		furTex.anisotropy = 4;

		// bones: the FBX rig nests pivot helpers with the same name; the outermost
		// (un-suffixed) node is the animated one
		const bones = {};
		model.traverse( ( o ) => {

			const base = o.name.replace( /_\d+$/, '' );
			if ( o.name && ! bones[ base ] ) bones[ base ] = o;

		} );
		this.bones = bones;

		// orient: nose along +Z, scale, paws on y = 0, body centred on the origin
		this.body.add( model );
		model.updateMatrixWorld( true );
		const wpos = ( n ) => bones[ n ].getWorldPosition( new THREE.Vector3() );
		const fwd = wpos( R.head ).sub( wpos( R.root ) );
		model.rotation.y = - Math.atan2( fwd.x, fwd.z );
		model.scale.setScalar( SCALE );
		model.updateMatrixWorld( true );
		const mid = wpos( R.root ).add( wpos( 'Chest_M' ) ).multiplyScalar( 0.5 );
		const floor = Math.min( wpos( 'Toes2_L' ).y, wpos( 'Toes2_R' ).y, wpos( 'Fingers2_L' ).y, wpos( 'Fingers2_R' ).y );
		model.position.set( - mid.x, - floor + 0.01, - mid.z );
		model.updateMatrixWorld( true );
		this.scale = SIZE;

		// idle clip (the artist's), faded out when moving / sitting / lying
		this.mixer = new THREE.AnimationMixer( model );
		this.idle = this.mixer.clipAction( gltf.animations[ 0 ] );
		this.idle.play();

		// --- materials
		const skinned = [];
		model.traverse( ( o ) => {

			if ( o.isSkinnedMesh ) skinned.push( o );

		} );
		const body = skinned.find( ( o ) => o.material.map );
		const eyes = skinned.find( ( o ) => /ojos/i.test( o.material.name ) );

		// fur tile ~ 10 cm (in the geometry's own, quantised units)
		body.geometry.computeBoundingBox();
		const gsz = body.geometry.boundingBox.getSize( new THREE.Vector3() );
		const wsz = new THREE.Box3().setFromObject( body, true ).getSize( new THREE.Vector3() );
		const furScale = float( Math.max( wsz.x, wsz.y, wsz.z ) / Math.max( gsz.x, gsz.y, gsz.z ) / 0.1 );

		// eye centres + gaze in world space, updated every frame from the eye bones
		this.eyeU = {};
		for ( const s of [ 'L', 'R' ] ) this.eyeU[ s ] = { c: uniform( new THREE.Vector3() ), d: uniform( new THREE.Vector3( 0, 0, 1 ) ), off: new THREE.Vector3() };
		if ( eyes ) {

			// eyeball centre = mean of the eye mesh's (skinned) vertices on each side
			const p = new THREE.Vector3(), acc = { L: new THREE.Vector3(), R: new THREE.Vector3() }, n = { L: 0, R: 0 };
			const eL = wpos( 'Eye_L' ), eR = wpos( 'Eye_R' );
			const cnt = eyes.geometry.attributes.position.count;
			for ( let i = 0; i < cnt; i ++ ) {

				eyes.getVertexPosition( i, p );
				p.applyMatrix4( eyes.matrixWorld );
				const s = p.distanceToSquared( eL ) < p.distanceToSquared( eR ) ? 'L' : 'R';
				acc[ s ].add( p ); n[ s ] ++;

			}

			for ( const s of [ 'L', 'R' ] ) {

				acc[ s ].divideScalar( Math.max( n[ s ], 1 ) );
				this.eyeU[ s ].off.copy( bones[ R.eye[ s ][ 0 ] ].worldToLocal( acc[ s ].clone() ) );

			}

		}

		model.traverse( ( o ) => {

			if ( ! o.isMesh ) return;
			o.frustumCulled = false;
			const src = o.material;
			const m = new THREE.MeshPhysicalNodeMaterial();
			m.fog = false;

			if ( o === eyes ) {

				// silver-blue iris, round black pupil (wider at night), dark limbal ring,
				// wet cornea: a small sharp highlight, no glow
				const E = this.eyeU;
				const dl = length( positionWorld.sub( E.L.c ) ), dr = length( positionWorld.sub( E.R.c ) );
				const c = select( dl.lessThan( dr ), E.L.c, E.R.c );
				const d = select( dl.lessThan( dr ), E.L.d, E.R.d );
				const rdir = normalize( positionWorld.sub( c ) );
				const ang = acos( clamp( dot( rdir, d ), - 1, 1 ) ); // radians from the gaze axis
				const pupilR = mix( float( 0.2 ), float( 0.42 ), U.night );
				const irisR = float( 0.78 );
				// radial iris fibres
				const side = normalize( vec3( d.z, 0, d.x.negate() ) );
				const az = atan( dot( rdir, vec3( 0, 1, 0 ) ), dot( rdir, side ) );
				const fib = sin( az.mul( 37.0 ) ).mul( 0.5 ).add( 0.5 ).mul( sin( az.mul( 13.0 ).add( 1.3 ) ).mul( 0.5 ).add( 0.5 ) );
				const r = ang.sub( pupilR ).div( irisR.sub( pupilR ) ).clamp( 0, 1 );
				const irisCol = mix( vec3( 0.5, 0.56, 0.6 ), vec3( 0.24, 0.3, 0.37 ), smoothstep( 0.1, 1.0, r ) )
					.mul( mix( 0.8, 1.15, fib ) )
					.mul( mix( 1.0, 0.25, smoothstep( 0.75, 1.0, r ) ) ); // limbal ring
				const sclera = vec3( 0.06, 0.055, 0.05 ); // a cat shows almost no white
				const pupil = smoothstep( pupilR.sub( 0.035 ), pupilR.add( 0.02 ), ang );
				const iris = float( 1 ).sub( smoothstep( irisR, irisR.add( 0.06 ), ang ) );
				m.colorNode = mix( sclera, mix( vec3( 0.004 ), irisCol, pupil ), iris );
				m.roughness = 0.35;
				m.clearcoat = 1.0;
				m.clearcoatRoughness = 0.04;
				m.specularIntensity = 0.5;

			} else if ( o === body ) {

				m.map = src.map; // melanistic coat (baked): near-black, rosettes faintly darker
				// fine fur strands (lifted from the deer's coat, luminance only), projected
				// triplanar in bind space so they stick to the body while it moves
				const pg = positionGeometry.mul( furScale );
				const wN = pow( abs( normalGeometry ), vec3( 4.0 ) );
				const wS = wN.div( wN.x.add( wN.y ).add( wN.z ).add( 1e-4 ) );
				const fx = texture( furTex, pg.zy ).r, fy = texture( furTex, pg.xz ).r, fz = texture( furTex, pg.xy ).r;
				const detail = fx.mul( wS.x ).add( fy.mul( wS.y ) ).add( fz.mul( wS.z ) );
				m.colorNode = texture( src.map, uv() ).rgb.mul( 0.32 ).add( 0.004 ).mul( mix( 0.75, 1.25, detail ) );
				// fur is matte: broad soft sheen, no wet highlights
				m.roughnessNode = mix( float( 0.95 ), float( 0.8 ), detail );
				m.normalNode = bumpMap( detail, float( 0.35 ) );
				m.metalness = 0.0;
				m.specularIntensity = 0.18;
				m.sheen = 0.25;
				m.sheenRoughness = 0.85;
				m.sheenColor = new THREE.Color( 0.06, 0.058, 0.056 );
				// soft fur halo when backlit (fine hairs on the silhouette catch the light)
				const V = normalize( cameraPosition.sub( positionWorld ) );
				const rim = pow( clamp( float( 1.0 ).sub( max( dot( normalWorld, V ), 0.0 ) ), 0.0, 1.0 ), 3.0 );
				const back = clamp( dot( V.negate(), U.sunDir ).mul( 0.5 ).add( 0.5 ), 0.0, 1.0 );
				m.emissiveNode = U.sunColor.mul( rim.mul( mix( 0.0, 0.08, back.mul( back ) ) ) );

			} else {

				// teeth / tongue
				m.color.copy( src.color );
				m.roughness = 0.5;

			}

			m.outputNode = vec4( applyFog( output.rgb, positionWorld ), output.a );
			o.material = m;

		} );

		// --- joints: rotation axes (side = +X, up = +Y, fwd = +Z in body space) in each bone's parent space
		model.updateMatrixWorld( true );
		const bodyInv = this.body.getWorldQuaternion( new THREE.Quaternion() ).invert();
		const axisIn = ( bone, a ) => {

			const pq = bone.parent.getWorldQuaternion( new THREE.Quaternion() ).premultiply( bodyInv );
			return a.clone().applyQuaternion( pq.invert() ).normalize();

		};

		const X = new THREE.Vector3( 1, 0, 0 ), Y = new THREE.Vector3( 0, 1, 0 ), Z = new THREE.Vector3( 0, 0, 1 );
		this.joints = {};
		const names = [ R.root, ...R.spine, ...R.neck, R.head, ...R.tail, R.ear.L, R.ear.R ];
		for ( const s of [ 'L', 'R' ] ) names.push( ...Object.values( LEG[ s ] ) );
		for ( const n of names ) {

			const b = bones[ n ];
			if ( ! b ) {

				console.warn( 'jaguar: missing bone', n );
				continue;

			}

			this.joints[ n ] = { bone: b, x: axisIn( b, X ), y: axisIn( b, Y ), z: axisIn( b, Z ), rest: b.quaternion.clone() };

		}

		const bp = ( n ) => bones[ n ].getWorldPosition( new THREE.Vector3() ).sub( this.body.getWorldPosition( new THREE.Vector3() ) );
		this.hindLen = bp( LEG.L.thigh ).y / SIZE;
		this.foreLen = bp( LEG.L.ua ).y / SIZE;
		this.hip = bp( R.root ); // pivot for sitting
		// neutral paw contact points (group frame: +z forward, +y up) for foot planting
		this.neutral = {};
		for ( const s of [ 'L', 'R' ] ) {

			this.neutral[ s + 'H' ] = bp( LEG[ s ].foot );
			this.neutral[ s + 'F' ] = bp( LEG[ s ].fing ).add( new THREE.Vector3( 0, 0, 0.03 * SIZE ) );

		}

		this._v = new THREE.Vector3();
		this._inv = new THREE.Matrix4();
		this._q = new THREE.Quaternion();
		this.ready = true;

	}

	// rotate a joint about side (x), up (y) and forward (z) axes (radians).
	// + about x moves a segment's distal end down (forward-pointing) / up (backward-pointing)
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
			const top = sprint ? SPEED.sprint : run ? SPEED.run : SPEED.walk;
			this.targetSpeed = top * ( input ? 1 : 0.85 ) * turnPenalty * ( 1 - smooth( 0.05, 0.6, seated ) );

		} else this.targetSpeed = 0;

		const accel = this.targetSpeed > this.speed ? ( sprint ? 9 : run ? 6.5 : 2.6 ) : 5.5;
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

		// 1D blend tree on speed: idle -> walk -> (trot) -> gallop
		const t = { idle: 0, walk: 0, trot: 0, gallop: 0 };
		const bands = [ [ 'idle', 0 ], [ 'walk', 0.8 ], [ 'walk', 2.2 ], [ 'trot', 3.0 ], [ 'trot', 4.2 ], [ 'gallop', 5.6 ] ];
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
		const m = 1 - W.idle;
		const seated = Math.max( this.sitW, this.lieW );

		// ---- base pose: the artist's idle clip while standing still, the bind pose otherwise
		for ( const n in this.joints ) this.joints[ n ].bone.quaternion.copy( this.joints[ n ].rest );
		const clipW = ( 1 - m ) * ( 1 - smooth( 0.0, 0.5, seated ) );
		this.idle.setEffectiveWeight( clipW );
		this.mixer.update( this.clipFrozen ? 0 : dt );

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
		for ( const l of legs ) ang[ l ] = { dz: 0, lift: 0, push: 0, fold: 0 };
		let bob = 0, sway = 0;

		for ( const g of GAIT_NAMES ) {

			const w = W[ g ];
			if ( w < 1e-3 ) continue;
			const G = GAITS[ g ];
			const beta = G.beta( v );
			const travel = v * beta / Math.max( f, 0.3 ); // paw travel during stance == body travel
			for ( let i = 0; i < 4; i ++ ) {

				const hind = i < 2;
				const p = ( P + G.off[ i ] ) % 1;
				const len = ( hind ? this.hindLen : this.foreLen ) * SIZE;
				// planted during stance (moves back exactly with the body), lifted arc forward in swing
				const half = Math.min( travel, len * 1.6 ) * 0.5;
				const shift = ( hind ? G.shiftH : G.shiftF ) * len;
				let dz, lift = 0, push = 0, fold = 0;
				if ( p < beta ) {

					const u = p / beta;
					dz = half * ( 1 - 2 * u );
					push = smooth( 0.6, 1.0, u );

				} else {

					const u = ( p - beta ) / ( 1 - beta );
					const e = u * u * ( 3 - 2 * u );
					dz = half * ( - 1 + 2 * e );
					lift = Math.sin( Math.PI * Math.pow( u, 0.8 ) ) * G.lift * len;
					fold = Math.sin( Math.PI * Math.min( 1, u * 1.25 ) );

				}

				const a = ang[ legs[ i ] ];
				a.dz += ( dz + shift ) * w; a.lift += lift * w; a.push += push * w; a.fold += fold * w;

			}

			if ( g === 'gallop' ) {

				// highest in the gathered suspension (before the hind legs land),
				// lowest through mid-stance of each pair
				bob += w * G.bob * ( 0.6 * Math.cos( TAU * ( P - 0.93 ) ) + 0.4 * Math.cos( 2 * TAU * ( P - 0.15 ) ) );

			} else bob += w * G.bob * Math.cos( 2 * TAU * ( P - 0.15 ) );

			sway += w * G.sway * Math.sin( TAU * P );

		}

		// gallop dynamics: spine flexion (+ = arched / gathered) peaks as the hind legs
		// land, extension as they push off and the fore legs reach; the trunk pitches
		// nose-up while vaulting over the hind legs and nose-down onto the fore legs
		const gal = W.gallop;
		const sprint = smooth( 8, 15, v );
		const flexAmp = gal * lerp( 0.13, 0.22, sprint ) + W.trot * 0.02;
		const flex = flexAmp * Math.cos( TAU * ( P - 0.02 ) );
		const pitchOsc = gal * lerp( 0.04, 0.07, sprint ) * Math.cos( TAU * ( P - 0.3 ) );

		// footfall events (dominant gait)
		const dom = GAIT_NAMES.reduce( ( a, b ) => ( W[ b ] > W[ a ] ? b : a ), 'walk' );
		for ( let i = 0; i < 4; i ++ ) {

			const p = ( P + GAITS[ dom ].off[ i ] ) % 1;
			if ( m > 0.3 && p < this._prevPhase[ i ] ) this.steps ++;
			this._prevPhase[ i ] = p;

		}

		// ---- spine: flexion wave, walk sway, bend into turns
		const turn = THREE.MathUtils.clamp( this.turnRate, - 1.5, 1.5 );
		const bend = turn * 0.06 * m;
		const [ s1, s2, s3, ch ] = R.spine;
		// arch: rear segments tip up (-), front segments tip down (+)
		this.rot( s1, - flex * 0.9, sway * m + bend );
		this.rot( s2, - flex * 0.3, - sway * 0.5 * m + bend );
		this.rot( s3, flex * 0.5, bend );
		this.rot( ch, flex * 0.7, bend );

		// ---- shoulder blades roll with the stride (the classic feline shoulder walk)
		for ( const s of [ 'L', 'R' ] ) this.rot( LEG[ s ].clav, m * ( - ( ang[ s + 'F' ].dz / ( this.foreLen * SIZE ) ) * 0.25 ) );

		// ---- rest behaviour: look-around on top of the clip, ears, tail
		this.restBehaviour( dt, m );

		// ---- head: level and looking ahead when moving (cancels trunk pitch and spine flexion)
		const lookYaw = this.look.yaw.v * ( 1 - m ), lookPitch = this.look.pitch.v * ( 1 - m );
		const turnLook = turn * 0.12 * m;
		const level = - ( - pitchOsc + flex * 0.4 ) - bob * 1.2 + gal * 0.06; // + = nose down
		const [ n0, n1, n2 ] = R.neck;
		this.rot( n0, m * level * 0.4 + lookPitch * 0.35, lookYaw * 0.35 + turnLook * 0.5 );
		this.rot( n1, m * level * 0.3 + lookPitch * 0.3, lookYaw * 0.35 + turnLook * 0.3 );
		this.rot( n2, lookPitch * 0.15, lookYaw * 0.15 );
		this.rot( R.head, m * level * 0.3 + lookPitch * 0.2, lookYaw * 0.15 + turnLook * 0.2, - lookYaw * 0.12 );

		// ---- tail: carried low with an upturned tip, lags the stride, streams out when running
		const rest = seated;
		const nT = R.tail.length;
		for ( let i = 0; i < nT; i ++ ) {

			const u = i / ( nT - 1 );
			const lag = u * 3.0;
			const swayT = Math.sin( TAU * P - lag ) * ( 0.025 + 0.03 * u ) * m * ( 1 - gal * 0.5 )
				+ Math.sin( this.time * 0.55 - u * 2.5 ) * 0.025 * ( 1 - m )
				+ this.tailFlick.s.v * u * 0.12;
			// running: tail raised toward horizontal as a rudder, bounces with the stride
			const lift = ( i === 0 ? 0.55 * gal + 0.15 * W.trot : 0 ) + Math.sin( TAU * P - lag ) * 0.035 * gal * u
				- ( i > 0 && i < 6 ? 0.05 * gal : 0 );
			// resting: tail lies on the ground curving around
			const sitOnly = this.sitW * ( 1 - this.lieW );
			const restCurl = rest * ( i === 0 ? 0.45 : ( i < 5 ? 0.06 : - 0.03 ) ) + sitOnly * ( i === 0 ? 0.55 : 0 );
			const restSide = rest * ( i >= 2 ? 0.1 : 0 );
			this.rot( R.tail[ i ], lift + restCurl, swayT - turn * 0.04 * m + restSide );

		}

		// ---- sit / lie poses (joint deltas + body drop/pitch)
		this.restPose();
		if ( this.debugRot ) for ( const n in this.debugRot ) this.rot( n, ...[].concat( this.debugRot[ n ] ) );

		// ---- body placement: terrain slope, bob, banking, pose drop
		const fwdX = - Math.sin( this.heading ), fwdZ = - Math.cos( this.heading );
		const half = 0.5 * SIZE;
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
		const bodyPitch = - this.pitch - sitPitch - pitchOsc;
		this.body.rotation.set( bodyPitch, 0, THREE.MathUtils.clamp( this.lean, - 0.25, 0.25 ) );
		// rotate about the hip pivot instead of the feet
		const hy = this.hip.y, hz = this.hip.z;
		const c = Math.cos( bodyPitch ), s = Math.sin( bodyPitch );
		const py = hy - ( hy * c - hz * s ), pz = hz - ( hy * s + hz * c );
		// moving cats carry themselves a little lower ("prowl"); galloping cats stretch out lower still
		this.body.position.set( 0, py + bob * SIZE * m - gal * 0.01 * SIZE - m * 0.015 * SIZE - drop, pz );

		// ---- legs: foot-planting IK (paws stay put on the terrain during stance)
		if ( m > 0.01 ) {

			this.group.updateMatrixWorld( true );
			this._inv.copy( this.group.matrixWorld ).invert();
			for ( const s of [ 'L', 'R' ] ) {

				const H = ang[ s + 'H' ], F = ang[ s + 'F' ], L = LEG[ s ];
				this.legIK( s + 'H', L.thigh, L.calf, L.hock, L.foot, H, true, 0.6, m );
				this.legIK( s + 'F', L.ua, L.fa, L.hand, L.fing, F, false, 1.2, m );
				// paws: toes curl in swing, push off at the end of stance
				this.rot( L.foot, m * ( H.fold * 0.4 - H.push * 0.2 ) );
				this.rot( L.fing, m * ( F.fold * 0.5 - F.push * 0.25 ) );

			}

		}

		// eyes (for the iris shader)
		this.model.updateMatrixWorld( true );
		for ( const s of [ 'L', 'R' ] ) {

			const E = this.eyeU[ s ], [ a, b ] = R.eye[ s ];
			E.c.value.copy( E.off ).applyMatrix4( this.bones[ a ].matrixWorld );
			const p0 = this.bones[ a ].getWorldPosition( this._v );
			E.d.value.copy( this.bones[ b ].getWorldPosition( new THREE.Vector3() ) ).sub( p0 ).normalize();

		}

	}

	// local (group-frame) position of a bone: x side, y up, z forward
	lp( name ) {

		return this.bones[ name ].getWorldPosition( new THREE.Vector3() ).applyMatrix4( this._inv );

	}

	/**
	 * Analytic 2-bone IK in the sagittal plane + an end segment aimed at the paw.
	 * upper/lower/end are joint bones, tip the paw contact. bendForward: knee
	 * (hind) bends forward, elbow (fore) backward. foldAmt: how far the end
	 * segment (metatarsus / carpus) folds back while the paw is in the air.
	 * Target blending happens in target space so the solve stays exact.
	 */
	legIK( leg, upper, lower, end, tip, a, bendForward, foldAmt, w ) {

		const N = this.neutral[ leg ];
		const A = this.lp( upper ), B = this.lp( lower ), C = this.lp( end ), D = this.lp( tip );
		// paw target on the ground (terrain under the paw, in group frame)
		const tz = N.z + a.dz;
		const wpos = this._v.set( N.x, 0, tz ).applyMatrix4( this.group.matrixWorld );
		const gy = terrainHeightJS( wpos.x, wpos.z ) - this.pos.y;
		const T = { z: lerp( D.z, tz, w ), y: lerp( D.y, Math.max( gy, - 0.5 ) + N.y + a.lift, w ) };
		// end segment (hock->paw / wrist->paw), folded back during swing
		const mz = D.z - C.z, my = D.y - C.y;
		const fa = a.fold * foldAmt * w;
		const cf = Math.cos( fa ), sf = Math.sin( fa );
		const Hz = T.z - ( mz * cf + my * sf ), Hy = T.y - ( my * cf - mz * sf );
		// 2-bone solve for the end joint
		const L1 = Math.hypot( B.z - A.z, B.y - A.y ), L2 = Math.hypot( C.z - B.z, C.y - B.y );
		const dx = Hz - A.z, dy = Hy - A.y;
		const d = Math.hypot( dx, dy );
		const dc = THREE.MathUtils.clamp( d, Math.abs( L1 - L2 ) * 1.05 + 1e-4, ( L1 + L2 ) * 0.995 );
		const phi = Math.atan2( dy, dx );
		const alpha = Math.acos( THREE.MathUtils.clamp( ( L1 * L1 + dc * dc - L2 * L2 ) / ( 2 * L1 * dc ), - 1, 1 ) );
		const th1 = bendForward ? phi + alpha : phi - alpha;
		const th1c = Math.atan2( B.y - A.y, B.z - A.z );
		const d1 = th1c - th1;
		this.rot( upper, d1 );
		const Bz = A.z + L1 * Math.cos( th1 ), By = A.y + L1 * Math.sin( th1 );
		const Hz2 = A.z + dc * Math.cos( phi ), Hy2 = A.y + dc * Math.sin( phi );
		const th2 = Math.atan2( Hy2 - By, Hz2 - Bz );
		const th2c = Math.atan2( C.y - B.y, C.z - B.z ) - d1;
		const d2 = th2c - th2;
		this.rot( lower, d2 );
		// aim the end segment at the paw target
		const th3 = Math.atan2( T.y - Hy2, T.z - Hz2 );
		const th3c = Math.atan2( D.y - C.y, D.z - C.z ) - d1 - d2;
		this.rot( end, th3c - th3 );
		if ( this.debugIK ) ( this._dbg ||= {} )[ leg ] = { T, H: { z: Hz2, y: Hy2 }, d, L1, L2, A, D };

	}

	restBehaviour( dt, m ) {

		const L = this.look, still = 1 - m;
		L.timer -= dt;
		if ( L.timer <= 0 ) {

			// pick a new point of interest; sometimes hold a gaze for a long time
			const r = Math.random();
			if ( r < 0.45 ) {

				L.tYaw = 0; L.tPitch = 0;

			} else {

				L.tYaw = ( Math.random() < 0.5 ? - 1 : 1 ) * ( 0.2 + Math.random() * 0.45 );
				L.tPitch = ( Math.random() - 0.6 ) * 0.2;

			}

			L.timer = r < 0.25 ? 9 + Math.random() * 9 : 3.5 + Math.random() * 5;

		}

		// slower, heavier motion when lying down
		const hl = lerp( 0.9, 1.4, this.lieW );
		L.yaw.step( L.tYaw * still, dt, hl );
		L.pitch.step( L.tPitch * still, dt, hl );

		// breathing (the clip breathes on its own while standing)
		const seated = Math.max( this.sitW, this.lieW );
		const br = Math.sin( this.time * TAU * 0.24 ) * 0.012 * still * seated;
		this.rot( R.spine[ 1 ], br );
		this.rot( R.spine[ 2 ], - br * 0.6 );

		// occasional ear flicks
		const E = this.ear;
		E.timer -= dt;
		if ( E.timer <= 0 ) {

			E.target = Math.random() < 0.5 ? 'L' : 'R';
			E.until = this.time + 0.18;
			E.timer = 2.5 + Math.random() * 6;

		}

		for ( const s of [ 'L', 'R' ] ) {

			const tgt = E.target === s && this.time < E.until ? 0.4 : 0;
			E[ s ].step( tgt, dt, 0.06 );

		}

		this.rot( R.ear.L, 0, E.L.v * still );
		this.rot( R.ear.R, 0, - E.R.v * still );

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

			const G = LEG[ s ];
			// hind legs folded under the hips, hocks and paws on the ground
			this.rot( G.thigh, mixp( 'thigh' ) );
			this.rot( G.calf, mixp( 'calf' ) );
			this.rot( G.hock, mixp( 'hock' ) );
			this.rot( G.foot, mixp( 'foot' ) );
			// front legs: vertical when sitting, forearms forward on the ground when lying
			this.rot( G.ua, mixp( 'ua' ) );
			this.rot( G.fa, mixp( 'fa' ) );
			this.rot( G.hand, mixp( 'hand' ) );

		}

		// keep the head level (+ = nose down): undo the sitting body pitch
		this.rot( R.neck[ 0 ], sit * 0.2 - lie * 0.25 );
		this.rot( R.neck[ 1 ], sit * 0.15 - lie * 0.1 );
		this.rot( R.head, sit * 0.1 + lie * 0.2 );

	}

}
