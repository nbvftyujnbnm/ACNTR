import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import * as M from '../core/MathUtils.js';

/**
 * PlayerController — Armored Core VI movement model.
 *
 * Design intent: a *heavy machine with instant response*. Every state change is a
 * step function (snap), every sustained motion has real mass (friction, ramp-up,
 * momentum you have to fight). Nothing in here uses a raw `lerp(a, b, 0.1)`.
 *
 * Control resolution: Space is the thruster, and the MOVEMENT STICK decides
 * which way the thrust points. Space + a direction is horizontal thrust; Space
 * + neutral is vertical thrust. One rule, no hold timers, no double taps, so
 * every transition is a same-frame response to what is currently held.
 *
 * State machine:
 *
 *   GROUNDED ──┬─ WALK          no Space, 14 m/s, hard friction
 *              ├─ GROUND_BOOST  Space + direction, 34 m/s hover skim at 0.75 m
 *              ├─ LIFTOFF       Space + neutral → jump impulse, leaves the ground
 *              └─ ASSAULT_BOOST Ctrl/C + forward, ramps to 95 m/s
 *   AIRBORNE ──┬─ ASCEND        Space + neutral, thruster climb to 18 m/s
 *              ├─ GLIDE         Space + direction, holds ~-3.4 m/s at boost speed
 *              ├─ FALL          no Space: gravity + drag, terminal -78 m/s
 *              └─ ASSAULT_BOOST air variant
 *
 *   Overlays (orthogonal, can combine with any base state):
 *     QUICK_BOOST      0.18 s velocity-locked burst window, then hard decay
 *     LAND_RECOVERY    control authority reduced, scaled by impact speed
 *     STAGGER          input crushed to 15 %, mech drifts
 *     EN_RECOVERY      forced: zero thrust of any kind until the gauge refills
 *
 * Cross-module contract:
 *   reads  player.root.position, player.velocity, player.stats, player.collider,
 *          player.loadout?.derived, player.aimYaw/aimPitch (written by CameraRig)
 *   writes player.root.position, player.root.quaternion, player.velocity,
 *          player.collider.center, player.stats.en, player.moveState (= this.state),
 *          player.iframes
 *   feeds  player.rig.update(dt, rigState)
 */

// ---------------------------------------------------------------------------
// module-scope scratch — nothing in update() may allocate
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _vh = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _axis = { x: 0, z: 0 };
const _probeOrigin = new THREE.Vector3();
const _rayOut = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null };
const _moveOut = {
  position: new THREE.Vector3(),
  grounded: false,
  normal: new THREE.Vector3(0, 1, 0),
  hitWall: false,
};
// Physics.moveCapsule works in capsule-CENTRE space (it matches
// Entity.collider.center), while the mech root is authored at the feet.
// This scratch carries the converted position across that boundary.
const _capsuleC = new THREE.Vector3();

/**
 * Nominal part stats used to normalise `loadout.derived` into multipliers.
 *
 * THESE MUST BE IN THE UNITS LOADOUT ACTUALLY EMITS, and they were not. Loadout
 * computes `boostSpeed = K_BOOST * thrust / sqrt(weight)` and labels it m/s;
 * the starter AC derives 45.2 m/s, 42.6 m/s of dash impulse and 617 EN/s. They
 * were being divided by 340, 400 and 1650, so every ratio came out at 0.11-0.37
 * and `statMul` clamped ALL THREE to their floors — 0.65 boost, 0.60 quick
 * boost, 0.50 EN recharge. The consequences were not subtle:
 *
 *   - assault boost topped out at 95 * 0.65 = 61.8 m/s, measured, against a
 *     tuned 95; ground boost, jump impulse and ascent were cut the same way
 *   - quick boost fired at 60% strength permanently
 *   - EN recharged at half rate
 *   - and because every build saturated the clamp, NO booster or generator in
 *     the parts DB could change any of it. The whole progression axis was dead
 *     weight, which is the part a looter shooter cannot afford.
 *
 * They are now the starter AC's own derived values, so a starter build sits at
 * exactly 1.0 and parts move it either way. If PartsDB is rebalanced these have
 * to move with it — `_refreshDerived` warns when a multiplier saturates, which
 * is the signature of this bug and would have caught it in seconds.
 *
 * `enMax` is deliberately NOT changed. It feeds `enScale`, which is a ratio
 * against the reference pool rather than a clamped multiplier, and at 2325/4000
 * it is operating exactly as intended. Retuning it is a balance decision, not a
 * units fix.
 */
const NOMINAL = { boostSpeed: 45, qbThrust: 43, enRecharge: 615, enMax: 4000 };

/**
 * Turn a part stat into a safe multiplier. The parts DB is authored by another
 * agent, so we accept either "already a multiplier" (0.2..3) or "absolute value"
 * (normalised against NOMINAL) and clamp hard either way.
 */
function statMul(value, nominal, lo, hi) {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 1;
  const m = value <= 3 ? value : value / nominal;
  return M.clamp(m, lo, hi);
}

const _warned = new Set();
/**
 * Shout when a loadout multiplier lands exactly on a clamp bound.
 *
 * A single build sitting on a bound is a legitimate extreme. But a bound is
 * also what a units mismatch looks like, and that mismatch is invisible from
 * inside the game — it does not throw, it just quietly makes the AC slower than
 * it was tuned to be, and it makes every part in that slot interchangeable
 * because they all saturate. All three of these were pinned for the life of the
 * project before anyone measured. One line per multiplier, once.
 */
