import * as THREE from 'three';
import { clamp, lerp, damp, dampAngle, shortestAngle, smoothstep } from '../core/MathUtils.js';

/**
 * MechRig — fully procedural animation. There are no skeletal assets in this
 * project; every bone transform below is solved each frame.
 *
 * The silhouette rules that make this read as an Armored Core rather than a
 * generic robot:
 *   - The upper body LEADS and the lower body FOLLOWS. The torso snaps to the aim
 *     direction inside a hard limit and the pelvis drags after it with lag; when
 *     you are moving the legs point along the velocity instead of the aim.
 *   - Boosting is not "walking in the air". Legs tuck and trail, the body pitches
 *     over its centre of mass and the ankles point back — a completely different
 *     pose that blends in over ~0.25 s.
 *   - Everything is driven by critically damped springs, so impulses (recoil,
 *     landing, quick boost) overshoot and settle instead of lerping linearly.
 *
 * Hot-path rule: `update()` allocates nothing. All scratch objects are module
 * scope, all per-leg storage is created once in the constructor.
 */

// --- module scratch (never allocated per frame) -----------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwdB = new THREE.Vector3();
const _fwdRef = new THREE.Vector3();
const _hipW = new THREE.Vector3();
const _baseW = new THREE.Vector3();
const _plant = new THREE.Vector3();
const _velL = new THREE.Vector3();
const _mBasis = new THREE.Matrix4();
const _mPelvis = new THREE.Matrix4();
const _mPelvisInv = new THREE.Matrix4();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qAcc = new THREE.Quaternion();
const _qF = new THREE.Quaternion();
const _eF = new THREE.Euler();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _ZERO = new THREE.Vector3();

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Springs
// ---------------------------------------------------------------------------

/** Critically damped scalar spring. Sub-steps so a stiff spring cannot explode. */
class Spring {
  constructor(stiffness = 120, value = 0) {
    this.k = stiffness;
    this.c = 2 * Math.sqrt(stiffness);
    this.x = value;
    this.v = 0;
    this.target = value;
  }
  setStiffness(k) { this.k = k; this.c = 2 * Math.sqrt(k); }
  kick(impulse) { this.v += impulse; }
  step(dt) {
    const n = dt > 0.02 ? Math.min(6, Math.ceil(dt / 0.008)) : 1;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += ((this.target - this.x) * this.k - this.v * this.c) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(v = 0) { this.x = this.target = v; this.v = 0; }
}

/** Three independent critically damped springs sharing one Vector3. */
class Spring3 {
  constructor(stiffness = 90) {
    this.k = stiffness;
    this.c = 2 * Math.sqrt(stiffness);
    this.x = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.target = new THREE.Vector3();
  }
  kick(x, y, z) { this.v.x += x; this.v.y += y; this.v.z += z; }
  step(dt) {
    const n = dt > 0.02 ? Math.min(6, Math.ceil(dt / 0.008)) : 1;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v.x += ((this.target.x - this.x.x) * this.k - this.v.x * this.c) * h;
      this.v.y += ((this.target.y - this.x.y) * this.k - this.v.y * this.c) * h;
      this.v.z += ((this.target.z - this.x.z) * this.k - this.v.z * this.c) * h;
      this.x.addScaledVector(this.v, h);
    }
    return this.x;
  }
  reset() { this.x.set(0, 0, 0); this.v.set(0, 0, 0); this.target.set(0, 0, 0); }
}

// ---------------------------------------------------------------------------
// MechRig
// ---------------------------------------------------------------------------

