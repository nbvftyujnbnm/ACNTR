import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import * as M from '../core/MathUtils.js';

/**
 * Brain.js — the behaviour core shared by every hostile.
 *
 * Layout:
 *   Blackboard  per-agent working memory (perception results, timers, intent)
 *   Squad       shared blackboard: contact call-outs, attack tokens, volley gate,
 *               flank slot assignment. This is what stops the "wall of bullets".
 *   Steering    allocation-free steering primitives (seek/flee/strafe/orbit/
 *               separation/avoid) that accumulate into a desired-velocity vector.
 *   Brain       hierarchical state machine + perception + weapon rhythm + movement.
 *
 * Archetypes supply the *content* (states, stats, weapons); Brain supplies the
 * *capabilities*. Everything here is defensive — any cross-module call is
 * optional-chained because sibling systems boot in parallel.
 */

const GRAVITY = 24;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// module-scope scratch — nothing in the hot path allocates
// ---------------------------------------------------------------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _rad = new THREE.Vector3();
const _probeF = new THREE.Vector3();
const _probeT = new THREE.Vector3();
const _moveOut = { position: new THREE.Vector3(), grounded: false, normal: new THREE.Vector3(0, 1, 0), hitWall: false };
// Physics.moveCapsule works in capsule-CENTRE space (matching
// Entity.collider.center); mech roots are authored at the feet.
const _capsuleC = new THREE.Vector3();

/** Yaw such that the object's local -Z (mech forward) points along (dx,dz). */
export function yawTo(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/** Uniform random direction inside a cone of half-angle `spread` around `dir`. */
export function coneDir(out, dir, spread, rng) {
  out.copy(dir);
  if (spread <= 1e-5) return out.normalize();
  _upv.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.94) _upv.set(1, 0, 0);
  _right.crossVectors(dir, _upv).normalize();
  _upv.crossVectors(_right, dir).normalize();
  const a = rng() * TAU;
  const r = Math.tan(spread) * Math.sqrt(rng());
  out.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_upv, Math.sin(a) * r);
  return out.normalize();
}

// ---------------------------------------------------------------------------
// Blackboard
// ---------------------------------------------------------------------------

/** Per-agent working memory. Every field is preallocated; nothing is created per frame. */
export class Blackboard {
  constructor() {
    // --- perception ---
    this.awareness = 0; // 0 unaware .. 1 fully acquired
    this.alert = 0; // 0 idle, 1 alerted (heard something), 2 engaged
    this.hasLOS = false;
    this.losAge = 99; // seconds since the last successful LOS raycast
    this.distance = 999;
    this.horizDistance = 999;
    this.timeSinceSeen = 999;
    this.lastKnownPos = new THREE.Vector3();
    this.lastKnownVel = new THREE.Vector3();
    this.searchPos = new THREE.Vector3();
    this.toTarget = new THREE.Vector3(0, 0, -1); // normalized, agent -> target
    this.confidence = 0; // how trustworthy lastKnownPos is (decays)

    // --- aiming ---
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.bodyYaw = 0;
    this.aimPoint = new THREE.Vector3();
    this.aimError = Math.PI; // radians between muzzle forward and desired dir
    this.trackTime = 0; // how long we've held the target in the reticle (tightens spread)
    this.reactionTimer = 0; // must expire before the first shot

    // --- movement intent ---
    this.desired = new THREE.Vector3();
    this.strafeSign = 1;
    this.strafeTimer = 0;
    this.orbitRadius = 40;
    this.anchor = new THREE.Vector3(); // home / perch / holding position
    this.hasAnchor = false;
    this.grounded = false;
    this.hitWall = false;
    this.repathTimer = 0;
    this.avoidTimer = 0;
    this.avoidDir = new THREE.Vector3();
    this.avoidStrength = 0;

    // --- squad ---
    this.slotAngle = 0;
    this.hasToken = false;
    this.tokenTime = 0;
    this.tokenCooldown = 0;
    this.calloutStamp = -999;

    // --- reactivity ---
    this.threatDir = new THREE.Vector3();
    this.threatTime = -999; // when we last detected incoming fire
    this.threatUrgency = 0;
    this.dodgeCooldown = 0;
    this.dodgeTimer = 0;
    this.lockedOnMe = false;
    this.lockedTime = 0;
    this.staggerReactionDone = false;
    this.panic = 0;

    // --- energy (AC-class only) ---
    this.enRecovering = false;
  }

  /** Timers that always run, regardless of state. */
  tick(dt) {
    this.timeSinceSeen += dt;
    this.losAge += dt;
    this.confidence = Math.max(0, this.confidence - dt * 0.14);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.dodgeTimer = Math.max(0, this.dodgeTimer - dt);
    this.reactionTimer = Math.max(0, this.reactionTimer - dt);
    this.strafeTimer -= dt;
    this.repathTimer -= dt;
    this.avoidTimer -= dt;
    this.avoidStrength = Math.max(0, this.avoidStrength - dt * 2.2);
    this.panic = Math.max(0, this.panic - dt * 0.4);
  }
}

// ---------------------------------------------------------------------------
// Squad — the shared blackboard
// ---------------------------------------------------------------------------

export const SQUAD_DEFAULTS = {
  maxAttackers: 2, // hard cap on simultaneous committed attackers
  tokenHold: 3.4, // seconds a member may hold the attack token
  tokenRest: 1.8, // forced rest before it can hold one again
  volleyGap: 0.42, // minimum spacing between *heavy* attacks squad-wide
  calloutDelay: 0.65, // comms latency before a squadmate acts on a call-out
  calloutError: 7.5, // metres of positional error in a relayed contact
};

