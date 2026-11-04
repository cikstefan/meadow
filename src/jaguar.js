// Black jaguar: the Ear.Rodriguez jaguar model (repainted melanistic) animated
// with motion-captured-style clips from a CC-BY tiger, retargeted onto its rig.
//
// Model: "jaguar" by Ear.Rodriguez (Sketchfab), CC-BY-4.0
//   https://sketchfab.com/3d-models/jaguar-91c61c329d2a4668816f81f08dfcd492
//   converted FBX -> glTF (meshopt + WebP); coat repainted melanistic (the
//   rosettes stay faintly visible in the black fur), eyes shaded procedurally
//   (silver-blue iris, round black pupil).
// Motion: "Tiger" by planeta-elefante (Sketchfab), CC-BY-4.0
//   https://sketchfab.com/3d-models/tiger-5566ab23dc004b3b96f3c15c7276e681
//   Walk, Run (bounding gallop), lie down / get up, sleep and attack clips are
//   baked onto the jaguar's Advanced Skeleton rig at load (see retarget.js).
//
// Controller (structure after False Earth's): speed -> blend weights over the
// idle / walk / run clips, which share one stride phase. Each clip plays at
// the rate that makes its paws travel exactly as fast as the body moves (no
// foot sliding). Rest: after 10 s it lies down, after 25 s it puts its head
// down to sleep; moving wakes it and it gets up first. F: attack.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
	vec3, vec4, output, positionWorld, positionGeometry, normalWorld, cameraPosition, normalize, dot, pow, clamp,
	float, max, mix, smoothstep, texture, uv, abs, normalGeometry, bumpMap, uniform, select, length, atan, sin, acos
} from 'three/tsl';
import { U, applyFog, terrainHeightJS } from './tsl/world.js';
import { retargetClips, stanceSpeed } from './retarget.js';

const TAU = Math.PI * 2;
const lerp = THREE.MathUtils.lerp;
const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const smooth = ( a, b, x ) => {

	const t = clamp01( ( x - a ) / ( b - a ) );
	return t * t * ( 3 - 2 * t );

};

const angleDiff = ( a, b ) => Math.atan2( Math.sin( b - a ), Math.cos( b - a ) );

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

async function parseGLB( dataUrl ) {

	const bin = atob( dataUrl.slice( dataUrl.indexOf( ',' ) + 1 ) );
	const bytes = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) bytes[ i ] = bin.charCodeAt( i );
	const loader = new GLTFLoader();
	loader.setMeshoptDecoder( MeshoptDecoder );
	return loader.parseAsync( bytes.buffer, '' );

}

// model is in centimetres at life size; 1.8x a real jaguar
const SCALE = 0.018;
const SIZE = 2.16; // legacy length unit (~ metres for this size)

const R = {
	root: 'Root_M',
	head: 'Head_M',
	neck: [ 'Neck_M', 'Neck1_M', 'Neck2_M' ],
	tail: [ 'Tail0_M', 'Tail7_M', 'Tail8_M', 'Tail9_M', 'Tail10_M', 'Tail11_M', 'Tail12_M', 'Tail13_M', 'Tail14_M', 'Tail15_M' ],
	ear: { L: 'Ear1_L', R: 'Ear4_R' },
	eye: { L: [ 'Eye_L', 'EyeEnd_L' ], R: [ 'Eye_R', 'EyeEnd_R' ] },
};

