import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import * as M from '../core/MathUtils.js';

/**
 * TargetingSystem — AC6 soft lock / hard lock.
 *
 * Soft lock continuously elects the best on-screen candidate (nearest to the
 * crosshair, with world distance, line-of-sight and hysteresis folded in).
 * Hard lock (Tab) latches that candidate: the reticle then tracks it in screen
 * space, weapons lead it, and the camera frames both mechs.
 *
 * `lockProgress` is the reticle convergence ring — it fills while the crosshair
 * sits on a target and drains when it slides off. Homing ordnance should only
 * commit at 1.0.
 *
 * Everything here is allocation-free per frame: candidate records are pooled and
 * `screenPos()` writes into a caller-supplied out object (the HUD calls it once
 * per target per frame).
 */

const _v = new THREE.Vector3();
const _camSpace = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _rayOut = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null };

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * In-place insertion sort by ascending score. Array#sort allocates scratch in
 * V8; this runs every frame over a handful of records, so it must not.
 */
function sortByScore(a) {
  for (let i = 1; i < a.length; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= 0 && a[j].score > v.score) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

export const DEFAULT_LOCK = {
  maxRange: 500, // hard-lock break distance
  softRange: 620, // soft-lock consideration distance
  coneRadius: 0.42, // NDC radius (vertical units) of the soft-lock cone
  convergeRadius: 0.14, // crosshair proximity that fills lockProgress
  lockTime: 0.45, // seconds crosshair-on-target to full convergence
  unlockTime: 0.3, // seconds to drain
  hysteresis: 0.72, // incumbent's score multiplier — must be clearly beaten
  switchDelay: 0.12, // minimum time between soft-target switches
  wScreen: 1.0,
  wDistance: 0.34,
  wOcclusion: 0.55,
  occludeBreak: 1.5, // seconds of no LOS before a hard lock drops
  losInterval: 0.12, // seconds between LOS probes (one ray per tick, round robin)
  aimConvergeMin: 60, // fallback convergence distance when nothing is locked
  aimConvergeMax: 300,
};

export class TargetingSystem {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} player Entity
   */
  constructor(camera, player) {
    this.camera = camera;
    this.player = player;
    this.physics = null;

    this.cfg = Object.assign({}, DEFAULT_LOCK);

    /** LIVE array reference handed over by EnemyManager — never copied. */
    this.targets = null;

    /** @type {object|null} the effective target (hard lock, else soft lock) */
    this.target = null;
    /** @type {object|null} */
    this.softTarget = null;
    this.hardLock = false;
    this.lockProgress = 0;

    /** Sorted on-screen candidates for the HUD's target boxes. */
    this.candidates = [];
    this._pool = [];

    /** Reticle position in normalised screen space (tracks the target when locked). */
    this.reticle = { x: 0.5, y: 0.5, visible: true, locked: false };

    this._switchTimer = 0;
    this._occluded = 0;
    this._losTimer = 0;
    this._losIndex = 0;
    this._losMap = new Map();
    this._pruneTimer = 0;

    this._lastEmitTarget = null;
    this._lastEmitHard = false;
    this._lastEmitProgress = 0;

    // reusable aim ray / lead point outputs
    this._aimRay = {
      origin: new THREE.Vector3(),
      direction: new THREE.Vector3(0, 0, -1),
      point: new THREE.Vector3(),
      distance: 0,
      target: null,
      converged: false,
    };
    this._leadOut = new THREE.Vector3();
    this._scratchScreen = { x: 0.5, y: 0.5, visible: false, depth: 0, dist: 0, behind: false };

    // Nothing else in the contract owns the Tab key, so the lock toggle lives
    // here. `toggleHardLock()` is debounced, so a sibling system wiring Tab as
    // well cannot produce a double toggle.
    this._toggleStamp = -1;
    this.input = null;
    this._onKey = (e) => {
      if (e.code !== 'Tab' || e.repeat) return;
      if (this.input) return; // an explicit Input source takes precedence
      e.preventDefault();
      this.toggleHardLock();
    };
    window.addEventListener('keydown', this._onKey);
  }

  /** @param {Array} list LIVE array of enemy entities (mutated by EnemyManager). */
  setTargets(list) {
    this.targets = list || null;
  }

  /** Optional: give the system a Physics instance so it can do LOS/occlusion. */
  setPhysics(physics) {
    this.physics = physics || null;
  }

  /** Optional: route the lock toggle through the shared Input instead of DOM. */
  setInput(input) {
    this.input = input || null;
  }

  // =========================================================================

  update(dt, elapsed) {
    const cam = this.camera;
    if (!cam) return;
    dt = M.clamp(dt, 0, 0.1);

    const C = this.cfg;
    this._switchTimer = Math.max(0, this._switchTimer - dt);
    this._losTimer -= dt;

    // Physics is not in the contract constructor; pick it up opportunistically
    // so occlusion and aim convergence work without extra wiring.
    if (!this.physics && this.player?.physics) this.physics = this.player.physics;
    if (this.input?.hit?.('Tab')) this.toggleHardLock();

    this._collect();
    this._tickLOS(dt);

    const best = this.candidates.length ? this.candidates[0] : null;

    // ---- hard lock maintenance -------------------------------------------
    if (this.hardLock) {
      const t = this.target;
      if (!this._validHard(t)) {
        this._breakHardLock();
      } else {
        const rec = this._recordFor(t);
        const los = rec ? rec.los : true;
        this._occluded = los ? 0 : this._occluded + dt;
        if (this._occluded > C.occludeBreak) this._breakHardLock();
      }
    }

    // ---- soft lock election ----------------------------------------------
    if (!this.hardLock) {
      const cur = this.softTarget;
      let next = best ? best.entity : null;
      if (cur && cur !== next && cur.alive !== false) {
        const curRec = this._findCandidate(cur);
        // incumbent keeps the lock unless a challenger clearly beats it
        if (curRec && best && curRec.score * C.hysteresis <= best.score) next = cur;
        else if (curRec && !best) next = cur;
        if (next !== cur && this._switchTimer > 0) next = cur;
      }
      if (next !== this.softTarget) {
        this.softTarget = next;
        this._switchTimer = C.switchDelay;
        this.lockProgress = 0;
      }
      this.target = this.softTarget;
    } else {
      this.softTarget = this.target;
    }

    // ---- convergence ------------------------------------------------------
    const rec = this.target ? this._findCandidate(this.target) : null;
    const onTarget = this.hardLock
      ? !!rec
      : !!rec && rec.screenDist < C.convergeRadius && rec.los !== false;
    if (onTarget) {
      this.lockProgress = Math.min(1, this.lockProgress + dt / Math.max(0.01, C.lockTime));
    } else {
      this.lockProgress = Math.max(0, this.lockProgress - dt / Math.max(0.01, C.unlockTime));
      if (!this.target) this.lockProgress = 0;
    }

    // ---- reticle ----------------------------------------------------------
    if (this.hardLock && rec && rec.visible) {
      this.reticle.x = rec.x;
      this.reticle.y = rec.y;
      this.reticle.visible = true;
      this.reticle.locked = true;
    } else {
      this.reticle.x = 0.5;
      this.reticle.y = 0.5;
      this.reticle.visible = true;
      this.reticle.locked = false;
    }

    this._emitIfChanged();

    this._pruneTimer -= dt;
    if (this._pruneTimer <= 0) {
      this._pruneTimer = 3;
      this._pruneLOS(elapsed);
    }
  }

  // =========================================================================
  // candidates
  // =========================================================================

  /** Project every live target, score it, and produce the sorted candidate list. */
  _collect() {
    const cam = this.camera;
    const C = this.cfg;
    const list = this.targets; // re-read every frame: EnemyManager mutates it
    this.candidates.length = 0;
    if (!list || !list.length) return;

    const aspect = num(cam.aspect, 1.7778) || 1.7778;
    const camPos = _origin.setFromMatrixPosition(cam.matrixWorld);

    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.alive === false || !e.root) continue;
      if (e === this.player) continue;

      if (e.getAimPoint) e.getAimPoint(_aim);
      else _aim.copy(e.root.position);

      const dist = camPos.distanceTo(_aim);
      if (dist > C.softRange) continue;

      // camera space first: reliable behind-camera rejection
      _camSpace.copy(_aim).applyMatrix4(cam.matrixWorldInverse);
      if (_camSpace.z > -0.1) continue; // behind or on the near plane

      _v.copy(_camSpace).applyMatrix4(cam.projectionMatrix);
      const ndcX = _v.x;
      const ndcY = _v.y;

      // aspect-corrected radius so the lock cone is circular on screen
      const sx = ndcX * aspect;
      const screenDist = Math.hypot(sx, ndcY);
      const onScreen = Math.abs(ndcX) <= 1.02 && Math.abs(ndcY) <= 1.02;
      if (screenDist > C.coneRadius && !onScreen) continue;

      const rec = this._rec(n++);
      rec.entity = e;
      rec.x = ndcX * 0.5 + 0.5;
      rec.y = -ndcY * 0.5 + 0.5;
      rec.visible = onScreen;
      rec.screenDist = screenDist;
      rec.dist = dist;
      rec.los = this._cachedLos(e);
      rec.priority = num(e.lockPriority, 0);

      // lower is better
      let score = screenDist * C.wScreen + (dist / C.softRange) * C.wDistance;
      if (rec.los === false) score += C.wOcclusion;
      if (!onScreen) score += 1.5;
      if (e.stats?.staggered) score -= 0.12; // staggered enemies are the play
      score -= rec.priority * 0.1;
      rec.score = score;

      this.candidates.push(rec);
    }

    if (this.candidates.length > 1) sortByScore(this.candidates);
  }

  _rec(i) {
    let r = this._pool[i];
    if (!r) {
      r = this._pool[i] = {
        entity: null,
        x: 0.5,
        y: 0.5,
        visible: false,
        screenDist: 9,
        dist: 0,
        score: 0,
        los: true,
        priority: 0,
      };
    }
    return r;
  }

  _findCandidate(entity) {
    const list = this.candidates;
    for (let i = 0; i < list.length; i++) if (list[i].entity === entity) return list[i];
    return null;
  }

  _recordFor(entity) {
    return this._findCandidate(entity);
  }

  // =========================================================================
  // line of sight (optional — needs setPhysics())
  // =========================================================================

  _cachedLos(entity) {
    const r = this._losMap.get(entity);
    return r ? r.los : true;
  }

  /** One ray per tick, round-robin over the top candidates. Cheap and enough. */
  _tickLOS(dt) {
    const ph = this.physics;
    if (!ph?.raycast || this._losTimer > 0) return;
    this._losTimer = this.cfg.losInterval;

    const cam = this.camera;
    const pool = this.candidates;
    if (!pool.length) return;

    // always keep the hard target fresh, otherwise round-robin the top 4
    let e = null;
    if (this.hardLock && this.target) e = this.target;
    else {
      const k = Math.min(4, pool.length);
      this._losIndex = (this._losIndex + 1) % k;
      e = pool[this._losIndex].entity;
    }
    if (!e?.root) return;

    if (e.getAimPoint) e.getAimPoint(_aim);
    else _aim.copy(e.root.position);

    _origin.setFromMatrixPosition(cam.matrixWorld);
    _tmp.subVectors(_aim, _origin);
    const d = _tmp.length();
    if (d < 1e-3) return;
    _tmp.divideScalar(d);

    const hit = ph.raycast(_origin, _tmp, d - 2.0, _rayOut);
    const blocked = !!(hit && hit.hit !== false && num(hit.distance, d) < d - 2.0);

    let r = this._losMap.get(e);
    if (!r) this._losMap.set(e, (r = { los: true, t: 0 }));
    r.los = !blocked;
    r.t = 0;
  }

  _pruneLOS() {
    for (const [e] of this._losMap) {
      if (!e || e.alive === false) this._losMap.delete(e);
    }
  }

  // =========================================================================
  // hard lock
  // =========================================================================

  /** Tab: latch the current soft target, or release an existing hard lock. */
  toggleHardLock() {
    // debounce: safe even if another system also wires Tab to this method
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._toggleStamp < 40) return this.hardLock;
    this._toggleStamp = now;

    if (this.hardLock) {
      this._breakHardLock();
      return false;
    }
    const t = this.softTarget || (this.candidates.length ? this.candidates[0].entity : null);
    if (!t) return false;
    this.hardLock = true;
    this.target = t;
    this.softTarget = t;
    this._occluded = 0;
    this._emitIfChanged(true);
    return true;
  }

  _breakHardLock() {
    if (!this.hardLock) return;
    this.hardLock = false;
    this._occluded = 0;
    this._switchTimer = 0;
  }

  _validHard(t) {
    if (!t || t.alive === false || !t.root) return false;
    const cam = this.camera;
    _origin.setFromMatrixPosition(cam.matrixWorld);
    return _origin.distanceTo(t.root.position) <= this.cfg.maxRange;
  }

  /**
   * Emit only on genuine state edges — target swap, hard-lock toggle, or the
   * convergence ring reaching/leaving full. Anything that wants the continuous
   * value reads `.lockProgress` directly, so this stays allocation-quiet.
   */
  _emitIfChanged(force) {
    const converged = this.lockProgress >= 1 ? 1 : this.lockProgress <= 0 ? 0 : -1;
    const lastConverged = this._lastEmitProgress >= 1 ? 1 : this._lastEmitProgress <= 0 ? 0 : -1;
    if (
      !force &&
      this.target === this._lastEmitTarget &&
      this.hardLock === this._lastEmitHard &&
      converged === lastConverged
    ) {
      return;
    }
    this._lastEmitTarget = this.target;
    this._lastEmitHard = this.hardLock;
    this._lastEmitProgress = this.lockProgress;
    bus.emit(EV.LOCK_STATE, {
      target: this.target,
      hardLock: this.hardLock,
      lockProgress: this.lockProgress,
    });
  }

  // =========================================================================
  // queries used by HUD / weapons
  // =========================================================================

  /**
   * Project an entity's aim point to normalised screen coords.
   * Allocation-free — writes into `out`.
   * @param {object} entity
   * @param {{x:number,y:number,visible:boolean}} out
   */
  screenPos(entity, out) {
    const o = out || this._scratchScreen;
    o.visible = false;
    o.behind = false;
    const cam = this.camera;
    if (!entity?.root || !cam) {
      o.x = 0.5;
      o.y = 0.5;
      return o;
    }
    if (entity.getAimPoint) entity.getAimPoint(_aim);
    else _aim.copy(entity.root.position);

    _camSpace.copy(_aim).applyMatrix4(cam.matrixWorldInverse);
    o.dist = _camSpace.length();
    if (_camSpace.z > -0.05) {
      // behind the camera: still give a usable direction for off-screen arrows
      o.behind = true;
      o.x = _camSpace.x > 0 ? 1.5 : -0.5;
      o.y = 0.5;
      o.depth = 1;
      return o;
    }
    _v.copy(_camSpace).applyMatrix4(cam.projectionMatrix);
    o.x = _v.x * 0.5 + 0.5;
    o.y = -_v.y * 0.5 + 0.5;
    o.depth = _v.z;
    o.visible = o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1;
    return o;
  }

  /**
   * The world ray weapons fire along: from the camera through the crosshair,
   * CONVERGED on the locked target's aim point when there is one — so shots
   * from left/right arm hardpoints meet at the target instead of running parallel.
   * @param {object} [out] { origin, direction, point, distance, target, converged }
   */
  getAimRay(out) {
    const o = out || this._aimRay;
    const cam = this.camera;
    if (!cam) return o;

    o.origin.setFromMatrixPosition(cam.matrixWorld);
    o.direction.set(0, 0, -1).applyQuaternion(cam.quaternion);

    const t = this.target;
    const useLock = t && t.alive !== false && t.root && (this.hardLock || this.lockProgress > 0.25);
    if (useLock) {
      if (t.getAimPoint) t.getAimPoint(_aim);
      else _aim.copy(t.root.position);
      o.point.copy(_aim);
      o.distance = o.origin.distanceTo(_aim);
      _tmp.subVectors(_aim, o.origin);
      if (_tmp.lengthSq() > 1e-6) o.direction.copy(_tmp).normalize();
      o.target = t;
      o.converged = true;
      return o;
    }

    // no lock: converge on the first thing the crosshair actually hits, else a
    // sensible mid-range plane so hardpoint fire still toes in slightly
    let d = this.cfg.aimConvergeMax;
    const hit = this.physics?.raycast?.(o.origin, o.direction, this.cfg.aimConvergeMax, _rayOut);
    if (hit && hit.hit !== false) d = M.clamp(num(hit.distance, d), this.cfg.aimConvergeMin, this.cfg.aimConvergeMax);
    o.distance = d;
    o.point.copy(o.origin).addScaledVector(o.direction, d);
    o.target = null;
    o.converged = false;
    return o;
  }

  /**
   * Predictive aim point for a constant-speed projectile.
   * @param {object} entity
   * @param {number} projectileSpeed m/s
   * @param {THREE.Vector3} [out]
   */
  getLeadPoint(entity, projectileSpeed, out) {
    const o = out || this._leadOut;
    if (!entity?.root) return o.set(0, 0, 0);
    if (entity.getAimPoint) entity.getAimPoint(_aim);
    else _aim.copy(entity.root.position);

    const speed = num(projectileSpeed, 0);
    const vel = entity.velocity;
    if (speed <= 0 || !vel) return o.copy(_aim);

    const shooter = this.player?.root?.position
      ? _tmp2.copy(this.player.root.position).setY(this.player.root.position.y + 4)
      : _tmp2.setFromMatrixPosition(this.camera.matrixWorld);

    return M.interceptPoint(shooter, _aim, vel, speed, o);
  }

  /** Convenience for weapons: is homing ordnance allowed to commit? */
  get missileLock() {
    return !!this.target && this.lockProgress >= 1;
  }

  reset() {
    this.target = null;
    this.softTarget = null;
    this.hardLock = false;
    this.lockProgress = 0;
    this.candidates.length = 0;
    this._losMap.clear();
    this._occluded = 0;
    this._switchTimer = 0;
    this._lastEmitTarget = null;
    this._lastEmitHard = false;
    this._lastEmitProgress = 0;
    this.reticle.x = 0.5;
    this.reticle.y = 0.5;
    this.reticle.locked = false;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this._losMap.clear();
    this.candidates.length = 0;
    this._pool.length = 0;
    this.targets = null;
  }
}

export default TargetingSystem;