function warnIfSaturated(rows) {
  for (const [name, mul, value, nominal, lo, hi] of rows) {
    if (mul !== lo && mul !== hi) continue;
    if (_warned.has(name)) continue;
    _warned.add(name);
    console.warn(
      `[controller] loadout multiplier '${name}' is saturated at ${mul} ` +
      `(derived ${Number(value).toFixed(2)} / nominal ${nominal} = ` +
      `${(Number(value) / nominal).toFixed(3)}). If every build saturates here, ` +
      `NOMINAL.${name} is in the wrong units and this stat is doing nothing.`,
    );
  }
}

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * Tuned constants. Units: metres, seconds, m/s, m/s². Gravity 24 m/s² per the contract.
 * These are live-editable via `controller.tune` for feel passes.
 */
export const DEFAULT_TUNE = {
  gravity: 24,

  // --- walk ---------------------------------------------------------------
  walkSpeed: 14,
  walkAccel: 96,
  walkFriction: 68,
  turnRateBody: 11.5, // rad/s-ish damp rate for the legs chasing the aim yaw

  // --- ground boost -------------------------------------------------------
  boostSpeed: 34,
  boostAccel: 124,
  boostFriction: 26, // low: boosting slides, it does not stop dead
  boostDrain: 175, // EN/s
  hoverHeight: 0.75, // ground boost is a hover, not a run
  hoverSpring: 7.0,
  hoverDamp: 15,

  // --- air ----------------------------------------------------------------
  airAccel: 46,
  airFriction: 2.4,
  fallDrag: 0.055, // quadratic-ish drag coefficient on descent
  fallTerminal: -78,

  // --- jump / ascend ------------------------------------------------------
  jumpImpulse: 13.0,
  coyote: 0.09,
  ascendAccel: 50,
  ascendMax: 18,
  ascendDrain: 430,
  hoverDrain: 135, // holding Space with no climb left: glide
  glideFall: -3.4,

  // --- quick boost --------------------------------------------------------
  qbSpeed: 55,
  qbWindow: 0.18, // velocity is LOCKED for this long — the snap
  qbCooldown: 0.35,
  qbCost: 360,
  qbReserveRefill: 1.0, // s to regain one full-strength QB
  qbMinScale: 0.48, // strength of a QB fired on an empty reserve
  qbDecay: 54, // m/s² bleed from burst speed back to base
  qbCarry: 0.45, // how much of the existing along-axis speed chains into a QB
  qbMaxSpeed: 78,
  qbAirLift: 2.4, // air QB cancels fall — the AC6 float
  qbIFrames: 0.12,

  // --- assault boost ------------------------------------------------------
  assaultMax: 95,
  assaultRampTime: 1.2,
  assaultAccel: 94,
  assaultDrain: 620,
  assaultTurnRate: 1.9, // rad/s the *velocity* may swing — reduced turn authority
  assaultLateral: 0.22,

  // --- energy -------------------------------------------------------------
  enRecharge: 1650, // EN/s
  enRechargeDelay: 0.55,
  enEmptyRecharge: 720, // punished rate while in forced recovery
  enBrownout: 0, // keep at 0 — a floor here would make EN-empty unreachable

  // --- landing ------------------------------------------------------------
  landSoft: 6, // below this, no recovery at all
  landHard: 45, // impact speed that produces the max recovery
  landRecoveryMax: 0.5,
  landHardSpeedLoss: 0.7, // horizontal speed kept on a slam landing

  // --- misc ---------------------------------------------------------------
  staggerInput: 0.15,
  staggerFriction: 0.35,
  maxSpeed: 145,
  arenaMargin: 10,
  arenaPush: 110,
};