export class MechRig {
  /**
   * @param {THREE.Object3D} mechRoot the mech's world transform
   * @param {object} bones see `.bones` — must contain at least pelvis/torso/headYaw
   * @param {object} [cfg] { legType, dims, mech, armSlots }
   */
  constructor(mechRoot, bones, cfg = {}) {
    this.root = mechRoot;
    this.bones = bones;
    this.mech = cfg.mech || null;
    this.legType = cfg.legType || 'biped';
    this.dims = cfg.dims || {};
    this.scale = cfg.scale || 1;

    /** Optional world-space ground sampler: (x, z) => y. Wired by the game. */
    this.groundAt = cfg.groundAt || null;
    /** Legless archetypes (drones, hover platforms) idle-bob instead of walking. */
    this.hover = !!cfg.hover;
    this._hoverY = 0;

    this._t = 0;
    this._cycle = 0;

    // rest transforms — every pose is expressed as a delta from these
    this._rest = new Map();
    for (const k of Object.keys(bones)) {
      const b = bones[k];
      if (b && b.isObject3D) this._rest.set(k, b.position.clone());
    }
    this._hipsRestY = bones.hips ? bones.hips.position.y : 0;

    // --- aim chain state -------------------------------------------------
    this._pelvisYaw = 0;
    this._torsoYaw = 0;
    this._headYawA = 0;
    this._torsoPitch = 0;
    this._headPitch = 0;
    this._torsoRoll = 0;
    this._leanZ = 0;

    // --- mode blend weights ----------------------------------------------
    this.wBoost = 0;
    this.wAssault = 0;
    this.wAir = 0;
    this.wStagger = 0;

    // --- springs ----------------------------------------------------------
    this.sLand = new Spring(78);        // knee compression on touchdown
    this.sPitch = new Spring(64);       // torso pitch impulses
    this.sYawKick = new Spring(90);     // torso yaw ripple from recoil
    this.sQuick = new Spring3(58);      // quick-boost body lurch (root-local)
    this.sRecoil = { rArm: new Spring(150), lArm: new Spring(150), rShoulder: new Spring(110), lShoulder: new Spring(110) };
    this._recoilKeys = Object.keys(this.sRecoil);

    // --- edge detection ---------------------------------------------------
    this._wasGrounded = true;
    this._wasQuick = false;
    this._wasFiring = { rArm: false, lArm: false, rShoulder: false, lShoulder: false };
    this._prevVelY = 0;

    this._buildLegs();

    // arm pose state
    this.armPose = [
      { pitch: 0, roll: 0, fore: 0 },
      { pitch: 0, roll: 0, fore: 0 },
    ];
  }

  _buildLegs() {
    const b = this.bones;
    const d = this.dims;
    const L1 = d.thigh ?? 1.85;
    const L2 = d.shin ?? 1.58;
    const footX = d.footX ?? 0.95;
    const bendZ = this.legType === 'reverse' ? 1 : -1;

    this.legs = [];
    const defs = [
      ['lLegUpper', 'lLegLower', 'lFoot', -1, 0.0, 0],
      ['rLegUpper', 'rLegLower', 'rFoot', 1, 0.5, 0],
      ['lLegUpper2', 'lLegLower2', 'lFoot2', -1, 0.25, 1],
      ['rLegUpper2', 'rLegLower2', 'rFoot2', 1, 0.75, 1],
    ];
    for (const [u, l, f, side, phase, pair] of defs) {
      if (!b[u] || !b[l] || !b[f]) continue;
      this.legs.push({
        upper: b[u], lower: b[l], foot: b[f],
        side, phase, pair, bendZ,
        L1, L2,
        hipLocal: b[u].position.clone(),
        restLocal: (b[u].userData.restFoot || new THREE.Vector3(side * footX, 0, pair ? 1.5 : 0)).clone(),
        world: new THREE.Vector3(),
        swingFrom: new THREE.Vector3(),
        swingTo: new THREE.Vector3(),
        target: new THREE.Vector3(),
        swingT: -1,
        prevP: 0,
        footPitch: 0,
      });
    }
    // seed foot world positions under the mech
    this.root.updateWorldMatrix(true, false);
    for (const leg of this.legs) {
      leg.world.copy(leg.restLocal).applyMatrix4(this.root.matrixWorld);
      leg.target.copy(leg.world);
    }
  }

