import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import * as M from '../core/MathUtils.js';
import { Brain, Squad } from './Brain.js';
import { getArchetype, tierScale } from './Archetypes.js';
import { EncounterDirector } from './Encounters.js';

/**
 * EnemyManager — owns every hostile entity, the AI frame budget, the shared
 * telegraph renderer and the death choreography.
 *
 * `.list` is a LIVE array. TargetingSystem and ProjectileManager hold a reference
 * to it, so it is only ever mutated in place (push/splice) — never reassigned.
 *
 * Every cross-module call in this file is optional-chained: sibling systems boot
 * in parallel and any of them may be absent when the AI first ticks.
 */

const UP = new THREE.Vector3(0, 1, 0);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _local = new THREE.Vector3();
const _q = new THREE.Quaternion();

const THREAT_MAX = 48;
const THREAT_STRIDE = 8; // ox oy oz dx dy dz speed stamp
const THREAT_LIFE = 1.6;

// ---------------------------------------------------------------------------
// Telegraphs — pooled, self-expiring readable warning geometry
// ---------------------------------------------------------------------------

/**
 * Shared telegraph renderer. Every heavy attack in this game draws here first:
 * laser sights, ballistic arcs, impact rings, beam paths. Entries auto-expire if
 * an agent stops refreshing them, so a state that dies mid-attack can't leak.
 */
export class Telegraphs {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;

    this._lineGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this._ringGeo = new THREE.RingGeometry(0.86, 1, 40);
    this._ringGeo.rotateX(-Math.PI / 2);

    this._linePool = [];
    this._ringPool = [];
    this._entries = new Map(); // key -> { mesh, kind, stamp }
    this._transient = [];
    this._now = 0;
    this._maxLines = 64;
    this._maxRings = 48;
    this._owned = []; // scratch for releaseOwner, reused
  }

  _makeMesh(kind) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(kind === 'line' ? this._lineGeo : this._ringGeo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 12;
    mesh.visible = false;
    mesh.matrixAutoUpdate = true;
    this.scene?.add(mesh);
    return mesh;
  }

  _take(kind) {
    const pool = kind === 'line' ? this._linePool : this._ringPool;
    if (pool.length) return pool.pop();
    const cap = kind === 'line' ? this._maxLines : this._maxRings;
    const live = (kind === 'line' ? this._countKind('line') : this._countKind('ring')) + this._transient.length;
    if (live >= cap) return null; // hard cap: telegraphs never blow the budget
    return this._makeMesh(kind);
  }

  _countKind(kind) {
    let n = 0;
    for (const e of this._entries.values()) if (e.kind === kind) n++;
    return n;
  }

  _give(mesh, kind) {
    if (!mesh) return;
    mesh.visible = false;
    (kind === 'line' ? this._linePool : this._ringPool).push(mesh);
  }

  _entry(key, kind) {
    let e = this._entries.get(key);
    if (!e) {
      const mesh = this._take(kind);
      if (!mesh) return null;
      e = { mesh, kind, stamp: this._now };
      this._entries.set(key, e);
    }
    e.stamp = this._now;
    return e;
  }

  /** A glowing sight/beam line from `a` to `b`. Refresh it every frame while active. */
  line(key, a, b, color, width, alpha) {
    if (!this.enabled) return;
    const e = this._entry(key, 'line');
    if (!e) return;
    const mesh = e.mesh;
    _v.subVectors(b, a);
    const len = _v.length();
    if (len < 1e-3) return;
    _v.multiplyScalar(1 / len);
    mesh.position.copy(a).addScaledVector(_v, len * 0.5);
    _q.setFromUnitVectors(UP, _v);
    mesh.quaternion.copy(_q);
    mesh.scale.set(width ?? 0.05, len, width ?? 0.05);
    mesh.material.color.setHex(color ?? 0xff3040);
    mesh.material.opacity = alpha ?? 0.85;
    mesh.visible = true;
  }

  /** A flat ground ring marking an impact zone. `t` 0..1 drives urgency. */
  ring(key, pos, radius, color, t) {
    if (!this.enabled) return;
    const e = this._entry(key, 'ring');
    if (!e) return;
    const mesh = e.mesh;
    mesh.position.set(pos.x, pos.y + 0.35, pos.z);
    const k = M.clamp(t ?? 0, 0, 1);
    mesh.scale.setScalar(radius * (1.35 - k * 0.35));
    mesh.material.color.setHex(color ?? 0xff6a20);
    mesh.material.opacity = 0.25 + k * 0.6;
    mesh.visible = true;
  }

  /** A dotted ballistic arc from launcher to predicted impact. */
  arc(key, from, to, height, color) {
    if (!this.enabled) return;
    _v2.subVectors(to, from);
    const flat = Math.sqrt(_v2.x * _v2.x + _v2.z * _v2.z);
    const apex = flat * (height ?? 0.5);
    const SEG = 8;
    for (let i = 0; i < SEG; i++) {
      const t0 = i / SEG;
      const t1 = (i + 0.62) / SEG; // gaps between segments read as a dotted line
      this._arcPoint(from, to, apex, t0, _v);
      this._arcPoint(from, to, apex, t1, _v3);
      this.line(key + i * 0.001, _v, _v3, color ?? 0xffa24d, 0.16, 0.5);
    }
  }

  _arcPoint(from, to, apex, t, out) {
    out.lerpVectors(from, to, t);
    out.y += Math.sin(t * Math.PI) * apex;
    return out;
  }

  /** One-shot expanding ring (impact shockwaves, nova pulses). */
  burst(pos, radius, life, color) {
    if (!this.enabled) return;
    const mesh = this._take('ring');
    if (!mesh) return;
    mesh.position.set(pos.x, pos.y + 0.4, pos.z);
    mesh.material.color.setHex(color ?? 0xffc070);
    mesh.visible = true;
    this._transient.push({ mesh, t: 0, life: life ?? 0.5, r: radius ?? 10 });
  }

  /** Drop every telegraph owned by an agent (keys are `agent.id * 8 + slot`). */
  releaseOwner(ownerId) {
    if (ownerId == null) return;
    const doomed = this._owned;
    doomed.length = 0;
    for (const key of this._entries.keys()) {
      if (Math.floor(key / 8) === ownerId) doomed.push(key);
    }
    for (let i = 0; i < doomed.length; i++) {
      const e = this._entries.get(doomed[i]);
      this._entries.delete(doomed[i]);
      this._give(e?.mesh, e?.kind);
    }
    doomed.length = 0;
  }

  update(dt, elapsed) {
    this._now = elapsed;
    // recycle anything nobody refreshed — the safety net for interrupted states
    for (const [key, e] of this._entries) {
      if (elapsed - e.stamp > 0.16) {
        this._entries.delete(key);
        this._give(e.mesh, e.kind);
      }
    }
    for (let i = this._transient.length - 1; i >= 0; i--) {
      const tr = this._transient[i];
      tr.t += dt;
      const k = tr.t / tr.life;
      if (k >= 1) {
        this._give(tr.mesh, 'ring');
        this._transient.splice(i, 1);
        continue;
      }
      tr.mesh.scale.setScalar(tr.r * (0.15 + k * 1.05));
      tr.mesh.material.opacity = (1 - k) * 0.8;
    }
  }

  clear() {
    for (const [, e] of this._entries) this._give(e.mesh, e.kind);
    this._entries.clear();
    for (let i = 0; i < this._transient.length; i++) this._give(this._transient[i].mesh, 'ring');
    this._transient.length = 0;
  }

  dispose() {
    this.clear();
    const kill = (m) => {
      this.scene?.remove(m);
      m.material?.dispose?.();
    };
    for (let i = 0; i < this._linePool.length; i++) kill(this._linePool[i]);
    for (let i = 0; i < this._ringPool.length; i++) kill(this._ringPool[i]);
    this._linePool.length = 0;
    this._ringPool.length = 0;
    this._lineGeo.dispose();
    this._ringGeo.dispose();
  }
}