export class PlayerController {
  /**
   * @param {object} player  Entity (see CONTRACT.md) — the player mech
   * @param {import('../core/Input.js').Input} input
   * @param {object} physics  Physics (capsule sweep provider)
   * @param {object} level    Level (arena bounds / spawn points)
   */
  constructor(player, input, physics, level) {
    this.player = player;
    this.input = input;
    this.physics = physics;
    this.level = level;

    this.tune = Object.assign({}, DEFAULT_TUNE);

    // aim — kept in lockstep with CameraRig (see _syncAim)
    this.yaw = 0;
    this.pitch = 0;
    this.bodyYaw = 0;

    // velocity lives on the entity so damage/AI can read it
    if (player && !player.velocity) player.velocity = new THREE.Vector3();
    this.vel = player?.velocity || new THREE.Vector3();

    // --- timers -----------------------------------------------------------
    this.qbTimer = 0; // burst window remaining
    this.qbCooldown = 0;
    this.qbReserve = 1; // 0..1 thruster reserve; a QB spends it all
    this.qbDir = new THREE.Vector3(0, 0, -1);
    this.assaultTime = 0;
    this.landRecovery = 0;
    this.landRecoveryMax = 0.001;
    this.airTime = 0;
    this.groundTime = 0;
    this.coyote = 0;
    this._enDelay = 0;
    this._prevVy = 0;
    this._wasGrounded = true;
    this._assaultActive = false;
    this._groundY = null;
    this._respawnGuard = 0;

    this.enRecovering = false;

    /** Public movement state — CameraRig, HUD and the rig all read this. */
    this.state = {
      grounded: true,
      airborne: false,
      boosting: false,
      assaultBoost: false,
      quickBoost: false,
      hovering: false,
      ascending: false,
      enRecovering: false,
      staggered: false,
      qbTimer: 0,
      qbCooldown: 0,
      qbReserve: 1,
      assaultRamp: 0,
      landing: 0,
      speed: 0,
      verticalSpeed: 0,
      enRatio: 1,
      moveX: 0,
      moveZ: 0,
      heightAboveGround: 0,
    };
    // Published on the entity so sibling systems can read it without an import
    // (CameraRig reads moveState, TargetingSystem picks up physics for LOS).
    if (player) {
      player.moveState = this.state;
      if (typeof player.iframes !== 'number') player.iframes = 0;
      if (!player.physics && physics) player.physics = physics;
    }

    /** Rig drive state — mutated in place, never reallocated. */
    this.rigState = {
      velocity: this.vel,
      grounded: true,
      airborne: false,
      boosting: false,
      quickBoost: false,
      quickBoostT: 0,
      qbDir: this.qbDir,
      assaultBoost: false,
      assaultRamp: 0,
      ascending: false,
      hovering: false,
      landing: 0,
      staggered: false,
      aimYaw: 0,
      aimPitch: 0,
      bodyYaw: 0,
      speed: 0,
      moveX: 0,
      moveZ: 0,
      enRatio: 1,
    };

    // loadout-derived multipliers, refreshed every frame (cheap, always correct)
    this._loadout = player?.loadout || null;
    this._mul = { boost: 1, qb: 1, enRech: 1, speed: 1, accel: 1, drain: 1 };

    // EN fallback if the stats block is not populated yet by the mech agent
    this._enStore = { en: NOMINAL.enMax, enMax: NOMINAL.enMax };

    this._offBuild = bus.on(EV.BUILD_CHANGED, (e) => {
      if (e?.loadout) this._loadout = e.loadout;
      else if (e?.derived) this._loadout = e;
    });
  }

  /** Optional: hand the controller an explicit Loadout (Garage may call this). */
  setLoadout(loadout) {
    this._loadout = loadout || null;
  }

  // =========================================================================
  // main tick
  // =========================================================================