  /** Wire a world-space ground height sampler, e.g. `physics.groundHeight`. */
  setGroundSampler(fn) { this.groundAt = fn; }

  /** External impulse: a weapon fired on `slot` ('rArm'|'lArm'|'rShoulder'|'lShoulder'). */
  fireRecoil(slot, amount = 1) {
    const s = this.sRecoil[slot];
    if (!s) return;
    s.kick(amount * 9);
    this.sPitch.kick(-amount * 1.4);
    this.sYawKick.kick((slot[0] === 'r' ? -1 : 1) * amount * 1.1);
  }

  /** External impulse: quick boost in a world-space horizontal direction. */
  quickBoostImpulse(dx, dz, amount = 1) {
    const len = Math.hypot(dx, dz) || 1;
    // convert to root-local so the lurch is body-relative
    const y = this.root.rotation.y;
    const cs = Math.cos(-y), sn = Math.sin(-y);
    const lx = (dx / len) * cs - (dz / len) * sn;
    const lz = (dx / len) * sn + (dz / len) * cs;
    this.sQuick.kick(lx * amount * 5.2, 0, lz * amount * 5.2);
    this.sPitch.kick(-lz * amount * 2.4);
  }

  /** External impulse: touchdown. `impact` in m/s of downward velocity. */
  land(impact) {
    const a = clamp(Math.abs(impact) / 26, 0, 1.4);
    this.sLand.kick(a * 5.5);
    this.sPitch.kick(a * 1.8);
  }

