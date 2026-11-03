// Fully procedural soundscape (Web Audio, no audio files):
//  - generative ambient music: slow pad chords + sparse soft bells, long reverb
//  - wind: low rumble + grass "shimmer" whose level follows the same gust field
//    that bends the grass (sampled slightly upwind, so you hear gusts arrive)
//  - wildlife: birds by day, crickets towards evening
//  - you: soft crunchy footsteps synced to the head bob, and a continuous swish
//    of legs brushing through the grass (louder in tall grass, faster when running)

const rand = ( a, b ) => a + Math.random() * ( b - a );
const pickOne = ( arr ) => arr[ Math.floor( Math.random() * arr.length ) ];
const mtof = ( m ) => 440 * Math.pow( 2, ( m - 69 ) / 12 );

export class MeadowAudio {

	constructor() {

		this.ctx = null;
		this.enabled = false;
		this.volumes = { master: 0.8, music: 0.55, nature: 0.8, steps: 0.85 };
		this._lastSteps = null;
		this._nextBird = 0;
		this._nextCricket = 0;
		this._nextBell = 0;
		this._nextChord = 0;
		this._chordIndex = 0;

	}

	// must be called from a user gesture
	async start() {

		if ( this.ctx ) {

			if ( this.ctx.state !== 'running' ) await this.ctx.resume();
			this.setEnabled( true );
			return;

		}

		const AC = window.AudioContext || window.webkitAudioContext;
		if ( ! AC ) return;
		const ctx = this.ctx = new AC( { latencyHint: 'playback' } );

		// ---------------------------------------------------------- busses
		this.out = ctx.createGain();
		this.out.gain.value = 0;
		const comp = ctx.createDynamicsCompressor();
		comp.threshold.value = - 18; comp.knee.value = 20; comp.ratio.value = 3;
		comp.attack.value = 0.02; comp.release.value = 0.4;
		this.out.connect( comp ).connect( ctx.destination );

		this.reverb = ctx.createConvolver();
		this.reverb.buffer = this.makeImpulse( 4.5, 2.6 );
		const revOut = ctx.createGain();
		revOut.gain.value = 0.9;
		this.reverb.connect( revOut ).connect( this.out );

		const bus = ( send ) => {

			const g = ctx.createGain();
			g.connect( this.out );
			const s = ctx.createGain();
			s.gain.value = send;
			g.connect( s ).connect( this.reverb );
			return g;

		};

		this.musicBus = bus( 0.85 );
		this.natureBus = bus( 0.25 );
		this.stepsBus = bus( 0.12 );

		// ---------------------------------------------------------- noise sources
		this.white = this.makeNoise( 'white', 3 );
		this.pink = this.makeNoise( 'pink', 6 );
		this.brown = this.makeNoise( 'brown', 6 );

		this.buildWind();
		this.buildSwish();
		this.applyVolumes();
		this.setEnabled( true );

	}

	setEnabled( on ) {

		this.enabled = on;
		if ( ! this.ctx ) return;
		const t = this.ctx.currentTime;
		this.out.gain.cancelScheduledValues( t );
		this.out.gain.setTargetAtTime( on ? this.volumes.master : 0, t, on ? 1.2 : 0.25 );
		if ( on ) {

			this._nextChord = 0;

		}

	}

	applyVolumes() {

		if ( ! this.ctx ) return;
		const t = this.ctx.currentTime;
		this.musicBus.gain.setTargetAtTime( this.volumes.music, t, 0.3 );
		this.natureBus.gain.setTargetAtTime( this.volumes.nature, t, 0.3 );
		this.stepsBus.gain.setTargetAtTime( this.volumes.steps, t, 0.3 );
		if ( this.enabled ) this.out.gain.setTargetAtTime( this.volumes.master, t, 0.3 );

	}

	// ------------------------------------------------------------ buffers

