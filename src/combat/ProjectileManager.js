import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, interceptPoint } from '../core/MathUtils.js';
import { getDamageSystem } from './DamageSystem.js';

/**
 * Pooled, instanced projectile simulation.
 *
 * Everything in flight lives in one flat pool of plain objects; rendering is done with a
 * handful of InstancedMeshes so 500+ live rounds cost a fistful of draw calls. Nothing is
 * allocated after construction.
 *
 * Kinds:
 *   bullet  — fast, near-hitscan, stretched additive tracer
 *   pellet  — like bullet but short-lived with range falloff (shotguns)
 *   shell   — ballistic arc under gravity, explodes (bazooka / shoulder cannon)
 *   missile — proportional-navigation homing, unguided pop-up phase, proximity fuse
 *   plasma  — slow glowing orb with a real point light, leaves a damaging field
 *   beam    — instant hitscan, persistent beam mesh for its lifetime
 *   field   — stationary lingering damage volume spawned by plasma detonations
 *
 * Collision is resolved on the SWEPT SEGMENT every frame (never a point test), against
 * both the static world (physics.raycast) and entity capsules, so a 1500 m/s railgun slug
 * cannot tunnel through a wall or a mech at 60 fps.
 */

// ------------------------------------------------------------------ capacities
const CAP = {
  tracer: 700, // bullet + pellet
  shell: 96,
  missile: 220,
  plasma: 48,
  field: 20,
  beam: 32,
  flare: 300, // engine glow for shells + missiles
};
const MAX_PROJECTILES = 1024;
const MAX_LIGHTS = 4;
const MAX_HITS_PER_PROJECTILE = 6;

// ------------------------------------------------------------------ scratch
// Every helper below owns a disjoint set of scratch vectors so that nesting
// (_sweep -> _detonate -> _splash) can never clobber a caller's vector.
const UNIT_Z = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _hitP = new THREE.Vector3();
const _hitN = new THREE.Vector3();
const _detP = new THREE.Vector3();
const _detN = new THREE.Vector3();
const _spA = new THREE.Vector3();
const _spB = new THREE.Vector3();
const _fldA = new THREE.Vector3();
const _fldB = new THREE.Vector3();
const _gP = new THREE.Vector3();
const _gN = new THREE.Vector3();
const _bFrom = new THREE.Vector3();
const _bTo = new THREE.Vector3();
const _bDir = new THREE.Vector3();
const _bP = new THREE.Vector3();
const _bN = new THREE.Vector3();
const _cs1 = new THREE.Vector3();
const _cs2 = new THREE.Vector3();
const _csD1 = new THREE.Vector3();
const _csD2 = new THREE.Vector3();
const _csR = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _scl = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _col = new THREE.Color();
const _closest = { s: 0, t: 0, d2: 0 };

/**
 * Closest distance between segment [p1,q1] and segment [p2,q2].
 * Ericson, Real-Time Collision Detection §5.1.9. Writes {s,t,d2} into `out`.
 */
function closestSegSeg(p1, q1, p2, q2, out) {
  _csD1.subVectors(q1, p1);
  _csD2.subVectors(q2, p2);
  _csR.subVectors(p1, p2);
  const a = _csD1.dot(_csD1);
  const e = _csD2.dot(_csD2);
  const f = _csD2.dot(_csR);
  let s = 0;
  let t = 0;
  const EPS = 1e-8;
  if (a <= EPS && e <= EPS) {
    out.s = 0;
    out.t = 0;
    out.d2 = _csR.dot(_csR);
    return out;
  }
  if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = _csD1.dot(_csR);
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = _csD1.dot(_csD2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  _cs1.copy(p1).addScaledVector(_csD1, s);
  _cs2.copy(p2).addScaledVector(_csD2, t);
  out.s = s;
  out.t = t;
  out.d2 = _cs1.distanceToSquared(_cs2);
  return out;
}

/** One pooled projectile. Fields are flat + preallocated; never re-shaped at runtime. */
class Projectile {
  constructor(index) {
    this.index = index;
    this.active = false;
    this.kind = 'bullet';
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);
    this.spawnPos = new THREE.Vector3();
    this.beamEnd = new THREE.Vector3();
    this.color = new THREE.Color(1, 1, 1);
    this.owner = null;
    this.faction = '';
    this.target = null;
    this.speed = 0;
    this.age = 0;
    this.maxLife = 3;
    this.damage = 0;
    this.impact = 0;
    this.type = 'kinetic';
    this.pulse = false;
    this.radius = 0.15;
    this.width = 0.1;
    this.length = 4;
    this.gravity = 0;
    this.pierce = 0;
    this.hitCount = 0;
    this.hits = new Array(MAX_HITS_PER_PROJECTILE).fill(null);
    this.splashRadius = 0;
    this.splashDamage = 0;
    this.splashImpact = 0;
    this.explosionRadius = 0;
    this.explosionPower = 0;
    this.explosionColor = 0xffa040;
    // homing
    this.homing = false;
    this.hTurn = 2.5;
    this.hTurnBoost = 3.4;
    this.hFuse = 2.5;
    this.hBoostDelay = 0.4;
    this.hAccel = 180;
    this.hMaxSpeed = 170;
    this.hLead = 1;
    // trail / fx — VFX hands back a persistent ribbon handle we drive each frame
    this.trail = false;
    this.trailHandle = null;
    this.trailColor = new THREE.Color(1, 1, 1);
    this.trailWidth = 0.3;
    // lingering field
    this.fieldDef = null;
    this.fieldDps = 0;
    this.fieldImpact = 0;
    this.fieldTick = 0.25;
    this.fieldT = 0;
    // range falloff
    this.falloffStart = 0;
    this.falloffEnd = 0;
    this.falloffMin = 1;
    this.travelled = 0;
    this.maxRange = 1400;
    this.charged = false;
    this.wantsLight = false;
    this.weaponId = '';
    this.fade = 1;
  }

  reset() {
    this.active = false;
    this.owner = null;
    this.target = null;
    this.fieldDef = null;
    this.hitCount = 0;
    for (let i = 0; i < MAX_HITS_PER_PROJECTILE; i++) this.hits[i] = null;
    if (this.trailHandle) {
      // stop feeding the ribbon; VFX dissolves and recycles it on its own
      this.trailHandle.end?.();
      this.trailHandle = null;
    }
    this.trail = false;
  }

  hasHit(e) {
    for (let i = 0; i < this.hitCount; i++) if (this.hits[i] === e) return true;
    return false;
  }

  noteHit(e) {
    if (this.hitCount < MAX_HITS_PER_PROJECTILE) this.hits[this.hitCount++] = e;
  }
}

