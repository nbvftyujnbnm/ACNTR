import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, damp, interceptPoint } from '../core/MathUtils.js';
import { WEAPON_DEFS, createWeapon } from './Weapons.js';

/**
 * WeaponSystem — turns player input into rounds leaving the correct hardpoint.
 *
 * Control map (matches Input.js):
 *   LMB        → right arm
 *   RMB        → left arm
 *   Q / MMB    → right shoulder
 *   E          → left shoulder
 *
 * Responsibilities:
 *  - resolve the world muzzle transform from `player.hardpoints.*`
 *  - resolve an aim point from the targeting system so shots CONVERGE on the target
 *    instead of leaving both arms on parallel rails
 *  - drive each Weapon's own trigger state machine (auto / burst / charge / beam / melee)
 *  - own the things a Weapon cannot: the melee lunge hitbox, the deployable pulse shield
 *    and the orbiting support pods
 *  - publish everything the HUD, the camera rig and the audio director need over the bus
 *
 * Every cross-module read is optional-chained: this class must survive being constructed
 * before the mech, the loadout or the VFX system exist.
 */

const SLOT_KEYS = ['rArm', 'lArm', 'rShoulder', 'lShoulder'];

/** Used when the loadout is missing or has not resolved yet. */
export const DEFAULT_LOADOUT = {
  rArm: 'rifle_rf025',
  lArm: 'shotgun_sg027',
  rShoulder: 'missile_bml',
  lShoulder: 'cannon_earshot',
};

/** Fallback muzzle anchors in player-local space when hardpoints are not built yet. */
const FALLBACK_ANCHOR = {
  rArm: new THREE.Vector3(2.6, 5.2, -1.0),
  lArm: new THREE.Vector3(-2.6, 5.2, -1.0),
  rShoulder: new THREE.Vector3(1.9, 7.4, 0.2),
  lShoulder: new THREE.Vector3(-1.9, 7.4, 0.2),
};

const MAX_SWINGS = 4;
const MAX_DRONES = 4;

// ------------------------------------------------------------------ scratch
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _off = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _swingC = new THREE.Vector3();
const _droneV = new THREE.Vector3();
const _droneD = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _lead = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

/** Closest point on segment [a,b] to `p`, written into `out`. */
function closestOnSegment(a, b, p, out) {
  _seg.subVectors(b, a);
  const len2 = _seg.lengthSq();
  if (len2 < 1e-8) return out.copy(a);
  _rel.subVectors(p, a);
  const t = clamp(_rel.dot(_seg) / len2, 0, 1);
  return out.copy(a).addScaledVector(_seg, t);
}

/** Per-slot firing context handed to a Weapon each frame. Allocated once. */
function makeContext(slot, system) {
  return {
    slot,
    system,
    projectiles: null,
    targeting: null,
    vfx: null,
    owner: null,
    origin: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 0, -1),
    quat: new THREE.Quaternion(),
    aimPoint: new THREE.Vector3(),
    target: null,
    lockProgress: 0,
    hardLock: false,
    held: false,
    pressed: false,
    released: false,
    dt: 0,
    elapsed: 0,
  };
}