  /**
   * @param {number} dt seconds (already time-scaled by Engine)
   * @param {number} elapsed
   */
  update(dt, elapsed) {
    const p = this.player;
    if (!p || !p.root) return;
    if (!(dt > 0)) {
      this._pushRig(0);
      return;
    }
    dt = Math.min(dt, 0.05); // integration stability under a stall

    const T = this.tune;
    const pos = p.root.position;
    const vel = this.vel;

    this._refreshDerived();
    this._syncAim();

    const en = this._en();
    const enScale = M.clamp(num(en.enMax, NOMINAL.enMax) / NOMINAL.enMax, 0.35, 3);
    const staggered = !!p.stats?.staggered;

    // ---- input -----------------------------------------------------------
    const inp = this.input;
    const ax = inp?.moveAxis ? inp.moveAxis(_axis) : (_axis.x = 0, _axis.z = 0, _axis);
    let inX = ax.x;
    let inZ = ax.z;
    if (staggered) {
      inX *= T.staggerInput;
      inZ *= T.staggerInput;
    }
    const inputMag = Math.hypot(inX, inZ);

    const spaceDown = !!inp?.down?.('Space');
    const spaceHit = !!inp?.hit?.('Space');
    const qbHit = !!(inp?.hit?.('ShiftLeft') || inp?.hit?.('ShiftRight'));
    const abDown = !!(inp?.down?.('ControlLeft') || inp?.down?.('ControlRight') || inp?.down?.('KeyC'));

    // ---- basis -----------------------------------------------------------
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    _fwd.set(-sy, 0, -cy);
    _right.set(cy, 0, -sy);
    _wish.set(0, 0, 0).addScaledVector(_right, inX).addScaledVector(_fwd, inZ);
    if (_wish.lengthSq() > 1e-6) _wish.normalize();

    // ---- timers ----------------------------------------------------------
    this.qbCooldown = Math.max(0, this.qbCooldown - dt);
    this.qbTimer = Math.max(0, this.qbTimer - dt);
    this.qbReserve = Math.min(1, this.qbReserve + dt / T.qbReserveRefill);
    this.landRecovery = Math.max(0, this.landRecovery - dt);
    if (typeof p.iframes === 'number') p.iframes = Math.max(0, p.iframes - dt);

    // ---- ground probe ----------------------------------------------------
    const groundY = this._probeGround(pos);
    const heightAG = groundY === null ? 999 : pos.y - groundY;

    let grounded = this._wasGrounded;
    let drained = false;

    // ---- energy pre-pass -------------------------------------------------
    // No brownout floor: sustained thrust is allowed to drain the gauge to
    // literal zero, because the forced EN recovery that follows *is* the risk
    // half of AC6's risk/reward loop. Gating it away would delete the mechanic.
    const enRatio = num(en.enMax, 1) > 0 ? M.clamp(en.en / en.enMax, 0, 1) : 0;
    const brownout = enRatio <= T.enBrownout;
    const thrustOK = !this.enRecovering && !staggered && en.en > 0 && !brownout;

    // =====================================================================
    // QUICK BOOST — the core mechanic. Fires on the input edge, no ramp.
    // =====================================================================
    if (qbHit && this.qbCooldown <= 0 && thrustOK) {
      const cost = Math.min(T.qbCost * enScale, en.enMax * 0.14);
      if (en.en >= cost * 0.55) {
        this._doQuickBoost(_wish, inputMag, cost, dt);
        drained = true;
      }
    }

    // =====================================================================
    // ASSAULT BOOST — sustained charge, ramps, eats EN, steals turn authority
    // =====================================================================
    const wantAssault = abDown && inZ > 0.3 && thrustOK && this.qbTimer <= 0;
    if (wantAssault) {
      this.assaultTime = Math.min(T.assaultRampTime * 1.6, this.assaultTime + dt);
      const drain = T.assaultDrain * enScale * this._mul.drain;
      this._spendEN(drain * dt);
      drained = true;
    } else {
      // assault bleeds off fast — releasing it should feel like cutting the engine
      this.assaultTime = Math.max(0, this.assaultTime - dt * 4);
    }
    const assault = wantAssault && this.assaultTime > 0;
    const assaultRamp = M.clamp(this.assaultTime / T.assaultRampTime, 0, 1);
    if (assault !== this._assaultActive) {
      this._assaultActive = assault;
      bus.emit(EV.ASSAULT_BOOST, { active: assault, entity: p });
    }

    // =====================================================================
    // THRUSTERS (Space)
    //
    // One key has to serve jump, sustained ascent and the ground skim, so the
    // discriminator is the movement stick — the same one AC6 uses:
    //
    //   Space + a direction  →  HORIZONTAL thrust  (ground boost / air glide)
    //   Space + neutral      →  VERTICAL thrust    (jump impulse, then climb)
    //
    // No hold timers, no double taps, no latency: the state is a pure function
    // of what is held this frame, so every transition is instantaneous.
    // =====================================================================
    let ascending = false;
    let hovering = false;
    const wantVertical = inputMag <= 0.18;

    if (grounded) this.coyote = T.coyote;
    else this.coyote = Math.max(0, this.coyote - dt);

    // --- liftoff: neutral stick + Space while on the ground ---------------
    if (spaceDown && wantVertical && thrustOK && grounded && this.coyote > 0) {
      // the press edge is a hard impulse; simply holding lets the climb take over
      if (spaceHit) vel.y = Math.max(vel.y, T.jumpImpulse * this._mul.boost);
      else if (vel.y < 0) vel.y = 0;
      grounded = false;
      this.coyote = 0;
      this._spendEN(T.ascendDrain * enScale * 0.18);
      drained = true;
    }

    // --- ground boost: directional Space near the ground = hover skim ------
    const canHover = groundY !== null ? heightAG < T.hoverHeight + 1.7 : grounded;
    let groundBoost = false;
    if (spaceDown && !wantVertical && !assault && thrustOK && canHover) {
      groundBoost = true;
      hovering = true;
      grounded = true; // the hover counts as grounded for the movement solver
      if (groundY !== null) {
        // spring to hover height instead of scraping over the terrain
        const err = groundY + T.hoverHeight - pos.y;
        vel.y = M.damp(vel.y, err * T.hoverSpring, T.hoverDamp, dt);
      } else if (vel.y < 0) {
        vel.y = M.damp(vel.y, 0, 12, dt);
      }
      this._spendEN(T.boostDrain * enScale * this._mul.drain * dt);
      drained = true;
    }

    // --- airborne thruster: climb on neutral, glide on a direction --------
    if (spaceDown && !grounded && !groundBoost && thrustOK) {
      if (wantVertical) {
        // thruster climb — net +26 m/s² against gravity, terminal 18 m/s
        vel.y = Math.min(T.ascendMax * this._mul.boost, vel.y + T.ascendAccel * dt);
        ascending = true;
        this._spendEN(T.ascendDrain * enScale * this._mul.drain * dt);
      } else {
        // air glide: hold altitude-ish while flying. Cheap, but it is the reason
        // altitude management is a skill — you cannot climb and strafe at once.
        vel.y = M.damp(vel.y, T.glideFall, 4.2, dt);
        hovering = true;
        this._spendEN(T.hoverDrain * enScale * this._mul.drain * dt);
      }
      drained = true;
    }

    // gravity + descent drag
    if (!grounded && !ascending && !hovering) {
      vel.y -= T.gravity * dt;
      if (vel.y < 0) vel.y += -vel.y * vel.y * T.fallDrag * dt * 0.02;
      if (vel.y < T.fallTerminal) vel.y = T.fallTerminal;
    } else if (grounded && !groundBoost && !ascending) {
      // stick to slopes so we do not skip off downhill ramps
      if (vel.y > 0 && !spaceDown) vel.y = 0;
      if (vel.y <= 0) vel.y = -3.5;
    }

    // =====================================================================
    // HORIZONTAL — accel / friction, per state
    // =====================================================================
    _vh.set(vel.x, 0, vel.z);
    const speedNow = _vh.length();

    // land-recovery authority (0..1)
    const rec = this.landRecovery > 0 ? 1 - this.landRecovery / this.landRecoveryMax : 1;
    const authority = M.lerp(0.34, 1, M.smoothstep(0, 1, rec)) * (staggered ? 0.4 : 1);

    if (this.qbTimer > 0) {
      // BURST WINDOW: velocity is locked. This is what makes a QB a snap and
      // not an acceleration curve. No accel, no friction, no steering.
    } else if (assault) {
      const abSpeed = M.lerp(T.boostSpeed * this._mul.boost, T.assaultMax * this._mul.boost, assaultRamp);
      // limited-authority turn: swing the velocity vector toward facing
      this._steerVelocity(_vh, _fwd, T.assaultTurnRate * dt);
      // lateral trickle so you can still correct, but barely
      _vh.addScaledVector(_right, inX * T.assaultAccel * T.assaultLateral * dt);
      const along = _vh.dot(_fwd);
      if (along < abSpeed) {
        _vh.addScaledVector(_fwd, Math.min(T.assaultAccel * dt * this._mul.accel, abSpeed - along));
      }
      // bleed (do not hard-clip) back to the charge speed, so entering AB out of
      // a burst decays smoothly instead of snapping
      const abNow = _vh.length();
      if (abNow > abSpeed) _vh.multiplyScalar(Math.max(abSpeed, abNow - T.qbDecay * dt) / abNow);
    } else {
      const boosting = groundBoost || (!grounded && (ascending || hovering || speedNow > T.walkSpeed * 1.05));
      let maxSpeed;
      let accel;
      let friction;

      if (grounded) {
        if (groundBoost) {
          maxSpeed = T.boostSpeed * this._mul.boost * this._mul.speed;
          accel = T.boostAccel * this._mul.accel;
          friction = T.boostFriction;
        } else {
          maxSpeed = T.walkSpeed * this._mul.speed;
          accel = T.walkAccel * this._mul.accel;
          friction = T.walkFriction;
        }
      } else {
        maxSpeed = (boosting ? T.boostSpeed * this._mul.boost : T.walkSpeed * 1.25) * this._mul.speed;
        accel = T.airAccel * this._mul.accel;
        friction = T.airFriction;
      }
      maxSpeed *= M.lerp(0.55, 1, rec);
      accel *= authority;
      if (staggered) friction *= T.staggerFriction;
      // partial stick (or a staggered mech, whose input is crushed to 15 %)
      // must actually move less — `_wish` is normalised, so scale the drive
      // target here. `maxSpeed` itself stays intact so a staggered mech keeps
      // drifting on its momentum instead of being clamped to a crawl.
      const drive = Math.min(1, inputMag);
      const driveMax = maxSpeed * drive;
      accel *= drive;

      const along = _vh.dot(_wish);

      if (inputMag > 0.01) {
        // Quake-style: only accelerate up to driveMax *along the wish axis*, so
        // burst speed from a QB is preserved instead of being clipped away.
        const add = Math.min(accel * dt, Math.max(0, driveMax - along));
        _vh.addScaledVector(_wish, add);
        // scrub the perpendicular component so turns are crisp, not skate-y
        const scrub = grounded ? 5.2 : 1.5;
        _tmp.copy(_wish).multiplyScalar(_vh.dot(_wish));
        _tmp.subVectors(_vh, _tmp); // perpendicular part
        _vh.addScaledVector(_tmp, -Math.min(1, scrub * dt));
        // A crushed stick (stagger) must still bleed momentum, or a staggered
        // mech would coast forever. Full stick is exempt so QB burst is kept.
        if (drive < 0.95 && along > driveMax + 0.5) {
          const s = _vh.length();
          if (s > driveMax) _vh.multiplyScalar(Math.max(driveMax, s - friction * 0.6 * dt) / s);
        }
      } else {
        // no input: real deceleration. Heavy machine, but it does stop.
        const s = _vh.length();
        if (s > 0.001) {
          const drop = friction * dt;
          _vh.multiplyScalar(Math.max(0, s - drop) / s);
        }
      }

      // burst decay: bleed anything above the state's max speed back down fast
      const s2 = _vh.length();
      if (s2 > maxSpeed) {
        const drop = T.qbDecay * dt * (grounded ? 1.15 : 1);
        _vh.multiplyScalar(Math.max(maxSpeed, s2 - drop) / s2);
      }
    }

    // arena containment (soft push, then hard clamp after the move)
    this._containArena(pos, _vh, dt);

    vel.x = _vh.x;
    vel.z = _vh.z;

    // hard sanity clamp — at 95 m/s a frame is 1.6 m, we rely on substepping
    const hs = Math.hypot(vel.x, vel.z);
    if (hs > T.maxSpeed) {
      const k = T.maxSpeed / hs;
      vel.x *= k;
      vel.z *= k;
    }
    if (!isFinite(vel.x) || !isFinite(vel.y) || !isFinite(vel.z)) vel.set(0, 0, 0);
    vel.y = M.clamp(vel.y, -120, 60);

    // =====================================================================
    // INTEGRATE
    // =====================================================================
    this._prevVy = vel.y;
    const res = this._move(pos, vel, dt);
    const physGrounded = !!res.grounded;
    const finalGrounded = physGrounded || groundBoost;

    // =====================================================================
    // LANDING
    // =====================================================================
    if (finalGrounded && !this._wasGrounded) {
      const impact = Math.max(0, -this._prevVy);
      if (this.airTime > 0.12 && impact > 2) {
        bus.emit(EV.LANDED, { impactSpeed: impact, position: pos, entity: p, hard: impact > T.landHard * 0.5 });
        if (impact > T.landSoft) {
          const t = M.clamp((impact - T.landSoft) / (T.landHard - T.landSoft), 0, 1);
          this.landRecoveryMax = M.lerp(0.07, T.landRecoveryMax, t * t);
          this.landRecovery = this.landRecoveryMax;
          if (impact > T.landHard * 0.5 && !groundBoost) {
            // slam landings scrub momentum — you pay for reckless altitude
            const keep = M.lerp(1, T.landHardSpeedLoss, t);
            vel.x *= keep;
            vel.z *= keep;
          }
        }
      }
      this.airTime = 0;
    }
    if (finalGrounded) {
      this.groundTime += dt;
      this.airTime = 0;
    } else {
      this.airTime += dt;
      this.groundTime = 0;
    }
    this._wasGrounded = finalGrounded;

    // =====================================================================
    // ENERGY — recharge with a delay; EN-empty is a real punishment
    // =====================================================================
    this._tickEnergy(dt, drained, enScale);

    // =====================================================================
    // OUTPUT — body yaw, collider, public state, rig
    // =====================================================================
    this._updateBody(dt, assault, assaultRamp);
    this._writeState(finalGrounded, groundBoost, assault, assaultRamp, ascending, hovering, inX, inZ, heightAG);
    this._pushRig(dt);

    this._safetyNet(pos, vel);
  }