/**
 * A group of agents that coordinate. The two mechanics that matter:
 *
 *  - **attack tokens**: only `maxAttackers` members may commit to firing at once.
 *    Holders rotate on a timer so the pressure moves around the arena instead of
 *    one enemy locking the player down forever.
 *  - **volley gate**: even token holders must claim a squad-wide slot before a
 *    heavy attack (salvo, artillery, shotgun rush), which desynchronises burst
 *    fire so the player never eats four salvos in the same frame.
 */
export class Squad {
  constructor(id, opts) {
    this.id = id;
    this.members = [];
    this.maxAttackers = opts?.maxAttackers ?? SQUAD_DEFAULTS.maxAttackers;
    this.tokenHold = opts?.tokenHold ?? SQUAD_DEFAULTS.tokenHold;
    this.tokenRest = opts?.tokenRest ?? SQUAD_DEFAULTS.tokenRest;
    this.volleyGap = opts?.volleyGap ?? SQUAD_DEFAULTS.volleyGap;

    this.contactPos = new THREE.Vector3();
    this.contactVel = new THREE.Vector3();
    this.contactStamp = -999; // elapsed time of the last call-out
    this.contactConfidence = 0;
    this.volleyGate = 0;
    this.alerted = false;
    this._slotPhase = 0;
    this._rng = M.mulberry32((id * 2654435761) >>> 0);
  }

  add(agent) {
    if (this.members.indexOf(agent) >= 0) return;
    this.members.push(agent);
    agent.squad = this;
    this._assignSlots();
  }

  remove(agent) {
    const i = this.members.indexOf(agent);
    if (i >= 0) this.members.splice(i, 1);
    if (agent.squad === this) agent.squad = null;
    if (agent.bb) agent.bb.hasToken = false;
    this._assignSlots();
  }

  get aliveCount() {
    let n = 0;
    for (let i = 0; i < this.members.length; i++) if (this.members[i]?.alive) n++;
    return n;
  }

  /** Evenly spaced approach lanes so agents never converge on the same line. */
  _assignSlots() {
    const n = Math.max(1, this.members.length);
    for (let i = 0; i < this.members.length; i++) {
      const bb = this.members[i]?.bb;
      if (bb) bb.slotAngle = (i / n) * TAU;
    }
  }

  /** A member (or the damage system) reports where the player is. */
  reportContact(pos, vel, confidence, elapsed) {
    if (!pos) return;
    if (confidence < this.contactConfidence && elapsed - this.contactStamp < 0.5) return;
    this.contactPos.copy(pos);
    if (vel) this.contactVel.copy(vel);
    this.contactStamp = elapsed;
    this.contactConfidence = confidence;
    this.alerted = true;
  }

  /** Claim the squad-wide heavy-attack slot. Returns false if someone just fired. */
  requestVolley(weight) {
    if (this.volleyGate > 0) return false;
    this.volleyGate = this.volleyGap * (weight ?? 1);
    return true;
  }

  update(dt, elapsed) {
    this.volleyGate -= dt;
    this._slotPhase += dt * 0.11;
    this.contactConfidence = Math.max(0, this.contactConfidence - dt * 0.1);

    const members = this.members;
    let holders = 0;

    for (let i = 0; i < members.length; i++) {
      const a = members[i];
      const bb = a?.bb;
      if (!bb) continue;
      if (!a.alive) {
        bb.hasToken = false;
        continue;
      }
      if (bb.hasToken) {
        bb.tokenTime += dt;
        // Yield the token so the aggression rotates around the squad.
        if (bb.tokenTime > this.tokenHold || bb.awareness < 0.25) {
          bb.hasToken = false;
          bb.tokenCooldown = this.tokenRest * (0.7 + this._rng() * 0.8);
        } else holders++;
      } else {
        bb.tokenCooldown = Math.max(0, bb.tokenCooldown - dt);
      }
    }

    // Fill vacancies with the best available candidate (linear best-pick, no sort alloc).
    let vacancies = this.maxAttackers - holders;
    while (vacancies-- > 0) {
      let best = null;
      let bestScore = -1e9;
      for (let i = 0; i < members.length; i++) {
        const a = members[i];
        const bb = a?.bb;
        if (!a?.alive || !bb || bb.hasToken || bb.tokenCooldown > 0) continue;
        if (bb.awareness < 0.3) continue;
        if (a.stats?.staggered) continue;
        const score =
          (bb.hasLOS ? 120 : 0) + bb.awareness * 40 - bb.distance * 0.35 - (bb.panic > 0.4 ? 60 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = bb;
        }
      }
      if (!best) break;
      best.hasToken = true;
      best.tokenTime = 0;
    }
  }

