/**
 * Synth.js — runtime synthesis primitives for ACNTR.
 *
 * There are no audio files in this project: every sound is built from
 * oscillators, pre-baked noise buffers and filters at the moment it is heard.
 * This module owns the cheap, reusable building blocks; `Sfx.js` composes them
 * into designed sounds and `Music.js` into an adaptive score.
 *
 * Two rules drive the design here:
 *  1. **Nothing large is allocated per shot.** Noise is baked once into a few
 *     seconds of AudioBuffer and re-read at random offsets/rates. Waveshaper
 *     curves are cached by (kind, amount). Only lightweight AudioNodes are
 *     created per voice, and they are always `stop()`ed so the graph can be
 *     garbage collected.
 *  2. **Everything is scheduled, never triggered.** Callers pass an absolute
 *     `t` (AudioContext time) so sounds can be layered with sample-accurate
 *     offsets — which is what makes a transient/body/tail stack read as one
 *     event rather than three.
 */

/** Length of the baked noise buffers. Long enough that loops never sound periodic. */
const NOISE_SECONDS = 3.17;

/** exponentialRampToValueAtTime cannot touch zero; this is our practical silence. */
const EPS = 1e-4;

/** Waveshaper curves are pure functions of (kind, amount) — share them process-wide. */
const CURVE_CACHE = new Map();

function buildCurve(kind, amount, n) {
  const c = new Float32Array(n);
  const k = Math.max(0.001, amount);
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y;
    switch (kind) {
      case 'hard':
        y = Math.max(-1, Math.min(1, x * k));
        break;
      case 'fold':
        // Wavefolder — adds inharmonic upper partials, good for energy weapons.
        y = Math.sin(x * k * Math.PI * 0.5);
        break;
      case 'crush': {
        const levels = Math.max(2, Math.round(k));
        y = Math.round(x * levels) / levels;
        break;
      }
      case 'asym':
        // Asymmetric drive generates even harmonics — reads as "speaker cone".
        y = x >= 0 ? Math.tanh(x * k) : Math.tanh(x * k * 0.55) * 0.85;
        break;
      case 'tube':
      default:
        y = Math.tanh(x * k) / norm;
        break;
    }
    c[i] = y;
  }
  return c;
}

