/**
 * Sfx.js — the ACNTR sound bank. Every entry is synthesised from scratch.
 *
 * Contract for a one-shot:
 *     SFX[name](S, v, o) -> duration in seconds
 *   S = Synth instance, v = { t, out, send(amount) }, o = per-call params.
 * The voice `v.out` is already panned, distance-attenuated and routed to a bus
 * by AudioDirector; a sound only has to build its graph into `v.out`.
 *
 * Design notes that apply throughout:
 *  - Everything is layered transient / body / tail. The transient carries the
 *    "read" of the sound through a busy mix, the body carries weight, the tail
 *    places it in the world.
 *  - Every shot is randomised in pitch and level. Identical repeats are the
 *    single loudest tell of synthesised audio.
 *  - Mechanical foley (bolts, mag drops, hydraulics, servos) is scheduled a few
 *    tens of milliseconds after the bang. That offset is what makes a weapon
 *    sound like a machine rather than an explosion.
 */

/** Bus / spatial metadata. `cd` is the per-sound cooldown that stops stacking. */
export const SFX_META = {
  // name:            [bus,        cooldown, reverbSend, refDistance]
  rifle_rf025: ['weapons', 0.028, 0.16, 24],
  rifle_lr: ['weapons', 0.08, 0.3, 40],
  shotgun_sg027: ['weapons', 0.06, 0.26, 30],
  handgun_hg003: ['weapons', 0.03, 0.16, 22],
  gatling_gu_a2: ['weapons', 0.018, 0.12, 24],
  bazooka_mj24: ['weapons', 0.09, 0.34, 40],
  plasma_pr16: ['weapons', 0.05, 0.28, 30],
  laser_lr37: ['weapons', 0.05, 0.22, 30],
  pulse_blade: ['weapons', 0.06, 0.24, 18],
  missile_bml: ['weapons', 0.035, 0.24, 30],
  missile_swarm: ['weapons', 0.09, 0.24, 30],
  cannon_earshot: ['weapons', 0.12, 0.42, 60],
  pulse_shield: ['weapons', 0.12, 0.2, 18],
  orbit_pod: ['weapons', 0.12, 0.22, 24],

  w_dryfire: ['weapons', 0.09, 0.1, 14],
  w_mag_drop: ['weapons', 0.05, 0.2, 14],
  w_mag_insert: ['weapons', 0.05, 0.16, 14],
  w_bolt: ['weapons', 0.04, 0.14, 14],
  w_reload: ['weapons', 0.2, 0.18, 14],
  w_deploy: ['weapons', 0.1, 0.18, 16],
  w_stow: ['weapons', 0.1, 0.18, 16],
  w_charge: ['weapons', 0.1, 0.2, 20],

  imp_metal: ['sfx', 0.026, 0.24, 20],
  imp_concrete: ['sfx', 0.03, 0.24, 20],
  imp_energy: ['sfx', 0.03, 0.24, 20],
  imp_shield: ['sfx', 0.04, 0.3, 20],
  imp_flesh: ['sfx', 0.04, 0.16, 18],
  explosion: ['sfx', 0.06, 0.5, 70],
  explosion_small: ['sfx', 0.04, 0.4, 45],
  debris: ['sfx', 0.08, 0.34, 30],

  footstep: ['sfx', 0.07, 0.28, 26],
  land: ['sfx', 0.1, 0.32, 34],
  quick_boost: ['sfx', 0.07, 0.2, 26],
  assault_boost: ['sfx', 0.4, 0.34, 40],
  damage_clang: ['sfx', 0.035, 0.24, 22],
  en_empty: ['ui', 0.4, 0.14, 20],
  servo_tick: ['sfx', 0.05, 0.14, 14],

  stagger_break: ['sfx', 0.35, 0.45, 60],
  direct_hit: ['ui', 0.045, 0.08, 20],
  hit_confirm: ['ui', 0.03, 0.06, 20],
  kill_confirm: ['ui', 0.1, 0.1, 20],
  lock_tick: ['ui', 0.03, 0.05, 12],
  lock_confirm: ['ui', 0.16, 0.08, 12],
  lock_lost: ['ui', 0.16, 0.08, 12],

  ui_click: ['ui', 0.02, 0.04, 10],
  ui_nav: ['ui', 0.03, 0.05, 10],
  ui_confirm: ['ui', 0.08, 0.08, 10],
  ui_back: ['ui', 0.08, 0.06, 10],
  ui_warning: ['ui', 0.5, 0.14, 10],
  ui_equip: ['ui', 0.1, 0.16, 10],
  ui_pickup: ['ui', 0.05, 0.18, 14],
  ui_log: ['ui', 0.06, 0.05, 10],
  mission_complete: ['ui', 1.0, 0.3, 10],
  game_over: ['ui', 1.0, 0.3, 10],

  amb_groan: ['ambience', 0.5, 0.6, 120],
  amb_distant_boom: ['ambience', 0.5, 0.7, 200],
};

/** Friendly aliases so callers can emit loose names without breaking. */
export const SFX_ALIASES = {
  hit: 'imp_metal',
  metal: 'imp_metal',
  concrete: 'imp_concrete',
  energy: 'imp_energy',
  shield: 'imp_shield',
  explode: 'explosion',
  boom: 'explosion',
  click: 'ui_click',
  blip: 'ui_nav',
  reload: 'w_reload',
  step: 'footstep',
  qb: 'quick_boost',
  ab: 'assault_boost',
  stagger: 'stagger_break',
  pickup: 'ui_pickup',
  equip: 'ui_equip',
};

// ---------------------------------------------------------------------------
// shared sub-builders — the foley vocabulary reused across the bank
// ---------------------------------------------------------------------------

/** A struck steel plate/receiver. Short, bright, inharmonic. */
function clunk(S, t, o = {}) {
  const { freq = 900, gain = 0.5, decay = 0.16, q = 16 } = o;
  return S.modal(t, {
    freq: freq * S.vary(140),
    partials: [1, 1.63, 2.29, 3.14, 4.11],
    decay,
    q,
    gain,
    exciteDur: 0.0035,
  });
}

/** A dull mechanical knock — mass moving, not metal ringing. */
function knock(S, t, o = {}) {
  const { freq = 260, gain = 0.5, dur = 0.09 } = o;
  return S.noiseBurst(t, {
    source: 'brown',
    type: 'bandpass',
    freq: freq * S.vary(120),
    q: 1.5,
    dur,
    gain,
    drive: 1.6,
  });
}

/** Pneumatic / hydraulic hiss. Fast attack, airy decay, slight downward sweep. */
function hiss(S, t, o = {}) {
  const { freq = 4200, freqTo = 1500, dur = 0.28, gain = 0.35, q = 0.8 } = o;
  return S.noiseBurst(t, {
    source: 'white',
    type: 'bandpass',
    freq,
    freqTo,
    q,
    dur,
    gain,
    attack: 0.008,
  });
}

/** Servo / actuator whirr — a filtered saw plus gear-tooth grain. */
function servoWhirr(S, t, o = {}) {
  const { freq = 220, freqTo = 150, dur = 0.3, gain = 0.3 } = o;
  const out = S.gain(1);
  S.tone(t, {
    type: 'sawtooth',
    freq,
    freqTo,
    dur,
    gain: gain * 0.7,
    attack: 0.02,
    filter: 'bandpass',
    filterFreq: freq * 4,
    filterQ: 5,
  }).connect(out);
  S.grains(t, { rate: 2.2, dur, gain: gain * 0.5, freq: 3000, q: 1.2, attack: 0.02 }).connect(out);
  return out;
}

/** Spent casing skittering off armour plate. */
function casing(S, t, gain = 0.25) {
  const out = S.gain(1);
  for (let i = 0; i < 3; i++) {
    const g = S.gain(gain * (1 - i * 0.3));
    clunk(S, t + 0.04 * i + S.rnd(0, 0.02), {
      freq: 3100 * S.vary(300),
      gain: 0.4,
      decay: 0.06,
      q: 12,
    }).connect(g);
    g.connect(out);
  }
  return out;
}

/** Chunky debris rattling down after something breaks. */
function debrisField(S, t, o = {}) {
  const { dur = 1.2, gain = 0.4, rate = 1, freq = 1500 } = o;
  const out = S.gain(1);
  S.grains(t, { rate, dur, gain: gain, freq, q: 1.1, freqTo: freq * 0.35, attack: 0.02 }).connect(out);
  S.grains(t + 0.09, {
    rate: rate * 0.55,
    dur: dur * 0.8,
    gain: gain * 0.7,
    freq: 420,
    q: 0.9,
    drive: 1.4,
    attack: 0.03,
  }).connect(out);
  return out;
}

// ---------------------------------------------------------------------------
// the bank
// ---------------------------------------------------------------------------

