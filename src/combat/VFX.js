import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, lerp, randRange, TAU } from '../core/MathUtils.js';
import { ParticleSystem, BATCH_ADD, BATCH_ALPHA, TILE } from './ParticleSystem.js';

/**
 * VFX — every combat effect in ACNTR.
 *
 * Two entry points, both always valid:
 *   - direct calls (`vfx.impact(...)`) for systems that hold a reference,
 *   - bus events (`EV.IMPACT`, `EV.STAGGER`, `EV.QUICK_BOOST`, `EV.ENTITY_KILLED`)
 *     so subsystems that never heard of VFX still get feedback.
 * Event-driven impacts are de-duplicated against direct calls at the same place
 * and time, so wiring both up does not double the effect.
 *
 * Timing philosophy, lifted straight from AC6: hits are *violent and gone*.
 * Flashes live 40-70ms, sparks 200-500ms, shockwaves 300ms. Only smoke lingers.
 * Anything that hangs around reads as sluggish and immediately breaks the feel.
 *
 * Colour philosophy: additive layers emit HDR (rgb well above 1.0) so the bloom
 * pass gives them a blown-out core and a soft halo. Alpha layers — smoke, dust,
 * debris — stay under 1.0 and are deliberately *not* uniform grey: fire-lit
 * smoke is warm at birth and cools to near-black soot.
 */

// --- module scratch — nothing in a spawn path allocates ---------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _ref = new THREE.Vector3();
// Ground-wash scratch, kept separate: the wash spawner is called in a loop from
// _updateGroundWash, which is itself holding _v0.._v3 across the call.
const _w0 = new THREE.Vector3();
const _w1 = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _w3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _tmpCol = new THREE.Color();

/** Orthonormal basis around `dir` (assumed unit). */
function basisFrom(dir, t1, t2) {
  if (Math.abs(dir.y) < 0.97) _ref.set(0, 1, 0); else _ref.set(1, 0, 0);
  t1.crossVectors(_ref, dir).normalize();
  t2.crossVectors(dir, t1);
}

/** Uniform random direction inside a cone of half-angle `spread` around `dir`. */
function coneDir(out, dir, t1, t2, spread) {
  const cosA = Math.cos(spread);
  const z = lerp(cosA, 1, Math.random());
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = Math.random() * TAU;
  out.copy(dir).multiplyScalar(z)
    .addScaledVector(t1, Math.cos(phi) * r)
    .addScaledVector(t2, Math.sin(phi) * r);
  return out;
}

/** Direction in the plane perpendicular to `dir`, at angle `a`. */
function radialDir(out, t1, t2, a) {
  return out.copy(t1).multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
}

function hdr(col, r, g, b, mul) {
  col.setRGB(r * mul, g * mul, b * mul);
  return col;
}

/** Accept THREE.Color | number | [r,g,b] | undefined. */
function toColor(out, src, fallbackR, fallbackG, fallbackB) {
  if (src === undefined || src === null) return out.setRGB(fallbackR, fallbackG, fallbackB);
  if (src.isColor) return out.copy(src);
  if (typeof src === 'number') return out.set(src);
  if (typeof src === 'string') return out.set(src);
  if (Array.isArray(src)) return out.setRGB(src[0], src[1], src[2]);
  return out.setRGB(fallbackR, fallbackG, fallbackB);
}

/** Resolve an Entity | Object3D | Vector3 to a world point. */
function resolvePoint(target, out) {
  if (!target) return out.set(0, 0, 0);
  if (target.isVector3) return out.copy(target);
  if (target.collider && target.collider.center) return out.copy(target.collider.center);
  if (target.root && target.root.isObject3D) return out.setFromMatrixPosition(target.root.matrixWorld);
  if (target.isObject3D) return out.setFromMatrixPosition(target.matrixWorld);
  if (typeof target.x === 'number') return out.set(target.x, target.y || 0, target.z || 0);
  return out.set(0, 0, 0);
}

function resolveRadius(target, fallback = 2.5) {
  if (!target) return fallback;
  if (target.collider && target.collider.radius) {
    return Math.max(target.collider.radius, (target.collider.height || 0) * 0.5);
  }
  return fallback;
}

// --- deferred work (ricochets, secondary detonations) ----------------------
const DEF_SPARK_BOUNCE = 1;
const DEF_SECONDARY = 2;
const DEF_SMOKE = 3;

class Deferred {
  constructor() {
    this.time = 0;
    this.kind = 0;
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
    this.s = 1;
    this.active = false;
  }
}

// --- thruster plume handle -------------------------------------------------

class FlameHandle {
  constructor(vfx, anchor, opts) {
    this.vfx = vfx;
    this.anchor = anchor;
    this.on = false;
    this.target = 0;
    this.intensity = 0;
    this.radius = opts.radius ?? 0.3;
    this.length = opts.length ?? 2.8;
    this.emberRate = opts.embers ?? 26;
    this.axis = opts.axis ? opts.axis.clone().normalize() : null;
    this.seed = Math.random();
    this.phase = Math.random() * 100;
    this._emberAccum = 0;
    this.disposed = false;
    this.pos = new THREE.Vector3();
    this.dirW = new THREE.Vector3(0, 0, 1);
  }

  /**
   * @param {boolean} on thruster firing
   * @param {number} intensity 0..1.5 — drives length, brightness and colour temp
   */
  set(on, intensity = 1) {
    this.on = !!on;
    this.target = this.on ? clamp(intensity, 0, 1.6) : 0;
    return this;
  }

  setAxis(v) {
    if (!this.axis) this.axis = new THREE.Vector3();
    this.axis.copy(v).normalize();
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.vfx._removeFlame(this);
  }
}

const NULL_FLAME = {
  set() { return this; }, setAxis() { return this; }, dispose() {}, disposed: true, intensity: 0,
};

// --- ribbon trail handle ---------------------------------------------------

class TrailHandle {
  constructor(vfx, batch, ribbon) {
    this.vfx = vfx;
    this.batch = batch;
    this.ribbon = ribbon;
    this.gen = ribbon.gen;
    this.ended = false;
    this.disposed = false;
  }

  get alive() { return !this.disposed && this.ribbon.gen === this.gen; }

  /** Move the trail head. Accepts (Vector3) or (x, y, z). */
  setPosition(x, y, z) {
    if (!this.alive) return this;
    const r = this.ribbon;
    r.hasManual = true;
    if (typeof x === 'object' && x) r.manual.set(x.x, x.y, x.z);
    else r.manual.set(x, y, z);
    return this;
  }

  /** Attach the head to an Object3D (read from its world matrix each frame). */
  follow(object3d) {
    if (!this.alive) return this;
    this.ribbon.target = object3d || null;
    this.ribbon.hasManual = false;
    return this;
  }

  /** Stop feeding new points; the ribbon dissolves and frees itself. */
  end() {
    if (!this.alive) return this;
    this.ribbon.ended = true;
    this.ribbon.target = null;
    this.ended = true;
    return this;
  }

  /** Free immediately (pops — prefer end()). */
  dispose() {
    if (!this.alive) { this.disposed = true; return; }
    this.batch.release(this.ribbon);
    this.disposed = true;
  }
}

const NULL_TRAIL = {
  alive: false,
  setPosition() { return this; },
  follow() { return this; },
  end() { return this; },
  dispose() {},
};

// --- damage smoke handle ---------------------------------------------------

class DamageSmokeHandle {
  constructor(vfx, entity, opts) {
    this.vfx = vfx;
    this.entity = entity;
    this.scale = opts.scale ?? 1;
    this.accum = 0;
    this.sparkAccum = 0;
    this.disposed = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.vfx._removeDamageSmoke(this);
  }
}

// --- electrical arc rig (stagger) -----------------------------------------

class ArcRig {
  constructor() {
    this.entity = null;
    this.until = 0;
    this.accum = 0;
    this.active = false;
    this.color = new THREE.Color();
  }
}

// ---------------------------------------------------------------------------

export class VFX {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer, opts = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.ps = new ParticleSystem(scene, renderer, opts);
    this.time = 0;
    this.enabled = true;
    this.quality = 1;

    this._flames = [];
    this._trails = [];
    this._damage = [];
    this._arcs = [];
    for (let i = 0; i < 8; i++) this._arcs.push(new ArcRig());

    this._deferred = [];
    for (let i = 0; i < 64; i++) this._deferred.push(new Deferred());

    // entities whose thrusters kick up ground particulate — see _noteWasher
    this._washers = [];

    // impact de-duplication ring (direct call vs bus event)
    this._dedupe = new Float32Array(8 * 4);
    this._dedupeHead = 0;