  /**
   * @param {number} dt seconds
   * @param {object} state { velocity, grounded, boosting, quickBoost, assaultBoost,
   *                         aimYaw, aimPitch, speed, staggered, firing }
   *   `aimYaw` is a WORLD yaw in radians; `aimPitch` is positive when aiming up.
   */
  update(dt, state) {
    if (dt <= 0) return;
    if (dt > 0.05) dt = 0.05;
    this._t += dt;
    const t = this._t;
    const b = this.bones;
    const st = state || _EMPTY_STATE;

    const vel = st.velocity || _ZERO;
    const grounded = st.grounded !== false;
    const boosting = !!st.boosting;
    const assault = !!st.assaultBoost;
    const staggered = !!st.staggered;
    const speed = st.speed ?? Math.hypot(vel.x, vel.z);

    // -----------------------------------------------------------------
    // 1. edge detection -> impulses
    // -----------------------------------------------------------------
    if (grounded && !this._wasGrounded) this.land(this._prevVelY);
    this._wasGrounded = grounded;
    this._prevVelY = vel.y;

    const qb = st.quickBoost;
    const qbActive = !!qb;
    if (qbActive && !this._wasQuick) {
      if (qb && typeof qb === 'object' && ('x' in qb)) this.quickBoostImpulse(qb.x, qb.z ?? 0, 1);
      else this.quickBoostImpulse(vel.x, vel.z, 1);
    }
    this._wasQuick = qbActive;

    const firing = st.firing;
    if (firing) {
      for (let i = 0; i < this._recoilKeys.length; i++) {
        const k = this._recoilKeys[i];
        const on = firing === true ? (k === 'rArm') : !!firing[k];
        if (on && !this._wasFiring[k]) this.fireRecoil(k, 1);
        this._wasFiring[k] = on;
      }
    }

    // -----------------------------------------------------------------
    // 2. mode blend weights
    // -----------------------------------------------------------------
    this.wAir = damp(this.wAir, grounded ? 0 : 1, 7, dt);
    this.wBoost = damp(this.wBoost, boosting || !grounded ? 1 : 0, 6.5, dt);
    this.wAssault = damp(this.wAssault, assault ? 1 : 0, 5, dt);
    this.wStagger = damp(this.wStagger, staggered ? 1 : 0, 9, dt);
    // "tuck" = how far the legs have left the walk cycle for the flight pose
    const tuck = clamp(Math.max(this.wAir, this.wBoost * 0.85, this.wAssault), 0, 1);

    // -----------------------------------------------------------------
    // 3. springs
    // -----------------------------------------------------------------
    const land = this.sLand.step(dt);
    const pitchK = this.sPitch.step(dt);
    const yawK = this.sYawKick.step(dt);
    const qbo = this.sQuick.step(dt);
    for (let i = 0; i < this._recoilKeys.length; i++) this.sRecoil[this._recoilKeys[i]].step(dt);

    // -----------------------------------------------------------------
    // 4. aim chain: torso leads, pelvis follows, head tracks tightest
    // -----------------------------------------------------------------
    const rootYaw = this.root.rotation.y;
    const aimYaw = st.aimYaw ?? rootYaw;
    const aimPitch = st.aimPitch ?? 0;
    const want = shortestAngle(rootYaw, aimYaw);

    const torsoLimit = 60 * DEG;
    const headLimit = 34 * DEG;
    // overflow beyond what the torso can twist has to be taken up by the legs
    let legTarget = want - clamp(want, -torsoLimit, torsoLimit);

    // local-space velocity: while moving, the legs point where you are GOING
    _velL.set(vel.x, 0, vel.z);
    const cs = Math.cos(-rootYaw), sn = Math.sin(-rootYaw);
    const vlx = _velL.x * cs - _velL.z * sn;
    const vlz = _velL.x * sn + _velL.z * cs;
    if (grounded && speed > 1.2) {
      const moveYaw = Math.atan2(-vlx, -vlz);
      const w = Math.min(1, speed / 10) * 0.75 * (1 - this.wAssault);
      legTarget = lerp(legTarget, clamp(moveYaw, -50 * DEG, 50 * DEG), w);
    }
    this._pelvisYaw = dampAngle(this._pelvisYaw, legTarget, grounded ? 4.5 : 2.6, dt);

    const torsoWant = clamp(want - this._pelvisYaw, -torsoLimit, torsoLimit);
    this._torsoYaw = dampAngle(this._torsoYaw, torsoWant, 13, dt);
    const headWant = clamp(want - this._pelvisYaw - this._torsoYaw, -headLimit, headLimit);
    this._headYawA = dampAngle(this._headYawA, headWant, 16, dt);

    // pitch: boost/assault lean dominates, aim contributes, springs add impulses
    const leanTarget = -0.10 * this.wBoost - 0.46 * this.wAssault + 0.30 * this.wStagger;
    this._leanZ = damp(this._leanZ, leanTarget, 6, dt);
    const torsoPitchWant = aimPitch * 0.38 + this._leanZ + 0.06; // +0.06: permanent forward set
    this._torsoPitch = damp(this._torsoPitch, torsoPitchWant, 11, dt) + pitchK * 0.05;
    this._headPitch = damp(this._headPitch, aimPitch * 0.34, 14, dt);

    // roll from strafing + quick-boost inertia
    const strafeRoll = clamp(-vlx * 0.016, -0.16, 0.16);
    this._torsoRoll = damp(this._torsoRoll, strafeRoll, 7, dt) - qbo.x * 0.035;

    // -----------------------------------------------------------------
    // 5. hips / pelvis / torso transforms
    // -----------------------------------------------------------------
    const walkW = clamp((1 - tuck) * Math.min(1, speed / 2.2), 0, 1);
    const strideLen = clamp(2.6 + speed * 0.34, 2.6, 6.0) * this.scale;
    const cycleFreq = clamp(speed / strideLen, 0, 3.2);
    this._cycle = (this._cycle + cycleFreq * dt) % 1;
    const cyc = this._cycle * Math.PI * 2;

    if (this.hover) {
      this._hoverY = (Math.sin(t * 1.7) * 0.20 + Math.sin(t * 2.63 + 1.1) * 0.09) * (1 - this.wStagger * 0.6);
    }

    const shudder = staggered || this.wStagger > 0.01
      ? (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 23.3) * 0.4) * this.wStagger
      : 0;