export const SFX = {
  // ======================================================== WEAPONS — fire ==

  /** Assault rifle: a sharp mechanical crack with a ringing receiver tail. */
  rifle_rf025(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(70);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.95 * l, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 3100 * p, q: 0.8, dur: 0.038,
        gain: 0.9, attack: 0.0006, curve: 'lin', drive: 1.9 }) },
      { gain: 0.5 * l, dur: 0.04, build: (t) => S.tone(t, {
        type: 'sawtooth', freq: 2300 * p, freqTo: 380 * p, dur: 0.03,
        gain: 0.5, attack: 0.0005, filter: 'lowpass', filterFreq: 7000, drive: 3 }) },
      { gain: 1.0 * l, dur: 0.14, build: (t) => S.sub(t, {
        freq: 195 * p, freqTo: 56, dur: 0.13, gain: 0.85, drive: 2.6 }) },
      { gain: 0.65 * l, dur: 0.16, build: (t) => S.noiseBurst(t, {
        source: 'brown', freq: 540 * p, q: 0.85, dur: 0.15, gain: 0.7, drive: 2.2 }) },
      { gain: 0.45 * l, delay: 0.006, dur: 0.34, build: (t) => clunk(S, t, {
        freq: 1180 * p, gain: 0.42, decay: 0.3, q: 26 }) },
      { gain: 0.3 * l, delay: 0.012, dur: 0.33, build: (t) => S.noiseBurst(t, {
        source: 'pink', type: 'highpass', freq: 1600, dur: 0.31, gain: 0.42, attack: 0.007 }) },
      // bolt cycling back — sells "machine" rather than "bang"
      { gain: 0.34 * l, delay: 0.034, dur: 0.1, build: (t) => clunk(S, t, {
        freq: 2650, gain: 0.3, decay: 0.055, q: 14 }) },
      { gain: 0.2 * l, delay: 0.07, dur: 0.2, build: (t) => casing(S, t, 0.2) },
    ]);
  },

  /** Linear rifle: electromagnetic charge, a colossal thump, a long whine. */
  rifle_lr(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(40);
    const l = o.gain == null ? 1 : o.gain;
    const chg = o.charge == null ? 0.22 : o.charge; // seconds of rising coil whine
    return S.layer(v.t, v.out, [
      // coil spin-up: rising, slightly detuned, opening filter
      { gain: 0.5 * l, dur: chg, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 260 * p, freqTo: 2600 * p, count: 3, spread: 22,
        dur: chg, gain: 0.4, attack: chg * 0.6, hold: 0, curve: 'lin',
        filterFreq: 900, filterTo: 7000, q: 6 }) },
      { gain: 0.3 * l, dur: chg, build: (t) => S.noiseBurst(t, {
        freq: 1800, freqTo: 6500, q: 8, dur: chg, gain: 0.35, attack: chg * 0.7, curve: 'lin' }) },
      // discharge
      { gain: 1.0 * l, delay: chg, dur: 0.06, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 4200, dur: 0.045, gain: 1.0,
        attack: 0.0004, curve: 'lin', drive: 2.6 }) },
      { gain: 1.15 * l, delay: chg, dur: 0.7, build: (t) => S.sub(t, {
        freq: 150 * p, freqTo: 28, dur: 0.68, gain: 1.0, drive: 3.4, attack: 0.003 }) },
      { gain: 0.8 * l, delay: chg, dur: 0.5, build: (t) => S.noiseBurst(t, {
        source: 'brown', freq: 1200, freqTo: 90, q: 0.9, dur: 0.48, gain: 0.8, drive: 2.4 }) },
      // the signature: a long descending electromagnetic whine
      { gain: 0.42 * l, delay: chg + 0.02, dur: 1.7, build: (t) => S.tone(t, {
        type: 'triangle', freq: 3300 * p, freqTo: 780, dur: 1.65, gain: 0.4,
        attack: 0.01, filter: 'bandpass', filterFreq: 3300, filterTo: 900, filterQ: 9 }) },
      { gain: 0.28 * l, delay: chg + 0.03, dur: 1.4, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 2600, freqTo: 500, q: 5, dur: 1.35, gain: 0.3, attack: 0.02 }) },
      // capacitor bank dumping + breech cycling
      { gain: 0.3 * l, delay: chg + 0.14, dur: 0.25, build: (t) => clunk(S, t, {
        freq: 760, gain: 0.35, decay: 0.2, q: 18 }) },
      { gain: 0.24 * l, delay: chg + 0.16, dur: 0.3, build: (t) => hiss(S, t, {
        freq: 5200, freqTo: 1800, dur: 0.28, gain: 0.3 }) },
    ]);
  },

  /** Shotgun: a deep percussive boom, then the pump racking. */
  shotgun_sg027(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(60);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.9 * l, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 2400, dur: 0.04, gain: 0.85, attack: 0.0005, curve: 'lin', drive: 2.2 }) },
      { gain: 1.15 * l, dur: 0.3, build: (t) => S.sub(t, {
        freq: 135 * p, freqTo: 38, dur: 0.28, gain: 1.0, drive: 3.2 }) },
      { gain: 0.95 * l, dur: 0.34, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 1400, freqTo: 190, q: 1.1,
        dur: 0.32, gain: 0.85, drive: 2.6 }) },
      { gain: 0.4 * l, delay: 0.01, dur: 0.55, build: (t) => S.noiseBurst(t, {
        source: 'pink', type: 'bandpass', freq: 900, freqTo: 300, q: 1.4,
        dur: 0.52, gain: 0.45, attack: 0.012 }) },
      { gain: 0.3 * l, delay: 0.012, dur: 0.4, build: (t) => clunk(S, t, {
        freq: 640, gain: 0.3, decay: 0.34, q: 20 }) },
      // pump action: back...
      { gain: 0.42 * l, delay: 0.26, dur: 0.14, build: (t) => {
        const out = S.gain(1);
        clunk(S, t, { freq: 1450, gain: 0.4, decay: 0.09, q: 12 }).connect(out);
        S.noiseBurst(t, { freq: 2600, freqTo: 900, q: 2.5, dur: 0.11, gain: 0.3, attack: 0.006 }).connect(out);
        return out;
      } },
      // ...and forward, harder
      { gain: 0.5 * l, delay: 0.4, dur: 0.2, build: (t) => {
        const out = S.gain(1);
        clunk(S, t, { freq: 980, gain: 0.5, decay: 0.13, q: 15 }).connect(out);
        knock(S, t, { freq: 300, gain: 0.4, dur: 0.07 }).connect(out);
        return out;
      } },
    ]);
  },

  /** Handgun: tight, high, snappy. Very little tail. */
  handgun_hg003(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(80);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.95 * l, dur: 0.04, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 4000 * p, dur: 0.028, gain: 0.9,
        attack: 0.0004, curve: 'lin', drive: 2.4 }) },
      { gain: 0.85 * l, dur: 0.1, build: (t) => S.sub(t, {
        freq: 240 * p, freqTo: 78, dur: 0.09, gain: 0.8, drive: 2.8 }) },
      { gain: 0.55 * l, dur: 0.12, build: (t) => S.noiseBurst(t, {
        source: 'brown', freq: 780 * p, q: 1.1, dur: 0.11, gain: 0.6, drive: 2 }) },
      { gain: 0.4 * l, delay: 0.005, dur: 0.2, build: (t) => clunk(S, t, {
        freq: 1900 * p, gain: 0.35, decay: 0.16, q: 22 }) },
      { gain: 0.45 * l, delay: 0.028, dur: 0.09, build: (t) => clunk(S, t, {
        freq: 2300, gain: 0.3, decay: 0.05, q: 12 }) },
      { gain: 0.24 * l, delay: 0.09, dur: 0.2, build: (t) => casing(S, t, 0.24) },
    ]);
  },

  /** Gatling: one tooth of the buzzsaw. Deliberately small — dozens stack. */
  gatling_gu_a2(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(120);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.8 * l, dur: 0.03, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 2800 * p, dur: 0.022, gain: 0.75,
        attack: 0.0004, curve: 'lin', drive: 2.2 }) },
      { gain: 0.8 * l, dur: 0.07, build: (t) => S.sub(t, {
        freq: 175 * p, freqTo: 70, dur: 0.065, gain: 0.7, drive: 3 }) },
      { gain: 0.55 * l, dur: 0.08, build: (t) => S.noiseBurst(t, {
        source: 'brown', freq: 900 * p, q: 1.3, dur: 0.075, gain: 0.6, drive: 2.4 }) },
      { gain: 0.22 * l, delay: 0.004, dur: 0.16, build: (t) => clunk(S, t, {
        freq: 1600 * p, gain: 0.22, decay: 0.13, q: 20 }) },
    ]);
  },

  /** Bazooka: a thick launch whoomph and the motor departing downrange. */
  bazooka_mj24(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(50);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.7 * l, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 1800, dur: 0.04, gain: 0.6, attack: 0.001, curve: 'lin' }) },
      { gain: 1.1 * l, dur: 0.5, build: (t) => S.sub(t, {
        freq: 105 * p, freqTo: 30, dur: 0.48, gain: 0.95, drive: 3.4, attack: 0.008 }) },
      // the whoomph: a big low-passed pressure wave, not a crack
      { gain: 1.0 * l, dur: 0.55, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 900, freqTo: 120, q: 1.4,
        dur: 0.52, gain: 0.9, attack: 0.008, drive: 2.2 }) },
      // rocket motor receding
      { gain: 0.42 * l, delay: 0.05, dur: 0.95, build: (t) => S.noiseBurst(t, {
        type: 'bandpass', freq: 1500, freqTo: 380, q: 1.8, dur: 0.9, gain: 0.45, attack: 0.03 }) },
      { gain: 0.26 * l, delay: 0.05, dur: 0.9, build: (t) => S.tone(t, {
        type: 'sawtooth', freq: 320, freqTo: 120, dur: 0.85, gain: 0.28,
        attack: 0.04, filter: 'lowpass', filterFreq: 1200, filterTo: 400, drive: 2 }) },
      { gain: 0.3 * l, delay: 0.02, dur: 0.4, build: (t) => hiss(S, t, {
        freq: 3800, freqTo: 900, dur: 0.38, gain: 0.34 }) },
      { gain: 0.3 * l, delay: 0.18, dur: 0.25, build: (t) => clunk(S, t, {
        freq: 520, gain: 0.32, decay: 0.2, q: 14 }) },
    ]);
  },

  /** Plasma: a resonant zap collapsing through a downward filter sweep. */
  plasma_pr16(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(90);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.85 * l, dur: 0.06, build: (t) => S.fm(t, {
        carrier: 940 * p, ratio: 3.71, index: 2600, indexTo: 40, indexDur: 0.05,
        dur: 0.055, gain: 0.8, attack: 0.0006, drive: 1.6 }) },
      { gain: 0.75 * l, dur: 0.38, build: (t) => S.noiseBurst(t, {
        freq: 2600 * p, freqTo: 230, q: 12, dur: 0.36, gain: 0.7, attack: 0.002, drive: 1.8 }) },
      { gain: 0.6 * l, dur: 0.3, build: (t) => S.stack(t, {
        type: 'square', freq: 420 * p, freqTo: 96, count: 3, spread: 26, dur: 0.28,
        gain: 0.5, attack: 0.001, filterFreq: 4200, filterTo: 480, q: 4, drive: 2 }) },
      { gain: 0.65 * l, dur: 0.3, build: (t) => S.sub(t, {
        freq: 160 * p, freqTo: 44, dur: 0.28, gain: 0.6, drive: 2.6 }) },
      // wet burble tail — inharmonic, slightly unstable
      { gain: 0.34 * l, delay: 0.03, dur: 0.6, build: (t) => S.modal(t, {
        freq: 380 * p, partials: [1, 1.41, 2.13, 3.37], decay: 0.5, q: 12,
        gain: 0.35, exciteDur: 0.02, exciteSource: 'pink' }) },
      { gain: 0.22 * l, delay: 0.04, dur: 0.5, build: (t) => S.grains(t, {
        rate: 3.2, dur: 0.45, gain: 0.3, freq: 3400, q: 1.6, freqTo: 1200, attack: 0.01 }) },
    ]);
  },

  /** Laser: a thin, hot, very fast zap with an ionised tail. */
  laser_lr37(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(70);
    const l = o.gain == null ? 1 : o.gain;
    const chg = o.charge == null ? 0.1 : o.charge;
    return S.layer(v.t, v.out, [
      { gain: 0.4 * l, dur: chg, build: (t) => S.tone(t, {
        type: 'triangle', freq: 900 * p, freqTo: 4600 * p, dur: chg, gain: 0.32,
        attack: chg * 0.8, curve: 'lin', filter: 'bandpass', filterFreq: 2400,
        filterTo: 6000, filterQ: 8 }) },
      { gain: 0.95 * l, delay: chg, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 5200, dur: 0.04, gain: 0.85, attack: 0.0004,
        curve: 'lin', drive: 2.6 }) },
      { gain: 0.8 * l, delay: chg, dur: 0.3, build: (t) => S.tone(t, {
        type: 'sine', freq: 4300 * p, freqTo: 1150, dur: 0.28, gain: 0.7,
        attack: 0.0008, filter: 'bandpass', filterFreq: 4300, filterTo: 1400, filterQ: 6 }) },
      { gain: 0.5 * l, delay: chg, dur: 0.26, build: (t) => S.noiseBurst(t, {
        freq: 6200, freqTo: 2200, q: 6, dur: 0.24, gain: 0.5, attack: 0.001 }) },
      { gain: 0.45 * l, delay: chg, dur: 0.2, build: (t) => S.sub(t, {
        freq: 210 * p, freqTo: 70, dur: 0.18, gain: 0.45, drive: 2.2 }) },
      { gain: 0.3 * l, delay: chg + 0.02, dur: 0.6, build: (t) => S.modal(t, {
        freq: 2350 * p, partials: [1, 2.04, 3.31], decay: 0.5, q: 30, gain: 0.3 }) },
      // heat-sink vent after the shot
      { gain: 0.26 * l, delay: chg + 0.2, dur: 0.35, build: (t) => hiss(S, t, {
        freq: 6000, freqTo: 2000, dur: 0.33, gain: 0.3 }) },
    ]);
  },

  /** Pulse blade: an air-shearing swoosh into an energised crackle. */
  pulse_blade(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(60);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      // the swing
      { gain: 0.6 * l, dur: 0.2, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 320, freqTo: 2800, q: 2.2, dur: 0.19,
        gain: 0.6, attack: 0.06, curve: 'lin' }) },
      // ignition
      { gain: 0.85 * l, delay: 0.14, dur: 0.06, build: (t) => S.fm(t, {
        carrier: 620 * p, ratio: 5.3, index: 3200, indexTo: 60, indexDur: 0.055,
        dur: 0.055, gain: 0.8, attack: 0.0006, drive: 2.2 }) },
      { gain: 0.7 * l, delay: 0.14, dur: 0.3, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 240 * p, freqTo: 88, count: 4, spread: 30, dur: 0.28,
        gain: 0.6, attack: 0.002, filterFreq: 3600, filterTo: 420, q: 5, drive: 2.6 }) },
      { gain: 0.6 * l, delay: 0.14, dur: 0.24, build: (t) => S.sub(t, {
        freq: 180 * p, freqTo: 46, dur: 0.22, gain: 0.6, drive: 3 }) },
      // arcing crackle
      { gain: 0.4 * l, delay: 0.15, dur: 0.5, build: (t) => S.grains(t, {
        rate: 4.5, dur: 0.45, gain: 0.45, freq: 2600, q: 1.1, freqTo: 900,
        attack: 0.006, drive: 2 }) },
      { gain: 0.3 * l, delay: 0.17, dur: 0.75, build: (t) => S.modal(t, {
        freq: 520 * p, partials: [1, 1.57, 2.61, 4.02], decay: 0.6, q: 14,
        gain: 0.3, exciteSource: 'pink', exciteDur: 0.02 }) },
    ]);
  },

  /** Missile: tube pop, then the motor lighting and running away from you. */
  missile_bml(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(90);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.7 * l, dur: 0.04, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 2200, dur: 0.03, gain: 0.6, attack: 0.0008, curve: 'lin' }) },
      { gain: 0.75 * l, dur: 0.16, build: (t) => S.sub(t, {
        freq: 165 * p, freqTo: 54, dur: 0.15, gain: 0.7, drive: 2.8 }) },
      { gain: 0.5 * l, dur: 0.14, build: (t) => knock(S, t, { freq: 420, gain: 0.5, dur: 0.13 }) },
      // motor: hiss that rises then departs
      { gain: 0.55 * l, delay: 0.03, dur: 0.8, build: (t) => S.noiseBurst(t, {
        freq: 900, freqTo: 2300, q: 1.6, dur: 0.75, gain: 0.5, attack: 0.05, curve: 'exp' }) },
      { gain: 0.3 * l, delay: 0.03, dur: 0.75, build: (t) => S.tone(t, {
        type: 'sawtooth', freq: 420 * p, freqTo: 190, dur: 0.7, gain: 0.3,
        attack: 0.05, filter: 'lowpass', filterFreq: 1600, filterTo: 620, drive: 1.8 }) },
      { gain: 0.28 * l, delay: 0.1, dur: 0.24, build: (t) => clunk(S, t, {
        freq: 1500, gain: 0.3, decay: 0.18, q: 18 }) },
    ]);
  },

  /** Swarm missiles: a rippling cluster of launches under one collective roar. */
  missile_swarm(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const count = Math.max(3, Math.min(10, o.count || 6));
    const layers = [];
    for (let i = 0; i < count; i++) {
      const d = i * S.rnd(0.035, 0.062);
      const p = S.vary(200);
      layers.push({ gain: 0.5 * l, delay: d, dur: 0.14, build: (t) => S.sub(t, {
        freq: 190 * p, freqTo: 62, dur: 0.13, gain: 0.6, drive: 2.6 }) });
      layers.push({ gain: 0.4 * l, delay: d, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 2600 * p, dur: 0.04, gain: 0.5, attack: 0.0008, curve: 'lin' }) });
      layers.push({ gain: 0.25 * l, delay: d + 0.02, dur: 0.5, build: (t) => S.noiseBurst(t, {
        freq: 1200 * p, freqTo: 2600, q: 2.2, dur: 0.45, gain: 0.3, attack: 0.04 }) });
    }
    layers.push({ gain: 0.4 * l, delay: 0.04, dur: 0.9, build: (t) => S.noiseBurst(t, {
      source: 'pink', freq: 1600, freqTo: 700, q: 1.1, dur: 0.85, gain: 0.4, attack: 0.12 }) });
    return S.layer(v.t, v.out, layers);
  },

  /** Earshot-class cannon: the biggest gun in the bank. Slow, enormous, mechanical. */
  cannon_earshot(S, v, o = {}) {
    const p = (o.pitch || 1) * S.vary(40);
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 1.0 * l, dur: 0.06, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 3000, dur: 0.05, gain: 0.95, attack: 0.0004, curve: 'lin', drive: 2.8 }) },
      { gain: 1.3 * l, dur: 1.0, build: (t) => S.sub(t, {
        freq: 120 * p, freqTo: 24, dur: 0.95, gain: 1.1, drive: 4, attack: 0.004 }) },
      { gain: 1.1 * l, dur: 0.75, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 2600, freqTo: 150, q: 1.6,
        dur: 0.72, gain: 1.0, drive: 3 }) },
      { gain: 0.55 * l, delay: 0.02, dur: 1.6, build: (t) => S.noiseBurst(t, {
        source: 'pink', type: 'bandpass', freq: 700, freqTo: 180, q: 1.0,
        dur: 1.55, gain: 0.55, attack: 0.03 }) },
      { gain: 0.4 * l, delay: 0.02, dur: 0.9, build: (t) => clunk(S, t, {
        freq: 430, gain: 0.4, decay: 0.8, q: 24 }) },
      // recoil: the whole mount slams back, then the breech vents
      { gain: 0.55 * l, delay: 0.14, dur: 0.3, build: (t) => {
        const out = S.gain(1);
        knock(S, t, { freq: 190, gain: 0.6, dur: 0.16 }).connect(out);
        clunk(S, t + 0.01, { freq: 760, gain: 0.45, decay: 0.24, q: 16 }).connect(out);
        return out;
      } },
      { gain: 0.34 * l, delay: 0.34, dur: 0.5, build: (t) => hiss(S, t, {
        freq: 3400, freqTo: 700, dur: 0.48, gain: 0.36 }) },
      { gain: 0.3 * l, delay: 0.5, dur: 0.7, build: (t) => debrisField(S, t, {
        dur: 0.65, gain: 0.3, rate: 0.7, freq: 900 }) },
    ]);
  },

  /** Pulse shield: a rising harmonic bloom that settles into a standing hum. */
  pulse_shield(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const base = 180 * (o.pitch || 1);
    const layers = [
      { gain: 0.4 * l, dur: 0.4, build: (t) => S.noiseBurst(t, {
        freq: 700, freqTo: 5200, q: 3, dur: 0.38, gain: 0.4, attack: 0.2, curve: 'lin' }) },
      { gain: 0.7 * l, delay: 0.3, dur: 0.4, build: (t) => S.sub(t, {
        freq: 150, freqTo: 62, dur: 0.38, gain: 0.6, drive: 2.2, attack: 0.01 }) },
      { gain: 0.4 * l, delay: 0.3, dur: 0.9, build: (t) => S.modal(t, {
        freq: base * 4, partials: [1, 1.5, 2, 3], decay: 0.8, q: 26, gain: 0.4,
        exciteSource: 'pink', exciteDur: 0.01 }) },
    ];
    // harmonic bloom — a rising partial stack, each entering slightly later
    for (let i = 0; i < 5; i++) {
      layers.push({ gain: 0.24 * l / (1 + i * 0.5), delay: 0.05 * i, dur: 0.7, build: (t) => S.tone(t, {
        type: 'sine', freq: base * (i + 1), freqTo: base * (i + 1) * 1.06,
        dur: 0.66, gain: 0.4, attack: 0.12, glide: 'lin' }) });
    }
    return S.layer(v.t, v.out, layers);
  },

  /** Orbit pod: hatch clunk, servo deploy, energy core spooling up. */
  orbit_pod(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.6 * l, dur: 0.2, build: (t) => clunk(S, t, { freq: 620, gain: 0.55, decay: 0.16, q: 14 }) },
      { gain: 0.5 * l, dur: 0.16, build: (t) => knock(S, t, { freq: 240, gain: 0.5, dur: 0.14 }) },
      { gain: 0.45 * l, delay: 0.05, dur: 0.45, build: (t) => servoWhirr(S, t, {
        freq: 260, freqTo: 400, dur: 0.42, gain: 0.4 }) },
      { gain: 0.35 * l, delay: 0.12, dur: 0.4, build: (t) => hiss(S, t, {
        freq: 4600, freqTo: 1400, dur: 0.38, gain: 0.34 }) },
      { gain: 0.5 * l, delay: 0.28, dur: 0.7, build: (t) => S.fm(t, {
        carrier: 180, carrierTo: 620, ratio: 2.01, index: 220, indexTo: 900,
        indexDur: 0.65, dur: 0.66, gain: 0.45, attack: 0.25, curve: 'lin' }) },
      { gain: 0.4 * l, delay: 0.85, dur: 0.5, build: (t) => S.modal(t, {
        freq: 1240, partials: [1, 1.5, 2.02], decay: 0.42, q: 28, gain: 0.4 }) },
    ]);
  },

  // ================================================ WEAPONS — mechanical foley ==

  w_dryfire(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.7 * l, dur: 0.06, build: (t) => clunk(S, t, { freq: 2900, gain: 0.5, decay: 0.04, q: 10 }) },
      { gain: 0.5 * l, dur: 0.05, build: (t) => knock(S, t, { freq: 520, gain: 0.4, dur: 0.045 }) },
      { gain: 0.3 * l, delay: 0.03, dur: 0.08, build: (t) => clunk(S, t, { freq: 1700, gain: 0.25, decay: 0.05, q: 9 }) },
    ]);
  },

  w_mag_drop(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.5 * l, dur: 0.1, build: (t) => clunk(S, t, { freq: 1250, gain: 0.4, decay: 0.07, q: 11 }) },
      { gain: 0.6 * l, delay: 0.11, dur: 0.4, build: (t) => clunk(S, t, {
        freq: 430, gain: 0.55, decay: 0.34, q: 18 }) },
      { gain: 0.5 * l, delay: 0.11, dur: 0.2, build: (t) => knock(S, t, { freq: 210, gain: 0.5, dur: 0.16 }) },
      { gain: 0.3 * l, delay: 0.23, dur: 0.25, build: (t) => clunk(S, t, {
        freq: 720, gain: 0.3, decay: 0.2, q: 16 }) },
      { gain: 0.24 * l, delay: 0.3, dur: 0.4, build: (t) => debrisField(S, t, {
        dur: 0.35, gain: 0.22, rate: 1.6, freq: 2200 }) },
    ]);
  },

  w_mag_insert(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.4 * l, dur: 0.13, build: (t) => S.noiseBurst(t, {
        freq: 1400, freqTo: 2600, q: 2.4, dur: 0.12, gain: 0.4, attack: 0.05, curve: 'lin' }) },
      { gain: 0.7 * l, delay: 0.12, dur: 0.14, build: (t) => clunk(S, t, {
        freq: 1050, gain: 0.6, decay: 0.1, q: 13 }) },
      { gain: 0.6 * l, delay: 0.12, dur: 0.12, build: (t) => knock(S, t, { freq: 280, gain: 0.55, dur: 0.1 }) },
      { gain: 0.35 * l, delay: 0.14, dur: 0.2, build: (t) => clunk(S, t, {
        freq: 2400, gain: 0.28, decay: 0.09, q: 20 }) },
    ]);
  },

  w_bolt(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.45 * l, dur: 0.09, build: (t) => S.noiseBurst(t, {
        freq: 2200, freqTo: 4200, q: 3.2, dur: 0.08, gain: 0.45, attack: 0.03, curve: 'lin' }) },
      { gain: 0.75 * l, delay: 0.075, dur: 0.16, build: (t) => clunk(S, t, {
        freq: 1750, gain: 0.6, decay: 0.11, q: 12 }) },
      { gain: 0.5 * l, delay: 0.075, dur: 0.1, build: (t) => knock(S, t, { freq: 340, gain: 0.45, dur: 0.08 }) },
      { gain: 0.28 * l, delay: 0.09, dur: 0.24, build: (t) => S.modal(t, {
        freq: 3300, partials: [1, 1.87, 2.6], decay: 0.18, q: 24, gain: 0.25 }) },
    ]);
  },

  /** Full reload cycle: mag out, mag in, bolt home. */
  w_reload(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const a = { t: v.t, out: v.out };
    const b = { t: v.t + 0.42, out: v.out };
    const c = { t: v.t + 0.86, out: v.out };
    SFX.w_mag_drop(S, a, { gain: l });
    SFX.w_mag_insert(S, b, { gain: l });
    SFX.w_bolt(S, c, { gain: l });
    // servo assist under the whole motion
    const g = S.gain(0.35 * l);
    g.connect(v.out);
    servoWhirr(S, v.t + 0.05, { freq: 200, freqTo: 320, dur: 0.9, gain: 0.3 }).connect(g);
    return 1.25;
  },

  w_deploy(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.5 * l, dur: 0.35, build: (t) => servoWhirr(S, t, {
        freq: 180, freqTo: 340, dur: 0.32, gain: 0.45 }) },
      { gain: 0.35 * l, delay: 0.05, dur: 0.3, build: (t) => hiss(S, t, {
        freq: 3600, freqTo: 1200, dur: 0.28, gain: 0.32 }) },
      { gain: 0.7 * l, delay: 0.3, dur: 0.26, build: (t) => clunk(S, t, {
        freq: 820, gain: 0.6, decay: 0.2, q: 16 }) },
      { gain: 0.55 * l, delay: 0.3, dur: 0.16, build: (t) => knock(S, t, { freq: 220, gain: 0.5, dur: 0.14 }) },
    ]);
  },

  w_stow(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.45 * l, dur: 0.3, build: (t) => servoWhirr(S, t, {
        freq: 330, freqTo: 170, dur: 0.28, gain: 0.4 }) },
      { gain: 0.6 * l, delay: 0.26, dur: 0.22, build: (t) => clunk(S, t, {
        freq: 640, gain: 0.5, decay: 0.17, q: 14 }) },
    ]);
  },

  /** Capacitor charge — used before linear rifle / laser shots. */
  w_charge(S, v, o = {}) {
    const dur = o.dur || 0.6;
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.5 * l, dur, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 140, freqTo: 1900, count: 3, spread: 18, dur,
        gain: 0.4, attack: dur * 0.75, curve: 'lin', filterFreq: 500, filterTo: 5200, q: 7 }) },
      { gain: 0.3 * l, dur, build: (t) => S.noiseBurst(t, {
        freq: 1200, freqTo: 6000, q: 9, dur, gain: 0.3, attack: dur * 0.8, curve: 'lin' }) },
      { gain: 0.25 * l, delay: dur * 0.4, dur: dur * 0.6, build: (t) => S.grains(t, {
        rate: 3, dur: dur * 0.6, gain: 0.25, freq: 4200, q: 1.4, attack: dur * 0.4 }) },
    ]);
  },

  // ======================================================== IMPACTS ==

  /** Metal ricochet: struck-plate modes plus the classic departing whine. */
  imp_metal(S, v, o = {}) {
    const l = (o.gain == null ? 1 : o.gain) * (o.scale || 1);
    const p = S.vary(300);
    return S.layer(v.t, v.out, [
      { gain: 0.9 * l, dur: 0.03, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 4200, dur: 0.02, gain: 0.8, attack: 0.0004, curve: 'lin', drive: 2 }) },
      { gain: 0.85 * l, dur: 0.38, build: (t) => S.modal(t, {
        freq: 1550 * p, partials: [1, 1.73, 2.41, 3.19, 4.58, 5.9],
        decay: 0.34, decaySpread: 0.6, q: 24, gain: 0.75 }) },
      { gain: 0.5 * l, dur: 0.1, build: (t) => knock(S, t, { freq: 380, gain: 0.45, dur: 0.09 }) },
      // ricochet whine — the "pyoo" of a round skating off armour
      { gain: 0.32 * l, delay: 0.008, dur: 0.32, build: (t) => S.tone(t, {
        type: 'sine', freq: 2700 * p, freqTo: 880, dur: 0.3, gain: 0.32, attack: 0.004 }) },
      { gain: 0.3 * l, delay: 0.004, dur: 0.28, build: (t) => S.grains(t, {
        rate: 3.6, dur: 0.25, gain: 0.32, freq: 5200, q: 1.2, freqTo: 2400, attack: 0.004 }) },
      { gain: 0.2 * l, delay: 0.02, dur: 0.45, build: (t) => S.ks(t, {
        freq: 260 * p, dur: 0.42, damping: 3200, gain: 0.22 }) },
    ]);
  },

  /** Concrete: a dull thud with dust and a shower of fragments. */
  imp_concrete(S, v, o = {}) {
    const l = (o.gain == null ? 1 : o.gain) * (o.scale || 1);
    const p = S.vary(220);
    return S.layer(v.t, v.out, [
      { gain: 0.8 * l, dur: 0.03, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 2600, dur: 0.022, gain: 0.6, attack: 0.0006, curve: 'lin' }) },
      { gain: 0.95 * l, dur: 0.2, build: (t) => S.noiseBurst(t, {
        source: 'brown', freq: 240 * p, q: 0.9, dur: 0.19, gain: 0.9, drive: 2 }) },
      { gain: 0.7 * l, dur: 0.18, build: (t) => S.sub(t, {
        freq: 110 * p, freqTo: 44, dur: 0.17, gain: 0.6, drive: 2.4 }) },
      { gain: 0.45 * l, delay: 0.006, dur: 0.3, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 1500, freqTo: 500, q: 1.1, dur: 0.28, gain: 0.45, attack: 0.006 }) },
      { gain: 0.4 * l, delay: 0.03, dur: 0.55, build: (t) => debrisField(S, t, {
        dur: 0.5, gain: 0.4, rate: 1.7, freq: 1900 }) },
    ]);
  },

  /** Energy impact: an electrical sizzle collapsing into a resonant burn. */
  imp_energy(S, v, o = {}) {
    const l = (o.gain == null ? 1 : o.gain) * (o.scale || 1);
    const p = S.vary(260);
    return S.layer(v.t, v.out, [
      { gain: 0.85 * l, dur: 0.05, build: (t) => S.fm(t, {
        carrier: 1500 * p, ratio: 4.3, index: 2400, indexTo: 30, indexDur: 0.045,
        dur: 0.045, gain: 0.75, attack: 0.0005, drive: 1.8 }) },
      { gain: 0.6 * l, dur: 0.3, build: (t) => {
        const n = S.noiseBurst(t, {
          type: 'highpass', freq: 2200, dur: 0.28, gain: 0.6, attack: 0.002, drive: 2 });
        // flutter the sizzle so it crackles instead of hissing flat
        S.lfo(n.gain, t, { rate: 34, depth: 0.22, type: 'square', dur: 0.32 });
        return n;
      } },
      { gain: 0.5 * l, dur: 0.28, build: (t) => S.tone(t, {
        type: 'sawtooth', freq: 900 * p, freqTo: 180, dur: 0.26, gain: 0.45,
        attack: 0.001, filter: 'bandpass', filterFreq: 2400, filterTo: 400, filterQ: 8, drive: 2 }) },
      { gain: 0.4 * l, dur: 0.16, build: (t) => S.sub(t, {
        freq: 150 * p, freqTo: 52, dur: 0.15, gain: 0.4, drive: 2.6 }) },
      { gain: 0.3 * l, delay: 0.02, dur: 0.45, build: (t) => S.grains(t, {
        rate: 4.2, dur: 0.4, gain: 0.32, freq: 3600, q: 1.3, freqTo: 1400, attack: 0.006, drive: 1.6 }) },
    ]);
  },

  /** Shield ping: bright, tuned, slightly rising — reads as "absorbed". */
  imp_shield(S, v, o = {}) {
    const l = (o.gain == null ? 1 : o.gain) * (o.scale || 1);
    const p = S.vary(180);
    return S.layer(v.t, v.out, [
      { gain: 0.7 * l, dur: 0.03, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 5000, dur: 0.022, gain: 0.6, attack: 0.0005, curve: 'lin' }) },
      { gain: 0.7 * l, dur: 0.75, build: (t) => S.tone(t, {
        type: 'sine', freq: 1870 * p, freqTo: 1960 * p, dur: 0.72, gain: 0.6,
        attack: 0.002, glide: 'lin' }) },
      { gain: 0.4 * l, dur: 0.6, build: (t) => S.tone(t, {
        type: 'sine', freq: 2810 * p, freqTo: 2900 * p, dur: 0.58, gain: 0.35,
        attack: 0.002, glide: 'lin' }) },
      { gain: 0.35 * l, dur: 0.5, build: (t) => S.noiseBurst(t, {
        freq: 3400, freqTo: 5600, q: 5, dur: 0.48, gain: 0.32, attack: 0.02 }) },
      { gain: 0.3 * l, dur: 0.12, build: (t) => S.sub(t, {
        freq: 220, freqTo: 110, dur: 0.11, gain: 0.3, drive: 1.6 }) },
    ]);
  },

  /** Soft-body / cockpit hit — used when a hit has no surface classification. */
  imp_flesh(S, v, o = {}) {
    const l = (o.gain == null ? 1 : o.gain) * (o.scale || 1);
    return S.layer(v.t, v.out, [
      { gain: 0.8 * l, dur: 0.13, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 700, freqTo: 200, dur: 0.12, gain: 0.75, drive: 2 }) },
      { gain: 0.6 * l, dur: 0.14, build: (t) => S.sub(t, { freq: 130, freqTo: 46, dur: 0.13, gain: 0.55, drive: 2.2 }) },
    ]);
  },

  /**
   * The big one. Sub-bass thump, a saturated noise blast, a long filtered tail
   * and debris raining down after. `scale` (0.4..2) sizes the whole event.
   */
  explosion(S, v, o = {}) {
    const s = Math.max(0.35, Math.min(2.2, o.scale || 1));
    const l = (o.gain == null ? 1 : o.gain) * (0.7 + s * 0.3);
    const p = S.vary(90) / Math.sqrt(s);
    const T = 1.1 * s;
    return S.layer(v.t, v.out, [
      { gain: 0.9 * l, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 2600, dur: 0.04, gain: 0.85, attack: 0.0004, curve: 'lin', drive: 3 }) },
      { gain: 1.25 * l, dur: T, build: (t) => S.sub(t, {
        freq: 130 * p, freqTo: 22, dur: T * 0.85, gain: 1.05, drive: 4, attack: 0.005 }) },
      { gain: 1.0 * l, dur: T * 0.9, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 3600 * p, freqTo: 170, q: 1.5,
        dur: T * 0.85, gain: 0.95, attack: 0.004, drive: 3 }) },
      { gain: 0.55 * l, delay: 0.015, dur: T * 2, build: (t) => S.noiseBurst(t, {
        source: 'pink', type: 'bandpass', freq: 1100, freqTo: 200, q: 0.9,
        dur: T * 1.9, gain: 0.55, attack: 0.03 }) },
      // hull modes — what makes it an exploding machine, not a firework
      { gain: 0.45 * l, delay: 0.02, dur: T * 1.2, build: (t) => S.modal(t, {
        freq: 320 * p, partials: [1, 1.58, 2.24, 3.4], decay: T, q: 20,
        gain: 0.45, exciteSource: 'brown', exciteDur: 0.02 }) },
      { gain: 0.45 * l, delay: 0.22 * s, dur: T * 1.8, build: (t) => debrisField(S, t, {
        dur: T * 1.6, gain: 0.45, rate: 0.9, freq: 1500 }) },
      // secondary cook-off
      { gain: 0.4 * l, delay: 0.34 * s, dur: 0.4, build: (t) => S.sub(t, {
        freq: 90 * p, freqTo: 30, dur: 0.38, gain: 0.4, drive: 3 }) },
    ]);
  },

  explosion_small(S, v, o = {}) {
    return SFX.explosion(S, v, { ...o, scale: (o.scale || 1) * 0.5 });
  },

  debris(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const g = S.gain(l);
    g.connect(v.out);
    debrisField(S, v.t, { dur: 1.0 * (o.scale || 1), gain: 0.5, rate: 1.2, freq: 1700 }).connect(g);
    return 1.1 * (o.scale || 1);
  },

  // ======================================================== MECH ==

  /**
   * Footstep. `weight` (0..2) scales mass: a heavy tetrapod gets more sub and
   * more hydraulic hiss, a lightweight gets more plate rattle.
   */
  footstep(S, v, o = {}) {
    const w = Math.max(0.3, Math.min(2, o.weight == null ? 1 : o.weight));
    const l = (o.gain == null ? 1 : o.gain) * (0.75 + w * 0.25);
    const p = S.vary(140) / Math.sqrt(w);
    return S.layer(v.t, v.out, [
      { gain: 0.9 * l, dur: 0.28 * w, build: (t) => S.sub(t, {
        freq: 96 * p, freqTo: 32, dur: 0.26 * w, gain: 0.9, drive: 3, attack: 0.004 }) },
      { gain: 0.7 * l, dur: 0.17, build: (t) => S.noiseBurst(t, {
        source: 'brown', freq: 330 * p, q: 1.1, dur: 0.16, gain: 0.7, drive: 2.2 }) },
      { gain: 0.45 * l, dur: 0.06, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 3200, dur: 0.05, gain: 0.4, attack: 0.0008, curve: 'lin' }) },
      // armour plates settling
      { gain: 0.4 * l, delay: 0.012, dur: 0.3, build: (t) => S.modal(t, {
        freq: 780 * p, partials: [1, 1.66, 2.38, 3.5], decay: 0.24, q: 18, gain: 0.4 }) },
      // hydraulic relief
      { gain: 0.34 * l, delay: 0.05, dur: 0.28, build: (t) => hiss(S, t, {
        freq: 4200, freqTo: 1300, dur: 0.26, gain: 0.34 * w }) },
      { gain: 0.26 * l, delay: 0.02, dur: 0.35, build: (t) => debrisField(S, t, {
        dur: 0.3, gain: 0.22, rate: 2.2, freq: 2600 }) },
      { gain: 0.3 * l, delay: 0.09, dur: 0.3, build: (t) => servoWhirr(S, t, {
        freq: 230, freqTo: 160, dur: 0.28, gain: 0.28 }) },
    ]);
  },

  /** Landing. `impact` 0..1 scales from a light touchdown to a crater. */
  land(S, v, o = {}) {
    const i = Math.max(0.15, Math.min(1.4, o.impact == null ? 0.7 : o.impact));
    const w = o.weight == null ? 1 : o.weight;
    const l = (o.gain == null ? 1 : o.gain) * (0.6 + i * 0.6);
    const p = S.vary(90) / Math.sqrt(w);
    return S.layer(v.t, v.out, [
      { gain: 1.05 * l, dur: 0.5, build: (t) => S.sub(t, {
        freq: 88 * p, freqTo: 26, dur: 0.46, gain: 1.0, drive: 3.6, attack: 0.004 }) },
      { gain: 0.85 * l, dur: 0.26, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 1200, freqTo: 180, q: 1.3,
        dur: 0.24, gain: 0.8, drive: 2.6 }) },
      { gain: 0.55 * l, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 3000, dur: 0.04, gain: 0.5, attack: 0.0006, curve: 'lin' }) },
      { gain: 0.55 * l, delay: 0.01, dur: 0.55, build: (t) => S.modal(t, {
        freq: 520 * p, partials: [1, 1.62, 2.31, 3.28, 4.4], decay: 0.45, q: 20, gain: 0.5 }) },
      { gain: 0.5 * l, delay: 0.06, dur: 0.45, build: (t) => hiss(S, t, {
        freq: 5200, freqTo: 1100, dur: 0.42, gain: 0.45 }) },
      { gain: 0.4 * l, delay: 0.05, dur: 0.7, build: (t) => debrisField(S, t, {
        dur: 0.6, gain: 0.36, rate: 1.4, freq: 1600 }) },
      { gain: 0.35 * l, delay: 0.16, dur: 0.4, build: (t) => servoWhirr(S, t, {
        freq: 300, freqTo: 170, dur: 0.36, gain: 0.34 }) },
    ]);
  },

  /**
   * Quick boost: a sharp pneumatic chuff with a downward pitch smear — the
   * doppler-ish drop is what makes the dash read as *displacement*.
   */
  quick_boost(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const p = S.vary(110);
    return S.layer(v.t, v.out, [
      { gain: 0.85 * l, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 5200, dur: 0.04, gain: 0.7, attack: 0.0006, curve: 'lin', drive: 2 }) },
      { gain: 1.0 * l, dur: 0.26, build: (t) => S.noiseBurst(t, {
        freq: 4200 * p, freqTo: 520, q: 1.5, dur: 0.24, gain: 0.9, attack: 0.003, drive: 1.8 }) },
      { gain: 0.8 * l, dur: 0.24, build: (t) => S.sub(t, {
        freq: 165 * p, freqTo: 46, dur: 0.22, gain: 0.75, drive: 3 }) },
      // the "pitch drop" resonance riding the exhaust
      { gain: 0.45 * l, dur: 0.3, build: (t) => S.tone(t, {
        type: 'sawtooth', freq: 900 * p, freqTo: 260, dur: 0.28, gain: 0.4,
        attack: 0.004, filter: 'bandpass', filterFreq: 1800, filterTo: 420, filterQ: 6, drive: 2 }) },
      { gain: 0.35 * l, delay: 0.02, dur: 0.38, build: (t) => S.noiseBurst(t, {
        source: 'pink', type: 'highpass', freq: 1800, dur: 0.35, gain: 0.35, attack: 0.02 }) },
      { gain: 0.3 * l, delay: 0.06, dur: 0.16, build: (t) => clunk(S, t, {
        freq: 1900, gain: 0.26, decay: 0.11, q: 16 }) },
    ]);
  },

  /** Assault boost ignition: a low roar that blooms open and holds. */
  assault_boost(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const T = o.dur || 2.4;
    return S.layer(v.t, v.out, [
      { gain: 0.9 * l, dur: 0.3, build: (t) => S.sub(t, {
        freq: 190, freqTo: 42, dur: 0.28, gain: 0.85, drive: 3.4 }) },
      { gain: 0.7 * l, dur: 0.1, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 3200, dur: 0.09, gain: 0.6, attack: 0.004, drive: 2 }) },
      // the roar: noise opening from a rumble into a full-band blast
      { gain: 1.0 * l, dur: T, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 380, freqTo: 3000, q: 1.6,
        dur: T, gain: 0.85, attack: 0.16, hold: T * 0.35, drive: 2.6 }) },
      { gain: 0.6 * l, dur: T, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 62, count: 4, spread: 16, dur: T, gain: 0.5,
        attack: 0.2, hold: T * 0.4, filterFreq: 320, filterTo: 1500, q: 3, drive: 3 }) },
      { gain: 0.45 * l, delay: 0.05, dur: T, build: (t) => S.noiseBurst(t, {
        source: 'pink', type: 'bandpass', freq: 2400, q: 2.2, dur: T,
        gain: 0.4, attack: 0.25, hold: T * 0.3 }) },
    ]);
  },

  /** Armour taking a hit: metal-on-metal, weighted by `scale`. */
  damage_clang(S, v, o = {}) {
    const s = Math.max(0.3, Math.min(2, o.scale || 1));
    const l = (o.gain == null ? 1 : o.gain) * (0.7 + s * 0.3);
    const p = S.vary(280) / Math.sqrt(s);
    return S.layer(v.t, v.out, [
      { gain: 0.8 * l, dur: 0.03, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 3600, dur: 0.022, gain: 0.7, attack: 0.0004, curve: 'lin', drive: 2.4 }) },
      { gain: 0.95 * l, dur: 0.55, build: (t) => S.modal(t, {
        freq: 890 * p, partials: [1, 1.69, 2.42, 3.36, 4.71], decay: 0.45,
        decaySpread: 0.62, q: 20, gain: 0.85, exciteDur: 0.005 }) },
      { gain: 0.8 * l, dur: 0.2, build: (t) => S.sub(t, {
        freq: 145 * p, freqTo: 44, dur: 0.19, gain: 0.7, drive: 3 }) },
      { gain: 0.6 * l, dur: 0.14, build: (t) => S.noiseBurst(t, {
        source: 'brown', freq: 420 * p, q: 1.2, dur: 0.13, gain: 0.6, drive: 2.4 }) },
      { gain: 0.3 * l, delay: 0.03, dur: 0.45, build: (t) => S.ks(t, {
        freq: 190 * p, dur: 0.42, damping: 2400, gain: 0.3 }) },
      { gain: 0.28 * l, delay: 0.04, dur: 0.4, build: (t) => debrisField(S, t, {
        dur: 0.35, gain: 0.26, rate: 2, freq: 2800 }) },
    ]);
  },

  /** Energy exhausted: a power-down sag plus a two-tone caution blip. */
  en_empty(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.6 * l, dur: 0.7, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 420, freqTo: 90, count: 3, spread: 20, dur: 0.68,
        gain: 0.5, attack: 0.006, filterFreq: 2600, filterTo: 320, q: 4 }) },
      { gain: 0.4 * l, dur: 0.5, build: (t) => S.noiseBurst(t, {
        freq: 2400, freqTo: 400, q: 4, dur: 0.48, gain: 0.35, attack: 0.006 }) },
      { gain: 0.35 * l, delay: 0.06, dur: 0.09, build: (t) => S.tone(t, {
        type: 'square', freq: 1180, dur: 0.08, gain: 0.3, attack: 0.002,
        filter: 'bandpass', filterFreq: 1180, filterQ: 4 }) },
      { gain: 0.35 * l, delay: 0.2, dur: 0.12, build: (t) => S.tone(t, {
        type: 'square', freq: 880, dur: 0.11, gain: 0.3, attack: 0.002,
        filter: 'bandpass', filterFreq: 880, filterQ: 4 }) },
      { gain: 0.4 * l, delay: 0.02, dur: 0.3, build: (t) => hiss(S, t, {
        freq: 3000, freqTo: 700, dur: 0.28, gain: 0.35 }) },
    ]);
  },

  /** Small actuator tick, used sparsely when limbs change direction. */
  servo_tick(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.4 * l, dur: 0.14, build: (t) => servoWhirr(S, t, {
        freq: 300 * S.vary(200), freqTo: 220, dur: 0.13, gain: 0.4 }) },
      { gain: 0.25 * l, delay: 0.1, dur: 0.07, build: (t) => clunk(S, t, {
        freq: 2200, gain: 0.2, decay: 0.05, q: 12 }) },
    ]);
  },

  // ======================================================== AC6 SIGNATURES ==

  /**
   * ACS OVERLOAD. The single most important sound in the game: a crushing
   * metallic collapse fused with an alarm. Structure:
   *   pre-swell -> crunch + saturated downward sweep -> sub drop -> alarm -> ring
   */
  stagger_break(S, v, o = {}) {
    const l = (o.gain == null ? 1 : o.gain) * (o.player ? 1.15 : 1);
    const pre = 0.16;
    const layers = [
      // rising swell into the break — buys the impact its weight
      { gain: 0.5 * l, dur: pre, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 380, freqTo: 3000, q: 2.4, dur: pre,
        gain: 0.5, attack: pre * 0.9, curve: 'lin' }) },
      { gain: 0.35 * l, dur: pre, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 90, freqTo: 240, count: 3, spread: 22, dur: pre,
        gain: 0.4, attack: pre * 0.85, curve: 'lin', filterFreq: 400, filterTo: 1800, q: 5 }) },
      // the break
      { gain: 1.0 * l, delay: pre, dur: 0.06, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 3400, dur: 0.05, gain: 0.95, attack: 0.0004, curve: 'lin', drive: 3.4 }) },
      { gain: 1.2 * l, delay: pre, dur: 0.9, build: (t) => S.sub(t, {
        freq: 175, freqTo: 26, dur: 0.85, gain: 1.05, drive: 4, attack: 0.004 }) },
      // the crunch: heavily saturated noise crushed down through the spectrum
      { gain: 1.0 * l, delay: pre, dur: 0.42, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 4200, freqTo: 200, q: 2.2,
        dur: 0.4, gain: 0.95, attack: 0.002, drive: 4 }) },
      { gain: 0.7 * l, delay: pre, dur: 0.5, build: (t) => {
        const n = S.noiseBurst(t, {
          type: 'bandpass', freq: 1600, freqTo: 320, q: 3.4, dur: 0.48, gain: 0.6, attack: 0.002 });
        S.lfo(n.gain, t, { rate: 22, depth: 0.3, type: 'square', dur: 0.5 });
        return n;
      } },
      // shearing metal modes
      { gain: 0.7 * l, delay: pre + 0.01, dur: 1.9, build: (t) => S.modal(t, {
        freq: 610, partials: [1, 1.47, 2.11, 2.93, 4.07, 5.62], decay: 1.5,
        decaySpread: 0.72, q: 26, gain: 0.6, exciteSource: 'brown', exciteDur: 0.02 }) },
      { gain: 0.4 * l, delay: pre + 0.03, dur: 1.2, build: (t) => S.ks(t, {
        freq: 148, dur: 1.1, damping: 1800, gain: 0.4 }) },
      { gain: 0.45 * l, delay: pre + 0.16, dur: 1.4, build: (t) => debrisField(S, t, {
        dur: 1.3, gain: 0.42, rate: 0.85, freq: 1300 }) },
    ];
    // the alarm half of the hybrid — three hard blips over the collapse
    for (let i = 0; i < 3; i++) {
      layers.push({ gain: 0.4 * l, delay: pre + 0.1 + i * 0.15, dur: 0.1, build: (t) => {
        const out = S.gain(1);
        S.tone(t, { type: 'square', freq: 1245, dur: 0.09, gain: 0.5, attack: 0.001,
          filter: 'bandpass', filterFreq: 1400, filterQ: 3 }).connect(out);
        S.tone(t, { type: 'square', freq: 933, dur: 0.09, gain: 0.35, attack: 0.001,
          filter: 'bandpass', filterFreq: 1000, filterQ: 3 }).connect(out);
        return out;
      } });
    }
    return S.layer(v.t, v.out, layers);
  },

  /** Direct hit on a staggered target — crisp, bright, unmistakable. */
  direct_hit(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.8 * l, dur: 0.05, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 5200, dur: 0.04, gain: 0.6, attack: 0.0004, curve: 'lin' }) },
      { gain: 0.75 * l, dur: 0.16, build: (t) => S.tone(t, {
        type: 'square', freq: 1560, dur: 0.15, gain: 0.5, attack: 0.001,
        filter: 'bandpass', filterFreq: 1900, filterQ: 4 }) },
      { gain: 0.6 * l, delay: 0.045, dur: 0.22, build: (t) => S.tone(t, {
        type: 'square', freq: 2340, dur: 0.2, gain: 0.42, attack: 0.001,
        filter: 'bandpass', filterFreq: 2600, filterQ: 4 }) },
      { gain: 0.5 * l, dur: 0.3, build: (t) => S.modal(t, {
        freq: 3120, partials: [1, 1.5, 2.02], decay: 0.24, q: 26, gain: 0.45 }) },
      { gain: 0.5 * l, dur: 0.14, build: (t) => S.sub(t, { freq: 190, freqTo: 70, dur: 0.13, gain: 0.5, drive: 2.4 }) },
    ]);
  },

  /** Generic hit marker — small, dry, extremely short. */
  hit_confirm(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.55 * l, dur: 0.045, build: (t) => S.tone(t, {
        type: 'square', freq: 2100 * S.vary(50), dur: 0.04, gain: 0.4, attack: 0.0006,
        filter: 'bandpass', filterFreq: 2400, filterQ: 5 }) },
      { gain: 0.4 * l, dur: 0.03, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 4600, dur: 0.022, gain: 0.35, attack: 0.0004, curve: 'lin' }) },
    ]);
  },

  /** Target destroyed confirmation — descending two-tone plus a low bloom. */
  kill_confirm(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.6 * l, dur: 0.12, build: (t) => S.tone(t, {
        type: 'square', freq: 1760, dur: 0.11, gain: 0.42, attack: 0.001,
        filter: 'bandpass', filterFreq: 2000, filterQ: 4 }) },
      { gain: 0.6 * l, delay: 0.1, dur: 0.3, build: (t) => S.tone(t, {
        type: 'square', freq: 1174, dur: 0.28, gain: 0.42, attack: 0.001,
        filter: 'bandpass', filterFreq: 1400, filterQ: 4 }) },
      { gain: 0.5 * l, delay: 0.1, dur: 0.5, build: (t) => S.sub(t, {
        freq: 130, freqTo: 58, dur: 0.48, gain: 0.45, drive: 2, attack: 0.02 }) },
      { gain: 0.3 * l, delay: 0.12, dur: 0.5, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 3200, freqTo: 1200, q: 4, dur: 0.48, gain: 0.28, attack: 0.02 }) },
    ]);
  },

  /**
   * Lock-on acquisition tick. Pitch and brightness climb with `progress`, and
   * the director shortens the interval as it fills — the accelerating rising
   * chain is the recognisable part, not any single blip.
   */
  lock_tick(S, v, o = {}) {
    const pr = Math.max(0, Math.min(1, o.progress == null ? 0 : o.progress));
    const l = (o.gain == null ? 1 : o.gain) * (0.55 + pr * 0.45);
    const f = 620 * Math.pow(2, pr * 1.35); // just over an octave of climb
    return S.layer(v.t, v.out, [
      { gain: 0.55 * l, dur: 0.05, build: (t) => S.fm(t, {
        carrier: f, ratio: 2.0, index: 180 + pr * 500, indexTo: 8, indexDur: 0.04,
        dur: 0.045, gain: 0.5, attack: 0.0008 }) },
      { gain: 0.35 * l, dur: 0.06, build: (t) => S.tone(t, {
        type: 'triangle', freq: f * 2, dur: 0.05, gain: 0.3, attack: 0.0008 }) },
      { gain: 0.22 * l, dur: 0.02, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 6000, dur: 0.014, gain: 0.25, attack: 0.0004, curve: 'lin' }) },
    ]);
  },

  /** Full lock. A confident rising fourth with a shimmer and a low seat. */
  lock_confirm(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const f = 1046.5; // C6
    return S.layer(v.t, v.out, [
      { gain: 0.6 * l, dur: 0.07, build: (t) => S.fm(t, {
        carrier: f, ratio: 2.0, index: 700, indexTo: 10, indexDur: 0.06,
        dur: 0.065, gain: 0.55, attack: 0.0008 }) },
      { gain: 0.7 * l, delay: 0.055, dur: 0.34, build: (t) => S.fm(t, {
        carrier: f * 1.3348, ratio: 2.0, index: 900, indexTo: 12, indexDur: 0.08,
        dur: 0.3, gain: 0.6, attack: 0.0008 }) },
      { gain: 0.34 * l, delay: 0.055, dur: 0.5, build: (t) => S.modal(t, {
        freq: f * 2.6696, partials: [1, 1.5, 2.01], decay: 0.4, q: 30, gain: 0.32 }) },
      { gain: 0.4 * l, delay: 0.05, dur: 0.28, build: (t) => S.sub(t, {
        freq: 175, freqTo: 88, dur: 0.26, gain: 0.4, drive: 1.8, attack: 0.008 }) },
      { gain: 0.26 * l, delay: 0.06, dur: 0.4, build: (t) => S.noiseBurst(t, {
        freq: 5200, freqTo: 8000, q: 6, dur: 0.38, gain: 0.24, attack: 0.03 }) },
    ]);
  },

  /** Lock broken — the confirm interval inverted and dulled. */
  lock_lost(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.45 * l, dur: 0.07, build: (t) => S.tone(t, {
        type: 'triangle', freq: 880, dur: 0.06, gain: 0.4, attack: 0.001 }) },
      { gain: 0.45 * l, delay: 0.06, dur: 0.2, build: (t) => S.tone(t, {
        type: 'triangle', freq: 622, dur: 0.18, gain: 0.4, attack: 0.001,
        filter: 'lowpass', filterFreq: 2600, filterTo: 900 }) },
    ]);
  },

  // ======================================================== UI ==

  ui_click(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.6 * l, dur: 0.016, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 4200, dur: 0.012, gain: 0.5, attack: 0.0003, curve: 'lin' }) },
      { gain: 0.4 * l, dur: 0.035, build: (t) => S.tone(t, {
        type: 'triangle', freq: 2400, freqTo: 1500, dur: 0.03, gain: 0.35, attack: 0.0005 }) },
    ]);
  },

  ui_nav(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const up = o.dir == null ? 1 : o.dir;
    const f = up >= 0 ? 1320 : 990;
    return S.layer(v.t, v.out, [
      { gain: 0.45 * l, dur: 0.055, build: (t) => S.tone(t, {
        type: 'square', freq: f, dur: 0.05, gain: 0.35, attack: 0.0008,
        filter: 'bandpass', filterFreq: f * 1.3, filterQ: 4 }) },
      { gain: 0.3 * l, dur: 0.014, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 5000, dur: 0.01, gain: 0.3, attack: 0.0003, curve: 'lin' }) },
    ]);
  },

  ui_confirm(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.5 * l, dur: 0.07, build: (t) => S.tone(t, {
        type: 'square', freq: 880, dur: 0.06, gain: 0.4, attack: 0.001,
        filter: 'bandpass', filterFreq: 1200, filterQ: 4 }) },
      { gain: 0.5 * l, delay: 0.055, dur: 0.2, build: (t) => S.tone(t, {
        type: 'square', freq: 1318, dur: 0.18, gain: 0.4, attack: 0.001,
        filter: 'bandpass', filterFreq: 1700, filterQ: 4 }) },
      { gain: 0.3 * l, delay: 0.05, dur: 0.2, build: (t) => S.sub(t, {
        freq: 150, freqTo: 90, dur: 0.18, gain: 0.3, drive: 1.6, attack: 0.006 }) },
    ]);
  },

  ui_back(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.45 * l, dur: 0.06, build: (t) => S.tone(t, {
        type: 'square', freq: 740, dur: 0.055, gain: 0.35, attack: 0.001,
        filter: 'bandpass', filterFreq: 1000, filterQ: 4 }) },
      { gain: 0.45 * l, delay: 0.05, dur: 0.14, build: (t) => S.tone(t, {
        type: 'square', freq: 494, dur: 0.13, gain: 0.35, attack: 0.001,
        filter: 'bandpass', filterFreq: 700, filterQ: 4 }) },
    ]);
  },

  /** Low warning drone — used for critical AP prompts and mission failure states. */
  ui_warning(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const T = o.dur || 1.3;
    return S.layer(v.t, v.out, [
      { gain: 0.55 * l, dur: T, build: (t) => {
        const n = S.stack(t, {
          type: 'sawtooth', freq: 104, count: 5, spread: 11, dur: T, gain: 0.5,
          attack: 0.08, hold: T * 0.55, filterFreq: 620, filterTo: 300, q: 3, drive: 2.2 });
        S.lfo(n.gain, t, { rate: 5.5, depth: 0.16, dur: T + 0.1 });
        return n;
      } },
      { gain: 0.35 * l, dur: T, build: (t) => S.tone(t, {
        type: 'sine', freq: 52, dur: T, gain: 0.4, attack: 0.1, hold: T * 0.5, drive: 2 }) },
      { gain: 0.25 * l, delay: 0.05, dur: T * 0.7, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 900, freqTo: 380, q: 2, dur: T * 0.7, gain: 0.25, attack: 0.12 }) },
    ]);
  },

  /** Part equipped: a heavy mechanical seat with servo lock. */
  ui_equip(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.45 * l, dur: 0.22, build: (t) => servoWhirr(S, t, {
        freq: 210, freqTo: 300, dur: 0.2, gain: 0.42 }) },
      { gain: 0.8 * l, delay: 0.19, dur: 0.3, build: (t) => clunk(S, t, {
        freq: 560, gain: 0.65, decay: 0.24, q: 17 }) },
      { gain: 0.7 * l, delay: 0.19, dur: 0.2, build: (t) => knock(S, t, { freq: 175, gain: 0.6, dur: 0.17 }) },
      { gain: 0.4 * l, delay: 0.19, dur: 0.24, build: (t) => S.sub(t, {
        freq: 120, freqTo: 52, dur: 0.22, gain: 0.4, drive: 2.4 }) },
      { gain: 0.3 * l, delay: 0.25, dur: 0.22, build: (t) => hiss(S, t, {
        freq: 4000, freqTo: 1400, dur: 0.2, gain: 0.3 }) },
      { gain: 0.3 * l, delay: 0.3, dur: 0.12, build: (t) => clunk(S, t, {
        freq: 2300, gain: 0.24, decay: 0.08, q: 14 }) },
    ]);
  },

  /**
   * Loot pickup. `rarity` 0..4 (common..legendary). Higher rarities add
   * partials, a longer arpeggio and a shimmer tail — legendary should feel
   * like a reward, not a notification.
   */
  ui_pickup(S, v, o = {}) {
    const r = Math.max(0, Math.min(4, Math.round(o.rarity == null ? 0 : o.rarity)));
    const l = (o.gain == null ? 1 : o.gain) * (0.75 + r * 0.09);
    // E major-ish pentatonic climb; more notes as rarity rises.
    const scale = [659.26, 783.99, 987.77, 1174.66, 1318.51, 1567.98, 1975.53];
    const notes = 1 + r;
    const layers = [
      { gain: 0.4 * l, dur: 0.03, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 5200, dur: 0.024, gain: 0.35, attack: 0.0004, curve: 'lin' }) },
    ];
    for (let i = 0; i < notes; i++) {
      const f = scale[Math.min(scale.length - 1, i + (r >= 3 ? 1 : 0))];
      const d = i * (r >= 3 ? 0.062 : 0.075);
      layers.push({ gain: 0.5 * l, delay: d, dur: 0.4, build: (t) => S.fm(t, {
        carrier: f, ratio: 3.0, index: 300 + r * 120, indexTo: 6, indexDur: 0.06,
        dur: 0.36, gain: 0.45, attack: 0.0012 }) });
      if (r >= 2) {
        layers.push({ gain: 0.22 * l, delay: d, dur: 0.5, build: (t) => S.modal(t, {
          freq: f * 2, partials: [1, 1.5, 2.02, 2.67], decay: 0.42, q: 30, gain: 0.22 }) });
      }
    }
    if (r >= 1) {
      layers.push({ gain: 0.35 * l, dur: 0.4, build: (t) => S.sub(t, {
        freq: 165, freqTo: 82, dur: 0.38, gain: 0.35, drive: 1.8, attack: 0.008 }) });
    }
    if (r >= 3) {
      // legendary flourish: a pad swell underneath and a bright shimmer over
      layers.push({ gain: 0.34 * l, dur: 1.3, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 164.81, count: 6, spread: 13, dur: 1.25, gain: 0.34,
        attack: 0.1, hold: 0.35, filterFreq: 700, filterTo: 2600, q: 3 }) });
      layers.push({ gain: 0.26 * l, delay: 0.1, dur: 1.1, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 4200, freqTo: 9000, q: 5, dur: 1.05, gain: 0.26, attack: 0.3 }) });
      layers.push({ gain: 0.3 * l, delay: 0.3, dur: 0.9, build: (t) => S.modal(t, {
        freq: 2637, partials: [1, 1.5, 2.01, 3.02], decay: 0.8, q: 34, gain: 0.3 }) });
    }
    if (r >= 4) {
      layers.push({ gain: 0.4 * l, delay: 0.36, dur: 0.9, build: (t) => S.fm(t, {
        carrier: 329.63, ratio: 1.5, index: 500, indexTo: 20, indexDur: 0.5,
        dur: 0.85, gain: 0.4, attack: 0.01 }) });
      layers.push({ gain: 0.3 * l, delay: 0.36, dur: 0.7, build: (t) => S.sub(t, {
        freq: 110, freqTo: 55, dur: 0.68, gain: 0.35, drive: 2, attack: 0.01 }) });
    }
    return S.layer(v.t, v.out, layers);
  },

  /** Terminal line printing to the mission log. Very small. */
  ui_log(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.3 * l, dur: 0.03, build: (t) => S.tone(t, {
        type: 'square', freq: 1760 * S.vary(120), dur: 0.026, gain: 0.25, attack: 0.0008,
        filter: 'bandpass', filterFreq: 2600, filterQ: 6 }) },
      { gain: 0.2 * l, dur: 0.012, build: (t) => S.noiseBurst(t, {
        type: 'highpass', freq: 6000, dur: 0.009, gain: 0.2, attack: 0.0003, curve: 'lin' }) },
    ]);
  },

  /** Mission complete: an ascending, widening major-ish resolution. */
  mission_complete(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const chord = [164.81, 246.94, 329.63, 493.88, 659.26];
    const layers = [
      { gain: 0.5 * l, dur: 2.6, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 82.41, count: 6, spread: 12, dur: 2.5, gain: 0.5,
        attack: 0.25, hold: 0.9, filterFreq: 400, filterTo: 2200, q: 3, drive: 2 }) },
      { gain: 0.45 * l, delay: 0.02, dur: 0.6, build: (t) => S.sub(t, {
        freq: 110, freqTo: 55, dur: 0.58, gain: 0.45, drive: 2.2, attack: 0.01 }) },
      { gain: 0.3 * l, delay: 0.3, dur: 2.0, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 3000, freqTo: 8000, q: 4, dur: 1.9, gain: 0.28, attack: 0.6 }) },
    ];
    for (let i = 0; i < chord.length; i++) {
      layers.push({ gain: 0.36 * l, delay: 0.09 * i, dur: 1.6, build: (t) => S.fm(t, {
        carrier: chord[i], ratio: 2.0, index: 260, indexTo: 8, indexDur: 0.35,
        dur: 1.5, gain: 0.35, attack: 0.006 }) });
    }
    return S.layer(v.t, v.out, layers);
  },

  /** Mission failed: everything sags and powers down. */
  game_over(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.7 * l, dur: 2.4, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: 220, freqTo: 41, count: 5, spread: 16, dur: 2.3,
        gain: 0.6, attack: 0.02, filterFreq: 2200, filterTo: 180, q: 4, drive: 2.4 }) },
      { gain: 0.45 * l, dur: 2.0, build: (t) => S.noiseBurst(t, {
        source: 'pink', freq: 1800, freqTo: 160, q: 2.4, dur: 1.9, gain: 0.4, attack: 0.02 }) },
      { gain: 0.5 * l, delay: 0.05, dur: 1.2, build: (t) => S.sub(t, {
        freq: 90, freqTo: 22, dur: 1.15, gain: 0.5, drive: 3, attack: 0.02 }) },
      { gain: 0.35 * l, delay: 0.5, dur: 1.6, build: (t) => debrisField(S, t, {
        dur: 1.5, gain: 0.3, rate: 0.6, freq: 700 }) },
      { gain: 0.3 * l, delay: 1.1, dur: 1.4, build: (t) => hiss(S, t, {
        freq: 2400, freqTo: 300, dur: 1.35, gain: 0.3 }) },
    ]);
  },

  // ======================================================== AMBIENCE ONE-SHOTS ==

  /** A distant structure flexing. Long, slow, tonal, unsettling. */
  amb_groan(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    const f = 70 * S.vary(500);
    const T = S.rnd(2.2, 4.0);
    return S.layer(v.t, v.out, [
      { gain: 0.6 * l, dur: T, build: (t) => S.stack(t, {
        type: 'sawtooth', freq: f, freqTo: f * S.rnd(0.72, 1.35), count: 4, spread: 8,
        dur: T, gain: 0.5, attack: T * 0.35, hold: T * 0.2, filterFreq: 340,
        filterTo: 180, q: 8, drive: 1.6 }) },
      { gain: 0.35 * l, delay: T * 0.2, dur: T * 0.8, build: (t) => S.modal(t, {
        freq: f * 6, partials: [1, 1.44, 2.13, 3.02], decay: T * 0.5, q: 30,
        gain: 0.3, exciteSource: 'pink', exciteDur: 0.06 }) },
      { gain: 0.2 * l, delay: T * 0.5, dur: 1.0, build: (t) => debrisField(S, t, {
        dur: 0.9, gain: 0.18, rate: 0.9, freq: 1100 }) },
    ]);
  },

  /** Something big going off a long way away. Almost all low end. */
  amb_distant_boom(S, v, o = {}) {
    const l = o.gain == null ? 1 : o.gain;
    return S.layer(v.t, v.out, [
      { gain: 0.9 * l, dur: 1.4, build: (t) => S.sub(t, {
        freq: 62 * S.vary(200), freqTo: 20, dur: 1.35, gain: 0.8, drive: 2.4, attack: 0.05 }) },
      { gain: 0.6 * l, dur: 1.6, build: (t) => S.noiseBurst(t, {
        source: 'brown', type: 'lowpass', freq: 320, freqTo: 70, q: 1.2,
        dur: 1.55, gain: 0.55, attack: 0.08 }) },
      { gain: 0.3 * l, delay: 0.15, dur: 2.4, build: (t) => S.noiseBurst(t, {
        source: 'pink', type: 'lowpass', freq: 600, freqTo: 160, q: 0.8,
        dur: 2.3, gain: 0.28, attack: 0.3 }) },
    ]);
  },
};

