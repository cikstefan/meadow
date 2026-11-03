// Red deer herd.
//
// Model: "Deer (Demo Free Download)" by All For $19.99 (Sketchfab), CC-BY-4.0
//   https://sketchfab.com/3d-models/deer-demo-free-download-034f40010b1341e5bc352fd97c5254d6
//   converted from spec-gloss to metal-rough, WebP + meshopt (10 MB -> 0.88 MB).
//
// Layers, bottom to top:
//   1. the artist's 22.5 s idle clip (ears, blinks, weight shifts; loops cleanly),
//      faded toward a neutral stance while moving
//   2. procedural gaits on the 80-bone rig: walk (lateral sequence), trot
//      (diagonal pairs), gallop (4-beat, spread footfalls), speed-blended, with
//      no-slip stride amplitude, spine flex and a stabilised head
//   3. behaviour poses: grazing (head down into the grass, chewing), alert
//      (head high, ears forward, looking at the threat)
// Behaviour: graze / look around / wander with the herd; alert when the jaguar
// or the player comes close; flee in a gallop when they come closer (sooner
// when the jaguar is running); calm down again afterwards.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
	vec4, output, positionWorld, normalWorld, cameraPosition, normalize, dot, pow, clamp, float, max, mix
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

const LENGTH = 5.0; // nose-to-rump length in metres (~2.5x a real red deer, like the jaguar)
const CAD = 0.62; // big animals step slowly

// legs: LH, RH, LF, RF
const GAITS = {
	walk: { beta: 0.62, freq: ( v ) => ( 0.95 + 0.12 * v ) * CAD, off: [ 0.0, 0.5, 0.25, 0.75 ], lift: 0.85, bob: 0.008, sway: 0.03, flex: 0.0 },
	trot: { beta: 0.45, freq: ( v ) => ( 1.5 + 0.06 * v ) * CAD, off: [ 0.0, 0.5, 0.5, 0.0 ], lift: 1.0, bob: 0.016, sway: 0.0, flex: 0.03 },
	gallop: { beta: 0.32, freq: ( v ) => ( 2.1 + 0.025 * v ) * CAD, off: [ 0.0, 0.15, 0.55, 0.7 ], lift: 1.1, bob: 0.045, sway: 0.0, flex: 0.16 },
};
const GAIT_NAMES = [ 'walk', 'trot', 'gallop' ];
const SPEED = { graze: 0.7, walk: 2.4, trot: 6.0, flee: 17.0 };

export async function loadDeerAsset() {

	const { default: dataUrl } = await import( './assets/deer.glb?inline' );
	const bin = atob( dataUrl.slice( dataUrl.indexOf( ',' ) + 1 ) );
	const bytes = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) bytes[ i ] = bin.charCodeAt( i );
	const loader = new GLTFLoader();
	loader.setMeshoptDecoder( MeshoptDecoder );
	const gltf = await loader.parseAsync( bytes.buffer, '' );

	// shared materials: soft fur with a warm sheen, glossier antlers; fogged like the scene
	const cache = new Map();
	gltf.scene.traverse( ( o ) => {

		if ( ! o.isMesh ) return;
		const src = o.material;
		let m = cache.get( src );
		if ( ! m ) {

			const antler = /antler/i.test( src.name );
			m = new THREE.MeshPhysicalNodeMaterial();
			m.map = src.map;
			m.normalMap = src.normalMap;
			if ( m.normalMap ) m.normalScale = new THREE.Vector2( 0.8, 0.8 );
			m.color.copy( src.color );
			m.side = src.side;
			m.roughness = antler ? 0.55 : 0.85;
			m.metalness = 0;
			m.specularIntensity = antler ? 0.4 : 0.22;
			if ( ! antler ) {

				m.sheen = 0.8;
				m.sheenRoughness = 0.5;
				m.sheenColor = new THREE.Color( 0.42, 0.3, 0.2 );
				const V = normalize( cameraPosition.sub( positionWorld ) );
				const rim = pow( clamp( float( 1.0 ).sub( max( dot( normalWorld, V ), 0.0 ) ), 0.0, 1.0 ), 2.8 );
				const back = clamp( dot( V.negate(), U.sunDir ).mul( 0.5 ).add( 0.5 ), 0.0, 1.0 );
				m.emissiveNode = U.sunColor.mul( rim.mul( mix( 0.02, 0.3, back ) ) ).mul( vec4( 1.0, 0.85, 0.65, 1 ).xyz );

			}

			m.outputNode = vec4( applyFog( output.rgb, positionWorld ), output.a );
			m.fog = false;
			cache.set( src, m );

		}

		o.material = m;
		o.frustumCulled = false;

	} );

	gltf.scene.updateMatrixWorld( true );
	const box = new THREE.Box3().setFromObject( gltf.scene, true );
	const size = box.getSize( new THREE.Vector3() );
	return { gltf, nativeLength: size.x };

}

