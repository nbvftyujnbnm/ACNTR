import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { mulberry32 } from '../core/MathUtils.js';
import { rollPart } from '../loot/PartsDB.js';

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

  /**
   * Drop the mech onto the terrain at (x, z). Review poses must not hard-code a
   * world Y — the level has real terrain, so an absolute Y either buries the
   * mech or floats it, and the shot silently becomes worthless.
   */
  placePlayerOnGround(x, z, yaw = 0, clearance = 0.05) {
    const g = this.game.physics?.groundHeight?.(x, z);
    return this.placePlayer(x, Number.isFinite(g) ? g + clearance : 0, z, yaw);
  }

  /** Put the mech on one of the level's authored spawn points. */
  placePlayerAtSpawn(index = 0, yaw = 0) {
    const sp = this.game.level?.spawnPoints?.[index];
    if (!sp) return this.placePlayerOnGround(0, 0, yaw);
    return this.placePlayerOnGround(sp.x, sp.z, yaw);
  }

  /**
   * Frame the camera relative to the mech rather than in world space, so a
   * pose keeps its composition wherever the mech happens to be standing.
   * @param {{x,y,z}} offset camera position relative to the mech's feet
   * @param {{x,y,z}} lookOffset look-at point relative to the mech's feet
   */
  cameraRelativeToPlayer(offset, lookOffset = { x: 0, y: 4.7, z: 0 }, fov = 34) {
    const p = this.game.player?.root?.position;
    if (!p) return this;
    return this.setCamera(
      { x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z },
      { x: p.x + lookOffset.x, y: p.y + lookOffset.y, z: p.z + lookOffset.z },
      fov
    );
  }

  /**
   * Hold keys down as if the player were pressing them.
   *
   * Setting `controller.state` flags directly does not work: `step()` runs the
   * real controller, which re-derives its state from input every frame and
   * overwrites them. The boost pose did exactly that and captured a mech
   * standing still at 9 m/s on the ground. Driving the actual input instead
   * produces authentic velocity, FOV kick, thruster plumes and motion blur.
   *
   * @param {string[]} codes KeyboardEvent.code values, e.g. ['KeyW','ControlLeft']
   */
  holdKeys(codes) {
    const input = window.__ACNTR__?.input || this.game.input;
    if (!input?.keys) return this;
    for (const c of codes) input.keys.add(c);
    return this;
  }

  releaseKeys(codes) {
    const input = window.__ACNTR__?.input || this.game.input;
    if (!input?.keys) return this;
    if (codes) for (const c of codes) input.keys.delete(c);
    else input.keys.clear();
    return this;
  }

  /**
   * Put the mech on a spawn point that is actually in direct sunlight.
   *
   * Review poses were framing the mech inside a 25 m building's 104 m cast
   * shadow, so it had no contact shadow and no lit/shadow side — which made the
   * lighting unreviewable through no fault of the lighting.
   */
  placePlayerInSun(yaw = 0) {
    const sun = this.game.sky?.sunDirection;
    const pts = this.game.level?.spawnPoints;
    if (!sun || !pts?.length) return this.placePlayerAtSpawn(0, yaw);
    const origin = new THREE.Vector3();
    for (const sp of pts) {
      const g = this.game.physics?.groundHeight?.(sp.x, sp.z);
      origin.set(sp.x, (isFinite(g) ? g : sp.y) + 6, sp.z);
      const hit = this.game.physics?.raycast?.(origin, sun, 400);
      if (!hit || !hit.hit) return this.placePlayerOnGround(sp.x, sp.z, yaw);
    }
    return this.placePlayerAtSpawn(0, yaw);
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

  /**
   * Clear the pause overlay.
   *
   * The HUD pauses whenever pointer lock is released, which in a headless
   * capture is *always* — so every gameplay/HUD review frame came back with a
   * "SYSTEM PAUSED" panel across the middle of it. Poses that show the HUD must
   * call this after setting up.
   */
  /**
   * Restore the player to a clean, full-health state.
   *
   * Every pose runs in ONE browser session, so whatever a pose does to game
   * state leaks into all the poses after it. That is how the VFX review frame
   * ended up drowned in the low-AP red vignette — the HUD pose before it had
   * set AP to 23%. capture.mjs calls this between poses.
   */
  resetState() {
    const s = this.game.player?.stats;
    if (s) {
      s.ap = s.apMax;
      s.acs = 0;
      s.en = s.enMax;
      s.staggered = false;
      s.staggerTimer = 0;
      s.heat = 0;
    }
    const c = this.game.controller?.state;
    if (c) {
      c.boosting = false;
      c.assaultBoost = false;
      c.enRecovering = false;
      c.speed = 0;
    }
    if (this.game.targeting) this.game.targeting.lockProgress = 0;
    this.game.engine.timeScale = 1;
    return this;
  }

  unpause() {
    try {
      this.game.hud?.setPaused?.(false);
      this.game.hud?.hideGameOver?.();
    } catch { /* HUD may not be ready */ }
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

  /**
   * Fill the inventory with rolled parts so garage/loot UI can be reviewed.
   * Lives here rather than in the pose script because pose scripts run against
   * a production bundle, where raw `/src/...` module paths do not resolve.
   */
  seedInventory(count = 24, seed = 20240826) {
    try {
      const rng = mulberry32(seed);
      const inv = this.game.loadout?.inventory;
      if (!inv) return this;
      for (let i = 0; i < count; i++) inv.push(rollPart(1 + (i % 5), rng));
      this.game.loadout?.recompute?.();
    } catch (e) {
      console.warn('[debug] seedInventory failed', e);
    }
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