  dispose() {
    for (let i = 0; i < this.members.length; i++) {
      const a = this.members[i];
      if (a && a.squad === this) a.squad = null;
    }
    this.members.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Steering — additive, allocation-free
// ---------------------------------------------------------------------------

export const Steering = {
  /** Straight at the target. */
  seek(out, from, to, speed) {
    _v0.subVectors(to, from);
    _v0.y = 0;
    const d = _v0.length();
    if (d < 1e-4) return out;
    out.addScaledVector(_v0, speed / d);
    return out;
  },

  /** Directly away. */
  flee(out, from, to, speed) {
    _v0.subVectors(from, to);
    _v0.y = 0;
    const d = _v0.length();
    if (d < 1e-4) return out;
    out.addScaledVector(_v0, speed / d);
    return out;
  },

  /** Pure lateral movement relative to the target. */
  strafe(out, from, to, speed, sign) {
    _v0.subVectors(to, from);
    _v0.y = 0;
    const d = _v0.length();
    if (d < 1e-4) return out;
    _v0.multiplyScalar(1 / d);
    out.x += -_v0.z * sign * speed;
    out.z += _v0.x * sign * speed;
    return out;
  },

  /**
   * Hold a ring at `radius` while circling. The radial term is proportional so
   * agents ease onto the ring instead of oscillating through it.
   */
  orbit(out, from, to, radius, speed, sign) {
    _rad.subVectors(from, to);
    _rad.y = 0;
    const d = _rad.length() || 1e-4;
    _rad.multiplyScalar(1 / d);
    _tan.set(-_rad.z * sign, 0, _rad.x * sign);
    const err = M.clamp((d - radius) / Math.max(radius * 0.45, 6), -1, 1);
    out.addScaledVector(_tan, speed * (1 - Math.abs(err) * 0.35));
    out.addScaledVector(_rad, -err * speed * 0.9);
    return out;
  },

  /** Push apart from nearby agents so a squad never stacks into one silhouette. */
  separation(out, agent, list, radius, strength) {
    const p = agent.root?.position;
    if (!p || !list) return out;
    const r2 = radius * radius;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === agent || !o?.alive) continue;
      const op = o.root?.position;
      if (!op) continue;
      const dx = p.x - op.x;
      const dz = p.z - op.z;
      const dy = p.y - op.y;
      const d2 = dx * dx + dz * dz + dy * dy * 0.35;
      if (d2 > r2 || d2 < 1e-5) continue;
      const d = Math.sqrt(d2);
      const w = (1 - d / radius) * strength;
      out.x += (dx / d) * w;
      out.z += (dz / d) * w;
      // vertical separation matters for flyers stacking in a column
      if (Math.abs(dy) < radius * 0.5) out.y += (dy >= 0 ? 1 : -1) * w * 0.35;
    }
    return out;
  },

  /**
   * Cheap whisker avoidance: three short rays. Returns the strength of the
   * avoidance found (0 = clear) and writes a lateral escape direction.
   */
  probe(physics, origin, forward, dist, outDir) {
    if (!physics?.raycast) return 0;
    let strength = 0;
    outDir.set(0, 0, 0);
    // `forward` may alias a caller scratch vector — copy it before we touch any
    _probeF.copy(forward);
    for (let i = -1; i <= 1; i++) {
      const a = i * 0.45;
      const c = Math.cos(a);
      const s = Math.sin(a);
      _dir.set(_probeF.x * c - _probeF.z * s, 0, _probeF.x * s + _probeF.z * c).normalize();
      const hit = physics.raycast(origin, _dir, dist);
      if (!hit || (hit.hit === false && !hit.point)) continue;
      const hd = hit.distance ?? dist;
      const w = 1 - M.clamp(hd / dist, 0, 1);
      if (w <= strength && i !== 0) continue;
      strength = Math.max(strength, w * (i === 0 ? 1.25 : 0.8));
      // slide along the surface rather than bouncing off it
      const n = hit.normal;
      if (n) {
        _probeT.set(-n.z, 0, n.x);
        if (_probeT.dot(_probeF) < 0) _probeT.multiplyScalar(-1);
        outDir.add(_probeT);
      } else {
        outDir.x += -_dir.z * (i >= 0 ? 1 : -1);
        outDir.z += _dir.x * (i >= 0 ? 1 : -1);
      }
    }
    if (outDir.lengthSq() > 1e-6) outDir.normalize();
    return M.clamp(strength, 0, 1);
  },
};

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

/**
 * The per-agent controller. Owns the state machine, perception, weapon rhythm
 * and movement integration; archetypes plug in states and tuning.
 */
export class Brain {
  /**
   * @param {object} agent  the Entity created by EnemyManager
   * @param {object} ctx    { manager, physics, level, arch, rng }
   */
  constructor(agent, ctx) {
    this.agent = agent;
    this.manager = ctx?.manager || null;
    this.physics = ctx?.physics || null;
    this.level = ctx?.level || null;
    this.arch = ctx?.arch || null;
    this.rng = ctx?.rng || Math.random;

    this.bb = new Blackboard();
    agent.bb = this.bb;

    this.state = 'idle';
    this.prevState = '';
    this.stateTime = 0;
    this.elapsed = 0;

    // LOD: 0 = every frame, 1 = 40 Hz, 2 = ~14 Hz
    this.lod = 0;
    this.tickInterval = 0;
    this._acc = 0;
    this.thinkTimer = 0;
    this.thinkInterval = this.arch?.reaction?.think ?? 0.12;

    // tier-scaled speed; archetypes may override at runtime (boss phases)
    this.speedMul = ctx?.speedMul ?? this.arch?.combat?.speedMul ?? 1;

    // per-agent weapon runtime state — defs are tier-scaled clones from Archetypes
    this.weapons = [];
    const defs = ctx?.weapons || this.arch?.weapons;
    if (defs) {
      for (let i = 0; i < defs.length; i++) {
        this.weapons.push({
          def: defs[i],
          cd: this.rng() * 0.8,
          burstLeft: 0,
          burstTimer: 0,
          telegraph: 0,
          charge: 0,
          charging: false,
          shotIndex: 0,
          lastFired: -999,
        });
      }
    }

    // scratch that must persist between ticks
    this._losGranted = false;
    this._losTimer = this.rng() * 0.2;
    this._muzzle = new THREE.Vector3();
    this._aimDir = new THREE.Vector3(0, 0, -1);
    this._shotDir = new THREE.Vector3();
    this._telegraphHandle = null;
    this._boostOn = false;
    this._boostIntensity = 0;
    this._boostReq = 0;
    this.memory = Object.create(null); // free-form archetype scratch (phase, counters)
  }

  // -- convenience -----------------------------------------------------------

  get player() {
    return this.manager?.player || null;
  }
  get stats() {
    return this.agent?.stats;
  }
  get pos() {
    return this.agent.root.position;
  }