// tiger bone -> jaguar bone (parent first). [ target, srcA, srcB?, k? ]
const T = {
	s1: 'spine1_loResSpine1', s2: 'spine1_loResSpine2', s3: 'spine1_loResSpine3', neck: 'head1_neck', head: 'head1_head',
	t: [ 'tail1_Joint1', 'tail1_Joint2', 'tail1_Joint3', 'tail1_Joint4' ],
};
const MAP = [
	[ 'Root_M', T.s1 ],
	[ 'Spine1_M', T.s1, T.s2, 0.5 ], [ 'Spine2_M', T.s2 ], [ 'Spine3_M', T.s2, T.s3, 0.5 ], [ 'Chest_M', T.s3 ],
	[ 'Neck_M', T.s3, T.neck, 0.5 ], [ 'Neck1_M', T.neck ], [ 'Neck2_M', T.neck, T.head, 0.5 ], [ 'Head_M', T.head ],
	[ 'Jaw_M', 'JAw' ],
];
for ( const [ s, ts ] of [ [ 'L', 'left' ], [ 'R', 'right' ] ] ) {

	// hind: hip, knee, hock, paw
	MAP.push( [ `Hip_${ s }`, `${ ts }Leg2_LoResUpperLeg` ], [ `Knee_${ s }`, `${ ts }Leg2_LoResLowerLeg` ],
		[ `Ankle_${ s }`, `${ ts }Leg2_LoResFoot` ], [ `Toes1_${ s }`, `${ ts }Leg2_LoResToe` ] );
	// fore: the tiger's upper segment is the shoulder blade
	MAP.push( [ `Scapula_${ s }`, `${ ts }Leg1_LoResUpperLeg` ], [ `Shoulder_${ s }`, `${ ts }Leg1_LoResLowerLeg` ],
		[ `Elbow_${ s }`, `${ ts }Leg1_LoResFoot` ], [ `Wrist_${ s }`, `${ ts }Leg1_LoResToe` ] );

}

R.tail.forEach( ( n, i ) => {

	const u = i / ( R.tail.length - 1 ) * ( T.t.length - 1 );
	const a = Math.floor( u ), b = Math.min( a + 1, T.t.length - 1 );
	MAP.push( u - a < 1e-3 || a === b ? [ n, T.t[ a ] ] : [ n, T.t[ a ], T.t[ b ], u - a ] );

} );

const SPEED = { walk: 1.5, run: 8.0, sprint: 11.5 };

export class Jaguar {

	constructor() {

		this.group = new THREE.Group(); // world placement (yaw)
		this.body = new THREE.Group(); // slope pitch / roll
		this.group.add( this.body );
		this.ready = false;

		this.pos = new THREE.Vector3();
		this.heading = 0; // 0 = facing -Z (camera yaw convention)
		this.speed = 0;
		this.targetSpeed = 0;
		this.turnRate = 0;
		this.phase = 0;
		this.steps = 0;
		this.weights = { idle: 1, walk: 0, run: 0 };
		this.lean = 0;
		this.pitch = 0;

		// rest behaviour: 'stand' | 'down' | 'lying' | 'toSleep' | 'sleeping' | 'wake' | 'up'
		this.state = 'stand';
		this.restTime = 0;
		this.restW = 0;
		this.sitW = 0;
		this.lieW = 0;
		this.attackT = - 1;
		this.ear = { L: new Spring(), R: new Spring(), timer: 3 };
		this.tailFlick = { s: new Spring(), timer: 4 };
		this.time = 0;

		this.wander = { target: new THREE.Vector3(), timer: 0, run: false, pause: 0 };

	}