    this._offs = [];
    this._wire();
  }

  // =========================================================================
  // Event wiring
  // =========================================================================

  _wire() {
    const on = (ev, fn) => this._offs.push(bus.on(ev, fn));

    on(EV.IMPACT, (p) => {
      if (!p || !this.enabled) return;
      const pt = p.point || p.position || p.pos;
      if (!pt) return;
      const n = p.normal || p.n || _up;
      const kind = this._impactKind(p);
      if (this._isDuplicate(pt)) return;
      this.impact(pt, n, kind, { scale: p.scale ?? p.power ?? 1 });
    });

    on(EV.STAGGER, (p) => {
      if (!this.enabled) return;
      const entity = p && p.entity ? p.entity : p;
      if (entity) this.staggerBurst(entity);
    });

    on(EV.QUICK_BOOST, (p) => {
      if (!p || !this.enabled) return;
      const pt = p.point || p.position || p.pos || (p.entity && p.entity.root && p.entity.root.position);
      if (!pt) return;
      const d = p.direction || p.dir || p.velocity;
      this.quickBoostBurst(pt, d || _up, p.scale ?? 1);
    });

    on(EV.ENTITY_KILLED, (p) => {
      if (!p || !this.enabled) return;
      const entity = p.entity || p;
      if (!entity) return;
      this._forgetWasher(entity);
      resolvePoint(entity, _v0);
      const r = resolveRadius(entity, 3);
      this.explosion(_v0, r * 2.1, { ground: false, shake: 1, hitstop: 0.07, debris: 1.3 });
    });

    // Movement events are also how VFX LEARNS WHICH ENTITIES MOVE. Nothing in
    // the contract hands the effects system the player, and per-frame ground
    // particulate needs an entity with a published `moveState` to read. Every
    // movement event carries `entity`, so latching them here gives the ground
    // wash a driver without a new wiring point in Game.
    on(EV.LANDED, (p) => {
      if (!p || !this.enabled) return;
      this._noteWasher(p.entity);
      const pt = p.position || p.point || (p.entity && p.entity.root && p.entity.root.position);
      if (!pt) return;
      this.landingDust(pt, p.impactSpeed ?? 12, resolveRadius(p.entity, 2.2));
    });
    on(EV.ASSAULT_BOOST, (p) => { if (p) this._noteWasher(p.entity); });
    on(EV.EN_EMPTY, (p) => { if (p) this._noteWasher(p.entity); });
  }

  /** Track an entity for per-frame ground particulate. Idempotent, bounded. */
  _noteWasher(entity) {
    if (!entity || !entity.root || !entity.moveState) return;
    for (const w of this._washers) if (w.entity === entity) return;
    if (this._washers.length >= 6) return;
    this._washers.push({ entity, accum: 0 });
  }

  _forgetWasher(entity) {
    for (let i = this._washers.length - 1; i >= 0; i--) {
      if (this._washers[i].entity === entity) this._washers.splice(i, 1);
    }
  }

  _impactKind(p) {
    const s = p.surface || p.material || p.surfaceType;
    if (s === 'metal' || s === 'concrete' || s === 'energy' || s === 'shield') return s;
    if (p.shielded || p.blocked) return 'shield';
    if (p.kind === 'metal' || p.kind === 'concrete' || p.kind === 'energy' || p.kind === 'shield') return p.kind;
    const t = p.type || p.damageType;
    if (t === 'energy') return 'energy';
    if (t === 'explosive') return 'metal';
    if (t === 'concrete' || t === 'world' || t === 'ground') return 'concrete';
    if (p.entity || p.target) return 'metal';
    return 'concrete';
  }

  /** True if an effect was already produced at this point in the last 40ms. */
  _isDuplicate(pt) {
    const d = this._dedupe;
    for (let i = 0; i < 8; i++) {
      const o = i * 4;
      if (this.time - d[o + 3] > 0.04) continue;
      const dx = d[o] - pt.x, dy = d[o + 1] - pt.y, dz = d[o + 2] - pt.z;
      if (dx * dx + dy * dy + dz * dz < 0.0625) return true;
    }
    return false;
  }

  _noteImpact(pt) {
    const o = (this._dedupeHead % 8) * 4;
    this._dedupeHead++;
    const d = this._dedupe;
    d[o] = pt.x; d[o + 1] = pt.y; d[o + 2] = pt.z; d[o + 3] = this.time;
  }

  // =========================================================================
  // Muzzle flash
  // =========================================================================

  /**
   * Layered muzzle flash. Total life 60-110ms — snappy, not a fireball.
   * @param {THREE.Vector3} pos muzzle world position
   * @param {THREE.Vector3} dir barrel direction (unit-ish)
   * @param {number} scale 1 = rifle, 0.5 = SMG, 2.5 = bazooka
   * @param {THREE.Color|number} color flash tint
   */
  muzzleFlash(pos, dir, scale = 1, color) {
    if (!this.enabled || !pos) return;
    const ps = this.ps;
    _dir.copy(dir || _up);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize();
    basisFrom(_dir, _t1, _t2);
    const s = clamp(scale, 0.2, 6);
    const q = this.quality;

    toColor(_c0, color, 1.0, 0.78, 0.42);
    const cr = _c0.r, cg = _c0.g, cb = _c0.b;

    // 1 — hot near-white core. Tiny, brief, extremely bright.
    let p = ps.begin(BATCH_ADD);
    p.pos.copy(pos).addScaledVector(_dir, 0.12 * s);
    p.life = 0.042;
    p.size0 = 0.55 * s; p.size1 = 1.15 * s;
    p.tile = TILE.CORE;
    hdr(p.color0, lerp(cr, 1, 0.72), lerp(cg, 1, 0.7), lerp(cb, 1, 0.62), 26);
    hdr(p.color1, cr, cg * 0.8, cb * 0.5, 5);
    p.alpha0 = 1; p.alpha1 = 0.4;
    p.fadeIn = 0; p.alphaCurve = 1.4; p.sizeCurve = 0.45;
    p.rot = Math.random() * TAU;
    ps.emit();

    // 2 — anamorphic cross/star flare (screen-space, like a real lens response)
    p = ps.begin(BATCH_ADD);
    p.pos.copy(pos).addScaledVector(_dir, 0.1 * s);
    p.life = 0.062;
    p.size0 = 1.6 * s; p.size1 = 3.4 * s;
    p.tile = TILE.FLARE;
    hdr(p.color0, lerp(cr, 1, 0.4), lerp(cg, 1, 0.35), lerp(cb, 1, 0.25), 13);
    hdr(p.color1, cr, cg * 0.6, cb * 0.3, 2);
    p.alpha0 = 1; p.alpha1 = 0;
    p.fadeIn = 0; p.alphaCurve = 1.1; p.sizeCurve = 0.4;
    p.rot = (Math.random() - 0.5) * 0.5;
    p.spin = (Math.random() - 0.5) * 2.5;
    ps.emit();

    // 3 — barrel-aligned streaks. A near-zero velocity plus a large stretch
    //     aligns the quad to the world barrel axis without the particle moving.
    for (let i = 0; i < 2; i++) {
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_dir, (0.35 + i * 0.5) * s);
      p.vel.copy(_dir).multiplyScalar(1.2);
      p.life = 0.05 + i * 0.012;
      p.size0 = (0.42 - i * 0.12) * s; p.size1 = (0.2 - i * 0.06) * s;
      p.stretch = (1.5 + i * 1.4) * s;
      p.tile = TILE.STREAK;
      hdr(p.color0, lerp(cr, 1, 0.55), lerp(cg, 1, 0.5), lerp(cb, 1, 0.35), 16 - i * 6);
      hdr(p.color1, cr, cg * 0.55, cb * 0.25, 2);
      p.alpha0 = 1; p.alpha1 = 0;
      p.fadeIn = 0; p.alphaCurve = 1.3;
      ps.emit();
    }

    // 3b — the CROSS blade. Two streaks perpendicular to the barrel, on the
    //      tangents, so the flash is a wide flat bar through a hot point rather
    //      than a symmetric ball with a lens star pasted on it. This is the
    //      anisotropy REVIEW asks for: it comes from the muzzle brake venting
    //      sideways, not from the lens, so it must live in world space and
    //      rotate with the gun. Two frames — the very first thing to go.
    for (let i = 0; i < 2; i++) {
      const tan = i === 0 ? _t1 : _t2;
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_dir, 0.16 * s);
      p.vel.copy(tan).multiplyScalar(0.9);
      p.life = 0.038;
      p.size0 = 0.30 * s; p.size1 = 0.1 * s;
      p.stretch = (2.6 - i * 1.0) * s;
      p.tile = TILE.STREAK;
      hdr(p.color0, lerp(cr, 1, 0.62), lerp(cg, 1, 0.58), lerp(cb, 1, 0.42), 14 - i * 5);
      hdr(p.color1, cr, cg * 0.5, cb * 0.2, 1.5);
      p.alpha0 = 1; p.alpha1 = 0;
      p.fadeIn = 0; p.alphaCurve = 1.5;
      ps.emit();
    }

    // 4 — short cone of expanding combustion gas
    const gas = Math.round(5 * q);
    for (let i = 0; i < gas; i++) {
      coneDir(_v0, _dir, _t1, _t2, 0.38);
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_dir, randRange(0.15, 0.6) * s);
      p.vel.copy(_v0).multiplyScalar(randRange(5, 13) * s);
      p.drag = 11;
      p.life = randRange(0.06, 0.1);
      p.size0 = 0.3 * s; p.size1 = randRange(1.1, 1.8) * s;
      p.tile = TILE.SMOKE_A + (i % 3);
      hdr(p.color0, cr, cg * 0.85, cb * 0.6, 5.5);
      hdr(p.color1, cr * 0.5, cg * 0.22, cb * 0.08, 0.6);
      p.alpha0 = 0.85; p.alpha1 = 0;
      p.fadeIn = 0.02; p.sizeCurve = 0.5; p.alphaCurve = 1.5;
      p.rot = Math.random() * TAU; p.spin = randRange(-6, 6);
      ps.emit();
    }

    // 5 — ejected sparks, gravity + drag, streaked along their velocity
    const sparks = Math.round(randRange(6, 14) * q);
    for (let i = 0; i < sparks; i++) {
      coneDir(_v0, _dir, _t1, _t2, 0.55);
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_dir, 0.15 * s);
      p.vel.copy(_v0).multiplyScalar(randRange(7, 26) * s);
      p.drag = randRange(1.6, 3.4);
      p.gravity = 24;
      p.life = randRange(0.1, 0.3);
      p.size0 = randRange(0.045, 0.1) * s; p.size1 = p.size0 * 0.35;
      p.stretch = randRange(0.014, 0.03);
      p.tile = TILE.SPARK;
      hdr(p.color0, 1.0, 0.72, 0.34, 15);
      hdr(p.color1, 1.0, 0.24, 0.05, 1.6);
      p.alpha0 = 1; p.alpha1 = 0;
      p.alphaCurve = 0.8;
      ps.emit();
    }

    // 6 — fast expanding smoke ring around the muzzle
    const ringN = Math.round(6 * q);
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * TAU + Math.random() * 0.4;
      radialDir(_v0, _t1, _t2, a);
      p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_dir, 0.3 * s).addScaledVector(_v0, 0.12 * s);
      p.vel.copy(_v0).multiplyScalar(randRange(2.2, 4.5) * s).addScaledVector(_dir, randRange(1, 3) * s);
      p.drag = 6.5;
      p.life = randRange(0.22, 0.4);
      p.size0 = 0.28 * s; p.size1 = randRange(1.3, 2.1) * s;
      p.tile = TILE.SMOKE_A + (i % 3);
      p.color0.setRGB(0.34, 0.31, 0.29);
      p.color1.setRGB(0.09, 0.085, 0.082);
      p.alpha0 = 0.34; p.alpha1 = 0;
      p.fadeIn = 0.08; p.erode = 0.5; p.sizeCurve = 0.55;
      p.rot = Math.random() * TAU; p.spin = randRange(-3, 3);
      ps.emit();
    }

    // 7 — additive shockwave ring, gone in 100ms
    this.ps.ring({
      pos: _v1.copy(pos).addScaledVector(_dir, 0.25 * s),
      normal: _dir,
      r0: 0.12 * s, r1: 1.5 * s,
      thickness: 0.28,
      life: 0.1,
      color: hdr(_c1, cr, cg * 0.8, cb * 0.55, 3.2),
      alpha: 0.7,
      growth: 2.0,
      mode: 0,
    });

    // 8 — pooled point light
    hdr(_c1, lerp(cr, 1, 0.3), lerp(cg, 1, 0.25), lerp(cb, 1, 0.15), 1);
    ps.lights.flash(pos, _c1, 26 * s * s, 13 * s, 0.075, this.time, 1);
  }

  // =========================================================================
  // Impacts
  // =========================================================================

  /**
   * @param {THREE.Vector3} pos hit point
   * @param {THREE.Vector3} normal surface normal (points away from the surface)
   * @param {'metal'|'concrete'|'energy'|'shield'} type
   * @param {object} [opts] { scale, color }
   */
  impact(pos, normal, type = 'metal', opts) {
    if (!this.enabled || !pos) return;
    this._noteImpact(pos);
    _dir.copy(normal || _up);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
    _dir.normalize();
    basisFrom(_dir, _t1, _t2);
    const scale = clamp((opts && opts.scale) || 1, 0.25, 4);

    switch (type) {
      case 'concrete': this._impactConcrete(pos, scale, opts); break;
      case 'energy': this._impactEnergy(pos, scale, opts); break;
      case 'shield': this._impactShield(pos, scale, opts); break;
      default: this._impactMetal(pos, scale, opts); break;
    }
  }

  _impactMetal(pos, s, opts) {
    const ps = this.ps;
    const q = this.quality;
    toColor(_c0, opts && opts.color, 1.0, 0.66, 0.26);

    // sharp flash
    let p = ps.begin(BATCH_ADD);
    p.pos.copy(pos).addScaledVector(_dir, 0.06);
    p.life = 0.05;
    p.size0 = 0.32 * s; p.size1 = 0.85 * s;
    p.tile = TILE.CORE;
    hdr(p.color0, 1.0, 0.92, 0.76, 22);
    hdr(p.color1, 1.0, 0.42, 0.12, 3);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.4; p.alphaCurve = 1.4;
    ps.emit();

    p = ps.begin(BATCH_ADD);
    p.pos.copy(pos).addScaledVector(_dir, 0.05);
    p.life = 0.07;
    p.size0 = 0.7 * s; p.size1 = 1.9 * s;
    p.tile = TILE.FLARE;
    hdr(p.color0, 1.0, 0.72, 0.34, 10);
    hdr(p.color1, 1.0, 0.3, 0.08, 1.2);
    p.alpha0 = 0.9; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.35;
    p.rot = Math.random() * TAU;
    ps.emit();

    // spark burst — hemisphere around the normal, biased outward
    const n = Math.round(randRange(14, 22) * s * q);
    for (let i = 0; i < n; i++) {
      coneDir(_v0, _dir, _t1, _t2, 1.15);
      const speed = randRange(5, 24) * s;
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_dir, 0.05);
      p.vel.copy(_v0).multiplyScalar(speed);
      p.drag = randRange(1.1, 2.6);
      p.gravity = 24;
      p.life = randRange(0.17, 0.5);
      p.size0 = randRange(0.05, 0.11) * s; p.size1 = p.size0 * 0.3;
      p.stretch = randRange(0.018, 0.034);
      p.tile = i % 5 === 0 ? TILE.STREAK : TILE.SPARK;
      hdr(p.color0, 1.0, 0.74, 0.3, 14);
      hdr(p.color1, 1.0, 0.2, 0.03, 1.4);
      p.alpha0 = 1; p.alpha1 = 0; p.alphaCurve = 0.75;
      ps.emit();
    }

    // three long streak trails that ricochet a moment later
    const rico = Math.min(3, Math.round(3 * q));
    for (let i = 0; i < rico; i++) {
      coneDir(_v0, _dir, _t1, _t2, 0.9);
      const speed = randRange(16, 30) * s;
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_dir, 0.05);
      p.vel.copy(_v0).multiplyScalar(speed);
      p.drag = 0.7;
      p.gravity = 24;
      p.life = randRange(0.28, 0.45);
      p.size0 = 0.075 * s; p.size1 = 0.03 * s;
      p.stretch = 0.05;
      p.tile = TILE.STREAK;
      hdr(p.color0, 1.0, 0.8, 0.4, 12);
      hdr(p.color1, 1.0, 0.22, 0.04, 1.2);
      p.alpha0 = 1; p.alpha1 = 0; p.alphaCurve = 0.7;
      ps.emit();
      // schedule the bounce at the ballistic endpoint
      const t = p.life * 0.85;
      _v1.copy(pos).addScaledVector(_v0, speed * t * 0.55);
      _v1.y -= 0.5 * 24 * t * t * 0.4;
      this._defer(t, DEF_SPARK_BOUNCE, _v1, _dir, s * 0.5);
    }

    // scorch
    ps.decal(pos, _dir, randRange(0.5, 0.95) * s, TILE.SCORCH,
      _c1.setRGB(0.035, 0.026, 0.022), 0.85, 14);

    // ring + smoke puff
    ps.ring({
      pos: _v1.copy(pos).addScaledVector(_dir, 0.05),
      normal: _dir,
      r0: 0.06 * s, r1: 1.1 * s, thickness: 0.24, life: 0.13,
      color: hdr(_c1, 1.0, 0.55, 0.18, 3.4), alpha: 0.75, growth: 2.2, mode: 0,
    });

    const puffs = Math.round(3 * q);
    for (let i = 0; i < puffs; i++) {
      coneDir(_v0, _dir, _t1, _t2, 0.8);
      p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_dir, 0.15);
      p.vel.copy(_v0).multiplyScalar(randRange(1.2, 3.2) * s);
      p.vel.y += 0.9;
      p.drag = 3.2;
      p.life = randRange(0.45, 0.8);
      p.size0 = 0.24 * s; p.size1 = randRange(1.0, 1.7) * s;
      p.tile = TILE.SMOKE_A + (i % 3);
      p.color0.setRGB(0.22, 0.19, 0.175);
      p.color1.setRGB(0.055, 0.05, 0.048);
      p.alpha0 = 0.42; p.alpha1 = 0;
      p.fadeIn = 0.1; p.erode = 0.55; p.sizeCurve = 0.6;
      p.rot = Math.random() * TAU; p.spin = randRange(-2, 2);
      ps.emit();
    }

    ps.lights.flash(pos, hdr(_c1, 1.0, 0.55, 0.2, 1), 12 * s, 7 * s, 0.07, this.time, 0);
  }

  _impactConcrete(pos, s, opts) {
    const ps = this.ps;
    const q = this.quality;

    // grey dust cone along the normal
    const n = Math.round(randRange(9, 14) * s * q);
    for (let i = 0; i < n; i++) {
      coneDir(_v0, _dir, _t1, _t2, 0.75);
      const p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_dir, 0.1);
      p.vel.copy(_v0).multiplyScalar(randRange(2.5, 9) * s);
      p.drag = 2.6;
      p.gravity = 3.5;
      p.life = randRange(0.45, 0.9);
      p.size0 = 0.3 * s; p.size1 = randRange(1.6, 3.0) * s;
      p.tile = i % 2 ? TILE.DUST : TILE.SMOKE_B;
      p.color0.setRGB(0.62, 0.585, 0.53);
      p.color1.setRGB(0.30, 0.285, 0.26);
      p.alpha0 = 0.55; p.alpha1 = 0;
      p.fadeIn = 0.05; p.erode = 0.62; p.sizeCurve = 0.55; p.turb = 0.35; p.turbFreq = 3.5;
      p.rot = Math.random() * TAU; p.spin = randRange(-2.5, 2.5);
      ps.emit();
    }

    // dust hugging the surface, spreading outward
    const skirt = Math.round(6 * q);
    for (let i = 0; i < skirt; i++) {
      const a = (i / skirt) * TAU + Math.random() * 0.5;
      radialDir(_v0, _t1, _t2, a);
      const p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_v0, 0.15 * s);
      p.vel.copy(_v0).multiplyScalar(randRange(3, 6.5) * s).addScaledVector(_dir, randRange(0.3, 1.4));
      p.drag = 4.2;
      p.life = randRange(0.5, 0.95);
      p.size0 = 0.25 * s; p.size1 = randRange(1.4, 2.4) * s;
      p.tile = TILE.DUST;
      p.color0.setRGB(0.58, 0.55, 0.50);
      p.color1.setRGB(0.26, 0.25, 0.23);
      p.alpha0 = 0.42; p.alpha1 = 0;
      p.fadeIn = 0.07; p.erode = 0.6; p.sizeCurve = 0.5;
      p.rot = Math.random() * TAU; p.spin = randRange(-2, 2);
      ps.emit();
    }

    // chunk debris under gravity
    const chunks = Math.round(randRange(5, 9) * s * q);
    for (let i = 0; i < chunks; i++) {
      coneDir(_v0, _dir, _t1, _t2, 1.0);
      const p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_dir, 0.08);
      p.vel.copy(_v0).multiplyScalar(randRange(4, 13) * s);
      p.drag = 0.35;
      p.gravity = 24;
      p.life = randRange(0.6, 1.15);
      p.size0 = randRange(0.07, 0.2) * s; p.size1 = p.size0 * 0.85;
      p.tile = TILE.DEBRIS;
      p.color0.setRGB(0.40, 0.385, 0.36);
      p.color1.setRGB(0.20, 0.19, 0.18);
      p.alpha0 = 1; p.alpha1 = 0.9;
      p.fadeIn = 0; p.alphaCurve = 2.2;
      p.rot = Math.random() * TAU; p.spin = randRange(-13, 13);
      ps.emit();
    }

    // a couple of dim sparks (rebar / ricochet)
    const sp = Math.round(4 * q);
    for (let i = 0; i < sp; i++) {
      coneDir(_v0, _dir, _t1, _t2, 1.0);
      const p = ps.begin(BATCH_ADD);
      p.pos.copy(pos);
      p.vel.copy(_v0).multiplyScalar(randRange(4, 14) * s);
      p.drag = 2; p.gravity = 24;
      p.life = randRange(0.12, 0.28);
      p.size0 = 0.05 * s; p.size1 = 0.02;
      p.stretch = 0.02;
      p.tile = TILE.SPARK;
      hdr(p.color0, 1.0, 0.7, 0.4, 6);
      hdr(p.color1, 1.0, 0.25, 0.06, 0.8);
      p.alpha0 = 1; p.alpha1 = 0;
      ps.emit();
    }

    ps.decal(pos, _dir, randRange(0.8, 1.5) * s, TILE.CRACK,
      _c1.setRGB(0.20, 0.19, 0.175), 0.62, 22);
  }

  _impactEnergy(pos, s, opts) {
    const ps = this.ps;
    const q = this.quality;
    toColor(_c0, opts && opts.color, 0.32, 0.85, 1.0);
    const cr = _c0.r, cg = _c0.g, cb = _c0.b;

    // plasma bloom
    let p = ps.begin(BATCH_ADD);
    p.pos.copy(pos);
    p.life = 0.14;
    p.size0 = 0.3 * s; p.size1 = 2.4 * s;
    p.tile = TILE.GLOW;
    hdr(p.color0, lerp(cr, 1, 0.55), lerp(cg, 1, 0.5), 1.0, 17);
    hdr(p.color1, 0.55, 0.35, 1.0, 1.6);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.35; p.alphaCurve = 1.5;
    ps.emit();

    p = ps.begin(BATCH_ADD);
    p.pos.copy(pos);
    p.life = 0.08;
    p.size0 = 0.25 * s; p.size1 = 0.7 * s;
    p.tile = TILE.CORE;
    hdr(p.color0, 1, 1, 1, 30);
    hdr(p.color1, cr, cg, cb, 4);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.4;
    ps.emit();

    // ring shockwave + spiked disc
    ps.ring({
      pos, normal: _dir,
      r0: 0.15 * s, r1: 2.6 * s, thickness: 0.13, life: 0.19,
      color: hdr(_c1, cr, cg, cb, 5.5), alpha: 1, growth: 2.6, mode: 0,
    });
    ps.ring({
      pos, normal: _dir,
      r0: 0.1 * s, r1: 1.9 * s, thickness: 0.2, life: 0.24,
      color: hdr(_c1, lerp(cr, 0.7, 0.5), cg * 0.7, cb, 4.2), alpha: 0.8,
      growth: 3.0, mode: 3, spin: randRange(-4, 4),
    });

    // crackling arcs radiating from the hit
    const arcs = Math.round(5 * q);
    for (let i = 0; i < arcs; i++) {
      coneDir(_v0, _dir, _t1, _t2, 1.3);
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_v0, randRange(0.2, 0.7) * s);
      p.vel.copy(_v0).multiplyScalar(3.5);
      p.life = randRange(0.06, 0.13);
      p.size0 = randRange(0.25, 0.6) * s; p.size1 = p.size0;
      p.stretch = randRange(0.25, 0.7) * s;
      p.tile = TILE.ARC;
      hdr(p.color0, lerp(cr, 1, 0.5), lerp(cg, 1, 0.4), 1.0, 12);
      hdr(p.color1, cr * 0.5, cg * 0.4, cb, 1);
      p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.alphaCurve = 0.5;
      ps.emit();
    }

    // energy shards + sparks
    const n = Math.round(randRange(10, 16) * s * q);
    for (let i = 0; i < n; i++) {
      coneDir(_v0, _dir, _t1, _t2, 1.25);
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos);
      p.vel.copy(_v0).multiplyScalar(randRange(5, 20) * s);
      p.drag = randRange(2.5, 5);
      p.gravity = 4;
      p.life = randRange(0.14, 0.32);
      p.size0 = randRange(0.05, 0.13) * s; p.size1 = p.size0 * 0.3;
      p.stretch = randRange(0.02, 0.05);
      p.tile = i % 3 === 0 ? TILE.SHARD : TILE.SPARK;
      hdr(p.color0, lerp(cr, 1, 0.4), lerp(cg, 1, 0.3), 1.0, 13);
      hdr(p.color1, 0.5, 0.25, 1.0, 1.2);
      p.alpha0 = 1; p.alpha1 = 0; p.alphaCurve = 0.8;
      ps.emit();
    }

    ps.decal(pos, _dir, randRange(0.4, 0.8) * s, TILE.SCORCH,
      _c1.setRGB(0.05, 0.055, 0.075), 0.5, 7);
    ps.lights.flash(pos, hdr(_c1, cr, cg, cb, 1), 20 * s, 10 * s, 0.13, this.time, 1);
  }

  _impactShield(pos, s, opts) {
    const ps = this.ps;
    const q = this.quality;
    toColor(_c0, opts && opts.color, 0.34, 0.72, 1.0);
    const cr = _c0.r, cg = _c0.g, cb = _c0.b;
    const R = 3.2 * s;

    // hex ripple travelling across a hemisphere centred on the hit
    ps.ring({
      pos, normal: _dir,
      r0: R * 0.55, r1: R, thickness: 0.35, life: 0.36,
      color: hdr(_c1, cr, cg, cb, 3.4), alpha: 1.0,
      growth: 2.0, mode: 2, dome: 0.85,
    });
    // leading edge ring
    ps.ring({
      pos, normal: _dir,
      r0: 0.2 * s, r1: R * 1.05, thickness: 0.1, life: 0.28,
      color: hdr(_c1, lerp(cr, 1, 0.4), lerp(cg, 1, 0.35), 1.0, 6), alpha: 1,
      growth: 2.4, mode: 1, dome: 0.7,
    });

    let p = ps.begin(BATCH_ADD);
    p.pos.copy(pos);
    p.life = 0.1;
    p.size0 = 0.4 * s; p.size1 = 1.5 * s;
    p.tile = TILE.GLOW;
    hdr(p.color0, lerp(cr, 1, 0.6), lerp(cg, 1, 0.5), 1, 14);
    hdr(p.color1, cr, cg, cb, 1.5);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.4;
    ps.emit();

    // sparks skittering across the shield surface (tangential, not radial)
    const n = Math.round(12 * q);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      radialDir(_v0, _t1, _t2, a);
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_v0, 0.2 * s);
      p.vel.copy(_v0).multiplyScalar(randRange(6, 18) * s).addScaledVector(_dir, randRange(0, 2));
      p.drag = 4;
      p.life = randRange(0.12, 0.26);
      p.size0 = randRange(0.05, 0.1) * s; p.size1 = p.size0 * 0.3;
      p.stretch = 0.03;
      p.tile = TILE.SPARK;
      hdr(p.color0, lerp(cr, 1, 0.55), lerp(cg, 1, 0.45), 1, 12);
      hdr(p.color1, cr * 0.6, cg * 0.6, cb, 1);
      p.alpha0 = 1; p.alpha1 = 0;
      ps.emit();
    }

    ps.lights.flash(pos, hdr(_c1, cr, cg, cb, 1), 16 * s, 12 * s, 0.16, this.time, 0);
  }

  // =========================================================================
  // Explosion
  // =========================================================================

  /**
   * The money shot. Everything scales off `radius` (metres).
   * @param {THREE.Vector3} pos
   * @param {number} radius blast radius in metres
   * @param {object} [opts] { color, ground, groundNormal, shake, hitstop, debris, smoke }
   */
  explosion(pos, radius = 6, opts) {
    if (!this.enabled || !pos) return;
    const ps = this.ps;
    const q = this.quality;
    const R = clamp(radius, 0.6, 60);
    const big = R / 6;
    const o = opts || {};
    toColor(_c0, o.color, 1.0, 0.55, 0.18);
    const cr = _c0.r, cg = _c0.g, cb = _c0.b;

    // --- 1. white-hot initial flash ----------------------------------------
    //
    // BOTH flash sprites used to be enormous AND blown: the flare reached
    // R * 5.5, which at a mech-kill radius of 13 m is a 71 m sprite, emitting at
    // 18 linear. AgX makes display value nearly independent of radiance past
    // ~3 linear, so that one quad painted a third of the frame a single flat
    // white with no hue and no structure — the "bloom that washes the frame"
    // automatic failure, and the reason no explosion has ever photographed as an
    // orange fireball. The flash is now SMALL and BRIEF; the fireball below
    // carries the size, and it carries it in the band where colour survives.
    let p = ps.begin(BATCH_ADD);
    p.pos.copy(pos);
    p.life = 0.06;
    p.size0 = R * 0.35; p.size1 = R * 1.05;
    p.tile = TILE.CORE;
    hdr(p.color0, 1.0, 0.97, 0.9, 34);
    hdr(p.color1, 1.0, 0.55, 0.2, 4);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.35; p.alphaCurve = 1.6;
    ps.emit();

    p = ps.begin(BATCH_ADD);
    p.pos.copy(pos);
    p.life = 0.105;
    p.size0 = R * 0.8; p.size1 = R * 2.3;
    p.tile = TILE.FLARE;
    hdr(p.color0, 1.0, 0.84, 0.55, 8.5);
    hdr(p.color1, 1.0, 0.32, 0.07, 0.9);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.3; p.alphaCurve = 1.7;
    p.rot = Math.random() * TAU; p.spin = randRange(-1.2, 1.2);
    ps.emit();

    ps.lights.flash(pos, hdr(_c1, 1.0, 0.72, 0.36, 1), 90 * big * big, R * 9, 0.42, this.time, 3);

    // --- 2. fireball -------------------------------------------------------
    //
    // The BODY of the fireball is alpha-blended, not additive. Additive puffs
    // cannot be a fireball on this tone curve: twenty of them at 9 linear stack
    // into one saturated slab with no interior, no silhouette and no colour.
    // Alpha puffs occlude each other, so the ball has an edge and a turbulent
    // interior, and their rgb still runs past 1.0 so the hot side blooms. The
    // additive pass is kept for the CORE only — a handful of small, short-lived
    // sprites that give the centre its blown-out heart for the first 0.25 s.
    const fire = Math.round(clamp(10 + R * 2.2, 10, 28) * q);
    for (let i = 0; i < fire; i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_v0.lengthSq() < 1e-5) _v0.set(0, 1, 0);
      _v0.normalize();
      const rr = Math.pow(Math.random(), 0.55);
      // hotter toward the middle of the ball, cooler and sootier at the rim
      const heat = clamp(1.15 - rr, 0.15, 1);
      p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_v0, rr * R * 0.40);
      p.vel.copy(_v0).multiplyScalar(randRange(2.5, 8) * big);
      p.vel.y += 1.6 * big;
      p.drag = 4.0;
      p.life = randRange(0.30, 0.62);
      p.size0 = R * 0.30; p.size1 = R * randRange(0.85, 1.45);
      p.tile = TILE.SMOKE_A + (i % 3);
      p.color0.setRGB(2.6 * heat + 0.5, (0.95 * heat + 0.10) * lerp(0.75, 1.05, Math.random()), 0.30 * heat * heat + 0.03);
      p.color1.setRGB(0.16 * cr, 0.055 * cg, 0.028 * cb);
      p.alpha0 = 0.92; p.alpha1 = 0;
      p.fadeIn = 0.03; p.erode = 0.34; p.sizeCurve = 0.45; p.alphaCurve = 1.35;
      p.turb = 0.6 * big; p.turbFreq = 5.5;
      p.rot = Math.random() * TAU; p.spin = randRange(-3.5, 3.5);
      ps.emit();
    }

    const core = Math.round(clamp(3 + R * 0.6, 3, 9) * q);
    for (let i = 0; i < core; i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_v0, Math.random() * R * 0.22);
      p.vel.copy(_v0).multiplyScalar(randRange(2, 6) * big);
      p.drag = 5.5;
      p.life = randRange(0.13, 0.26);
      p.size0 = R * 0.22; p.size1 = R * randRange(0.5, 0.8);
      p.tile = TILE.SMOKE_A + (i % 3);
      hdr(p.color0, 1.0, lerp(0.80, 0.58, Math.random()), lerp(0.40, 0.14, Math.random()), 7);
      hdr(p.color1, cr, cg * 0.30, cb * 0.06, 0.7);
      p.alpha0 = 0.85; p.alpha1 = 0;
      p.fadeIn = 0.02; p.sizeCurve = 0.4; p.alphaCurve = 1.5;
      p.rot = Math.random() * TAU; p.spin = randRange(-4, 4);
      ps.emit();
    }

    // --- 3. rolling smoke over the fireball --------------------------------
    const smokeN = Math.round(clamp(8 + R * 1.7, 8, 24) * q);
    for (let i = 0; i < smokeN; i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 1.4 - 0.35, Math.random() * 2 - 1).normalize();
      p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_v0, Math.random() * R * 0.5);
      p.vel.copy(_v0).multiplyScalar(randRange(1.5, 5) * big);
      p.vel.y += randRange(0.8, 2.6) * big;
      p.drag = 1.5;
      p.life = randRange(1.4, 3.0) * clamp(big, 0.6, 2.2);
      p.size0 = R * 0.45; p.size1 = R * randRange(1.5, 2.8);
      p.tile = TILE.SMOKE_A + (i % 3);
      // fire-lit at birth, cold soot at death — never uniform grey
      p.color0.setRGB(0.34, 0.155, 0.065);
      p.color1.setRGB(0.030, 0.027, 0.026);
      p.alpha0 = 0.78; p.alpha1 = 0;
      p.fadeIn = 0.07; p.erode = 0.6; p.sizeCurve = 0.55;
      p.turb = 0.45 * big; p.turbFreq = 1.6;
      p.rot = Math.random() * TAU; p.spin = randRange(-1.4, 1.4);
      ps.emit();
    }

    // --- 4. lingering black smoke that rises and dissipates -----------------
    // REVIEW asks for smoke that lingers FAR longer than the fire. The fire is
    // gone in ~0.6 s; this column runs 3.5-6.5 s, i.e. six to ten times as long,
    // and it is the last thing left in frame.
    if (o.smoke !== false) {
      const linger = Math.round(clamp(6 + R * 0.9, 6, 16) * q);
      for (let i = 0; i < linger; i++) {
        _v0.set(Math.random() * 2 - 1, 0, Math.random() * 2 - 1).normalize();
        p = ps.begin(BATCH_ALPHA);
        p.pos.copy(pos).addScaledVector(_v0, Math.random() * R * 0.5);
        p.pos.y += R * 0.25;
        p.vel.copy(_v0).multiplyScalar(randRange(0.4, 1.6));
        p.vel.y = randRange(1.8, 4.2);
        p.drag = 0.55;
        p.life = randRange(3.5, 6.5);
        p.size0 = R * 0.7; p.size1 = R * randRange(2.4, 4.0);
        p.tile = TILE.SMOKE_A + (i % 3);
        p.color0.setRGB(0.062, 0.057, 0.054);
        p.color1.setRGB(0.020, 0.019, 0.018);
        p.alpha0 = 0.62; p.alpha1 = 0;
        p.fadeIn = 0.12; p.erode = 0.70; p.sizeCurve = 0.6;
        p.turb = 0.55; p.turbFreq = 0.7;
        p.rot = Math.random() * TAU; p.spin = randRange(-0.7, 0.7);
        ps.emit();
      }
    }

    // --- 5. shockwave ------------------------------------------------------
    //
    // MEASURED ON shots/vfx00/combat_vfx.png, and it was the worst thing in the
    // VFX layer: at R * 2.4 / R * 2.6 these rings are 17-34 m across, which from
    // a 40 m camera is most of the frame — three enormous thin white ellipses
    // laid over the sky, with the fireball they belong to invisible underneath.
    // Neither ring had ever been seen at these numbers (the dome was dark until
    // the smoothstep fix, and the mode-0 ring only became a distortion once the
    // pipeline started handing VFX a scene colour texture).
    //
    // The front of a detonation outruns the fireball by a little, not by three
    // times: the ring is now barely wider than the ball, and it is gone in
    // 0.18 s. Radius is the knob that matters — halving alpha on a shape that
    // spans the frame still leaves a shape that spans the frame.
    ps.ring({
      pos, normal: _up,
      r0: R * 0.3, r1: R * 1.15, thickness: 0.14, life: 0.20,
      color: hdr(_c1, 1.0, 0.84, 0.62, 1.7), alpha: 0.55,
      growth: 2.6, mode: 1, dome: 0.82,
    });
    ps.ring({
      pos, normal: _up,
      r0: R * 0.2, r1: R * 1.35, thickness: 0.13, life: 0.18,
      color: hdr(_c1, 1.0, 0.9, 0.8, 1.5), alpha: 0.45,
      growth: 3.0, mode: 0, distort: true,
    });

    // --- 6. radial debris + sparks with trails ------------------------------
    const debrisScale = o.debris ?? 1;
    const sparkN = Math.round(clamp(14 + R * 3, 14, 44) * q * debrisScale);
    for (let i = 0; i < sparkN; i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 0.5, Math.random() * 2 - 1).normalize();
      const speed = randRange(9, 30) * Math.sqrt(big);
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_v0, R * 0.2);
      p.vel.copy(_v0).multiplyScalar(speed);
      p.drag = randRange(0.5, 1.4);
      p.gravity = 24;
      p.life = randRange(0.4, 1.1);
      p.size0 = randRange(0.07, 0.17) * big; p.size1 = p.size0 * 0.25;
      p.stretch = randRange(0.02, 0.045);
      p.tile = i % 4 === 0 ? TILE.STREAK : TILE.SPARK;
      hdr(p.color0, 1.0, 0.72, 0.3, 13);
      hdr(p.color1, 1.0, 0.18, 0.03, 1.1);
      p.alpha0 = 1; p.alpha1 = 0; p.alphaCurve = 0.7;
      ps.emit();
    }

    const chunkN = Math.round(clamp(4 + R * 1.1, 4, 16) * q * debrisScale);
    for (let i = 0; i < chunkN; i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 1.6 - 0.2, Math.random() * 2 - 1).normalize();
      p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_v0, R * 0.3);
      p.vel.copy(_v0).multiplyScalar(randRange(6, 20) * Math.sqrt(big));
      p.drag = 0.3;
      p.gravity = 24;
      p.life = randRange(0.8, 1.7);
      p.size0 = randRange(0.14, 0.4) * big; p.size1 = p.size0 * 0.9;
      p.tile = TILE.DEBRIS;
      p.color0.setRGB(0.26, 0.17, 0.11);
      p.color1.setRGB(0.10, 0.095, 0.09);
      p.alpha0 = 1; p.alpha1 = 0.85; p.alphaCurve = 2.4; p.fadeIn = 0;
      p.rot = Math.random() * TAU; p.spin = randRange(-14, 14);
      ps.emit();
    }

    // --- 7. ground-hugging dust ring ---------------------------------------
    if (o.ground !== false) {
      const gn = o.groundNormal || _up;
      _v3.copy(gn).normalize();
      basisFrom(_v3, _t1, _t2);
      const dustN = Math.round(clamp(8 + R * 1.4, 8, 20) * q);
      for (let i = 0; i < dustN; i++) {
        const a = (i / dustN) * TAU + Math.random() * 0.4;
        radialDir(_v0, _t1, _t2, a);
        p = ps.begin(BATCH_ALPHA);
        p.pos.copy(pos).addScaledVector(_v0, R * 0.35);
        p.pos.addScaledVector(_v3, R * 0.05);
        p.vel.copy(_v0).multiplyScalar(randRange(7, 17) * Math.sqrt(big));
        p.vel.addScaledVector(_v3, randRange(0.4, 2.2));
        p.drag = 2.4;
        p.life = randRange(0.8, 1.7);
        p.size0 = R * 0.3; p.size1 = R * randRange(1.1, 2.0);
        p.tile = TILE.DUST;
        p.color0.setRGB(0.50, 0.45, 0.40);
        p.color1.setRGB(0.17, 0.16, 0.15);
        p.alpha0 = 0.5; p.alpha1 = 0;
        p.fadeIn = 0.08; p.erode = 0.66; p.sizeCurve = 0.5;
        p.turb = 0.4; p.turbFreq = 2.0;
        p.rot = Math.random() * TAU; p.spin = randRange(-1.6, 1.6);
        ps.emit();
      }
      ps.ring({
        pos: _v1.copy(pos).addScaledVector(_v3, 0.12),
        normal: _v3,
        r0: R * 0.3, r1: R * 1.7, thickness: 0.22, life: 0.40,
        color: hdr(_c1, 0.9, 0.72, 0.5, 0.85), alpha: 0.30, growth: 2.6, mode: 0,
      });
      ps.decal(pos, _v3, R * 1.3, TILE.SCORCH, _c1.setRGB(0.030, 0.024, 0.020), 0.9, 30);
    }

    // --- 8. feedback --------------------------------------------------------
    const shakeScale = o.shake ?? 1;
    if (shakeScale > 0) {
      bus.emit(EV.SHAKE, {
        intensity: clamp(big * 0.55, 0.08, 1.6) * shakeScale,
        duration: clamp(0.22 + big * 0.14, 0.2, 0.85),
      });
    }
    const hs = o.hitstop ?? (R >= 7 ? 0.055 : 0);
    if (hs > 0) bus.emit(EV.HITSTOP, { duration: hs });
    bus.emit('vfx:flash', { intensity: clamp(big * 0.4, 0.05, 0.9), duration: 0.12 });
  }

  // =========================================================================
  // Thruster plumes
  // =========================================================================

  /**
   * Persistent thruster plume parented to a nozzle. The plume fires along the
   * anchor's local +Z (mechs face -Z, so exhaust blows backwards).
   * @param {THREE.Object3D} anchor
   * @param {boolean} on
   * @param {number} intensity 0..1.5
   * @param {object} [opts] { radius, length, axis, embers }
   * @returns {{set:Function, dispose:Function}}
   */
  boostFlame(anchor, on = true, intensity = 1, opts = {}) {
    if (!anchor || !anchor.isObject3D) return NULL_FLAME;
    if (this._flames.length >= this.ps.flameCapacity) return NULL_FLAME;
    const h = new FlameHandle(this, anchor, opts || {});
    h.set(on, intensity);
    // Start at the target so a plume that spawns already-on does not swell in.
    h.intensity = h.target;
    this._flames.push(h);
    return h;
  }

  _removeFlame(h) {
    const i = this._flames.indexOf(h);
    if (i >= 0) this._flames.splice(i, 1);
  }

  _updateFlames(dt) {
    const ps = this.ps;
    const data = ps.flameData;
    let n = 0;
    for (let i = 0; i < this._flames.length; i++) {
      const h = this._flames[i];
      const anchor = h.anchor;
      if (!anchor || !anchor.parent) {
        // The mech was removed from the scene — idle the plume, keep the handle
        // so the owner's dispose() still works.
        h.intensity = 0;
        continue;
      }
      // 45/s converges in ~70ms: thrusters snap, they do not swell.
      h.intensity += (h.target - h.intensity) * (1 - Math.exp(-45 * dt));
      if (h.intensity < 0.004) { h.intensity = 0; continue; }

      anchor.updateWorldMatrix(true, false);
      const e = anchor.matrixWorld.elements;
      h.pos.set(e[12], e[13], e[14]);
      if (h.axis) {
        h.dirW.copy(h.axis);
      } else {
        h.dirW.set(e[8], e[9], e[10]).normalize();
      }

      const o = n * 12;
      data[o] = h.pos.x; data[o + 1] = h.pos.y; data[o + 2] = h.pos.z; data[o + 3] = h.seed;
      data[o + 4] = h.dirW.x; data[o + 5] = h.dirW.y; data[o + 6] = h.dirW.z;
      data[o + 7] = h.length;
      data[o + 8] = h.radius;
      data[o + 9] = h.intensity;
      // Colour temperature: idle plumes are deep blue, full burn is white-hot.
      data[o + 10] = clamp(h.intensity * 0.85, 0, 1);
      data[o + 11] = h.phase;
      n++;
      if (n >= ps.flameCapacity) break;

      // trailing ember stream
      if (h.intensity > 0.35 && ps.canSpawn(2)) {
        h._emberAccum += dt * h.emberRate * h.intensity * this.quality;
        let count = h._emberAccum | 0;
        if (count > 4) count = 4;
        h._emberAccum -= count;
        for (let k = 0; k < count; k++) {
          const p = ps.begin(BATCH_ADD);
          p.pos.copy(h.pos).addScaledVector(h.dirW, randRange(0.4, 1.1) * h.length);
          p.pos.x += randRange(-1, 1) * h.radius * 0.7;
          p.pos.y += randRange(-1, 1) * h.radius * 0.7;
          p.pos.z += randRange(-1, 1) * h.radius * 0.7;
          p.vel.copy(h.dirW).multiplyScalar(randRange(6, 16) * h.intensity);
          p.drag = 3.5;
          p.gravity = 6;
          p.life = randRange(0.12, 0.34);
          p.size0 = randRange(0.03, 0.075); p.size1 = p.size0 * 0.3;
          p.stretch = randRange(0.012, 0.028);
          p.tile = TILE.SPARK;
          hdr(p.color0, 0.75, 0.88, 1.0, 9);
          hdr(p.color1, 1.0, 0.4, 0.12, 1.2);
          p.alpha0 = 1; p.alpha1 = 0; p.alphaCurve = 0.8;
          ps.emit();
        }
        // heat-haze shimmer at the tip (a soft, near-transparent additive puff —
        // real refraction only when the pipeline hands us a scene colour buffer)
        if (Math.random() < dt * 22 * h.intensity) {
          const p = ps.begin(BATCH_ADD);
          p.pos.copy(h.pos).addScaledVector(h.dirW, h.length * randRange(0.85, 1.3));
          p.vel.copy(h.dirW).multiplyScalar(randRange(2, 6));
          p.drag = 4;
          p.life = randRange(0.14, 0.26);
          p.size0 = h.radius * 2.2; p.size1 = h.radius * 5.5;
          p.tile = TILE.SMOKE_B;
          hdr(p.color0, 0.45, 0.6, 1.0, 0.55);
          hdr(p.color1, 0.3, 0.32, 0.4, 0.1);
          p.alpha0 = 0.3; p.alpha1 = 0;
          p.fadeIn = 0.2; p.erode = 0.5; p.sizeCurve = 0.5;
          p.rot = Math.random() * TAU; p.spin = randRange(-4, 4);
          ps.emit();
        }
      }
    }
    ps.setFlameInstances(n);
  }

  // =========================================================================
  // Ribbon trails
  // =========================================================================

  /**
   * Tapered ribbon trail.
   * @param {THREE.Object3D|THREE.Vector3} target head of the trail
   * @param {object|string} [opts] preset name or { type, color, width, life, ... }
   * @returns {{setPosition:Function, follow:Function, end:Function, dispose:Function}}
   */
  trail(target, opts) {
    if (!this.enabled) return NULL_TRAIL;
    let o = opts;
    if (typeof target === 'string') { o = { type: target }; target = null; }
    if (typeof o === 'string') o = { type: o };
    o = o || {};
    if (!target && o.target) target = o.target;
    const type = o.type || 'tracer';

    const preset = TRAIL_PRESETS[type] || TRAIL_PRESETS.tracer;
    const batch = preset.additive ? this.ps.trailAdd : this.ps.trailAlpha;
    const r = batch.acquire();
    if (!r) return NULL_TRAIL;

    r.width = o.width ?? preset.width;
    r.widthGrow = o.widthGrow ?? preset.widthGrow;
    r.life = o.life ?? preset.life;
    r.minSeg = o.minSeg ?? preset.minSeg;
    r.tile = o.tile ?? preset.tile;
    r.scrollRate = o.scroll ?? preset.scroll;
    r.taperHead = o.taperHead ?? preset.taperHead;
    r.alpha = o.alpha ?? preset.alpha;
    r.spread = o.spread ?? preset.spread;
    toColor(r.color, o.color, preset.color[0], preset.color[1], preset.color[2]);
    toColor(r.color1, o.color1, preset.color1[0], preset.color1[1], preset.color1[2]);
    if (o.drift) r.drift.copy(o.drift);
    else r.drift.set(0, preset.rise, 0);

    const h = new TrailHandle(this, batch, r);
    if (target) {
      if (target.isObject3D) h.follow(target);
      else if (target.isVector3) h.setPosition(target);
    }
    this._trails.push(h);
    return h;
  }

  _updateTrails(dt) {
    const t = this.time;
    for (let i = this._trails.length - 1; i >= 0; i--) {
      const h = this._trails[i];
      const r = h.ribbon;
      if (h.disposed || r.dead) { this._trails.splice(i, 1); continue; }
      const batch = h.batch;

      if (!r.ended) {
        if (r.target) {
          if (!r.target.parent) {
            r.ended = true;
          } else {
            r.target.updateWorldMatrix(true, false);
            const e = r.target.matrixWorld.elements;
            batch.push(r, e[12], e[13], e[14], t);
          }
        } else if (r.hasManual) {
          batch.push(r, r.manual.x, r.manual.y, r.manual.z, t);
        }
      }

      const alive = r.used > 0 ? batch.build(r, t, dt) : false;
      if (r.ended && !alive) {
        batch.release(r);
        this._trails.splice(i, 1);
      }
    }
  }

  // =========================================================================
  // Building blocks
  // =========================================================================

  /**
   * Free-standing smoke burst.
   * @param {THREE.Vector3} pos
   * @param {object} [opts] { count, size, life, color, rise, dark, spread, speed }
   */
  smoke(pos, opts) {
    if (!this.enabled || !pos) return;
    const ps = this.ps;
    const o = opts || {};
    const count = Math.round((o.count ?? 6) * this.quality);
    const size = o.size ?? 1.2;
    const life = o.life ?? 1.4;
    const rise = o.rise ?? 1.2;
    const spread = o.spread ?? 0.6;
    const speed = o.speed ?? 1.4;
    toColor(_c0, o.color, 0.16, 0.15, 0.14);
    toColor(_c1, o.color1, 0.035, 0.033, 0.031);
    for (let i = 0; i < count; i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      const p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_v0, Math.random() * size * spread);
      p.vel.copy(_v0).multiplyScalar(randRange(0.3, 1) * speed);
      p.vel.y += rise;
      p.drag = 0.9;
      p.life = life * randRange(0.75, 1.3);
      p.size0 = size * 0.55; p.size1 = size * randRange(1.6, 2.8);
      p.tile = TILE.SMOKE_A + (i % 3);
      p.color0.copy(_c0);
      p.color1.copy(_c1);
      p.alpha0 = o.alpha ?? 0.5; p.alpha1 = 0;
      p.fadeIn = 0.12; p.erode = 0.65; p.sizeCurve = 0.58;
      p.turb = o.turb ?? 0.4; p.turbFreq = 1.3;
      p.rot = Math.random() * TAU; p.spin = randRange(-0.9, 0.9);
      ps.emit();
    }
  }

  /**
   * Free-standing spark burst.
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} dir cone axis
   * @param {object} [opts] { count, speed, spread, life, color, gravity, size }
   */
  sparks(pos, dir, opts) {
    if (!this.enabled || !pos) return;
    const ps = this.ps;
    const o = opts || {};
    _dir.copy(dir || _up);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
    _dir.normalize();
    basisFrom(_dir, _t1, _t2);
    const count = Math.round((o.count ?? 12) * this.quality);
    const speed = o.speed ?? 14;
    const spread = o.spread ?? 1.0;
    const life = o.life ?? 0.3;
    const size = o.size ?? 0.08;
    toColor(_c0, o.color, 1.0, 0.74, 0.3);
    toColor(_c1, o.color1, 1.0, 0.2, 0.03);
    const m0 = o.hdr ?? 14;
    for (let i = 0; i < count; i++) {
      coneDir(_v0, _dir, _t1, _t2, spread);
      const p = ps.begin(BATCH_ADD);
      p.pos.copy(pos);
      p.vel.copy(_v0).multiplyScalar(speed * randRange(0.4, 1.3));
      p.drag = o.drag ?? 1.6;
      p.gravity = o.gravity ?? 24;
      p.life = life * randRange(0.6, 1.4);
      p.size0 = size * randRange(0.7, 1.4); p.size1 = size * 0.3;
      p.stretch = o.stretch ?? 0.025;
      p.tile = i % 5 === 0 ? TILE.STREAK : TILE.SPARK;
      hdr(p.color0, _c0.r, _c0.g, _c0.b, m0);
      hdr(p.color1, _c1.r, _c1.g, _c1.b, 1.3);
      p.alpha0 = 1; p.alpha1 = 0; p.alphaCurve = 0.78;
      ps.emit();
    }
  }

  /**
   * Expanding shockwave ring.
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} normal ring facing
   * @param {object} [opts] { radius, life, color, thickness, dome, mode, alpha, distort }
   */
  shockwave(pos, normal, opts) {
    if (!this.enabled || !pos) return;
    const o = opts || {};
    const R = o.radius ?? 6;
    toColor(_c1, o.color, 1.0, 0.88, 0.7);
    const mul = o.hdr ?? 3.0;
    this.ps.ring({
      pos,
      normal: normal || _up,
      r0: o.r0 ?? R * 0.2,
      r1: R,
      thickness: o.thickness ?? 0.1,
      life: o.life ?? 0.3,
      color: hdr(_c1, _c1.r, _c1.g, _c1.b, mul),
      alpha: o.alpha ?? 0.9,
      growth: o.growth ?? 2.8,
      mode: o.mode ?? (o.dome ? 1 : 0),
      dome: o.dome ?? 0,
      distort: o.distort ?? false,
    });
  }

  /**
   * Long thin additive streak stretched along velocity — the read for a very
   * fast projectile that would otherwise be invisible between frames.
   */
  tracer(pos, dir, opts) {
    if (!this.enabled || !pos) return;
    const o = opts || {};
    _dir.copy(dir || _up).normalize();
    toColor(_c0, o.color, 1.0, 0.82, 0.45);
    const p = this.ps.begin(BATCH_ADD);
    p.pos.copy(pos);
    p.vel.copy(_dir).multiplyScalar(o.speed ?? 240);
    p.life = o.life ?? 0.06;
    p.size0 = o.width ?? 0.12; p.size1 = (o.width ?? 0.12) * 0.6;
    p.stretch = o.stretch ?? 0.028;
    p.tile = TILE.STREAK;
    hdr(p.color0, _c0.r, _c0.g, _c0.b, o.hdr ?? 12);
    hdr(p.color1, _c0.r, _c0.g * 0.4, _c0.b * 0.15, 1.5);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.alphaCurve = 0.9;
    this.ps.emit();
  }

  // =========================================================================
  // Stagger — the ACS break payoff
  // =========================================================================

  /**
   * ACS break. Bright expanding ring, radial energy spikes, a screen-filling
   * flash contribution, sparks pouring out and arcs crawling over the mech for
   * the stagger duration.
   * @param {object} entity
   */
  staggerBurst(entity) {
    if (!this.enabled) return;
    const ps = this.ps;
    const q = this.quality;
    resolvePoint(entity, _v1);
    const R = resolveRadius(entity, 3);
    const dur = (entity && entity.stats && entity.stats.staggerTimer > 0)
      ? entity.stats.staggerTimer : 2.2;

    // screen-filling flash contribution: a huge soft glow the bloom smears out
    let p = ps.begin(BATCH_ADD);
    p.pos.copy(_v1);
    p.life = 0.16;
    p.size0 = R * 1.4; p.size1 = R * 5.5;
    p.tile = TILE.GLOW;
    hdr(p.color0, 1.0, 0.9, 0.72, 22);
    hdr(p.color1, 1.0, 0.5, 0.2, 1.5);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.3; p.alphaCurve = 1.4;
    ps.emit();

    p = ps.begin(BATCH_ADD);
    p.pos.copy(_v1);
    p.life = 0.22;
    p.size0 = R * 2; p.size1 = R * 9;
    p.tile = TILE.FLARE;
    hdr(p.color0, 1.0, 0.82, 0.55, 14);
    hdr(p.color1, 1.0, 0.35, 0.1, 1);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.3;
    p.rot = Math.random() * TAU; p.spin = 1.2;
    ps.emit();

    // rings: a horizontal spiked disc, a dome shock and a wire shell
    ps.ring({
      pos: _v1, normal: _up,
      r0: R * 0.4, r1: R * 4.2, thickness: 0.09, life: 0.42,
      color: hdr(_c1, 1.0, 0.72, 0.32, 5.5), alpha: 1, growth: 2.6,
      mode: 3, spin: 1.6,
    });
    ps.ring({
      pos: _v1, normal: _up,
      r0: R * 0.3, r1: R * 3.2, thickness: 0.12, life: 0.34,
      color: hdr(_c1, 1.0, 0.9, 0.75, 4), alpha: 0.9, growth: 3.0,
      mode: 1, dome: 0.9,
    });
    ps.ring({
      pos: _v1, normal: _up,
      r0: R * 0.2, r1: R * 5.0, thickness: 0.05, life: 0.5,
      color: hdr(_c1, 1.0, 0.55, 0.18, 3), alpha: 0.7, growth: 2.2, mode: 0,
    });
    ps.shell(_v1, R * 0.6, R * 2.6, 0.5, hdr(_c1, 1.0, 0.65, 0.28, 2.6), 0.9, 0);

    // radial energy spikes
    basisFrom(_up, _t1, _t2);
    const spikes = Math.round(16 * q);
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * TAU + Math.random() * 0.2;
      radialDir(_v0, _t1, _t2, a);
      _v0.y += randRange(-0.55, 0.55);
      _v0.normalize();
      p = ps.begin(BATCH_ADD);
      p.pos.copy(_v1).addScaledVector(_v0, R * 0.5);
      p.vel.copy(_v0).multiplyScalar(randRange(14, 30));
      p.drag = 5.5;
      p.life = randRange(0.16, 0.3);
      p.size0 = randRange(0.2, 0.45); p.size1 = 0.05;
      p.stretch = randRange(0.10, 0.22);
      p.tile = TILE.SHARD;
      hdr(p.color0, 1.0, 0.88, 0.65, 18);
      hdr(p.color1, 1.0, 0.3, 0.06, 1.5);
      p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.alphaCurve = 0.7;
      ps.emit();
    }

    // sparks pouring out of the mech
    const sparkN = Math.round(40 * q);
    for (let i = 0; i < sparkN; i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      p = ps.begin(BATCH_ADD);
      p.pos.copy(_v1).addScaledVector(_v0, R * randRange(0.2, 0.9));
      p.vel.copy(_v0).multiplyScalar(randRange(5, 22));
      p.drag = randRange(1.2, 3);
      p.gravity = 24;
      p.life = randRange(0.3, 0.95);
      p.size0 = randRange(0.05, 0.12); p.size1 = p.size0 * 0.25;
      p.stretch = randRange(0.02, 0.04);
      p.tile = i % 5 === 0 ? TILE.STREAK : TILE.SPARK;
      hdr(p.color0, 1.0, 0.75, 0.32, 14);
      hdr(p.color1, 1.0, 0.2, 0.03, 1.2);
      p.alpha0 = 1; p.alpha1 = 0; p.alphaCurve = 0.75;
      ps.emit();
    }

    // a plume of hot gas venting upward
    for (let i = 0; i < Math.round(7 * q); i++) {
      _v0.set(Math.random() * 2 - 1, Math.random() * 1.2, Math.random() * 2 - 1).normalize();
      p = ps.begin(BATCH_ALPHA);
      p.pos.copy(_v1).addScaledVector(_v0, R * 0.5);
      p.vel.copy(_v0).multiplyScalar(randRange(1.5, 4));
      p.vel.y += 2.4;
      p.drag = 1.2;
      p.life = randRange(0.9, 1.8);
      p.size0 = R * 0.4; p.size1 = R * randRange(1.2, 2.1);
      p.tile = TILE.SMOKE_A + (i % 3);
      p.color0.setRGB(0.26, 0.16, 0.10);
      p.color1.setRGB(0.04, 0.037, 0.035);
      p.alpha0 = 0.55; p.alpha1 = 0;
      p.fadeIn = 0.1; p.erode = 0.66; p.sizeCurve = 0.55; p.turb = 0.4; p.turbFreq = 1.6;
      p.rot = Math.random() * TAU; p.spin = randRange(-1.2, 1.2);
      ps.emit();
    }

    ps.lights.flash(_v1, hdr(_c1, 1.0, 0.72, 0.38, 1), 110, R * 12, 0.34, this.time, 3);

    // lingering electrical arcs crawling over the mech
    if (entity && entity.root) {
      let rig = null;
      for (const a of this._arcs) if (!a.active) { rig = a; break; }
      if (!rig) rig = this._arcs[0];
      rig.entity = entity;
      rig.until = this.time + clamp(dur, 0.6, 6);
      rig.accum = 0;
      rig.active = true;
      rig.color.setRGB(0.75, 0.88, 1.0);
    }

    bus.emit(EV.SHAKE, { intensity: 0.85, duration: 0.55 });
    bus.emit(EV.HITSTOP, { duration: 0.09 });
    bus.emit('vfx:flash', { intensity: 0.55, duration: 0.16 });
  }

  _updateArcs(dt) {
    const ps = this.ps;
    for (let i = 0; i < this._arcs.length; i++) {
      const rig = this._arcs[i];
      if (!rig.active) continue;
      if (this.time >= rig.until || !rig.entity || !rig.entity.root || !rig.entity.root.parent) {
        rig.active = false;
        rig.entity = null;
        continue;
      }
      resolvePoint(rig.entity, _v1);
      const R = resolveRadius(rig.entity, 3);
      rig.accum += dt * 34 * this.quality;
      let count = rig.accum | 0;
      if (count > 4) count = 4;
      rig.accum -= count;
      for (let k = 0; k < count; k++) {
        _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        const p = ps.begin(BATCH_ADD);
        p.pos.copy(_v1).addScaledVector(_v0, R * randRange(0.55, 1.05));
        // arcs crawl tangentially across the hull
        _v2.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
          .cross(_v0).normalize();
        p.vel.copy(_v2).multiplyScalar(randRange(1.5, 5));
        p.life = randRange(0.05, 0.12);
        p.size0 = randRange(0.25, 0.8); p.size1 = p.size0;
        p.stretch = randRange(0.25, 0.8);
        p.tile = TILE.ARC;
        hdr(p.color0, rig.color.r, rig.color.g, rig.color.b, 11);
        hdr(p.color1, 0.4, 0.55, 1.0, 1);
        p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.alphaCurve = 0.45;
        p.rot = Math.random() * TAU;
        ps.emit();
      }
      // occasional venting spark
      if (Math.random() < dt * 12) {
        _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        _v2.copy(_v1).addScaledVector(_v0, R * 0.8);
        this.sparks(_v2, _v0, { count: 4, speed: 9, spread: 0.8, life: 0.28, size: 0.06 });
      }
    }
  }

  // =========================================================================
  // Quick boost / scan / damage smoke
  // =========================================================================

  /**
   * The lateral vapour-cone puff when a mech quick-boosts.
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} dir direction of travel (exhaust goes the other way)
   * @param {number} scale
   */
  quickBoostBurst(pos, dir, scale = 1) {
    if (!this.enabled || !pos) return;
    const ps = this.ps;
    const q = this.quality;
    const s = clamp(scale, 0.3, 3);
    _dir.copy(dir || _up);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize().negate();   // exhaust points opposite the dash
    basisFrom(_dir, _t1, _t2);

    // bright blue-white core flash
    let p = ps.begin(BATCH_ADD);
    p.pos.copy(pos).addScaledVector(_dir, 0.5 * s);
    p.life = 0.1;
    p.size0 = 0.8 * s; p.size1 = 3.2 * s;
    p.tile = TILE.GLOW;
    hdr(p.color0, 0.72, 0.88, 1.0, 11);
    hdr(p.color1, 0.3, 0.45, 1.0, 0.8);
    p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0; p.sizeCurve = 0.35; p.alphaCurve = 1.4;
    ps.emit();

    // flat vapour cone — wide, thin, gone in a quarter second
    const n = Math.round(14 * q);
    for (let i = 0; i < n; i++) {
      coneDir(_v0, _dir, _t1, _t2, 0.95);
      p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_dir, randRange(0.2, 1.0) * s);
      p.vel.copy(_v0).multiplyScalar(randRange(7, 20) * s);
      p.drag = 6.5;
      p.life = randRange(0.18, 0.38);
      p.size0 = 0.4 * s; p.size1 = randRange(2.2, 4.0) * s;
      p.tile = i % 2 ? TILE.SMOKE_C : TILE.DUST;
      p.color0.setRGB(0.62, 0.70, 0.82);
      p.color1.setRGB(0.14, 0.16, 0.20);
      p.alpha0 = 0.4; p.alpha1 = 0;
      p.fadeIn = 0.05; p.erode = 0.6; p.sizeCurve = 0.42;
      p.rot = Math.random() * TAU; p.spin = randRange(-4, 4);
      ps.emit();
    }

    // vapour-cone ring perpendicular to the dash
    ps.ring({
      pos: _v1.copy(pos).addScaledVector(_dir, 0.7 * s),
      normal: _dir,
      r0: 0.4 * s, r1: 3.4 * s, thickness: 0.22, life: 0.2,
      color: hdr(_c1, 0.6, 0.8, 1.0, 2.2), alpha: 0.6, growth: 2.6, mode: 0,
    });

    // ember scatter
    const sp = Math.round(9 * q);
    for (let i = 0; i < sp; i++) {
      coneDir(_v0, _dir, _t1, _t2, 0.7);
      p = ps.begin(BATCH_ADD);
      p.pos.copy(pos).addScaledVector(_dir, 0.3 * s);
      p.vel.copy(_v0).multiplyScalar(randRange(10, 28) * s);
      p.drag = 3;
      p.gravity = 12;
      p.life = randRange(0.12, 0.3);
      p.size0 = randRange(0.04, 0.09) * s; p.size1 = 0.02;
      p.stretch = randRange(0.02, 0.045);
      p.tile = TILE.SPARK;
      hdr(p.color0, 0.75, 0.9, 1.0, 10);
      hdr(p.color1, 1.0, 0.45, 0.15, 1.2);
      p.alpha0 = 1; p.alpha1 = 0;
      ps.emit();
    }

    ps.lights.flash(_v1.copy(pos).addScaledVector(_dir, 0.6 * s),
      hdr(_c1, 0.55, 0.75, 1.0, 1), 22 * s, 12 * s, 0.14, this.time, 0);
  }

  // =========================================================================
  // Ground particulate
  // =========================================================================

  /**
   * Dust thrown off a surface by thrust or by a mech moving across it.
   * @param {THREE.Vector3} pos contact point (on the ground)
   * @param {THREE.Vector3} flow direction the wash travels along the surface
   * @param {number} strength 0..1.5 — rate and reach
   * @param {number} [scale] mech-sized by default
   */
  groundWash(pos, flow, strength = 1, scale = 1) {
    if (!this.enabled || !pos) return;
    const ps = this.ps;
    const st = clamp(strength, 0, 1.6);
    const s = clamp(scale, 0.4, 3);
    _w1.copy(flow || _up);
    _w1.y = 0;
    if (_w1.lengthSq() < 1e-6) _w1.set(1, 0, 0);
    _w1.normalize();
    // side vector for the splay
    _w2.set(-_w1.z, 0, _w1.x);

    // A THRUSTER WASH IS A WALL JET, and the shape of a wall jet is the whole
    // effect: the exhaust hits the deck, turns, and races OUTWARD along the
    // surface far faster than it ever rises, then rolls up into a billow at the
    // periphery once drag has eaten the horizontal run. The old numbers had it
    // backwards — up to 6.6 m/s of launch velocity straight up against 3-10 m/s
    // along the ground — so the dust behaved like a smoke puff released at
    // ankle height and never read as anything blasting the deck.
    //
    // Horizontal is now 4x the vertical at birth, drag is high so the run stops
    // inside a couple of metres, and GRAVITY IS NEGATIVE: fine dust is buoyant
    // in its own turbulence, so the sheet lifts as it slows. That, and not a
    // launch velocity, is what makes the billow happen at the RIM instead of at
    // the source.
    const grit = Math.random() < 0.22;
    const p = ps.begin(BATCH_ALPHA);
    const off = randRange(-1, 1);
    p.pos.copy(pos).addScaledVector(_w2, off * randRange(0.3, 1.6) * s)
      .addScaledVector(_w1, randRange(-0.2, 0.9) * s);
    p.pos.y += randRange(0.02, 0.30) * s;
    p.vel.copy(_w1).multiplyScalar(randRange(7, 17) * (0.45 + st) * s)
      .addScaledVector(_w2, off * randRange(1.5, 5.0) * s);

    if (grit) {
      // The sharp half: a low, fast, streaked skirt that outruns the billow and
      // gives the sheet a defined leading edge instead of a soft gradient.
      p.vel.y = randRange(0.1, 0.9);
      p.drag = 1.5;
      p.gravity = 3.0;
      p.life = randRange(0.35, 0.75);
      p.size0 = 0.22 * s; p.size1 = randRange(0.9, 1.7) * s;
      p.stretch = randRange(0.02, 0.05);
      p.tile = TILE.DUST;
      p.color0.setRGB(0.46, 0.385, 0.29);
      p.color1.setRGB(0.16, 0.14, 0.12);
      p.alpha0 = randRange(0.22, 0.40) * (0.45 + st * 0.55); p.alpha1 = 0;
      p.fadeIn = 0.05; p.erode = 0.5; p.sizeCurve = 0.45; p.alphaCurve = 1.4;
    } else {
      p.vel.y = randRange(0.3, 1.8) * (0.5 + st);
      p.drag = 3.1;
      p.gravity = -0.55;                 // buoyant: the sheet lofts as it slows
      p.life = randRange(1.0, 2.2);
      p.size0 = 0.55 * s; p.size1 = randRange(3.0, 6.0) * s;
      p.tile = Math.random() < 0.6 ? TILE.DUST : TILE.SMOKE_B + (Math.random() < 0.5 ? 0 : 1);
      p.color0.setRGB(0.38, 0.315, 0.235);
      p.color1.setRGB(0.115, 0.100, 0.086);
      p.alpha0 = randRange(0.18, 0.32) * (0.45 + st * 0.55); p.alpha1 = 0;
      p.fadeIn = 0.13; p.erode = 0.66; p.sizeCurve = 0.42;
      p.turb = 0.42; p.turbFreq = 1.5;
      p.rot = Math.random() * TAU; p.spin = randRange(-1.5, 1.5);
    }
    ps.emit();
  }

  /**
   * The dust slam when a mech puts 60 tonnes back on the deck.
   * @param {THREE.Vector3} pos foot position
   * @param {number} impactSpeed m/s of downward velocity absorbed
   * @param {number} [scale]
   */
  landingDust(pos, impactSpeed = 12, scale = 2.2) {
    if (!this.enabled || !pos) return;
    const ps = this.ps;
    const q = this.quality;
    const hard = clamp(impactSpeed / 26, 0.18, 1.4);
    const s = clamp(scale, 0.5, 4);

    basisFrom(_up, _t1, _t2);

    // TWO SHEETS, and the fast one is what says "60 tonnes". A landing slam
    // drives a thin skirt of dust out along the deck several times faster than
    // the billow that follows it, so for the first ~0.3 s there is a sharp
    // expanding edge with a rolling cloud catching up behind. One population of
    // puffs at one speed can only ever be a puff.
    const n = Math.round(clamp(10 + 16 * hard, 10, 26) * q);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.5;
      radialDir(_v0, _t1, _t2, a);
      const p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_v0, randRange(0.3, 1.1) * s);
      p.pos.y += 0.1;
      p.vel.copy(_v0).multiplyScalar(randRange(6, 17) * hard * s);
      p.vel.y = randRange(0.2, 1.4) * hard;   // out, not up — see groundWash
      p.drag = 2.9;
      p.gravity = -0.5;                       // buoyant, so the rim rolls up
      p.life = randRange(1.0, 2.2);
      p.size0 = 0.45 * s; p.size1 = randRange(2.4, 5.0) * s;
      p.tile = i % 3 === 0 ? TILE.SMOKE_B : TILE.DUST;
      p.color0.setRGB(0.44, 0.365, 0.27);
      p.color1.setRGB(0.125, 0.110, 0.095);
      p.alpha0 = 0.32 * (0.5 + hard * 0.5); p.alpha1 = 0;
      p.fadeIn = 0.07; p.erode = 0.64; p.sizeCurve = 0.45;
      p.turb = 0.4; p.turbFreq = 1.8;
      p.rot = Math.random() * TAU; p.spin = randRange(-1.8, 1.8);
      ps.emit();
    }

    // The sharp skirt: low, fast, velocity-streaked, gone before the billow is.
    const skirt = Math.round(clamp(6 + 10 * hard, 6, 16) * q);
    for (let i = 0; i < skirt; i++) {
      const a = (i / skirt) * TAU + Math.random() * 0.7;
      radialDir(_v0, _t1, _t2, a);
      const p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos).addScaledVector(_v0, randRange(0.2, 0.8) * s);
      p.pos.y += randRange(0.02, 0.2);
      p.vel.copy(_v0).multiplyScalar(randRange(14, 30) * hard * s);
      p.vel.y = randRange(0.05, 0.5);
      p.drag = 4.2;
      p.gravity = 2.0;
      p.life = randRange(0.3, 0.62);
      p.size0 = 0.3 * s; p.size1 = randRange(1.1, 2.0) * s;
      p.stretch = randRange(0.02, 0.05);
      p.tile = TILE.DUST;
      p.color0.setRGB(0.50, 0.42, 0.31);
      p.color1.setRGB(0.17, 0.15, 0.13);
      p.alpha0 = 0.30 * (0.5 + hard * 0.5); p.alpha1 = 0;
      p.fadeIn = 0.04; p.erode = 0.48; p.sizeCurve = 0.4; p.alphaCurve = 1.3;
      ps.emit();
    }

    // grit kicked up and thrown clear — the fast, sharp half of the effect
    const grit = Math.round(6 * q * hard);
    for (let i = 0; i < grit; i++) {
      coneDir(_v0, _up, _t1, _t2, 1.25);
      const p = ps.begin(BATCH_ALPHA);
      p.pos.copy(pos);
      p.vel.copy(_v0).multiplyScalar(randRange(5, 16) * hard * s);
      p.drag = 0.35; p.gravity = 24;
      p.life = randRange(0.5, 1.0);
      p.size0 = randRange(0.06, 0.16) * s; p.size1 = p.size0 * 0.85;
      p.tile = TILE.DEBRIS;
      p.color0.setRGB(0.30, 0.255, 0.19);
      p.color1.setRGB(0.14, 0.125, 0.105);
      p.alpha0 = 1; p.alpha1 = 0.85; p.alphaCurve = 2.2; p.fadeIn = 0;
      p.rot = Math.random() * TAU; p.spin = randRange(-12, 12);
      ps.emit();
    }

    if (hard > 0.55) {
      ps.ring({
        pos: _v1.copy(pos).setY(pos.y + 0.14), normal: _up,
        r0: s * 0.5, r1: s * (2.4 + hard * 1.6), thickness: 0.16,
        life: 0.4, color: hdr(_c1, 0.70, 0.60, 0.46, 0.9),
        alpha: 0.32 * hard, growth: 2.6, mode: 0,
      });
    }
  }

  /**
   * Register an entity for per-frame ground particulate. Optional — VFX also
   * latches entities off the movement events it already listens to, so this is
   * only needed to start the effect before an entity has landed or boosted.
   * @param {object} entity anything with `.root` and a published `.moveState`
   */
  addGroundWashTarget(entity) { this._noteWasher(entity); }

  /**
   * Dust under anything moving fast near the deck.
   *
   * `moveState.heightAboveGround` is the only ground sampler VFX has — it does
   * not own the physics — so this runs for entities that publish one. Below
   * WASH_H a hovering mech's thrusters blast the deck even standing still;
   * above it, only forward speed raises anything.
   */
  _updateGroundWash(dt) {
    if (!this.enabled || dt <= 0) return;
    // A main nozzle sits ~6 m up on a 9 m mech and the exhaust is several metres
    // long, so it is still scouring the deck with the feet well clear of it.
    const WASH_H = 5.5;
    for (let i = this._washers.length - 1; i >= 0; i--) {
      const w = this._washers[i];
      const e = w.entity;
      const m = e && e.moveState;
      if (!m || !e.root || e.alive === false) { this._washers.splice(i, 1); continue; }

      const h = m.heightAboveGround;
      if (!Number.isFinite(h) || h > WASH_H) { w.accum = 0; continue; }

      const near = 1 - clamp(h / WASH_H, 0, 1);          // 1 on the deck, 0 at WASH_H
      const speed = m.speed || 0;
      const run = clamp(speed / 60, 0, 1.35);

      // THRUST, not just altitude, decides whether the deck is being blasted.
      // The old rule was `grounded ? 0 : near * 0.75`, which gave a mech hovering
      // 20 cm off the deck under full lift exactly as much wash as one drifting
      // through the same point with cold engines, and gave a mech STANDING on it
      // under ground boost none at all. Mirrors Game._updatePlayerThrusters so
      // the dust and the plume agree about how hard the engines are working.
      let thrust = m.grounded ? 0.10 : 0.45;
      if (m.boosting) thrust = Math.max(thrust, 0.72);
      if (m.assaultBoost) thrust = Math.max(thrust, 1.0);
      if (m.quickBoost || (m.qbTimer ?? 0) > 0) thrust = 1.3;
      if (m.staggered) thrust = 0;
      // near^2: a jet's scour falls off fast with standoff distance.
      const downwash = thrust * near * near;
      const strength = clamp(run * (0.35 + near * 0.65) + downwash, 0, 1.5);
      if (strength < 0.14) { w.accum = 0; continue; }

      w.accum += dt * (8 + 54 * strength) * this.quality;
      let count = w.accum | 0;
      if (count > 6) count = 6;                            // never a frame-rate spike
      w.accum -= count;
      if (!count || !this.ps.canSpawn(count)) continue;

      // Contact point is under the mech's origin, which the contract puts at the
      // feet.
      _v1.copy(e.root.position);
      _v1.y -= h;
      const vel = e.velocity;
      const moving = vel && (vel.x * vel.x + vel.z * vel.z) > 4;
      if (moving) _v3.set(-vel.x, 0, -vel.z).normalize();
      else _v3.set(0, 0, 0);

      // How much of the wash is a stationary jet hitting the deck (radial) and
      // how much is dust the machine is outrunning (trailing). A hovering mech
      // is all radial; one crossing the map at 90 m/s leaves a wake.
      const radialShare = moving ? clamp(downwash / Math.max(strength, 1e-3), 0.12, 1) : 1;
      const reach = clamp(resolveRadius(e, 2.2), 1.2, 4);

      for (let k = 0; k < count; k++) {
        if (Math.random() < radialShare) {
          // WALL JET. The exhaust column hits the deck and turns: dust leaves
          // the impingement point radially, in a flat sheet, in every direction
          // at once. This is the half that was missing entirely — the old code
          // only ever blew dust along one line.
          const a = Math.random() * TAU;
          _w3.set(Math.cos(a), 0, Math.sin(a));
          _w0.copy(_v1).addScaledVector(_w3, randRange(0.15, 1.0) * reach);
          this.groundWash(_w0, _w3, strength, reach * 0.55);
        } else {
          _w3.copy(_v3);
          _w0.copy(_v1).addScaledVector(_w3, randRange(0.2, 2.6) * reach * (0.4 + run));
          this.groundWash(_w0, _w3, strength, reach * 0.55);
        }
      }
    }
  }

  /**
   * Targeting / lock-on sweep.
   * @param {object|THREE.Object3D|THREE.Vector3} target
   * @param {object} [opts] { radius, life, color, mode }
   */
  scanLine(target, opts) {
    if (!this.enabled) return;
    const o = opts || {};
    resolvePoint(target, _v1);
    const R = o.radius ?? resolveRadius(target, 3) * 2.2;
    toColor(_c0, o.color, 0.35, 0.85, 1.0);
    this.ps.shell(_v1, R * 0.25, R, o.life ?? 0.5,
      hdr(_c1, _c0.r, _c0.g, _c0.b, o.hdr ?? 2.4), o.alpha ?? 0.85, o.mode ?? 0);
    this.ps.ring({
      pos: _v1, normal: _up,
      r0: R * 0.2, r1: R * 1.15, thickness: 0.06, life: (o.life ?? 0.5) * 0.9,
      color: hdr(_c1, _c0.r, _c0.g, _c0.b, 3), alpha: 0.55, growth: 2.0, mode: 4,
    });
  }

  /**
   * Persistent damage smoke + intermittent sparks. Rate scales with how much AP
   * the entity has lost; below ~35% damage nothing is emitted at all.
   * @returns {{dispose:Function}}
   */
  attachDamageSmoke(entity, opts) {
    const h = new DamageSmokeHandle(this, entity, opts || {});
    this._damage.push(h);
    // Free bootstrap for the ground wash. `_noteWasher` otherwise only latches
    // an entity when it LANDS, assault-boosts or runs its EN dry, so a mech
    // that spawned on the deck and ground-boosted away raised no dust at all
    // until the first time it jumped — the whole opening of a mission. Game
    // calls this for the player at boot and for every enemy as it spawns, which
    // is exactly the set that wants a wash.
    this._noteWasher(entity);
    return h;
  }

  _removeDamageSmoke(h) {
    const i = this._damage.indexOf(h);
    if (i >= 0) this._damage.splice(i, 1);
  }

  _updateDamageSmoke(dt) {
    const ps = this.ps;
    for (let i = this._damage.length - 1; i >= 0; i--) {
      const h = this._damage[i];
      const e = h.entity;
      if (h.disposed || !e || !e.root || !e.root.parent) {
        this._damage.splice(i, 1);
        continue;
      }
      const st = e.stats;
      const apMax = (st && st.apMax) || 1;
      const ap = st ? clamp(st.ap / apMax, 0, 1) : 1;
      const hurt = clamp((0.72 - ap) / 0.72, 0, 1);
      if (hurt <= 0.02 || e.alive === false) continue;

      resolvePoint(e, _v1);
      const R = resolveRadius(e, 3);

      h.accum += dt * (3 + hurt * 16) * this.quality * h.scale;
      let count = h.accum | 0;
      if (count > 3) count = 3;
      h.accum -= count;
      for (let k = 0; k < count; k++) {
        _v0.set(Math.random() * 2 - 1, Math.random() * 1.4 - 0.3, Math.random() * 2 - 1).normalize();
        const p = ps.begin(BATCH_ALPHA);
        p.pos.copy(_v1).addScaledVector(_v0, R * randRange(0.3, 0.85));
        p.vel.copy(_v0).multiplyScalar(randRange(0.4, 1.6));
        p.vel.y += randRange(1.4, 3.2);
        if (e.velocity) p.vel.addScaledVector(e.velocity, 0.35);
        p.drag = 1.1;
        p.life = randRange(0.9, 2.0) * (0.6 + hurt);
        p.size0 = R * 0.28; p.size1 = R * randRange(0.9, 1.8);
        p.tile = TILE.SMOKE_A + (k % 3);
        p.color0.setRGB(0.085, 0.078, 0.072);
        p.color1.setRGB(0.024, 0.023, 0.022);
        p.alpha0 = 0.28 + hurt * 0.34; p.alpha1 = 0;
        p.fadeIn = 0.14; p.erode = 0.68; p.sizeCurve = 0.6;
        p.turb = 0.35; p.turbFreq = 1.1;
        p.rot = Math.random() * TAU; p.spin = randRange(-0.8, 0.8);
        ps.emit();
      }

      // intermittent electrical spitting once badly hurt
      if (hurt > 0.5) {
        h.sparkAccum += dt * (hurt - 0.5) * 5.5;
        if (h.sparkAccum >= 1) {
          h.sparkAccum = 0;
          _v0.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
          _v2.copy(_v1).addScaledVector(_v0, R * 0.7);
          this.sparks(_v2, _v0, {
            count: 5 + Math.round(hurt * 6), speed: 11, spread: 1.0,
            life: 0.32, size: 0.07, drag: 2.2,
          });
          const p = ps.begin(BATCH_ADD);
          p.pos.copy(_v2);
          p.life = 0.07;
          p.size0 = 0.25; p.size1 = 0.7;
          p.tile = TILE.CORE;
          hdr(p.color0, 1.0, 0.85, 0.6, 10);
          hdr(p.color1, 1.0, 0.3, 0.08, 1);
          p.alpha0 = 1; p.alpha1 = 0; p.fadeIn = 0;
          ps.emit();
        }
      }
    }
  }

  // =========================================================================
  // Deferred work
  // =========================================================================

  _defer(delay, kind, a, b, s) {
    for (let i = 0; i < this._deferred.length; i++) {
      const d = this._deferred[i];
      if (d.active) continue;
      d.active = true;
      d.time = this.time + delay;
      d.kind = kind;
      d.a.copy(a);
      if (b) d.b.copy(b); else d.b.set(0, 1, 0);
      d.s = s;
      return d;
    }
    return null;
  }

  _updateDeferred() {
    for (let i = 0; i < this._deferred.length; i++) {
      const d = this._deferred[i];
      if (!d.active || this.time < d.time) continue;
      d.active = false;
      switch (d.kind) {
        case DEF_SPARK_BOUNCE:
          // ricochet: a tight second burst kicking away from the surface
          this.sparks(d.a, d.b, {
            count: 4, speed: 9 * d.s, spread: 0.9, life: 0.22,
            size: 0.055, drag: 2.4, gravity: 24,
          });
          break;
        case DEF_SECONDARY:
          this.explosion(d.a, d.s, { ground: false, shake: 0.4, smoke: true });
          break;
        case DEF_SMOKE:
          this.smoke(d.a, { count: 5, size: d.s, life: 1.6 });
          break;
        default: break;
      }
    }
  }

  // =========================================================================
  // Frame / lifecycle
  // =========================================================================

  /**
   * @param {number} dt seconds since last frame (already time-scaled)
   * @param {number} elapsed total scaled elapsed seconds — the clock every
   *   GPU-simulated particle is driven from
   */
  update(dt, elapsed) {
    this.time = elapsed;
    this._updateDeferred();
    this._updateFlames(dt);
    this._updateGroundWash(dt);
    this._updateTrails(dt);
    this._updateArcs(dt);
    this._updateDamageSmoke(dt);
    this.ps.update(dt, elapsed);
  }

  // -- pipeline hooks -------------------------------------------------------

  /**
   * Optional. Enables soft particles (depth-faded intersections). Everything
   * works without it — particles simply cut hard against geometry.
   */
  setDepthTexture(tex, camNear, camFar, softness) {
    this.ps.setDepthTexture(tex, camNear, camFar, softness);
  }

  /** Optional. Enables true refractive shockwave distortion. */
  setSceneColorTexture(tex) {
    this.ps.setSceneColorTexture(tex);
  }

  /** 'low' | 'med' | 'high' | 'ultra', or a raw 0.15..2 multiplier. */
  setQuality(level) {
    const map = { low: 0.35, med: 0.65, high: 1, ultra: 1.35 };
    const v = typeof level === 'number' ? level : (map[level] ?? 1);
    this.quality = clamp(v, 0.15, 2);
    this.ps.setQuality(this.quality);
  }

  /** Live particle count (approximate, bucket-tracked). */
  get liveParticles() { return this.ps.live; }

  reset() {
    this.ps.reset();
    for (let i = this._trails.length - 1; i >= 0; i--) this._trails[i].dispose();
    this._trails.length = 0;
    this._damage.length = 0;
    for (const a of this._arcs) { a.active = false; a.entity = null; }
    for (const d of this._deferred) d.active = false;
    this._washers.length = 0;
    for (const f of this._flames) { f.intensity = 0; f.target = 0; }
    this.ps.setFlameInstances(0);
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this._flames.length = 0;
    this._trails.length = 0;
    this._damage.length = 0;
    this._washers.length = 0;
    this.ps.dispose();
  }
}