    if (b.hips) {
      const bob = Math.sin(cyc * 2) * 0.075 * walkW;
      b.hips.position.set(
        qbo.x * 0.16 + shudder * 0.03,
        this._hipsRestY + bob - land * 0.11 - this.wStagger * 0.22 + this._hoverY,
        qbo.z * 0.16,
      );
    }
    if (b.pelvis) {
      b.pelvis.rotation.set(
        -this._leanZ * 0.25 + this.wStagger * 0.12,
        this._pelvisYaw,
        Math.sin(cyc) * 0.035 * walkW + shudder * 0.012,
      );
    }
    if (b.torso) {
      b.torso.rotation.set(
        this._torsoPitch + shudder * 0.02,
        this._torsoYaw - Math.sin(cyc) * 0.075 * walkW + yawK * 0.05,
        this._torsoRoll - Math.sin(cyc) * 0.028 * walkW,
      );
    }
    if (b.headYaw) b.headYaw.rotation.y = this._headYawA + shudder * 0.03;
    if (b.head) {
      b.head.rotation.x = -this._headPitch + this.wStagger * 0.45 + shudder * 0.02;
      b.head.rotation.z = shudder * 0.02;
    }
    // booster pack gimbals into the thrust direction
    if (b.backpack) {
      b.backpack.rotation.x = damp(b.backpack.rotation.x, -0.16 * this.wBoost - 0.10 * this.wAssault, 8, dt);
    }

    // -----------------------------------------------------------------
    // 6. legs
    // -----------------------------------------------------------------
    this.root.updateWorldMatrix(true, false);
    if (b.hips) b.hips.updateMatrix();
    if (b.pelvis) b.pelvis.updateMatrix();
    _mPelvis.copy(this.root.matrixWorld);
    if (b.hips) _mPelvis.multiply(b.hips.matrix);
    if (b.pelvis) _mPelvis.multiply(b.pelvis.matrix);
    _mPelvisInv.copy(_mPelvis).invert();

    if (this.legs.length) this._updateLegs(dt, speed, cycleFreq, strideLen, tuck, walkW, vlx, vlz, land);

    // -----------------------------------------------------------------
    // 7. arms
    // -----------------------------------------------------------------
    this._updateArms(dt, cyc, walkW, aimPitch);

