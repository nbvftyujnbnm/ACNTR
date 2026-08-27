/**
 * Music.js — ACNTR's adaptive score. Fully synthesised, no samples.
 *
 * The score is four stems that are always *scheduled in the same musical grid*
 * and crossfaded by combat intensity, so the transition between exploring and
 * being shot at is a change of texture rather than a change of track:
 *
 *   0 ambient   sparse pad, sub pedal, distant metallic pings
 *   1 rhythm    driving 16th pulse + industrial percussion
 *   2 high      aggressive distorted lead + heavy drums
 *   3 boss      choir-ish pad + brass stabs + taiko
 *
 * Harmony is E Phrygian over an eight-bar progression (i - bII - i - bVI -
 * bVII). The flat-second is the whole reason Phrygian sounds like this genre;
 * the pedal E underneath keeps it menacing rather than merely sad.
 *
 * Timing uses the standard lookahead pattern: a `setTimeout` clock wakes up
 * often and schedules every event that falls inside the next window against
 * `AudioContext.currentTime`. The audio clock is never driven by `setInterval`.
 */

/** E1. Everything is expressed as semitones above this. */
const ROOT = 41.203;

/** E Phrygian: 1 b2 b3 4 5 b6 b7. */
const SCALE = [0, 1, 3, 5, 7, 8, 10];

/**
 * Eight bars. `chord` is semitone offsets from ROOT; `bass` is the pedal note.
 * i / i / bII / bII / i / bVI / bVII / bII
 */
const PROG = [
  { bass: 0, chord: [12, 15, 19, 22] },
  { bass: 0, chord: [12, 15, 19, 22] },
  { bass: 1, chord: [13, 17, 20, 24] },
  { bass: 1, chord: [13, 17, 20, 24] },
  { bass: 0, chord: [12, 15, 19, 22] },
  { bass: 8, chord: [8, 12, 15, 19] },
  { bass: 10, chord: [10, 13, 17, 22] },
  { bass: 1, chord: [13, 17, 20, 24] },
];

/** 16th-note accent map for the driving pulse. */
const PULSE = [1.0, 0.34, 0.55, 0.36, 0.82, 0.34, 0.58, 0.4, 0.95, 0.34, 0.55, 0.36, 0.8, 0.42, 0.62, 0.52];

/** Kick patterns — alternated per bar so the groove never sits still. */
const KICK_A = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
const KICK_B = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/** Lead riffs, indices into SCALE (null = rest). Chosen per bar. */
const RIFF = [
  [0, null, null, 0, null, 1, null, 0, null, null, 2, null, 1, null, 0, null],
  [0, null, 2, null, 1, null, 0, null, 4, null, 3, null, 2, null, 0, null],
  [6, null, 5, null, 4, null, 2, null, 1, null, 0, null, null, 0, 0, null],
  [0, 0, null, 3, null, 2, null, 1, 0, null, null, 5, null, 4, null, 2],
];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1));
  return t * t * (3 - 2 * t);
};

export class Music {
  /**
   * @param {AudioContext} ctx
   * @param {import('./Synth.js').Synth} S
   * @param {AudioNode} out music bus
   * @param {AudioNode|null} reverbSend optional global reverb send
   */
  constructor(ctx, S, out, reverbSend = null) {
    this.ctx = ctx;
    this.S = S;
    this.out = out;

    this.bpm = 138;
    this.stepDur = 60 / this.bpm / 4; // 16th note
    this.lookahead = 0.16;
    this.tickMs = 26;

    this.step = 0;
    this.nextStepTime = 0;
    this._timer = 0;
    this._running = false;

    this.intensity = 0;
    this._intensity = 0;
    this.boss = 0;
    this._boss = 0;

    // --- stems -------------------------------------------------------------
    this.layers = {};
    for (const name of ['ambient', 'rhythm', 'high', 'boss']) {
      const g = S.gain(name === 'ambient' ? 1 : 0);
      g.connect(out);
      this.layers[name] = g;
    }

    // A shared verb send: the score sits in the same hall as the world.
    this.send = null;
    if (reverbSend) {
      this.send = S.gain(0.24);
      this.send.connect(reverbSend);
      for (const name in this.layers) this.layers[name].connect(this.send);
    }

    // Cached level snapshot so we can skip scheduling silent stems entirely.
    this._lv = { ambient: 1, rhythm: 0, high: 0, boss: 0 };
  }

  // ------------------------------------------------------------- transport --

  start() {
    if (this._running) return;
    this._running = true;
    this.nextStepTime = this.ctx.currentTime + 0.08;
    this._tick();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = 0;
  }