	makeNoise( type, seconds ) {

		const ctx = this.ctx;
		const len = Math.floor( ctx.sampleRate * seconds );
		const buf = ctx.createBuffer( 2, len, ctx.sampleRate );
		for ( let ch = 0; ch < 2; ch ++ ) {

			const d = buf.getChannelData( ch );
			let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
			for ( let i = 0; i < len; i ++ ) {

				const w = Math.random() * 2 - 1;
				if ( type === 'white' ) d[ i ] = w * 0.5;
				else if ( type === 'pink' ) {

					b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
					b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
					b4 = 0.55 * b4 + w * 0.5329522; b5 = - 0.7616 * b5 - w * 0.016898;
					d[ i ] = ( b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362 ) * 0.11;
					b6 = w * 0.115926;

				} else {

					last = ( last + 0.02 * w ) / 1.02;
					d[ i ] = last * 3.5;

				}

			}

			// crossfade the loop seam
			const fade = Math.floor( ctx.sampleRate * 0.05 );
			for ( let i = 0; i < fade; i ++ ) {

				const a = i / fade;
				d[ i ] = d[ i ] * a + d[ len - fade + i ] * ( 1 - a );

			}

		}

		return buf;

	}

	makeImpulse( seconds, decay ) {

		const ctx = this.ctx;
		const len = Math.floor( ctx.sampleRate * seconds );
		const buf = ctx.createBuffer( 2, len, ctx.sampleRate );
		for ( let ch = 0; ch < 2; ch ++ ) {

			const d = buf.getChannelData( ch );
			let lp = 0;
			for ( let i = 0; i < len; i ++ ) {

				const t = i / len;
				// darker as it decays (air absorption)
				const k = 0.55 - t * 0.45;
				lp += ( ( Math.random() * 2 - 1 ) - lp ) * k;
				const pre = Math.min( 1, i / ( ctx.sampleRate * 0.02 ) );
				d[ i ] = lp * Math.pow( 1 - t, decay ) * pre;

			}

		}

		return buf;

	}

	loop( buffer, offset = 0 ) {

		const src = this.ctx.createBufferSource();
		src.buffer = buffer;
		src.loop = true;
		src.start( 0, offset % buffer.duration );
		return src;

	}

	// ------------------------------------------------------------ wind

	buildWind() {

		const ctx = this.ctx;

		// low body of the wind
		const low = this.loop( this.brown );
		const lowF = ctx.createBiquadFilter();
		lowF.type = 'lowpass'; lowF.frequency.value = 320; lowF.Q.value = 0.5;
		this.windLow = ctx.createGain(); this.windLow.gain.value = 0;
		low.connect( lowF ).connect( this.windLow ).connect( this.natureBus );

		// mid "whoosh" with moving resonance
		const mid = this.loop( this.pink, 2.1 );
		this.windMidF = ctx.createBiquadFilter();
		this.windMidF.type = 'bandpass'; this.windMidF.frequency.value = 700; this.windMidF.Q.value = 0.8;
		this.windMid = ctx.createGain(); this.windMid.gain.value = 0;
		mid.connect( this.windMidF ).connect( this.windMid ).connect( this.natureBus );

		// grass shimmer: airy hiss of millions of blades, stereo-wide
		const hi = this.loop( this.pink, 4.3 );
		const hiF = ctx.createBiquadFilter();
		hiF.type = 'highpass'; hiF.frequency.value = 2200; hiF.Q.value = 0.4;
		const hiShelf = ctx.createBiquadFilter();
		hiShelf.type = 'peaking'; hiShelf.frequency.value = 5200; hiShelf.Q.value = 0.7; hiShelf.gain.value = 4;
		const hiLP = ctx.createBiquadFilter();
		hiLP.type = 'lowpass'; hiLP.frequency.value = 9000;
		this.grassHiss = ctx.createGain(); this.grassHiss.gain.value = 0;
		hi.connect( hiF ).connect( hiShelf ).connect( hiLP ).connect( this.grassHiss ).connect( this.natureBus );

	}

	// ------------------------------------------------------------ movement swish

