import * as THREE from 'three/webgpu';
import { pass, vec2, vec3, vec4, uv, smoothstep, length, float, mix, dot, uniform, step, max, Fn, rtt, normalize, select, screenSize, screenCoordinate, uint, ivec2, floor, bitcast, mrt, output, velocity, min } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { computeHaltonOffsets } from 'three/addons/tsl/utils/TAAUtils.js';
const HALTON = computeHaltonOffsets( 32 );
const _dbs = new THREE.Vector2();
import { unpackColor } from './biomes/plains/vox/raster.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

import { U, fieldsJS, windFieldJS, advanceWind, terrainHeightJS } from './tsl/world.js';
import { Grass } from './grass.js';
import { Flowers } from './flowers.js';
import { Terrain } from './terrain.js';
import { Sky } from './sky.js';
import { Controls } from './controls.js';
import { Pollen } from './pollen.js';
import { MeadowAudio } from './audio.js';
import { Weather, sunElevation } from './weather.js';
import { Jaguar } from './jaguar.js';
import { makeRaptor, makeHuman } from './characters.js';
import { DeerHerd } from './deer.js';
import { WindSpirits } from './spirits.js';
import { BIOME, BIOMES } from './biomes/index.js';
import { Loader } from './ui/loader.js';
// the plains' own look (night grade, bloom, exposure) never touches the meadow
const PLAINS = BIOME.id === 'plains';
const CLOUD_LOW = BIOME.clouds && BIOME.clouds.BASE !== undefined ? BIOME.clouds.BASE - 350 : 1e9; // below the cloud deck
import { mountWorldSwitch } from './ui/worldswitch.js';

const QUALITY = {
	// three nested grass rings, each coarser (wider blades) than the last:
	// blades/area = dense near field, mid/midArea, far/farArea out to the hills
	low: { blades: 576, area: 56, mid: 512, midArea: 150, far: 384, farArea: 360, flowers: 224, dpr: 1, lod: 0.8 },
	medium: { blades: 896, area: 76, mid: 704, midArea: 190, far: 512, farArea: 400, flowers: 304, dpr: 1.25, lod: 1 },
	high: { blades: 1280, area: 96, mid: PLAINS ? 800 : 896, midArea: 240, far: PLAINS ? 640 : 640, farArea: PLAINS ? 620 : 440, flowers: 384, dpr: 1.5, lod: 1.15 },
	ultra: { blades: 1664, area: 120, mid: PLAINS ? 1024 : 1152, midArea: 300, far: PLAINS ? 800 : 768, farArea: PLAINS ? 760 : 500, flowers: 480, dpr: 2, lod: 1.4 },
};

const params = new URLSearchParams( location.search );
// the plains render the scene at a fraction of the screen's resolution and rebuild full
// resolution over frames (temporal upscaling); ?rs=1 renders at native resolution
const RS = PLAINS ? Math.min( 1, Math.max( 0.4, parseFloat( params.get( 'rs' ) ?? '0.7' ) || 0.7 ) ) : 1;
const isMobile = /Android|iPhone|iPad|iPod/i.test( navigator.userAgent ) || ( navigator.maxTouchPoints > 1 && window.innerWidth < 1100 );

const D = BIOME.defaults;
const num = ( k, def ) => ( params.has( k ) ? parseFloat( params.get( k ) ) : def );