  /** Eye/sensor position — a bit above the capsule centre. */
  eye(out) {
    const c = this.agent.collider;
    out.copy(this.agent.root.position);
    out.y += (c?.height ?? 8) * 0.78;
    return out;
  }

  /** World position of a named hardpoint, with a sane fallback if the rig is absent. */
  muzzlePos(name, out) {
    const hp = this.agent.hardpoints?.[name];
    if (hp) {
      this.agent.root.updateMatrixWorld(true);
      out.setFromMatrixPosition(hp.matrixWorld);
      return out;
    }
    const c = this.agent.collider;
    out.copy(this.agent.root.position);
    out.y += (c?.height ?? 8) * 0.68;
    const yaw = this.bb.bodyYaw;
    out.x += -Math.sin(yaw) * 1.6;
    out.z += -Math.cos(yaw) * 1.6;
    return out;
  }

  /**
   * Toggle the boost plume. Deduplicated: VFX only hears about real changes, so
   * archetype states can call this every tick without spamming the VFX pool.
   */
  setBoost(intensity) {
    this._boostReq = Math.max(this._boostReq, intensity ?? 1);
  }

  _applyBoost(on, intensity) {
    if (on === this._boostOn && Math.abs(intensity - this._boostIntensity) < 0.3) return;
    this._boostOn = on;
    this._boostIntensity = intensity;
    this.manager?.vfx?.boostFlame?.(this.agent.hardpoints?.core || this.agent.root, on, intensity);
  }

  setState(name) {
    if (this.state === name) return;
    const states = this.arch?.states;
    states?.[this.state]?.exit?.(this);
    this.prevState = this.state;
    this.state = name;
    this.stateTime = 0;
    states?.[name]?.enter?.(this);
  }

  // -- main tick -------------------------------------------------------------

  /**
   * Called every frame by EnemyManager. Internally rate-limited by LOD so distant
   * agents do a fraction of the work while still moving plausibly.
   */
  update(dt, elapsed) {
    this.elapsed = elapsed;
    this._acc += dt;
    if (this._acc < this.tickInterval) return;
    const step = Math.min(this._acc, 0.2);
    this._acc = 0;

    const agent = this.agent;
    if (!agent.alive) return;

    const bb = this.bb;
    bb.tick(step);
    this.stateTime += step;

    this._perceive(step);
    this._energy(step);

    // ---- global overrides (they outrank whatever the archetype wants) ----
    if (this.stats?.staggered) {
      if (this.state !== 'staggered') {
        this.arch?.onStagger?.(this);
        this.setState('staggered');
      }
    } else if (this.state === 'staggered') {
      bb.staggerReactionDone = false;
      this.setState(this.arch?.initial || 'idle');
      bb.reactionTimer = Math.max(bb.reactionTimer, (this.arch?.reaction?.afterStagger ?? 0.35));
    }

    // ---- think at reaction cadence, not every frame ----
    this.thinkTimer -= step;
    if (this.thinkTimer <= 0 && this.state !== 'staggered') {
      this.thinkTimer = this.thinkInterval * (0.85 + this.rng() * 0.3);
      this.arch?.think?.(this, this.thinkInterval);
    }

    // ---- run the active state ----
    bb.desired.set(0, 0, 0);
    this.arch?.states?.[this.state]?.update?.(this, step);

    this._reactivity(step);
    this._weapons(step);
    this._aim(step);
    this._move(step);
  }

  // -- perception ------------------------------------------------------------

  _perceive(dt) {
    const bb = this.bb;
    const p = this.player;
    const per = this.arch?.perception;
    if (!p?.root) {
      bb.awareness = Math.max(0, bb.awareness - dt * 0.5);
      return;
    }

    const pp = p.root.position;
    const ap = this.agent.root.position;
    const dx = pp.x - ap.x;
    const dy = pp.y - ap.y;
    const dz = pp.z - ap.z;
    bb.horizDistance = Math.sqrt(dx * dx + dz * dz);
    bb.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const inv = 1 / Math.max(bb.distance, 1e-4);
    bb.toTarget.set(dx * inv, dy * inv, dz * inv);

    const range = per?.range ?? 220;
    const fov = per?.fov ?? 1.35; // half-angle, radians
    const closeSense = per?.close ?? 22;

    // cheap gate first — angle test costs nothing compared to a raycast
    let inCone = false;
    if (bb.distance <= range) {
      const fy = -Math.sin(bb.bodyYaw);
      const fz = -Math.cos(bb.bodyYaw);
      const dot = fy * bb.toTarget.x + fz * bb.toTarget.z;
      inCone = dot > Math.cos(fov) || bb.distance < closeSense;
    }

    // Raycast LOS only when the manager granted us a slot this frame.
    this._losTimer -= dt;
    if (inCone && this._losGranted) {
      this._losGranted = false;
      this._losTimer = (per?.losInterval ?? 0.12) * (1 + this.lod);
      bb.hasLOS = this._raycastLOS(pp);
      bb.losAge = 0;
    } else if (!inCone) {
      // release an unused grant so agents facing away can't starve the budget
      if (this._losGranted) {
        this._losGranted = false;
        this._losTimer = 0.3;
      }
      if (bb.losAge > 0.6) bb.hasLOS = false;
    }

    const seeing = inCone && bb.hasLOS && bb.losAge < 0.8;
    if (seeing) {
      const gain = per?.acquire ?? 2.2;
      // acquiring is slower at extreme range — no instant cross-arena snap
      const rangeFactor = 1 - M.clamp(bb.distance / range, 0, 1) * 0.55;
      bb.awareness = Math.min(1, bb.awareness + dt * gain * rangeFactor);
      bb.timeSinceSeen = 0;
      bb.lastKnownPos.copy(pp);
      if (p.velocity) bb.lastKnownVel.copy(p.velocity);
      bb.confidence = 1;
      if (bb.awareness > 0.5) {
        bb.alert = 2;
        this.agent.squad?.reportContact(pp, p.velocity, 1, this.elapsed);
      }
    } else {
      // Memory decay: they keep believing for a while, then start searching.
      const hold = per?.memory ?? 5.5;
      if (bb.timeSinceSeen > hold) bb.awareness = Math.max(0, bb.awareness - dt * (per?.forget ?? 0.32));
      // dead-reckon the last known position for a short while
      if (bb.timeSinceSeen < 1.6) bb.lastKnownPos.addScaledVector(bb.lastKnownVel, dt * 0.6);
      this._consumeCallout();
    }
  }

