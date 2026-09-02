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

    // Setting the ROOT yaw alone does not survive a single second of
    // simulation. `Entity.aimYaw` is the authority — CameraRig owns it and
    // PlayerController turns the body to chase it every frame — so a pose that
    // only rotated the root had the mech quietly swing back to aimYaw 0 while
    // it settled. That is what made the combat poses walk into scenery and
    // spawn their enemies off to one side: the placement chose an open bearing,
    // and by the time anything was captured the mech was facing somewhere else.
    // CameraRig is the real authority: it writes `p.aimYaw = this.yaw` in
    // lateUpdate, so setting the entity alone is overwritten on the very next
    // frame. Set the rig, then the entity, then the controller, then reset the
    // rig's smoothing so the camera does not sweep across the level catching up.
    const rig = this.game.cameraRig;
    if (rig && typeof rig.yaw === 'number') rig.yaw = yaw;
    p.aimYaw = yaw;
    const c = this.game.controller;
    if (c) {
      if (typeof c.yaw === 'number') c.yaw = yaw;
      if (typeof c.bodyYaw === 'number') c.bodyYaw = yaw;
    }
    rig?.reset?.();
    this.game.pipeline?.resetHistory?.();
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
   * Frame the camera in the mech's OWN frame — behind / above / beside it,
   * whichever way it happens to be facing.
   *
   * `cameraRelativeToPlayer` offsets in world space, so which side of the mech
   * it lands on depends entirely on the yaw the placement happened to choose.
   * That is how the thruster close-up ended up looking at the mech's FRONT: the
   * exhaust blows out of the back, so the pose that existed to photograph the
   * plumes had the body between the lens and the plumes, and the resulting
   * empty frame was very nearly diagnosed as a rendering failure.
   *
   * @param {{back?:number, up?:number, side?:number, lookY?:number, lookAhead?:number, fov?:number}} [opts]
   */
  cameraBehindPlayer({ back = 12, up = 4, side = 0, lookY = 4.6, lookAhead = 0, fov = 38 } = {}) {
    const p = this.game.player?.root;
    if (!p) return this;
    const yaw = p.rotation.y;
    // Mech forward is (-sin yaw, 0, -cos yaw); behind it is the negation.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    return this.setCamera(
      {
        x: p.position.x - fx * back + rx * side,
        y: p.position.y + up,
        z: p.position.z - fz * back + rz * side,
      },
      {
        x: p.position.x + fx * lookAhead,
        y: p.position.y + lookY,
        z: p.position.z + fz * lookAhead,
      },
      fov,
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
    // NOTE: prefer frameHeroShot() for any pose that also places a camera.
    // This scorer only knows about the mech, and two agents independently
    // reproduced it choosing a spawn whose camera position was inside a wall.
    //
    // Sunlight alone is not enough — the first sunlit spawn turned out to be
    // jammed against an embankment, which is technically lit and visually
    // useless. Score candidates on sun access AND horizontal elbow room.
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let best = null;
    let bestScore = -Infinity;
    for (const sp of pts) {
      const g = this.game.physics?.groundHeight?.(sp.x, sp.z);
      const y = (isFinite(g) ? g : sp.y) + 6;
      origin.set(sp.x, y, sp.z);
      const sunHit = this.game.physics?.raycast?.(origin, sun, 400);
      if (sunHit && sunHit.hit) continue; // in shadow

      let clearance = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        dir.set(Math.cos(a), 0, Math.sin(a));
        const h = this.game.physics?.raycast?.(origin, dir, 60);
        clearance += h && h.hit ? h.distance : 60;
      }
      if (clearance > bestScore) {
        bestScore = clearance;
        best = sp;
      }
    }
    if (best) return this.placePlayerOnGround(best.x, best.z, yaw);
    return this.placePlayerAtSpawn(0, yaw);
  }

  /**
   * Place the mech AND frame the camera together, validating both.
   *
   * `placePlayerInSun` scored only the mech's surroundings, so nothing checked
   * what was behind the lens; its clearance term was also a SUM over eight
   * 60 m rays, meaning a spot with open ground in seven directions and 5 m of
   * wall in the eighth scored 425/480 and won — and when that eighth direction
   * was the camera's, the shot was taken from inside the wall. Two agents
   * reproduced that deterministically on consecutive builds.
   *
   * This scores the MINIMUM ray rather than the sum, rejects any camera
   * position that is underground or has geometry between it and the mech, and
   * prefers a bearing with the sun roughly SIDE-ON. That last term matters: at
   * a 13.5-degree sun a 9 m mech throws a ~37 m shadow, so it is a long blade
   * cast far to one side rather than a pool at the feet, and whether the frame
   * contains it is decided entirely by camera azimuth relative to the sun.
   *
   * @returns {boolean} true if a valid framing was found
   */
  /**
   * Stand the mech somewhere with a genuinely open field of fire, and face it
   * down the open direction.
   *
   * Combat poses need more than flat ground. `placePlayerOnGround(0, 40, ...)`
   * put the mech nose-first against a warehouse wall: it could not move (the
   * frame reported 0.1 m/s while holding forward) and every enemy spawned ahead
   * of it was behind that wall. The frustum test still said "4 of 4 enemies in
   * frame", because being inside the frustum and being VISIBLE are different
   * questions — the same distinction that made the first hero framing scorer
   * shoot the inside of a wall.
   *
   * Scores each level spawn by how far a fan of rays reaches across a forward
   * arc, and returns the yaw it chose so a pose can spawn enemies down it.
   *
   * @param {{arc?:number, rays?:number, range?:number}} [opts]
   * @returns {{x:number, z:number, yaw:number, clear:number}|null}
   */
  placePlayerInOpenGround({ arc = Math.PI * 0.5, rays = 7, range = 140, rank = 0 } = {}) {
    const pts = this.game.level?.spawnPoints;
    const ph = this.game.physics;
    if (!pts?.length || !ph?.raycast) return null;

    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    // Every viable (spawn, bearing) pair is kept and sorted, not just the top
    // one. A pose that needs to SEE something has to be able to ask for the
    // next-best arena when the best one turns out to be occluded from the
    // chase camera — scoring cannot know what the camera will end up behind.
    const candidates = [];
    let best = null;

    const low = new THREE.Vector3();
    for (const sp of pts) {
      const g = ph.groundHeight?.(sp.x, sp.z);
      if (!isFinite(g)) continue;
      origin.set(sp.x, g + 5.5, sp.z); // roughly the mech's chest
      low.set(sp.x, g + 1.8, sp.z);    // roughly its knees

      // Sweep whole-circle bearings, and for each, measure the WORST ray in a
      // forward arc. The worst ray is what actually blocks a shot; an average
      // would let one clear lane hide a wall filling the rest of the view.
      //
      // Rays are cast at TWO heights. Chest height alone scored a spot as
      // 140 m clear when the mech was standing behind a knee-high lip it could
      // not walk over — the pose reported 0 m/s with a completely open view.
      for (let b = 0; b < 16; b++) {
        const bearing = (b / 16) * Math.PI * 2;
        let worst = Infinity;
        for (let i = 0; i < rays; i++) {
          const a = bearing + (i / (rays - 1) - 0.5) * arc;
          dir.set(Math.sin(a), 0, Math.cos(a));
          const hi = ph.raycast(origin, dir, range);
          const lo = ph.raycast(low, dir, range);
          worst = Math.min(
            worst,
            hi && hi.hit ? hi.distance : range,
            lo && lo.hit ? lo.distance : range,
          );
        }
        if (worst < 25) continue;

        // Rays clear terrain they pass OVER, so a spot can be ray-clear and
        // still be a pit, a hillside or — the case that actually bit — a
        // CLIFFTOP. Walk the heightfield instead, and reject a DROP as firmly
        // as a rise.
        //
        // Rejecting only rises let the scorer pick the edge of a mesa: the
        // horizontal rays flew out over the drop and reported the full 140 m
        // clear, there was no rise, so it scored perfectly. Enemies were then
        // spawned on the terrain far below, and the chase camera — measured at
        // y 47.7 — had its line to every one of them clipped by the cliff edge.
        // Four ranked arenas in a row failed that way, which is what made it
        // look like a bug in the visibility test rather than in the scoring.
        // Walk BEHIND the mech as well as ahead of it. Checking only forward
        // still let the scorer pick a ledge with the drop at its BACK: the
        // chase camera swings backwards, out over that drop, and ends up high
        // above the terrain — measured at camY 70.9, not buried, with its line
        // to every enemy ahead clipped by the mech's own plateau edge. Where
        // the camera stands decides what it can see, so the ground under the
        // camera has to be scored too.
        const fx = Math.sin(bearing);
        const fz = Math.cos(bearing);
        let relief = 0;
        for (let s = -14; s <= 40; s += 5) {
          if (s === 0) continue;
          const gh = ph.groundHeight?.(sp.x + fx * s, sp.z + fz * s);
          if (!isFinite(gh)) { relief = Infinity; break; }
          relief = Math.max(relief, Math.abs(gh - g));
        }
        if (relief > 2.5) continue;
        const rise = relief;

        // The rays point along (sin b, 0, cos b); the controller's forward is
        // (-sin yaw, 0, -cos yaw), so facing down that bearing is yaw = b + PI.
        const score = worst - rise * 8;
        candidates.push({
          x: sp.x, z: sp.z, yaw: bearing + Math.PI,
          clear: +worst.toFixed(1), rise: +rise.toFixed(2), score: +score.toFixed(1),
        });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);

    // Spread the ranks out. Adjacent bearings at the same spawn are nearly the
    // same shot, so retrying rank 1 after rank 0 failed would change almost
    // nothing; step through in strides instead.
    const idx = Math.min(candidates.length - 1, Math.max(0, rank) * 3);
    best = candidates[idx];
    this._openGroundCandidates = candidates.length;
    this.placePlayerOnGround(best.x, best.z, best.yaw, 0.05);
    this._lastOpenGround = { ...best, rank, of: candidates.length };
    return this._lastOpenGround;
  }

  /**
   * Spawn an enemy standing ON the terrain at (x, z) rather than at a y you
   * guessed. Poses kept placing enemies at the player's own y plus an offset,
   * which buries them in any ground that rises ahead — one review frame had
   * four enemies inside a hillside and reported all four as "in frame".
   */
  spawnEnemyOnGround(archetype, x, z, tier = 1, above = 0) {
    const g = this.game.physics?.groundHeight?.(x, z);
    const y = isFinite(g) ? g + above : (this.game.player?.root?.position?.y ?? 0) + above;
    return this.spawnEnemy(archetype, x, y, z, tier);
  }

  /**
   * Of the entities given, how many are both inside the frustum AND not behind
   * geometry? Poses use this to report whether the fight they set up is
   * actually in the picture.
   */
  visibleCount(entities) {
    const cam = this.game.engine.camera;
    const ph = this.game.physics;
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    const dir = new THREE.Vector3();
    const aim = new THREE.Vector3();
    let inFrustum = 0;
    let visible = 0;
    // Distances to the first blocker, so "0 visible" can be told apart from
    // "the camera is buried". The chase camera swings behind the mech and can
    // end up inside a berm or a wall, in which case EVERY ray hits within a
    // metre or two and nothing is ever visible no matter where the fight is.
    const blockedAt = [];
    const camGround = this.game.physics?.groundHeight?.(cam.position.x, cam.position.z);
    const camBuried = isFinite(camGround) ? cam.position.y < camGround + 0.5 : false;
    for (const e of entities || []) {
      if (!e?.root) continue;
      // Aim at the CHEST, not the root. Mech roots are authored at the feet
      // (see the capsule-centre amendment), so a ray to `root.position` runs
      // along the ground and is blocked by any rise between here and there —
      // which reported every enemy as occluded in an arena where they were
      // plainly standing in the open.
      aim.copy(e.root.position);
      // `??` catches undefined but NOT NaN, and a NaN here is fatal in a way
      // that looks like scenery: it makes `d` NaN, which makes `maxDist` NaN,
      // and `Physics.raycast` starts with `best = maxDist` and misses via
      // `if (best >= maxDist) return null` — a comparison that is FALSE for
      // NaN. So the ray falls through to `res.hit = true` with a NaN distance
      // and every target reports as occluded. That is exactly what "4 enemies
      // in frustum, 0 visible, blocked at hit(no distance)" was, and it sent
      // three iterations after the arena scorer.
      const h = e.collider?.height;
      aim.y += (Number.isFinite(h) ? h : 8) * 0.5;
      if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y) || !Number.isFinite(aim.z)) continue;
      if (!frustum.containsPoint(aim)) continue;
      inFrustum++;
      if (!ph?.raycast) { visible++; continue; }
      dir.subVectors(aim, cam.position);
      const d = dir.length();
      // A target closer than the 3 m skin would ask for a negative range, which
      // is the same NaN-shaped trap from the other end: call it visible.
      if (!Number.isFinite(d) || d <= 4) { visible++; continue; }
      dir.divideScalar(d);
      const hit = ph.raycast(cam.position, dir, d - 3);
      if (!hit || !hit.hit || !Number.isFinite(hit.distance)) visible++;
      // `Physics.raycast` returns a SHARED scratch object and does not always
      // carry a finite distance on a hit; the first run of this reported four
      // nulls, which is a NaN surviving JSON. Report it honestly rather than
      // emitting a number that is not one.
      else blockedAt.push(isFinite(hit.distance) ? +hit.distance.toFixed(1) : 'hit(no distance)');
    }
    return { inFrustum, visible, blockedAt, camBuried, camY: +cam.position.y.toFixed(1) };
  }

  frameHeroShot({ dist = 18.4, height = 6.4, lookY = 4.7, fov = 34, yaw = null } = {}) {
    const sun = this.game.sky?.sunDirection;
    const pts = this.game.level?.spawnPoints;
    const ph = this.game.physics;
    if (!sun || !pts?.length || !ph?.raycast) return false;

    const up = new THREE.Vector3(0, 1, 0);
    const sunH = new THREE.Vector3(sun.x, 0, sun.z).normalize();
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    const toMech = new THREE.Vector3();

    let best = null;
    let bestScore = -Infinity;

    for (const sp of pts) {
      const g = ph.groundHeight?.(sp.x, sp.z);
      if (!isFinite(g)) continue;
      const feetY = g;

      // Is the mech's upper body actually in direct sun?
      origin.set(sp.x, feetY + 6, sp.z);
      const sunHit = ph.raycast(origin, sun, 400);
      if (sunHit && sunHit.hit) continue;

      // Minimum horizontal elbow room — the SUM hid a close wall.
      let minClear = Infinity;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        dir.set(Math.cos(a), 0, Math.sin(a));
        const h = ph.raycast(origin, dir, 60);
        minClear = Math.min(minClear, h && h.hit ? h.distance : 60);
      }
      if (minClear < 14) continue; // camera needs to stand back this far

      // Try camera bearings around the mech and validate each one.
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        camPos.set(sp.x + Math.cos(a) * dist, feetY + height, sp.z + Math.sin(a) * dist);

        const camGround = ph.groundHeight?.(camPos.x, camPos.z);
        if (isFinite(camGround) && camPos.y < camGround + 1.5) continue; // underground

        // Nothing between the lens and the mech.
        toMech.set(sp.x - camPos.x, feetY + lookY - camPos.y, sp.z - camPos.z);
        const span = toMech.length();
        toMech.normalize();
        const block = ph.raycast(camPos, toMech, span - 1.5);
        if (block && block.hit) continue;

        // Sun side-on to the view direction puts the shadow blade across frame.
        const viewH = new THREE.Vector3(toMech.x, 0, toMech.z).normalize();
        const sideOn = 1 - Math.abs(viewH.dot(sunH)); // 1 = perpendicular

        const score = sideOn * 100 + Math.min(minClear, 60);
        if (score > bestScore) {
          bestScore = score;
          best = { sp, feetY, a, camPos: camPos.clone(), sideOn };
        }
      }
    }

    if (!best) return false;

    // Face the mech roughly toward the camera so we see its front.
    const faceYaw = yaw != null ? yaw : Math.atan2(best.camPos.x - best.sp.x, best.camPos.z - best.sp.z);
    this.placePlayerOnGround(best.sp.x, best.sp.z, faceYaw);
    this.setCamera(
      { x: best.camPos.x, y: best.camPos.y, z: best.camPos.z },
      { x: best.sp.x, y: best.feetY + lookY, z: best.sp.z },
      fov
    );
    this._lastHeroFraming = { sideOn: +best.sideOn.toFixed(2), score: +bestScore.toFixed(1) };
    return true;
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
      // The HUD re-derives its pause card from `input.locked` every frame and
      // ignores setPaused(), so overriding the HUD does not survive a single
      // step(). Simulate the pointer lock instead — which is honest, since a
      // capture is standing in for a real locked-pointer play session — and the
      // HUD's own logic then produces the right answer on its own.
      const input = window.__ACNTR__?.input || this.game.input;
      if (input) input.locked = true;
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

  /**
   * Render the mech as a flat black shape on white, framed to a fixed size.
   *
   * This exists because "does the silhouette read as an Armored Core" had been
   * argued three times from screenshots and settled none of them. A lit render
   * hides the answer: paint, panel lines and rim light all give the eye things
   * to latch onto that a black shape does not. Strip those away and the
   * question becomes measurable — see tools/silhouette.mjs, which counts the
   * enclosed sky-gaps, the fill ratio and the width profile down the body.
   *
   * The framing is derived from the mech's own bounding box rather than a fixed
   * camera, so the numbers stay comparable across iterations that change the
   * mech's size. Everything is restored by `silhouette({ on: false })`.
   *
   * @param {{on?:boolean, yaw?:number, fov?:number, pad?:number}} [opts]
   */
  silhouette({ on = true, yaw = 0, fov = 26, pad = 1.14 } = {}) {
    const g = this.game;
    const root = g.player?.root;
    const renderer = g.engine?.renderer;
    if (!root || !renderer) return this;

    if (!on) {
      const s = this._silhouette;
      if (!s) return this;
      if (s.pipelineRender) g.pipeline.render = s.pipelineRender;
      g.scene.background = s.background;
      g.scene.fog = s.fog;
      renderer.toneMapping = s.toneMapping;
      renderer.setClearColor(s.clearColor, s.clearAlpha);
      g.engine.timeScale = s.timeScale;
      if (s.near != null) {
        const cam = g.engine.camera;
        cam.near = s.near;
        cam.far = s.far;
        cam.updateProjectionMatrix();
      }
      for (const [obj, vis] of s.hidden) obj.visible = vis;
      for (const [mesh, mat] of s.materials) mesh.material = mat;
      for (const m of s.temp) m.dispose();
      this._silhouette = null;
      this.releaseCamera();
      return this;
    }

    if (this._silhouette) this.silhouette({ on: false });

    const s = {
      pipelineRender: null,
      background: g.scene.background,
      fog: g.scene.fog,
      toneMapping: renderer.toneMapping,
      clearColor: new THREE.Color(),
      clearAlpha: renderer.getClearAlpha(),
      timeScale: g.engine.timeScale,
      hidden: [],
      materials: [],
      temp: [],
    };
    renderer.getClearColor(s.clearColor);

    // Freeze the simulation for the duration. Hiding the level takes the ground
    // out from under the controller, so the mech free-falls — it was 16 m lower
    // by the second capture and had left the frame the camera was fitted to,
    // which presented as "the renderer draws nothing" for three runs. A shape
    // test wants a static subject anyway.
    g.engine.timeScale = 0;

    // Bypass the whole post stack. Bloom would eat into the shape's edge from
    // the white side and DOF would soften it, and both would do so by an amount
    // that varies with the framing — which is exactly the measurement noise
    // this mode exists to remove.
    if (g.pipeline?.render) {
      s.pipelineRender = g.pipeline.render;
      g.pipeline.render = () => {
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(g.scene, g.engine.camera);
      };
    }

    const WHITE = new THREE.Color(1, 1, 1);
    g.scene.background = WHITE;
    g.scene.fog = null;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(WHITE, 1);

    // Only the mech. Sky domes, terrain and props are all top-level children.
    for (const child of g.scene.children) {
      if (child === root) continue;
      s.hidden.push([child, child.visible]);
      child.visible = false;
    }

    // Solid chassis only. Trails, plumes, sprites and debug lines are hidden
    // rather than blacked out: a silhouette test measures the machine, not its
    // exhaust, and a Points cloud drawn black would both corrupt the shape and
    // (because its bounding volume is far larger than the geometry it draws)
    // drag the framing off the mech entirely.
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
    s.temp.push(black);
    const chassis = [];
    root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        if (!o.visible) return;
        s.materials.push([o, o.material]);
        o.material = black;
        chassis.push(o);
      } else if (o.isPoints || o.isSprite || o.isLine || o.isLineSegments) {
        s.hidden.push([o, o.visible]);
        o.visible = false;
      }
    });

    // Frame from the mech's own bounds so the shape lands at the same size in
    // every iteration, whatever the geometry underneath has done.
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const meshBox = new THREE.Box3();
    for (const m of chassis) {
      if (!m.geometry) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      if (!m.geometry.boundingBox) continue;
      meshBox.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      box.union(meshBox);
    }
    if (box.isEmpty()) box.setFromObject(root);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const cam = g.engine.camera;
    const aspect = cam.aspect || 16 / 9;
    const vFov = (fov * Math.PI) / 180;
    const distV = (size.y * 0.5 * pad) / Math.tan(vFov * 0.5);
    const spanH = Math.max(size.x, size.z);
    const distH = (spanH * 0.5 * pad) / (Math.tan(vFov * 0.5) * aspect);
    const dist = Math.max(distV, distH);

    // The shape must not be clipped by a near/far tuned for gameplay ranges.
    s.near = cam.near;
    s.far = cam.far;
    cam.near = Math.max(0.05, dist * 0.05);
    cam.far = dist * 4 + size.length();
    cam.updateProjectionMatrix();

    const eye = {
      x: centre.x + Math.sin(yaw) * dist,
      y: centre.y,
      z: centre.z + Math.cos(yaw) * dist,
    };
    this.setCamera(eye, { x: centre.x, y: centre.y, z: centre.z }, fov);
    // Apply it now rather than waiting for a late-update: the sim is frozen, so
    // there may not be another one before the mask is read.
    this._applyCameraOverride(0, 0);

    // Recorded so the audit tool can report the framing it actually got. An
    // empty mask is otherwise indistinguishable between "the mech has no
    // geometry", "the box is wrong" and "the camera override never applied",
    // and guessing between those cost two runs.
    s.framing = {
      chassisMeshes: chassis.length,
      sceneChildrenHidden: s.hidden.length,
      boxMin: centre.clone().sub(size.clone().multiplyScalar(0.5)).toArray().map((n) => +n.toFixed(2)),
      boxSize: size.toArray().map((n) => +n.toFixed(2)),
      centre: centre.toArray().map((n) => +n.toFixed(2)),
      dist: +dist.toFixed(2),
      eye: [eye.x, eye.y, eye.z].map((n) => +n.toFixed(2)),
      near: +cam.near.toFixed(2),
      far: +cam.far.toFixed(2),
    };
    this._silhouette = s;
    return this;
  }

  /**
   * Where the camera actually ended up in silhouette mode, and what it is
   * looking at. `camPos` is read live, so it also reveals whether the camera
   * override survived the frame or something else moved the camera afterwards.
   */
  silhouetteInfo() {
    if (!this._silhouette) return null;
    const cam = this.game.engine.camera;
    return {
      ...this._silhouette.framing,
      camPos: cam.position.toArray().map((n) => +n.toFixed(2)),
      camFov: cam.fov,
      overrideActive: !!this.cameraOverride,
    };
  }

  /**
   * Read the current silhouette back as a binary mask.
   *
   * Renders to an offscreen target rather than scraping the canvas: the
   * drawing buffer is not guaranteed to survive to the next task, so canvas
   * readback returns whatever the compositor left behind. Aspect is matched to
   * the live camera so the mask frames exactly like the screenshot beside it.
   *
   * @param {number} [width]
   * @returns {{w:number,h:number,mask:Uint8Array}|null} 1 = mech, 0 = background
   */
  silhouetteMask(width = 512) {
    const g = this.game;
    const renderer = g.engine?.renderer;
    if (!renderer || !this._silhouette) return null;

    const cam = g.engine.camera;
    const w = Math.max(64, Math.round(width));
    const h = Math.max(64, Math.round(w / (cam.aspect || 16 / 9)));

    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
    });
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(g.scene, cam);

    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(prevTarget);
    rt.dispose();

    // readRenderTargetPixels returns bottom-up; flip so row 0 is the top of the
    // frame and the width profile reads head-to-foot.
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        mask[y * w + x] = buf[(src + x) * 4] < 128 ? 1 : 0;
      }
    }
    return { w, h, mask };
  }

  /**
   * Toggle individual post passes so a critic can isolate what a pass costs.
   *
   * The real switches are the booleans on `pipeline.q` — `{ taa, ssao, ssr,
   * motionBlur, dof, ... }`, set by `setQuality()`. This used to write
   * `pipeline.params[name]` and then call a `setPassEnabled` that does not
   * exist on the pipeline, so for every pass whose params entry is an object of
   * tunables rather than a bare boolean (dof, bloom, taa, vignette — most of
   * them) it silently did nothing and reported success. A debug affordance that
   * quietly no-ops is worse than one that is missing: it makes an A/B look
   * conclusive when both frames are identical.
   *
   * Returns `this` for chaining; read `debug.passes()` to see what actually took.
   */
  setPass(name, on) {
    const p = this.game.pipeline;
    if (!p) return this;
    let applied = false;
    if (p.q && typeof p.q[name] === 'boolean') {
      p.q[name] = !!on;
      applied = true;
    }
    if (p.params && name in p.params) {
      const v = p.params[name];
      if (v && typeof v === 'object' && 'enabled' in v) { v.enabled = !!on; applied = true; }
      else if (typeof v === 'boolean') { p.params[name] = !!on; applied = true; }
    }
    if (typeof p.setPassEnabled === 'function') { p.setPassEnabled(name, on); applied = true; }
    if (!applied) console.warn(`[debug] setPass('${name}') matched no switch — try one of: ${Object.keys(p.q || {}).join(', ')}`);
    return this;
  }

  /** The pass switches that actually exist, and their current state. */
  passes() {
    const q = this.game.pipeline?.q;
    if (!q) return null;
    const out = {};
    for (const k of Object.keys(q)) if (typeof q[k] === 'boolean') out[k] = q[k];
    return out;
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