  /** Lookahead scheduler. Never touches the audio clock from a timer callback. */
  _tick() {
    if (!this._running) return;
    const now = this.ctx.currentTime;

    // A backgrounded tab can stall the timer for seconds; resync rather than
    // dumping a burst of late notes into the graph.
    if (this.nextStepTime < now - 0.4) this.nextStepTime = now + 0.05;

    let guard = 0;
    while (this.nextStepTime < now + this.lookahead && guard++ < 64) {
      try {
        this._schedule(this.step, this.nextStepTime);
      } catch (e) {
        /* one bad step must never kill the transport */
      }
      this.step = (this.step + 1) % (16 * PROG.length);
      this.nextStepTime += this.stepDur;
    }

    this._timer = setTimeout(() => this._tick(), this.tickMs);
  }

  // -------------------------------------------------------------- dynamics --

  /** @param {number} x 0..1 combat intensity */
  setIntensity(x) {
    this.intensity = clamp01(x);
  }

  /** @param {boolean} on boss/major-target encounter */
  setBoss(on) {
    this.boss = on ? 1 : 0;
  }

  /**
   * Smooth the intensity and crossfade the stems. Called from the frame loop —
   * the crossfade is a control-rate ramp, never a step change.
   */
  update(dt) {
    if (!this.ctx) return;
    const k = 1 - Math.exp(-1.1 * Math.max(0.0001, dt));
    this._intensity += (this.intensity - this._intensity) * k;
    this._boss += (this.boss - this._boss) * (1 - Math.exp(-0.7 * dt));

    const i = this._intensity;
    const b = this._boss;

    // Ambient never disappears entirely — it is the glue under the other stems.
    const lv = {
      ambient: (1 - smooth(0.15, 0.55, i) * 0.72) * (1 - b * 0.35),
      rhythm: smooth(0.1, 0.42, i),
      high: smooth(0.44, 0.82, i) * (1 - b * 0.25),
      boss: b * (0.45 + 0.55 * smooth(0.1, 0.6, i)),
    };
    this._lv = lv;

    const t = this.ctx.currentTime;
    for (const name in this.layers) {
      this.layers[name].gain.setTargetAtTime(lv[name], t, 0.45);
    }
  }

  // ----------------------------------------------------------- composition --

  /** Semitones above ROOT -> Hz. */
  _hz(semi) {
    return ROOT * Math.pow(2, semi / 12);
  }

  /** Scale degree (can exceed the octave) -> semitones above ROOT. */
  _deg(d, oct = 0) {
    const n = SCALE.length;
    const o = Math.floor(d / n) + oct;
    return SCALE[((d % n) + n) % n] + o * 12;
  }

  _schedule(step, t) {
    const bar = Math.floor(step / 16) % PROG.length;
    const s = step % 16;
    const P = PROG[bar];
    const lv = this._lv;

    if (lv.ambient > 0.02) this._ambient(t, s, bar, P);
    if (lv.rhythm > 0.02) this._rhythm(t, s, bar, P);
    if (lv.high > 0.02) this._high(t, s, bar, P);
    if (lv.boss > 0.02) this._bossLayer(t, s, bar, P);
  }

  // --- stem 0: ambient -----------------------------------------------------

  _ambient(t, s, bar, P) {
    const S = this.S;
    const dest = this.layers.ambient;
    const barDur = this.stepDur * 16;

    if (s === 0) {
      // Wide, slow pad on the chord — the harmonic bed.
      for (let i = 0; i < P.chord.length; i++) {
        const f = this._hz(P.chord[i] + 12);
        const g = S.gain(0.09 / (1 + i * 0.3));
        g.connect(dest);
        S.stack(t, {
          type: 'sawtooth', freq: f, count: 4, spread: 9,
          dur: barDur * 1.4, gain: 0.5, attack: barDur * 0.45,
          hold: barDur * 0.4, filterFreq: 480 + i * 180, filterTo: 900 + i * 260, q: 2.5,
        }).connect(g);
      }
    }

    if (s === 0 && bar % 2 === 0) {
      // Sub pedal, two bars long.
      const g = S.gain(0.24);
      g.connect(dest);
      S.tone(t, {
        type: 'sine', freq: this._hz(P.bass), dur: barDur * 2,
        gain: 0.6, attack: 0.35, hold: barDur * 1.2, drive: 1.6,
      }).connect(g);
    }

    // Sparse metallic pings drifting through the hall.
    if ((s === 6 || s === 13) && Math.random() < 0.22) {
      const g = S.gain(0.05);
      g.connect(dest);
      const d = this._deg(Math.floor(Math.random() * 5), 3);
      S.modal(t, {
        freq: this._hz(P.bass + d), partials: [1, 2.01, 3.03, 4.6],
        decay: 1.6, decaySpread: 0.7, q: 34, gain: 0.5,
      }).connect(g);
    }

    // A low breath of filtered noise every four bars keeps it from feeling static.
    if (s === 0 && bar % 4 === 0) {
      const g = S.gain(0.07);
      g.connect(dest);
      S.noiseBurst(t, {
        source: 'pink', type: 'bandpass', freq: 320, freqTo: 900, q: 1.4,
        dur: barDur * 2, gain: 0.5, attack: barDur * 0.7,
      }).connect(g);
    }
  }