  // =========================================================================
  // pieces
  // =========================================================================

  /**
   * Keep the movement basis in exact lockstep with CameraRig.
   * CameraRig runs in lateUpdate (after us) and writes player.aimYaw/aimPitch,
   * so we take last frame's authoritative value and re-apply *this* frame's raw
   * mouse delta. Result: zero-frame input latency on movement direction while
   * the camera keeps full authority (including lock-on assist).
   */
  _syncAim() {
    const p = this.player;
    const inp = this.input;
    if (typeof p?.aimYaw === 'number') this.yaw = p.aimYaw;
    if (typeof p?.aimPitch === 'number') this.pitch = p.aimPitch;
    if (!inp) return;
    const sens = num(inp.sensitivity, 0.0021);
    const dx = num(inp.mouse?.dx, 0);
    const dy = num(inp.mouse?.dy, 0);
    this.yaw -= dx * sens;
    this.pitch -= dy * sens * (inp.invertY ? -1 : 1);
    this.pitch = M.clamp(this.pitch, -1.2566, 1.2566);
  }

  /** Fire a quick boost: instantaneous, direction-snapping, EN-gated. */
  _doQuickBoost(wish, inputMag, cost, dt) {
    const T = this.tune;
    const p = this.player;

    // direction: current input, or straight backward (the AC6 default dodge)
    if (inputMag > 0.05) _dir.copy(wish);
    else _dir.copy(_fwd).multiplyScalar(-1);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.copy(_fwd).multiplyScalar(-1);
    _dir.normalize();

    // reserve scaling — a second QB inside the recovery window is weaker.
    // This, not a long cooldown, is what kills QB spam. The momentum carry is
    // scaled by the same reserve, otherwise chaining hides the penalty entirely.
    const scale = M.lerp(T.qbMinScale, 1, this.qbReserve) * this._mul.qb;
    const thrust = T.qbSpeed * scale;

    _vh.set(this.vel.x, 0, this.vel.z);
    const along = _vh.dot(_dir);
    // Perpendicular momentum is DISCARDED — that hard direction change is the
    // entire feel of a quick boost. Along-axis speed partially chains.
    const target = Math.min(T.qbMaxSpeed, Math.max(thrust, Math.max(0, along) * T.qbCarry * scale + thrust));
    this.vel.x = _dir.x * target;
    this.vel.z = _dir.z * target;

    // air QB kills the fall and floats slightly — lets you chain QBs mid-air
    if (!this._wasGrounded) {
      if (this.vel.y < 0) this.vel.y = Math.min(0, this.vel.y * 0.15) + T.qbAirLift;
      else this.vel.y += T.qbAirLift * 0.4;
    }

    this.qbDir.copy(_dir);
    this.qbTimer = T.qbWindow;
    this.qbCooldown = T.qbCooldown;
    this.qbReserve = 0;
    this.assaultTime = 0; // QB cancels assault boost — the AC6 AB-cancel
    this.landRecovery = 0; // and cancels landing recovery, so you can escape
    p.iframes = Math.max(num(p.iframes, 0), T.qbIFrames);
    this._spendEN(cost);

    bus.emit(EV.QUICK_BOOST, {
      direction: _dir.clone(),
      position: this.player.root.position.clone(),
      strength: scale,
      grounded: this._wasGrounded,
      entity: p,
    });
  }