// ---------------------------------------------------------------------------
// Continuous sources. These are *not* retriggered — they run and are modulated.
// ---------------------------------------------------------------------------

/**
 * Boost thruster. A filtered noise column plus a resonant tone; cutoff, pitch
 * and level all track `intensity`, so accelerating actually sounds like
 * accelerating rather than like the same sample getting louder.
 */
export function createThruster(S, out) {
  const t0 = S.now;
  const master = S.gain(0);
  master.connect(out);

  const lp = S.filter('lowpass', 240, 1.2);
  const peak = S.filter('peaking', 900, 3, 9);
  const body = S.src('brown', { loop: true, rate: 0.9 });
  const air = S.src('white', { loop: true, rate: 1 });
  const airBp = S.filter('bandpass', 2200, 2.4);
  const airGain = S.gain(0.35);
  const tonal = S.osc('sawtooth', 78);
  const tonalLp = S.filter('lowpass', 520, 5);
  const tonalGain = S.gain(0.22);
  const drive = S.shaper('tube', 1.8);

  S.chain(body, lp, peak, drive, master);
  S.chain(air, airBp, airGain, master);
  S.chain(tonal, tonalLp, tonalGain, master);

  // Slow flutter keeps the column alive instead of static.
  const flutter = S.lfo(master.gain, t0, { rate: 11.3, depth: 0.02 });
  const flutter2 = S.lfo(lp.frequency, t0, { rate: 0.7, depth: 90 });

  S.startAt(body, t0);
  S.startAt(air, t0);
  S.startAt(tonal, t0);

  let stopped = false;
  return {
    /** @param {number} i 0..1 thrust intensity @param {number} boostPitch extra pitch factor */
    set(i, boostPitch = 1) {
      if (stopped) return;
      const t = S.now;
      const k = Math.max(0, Math.min(1.4, i));
      const tc = 0.06;
      master.gain.setTargetAtTime(0.5 * k, t, tc);
      lp.frequency.setTargetAtTime(200 + 2900 * k * k, t, tc);
      peak.frequency.setTargetAtTime(700 + 1400 * k, t, tc);
      airGain.gain.setTargetAtTime(0.12 + 0.42 * k, t, tc);
      airBp.frequency.setTargetAtTime(1400 + 2600 * k, t, tc);
      tonal.frequency.setTargetAtTime((62 + 92 * k) * boostPitch, t, tc);
      tonalGain.gain.setTargetAtTime(0.1 + 0.24 * k, t, tc);
    },
    stop(fade = 0.2) {
      if (stopped) return;
      stopped = true;
      const t = S.now;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(0, t, fade * 0.4);
      const end = t + fade + 0.1;
      try {
        body.stop(end);
        air.stop(end);
        tonal.stop(end);
        flutter.osc.stop(end);
        flutter2.osc.stop(end);
      } catch (e) { /* already stopped */ }
    },
  };
}