	async load() {

		const [ { default: jagUrl }, { default: tigUrl }, { default: furUrl } ] = await Promise.all( [
			import( './assets/jaguar.glb?inline' ), import( './assets/tiger_anim.glb?inline' ), import( './assets/fur_detail.jpg?inline' ) ] );
		const [ gltf, tiger ] = await Promise.all( [ parseGLB( jagUrl ), parseGLB( tigUrl ) ] );
		const model = gltf.scene;
		this.model = model;

		const furTex = await new THREE.TextureLoader().loadAsync( furUrl );
		furTex.wrapS = furTex.wrapT = THREE.RepeatWrapping;
		furTex.colorSpace = THREE.NoColorSpace;
		furTex.anisotropy = 4;

		// bones: the FBX rig nests pivot helpers with the same name; the first
		// (outermost) node of each name carries the chain
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

		// --- retarget the tiger's clips onto this rig
		const src = tiger.scene;
		src.updateMatrixWorld( true );
		const srcClip = ( n ) => tiger.animations.find( ( a ) => a.name.replace( /\s+/g, ' ' ).trim() === n );
		const sp = ( root, n ) => root.getObjectByName( n ).getWorldPosition( new THREE.Vector3() );
		// leg length ratio (hip joint height above the paw), reference = tiger Idle
		const mixer0 = new THREE.AnimationMixer( src );
		mixer0.clipAction( srcClip( 'Idle' ) ).play();
		mixer0.setTime( 0 );
		src.updateMatrixWorld( true );
		const srcLeg = sp( src, 'leftLeg2_LoResUpperLeg' ).y - sp( src, 'leftLeg2_LoResToe' ).y;
		mixer0.stopAllAction();
		const bodyInv = new THREE.Matrix4().copy( this.body.matrixWorld ).invert();
		const dstLeg = wpos( 'Hip_L' ).applyMatrix4( bodyInv ).y - wpos( 'Toes1_L' ).applyMatrix4( bodyInv ).y;
		const posScale = dstLeg / srcLeg;
		const names = [ 'Walk', 'Run', 'Start Rest', 'End Rest', 'Go To Sleep', 'Sleep', 'End Sleep', 'Attack', 'Attack Paw' ];
		const baked = retargetClips( {
			srcRoot: src, clips: names.map( srcClip ), refClip: srcClip( 'Idle' ),
			dstFrame: this.body, dstBones: bones, map: MAP, rootDst: 'Root_M', rootSrc: T.s1, posScale,
		} );
		const clip = Object.fromEntries( baked.map( ( c ) => [ c.name, c ] ) );
		// body speed at which each locomotion clip's paws don't slide (m/s at timeScale 1)
		this.clipSpeed = {
			walk: stanceSpeed( src, srcClip( 'Walk' ), [ 'leftLeg2_LoResToe', 'rightLeg2_LoResToe', 'leftLeg1_LoResToe', 'rightLeg1_LoResToe' ] ) * posScale,
			run: stanceSpeed( src, srcClip( 'Run' ), [ 'leftLeg2_LoResToe', 'rightLeg2_LoResToe', 'leftLeg1_LoResToe', 'rightLeg1_LoResToe' ] ) * posScale,
		};

		// --- actions
		this.mixer = new THREE.AnimationMixer( model );
		const act = ( c, once ) => {

			const a = this.mixer.clipAction( c );
			if ( once ) {

				a.setLoop( THREE.LoopOnce, 1 ); a.clampWhenFinished = true;

			}

			a.play(); a.setEffectiveWeight( 0 );
			return a;

		};

		this.A = {
			idle: act( gltf.animations[ 0 ] ), // the artist's own idle (looks around, sniffs, paws)
			walk: act( clip[ 'Walk' ] ), run: act( clip[ 'Run' ] ),
			down: act( clip[ 'Start Rest' ], true ), up: act( clip[ 'End Rest' ], true ),
			toSleep: act( clip[ 'Go To Sleep' ], true ), sleep: act( clip[ 'Sleep' ] ), wake: act( clip[ 'End Sleep' ], true ),
			attack: act( clip[ 'Attack' ], true ), paw: act( clip[ 'Attack Paw' ], true ),
		};
		this.A.walk.timeScale = 0; this.A.run.timeScale = 0; // driven by the stride phase
		this.restW_ = { down: 0, up: 0, toSleep: 0, sleep: 0, wake: 0 };
		this.A.idle.setEffectiveWeight( 1 );

		// joints touched procedurally on top of the clips (ears, tail flick, head into turns)
		this.rest = {};
		for ( const n of [ ...R.neck, R.head, ...R.tail, R.ear.L, R.ear.R ] ) if ( bones[ n ] ) this.rest[ n ] = bones[ n ];
		const bodyQ = this.body.getWorldQuaternion( new THREE.Quaternion() ).invert();
		this.axes = {};
		this.restQ = {};
		for ( const n in this.rest ) this.restQ[ n ] = this.rest[ n ].quaternion.clone();
		for ( const n in this.rest ) {

			const pq = bones[ n ].parent.getWorldQuaternion( new THREE.Quaternion() ).premultiply( bodyQ ).invert();
			this.axes[ n ] = { x: new THREE.Vector3( 1, 0, 0 ).applyQuaternion( pq ), y: new THREE.Vector3( 0, 1, 0 ).applyQuaternion( pq ) };

		}

		this.hip = wpos( R.root ).applyMatrix4( bodyInv ); // pitch pivot
		// paw contact heights in the rest pose (foot-contact IK keeps them above the terrain)
		this.legs = [];
		for ( const sd of [ 'L', 'R' ] ) {

			this.legs.push( { c: [ `Hip_${ sd }`, `Knee_${ sd }`, `Ankle_${ sd }`, `Toes1_${ sd }`, `Toes2_${ sd }` ], h: wpos( `Toes1_${ sd }` ).applyMatrix4( bodyInv ).y, h2: wpos( `Toes2_${ sd }` ).applyMatrix4( bodyInv ).y } );
			this.legs.push( { c: [ `Shoulder_${ sd }`, `Elbow_${ sd }`, `Wrist_${ sd }`, `Fingers1_${ sd }`, `Fingers2_${ sd }` ], h: wpos( `Fingers1_${ sd }` ).applyMatrix4( bodyInv ).y, h2: Math.min( 0.02, wpos( `Fingers2_${ sd }` ).applyMatrix4( bodyInv ).y ) } );

		}

		this._inv = new THREE.Matrix4();
		this._v = new THREE.Vector3();
		this._q = new THREE.Quaternion();
		this.ready = true;

	}