const settings = {
	quality: params.get( 'q' ) || ( isMobile ? 'low' : 'high' ), // desktop may start at ultra (see below)
	hour: num( 'hour', D.hour ),
	clouds: num( 'clouds', D.clouds ),
	wind: num( 'wind', D.wind ),
	windAngle: num( 'winddir', D.windAngle ),
	grassHeight: num( 'grass', D.grassHeight ),
	dryPatches: num( 'dry', D.dryPatches ),
	flowerGlow: D.glow ?? 1.0,
	mist: num( 'mist', D.mist ),
	particles: num( 'particles', D.particles ),
	autoTime: params.get( 'auto' ) === '1',
	windSpirits: params.has( 'spirits' ) ? params.get( 'spirits' ) !== '0' : D.spirits,
	spiritAmount: num( 'spiritamount', D.spiritAmount ),
	sunShafts: params.has( 'shafts' ) ? params.get( 'shafts' ) !== '0' : D.shafts,
	painterly: params.get( 'grade' ) === '1',
	view: ( BIOME.animals && { third: 'third person (jaguar)', jaguar: 'third person (jaguar)', raptor: 'third person (raptor)' }[ params.get( 'view' ) ] ) || 'first person',
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

	if ( BIOME.loading && ! Loader.active ) document.getElementById( 'loading' ).textContent = BIOME.loading;
	await Loader.stage( 'boot' );
	if ( BIOME.title ) document.title = BIOME.title;

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

	// long views (mountains 4-16 km away) need a reversed depth buffer for precision
	const reversedDepth = !! BIOME.atmosphere;
	const renderer = new THREE.WebGPURenderer( { antialias: true, powerPreference: 'high-performance', requiredLimits, reversedDepthBuffer: reversedDepth } );
	// capable desktop GPUs start at ultra; adaptive quality steps down if it struggles
	if ( ! params.has( 'q' ) && ! isMobile && ( requiredLimits.maxStorageBufferBindingSize || 0 ) >= 512 * 1024 * 1024 ) settings.quality = 'ultra';
	await renderer.init();
	await Loader.stage( 'terrain' );
	// biome data that must exist before anything samples the terrain (real elevation)
	if ( BIOME.preload ) await BIOME.preload();
	await Loader.stage( 'world' );
	if ( ! renderer.backend.isWebGPUBackend ) return fail( 'WebGPU adapter unavailable (fell back to WebGL). Compute + indirect draw need a WebGPU device.' );

	// (the plains: AgX, natural greens and a soft highlight roll-off; the meadow keeps ACES)
	renderer.toneMapping = PLAINS ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = settings.exposure;
	renderer.setClearColor( 0x000000 );
	document.body.appendChild( renderer.domElement );

	const scene = new THREE.Scene();
	const ATM = BIOME.atmosphere;
	const camera = new THREE.PerspectiveCamera( 55, 1, ATM ? 0.08 : 0.05, ATM ? ATM.far : 4000 );

	const sky = new Sky();
	if ( ATM ) sky.mesh.scale.setScalar( ATM.skyRadius );
	scene.add( sky.mesh );
	if ( ATM ) {

		U.fogDensity.value = ATM.fogDensity;
		U.terrainFar.value = ATM.terrainFar;

	}

	// Lights only affect the jaguar (everything else uses the custom foliage
	// model); they mirror the sky uniforms. Intensity PI matches three's
	// Lambert normalisation to our albedo * irradiance convention.
	const sunLight = new THREE.DirectionalLight( 0xffffff, Math.PI );
	const hemiLight = new THREE.HemisphereLight( 0xffffff, 0x000000, Math.PI );
	scene.add( sunLight, sunLight.target, hemiLight );

	const jaguar = new Jaguar();
	scene.add( jaguar.group );
	// more third-person characters, loaded the first time they're chosen
	const raptor = makeRaptor(), human = makeHuman();
	scene.add( raptor.group, human.group );
	const chars = { 'third person (jaguar)': jaguar, 'third person (raptor)': raptor, 'third person (human)': human };
	// the human is hidden from the view list for now (the character code stays in place)
	const VIEWS = BIOME.animals ? [ 'first person', ...Object.keys( chars ).filter( ( v ) => chars[ v ] !== human ) ] : [ 'first person' ];
	const herd = new DeerHerd();
	scene.add( herd.group );
	const spirits = new WindSpirits( isMobile ? 90 : 170 );
	spirits.mesh.visible = settings.windSpirits;
	spirits.u.amount.value = settings.spiritAmount;
	scene.add( spirits.mesh );

	const pollen = new Pollen( isMobile ? 2500 : 6000 );
	const weather = new Weather();
	scene.add( pollen.mesh );

	const controls = new Controls( camera, renderer.domElement );
	controls.tour = settings.tour;

	// spawn: the biome's chosen spot, or somewhere lush, flowery and not too short
	if ( BIOME.spawn ) controls.pos.set( BIOME.spawn.pos[ 0 ], 0, BIOME.spawn.pos[ 1 ] );
	else spawn: for ( let r = 0; r < 400; r += 6 ) for ( let a = 0; a < Math.PI * 2; a += Math.max( 0.15, 6 / Math.max( r, 1 ) ) ) {

		const x = Math.cos( a ) * r, z = Math.sin( a ) * r;
		const f = fieldsJS( x, z );
		if ( f.dry < 0.02 && f.flowers > 0.75 && f.tall > 0.45 && f.tall < 0.8 ) {

			controls.pos.set( x, 0, z );
			break spawn;

		}

	}

	// biome-specific systems (plains: mountains, lake, shrubs, ghost forest)
	const extras = BIOME.createExtras ? await BIOME.createExtras( { scene, renderer, camera, settings } ) : null;
	await Loader.stage( 'shaders' );

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
		// (the plains spend fewer triangles with distance: a blade 20 m away is a few pixels
		// tall, so it gets fewer segments, and the far rings draw single wider blades)
		const L = q.lod;
		grass = new Grass( { bladesPerAxis: q.blades, area: q.area, lodScale: q.lod, fadeOut: bandN,
			lods: PLAINS ? [ { segments: 12, maxDistance: 6.5 * L }, { segments: 5, maxDistance: 15 * L }, { segments: 2, maxDistance: Infinity } ] : null } );
		midGrass = new Grass( {
			bladesPerAxis: q.mid, area: q.midArea, renderOrder: 3, fadeIn: bandN, fadeOut: bandM,
			widthScale: Math.sqrt( ( q.midArea / q.mid ) / nearSp ) * 1.6, aoMin: 0.32, groundBlend: 0.1,
			lods: PLAINS ? [ { segments: 3, maxDistance: Rn * 1.1 }, { segments: 2, maxDistance: Rm * 0.75 }, { segments: 1, maxDistance: Infinity } ]
				: [ { segments: 4, maxDistance: Rn * 1.4 }, { segments: 2, maxDistance: Infinity } ],
		} );
		farGrass = new Grass( {
			bladesPerAxis: q.far, area: q.farArea, renderOrder: 5, fadeIn: bandM, fadeOut: [ Rf * 0.7, Rf * 0.97 ],
			widthScale: Math.sqrt( ( q.farArea / q.far ) / nearSp ) * ( PLAINS ? 2.1 : 1.7 ), aoMin: 0.45, groundBlend: 0.2,
			lods: PLAINS ? [ { segments: 1, maxDistance: Infinity } ]
				: [ { segments: 2, maxDistance: Rm * 1.3 }, { segments: 1, maxDistance: Infinity } ],
		} );
		for ( const g of grassRings() ) {

			g.u.heightScale.value = settings.grassHeight;
			scene.add( g.group );

		}

		flowers = new Flowers( { perAxis: q.flowers, area: q.area * 0.92, grassArea: q.area } );
		flowers.u.heightScale.value = settings.grassHeight;
		flowers.group.visible = settings.flowers && ! BIOME.noGroundFlowers;
		scene.add( flowers.group );

		terrain = new Terrain( { grassRadius: q.area * 0.5 } );
		scene.add( terrain.mesh );

		renderer.setPixelRatio( Math.min( window.devicePixelRatio, q.dpr ) );
		resize();
		stats.blades = q.blades * q.blades + q.mid * q.mid + q.far * q.far;

	}

	// ------------------------------------------------------------ post
	let pipeline = null;
	const post = { night: uniform( 0 ), cloudy: uniform( 0 ), sunUV: uniform( new THREE.Vector2( 0.5, 0.5 ) ), shaftAmt: uniform( 0 ), aspect: uniform( 1 ),
		invProj: uniform( new THREE.Matrix4() ), camWorld: uniform( new THREE.Matrix4() ), camPos: uniform( new THREE.Vector3() ) };

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
		// (the plains resolve edges with TAA instead of MSAA: cheaper, and TAA needs single-sample depth)
		const scenePass = PLAINS ? pass( scene, camera, { samples: 0 } ) : pass( scene, camera );
		// the plains: a velocity buffer for temporal anti-aliasing
		if ( PLAINS ) { scenePass.setMRT( mrt( { output, velocity } ) ); scenePass.setResolutionScale( RS ); }
		let color = scenePass.getTextureNode( 'output' );
		if ( PLAINS ) {

			// ambient occlusion (GTAO, half resolution, normals from depth): contact shade where
			// grass meets plants and rocks, inside bushes, under branches
			const aoPass = ao( scenePass.getTextureNode( 'depth' ), null, camera );
			aoPass.resolutionScale = 0.5;
			aoPass.radius.value = 0.9; aoPass.samples.value = 12; aoPass.thickness.value = 1.2;
			post.ao = aoPass;
			color = vec4( color.rgb.mul( mix( float( 1.0 ), aoPass.getTextureNode().sample( uv() ).r, 0.85 ) ), 1.0 );

		}

		if ( BIOME.postClouds && BIOME.clouds ) {

			// volumetric clouds as a screen-space pass (after ceddc's ArcGIS RenderNode
			// clouds): every pixel marches the deck from the eye up to the surface the
			// depth buffer saw, at half resolution, then the scene is composited as
			// scene * transmittance + scattered light (clouds in front of mountains too)
			const depthTex = scenePass.getTextureNode( 'depth' );
			const vol = rtt( Fn( () => {

				const suv = uv();
				const d = depthTex.sample( suv ).x;
				const nx = suv.x.mul( 2.0 ).sub( 1.0 ), ny = float( 1.0 ).sub( suv.y.mul( 2.0 ) );
				const unproject = ( z ) => {

					const v = post.invProj.mul( vec4( nx, ny, z, 1.0 ) );
					return post.camWorld.mul( vec4( v.xyz.div( v.w ), 1.0 ) ).xyz;

				};
				const isSky = reversedDepth ? d.lessThan( 1e-7 ) : d.greaterThan( 0.9999999 );
				const wp = unproject( d );
				const dir = normalize( unproject( float( 0.5 ) ).sub( post.camPos ) );
				const dist = select( isSky, float( 1e9 ), length( wp.sub( post.camPos ) ) );
				if ( ! PLAINS ) return BIOME.clouds.marchView( post.camPos, dir, dist );
				// (the plains: ground and plants below the deck can't be inside a cloud; such texels
				// store what the sky behind them holds, flagged with alpha + 2, so neighbouring sky
				// pixels can use them while the plants themselves get no cloud at all)
				const low = isSky.not().and( wp.y.lessThan( CLOUD_LOW ) ).and( post.camPos.y.lessThan( CLOUD_LOW ) );
				const m = BIOME.clouds.marchView( post.camPos, dir, select( low, float( 1e9 ), dist ) );
				return select( low, vec4( m.rgb, m.a.add( 2.0 ) ), m );

			} )(), null, null, { resolutionScale: 0.5 } );
			// a small tent filter over the half-res march hides its per-pixel step jitter
			const px = vec2( 1.5 ).div( screenSize );
			const suv = uv();
			// (point taps on the plains: a filtered tap would blend flagged and unflagged texels)
			const tap = ( o ) => {

				if ( ! PLAINS ) return vol.sample( suv.add( o ) );
				const vs = vec2( vol.size() );
				const t = vol.load( ivec2( suv.add( o ).mul( vs ).floor().clamp( vec2( 0 ), vs.sub( 1.0 ) ) ) );
				return vec4( t.rgb, select( t.a.greaterThan( 1.5 ), t.a.sub( 2.0 ), t.a ) );

			};
			let v = tap( vec2( 0 ) ).mul( 0.28 )
				.add( tap( vec2( px.x, px.y ) ).mul( 0.18 ) ).add( tap( vec2( px.x.negate(), px.y ) ).mul( 0.18 ) )
				.add( tap( vec2( px.x, px.y.negate() ) ).mul( 0.18 ) ).add( tap( px.negate() ).mul( 0.18 ) );
			if ( PLAINS ) {

				// this pixel itself: plants and ground below the deck take no cloud (no half-res
				// cloud colour bleeding onto leaf edges in front of the clouds)
				const d0 = depthTex.sample( suv ).x;
				const sky0 = reversedDepth ? d0.lessThan( 1e-7 ) : d0.greaterThan( 0.9999999 );
				const q0 = post.invProj.mul( vec4( suv.x.mul( 2.0 ).sub( 1.0 ), float( 1.0 ).sub( suv.y.mul( 2.0 ) ), d0, 1.0 ) );
				const w0 = post.camWorld.mul( vec4( q0.xyz.div( q0.w ), 1.0 ) ).xyz;
				const low0 = sky0.not().and( w0.y.lessThan( CLOUD_LOW ) ).and( post.camPos.y.lessThan( CLOUD_LOW ) );
				v = select( low0, vec4( 0, 0, 0, 1 ), v );

			}
			color = vec4( color.rgb.mul( v.a ).add( v.rgb ), 1.0 );

		}
		// voxel foliage (compute-shader rasterizer, ?veg=raster): its colour wins
		// wherever its depth is nearer than the scene's
		const vr = extras && extras.vox;
		// (the voxel cull tests plants against this pass's depth from the frame before)
		if ( vr ) vr.resScale = RS;
		if ( vr && reversedDepth ) vr.setOcclusionDepth( scenePass.getTexture( 'depth' ) );
		if ( vr ) {

			const sc = screenCoordinate;
			const idx = uint( floor( sc.y ) ).mul( uint( vr.u.size.x ) ).add( uint( floor( sc.x ) ) );
			const bits = vr.depthRead.element( idx );
			const vd = float( 1.0 ).div( bitcast( bits, 'float' ) );
			const d = scenePass.getTextureNode( 'depth' ).sample( uv() ).x;
			const nx = uv().x.mul( 2.0 ).sub( 1.0 ), ny = float( 1.0 ).sub( uv().y.mul( 2.0 ) );
			const vv = post.invProj.mul( vec4( nx, ny, d, 1.0 ) );
			const wp = post.camWorld.mul( vec4( vv.xyz.div( vv.w ), 1.0 ) ).xyz;
			const sceneD = length( wp.sub( post.camPos ) );
			const isSky = reversedDepth ? d.lessThan( 1e-7 ) : d.greaterThan( 0.9999999 );
			const win = bits.greaterThan( uint( 0 ) ).and( isSky.or( vd.lessThan( sceneD ) ) );
			color = select( win, vec4( unpackColor( vr.colorRead.element( idx ) ), 1.0 ), color );

		}


		if ( PLAINS ) {

			// everything above is composed at the reduced resolution, then temporal upscaling
			// (TAAU) accumulates the jittered frames into a full-resolution image — anti-aliasing
			// and upscaling in one pass — and a light contrast-adaptive sharpen restores crispness
			const low = rtt( color, null, null, { resolutionScale: RS } );
			const depthTex = scenePass.getTextureNode( 'depth' );
			const up = taau( low, depthTex, scenePass.getTextureNode( 'velocity' ), camera );
			post.taau = up;
			if ( vr ) vr.jitter = () => { const h = HALTON[ up._jitterIndex % HALTON.length ]; return [ h[ 0 ] - 0.5, h[ 1 ] - 0.5 ]; }; // the voxels jitter with the scene (this frame's offset)
			color = RS < 0.99 ? sharpen( up, 0.75 ) : up;
			// distance softening: real air smears what is far (and the haze takes its colour),
			// so the far plain and ridges are not razor-sharp
			const dD = depthTex.sample( uv() ).x;
			const vv2 = post.invProj.mul( vec4( uv().x.mul( 2.0 ).sub( 1.0 ), float( 1.0 ).sub( uv().y.mul( 2.0 ) ), dD, 1.0 ) );
			const dist2 = length( vv2.xyz.div( vv2.w ) );
			const soft = gaussianBlur( up, 1, 2.0 );
			soft.resolutionScale = 0.5;
			const skyPx = reversedDepth ? dD.lessThan( 1e-7 ) : dD.greaterThan( 0.9999999 );
			color = vec4( mix( color.rgb, soft.rgb, select( skyPx, float( 0.0 ), smoothstep( 900.0, 9000.0, dist2 ).mul( 0.5 ) ) ), 1.0 );

		}

		let col = color.rgb;
		if ( PLAINS ) {

			// by day only a faint halo round the brightest glints (sun on glossy leaves, sunlit
			// cloud rims); nothing at night
			const sheen = bloom( color, 0.1, 0.35, 1.5 );
			post.dayBloom = sheen;
			col = col.add( sheen.rgb );

		}

		// (the plains go without the meadow's bloom: a clean, high-contrast image)
		if ( ! PLAINS ) {

			const glow = bloom( color, 0.22, 0.55, 1.1 );
			post.bloom = glow;
			col = col.add( glow.rgb );

		}

		if ( settings.sunShafts ) {

			// light shafts: bright sky near the sun, radially smeared toward the sun;
			// grass blades and animals cut dark rays into it
			const depth = scenePass.getTextureNode( 'depth' ).x;
			const sky = reversedDepth ? step( depth, 0.00003 ) : step( 0.99997, depth );
			const d = length( uv().sub( post.sunUV ).mul( vec2( post.aspect, 1.0 ) ) );
			const near = smoothstep( 0.55, 0.0, d );
			const src = vec4( color.rgb.mul( sky ).mul( near ), 1.0 );
			const rays = radialBlur( src, { center: post.sunUV, weight: float( 0.6 ), decay: float( 0.965 ), count: 48, exposure: float( 1 ) } );
			col = col.add( rays.rgb.mul( post.shaftAmt ).mul( U.sunColor.mul( 0.25 ).add( 0.2 ) ) );

		}

		if ( settings.painterly ) col = painterly( col );

		// daylight grade (plains only): richer but natural greens, faintly cool shadows and
		// warm highlights, a gentle S-curve (the look of a bright summer day photographed)
		if ( PLAINS ) {

			const day = float( 1.0 ).sub( post.night );
			const l0 = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
			const sat = mix( vec3( l0 ), col, 1.32 ).max( 0.0 );
			const tone = mix( vec3( 0.93, 1.0, 1.06 ), vec3( 1.04, 1.01, 0.95 ), smoothstep( 0.05, 0.6, l0 ) );
			// S-curve around mid grey in log space: deeper shadows, brighter leaf tops
			const curve = l0.add( 1e-4 ).div( 0.16 ).pow( 0.2 ).clamp( 0.45, 1.6 );
			col = mix( col, sat.mul( tone ).mul( curve ), day.mul( 0.85 ) );

		}

		// night grade (plains only): moonlit midnight blue that stays vivid — colours are
		// pushed toward blue rather than greyed, the glowing flowers keep their own hues,
		// and under cloud the blacks are lifted (scattered light, more dynamic range)
		if ( PLAINS ) {

			const lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
			const moon = mix( vec3( lum ).mul( vec3( 0.5, 0.74, 1.4 ) ), col.mul( vec3( 0.7, 0.92, 1.35 ) ), 0.6 );
			const keep = smoothstep( 0.05, 0.22, lum );
			const graded = mix( moon, col, keep );
			// a little extra saturation so the night reads deep blue and the lights vivid
			const gl = dot( graded, vec3( 0.2126, 0.7152, 0.0722 ) );
			const vivid = mix( vec3( gl ), graded, 1.25 ).max( 0.0 );
			col = mix( col, vivid, post.night.mul( 0.75 ) );
			// deep, clean blacks (no grey veil): the darks fall toward blue-black with a toe,
			// so the ground reads black and the glowing flowers and spores stand out on it
			const l2 = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
			const toe = mix( float( 1.0 ), smoothstep( 0.0, 0.12, l2 ).mul( 0.82 ).add( 0.18 ), post.night.mul( mix( 1.0, 0.7, post.cloudy ) ) );
			col = col.mul( toe ).add( vec3( 0.002, 0.004, 0.012 ).mul( post.night ) );

		}

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
		const az = 90 + ( h - 6 ) / 12 * 180 + ( BIOME.sunAzOffset || 0 );
		sky.setAtmosphere( el, az, settings.clouds );
		// eyes adapt at night: lift exposure so the moonlit meadow stays readable
		// daylight is bright: settle at ~0.8 exposure once the sun is up; dawn,
		// dusk and night keep their exposure (night is lifted for readability)
		const day = THREE.MathUtils.smoothstep( el, 4, 16 );
		// eyes adapt at night (more under cloud): the moonlit plains stay readable
		renderer.toneMappingExposure = settings.exposure * ( PLAINS ? 1.18 : 1 ) * ( 1 + U.night.value * ( PLAINS ? BIOME.nightExposure * ( 1 + settings.clouds * 0.6 ) : 0.7 ) ) * THREE.MathUtils.lerp( 1, 0.8, day );
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
		// (the travelling gust waves keep their heading while auto time turns the wind: turning
		// them would swing every wave's phase by its distance from the world origin)
		if ( ! ( PLAINS && settings.autoTime ) ) U.waveDir.value.copy( U.windDir.value );
		U.windStrength.value = settings.wind;
		U.windSpeed.value = 1.5 + settings.wind * 4;

	}

	applySky();
	// start facing the sun (backlit translucent blades are the money shot), or the biome's view
	controls.lookAtAzimuth( BIOME.spawn ? BIOME.spawn.az : sky.az + 12 );
	if ( BIOME.spawn && BIOME.spawn.eye ) controls.eye = controls.eyeTarget = BIOME.spawn.eye;

	// the jaguar appears a few metres ahead, crossing the view
	if ( BIOME.animals ) jaguar._loading = jaguar.load().then( () => {

		const f = new THREE.Vector3( - Math.sin( controls.yaw ), 0, - Math.cos( controls.yaw ) );
		jaguar.place( controls.pos.x + f.x * 11, controls.pos.z + f.z * 11, controls.yaw + Math.PI / 2 );
		if ( settings.view.startsWith( 'third' ) ) setView( settings.view );

	} ).catch( ( e ) => console.warn( 'jaguar failed to load', e ) );

	// a small herd of red deer grazing ahead and to the side
	{

		const a = controls.yaw + 0.5;
		const f = new THREE.Vector3( - Math.sin( a ), 0, - Math.cos( a ) );
		if ( BIOME.animals ) herd.load( new THREE.Vector3( controls.pos.x + f.x * 55, 0, controls.pos.z + f.z * 55 ), 4 )
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
		const c = chars[ v ];
		if ( c && ! c.ready ) {

			// load on first use, appear a few metres ahead of the camera
			if ( ! c._loading ) c._loading = c.load().then( () => {

				const f = new THREE.Vector3( - Math.sin( controls.yaw ), 0, - Math.cos( controls.yaw ) );
				const p = controls.mode === 'third' && chars[ VIEWS[ 0 ] ] ? controls.pos : controls.pos;
				c.place( p.x + f.x * 6, p.z + f.z * 6, controls.yaw );
				c.group.visible = true;
				if ( settings.view === v ) setView( v );

			} ).catch( ( e ) => console.warn( c.name + ' failed to load', e ) );
			return;

		}

		if ( c ) {

			controls.mode = 'third';
			controls._orbitInit = false;
			controls.yaw = c.heading;
			controls.pitch = - 0.22;
			controls.distTarget = controls.dist = c.cfg ? c.cfg.camDist : 8;

		} else {

			controls.mode = 'first';
			controls.eye = controls.eyeTarget = 2.3;
			controls._initialised = false;

		}

	}

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.code === 'KeyV' ) setView( VIEWS[ ( VIEWS.indexOf( settings.view ) + 1 ) % VIEWS.length ] );
		const c = chars[ settings.view ];
		if ( c && c.ready && controls.mode === 'third' && ! e.repeat ) {

			if ( e.code === 'KeyF' ) c.attack();
			if ( e.code === 'KeyG' && c.roar ) c.roar();

		}

	} );

	// ------------------------------------------------------------ gui
	const gui = new GUI( { title: BIOME.name } );
	if ( isMobile || params.has( 'nogui' ) ) gui.close();
	gui.add( settings, 'hour', 0, 24, 0.05 ).name( 'time of day' ).onChange( applySky ).listen();
	gui.add( settings, 'clouds', 0, 1, 0.01 ).onChange( applySky ).listen();
	gui.add( settings, 'wind', 0, 2.5, 0.01 ).onChange( applySky ).listen();
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
	if ( BIOME.animals ) {

		gui.add( settings, 'view', VIEWS ).name( 'view (V)' ).onChange( setView ).listen();
		gui.add( herd.group, 'visible' ).name( 'deer' );

	}

	if ( BIOME.buildGui ) BIOME.buildGui( gui, extras, settings );

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

		const active = chars[ settings.view ];
		const third = controls.mode === 'third' && active && active.ready && ! window.__jaguarFreeze;
		if ( third ) {

			active.update( dt, window.__jaguarInput || controls.moveInput() );
			const h = active.cfg ? active.cfg.camHeight : 1.25;
			controls.updateThird( dt, new THREE.Vector3( active.pos.x, active.pos.y + h, active.pos.z ), active.speed );

		} else controls.update( dt, settings.tour );

		// biome bounds: keep the walker on the plains (soft wall)
		if ( BIOME.walkRadius ) {

			const r = Math.hypot( controls.pos.x, controls.pos.z );
			if ( r > BIOME.walkRadius ) controls.pos.multiplyScalar( BIOME.walkRadius / r );

		}

		const freeze = window.__jaguarFreeze;
		if ( jaguar.ready && ! freeze && ! ( third && active === jaguar ) ) jaguar.update( dt, null, third ? active.pos : controls.pos );
		for ( const c of [ raptor, human ] ) if ( c.ready && c.group.visible && ! freeze && ! ( third && active === c ) ) c.update( dt, null );

		// the followed animal (or the jaguar) pushes grass and casts a soft shadow
		const lead = third ? active : jaguar;
		if ( lead.ready ) {

			if ( lead === jaguar ) setActor( 0, jaguar.pos, 1.6 + Math.min( jaguar.speed, 15 ) * 0.03, 0.9 );
			else setActor( 0, lead.pos, lead.cfg.radius + Math.min( lead.speed, 15 ) * 0.03, lead.cfg.bodyHeight );

		}

		if ( herd.ready && herd.group.visible && ! window.__deerFreeze ) {

			const threats = [];
			if ( jaguar.ready ) threats.push( { pos: jaguar.pos, speed: jaguar.speed, isPredator: true } );
			for ( const c of [ raptor, human ] ) if ( c.ready && c.group.visible ) threats.push( { pos: c.pos, speed: c.speed, isPredator: c.cfg.predator } );
			if ( ! third ) threats.push( { pos: camera.position, speed: controls.speed || 0, isPredator: false } );
			herd.update( dt, threats, third ? active.pos : controls.pos );

		}

		herd.deer.forEach( ( d, i ) => {

			if ( herd.group.visible ) setActor( i + 1, d.pos, d.size * 0.3, d.size * 0.32 );
			else U.actors[ i + 1 ].value.y = - 1e4;

		} );
		sky.update( camera );
		terrain.update( camera );
		if ( extras ) extras.update( renderer, camera, dt );
		grass.update( renderer, camera, controls.pusher );
		midGrass.update( renderer, camera, null );
		farGrass.update( renderer, camera, null );
		if ( settings.flowers && flowers.group.visible ) flowers.update( renderer, camera, controls.pusher );
		pollen.update( camera, controls._groundY );
		if ( PLAINS ) pollen.u.pxK.value = 2 * Math.tan( THREE.MathUtils.degToRad( camera.fov ) * 0.5 ) / Math.max( 1, renderer.getDrawingBufferSize( _dbs ).y * RS );

		if ( Math.abs( camera.fov - ( baseFov + controls.fovKick ) ) > 0.01 ) {

			camera.fov = baseFov + controls.fovKick;
			camera.updateProjectionMatrix();

		}

		if ( audio.enabled ) {

			const who = third ? active.pos : controls.pos;
			const f = fieldsJS( who.x, who.z );
			audio.update( {
				wind: windSample(),
				speed: third ? active.speed : ( controls.speed || 0 ),
				onFoot: third || controls.eye < 2.5,
				steps: third ? active.steps : ( controls.steps || 0 ),
				bob: third ? active.phase * Math.PI * 4 : ( controls.bob || 0 ),
				soft: third,
				grass: Math.min( 1, ( 0.14 + f.tall * 0.91 ) * settings.grassHeight ),
				hour: settings.hour,
				eye: controls.eye,
			} );

		}

		// camera for the screen-space cloud pass
		post.night.value = U.night.value;
		if ( post.dayBloom ) post.dayBloom.strength.value = 0.1 * ( 1 - U.night.value );
		post.cloudy.value = THREE.MathUtils.smoothstep( settings.clouds, 0.3, 0.8 );
		// at night the glowing flowers bloom: a lower threshold and a stronger, wider halo
		if ( post.bloom && PLAINS ) {

			const nt = U.night.value;
			post.bloom.threshold.value = THREE.MathUtils.lerp( 1.1, 0.32, nt );
			post.bloom.strength.value = THREE.MathUtils.lerp( 0.22, 0.6, nt );
			post.bloom.radius.value = THREE.MathUtils.lerp( 0.55, 0.85, nt );

		}

		post.invProj.value.copy( camera.projectionMatrixInverse );
		post.camWorld.value.copy( camera.matrixWorld );
		post.camPos.value.copy( camera.position );

		if ( settings.sunShafts ) {

			const sp = U.trueSunDir.value.clone().multiplyScalar( 1000 ).add( camera.position ).project( camera );
			post.sunUV.value.set( sp.x * 0.5 + 0.5, 1 - ( sp.y * 0.5 + 0.5 ) );
			post.aspect.value = camera.aspect;
			const facing = U.trueSunDir.value.dot( camera.getWorldDirection( new THREE.Vector3() ) );
			const low = 1 - THREE.MathUtils.smoothstep( U.trueSunDir.value.y, 0.25, 0.7 );
			post.shaftAmt.value = THREE.MathUtils.smoothstep( facing, 0.05, 0.45 ) * ( 0.35 + 0.65 * low ) * THREE.MathUtils.smoothstep( U.trueSunDir.value.y, - 0.03, 0.04 ) * 0.9 * ( BIOME.sky && BIOME.sky.volumetric ? 0.35 : 1 );

		}

		if ( PLAINS || settings.bloom || settings.sunShafts || settings.painterly ) pipeline.render();
		else renderer.render( scene, camera );

		if ( firstFrame ) {

			firstFrame = false;
			const l = document.getElementById( 'loading' );
			// (the sunrise loader runs up to 100 % first, then fades in a flash of light)
			Loader.finish().then( () => {

				l.classList.add( 'done' );
				setTimeout( () => l.remove(), 1500 );

			} );

		}

		// fps + simple adaptive quality during the first seconds
		stats.frames ++;
		stats.acc += dt;
		if ( stats.acc > 0.5 ) {

			stats.fps = stats.frames / stats.acc;
			stats.frames = 0; stats.acc = 0;
			let gait = '';
			const act = chars[ settings.view ];
			if ( controls.mode === 'third' && act && act.ready ) {

				const w = act.weights;
				const g = Object.keys( w ).reduce( ( a, b ) => ( w[ b ] > w[ a ] ? b : a ) );
				const st = { down: 'lying down', lying: 'lying', resting: 'resting', toSleep: 'falling asleep', sleeping: 'sleeping', wake: 'waking', up: 'getting up' }[ act.state ];
				const doing = st || ( act.shot ? act.shot.n : act.attackT >= 0 ? 'attack' : g === 'idle' ? ( act.crouch ? 'crouching' : 'standing' ) : g.toLowerCase() );
				gait = ` · ${ act === jaguar ? 'jaguar' : act.name }: ${ doing } ${ act.speed.toFixed( 1 ) } m/s${ controls.autoRun ? ' (run: R)' : '' }`;

			}

			const vxr = extras && extras.vox;
			if ( vxr ) vxr.readStats( renderer );
			hud.textContent = `${ stats.fps.toFixed( 0 ) } fps · ${ ( stats.blades / 1e6 ).toFixed( 2 ) }M blades · ${ settings.quality }${ gait }${ vxr && vxr.visible !== undefined ? ` · ${ ( vxr.visible / 1000 ).toFixed( 0 ) }k voxel plants` : '' }`;

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
	mountWorldSwitch( BIOMES, BIOME );
	if ( BIOME.help !== undefined ) document.querySelector( '#help .desk' ).innerHTML = BIOME.help;
	if ( BIOME.credit !== undefined ) {

		const c = document.getElementById( 'credit' );
		if ( BIOME.credit ) c.innerHTML = BIOME.credit;
		else c.remove();

	}

	window.__meadow = { THREE, U, BIOME, get extras() {

		return extras;

	}, spirits, renderer, scene, camera, controls, settings, applySky, audio, jaguar, herd, raptor, human, setView, terrainHeightJS, setQuality( q ) {

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
