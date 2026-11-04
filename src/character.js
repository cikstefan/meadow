// Generic clip-driven third-person character (used for the velociraptor and the
// human). Same controller structure as the jaguar (False Earth style):
//   speed -> blend weights over in-place locomotion clips that share one stride
//   phase; each clip plays at the rate that makes its planted feet move exactly
//   with the ground (stance speed measured from the clip) -> no foot sliding.
// One-shot actions (attack, jump / leap, idle variations) overlay the base
// layer; clips with forward root motion (a leap, a tackle) have it stripped from
// the skeleton and turned into real movement of the character. Standing still
// for a while leads to a rest (lie down / sleep) loop, with optional
// transition clips.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { vec4, output, positionWorld } from 'three/tsl';
import { applyFog, terrainHeightJS } from './tsl/world.js';
import { retargetClips, stanceSpeed } from './retarget.js';

const TAU = Math.PI * 2;
const lerp = THREE.MathUtils.lerp;
const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const smooth = ( a, b, x ) => {

	const t = clamp01( ( x - a ) / ( b - a ) );
	return t * t * ( 3 - 2 * t );

};

const angleDiff = ( a, b ) => Math.atan2( Math.sin( b - a ), Math.cos( b - a ) );
const pick = ( a ) => a[ Math.floor( Math.random() * a.length ) ];

export async function parseGLB( dataUrl ) {

	const bin = atob( dataUrl.slice( dataUrl.indexOf( ',' ) + 1 ) );
	const bytes = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) bytes[ i ] = bin.charCodeAt( i );
	const loader = new GLTFLoader();
	loader.setMeshoptDecoder( MeshoptDecoder );
	return loader.parseAsync( bytes.buffer, '' );

}

export class ClipCharacter {

	/**
	 * cfg: { name, asset(), anim()? + retarget?, height | scale, back, front, hip, feet[],
	 *        idle, idleVariants[], loco: [ { clip, crouch? } ], speeds: { walk, run },
	 *        rest: { after, down?, loop, up?, fade }, attack[], jump[], crouch: { idle, walk }?,
	 *        camHeight, camDist, radius, bodyHeight, predator, material(m, mesh)? }
	 */
	constructor( cfg ) {

		this.cfg = cfg;
		this.name = cfg.name;
		this.group = new THREE.Group();
		this.body = new THREE.Group();
		this.group.add( this.body );
		this.group.visible = false;
		this.ready = false;
		this.pos = new THREE.Vector3();
		this.heading = 0;
		this.speed = 0;
		this.targetSpeed = 0;
		this.turnRate = 0;
		this.phase = 0;
		this.steps = 0;
		this.weights = {};
		this.state = 'stand';
		this.restTime = 0;
		this.restW = 0;
		this.lieW = 0;
		this.sitW = 0;
		this.crouch = false;
		this.shot = null; // active one-shot { a, t, dur, move, lock }
		this.idleTimer = 6;
		this.time = 0;
		this.pitch = 0;
		this.lean = 0;
		this.vy = 0; // jump: extra height from root-motion-free leaps is in the clip

	}