export class WeaponSystem {
  /**
   * @param {object} player the player mech (Entity)
   * @param {object} input Input instance
   * @param {object} projectiles ProjectileManager
   * @param {object} targeting TargetingSystem
   * @param {object} vfx VFX
   */
  constructor(player, input, projectiles, targeting, vfx) {
    this.player = player || null;
    this.input = input || null;
    this.projectiles = projectiles || null;
    this.targeting = targeting || null;
    this.vfx = vfx || null;
    this.enabled = true;
    this._disposed = false;

    /** @type {{rArm:import('./Weapons.js').Weapon|null, lArm:*, rShoulder:*, lShoulder:*}} */
    this.slots = { rArm: null, lArm: null, rShoulder: null, lShoulder: null };
    this.loadout = null;

    /** State the mech rig / camera rig read for recoil animation. */
    this.state = {
      recoil: 0,
      recoilDir: new THREE.Vector3(),
      kick: { rArm: 0, lArm: 0, rShoulder: 0, lShoulder: 0 },
      firing: { rArm: false, lArm: false, rShoulder: false, lShoulder: false },
      deployed: { rShoulder: 0, lShoulder: 0 },
      charging: 0,
      lastFired: '',
      meleeT: 0,
    };
    if (this.player) this.player.weaponState = this.state;

    this._ctx = {
      rArm: makeContext('rArm', this),
      lArm: makeContext('lArm', this),
      rShoulder: makeContext('rShoulder', this),
      lShoulder: makeContext('lShoulder', this),
    };
    this._prevHeld = { rArm: false, lArm: false, rShoulder: false, lShoulder: false };

    // reusable event payloads — the bus fires a lot in a firefight
    this._firePayload = new Array(8);
    for (let i = 0; i < 8; i++) {
      this._firePayload[i] = {
        weapon: null,
        slot: '',
        id: '',
        recoil: 0,
        position: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        charged: false,
        category: '',
      };
    }
    this._fireIdx = 0;
    this._shake = { intensity: 0, duration: 0.12 };
    this._dashPayload = {
      entity: null,
      direction: new THREE.Vector3(),
      distance: 0,
      duration: 0.24,
      combo: 0,
    };

    // pooled melee hit payloads — a blade combo can land on several targets at once
    this._meleeRing = new Array(8);
    for (let i = 0; i < 8; i++) {
      this._meleeRing[i] = {
        info: {
          amount: 0,
          impact: 0,
          type: 'energy',
          point: new THREE.Vector3(),
          normal: new THREE.Vector3(0, 1, 0),
          source: null,
          direct: false,
          pulse: true,
          weaponId: 'pulse_blade',
          splash: false,
        },
        fx: { point: null, normal: null, type: 'energy', scale: 2.4 },
        sfx: { id: 'blade_hit', position: null },
      };
      const r = this._meleeRing[i];
      r.fx.point = r.info.point;
      r.fx.normal = r.info.normal;
      r.sfx.position = r.info.point;
    }
    this._meleeIdx = 0;
    this._hitstop = { duration: 0.07 };
    this._meleeShake = { intensity: 0.55, duration: 0.2 };

    // ---- melee swings ------------------------------------------------------
    this._swings = new Array(MAX_SWINGS);
    for (let i = 0; i < MAX_SWINGS; i++) {
      this._swings[i] = {
        active: false,
        weapon: null,
        slot: '',
        t: 0,
        windup: 0,
        activeEnd: 0,
        total: 0,
        damage: 0,
        impact: 0,
        reach: 12,
        radius: 4,
        dir: new THREE.Vector3(),
        hits: [],
      };
    }

    // ---- support drones ----------------------------------------------------
    this._drones = [];
    this._droneGroup = null;
    this._droneGeo = null;
    this._droneMat = null;
    this._dronePdef = null;

    // ---- pulse shield ------------------------------------------------------
    this._shieldMesh = null;
    this._shieldGeo = null;
    this._shieldMat = null;
    this._shieldWeapon = null;

    this._vfxBad = { muzzle: false };
    this._aimBad = { ray: false, lead: false };
    this._forwardedTargets = false;
    this._syncT = 0;

    // players are damageable too — make sure projectiles can find them
    this.projectiles?.addTarget?.(this.player);

    this.setLoadout(player?.loadout || null);

    this._offBuild = bus.on(EV.BUILD_CHANGED, () => this.setLoadout(this.loadout));
    this._offEquip = bus.on(EV.PART_EQUIPPED, () => this.setLoadout(this.loadout));
  }

  // ================================================================ loadout

