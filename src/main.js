import * as THREE from 'three/webgpu';
import { pass, vec3, uv, smoothstep, length, float, mix } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

import { U, fieldsJS, windFieldJS } from './tsl/world.js';
import { Grass } from './grass.js';
import { Flowers } from './flowers.js';
import { Terrain } from './terrain.js';
import { Sky } from './sky.js';
import { Controls } from './controls.js';
import { Pollen } from './pollen.js';
import { MeadowAudio } from './audio.js';

const QUALITY = {
	low: { blades: 576, area: 56, flowers: 224, dpr: 1, lod: 0.8 },
	medium: { blades: 896, area: 76, flowers: 304, dpr: 1.25, lod: 1 },
	high: { blades: 1280, area: 96, flowers: 384, dpr: 1.5, lod: 1.15 },
	ultra: { blades: 1664, area: 120, flowers: 480, dpr: 2, lod: 1.4 },
};

const params = new URLSearchParams( location.search );
const isMobile = /Android|iPhone|iPad|iPod/i.test( navigator.userAgent ) || ( navigator.maxTouchPoints > 1 && window.innerWidth < 1100 );

const settings = {
	quality: params.get( 'q' ) || ( isMobile ? 'low' : 'high' ),
	hour: parseFloat( params.get( 'hour' ) || '17.95' ),
	clouds: parseFloat( params.get( 'clouds' ) || '0.35' ),
	wind: parseFloat( params.get( 'wind' ) || '0.55' ),
	windAngle: 20,
	grassHeight: parseFloat( params.get( 'grass' ) || '1.28' ),
	flowers: true,
	bloom: params.get( 'bloom' ) !== '0',
	exposure: 1.0,
	tour: params.get( 'tour' ) !== '0',
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

	const pollen = new Pollen( isMobile ? 1200 : 2500 );
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

	let grass = null, flowers = null, terrain = null;

	function buildWorld() {

		const q = QUALITY[ settings.quality ];
		if ( grass ) grass.dispose();
		if ( flowers ) flowers.dispose();
		if ( terrain ) terrain.mesh.removeFromParent();

		grass = new Grass( { bladesPerAxis: q.blades, area: q.area, lodScale: q.lod } );
		grass.u.heightScale.value = settings.grassHeight;
		scene.add( grass.group );

		flowers = new Flowers( { perAxis: q.flowers, area: q.area * 0.92, grassArea: q.area } );
		flowers.u.heightScale.value = settings.grassHeight;
		flowers.group.visible = settings.flowers;
		scene.add( flowers.group );

		terrain = new Terrain( { grassRadius: q.area * 0.5 } );
		scene.add( terrain.mesh );

		renderer.setPixelRatio( Math.min( window.devicePixelRatio, q.dpr ) );
		resize();
		stats.blades = q.blades * q.blades;

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
		const el = 58 * Math.sin( Math.PI * ( h - 6 ) / 12 ) - ( h < 6 || h > 18 ? 4 : 0 );
		const az = 90 + ( h - 6 ) / 12 * 180;
		sky.setAtmosphere( el, az, settings.clouds );
		sky.az = az;
		const wa = THREE.MathUtils.degToRad( settings.windAngle );
		U.windDir.value.set( Math.cos( wa ), Math.sin( wa ) );
		U.windStrength.value = settings.wind;
		U.windSpeed.value = 1.5 + settings.wind * 4;

	}

	applySky();
	// start facing the sun: backlit translucent blades are the money shot
	controls.lookAtAzimuth( sky.az + 12 );

	// ------------------------------------------------------------ gui
	const gui = new GUI( { title: 'Meadow' } );
	if ( isMobile || params.has( 'nogui' ) ) gui.close();
	gui.add( settings, 'hour', 4.5, 20.5, 0.05 ).name( 'time of day' ).onChange( applySky );
	gui.add( settings, 'clouds', 0, 1, 0.01 ).onChange( applySky );
	gui.add( settings, 'wind', 0, 1.2, 0.01 ).onChange( applySky );
	gui.add( settings, 'windAngle', 0, 360, 1 ).name( 'wind direction' ).onChange( applySky );
	gui.add( settings, 'grassHeight', 0.3, 1.6, 0.01 ).name( 'grass height' ).onChange( ( v ) => {

		grass.u.heightScale.value = v;
		flowers.u.heightScale.value = v;
		grass.invalidate();
		flowers.invalidate();

	} );
	gui.add( settings, 'flowers' ).onChange( ( v ) => ( flowers.group.visible = v ) );
	gui.add( settings, 'exposure', 0.4, 2.0, 0.01 ).onChange( ( v ) => ( renderer.toneMappingExposure = v ) );
	gui.add( settings, 'bloom' );
	gui.add( settings, 'quality', Object.keys( QUALITY ) ).onChange( () => {

		settings.adaptive = false;
		buildWorld();

	} ).listen();
	gui.add( controls, 'tour' ).name( 'auto tour' ).listen();

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

		controls.update( dt, settings.tour );
		sky.update( camera );
		terrain.update( camera );
		grass.update( renderer, camera, controls.pusher );
		if ( settings.flowers ) flowers.update( renderer, camera, controls.pusher );
		pollen.update( camera, controls._groundY );

		if ( Math.abs( camera.fov - ( baseFov + controls.fovKick ) ) > 0.01 ) {

			camera.fov = baseFov + controls.fovKick;
			camera.updateProjectionMatrix();

		}

		if ( audio.enabled ) {

			const f = fieldsJS( controls.pos.x, controls.pos.z );
			audio.update( {
				wind: windSample(),
				speed: controls.speed || 0,
				onFoot: controls.eye < 2.5,
				steps: controls.steps || 0,
				bob: controls.bob || 0,
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
	window.__meadow = { renderer, scene, camera, controls, settings, applySky, audio, setQuality( q ) {

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