  _raycastLOS(targetPos) {
    if (!this.physics?.raycast) return true; // physics not ready — don't cripple the AI
    this.eye(_v0);
    _v1.subVectors(targetPos, _v0);
    _v1.y += 3.5; // aim for the torso, not the feet
    const dist = _v1.length();
    if (dist < 1e-3) return true;
    _v1.multiplyScalar(1 / dist);
    const hit = this.physics.raycast(_v0, _v1, dist - 1.2);
    if (!hit) return true;
    if (hit.hit === false) return true;
    const hd = hit.distance ?? dist;
    return hd >= dist - 1.5;
  }

  /** Act on a squadmate's radio call after comms latency, with positional error. */
  _consumeCallout() {
    const sq = this.agent.squad;
    const bb = this.bb;
    if (!sq || sq.contactStamp < 0) return;
    const age = this.elapsed - sq.contactStamp;
    if (age < SQUAD_DEFAULTS.calloutDelay) return;
    if (sq.contactStamp <= bb.calloutStamp) return;
    bb.calloutStamp = sq.contactStamp;
    const e = SQUAD_DEFAULTS.calloutError;
    bb.lastKnownPos.set(
      sq.contactPos.x + (this.rng() - 0.5) * e,
      sq.contactPos.y,
      sq.contactPos.z + (this.rng() - 0.5) * e
    );
    bb.lastKnownVel.copy(sq.contactVel);
    bb.confidence = Math.max(bb.confidence, 0.55);
    // Relayed intel makes them *look*, it does not make them omniscient.
    bb.awareness = Math.max(bb.awareness, 0.42);
    if (bb.alert < 1) bb.alert = 1;
  }

  /** External alert (gunfire heard, took damage). `certainty` 0..1. */
  alertTo(pos, certainty, vel) {
    const bb = this.bb;
    bb.awareness = Math.max(bb.awareness, certainty);
    if (bb.alert < 1) bb.alert = 1;
    if (certainty > 0.7) bb.alert = 2;
    if (pos) {
      const e = (1 - certainty) * 14;
      bb.lastKnownPos.set(pos.x + (this.rng() - 0.5) * e, pos.y, pos.z + (this.rng() - 0.5) * e);
      bb.confidence = Math.max(bb.confidence, certainty);
      if (vel) bb.lastKnownVel.copy(vel);
    }
    if (bb.timeSinceSeen > 3) bb.timeSinceSeen = 3;
  }

  // -- energy ---------------------------------------------------------------

  _energy(dt) {
    const s = this.stats;
    if (!s || !s.enMax) return;
    const rate = this.arch?.move?.enRecharge ?? 900;
    if (this.bb.enRecovering) {
      s.en = Math.min(s.enMax, s.en + rate * 0.55 * dt);
      if (s.en >= s.enMax * 0.85) this.bb.enRecovering = false;
    } else {
      s.en = Math.min(s.enMax, s.en + rate * dt);
    }
  }

  /** Spend energy; returns false (and flags recovery) if the agent is tapped out. */
  spendEN(amount) {
    const s = this.stats;
    if (!s || !s.enMax) return true;
    if (this.bb.enRecovering) return false;
    if (s.en < amount) {
      s.en = 0;
      this.bb.enRecovering = true;
      bus.emit(EV.EN_EMPTY, { entity: this.agent });
      return false;
    }
    s.en -= amount;
    return true;
  }

  // -- reactivity ------------------------------------------------------------

  _reactivity(dt) {
    const bb = this.bb;
    const react = this.arch?.reaction;
    if (!react) return;

    // is the player's reticle sitting on us?
    bb.lockedOnMe = this.manager?.lockedTarget === this.agent;
    if (bb.lockedOnMe) bb.lockedTime += dt;
    else bb.lockedTime = Math.max(0, bb.lockedTime - dt * 1.5);

    // incoming fire?
    if (react.dodge && bb.dodgeCooldown <= 0 && !this.stats?.staggered) {
      const urgency = this.manager?.threatToward(this.agent, bb.threatDir) ?? 0;
      const lockPressure = bb.lockedTime > (react.lockPatience ?? 1.5) ? 0.55 : 0;
      const trigger = Math.max(urgency, lockPressure);
      if (trigger > (react.dodgeThreshold ?? 0.4) && this.rng() < (react.dodgeChance ?? 0.85)) {
        this.quickBoost(bb.threatDir, urgency > 0 ? 1 : 0.7);
      }
    }
  }