  /**
   * Instantiate weapons from a Loadout. Guarded end to end: any slot that does not
   * resolve to a real weapon id falls back to the default set.
   * @param {object} loadout
   */
  setLoadout(loadout) {
    if (loadout) this.loadout = loadout;
    const slots = this.loadout?.slots;
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      const key = SLOT_KEYS[i];
      const id = this._resolveWeaponId(slots?.[key], key);
      const cur = this.slots[key];
      if (cur && cur.id === id) continue;
      cur?.dispose?.();
      const w = createWeapon(id);
      if (w) w.slot = key;
      this.slots[key] = w;
    }
    bus.emit('combat:loadoutApplied', { slots: this.slots });
    return this;
  }

  /** A part may carry `weaponId`, be a raw id string, or be missing entirely. */
  _resolveWeaponId(part, key) {
    let id = null;
    if (typeof part === 'string') id = part;
    else if (part) id = part.weaponId || part.weapon?.id || part.id || null;
    if (id && WEAPON_DEFS[id]) return id;
    return DEFAULT_LOADOUT[key];
  }

  /** @returns {import('./Weapons.js').Weapon|null} */
  getSlot(key) {
    return this.slots[key] || null;
  }

  /** Total ACS pressure per second across the build — the garage wants this. */
  get impactPerSecond() {
    let s = 0;
    for (const k of SLOT_KEYS) s += this.slots[k]?.def?.ips || 0;
    return s;
  }

  get damagePerSecond() {
    let s = 0;
    for (const k of SLOT_KEYS) s += this.slots[k]?.def?.dps || 0;
    return s;
  }

  // ================================================================= update

  /**
   * @param {number} dt seconds
   * @param {number} elapsed total elapsed seconds
   */
  update(dt, elapsed) {
    if (this._disposed || dt <= 0) return;

    this._syncTargets(dt);

    const st = this.state;
    st.recoil = damp(st.recoil, 0, 9, dt);
    for (const k of SLOT_KEYS) st.kick[k] = damp(st.kick[k], 0, 11, dt);
    if (st.meleeT > 0) st.meleeT -= dt;

    const p = this.player;
    const canAct = this.enabled && p && p.alive !== false && !p.stats?.staggered;

    let charging = 0;
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      const key = SLOT_KEYS[i];
      const w = this.slots[key];
      if (!w) continue;
      const ctx = this._prepareContext(key, w, dt, elapsed, canAct);
      w.update(dt, ctx);
      st.firing[key] = w.firing;
      if (w.charge > charging) charging = w.charge;
      if (key === 'rShoulder' || key === 'lShoulder') st.deployed[key] = w.deploy;
    }
    st.charging = charging;

    this._updateSwings(dt);
    this._updateShield(dt);
    this._updateDrones(dt, elapsed);
  }

  /** Fill the per-slot context: muzzle transform, converged aim, trigger edges. */
  _prepareContext(key, weapon, dt, elapsed, canAct) {
    const ctx = this._ctx[key];
    const tg = this.targeting;
    ctx.projectiles = this.projectiles;
    ctx.targeting = tg;
    ctx.vfx = this.vfx;
    ctx.owner = this.player;
    ctx.dt = dt;
    ctx.elapsed = elapsed;
    ctx.target = tg?.target || null;
    ctx.lockProgress = typeof tg?.lockProgress === 'number' ? tg.lockProgress : ctx.target ? 1 : 0;
    ctx.hardLock = !!tg?.hardLock;

    // ---- trigger edges -----------------------------------------------------
    const held = canAct && this._readTrigger(key);
    ctx.pressed = held && !this._prevHeld[key];
    ctx.released = !held && this._prevHeld[key];
    ctx.held = held;
    this._prevHeld[key] = held;

    // ---- muzzle ------------------------------------------------------------
    this._muzzle(key, weapon, ctx.origin, ctx.quat);

    // ---- aim ---------------------------------------------------------------
    this._aimPoint(weapon, ctx, _aim);
    ctx.aimPoint.copy(_aim);
    ctx.dir.subVectors(_aim, ctx.origin);
    if (ctx.dir.lengthSq() < 1e-8) ctx.dir.copy(FORWARD).applyQuaternion(ctx.quat);
    ctx.dir.normalize();

    return ctx;
  }

  _readTrigger(key) {
    const inp = this.input;
    if (!inp) return false;
    switch (key) {
      case 'rArm':
        return !!inp.mouseDown?.(0);
      case 'lArm':
        return !!inp.mouseDown?.(2);
      case 'rShoulder':
        return !!inp.down?.('KeyQ') || !!inp.mouseDown?.(1);
      case 'lShoulder':
        return !!inp.down?.('KeyE');
      default:
        return false;
    }
  }

  /**
   * World muzzle transform for a slot. Prefers the real hardpoint Object3D so the barrel
   * follows the rig; falls back to a fixed offset from the mech root.
   */
  _muzzle(key, weapon, outPos, outQuat) {
    const hp = this.player?.hardpoints?.[key];
    if (hp && hp.getWorldPosition) {
      hp.getWorldPosition(outPos);
      hp.getWorldQuaternion(outQuat);
    } else {
      const root = this.player?.root;
      if (root) {
        root.getWorldQuaternion(outQuat);
        root.getWorldPosition(_v);
        outPos.copy(FALLBACK_ANCHOR[key] || FALLBACK_ANCHOR.rArm).applyQuaternion(outQuat).add(_v);
      } else {
        outPos.set(0, 6, 0);
        outQuat.identity();
      }
    }
    const mo = weapon?.def?.muzzleOffset;
    if (mo) {
      _off.set(mo.x || 0, mo.y || 0, mo.z || 0).applyQuaternion(outQuat);
      outPos.add(_off);
    }
    return outPos;
  }

  /**
   * Where this weapon should send its round.
   *
   * Priority: the targeting system's own lead solver → an intercept solution against the
   * locked target → the camera aim ray → straight out of the mech. Converging every barrel
   * on one point is what makes two arm weapons feel like they belong to the same mech.
   */
  _aimPoint(weapon, ctx, out) {
    const tg = this.targeting;
    const def = weapon?.def;
    const speed = def?.projectileSpeed || 0;
    const range = def?.range || 900;
    let solved = false;

    // CONTRACT SIGNATURE: `getLeadPoint(entity, projectileSpeed, out)`. This
    // called it as `(speed, out)`, so `entity` arrived as a NUMBER, the method's
    // own `if (!entity?.root) return o.set(0, 0, 0)` guard fired, and it handed
    // back its INTERNAL vector — never touching the `out` we pass on as the aim
    // point. The finite-check below then declared the shot SOLVED, so `_aim` was
    // never written by anything and kept its initial value. Measured: with the
    // mech at (-198, 65.6, -8) every slot fired along (0.94, -0.34, 0.05), which
    // is exactly `normalize((0,0,0) - muzzle)` — EVERY PLAYER WEAPON WAS AIMING
    // AT THE WORLD ORIGIN, whatever the camera was pointing at.
    // A lead solution only means anything when there IS a target, so gate on one
    // instead of trusting a returned vector to say so.
    const lead = ctx.target || tg?.target || null;
    if (lead && tg && !this._aimBad.lead && typeof tg.getLeadPoint === 'function') {
      try {
        const r = tg.getLeadPoint(lead, speed, out);
        if (r && isFinite(r.x)) {
          if (r !== out) out.copy(r);
          solved = true;
        }
      } catch (err) {
        this._aimBad.lead = true;
      }
    }

    if (!solved) {
      const t = ctx.target;
      if (t && t.alive !== false) {
        if (t.getAimPoint) t.getAimPoint(out);
        else out.copy(t.collider?.center || t.root?.position || ctx.origin);
        // lead moving targets for anything that is not effectively hitscan
        if (speed > 0 && speed < 900 && t.velocity) {
          interceptPoint(ctx.origin, out, t.velocity, speed, _lead);
          if (isFinite(_lead.x)) out.copy(_lead);
        }
        solved = true;
      }
    }

    if (!solved && tg && !this._aimBad.ray && typeof tg.getAimRay === 'function') {
      try {
        const ray = tg.getAimRay();
        const o = ray?.origin;
        const d = ray?.direction;
        if (o && d) {
          out.copy(o).addScaledVector(d, range);
          solved = true;
        }
      } catch (err) {
        this._aimBad.ray = true;
      }
    }

    if (!solved) {
      // last resort: straight out of the muzzle along the mech's facing
      this._playerForward(_fwd);
      out.copy(ctx.origin).addScaledVector(_fwd, range);
    }

    // Ballistic weapons must aim above the point they want to hit or every bazooka
    // round lands in the dirt. Low-arc solution, capped so free aim stays sane.
    const g = def?.projectile?.gravity || 0;
    if (g > 0 && speed > 0) {
      const flight = Math.min(ctx.origin.distanceTo(out), 400) / speed;
      out.y += 0.5 * g * flight * flight;
    }
    return out;
  }

  /** Best-effort forward vector for the mech, honouring an aim pitch if one exists. */
  _playerForward(out) {
    const p = this.player;
    const dir = p?.aimDir || p?.rig?.aimDir;
    if (dir && isFinite(dir.x)) return out.copy(dir).normalize();
    const yaw = p?.aimYaw;
    const pitch = p?.aimPitch;
    if (typeof yaw === 'number') {
      const cp = Math.cos(typeof pitch === 'number' ? pitch : 0);
      out.set(-Math.sin(yaw) * cp, Math.sin(typeof pitch === 'number' ? pitch : 0), -Math.cos(yaw) * cp);
      return out.normalize();
    }
    const root = p?.root;
    if (root) {
      root.getWorldQuaternion(_q);
      return out.copy(FORWARD).applyQuaternion(_q).normalize();
    }
    return out.copy(FORWARD);
  }

  /**
   * Hand the enemy list to the ProjectileManager. Game wires TargetingSystem with the live
   * enemy array but nothing wires ProjectileManager, so we bridge it here (once).
   */
  _syncTargets(dt) {
    if (this._forwardedTargets || !this.projectiles?.setTargetList) return;
    this._syncT -= dt;
    if (this._syncT > 0) return;
    this._syncT = 0.5;
    const tg = this.targeting;
    if (!tg) return;
    const keys = ['targets', '_targets', 'list', 'entities', 'candidates', '_list'];
    for (let i = 0; i < keys.length; i++) {
      const v = tg[keys[i]];
      if (Array.isArray(v)) {
        this.projectiles.setTargetList(v);
        this.projectiles.addTarget?.(this.player);
        this._forwardedTargets = true;
        return;
      }
    }
  }

  // ============================================================ fire feedback

  /**
   * Called by Weapon the instant a round leaves the tube.
   * @param {import('./Weapons.js').Weapon} weapon
   * @param {object} ctx firing context
   * @param {number} scaleMul flash size multiplier (charged shots bloom bigger)
   */
  _onFired(weapon, ctx, scaleMul = 1) {
    const d = weapon.def;
    const st = this.state;
    const recoil = (d.recoil || 0) * scaleMul;

    st.recoil = Math.min(3.5, st.recoil + recoil);
    st.recoilDir.copy(ctx.dir).multiplyScalar(-1);
    st.kick[ctx.slot] = 1;
    st.lastFired = ctx.slot;

    // muzzle flash at the actual hardpoint
    const v = this.vfx;
    if (v && v.muzzleFlash && !this._vfxBad.muzzle && d.flashScale > 0) {
      try {
        v.muzzleFlash(ctx.origin, ctx.dir, d.flashScale * scaleMul, d.flashColor);
      } catch (err) {
        this._vfxBad.muzzle = true;
      }
    }

    const pay = this._firePayload[this._fireIdx++ & 7];
    pay.weapon = weapon;
    pay.slot = ctx.slot;
    pay.id = d.id;
    pay.recoil = recoil;
    pay.position.copy(ctx.origin);
    pay.direction.copy(ctx.dir);
    pay.charged = scaleMul > 1.05;
    pay.category = d.category;
    bus.emit(EV.WEAPON_FIRED, pay);

    // heavy ordnance shoves the camera; a rifle should not
    if (recoil > 0.9) {
      this._shake.intensity = clamp(recoil * 0.22, 0.05, 0.85);
      this._shake.duration = 0.14;
      bus.emit(EV.SHAKE, this._shake);
    }
  }

  // ================================================================== melee

  /**
   * Pulse blade swing. The dash is broadcast so PlayerController can own the movement;
   * the hitbox is ours — a swept sphere that tracks the mech through the lunge.
   */
  _onMeleeSwing(weapon, ctx, comboIndex) {
    const m = weapon.def.melee;
    if (!m) return;
    const last = comboIndex === (m.combo || 1) - 1;
    const dmgMul = last ? m.comboDamageMul || 1.3 : 1;
    const impMul = last ? m.comboImpactMul || 1.25 : 1;
    const dashMul = last ? m.comboDashMul || 1.2 : 1;

    // let whoever owns movement perform the lunge
    const dash = this._dashPayload;
    dash.entity = this.player;
    dash.direction.copy(ctx.dir);
    dash.distance = (m.dashDistance || 12) * dashMul;
    dash.duration = m.dashDuration || 0.24;
    dash.combo = comboIndex;
    bus.emit('combat:meleeDash', dash);
    bus.emit(EV.SFX, { id: 'blade_swing', position: ctx.origin, combo: comboIndex });

    const s = this._freeSwing();
    if (!s) return;
    s.active = true;
    s.weapon = weapon;
    s.slot = ctx.slot;
    s.t = 0;
    s.windup = m.windup || 0.1;
    s.activeEnd = s.windup + (m.active || 0.2);
    s.total = s.activeEnd + (m.recovery || 0.25);
    s.damage = weapon.def.damage * dmgMul;
    s.impact = weapon.def.impact * impMul;
    s.reach = m.reach || 14;
    s.radius = m.radius || 4;
    s.dir.copy(ctx.dir);
    s.hits.length = 0;
    this.state.meleeT = s.total;
  }

  _freeSwing() {
    for (let i = 0; i < MAX_SWINGS; i++) if (!this._swings[i].active) return this._swings[i];
    return null;
  }

  /** Advance active swings and resolve their sphere overlap against live entities. */
  _updateSwings(dt) {
    const list = this.projectiles?.getTargets?.();
    for (let i = 0; i < MAX_SWINGS; i++) {
      const s = this._swings[i];
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.total) {
        s.active = false;
        s.weapon = null;
        s.hits.length = 0;
        continue;
      }
      if (s.t < s.windup || s.t > s.activeEnd || !list) continue;

      // the blade sphere rides out in front of the mech and follows it through the lunge
      const w = s.weapon;
      const origin = this._ctx[s.slot]?.origin;
      if (!origin) continue;
      const sweep = clamp((s.t - s.windup) / Math.max(1e-3, s.activeEnd - s.windup), 0, 1);
      _swingC.copy(origin).addScaledVector(s.dir, s.reach * (0.25 + 0.75 * sweep));

      const r = s.radius;
      for (let j = 0; j < list.length; j++) {
        const e = list[j];
        if (!e || e === this.player || e.alive === false || !e.stats) continue;
        if (e.faction && this.player?.faction && e.faction === this.player.faction) continue;
        if (s.hits.indexOf(e) >= 0) continue;
        const cap = this._capsuleOf(e, _capA, _capB);
        if (cap <= 0) continue;
        closestOnSegment(_capA, _capB, _swingC, _v);
        const rr = r + cap;
        if (_v.distanceToSquared(_swingC) > rr * rr) continue;

        s.hits.push(e);
        _v2.subVectors(_v, _swingC);
        if (_v2.lengthSq() < 1e-8) _v2.copy(s.dir).multiplyScalar(-1);
        _v2.normalize();
        this._applyMeleeHit(e, s, _v, _v2, w);
      }
    }
  }

  _applyMeleeHit(entity, swing, point, normal, weapon) {
    const rec = this._meleeRing[this._meleeIdx++ & 7];
    const info = rec.info;
    info.amount = swing.damage;
    info.impact = swing.impact;
    info.type = weapon?.def?.type || 'energy';
    info.point.copy(point);
    info.normal.copy(normal);
    info.source = this.player;
    info.direct = false;
    info.pulse = true; // pulse blades shred energy shields
    info.weaponId = weapon?.def?.id || 'pulse_blade';

    const ds = this.projectiles?.damageSystem;
    if (ds) {
      ds.applyDamage(entity, info);
    } else {
      entity.onDamage?.(info);
      bus.emit(EV.DAMAGE_DEALT, {
        entity,
        amount: info.amount,
        direct: false,
        point: info.point,
        isPlayer: !!entity.isPlayer,
        type: info.type,
        impact: info.impact,
        source: this.player,
      });
    }

    try {
      this.vfx?.impact?.(info.point, info.normal, 'energy', 2.2);
    } catch (err) {
      /* VFX not ready yet — the bus event below still reaches it */
    }
    bus.emit(EV.IMPACT, rec.fx);
    bus.emit(EV.HITSTOP, this._hitstop);
    bus.emit(EV.SHAKE, this._meleeShake);
    bus.emit(EV.SFX, rec.sfx);
  }

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

  // ============================================================= deployables

  /** Weapon calls this when a `deploy`-trigger weapon activates. */
  _onDeployStart(weapon, ctx) {
    const d = weapon.def.deployable;
    if (!d) return;
    if (d.mode === 'shield') this._startShield(weapon, ctx, d);
    else if (d.mode === 'drones') this._startDrones(weapon, ctx, d);
    bus.emit('combat:deployStart', { weapon, slot: ctx.slot, mode: d.mode, duration: d.duration });
    bus.emit(EV.SFX, { id: d.mode === 'shield' ? 'shield_up' : 'pod_launch', position: ctx.origin });
  }

  _onDeployEnd(weapon, ctx) {
    const d = weapon.def.deployable;
    if (!d) return;
    if (d.mode === 'shield' && this._shieldWeapon === weapon) this._stopShield();
    else if (d.mode === 'drones') this._stopDrones(weapon);
    bus.emit('combat:deployEnd', { weapon, slot: ctx?.slot || weapon.slot, mode: d.mode });
  }

  // ---- pulse shield --------------------------------------------------------

  _startShield(weapon, ctx, d) {
    const p = this.player;
    if (!p) return;
    this._shieldWeapon = weapon;
    const arcCos = Math.cos(((d.arcDeg || 130) * Math.PI) / 360);
    if (!p.shield) p.shield = { active: false, hp: 0, hpMax: 0, dir: new THREE.Vector3(), arcCos, timer: 0, radius: 0, broken: false };
    const sh = p.shield;
    sh.active = true;
    sh.hp = d.absorb || 2000;
    sh.hpMax = sh.hp;
    sh.arcCos = arcCos;
    sh.timer = d.duration || 6;
    sh.radius = d.radius || 7.5;
    sh.broken = false;
    sh.dir.copy(ctx.dir);

    if (!this._shieldMesh) {
      // a shallow spherical cap facing the aim direction; additive so bloom picks it up
      const arc = (d.arcDeg || 130) * (Math.PI / 180);
      this._shieldGeo = new THREE.SphereGeometry(1, 28, 18, -arc * 0.5, arc, Math.PI * 0.22, Math.PI * 0.56);
      this._shieldGeo.rotateY(Math.PI); // opening faces -Z, the mech's forward
      this._shieldMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.35, 1.9, 3.2),
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      this._shieldMesh = new THREE.Mesh(this._shieldGeo, this._shieldMat);
      this._shieldMesh.frustumCulled = false;
      this._shieldMesh.renderOrder = 9;
      this.player?.root?.parent?.add(this._shieldMesh);
    }
    this._shieldMesh.visible = true;
    this._shieldMesh.scale.setScalar(sh.radius);
  }

  _updateShield(dt) {
    const sh = this.player?.shield;
    const mesh = this._shieldMesh;
    if (!sh || !sh.active) {
      if (mesh && mesh.visible) mesh.visible = false;
      return;
    }
    // the barrier tracks where the mech is looking, so you must face the incoming fire
    this._playerForward(_fwd);
    sh.dir.lerp(_fwd, clamp(dt * 8, 0, 1)).normalize();
    if (mesh) {
      const c = this.player?.collider?.center || this.player?.root?.position;
      if (c) mesh.position.copy(c);
      _v.copy(sh.dir);
      mesh.quaternion.setFromUnitVectors(FORWARD, _v);
      const hp = sh.hpMax > 0 ? sh.hp / sh.hpMax : 0;
      if (this._shieldMat) this._shieldMat.opacity = 0.12 + 0.28 * hp;
      mesh.visible = true;
    }
  }

  _stopShield() {
    const sh = this.player?.shield;
    if (sh) {
      sh.active = false;
      sh.hp = 0;
    }
    if (this._shieldMesh) this._shieldMesh.visible = false;
    this._shieldWeapon = null;
  }

  // ---- support pods --------------------------------------------------------

  _startDrones(weapon, ctx, d) {
    if (!this._droneGroup) {
      this._droneGroup = new THREE.Group();
      this._droneGroup.name = 'supportPods';
      this._droneGeo = new THREE.OctahedronGeometry(0.55, 0);
      this._droneMat = new THREE.MeshStandardMaterial({
        color: 0x232830,
        metalness: 1,
        roughness: 0.35,
        emissive: new THREE.Color(0.1, 0.9, 1.6),
        emissiveIntensity: 1.4,
      });
      this.player?.root?.parent?.add(this._droneGroup);
    }
    const src = weapon.def.projectile;
    if (!this._dronePdef) {
      this._dronePdef = {
        kind: src.kind,
        type: weapon.def.type,
        pulse: false,
        damage: weapon.def.damage,
        impact: weapon.def.impact,
        speed: weapon.def.projectileSpeed,
        life: src.life,
        radius: src.radius,
        width: src.width,
        length: src.length,
        color: src.color,
        gravity: 0,
        pierce: 0,
        range: d.range || 320,
        weaponId: weapon.def.id,
      };
    }

    const count = Math.min(MAX_DRONES, d.count || 2);
    for (let i = 0; i < count; i++) {
      let drone = this._drones[i];
      if (!drone) {
        drone = {
          mesh: new THREE.Mesh(this._droneGeo, this._droneMat),
          phase: 0,
          fireT: 0,
          active: false,
          weapon: null,
        };
        drone.mesh.castShadow = false;
        this._droneGroup.add(drone.mesh);
        this._drones[i] = drone;
      }
      drone.active = true;
      drone.weapon = weapon;
      drone.phase = (i / count) * Math.PI * 2;
      drone.fireT = 0.25 + i * 0.12;
      drone.orbitRadius = d.orbitRadius || 6.5;
      drone.orbitSpeed = d.orbitSpeed || 1.9;
      drone.fireRate = d.droneFireRate || 4;
      drone.range = d.range || 320;
      drone.mesh.visible = true;
    }
  }

  _updateDrones(dt, elapsed) {
    if (!this._drones.length) return;
    const p = this.player;
    const anchor = p?.collider?.center || p?.root?.position;
    const target = this.targeting?.target || null;
    for (let i = 0; i < this._drones.length; i++) {
      const d = this._drones[i];
      if (!d || !d.active) continue;
      d.phase += d.orbitSpeed * dt;
      if (anchor) {
        d.mesh.position.set(
          anchor.x + Math.cos(d.phase) * d.orbitRadius,
          anchor.y + 3.2 + Math.sin(elapsed * 2 + d.phase) * 0.6,
          anchor.z + Math.sin(d.phase) * d.orbitRadius
        );
      }
      if (target && target.alive !== false) {
        if (target.getAimPoint) target.getAimPoint(_droneV);
        else _droneV.copy(target.collider?.center || target.root?.position || d.mesh.position);
        _droneD.subVectors(_droneV, d.mesh.position);
        const dist = _droneD.length();
        if (dist > 1e-3) {
          _droneD.multiplyScalar(1 / dist);
          d.mesh.quaternion.setFromUnitVectors(FORWARD, _droneD);
          d.fireT -= dt;
          if (d.fireT <= 0 && dist < d.range) {
            d.fireT += 1 / (d.fireRate || 4);
            // lead the target like any other slow round
            interceptPoint(d.mesh.position, _droneV, target.velocity || WORLD_UP, this._dronePdef.speed, _lead);
            _droneD.subVectors(_lead, d.mesh.position).normalize();
            this.projectiles?.spawn?.(this._dronePdef, d.mesh.position, _droneD, p, target);
            bus.emit(EV.SFX, { id: 'pod_fire', position: d.mesh.position });
          }
        }
      } else {
        d.mesh.rotation.y += dt * 1.4;
      }
    }
  }

  _stopDrones(weapon) {
    for (let i = 0; i < this._drones.length; i++) {
      const d = this._drones[i];
      if (!d || (weapon && d.weapon !== weapon)) continue;
      d.active = false;
      d.weapon = null;
      d.mesh.visible = false;
    }
  }

  // ================================================================== misc

  /** Restore ammo, heat and cooldowns across the build (mission restart / garage exit). */
  reset() {
    for (const k of SLOT_KEYS) this.slots[k]?.reset?.();
    for (let i = 0; i < MAX_SWINGS; i++) {
      const s = this._swings[i];
      s.active = false;
      s.weapon = null;
      s.hits.length = 0;
    }
    this._stopShield();
    this._stopDrones(null);
    const st = this.state;
    st.recoil = 0;
    st.meleeT = 0;
    st.charging = 0;
    for (const k of SLOT_KEYS) {
      st.kick[k] = 0;
      st.firing[k] = false;
      this._prevHeld[k] = false;
    }
  }

  dispose() {
    this._disposed = true;
    this._offBuild?.();
    this._offEquip?.();
    for (const k of SLOT_KEYS) {
      this.slots[k]?.dispose?.();
      this.slots[k] = null;
    }
    if (this._shieldMesh) {
      this._shieldMesh.parent?.remove(this._shieldMesh);
      this._shieldGeo?.dispose();
      this._shieldMat?.dispose();
      this._shieldMesh = null;
    }
    if (this._droneGroup) {
      this._droneGroup.parent?.remove(this._droneGroup);
      this._droneGeo?.dispose();
      this._droneMat?.dispose();
      this._droneGroup = null;
    }
    this._drones.length = 0;
    if (this.player && this.player.weaponState === this.state) this.player.weaponState = null;
  }
}

export default WeaponSystem;
