import * as THREE from 'three/webgpu';
import { pass, vec3, uv, smoothstep, length, float, mix } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

import { U, fieldsJS, windFieldJS, advanceWind } from './tsl/world.js';
import { Grass } from './grass.js';
import { Flowers } from './flowers.js';
import { Terrain } from './terrain.js';
import { Sky } from './sky.js';
import { Controls } from './controls.js';
import { Pollen } from './pollen.js';
import { MeadowAudio } from './audio.js';
import { Weather, sunElevation } from './weather.js';
import { Jaguar } from './jaguar.js';

const QUALITY = {
	// three nested grass rings, each coarser (wider blades) than the last:
	// blades/area = dense near field, mid/midArea, far/farArea out to the hills
	low: { blades: 576, area: 56, mid: 512, midArea: 150, far: 384, farArea: 360, flowers: 224, dpr: 1, lod: 0.8 },
	medium: { blades: 896, area: 76, mid: 704, midArea: 190, far: 512, farArea: 400, flowers: 304, dpr: 1.25, lod: 1 },
	high: { blades: 1280, area: 96, mid: 896, midArea: 240, far: 640, farArea: 440, flowers: 384, dpr: 1.5, lod: 1.15 },
	ultra: { blades: 1664, area: 120, mid: 1152, midArea: 300, far: 768, farArea: 500, flowers: 480, dpr: 2, lod: 1.4 },
};

const params = new URLSearchParams( location.search );
const isMobile = /Android|iPhone|iPad|iPod/i.test( navigator.userAgent ) || ( navigator.maxTouchPoints > 1 && window.innerWidth < 1100 );

const settings = {
	quality: params.get( 'q' ) || ( isMobile ? 'low' : 'high' ),
	hour: parseFloat( params.get( 'hour' ) || '6' ),
	clouds: parseFloat( params.get( 'clouds' ) || '0.5' ),
	wind: parseFloat( params.get( 'wind' ) || '1.2' ),
	windAngle: parseFloat( params.get( 'winddir' ) || '108' ),
	grassHeight: parseFloat( params.get( 'grass' ) || '1.6' ),
	dryPatches: parseFloat( params.get( 'dry' ) || '0' ),
	flowerGlow: 1.0,
	mist: parseFloat( params.get( 'mist' ) || '0.35' ),
	particles: parseFloat( params.get( 'particles' ) || '0.6' ),
	autoTime: params.get( 'auto' ) === '1',
	view: params.get( 'view' ) === 'third' ? 'third person (jaguar)' : 'first person',
	flowers: true,
	bloom: params.get( 'bloom' ) !== '0',
	exposure: 1.0,
	tour: params.get( 'tour' ) === '1',
	adaptive: ! params.has( 'q' ),
};

const hud = document.getElementById( 'hud' );
const fail = ( msg ) => {

	document.getElementById( 'loading' ).remove();
	const el = document.getElementById( 'nogpu' );
	el.querySelector( 'p' ).innerHTML = msg;
	el.hidden = false;

};