  /** Rotate `v` (horizontal) toward `target` by at most `maxRad`. */
  _steerVelocity(v, target, maxRad) {
    const sp = v.length();
    if (sp < 0.5 || maxRad <= 0) return;
    _tmp.copy(v).divideScalar(sp);
    const d = M.clamp(_tmp.dot(target), -1, 1);
    const ang = Math.acos(d);
    if (ang < 1e-4) return;
    const t = Math.min(1, maxRad / ang);
    _tmp.lerp(target, t);
    if (_tmp.lengthSq() < 1e-6) return;
    _tmp.normalize();
    v.copy(_tmp).multiplyScalar(sp);
  }

  /** Collide-and-slide through Physics; falls back to a ground-height solver. */
  _move(pos, vel, dt) {
    const p = this.player;
    const radius = num(p.collider?.radius, 2.1);
    const height = num(p.collider?.height, 8.0);
    const ph = this.physics;

    _moveOut.grounded = false;
    _moveOut.hitWall = false;
    _moveOut.normal.set(0, 1, 0);
    _moveOut.position.copy(pos);

    let res = null;
    if (ph?.moveCapsule) {
      // feet -> centre for the solver, then back again.
      const halfH = height * 0.5;
      _capsuleC.set(pos.x, pos.y + halfH, pos.z);
      res = ph.moveCapsule(_capsuleC, vel, radius, height, dt, _moveOut) || _moveOut;
      if (res.position) pos.set(res.position.x, res.position.y - halfH, res.position.z);
      else pos.set(_capsuleC.x, _capsuleC.y - halfH, _capsuleC.z);
      const n = res.normal;
      if (res.hitWall && n && typeof n.x === 'number') {
        const into = vel.x * n.x + vel.y * n.y + vel.z * n.z;
        if (into < 0) {
          vel.x -= n.x * into;
          vel.y -= n.y * into;
          vel.z -= n.z * into;
        }
      }
      if (res.grounded && vel.y < 0) vel.y = 0;
    } else {
      pos.addScaledVector(vel, dt);
      const gy = this._probeGround(pos);
      _moveOut.grounded = false;
      if (gy !== null && pos.y <= gy + 0.02) {
        pos.y = gy;
        if (vel.y < 0) vel.y = 0;
        _moveOut.grounded = true;
      }
      res = _moveOut;
    }
    return res;
  }