  /**
   * Quick boost perpendicular to `awayFrom` (a direction pointing at us). Costs EN.
   * This is the AC-class dodge — visible, brief, on a cooldown, never spammable.
   */
  quickBoost(awayFrom, scale) {
    const react = this.arch?.reaction;
    const move = this.arch?.move;
    const bb = this.bb;
    if (bb.dodgeCooldown > 0) return false;
    const cost = move?.qbCost ?? 0;
    if (cost > 0 && !this.spendEN(cost)) return false;

    // Perpendicular in XZ, biased to whichever side has more room.
    _v2.set(awayFrom?.x || bb.toTarget.x, 0, awayFrom?.z || bb.toTarget.z);
    if (_v2.lengthSq() < 1e-5) _v2.set(1, 0, 0);
    _v2.normalize();
    let sign = this.rng() < 0.5 ? -1 : 1;
    _v3.set(-_v2.z * sign, 0, _v2.x * sign);
    // don't dodge into a wall
    if (this.physics?.raycast) {
      this.eye(_v0);
      const hit = this.physics.raycast(_v0, _v3, 14);
      if (hit && (hit.hit !== false) && (hit.distance ?? 99) < 12) {
        sign = -sign;
        _v3.set(-_v2.z * sign, 0, _v2.x * sign);
      }
    }
    const thrust = (move?.qbThrust ?? 26) * (scale ?? 1);
    this.agent.velocity.addScaledVector(_v3, thrust);
    if (move?.hover) this.agent.velocity.y += thrust * 0.16;

    bb.dodgeCooldown = (react?.dodgeCooldown ?? 1.2) * (0.85 + this.rng() * 0.4);
    bb.dodgeTimer = 0.28;
    bus.emit(EV.QUICK_BOOST, { entity: this.agent, direction: _v3 });
    this.setBoost(1.6);
    return true;
  }

  // -- aiming ----------------------------------------------------------------

  /** Set the point the agent wants its guns on. States call this each tick. */
  aimAtPoint(p) {
    this.bb.aimPoint.copy(p);
  }

  /**
   * Predictive aim for a given weapon, written into `out`. Applies imperfect lead
   * (agents systematically under-lead a bit) so they are readable and beatable.
   */
  solveAim(def, from, out) {
    const p = this.player;
    const bb = this.bb;
    const targetPos = _v4;
    if (p?.getAimPoint) p.getAimPoint(targetPos);
    else if (p?.root) targetPos.copy(p.root.position).setY(p.root.position.y + 4);
    else targetPos.copy(bb.lastKnownPos);

    // If we can't see them, shoot at where we believe they are, not where they are.
    if (!bb.hasLOS || bb.timeSinceSeen > 0.35) targetPos.copy(bb.lastKnownPos).setY(bb.lastKnownPos.y + 4);

    const speed = def?.speed ?? 200;
    const vel = p?.velocity || bb.lastKnownVel;
    if (def?.arc) {
      // ballistic weapons lead on the ground plane and let the launcher solve pitch
      M.interceptPoint(from, targetPos, vel, speed * 0.85, out);
    } else {
      M.interceptPoint(from, targetPos, vel, speed, out);
    }
    // scale the lead correction down: perfect prediction feels like an aimbot
    const acc = def?.leadAccuracy ?? 0.75;
    out.sub(targetPos).multiplyScalar(acc * M.clamp(bb.confidence, 0.3, 1)).add(targetPos);
    return out;
  }

  /**
   * Effective spread for a weapon: widens with player speed and range,
   * tightens the longer this agent has been tracking, and never reaches zero.
   */
  spreadFor(def) {
    const bb = this.bb;
    const arch = this.arch;
    const base = (def?.spread ?? 0.03) * (arch?.combat?.accuracyMul ?? 1);
    const pSpeed = this.manager?.playerSpeed ?? 0;
    const speedPen = 1 + M.clamp(pSpeed / 45, 0, 1.3) * (arch?.combat?.speedPenalty ?? 1.25);
    const tighten = 1 - M.clamp(bb.trackTime / (def?.tightenTime ?? 2.2), 0, 1) * 0.55;
    const rangePen = 1 + M.clamp(bb.distance / (def?.range ?? 120), 0, 1.4) * 0.35;
    const panic = 1 + bb.panic * 0.8;
    return Math.max(0.004, base * speedPen * tighten * rangePen * panic);
  }

  _aim(dt) {
    const bb = this.bb;
    const move = this.arch?.move;
    // default aim: at whatever we believe the target is
    if (bb.aimPoint.lengthSq() < 1e-6) bb.aimPoint.copy(bb.lastKnownPos);

    this.eye(_v0);
    _v1.subVectors(bb.aimPoint, _v0);
    const len = _v1.length();
    if (len > 1e-4) {
      _v1.multiplyScalar(1 / len);
      const wantYaw = yawTo(_v1.x, _v1.z);
      const wantPitch = Math.asin(M.clamp(_v1.y, -1, 1));
      const rate = (move?.turnRate ?? 3.4) * (this.stats?.staggered ? 0.15 : 1);
      const before = bb.aimYaw;
      bb.aimYaw = M.dampAngle(bb.aimYaw, wantYaw, rate, dt);
      bb.aimPitch = M.damp(bb.aimPitch, wantPitch, rate * 1.2, dt);
      bb.aimError = Math.abs(M.shortestAngle(bb.aimYaw, wantYaw)) + Math.abs(bb.aimPitch - wantPitch) * 0.6;
      // torso leads, hull follows — reads as an AC6 mech, not a turret
      bb.bodyYaw = M.dampAngle(bb.bodyYaw, bb.aimYaw, rate * (move?.bodyTurnMul ?? 0.62), dt);
      if (Math.abs(M.shortestAngle(before, bb.aimYaw)) < 0.02 && bb.aimError < 0.14) bb.trackTime += dt;
      else bb.trackTime = Math.max(0, bb.trackTime - dt * 1.5);
    }

    this._aimDir.set(-Math.sin(bb.aimYaw) * Math.cos(bb.aimPitch), Math.sin(bb.aimPitch), -Math.cos(bb.aimYaw) * Math.cos(bb.aimPitch));
    this.agent.root.rotation.y = bb.bodyYaw;
  }