export class Synth {
  /** @param {BaseAudioContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    /** @type {Object<string, AudioBuffer>} */
    this.buffers = Object.create(null);
    this._bake();
  }

  /** Current context time. */
  get now() {
    return this.ctx.currentTime;
  }

  // ---------------------------------------------------------------- baking --

  /**
   * Bake the noise sources once. White/pink/brown cover the tonal range of
   * every noise-based layer we need (air, body, rumble); `grain` is a sparse
   * impulse field used for debris rattle, sparks and electrical crackle.
   */
  _bake() {
    const ctx = this.ctx;
    const sr = this.sr;
    const n = Math.max(1024, Math.floor(sr * NOISE_SECONDS));

    const white = ctx.createBuffer(1, n, sr);
    const pink = ctx.createBuffer(1, n, sr);
    const brown = ctx.createBuffer(1, n, sr);
    const grain = ctx.createBuffer(1, n, sr);

    const w = white.getChannelData(0);
    const p = pink.getChannelData(0);
    const b = brown.getChannelData(0);
    const g = grain.getChannelData(0);

    // Paul Kellet's economy pink filter + a leaky integrator for brown.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, run = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.random() * 2 - 1;
      w[i] = v;

      b0 = 0.99886 * b0 + v * 0.0555179;
      b1 = 0.99332 * b1 + v * 0.0750759;
      b2 = 0.969 * b2 + v * 0.153852;
      b3 = 0.8665 * b3 + v * 0.3104856;
      b4 = 0.55 * b4 + v * 0.5329522;
      b5 = -0.7616 * b5 - v * 0.016898;
      p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + v * 0.5362) * 0.11;
      b6 = v * 0.115926;

      run = (run + 0.032 * v) / 1.032;
      b[i] = run * 3.4;
    }

    // Sparse decaying impulses. Amplitude^3 keeps most grains small so the
    // occasional loud one reads as a real chunk of debris.
    let ring = 0;
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.0016) {
        const a = Math.random();
        ring = (Math.random() < 0.5 ? -1 : 1) * a * a * a;
      }
      g[i] = ring;
      ring *= 0.55;
    }

    // Brown noise integrates, so its endpoints drift away from zero and a loop
    // seam would click. Taper only brown; white/pink seams are inaudible.
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      b[i] *= k;
      b[n - 1 - i] *= k;
    }

    this.buffers.white = white;
    this.buffers.pink = pink;
    this.buffers.brown = brown;
    this.buffers.grain = grain;
  }

  /**
   * Procedural convolution impulse response: a large industrial hall.
   * Exponentially decaying noise, progressively low-passed (air + material
   * absorption), with sparse early reflections for the "concrete and steel"
   * signature and a short pre-delay so close sounds still read as dry.
   * @returns {AudioBuffer}
   */
  impulseResponse(opts = {}) {
    const {
      seconds = 2.2,
      decay = 3.4,
      preDelay = 0.021,
      damping = 0.85,
      seed = 0x9e37,
    } = opts;

    const sr = this.sr;
    const pre = Math.max(1, Math.floor(preDelay * sr));
    const len = Math.floor(seconds * sr) + pre;
    const buf = this.ctx.createBuffer(2, len, sr);

    // Deterministic noise so the hall is identical every run.
    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const taps = [0.013, 0.021, 0.031, 0.044, 0.058, 0.077, 0.099, 0.128, 0.161];

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      let hp = 0;
      let prev = 0;
      for (let i = pre; i < len; i++) {
        const time = (i - pre) / sr;
        const u = time / seconds;
        const env = Math.exp(-decay * u) * (1 - u) * (1 - u);
        const v = (rnd() * 2 - 1) * env;
        // One-pole low-pass whose cutoff closes as the tail ages.
        const a = 0.62 - 0.5 * u * damping;
        lp += (v - lp) * a;
        // One-pole high-pass strips the rumble that would muddy the mix.
        hp = 0.995 * (hp + lp - prev);
        prev = lp;
        d[i] = hp;
      }
      // Early reflections: hard, slightly metallic, decorrelated per channel.
      for (let k = 0; k < taps.length; k++) {
        const idx = pre + Math.floor((taps[k] + (ch ? 0.004 : 0)) * sr);
        if (idx < len) d[idx] += (rnd() * 2 - 1) * 0.5 * Math.exp(-k * 0.32);
      }
    }
    return buf;
  }

  // --------------------------------------------------------- node factories --

  gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter(type = 'lowpass', freq = 1000, q = 1, gainDb = 0) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.max(10, Math.min(freq, this.sr * 0.48));
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return f;
  }

  osc(type = 'sine', freq = 440, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = Math.max(0.01, freq);
    if (detune) o.detune.value = detune;
    return o;
  }

  delay(time = 0.05, max = 1) {
    const d = this.ctx.createDelay(max);
    d.delayTime.value = Math.min(time, max);
    return d;
  }

  /** Cached waveshaper. `kind`: tube | asym | hard | fold | crush. */
  shaper(kind = 'tube', amount = 2, n = 1024) {
    const key = `${kind}:${Math.round(amount * 100)}:${n}`;
    let curve = CURVE_CACHE.get(key);
    if (!curve) {
      curve = buildCurve(kind, amount, n);
      CURVE_CACHE.set(key, curve);
    }
    const ws = this.ctx.createWaveShaper();
    ws.curve = curve;
    ws.oversample = kind === 'crush' ? 'none' : '2x';
    return ws;
  }

  /** Bit-crush / sample-rate-ish grunge for electrical and damaged-machine sounds. */
  bitcrush(bits = 5) {
    return this.shaper('crush', Math.pow(2, Math.max(1, bits)) * 0.5, 2048);
  }

  /** Buffer source over a baked noise buffer, entered at a random offset. */
  src(name = 'white', o = {}) {
    const { rate = 1, loop = false, offset = null, detune = 0 } = o;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffers[name] || this.buffers.white;
    s.playbackRate.value = Math.max(0.02, rate);
    s.loop = loop;
    if (detune) {
      try {
        s.detune.value = detune;
      } catch (e) {
        /* detune unsupported on old implementations — harmless */
      }
    }
    const span = Math.max(0.05, s.buffer.duration - 0.75);
    s._offset = offset == null ? Math.random() * span : offset;
    return s;
  }

  /** Start (and optionally stop) a source, clamped so we never schedule in the past. */
  startAt(node, t, dur = 0) {
    const when = Math.max(t, this.ctx.currentTime);
    try {
      if (node._offset !== undefined) node.start(when, node._offset);
      else node.start(when);
      if (dur > 0) node.stop(when + dur);
    } catch (e) {
      /* already started — ignore */
    }
    return node;
  }

  /** Fade a running source out and stop it. Used to retire loops cleanly. */
  stopSource(node, gainNode, t, fade = 0.12) {
    if (!node) return;
    const when = Math.max(t, this.ctx.currentTime);
    try {
      if (gainNode) {
        gainNode.gain.cancelScheduledValues(when);
        gainNode.gain.setValueAtTime(Math.max(gainNode.gain.value, EPS), when);
        gainNode.gain.exponentialRampToValueAtTime(EPS, when + fade);
      }
      node.stop(when + fade + 0.02);
    } catch (e) {
      /* already stopped */
    }
  }

  /** Connect a chain of nodes and return the last one. */
  chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i] && nodes[i + 1]) nodes[i].connect(nodes[i + 1]);
    }
    return nodes[nodes.length - 1];
  }

  // ------------------------------------------------------------- envelopes --

  /**
   * Percussive envelope: fast attack, optional plateau, then decay to silence.
   * This is the shape of almost every impact and gunshot layer.
   * @returns {number} total duration
   */
  perc(param, t, peak, dur, o = {}) {
    const { attack = 0.0018, hold = 0, curve = 'exp' } = o;
    const p = Math.max(peak, EPS * 4);
    const total = Math.max(dur, attack + hold + 0.006);
    param.cancelScheduledValues(t);
    param.setValueAtTime(EPS, t);
    param.exponentialRampToValueAtTime(p, t + attack);
    if (hold > 0) param.setValueAtTime(p, t + attack + hold);
    if (curve === 'lin') {
      param.linearRampToValueAtTime(0, t + total);
    } else {
      param.exponentialRampToValueAtTime(EPS, t + total);
      param.setValueAtTime(0, t + total);
    }
    return total;
  }

  /** Classic ADSR on any AudioParam. Returns total duration. */
  adsr(param, t, o = {}) {
    const { a = 0.01, d = 0.12, s = 0.5, r = 0.25, peak = 1, hold = 0 } = o;
    const p = Math.max(peak, EPS * 4);
    const sus = Math.max(p * s, EPS * 2);
    param.cancelScheduledValues(t);
    param.setValueAtTime(EPS, t);
    param.exponentialRampToValueAtTime(p, t + a);
    param.exponentialRampToValueAtTime(sus, t + a + d);
    const relStart = t + a + d + hold;
    param.setValueAtTime(sus, relStart);
    param.exponentialRampToValueAtTime(EPS, relStart + r);
    param.setValueAtTime(0, relStart + r);
    return a + d + hold + r;
  }

  /** Slow swell — pads, charge-ups, warning drones. */
  swell(param, t, peak, attack, hold, release) {
    const p = Math.max(peak, EPS * 4);
    param.cancelScheduledValues(t);
    param.setValueAtTime(EPS, t);
    param.exponentialRampToValueAtTime(p, t + attack);
    param.setValueAtTime(p, t + attack + hold);
    param.exponentialRampToValueAtTime(EPS, t + attack + hold + release);
    param.setValueAtTime(0, t + attack + hold + release);
    return attack + hold + release;
  }

  /** Filter / pitch sweep on any AudioParam. */
  sweep(param, t, from, to, dur, curve = 'exp') {
    const f0 = Math.max(from, EPS);
    const f1 = Math.max(to, EPS);
    param.cancelScheduledValues(t);
    param.setValueAtTime(f0, t);
    if (curve === 'lin') param.linearRampToValueAtTime(f1, t + dur);
    else param.exponentialRampToValueAtTime(f1, t + dur);
    return dur;
  }

  /** Multi-point automation: `[[offset, value, 'lin'|'exp'], ...]`. */
  ramp(param, t, points) {
    if (!points.length) return 0;
    param.cancelScheduledValues(t);
    param.setValueAtTime(Math.max(points[0][1], EPS), t);
    let end = 0;
    for (let i = 1; i < points.length; i++) {
      const [off, val, mode] = points[i];
      if (mode === 'lin') param.linearRampToValueAtTime(val, t + off);
      else param.exponentialRampToValueAtTime(Math.max(val, EPS), t + off);
      end = off;
    }
    return end;
  }

  /**
   * Low-frequency oscillator driving an AudioParam (tremolo, vibrato, filter
   * wobble). Returns the oscillator so loops can stop it.
   */
  lfo(param, t, o = {}) {
    const { rate = 4, depth = 1, type = 'sine', offset = 0, dur = 0 } = o;
    const osc = this.osc(type, rate);
    const amp = this.gain(depth);
    osc.connect(amp);
    amp.connect(param);
    if (offset) param.value = offset;
    this.startAt(osc, t, dur);
    return { osc, amp };
  }

  // ------------------------------------------------------------ generators --

  /**
   * Band-passed noise burst — the workhorse layer: air, sizzle, crack, hiss.
   * @returns {GainNode} output (caller connects it onward)
   */
  noiseBurst(t, o = {}) {
    const {
      source = 'white', rate = 1, dur = 0.12, gain = 1,
      type = 'bandpass', freq = 2000, q = 1, freqTo = 0, sweepCurve = 'exp',
      hp = 0, lp = 0, drive = 0, attack = 0.0018, hold = 0, curve = 'exp',
    } = o;

    const s = this.src(source, { rate, loop: dur > NOISE_SECONDS * 0.6 });
    let node = s;
    if (type) {
      const f = this.filter(type, freq, q);
      if (freqTo) this.sweep(f.frequency, t, freq, freqTo, dur, sweepCurve);
      node = this.chain(node, f);
    }
    if (hp) node = this.chain(node, this.filter('highpass', hp, 0.7));
    if (lp) node = this.chain(node, this.filter('lowpass', lp, 0.7));
    if (drive) node = this.chain(node, this.shaper('tube', drive));

    const out = this.gain(0);
    node.connect(out);
    this.perc(out.gain, t, gain, dur, { attack, hold, curve });
    this.startAt(s, t, dur + 0.06);
    return out;
  }

  /** Single oscillator with optional pitch glide, filter and drive. */
  tone(t, o = {}) {
    const {
      type = 'sine', freq = 440, freqTo = 0, glide = 'exp', detune = 0,
      dur = 0.3, gain = 0.5, attack = 0.002, hold = 0, curve = 'exp',
      filter = null, filterFreq = 0, filterQ = 1, filterTo = 0, drive = 0,
    } = o;

    const osc = this.osc(type, freq, detune);
    if (freqTo) this.sweep(osc.frequency, t, freq, freqTo, dur, glide);
    let node = osc;
    if (filter) {
      const f = this.filter(filter, filterFreq || freq * 3, filterQ);
      if (filterTo) this.sweep(f.frequency, t, filterFreq || freq * 3, filterTo, dur);
      node = this.chain(node, f);
    }
    if (drive) node = this.chain(node, this.shaper('tube', drive));

    const out = this.gain(0);
    node.connect(out);
    this.perc(out.gain, t, gain, dur, { attack, hold, curve });
    this.startAt(osc, t, dur + 0.06);
    return out;
  }

  /**
   * Saturated sine with a steep downward pitch drop — the sub-bass "thump"
   * under every explosion, cannon and heavy footstep.
   */
  sub(t, o = {}) {
    const {
      freq = 120, freqTo = 36, dur = 0.55, gain = 0.9,
      drive = 2.4, attack = 0.004, curve = 'exp',
    } = o;
    return this.tone(t, {
      type: 'sine', freq, freqTo, dur, gain, attack, curve, drive,
      glide: 'exp',
    });
  }

  /**
   * Two-operator FM. A decaying modulation index is what gives energy weapons
   * their bright attack collapsing into a pure tone.
   */
  fm(t, o = {}) {
    const {
      carrier = 220, ratio = 2.0, index = 400, indexTo = 1, indexDur = 0,
      dur = 0.4, gain = 0.5, type = 'sine', modType = 'sine',
      attack = 0.002, hold = 0, curve = 'exp', carrierTo = 0, drive = 0,
    } = o;

    const c = this.osc(type, carrier);
    const m = this.osc(modType, carrier * ratio);
    const mg = this.gain(index);
    m.connect(mg);
    mg.connect(c.frequency);
    this.sweep(mg.gain, t, index, indexTo, indexDur || dur);
    if (carrierTo) this.sweep(c.frequency, t, carrier, carrierTo, dur);

    let node = c;
    if (drive) node = this.chain(node, this.shaper('fold', drive));
    const out = this.gain(0);
    node.connect(out);
    this.perc(out.gain, t, gain, dur, { attack, hold, curve });
    this.startAt(c, t, dur + 0.06);
    this.startAt(m, t, dur + 0.06);
    return out;
  }

  /** Detuned oscillator stack through a sweeping filter — brass, leads, drones. */
  stack(t, o = {}) {
    const {
      type = 'sawtooth', freq = 110, freqTo = 0, count = 5, spread = 14,
      dur = 0.6, gain = 0.4, attack = 0.01, hold = 0, curve = 'exp',
      filterFreq = 1400, filterTo = 0, q = 1, drive = 0, filterType = 'lowpass',
    } = o;

    const mix = this.gain(1 / Math.max(1, count));
    for (let i = 0; i < count; i++) {
      const osc = this.osc(type, freq);
      osc.detune.value = (i - (count - 1) / 2) * spread + this.rnd(-4, 4);
      if (freqTo) this.sweep(osc.frequency, t, freq, freqTo, dur);
      osc.connect(mix);
      this.startAt(osc, t, dur + 0.08);
    }
    let node = mix;
    const f = this.filter(filterType, filterFreq, q);
    if (filterTo) this.sweep(f.frequency, t, filterFreq, filterTo, dur);
    node = this.chain(node, f);
    if (drive) node = this.chain(node, this.shaper('asym', drive));

    const out = this.gain(0);
    node.connect(out);
    this.perc(out.gain, t, gain, dur, { attack, hold, curve });
    return out;
  }

  /**
   * Modal resonator — a bank of high-Q band-passes rung by a short exciter.
   * Inharmonic partial ratios are what separate "struck metal" from "a beep".
   */
  modal(t, o = {}) {
    const {
      freq = 1400,
      partials = [1, 1.71, 2.35, 3.11, 4.42],
      gains = null,
      decay = 0.45,
      decaySpread = 0.55,
      q = 22,
      gain = 0.6,
      exciteDur = 0.004,
      exciteSource = 'white',
      exciteFreq = 0,
      detune = 1,
    } = o;

    const ex = this.src(exciteSource, { rate: 1 + this.rnd(-0.1, 0.1) });
    let exNode = ex;
    if (exciteFreq) exNode = this.chain(exNode, this.filter('highpass', exciteFreq, 0.7));
    const exGain = this.gain(0);
    exNode.connect(exGain);
    this.perc(exGain.gain, t, 1, exciteDur, { attack: 0.0006, curve: 'lin' });
    this.startAt(ex, t, exciteDur + 0.05);

    const out = this.gain(gain);
    let longest = 0;
    for (let i = 0; i < partials.length; i++) {
      const f = freq * partials[i] * detune;
      if (f > this.sr * 0.45) continue;
      const bp = this.filter('bandpass', f, q * (1 + i * 0.15));
      const vg = this.gain(0);
      exGain.connect(bp);
      bp.connect(vg);
      vg.connect(out);
      const d = decay * Math.pow(decaySpread, i * 0.9 + 0.1) + 0.02;
      const amp = (gains ? gains[i] || 0 : 1 / (1 + i * 0.75));
      this.perc(vg.gain, t, amp * 6, d, { attack: 0.0008 });
      longest = Math.max(longest, d);
    }
    out._dur = longest;
    return out;
  }

  /**
   * Karplus-Strong string/plate: a noise burst circulating through a damped
   * delay line. Web Audio requires a DelayNode in any feedback cycle and
   * enforces a one-render-quantum minimum, so this is only accurate below
   * ~sampleRate/128 Hz — use it for low hull resonance, `modal()` for bright metal.
   */
  ks(t, o = {}) {
    const { freq = 180, dur = 0.9, damping = 2600, gain = 0.5, exciteDur = 0.006 } = o;
    const minDelay = 128 / this.sr;
    const period = Math.max(minDelay, 1 / Math.max(20, freq));

    const d = this.delay(period, 0.2);
    const damp = this.filter('lowpass', damping, 0.4);
    const fb = this.gain(Math.min(0.995, Math.pow(0.001, period / Math.max(0.05, dur))));

    const ex = this.src('white', { rate: 1 });
    const exGain = this.gain(0);
    ex.connect(exGain);
    this.perc(exGain.gain, t, 1, exciteDur, { attack: 0.0005, curve: 'lin' });
    this.startAt(ex, t, exciteDur + 0.05);

    exGain.connect(d);
    d.connect(damp);
    damp.connect(fb);
    fb.connect(d);

    const out = this.gain(0);
    damp.connect(out);
    this.perc(out.gain, t, gain, dur, { attack: 0.002 });
    return out;
  }

  /**
   * Grain field — sparse impulses for debris rattle, sparks and crackle.
   * `rate` controls both density and the size of the individual chunks.
   */
  grains(t, o = {}) {
    const {
      rate = 1, dur = 0.8, gain = 0.5, freq = 1800, q = 1.4,
      type = 'bandpass', freqTo = 0, attack = 0.01, hold = 0, curve = 'exp', drive = 0,
    } = o;
    const s = this.src('grain', { rate, loop: dur > NOISE_SECONDS * 0.6 });
    const f = this.filter(type, freq, q);
    if (freqTo) this.sweep(f.frequency, t, freq, freqTo, dur);
    let node = this.chain(s, f);
    if (drive) node = this.chain(node, this.shaper('tube', drive));
    const out = this.gain(0);
    node.connect(out);
    this.perc(out.gain, t, gain, dur, { attack, hold, curve });
    this.startAt(s, t, dur + 0.06);
    return out;
  }

  /**
   * Three-layer mixer: transient / body / tail. Real weapon design is built
   * this way — a click that cuts through, a body that carries the weight and a
   * tail that places it in the world.
   * @param {number} t start time
   * @param {AudioNode} out destination
   * @param {Array<{build:(t:number)=>AudioNode|null, gain?:number, delay?:number, dur?:number}>} layers
   * @returns {number} total duration
   */
  layer(t, out, layers) {
    let end = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L || !L.build) continue;
      const tt = t + (L.delay || 0);
      let node;
      try {
        node = L.build(tt);
      } catch (e) {
        node = null;
      }
      if (!node) continue;
      const lg = this.gain(L.gain == null ? 1 : L.gain);
      node.connect(lg);
      lg.connect(out);
      end = Math.max(end, (L.delay || 0) + (L.dur || node._dur || 0.3));
    }
    return end;
  }

  // ----------------------------------------------------------------- utils --

  rnd(a = 0, b = 1) {
    return a + Math.random() * (b - a);
  }

  /** Random pitch multiplier, +/- `cents`. Keeps repeated shots from phasing. */
  vary(cents = 60) {
    return Math.pow(2, this.rnd(-cents, cents) / 1200);
  }

  dispose() {
    this.buffers = Object.create(null);
  }
}

export { EPS as AUDIO_EPS };
export default Synth;