/**
 * Limb servos. Pitch and level follow how fast the rig is actually moving,
 * which turns silent animation into machinery.
 */
export function createServo(S, out) {
  const t0 = S.now;
  const master = S.gain(0);
  master.connect(out);

  const osc = S.osc('sawtooth', 180);
  const bp = S.filter('bandpass', 900, 6);
  const oscGain = S.gain(0.4);
  const gears = S.src('grain', { loop: true, rate: 1.6 });
  const gearHp = S.filter('highpass', 1800, 0.8);
  const gearGain = S.gain(0.3);

  S.chain(osc, bp, oscGain, master);
  S.chain(gears, gearHp, gearGain, master);
  S.startAt(osc, t0);
  S.startAt(gears, t0);

  let stopped = false;
  return {
    /** @param {number} speed normalised limb speed 0..1 */
    set(speed) {
      if (stopped) return;
      const t = S.now;
      const k = Math.max(0, Math.min(1, speed));
      const tc = 0.09;
      master.gain.setTargetAtTime(0.16 * k, t, tc);
      osc.frequency.setTargetAtTime(120 + 420 * k, t, tc);
      bp.frequency.setTargetAtTime(700 + 2100 * k, t, tc);
      gears.playbackRate.setTargetAtTime(0.8 + 2.2 * k, t, tc);
      gearGain.gain.setTargetAtTime(0.08 + 0.3 * k, t, tc);
    },
    stop(fade = 0.2) {
      if (stopped) return;
      stopped = true;
      const t = S.now;
      master.gain.setTargetAtTime(0, t, fade * 0.4);
      try {
        osc.stop(t + fade + 0.1);
        gears.stop(t + fade + 0.1);
      } catch (e) { /* already stopped */ }
    },
  };
}