    // -----------------------------------------------------------------
    // 8. collider follows the body
    // -----------------------------------------------------------------
    const col = this.mech?.collider;
    if (col) {
      col.center.set(
        this.root.position.x,
        this.root.position.y + col.height * 0.5,
        this.root.position.z,
      );
    }
  }

  // -------------------------------------------------------------------------

  _updateLegs(dt, speed, cycleFreq, strideLen, tuck, walkW, vlx, vlz, land) {
    const legs = this.legs;
    const moving = speed > 1.0;
    const swingDur = clamp((1 - 0.60) / Math.max(cycleFreq, 0.7), 0.13, 0.55);
    const lift = (0.30 + speed * 0.028) * this.scale;
    const anySwinging = legs.some(_isSwinging);

    // horizontal move direction in world space
    const mvLen = Math.hypot(vlx, vlz);
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];

      // where this leg would like to plant, in world space
      _baseW.copy(leg.restLocal).applyMatrix4(this.root.matrixWorld);
      _plant.copy(_baseW);
      if (mvLen > 0.001) {
        // stride ahead along the travel direction (transform local vel to world)
        const y = this.root.rotation.y;
        const c = Math.cos(y), s = Math.sin(y);
        const wx = (vlx * c + vlz * s) / mvLen;
        const wz = (-vlx * s + vlz * c) / mvLen;
        _plant.x += wx * strideLen * 0.5;
        _plant.z += wz * strideLen * 0.5;
      }
      _plant.y = this._sampleGround(_plant.x, _plant.z);

      // --- gait state machine ------------------------------------------
      if (leg.swingT >= 0) {
        leg.swingT += dt / swingDur;
        if (leg.swingT >= 1) {
          leg.swingT = -1;
          leg.world.copy(leg.swingTo);
        } else {
          const k = smoothstep(0, 1, leg.swingT);
          leg.world.lerpVectors(leg.swingFrom, leg.swingTo, k);
          leg.world.y += Math.sin(Math.PI * leg.swingT) * lift;
        }
      } else {
        leg.world.y = damp(leg.world.y, this._sampleGround(leg.world.x, leg.world.z), 9, dt);
        let step = false;
        if (moving) {
          const p = (this._cycle + leg.phase) % 1;
          if (p < leg.prevP) step = true;
          leg.prevP = p;
        } else if (!anySwinging) {
          // idle: re-plant a foot that has been dragged too far from its rest spot
          _v1.copy(leg.world).sub(_baseW);
          _v1.y = 0;
          if (_v1.lengthSq() > 0.30 * this.scale * this.scale) step = true;
        }
        if (step && tuck < 0.5) {
          leg.swingFrom.copy(leg.world);
          leg.swingTo.copy(_plant);
          leg.swingT = 0;
        }
      }

      // --- pose target -------------------------------------------------
      // Flight pose: the leg folds up and trails behind the hip. This is
      // expressed body-relative then pushed to world so the blend is stable.
      _v2.copy(leg.hipLocal).applyMatrix4(_mPelvis);
      const sc = this.scale;
      _v3.set(
        leg.side * 0.55 * sc,
        -(leg.L1 + leg.L2) * (0.44 - this.wAssault * 0.10) * sc,
        (leg.bendZ < 0 ? 1 : 0.55) * (0.85 + this.wAssault * 0.55) * sc,
      );
      _v3.applyQuaternion(this.root.quaternion).add(_v2);

      leg.target.lerpVectors(leg.world, _v3, tuck);

      // foot orientation: flat on the ground, pointed back in flight,
      // rolling through toe-off during the last third of stance
      const toeOff = leg.swingT < 0 && moving ? smoothstep(0.55, 1.0, (this._cycle + leg.phase) % 1) : 0;
      const swingPitch = leg.swingT >= 0 ? Math.sin(Math.PI * leg.swingT) * -0.24 : 0;
      const flightPitch = (leg.bendZ < 0 ? 0.95 : 0.70) + this.wAssault * 0.25;
      const groundPitch = toeOff * 0.42 + swingPitch - land * 0.05;
      leg.footPitch = damp(leg.footPitch, lerp(groundPitch, flightPitch, tuck), 16, dt);

      this._solveLeg(leg, leg.target, leg.footPitch, -this._pelvisYaw * 0.35);
    }
  }

  /** Two-bone analytic IK. Bend plane is chosen so reverse joints fold backwards. */
  _solveLeg(leg, targetWorld, footPitch, footYaw) {
    _v1.copy(targetWorld).applyMatrix4(_mPelvisInv);
    _dir.subVectors(_v1, leg.hipLocal);
    let dist = _dir.length();
    const L1 = leg.L1, L2 = leg.L2;
    const maxD = (L1 + L2) * 0.995;
    const minD = Math.abs(L1 - L2) + 0.12;
    if (dist < 1e-4) { _dir.set(0, -1, 0); dist = minD; } else { _dir.multiplyScalar(1 / dist); }
    dist = clamp(dist, minD, maxD);

    const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
    const A = Math.acos(cosA);
    const cosK = clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1);
    const K = Math.acos(cosK);

    // Build the thigh basis so local +X is exactly the knee bend axis; the knee
    // then juts toward `bendZ` and the shin can be a single rotation.x.
    _fwdRef.set(0, 0, leg.bendZ);
    _right.crossVectors(_dir, _fwdRef);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); else _right.normalize();
    _up.copy(_dir).multiplyScalar(-1);
    _fwdB.crossVectors(_right, _up);
    _mBasis.makeBasis(_right, _up, _fwdB);
    _qA.setFromRotationMatrix(_mBasis);
    _qB.setFromAxisAngle(X_AXIS, A);
    leg.upper.quaternion.copy(_qA).multiply(_qB);
    leg.lower.quaternion.setFromAxisAngle(X_AXIS, -(Math.PI - K));

    // cancel the accumulated chain so the foot lands in the orientation we asked for
    _qAcc.copy(leg.upper.quaternion).multiply(leg.lower.quaternion).invert();
    _eF.set(footPitch, footYaw, 0);
    _qF.setFromEuler(_eF);
    leg.foot.quaternion.copy(_qAcc).multiply(_qF);
  }

  _updateArms(dt, cyc, walkW, aimPitch) {
    const b = this.bones;
    const arms = [
      [b.lArm, b.lForeArm, this.sRecoil.lArm, -1, 0],
      [b.rArm, b.rForeArm, this.sRecoil.rArm, 1, 1],
    ];
    for (let i = 0; i < arms.length; i++) {
      const [arm, fore, recoil, side, idx] = arms[i];
      if (!arm) continue;
      const p = this.armPose[idx];

      // counter-swing against the legs while walking
      const sway = Math.sin(cyc + (side > 0 ? Math.PI : 0)) * 0.16 * walkW;
      // boost tuck: arms fold back; assault boost pins them in tight
      const tuckPitch = 0.30 * this.wBoost + 0.75 * this.wAssault;
      const tuckRoll = -0.10 * this.wBoost - 0.30 * this.wAssault;
      const slack = this.wStagger;

      const pitchWant = sway - tuckPitch + aimPitch * 0.22 + slack * 0.55
        - recoil.x * 0.055;
      const rollWant = side * (0.09 + tuckRoll + slack * 0.20);
      const foreWant = -0.16 - 0.55 * this.wAssault - 0.22 * this.wBoost
        - slack * 0.35 + recoil.x * 0.030;

      p.pitch = damp(p.pitch, pitchWant, 12, dt);
      p.roll = damp(p.roll, rollWant, 10, dt);
      p.fore = damp(p.fore, foreWant, 12, dt);

      arm.rotation.set(p.pitch, side * this.wAssault * -0.18, p.roll);
      if (fore) fore.rotation.x = p.fore;
    }

    // shoulder hardpoints recoil independently of the arms
    if (b.lShoulderMount) b.lShoulderMount.rotation.x = -this.sRecoil.lShoulder.x * 0.030;
    if (b.rShoulderMount) b.rShoulderMount.rotation.x = -this.sRecoil.rShoulder.x * 0.030;
  }

  _sampleGround(x, z) {
    if (this.groundAt) {
      const y = this.groundAt(x, z);
      if (typeof y === 'number' && isFinite(y)) return y;
    }
    return this.root.position.y;
  }

  /** Snap every spring and gait state back to rest (respawn, teleport). */
  reset() {
    this.sLand.reset();
    this.sPitch.reset();
    this.sYawKick.reset();
    this.sQuick.reset();
    for (const k of this._recoilKeys) this.sRecoil[k].reset();
    this._pelvisYaw = this._torsoYaw = this._headYawA = 0;
    this._torsoPitch = this._headPitch = this._torsoRoll = this._leanZ = 0;
    this.wBoost = this.wAssault = this.wAir = this.wStagger = 0;
    this._cycle = 0;
    this.root.updateWorldMatrix(true, false);
    for (const leg of this.legs) {
      leg.swingT = -1;
      leg.world.copy(leg.restLocal).applyMatrix4(this.root.matrixWorld);
      leg.target.copy(leg.world);
    }
  }
}

function _isSwinging(l) { return l.swingT >= 0; }

const _EMPTY_STATE = {
  velocity: _ZERO, grounded: true, boosting: false, quickBoost: false,
  assaultBoost: false, aimYaw: 0, aimPitch: 0, speed: 0, staggered: false, firing: null,
};

export default MechRig;