// ---------------------------------------------------------------------------
// Stats factory
// ---------------------------------------------------------------------------

/** Build a CONTRACT-shaped Stats object (with a working `reset()`) from a stat block. */
function makeStats(block) {
  return {
    ap: block.apMax,
    apMax: block.apMax,
    acs: 0,
    acsMax: block.acsMax,
    staggered: false,
    staggerTimer: 0,
    en: block.enMax || 0,
    enMax: block.enMax || 0,
    heat: 0,
    defKinetic: block.defKinetic,
    defEnergy: block.defEnergy,
    // AI-side tuning the damage system may ignore safely
    acsDecay: block.acsDecay,
    staggerTime: block.staggerTime,
    reset() {
      this.ap = this.apMax;
      this.acs = 0;
      this.staggered = false;
      this.staggerTimer = 0;
      this.en = this.enMax;
      this.heat = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// EnemyManager
// ---------------------------------------------------------------------------

export class EnemyManager {
  constructor(scene, mechFactory, physics, level, projectiles, vfx) {
    this.scene = scene;
    this.mechFactory = mechFactory;
    this.physics = physics;
    this.level = level;
    this.projectiles = projectiles;
    this.vfx = vfx;

    /** LIVE array — mutated in place, never reassigned. */
    this.list = [];
    this._corpses = [];
    this.player = null;
    this.playerSpeed = 0;
    this.lockedTarget = null;
    this.waveIndex = 0;
    this.enabled = true;

    this.telegraphs = new Telegraphs(scene);
    this.squads = [];
    this._squadSeq = 0;
    this._idSeq = 1;
    this._rngSeq = 0x1a2b3c;

    // ---- frame budget ----
    this.perceptionBudget = 5; // LOS raycasts granted per frame
    this.rayBudget = 8; // total generic raycasts (cover probes, avoidance)
    this._rays = 0;
    this._losCursor = 0;

    // ---- incoming-fire threat ring buffer (drives AC/flyer dodges) ----
    this._threats = new Float32Array(THREAT_MAX * THREAT_STRIDE);
    this._threatHead = 0;
    this._threatCount = 0;
    this._elapsed = 0;

    // ---- placeholder mech assets (only used if MechFactory isn't ready) ----
    this._phGeo = [];
    this._phMat = [];
    this._phCache = new Map();

    this._shieldGeo = null;
    this._shieldMats = [];

    this.encounter = new EncounterDirector(this);

    // ---- bus wiring ----
    this._offs = [];
    this._offs.push(bus.on(EV.WEAPON_FIRED, (p) => this._onWeaponFired(p)));
    this._offs.push(bus.on(EV.LOCK_STATE, (p) => {
      this.lockedTarget = p?.target ?? p?.entity ?? (p?.locked === false ? null : this.lockedTarget) ?? null;
      if (p && p.target === null) this.lockedTarget = null;
    }));
  }

  // -- lifecycle -------------------------------------------------------------

  setPlayer(player) {
    this.player = player || null;
    this.encounter?.setPlayer?.(player);
  }

  _rng() {
    // one deterministic stream per agent so behaviour is reproducible per run
    this._rngSeq = (this._rngSeq + 0x9e3779b9) | 0;
    return M.mulberry32(this._rngSeq >>> 0);
  }

  /** Get or create a squad. Squads are the unit of coordination, not the wave. */
  getSquad(name, opts) {
    for (let i = 0; i < this.squads.length; i++) if (this.squads[i].name === name) return this.squads[i];
    const sq = new Squad(++this._squadSeq, opts);
    sq.name = name;
    this.squads.push(sq);
    return sq;
  }

  // -- spawning --------------------------------------------------------------

  /**
   * Create a hostile.
   * @param {string} archetypeId  'mt' | 'ac' | 'tank' | 'flyer' | 'sniper' | 'boss'
   * @param {number} tier         1..6 stat scaling
   * @param {THREE.Vector3} position
   * @param {object} [opts]       { squad, anchor, perch, silent }
   */
  spawn(archetypeId, tier, position, opts) {
    const arch = getArchetype(archetypeId);
    const t = tier || 1;
    const block = arch.stats(t);
    const scale = tierScale(t);

    // --- visual --------------------------------------------------------
    let mech = null;
    try {
      mech = this.mechFactory?.buildEnemy?.(archetypeId, t) || null;
    } catch (err) {
      mech = null;
    }
    const root = mech?.root || (mech instanceof THREE.Object3D ? mech : null) || this._buildPlaceholder(arch, t);
    if (!root.parent) this.scene?.add(root);
    if (position) root.position.copy(position);

    // --- entity (CONTRACT Entity shape) --------------------------------
    const stats = makeStats(block);
    const entity = {
      id: this._idSeq++,
      root,
      mesh: mech,
      rig: mech?.rig || root.userData?.rig || null,
      isPlayer: false,
      faction: 'enemy',
      alive: true,
      archetype: archetypeId,
      tier: t,
      name: arch.name,
      displayName: arch.displayName,
      isBoss: !!arch.isBoss,
      threat: arch.threat || 1,
      stats,
      velocity: new THREE.Vector3(),
      collider: {
        radius: block.radius,
        height: block.height,
        center: new THREE.Vector3().copy(root.position).add(_v.set(0, block.height * 0.5, 0)),
      },
      hardpoints: mech?.hardpoints || root.userData?.hardpoints || this._placeholderHardpoints(root),
      squad: null,
      bb: null,
      brain: null,
      shield: 0,
      shieldUp: false,
      deathTimer: 0,
      _dying: false,
      _dmgVisual: 0,

      onDamage: null,
      onStagger: null,
      onDeath: null,
      getAimPoint: null,
    };

    // bind the Entity callbacks (arrow-free so `this` stays the manager)
    const self = this;
    entity.onDamage = function (info) {
      self._onEntityDamage(entity, info);
    };
    entity.onStagger = function () {
      self._onEntityStagger(entity);
    };
    entity.onDeath = function () {
      self._onEntityDeath(entity, null);
    };
    entity.getAimPoint = function (out) {
      const o = out || _v;
      o.copy(entity.root.position);
      o.y += entity.collider.height * 0.55;
      return o;
    };

    // --- brain ---------------------------------------------------------
    const brain = new Brain(entity, {
      manager: this,
      physics: this.physics,
      level: this.level,
      arch,
      rng: this._rng(),
      weapons: arch.makeWeapons ? arch.makeWeapons(t) : arch.weapons,
      speedMul: block.speedMul ?? scale.speed,
    });
    entity.brain = brain;
    brain.bb.anchor.copy(root.position);
    brain.bb.hasAnchor = true;
    brain.bb.lastKnownPos.copy(root.position);
    brain.bb.bodyYaw = root.rotation.y;
    brain.bb.aimYaw = root.rotation.y;
    brain.setState(arch.initial || 'idle');

    // --- squad ---------------------------------------------------------
    const squadName = opts?.squad || `${archetypeId}-w${this.waveIndex}`;
    const squad = this.getSquad(squadName, arch.squad);
    squad.add(entity);

    // --- shield (boss) --------------------------------------------------
    if (arch.shield) this._attachShield(entity, arch.shield);

    this.list.push(entity);
    arch.onSpawn?.(brain);
    bus.emit('ai:spawned', { entity });
    if (entity.isBoss) bus.emit('boss:spawn', { entity, name: arch.displayName });
    return entity;
  }

  // -- placeholder visuals ---------------------------------------------------

  /**
   * Fallback mech built from primitives, used only when MechFactory isn't ready.
   * Geometry/materials are cached per archetype so 20 grunts share one set.
   */
  _buildPlaceholder(arch, tier) {
    const key = arch.id;
    let kit = this._phCache.get(key);
    if (!kit) {
      const ph = arch.placeholder || { height: 7, radius: 2, color: 0x50565e, accent: 0xff7b3a };
      const body = new THREE.MeshStandardMaterial({ color: ph.color, metalness: 1, roughness: 0.46 });
      const accent = new THREE.MeshStandardMaterial({
        color: 0x11141a,
        metalness: 1,
        roughness: 0.3,
        emissive: new THREE.Color(ph.accent),
        emissiveIntensity: 2.4,
      });
      const h = ph.height;
      const r = ph.radius;
      const geos = {
        torso: new THREE.BoxGeometry(r * 1.5, h * 0.34, r * 1.1),
        head: new THREE.BoxGeometry(r * 0.5, r * 0.42, r * 0.5),
        limb: new THREE.BoxGeometry(r * 0.46, h * 0.4, r * 0.46),
        arm: new THREE.BoxGeometry(r * 0.38, h * 0.3, r * 0.38),
        pod: new THREE.BoxGeometry(r * 0.6, r * 0.42, r * 0.9),
        eye: new THREE.BoxGeometry(r * 0.34, r * 0.1, r * 0.06),
      };
      for (const k in geos) this._phGeo.push(geos[k]);
      this._phMat.push(body, accent);
      kit = { ph, body, accent, geos };
      this._phCache.set(key, kit);
    }

    const { ph, body, accent, geos } = kit;
    const h = ph.height;
    const r = ph.radius;
    const root = new THREE.Group();
    root.name = `enemy_${arch.id}`;

    const torso = new THREE.Mesh(geos.torso, body);
    torso.position.y = h * 0.66;
    torso.castShadow = true;
    torso.receiveShadow = true;
    root.add(torso);

    const head = new THREE.Mesh(geos.head, body);
    head.position.y = h * 0.88;
    head.castShadow = true;
    root.add(head);

    const eye = new THREE.Mesh(geos.eye, accent);
    eye.position.set(0, h * 0.89, -r * 0.27);
    root.add(eye);

    const hp = {};
    const addLimb = (x, z, geo, y) => {
      const mesh = new THREE.Mesh(geo, body);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      root.add(mesh);
      return mesh;
    };

    if (ph.shape === 'drone') {
      torso.position.y = h * 0.5;
      head.position.y = h * 0.78;
      eye.position.y = h * 0.79;
      addLimb(-r * 0.9, 0, geos.pod, h * 0.5);
      addLimb(r * 0.9, 0, geos.pod, h * 0.5);
    } else if (ph.shape === 'quad') {
      addLimb(-r * 0.7, -r * 0.6, geos.limb, h * 0.24);
      addLimb(r * 0.7, -r * 0.6, geos.limb, h * 0.24);
      addLimb(-r * 0.7, r * 0.6, geos.limb, h * 0.24);
      addLimb(r * 0.7, r * 0.6, geos.limb, h * 0.24);
    } else {
      addLimb(-r * 0.42, 0, geos.limb, h * 0.24);
      addLimb(r * 0.42, 0, geos.limb, h * 0.24);
    }

    const lArm = addLimb(-r * 1.0, 0, geos.arm, h * 0.64);
    const rArm = addLimb(r * 1.0, 0, geos.arm, h * 0.64);
    const lPod = new THREE.Mesh(geos.pod, body);
    lPod.position.set(-r * 0.85, h * 0.86, r * 0.15);
    root.add(lPod);
    const rPod = new THREE.Mesh(geos.pod, body);
    rPod.position.set(r * 0.85, h * 0.86, r * 0.15);
    root.add(rPod);

    if (ph.shape === 'boss') {
      root.scale.setScalar(1);
      const crown = new THREE.Mesh(geos.pod, accent);
      crown.position.set(0, h * 0.98, 0);
      crown.scale.set(2.2, 0.6, 1.6);
      root.add(crown);
    }

    // hardpoint anchors — muzzles hang off these
    const mk = (name, x, y, z) => {
      const o = new THREE.Object3D();
      o.position.set(x, y, z);
      root.add(o);
      hp[name] = o;
      return o;
    };
    mk('rArm', rArm.position.x, h * 0.56, -r * 0.7);
    mk('lArm', lArm.position.x, h * 0.56, -r * 0.7);
    mk('rShoulder', r * 0.85, h * 0.92, -r * 0.2);
    mk('lShoulder', -r * 0.85, h * 0.92, -r * 0.2);
    mk('core', 0, h * 0.6, r * 0.4);
    root.userData.hardpoints = hp;
    return root;
  }

  _placeholderHardpoints(root) {
    if (root.userData?.hardpoints) return root.userData.hardpoints;
    const hp = {};
    const names = ['rArm', 'lArm', 'rShoulder', 'lShoulder', 'core'];
    for (let i = 0; i < names.length; i++) {
      const o = new THREE.Object3D();
      o.position.set(i % 2 ? 1.4 : -1.4, 5, -1.2);
      root.add(o);
      hp[names[i]] = o;
    }
    root.userData.hardpoints = hp;
    return hp;
  }

  _attachShield(entity, def) {
    if (!this._shieldGeo) this._shieldGeo = new THREE.SphereGeometry(1, 24, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: def.color ?? 0x49c8ff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this._shieldMats.push(mat);
    const mesh = new THREE.Mesh(this._shieldGeo, mat);
    mesh.scale.setScalar(def.radius ?? 12);
    mesh.position.y = (entity.collider?.height ?? 14) * 0.5;
    mesh.renderOrder = 8;
    mesh.frustumCulled = false;
    entity.root.add(mesh);
    entity.shieldMesh = mesh;
    entity.shield = def.amount ?? 0.6;
    entity.shieldUp = true;
  }

  /** Boss phase 1 → 2: the shield collapses. Big, loud, unmistakable. */
  breakShield(entity) {
    if (!entity?.shieldMesh) return;
    entity.shieldUp = false;
    entity.shield = 0;
    entity.shieldMesh.visible = false;
    entity.getAimPoint(_v);
    this.vfx?.explosion?.(_v, 18, { color: 0x49c8ff, energy: true });
    this.vfx?.shockwave?.(_v, 26);
    this.telegraphs.burst(entity.root.position, 34, 0.9, 0x49c8ff);
    bus.emit(EV.SHAKE, { intensity: 1.2, duration: 0.9 });
    bus.emit(EV.SFX, { id: 'shield_break', position: _v });
  }

  /** Ground shockwave used by the boss charge / nova. */
  shockwave(pos, radius) {
    this.vfx?.shockwave?.(pos, radius);
    this.telegraphs.burst(pos, radius, 0.55, 0xffd27a);
    bus.emit(EV.SHAKE, { intensity: 0.6, duration: 0.4 });
  }

  // -- projectiles -----------------------------------------------------------

  /** Guarded wrapper so a missing/immature ProjectileManager can never crash the AI. */
  spawnProjectile(def, origin, direction, owner, target) {
    const pm = this.projectiles;
    if (!pm?.spawn) return null;
    try {
      return pm.spawn(def, origin, direction, owner, target || undefined);
    } catch (err) {
      return null;
    }
  }

  /** Ray credits are shared: a 20-agent squad can never stampede the raycaster. */
  spendRay() {
    if (this._rays <= 0) return false;
    this._rays--;
    return true;
  }

  // -- perception feeds ------------------------------------------------------

  _onWeaponFired(p) {
    if (!p) return;
    const owner = p.owner || p.entity || null;
    const origin = p.origin || p.position || owner?.root?.position || null;
    if (!origin) return;

    if (owner?.isPlayer) {
      // 1. record an incoming-fire threat ray so ACs can quick-boost it
      const dir = p.direction;
      if (dir) {
        const i = this._threatHead * THREAT_STRIDE;
        const a = this._threats;
        a[i] = origin.x;
        a[i + 1] = origin.y;
        a[i + 2] = origin.z;
        a[i + 3] = dir.x;
        a[i + 4] = dir.y;
        a[i + 5] = dir.z;
        a[i + 6] = p.def?.speed || p.speed || 240;
        a[i + 7] = this._elapsed;
        this._threatHead = (this._threatHead + 1) % THREAT_MAX;
        if (this._threatCount < THREAT_MAX) this._threatCount++;
      }
    }

    // 2. gunfire is loud — everything nearby gets a heading, not a solution
    const loud = owner?.isPlayer ? 130 : 55;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e?.alive || e === owner) continue;
      const d = e.root.position.distanceTo(origin);
      const hear = e.brain?.arch?.perception?.hearing ?? loud;
      if (d > hear) continue;
      const certainty = owner?.isPlayer ? M.clamp(1 - d / hear, 0.2, 0.6) : 0.25;
      e.brain?.alertTo(origin, certainty, owner?.velocity);
    }
  }

  /**
   * How urgently is `agent` about to be hit? Writes the incoming travel direction
   * into `outDir`. Returns 0..1 — the AC dodges perpendicular to this.
   */
  threatToward(agent, outDir) {
    const n = this._threatCount;
    if (!n) return 0;
    const a = this._threats;
    const p = agent.root.position;
    const rad = (agent.collider?.radius ?? 2) * 3 + 3;
    const rad2 = rad * rad;
    const now = this._elapsed;
    let best = 0;
    for (let k = 0; k < n; k++) {
      const i = k * THREAT_STRIDE;
      const age = now - a[i + 7];
      if (age > THREAT_LIFE || age < 0) continue;
      const speed = a[i + 6];
      const travelled = age * speed;
      const rx = p.x - a[i];
      const ry = p.y - a[i + 1];
      const rz = p.z - a[i + 2];
      const along = rx * a[i + 3] + ry * a[i + 4] + rz * a[i + 5];
      if (along < travelled - 6) continue; // already flew past
      const perp2 = rx * rx + ry * ry + rz * rz - along * along;
      if (perp2 > rad2) continue;
      const tta = (along - travelled) / Math.max(speed, 1);
      if (tta < 0.03 || tta > 0.75) continue;
      const urgency = (1 - perp2 / rad2) * (1 - tta / 0.75);
      if (urgency > best) {
        best = urgency;
        outDir.set(a[i + 3], a[i + 4], a[i + 5]);
      }
    }
    return best;
  }

  // -- damage / stagger / death ---------------------------------------------

  _onEntityDamage(entity, info) {
    if (!entity?.alive) return;
    const s = entity.stats;
    let mult = 1;

    // weak point (tank rear vents): a positional skill check, not a dice roll
    const wp = entity.brain?.arch?.weakPoint;
    if (wp && info?.point) {
      entity.root.updateMatrixWorld();
      _local.copy(info.point);
      entity.root.worldToLocal(_local);
      if (_local.distanceTo(wp.offset) < wp.radius) {
        mult *= wp.mult;
        this.vfx?.impact?.(info.point, info.normal || UP, 'energy');
        bus.emit('combat:weakpoint', { entity, name: wp.name, point: info.point });
      }
    }

    if (entity.shieldUp && entity.shield > 0) {
      mult *= 1 - entity.shield;
      if (info?.point) this.vfx?.impact?.(info.point, info.normal || UP, 'shield');
    }

    // If a DamageSystem already resolved the numbers it flags `resolved`; we then
    // only run the AI-side reactions and skip a second application.
    if (!info?.resolved) {
      const type = info?.type;
      const dr = type === 'energy' ? s.defEnergy : type === 'kinetic' ? s.defKinetic : (s.defKinetic + s.defEnergy) * 0.5;
      let dmg = (info?.amount || 0) * mult * (1 - M.clamp(dr, 0, 0.85));
      if (s.staggered) dmg *= 1.65; // direct-hit bonus into a staggered target
      s.ap -= dmg;
      s.acs += (info?.impact || 0) * mult * (s.staggered ? 0 : 1);
      bus.emit(EV.DAMAGE_DEALT, {
        entity,
        target: entity,
        source: info?.source || null,
        amount: dmg,
        point: info?.point,
        weak: mult > 1,
      });
    }

    // reactions — being shot is the loudest perception cue there is
    const brain = entity.brain;
    const src = info?.source;
    if (brain) {
      brain.alertTo(src?.root?.position || info?.point || null, src?.isPlayer ? 0.95 : 0.5, src?.velocity);
      if (src?.isPlayer) entity.squad?.reportContact(src.root?.position, src.velocity, 0.9, this._elapsed);
      brain.bb.panic = Math.min(1, brain.bb.panic + 0.22);
    }

    // battle damage on the mesh
    const ratio = s.apMax ? 1 - s.ap / s.apMax : 0;
    if (ratio - entity._dmgVisual > 0.12) {
      entity._dmgVisual = ratio;
      entity.mesh?.applyDamageVisual?.(ratio);
    }

    if (!s.staggered && s.acs >= s.acsMax) entity.onStagger();
    if (s.ap <= 0) this._onEntityDeath(entity, src || null);
  }

  _onEntityStagger(entity) {
    const s = entity.stats;
    if (s.staggered) return;
    s.staggered = true;
    s.staggerTimer = s.staggerTime || 1.8;
    s.acs = s.acsMax;
    entity.getAimPoint(_v);
    this.vfx?.staggerBurst?.(entity);
    bus.emit(EV.STAGGER, { entity, position: _v });
    bus.emit(EV.HITSTOP, { duration: entity.isBoss ? 0.12 : 0.07 });
    bus.emit(EV.SFX, { id: 'stagger', position: _v });
  }

  _onEntityDeath(entity, killer) {
    if (!entity || entity._dying) return;
    entity._dying = true;
    entity.alive = false;
    entity.stats.ap = 0;
    entity.stats.staggered = false;

    const arch = entity.brain?.arch;
    const pos = entity.root.position;
    entity.getAimPoint(_v);

    this.telegraphs.releaseOwner(entity.id);
    entity.squad?.remove(entity);

    // --- the kill feedback ---
    const big = entity.isBoss ? 3.2 : entity.threat > 3 ? 1.6 : 1;
    this.vfx?.explosion?.(_v, (entity.collider.height || 7) * 0.8 * big, {
      color: entity.isBoss ? 0xff2d6f : 0xffa24d,
    });
    bus.emit(EV.SHAKE, { intensity: 0.35 * big, duration: 0.4 * big });
    bus.emit(EV.HITSTOP, { duration: entity.isBoss ? 0.16 : 0.05 });
    bus.emit(EV.SFX, { id: entity.isBoss ? 'boss_death' : 'mech_death', position: _v });

    bus.emit(EV.ENTITY_KILLED, { entity, killer: killer || this.player || null });
    bus.emit(EV.LOOT_DROP, { position: pos.clone(), tier: entity.tier, archetype: entity.archetype });

    arch?.onDeathStart?.(entity.brain);

    // --- start the collapse: they fall, burn, then sink ---
    entity.deathTimer = entity.isBoss ? 5.0 : 2.8;
    entity._deathT = 0;
    entity._fallSign = Math.random() < 0.5 ? -1 : 1;
    entity._smokeT = 0;
    entity._secondary = false;
    entity.velocity.y = Math.min(entity.velocity.y, 0);
    this._corpses.push(entity);
    if (entity.shieldMesh) entity.shieldMesh.visible = false;

    this.encounter?.onEnemyKilled?.(entity);
  }

  // -- frame -----------------------------------------------------------------

  update(dt, elapsed) {
    if (!this.enabled) return;
    this._elapsed = elapsed;
    this._rays = this.rayBudget;

    const player = this.player;
    this.playerSpeed = player?.velocity ? player.velocity.length() : 0;

    const list = this.list;

    // 1. LOD + perception scheduling
    this._assignLOD();
    this._grantPerception();

    // 2. squads coordinate before individuals act
    for (let i = 0; i < this.squads.length; i++) this.squads[i].update(dt, elapsed);

    // 3. agents
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e) continue;
      if (e.alive) {
        this._tickStats(e, dt);
        e.brain?.update(dt, elapsed);
      }
    }

    // 4. death choreography (runs every frame regardless of LOD)
    this._updateCorpses(dt);

    // 5. presentation + mission flow
    this.telegraphs.update(dt, elapsed);
    this.encounter?.update?.(dt, elapsed);
    this.waveIndex = this.encounter?.waveIndex ?? this.waveIndex;
  }

  _assignLOD() {
    const p = this.player?.root?.position;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const b = e?.brain;
      if (!b) continue;
      if (!p) {
        b.lod = 1;
        b.tickInterval = 0.025;
        continue;
      }
      const dx = e.root.position.x - p.x;
      const dz = e.root.position.z - p.z;
      const d2 = dx * dx + dz * dz;
      // bosses and staggered agents always run at full rate — they're on camera
      if (e.isBoss || e.stats.staggered || d2 < 90 * 90) {
        b.lod = 0;
        b.tickInterval = 0;
      } else if (d2 < 190 * 190) {
        b.lod = 1;
        b.tickInterval = 0.025;
      } else {
        b.lod = 2;
        b.tickInterval = 0.07;
      }
    }
  }

  _grantPerception() {
    const list = this.list;
    const n = list.length;
    if (!n) return;
    let grants = this.perceptionBudget;
    const start = this._losCursor % n;
    for (let k = 0; k < n && grants > 0; k++) {
      const e = list[(start + k) % n];
      const b = e?.brain;
      if (!e?.alive || !b || b._losGranted || b._losTimer > 0) continue;
      b._losGranted = true;
      grants--;
    }
    this._losCursor = (this._losCursor + this.perceptionBudget) % n;
  }

  _tickStats(e, dt) {
    const s = e.stats;
    if (s.staggered) {
      s.staggerTimer -= dt;
      if (s.staggerTimer <= 0) {
        s.staggered = false;
        s.acs = 0;
      }
    } else if (s.acs > 0) {
      s.acs = Math.max(0, s.acs - (s.acsDecay || 120) * dt);
    }
    if (s.heat > 0) s.heat = Math.max(0, s.heat - dt * 40);

    if (e.shieldMesh && e.shieldUp) {
      const pulse = 0.12 + Math.sin(this._elapsed * 2.4) * 0.05;
      e.shieldMesh.material.opacity = pulse;
    }
  }

  _updateCorpses(dt) {
    const corpses = this._corpses;
    for (let i = corpses.length - 1; i >= 0; i--) {
      const e = corpses[i];
      e._deathT += dt;
      e.deathTimer -= dt;
      const root = e.root;

      // fall: gravity + a topple onto its side
      e.velocity.y -= 24 * dt;
      root.position.y += e.velocity.y * dt;
      root.position.x += e.velocity.x * dt * 0.4;
      root.position.z += e.velocity.z * dt * 0.4;
      const ground = this.physics?.groundHeight?.(root.position.x, root.position.z) ?? 0;
      if (root.position.y < ground) {
        root.position.y = ground;
        e.velocity.y *= -0.18;
        e.velocity.x *= 0.5;
        e.velocity.z *= 0.5;
      }
      const topple = M.clamp(e._deathT * 1.5, 0, 1);
      root.rotation.z = M.lerp(root.rotation.z, e._fallSign * 1.45, topple * dt * 4);
      root.rotation.x = M.lerp(root.rotation.x, e._fallSign * 0.35, topple * dt * 3);

      // burn
      e._smokeT -= dt;
      if (e._smokeT <= 0) {
        e._smokeT = 0.11;
        _v.copy(root.position);
        _v.y += e.collider.height * 0.45;
        _v2.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
        this.vfx?.smoke?.(_v, _v2, 1.2);
        if (Math.random() < 0.5) this.vfx?.sparks?.(_v, _v2, 0.7);
      }
      if (!e._secondary && e._deathT > (e.isBoss ? 1.2 : 0.55)) {
        e._secondary = true;
        _v.copy(root.position);
        _v.y += e.collider.height * 0.4;
        this.vfx?.explosion?.(_v, e.collider.height * (e.isBoss ? 1.6 : 0.55), {});
      }
      if (e.isBoss && e._deathT > 2.4 && Math.random() < dt * 6) {
        _v.copy(root.position);
        _v.x += (Math.random() - 0.5) * 14;
        _v.z += (Math.random() - 0.5) * 14;
        _v.y += Math.random() * 12;
        this.vfx?.explosion?.(_v, 6, {});
      }

      // sink out of sight in the last stretch, then retire
      if (e.deathTimer < 0.7) {
        root.position.y -= dt * 4.5;
        const k = M.clamp(e.deathTimer / 0.7, 0, 1);
        root.scale.setScalar(0.55 + k * 0.45);
      }
      if (e.deathTimer <= 0) {
        corpses.splice(i, 1);
        this._retire(e);
      }
    }
  }

  /** Remove from the live list, detach the visual, release AI resources. */
  _retire(e) {
    const idx = this.list.indexOf(e);
    if (idx >= 0) this.list.splice(idx, 1);
    this.telegraphs.releaseOwner(e.id);
    if (e.root?.parent) e.root.parent.remove(e.root);
    if (e.shieldMesh) {
      const mi = this._shieldMats.indexOf(e.shieldMesh.material);
      if (mi >= 0) {
        this._shieldMats.splice(mi, 1);
        e.shieldMesh.material.dispose();
      }
      e.shieldMesh = null;
    }
    e.mesh?.dispose?.();
    e.brain?.dispose?.();
    e.brain = null;
    e.bb = null;
    bus.emit('ai:removed', { entity: e });
  }

  // -- queries used by encounters / HUD --------------------------------------

  get aliveCount() {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) if (this.list[i]?.alive) n++;
    return n;
  }

  aliveOfArchetype(id) {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (e?.alive && e.archetype === id) n++;
    }
    return n;
  }

  /** True if `pos` is at least `minDist` from the player. */
  isFarFromPlayer(pos, minDist) {
    const p = this.player?.root?.position;
    if (!p || !pos) return true;
    const dx = pos.x - p.x;
    const dz = pos.z - p.z;
    return dx * dx + dz * dz >= minDist * minDist;
  }

  // -- lifecycle -------------------------------------------------------------

  reset() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      this.telegraphs.releaseOwner(e.id);
      if (e.root?.parent) e.root.parent.remove(e.root);
      e.brain?.dispose?.();
      e.brain = null;
    }
    this.list.length = 0;
    this._corpses.length = 0;
    for (let i = 0; i < this.squads.length; i++) this.squads[i].dispose();
    this.squads.length = 0;
    for (let i = 0; i < this._shieldMats.length; i++) this._shieldMats[i].dispose();
    this._shieldMats.length = 0;
    this.telegraphs.clear();
    this._threatCount = 0;
    this._threatHead = 0;
    this.lockedTarget = null;
    this.waveIndex = 0;
    this.encounter?.reset?.();
  }

  dispose() {
    this.reset();
    this.telegraphs.dispose();
    this.encounter?.dispose?.();
    for (let i = 0; i < this._phGeo.length; i++) this._phGeo[i].dispose();
    for (let i = 0; i < this._phMat.length; i++) this._phMat[i].dispose();
    this._phGeo.length = 0;
    this._phMat.length = 0;
    this._phCache.clear();
    this._shieldGeo?.dispose();
    this._shieldGeo = null;
    for (let i = 0; i < this._offs.length; i++) this._offs[i]?.();
    this._offs.length = 0;
  }
}

export default EnemyManager;