  /** World-space Y of the ground under `pos`, or null. One ray per frame. */
  _probeGround(pos) {
    const ph = this.physics;
    _probeOrigin.set(pos.x, pos.y + 2.5, pos.z);
    if (ph?.raycast) {
      const r = ph.raycast(_probeOrigin, DOWN, 26, _rayOut);
      if (r && r.hit !== false) {
        const d = typeof r.distance === 'number' ? r.distance : r.point ? _probeOrigin.y - r.point.y : NaN;
        if (isFinite(d)) {
          this._groundY = _probeOrigin.y - d;
          return this._groundY;
        }
      }
    }
    if (ph?.groundHeight) {
      const gh = ph.groundHeight(pos.x, pos.z);
      if (typeof gh === 'number' && isFinite(gh)) {
        this._groundY = gh;
        return gh;
      }
    }
    return null;
  }

  /** Soft radial push-back near the arena edge, so the player never leaves it. */
  _containArena(pos, vh, dt) {
    const R = num(this.level?.arenaRadius, 0);
    if (R <= 0) return;
    const d = Math.hypot(pos.x, pos.z);
    const lim = R - this.tune.arenaMargin;
    if (d <= lim || d < 1e-3) return;
    const k = M.clamp((d - lim) / 25, 0, 1);
    vh.x -= (pos.x / d) * this.tune.arenaPush * k * dt;
    vh.z -= (pos.z / d) * this.tune.arenaPush * k * dt;
  }

  // --- energy --------------------------------------------------------------

  _en() {
    const s = this.player?.stats;
    if (s && typeof s.en === 'number' && typeof s.enMax === 'number' && s.enMax > 0) return s;
    return this._enStore;
  }

  _spendEN(amount) {
    if (!(amount > 0)) return;
    const en = this._en();
    en.en = Math.max(0, en.en - amount);
    this._enDelay = this.tune.enRechargeDelay;
    if (en.en <= 0 && !this.enRecovering) this._enterRecovery();
  }

  _enterRecovery() {
    this.enRecovering = true;
    this.assaultTime = 0;
    if (this._assaultActive) {
      this._assaultActive = false;
      bus.emit(EV.ASSAULT_BOOST, { active: false, entity: this.player });
    }
    // the mech drops: all thrust is gone
    if (this.vel.y > 0) this.vel.y *= 0.25;
    bus.emit(EV.EN_EMPTY, { entity: this.player, position: this.player?.root?.position });
  }

  _tickEnergy(dt, drained, enScale) {
    const T = this.tune;
    const en = this._en();
    if (this.enRecovering) {
      // punished: slower rate, no delay, and NOTHING works until it is full
      en.en = Math.min(en.enMax, en.en + T.enEmptyRecharge * enScale * this._mul.enRech * dt);
      if (en.en >= en.enMax - 0.5) {
        en.en = en.enMax;
        this.enRecovering = false;
        this._enDelay = 0;
      }
      return;
    }
    if (drained) {
      this._enDelay = T.enRechargeDelay;
      return;
    }
    this._enDelay -= dt;
    if (this._enDelay <= 0) {
      en.en = Math.min(en.enMax, en.en + T.enRecharge * enScale * this._mul.enRech * dt);
    }
  }

  // --- loadout -------------------------------------------------------------