  // -- weapons ---------------------------------------------------------------

  /**
   * Request a shot from weapon `i`. Honours reaction delay, squad tokens, the
   * squad volley gate, LOS and aim error. Returns true if the fire sequence began.
   */
  requestFire(i, opts) {
    const w = this.weapons[i];
    if (!w) return false;
    const def = w.def;
    const bb = this.bb;
    if (w.cd > 0 || w.burstLeft > 0 || w.telegraph > 0 || w.charging) return false;
    if (bb.reactionTimer > 0) return false;
    if (bb.distance > (def.range ?? 140) * (opts?.rangeMul ?? 1)) return false;
    if (bb.distance < (def.minRange ?? 0)) return false;
    if (!def.indirect && !bb.hasLOS && !opts?.ignoreLOS) return false;
    if (bb.aimError > (def.aimTolerance ?? 0.22) && !opts?.ignoreAim) return false;

    // squad discipline
    if (!opts?.ignoreToken && this.arch?.combat?.useTokens !== false) {
      if (!bb.hasToken && !def.suppressive) return false;
    }
    if (def.heavy) {
      const sq = this.agent.squad;
      if (sq && !sq.requestVolley(def.volleyWeight ?? 1)) return false;
    }

    if (def.charge > 0) {
      w.charging = true;
      w.charge = 0;
      this.arch?.onChargeStart?.(this, w);
    } else {
      w.telegraph = def.telegraph ?? 0;
      if (w.telegraph > 0) this.arch?.onTelegraph?.(this, w);
    }
    if (w.telegraph <= 0 && !w.charging) {
      w.burstLeft = def.burst ?? 1;
      w.burstTimer = 0;
      w.shotIndex = 0;
    }
    return true;
  }

  _weapons(dt) {
    const bb = this.bb;
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w.cd > 0) w.cd -= dt;

      if (w.charging) {
        w.charge += dt;
        this.arch?.onCharging?.(this, w, w.charge / (w.def.charge || 1));
        if (w.charge >= w.def.charge) {
          w.charging = false;
          w.charge = 0;
          w.burstLeft = w.def.burst ?? 1;
          w.burstTimer = 0;
          w.shotIndex = 0;
          this.arch?.onChargeEnd?.(this, w);
        }
        continue;
      }

      if (w.telegraph > 0) {
        w.telegraph -= dt;
        if (w.telegraph <= 0) {
          w.burstLeft = w.def.burst ?? 1;
          w.burstTimer = 0;
          w.shotIndex = 0;
        }
        continue;
      }

