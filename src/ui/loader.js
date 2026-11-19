// The plains loader: sunrise on the Paine massif. Progress is real: each loading stage
// has a weight, reports its own fraction (bytes for the plant data), and creeps forward
// while it runs so the bar never stalls; the number on screen eases toward the target.
// As it climbs, the peaks' outline draws itself, alpenglow rises up the granite towers,
// the stars fade, and flowering plants sprout along the lake shore.

const STAGES = {
	boot: [ 0.04, 'waking the GPU' ],
	terrain: [ 0.1, 'reading the valley' ],
	world: [ 0.08, 'laying out the plains' ],
	mountains: [ 0.18, 'raising the Cuernos' ],
	plants: [ 0.32, 'growing oleanders and olives' ],
	scene: [ 0.08, 'scattering the flora' ],
	shaders: [ 0.2, 'waiting for first light' ],
};
const ORDER = Object.keys( STAGES );

const el = document.getElementById( 'loading' );
const active = !! ( el && el.classList.contains( 'pl' ) );
const frac = Object.fromEntries( ORDER.map( ( k ) => [ k, 0 ] ) );
let current = null, shown = 0, started = 0, finished = false, last = 0, finishAt = 0, finishFrom = 0;

function target() {

	let p = 0;
	for ( const k of ORDER ) p += STAGES[ k ][ 0 ] * frac[ k ];
	return Math.min( 1, p );

}

const SHORE_COLS = [ '#ff6b8b', '#ffd36b', '#ffffff', '#b78bff', '#ff8a5c', '#7fb8ff', '#ff4f6d', '#f7c4ff' ];
let shore = [];

function setup() {

	const stars = el.querySelector( '.stars' );
	for ( let i = 0; i < 90; i ++ ) {

		const s = document.createElement( 'i' );
		const r = Math.random();
		s.style.cssText = `left:${ Math.random() * 100 }%;top:${ Math.pow( Math.random(), 1.4 ) * 100 }%;animation-delay:${ - Math.random() * 3 }s;animation-duration:${ 2 + Math.random() * 3 }s;` +
			( r < 0.15 ? 'width:3px;height:3px;' : r > 0.7 ? 'width:1px;height:1px;' : '' );
		stars.appendChild( s );

	}

	const sh = el.querySelector( '.shore' );
	const n = Math.round( Math.min( 46, window.innerWidth / 30 ) );
	for ( let i = 0; i < n; i ++ ) {

		const w = document.createElement( 'span' ), b = document.createElement( 'b' );
		const x = ( i + 0.5 + ( Math.random() - 0.5 ) * 0.8 ) / n;
		w.style.left = ( x * 100 ) + '%';
		w.style.animationDelay = ( - Math.random() * 3.6 ).toFixed( 2 ) + 's';
		w.appendChild( b );
		b.style.height = ( 1.6 + Math.random() * 3.6 ) + 'vh';
		b.style.setProperty( '--c', SHORE_COLS[ i % SHORE_COLS.length ] );
		b.dataset.at = ( 0.06 + Math.random() * 0.86 ).toFixed( 3 ); // sprouts when progress passes this
		sh.appendChild( w );
		shore.push( b );

	}

	const line = document.getElementById( 'ldLine' );
	line.dataset.len = line.getTotalLength();
	line.style.strokeDasharray = line.dataset.len;
	line.style.strokeDashoffset = line.dataset.len;
	started = performance.now();
	requestAnimationFrame( tick );

}

function paint( p ) {

	if ( ! document.getElementById( 'ldPct' ) ) return; // loader already gone
	el.style.setProperty( '--p', p.toFixed( 4 ) );
	el.setAttribute( 'aria-valuenow', Math.round( p * 100 ) );
	document.getElementById( 'ldPct' ).textContent = Math.floor( p * 100 );
	const line = document.getElementById( 'ldLine' );
	line.style.strokeDashoffset = ( line.dataset.len * ( 1 - Math.min( 1, p * 1.25 ) ) ).toFixed( 1 );
	// alpenglow: first light catches the summits and creeps down the granite
	document.getElementById( 'ldRise' ).setAttribute( 'height', ( 40 + 420 * Math.pow( p, 1.1 ) ).toFixed( 1 ) );
	for ( const b of shore ) if ( ! b.grown && p >= + b.dataset.at ) {

		b.grown = true;
		b.style.setProperty( '--g', ( 0.75 + Math.random() * 0.25 ).toFixed( 2 ) );

	}

}

function tick( now = performance.now() ) {

	if ( ! active || ! document.getElementById( 'ldPct' ) ) return;
	const dt = Math.min( 0.25, ( now - ( last || now ) ) / 1000 );
	last = now;
	// the running stage creeps toward (never reaching) its end while it works
	if ( current && frac[ current ] < 0.92 ) frac[ current ] += ( 0.92 - frac[ current ] ) * ( 1 - Math.exp( - dt * 0.7 ) );
	if ( finished ) {

		// the last stretch to 100 % in a fixed, short time, however slow the frames are
		const k = Math.min( 1, ( now - finishAt ) / 650 );
		shown = finishFrom + ( 1 - finishFrom ) * ( 1 - Math.pow( 1 - k, 3 ) );

	} else {

		shown += ( target() - shown ) * ( 1 - Math.exp( - dt * 5 ) );

	}

	paint( shown );
	if ( ! ( finished && shown >= 1 ) ) requestAnimationFrame( tick );

}

// yield one frame so the loader can paint before a long synchronous step
const breathe = () => new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r, 0 ) ) );

export const Loader = {

	active,
	// enter a stage (earlier stages are complete); resolves after a paint
	async stage( name, message ) {

		if ( ! active ) return;
		const i = ORDER.indexOf( name );
		for ( let k = 0; k < i; k ++ ) frac[ ORDER[ k ] ] = 1;
		current = name;
		const m = document.getElementById( 'ldMsg' );
		if ( m ) m.textContent = message || STAGES[ name ][ 1 ];
		await breathe();

	},
	// fractional progress within the current (or a named) stage
	progress( f, name = current ) {

		if ( ! active || ! name ) return;
		frac[ name ] = Math.max( frac[ name ], Math.min( 1, f ) );

	},
	message( text ) {

		const m = active && document.getElementById( 'ldMsg' );
		if ( m ) m.textContent = text;

	},
	// all done: run up to 100 %, then the caller fades the loader
	finish() {

		if ( ! active ) return Promise.resolve();
		for ( const k of ORDER ) frac[ k ] = 1;
		finished = true;
		finishAt = performance.now(); finishFrom = shown;
		const m = document.getElementById( 'ldMsg' );
		if ( m ) m.textContent = 'first light';
		return new Promise( ( r ) => setTimeout( () => {

			paint( 1 );
			r();

		}, 750 ) );

	},

};

if ( active ) setup();