export class ProjectileManager {
  /**
   * @param {THREE.Scene} scene
   * @param {object} physics exposes raycast(origin, dir, maxDist) -> {point, normal, distance}
   * @param {object} vfx VFX facade — every call is optional-chained
   */
  constructor(scene, physics, vfx) {
    this.scene = scene;
    this.physics = physics || null;
    this.vfx = vfx || null;
    this._damageSystem = null;
    this._disposed = false;

    // ---- pool ------------------------------------------------------------
    this.pool = new Array(MAX_PROJECTILES);
    for (let i = 0; i < MAX_PROJECTILES; i++) this.pool[i] = new Projectile(i);
    this.free = new Array(MAX_PROJECTILES);
    for (let i = 0; i < MAX_PROJECTILES; i++) this.free[i] = MAX_PROJECTILES - 1 - i;
    this.freeCount = MAX_PROJECTILES;
    /** @type {Projectile[]} dense list; only [0, liveCount) is live */
    this.live = new Array(MAX_PROJECTILES).fill(null);
    this.liveCount = 0;

    // ---- targets ---------------------------------------------------------
    this._explicit = null;
    this._extra = [];
    this._targets = [];
    this._seen = new Set();
    this._targetT = 0;

    // ---- damage plumbing --------------------------------------------------
    this._infoRing = new Array(16);
    for (let i = 0; i < 16; i++) {
      this._infoRing[i] = {
        amount: 0,
        impact: 0,
        type: 'kinetic',
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 1, 0),
        source: null,
        direct: false,
        pulse: false,
        weaponId: '',
        splash: false,
      };
    }
    this._infoIdx = 0;
    this._fxRing = new Array(16);
    for (let i = 0; i < 16; i++) {
      this._fxRing[i] = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), type: 'metal', scale: 1 };
    }
    this._fxIdx = 0;
    this._explOpts = { color: 0xffa040, power: 1, type: 'explosive', shockwave: true, ground: true };
    // scratch for the ground probe under a detonation — see _fxExplosion
    this._gDown = new THREE.Vector3(0, -1, 0);
    this._gHit = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null };
    this._gNormal = new THREE.Vector3(0, 1, 0);
    this._trailPayload = {
      position: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      color: new THREE.Color(),
      width: 0.3,
      life: 0.55,
    };
    this._sfxPayload = { id: '', position: new THREE.Vector3(), size: 1 };
    this._shakePayload = { intensity: 0, duration: 0.3, position: new THREE.Vector3() };
    this._vfxBad = { trail: false, smoke: false, impact: false, explosion: false };

    // ---- render ----------------------------------------------------------
    this.group = new THREE.Group();
    this.group.name = 'projectiles';
    this.group.frustumCulled = false;
    scene?.add?.(this.group);

    this._geo = {};
    this._mat = {};
    this._im = {};
    this._counts = { tracer: 0, shell: 0, missile: 0, plasma: 0, field: 0, beam: 0, flare: 0 };
    this._buildRenderables();

    // ---- lights ----------------------------------------------------------
    this.lights = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0x66ffe0, 0, 34, 2);
      l.castShadow = false;
      l.visible = false;
      this.group.add(l);
      this.lights.push(l);
    }

    this.stats = { live: 0, spawned: 0, hits: 0 };

    // Other subsystems can announce damageable entities without importing us.
    this._offRegister = bus.on('combat:registerEntity', (e) => this.addTarget(e?.entity || e));
  }

  // ================================================================= render

  _buildRenderables() {
    // Unit cylinders whose axis is +Z, so setFromUnitVectors(UNIT_Z, dir) aims them.
    const cylZ = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    cylZ.rotateX(Math.PI / 2);
    const beamZ = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    beamZ.rotateX(Math.PI / 2);
    const sphere = new THREE.IcosahedronGeometry(1, 1);
    const fieldGeo = new THREE.IcosahedronGeometry(1, 2);
    // radiusTop ends up at +Z after rotateX(+90°), so the narrow end is the nose
    const missileGeo = new THREE.CylinderGeometry(0.18, 0.5, 1, 7, 1, false);
    missileGeo.rotateX(Math.PI / 2);
    const shellGeo = new THREE.CylinderGeometry(0.3, 0.55, 1, 8, 1, false);
    shellGeo.rotateX(Math.PI / 2);

    this._geo = { cylZ, beamZ, sphere, fieldGeo, missileGeo, shellGeo };

    const additive = (opacity) =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false, // HDR instance colours pass straight through so bloom catches them
        side: THREE.DoubleSide,
      });

    this._mat.tracer = additive(0.95);
    this._mat.plasma = additive(0.9);
    this._mat.field = additive(0.16);
    this._mat.beam = additive(1.0);
    this._mat.flare = additive(0.85);
    this._mat.body = new THREE.MeshStandardMaterial({
      color: 0x30343c,
      metalness: 1.0,
      roughness: 0.42,
      emissive: new THREE.Color(0x140b05),
    });

    this._im.tracer = this._mkInstanced(cylZ, this._mat.tracer, CAP.tracer, 12, true);
    this._im.beam = this._mkInstanced(beamZ, this._mat.beam, CAP.beam, 13, true);
    this._im.plasma = this._mkInstanced(sphere, this._mat.plasma, CAP.plasma, 11, true);
    this._im.field = this._mkInstanced(fieldGeo, this._mat.field, CAP.field, 10, true);
    this._im.flare = this._mkInstanced(sphere, this._mat.flare, CAP.flare, 12, true);
    // lit bodies: no per-instance tint, they read as real metal against the env map
    this._im.missile = this._mkInstanced(missileGeo, this._mat.body, CAP.missile, 0, false);
    this._im.shell = this._mkInstanced(shellGeo, this._mat.body, CAP.shell, 0, false);
  }

  _mkInstanced(geo, mat, count, renderOrder, tinted) {
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (tinted) {
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    im.frustumCulled = false;
    im.count = 0;
    im.visible = false;
    im.renderOrder = renderOrder;
    im.receiveShadow = false;
    im.castShadow = false;
    this.group.add(im);
    return im;
  }

  // ================================================================= wiring

  /**
   * Route resolved hits into a DamageSystem. Optional — if Game never calls this we fall
   * back to the module-level active DamageSystem, and failing that to a bus event.
   * @param {import('./DamageSystem.js').DamageSystem} ds
   */
  setDamageSystem(ds) {
    this._damageSystem = ds || null;
    return this;
  }

  /** @returns {import('./DamageSystem.js').DamageSystem|null} */
  get damageSystem() {
    return this._damageSystem || getDamageSystem();
  }

  /**
   * The live list of damageable entities projectiles may collide with — BOTH factions;
   * faction filtering happens per hit against the firing owner.
   * @param {Array} entities kept by reference
   */
  setTargetList(entities) {
    this._explicit = Array.isArray(entities) ? entities : null;
    this._refreshTargets();
    return this;
  }

  /** Add one entity to the collision set (the player, a turret, a destructible). */
  addTarget(entity) {
    if (entity && typeof entity === 'object' && this._extra.indexOf(entity) < 0) {
      this._extra.push(entity);
      this._refreshTargets();
    }
    return this;
  }

  removeTarget(entity) {
    const i = this._extra.indexOf(entity);
    if (i >= 0) {
      this._extra.splice(i, 1);
      this._refreshTargets();
    }
    return this;
  }

  /** Merged collision set — WeaponSystem borrows this for melee sphere overlaps. */
  getTargets() {
    return this._targets;
  }

  _refreshTargets() {
    const out = this._targets;
    const seen = this._seen;
    out.length = 0;
    seen.clear();
    const ex = this._explicit;
    if (ex) {
      for (let i = 0; i < ex.length; i++) {
        const e = ex[i];
        if (e && !seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      }
    }
    for (let i = 0; i < this._extra.length; i++) {
      const e = this._extra[i];
      if (e && !seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
    const ds = this.damageSystem;
    const de = ds?.entities;
    if (de) {
      for (let i = 0; i < de.length; i++) {
        const e = de[i];
        if (e && !seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      }
    }
  }

  // ================================================================== spawn

  /**
   * Launch one projectile.
   * @param {object} def projectile description built by Weapons.js — read, never retained
   * @param {THREE.Vector3} origin world muzzle position
   * @param {THREE.Vector3} direction normalized world direction
   * @param {object} owner shooting entity — never hit by its own rounds
   * @param {object|null} targetEntity homing / lead target
   * @returns {Projectile|null} null when the pool is exhausted
   */
  spawn(def, origin, direction, owner, targetEntity = null) {
    if (this._disposed || !def || !origin || !direction) return null;
    if (this.freeCount <= 0) return null;
    const p = this.pool[this.free[--this.freeCount]];

    p.active = true;
    p.kind = def.kind || 'bullet';
    p.pos.copy(origin);
    p.prev.copy(origin);
    p.spawnPos.copy(origin);
    p.dir.copy(direction);
    if (p.dir.lengthSq() < 1e-8) p.dir.set(0, 0, -1);
    p.dir.normalize();
    p.speed = def.speed || 0;
    p.vel.copy(p.dir).multiplyScalar(p.speed);
    p.age = 0;
    p.maxLife = def.life || 3;
    p.damage = def.damage || 0;
    p.impact = def.impact || 0;
    p.type = def.type || 'kinetic';
    p.pulse = !!def.pulse;
    p.radius = def.radius || 0.15;
    p.width = def.width || 0.1;
    p.length = def.length || 3;
    p.gravity = def.gravity || 0;
    p.pierce = def.pierce || 0;
    p.hitCount = 0;
    for (let i = 0; i < MAX_HITS_PER_PROJECTILE; i++) p.hits[i] = null;
    p.owner = owner || null;
    p.faction = owner?.faction || (owner?.isPlayer ? 'player' : '');
    p.target = targetEntity || null;
    p.charged = !!def.charged;
    p.weaponId = def.weaponId || '';
    p.travelled = 0;
    p.maxRange = def.range || 1400;
    p.fade = 1;

    const c = def.color;
    if (Array.isArray(c)) p.color.setRGB(c[0], c[1], c[2]);
    else if (typeof c === 'number') p.color.setHex(c);
    else p.color.setRGB(3, 2, 1);

    const sp = def.splash;
    const sc = def.splashScale || 1;
    p.splashRadius = sp ? (sp.radius || 0) * sc : 0;
    p.splashDamage = sp ? (sp.damage || 0) * sc : 0;
    p.splashImpact = sp ? (sp.impact || 0) * sc : 0;

    const ex = def.explosion;
    p.explosionRadius = ex ? (ex.radius || p.splashRadius) * sc : 0;
    p.explosionPower = ex ? ex.power || 1 : 0;
    p.explosionColor = ex && typeof ex.color === 'number' ? ex.color : 0xffa040;

    const h = def.homing;
    p.homing = !!h;
    if (h) {
      p.hTurn = h.turnRate ?? 2.5;
      p.hTurnBoost = h.turnRateBoost ?? p.hTurn * 1.4;
      p.hFuse = h.fuse ?? 2.5;
      p.hBoostDelay = h.boostDelay ?? 0.4;
      p.hAccel = h.accel ?? 180;
      p.hMaxSpeed = h.maxSpeed ?? 170;
      p.hLead = h.leadStrength ?? 1;
    }

    const tr = def.trail;
    p.trail = false;
    if (tr) {
      const tc = tr.color;
      if (Array.isArray(tc)) p.trailColor.setRGB(tc[0], tc[1], tc[2]);
      else if (typeof tc === 'number') p.trailColor.setHex(tc);
      else p.trailColor.copy(p.color);
      p.trailWidth = tr.width || 0.3;
      this._acquireTrail(p, tr);
    }

    p.fieldDef = def.field || null;
    p.fieldDps = 0;
    p.fieldImpact = 0;
    p.fieldT = 0;

    const fo = def.falloff;
    p.falloffStart = fo ? fo.start : 0;
    p.falloffEnd = fo ? fo.end : 0;
    p.falloffMin = fo ? fo.min : 1;

    p.wantsLight = !!def.light;

    this.live[this.liveCount++] = p;
    this.stats.spawned++;

    // hitscan beams resolve the instant they exist, then linger purely as a visual
    if (p.kind === 'beam') this._resolveBeam(p);

    return p;
  }

  /** Spawn the lingering plasma field left behind by a detonation. */
  _spawnField(src, position) {
    const f = src.fieldDef;
    if (!f || this.freeCount <= 0) return;
    const p = this.pool[this.free[--this.freeCount]];
    p.active = true;
    p.kind = 'field';
    p.pos.copy(position);
    p.prev.copy(position);
    p.vel.set(0, 0, 0);
    p.dir.set(0, 1, 0);
    p.age = 0;
    p.maxLife = f.duration || 3;
    p.radius = f.radius || 6;
    p.width = p.radius;
    p.length = p.radius;
    p.damage = 0;
    p.impact = 0;
    p.type = src.type;
    p.pulse = src.pulse;
    p.owner = src.owner;
    p.faction = src.faction;
    p.target = null;
    p.fieldDef = null;
    p.fieldDps = f.dps || 0;
    p.fieldImpact = f.impactPerSec || 0;
    p.fieldTick = f.tick || 0.25;
    p.fieldT = 0;
    p.splashRadius = 0;
    p.splashDamage = 0;
    p.splashImpact = 0;
    p.explosionRadius = 0;
    p.homing = false;
    p.trail = false;
    p.pierce = 0;
    p.hitCount = 0;
    p.travelled = 0;
    p.maxRange = 1e9;
    p.wantsLight = true;
    p.fade = 1;
    const c = f.color;
    if (Array.isArray(c)) p.color.setRGB(c[0], c[1], c[2]);
    else p.color.copy(src.color);
    this.live[this.liveCount++] = p;
  }

  // ================================================================= update

  /**
   * @param {number} dt seconds
   * @param {number} elapsed total elapsed seconds
   */
  update(dt, elapsed) {
    if (this._disposed || dt <= 0) return;

    this._targetT -= dt;
    if (this._targetT <= 0) {
      this._targetT = 0.25;
      this._refreshTargets();
    }

    const counts = this._counts;
    counts.tracer = 0;
    counts.shell = 0;
    counts.missile = 0;
    counts.plasma = 0;
    counts.field = 0;
    counts.beam = 0;
    counts.flare = 0;
    this._lightUsed = 0;

    for (let i = this.liveCount - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;

      let dead;
      if (p.kind === 'beam') {
        dead = p.age >= p.maxLife;
        p.fade = 1 - clamp(p.age / p.maxLife, 0, 1);
      } else if (p.kind === 'field') {
        dead = this._stepField(p, dt);
      } else {
        dead = this._stepMoving(p, dt);
      }

      if (dead) {
        this._retire(i);
        continue;
      }
      this._draw(p, counts);
    }

    for (let i = this._lightUsed; i < MAX_LIGHTS; i++) {
      const l = this.lights[i];
      if (l.visible) {
        l.visible = false;
        l.intensity = 0;
      }
    }

    this._flush(counts);
    this.stats.live = this.liveCount;
  }

  /**
   * Integrate + collide one moving projectile.
   * @returns {boolean} true when it should be retired
   */
  _stepMoving(p, dt) {
    if (p.homing) {
      if (this._guide(p, dt)) return true; // proximity fuse popped
    } else if (p.gravity > 0) {
      p.vel.y -= p.gravity * dt;
      const sp = p.vel.length();
      if (sp > 1e-4) p.dir.copy(p.vel).multiplyScalar(1 / sp);
    }

    p.prev.copy(p.pos);
    _to.copy(p.pos).addScaledVector(p.vel, dt);
    const segLen = p.prev.distanceTo(_to);
    p.travelled += segLen;

    if (segLen > 1e-6 && this._sweep(p, p.prev, _to, segLen) === 2) return true;
    p.pos.copy(_to);

    if (p.trailHandle) p.trailHandle.setPosition(p.pos);

    if (p.age >= p.maxLife || p.travelled >= p.maxRange) {
      // a seeker that lost the plot self-destructs rather than vanishing
      if (p.explosionRadius > 0 || p.splashRadius > 0) {
        _gP.copy(p.pos);
        _gN.copy(p.dir).multiplyScalar(-1);
        this._detonate(p, _gP, _gN, null);
      }
      return true;
    }
    return false;
  }

  /**
   * Proportional-navigation homing: lead the target, then rotate the velocity toward that
   * bearing under a hard per-second turn limit. Seekers arc, they do not snap.
   * @returns {boolean} true if the proximity fuse detonated it
   */
  _guide(p, dt) {
    if (p.age < p.hBoostDelay) {
      // unguided launch phase — coasts on the launch vector (VLS pops it upward first)
      p.vel.y -= 6 * dt;
      const sp = p.vel.length();
      if (sp > 1e-4) p.dir.copy(p.vel).multiplyScalar(1 / sp);
      p.speed = sp;
      return false;
    }

    p.speed = Math.min(p.hMaxSpeed, p.speed + p.hAccel * dt); // motor burn

    const t = p.target;
    if (!t || t.alive === false) {
      // lost the lock: nose over gently and fly on until the self-destruct timer
      p.target = null;
      p.dir.y -= 0.35 * dt;
      p.dir.normalize();
      p.vel.copy(p.dir).multiplyScalar(p.speed);
      return false;
    }

    if (t.getAimPoint) t.getAimPoint(_desired);
    else _desired.copy(t.collider?.center || t.root?.position || p.pos);

    // cut the corner instead of tail-chasing
    if (p.hLead > 0 && t.velocity) {
      interceptPoint(p.pos, _desired, t.velocity, p.speed, _lead);
      _desired.lerp(_lead, p.hLead);
    }

    const dist = p.pos.distanceTo(_desired);
    if (dist <= p.hFuse + p.radius) {
      _gP.copy(_desired);
      _gN.subVectors(p.pos, _desired);
      if (_gN.lengthSq() < 1e-8) _gN.copy(WORLD_UP);
      _gN.normalize();
      this._detonate(p, _gP, _gN, t);
      return true;
    }

    _desired.sub(p.pos);
    const dl = _desired.length();
    if (dl > 1e-5) {
      _desired.multiplyScalar(1 / dl);
      // fresh off the rail seekers are more agile so they can commit to the arc
      const agile = p.age < p.hBoostDelay + 0.7;
      const maxTurn = (agile ? p.hTurnBoost : p.hTurn) * dt;
      const dot = clamp(p.dir.dot(_desired), -1, 1);
      const ang = Math.acos(dot);
      if (ang > 1e-4) {
        if (ang <= maxTurn) {
          p.dir.copy(_desired);
        } else {
          _axis.crossVectors(p.dir, _desired);
          if (_axis.lengthSq() < 1e-10) _axis.copy(WORLD_UP);
          _axis.normalize();
          _q.setFromAxisAngle(_axis, maxTurn);
          p.dir.applyQuaternion(_q).normalize();
        }
      }
    }
    p.vel.copy(p.dir).multiplyScalar(p.speed);
    return false;
  }

  /** Lingering damage volume. @returns {boolean} retire */
  _stepField(p, dt) {
    p.fade = 1 - clamp(p.age / p.maxLife, 0, 1);
    p.fieldT -= dt;
    if (p.fieldT <= 0) {
      p.fieldT += p.fieldTick;
      const list = this._targets;
      const r2 = p.radius * p.radius;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!this._hostile(p, e)) continue;
        const c = e.collider?.center || e.root?.position;
        if (!c || c.distanceToSquared(p.pos) > r2) continue;
        _fldA.copy(c);
        _fldB.subVectors(c, p.pos);
        if (_fldB.lengthSq() < 1e-8) _fldB.copy(WORLD_UP);
        _fldB.normalize();
        this._damage(e, p.fieldDps * p.fieldTick, p.fieldImpact * p.fieldTick, p.type, _fldA, _fldB, p.owner, false, p, false);
      }
    }
    return p.age >= p.maxLife;
  }

  // ============================================================== collision

  /**
   * Swept-segment collision for one frame of travel: world raycast plus segment-vs-capsule
   * against every hostile entity, resolving whichever hit is nearest the muzzle.
   * @returns {number} 0 = clean, 1 = pierced through, 2 = consumed
   */
  _sweep(p, from, to, segLen) {
    _dir.subVectors(to, from).multiplyScalar(1 / segLen);

    // --- static world -------------------------------------------------------
    let worldDist = Infinity;
    let worldHit = null;
    const phys = this.physics;
    if (phys && typeof phys.raycast === 'function') {
      const h = phys.raycast(from, _dir, segLen + p.radius);
      if (h && h.hit !== false) {
        worldDist = typeof h.distance === 'number' ? h.distance : h.point ? from.distanceTo(h.point) : Infinity;
        if (isFinite(worldDist)) worldHit = h;
      }
    }

    // --- entity capsules ----------------------------------------------------
    let entDist = Infinity;
    let entHit = null;
    const list = this._targets;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!this._hostile(p, e) || p.hasHit(e)) continue;
      const rad = this._capsuleOf(e, _capA, _capB);
      if (rad <= 0) continue;
      const rr = rad + p.radius;
      closestSegSeg(from, to, _capA, _capB, _closest);
      if (_closest.d2 > rr * rr) continue;
      // step back along the sweep to approximate the surface entry point
      const back = Math.sqrt(Math.max(0, rr * rr - _closest.d2));
      const d = Math.max(0, _closest.s * segLen - back);
      if (d < entDist) {
        entDist = d;
        entHit = e;
      }
    }

    // --- resolve the earliest ------------------------------------------------
    if (entHit && entDist <= worldDist) {
      _hitP.copy(from).addScaledVector(_dir, entDist);
      const c = entHit.collider?.center || entHit.root?.position;
      if (c) _hitN.subVectors(_hitP, c);
      else _hitN.copy(_dir).multiplyScalar(-1);
      if (_hitN.lengthSq() < 1e-8) _hitN.copy(_dir).multiplyScalar(-1);
      _hitN.normalize();
      return this._onEntityHit(p, entHit, _hitP, _hitN);
    }
    if (worldHit) {
      if (worldHit.point) _hitP.copy(worldHit.point);
      else _hitP.copy(from).addScaledVector(_dir, worldDist);
      if (worldHit.normal) _hitN.copy(worldHit.normal);
      else _hitN.copy(_dir).multiplyScalar(-1);
      this._onWorldHit(p, _hitP, _hitN);
      return 2;
    }
    return 0;
  }

  /** True if `e` is a legitimate victim for `p`. */
  _hostile(p, e) {
    if (!e || e === p.owner || e.alive === false || !e.stats) return false;
    const f = e.faction;
    if (f && p.faction && f === p.faction) return false;
    return true;
  }

  /** Fill a world-space capsule for an entity. @returns {number} radius, 0 if unusable */
  _capsuleOf(e, a, b) {
    const col = e.collider;
    if (col && col.radius > 0) {
      const c = col.center || e.root?.position;
      if (!c) return 0;
      const half = Math.max(0, (col.height || col.radius * 2) * 0.5 - col.radius);
      a.set(c.x, c.y + half, c.z);
      b.set(c.x, c.y - half, c.z);
      return col.radius;
    }
    const r = e.root?.position;
    if (!r) return 0;
    a.set(r.x, r.y + 4.5, r.z);
    b.set(r.x, r.y + 1.5, r.z);
    return 3.0;
  }

  _onEntityHit(p, entity, point, normal) {
    this.stats.hits++;
    if (p.explosionRadius > 0 || p.splashRadius > 0) {
      this._detonate(p, point, normal, entity);
      return 2;
    }
    let dmg = p.damage;
    let imp = p.impact;
    if (p.falloffEnd > p.falloffStart) {
      // shotgun pellets go from decisive to insulting across their falloff band
      const t = clamp((p.travelled - p.falloffStart) / (p.falloffEnd - p.falloffStart), 0, 1);
      const k = 1 - t * (1 - p.falloffMin);
      dmg *= k;
      imp *= k;
    }
    this._damage(entity, dmg, imp, p.type, point, normal, p.owner, false, p, false);
    this._fxImpact(point, normal, p.type === 'energy' ? 'energy' : 'metal', p.charged ? 1.8 : 1, 'hit_metal');

    p.noteHit(entity);
    return p.pierce > 0 && p.hitCount <= p.pierce ? 1 : 2;
  }

  _onWorldHit(p, point, normal) {
    if (p.explosionRadius > 0 || p.splashRadius > 0) {
      this._detonate(p, point, normal, null);
      return;
    }
    this._fxImpact(point, normal, p.type === 'energy' ? 'energy' : 'concrete', p.charged ? 1.8 : 1, 'ricochet');
  }

  /** Explosive payload: full damage to whatever was struck, then a falloff sphere query. */
  _detonate(p, point, normal, directTarget) {
    _detP.copy(point);
    _detN.copy(normal);
    if (directTarget) {
      this._damage(directTarget, p.damage, p.impact, p.type, _detP, _detN, p.owner, false, p, false);
      p.noteHit(directTarget);
    }
    if (p.splashRadius > 0) this._splash(p, _detP, directTarget);
    if (p.explosionRadius > 0) {
      this._fxExplosion(_detP, p.explosionRadius, p.explosionPower, p.explosionColor);
      const sh = this._shakePayload;
      sh.intensity = clamp(p.explosionPower * 0.55, 0.08, 1.3);
      sh.duration = 0.35;
      sh.position.copy(_detP);
      bus.emit(EV.SHAKE, sh);
    } else {
      this._fxImpact(_detP, _detN, p.type === 'energy' ? 'energy' : 'concrete', 1.4, 'explosion');
    }
    if (p.fieldDef) this._spawnField(p, _detP);
  }

  _splash(p, center, exclude) {
    const list = this._targets;
    const r = p.splashRadius;
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      // splash reaches everyone in range except the shooter and the direct victim
      if (!e || e === exclude || e === p.owner || e.alive === false || !e.stats) continue;
      const c = e.collider?.center || e.root?.position;
      if (!c) continue;
      const d2 = c.distanceToSquared(center);
      if (d2 > r2) continue;
      const k = 1 - clamp(Math.sqrt(d2) / r, 0, 1);
      // the edge of a blast should feel like a graze, the centre like a hammer
      const falloff = k * k * 0.65 + k * 0.35;
      _spA.copy(c);
      _spB.subVectors(c, center);
      if (_spB.lengthSq() < 1e-8) _spB.copy(WORLD_UP);
      _spB.normalize();
      this._damage(e, p.splashDamage * falloff, p.splashImpact * falloff, 'explosive', _spA, _spB, p.owner, false, p, true);
    }
  }

  /** Instant hitscan beam — resolves the moment it spawns, then lingers as a mesh. */
  _resolveBeam(p) {
    const range = p.maxRange || 900;
    _bFrom.copy(p.pos);
    _bDir.copy(p.dir);
    _bTo.copy(_bFrom).addScaledVector(_bDir, range);

    let bestDist = range;
    let entHit = null;
    let worldHit = null;

    const phys = this.physics;
    if (phys && typeof phys.raycast === 'function') {
      const h = phys.raycast(_bFrom, _bDir, range);
      if (h && h.hit !== false) {
        const d = typeof h.distance === 'number' ? h.distance : h.point ? _bFrom.distanceTo(h.point) : Infinity;
        if (d < bestDist) {
          bestDist = d;
          worldHit = h;
        }
      }
    }

    const list = this._targets;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!this._hostile(p, e)) continue;
      const rad = this._capsuleOf(e, _capA, _capB);
      if (rad <= 0) continue;
      const rr = rad + p.radius;
      closestSegSeg(_bFrom, _bTo, _capA, _capB, _closest);
      if (_closest.d2 > rr * rr) continue;
      const back = Math.sqrt(Math.max(0, rr * rr - _closest.d2));
      const d = Math.max(0, _closest.s * range - back);
      if (d < bestDist) {
        bestDist = d;
        entHit = e;
        worldHit = null;
      }
    }

    p.beamEnd.copy(_bFrom).addScaledVector(_bDir, bestDist);
    p.length = bestDist;

    if (entHit) {
      _bP.copy(p.beamEnd);
      const c = entHit.collider?.center || entHit.root?.position;
      if (c) _bN.subVectors(_bP, c);
      else _bN.copy(_bDir).multiplyScalar(-1);
      if (_bN.lengthSq() < 1e-8) _bN.copy(_bDir).multiplyScalar(-1);
      _bN.normalize();
      this._damage(entHit, p.damage, p.impact, p.type, _bP, _bN, p.owner, false, p, false);
      this._fxImpact(_bP, _bN, 'energy', p.charged ? 2.2 : 1.1, 'hit_energy');
      this.stats.hits++;
    } else if (worldHit) {
      if (worldHit.point) _bP.copy(worldHit.point);
      else _bP.copy(p.beamEnd);
      if (worldHit.normal) _bN.copy(worldHit.normal);
      else _bN.copy(_bDir).multiplyScalar(-1);
      this._fxImpact(_bP, _bN, 'energy', p.charged ? 1.6 : 0.9, 'hit_energy');
    }
  }

  // ================================================================= damage

  /**
   * Build a DamageInfo and route it. Prefers the explicitly wired DamageSystem, falls back
   * to the module-level active one, and finally to a bus event so nothing is silently lost.
   */
  _damage(entity, amount, impact, type, point, normal, owner, direct, p, splash) {
    if (!(amount > 0) && !(impact > 0)) return;
    const info = this._infoRing[this._infoIdx++ & 15];
    info.amount = amount;
    info.impact = impact;
    info.type = type;
    info.point.copy(point);
    info.normal.copy(normal);
    info.source = owner || null;
    info.direct = !!direct;
    info.pulse = !!p?.pulse;
    info.weaponId = p?.weaponId || '';
    info.splash = !!splash;

    const ds = this.damageSystem;
    if (ds) {
      ds.applyDamage(entity, info);
      return;
    }
    // nothing wired — still tell the entity and the HUD
    entity.onDamage?.(info);
    if (entity.stats) entity.stats.ap = Math.max(0, entity.stats.ap - amount);
    bus.emit(EV.DAMAGE_DEALT, {
      entity,
      amount,
      direct: info.direct,
      point: info.point,
      isPlayer: !!entity.isPlayer,
      type,
      impact,
      source: info.source,
    });
  }

  // ==================================================================== vfx

  _fxImpact(point, normal, type, scale, sfxId) {
    const pay = this._fxRing[this._fxIdx++ & 15];
    pay.point.copy(point);
    pay.normal.copy(normal);
    pay.type = type;
    pay.scale = scale;
    bus.emit(EV.IMPACT, pay);
    if (sfxId) {
      const s = this._sfxPayload;
      s.id = sfxId;
      s.position.copy(pay.point);
      s.size = scale;
      bus.emit(EV.SFX, s);
    }
    const v = this.vfx;
    if (v && v.impact && !this._vfxBad.impact) {
      try {
        v.impact(pay.point, pay.normal, type, scale);
      } catch (err) {
        this._vfxBad.impact = true;
      }
    }
  }

  _fxExplosion(point, radius, power, color) {
    const o = this._explOpts;
    o.color = color;
    o.power = power;
    o.type = 'explosive';
    o.shockwave = radius > 6;

    // IS THERE ACTUALLY GROUND UNDER THIS BLAST? `VFX.explosion` defaults its
    // ground layer ON, and nothing ever told it otherwise, so every airburst —
    // a missile intercepted at 40 m, a mech killed mid-boost — laid a
    // ground-hugging dust ring and a scorch DECAL in open air. Probe down half a
    // blast radius and let the answer decide.
    //
    // Physics.raycast returns a SHARED mutable scratch object that the next cast
    // invalidates, so we pass our own `out` and read it immediately. It also
    // reports a phantom hit when maxDist is not a positive finite number, hence
    // the guard on the range rather than on the result.
    o.ground = false;
    o.groundNormal = null;
    const reach = radius * 0.6;
    if (this.physics?.raycast && reach > 0 && Number.isFinite(reach)) {
      const g = this._gDown;
      const hit = this.physics.raycast(point, g, reach, this._gHit);
      if (hit && hit.hit) {
        o.ground = true;
        o.groundNormal = this._gNormal.copy(hit.normal);
        if (this._gNormal.lengthSq() < 1e-6) this._gNormal.set(0, 1, 0);
      }
    }
    const pay = this._fxRing[this._fxIdx++ & 15];
    pay.point.copy(point);
    pay.normal.copy(WORLD_UP);
    pay.type = 'explosion';
    pay.scale = radius;
    bus.emit(EV.IMPACT, pay);
    const s = this._sfxPayload;
    s.id = 'explosion';
    s.position.copy(pay.point);
    s.size = radius;
    bus.emit(EV.SFX, s);
    const v = this.vfx;
    if (v && v.explosion && !this._vfxBad.explosion) {
      try {
        v.explosion(pay.point, radius, o);
      } catch (err) {
        this._vfxBad.explosion = true;
      }
    }
  }

  _fxTrail(p) {
    const pay = this._trailPayload;
    pay.position.copy(p.pos);
    pay.direction.copy(p.dir);
    pay.color.copy(p.trailColor);
    pay.width = p.trailWidth;
    pay.life = 0.55;
    bus.emit('vfx:trail', pay);
    const v = this.vfx;
    if (!v) return;
    if (v.trail && !this._vfxBad.trail) {
      try {
        v.trail(pay.position, pay.direction, pay.color, pay.width);
      } catch (err) {
        this._vfxBad.trail = true;
      }
    }
    if (v.smoke && !this._vfxBad.smoke) {
      try {
        v.smoke(pay.position, pay.width);
      } catch (err) {
        this._vfxBad.smoke = true;
      }
    }
  }

  // ================================================================== draw

  /** Write one projectile's instance data for this frame. */
  _draw(p, counts) {
    const kind = p.kind;

    if (kind === 'bullet' || kind === 'pellet') {
      if (counts.tracer < CAP.tracer) {
        // the tracer trails BEHIND the head and stretches with speed, so a fast round
        // reads as a streak rather than a dot that teleports
        const len = Math.max(p.length, p.speed * 0.012);
        _q.setFromUnitVectors(UNIT_Z, p.dir);
        _mid.copy(p.pos).addScaledVector(p.dir, -len * 0.5);
        _scl.set(p.width, p.width, len);
        _m.compose(_mid, _q, _scl);
        const i = counts.tracer++;
        this._im.tracer.setMatrixAt(i, _m);
        this._setColor(this._im.tracer, i, p.color, 1);
      }
      return;
    }

    if (kind === 'shell' || kind === 'missile') {
      const isShell = kind === 'shell';
      const im = isShell ? this._im.shell : this._im.missile;
      const cap = isShell ? CAP.shell : CAP.missile;
      const key = isShell ? 'shell' : 'missile';
      if (counts[key] < cap) {
        _q.setFromUnitVectors(UNIT_Z, p.dir);
        _scl.set(p.width, p.width, p.length);
        _m.compose(p.pos, _q, _scl);
        im.setMatrixAt(counts[key]++, _m);
      }
      const burning = isShell || p.age >= p.hBoostDelay;
      if (burning && counts.flare < CAP.flare) {
        const flick = 0.75 + 0.25 * Math.sin(p.age * 90 + p.index);
        const s = p.width * (isShell ? 1.5 : 2.1) * flick;
        _q.setFromUnitVectors(UNIT_Z, p.dir);
        _mid.copy(p.pos).addScaledVector(p.dir, -p.length * 0.55);
        _scl.set(s, s, s * 2.4);
        _m.compose(_mid, _q, _scl);
        const i = counts.flare++;
        this._im.flare.setMatrixAt(i, _m);
        this._setColor(this._im.flare, i, p.trail ? p.trailColor : p.color, 1.6);
      }
      return;
    }

    if (kind === 'plasma') {
      if (counts.plasma < CAP.plasma) {
        const s = p.radius * (1 + 0.14 * Math.sin(p.age * 22 + p.index));
        _q.identity();
        _scl.set(s, s, s);
        _m.compose(p.pos, _q, _scl);
        const i = counts.plasma++;
        this._im.plasma.setMatrixAt(i, _m);
        this._setColor(this._im.plasma, i, p.color, 1);
      }
      if (p.wantsLight) this._assignLight(p.pos, p.color, 30, 36, 0);
      return;
    }

    if (kind === 'field') {
      if (counts.field < CAP.field) {
        const s = p.radius * (1 + 0.05 * Math.sin(p.age * 6 + p.index));
        _q.identity();
        _scl.set(s, s * 0.7, s);
        _m.compose(p.pos, _q, _scl);
        const i = counts.field++;
        this._im.field.setMatrixAt(i, _m);
        this._setColor(this._im.field, i, p.color, p.fade * 1.4);
      }
      if (p.wantsLight) this._assignLight(p.pos, p.color, 55 * p.fade, p.radius * 4, 1.5);
      return;
    }

    if (kind === 'beam') {
      if (counts.beam < CAP.beam) {
        const len = Math.max(0.01, p.length);
        const w = p.width * (0.35 + 0.65 * p.fade);
        _q.setFromUnitVectors(UNIT_Z, p.dir);
        _mid.copy(p.pos).addScaledVector(p.dir, len * 0.5);
        _scl.set(w, w, len);
        _m.compose(_mid, _q, _scl);
        let i = counts.beam++;
        this._im.beam.setMatrixAt(i, _m);
        this._setColor(this._im.beam, i, p.color, 1);
        if (counts.beam < CAP.beam) {
          // a wide, dim sheath around the core is what makes bloom read as a beam
          _scl.set(w * 3.2, w * 3.2, len);
          _m.compose(_mid, _q, _scl);
          i = counts.beam++;
          this._im.beam.setMatrixAt(i, _m);
          this._setColor(this._im.beam, i, p.color, 0.22 * p.fade);
        }
      }
    }
  }

  _assignLight(pos, color, intensity, distance, yOffset) {
    if (this._lightUsed >= MAX_LIGHTS) return;
    const l = this.lights[this._lightUsed++];
    l.visible = true;
    l.position.copy(pos);
    l.position.y += yOffset;
    _col.copy(color);
    const m = Math.max(_col.r, _col.g, _col.b) || 1;
    l.color.setRGB(_col.r / m, _col.g / m, _col.b / m);
    l.intensity = intensity;
    l.distance = distance;
  }

  _setColor(im, i, color, mul) {
    const arr = im.instanceColor.array;
    const o = i * 3;
    arr[o] = color.r * mul;
    arr[o + 1] = color.g * mul;
    arr[o + 2] = color.b * mul;
  }

  _flush(counts) {
    this._push(this._im.tracer, counts.tracer);
    this._push(this._im.shell, counts.shell);
    this._push(this._im.missile, counts.missile);
    this._push(this._im.plasma, counts.plasma);
    this._push(this._im.field, counts.field);
    this._push(this._im.beam, counts.beam);
    this._push(this._im.flare, counts.flare);
  }

  _push(im, n) {
    im.count = n;
    im.visible = n > 0;
    if (n > 0) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  // ================================================================= pooling

  _retire(liveIndex) {
    const p = this.live[liveIndex];
    p.reset();
    const last = this.liveCount - 1;
    this.live[liveIndex] = this.live[last];
    this.live[last] = p;
    this.liveCount--;
    this.free[this.freeCount++] = p.index;
  }

  /** Kill everything in flight (mission restart). */
  reset() {
    this.liveCount = 0;
    this.freeCount = MAX_PROJECTILES;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.free[i] = MAX_PROJECTILES - 1 - i;
      this.live[i] = null;
      this.pool[i].reset();
    }
    for (const l of this.lights) {
      l.visible = false;
      l.intensity = 0;
    }
    const c = this._counts;
    c.tracer = c.shell = c.missile = c.plasma = c.field = c.beam = c.flare = 0;
    this._lightUsed = 0;
    this._flush(c);
  }

  dispose() {
    this._disposed = true;
    this._offRegister?.();
    this.reset();
    this.group.parent?.remove(this.group);
    for (const k in this._im) this._im[k]?.dispose?.();
    for (const k in this._geo) this._geo[k]?.dispose?.();
    for (const k in this._mat) this._mat[k]?.dispose?.();
    for (const l of this.lights) l.dispose?.();
    this.lights.length = 0;
    this.live.length = 0;
    this.pool.length = 0;
    this._targets.length = 0;
    this._seen.clear();
    this._explicit = null;
    this._extra.length = 0;
  }
}

export default ProjectileManager;