/** Gatling barrel spin-up/down. Rotational whine plus a rising motor buzz. */
export function createSpinUp(S, out) {
  const t0 = S.now;
  const master = S.gain(0);
  master.connect(out);

  const motor = S.osc('sawtooth', 40);
  const motorLp = S.filter('lowpass', 900, 4);
  const motorGain = S.gain(0.3);
  const whine = S.osc('triangle', 320);
  const whineBp = S.filter('bandpass', 1600, 9);
  const whineGain = S.gain(0.18);
  const air = S.src('white', { loop: true });
  const airBp = S.filter('bandpass', 2400, 3);
  const airGain = S.gain(0.1);

  S.chain(motor, motorLp, motorGain, master);
  S.chain(whine, whineBp, whineGain, master);
  S.chain(air, airBp, airGain, master);
  S.startAt(motor, t0);
  S.startAt(whine, t0);
  S.startAt(air, t0);

  let stopped = false;
  return {
    /** @param {number} spin 0..1 barrel speed */
    set(spin) {
      if (stopped) return;
      const t = S.now;
      const k = Math.max(0, Math.min(1, spin));
      const tc = 0.12;
      master.gain.setTargetAtTime(0.34 * k, t, tc);
      motor.frequency.setTargetAtTime(34 + 210 * k, t, tc);
      motorLp.frequency.setTargetAtTime(400 + 2200 * k, t, tc);
      whine.frequency.setTargetAtTime(260 + 1500 * k, t, tc);
      whineBp.frequency.setTargetAtTime(1200 + 3200 * k, t, tc);
      airGain.gain.setTargetAtTime(0.04 + 0.2 * k, t, tc);
    },
    stop(fade = 0.35) {
      if (stopped) return;
      stopped = true;
      const t = S.now;
      master.gain.setTargetAtTime(0, t, fade * 0.4);
      try {
        motor.stop(t + fade + 0.1);
        whine.stop(t + fade + 0.1);
        air.stop(t + fade + 0.1);
      } catch (e) { /* already stopped */ }
    },
  };
}