async function start() {

	if ( ! navigator.gpu ) return fail( 'This meadow is rendered entirely on the GPU with <b>WebGPU</b> compute shaders and indirect drawing. Your browser does not expose WebGPU. Try a recent Chrome, Edge, Safari 26+ or Firefox 141+.' );

	const renderer = new THREE.WebGPURenderer( { antialias: true, powerPreference: 'high-performance' } );
	await renderer.init();
	if ( ! renderer.backend.isWebGPUBackend ) return fail( 'WebGPU adapter unavailable (fell back to WebGL). Compute + indirect draw need a WebGPU device.' );

	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = settings.exposure;
	renderer.setClearColor( 0x000000 );
	document.body.appendChild( renderer.domElement );

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera( 55, 1, 0.05, 4000 );

	const sky = new Sky();
	scene.add( sky.mesh );

	// Lights only affect the jaguar (everything else uses the custom foliage
	// model); they mirror the sky uniforms. Intensity PI matches three's
	// Lambert normalisation to our albedo * irradiance convention.
	const sunLight = new THREE.DirectionalLight( 0xffffff, Math.PI );
	const hemiLight = new THREE.HemisphereLight( 0xffffff, 0x000000, Math.PI );
	scene.add( sunLight, sunLight.target, hemiLight );

	const jaguar = new Jaguar();
	scene.add( jaguar.group );

	const pollen = new Pollen( isMobile ? 2500 : 6000 );
	const weather = new Weather();
	scene.add( pollen.mesh );

	const controls = new Controls( camera, renderer.domElement );
	controls.tour = settings.tour;

	// spawn somewhere lush, flowery and not too short
	spawn: for ( let r = 0; r < 400; r += 6 ) for ( let a = 0; a < Math.PI * 2; a += Math.max( 0.15, 6 / Math.max( r, 1 ) ) ) {

		const x = Math.cos( a ) * r, z = Math.sin( a ) * r;
		const f = fieldsJS( x, z );
		if ( f.dry < 0.02 && f.flowers > 0.75 && f.tall > 0.45 && f.tall < 0.8 ) {

			controls.pos.set( x, 0, z );
			break spawn;

		}

	}

	let grass = null, midGrass = null, farGrass = null, flowers = null, terrain = null;
	const grassRings = () => [ grass, midGrass, farGrass ].filter( Boolean );

	function buildWorld() {

		const q = QUALITY[ settings.quality ];
		for ( const g of grassRings() ) g.dispose();
		if ( flowers ) flowers.dispose();
		if ( terrain ) terrain.mesh.removeFromParent();

		// Complementary crossfade bands: ring k fades out over the same distances
		// ring k+1 fades in, so blade *density* hands over while heights stay real.
		const Rn = q.area * 0.5, Rm = q.midArea * 0.5, Rf = q.farArea * 0.5;
		const bandN = [ Rn * 0.62, Rn * 0.96 ], bandM = [ Rm * 0.6, Rm * 0.96 ];
		const nearSp = q.area / q.blades;
		grass = new Grass( { bladesPerAxis: q.blades, area: q.area, lodScale: q.lod, fadeOut: bandN } );
		midGrass = new Grass( {
			bladesPerAxis: q.mid, area: q.midArea, renderOrder: 3, fadeIn: bandN, fadeOut: bandM,
			widthScale: Math.sqrt( ( q.midArea / q.mid ) / nearSp ) * 1.6, aoMin: 0.32, groundBlend: 0.1,
			lods: [ { segments: 4, maxDistance: Rn * 1.4 }, { segments: 2, maxDistance: Infinity } ],
		} );
		farGrass = new Grass( {
			bladesPerAxis: q.far, area: q.farArea, renderOrder: 5, fadeIn: bandM, fadeOut: [ Rf * 0.7, Rf * 0.97 ],
			widthScale: Math.sqrt( ( q.farArea / q.far ) / nearSp ) * 1.7, aoMin: 0.45, groundBlend: 0.2,
			lods: [ { segments: 2, maxDistance: Rm * 1.3 }, { segments: 1, maxDistance: Infinity } ],
		} );
		for ( const g of grassRings() ) {

			g.u.heightScale.value = settings.grassHeight;
			scene.add( g.group );

		}

		flowers = new Flowers( { perAxis: q.flowers, area: q.area * 0.92, grassArea: q.area } );
		flowers.u.heightScale.value = settings.grassHeight;
		flowers.group.visible = settings.flowers;
		scene.add( flowers.group );

		terrain = new Terrain( { grassRadius: q.area * 0.5 } );
		scene.add( terrain.mesh );

		renderer.setPixelRatio( Math.min( window.devicePixelRatio, q.dpr ) );
		resize();
		stats.blades = q.blades * q.blades + q.mid * q.mid + q.far * q.far;

	}

	// ------------------------------------------------------------ post
	let pipeline = null;
	function buildPost() {

		pipeline = new THREE.RenderPipeline( renderer );
		const scenePass = pass( scene, camera );
		const color = scenePass.getTextureNode( 'output' );
		const glow = bloom( color, 0.22, 0.55, 1.1 );
		// subtle optical vignette
		const d = length( uv().sub( 0.5 ).mul( vec3( 1.0, 0.8, 0 ).xy ) );
		const vig = mix( float( 1.0 ), float( 0.78 ), smoothstep( 0.35, 0.85, d ) );
		pipeline.outputNode = color.add( glow ).mul( vig );

	}

	buildPost();

	// ------------------------------------------------------------ atmosphere
	function applySky() {

		const h = settings.hour;
		const el = sunElevation( h );
		const az = 90 + ( h - 6 ) / 12 * 180;
		sky.setAtmosphere( el, az, settings.clouds );
		// eyes adapt at night: lift exposure so the moonlit meadow stays readable
		renderer.toneMappingExposure = settings.exposure * ( 1 + U.night.value * 0.7 );
		U.dry.value = settings.dryPatches;
		U.glow.value = settings.flowerGlow;
		U.mist.value = settings.mist;
		U.particles.value = settings.particles;
		sunLight.color.copy( U.sunColor.value );
		sunLight.position.copy( U.sunDir.value ).multiplyScalar( 100 );
		hemiLight.color.copy( U.skyAmb.value );
		hemiLight.groundColor.copy( U.groundAmb.value );
		sky.az = az;
		const wa = THREE.MathUtils.degToRad( settings.windAngle );
		U.windDir.value.set( Math.cos( wa ), Math.sin( wa ) );
		U.windStrength.value = settings.wind;
		U.windSpeed.value = 1.5 + settings.wind * 4;

	}

	applySky();
	// start facing the sun: backlit translucent blades are the money shot
	controls.lookAtAzimuth( sky.az + 12 );

	// the jaguar appears a few metres ahead, crossing the view
	jaguar.load( './models/jaguar.glb' ).then( () => {

		const f = new THREE.Vector3( - Math.sin( controls.yaw ), 0, - Math.cos( controls.yaw ) );
		jaguar.place( controls.pos.x + f.x * 7, controls.pos.z + f.z * 7, controls.yaw + Math.PI / 2 );
		if ( settings.view.startsWith( 'third' ) ) setView( settings.view );

	} ).catch( ( e ) => console.warn( 'jaguar failed to load', e ) );

	function setView( v ) {

		settings.view = v;
		if ( v.startsWith( 'third' ) ) {

			controls.mode = 'third';
			controls._orbitInit = false;
			controls.yaw = jaguar.heading;
			controls.pitch = - 0.22;
			controls.distTarget = controls.dist = 5.5;

		} else {

			controls.mode = 'first';
			controls.eye = controls.eyeTarget = 2.3;
			controls._initialised = false;

		}

	}

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.code === 'KeyV' && jaguar.ready ) setView( settings.view.startsWith( 'third' ) ? 'first person' : 'third person (jaguar)' );

	} );

	// ------------------------------------------------------------ gui
	const gui = new GUI( { title: 'Meadow' } );
	if ( isMobile || params.has( 'nogui' ) ) gui.close();
	gui.add( settings, 'hour', 0, 24, 0.05 ).name( 'time of day' ).onChange( applySky ).listen();
	gui.add( settings, 'clouds', 0, 1, 0.01 ).onChange( applySky ).listen();
	gui.add( settings, 'wind', 0, 1.6, 0.01 ).onChange( applySky ).listen();
	gui.add( settings, 'windAngle', 0, 360, 1 ).name( 'wind direction' ).onChange( applySky ).listen();
	gui.add( settings, 'grassHeight', 0.3, 3.0, 0.01 ).name( 'grass height' ).onChange( ( v ) => {

		for ( const g of grassRings() ) {

			g.u.heightScale.value = v;
			g.invalidate();

		}

		flowers.u.heightScale.value = v;
		flowers.invalidate();

	} );
	gui.add( settings, 'dryPatches', 0, 1, 0.01 ).name( 'dry patches' ).onChange( () => {

		applySky();
		for ( const g of grassRings() ) g.invalidate();

	} );
	gui.add( settings, 'flowerGlow', 0, 3, 0.01 ).name( 'night glow' ).onChange( applySky );
	gui.add( settings, 'mist', 0, 1, 0.01 ).name( 'inversion / mist' ).onChange( applySky ).listen();
	gui.add( settings, 'particles', 0, 1, 0.01 ).name( 'floating particles' ).onChange( applySky ).listen();
	gui.add( settings, 'autoTime' ).name( 'auto time (12 min day)' );
	gui.add( settings, 'flowers' ).onChange( ( v ) => ( flowers.group.visible = v ) );
	gui.add( settings, 'exposure', 0.4, 2.0, 0.01 ).onChange( applySky );
	gui.add( settings, 'bloom' );
	gui.add( settings, 'quality', Object.keys( QUALITY ) ).onChange( () => {

		settings.adaptive = false;
		buildWorld();

	} ).listen();
	gui.add( controls, 'tour' ).name( 'auto tour' ).listen();
	gui.add( settings, 'view', [ 'first person', 'third person (jaguar)' ] ).name( 'view (V)' ).onChange( setView ).listen();

	// ------------------------------------------------------------ sound
	const audio = new MeadowAudio();
	const soundBtn = document.getElementById( 'sound' );
	const setSoundUI = () => {

		soundBtn.classList.toggle( 'on', audio.enabled );
		soundBtn.setAttribute( 'aria-pressed', audio.enabled ? 'true' : 'false' );
		soundBtn.querySelector( 'span' ).textContent = audio.enabled ? 'sound on' : 'sound off';

	};

	let userMuted = params.get( 'sound' ) === '0';
	const startAudio = async () => {

		if ( userMuted || audio.enabled ) return;
		try {

			await audio.start();

		} catch ( e ) {

			console.warn( 'audio unavailable', e );

		}

		setSoundUI();

	};

	// browsers only allow audio after a user gesture: start on the first one
	const firstGesture = () => {

		startAudio();
		window.removeEventListener( 'pointerdown', firstGesture );
		window.removeEventListener( 'keydown', firstGesture );

	};

	window.addEventListener( 'pointerdown', firstGesture );
	window.addEventListener( 'keydown', firstGesture );
	soundBtn.addEventListener( 'pointerdown', ( e ) => e.stopPropagation() );
	soundBtn.addEventListener( 'click', async ( e ) => {

		e.stopPropagation();
		if ( audio.enabled ) {

			userMuted = true;
			audio.setEnabled( false );

		} else {

			userMuted = false;
			await startAudio();
			audio.setEnabled( true );

		}

		setSoundUI();

	} );
	window.addEventListener( 'keydown', ( e ) => {

		if ( e.code === 'KeyM' ) soundBtn.click();

	} );

	const sfx = gui.addFolder( 'Sound' );
	sfx.add( audio.volumes, 'master', 0, 1, 0.01 ).onChange( () => audio.applyVolumes() );
	sfx.add( audio.volumes, 'music', 0, 1, 0.01 ).onChange( () => audio.applyVolumes() );
	sfx.add( audio.volumes, 'nature', 0, 1, 0.01 ).name( 'wind & wildlife' ).onChange( () => audio.applyVolumes() );
	sfx.add( audio.volumes, 'steps', 0, 1, 0.01 ).name( 'steps & rustle' ).onChange( () => audio.applyVolumes() );
	sfx.close();

	const windSample = () => {

		// average the gust field around you and slightly upwind: gusts are
		// heard rolling in a moment before they bend the grass at your feet
		const p = controls.pos, d = U.windDir.value;
		let w = 0;
		for ( const k of [ 0, 3, 6, 10 ] ) w += windFieldJS( p.x - d.x * k, p.z - d.y * k );
		return w / 4;

	};

	// ------------------------------------------------------------ loop
	const stats = { fps: 0, blades: 0, frames: 0, acc: 0 };

	let baseFov = 55;
	function resize() {

		const w = window.innerWidth, h = window.innerHeight;
		renderer.setSize( w, h );
		camera.aspect = w / h;
		baseFov = w < h ? 70 : 55;
		camera.fov = baseFov;
		camera.updateProjectionMatrix();

	}

	window.addEventListener( 'resize', resize );
	buildWorld();

	const clock = new THREE.Timer();
	let firstFrame = true;
	let adaptT = 0, adaptFrames = 0, adaptStage = 0;

	async function frame() {

		clock.update();
		const dt = Math.min( clock.getDelta(), 1 / 15 );
		U.time.value += dt;
		if ( weather.update( dt, settings ) ) applySky();
		advanceWind( dt );

		const third = controls.mode === 'third' && jaguar.ready && ! window.__jaguarFreeze;
		if ( third ) {

			jaguar.update( dt, window.__jaguarInput || controls.moveInput() );
			controls.updateThird( dt, new THREE.Vector3( jaguar.pos.x, jaguar.pos.y + 0.8, jaguar.pos.z ), jaguar.speed );

		} else {

			controls.update( dt, settings.tour );
			if ( jaguar.ready && ! window.__jaguarFreeze ) jaguar.update( dt, null, controls.pos );

		}

		if ( jaguar.ready ) {

			// body pushes grass; soft shadow cast along the sun direction
			U.actor.value.set( jaguar.pos.x, jaguar.pos.y, jaguar.pos.z, 0.95 + Math.min( jaguar.speed, 10 ) * 0.03 );
			const sd = U.sunDir.value;
			const k = Math.min( 3, 0.45 / Math.max( sd.y, 0.15 ) );
			U.actorShadow.value.set( jaguar.pos.x - sd.x * k, jaguar.pos.z - sd.z * k,
				0.6 * THREE.MathUtils.smoothstep( sd.y, - 0.02, 0.12 ) * ( 1 - settings.clouds * 0.4 ) );

		}
		sky.update( camera );
		terrain.update( camera );
		grass.update( renderer, camera, controls.pusher );
		midGrass.update( renderer, camera, null );
		farGrass.update( renderer, camera, null );
		if ( settings.flowers ) flowers.update( renderer, camera, controls.pusher );
		pollen.update( camera, controls._groundY );

		if ( Math.abs( camera.fov - ( baseFov + controls.fovKick ) ) > 0.01 ) {

			camera.fov = baseFov + controls.fovKick;
			camera.updateProjectionMatrix();

		}

		if ( audio.enabled ) {

			const who = third ? jaguar.pos : controls.pos;
			const f = fieldsJS( who.x, who.z );
			audio.update( {
				wind: windSample(),
				speed: third ? jaguar.speed : ( controls.speed || 0 ),
				onFoot: third || controls.eye < 2.5,
				steps: third ? jaguar.steps : ( controls.steps || 0 ),
				bob: third ? jaguar.phase * Math.PI * 4 : ( controls.bob || 0 ),
				soft: third,
				grass: Math.min( 1, ( 0.14 + f.tall * 0.91 ) * settings.grassHeight ),
				hour: settings.hour,
				eye: controls.eye,
			} );

		}

		if ( settings.bloom ) pipeline.render();
		else renderer.render( scene, camera );

		if ( firstFrame ) {

			firstFrame = false;
			const l = document.getElementById( 'loading' );
			l.classList.add( 'done' );
			setTimeout( () => l.remove(), 1200 );

		}

		// fps + simple adaptive quality during the first seconds
		stats.frames ++;
		stats.acc += dt;
		if ( stats.acc > 0.5 ) {

			stats.fps = stats.frames / stats.acc;
			stats.frames = 0; stats.acc = 0;
			hud.textContent = `${ stats.fps.toFixed( 0 ) } fps · ${ ( stats.blades / 1e6 ).toFixed( 2 ) }M blades · ${ settings.quality }`;

		}

		if ( settings.adaptive ) {

			adaptT += dt; adaptFrames ++;
			if ( adaptT > 2.5 ) {

				const fps = adaptFrames / adaptT;
				adaptT = 0; adaptFrames = 0;
				adaptStage ++;
				if ( adaptStage >= 2 ) {

					const order = Object.keys( QUALITY );
					const i = order.indexOf( settings.quality );
					if ( fps < 42 && i > 0 ) {

						settings.quality = order[ i - 1 ];
						buildWorld();

					} else if ( fps > 85 && i < order.length - 1 && adaptStage < 4 ) {

						settings.quality = order[ i + 1 ];
						buildWorld();

					} else if ( adaptStage > 5 ) settings.adaptive = false;

				}

			}

		}

	}

	renderer.setAnimationLoop( frame );

	// expose for debugging / screenshots
	window.__meadow = { THREE, renderer, scene, camera, controls, settings, applySky, audio, jaguar, setView, jaguarMod: () => import( './jaguar.js' ), setQuality( q ) {

		settings.quality = q;
		settings.adaptive = false;
		buildWorld();

	}, get grass() {

		return grass;

	}, get flowers() {

		return flowers;

	} };

}

start().catch( ( e ) => {

	console.error( e );
	fail( 'Failed to start: ' + ( e && e.message ? e.message : e ) );

} );