  _refreshDerived() {
    const d = this._loadout?.derived || this.player?.loadout?.derived || this.player?.derived || null;
    const m = this._mul;
    if (!d) {
      m.boost = m.qb = m.enRech = m.speed = m.accel = m.drain = 1;
      return;
    }
    m.boost = statMul(d.boostSpeed, NOMINAL.boostSpeed, 0.65, 1.55);
    m.qb = statMul(d.qbThrust, NOMINAL.qbThrust, 0.6, 1.6);
    m.enRech = statMul(d.enRecharge, NOMINAL.enRecharge, 0.5, 1.8);
    warnIfSaturated([
      ['boost', m.boost, d.boostSpeed, NOMINAL.boostSpeed, 0.65, 1.55],
      ['qb', m.qb, d.qbThrust, NOMINAL.qbThrust, 0.6, 1.6],
      ['enRech', m.enRech, d.enRecharge, NOMINAL.enRecharge, 0.5, 1.8],
    ]);

    const w = num(d.weight, 0);
    const ll = num(d.loadLimit, 0);
    let ratio = 0.6;
    if (w > 0 && ll > 0) ratio = w / ll;
    const over = Math.max(0, ratio - 1);
    // overweight builds: slower, sluggish, thirstier. Under-weight gets nothing
    // for free — AC6 rewards being under the limit, it does not reward being empty.
    m.speed = 1 / (1 + over * 1.35);
    m.accel = 1 / (1 + over * 1.8);
    m.drain = 1 + over * 0.9;
  }

  // --- output --------------------------------------------------------------

  /** Legs chase the aim yaw; assault boost locks the body to the charge line. */
  _updateBody(dt, assault, assaultRamp) {
    const T = this.tune;
    const rate = assault ? T.turnRateBody * M.lerp(1, 0.35, assaultRamp) : T.turnRateBody;
    this.bodyYaw = M.dampAngle(this.bodyYaw, this.yaw, rate, dt);
    const root = this.player?.root;
    if (root) {
      root.quaternion.setFromAxisAngle(UP, this.bodyYaw);
      const c = this.player.collider;
      if (c?.center) {
        c.center.set(root.position.x, root.position.y + num(c.height, 8) * 0.5, root.position.z);
      }
    }
  }

  _writeState(grounded, groundBoost, assault, assaultRamp, ascending, hovering, inX, inZ, heightAG) {
    const s = this.state;
    const v = this.vel;
    const en = this._en();
    s.grounded = grounded;
    s.airborne = !grounded;
    s.boosting = groundBoost || assault || ascending || hovering || (!grounded && this.qbTimer > 0);
    s.assaultBoost = assault;
    s.assaultRamp = assaultRamp;
    s.quickBoost = this.qbTimer > 0;
    s.hovering = hovering;
    s.ascending = ascending;
    s.enRecovering = this.enRecovering;
    s.staggered = !!this.player?.stats?.staggered;
    s.qbTimer = this.qbTimer;
    s.qbCooldown = this.qbCooldown;
    s.qbReserve = this.qbReserve;
    s.landing = this.landRecoveryMax > 0 ? this.landRecovery / this.landRecoveryMax : 0;
    s.speed = Math.hypot(v.x, v.z);
    s.verticalSpeed = v.y;
    s.enRatio = en.enMax > 0 ? M.clamp(en.en / en.enMax, 0, 1) : 0;
    s.moveX = inX;
    s.moveZ = inZ;
    s.heightAboveGround = heightAG;
  }

  _pushRig(dt) {
    const r = this.rigState;
    const s = this.state;
    r.velocity = this.vel;
    r.grounded = s.grounded;
    r.airborne = s.airborne;
    r.boosting = s.boosting;
    r.quickBoost = s.quickBoost;
    r.quickBoostT = this.tune.qbWindow > 0 ? this.qbTimer / this.tune.qbWindow : 0;
    r.assaultBoost = s.assaultBoost;
    r.assaultRamp = s.assaultRamp;
    r.ascending = s.ascending;
    r.hovering = s.hovering;
    r.landing = s.landing;
    r.staggered = s.staggered;
    r.aimYaw = this.yaw;
    r.aimPitch = this.pitch;
    r.bodyYaw = this.bodyYaw;
    r.speed = s.speed;
    r.moveX = s.moveX;
    r.moveZ = s.moveZ;
    r.enRatio = s.enRatio;
    this.player?.rig?.update?.(dt, r);
  }

  /** Never let a physics hiccup drop the player out of the world. */
  _safetyNet(pos, vel) {
    this._respawnGuard = Math.max(0, this._respawnGuard - 0.016);
    const floor = num(this.level?.bounds?.min?.y, -400) - 80;
    if (pos.y > floor && isFinite(pos.x) && isFinite(pos.z)) return;
    if (this._respawnGuard > 0) return;
    this._respawnGuard = 1;
    const sp = this.level?.spawnPoints?.[0];
    if (sp) pos.set(sp.x, sp.y + 6, sp.z);
    else pos.set(0, 40, 0);
    vel.set(0, 0, 0);
  }

  // =========================================================================

  reset() {
    this.vel.set(0, 0, 0);
    this.qbTimer = 0;
    this.qbCooldown = 0;
    this.qbReserve = 1;
    this.assaultTime = 0;
    this.landRecovery = 0;
    this.landRecoveryMax = 0.001;
    this.airTime = 0;
    this.groundTime = 0;
    this.coyote = 0;
    this._enDelay = 0;
    this._prevVy = 0;
    this._wasGrounded = false;
    this.enRecovering = false;
    if (this._assaultActive) {
      this._assaultActive = false;
      bus.emit(EV.ASSAULT_BOOST, { active: false, entity: this.player });
    }
    const en = this._en();
    en.en = en.enMax;
    this.bodyYaw = this.yaw;
    this._writeState(false, false, false, 0, false, false, 0, 0, 0);
  }

  dispose() {
    this._offBuild?.();
    this._offBuild = null;
  }
}

export default PlayerController;
