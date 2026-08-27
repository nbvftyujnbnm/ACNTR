import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { Synth } from './Synth.js';
import {
  SFX,
  SFX_META,
  SFX_ALIASES,
  createThruster,
  createServo,
  createSpinUp,
  createAlarm,
  createAmbience,
} from './Sfx.js';
import { Music } from './Music.js';

/**
 * AudioDirector — the only object the rest of the game talks to about sound.
 *
 * Signal chain:
 *
 *   voice.in -> airLPF -> [HRTF panner | stereo pan] -> tap -> bus gain -.
 *                                                         \               \
 *                                                          '-> send ->.    '-> master
 *                                                                     |        |
 *   music/ambience buses -> duck gains -----------------------------> master   |
 *                                                                     |        |
 *              reverbIn -> preDelay -> convolver -> reverbOut --------'--------'
 *                                                                              |
 *                                        master -> concussion LPF -> limiter -> destination
 *
 * Everything is defensive: with no AudioContext (headless CI, `--mute-audio`,
 * a browser that blocks it) every method is a no-op and the game boots and runs
 * exactly as before.
 */

const MAX_VOICES = 48;
const STORE_KEY = 'acntr.audio.v1';
const MAX_AUDIBLE_DIST = 700;

const BUS_NAMES = ['sfx', 'weapons', 'music', 'ui', 'ambience'];

const DEFAULT_VOLUMES = {
  master: 0.9,
  sfx: 1.0,
  weapons: 1.0,
  music: 0.55,
  ui: 0.8,
  ambience: 0.55,
};

/** Rarity words that may arrive on loot payloads. */
const RARITY_INDEX = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, exotic: 4, unique: 4 };

// Module-scope scratch — the update path must not allocate.
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/** Read a position off any of the shapes our events use (Vector3, Object3D, Entity, {x,y,z}). */
function readPos(src, out) {
  if (!src) return null;
  if (src.isVector3) return out.copy(src);
  if (src.isObject3D) return src.getWorldPosition(out);
  if (typeof src.x === 'number' && typeof src.y === 'number' && typeof src.z === 'number') {
    return out.set(src.x, src.y, src.z);
  }
  if (src.root && src.root.isObject3D) return src.root.getWorldPosition(out);
  if (src.position) return readPos(src.position, out);
  if (src.point) return readPos(src.point, out);
  return null;
}

export class AudioDirector {
  /**
   * @param {THREE.Camera} camera listener transform source
   * @param {{game?: object}} [opts]
   */
  constructor(camera, opts = {}) {
    this.camera = camera || null;
    this.game = opts.game || null;

    this.ctx = null;
    this.synth = null;
    this.music = null;
    this.ready = false;
    this.failed = false;
    this.muted = false;
    this.quality = 'high';

    this.volumes = Object.assign({}, DEFAULT_VOLUMES);
    this._loadSettings();

    /** @type {Array<object>} */
    this._voices = [];
    this._cool = new Map();

    // combat -> music intensity
    this._heat = 0;
    this._heatFloor = 0;

    // lock-on chain state
    this._lock = { progress: 0, active: false, confirmed: false, next: 0 };

    // continuous sources
    this._thruster = null;
    this._servo = null;
    this._spin = null;
    this._alarm = null;
    this._ambience = null;

    this._boostTarget = 0;
    this._spinTarget = 0;
    this._spinHold = 0;
    this._servoTarget = 0;
    this._alarmTarget = 0;

    this._unsubs = [];
    this._gestureEvents = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
    this._onGesture = null;

    this._wireEvents();
    this._armGesture();
  }

  // =========================================================== bootstrap ====

  /**
   * Browsers refuse to start an AudioContext without a user gesture, so we do
   * not create one until we see one. Until then every entry point no-ops.
   */
  _armGesture() {
    const kick = () => this._init();
    this._unsubs.push(bus.on('input:locked', kick));
    this._unsubs.push(bus.on(EV.GAME_START, kick));

    if (typeof document !== 'undefined') {
      this._onGesture = () => this._init();
      for (const ev of this._gestureEvents) {
        document.addEventListener(ev, this._onGesture, { passive: true, capture: true });
      }
    }

    // If the page has already been interacted with (hot reload, harness click)
    // we can start immediately rather than waiting for another gesture.
    try {
      if (typeof navigator !== 'undefined' && navigator.userActivation && navigator.userActivation.hasBeenActive) {
        this._init();
      }
    } catch (e) {
      /* userActivation unsupported */
    }
  }

  _disarmGesture() {
    if (this._onGesture && typeof document !== 'undefined') {
      for (const ev of this._gestureEvents) {
        document.removeEventListener(ev, this._onGesture, { capture: true });
      }
      this._onGesture = null;
    }
  }

