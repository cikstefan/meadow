import * as THREE from 'three/webgpu';
import { pass, vec2, vec3, vec4, uv, smoothstep, length, float, mix, dot, uniform, step, max, Fn } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
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
import { Jaguar, POSE } from './jaguar.js';
import { DeerHerd } from './deer.js';
import { WindSpirits } from './spirits.js';

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
	quality: params.get( 'q' ) || ( isMobile ? 'low' : 'high' ), // desktop may start at ultra (see below)
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
	windSpirits: params.get( 'spirits' ) === '1',
	spiritAmount: 0.1,
	sunShafts: params.get( 'shafts' ) !== '0',
	painterly: params.get( 'grade' ) === '1',
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

	// Ask for the adapter's real buffer limits: the default 128 MiB storage
	// binding is too small for the ultra grass buffers (that made ultra render black).
	let requiredLimits = {};
	try {

		const adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
		if ( adapter ) requiredLimits = {
			maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			maxBufferSize: adapter.limits.maxBufferSize,
		};

	} catch ( e ) { /* fall back to defaults */ }

	const renderer = new THREE.WebGPURenderer( { antialias: true, powerPreference: 'high-performance', requiredLimits } );
	// capable desktop GPUs start at ultra; adaptive quality steps down if it struggles
	if ( ! params.has( 'q' ) && ! isMobile && ( requiredLimits.maxStorageBufferBindingSize || 0 ) >= 512 * 1024 * 1024 ) settings.quality = 'ultra';
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
	const herd = new DeerHerd();
	scene.add( herd.group );
	const spirits = new WindSpirits( isMobile ? 90 : 170 );
	spirits.mesh.visible = settings.windSpirits;
	scene.add( spirits.mesh );

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

		const q = { ...QUALITY[ settings.quality ] };
		// keep every storage buffer inside the device limit (64 B of static data per blade)
		const lim = Math.min( renderer.backend.device.limits.maxStorageBufferBindingSize, renderer.backend.device.limits.maxBufferSize );
		const maxAxis = ( n ) => Math.floor( Math.sqrt( lim * 0.98 / 64 ) / 16 ) * 16;
		for ( const k of [ 'blades', 'mid', 'far' ] ) if ( q[ k ] > maxAxis() ) {

			const r = maxAxis() / q[ k ];
			console.warn( `grass ${ k }: ${ q[ k ] }² exceeds GPU buffer limit, using ${ maxAxis() }²` );
			if ( k === 'blades' ) q.area *= r; // keep blade spacing, shrink the near radius slightly
			q[ k ] = maxAxis();

		}
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
	const post = { sunUV: uniform( new THREE.Vector2( 0.5, 0.5 ) ), shaftAmt: uniform( 0 ), aspect: uniform( 1 ) };

	// Giant Squid-style painterly grade: richer colour, cool shadows, warm highlights
	const painterly = Fn( ( [ c ] ) => {

		const lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
		const sat = mix( vec3( lum ), c, 1.22 );
		const shadowTint = vec3( 0.9, 0.98, 1.1 ), highTint = vec3( 1.08, 1.0, 0.9 );
		const t = smoothstep( 0.02, 0.6, lum );
		return sat.mul( mix( shadowTint, highTint, t ) ).mul( 1.04 );

	} );

	function buildPost() {

		if ( pipeline ) pipeline.dispose();
		pipeline = new THREE.RenderPipeline( renderer );
		const scenePass = pass( scene, camera );
		const color = scenePass.getTextureNode( 'output' );
		let col = color.rgb;
		const glow = bloom( color, 0.22, 0.55, 1.1 );
		col = col.add( glow.rgb );

		if ( settings.sunShafts ) {

			// light shafts: bright sky near the sun, radially smeared toward the sun;
			// grass blades and animals cut dark rays into it
			const depth = scenePass.getTextureNode( 'depth' ).x;
			const sky = step( 0.99997, depth );
			const d = length( uv().sub( post.sunUV ).mul( vec2( post.aspect, 1.0 ) ) );
			const near = smoothstep( 0.55, 0.0, d );
			const src = vec4( color.rgb.mul( sky ).mul( near ), 1.0 );
			const rays = radialBlur( src, { center: post.sunUV, weight: float( 0.6 ), decay: float( 0.965 ), count: 48, exposure: float( 1 ) } );
			col = col.add( rays.rgb.mul( post.shaftAmt ).mul( U.sunColor.mul( 0.25 ).add( 0.2 ) ) );

		}

		if ( settings.painterly ) col = painterly( col );

		// subtle optical vignette
		const dv = length( uv().sub( 0.5 ).mul( vec3( 1.0, 0.8, 0 ).xy ) );
		const vig = mix( float( 1.0 ), float( 0.78 ), smoothstep( 0.35, 0.85, dv ) );
		pipeline.outputNode = vec4( col.mul( vig ), 1.0 );

	}

	buildPost();

	// ------------------------------------------------------------ atmosphere
	function applySky() {

		const h = settings.hour;
		const el = sunElevation( h );
		const az = 90 + ( h - 6 ) / 12 * 180;
		sky.setAtmosphere( el, az, settings.clouds );
		// eyes adapt at night: lift exposure so the moonlit meadow stays readable
		// daylight is bright: settle at ~0.8 exposure once the sun is up; dawn,
		// dusk and night keep their exposure (night is lifted for readability)
		const day = THREE.MathUtils.smoothstep( el, 4, 16 );
		renderer.toneMappingExposure = settings.exposure * ( 1 + U.night.value * 0.7 ) * THREE.MathUtils.lerp( 1, 0.8, day );
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
	jaguar.load().then( () => {

		const f = new THREE.Vector3( - Math.sin( controls.yaw ), 0, - Math.cos( controls.yaw ) );
		jaguar.place( controls.pos.x + f.x * 11, controls.pos.z + f.z * 11, controls.yaw + Math.PI / 2 );
		if ( settings.view.startsWith( 'third' ) ) setView( settings.view );

	} ).catch( ( e ) => console.warn( 'jaguar failed to load', e ) );

	// a small herd of red deer grazing ahead and to the side
	{

		const a = controls.yaw + 0.5;
		const f = new THREE.Vector3( - Math.sin( a ), 0, - Math.cos( a ) );
		herd.load( new THREE.Vector3( controls.pos.x + f.x * 55, 0, controls.pos.z + f.z * 55 ), 4 )
			.catch( ( e ) => console.warn( 'deer failed to load', e ) );

	}

	// an animal pushes plants aside and casts a soft shadow along the sun direction
	function setActor( i, p, radius, bodyHeight ) {

		U.actors[ i ].value.set( p.x, p.y, p.z, radius );
		const sd = U.sunDir.value;
		const k = Math.min( 6, bodyHeight / Math.max( sd.y, 0.2 ) );
		U.actorShadows[ i ].value.set( p.x - sd.x * k, p.z - sd.z * k,
			0.6 * THREE.MathUtils.smoothstep( sd.y, - 0.02, 0.12 ) * ( 1 - settings.clouds * 0.4 ), radius * 1.05 );

	}

	function setView( v ) {

		settings.view = v;
		if ( v.startsWith( 'third' ) ) {

			controls.mode = 'third';
			controls._orbitInit = false;
			controls.yaw = jaguar.heading;
			controls.pitch = - 0.22;
			controls.distTarget = controls.dist = 8;

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
	gui.add( controls, 'mouseSteer' ).name( 'look follows cursor' );
	gui.add( settings, 'view', [ 'first person', 'third person (jaguar)' ] ).name( 'view (V)' ).onChange( setView ).listen();
	gui.add( herd.group, 'visible' ).name( 'deer' );

	const squid = gui.addFolder( '✦ Sword of the Sea mode (prototype)' );
	squid.add( settings, 'windSpirits' ).name( 'wind spirits' ).onChange( ( v ) => ( spirits.mesh.visible = v ) );
	squid.add( settings, 'spiritAmount', 0, 1, 0.005 ).name( 'spirit amount' ).onChange( ( v ) => ( spirits.u.amount.value = v ) ).listen();
	squid.add( settings, 'sunShafts' ).name( 'sun shafts' ).onChange( buildPost );
	squid.add( settings, 'painterly' ).name( 'painterly grade' ).onChange( buildPost );
	squid.add( { all: () => {

		const on = ! ( settings.windSpirits && settings.sunShafts && settings.painterly );
		settings.windSpirits = settings.sunShafts = settings.painterly = on;
		spirits.mesh.visible = on;
		buildPost();
		squid.controllersRecursive().forEach( ( c ) => c.updateDisplay() );

	} }, 'all' ).name( 'toggle all' );

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
		if ( weather.update( dt, settings ) ) {

			applySky();
			// spirits behave like weather in auto time: they appear on their own at twilight
			spirits.u.amount.value = settings.spiritAmount;
			spirits.mesh.visible = settings.spiritAmount > 0.003;

		}

		spirits.update( camera );
		advanceWind( dt );

		const third = controls.mode === 'third' && jaguar.ready && ! window.__jaguarFreeze;
		if ( third ) {

			jaguar.update( dt, window.__jaguarInput || controls.moveInput() );
			controls.updateThird( dt, new THREE.Vector3( jaguar.pos.x, jaguar.pos.y + 1.25, jaguar.pos.z ), jaguar.speed );

		} else {

			controls.update( dt, settings.tour );
			if ( jaguar.ready && ! window.__jaguarFreeze ) jaguar.update( dt, null, controls.pos );

		}

		if ( jaguar.ready ) {

			// body pushes grass; soft shadow cast along the sun direction
			setActor( 0, jaguar.pos, 1.6 + Math.min( jaguar.speed, 15 ) * 0.03, 0.9 );

		}

		if ( herd.ready && herd.group.visible && ! window.__deerFreeze ) {

			const threats = [ { pos: jaguar.pos, speed: jaguar.speed, isPredator: true } ];
			if ( ! third ) threats.push( { pos: camera.position, speed: controls.speed || 0, isPredator: false } );
			herd.update( dt, threats, third ? jaguar.pos : controls.pos );

		}

		herd.deer.forEach( ( d, i ) => {

			if ( herd.group.visible ) setActor( i + 1, d.pos, d.size * 0.3, d.size * 0.32 );
			else U.actors[ i + 1 ].value.y = - 1e4;

		} );
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

		if ( settings.sunShafts ) {

			const sp = U.trueSunDir.value.clone().multiplyScalar( 1000 ).add( camera.position ).project( camera );
			post.sunUV.value.set( sp.x * 0.5 + 0.5, 1 - ( sp.y * 0.5 + 0.5 ) );
			post.aspect.value = camera.aspect;
			const facing = U.trueSunDir.value.dot( camera.getWorldDirection( new THREE.Vector3() ) );
			const low = 1 - THREE.MathUtils.smoothstep( U.trueSunDir.value.y, 0.25, 0.7 );
			post.shaftAmt.value = THREE.MathUtils.smoothstep( facing, 0.05, 0.45 ) * ( 0.35 + 0.65 * low ) * THREE.MathUtils.smoothstep( U.trueSunDir.value.y, - 0.03, 0.04 ) * 0.9;

		}

		if ( settings.bloom || settings.sunShafts || settings.painterly ) pipeline.render();
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
			let gait = '';
			if ( controls.mode === 'third' && jaguar.ready ) {

				const w = jaguar.weights;
				const g = Object.keys( w ).reduce( ( a, b ) => ( w[ b ] > w[ a ] ? b : a ) );
				gait = ` · jaguar: ${ g === 'idle' ? ( jaguar.lieW > 0.5 ? 'lying' : jaguar.sitW > 0.5 ? 'sitting' : 'standing' ) : g } ${ jaguar.speed.toFixed( 1 ) } m/s${ controls.autoRun ? ' (run: R)' : '' }`;

			}

			hud.textContent = `${ stats.fps.toFixed( 0 ) } fps · ${ ( stats.blades / 1e6 ).toFixed( 2 ) }M blades · ${ settings.quality }${ gait }`;

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
	window.__meadow = { THREE, U, spirits, renderer, scene, camera, controls, settings, applySky, audio, jaguar, herd, setView, POSE, setQuality( q ) {

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
