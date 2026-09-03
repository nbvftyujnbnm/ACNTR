import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import * as M from '../core/MathUtils.js';

/**
 * CameraRig — AC6 third-person, over-the-shoulder boom camera.
 *
 * The camera is a *feel* system, not a transform system. Everything here exists
 * to sell speed and weight:
 *
 *   - rotation is nearly instant (input lag is death), position trails behind
 *   - FOV breathes with the thruster state and punches on a quick boost
 *   - the boom whips: a QB throws the camera backward, then it catches up
 *   - roll banks the horizon on lateral velocity
 *   - lock-on gently biases yaw/pitch so player AND target stay framed, without
 *     ever taking the stick away from the player
 *   - trauma-based shake (trauma², decaying) drives position + rotation + FOV
 *   - weapon fire kicks the camera along a spring
 *   - a sphere-cast pulls the boom in through geometry: fast in, slow out
 *
 * Writes `player.aimYaw` / `player.aimPitch`, which PlayerController and MechRig read.
 */

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _boom = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _castDir = new THREE.Vector3();
const _pivotTarget = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _shakePos = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();

const PITCH_LIMIT = 72 * M.DEG;

/** Cheap smooth value noise — shake needs continuity, not white noise. */
function noise1(seed, t) {
  const i = Math.floor(t);
  const f = t - i;
  const a = M.hash01(i * 374761393 + seed * 668265263);
  const b = M.hash01((i + 1) * 374761393 + seed * 668265263);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}
/** Two-octave version so the shake has both a body and a rattle. */
function shakeNoise(seed, t) {
  return noise1(seed, t) * 0.68 + noise1(seed + 91, t * 2.37) * 0.32;
}

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

