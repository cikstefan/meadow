// Walk / look controls with a self-driving "tour" mode.
// Drag to look, WASD / arrows to walk, Shift to run, wheel or Q/E for height.
// After a few idle seconds the camera drifts on its own along a lazy path.

import * as THREE from 'three/webgpu';
import { terrainHeightJS } from './tsl/world.js';

export class Controls {

	constructor( camera, dom ) {

		this.camera = camera;
		this.dom = dom;
		this.pos = new THREE.Vector3( 0, 0, 0 );
		this.yaw = 0;
		this.pitch = - 0.06;
		this.eye = 2.3;
		this.eyeTarget = 2.3;
		this.mode = 'first'; // 'first' | 'third'
		this.dist = 5.5;
		this.distTarget = 5.5;
		this.orbitTarget = new THREE.Vector3();
		this._orbitInit = false;
		this.keys = new Set();
		this.tour = true;
		this.idle = 0;
		this.tourTime = 0;
		this.tourHeading = 0;
		this.vel = new THREE.Vector3();
		this.pusher = new THREE.Vector3();
		this._groundY = 0;

		let dragging = false, lx = 0, ly = 0;

		// cursor steering: the view follows the mouse without clicking
		this.mouseSteer = false;
		this.cursor = { x: 0, y: 0, active: false };
		this._dragging = () => dragging;
		dom.addEventListener( 'pointermove', ( e ) => {

			if ( e.pointerType !== 'mouse' ) return;
			const r = dom.getBoundingClientRect();
			this.cursor.x = ( ( e.clientX - r.left ) / r.width ) * 2 - 1;
			this.cursor.y = ( ( e.clientY - r.top ) / r.height ) * 2 - 1;
			if ( ! this.cursor.active && this.mouseSteer ) this.poke();
			this.cursor.active = true;

		} );
		dom.addEventListener( 'pointerleave', () => ( this.cursor.active = false ) );
		window.addEventListener( 'blur', () => ( this.cursor.active = false ) );
		const touches = new Map();

		dom.addEventListener( 'pointerdown', ( e ) => {

			dragging = true; lx = e.clientX; ly = e.clientY;
			touches.set( e.pointerId, e );
			dom.setPointerCapture( e.pointerId );
			this.poke();

		} );
		dom.addEventListener( 'pointermove', ( e ) => {

			if ( ! dragging ) return;
			const dx = e.clientX - lx, dy = e.clientY - ly;
			lx = e.clientX; ly = e.clientY;
			this.yaw -= dx * 0.0032;
			this.pitch = THREE.MathUtils.clamp( this.pitch - dy * 0.0032, - 1.45, 1.2 );
			this.poke();

		} );
		const up = ( e ) => {

			dragging = false;
			touches.delete( e.pointerId );

		};

		dom.addEventListener( 'pointerup', up );
		dom.addEventListener( 'pointercancel', up );
		this.touches = touches;

		dom.addEventListener( 'wheel', ( e ) => {

			if ( this.mode === 'third' ) this.distTarget = THREE.MathUtils.clamp( this.distTarget * Math.exp( e.deltaY * 0.0012 ), 1.6, 40 );
			else this.eyeTarget = THREE.MathUtils.clamp( this.eyeTarget * Math.exp( e.deltaY * 0.0012 ), 0.25, 40 );
			this.poke();
			e.preventDefault();

		}, { passive: false } );

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.target && e.target.tagName === 'INPUT' ) return;
			this.keys.add( e.code );
			if ( [ 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE' ].includes( e.code ) ) this.poke();

		} );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );

	}

	poke() {

		this.idle = 0;
		if ( this.tour ) {

			this.tour = false;

		}

	}

	lookAtAzimuth( azDeg ) {

		// azimuth 0 = -Z, clockwise. Camera yaw 0 looks at -Z, positive yaw turns left.
		this.yaw = - THREE.MathUtils.degToRad( azDeg );
		this.tourHeading = this.yaw;

	}

	update( dt, autoTour ) {

		const k = this.keys;
		const fwd = ( k.has( 'KeyW' ) || k.has( 'ArrowUp' ) || this.touches.size >= 2 ? 1 : 0 ) - ( k.has( 'KeyS' ) || k.has( 'ArrowDown' ) ? 1 : 0 );
		const str = ( k.has( 'KeyD' ) || k.has( 'ArrowRight' ) ? 1 : 0 ) - ( k.has( 'KeyA' ) || k.has( 'ArrowLeft' ) ? 1 : 0 );
		if ( k.has( 'KeyQ' ) ) this.eyeTarget = Math.max( 0.25, this.eyeTarget * Math.exp( - dt * 1.5 ) );
		if ( k.has( 'KeyE' ) ) this.eyeTarget = Math.min( 40, this.eyeTarget * Math.exp( dt * 1.5 ) );

		this.steer( dt, 0 );
		this.idle += dt;
		if ( autoTour && ! this.tour && this.idle > 12 ) {

			this.tour = true;
			this.tourHeading = this.yaw;

		}

		const run = k.has( 'ShiftLeft' ) || k.has( 'ShiftRight' );
		this.running = run && ! this.tour;
		const speed = ( run ? 9.0 : 1.6 ) * Math.max( 1, this.eye / 2 );
		const target = new THREE.Vector3();

		if ( this.tour ) {

			this.tourTime += dt;
			this.tourHeading += Math.sin( this.tourTime * 0.07 ) * 0.035 * dt;
			const dh = this.tourHeading - this.yaw;
			this.yaw += dh * Math.min( 1, dt * 0.6 );
			this.pitch += ( - 0.07 + Math.sin( this.tourTime * 0.11 ) * 0.04 - this.pitch ) * Math.min( 1, dt * 0.5 );
			target.set( - Math.sin( this.tourHeading ), 0, - Math.cos( this.tourHeading ) ).multiplyScalar( 0.75 );

		} else {

			const f = new THREE.Vector3( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );
			const r = new THREE.Vector3( Math.cos( this.yaw ), 0, - Math.sin( this.yaw ) );
			target.addScaledVector( f, fwd ).addScaledVector( r, str );
			if ( target.lengthSq() > 0 ) target.normalize().multiplyScalar( speed );

		}

		this.vel.lerp( target, 1 - Math.exp( - dt * ( this.running ? 3 : 5 ) ) );
		this.pos.addScaledVector( this.vel, dt );

		this.eye += ( this.eyeTarget - this.eye ) * ( 1 - Math.exp( - dt * 4 ) );
		const gy = terrainHeightJS( this.pos.x, this.pos.z );
		this._groundY += ( gy - this._groundY ) * ( this._initialised ? 1 - Math.exp( - dt * 10 ) : 1 );
		this._initialised = true;

		// head bob synced to footsteps: cadence rises with speed (longer strides
		// when running). One step per half bob period; `steps` counts them.
		const sp = this.vel.length();
		this.speed = sp;
		const onFoot = this.eye < 2.5;
		const cadence = 1.5 + 0.2 * sp; // steps per second
		if ( sp > 0.15 && onFoot ) this.bob = ( this.bob || 0 ) + dt * cadence * Math.PI;
		// foot strike at the lowest point of the bob (|sin| = 1)
		this.steps = Math.floor( ( ( this.bob || 0 ) + Math.PI / 2 ) / Math.PI );
		const amp = THREE.MathUtils.lerp( 0.012, 0.03, THREE.MathUtils.clamp( ( sp - 1.6 ) / 6, 0, 1 ) );
		const bob = - Math.abs( Math.sin( this.bob || 0 ) ) * amp * Math.min( 1, sp ) * ( onFoot ? 1 : 0 );

		// speed feel: widen the field of view a little when running
		const kick = THREE.MathUtils.clamp( ( sp - 2 ) / 7, 0, 1 ) * 9;
		this.fovKick = ( this.fovKick || 0 ) + ( kick - ( this.fovKick || 0 ) ) * ( 1 - Math.exp( - dt * 3 ) );

		const cam = this.camera;
		cam.position.set( this.pos.x, this._groundY + this.eye + bob, this.pos.z );
		cam.rotation.set( this.pitch, this.yaw, 0, 'YXZ' );
		cam.updateMatrixWorld();

		// the walker's "legs": a bit ahead of the eye, on the ground
		const ahead = new THREE.Vector3( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) ).multiplyScalar( 0.55 );
		this.pusher.set( this.pos.x + ahead.x, this.eye < 2.5 ? this._groundY : - 1e4, this.pos.z + ahead.z );

	}


	// ------------------------------------------------------------ third person

	/** Camera-relative move intent for the followed character: { x, y, run }. */
	moveInput() {

		const k = this.keys;
		const fwd = ( k.has( 'KeyW' ) || k.has( 'ArrowUp' ) || this.touches.size >= 2 ? 1 : 0 ) - ( k.has( 'KeyS' ) || k.has( 'ArrowDown' ) ? 1 : 0 );
		const str = ( k.has( 'KeyD' ) || k.has( 'ArrowRight' ) ? 1 : 0 ) - ( k.has( 'KeyA' ) || k.has( 'ArrowLeft' ) ? 1 : 0 );
		const fx = - Math.sin( this.yaw ), fz = - Math.cos( this.yaw );
		const rx = Math.cos( this.yaw ), rz = - Math.sin( this.yaw );
		let x = fx * fwd + rx * str, y = fz * fwd + rz * str;
		const l = Math.hypot( x, y );
		if ( l > 1e-3 ) {

			x /= l; y /= l;

		}

		return { x, y, run: k.has( 'ShiftLeft' ) || k.has( 'ShiftRight' ) };

	}

	/** Orbit camera around `target` (drag = orbit, wheel / Q E = distance). */
	updateThird( dt, target, targetSpeed = 0 ) {

		const k = this.keys;
		if ( k.has( 'KeyQ' ) ) this.distTarget = Math.max( 1.6, this.distTarget * Math.exp( - dt * 1.5 ) );
		if ( k.has( 'KeyE' ) ) this.distTarget = Math.min( 40, this.distTarget * Math.exp( dt * 1.5 ) );
		this.tour = false;
		this.idle = 0;

		if ( ! this._orbitInit ) {

			this.orbitTarget.copy( target );
			this._orbitInit = true;

		}

		this.orbitTarget.lerp( target, 1 - Math.exp( - dt * 9 ) );
		this.dist += ( this.distTarget - this.dist ) * ( 1 - Math.exp( - dt * 5 ) );
		this.steer( dt, - 0.22 );
		this.pitch = THREE.MathUtils.clamp( this.pitch, - 1.35, 0.35 );

		const cp = Math.cos( this.pitch );
		const look = new THREE.Vector3( - Math.sin( this.yaw ) * cp, Math.sin( this.pitch ), - Math.cos( this.yaw ) * cp );
		const cam = this.camera;
		cam.position.copy( this.orbitTarget ).addScaledVector( look, - this.dist );
		const gy = terrainHeightJS( cam.position.x, cam.position.z ) + 0.35;
		if ( cam.position.y < gy ) cam.position.y = gy;
		cam.rotation.set( this.pitch, this.yaw, 0, 'YXZ' );
		cam.updateMatrixWorld();

		this.pos.set( cam.position.x, 0, cam.position.z );
		this._groundY = terrainHeightJS( cam.position.x, cam.position.z );
		this.eye = cam.position.y - this._groundY;
		this.pusher.set( 0, - 1e4, 0 );
		this.speed = 0;

		const kick = THREE.MathUtils.clamp( ( targetSpeed - 4 ) / 8, 0, 1 ) * 8;
		this.fovKick = ( this.fovKick || 0 ) + ( kick - ( this.fovKick || 0 ) ) * ( 1 - Math.exp( - dt * 3 ) );

	}


	// Cursor steering: horizontal offset from the centre turns (dead zone in the
	// middle, faster toward the edges); vertical position sets the look pitch.
	steer( dt, pitchBase ) {

		const c = this.cursor;
		if ( ! this.mouseSteer || ! c.active || this._dragging() ) return;
		const ax = Math.abs( c.x );
		const t = Math.min( 1, Math.max( 0, ( ax - 0.16 ) / 0.84 ) );
		const rate = t * t * ( 3 - 2 * t ) * 2.4; // rad/s at the very edge
		this.yaw -= Math.sign( c.x ) * rate * dt;
		const targetPitch = pitchBase - c.y * 0.75;
		this.pitch += ( targetPitch - this.pitch ) * ( 1 - Math.exp( - dt * 3.5 ) );
		if ( rate > 0.05 ) this.idle = 0;

	}

}