export class Deer {

	constructor( asset, { scale = 1, seed = 0 } = {} ) {

		this.group = new THREE.Group();
		this.body = new THREE.Group();
		this.group.add( this.body );
		const model = cloneSkinned( asset.gltf.scene );
		const s = LENGTH / asset.nativeLength * scale;
		model.scale.multiplyScalar( s );
		this.size = LENGTH * scale;
		this.body.add( model );
		this.model = model;
		this.seed = seed;

		// idle clip
		this.mixer = new THREE.AnimationMixer( model );
		const clip = asset.gltf.animations[ 0 ];
		this.mixer.clipAction( clip ).play();
		this.mixer.setTime( 0 );

		const bones = {};
		model.traverse( ( o ) => {

			if ( o.isBone ) bones[ o.name.replace( /_\d+$/, '' ) ] = o;

		} );
		this.bones = bones;
		model.updateMatrixWorld( true );

		// axes: deer faces +X, up +Y; side = up x fwd = -Z (keeps the jaguar's sign convention:
		// + rotation tips a forward segment nose-down / swings a leg's distal end backward)
		const modelInv = model.getWorldQuaternion( new THREE.Quaternion() ).invert();
		const axisIn = ( bone, a ) => {

			const pq = bone.parent.getWorldQuaternion( new THREE.Quaternion() ).premultiply( modelInv );
			return a.clone().applyQuaternion( pq.invert() ).normalize();

		};

		const SIDE = new THREE.Vector3( 0, 0, - 1 ), UP = new THREE.Vector3( 0, 1, 0 ), FWD = new THREE.Vector3( 1, 0, 0 );
		const names = [ 'Pelvis', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Neck3', 'Head', 'Jaw', 'EarL1', 'EarR1', 'Tail1', 'Tail2', 'Tail3', 'Tail4' ];
		for ( const s2 of [ 'L', 'R' ] ) {

			names.push( `LegF${ s2 }Collarbone`, `LegF${ s2 }1`, `LegF${ s2 }2`, `LegF${ s2 }3`, `LegF${ s2 }Ankle` );
			names.push( `LegB${ s2 }1`, `LegB${ s2 }2`, `LegB${ s2 }3`, `LegB${ s2 }Ankle` );

		}

		this.joints = {};
		for ( const n of names ) {

			const b = bones[ n ];
			if ( ! b ) continue;
			this.joints[ n ] = { bone: b, x: axisIn( b, SIDE ), y: axisIn( b, UP ), z: axisIn( b, FWD ), neutral: b.quaternion.clone() };

		}

		const wp = ( n ) => bones[ n ].getWorldPosition( new THREE.Vector3() );
		const groundY = wp( 'LegFLAnkle' ).y;
		this.foreLen = wp( 'LegFL1' ).y - groundY;
		this.hindLen = wp( 'LegBL1' ).y - groundY;

		// different start times / speeds so herd members don't move in sync
		this.mixer.setTime( ( seed * 7.3 ) % clip.duration );
		this.mixer.timeScale = 0.9 + ( seed % 3 ) * 0.07;

		this._q = new THREE.Quaternion();
		this.pos = new THREE.Vector3();
		this.heading = 0;
		this.speed = 0;
		this.targetSpeed = 0;
		this.turnRate = 0;
		this.phase = Math.random();
		this.weights = { idle: 1, walk: 0, trot: 0, gallop: 0 };
		this.pitch = 0;
		this.lean = 0;
		this.time = seed * 3;

		this.state = 'graze';
		this.stateTime = 0;
		this.stateDur = 6 + Math.random() * 10;
		this.target = new THREE.Vector3();
		this.grazeW = new Spring( 1 );
		this.alertW = new Spring( 0 );
		this.lookYaw = new Spring( 0 );
		this.chew = 0;
		this.threatDir = 0;
		this.calm = 0;

	}

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

	/**
	 * @param ctx { home: Vector3 (herd centre), threats: [{ pos, speed, isPredator }] }
	 */
	update( dt, ctx ) {

		this.time += dt;
		this.stateTime += dt;

		// nearest threat
		let threat = null, td = Infinity;
		for ( const t of ctx.threats ) {

			const d = Math.hypot( t.pos.x - this.pos.x, t.pos.z - this.pos.z );
			const eff = d / ( t.isPredator ? ( t.speed > 5 ? 1.8 : 1.15 ) : 1 ); // a running jaguar is scarier
			if ( eff < td ) {

				td = eff; threat = t;

			}

		}

		const S = this.size / 5;
		const alertR = 48 * S, fleeR = 24 * S;
		if ( threat ) this.threatDir = Math.atan2( - ( threat.pos.x - this.pos.x ), - ( threat.pos.z - this.pos.z ) );

		// --- behaviour state machine
		const go = ( st, dur ) => {

			this.state = st; this.stateTime = 0; this.stateDur = dur;

		};

		if ( td < fleeR && this.state !== 'flee' ) go( 'flee', 5 + Math.random() * 3 );
		else if ( td < alertR && ( this.state === 'graze' || this.state === 'idle' || this.state === 'walk' ) ) go( 'alert', 3 + Math.random() * 4 );

		let desired = null, speed = 0;
		switch ( this.state ) {

			case 'flee': {

				desired = this.threatDir + Math.PI + Math.sin( this.time * 0.7 + this.seed ) * 0.35;
				speed = SPEED.flee;
				if ( this.stateTime > this.stateDur && td > alertR * 1.3 ) go( 'alert', 4 );
				break;

			}

			case 'alert': {

				if ( this.stateTime > this.stateDur && td > alertR ) go( 'idle', 3 + Math.random() * 4 );
				break;

			}

			case 'walk': {

				const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
				if ( dx * dx + dz * dz < 4 * S * S || this.stateTime > 30 ) go( 'graze', 10 + Math.random() * 20 );
				else {

					desired = Math.atan2( - dx, - dz );
					speed = SPEED.walk;

				}

				break;

			}

			case 'graze': {

				// slowly drift forward while grazing now and then
				if ( Math.sin( this.time * 0.21 + this.seed * 5 ) > 0.55 ) {

					desired = this.heading + Math.sin( this.time * 0.13 ) * 0.3;
					speed = SPEED.graze;

				}

				if ( this.stateTime > this.stateDur ) go( 'idle', 3 + Math.random() * 6 );
				break;

			}

			default: { // idle: stand, look around, then move somewhere else or graze again

				if ( this.stateTime > this.stateDur ) {

					if ( Math.random() < 0.55 ) {

						const a = Math.random() * TAU, r = ( 8 + Math.random() * 30 ) * S;
						this.target.set( ctx.home.x + Math.cos( a ) * r, 0, ctx.home.z + Math.sin( a ) * r );
						go( 'walk', 30 );

					} else go( 'graze', 10 + Math.random() * 20 );

				}

			}

		}

		// --- steering + speed
		const prevHeading = this.heading;
		if ( desired !== null ) {

			const d = angleDiff( this.heading, desired );
			const rate = lerp( 1.6, 1.0, smooth( 3, 14, this.speed ) );
			this.heading += Math.sign( d ) * Math.min( Math.abs( d ), rate * dt );
			this.targetSpeed = speed * lerp( 1, 0.4, smooth( 0.6, 2.2, Math.abs( d ) ) );

		} else this.targetSpeed = 0;

		const accel = this.targetSpeed > this.speed ? ( this.state === 'flee' ? 9 : 1.6 ) : 3.5;
		this.speed += Math.sign( this.targetSpeed - this.speed ) * Math.min( Math.abs( this.targetSpeed - this.speed ), accel * dt );
		this.turnRate = lerp( this.turnRate, angleDiff( prevHeading, this.heading ) / Math.max( dt, 1e-3 ), 1 - Math.exp( - dt * 6 ) );
		this.pos.x += - Math.sin( this.heading ) * this.speed * dt;
		this.pos.z += - Math.cos( this.heading ) * this.speed * dt;

		// --- pose weights
		this.grazeW.step( this.state === 'graze' && this.speed < 1.2 ? 1 : 0, dt, 0.7 );
		this.alertW.step( this.state === 'alert' ? 1 : 0, dt, 0.25 );
		const lookTarget = this.state === 'alert' ? THREE.MathUtils.clamp( angleDiff( this.heading, this.threatDir ), - 1.1, 1.1 ) : 0;
		this.lookYaw.step( lookTarget, dt, 0.35 );

		this.animate( dt );

	}

	blendWeights( v ) {

		const t = { idle: 0, walk: 0, trot: 0, gallop: 0 };
		const bands = [ [ 'idle', 0 ], [ 'walk', 0.8 ], [ 'walk', 3.2 ], [ 'trot', 5.0 ], [ 'trot', 7.0 ], [ 'gallop', 10 ] ];
		if ( v <= 0.05 ) {

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
		const tw = this.blendWeights( v );
		const k = 1 - Math.exp( - dt * 5 );
		for ( const g in this.weights ) this.weights[ g ] = lerp( this.weights[ g ], tw[ g ], k );
		const W = this.weights, m = 1 - W.idle;

		// 1) artist idle clip, faded toward the neutral stance while moving
		this.mixer.update( dt );
		for ( const n in this.joints ) {

			const j = this.joints[ n ];
			if ( m > 1e-3 ) j.bone.quaternion.slerp( j.neutral, m );

		}

		// 2) gaits
		let f = 0, wsum = 0;
		for ( const g of GAIT_NAMES ) {

			f += W[ g ] * GAITS[ g ].freq( Math.max( v, 0.6 ) );
			wsum += W[ g ];

		}

		f = wsum > 1e-3 ? f / wsum : GAITS.walk.freq( 1 );
		this.phase = ( this.phase + dt * f ) % 1;
		const P = this.phase;
		const sc = this.model.scale.x;
		const legs = [ 'LH', 'RH', 'LF', 'RF' ];
		const ang = {};
		for ( const l of legs ) ang[ l ] = { swing: 0, lift: 0, push: 0 };
		let bob = 0, flex = 0, sway = 0;
		for ( const g of GAIT_NAMES ) {

			const w = W[ g ];
			if ( w < 1e-3 ) continue;
			const G = GAITS[ g ];
			const travel = v * G.beta / Math.max( f, 0.3 );
			for ( let i = 0; i < 4; i ++ ) {

				const p = ( P + G.off[ i ] ) % 1;
				const len = ( i < 2 ? this.hindLen : this.foreLen ) * sc;
				const A = Math.asin( Math.min( 0.6, travel / ( 2 * len ) ) );
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

			bob += w * G.bob * ( g === 'gallop' ? Math.sin( TAU * P ) : Math.sin( TAU * P * 2 ) );
			flex += w * G.flex * Math.sin( TAU * ( P - 0.15 ) );
			sway += w * G.sway * Math.sin( TAU * P );

		}

		for ( const s of [ 'L', 'R' ] ) {

			const H = ang[ s + 'H' ], F = ang[ s + 'F' ];
			this.rot( `LegB${ s }1`, m * ( - H.swing - H.lift * 0.2 ) );
			this.rot( `LegB${ s }2`, m * ( - H.lift * 0.55 ) );
			this.rot( `LegB${ s }3`, m * ( H.lift * 0.95 + H.push * 0.2 ) );
			this.rot( `LegB${ s }Ankle`, m * ( H.lift * 0.6 + H.swing * 0.3 ) );
			this.rot( `LegF${ s }Collarbone`, m * ( - F.swing * 0.3 ) );
			this.rot( `LegF${ s }1`, m * ( - F.swing * 0.75 - F.lift * 0.1 ) );
			this.rot( `LegF${ s }2`, m * ( F.lift * 0.25 ) );
			this.rot( `LegF${ s }3`, m * ( F.lift * 1.35 + F.swing * 0.3 ) );
			this.rot( `LegF${ s }Ankle`, m * ( F.lift * 0.7 + F.swing * 0.3 + F.push * 0.25 ) );

		}

		const turn = THREE.MathUtils.clamp( this.turnRate, - 1.5, 1.5 );
		this.rot( 'Spine1', m * flex * 0.6, sway * m + turn * 0.05 * m );
		this.rot( 'Spine2', m * - flex * 0.4, turn * 0.05 * m );
		this.rot( 'Chest', m * - flex * 0.5, - sway * 0.5 * m );

		// 3) behaviour poses on neck / head / ears
		const gz = this.grazeW.v, al = this.alertW.v;
		this.chew += dt * ( 2.6 + Math.sin( this.time * 0.3 ) * 0.4 );
		const headStab = - flex * 0.7 - bob * 1.5;
		this.rot( 'Neck1', gz * 0.75 - al * 0.25 + headStab * 0.4 * m, this.lookYaw.v * 0.4 + turn * 0.08 * m );
		this.rot( 'Neck2', gz * 0.45 - al * 0.15 + headStab * 0.3 * m, this.lookYaw.v * 0.35 );
		this.rot( 'Neck3', gz * 0.25 - al * 0.05, this.lookYaw.v * 0.15 );
		this.rot( 'Head', gz * 0.3 + al * 0.1 + headStab * 0.3 * m, this.lookYaw.v * 0.1 );
		this.rot( 'Jaw', gz * ( Math.sin( this.chew * TAU ) * 0.5 + 0.5 ) * 0.12 );
		this.rot( 'EarL1', - al * 0.35, 0 );
		this.rot( 'EarR1', - al * 0.35, 0 );
		// tail: flicks up when alarmed or fleeing (white rump flash)
		const flag = Math.max( al * 0.6, this.state === 'flee' ? 1 : 0 );
		this.rot( 'Tail1', - flag * 0.9 + Math.sin( this.time * 3 + this.seed ) * 0.05 * ( 1 - flag ) );

		// placement: terrain slope, bob, bank
		const fwdX = - Math.sin( this.heading ), fwdZ = - Math.cos( this.heading );
		const half = this.size * 0.3;
		const hF = terrainHeightJS( this.pos.x + fwdX * half, this.pos.z + fwdZ * half );
		const hB = terrainHeightJS( this.pos.x - fwdX * half, this.pos.z - fwdZ * half );
		this.pos.y = lerp( this.pos.y, ( hF + hB ) * 0.5, 1 - Math.exp( - dt * 12 ) );
		this.pitch = lerp( this.pitch, Math.atan2( hF - hB, 2 * half ), 1 - Math.exp( - dt * 8 ) );
		this.lean = lerp( this.lean, - turn * this.speed * 0.01, 1 - Math.exp( - dt * 4 ) );

		this.group.position.copy( this.pos );
		this.group.rotation.set( 0, this.heading + Math.PI / 2, 0 ); // model faces +X
		this.body.rotation.set( 0, 0, 0 );
		this.body.rotation.z = this.pitch; // around the deer's side axis (model X forward -> pitch about Z)
		this.body.rotation.x = THREE.MathUtils.clamp( this.lean, - 0.2, 0.2 );
		this.body.position.y = bob * this.size * m * 0.5;

	}

}

export class DeerHerd {

	constructor() {

		this.group = new THREE.Group();
		this.deer = [];
		this.home = new THREE.Vector3();
		this.ready = false;

	}

	async load( spawn, count = 3 ) {

		const asset = await loadDeerAsset();
		for ( let i = 0; i < count; i ++ ) {

			const d = new Deer( asset, { scale: i === 0 ? 1 : 0.86 - i * 0.04, seed: i + 1 } );
			const a = i * 2.1, r = i === 0 ? 0 : 9 + i * 4;
			d.place( spawn.x + Math.cos( a ) * r, spawn.z + Math.sin( a ) * r, Math.random() * TAU );
			this.group.add( d.group );
			this.deer.push( d );

		}

		this.home.copy( spawn );
		this.ready = true;

	}

	update( dt, threats, focus ) {

		if ( ! this.ready ) return;
		// herd centre follows its members; if the viewer wanders far away, the herd
		// quietly relocates ahead of them (out of view) so it stays part of the scene
		const c = new THREE.Vector3();
		for ( const d of this.deer ) c.add( d.pos );
		c.multiplyScalar( 1 / this.deer.length );
		this.home.lerp( c, 1 - Math.exp( - dt * 0.05 ) );
		if ( focus && Math.hypot( focus.x - c.x, focus.z - c.z ) > 260 ) {

			const a = Math.random() * TAU;
			const nx = focus.x + Math.cos( a ) * 120, nz = focus.z + Math.sin( a ) * 120;
			for ( const d of this.deer ) d.place( nx + ( d.pos.x - c.x ), nz + ( d.pos.z - c.z ), d.heading );
			this.home.set( nx, 0, nz );

		}

		for ( const d of this.deer ) d.update( dt, { home: this.home, threats } );

	}

}