	// small additive rotation about body-space side (x) / up (y) axes, after the clips
	rot( name, ax, ay = 0 ) {

		const b = this.rest[ name ], A = this.axes[ name ];
		if ( ! b ) return;
		if ( ax ) b.quaternion.premultiply( this._q.setFromAxisAngle( A.x, ax ) );
		if ( ay ) b.quaternion.premultiply( this._q.setFromAxisAngle( A.y, ay ) );

	}

	place( x, z, heading ) {

		this.pos.set( x, terrainHeightJS( x, z ), z );
		this.heading = heading;

	}

	attack() {

		if ( ! this.ready || this.attackT >= 0 || this.state !== 'stand' ) return;
		this.attackClip = this.speed < 2 && Math.random() < 0.5 ? this.A.paw : this.A.attack;
		this.attackClip.reset().play();
		this.attackT = 0;

	}

	// ------------------------------------------------------------------ control

	/**
	 * @param input null (wander on its own) or { x, y, run, sprint, attack } with (x,y)
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
				w.pause = Math.random() < 0.55 ? 6 + Math.random() * 40 : 0;

			}

			const dx = w.target.x - this.pos.x, dz = w.target.z - this.pos.z;
			if ( w.pause > 0 ) w.pause -= dt;
			else if ( dx * dx + dz * dz > 4 ) {

				desired = Math.atan2( - dx, - dz );
				run = w.run;

			}

		}

		// rest state machine (lie down after 10 s, sleep after 25 s; get up before moving)
		const A = this.A, done = ( a ) => ! a.isRunning() || a.time >= a.getClip().duration - 1e-3;
		if ( desired === null && this.speed < 0.05 && this.attackT < 0 ) this.restTime += dt;
		else this.restTime = 0;
		const S = this.state;
		const go = ( s, a ) => {

			this.state = s;
			if ( a ) a.reset().play();

		};

		if ( S === 'stand' && this.restTime > 10 ) go( 'down', A.down );
		else if ( S === 'down' && done( A.down ) ) go( 'lying' );
		else if ( S === 'lying' && desired !== null ) go( 'up', A.up );
		else if ( S === 'lying' && this.restTime > 25 ) go( 'toSleep', A.toSleep );
		else if ( S === 'toSleep' && done( A.toSleep ) ) go( 'sleeping' );
		else if ( ( S === 'sleeping' || S === 'toSleep' ) && desired !== null ) go( 'wake', A.wake );
		else if ( S === 'wake' && done( A.wake ) ) go( 'up', A.up );
		else if ( S === 'down' && desired !== null && A.down.time < 0.3 ) go( 'stand' );
		else if ( S === 'up' && done( A.up ) ) go( 'stand' );

		const canMove = this.state === 'stand' && this.attackT < 0.6;
		const prevHeading = this.heading;
		if ( desired !== null && canMove ) {

			const d = angleDiff( this.heading, desired );
			const rate = lerp( 2.6, 1.2, smooth( 3, 11, this.speed ) );
			this.heading += Math.sign( d ) * Math.min( Math.abs( d ), rate * dt );
			const turnPenalty = lerp( 1, 0.35, smooth( 0.6, 2.2, Math.abs( d ) ) );
			const top = sprint ? SPEED.sprint : run ? SPEED.run : SPEED.walk;
			this.targetSpeed = top * ( input ? 1 : 0.85 ) * turnPenalty;

		} else this.targetSpeed = 0;

		const accel = this.targetSpeed > this.speed ? ( sprint ? 8 : run ? 6 : 2.4 ) : 6;
		this.speed += Math.sign( this.targetSpeed - this.speed ) * Math.min( Math.abs( this.targetSpeed - this.speed ), accel * dt );
		this.turnRate = lerp( this.turnRate, angleDiff( prevHeading, this.heading ) / Math.max( dt, 1e-3 ), 1 - Math.exp( - dt * 6 ) );

		this.pos.x += - Math.sin( this.heading ) * this.speed * dt;
		this.pos.z += - Math.cos( this.heading ) * this.speed * dt;

		if ( input && input.attack ) this.attack();
		this.animate( dt );

	}

	// ------------------------------------------------------------------ animation

	blendWeights( v ) {

		const walk = smooth( 0.05, 0.7, v ) * ( 1 - smooth( 2.4, 4.8, v ) );
		const run = smooth( 2.4, 4.8, v );
		return { idle: 1 - smooth( 0.05, 0.7, v ), walk, run };

	}

	animate( dt ) {

		const v = this.speed, A = this.A;
		const k = 1 - Math.exp( - dt * 6 );
		const tw = this.blendWeights( v );
		for ( const g in this.weights ) this.weights[ g ] = lerp( this.weights[ g ], tw[ g ], k );
		const W = this.weights;
		const m = 1 - W.idle;

		// ---- stride phase: clips advance so their paws travel with the ground
		const sW = this.clipSpeed.walk, sR = this.clipSpeed.run;
		const dW = A.walk.getClip().duration, dR = A.run.getClip().duration;
		const wl = W.walk + W.run;
		const freq = wl > 1e-3
			? ( W.walk * v / ( sW * dW ) + W.run * v / ( sR * dR ) ) / wl
			: 1 / dW;
		const prevP = this.phase;
		this.phase = ( this.phase + dt * Math.max( freq, 0.1 ) ) % 1;
		// align the left-hind footfall of both cycles
		A.walk.time = ( ( this.phase + 0.0 ) % 1 ) * dW;
		A.run.time = ( ( this.phase + 0.0 ) % 1 ) * dR;
		if ( m > 0.3 && Math.floor( this.phase * 4 ) !== Math.floor( prevP * 4 ) ) this.steps ++;

		// ---- rest layer weights (one transition clip active at a time, crossfaded)
		const st = this.state;
		const tgt = {
			down: st === 'down' || st === 'lying' ? 1 : 0, toSleep: st === 'toSleep' ? 1 : 0, sleep: st === 'sleeping' ? 1 : 0,
			wake: st === 'wake' ? 1 : 0, up: st === 'up' ? 1 : 0,
		};
		const kr = 1 - Math.exp( - dt * 10 );
		let rest = 0;
		for ( const n in tgt ) {

			this.restW_[ n ] = lerp( this.restW_[ n ], tgt[ n ], kr );
			rest += this.restW_[ n ];

		}

		rest = Math.min( 1, rest );
		this.restW = rest;
		this.lieW = st === 'stand' ? 0 : 1;

		// ---- attack overlay
		let atk = 0;
		if ( this.attackT >= 0 ) {

			this.attackT += dt;
			const d = this.attackClip.getClip().duration;
			atk = smooth( 0, 0.12, this.attackT ) * ( 1 - smooth( d - 0.2, d, this.attackT ) );
			if ( this.attackT >= d ) {

				this.attackT = - 1; atk = 0;

			}

		}

		const base = ( 1 - rest ) * ( 1 - atk );
		A.idle.setEffectiveWeight( W.idle * base );
		A.walk.setEffectiveWeight( W.walk * base );
		A.run.setEffectiveWeight( W.run * base );
		for ( const n in this.restW_ ) A[ n ].setEffectiveWeight( this.restW_[ n ] * ( 1 - atk ) );
		A.attack.setEffectiveWeight( this.attackClip === A.attack ? atk : 0 );
		A.paw.setEffectiveWeight( this.attackClip === A.paw ? atk : 0 );

		// rest pose of procedurally touched joints, then the clips
		for ( const n in this.rest ) this.rest[ n ].quaternion.copy( this.restQ[ n ] );
		this.mixer.update( this.clipFrozen ? 0 : dt );

		// ---- small procedural layer: look into turns, ear and tail flicks
		const turn = THREE.MathUtils.clamp( this.turnRate, - 1.5, 1.5 );
		this.rot( R.neck[ 0 ], 0, turn * 0.06 * m );
		this.rot( R.head, 0, turn * 0.05 * m );
		this.flicks( dt, 1 - m );
		const nT = R.tail.length;
		for ( let i = 0; i < nT; i ++ ) {

			const u = i / ( nT - 1 );
			this.rot( R.tail[ i ], 0, this.tailFlick.s.v * u * 0.12 - turn * 0.03 * m );

		}

		// ---- body placement: terrain slope, banking
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
		const bodyPitch = - this.pitch;
		this.body.rotation.set( bodyPitch, 0, THREE.MathUtils.clamp( this.lean, - 0.2, 0.2 ) );
		const hy = this.hip.y, hz = this.hip.z;
		const c = Math.cos( bodyPitch ), s = Math.sin( bodyPitch );
		this.body.position.set( 0, hy - ( hy * c - hz * s ), hz - ( hy * s + hz * c ) );

		// foot contact: lift any paw the clip pushes below the terrain
		this.group.updateMatrixWorld( true );
		this._inv.copy( this.group.matrixWorld ).invert();
		for ( const L of this.legs ) this.footIK( L );

		// eyes (for the iris shader)
		this.model.updateMatrixWorld( true );
		for ( const sd of [ 'L', 'R' ] ) {

			const E = this.eyeU[ sd ], [ a, b ] = R.eye[ sd ];
			E.c.value.copy( E.off ).applyMatrix4( this.bones[ a ].matrixWorld );
			const p0 = this.bones[ a ].getWorldPosition( this._v );
			E.d.value.copy( this.bones[ b ].getWorldPosition( new THREE.Vector3() ) ).sub( p0 ).normalize();

		}

	}

	// group-frame position (x side, y up, z forward)
	lp( n ) {

		return this.bones[ n ].getWorldPosition( new THREE.Vector3() ).applyMatrix4( this._inv );

	}

	// rotate a bone about the body's side axis (expressed in its parent's current frame)
	rotSide( n, a ) {

		const b = this.bones[ n ];
		const ax = new THREE.Vector3( 1, 0, 0 ).transformDirection( this.group.matrixWorld );
		const pq = b.parent.getWorldQuaternion( new THREE.Quaternion() ).invert();
		b.quaternion.premultiply( this._q.setFromAxisAngle( ax.applyQuaternion( pq ).normalize(), a ) );

	}

	/** 2-bone IK in the sagittal plane: raise the paw to the ground, keep the paw segment's angle */
	footIK( L ) {

		const [ u, l, e, t, t2 ] = L.c;
		const D = this.lp( t ), D2 = this.lp( t2 );
		const w = this._v.set( D.x, 0, D.z ).applyMatrix4( this.group.matrixWorld );
		const g = terrainHeightJS( w.x, w.z ) - this.pos.y;
		const lift = Math.max( g + L.h - D.y, g + L.h2 - D2.y );
		if ( lift <= 0 ) return;
		const want = D.y + lift;
		const A = this.lp( u ), B = this.lp( l ), C = this.lp( e );
		const Hz = C.z, Hy = C.y + ( want - D.y ); // move the end joint straight up
		const L1 = Math.hypot( B.z - A.z, B.y - A.y ), L2 = Math.hypot( C.z - B.z, C.y - B.y );
		const dx = Hz - A.z, dy = Hy - A.y;
		const dc = THREE.MathUtils.clamp( Math.hypot( dx, dy ), Math.abs( L1 - L2 ) * 1.05 + 1e-4, ( L1 + L2 ) * 0.999 );
		const phi = Math.atan2( dy, dx );
		const alpha = Math.acos( THREE.MathUtils.clamp( ( L1 * L1 + dc * dc - L2 * L2 ) / ( 2 * L1 * dc ), - 1, 1 ) );
		// keep the current bend direction: pick the solution nearest the current middle joint
		const ta = phi + alpha, tb = phi - alpha;
		const ea = Math.hypot( A.z + L1 * Math.cos( ta ) - B.z, A.y + L1 * Math.sin( ta ) - B.y );
		const eb = Math.hypot( A.z + L1 * Math.cos( tb ) - B.z, A.y + L1 * Math.sin( tb ) - B.y );
		const th1 = ea < eb ? ta : tb;
		const d1 = Math.atan2( B.y - A.y, B.z - A.z ) - th1;
		this.rotSide( u, d1 );
		const Bz = A.z + L1 * Math.cos( th1 ), By = A.y + L1 * Math.sin( th1 );
		const Hz2 = A.z + dc * Math.cos( phi ), Hy2 = A.y + dc * Math.sin( phi );
		const d2 = ( Math.atan2( C.y - B.y, C.z - B.z ) - d1 ) - Math.atan2( Hy2 - By, Hz2 - Bz );
		this.rotSide( l, d2 );
		// paw segment keeps its original body-frame angle
		this.rotSide( e, - ( d1 + d2 ) );

	}

	flicks( dt, still ) {

		const E = this.ear;
		E.timer -= dt;
		if ( E.timer <= 0 ) {

			E.target = Math.random() < 0.5 ? 'L' : 'R';
			E.until = this.time + 0.18;
			E.timer = 2.5 + Math.random() * 6;

		}

		for ( const s of [ 'L', 'R' ] ) E[ s ].step( E.target === s && this.time < E.until ? 0.4 : 0, dt, 0.06 );
		this.rot( R.ear.L, 0, E.L.v * still );
		this.rot( R.ear.R, 0, - E.R.v * still );

		const T = this.tailFlick;
		T.timer -= dt;
		if ( T.timer <= 0 ) {

			T.until = this.time + 0.9;
			T.dir = Math.random() < 0.5 ? - 1 : 1;
			T.timer = 5 + Math.random() * 9;

		}

		T.s.step( this.time < T.until ? T.dir * still : 0, dt, 0.35 );

	}

}
