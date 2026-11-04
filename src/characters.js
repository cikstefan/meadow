// Third-person characters besides the jaguar (configs for ClipCharacter).
//
// Velociraptor: "PBR Velociraptor (Animated)" by ferociousindustries.matthias, CC-BY-4.0
//   https://sketchfab.com/3d-models/pbr-velociraptor-animated-8f1744af7b0847a2aabe3df90be802f0
//   its own 26 clips (walk / jog / sprint, idles, sniff, roars, bites, leaps,
//   tackle, sleep). Spec-gloss converted to metal-rough, WebP + meshopt.
// Human: "Low Poly Female" by Loves_Art, CC-BY-4.0
//   https://sketchfab.com/3d-models/low-poly-female-07eeb124d210402bbc061e543d0b97a1
//   animated with Mixamo motion clips (idle, walk, run, jump, crouch, kick,
//   punch, sleep) retargeted onto her rig at load.

import { ClipCharacter } from './character.js';

export const RAPTOR = {
	name: 'raptor',
	asset: () => import( './assets/raptor.glb?inline' ),
	scale: 1, // ~3.6 m nose to tail, like a large dromaeosaur
	back: 'Spine_1_03', front: 'Head_09', hip: 'Spine_1_03', feet: [ 'MiddleToe1R_067', 'MiddleToe1L_096' ], footLift: 0.1,
	idle: 'Idle_01', idleVariants: [ 'Idle_02', 'Sniff', 'Idle_02', 'Call_Alert' ],
	loco: [ { clip: 'Walk' }, { clip: 'Jog', at: 4.2 }, { clip: 'Sprint', at: 6.5 } ],
	speeds: { accel: 9 },
	rest: { after: 15, down: 'Go to Sleep', loop: 'Sleep_Loop', up: 'Wake From Sleep' },
	attack: [ 'Bite_01', 'Bite_02', 'Tackle' ],
	jump: [ 'Leap_01', 'Leap_02' ],
	roar: [ 'Roar_01', 'Roar_02', 'Roar_03' ],
	camHeight: 1.7, camDist: 9, radius: 1.5, bodyHeight: 1.2, halfLength: 1.0, predator: true, bank: 0.012,
	credit: '“PBR Velociraptor (Animated)” by ferociousindustries.matthias',
};

const M = ( n ) => 'mixamorig' + n;
const humanMap = [
	[ M( 'Hips' ), M( 'Hips' ) ], [ M( 'Spine' ), M( 'Spine' ) ], [ M( 'Spine1' ), M( 'Spine1' ) ], [ M( 'Spine2' ), M( 'Spine2' ) ],
	[ M( 'Neck' ), M( 'Neck' ) ], [ M( 'Head' ), M( 'Head' ) ],
];
for ( const s of [ 'Left', 'Right' ] ) {

	const chain = [ 'Shoulder', 'Arm', 'ForeArm', 'Hand' ];
	chain.forEach( ( b, i ) => humanMap.push( chain[ i + 1 ]
		? [ M( s + b ), M( s + b ), null, 0, M( s + chain[ i + 1 ] ), M( s + chain[ i + 1 ] ) ]
		: [ M( s + b ), M( s + b ) ] ) );
	const leg = [ 'UpLeg', 'Leg', 'Foot', 'ToeBase' ];
	leg.forEach( ( b, i ) => humanMap.push( leg[ i + 1 ]
		? [ M( s + b ), M( s + b ), null, 0, M( s + leg[ i + 1 ] ), M( s + leg[ i + 1 ] ) ]
		: [ M( s + b ), M( s + b ) ] ) );

}

export const HUMAN = {
	name: 'human',
	asset: () => import( './assets/human.glb?inline' ),
	anim: () => import( './assets/human_anim.glb?inline' ),
	retarget: {
		ref: 'Idle', map: humanMap, rootDst: M( 'Hips' ), rootSrc: M( 'Hips' ),
		legSrc: [ M( 'LeftUpLeg' ), M( 'LeftToeBase' ) ], legDst: [ M( 'LeftUpLeg' ), M( 'LeftToeBase' ) ],
		feetSrc: [ M( 'LeftToeBase' ), M( 'RightToeBase' ) ],
	},
	height: 1.7,
	back: M( 'Hips' ), front: null, hip: M( 'Hips' ), feet: [ M( 'LeftToeBase' ), M( 'RightToeBase' ) ],
	idle: 'Idle',
	loco: [ { clip: 'Walking' }, { clip: 'Running' } ],
	speeds: { accel: 7 },
	crouch: { idle: 'Crouch_Idle', walk: 'Crouched_W' },
	rest: { after: 20, loop: 'Sleeping_Idle', fade: 2.2 },
	attack: [ 'Kick_1', 'Boxing_1' ],
	jump: [ 'Jump' ],
	camHeight: 1.45, camDist: 4.5, radius: 0.5, bodyHeight: 1.0, halfLength: 0.2, biped: true, predator: false, bank: 0.006,
	credit: '“Low Poly Female” by Loves_Art',
};

export const makeRaptor = () => new ClipCharacter( RAPTOR );
export const makeHuman = () => new ClipCharacter( HUMAN );