	buildSwish() {

		const ctx = this.ctx;
		const src = this.loop( this.pink, 1.3 );
		this.swishF = ctx.createBiquadFilter();
		this.swishF.type = 'bandpass'; this.swishF.frequency.value = 2600; this.swishF.Q.value = 0.6;
		const hp = ctx.createBiquadFilter();
		hp.type = 'highpass'; hp.frequency.value = 700;
		this.swish = ctx.createGain(); this.swish.gain.value = 0;
		this.swishPan = ctx.createStereoPanner();
		src.connect( hp ).connect( this.swishF ).connect( this.swish ).connect( this.swishPan ).connect( this.stepsBus );

	}

	// one footstep: soft soil thump + a cluster of crisp grass crunch grains
	step( intensity, grass, side ) {

		const ctx = this.ctx;
		const t0 = ctx.currentTime + 0.005;
		const pan = ctx.createStereoPanner();
		pan.pan.value = side * 0.18;
		pan.connect( this.stepsBus );

		// thump
		const o = ctx.createOscillator();
		o.type = 'sine';
		o.frequency.setValueAtTime( rand( 75, 95 ), t0 );
		o.frequency.exponentialRampToValueAtTime( 45, t0 + 0.12 );
		const og = ctx.createGain();
		og.gain.setValueAtTime( 0, t0 );
		og.gain.linearRampToValueAtTime( 0.22 * intensity, t0 + 0.012 );
		og.gain.exponentialRampToValueAtTime( 0.0001, t0 + 0.16 );
		o.connect( og ).connect( pan );
		o.start( t0 ); o.stop( t0 + 0.2 );

		// crunch grains (dry stems / leaves compressing under the foot)
		const grains = 4 + Math.floor( Math.random() * 5 );
		const crunch = 0.35 + grass * 0.65;
		for ( let i = 0; i < grains; i ++ ) {

			const t = t0 + Math.pow( Math.random(), 1.6 ) * 0.11;
			const dur = rand( 0.018, 0.06 );
			const s = ctx.createBufferSource();
			s.buffer = this.white;
			const f = ctx.createBiquadFilter();
			f.type = 'bandpass';
			f.frequency.value = rand( 1800, 6500 );
			f.Q.value = rand( 0.8, 2.2 );
			const g = ctx.createGain();
			const peak = rand( 0.25, 0.6 ) * intensity * crunch;
			g.gain.setValueAtTime( 0, t );
			g.gain.linearRampToValueAtTime( peak, t + 0.003 );
			g.gain.exponentialRampToValueAtTime( 0.0001, t + dur );
			s.connect( f ).connect( g ).connect( pan );
			s.start( t, Math.random() * 2.5, dur + 0.02 );

		}

		// soft body of the step: filtered noise "hush"
		const b = ctx.createBufferSource();
		b.buffer = this.pink;
		const bf = ctx.createBiquadFilter();
		bf.type = 'bandpass'; bf.frequency.value = rand( 900, 1500 ); bf.Q.value = 0.7;
		const bg = ctx.createGain();
		bg.gain.setValueAtTime( 0, t0 );
		bg.gain.linearRampToValueAtTime( 0.35 * intensity * crunch, t0 + 0.02 );
		bg.gain.exponentialRampToValueAtTime( 0.0001, t0 + 0.24 );
		b.connect( bf ).connect( bg ).connect( pan );
		b.start( t0, Math.random() * 5, 0.3 );

	}

	// ------------------------------------------------------------ wildlife