export const DEFAULT_CAM = {
  pivotHeight: 4.5,
  // MEASURED, not guessed. The mech's mesh is 8.71 m tall. At the old 13 m
  // boom and a 58 deg FOV the visible height at the pivot is 2*13*tan(29 deg)
  // = 14.4 m, so the mech covered 0.63 of the frame — confirmed by projecting
  // its bounding box in tools/probes/framing.js, and plainly visible in the
  // first real gameplay frame this project captured, where the player buries
  // the fight behind it. An AC6 gameplay screenshot frames the player AC
  // nearer 0.30 of frame height, with the arena and its targets around it.
  // The same sweep prices the alternatives: 22 m gives 0.37, 25 m gives 0.33,
  // 26 m gives 0.31, and past ~30 m the mech is small enough that the panel
  // and grime work stops reading at all. 25 m sits at the top of the AC6 band
  // without throwing that away.
  distance: 25.0,
  shoulder: 0.7,
  distanceSpeedGain: 0.052, // metres of pull-back per m/s over walk speed
  distanceSpeedMax: 3.4,

  rotRate: 45, // aim smoothing — snappy, just enough to kill mouse stair-stepping
  pivotRate: 13, // positional trail; deliberately slower than rotation
  pivotRateWhip: 4.4, // during a QB whip the pivot lags hard
  whipTime: 0.24,

  collisionRadius: 0.9,
  collisionPad: 0.55,
  pullInRate: 42, // fast: never clip
  pushOutRate: 5.0, // slow: never jitter

  fovBase: 58,
  fovBoost: 6,
  fovAssault: 18,
  fovQbPunch: 4,
  fovSpeedGain: 0.1,
  fovSpeedMax: 5,
  fovLockPull: 6,
  fovRate: 6.5,
  fovPunchRate: 6.0,

  rollMax: 5 * M.DEG,
  rollSpeedRef: 38,
  rollQb: 3.6 * M.DEG,
  rollRate: 6.0,

  whipDistance: 3.2,
  whipMax: 4.6,
  whipDecay: 6.5,

  lockAssistYaw: 4.2, // rad/s of gentle correction
  lockAssistPitch: 3.4,
  lockTargetWeightNear: 0.6, // close target: split framing so the mech stays in shot
  lockTargetWeightFar: 1.0, // far target: look straight at it

  shakeFreq: 23,
  shakePos: 0.62,
  shakeRot: 0.038,
  shakeRoll: 0.06,
  shakeFov: 2.4,

  recoilStiff: 300,
  recoilDamp: 33,
};

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} player Entity
   * @param {import('../core/Input.js').Input} input
   * @param {object} physics
   */
  constructor(camera, player, input, physics) {
    this.camera = camera;
    this.player = player;
    this.input = input;
    this.physics = physics;

    this.cfg = Object.assign({}, DEFAULT_CAM);

    this.yaw = 0;
    this.pitch = -0.06;
    this.roll = 0;

    this._smYaw = 0;
    this._smPitch = this.pitch;
    this._smRoll = 0;

    this.pivot = new THREE.Vector3();
    this._lag = new THREE.Vector3(); // QB whip offset, world space
    this._whipTimer = 0;

    this._boomDist = this.cfg.distance;
    this._targetDist = this.cfg.distance;

    this.baseFov = num(camera?.fov, this.cfg.fovBase) || this.cfg.fovBase;
    this.cfg.fovBase = this.baseFov;
    this._fov = this.baseFov;
    this._fovPunch = 0;
    this._lastAppliedFov = -1;

    // trauma shake
    this.trauma = 0;
    this._shakeDecay = 2.2;
    this._shakeTime = 0;

    // recoil spring (pitch, yaw, push)
    this._recPitch = 0;
    this._recPitchV = 0;
    this._recYaw = 0;
    this._recYawV = 0;
    this._recPush = 0;
    this._recPushV = 0;

    this._qbRoll = 0;
    this._assaultActive = false;

    if (player) {
      const startPos = player.root?.position;
      if (startPos) this.pivot.set(startPos.x, startPos.y + this.cfg.pivotHeight, startPos.z);
    }

    this._offs = [
      bus.on(EV.SHAKE, (e) => {
        if (typeof e === 'number') this.addShake(e, 0.35);
        else this.addShake(num(e?.intensity, num(e?.amount, 0.3)), num(e?.duration, 0.35));
      }),
      bus.on(EV.WEAPON_FIRED, (e) => this._onWeaponFired(e)),
      bus.on(EV.QUICK_BOOST, (e) => this._onQuickBoost(e)),
      bus.on(EV.LANDED, (e) => this._onLanded(e)),
      bus.on(EV.ASSAULT_BOOST, (e) => {
        const active = !!e?.active;
        if (active && !this._assaultActive) this.addShake(0.18, 0.4);
        this._assaultActive = active;
      }),
      bus.on(EV.PLAYER_HIT, (e) => this.addShake(M.clamp(num(e?.amount, 12) / 260, 0.08, 0.55), 0.3)),
      bus.on(EV.EN_EMPTY, (e) => {
        if (!e || e.entity === this.player) this.addShake(0.24, 0.5);
      }),
    ];
  }

  // =========================================================================

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {object} targeting TargetingSystem (optional)
   */
  update(dt, elapsed, targeting) {
    const cam = this.camera;
    const p = this.player;
    if (!cam || !p?.root) return;
    dt = M.clamp(dt, 0, 0.05);

    const C = this.cfg;
    const ms = p.moveState || null;
    const vel = p.velocity;
    const speed = num(ms?.speed, vel ? Math.hypot(vel.x, vel.z) : 0);

    // ---- 1. look input (must match PlayerController._syncAim exactly) -----
    const inp = this.input;
    const sens = num(inp?.sensitivity, 0.0021);
    const dx = num(inp?.mouse?.dx, 0);
    const dy = num(inp?.mouse?.dy, 0);
    this.yaw -= dx * sens;
    this.pitch -= dy * sens * (inp?.invertY ? -1 : 1);
    this.pitch = M.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    const lookInput = M.clamp((Math.abs(dx) + Math.abs(dy)) * 0.045, 0, 1);

    // ---- 2. lock-on framing assist ---------------------------------------
    this._applyLockAssist(dt, targeting, lookInput);

    // ---- 3. rotation smoothing (fast) ------------------------------------
    this._smYaw = M.dampAngle(this._smYaw, this.yaw, C.rotRate, dt);
    this._smPitch = M.damp(this._smPitch, this.pitch, C.rotRate, dt);

    // ---- 4. roll ---------------------------------------------------------
    _camRight.set(Math.cos(this._smYaw), 0, -Math.sin(this._smYaw));
    let rollTarget = 0;
    if (vel) {
      const lateral = vel.x * _camRight.x + vel.z * _camRight.z;
      rollTarget = -M.clamp(lateral / C.rollSpeedRef, -1, 1) * C.rollMax;
    }
    this._qbRoll = M.damp(this._qbRoll, 0, 4.5, dt);
    rollTarget += this._qbRoll;
    this._smRoll = M.damp(this._smRoll, rollTarget, C.rollRate, dt);

    // ---- 5. pivot (slower than rotation → the boom trails) ---------------
    _pivotTarget.set(p.root.position.x, p.root.position.y + C.pivotHeight, p.root.position.z);
    this._whipTimer = Math.max(0, this._whipTimer - dt);
    const pivotRate = this._whipTimer > 0 ? C.pivotRateWhip : C.pivotRate;
    M.dampVec3(this.pivot, _pivotTarget, pivotRate, dt);
    // never let the trail run away — clamp the leash
    _tmp.subVectors(_pivotTarget, this.pivot);
    const leash = _tmp.length();
    if (leash > 6) this.pivot.addScaledVector(_tmp, (leash - 6) / leash);

    // whip offset decays back to zero: the camera catches up
    M.dampVec3(this._lag, ZERO, C.whipDecay, dt);

    // ---- 6. desired boom position ----------------------------------------
    _e.set(this._smPitch, this._smYaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _qYaw.setFromAxisAngle(UP, this._smYaw);

    const speedPull = Math.min(C.distanceSpeedMax, Math.max(0, speed - 14) * C.distanceSpeedGain);
    const wantDist = C.distance + speedPull;

    _boom.set(0, 0, wantDist).applyQuaternion(_q);
    _shoulder.set(C.shoulder, 0, 0).applyQuaternion(_qYaw);
    _desired.copy(this.pivot).add(_boom).add(_shoulder).add(this._lag);

    // ---- 7. collision: sphere-cast the boom ------------------------------
    _castDir.subVectors(_desired, this.pivot);
    let castLen = _castDir.length();
    let allowed = castLen;
    if (castLen <= 1e-4) {
      _castDir.set(0, 0, 1).applyQuaternion(_q);
      castLen = wantDist;
      allowed = wantDist;
    } else {
      _castDir.divideScalar(castLen);
      const hit = this.physics?.sphereCast?.(this.pivot, _castDir, C.collisionRadius, castLen + C.collisionPad);
      if (hit) {
        const d = num(hit.distance, num(hit.dist, num(hit.t, NaN)));
        if (isFinite(d)) allowed = Math.max(2.2, d - C.collisionPad);
      }
    }
    // fast in (never clip), slow out (never jitter)
    const rate = allowed < this._boomDist ? C.pullInRate : C.pushOutRate;
    this._boomDist = M.damp(this._boomDist, Math.min(allowed, castLen), rate, dt);
    this._targetDist = castLen;

    // ---- 8. recoil spring -------------------------------------------------
    this._springRecoil(dt);

    // ---- 9. trauma shake --------------------------------------------------
    this._shakeTime += dt;
    if (this.trauma > 0) this.trauma = Math.max(0, this.trauma - this._shakeDecay * dt);
    const s = this.trauma * this.trauma; // trauma² — small shakes stay subtle
    let shakeYaw = 0;
    let shakePitch = 0;
    let shakeRoll = 0;
    let shakeFov = 0;
    _shakePos.set(0, 0, 0);
    if (s > 1e-4) {
      const t = this._shakeTime * C.shakeFreq;
      _shakePos.set(shakeNoise(1, t) * C.shakePos, shakeNoise(2, t) * C.shakePos * 0.78, shakeNoise(3, t) * C.shakePos * 0.5);
      _shakePos.multiplyScalar(s);
      shakeYaw = shakeNoise(4, t * 0.82) * C.shakeRot * s;
      shakePitch = shakeNoise(5, t * 0.82) * C.shakeRot * s;
      shakeRoll = shakeNoise(6, t * 0.6) * C.shakeRoll * s;
      shakeFov = shakeNoise(7, t * 0.5) * C.shakeFov * s;
    }

    // ---- 10. final transform ---------------------------------------------
    const finalYaw = this._smYaw + shakeYaw + this._recYaw;
    const finalPitch = M.clamp(this._smPitch + shakePitch + this._recPitch, -PITCH_LIMIT - 0.2, PITCH_LIMIT + 0.2);
    _e.set(finalPitch, finalYaw, this._smRoll + shakeRoll, 'YXZ');
    cam.quaternion.setFromEuler(_e);

    cam.position.copy(this.pivot).addScaledVector(_castDir, this._boomDist);
    // shake + recoil push are camera-local
    _camFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _camRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _tmp2.set(0, 1, 0).applyQuaternion(cam.quaternion);
    cam.position.addScaledVector(_camRight, _shakePos.x);
    cam.position.addScaledVector(_tmp2, _shakePos.y);
    cam.position.addScaledVector(_camFwd, _shakePos.z - this._recPush);

    // ---- 11. FOV ----------------------------------------------------------
    this._updateFov(dt, ms, speed, targeting, shakeFov);

    // ---- 12. publish aim + refresh matrices for HUD/targeting projection --
    p.aimYaw = this.yaw;
    p.aimPitch = this.pitch;
    this.roll = this._smRoll;
    // The camera is not in the scene graph and nothing else refreshes it before
    // HUD/targeting project against it, so keep the inverse in sync here.
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  }

  // =========================================================================

  /**
   * Bias the camera so the player AND the locked target both sit in frame.
   * Applied as an additive correction that fades out while the player is
   * actively moving the mouse — the camera assists, it never takes over.
   */
  _applyLockAssist(dt, targeting, lookInput) {
    const t = targeting?.target;
    if (!targeting?.hardLock || !t || t.alive === false) return;
    const C = this.cfg;
    const p = this.player;

    if (t.getAimPoint) t.getAimPoint(_look);
    else if (t.root?.position) _look.copy(t.root.position);
    else return;

    // Midpoint-weighted framing. The weight has to be measured from the CAMERA,
    // not from the pivot: from the pivot every point on the pivot→target segment
    // shares one direction, so the weight would cancel out entirely.
    _tmp.set(p.root.position.x, p.root.position.y + C.pivotHeight, p.root.position.z);
    const dist = _tmp.distanceTo(_look);
    // a very close target would otherwise whip the camera and throw the player
    // out of frame, so near range splits the framing between the two mechs
    const w = M.lerp(C.lockTargetWeightNear, C.lockTargetWeightFar, M.smoothstep(25, 220, dist));
    _tmp2.copy(_tmp).lerp(_look, w);

    _tmp2.sub(this.camera.position); // direction from the camera to the framing point
    const len = _tmp2.length();
    if (len < 1e-3) return;
    _tmp2.divideScalar(len);

    const wantYaw = Math.atan2(-_tmp2.x, -_tmp2.z);
    const wantPitch = Math.asin(M.clamp(_tmp2.y, -1, 1));

    // fade the assist out while the player is steering
    const authority = 1 - M.smoothstep(0.05, 0.6, lookInput);
    if (authority <= 0.001) return;

    this.yaw = M.dampAngle(this.yaw, wantYaw, C.lockAssistYaw * authority, dt);
    this.pitch = M.clamp(
      M.damp(this.pitch, wantPitch, C.lockAssistPitch * authority, dt),
      -PITCH_LIMIT,
      PITCH_LIMIT
    );
  }

  _updateFov(dt, ms, speed, targeting, shakeFov) {
    const C = this.cfg;
    const cam = this.camera;
    let want = C.fovBase;

    if (ms?.assaultBoost) want += C.fovAssault * M.clamp(num(ms.assaultRamp, 1), 0, 1);
    else if (ms?.boosting || this._assaultActive) want += C.fovBoost;
    want += Math.min(C.fovSpeedMax, Math.max(0, speed - 34) * C.fovSpeedGain);

    // slight pull-in when locked at long range: the target reads bigger
    const t = targeting?.hardLock ? targeting.target : null;
    if (t?.root?.position) {
      const d = cam.position.distanceTo(t.root.position);
      want -= C.fovLockPull * M.smoothstep(110, 420, d);
    }

    this._fov = M.damp(this._fov, want, C.fovRate, dt);
    this._fovPunch = M.damp(this._fovPunch, 0, C.fovPunchRate, dt);

    const applied = this._fov + this._fovPunch + shakeFov;
    if (Math.abs(applied - this._lastAppliedFov) > 0.002) {
      cam.fov = applied;
      this._lastAppliedFov = applied;
      cam.updateProjectionMatrix();
    }
  }

  _springRecoil(dt) {
    const C = this.cfg;
    const k = C.recoilStiff;
    const c = C.recoilDamp;
    this._recPitchV += (-this._recPitch * k - this._recPitchV * c) * dt;
    this._recPitch += this._recPitchV * dt;
    this._recYawV += (-this._recYaw * k - this._recYawV * c) * dt;
    this._recYaw += this._recYawV * dt;
    this._recPushV += (-this._recPush * k * 0.7 - this._recPushV * c * 0.8) * dt;
    this._recPush += this._recPushV * dt;
  }

  // --- event handlers ------------------------------------------------------

  _onWeaponFired(e) {
    // only react to the player's own guns when we can tell them apart
    const owner = e?.entity || e?.owner || e?.shooter || null;
    if (owner && owner !== this.player) return;
    if (!owner && e?.isPlayer === false) return;

    const recoil = M.clamp(num(e?.recoil, num(e?.weapon?.recoil, num(e?.def?.recoil, 1))), 0, 40);
    const k = recoil <= 4 ? recoil : recoil / 8; // accept 0..4 "units" or raw impulse
    this._recPitchV += k * 0.62; // muzzle climb
    this._recYawV += (M.hash01((this._shakeTime * 1000) | 0) * 2 - 1) * k * 0.3;
    this._recPushV += k * 0.5; // positive _recPush shoves the camera backward
    this.addShake(M.clamp(k * 0.055, 0.01, 0.35), 0.18);
  }

  _onQuickBoost(e) {
    if (e?.entity && e.entity !== this.player) return;
    const C = this.cfg;
    const d = e?.direction;
    if (d && typeof d.x === 'number') {
      // throw the camera backward along the dash — it then springs forward
      const amount = C.whipDistance * M.clamp(num(e?.strength, 1), 0.4, 1.2);
      this._lag.addScaledVector(d, -amount);
      const l = this._lag.length();
      if (l > C.whipMax) this._lag.multiplyScalar(C.whipMax / l);
      // bank into the dash
      _camRight.set(Math.cos(this._smYaw), 0, -Math.sin(this._smYaw));
      const lat = d.x * _camRight.x + d.z * _camRight.z;
      this._qbRoll = -M.clamp(lat, -1, 1) * C.rollQb;
    }
    this._whipTimer = C.whipTime;
    this._fovPunch += C.fovQbPunch;
    this.addShake(0.16, 0.16);
  }

  _onLanded(e) {
    if (e?.entity && e.entity !== this.player) return;
    const v = num(e?.impactSpeed, 0);
    if (v < 4) return;
    const k = M.clamp((v - 4) / 42, 0, 1);
    this.addShake(0.14 + k * 0.7, 0.2 + k * 0.35);
    this._recPushV -= 0.4 + k * 2.2; // the whole rig compresses
    this._recPitchV -= (0.5 + k * 2.4) * 0.35;
  }

  // --- public --------------------------------------------------------------

  /**
   * Add camera trauma. Shake amplitude is trauma², so stacking small hits stays
   * readable while a big one really slams.
   * @param {number} intensity 0..1
   * @param {number} duration seconds for this contribution to decay away
   */
  addShake(intensity, duration = 0.35) {
    const i = M.clamp(num(intensity, 0), 0, 1);
    if (i <= 0) return;
    const d = Math.max(0.06, num(duration, 0.35));
    const newDecay = 1 / d;
    const total = this.trauma + i;
    this._shakeDecay = total > 0 ? (this._shakeDecay * this.trauma + newDecay * i) / total : newDecay;
    this.trauma = Math.min(1, total);
  }

  /** Snap the rig to the player with no trail — use after teleports/respawn. */
  reset() {
    const p = this.player;
    this.trauma = 0;
    this._lag.set(0, 0, 0);
    this._whipTimer = 0;
    this._recPitch = this._recPitchV = this._recYaw = this._recYawV = this._recPush = this._recPushV = 0;
    this._qbRoll = 0;
    this._fovPunch = 0;
    this._fov = this.baseFov;
    this._smYaw = this.yaw;
    this._smPitch = this.pitch;
    this._smRoll = 0;
    this._boomDist = this.cfg.distance;
    if (p?.root?.position) {
      this.pivot.set(p.root.position.x, p.root.position.y + this.cfg.pivotHeight, p.root.position.z);
    }
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}

export default CameraRig;