/** Critical-AP alarm: a hard two-tone klaxon over a pulsing low bed. */
export function createAlarm(S, out) {
  const t0 = S.now;
  const master = S.gain(0);
  master.connect(out);

  // Unipolar square LFO gate: base 0.5 + depth 0.5 swings 0..1.
  const gate = S.gain(0.5);
  const gateLfo = S.lfo(gate.gain, t0, { rate: 1.9, depth: 0.5, type: 'square' });

  const a = S.osc('square', 932);
  const b = S.osc('square', 1245);
  const bp = S.filter('bandpass', 1250, 2.6);
  const toneGain = S.gain(0.14);
  a.connect(bp);
  b.connect(bp);
  S.chain(bp, toneGain, gate, master);

  const bed = S.osc('sawtooth', 58);
  const bedLp = S.filter('lowpass', 240, 4);
  const bedGain = S.gain(0.18);
  S.chain(bed, bedLp, bedGain, master);
  const bedLfo = S.lfo(bedGain.gain, t0, { rate: 0.95, depth: 0.09 });

  S.startAt(a, t0);
  S.startAt(b, t0);
  S.startAt(bed, t0);

  let stopped = false;
  return {
    /** @param {number} urgency 0..1 — raises rate and level as AP drops. */
    set(urgency) {
      if (stopped) return;
      const t = S.now;
      const k = Math.max(0, Math.min(1, urgency));
      master.gain.setTargetAtTime(0.5 * k, t, 0.25);
      gateLfo.osc.frequency.setTargetAtTime(1.5 + 2.4 * k, t, 0.4);
      bp.frequency.setTargetAtTime(1100 + 400 * k, t, 0.4);
    },
    stop(fade = 0.3) {
      if (stopped) return;
      stopped = true;
      const t = S.now;
      master.gain.setTargetAtTime(0, t, fade * 0.4);
      const end = t + fade + 0.2;
      try {
        a.stop(end); b.stop(end); bed.stop(end);
        gateLfo.osc.stop(end); bedLfo.osc.stop(end);
      } catch (e) { /* already stopped */ }
    },
  };
}