	bird( dayness ) {

		const ctx = this.ctx;
		const t0 = ctx.currentTime + 0.05;
		const pan = ctx.createStereoPanner();
		pan.pan.value = rand( - 0.9, 0.9 );
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass'; lp.frequency.value = rand( 5000, 9000 ); // distance
		const g = ctx.createGain();
		g.gain.value = rand( 0.025, 0.07 ) * dayness;
		lp.connect( g ).connect( pan ).connect( this.natureBus );

		const kind = Math.random();
		const base = rand( 2300, 4200 );
		let t = t0;
		const chirp = ( f0, f1, dur, amp ) => {

			const o = ctx.createOscillator();
			o.type = 'sine';
			o.frequency.setValueAtTime( f0, t );
			o.frequency.exponentialRampToValueAtTime( f1, t + dur );
			const e = ctx.createGain();
			e.gain.setValueAtTime( 0, t );
			e.gain.linearRampToValueAtTime( amp, t + dur * 0.15 );
			e.gain.exponentialRampToValueAtTime( 0.0001, t + dur );
			o.connect( e ).connect( lp );
			o.start( t ); o.stop( t + dur + 0.02 );

		};

		if ( kind < 0.4 ) {

			// melodic whistles (blackbird-ish phrase)
			const n = 3 + Math.floor( Math.random() * 4 );
			for ( let i = 0; i < n; i ++ ) {

				const f = base * rand( 0.7, 1.25 ) * 0.7;
				const d = rand( 0.12, 0.3 );
				chirp( f, f * rand( 0.85, 1.25 ), d, 1 );
				t += d + rand( 0.03, 0.12 );

			}

		} else if ( kind < 0.75 ) {

			// rapid trill (lark / finch)
			const n = 8 + Math.floor( Math.random() * 14 );
			const d = rand( 0.035, 0.06 );
			for ( let i = 0; i < n; i ++ ) {

				chirp( base * 1.15, base * 0.8, d, 0.7 + 0.3 * Math.sin( i ) );
				t += d * rand( 1.2, 1.6 );

			}

		} else {

			// two-note call, repeated
			const reps = 2 + Math.floor( Math.random() * 3 );
			for ( let i = 0; i < reps; i ++ ) {

				chirp( base, base * 1.3, 0.09, 1 );
				t += 0.12;
				chirp( base * 0.8, base * 0.75, 0.16, 0.8 );
				t += rand( 0.35, 0.6 );

			}

		}

	}

	cricket( night ) {

		const ctx = this.ctx;
		const t0 = ctx.currentTime + 0.02;
		const pan = ctx.createStereoPanner();
		pan.pan.value = rand( - 0.8, 0.8 );
		const g = ctx.createGain();
		g.gain.value = rand( 0.008, 0.022 ) * night;
		g.connect( pan ).connect( this.natureBus );
		const f = rand( 4200, 5200 );
		const pulses = 3 + Math.floor( Math.random() * 3 );
		const groups = 2 + Math.floor( Math.random() * 4 );
		let t = t0;
		for ( let gi = 0; gi < groups; gi ++ ) {

			for ( let i = 0; i < pulses; i ++ ) {

				const o = ctx.createOscillator();
				o.frequency.value = f;
				const e = ctx.createGain();
				e.gain.setValueAtTime( 0, t );
				e.gain.linearRampToValueAtTime( 1, t + 0.004 );
				e.gain.linearRampToValueAtTime( 0, t + 0.018 );
				o.connect( e ).connect( g );
				o.start( t ); o.stop( t + 0.025 );
				t += 0.032;

			}

			t += rand( 0.25, 0.45 );

		}

	}

	// ------------------------------------------------------------ music

	// D major-ish, lydian colour: lush but calm
	static CHORDS = [
		[ 50, 57, 62, 64, 66, 69 ], // Dmaj9
		[ 47, 54, 59, 62, 66, 69 ], // Bm11
		[ 43, 50, 57, 59, 62, 66 ], // Gmaj9
		[ 45, 52, 57, 59, 64, 66 ], // A(add9/6)
		[ 42, 49, 54, 57, 61, 64 ], // F#m9
		[ 43, 50, 55, 59, 62, 69 ], // Gadd9
	];

	static PROGRESSION = [ 0, 2, 1, 3, 0, 4, 5, 3 ];

	static SCALE = [ 74, 76, 78, 81, 83, 86, 88, 90 ]; // D E F# A B D E F#