	async load() {

		const cfg = this.cfg;
		const { default: url } = await cfg.asset();
		const gltf = await parseGLB( url );
		const model = gltf.scene;
		this.model = model;
		this.body.add( model );

		const nodes = {};
		model.traverse( ( o ) => {

			if ( o.name && ! nodes[ o.name ] ) nodes[ o.name ] = o;
			const base = o.name.replace( /_\d+$/, '' );
			if ( o.name && ! nodes[ base ] ) nodes[ base ] = o;

		} );
		this.nodes = nodes;
		const wpos = ( n ) => nodes[ n ].getWorldPosition( new THREE.Vector3() );

		// orient (front bone ahead of back bone = +Z), scale, feet on the ground, centred
		model.updateMatrixWorld( true );
		if ( cfg.front ) { // otherwise the model already faces +Z

			const f = wpos( cfg.front ).sub( wpos( cfg.back ) );
			model.rotation.y = - Math.atan2( f.x, f.z );

		}
		model.updateMatrixWorld( true );
		if ( cfg.height ) {

			const box = new THREE.Box3().setFromObject( model, true );
			model.scale.multiplyScalar( cfg.height / ( box.max.y - box.min.y ) );

		} else if ( cfg.scale ) model.scale.multiplyScalar( cfg.scale );

		model.updateMatrixWorld( true );
		const hip = wpos( cfg.hip );
		const floor = Math.min( ...cfg.feet.map( ( n ) => wpos( n ).y ) ) - ( cfg.footLift || 0 );
		model.position.x -= hip.x; model.position.z -= hip.z; model.position.y -= floor;
		model.updateMatrixWorld( true );

		model.traverse( ( o ) => {

			if ( ! o.isMesh ) return;
			o.frustumCulled = false;
			o.castShadow = false;
			const src = o.material;
			const m = new THREE.MeshStandardNodeMaterial();
			m.color.copy( src.color );
			for ( const k of [ 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap' ] ) if ( src[ k ] ) m[ k ] = src[ k ];
			m.roughness = src.roughness ?? 0.8;
			m.metalness = src.metalness ?? 0;
			if ( src.normalScale ) m.normalScale = src.normalScale;
			m.emissive.copy( src.emissive || new THREE.Color( 0 ) );
			m.side = src.side;
			m.transparent = src.transparent;
			m.alphaTest = src.alphaTest;
			m.fog = false;
			if ( cfg.material ) cfg.material( m, o );
			m.outputNode = vec4( applyFog( output.rgb, positionWorld ), output.a );
			o.material = m;

		} );

		// --- clips: native, or retargeted from another skeleton
		let clips = gltf.animations;
		let srcRoot = model, measureFeet = cfg.feet, measureScale = 1;
		if ( cfg.anim ) {

			const { default: aurl } = await cfg.anim();
			const anim = await parseGLB( aurl );
			const src = anim.scene;
			src.updateMatrixWorld( true );
			const R = cfg.retarget;
			const sw = ( n ) => src.getObjectByName( n ).getWorldPosition( new THREE.Vector3() );
			const ref = anim.animations.find( ( a ) => a.name === R.ref );
			// leg-length ratio in the reference pose
			const mx = new THREE.AnimationMixer( src );
			mx.clipAction( ref ).play(); mx.setTime( 0 ); src.updateMatrixWorld( true );
			const srcLeg = sw( R.legSrc[ 0 ] ).y - sw( R.legSrc[ 1 ] ).y;
			mx.stopAllAction();
			const bodyInv = new THREE.Matrix4().copy( this.body.matrixWorld ).invert();
			const dstLeg = wpos( R.legDst[ 0 ] ).applyMatrix4( bodyInv ).y - wpos( R.legDst[ 1 ] ).applyMatrix4( bodyInv ).y;
			const posScale = dstLeg / srcLeg;
			clips = retargetClips( {
				srcRoot: src, clips: anim.animations, refClip: ref, dstFrame: this.body, dstBones: nodes,
				map: R.map, rootDst: R.rootDst, rootSrc: R.rootSrc, posScale,
			} );
			srcRoot = src; measureFeet = R.feetSrc; measureScale = posScale;
			this._src = { src, anim };

		}

		const byName = Object.fromEntries( clips.map( ( c ) => [ c.name, c ] ) );
		const srcByName = this._src ? Object.fromEntries( this._src.anim.animations.map( ( c ) => [ c.name, c ] ) ) : byName;
		this.byName = byName;

		// measured ground speed (m/s at timeScale 1) of each locomotion clip
		const worldScale = this._src ? measureScale : model.scale.x * ( cfg.nativeScale || 1 );
		this.loco = cfg.loco.map( ( L ) => {

			const v = stanceSpeed( srcRoot, srcByName[ L.clip ], measureFeet, 120, 0.06 ) * worldScale;
			// speed: stride-matched ground speed at timeScale 1; at: speed where this clip is fully weighted
			return { ...L, speed: v, at: L.at ?? v, dur: byName[ L.clip ].duration };

		} );

		cfg.speeds = { ...cfg.speeds, walk: cfg.speeds.walk ?? this.loco[ 0 ].at, run: cfg.speeds.run ?? this.loco[ this.loco.length - 1 ].at };

		// strip forward root motion of one-shot clips and remember it as movement
		this.rootMove = {};
		const hipNode = this._src ? nodes[ cfg.retarget.rootDst ] : nodes[ cfg.hip ];
		const chain = new Map(); // hip and its ancestors: name / uuid -> node
		for ( let o = hipNode; o && o !== this.body; o = o.parent ) {

			chain.set( o.name, o ); chain.set( o.uuid, o );

		}

		const bodyInv = new THREE.Matrix4().copy( this.body.matrixWorld ).invert();
		for ( const n of [ ...( cfg.jump || [] ), ...( cfg.attack || [] ), ...( cfg.roar || [] ) ] ) {

			const c = byName[ n ];
			if ( ! c ) continue;
			// the root-motion track: the position track on the hip chain that drifts forward most
			let best = null;
			for ( const tr of c.tracks ) {

				const [ id, prop ] = tr.name.split( '.' );
				const node = chain.get( id );
				if ( prop !== 'position' || ! node ) continue;
				const v = tr.values, k = v.length / 3;
				const d = new THREE.Vector3( v[ k * 3 - 3 ] - v[ 0 ], v[ k * 3 - 2 ] - v[ 1 ], v[ k * 3 - 1 ] - v[ 2 ] );
				const m3 = new THREE.Matrix3().setFromMatrix4( bodyInv.clone().multiply( node.parent.matrixWorld ) );
				const dBody = d.clone().applyMatrix3( m3 );
				if ( ! best || dBody.z > best.dBody.z ) best = { tr, d, dBody, m3 };

			}

			if ( ! best || best.dBody.z < 0.3 ) continue;
			const { tr, d, m3 } = best;
			const v = tr.values, k = v.length / 3;
			// body-up expressed in the track's local space
			const up = new THREE.Vector3( 0, 1, 0 ).applyMatrix3( m3.clone().invert() ).normalize();
			for ( let i = 0; i < k; i ++ ) {

				const u = ( tr.times[ i ] - tr.times[ 0 ] ) / Math.max( 1e-4, tr.times[ k - 1 ] - tr.times[ 0 ] );
				// remove the horizontal part of the drift (keep the vertical arc)
				const dl = d.clone().multiplyScalar( u );
				dl.addScaledVector( up, - dl.dot( up ) );
				v[ i * 3 ] -= dl.x; v[ i * 3 + 1 ] -= dl.y; v[ i * 3 + 2 ] -= dl.z;

			}

			this.rootMove[ n ] = best.dBody.z / c.duration;

		}

		// --- actions
		this.mixer = new THREE.AnimationMixer( model );
		this.A = {};
		const act = ( n, once ) => {

			if ( this.A[ n ] || ! byName[ n ] ) return this.A[ n ];
			const a = this.mixer.clipAction( byName[ n ] );
			if ( once ) {

				a.setLoop( THREE.LoopOnce, 1 ); a.clampWhenFinished = true;

			}

			a.play(); a.setEffectiveWeight( 0 );
			this.A[ n ] = a;
			return a;

		};

		act( cfg.idle );
		for ( const L of this.loco ) {

			act( L.clip ).timeScale = 0;
			this.weights[ L.clip ] = 0;

		}

		if ( cfg.crouch ) {

			act( cfg.crouch.idle );
			act( cfg.crouch.walk ).timeScale = 0;
			const cv = stanceSpeed( srcRoot, srcByName[ cfg.crouch.walk ], measureFeet, 120, 0.06 ) * worldScale;
			this.crouchLoco = { clip: cfg.crouch.walk, speed: cv, dur: byName[ cfg.crouch.walk ].duration };

		}

		this.weights.idle = 1;
		for ( const n of [ ...( cfg.idleVariants || [] ), ...( cfg.attack || [] ), ...( cfg.jump || [] ), ...( cfg.roar || [] ) ] ) act( n, true );
		const R = cfg.rest;
		if ( R ) {

			if ( R.down ) act( R.down, true );
			act( R.loop );
			if ( R.up ) act( R.up, true );

		}

		this.restW_ = {};
		this.ready = true;

	}

	place( x, z, heading ) {

		this.pos.set( x, terrainHeightJS( x, z ), z );
		this.heading = heading;

	}

	// one-shot overlay clip; returns false if busy
	play( list, opts = {} ) {

		if ( ! this.ready || ( this.shot && ! opts.force ) || this.state !== 'stand' ) return false;
		const n = pick( list.filter( ( x ) => this.A[ x ] ) );
		if ( ! n ) return false;
		const a = this.A[ n ];
		a.reset().play();
		this.shot = { a, n, t: 0, dur: a.getClip().duration, move: this.rootMove[ n ] || 0, lock: opts.lock ?? true, idle: !! opts.idle, carry: opts.carry ?? false, fadeIn: opts.fadeIn ?? 0.12 };
		if ( ! opts.idle ) this.restTime = 0;
		return true;

	}

	attack() {

		if ( this.cfg.attack ) this.play( this.cfg.attack, { lock: true } );

	}

	jump() {

		if ( this.cfg.jump ) this.play( this.cfg.jump, { lock: false, carry: true, fadeIn: 0.08 } );

	}

	roar() {

		if ( this.cfg.roar ) this.play( this.cfg.roar, { lock: true } );

	}

	update( dt, input ) {

		if ( ! this.ready ) return;
		this.time += dt;
		const cfg = this.cfg;
		let desired = null, run = false;
		if ( input ) {

			if ( input.x * input.x + input.y * input.y > 0.01 ) desired = Math.atan2( - input.x, - input.y );
			run = input.run;
			if ( input.sprint && ! this._space ) this.jump();
			this._space = input.sprint;
			if ( input.crouch !== undefined ) this.crouch = !! input.crouch && !! cfg.crouch;

		}

		// rest: lie down / sleep after standing still for a while; get up to move
		const Rr = cfg.rest, A = this.A;
		const done = ( a ) => ! a || ! a.isRunning() || a.time >= a.getClip().duration - 1e-3;
		if ( desired === null && this.speed < 0.05 && ! ( this.shot && ! this.shot.idle ) ) this.restTime += dt;
		else this.restTime = 0;
		if ( Rr ) {

			const S = this.state;
			const go = ( s, n ) => {

				this.state = s; this.stateT = 0;
				if ( n && A[ n ] ) A[ n ].reset().play();

			};

			this.stateT = ( this.stateT || 0 ) + dt;
			if ( S === 'stand' && this.restTime > Rr.after && ! ( this.shot && ! this.shot.idle ) ) {

				this.shot = null;
				go( 'down', Rr.down );

			}
			else if ( S === 'down' && ( Rr.down ? done( A[ Rr.down ] ) : this.stateT > ( Rr.fade || 1.5 ) ) ) go( 'resting' );
			else if ( ( S === 'resting' || S === 'down' ) && desired !== null ) go( 'up', Rr.up );
			else if ( S === 'up' && ( Rr.up ? done( A[ Rr.up ] ) : this.stateT > ( Rr.fade || 1.5 ) * 0.7 ) ) go( 'stand' );

		}

		const shot = this.shot;
		const canMove = this.state === 'stand' && ! ( shot && shot.lock );
		const prevHeading = this.heading;
		const sp = cfg.speeds;
		if ( desired !== null && canMove ) {

			const d = angleDiff( this.heading, desired );
			const rate = lerp( 3.0, 1.4, smooth( 2, sp.run, this.speed ) ) * ( shot ? 0.3 : 1 );
			this.heading += Math.sign( d ) * Math.min( Math.abs( d ), rate * dt );
			const turnPenalty = lerp( 1, 0.4, smooth( 0.6, 2.2, Math.abs( d ) ) );
			const top = this.crouch ? this.crouchLoco.speed : run ? sp.run : sp.walk;
			this.targetSpeed = top * turnPenalty;

		} else if ( shot && shot.carry ) this.targetSpeed = this.speed; // keep momentum through a jump
		else this.targetSpeed = 0;

		const accel = this.targetSpeed > this.speed ? ( run ? sp.accel || 6 : 2.5 ) : 7;
		this.speed += Math.sign( this.targetSpeed - this.speed ) * Math.min( Math.abs( this.targetSpeed - this.speed ), accel * dt );
		this.turnRate = lerp( this.turnRate, angleDiff( prevHeading, this.heading ) / Math.max( dt, 1e-3 ), 1 - Math.exp( - dt * 6 ) );

		// root motion of one-shots (leap / tackle) moves the character
		let v = this.speed;
		if ( shot && shot.move ) v = Math.max( v, shot.move * smooth( 0.05, 0.25, shot.t / shot.dur ) * ( 1 - smooth( 0.8, 1.0, shot.t / shot.dur ) ) );
		this.pos.x += - Math.sin( this.heading ) * v * dt;
		this.pos.z += - Math.cos( this.heading ) * v * dt;

		// occasional idle variation
		if ( this.state === 'stand' && this.speed < 0.05 && ! this.shot && cfg.idleVariants ) {

			this.idleTimer -= dt;
			if ( this.idleTimer <= 0 ) {

				this.play( cfg.idleVariants, { lock: false, idle: true, fadeIn: 0.4 } );
				this.idleTimer = 7 + Math.random() * 10;

			}

		}

		if ( input && input.attack ) this.attack();
		this.animate( dt );

	}

	animate( dt ) {

		const cfg = this.cfg, A = this.A, v = this.speed;
		// --- locomotion weights: piecewise between the clips' own speeds
		const loco = this.crouch && this.crouchLoco ? [ this.crouchLoco ] : this.loco;
		const tw = { idle: 0 };
		for ( const L of this.loco ) tw[ L.clip ] = 0;
		if ( this.crouchLoco ) tw[ this.crouchLoco.clip ] = 0;
		const at = ( L ) => L.at ?? L.speed;
		const start = Math.min( 0.6, at( loco[ 0 ] ) * 0.5 );
		const moveW = smooth( 0.05, start, v );
		tw.idle = 1 - moveW;
		if ( v <= at( loco[ 0 ] ) || loco.length === 1 ) tw[ loco[ 0 ].clip ] = moveW;
		else {

			let i = 0;
			while ( i < loco.length - 2 && v > at( loco[ i + 1 ] ) ) i ++;
			const k = smooth( at( loco[ i ] ), at( loco[ i + 1 ] ), v );
			tw[ loco[ i ].clip ] = moveW * ( 1 - k ); tw[ loco[ i + 1 ].clip ] = moveW * k;

		}

		const kw = 1 - Math.exp( - dt * 6 );
		for ( const n in tw ) this.weights[ n ] = lerp( this.weights[ n ] ?? 0, tw[ n ], kw );
		const W = this.weights;

		// --- shared stride phase
		let f = 0, ws = 0;
		const all = this.crouchLoco ? [ ...this.loco, this.crouchLoco ] : this.loco;
		for ( const L of all ) {

			const w = W[ L.clip ] || 0;
			f += w * v / ( L.speed * L.dur ); ws += w;

		}

		f = ws > 1e-3 ? f / ws : 1;
		const prev = this.phase;
		this.phase = ( this.phase + dt * Math.max( 0.05, f ) ) % 1;
		for ( const L of all ) A[ L.clip ].time = this.phase * L.dur;
		if ( ws > 0.3 && Math.floor( this.phase * 2 ) !== Math.floor( prev * 2 ) ) this.steps ++;

		// --- rest layer
		const Rr = cfg.rest;
		let rest = 0;
		if ( Rr ) {

			const st = this.state;
			const tgt = {};
			if ( Rr.down ) tgt[ Rr.down ] = st === 'down' ? 1 : 0;
			tgt[ Rr.loop ] = st === 'resting' || ( ! Rr.down && st === 'down' ) || ( ! Rr.up && st === 'up' && this.stateT < 0.01 ) ? 1 : 0;
			if ( Rr.up ) tgt[ Rr.up ] = st === 'up' ? 1 : 0;
			const fade = Rr.down ? 10 : 1 / ( Rr.fade || 1.5 ) * 3;
			const kr = 1 - Math.exp( - dt * fade );
			for ( const n in tgt ) {

				this.restW_[ n ] = lerp( this.restW_[ n ] || 0, tgt[ n ], kr );
				rest += this.restW_[ n ];

			}

			rest = Math.min( 1, rest );

		}

		this.restW = rest;
		this.lieW = this.state === 'stand' ? 0 : 1;

		// --- one-shot overlay
		let sw = 0;
		const shot = this.shot;
		if ( shot ) {

			shot.t += dt;
			sw = smooth( 0, shot.fadeIn, shot.t ) * ( 1 - smooth( shot.dur - 0.2, shot.dur, shot.t ) );
			if ( shot.t >= shot.dur ) {

				this.shot = null; sw = 0;

			}

		}

		const base = ( 1 - rest ) * ( 1 - sw );
		const idleN = this.crouch && cfg.crouch ? cfg.crouch.idle : cfg.idle;
		A[ cfg.idle ].setEffectiveWeight( ( idleN === cfg.idle ? W.idle : 0 ) * base );
		if ( cfg.crouch ) A[ cfg.crouch.idle ].setEffectiveWeight( ( idleN !== cfg.idle ? W.idle : 0 ) * base );
		for ( const L of all ) A[ L.clip ].setEffectiveWeight( ( W[ L.clip ] || 0 ) * base );
		if ( Rr ) for ( const n in this.restW_ ) A[ n ].setEffectiveWeight( this.restW_[ n ] * ( 1 - sw ) );
		for ( const n of [ ...( cfg.idleVariants || [] ), ...( cfg.attack || [] ), ...( cfg.jump || [] ), ...( cfg.roar || [] ) ] ) {

			if ( A[ n ] ) A[ n ].setEffectiveWeight( shot && shot.n === n ? sw : 0 );

		}

		this.mixer.update( this.clipFrozen ? 0 : dt );
		if ( this.afterClips ) this.afterClips( dt );

		// --- placement: terrain slope, banking
		const turn = THREE.MathUtils.clamp( this.turnRate, - 1.5, 1.5 );
		const half = cfg.halfLength || 0.5;
		const fx = - Math.sin( this.heading ), fz = - Math.cos( this.heading );
		const hF = terrainHeightJS( this.pos.x + fx * half, this.pos.z + fz * half );
		const hB = terrainHeightJS( this.pos.x - fx * half, this.pos.z - fz * half );
		this.pos.y = lerp( this.pos.y, ( hF + hB ) * 0.5, 1 - Math.exp( - dt * 12 ) );
		this.pitch = lerp( this.pitch, Math.atan2( hF - hB, 2 * half ) * ( cfg.biped ? 0 : 1 ), 1 - Math.exp( - dt * 8 ) );
		this.lean = lerp( this.lean, - turn * this.speed * ( cfg.bank ?? 0.01 ), 1 - Math.exp( - dt * 4 ) );
		this.group.position.copy( this.pos );
		this.group.rotation.set( 0, this.heading + Math.PI, 0 );
		this.body.rotation.set( - this.pitch, 0, THREE.MathUtils.clamp( this.lean, - 0.2, 0.2 ) );

	}

}