  // --- stem 1: rhythm ------------------------------------------------------

  _rhythm(t, s, bar, P) {
    const S = this.S;
    const dest = this.layers.rhythm;
    const kick = (bar % 2 === 0 ? KICK_A : KICK_B)[s];

    // Driving 16th pulse — the spine of the combat music.
    const acc = PULSE[s];
    if (acc > 0.3) {
      const g = S.gain(0.075 * acc);
      g.connect(dest);
      const f = this._hz(P.bass + 24);
      S.stack(t, {
        type: 'square', freq: f, count: 2, spread: 8, dur: this.stepDur * 0.9,
        gain: 0.55, attack: 0.002, filterFreq: 900 + acc * 2600,
        filterTo: 500, q: 5, drive: 1.8,
      }).connect(g);
    }

    if (kick) this._kick(t, dest, 0.5);

    // Industrial metal hit on the backbeat — struck plate, not a snare.
    if (s === 4 || s === 12) {
      const g = S.gain(0.16);
      g.connect(dest);
      S.modal(t, {
        freq: 640 * (0.94 + Math.random() * 0.12),
        partials: [1, 1.62, 2.31, 3.4, 4.7], decay: 0.3, q: 18, gain: 0.6,
      }).connect(g);
      S.noiseBurst(t, {
        source: 'brown', type: 'bandpass', freq: 420, q: 1.2,
        dur: 0.1, gain: 0.4, drive: 2,
      }).connect(g);
    }

    // Offbeat hats.
    if (s % 2 === 1) {
      const g = S.gain(0.05 * (s % 4 === 3 ? 1.3 : 0.8));
      g.connect(dest);
      S.noiseBurst(t, {
        type: 'highpass', freq: 7000, dur: 0.035, gain: 0.5, attack: 0.0008, curve: 'lin',
      }).connect(g);
    }

    // End-of-phrase riser.
    if (bar === PROG.length - 1 && s === 12) {
      const g = S.gain(0.12);
      g.connect(dest);
      S.noiseBurst(t, {
        source: 'pink', freq: 500, freqTo: 5200, q: 3, dur: this.stepDur * 4,
        gain: 0.6, attack: this.stepDur * 3.6, curve: 'lin',
      }).connect(g);
    }
  }

  // --- stem 2: high intensity ---------------------------------------------

  _high(t, s, bar, P) {
    const S = this.S;
    const dest = this.layers.high;

    // Reinforced kick.
    if (s === 0 || s === 8 || (bar % 2 === 1 && s === 14)) {
      this._kick(t, dest, 0.85, true);
    }

    // Snare on the backbeat: noise body plus a tuned crack.
    if (s === 4 || s === 12) {
      const g = S.gain(0.2);
      g.connect(dest);
      S.noiseBurst(t, {
        type: 'bandpass', freq: 1900, q: 0.9, dur: 0.17, gain: 0.7, drive: 2.4,
      }).connect(g);
      S.tone(t, {
        type: 'triangle', freq: 210, freqTo: 150, dur: 0.09, gain: 0.5,
        attack: 0.001, drive: 2.6,
      }).connect(g);
      S.noiseBurst(t, {
        type: 'highpass', freq: 5200, dur: 0.05, gain: 0.4, attack: 0.0006, curve: 'lin',
      }).connect(g);
    }

    // 16th hats, accented.
    {
      const acc = s % 4 === 0 ? 1.0 : s % 2 === 0 ? 0.5 : 0.7;
      const g = S.gain(0.045 * acc);
      g.connect(dest);
      S.noiseBurst(t, {
        type: 'highpass', freq: 8000, dur: 0.03, gain: 0.5, attack: 0.0006, curve: 'lin',
      }).connect(g);
    }

    // Aggressive lead riff.
    const riff = RIFF[bar % RIFF.length];
    const d = riff[s];
    if (d !== null && d !== undefined) {
      const semi = P.bass + this._deg(d, 3);
      const g = S.gain(0.12);
      g.connect(dest);
      S.stack(t, {
        type: 'sawtooth', freq: this._hz(semi), count: 3, spread: 16,
        dur: this.stepDur * 1.8, gain: 0.6, attack: 0.004,
        filterFreq: 2600, filterTo: 800, q: 6, drive: 3.2,
      }).connect(g);
      // an octave-down layer gives the lead weight without muddying it
      S.tone(t, {
        type: 'square', freq: this._hz(semi - 12), dur: this.stepDur * 1.4,
        gain: 0.28, attack: 0.004, filter: 'lowpass', filterFreq: 1400,
        filterTo: 500, drive: 2,
      }).connect(g);
    }

    // Tom fill closing the phrase.
    if (bar === PROG.length - 1 && s >= 12) {
      const g = S.gain(0.16);
      g.connect(dest);
      const f = 180 - (s - 12) * 26;
      S.tone(t, {
        type: 'sine', freq: f * 1.6, freqTo: f, dur: 0.18, gain: 0.7,
        attack: 0.002, drive: 2.4,
      }).connect(g);
      S.noiseBurst(t, {
        source: 'brown', type: 'bandpass', freq: f * 3, q: 1.4, dur: 0.12, gain: 0.4,
      }).connect(g);
    }
  }