	pad( notes, dur ) {

		const ctx = this.ctx;
		const t0 = ctx.currentTime + 0.05;
		const atk = 5, rel = 7;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.setValueAtTime( 500, t0 );
		lp.frequency.linearRampToValueAtTime( 1400, t0 + atk + dur * 0.4 );
		lp.frequency.linearRampToValueAtTime( 600, t0 + dur + rel );
		lp.Q.value = 0.3;
		const env = ctx.createGain();
		env.gain.setValueAtTime( 0, t0 );
		env.gain.linearRampToValueAtTime( 0.07, t0 + atk );
		env.gain.setValueAtTime( 0.07, t0 + dur );
		env.gain.linearRampToValueAtTime( 0, t0 + dur + rel );
		lp.connect( env ).connect( this.musicBus );

		for ( const m of notes ) {

			for ( const [ type, det, amp ] of [ [ 'sine', - 5, 1 ], [ 'triangle', 6, 0.45 ], [ 'sine', 1200.5, 0.08 ] ] ) {

				const o = ctx.createOscillator();
				o.type = type;
				o.frequency.value = mtof( m );
				o.detune.value = det + rand( - 2, 2 );
				// slow vibrato-free drift
				const lfo = ctx.createOscillator();
				lfo.frequency.value = rand( 0.05, 0.15 );
				const lg = ctx.createGain();
				lg.gain.value = 3;
				lfo.connect( lg ).connect( o.detune );
				const vg = ctx.createGain();
				vg.gain.value = amp * ( m < 48 ? 0.8 : 0.55 );
				const pan = ctx.createStereoPanner();
				pan.pan.value = rand( - 0.6, 0.6 );
				o.connect( vg ).connect( pan ).connect( lp );
				const end = t0 + dur + rel + 0.1;
				o.start( t0 ); o.stop( end );
				lfo.start( t0 ); lfo.stop( end );

			}

		}

	}

	bell( midi ) {

		const ctx = this.ctx;
		const t0 = ctx.currentTime + 0.05;
		const f = mtof( midi );
		const pan = ctx.createStereoPanner();
		pan.pan.value = rand( - 0.5, 0.5 );
		pan.connect( this.musicBus );
		const amp = rand( 0.035, 0.06 );
		// soft mallet: fundamental + gentle inharmonic partials, quick decay on highs
		for ( const [ ratio, a, d ] of [ [ 1, 1, 3.8 ], [ 2.0, 0.25, 1.6 ], [ 3.01, 0.08, 0.9 ], [ 4.2, 0.04, 0.5 ] ] ) {

			const o = ctx.createOscillator();
			o.type = 'sine';
			o.frequency.value = f * ratio;
			const g = ctx.createGain();
			g.gain.setValueAtTime( 0, t0 );
			g.gain.linearRampToValueAtTime( amp * a, t0 + 0.015 );
			g.gain.exponentialRampToValueAtTime( 0.0001, t0 + d );
			o.connect( g ).connect( pan );
			o.start( t0 ); o.stop( t0 + d + 0.05 );

		}

	}

	// ------------------------------------------------------------ per-frame