/**
 * Industrial ambience bed. Wind whose cutoff drifts, a machinery drone that
 * beats slowly against itself, and a scheduler that drops metallic groans and
 * far-off detonations at irregular intervals so the bed never loops audibly.
 */
export function createAmbience(S, out, oneShot) {
  const t0 = S.now;
  const master = S.gain(0);
  master.connect(out);
  master.gain.setTargetAtTime(0.6, t0, 2.5);

  // --- wind: pink noise through a drifting low-pass plus a wandering whistle
  const wind = S.src('pink', { loop: true, rate: 0.85 });
  const windLp = S.filter('lowpass', 700, 0.9);
  const windHp = S.filter('highpass', 90, 0.7);
  const windGain = S.gain(0.28);
  S.chain(wind, windHp, windLp, windGain, master);
  const windDrift = S.lfo(windLp.frequency, t0, { rate: 0.031, depth: 420 });
  const windDrift2 = S.lfo(windLp.frequency, t0, { rate: 0.0117, depth: 260 });
  const windSwell = S.lfo(windGain.gain, t0, { rate: 0.043, depth: 0.13 });

  const whistle = S.src('white', { loop: true, rate: 1 });
  const whistleBp = S.filter('bandpass', 1800, 14);
  const whistleGain = S.gain(0.045);
  S.chain(whistle, whistleBp, whistleGain, master);
  const whistleDrift = S.lfo(whistleBp.frequency, t0, { rate: 0.019, depth: 900 });
  const whistleSwell = S.lfo(whistleGain.gain, t0, { rate: 0.027, depth: 0.04 });

  // --- machinery: two near-unison low saws beating, hard low-passed
  const droneMix = S.gain(0.1);
  const droneLp = S.filter('lowpass', 190, 3);
  const d1 = S.osc('sawtooth', 41.2);
  const d2 = S.osc('sawtooth', 61.9);
  d2.detune.value = 7;
  const d3 = S.osc('sawtooth', 41.2);
  d3.detune.value = -11;
  d1.connect(droneMix); d2.connect(droneMix); d3.connect(droneMix);
  S.chain(droneMix, droneLp, master);
  const droneAm = S.lfo(droneMix.gain, t0, { rate: 0.081, depth: 0.045 });

  // --- rumble floor
  const rumble = S.src('brown', { loop: true, rate: 0.55 });
  const rumbleLp = S.filter('lowpass', 110, 1);
  const rumbleGain = S.gain(0.2);
  S.chain(rumble, rumbleLp, rumbleGain, master);

  S.startAt(wind, t0);
  S.startAt(whistle, t0);
  S.startAt(rumble, t0);
  S.startAt(d1, t0);
  S.startAt(d2, t0);
  S.startAt(d3, t0);

  let nextGroan = t0 + S.rnd(6, 14);
  let nextBoom = t0 + S.rnd(9, 22);
  let stopped = false;

  return {
    /** Called every frame; drops irregular one-shots into the world. */
    update() {
      if (stopped || !oneShot) return;
      const t = S.now;
      if (t >= nextGroan) {
        nextGroan = t + S.rnd(11, 30);
        oneShot('amb_groan', { gain: S.rnd(0.25, 0.6) });
      }
      if (t >= nextBoom) {
        nextBoom = t + S.rnd(14, 42);
        oneShot('amb_distant_boom', { gain: S.rnd(0.3, 0.75) });
      }
    },
    /** Ambience thins out under heavy combat so the mix stays readable. */
    setLevel(x) {
      if (stopped) return;
      master.gain.setTargetAtTime(Math.max(0, x), S.now, 1.2);
    },
    stop(fade = 1.0) {
      if (stopped) return;
      stopped = true;
      const t = S.now;
      master.gain.setTargetAtTime(0, t, fade * 0.4);
      const end = t + fade + 0.4;
      try {
        wind.stop(end); whistle.stop(end); rumble.stop(end);
        d1.stop(end); d2.stop(end); d3.stop(end);
        windDrift.osc.stop(end); windDrift2.osc.stop(end); windSwell.osc.stop(end);
        whistleDrift.osc.stop(end); whistleSwell.osc.stop(end); droneAm.osc.stop(end);
      } catch (e) { /* already stopped */ }
    },
  };
}

export default SFX;