      if (w.burstLeft > 0) {
        w.burstTimer -= dt;
        if (w.burstTimer <= 0) {
          this._shoot(w);
          w.burstLeft--;
          w.burstTimer = w.def.burstInterval ?? 0.09;
          if (w.burstLeft <= 0) {
            // jitter the reload so a squad never re-syncs into a single volley
            w.cd = (w.def.cooldown ?? 1.2) * (0.78 + this.rng() * 0.5);
          }
        }
      }
    }
  }

  _shoot(w) {
    const def = w.def;
    const agent = this.agent;
    const bb = this.bb;
    const hp = def.hardpoint || 'rArm';
    this.muzzlePos(hp, this._muzzle);
    this.solveAim(def, this._muzzle, _v5);

    _v2.subVectors(_v5, this._muzzle);
    if (def.arc) {
      // lob: raise the launch pitch so the shell travels a visible arc
      const flat = Math.sqrt(_v2.x * _v2.x + _v2.z * _v2.z);
      _v2.y = Math.max(_v2.y, 0) + flat * (def.arcHeight ?? 0.55);
    }
    const l = _v2.length() || 1;
    _v2.multiplyScalar(1 / l);

    // first round of a burst is looser — the "settling" shot
    const settle = w.shotIndex === 0 ? 1.35 : 1;
    let spread = this.spreadFor(def) * settle;
    if (def.pellets > 1) spread = def.spread; // shotgun pattern is the weapon, not error

    const count = def.pellets ?? 1;
    for (let p = 0; p < count; p++) {
      coneDir(this._shotDir, _v2, count > 1 ? def.spread : spread, this.rng);
      this.manager?.spawnProjectile?.(def, this._muzzle, this._shotDir, agent, def.homing ? this.player : null);
    }

    w.shotIndex++;
    w.lastFired = this.elapsed;
    bb.trackTime = Math.max(0, bb.trackTime - 0.1);

    this.manager?.vfx?.muzzleFlash?.(this._muzzle, _v2, def.flashScale ?? 1, def.color ?? 0xffcc88);
    bus.emit(EV.WEAPON_FIRED, {
      entity: agent,
      owner: agent,
      def,
      weapon: def.id,
      origin: this._muzzle,
      direction: _v2,
      position: this._muzzle,
    });
    this.arch?.onShot?.(this, w);
  }

  /** True while any weapon is winding up — used by states to hold position. */
  isBusy() {
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w.telegraph > 0 || w.charging || w.burstLeft > 0) return true;
    }
    return false;
  }

  weaponByIndex(i) {
    return this.weapons[i];
  }

  // -- movement --------------------------------------------------------------

  /** Convenience: fill `bb.desired` with a standard combat orbit around a point. */
  combatSteer(centre, radius, speed, dt) {
    const bb = this.bb;
    if (bb.strafeTimer <= 0) {
      bb.strafeSign = this.rng() < 0.5 ? -1 : 1;
      bb.strafeTimer = 1.1 + this.rng() * 2.2;
    }
    Steering.orbit(bb.desired, this.pos, centre, radius, speed, bb.strafeSign);
    // slot offset keeps squadmates on separate lanes around the target
    const slot = bb.slotAngle + (this.agent.squad?._slotPhase ?? 0);
    _v1.set(Math.cos(slot), 0, Math.sin(slot)).multiplyScalar(speed * 0.22);
    bb.desired.add(_v1);
    Steering.separation(bb.desired, this.agent, this.manager?.list, this.arch?.move?.separation ?? 11, speed * 0.9);
    this._avoid(dt, speed);
  }

  _avoid(dt, speed) {
    const bb = this.bb;
    if (this.lod > 1) return;
    if (bb.avoidTimer <= 0 && this.manager?.spendRay?.()) {
      bb.avoidTimer = 0.18 + this.rng() * 0.1;
      _v1.copy(bb.desired);
      _v1.y = 0;
      if (_v1.lengthSq() > 1e-4) {
        _v1.normalize();
        this.eye(_v0);
        _v0.y -= (this.agent.collider?.height ?? 8) * 0.35;
        const look = M.clamp(speed * 0.55, 8, 26);
        bb.avoidStrength = Steering.probe(this.physics, _v0, _v1, look, bb.avoidDir);
      }
    }
    if (bb.avoidStrength > 0.01) bb.desired.addScaledVector(bb.avoidDir, speed * bb.avoidStrength * 1.4);
  }

  _move(dt) {
    const agent = this.agent;
    const bb = this.bb;
    const move = this.arch?.move || {};
    const v = agent.velocity;
    const staggerMul = this.stats?.staggered ? 0.08 : 1;

    // clamp desire to the archetype's top speed
    _v1.copy(bb.desired);
    const hover = !!move.hover;
    if (!hover) _v1.y = 0;
    const maxS = (move.speed ?? 14) * this.speedMul * staggerMul;
    const dl = _v1.length();
    if (dl > maxS) _v1.multiplyScalar(maxS / dl);

    // keep everyone inside the arena
    const arena = this.level?.arenaRadius;
    if (arena) {
      const p = agent.root.position;
      const r = Math.sqrt(p.x * p.x + p.z * p.z);
      if (r > arena * 0.94) {
        const push = (r - arena * 0.94) * 0.6;
        _v1.x -= (p.x / (r || 1)) * push * maxS * 0.4;
        _v1.z -= (p.z / (r || 1)) * push * maxS * 0.4;
      }
    }

    // boost plume follows demanded speed unless a state asked for more
    const boosting = this._boostReq > 0 || dl > maxS * 0.6;
    this._applyBoost(boosting && !this.stats?.staggered, Math.max(this._boostReq, 1));
    this._boostReq = 0;

    const accel = (move.accel ?? 9) * staggerMul;
    v.x = M.damp(v.x, _v1.x, accel, dt);
    v.z = M.damp(v.z, _v1.z, accel, dt);

    if (hover) {
      v.y = M.damp(v.y, _v1.y, (move.vertAccel ?? 5) * staggerMul, dt);
      if (this.stats?.staggered) v.y -= GRAVITY * 0.45 * dt; // staggered flyers sag
    } else {
      v.y -= GRAVITY * dt;
      if (v.y < -70) v.y = -70;
    }

    const c = agent.collider;
    const r = c?.radius ?? 2.2;
    const h = c?.height ?? 8;
    const pos = agent.root.position;

    if (this.physics?.moveCapsule) {
      // feet -> centre for the solver, then back again.
      const halfH = h * 0.5;
      _capsuleC.set(pos.x, pos.y + halfH, pos.z);
      const res = this.physics.moveCapsule(_capsuleC, v, r, h, dt, _moveOut) || _moveOut;
      const rp = res.position || _capsuleC;
      pos.set(rp.x, rp.y - halfH, rp.z);
      bb.grounded = !!res.grounded;
      bb.hitWall = !!res.hitWall;
      if (bb.grounded && v.y < 0) v.y = 0;
    } else {
      pos.addScaledVector(v, dt);
      const g = this.physics?.groundHeight?.(pos.x, pos.z) ?? 0;
      if (!hover && pos.y <= g) {
        pos.y = g;
        v.y = 0;
        bb.grounded = true;
      } else bb.grounded = false;
    }

    if (hover) {
      // hover units hold an altitude band above whatever is under them
      const g = this.physics?.groundHeight?.(pos.x, pos.z) ?? 0;
      const floor = g + (move.minAltitude ?? 6);
      if (pos.y < floor) {
        pos.y = M.damp(pos.y, floor, 8, dt);
        if (v.y < 0) v.y *= 0.2;
      }
    }

    // world-space collider centre, kept fresh for damage/targeting
    if (c) {
      c.center.set(pos.x, pos.y + h * 0.5, pos.z);
    }

    // drive the procedural rig if the factory supplied one
    const rig = agent.mesh?.rig || agent.rig;
    if (rig?.update && this.lod < 2) {
      const st = this._rigState || (this._rigState = {
        velocity: agent.velocity,
        grounded: false,
        boosting: false,
        quickBoost: false,
        aimYaw: 0,
        aimPitch: 0,
        speed: 0,
        staggered: false,
      });
      st.velocity = agent.velocity;
      st.grounded = bb.grounded;
      st.boosting = dl > maxS * 0.7;
      st.quickBoost = bb.dodgeTimer > 0;
      st.aimYaw = bb.aimYaw;
      st.aimPitch = bb.aimPitch;
      st.speed = Math.sqrt(v.x * v.x + v.z * v.z);
      st.staggered = !!this.stats?.staggered;
      rig.update(dt, st);
    }
  }

  dispose() {
    this.weapons.length = 0;
    this.manager = null;
    this.physics = null;
    this.level = null;
    this._telegraphHandle = null;
  }
}

export default Brain;