	/**
	 * @param {object} s  { wind: 0..~1.2 local gust strength, speed: m/s,
	 *   onFoot: bool, steps: int counter, grass: 0..1 local grass height,
	 *   hour: 0..24, eye: metres above ground }
	 */
	update( s ) {

		if ( ! this.ctx || ! this.enabled || this.ctx.state !== 'running' ) return;
		const ctx = this.ctx;
		const now = ctx.currentTime;

		// --- wind: fly higher -> more wind body, less grass hiss
		const high = Math.min( 1, Math.max( 0, ( s.eye - 2 ) / 15 ) );
		const w = s.wind;
		this.windLow.gain.setTargetAtTime( ( 0.05 + w * 0.22 ) * ( 1 + high * 1.5 ), now, 0.4 );
		this.windMid.gain.setTargetAtTime( ( 0.015 + w * w * 0.12 ) * ( 1 + high ), now, 0.35 );
		this.windMidF.frequency.setTargetAtTime( 450 + w * 900, now, 0.5 );
		this.grassHiss.gain.setTargetAtTime( ( 0.01 + w * w * 0.16 ) * ( 1 - high * 0.7 ), now, 0.25 );

		// --- movement swish (legs through grass), pulsing with the stride
		const move = Math.min( 1, s.speed / 2.5 ) * ( s.onFoot ? 1 : 0 );
		const strideWave = 0.55 + 0.45 * Math.abs( Math.sin( s.bob || 0 ) );
		const swish = move * ( 0.15 + s.grass * 0.85 ) * strideWave * ( s.speed > 3 ? 1.35 : 1 );
		this.swish.gain.setTargetAtTime( swish * 0.32, now, 0.06 );
		this.swishF.frequency.setTargetAtTime( 1800 + Math.min( s.speed, 9 ) * 260 + strideWave * 600, now, 0.08 );
		this.swishPan.pan.setTargetAtTime( Math.sin( s.bob || 0 ) * 0.25, now, 0.08 );

		// --- footsteps on each new strike
		if ( this._lastSteps === null ) this._lastSteps = s.steps;
		if ( s.steps !== this._lastSteps ) {

			if ( s.onFoot && s.speed > 0.15 ) {

				// paws are soft: fewer crunches, gentler thump, more of them per second
				const intensity = Math.min( 1.25, 0.45 + s.speed * 0.12 ) * ( s.soft ? 0.5 : 1 );
				this.step( intensity, s.grass, s.steps % 2 ? 1 : - 1 );

			}

			this._lastSteps = s.steps;

		}

		// --- wildlife by time of day
		const h = s.hour;
		const day = Math.max( 0, Math.min( 1, ( h - 5.2 ) / 1.5 ) ) * Math.max( 0, Math.min( 1, ( 20.5 - h ) / 1.5 ) );
		const dawnChorus = Math.exp( - Math.pow( ( h - 7 ) / 1.6, 2 ) ) * 0.8;
		const night = Math.max( 0, Math.min( 1, ( h - 16.5 ) / 2.5 ) ) + Math.max( 0, Math.min( 1, ( 6.5 - h ) / 1.5 ) );

		if ( now > this._nextBird && day > 0.05 ) {

			this.bird( Math.min( 1, day * 0.8 + dawnChorus ) );
			this._nextBird = now + rand( 2.5, 9 ) / ( 0.6 + dawnChorus * 1.5 + day * 0.4 );

		}

		if ( now > this._nextCricket && night > 0.05 ) {

			this.cricket( Math.min( 1, night ) );
			this._nextCricket = now + rand( 0.15, 0.9 ) / Math.min( 1, night + 0.2 );

		}

		// --- music
		if ( now > this._nextChord ) {

			const prog = MeadowAudio.PROGRESSION;
			const chord = MeadowAudio.CHORDS[ prog[ this._chordIndex % prog.length ] ];
			this._chordIndex ++;
			const dur = rand( 11, 15 );
			this.pad( chord, dur );
			this._nextChord = now + dur + 1.5; // overlap with the release tail
			this._chordNotes = chord;

		}

		if ( now > this._nextBell ) {

			// gentle melodic fragments drawn from the scale, favouring chord tones
			const chordPcs = ( this._chordNotes || [] ).map( ( m ) => m % 12 );
			const scale = MeadowAudio.SCALE;
			const pool = scale.filter( ( m ) => chordPcs.includes( m % 12 ) );
			const n = 1 + Math.floor( Math.random() * 3 );
			let idx = Math.floor( Math.random() * scale.length );
			for ( let i = 0; i < n; i ++ ) {

				const m = Math.random() < 0.6 && pool.length ? pickOne( pool ) : scale[ idx ];
				setTimeout( () => this.ctx && this.bell( m ), i * rand( 350, 700 ) );
				idx = Math.max( 0, Math.min( scale.length - 1, idx + pickOne( [ - 2, - 1, 1, 2 ] ) ) );

			}

			this._nextBell = now + rand( 3.5, 9 );

		}

	}

}