// ---------------------------------------------------------------------------
// Trail presets
// ---------------------------------------------------------------------------

const TRAIL_PRESETS = {
  /** Thin, hot, short — bullets and beams. */
  tracer: {
    additive: true, width: 0.16, widthGrow: 0.2, life: 0.16, minSeg: 0.9,
    tile: 1, scroll: -2.5, taperHead: 0.12, alpha: 1, spread: 0, rise: 0,
    color: [7.0, 4.2, 1.6], color1: [1.6, 0.4, 0.08],
  },
  /** Energy weapons — cyan, brighter, slightly wider. */
  plasma: {
    additive: true, width: 0.28, widthGrow: 0.4, life: 0.24, minSeg: 0.8,
    tile: 1, scroll: -3.5, taperHead: 0.12, alpha: 1, spread: 0, rise: 0,
    color: [2.4, 6.5, 9.0], color1: [1.2, 0.6, 3.2],
  },
  /** Thick, white, turbulent, long-lived — missiles. */
  missile: {
    additive: false, width: 0.85, widthGrow: 2.6, life: 2.6, minSeg: 1.4,
    tile: 4, scroll: -0.35, taperHead: 0.06, alpha: 0.62, spread: 0.35, rise: 0.85,
    color: [0.78, 0.76, 0.74], color1: [0.16, 0.155, 0.15],
  },
  /** Boost afterimage ribbon — wide, cool, very short. */
  afterimage: {
    additive: true, width: 1.5, widthGrow: -0.4, life: 0.24, minSeg: 0.6,
    tile: 1, scroll: -1.2, taperHead: 0.25, alpha: 0.55, spread: 0, rise: 0,
    color: [0.9, 2.0, 4.2], color1: [0.15, 0.3, 1.1],
  },
  /** Crawling electrical arc. */
  arc: {
    additive: true, width: 0.2, widthGrow: 0, life: 0.12, minSeg: 0.35,
    tile: 2, scroll: -8, taperHead: 0.1, alpha: 1, spread: 0, rise: 0,
    color: [3.0, 5.0, 9.0], color1: [0.6, 1.0, 3.0],
  },
  /** Falling debris smoke. */
  debris: {
    additive: false, width: 0.35, widthGrow: 2.2, life: 1.1, minSeg: 0.8,
    tile: 3, scroll: -0.4, taperHead: 0.1, alpha: 0.4, spread: 0.2, rise: 0.5,
    color: [0.32, 0.30, 0.29], color1: [0.08, 0.078, 0.075],
  },
};

export default VFX;