  // --- stem 3: boss --------------------------------------------------------

  _bossLayer(t, s, bar, P) {
    const S = this.S;
    const dest = this.layers.boss;
    const barDur = this.stepDur * 16;

    // Choir-ish pad: detuned triangles pushed through fixed formant bands.
    if (s === 0) {
      const formants = [620, 1180, 2500];
      for (let i = 0; i < P.chord.length; i++) {
        const semi = P.chord[i] + 12;
        const g = S.gain(0.075 / (1 + i * 0.25));
        g.connect(dest);
        const mix = S.gain(0.5);
        for (let k = 0; k < 3; k++) {
          const bp = S.filter('bandpass', formants[k], 5.5);
          const bg = S.gain(1 / (1 + k * 0.6));
          mix.connect(bp);
          bp.connect(bg);
          bg.connect(g);
        }
        const voice = S.stack(t, {
          type: 'triangle', freq: this._hz(semi), count: 3, spread: 11,
          dur: barDur * 1.3, gain: 0.9, attack: barDur * 0.3,
          hold: barDur * 0.55, filterFreq: 3200, q: 1,
        });
        voice.connect(mix);
        // slow vibrato is what separates "choir" from "organ"
        S.lfo(mix.gain, t, { rate: 5.2, depth: 0.06, dur: barDur * 1.4 });
      }
    }

    // Brass stabs.
    if (s === 0 || s === 10 || (bar % 2 === 1 && s === 6)) {
      const g = S.gain(0.13);
      g.connect(dest);
      for (let i = 0; i < 3; i++) {
        const semi = P.chord[i] - 12;
        S.stack(t, {
          type: 'sawtooth', freq: this._hz(semi), count: 4, spread: 13,
          dur: 0.42, gain: 0.5 / (1 + i * 0.4), attack: 0.022,
          filterFreq: 300, filterTo: 2600, q: 3.5, drive: 2.6,
        }).connect(g);
      }
      S.tone(t, {
        type: 'sine', freq: this._hz(P.bass), dur: 0.45, gain: 0.5,
        attack: 0.01, drive: 2,
      }).connect(g);
    }

    // Taiko.
    if (s === 0 || s === 8 || (bar === PROG.length - 1 && s >= 12 && s % 2 === 0)) {
      const g = S.gain(0.22);
      g.connect(dest);
      S.tone(t, {
        type: 'sine', freq: 128, freqTo: 62, dur: 0.5, gain: 0.8,
        attack: 0.003, drive: 2.8,
      }).connect(g);
      S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 900, freqTo: 200, q: 1.2,
        dur: 0.22, gain: 0.45, drive: 2,
      }).connect(g);
    }
  }

  // --- shared drum ---------------------------------------------------------

  _kick(t, dest, level, hard = false) {
    const S = this.S;
    const g = S.gain(level * 0.3);
    g.connect(dest);
    S.tone(t, {
      type: 'sine', freq: 165, freqTo: 41, dur: 0.32, gain: 0.95,
      attack: 0.002, drive: hard ? 4 : 2.6,
    }).connect(g);
    S.noiseBurst(t, {
      type: 'highpass', freq: 1800, dur: 0.02, gain: hard ? 0.4 : 0.25,
      attack: 0.0005, curve: 'lin',
    }).connect(g);
    if (hard) {
      S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 260, dur: 0.1, gain: 0.35, drive: 3,
      }).connect(g);
    }
  }

  dispose() {
    this.stop();
    try {
      for (const name in this.layers) this.layers[name].disconnect();
      if (this.send) this.send.disconnect();
    } catch (e) {
      /* context may already be closed */
    }
    this.layers = {};
  }
}

export default Music;
