// Time of day + slowly evolving weather ("auto time").
//
// A full day lasts DAY_SECONDS of real time, but the clock slows down while the
// sun is near the horizon so dawn and dusk get much more screen time. Clouds,
// wind, the morning inversion and floating particles drift on smooth noise, with
// mist favouring the hours around sunrise (and, more rarely, late evening).

import { vnoiseJS } from './tsl/noise.js';

export const DAY_SECONDS = 12 * 60;

// Sun elevation (deg) for an hour of the day. The power curve flattens the arc
// near the horizon, so the golden / blue hours last longer even at a fixed rate.
export function sunElevation( h ) {

	const s = Math.sin( Math.PI * ( h - 6 ) / 12 );
	return 58 * Math.sign( s ) * Math.pow( Math.abs( s ), 2.0 );

}

const smooth = ( a, b, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

// relative clock speed: slower near the horizon
const slow = ( h ) => 0.42 + 0.88 * smooth( 3, 16, Math.abs( sunElevation( h ) ) );

// hours per real second at slow() == 1, so that a whole day takes DAY_SECONDS
const BASE_RATE = ( () => {

	let inv = 0;
	const n = 2400;
	for ( let i = 0; i < n; i ++ ) inv += ( 24 / n ) / slow( ( i + 0.5 ) * 24 / n );
	return inv / DAY_SECONDS;

} )();

// smooth 1D noise in 0..1
const n1 = ( x, seed ) => vnoiseJS( x, seed * 17.3 + 0.5 );

const gauss = ( x, mu, sigma ) => Math.exp( - Math.pow( ( x - mu ) / sigma, 2 ) );

export class Weather {

	constructor() {

		this.t = 0;
		this.baseWindAngle = null;

	}

	/** Advances settings in place when settings.autoTime is on. */
	update( dt, settings ) {

		if ( ! settings.autoTime ) return false;
		if ( this.baseWindAngle === null ) this.baseWindAngle = settings.windAngle;

		this.t += dt;
		const t = this.t;
		settings.hour = ( settings.hour + dt * BASE_RATE * slow( settings.hour ) ) % 24;
		const h = settings.hour;

		settings.clouds = 0.08 + 0.8 * Math.pow( n1( t / 160, 1 ), 1.3 );
		settings.wind = 0.3 + 1.0 * n1( t / 75, 2 );
		settings.windAngle = ( this.baseWindAngle + 70 * ( n1( t / 220, 3 ) - 0.5 ) + 360 ) % 360;

		// mist: mostly around sunrise, on some days more than others
		const morning = gauss( h, 6.6, 1.6 ) + 0.35 * gauss( h, 20.8, 1.2 );
		const mood = n1( t / 260, 4 );
		settings.mist = Math.min( 1, morning * ( 0.15 + 1.1 * mood ) );

		// floating particles: livelier around golden hours and at night (spores)
		const golden = gauss( h, 6.8, 1.3 ) + gauss( h, 18.6, 1.3 );
		settings.particles = Math.min( 1, 0.25 + 0.5 * n1( t / 60, 5 ) + 0.35 * golden );

		// wind spirits: a twilight phenomenon — they gather around sunset and before
		// sunrise, only rarely deep in the night, never by day; usually ~0.1, never > 0.2
		const twilight = gauss( h, 5.5, 0.75 ) + gauss( h, 19.0, 0.8 );
		const deepNight = ( h > 21 || h < 3.5 ) ? 1 : 0;
		const rare = deepNight * smooth( 0.82, 0.95, n1( t / 300, 8 ) ) * 0.06;
		const target = Math.min( 0.2, twilight * ( 0.03 + 0.15 * n1( t / 170, 7 ) ) + rare );
		// gather / disperse slowly
		this.spirits = ( this.spirits ?? 0 ) + ( target - ( this.spirits ?? 0 ) ) * ( 1 - Math.exp( - dt / 25 ) );
		settings.spiritAmount = this.spirits;

		return true;

	}

}
