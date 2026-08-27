import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';

/**
 * Debug / capture API.
 *
 * Exposed as `window.__ACNTR__.debug`. The headless screenshot harness drives
 * the game through this so every review frame is reproducible: same camera,
 * same lighting, same combat state, every iteration. Without it the critic is
 * comparing noise.
 *
 * Everything here is defensive — subsystems may be missing or mid-refactor and
 * a debug call must never take the game down.
 */
export class Debug {
  constructor(game) {
    this.game = game;
    this.cameraOverride = null;
    this._orbit = null;
    this._scratch = new THREE.Vector3();
    this._target = new THREE.Vector3();

    // Take over the camera *after* CameraRig has written to it.
    game.engine.addLateUpdate((dt, t) => this._applyCameraOverride(dt, t));
  }

  // ---- camera -------------------------------------------------------------

  /**
   * Pin the camera to an explicit pose. Disables CameraRig influence.
   * @param {{x,y,z}} pos world position
   * @param {{x,y,z}} look world look-at point
   * @param {number} [fov]
   */
  setCamera(pos, look, fov) {
    this.cameraOverride = { mode: 'fixed', pos, look, fov };
    return this;
  }

  /**
   * Slow orbit around a point — used for turntable review of the mech.
   * @param {{x,y,z}} center
   * @param {number} radius
   * @param {number} height
   * @param {number} angle radians; if null the orbit animates
   */
  orbit(center, radius, height, angle = null, fov = 40) {
    this.cameraOverride = { mode: 'orbit', center, radius, height, angle, fov, t: 0 };
    return this;
  }

  releaseCamera() {
    this.cameraOverride = null;
    return this;
  }

  _applyCameraOverride(dt, t) {
    const o = this.cameraOverride;
    if (!o) return;
    const cam = this.game.engine.camera;
    if (o.mode === 'fixed') {
      cam.position.set(o.pos.x, o.pos.y, o.pos.z);
      this._target.set(o.look.x, o.look.y, o.look.z);
      cam.up.set(0, 1, 0);
      cam.lookAt(this._target);
    } else if (o.mode === 'orbit') {
      o.t += dt;
      const a = o.angle == null ? o.t * 0.35 : o.angle;
      cam.position.set(
        o.center.x + Math.cos(a) * o.radius,
        o.center.y + o.height,
        o.center.z + Math.sin(a) * o.radius
      );
      this._target.set(o.center.x, o.center.y, o.center.z);
      cam.up.set(0, 1, 0);
      cam.lookAt(this._target);
    }
    if (o.fov && cam.fov !== o.fov) {
      cam.fov = o.fov;
      cam.updateProjectionMatrix();
    }
    this.game.pipeline?.resetHistory?.();
  }

  // ---- world state --------------------------------------------------------

  /** Teleport the player mech and zero its velocity. */
  placePlayer(x, y, z, yaw = 0) {
    const p = this.game.player;
    if (!p) return this;
    p.root.position.set(x, y, z);
    p.root.rotation.y = yaw;
    p.velocity?.set?.(0, 0, 0);
    return this;
  }

  /** Force a rig pose without needing live input. */
  poseMech(state = {}) {
    const rig = this.game.player?.rig;
    if (!rig) return this;
    this._forcedRigState = {
      velocity: new THREE.Vector3(0, 0, 0),
      grounded: true,
      boosting: false,
      quickBoost: false,
      assaultBoost: false,
      aimYaw: 0,
      aimPitch: 0,
      speed: 0,
      staggered: false,
      firing: false,
      ...state,
    };
    try {
      rig.update(0.016, this._forcedRigState);
    } catch { /* rig may not accept partial state yet */ }
    return this;
  }

  /** Spawn an enemy of a given archetype near a position. */
  spawnEnemy(archetype = 'mt', x = 0, y = 0, z = -40, tier = 1) {
    try {
      return this.game.enemies?.spawn?.(archetype, new THREE.Vector3(x, y, z), tier) ?? null;
    } catch (e) {
      console.warn('[debug] spawnEnemy failed', e);
      return null;
    }
  }

  clearEnemies() {
    try {
      this.game.enemies?.reset?.();
    } catch { /* noop */ }
    return this;
  }

  /** Trigger VFX directly for effect review. */
  vfx(name, ...args) {
    try {
      this.game.vfx?.[name]?.(...args);
    } catch (e) {
      console.warn(`[debug] vfx.${name} failed`, e);
    }
    return this;
  }

  explosionAt(x, y, z, radius = 8) {
    return this.vfx('explosion', new THREE.Vector3(x, y, z), radius);
  }

  /** Fire every weapon slot once, for muzzle-flash / tracer captures. */
  fireAll() {
    const slots = this.game.weapons?.slots;
    if (!slots) return this;
    for (const k of Object.keys(slots)) {
      try {
        slots[k]?.tryFire?.({ force: true });
      } catch { /* weapon may need a richer ctx */ }
    }
    return this;
  }

  /** Drive HUD state for interface review. */
  hudState({ ap, acs, en, staggered, lockProgress } = {}) {
    const s = this.game.player?.stats;
    if (s) {
      if (ap != null) s.ap = ap * s.apMax;
      if (acs != null) s.acs = acs * s.acsMax;
      if (en != null) s.en = en * s.enMax;
      if (staggered != null) s.staggered = staggered;
    }
    if (lockProgress != null && this.game.targeting) {
      this.game.targeting.lockProgress = lockProgress;
    }
    return this;
  }

  /** Hide the HUD so pure-render frames can be judged without interface. */
  setHudVisible(v) {
    const root = document.getElementById('ui-root');
    if (root) root.style.display = v ? '' : 'none';
    return this;
  }

  /** Freeze gameplay but keep rendering — for clean, deterministic captures. */
  freeze(v = true) {
    this.game.engine.timeScale = v ? 0 : 1;
    return this;
  }

  /** Advance the simulation by a fixed amount without real time passing. */
  step(seconds = 1, stepDt = 1 / 60) {
    const n = Math.round(seconds / stepDt);
    const e = this.game.engine;
    const prevScale = e.timeScale;
    e.timeScale = 1;
    for (let i = 0; i < n; i++) {
      for (const fn of e._updaters) fn(stepDt, e.clock.elapsed, stepDt);
      for (const fn of e._lateUpdaters) fn(stepDt, e.clock.elapsed, stepDt);
      e.clock.elapsed += stepDt;
    }
    e.timeScale = prevScale;
    return this;
  }

  /** Renderer/scene statistics for the perf budget. */
  stats() {
    const e = this.game.engine;
    const i = e.renderer.info;
    let objects = 0;
    e.scene.traverse(() => objects++);
    return {
      fps: Math.round(e.fps),
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
      sceneObjects: objects,
      resolutionScale: e.resolutionScale,
      enemies: this.game.enemies?.list?.length ?? 0,
    };
  }

  /** Toggle individual post passes so a critic can isolate what a pass costs. */
  setPass(name, on) {
    const p = this.game.pipeline;
    if (!p) return this;
    if (p.params && name in p.params) {
      const v = p.params[name];
      if (typeof v === 'object' && v && 'enabled' in v) v.enabled = on;
      else p.params[name] = on;
    }
    p.setPassEnabled?.(name, on);
    return this;
  }
}

export function installDebug(game) {
  const d = new Debug(game);
  if (typeof window !== 'undefined') {
    window.__ACNTR__ = window.__ACNTR__ || {};
    window.__ACNTR__.debug = d;
    window.__ACNTR__.THREE = THREE;
    window.__ACNTR__.bus = bus;
    window.__ACNTR__.EV = EV;
  }
  return d;
}