  /** Idempotent. Creates the context and graph, or gives up permanently. */
  _init() {
    if (this.failed) return;
    if (this.ctx) {
      this._resume();
      return;
    }
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) {
      this.failed = true;
      return;
    }
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.synth = new Synth(this.ctx);
      this._buildGraph();
      this._buildVoices();
      this._startContinuous();
      this.ready = true;
    } catch (err) {
      this.failed = true;
      this.ctx = null;
      this.synth = null;
      return;
    }
    this._applyVolumes();
    this._resume();
  }

  _resume() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    if (this.ctx.state === 'running') this._disarmGesture();
  }

  _buildGraph() {
    const ctx = this.ctx;
    const S = this.synth;

    // A real limiter: hard ratio, fast attack, so 40 simultaneous events squash
    // instead of clipping into digital distortion.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -7;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.22;
    this.limiter.connect(ctx.destination);

    // "Concussion" filter — normally wide open, slammed shut for a moment when
    // the player takes a heavy hit. Costs one biquad and sells every impact.
    this.concussion = S.filter('lowpass', 20000, 0.7);
    this.concussion.connect(this.limiter);

    this.master = S.gain(this.muted ? 0 : this.volumes.master);
    this.master.connect(this.concussion);

    // Buses.
    this.buses = {};
    for (const name of BUS_NAMES) {
      this.buses[name] = S.gain(this.volumes[name] == null ? 1 : this.volumes[name]);
    }
    // Music and ambience pass through duckers so explosions can push them down.
    this.duckMusic = S.gain(1);
    this.duckAmbience = S.gain(1);
    this.buses.music.connect(this.duckMusic);
    this.duckMusic.connect(this.master);
    this.buses.ambience.connect(this.duckAmbience);
    this.duckAmbience.connect(this.master);
    this.buses.sfx.connect(this.master);
    this.buses.weapons.connect(this.master);
    this.buses.ui.connect(this.master);

    // Convolution reverb: a large industrial hall, generated procedurally.
    this.reverbIn = S.gain(1);
    this.preDelay = S.delay(0.021, 0.2);
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = S.impulseResponse({ seconds: 2.2, decay: 3.4, preDelay: 0.0, damping: 0.85 });
    this.reverbOut = S.gain(0.85);
    // Trim the very bottom out of the tail so the reverb never muddies the sub.
    this.reverbHP = S.filter('highpass', 180, 0.7);
    S.chain(this.reverbIn, this.preDelay, this.convolver, this.reverbHP, this.reverbOut, this.master);

    // Listener defaults.
    const L = ctx.listener;
    if (L.forwardX) {
      L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else if (L.setOrientation) {
      L.setOrientation(0, 0, -1, 0, 1, 0);
    }
  }

  _buildVoices() {
    for (let i = 0; i < MAX_VOICES; i++) this._voices.push(this._makeVoice());
  }

  _makeVoice() {
    const ctx = this.ctx;
    const S = this.synth;

    const air = S.filter('lowpass', 20000, 0.6);

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 20;
    panner.maxDistance = 2000;
    panner.rolloffFactor = 1.05;
    panner.coneInnerAngle = 360;

    let pan2d = null;
    if (ctx.createStereoPanner) {
      pan2d = ctx.createStereoPanner();
    } else {
      pan2d = S.gain(1); // ancient browser: no stereo placement, still audible
    }

    const tap = S.gain(1);
    const send = S.gain(0);
    panner.connect(tap);
    pan2d.connect(tap);
    tap.connect(send);
    send.connect(this.reverbIn);

    return {
      input: null,
      air,
      panner,
      pan2d,
      tap,
      send,
      busNode: null,
      spatial: false,
      active: false,
      endTime: 0,
      startTime: 0,
      priority: 0,
      name: '',
    };
  }

  _startContinuous() {
    const S = this.synth;
    this._thruster = createThruster(S, this.buses.sfx);
    this._servo = createServo(S, this.buses.sfx);
    this._spin = createSpinUp(S, this.buses.weapons);
    this._alarm = createAlarm(S, this.buses.ui);
    this._ambience = createAmbience(S, this.buses.ambience, (name, params) => {
      // Ambience one-shots are placed far away, in random directions.
      const a = Math.random() * Math.PI * 2;
      const d = 160 + Math.random() * 340;
      _tmp.set(Math.cos(a) * d, 20 + Math.random() * 60, Math.sin(a) * d);
      if (this.camera) {
        this.camera.getWorldPosition(_pos);
        _tmp.add(_pos);
      }
      this.play(name, _tmp, params);
    });

    this.music = new Music(this.ctx, S, this.buses.music, this.reverbIn);
    this.music.start();
  }

  // ============================================================== playback ==

  /**
   * Play a sound.
   * @param {string} name key in the SFX bank (aliases accepted)
   * @param {THREE.Vector3|{x,y,z}|null} position world position, or null for a 2D/local sound
   * @param {object} [params] forwarded to the sound; `gain`, `pitch`, `local`, `pan`, `scale`...
   * @returns {object|null} the voice, or null if it was culled
   */
  play(name, position, params) {
    if (!this.ready || this.muted || !this.ctx) return null;
    if (this.ctx.state !== 'running') {
      this._resume();
      if (this.ctx.state !== 'running') return null;
    }

    const key = SFX[name] ? name : SFX_ALIASES[name];
    const fn = key ? SFX[key] : null;
    if (!fn) return null;

    const meta = SFX_META[key] || ['sfx', 0.03, 0.2, 20];
    const now = this.ctx.currentTime;
    const o = params || {};

    // --- cooldown: many identical events in one frame collapse into one voice
    const cd = o.ignoreCooldown ? 0 : meta[1];
    const last = this._cool.get(key);
    if (cd > 0 && last && now - last.t < cd) {
      // "Play one and scale it" — nudge the voice that is already sounding.
      if (last.voice && last.voice.active && last.voice.input && now < last.voice.startTime + 0.06) {
        const g = last.voice.input.gain;
        const next = Math.min(2.2, (g.value || 1) * 1.22);
        try {
          g.setTargetAtTime(next, now, 0.008);
        } catch (e) { /* ignore */ }
      }
      return null;
    }

    // --- spatialisation
    const spatial = !o.local && !!readPos(position, _tmp);
    let dist = 0;
    if (spatial) {
      if (this.camera) {
        this.camera.getWorldPosition(_pos);
        dist = _tmp.distanceTo(_pos);
      }
      if (dist > MAX_AUDIBLE_DIST) return null;
    }

    const v = this._acquire(now, o.priority || 0);
    if (!v) return null;

    // A fresh input gain per acquire: releasing the voice disconnects it, which
    // instantly silences whatever was still ringing without touching the
    // (expensive) pooled HRTF panner behind it.
    const S = this.synth;
    v.input = S.gain(1);
    v.input.connect(v.air);

    // Route the tail of the chain: HRTF for world sounds, stereo for local ones.
    try {
      v.air.disconnect();
    } catch (e) { /* not connected */ }
    if (spatial) {
      v.air.connect(v.panner);
      this._setPannerPos(v.panner, _tmp);
      v.panner.refDistance = meta[3] || 20;
      // Air absorption: distance eats the top end. Cheap, and enormously
      // effective at giving the arena a sense of scale.
      const cutoff = Math.max(700, 20000 * Math.exp(-dist / 190));
      v.air.frequency.setValueAtTime(cutoff, now);
    } else {
      v.air.connect(v.pan2d);
      if (v.pan2d.pan) v.pan2d.pan.setValueAtTime(Math.max(-1, Math.min(1, o.pan || 0)), now);
      v.air.frequency.setValueAtTime(20000, now);
    }
    v.spatial = spatial;

    // Bus routing.
    const busName = o.bus || meta[0];
    const busNode = this.buses[busName] || this.buses.sfx;
    if (v.busNode !== busNode) {
      if (v.busNode) {
        try {
          v.tap.disconnect(v.busNode);
        } catch (e) { /* already gone */ }
      }
      v.tap.connect(busNode);
      v.busNode = busNode;
    }

    // Reverb send: more for distant sounds, less for things in your cockpit.
    let sendAmt = o.send == null ? meta[2] : o.send;
    if (spatial) sendAmt *= 0.55 + Math.min(1.4, dist / 160);
    v.send.gain.setValueAtTime(Math.max(0, Math.min(1.6, sendAmt)), now);

    // --- build the sound
    const start = now + 0.004; // a hair of headroom so nothing schedules in the past
    let dur = 0.4;
    try {
      dur = fn(S, { t: start, out: v.input, ctx: this.ctx }, o) || 0.4;
    } catch (err) {
      dur = 0.3;
    }

    v.active = true;
    v.name = key;
    v.startTime = start;
    v.endTime = start + Math.max(0.05, dur) + 0.35;
    v.priority = o.priority || 0;

    this._cool.set(key, { t: now, voice: v });
    return v;
  }

  /** Grab a free voice, or steal the one that is furthest through its life. */
  _acquire(now, priority) {
    let free = null;
    let steal = null;
    let stealScore = Infinity;
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      if (!v.active || v.endTime <= now) {
        if (v.active) this._release(v);
        free = v;
        break;
      }
      // Prefer stealing old, low-priority voices.
      const score = v.priority * 1000 + (v.endTime - now);
      if (score < stealScore) {
        stealScore = score;
        steal = v;
      }
    }
    if (free) return free;
    if (!steal) return null;
    if (steal.priority > priority) return null; // never rob something more important
    this._release(steal);
    return steal;
  }

  /** Orphan whatever this voice was playing; the old nodes go silent and get GC'd. */
  _release(v) {
    if (v.input) {
      try {
        v.input.disconnect();
      } catch (e) { /* ignore */ }
      v.input = null;
    }
    v.active = false;
    v.name = '';
  }

  _setPannerPos(panner, p) {
    if (panner.positionX) {
      const t = this.ctx.currentTime;
      panner.positionX.setValueAtTime(p.x, t);
      panner.positionY.setValueAtTime(p.y, t);
      panner.positionZ.setValueAtTime(p.z, t);
    } else if (panner.setPosition) {
      panner.setPosition(p.x, p.y, p.z);
    }
  }

  // ================================================================= mix ====

  /**
   * Dip music and ambience so a big event has room. Explosions and the stagger
   * break are the only things allowed to do this.
   */
  duck(depth = 0.42, hold = 0.09, release = 0.7) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const d = Math.max(0.05, Math.min(1, depth));
    for (const n of [this.duckMusic, this.duckAmbience]) {
      const g = n.gain;
      let cur = 1;
      try {
        cur = Math.max(0.05, g.value);
      } catch (e) { /* ignore */ }
      if (d >= cur) continue; // never un-duck something that is ducked harder
      g.cancelScheduledValues(t);
      g.setValueAtTime(cur, t);
      g.exponentialRampToValueAtTime(d, t + 0.035);
      g.setValueAtTime(d, t + 0.035 + hold);
      g.exponentialRampToValueAtTime(1, t + 0.035 + hold + release);
    }
  }

  /**
   * Signature "your ears are ringing" sweep: slam a low-pass across the whole
   * master bus and let it open back up. Used for heavy hits and stagger.
   * @param {number} strength 0..1
   */
  concuss(strength = 1) {
    if (!this.ready) return;
    const s = Math.max(0.1, Math.min(1, strength));
    const t = this.ctx.currentTime;
    const f = this.concussion.frequency;
    const q = this.concussion.Q;
    const low = 1400 - 1100 * s;
    let cur = 20000;
    try {
      cur = Math.max(200, f.value);
    } catch (e) { /* ignore */ }
    f.cancelScheduledValues(t);
    f.setValueAtTime(cur, t);
    f.exponentialRampToValueAtTime(low, t + 0.03);
    f.exponentialRampToValueAtTime(20000, t + 0.06 + 0.95 * s);
    q.cancelScheduledValues(t);
    q.setValueAtTime(q.value, t);
    q.linearRampToValueAtTime(0.7 + 1.8 * s, t + 0.04);
    q.linearRampToValueAtTime(0.7, t + 0.06 + 0.95 * s);
  }

  // --- volumes / mute ------------------------------------------------------

  /** @param {'master'|'sfx'|'weapons'|'music'|'ui'|'ambience'} name */
  setVolume(name, value) {
    const v = Math.max(0, Math.min(1.5, Number(value) || 0));
    if (!(name in this.volumes)) return;
    this.volumes[name] = v;
    this._applyVolumes();
    this._saveSettings();
  }

  getVolume(name) {
    return this.volumes[name] == null ? 0 : this.volumes[name];
  }

  setMuted(on) {
    this.muted = !!on;
    this._applyVolumes();
    this._saveSettings();
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  isMuted() {
    return this.muted;
  }

  _applyVolumes() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.03);
    for (const name of BUS_NAMES) {
      const g = this.buses[name];
      if (g) g.gain.setTargetAtTime(this.volumes[name] == null ? 1 : this.volumes[name], t, 0.05);
    }
  }

  /** @param {'low'|'med'|'high'|'ultra'} level */
  setQuality(level) {
    this.quality = level;
    if (!this.ready) return;
    const model = level === 'low' ? 'equalpower' : 'HRTF';
    for (const v of this._voices) {
      try {
        v.panner.panningModel = model;
      } catch (e) { /* ignore */ }
    }
    if (this.reverbOut) {
      this.reverbOut.gain.setTargetAtTime(level === 'low' ? 0.45 : 0.85, this.ctx.currentTime, 0.2);
    }
  }

  _loadSettings() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        if (d.volumes) {
          for (const k in DEFAULT_VOLUMES) {
            if (typeof d.volumes[k] === 'number') this.volumes[k] = d.volumes[k];
          }
        }
        this.muted = !!d.muted;
      }
    } catch (e) {
      /* storage unavailable or corrupt — defaults are fine */
    }
  }

  _saveSettings() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORE_KEY, JSON.stringify({ volumes: this.volumes, muted: this.muted }));
    } catch (e) {
      /* quota / private mode — ignore */
    }
  }

  // ================================================================ events ==

  _wireEvents() {
    const on = (type, fn) => this._unsubs.push(bus.on(type, (p) => {
      try {
        fn.call(this, p || {});
      } catch (e) {
        /* audio must never break gameplay */
      }
    }));

    on(EV.SFX, this._onGeneric);
    on(EV.WEAPON_FIRED, this._onWeaponFired);
    on(EV.IMPACT, this._onImpact);
    on(EV.DAMAGE_DEALT, this._onDamage);
    on(EV.PLAYER_HIT, this._onPlayerHit);
    on(EV.STAGGER, this._onStagger);
    on(EV.ENTITY_KILLED, this._onKilled);
    on(EV.QUICK_BOOST, this._onQuickBoost);
    on(EV.ASSAULT_BOOST, this._onAssaultBoost);
    on(EV.LANDED, this._onLanded);
    on(EV.EN_EMPTY, this._onEnEmpty);
    on(EV.LOCK_STATE, this._onLockState);
    on(EV.LOOT_PICKUP, this._onPickup);
    on(EV.LOOT_DROP, this._onLootDrop);
    on(EV.PART_EQUIPPED, this._onEquipped);
    on(EV.BUILD_CHANGED, () => this.play('ui_click', null, { gain: 0.6 }));
    on(EV.GAME_OVER, this._onGameOver);
    on(EV.MISSION_COMPLETE, this._onMissionComplete);
    on(EV.GAME_START, this._onGameStart);
    on(EV.PAUSE, () => this.duck(0.45, 0.2, 0.4));
    on('mission:log', this._onLog);
  }

  /** `EV.SFX` — the open door: `{ name, position, params }`. */
  _onGeneric(e) {
    const name = e.name || e.id || e.sound;
    if (!name) return;
    const params = e.params || e.opts || {};

    // A few names address the continuous sources rather than the one-shot bank.
    switch (name) {
      case 'boost':
      case 'thruster':
        this._boostTarget = params.intensity == null ? (params.on === false ? 0 : 1) : params.intensity;
        return;
      case 'servo':
        this._servoTarget = params.speed == null ? 0 : params.speed;
        return;
      case 'alarm':
        this._alarmTarget = params.urgency == null ? (params.on ? 1 : 0) : params.urgency;
        return;
      case 'gatling_spin':
        this._spinTarget = params.spin == null ? 1 : params.spin;
        this._spinHold = 0.35;
        return;
      case 'boss':
        if (this.music) this.music.setBoss(params.active !== false);
        return;
      default:
        break;
    }
    this.play(name, e.position || e.point || params.position || null, params);
  }

  _onWeaponFired(e) {
    const id = e.weaponId || e.id || (e.weapon && (e.weapon.id || (e.weapon.def && e.weapon.def.id))) || (e.def && e.def.id) || e.name;
    const name = this._weaponSound(id);
    const owner = e.owner || e.entity || e.shooter;
    const isPlayer = e.isPlayer != null ? e.isPlayer : !!(owner && owner.isPlayer);
    const pos = e.position || e.point || e.origin || e.muzzle || owner;

    const opts = {
      gain: isPlayer ? 1 : 0.8,
      local: isPlayer,
      pan: this._slotPan(e.slot || e.hardpoint),
      priority: isPlayer ? 2 : 1,
      charge: e.charge,
      count: e.count,
      pitch: e.pitch,
    };
    this.play(name, isPlayer ? null : pos, opts);

    if (e.dry) this.play('w_dryfire', isPlayer ? null : pos, { local: isPlayer });
    if (e.reload) this.play('w_reload', isPlayer ? null : pos, { local: isPlayer });

    // A gatling firing keeps its barrels spinning.
    if (name === 'gatling_gu_a2') {
      this._spinTarget = 1;
      this._spinHold = 0.3;
    }

    this._heat = Math.min(1, this._heat + (isPlayer ? 0.03 : 0.02));
  }

  _weaponSound(id) {
    if (id && SFX[id]) return id;
    const s = String(id || '').toLowerCase();
    if (s.includes('gatling') || s.includes('gu_')) return 'gatling_gu_a2';
    if (s.includes('shotgun') || s.includes('sg')) return 'shotgun_sg027';
    if (s.includes('swarm')) return 'missile_swarm';
    if (s.includes('missile') || s.includes('bml')) return 'missile_bml';
    if (s.includes('bazooka') || s.includes('mj')) return 'bazooka_mj24';
    if (s.includes('cannon') || s.includes('earshot')) return 'cannon_earshot';
    if (s.includes('plasma')) return 'plasma_pr16';
    if (s.includes('laser')) return 'laser_lr37';
    if (s.includes('blade') || s.includes('melee')) return 'pulse_blade';
    if (s.includes('shield')) return 'pulse_shield';
    if (s.includes('pod') || s.includes('orbit')) return 'orbit_pod';
    if (s.includes('handgun') || s.includes('pistol') || s.includes('hg')) return 'handgun_hg003';
    if (s.includes('linear') || s.includes('_lr')) return 'rifle_lr';
    return 'rifle_rf025';
  }

  _slotPan(slot) {
    switch (slot) {
      case 'rArm': return 0.35;
      case 'lArm': return -0.35;
      case 'rShoulder': return 0.2;
      case 'lShoulder': return -0.2;
      default: return 0;
    }
  }

  _onImpact(e) {
    const raw = String(e.type || e.surface || e.material || 'metal').toLowerCase();
    let name = 'imp_metal';
    if (raw.includes('concrete') || raw.includes('ground') || raw.includes('dirt') || raw.includes('rock')) name = 'imp_concrete';
    else if (raw.includes('energy') || raw.includes('plasma') || raw.includes('laser')) name = 'imp_energy';
    else if (raw.includes('shield')) name = 'imp_shield';
    else if (raw.includes('flesh') || raw.includes('body')) name = 'imp_flesh';

    const pos = e.position || e.point || e.pos;
    const scale = e.scale || e.size || 1;
    if (e.explosive || raw.includes('explos')) {
      this.play('explosion', pos, { scale: scale * (e.radius ? Math.min(2, e.radius / 8) : 1), priority: 3 });
      this.duck(0.55, 0.06, 0.55);
      return;
    }
    this.play(name, pos, { scale });
  }

  _onDamage(e) {
    const info = e.info || e.damage || e;
    const source = info.source || e.source;
    const fromPlayer = e.byPlayer != null ? e.byPlayer : !!(source && source.isPlayer);
    const target = e.entity || e.target || info.target;
    const targetIsPlayer = !!(target && target.isPlayer);

    if (fromPlayer && !targetIsPlayer) {
      // Hit feedback is a cockpit sound, not a world sound.
      if (info.direct) this.play('direct_hit', null, { gain: 1, priority: 3 });
      else this.play('hit_confirm', null, { gain: 0.6 });
    }
    this._heat = Math.min(1, this._heat + 0.045);
  }

  _onPlayerHit(e) {
    const info = e.info || e;
    const amount = info.amount || e.amount || 0;
    const max = (e.apMax || (e.entity && e.entity.stats && e.entity.stats.apMax)) || 6000;
    const severity = Math.max(0.15, Math.min(1, amount / (max * 0.05)));

    this.play('damage_clang', null, { scale: 0.6 + severity * 1.2, priority: 3 });
    if (severity > 0.55) {
      this.concuss(Math.min(0.85, severity));
      this.duck(0.6, 0.05, 0.45);
    }
    this._heat = Math.min(1, this._heat + 0.09 + severity * 0.08);
  }

  _onStagger(e) {
    const entity = e.entity || e.target || e;
    const isPlayer = !!(entity && entity.isPlayer);
    const pos = isPlayer ? null : entity;

    this.play('stagger_break', pos, { player: isPlayer, local: isPlayer, priority: 5 });
    this.duck(isPlayer ? 0.28 : 0.42, 0.22, 0.9);
    this.concuss(isPlayer ? 1 : 0.45);
    this._heat = Math.min(1, this._heat + 0.28);
  }

  _onKilled(e) {
    const entity = e.entity || e.target || e;
    const isPlayer = !!(entity && entity.isPlayer);
    const scale = e.scale || (entity && entity.tier ? 0.8 + entity.tier * 0.25 : 1);

    this.play('explosion', isPlayer ? null : entity, { scale, priority: 4, local: isPlayer });
    this.duck(0.5, 0.1, 0.7);
    if (!isPlayer) {
      this.play('kill_confirm', null, { gain: 0.75 });
      this._heat = Math.min(1, this._heat + 0.12);
    } else {
      this.concuss(1);
    }
  }

  _onQuickBoost(e) {
    const isPlayer = e.isPlayer != null ? e.isPlayer : !(e.entity && !e.entity.isPlayer);
    this.play('quick_boost', isPlayer ? null : (e.position || e.entity), {
      local: isPlayer,
      priority: 2,
      pan: e.dir && typeof e.dir.x === 'number' ? Math.max(-0.6, Math.min(0.6, -e.dir.x * 0.6)) : 0,
    });
  }

  _onAssaultBoost(e) {
    if (e.active === false || e.on === false || e.end) {
      this._boostTarget = Math.min(this._boostTarget, 0.35);
      return;
    }
    this.play('assault_boost', null, { priority: 3 });
    this._boostTarget = 1.35;
  }

  _onLanded(e) {
    const speed = e.speed || e.impact || (e.velocity && Math.abs(e.velocity.y)) || 8;
    const impact = Math.max(0.15, Math.min(1.4, speed / 26));
    if (impact < 0.18) return;
    this.play('land', e.position || null, {
      impact,
      weight: e.weight || 1,
      local: e.isPlayer !== false && !e.position,
      priority: 2,
    });
    if (impact > 0.9) this.concuss(0.35);
  }

  _onEnEmpty() {
    this.play('en_empty', null, { priority: 2 });
  }

  _onLockState(e) {
    const p = e.progress != null ? e.progress : e.lockProgress;
    this._lock.progress = Math.max(0, Math.min(1, p == null ? this._lock.progress : p));

    // Payload shapes vary between emitters; fall back to progress as evidence
    // that a target exists rather than reading "no target" and killing the chain.
    let has;
    if (e.target !== undefined) has = !!e.target;
    else if (e.hasTarget !== undefined) has = !!e.hasTarget;
    else if (e.locked !== undefined) has = !!e.locked;
    else has = this._lock.progress > 0.01;

    if (!has || e.lost) {
      if (this._lock.confirmed || this._lock.active) this.play('lock_lost', null, { gain: 0.7 });
      this._lock.active = false;
      this._lock.confirmed = false;
      return;
    }
    if (!this._lock.active) {
      this._lock.active = true;
      this._lock.confirmed = false;
      this._lock.next = 0;
    }
    if ((e.hardLock || this._lock.progress >= 0.999) && !this._lock.confirmed) {
      this._lock.confirmed = true;
      this.play('lock_confirm', null, { priority: 3 });
    }
  }

  _onPickup(e) {
    const part = e.part || e.item || e;
    let r = part.rarity;
    if (typeof r === 'string') r = RARITY_INDEX[r.toLowerCase()] == null ? 0 : RARITY_INDEX[r.toLowerCase()];
    if (typeof r !== 'number') r = part.tier || 0;
    this.play('ui_pickup', null, { rarity: Math.max(0, Math.min(4, Math.round(r))), priority: 3 });
  }

  _onLootDrop(e) {
    this.play('ui_log', e.position || e.point || null, { gain: 0.5 });
  }

  _onEquipped() {
    this.play('ui_equip', null, { priority: 2 });
  }

  _onGameStart() {
    this._init();
    this._heat = 0;
    if (this.music) {
      this.music.setBoss(false);
      this.music.setIntensity(0);
    }
  }

  _onGameOver() {
    this.play('game_over', null, { priority: 6 });
    this.duck(0.2, 1.2, 2.5);
    this._heat = 0;
    this._heatFloor = 0;
    this._alarmTarget = 0;
    this._boostTarget = 0;
    if (this.music) {
      this.music.setIntensity(0);
      this.music.setBoss(false);
    }
  }

  _onMissionComplete() {
    this.play('mission_complete', null, { priority: 6 });
    this.duck(0.25, 1.0, 2.2);
    this._heat = 0;
    this._heatFloor = 0;
    if (this.music) {
      this.music.setIntensity(0.15);
      this.music.setBoss(false);
    }
  }

  _onLog(e) {
    const text = typeof e === 'string' ? e : e.text || e.message || '';
    this.play('ui_log', null, { gain: 0.55 });
    const t = text.toLowerCase();
    if (this.music) {
      if (t.includes('boss') || t.includes('ac detected') || t.includes('priority target')) this.music.setBoss(true);
      else if (t.includes('area clear') || t.includes('target destroyed') && t.includes('boss')) this.music.setBoss(false);
    }
    if (t.includes('warning') || t.includes('critical') || t.includes('danger')) {
      this.play('ui_warning', null, { gain: 0.55 });
    }
  }

  // ================================================================ update ==

  /**
   * Frame tick: sync the listener to the camera, retire finished voices, drive
   * the continuous sources and the music intensity.
   * @param {number} dt seconds
   * @param {number} elapsed seconds since start
   */
  update(dt, elapsed) {
    if (!this.ready) {
      // The context may become creatable once the page has been interacted with.
      if (!this.failed && typeof navigator !== 'undefined' && navigator.userActivation &&
          navigator.userActivation.hasBeenActive) {
        this._init();
      }
      return;
    }
    if (this.ctx.state === 'suspended') {
      this._resume();
      return;
    }

    const now = this.ctx.currentTime;
    const step = Math.max(0.0001, Math.min(0.1, dt || 0.016));

    this._syncListener();

    // Retire voices whose scheduled life has ended.
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      if (v.active && v.endTime <= now) this._release(v);
    }

    this._pollGameState(step);

    // --- continuous sources
    if (this._thruster) this._thruster.set(this._boostTarget, 1 + Math.max(0, this._boostTarget - 1) * 0.3);
    if (this._servo) this._servo.set(this._servoTarget);
    if (this._alarm) this._alarm.set(this._alarmTarget);
    if (this._spin) {
      if (this._spinHold > 0) this._spinHold -= step;
      else this._spinTarget = Math.max(0, this._spinTarget - step * 1.6);
      this._spin.set(this._spinTarget);
    }
    if (this._ambience) {
      this._ambience.update();
      // Thin the bed out while the music is loud so the mix stays readable.
      this._ambience.setLevel(0.6 - 0.35 * this._heat);
    }

    // --- lock-on chain: the interval tightens as the reticle converges
    const lk = this._lock;
    if (lk.active && !lk.confirmed) {
      if (now >= lk.next) {
        this.play('lock_tick', null, { progress: lk.progress, gain: 0.8, ignoreCooldown: true });
        lk.next = now + (0.24 - 0.185 * lk.progress);
      }
      if (lk.progress >= 0.999) {
        lk.confirmed = true;
        this.play('lock_confirm', null, { priority: 3 });
      }
    }

    // --- music intensity
    this._heat = Math.max(this._heatFloor, this._heat - step * 0.115);
    if (this.music) {
      this.music.setIntensity(this._heat);
      this.music.update(step);
    }
  }

  _syncListener() {
    if (!this.camera) return;
    const L = this.ctx.listener;
    this.camera.getWorldPosition(_pos);
    this.camera.getWorldQuaternion(_quat);
    _fwd.set(0, 0, -1).applyQuaternion(_quat);
    _up.set(0, 1, 0).applyQuaternion(_quat);

    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(_pos.x, t);
      L.positionY.setValueAtTime(_pos.y, t);
      L.positionZ.setValueAtTime(_pos.z, t);
      L.forwardX.setValueAtTime(_fwd.x, t);
      L.forwardY.setValueAtTime(_fwd.y, t);
      L.forwardZ.setValueAtTime(_fwd.z, t);
      L.upX.setValueAtTime(_up.x, t);
      L.upY.setValueAtTime(_up.y, t);
      L.upZ.setValueAtTime(_up.z, t);
    } else {
      if (L.setPosition) L.setPosition(_pos.x, _pos.y, _pos.z);
      if (L.setOrientation) L.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  /**
   * Read (never write) whatever game state happens to exist so the continuous
   * layers track the mech even if no subsystem bothers to emit for them.
   * Everything here is optional and failure-tolerant.
   */
  _pollGameState(dt) {
    if (!this.game && typeof window !== 'undefined' && window.__ACNTR__) {
      this.game = window.__ACNTR__.game || null;
    }
    const g = this.game;
    if (!g) return;
    try {
      const st = g.controller && g.controller.state;
      const player = g.player;

      if (st) {
        let target = 0;
        if (st.assaultBoost) target = 1.35;
        else if (st.boosting) target = 0.75;
        else if (!st.grounded) target = 0.4;
        if (st.qbTimer > 0) target = Math.max(target, 1.0);
        // Speed adds the last of the intensity so acceleration is audible.
        const spd = st.speed || (player && player.velocity ? player.velocity.length() : 0);
        target = Math.min(1.4, target + Math.min(0.35, spd / 240));
        this._boostTarget += (target - this._boostTarget) * Math.min(1, dt * 9);
      }

      if (player) {
        const s = player.stats;
        if (s && s.apMax > 0) {
          const frac = s.ap / s.apMax;
          const urgency = frac < 0.28 && player.alive !== false ? Math.min(1, (0.28 - frac) / 0.24) : 0;
          this._alarmTarget += (urgency - this._alarmTarget) * Math.min(1, dt * 3);
        }
        if (player.velocity) {
          const sp = Math.min(1, player.velocity.length() / 90);
          this._servoTarget += (sp - this._servoTarget) * Math.min(1, dt * 6);
        }
      }

      // Enemies nearby hold the music above a floor even between shots.
      const list = g.enemies && g.enemies.list;
      if (list && player && player.root) {
        let engaged = 0;
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (!e || e.alive === false || !e.root) continue;
          if (e.root.position.distanceToSquared(player.root.position) < 240 * 240) engaged++;
        }
        this._heatFloor = Math.min(0.62, engaged * 0.16);
        if (this._heat < this._heatFloor) this._heat = this._heatFloor;
      }
    } catch (e) {
      // Subsystems are built in parallel; a shape mismatch must not be fatal.
      this.game = this.game && this.game.player ? this.game : null;
    }
  }

  /** Optional explicit attach, if a caller would rather not rely on the global. */
  attach(game) {
    this.game = game || null;
  }

  // =============================================================== teardown ==

  dispose() {
    for (const off of this._unsubs) {
      try {
        off();
      } catch (e) { /* ignore */ }
    }
    this._unsubs.length = 0;
    this._disarmGesture();

    if (this.music) {
      this.music.dispose();
      this.music = null;
    }
    for (const loop of [this._thruster, this._servo, this._spin, this._alarm, this._ambience]) {
      try {
        if (loop) loop.stop(0.05);
      } catch (e) { /* ignore */ }
    }
    this._thruster = this._servo = this._spin = this._alarm = this._ambience = null;

    for (const v of this._voices) {
      try {
        this._release(v);
        v.air.disconnect();
        v.panner.disconnect();
        v.pan2d.disconnect();
        v.tap.disconnect();
        v.send.disconnect();
      } catch (e) { /* ignore */ }
    }
    this._voices.length = 0;
    this._cool.clear();

    if (this.ctx) {
      try {
        if (this.master) this.master.disconnect();
        if (this.reverbOut) this.reverbOut.disconnect();
        if (this.convolver) this.convolver.disconnect();
        if (this.concussion) this.concussion.disconnect();
        if (this.limiter) this.limiter.disconnect();
      } catch (e) { /* ignore */ }
      try {
        const p = this.ctx.close();
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* ignore */ }
    }
    if (this.synth) this.synth.dispose();
    this.ctx = null;
    this.synth = null;
    this.ready = false;
  }
}

export default AudioDirector;
