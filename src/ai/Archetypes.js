import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import * as M from '../core/MathUtils.js';
import { Steering, coneDir } from './Brain.js';

/**
 * Archetypes.js — the *content* layer of the AI.
 *
 * Brain.js supplies capabilities (perception, steering, weapon rhythm, dodging).
 * This file supplies personality: stat blocks, weapon definitions, and a state
 * table per archetype. Each archetype answers a different question for the
 * player, so none of them is a reskin of another:
 *
 *   mt      pressure & chip damage, dies loudly              (crowd)
 *   ac      a duel — reads your fire and quick-boosts it     (skill check)
 *   tank    area denial, forces movement, rewards flanking   (positioning)
 *   flyer   verticality, forces you to look up               (tracking)
 *   sniper  forces you to break line of sight                (map awareness)
 *   boss    multi-phase set piece with readable tells        (everything)
 */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _mz = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Tier scaling — one function, applied to every archetype
// ---------------------------------------------------------------------------

/**
 * Per-tier multipliers. Tier 1 is the baseline grunt; tier 5 is late-mission.
 * Accuracy improves by *narrowing spread*, never by removing spread entirely.
 */
export function tierScale(tier) {
  const t = M.clamp(tier || 1, 1, 6);
  const k = t - 1;
  return {
    tier: t,
    ap: 1 + 0.38 * k,
    acs: 1 + 0.3 * k,
    dmg: 1 + 0.22 * k,
    spread: 1 / (1 + 0.11 * k), // tighter cone at higher tier
    speed: 1 + 0.055 * k,
    def: 1 + 0.12 * k,
    react: 1 / (1 + 0.14 * k), // faster reaction, floored per archetype
  };
}

/** Clone a weapon def with tier scaling baked in (once, at spawn — never per frame). */
function scaleWeapon(def, s) {
  const out = {};
  for (const k in def) out[k] = def[k];
  out.damage = (def.damage || 0) * s.dmg;
  out.impact = (def.impact || 0) * s.dmg;
  out.spread = (def.spread || 0) * s.spread;
  if (def.splash) out.splash = def.splash * (1 + (s.tier - 1) * 0.06);
  return out;
}

// ---------------------------------------------------------------------------
// Weapon definitions handed to ProjectileManager.spawn()
// ---------------------------------------------------------------------------

export const ENEMY_WEAPONS = {
  // --- MT ---------------------------------------------------------------
  mtRifle: {
    id: 'mt_rifle', kind: 'bullet', damageType: 'kinetic',
    speed: 205, damage: 34, impact: 58, radius: 0.16, life: 2.4,
    color: 0xffb257, tracer: true, flashScale: 0.85,
    burst: 3, burstInterval: 0.095, cooldown: 1.55, telegraph: 0.34, aimLaser: true,
    spread: 2.7 * DEG, range: 100, aimTolerance: 0.2, leadAccuracy: 0.6, tightenTime: 2.6,
  },
  mtGrenade: {
    id: 'mt_grenade', kind: 'shell', damageType: 'explosive', arc: true, arcHeight: 0.45,
    speed: 78, damage: 62, impact: 130, splash: 5.5, radius: 0.35, life: 6,
    color: 0xff8a3c, burst: 1, cooldown: 7.5, telegraph: 0.8, heavy: true, volleyWeight: 1.4,
    spread: 3.5 * DEG, range: 70, minRange: 22, aimTolerance: 0.5, leadAccuracy: 0.7,
  },

  // --- rival AC ---------------------------------------------------------
  acRifle: {
    id: 'ac_rifle', kind: 'bullet', damageType: 'kinetic',
    speed: 320, damage: 48, impact: 74, radius: 0.18, life: 2.2,
    color: 0xffe9b0, tracer: true, flashScale: 1.1,
    burst: 2, burstInterval: 0.105, cooldown: 0.82, telegraph: 0.1,
    spread: 1.55 * DEG, range: 135, aimTolerance: 0.19, leadAccuracy: 0.82, tightenTime: 1.9,
  },
  acShotgun: {
    id: 'ac_shotgun', kind: 'pellet', damageType: 'kinetic',
    speed: 190, damage: 27, impact: 118, radius: 0.13, life: 0.9, pellets: 9,
    color: 0xffd08a, flashScale: 1.6,
    burst: 1, cooldown: 1.95, telegraph: 0.24, heavy: true, volleyWeight: 1.2,
    spread: 4.6 * DEG, range: 36, aimTolerance: 0.3, leadAccuracy: 0.9, tightenTime: 1,
  },
  acMissile: {
    id: 'ac_missile', kind: 'missile', damageType: 'explosive', homing: true,
    speed: 62, accel: 40, turnRate: 2.4, damage: 40, impact: 66, splash: 4.5,
    radius: 0.28, life: 7, color: 0xff7a4a, smoke: true, flashScale: 1.2,
    burst: 6, burstInterval: 0.085, cooldown: 7.2, telegraph: 0.55,
    heavy: true, volleyWeight: 1.8, hardpoint: 'rShoulder',
    spread: 6 * DEG, range: 175, minRange: 20, aimTolerance: 0.55, leadAccuracy: 0.85,
  },

  // --- tank -------------------------------------------------------------
  tankArtillery: {
    id: 'tank_arty', kind: 'shell', damageType: 'explosive', arc: true, arcHeight: 0.62,
    indirect: true, speed: 96, damage: 168, impact: 300, splash: 9.5,
    radius: 0.5, life: 9, color: 0xffa24d, flashScale: 2.2,
    burst: 3, burstInterval: 0.5, cooldown: 5.4, telegraph: 1.7,
    heavy: true, volleyWeight: 2.2, hardpoint: 'rShoulder',
    spread: 1.6 * DEG, range: 185, minRange: 24, aimTolerance: 0.75, leadAccuracy: 0.88,
  },
  tankCQB: {
    id: 'tank_cqb', kind: 'pellet', damageType: 'kinetic',
    speed: 155, damage: 21, impact: 86, radius: 0.14, life: 0.8, pellets: 12,
    color: 0xffc98a, flashScale: 1.8,
    burst: 1, cooldown: 3.1, telegraph: 0.55, heavy: true,
    spread: 7 * DEG, range: 28, aimTolerance: 0.42, leadAccuracy: 0.75,
  },

  // --- flyer ------------------------------------------------------------
  flyerPulse: {
    id: 'flyer_pulse', kind: 'plasma', damageType: 'energy',
    speed: 165, damage: 20, impact: 30, radius: 0.22, life: 1.8,
    color: 0x66e0ff, tracer: true, flashScale: 0.7,
    burst: 4, burstInterval: 0.1, cooldown: 2.1, telegraph: 0.2,
    spread: 3.3 * DEG, range: 85, aimTolerance: 0.26, leadAccuracy: 0.58, tightenTime: 2.8,
  },

  // --- sniper -----------------------------------------------------------
  sniperRail: {
    id: 'sniper_rail', kind: 'rail', damageType: 'energy',
    speed: 620, damage: 480, impact: 430, radius: 0.22, life: 1.4,
    color: 0xff4d6a, tracer: true, flashScale: 2.6, pierce: true,
    burst: 1, cooldown: 4.4, charge: 2.15,
    spread: 0.75 * DEG, range: 340, aimTolerance: 0.1, leadAccuracy: 0.9, tightenTime: 1.5,
    heavy: true, volleyWeight: 1.5,
  },

  // --- boss -------------------------------------------------------------
  bossArtillery: {
    id: 'boss_arty', kind: 'shell', damageType: 'explosive', arc: true, arcHeight: 0.7,
    indirect: true, speed: 105, damage: 130, impact: 210, splash: 11,
    radius: 0.6, life: 9, color: 0xffb14d, flashScale: 2.4,
    burst: 1, cooldown: 0.001, telegraph: 0, hardpoint: 'rShoulder',
    spread: 0.6 * DEG, range: 400, aimTolerance: 3, leadAccuracy: 0.8,
  },
  bossBeam: {
    id: 'boss_beam', kind: 'beam', damageType: 'energy',
    speed: 480, damage: 74, impact: 120, radius: 0.7, life: 1.1,
    color: 0xff3fa0, flashScale: 1.4, beam: true,
    burst: 1, cooldown: 0.001, spread: 0.4 * DEG, range: 400, aimTolerance: 3,
  },
  bossSwarm: {
    id: 'boss_swarm', kind: 'missile', damageType: 'explosive', homing: true,
    speed: 48, accel: 52, turnRate: 2.9, damage: 34, impact: 52, splash: 3.8,
    radius: 0.26, life: 9, color: 0xff5fbf, smoke: true, flashScale: 1,
    burst: 1, cooldown: 0.001, spread: 10 * DEG, range: 400, aimTolerance: 3,
  },
  bossNova: {
    id: 'boss_nova', kind: 'plasma', damageType: 'energy',
    speed: 38, damage: 88, impact: 150, radius: 1.5, life: 6,
    color: 0xff2d6f, flashScale: 1.2,
    burst: 1, cooldown: 0.001, spread: 0, range: 400, aimTolerance: 3,
  },
};

// ---------------------------------------------------------------------------
// small shared helpers used by several archetypes
// ---------------------------------------------------------------------------

/** Draw the short aim laser that telegraphs a burst. Cheap, readable, fair. */
function drawAimLaser(b, key, hardpoint, color, width) {
  const tg = b.manager?.telegraphs;
  if (!tg) return;
  b.muzzlePos(hardpoint || 'rArm', _mz);
  tg.line(b.agent.id * 8 + key, _mz, b.bb.aimPoint, color, width);
}

/** Fire a projectile outside the normal weapon rhythm (boss set-piece attacks). */
function emitShot(b, def, hardpoint, dir, target) {
  b.muzzlePos(hardpoint || 'rArm', _mz);
  b.manager?.spawnProjectile?.(def, _mz, dir, b.agent, target || null);
  b.manager?.vfx?.muzzleFlash?.(_mz, dir, def.flashScale ?? 1, def.color ?? 0xffffff);
  bus.emit(EV.WEAPON_FIRED, {
    entity: b.agent, owner: b.agent, def, weapon: def.id,
    origin: _mz, position: _mz, direction: dir,
  });
}

/** Where is the player (believed to be)? Writes into `out`. */
function believedTarget(b, out) {
  const p = b.player;
  if (b.bb.hasLOS && b.bb.timeSinceSeen < 0.3 && p?.root) out.copy(p.root.position);
  else out.copy(b.bb.lastKnownPos);
  return out;
}

/**
 * Cheap incremental cover search: probes one candidate direction per call and
 * keeps the best hiding spot found. Spends a manager ray credit so a whole squad
 * can never storm the raycaster in one frame.
 */
function probeCover(b, dt) {
  const mem = b.memory;
  if (!mem.coverPos) {
    mem.coverPos = new THREE.Vector3();
    mem.hasCover = false;
    mem.coverProbe = 0;
    mem.coverTimer = 0;
    mem.coverAge = 0;
  }
  mem.coverAge += dt;
  if (mem.coverAge > 6) mem.hasCover = false;
  mem.coverTimer -= dt;
  if (mem.coverTimer > 0 || !b.manager?.spendRay?.()) return mem.hasCover;
  mem.coverTimer = 0.3;
  mem.coverProbe = (mem.coverProbe + 1) % 8;

  believedTarget(b, _t);
  const a = (mem.coverProbe / 8) * TAU + b.bb.slotAngle;
  const dist = 14 + b.rng() * 18;
  _p.set(b.pos.x + Math.cos(a) * dist, b.pos.y + 3.5, b.pos.z + Math.sin(a) * dist);
  // move *away* from the threat, not through it
  _u.subVectors(_p, _t);
  if (_u.dot(b.bb.toTarget) > 0) return mem.hasCover;

  _d.subVectors(_t, _p);
  _d.y += 4;
  const len = _d.length();
  if (len < 1) return mem.hasCover;
  _d.multiplyScalar(1 / len);
  const hit = b.physics?.raycast?.(_p, _d, len - 2);
  const blocked = !!(hit && hit.hit !== false && (hit.distance ?? len) < len - 3);
  if (blocked) {
    mem.coverPos.set(_p.x, b.pos.y, _p.z);
    mem.hasCover = true;
    mem.coverAge = 0;
  }
  return mem.hasCover;
}

/** Shared "helpless" state — the player's reward window after a stagger. */
const STAGGERED_STATE = {
  enter(b) {
    b.bb.desired.set(0, 0, 0);
    b.agent.velocity.x *= 0.35;
    b.agent.velocity.z *= 0.35;
    b.manager?.vfx?.staggerBurst?.(b.agent);
    // drop everything mid-sequence: no cheeky shots while reeling
    for (let i = 0; i < b.weapons.length; i++) {
      const w = b.weapons[i];
      w.burstLeft = 0;
      w.telegraph = 0;
      w.charging = false;
      w.charge = 0;
      w.cd = Math.max(w.cd, 0.6);
    }
    b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
  },
  update(b, dt) {
    // no input at all — they sag, sparks pour out, the player gets a free window
    b.bb.desired.set(0, 0, 0);
    b.memory.sparkT = (b.memory.sparkT ?? 0) - dt;
    if (b.memory.sparkT <= 0 && b.lod === 0) {
      b.memory.sparkT = 0.16;
      _p.copy(b.pos);
      _p.y += (b.agent.collider?.height ?? 8) * 0.6;
      _u.set(b.rng() - 0.5, b.rng() * 0.6, b.rng() - 0.5).normalize();
      b.manager?.vfx?.sparks?.(_p, _u, 0.8);
    }
  },
};

/** Search the last known position, then sweep, then give up. */
function searchUpdate(b, dt, speedMul) {
  const bb = b.bb;
  const speed = (b.arch.move.speed ?? 12) * (speedMul ?? 0.6);
  const d2 = _p.subVectors(bb.lastKnownPos, b.pos).setY(0).lengthSq();
  if (d2 > 36) {
    Steering.seek(bb.desired, b.pos, bb.lastKnownPos, speed);
  } else {
    // arrived: sweep the sensor around instead of standing like a statue
    const a = b.elapsed * 1.1 + b.bb.slotAngle;
    _p.set(b.pos.x + Math.cos(a) * 14, b.pos.y + 4, b.pos.z + Math.sin(a) * 14);
    b.aimAtPoint(_p);
    Steering.strafe(bb.desired, b.pos, bb.lastKnownPos, speed * 0.5, bb.strafeSign);
  }
  Steering.separation(bb.desired, b.agent, b.manager?.list, b.arch.move.separation ?? 11, speed);
  if (d2 > 36) {
    believedTarget(b, _t);
    _t.y += 4;
    b.aimAtPoint(_t);
  }
}

/** Idle patrol: slow drift around the spawn anchor with a scanning head. */
function idleUpdate(b, dt) {
  const bb = b.bb;
  const speed = (b.arch.move.speed ?? 12) * 0.28;
  if (!bb.hasAnchor) {
    bb.anchor.copy(b.pos);
    bb.hasAnchor = true;
  }
  if (bb.strafeTimer <= 0) {
    bb.strafeSign = b.rng() < 0.5 ? -1 : 1;
    bb.strafeTimer = 3 + b.rng() * 4;
  }
  Steering.orbit(bb.desired, b.pos, bb.anchor, 9, speed, bb.strafeSign);
  Steering.separation(bb.desired, b.agent, b.manager?.list, b.arch.move.separation ?? 11, speed);
  const a = b.elapsed * 0.5 + b.agent.id;
  _p.set(b.pos.x + Math.cos(a) * 22, b.pos.y + 5, b.pos.z + Math.sin(a) * 22);
  b.aimAtPoint(_p);
}

// ---------------------------------------------------------------------------
// MT — Muscle Tracer grunt
// ---------------------------------------------------------------------------

const MT = {
  id: 'mt',
  name: 'MT',
  displayName: 'MT-04 STRIDER',
  threat: 1,
  placeholder: { height: 6.4, radius: 1.7, color: 0x4a5560, accent: 0xff7b3a, shape: 'biped' },
  squad: { maxAttackers: 2, tokenHold: 3.2, volleyGap: 0.5 },

  stats(tier) {
    const s = tierScale(tier);
    return {
      apMax: 820 * s.ap,
      acsMax: 460 * s.acs,
      enMax: 0,
      defKinetic: M.clamp(0.08 * s.def, 0, 0.7),
      defEnergy: M.clamp(0.05 * s.def, 0, 0.7),
      acsDecay: 130, // ACS bleeds off fast → easy to stagger only under sustained fire
      staggerTime: 2.1, // long helpless window: MTs are punching bags by design
      radius: 1.7,
      height: 6.4,
      speedMul: s.speed,
    };
  },
  makeWeapons(tier) {
    const s = tierScale(tier);
    const list = [scaleWeapon(ENEMY_WEAPONS.mtRifle, s)];
    if (tier >= 3) list.push(scaleWeapon(ENEMY_WEAPONS.mtGrenade, s));
    return list;
  },

  move: { speed: 15, accel: 8.5, turnRate: 3.0, bodyTurnMul: 0.7, separation: 11, qbThrust: 0 },
  perception: { range: 165, fov: 1.25, close: 20, hearing: 110, memory: 5.0, acquire: 1.9, forget: 0.34, losInterval: 0.16 },
  reaction: { think: 0.16, firstShot: 0.62, afterStagger: 0.5, dodge: false },
  combat: { preferred: 34, accuracyMul: 1, speedPenalty: 1.5, useTokens: true },

  initial: 'idle',

  think(b) {
    const bb = b.bb;
    const s = b.stats;
    const apRatio = s.apMax ? s.ap / s.apMax : 1;

    if (bb.awareness < 0.32) {
      b.setState(bb.alert >= 1 ? 'search' : 'idle');
      return;
    }
    if (b.state === 'idle' || b.state === 'search') {
      // first acquisition — pay the reaction tax before shooting
      bb.reactionTimer = Math.max(bb.reactionTimer, b.arch.reaction.firstShot * (0.75 + b.rng() * 0.6));
    }
    if (apRatio < 0.3 && bb.distance < 48 && !bb.hasToken) {
      bb.panic = 1;
      b.setState('fallback');
      return;
    }
    if (bb.timeSinceSeen > 2.2 && !bb.hasLOS) {
      b.setState('search');
      return;
    }
    b.setState(bb.hasToken ? 'engage' : 'flank');
  },

  states: {
    idle: { update: idleUpdate },
    search: {
      update(b, dt) {
        searchUpdate(b, dt, 0.62);
        if (b.stateTime > 9) {
          b.bb.alert = 0;
          b.setState('idle');
        }
      },
    },

    engage: {
      enter(b) {
        b.bb.orbitRadius = b.arch.combat.preferred * (0.8 + b.rng() * 0.5);
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 4;
        b.aimAtPoint(_t);
        b.combatSteer(_t, bb.orbitRadius, b.arch.move.speed, dt);
        b.requestFire(0);
        if (b.weapons[1]) b.requestFire(1);
        if (b.weapons[0]?.telegraph > 0) drawAimLaser(b, 0, 'rArm', 0xff5a3c, 0.055);
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
    },

    /** No token: take a wide lane, keep the player boxed in, fire only sparsely. */
    flank: {
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 4;
        b.aimAtPoint(_t);
        const r = b.arch.combat.preferred * 1.75;
        b.combatSteer(_t, r, b.arch.move.speed * 0.95, dt);
        // occasional suppressive chatter so flankers aren't mute — deliberately loose
        b.memory.supT = (b.memory.supT ?? 2 + b.rng() * 3) - dt;
        if (b.memory.supT <= 0) {
          b.memory.supT = 3.2 + b.rng() * 3.5;
          bb.panic = Math.max(bb.panic, 0.9); // widens the cone: this is noise, not a kill shot
          b.requestFire(0, { ignoreToken: true });
        }
      },
    },

    fallback: {
      enter(b) {
        b.memory.hasCover = false;
        b.memory.coverAge = 99;
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        const speed = b.arch.move.speed * 1.05;
        if (probeCover(b, dt)) Steering.seek(bb.desired, b.pos, b.memory.coverPos, speed);
        else Steering.flee(bb.desired, b.pos, _t, speed);
        Steering.separation(bb.desired, b.agent, b.manager?.list, 12, speed);
        b._avoid(dt, speed);
        _t.y += 4;
        b.aimAtPoint(_t);
        if (bb.distance > 75 || b.stateTime > 7) {
          bb.panic = 0.3;
          b.setState('flank');
        }
      },
    },

    staggered: STAGGERED_STATE,
  },

  onStagger(b) {
    bus.emit(EV.SFX, { id: 'stagger_light', position: b.pos });
  },
};

// ---------------------------------------------------------------------------
// AC — the rival Armored Core. This is the duel.
// ---------------------------------------------------------------------------

const AC = {
  id: 'ac',
  name: 'AC',
  displayName: 'AC "ASHFALL"',
  threat: 6,
  placeholder: { height: 8.8, radius: 2.1, color: 0x2f3540, accent: 0x59d2ff, shape: 'biped' },
  squad: { maxAttackers: 1, tokenHold: 99, volleyGap: 0.2 },

  stats(tier) {
    const s = tierScale(tier);
    return {
      apMax: 4400 * s.ap,
      acsMax: 2100 * s.acs,
      enMax: 5400,
      defKinetic: M.clamp(0.26 * s.def, 0, 0.7),
      defEnergy: M.clamp(0.24 * s.def, 0, 0.7),
      acsDecay: 260,
      staggerTime: 1.5,
      radius: 2.1,
      height: 8.8,
      speedMul: s.speed,
    };
  },
  makeWeapons(tier) {
    const s = tierScale(tier);
    return [
      scaleWeapon(ENEMY_WEAPONS.acRifle, s),
      scaleWeapon(ENEMY_WEAPONS.acShotgun, s),
      scaleWeapon(ENEMY_WEAPONS.acMissile, s),
    ];
  },

  move: {
    speed: 44, accel: 16, turnRate: 5.2, bodyTurnMul: 0.8, separation: 14,
    qbThrust: 30, qbCost: 480, enRecharge: 1150, boostCost: 190,
  },
  perception: { range: 260, fov: 1.5, close: 32, hearing: 170, memory: 7, acquire: 3.4, forget: 0.28, losInterval: 0.1 },
  reaction: {
    think: 0.1, firstShot: 0.26, afterStagger: 0.3,
    dodge: true, dodgeCooldown: 1.05, dodgeThreshold: 0.34, dodgeChance: 0.88, lockPatience: 1.25,
  },
  combat: { preferred: 40, accuracyMul: 1, speedPenalty: 0.95, useTokens: false },

  initial: 'approach',

  onSpawn(b) {
    b.memory.commit = 0;
    b.memory.plan = 'duel';
    b.memory.weave = b.rng() * TAU;
  },

  think(b, dt) {
    const bb = b.bb;
    const s = b.stats;
    const ap = s.apMax ? s.ap / s.apMax : 1;
    const en = s.enMax ? s.en / s.enMax : 1;

    if (bb.awareness < 0.3) {
      b.setState(bb.alert >= 1 ? 'search' : 'approach');
      return;
    }

    // Emergencies override the commitment timer.
    if (bb.enRecovering || en < 0.16) {
      b.memory.commit = 1.2;
      b.setState('cover');
      return;
    }
    if (ap < 0.22 && b.state !== 'break' && b.rng() < 0.6) {
      b.memory.commit = 2.4;
      b.setState('break');
      return;
    }

    // Commit to a plan for a beat so it doesn't twitch between states.
    b.memory.commit -= dt;
    if (b.memory.commit > 0) return;
    b.memory.commit = 1.3 + b.rng() * 1.9;

    if (!bb.hasLOS && bb.timeSinceSeen > 1.8) {
      b.setState('search');
      return;
    }

    const d = bb.distance;
    const r = b.rng();
    if (d > 95) b.setState(r < 0.65 ? 'approach' : 'break');
    else if (d > 58) b.setState(r < 0.55 ? 'approach' : 'duel');
    else if (d > 24) b.setState(r < 0.32 ? 'close' : 'duel');
    else b.setState(r < 0.72 ? 'close' : 'break');
  },

  states: {
    search: {
      update(b, dt) {
        searchUpdate(b, dt, 0.85);
        if (b.stateTime > 6) b.setState('approach');
      },
    },

    /** Assault boost in on a weaving line — never a straight beeline. */
    approach: {
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 4.5;
        b.aimAtPoint(_t);
        const speed = b.arch.move.speed;
        Steering.seek(bb.desired, b.pos, _t, speed);
        // lateral weave: sinusoidal offset makes it a hard target while closing
        b.memory.weave += dt * 2.1;
        _u.subVectors(_t, b.pos).setY(0).normalize();
        bb.desired.x += -_u.z * Math.sin(b.memory.weave) * speed * 0.62;
        bb.desired.z += _u.x * Math.sin(b.memory.weave) * speed * 0.62;
        Steering.separation(bb.desired, b.agent, b.manager?.list, 14, speed);
        b._avoid(dt, speed);
        if (bb.distance > 40) b.spendEN(b.arch.move.boostCost * dt);
        b.requestFire(0);
        b.requestFire(2);
        b.setBoost(0.9);
      },
    },

    /** Mid-range trading: boost-strafe on a ring, rifle bursts, missile salvos. */
    duel: {
      enter(b) {
        b.bb.orbitRadius = 32 + b.rng() * 22;
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 4.5;
        b.aimAtPoint(_t);
        const speed = b.arch.move.speed * 0.92;
        if (bb.strafeTimer <= 0) {
          bb.strafeSign = -bb.strafeSign;
          bb.strafeTimer = 0.9 + b.rng() * 1.5;
        }
        Steering.orbit(bb.desired, b.pos, _t, bb.orbitRadius, speed, bb.strafeSign);
        Steering.separation(bb.desired, b.agent, b.manager?.list, 14, speed);
        b._avoid(dt, speed);
        b.spendEN(b.arch.move.boostCost * 0.6 * dt);
        b.requestFire(0);
        b.requestFire(2);
      },
    },

    /** Shotgun rush: get inside, dump the barrel, then immediately break off. */
    close: {
      enter(b) {
        b.memory.dumped = false;
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 4;
        b.aimAtPoint(_t);
        const speed = b.arch.move.speed * 1.06;
        if (bb.distance > 18) {
          Steering.seek(bb.desired, b.pos, _t, speed);
          // juke laterally on the way in so the approach isn't a free shot for the player
          b.memory.weave += dt * 3.4;
          _u.subVectors(_t, b.pos).setY(0).normalize();
          bb.desired.x += -_u.z * Math.sin(b.memory.weave) * speed * 0.5;
          bb.desired.z += _u.x * Math.sin(b.memory.weave) * speed * 0.5;
          b.spendEN(b.arch.move.boostCost * dt);
        } else {
          Steering.orbit(bb.desired, b.pos, _t, 14, speed, bb.strafeSign);
        }
        Steering.separation(bb.desired, b.agent, b.manager?.list, 14, speed);
        b._avoid(dt, speed);

        if (b.requestFire(1)) b.memory.dumped = true;
        b.requestFire(0, { rangeMul: 0.5 });
        // after the shotgun goes off, disengage rather than standing in the blender
        if (b.memory.dumped && b.weapons[1]?.cd > 0.35) {
          b.quickBoost(bb.toTarget, 1);
          b.memory.commit = 0;
          b.setState('break');
        }
      },
    },

    /** Back off, regain EN, lob missiles from outside the player's comfortable range. */
    break: {
      enter(b) {
        b.bb.strafeSign = b.rng() < 0.5 ? -1 : 1;
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 4.5;
        b.aimAtPoint(_t);
        const speed = b.arch.move.speed * 0.85;
        if (bb.distance < 78) {
          Steering.flee(bb.desired, b.pos, _t, speed);
          Steering.strafe(bb.desired, b.pos, _t, speed * 0.7, bb.strafeSign);
        } else {
          Steering.orbit(bb.desired, b.pos, _t, 82, speed * 0.7, bb.strafeSign);
        }
        Steering.separation(bb.desired, b.agent, b.manager?.list, 14, speed);
        b._avoid(dt, speed);
        b.requestFire(2);
        b.requestFire(0, { rangeMul: 1 });
      },
    },

    /** Break line of sight behind geometry and let the generator refill. */
    cover: {
      enter(b) {
        b.memory.hasCover = false;
        b.memory.coverAge = 99;
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        const speed = b.arch.move.speed * 0.8;
        if (probeCover(b, dt)) Steering.seek(bb.desired, b.pos, b.memory.coverPos, speed);
        else Steering.flee(bb.desired, b.pos, _t, speed);
        Steering.separation(bb.desired, b.agent, b.manager?.list, 14, speed);
        b._avoid(dt, speed);
        _t.y += 4;
        b.aimAtPoint(_t);
        // indirect fire is still fair game from behind cover
        if (!bb.hasLOS) b.requestFire(2, { ignoreLOS: true, ignoreAim: true });
        const s = b.stats;
        if ((s.enMax ? s.en / s.enMax : 1) > 0.75) {
          b.memory.commit = 0;
          b.setState('duel');
        }
      },
    },

    staggered: STAGGERED_STATE,
  },

  onStagger(b) {
    bus.emit(EV.SFX, { id: 'stagger_heavy', position: b.pos });
    bus.emit('mission:log', { text: 'TARGET ACS OVERLOAD — ASHFALL' });
  },
};

// ---------------------------------------------------------------------------
// TANK — heavy quad artillery platform with a rear weak point
// ---------------------------------------------------------------------------

const TANK = {
  id: 'tank',
  name: 'TANK',
  displayName: 'HC-11 BULWARK',
  threat: 4,
  placeholder: { height: 7.6, radius: 3.4, color: 0x50493c, accent: 0xffb03a, shape: 'quad' },
  squad: { maxAttackers: 2, tokenHold: 4.5, volleyGap: 0.8 },

  stats(tier) {
    const s = tierScale(tier);
    return {
      apMax: 7600 * s.ap,
      acsMax: 3700 * s.acs,
      enMax: 0,
      defKinetic: M.clamp(0.4 * s.def, 0, 0.72),
      defEnergy: M.clamp(0.28 * s.def, 0, 0.72),
      acsDecay: 420, // very high stagger resistance — hit the vents instead
      staggerTime: 2.6,
      radius: 3.4,
      height: 7.6,
      speedMul: s.speed,
    };
  },
  makeWeapons(tier) {
    const s = tierScale(tier);
    return [scaleWeapon(ENEMY_WEAPONS.tankArtillery, s), scaleWeapon(ENEMY_WEAPONS.tankCQB, s)];
  },

  // rear vents: local +Z is behind the mech (forward is -Z)
  weakPoint: { offset: new THREE.Vector3(0, 4.2, 3.1), radius: 3.0, mult: 2.6, name: 'REAR VENTS' },

  move: { speed: 7.5, accel: 3.4, turnRate: 1.15, bodyTurnMul: 0.9, separation: 15, qbThrust: 0 },
  perception: { range: 220, fov: 1.05, close: 26, hearing: 140, memory: 8, acquire: 1.5, forget: 0.22, losInterval: 0.2 },
  reaction: { think: 0.24, firstShot: 0.95, afterStagger: 0.9, dodge: false },
  combat: { preferred: 78, accuracyMul: 1, speedPenalty: 0.7, useTokens: true },

  initial: 'idle',

  think(b) {
    const bb = b.bb;
    if (bb.awareness < 0.3) {
      b.setState(bb.alert >= 1 ? 'track' : 'idle');
      return;
    }
    if (b.state === 'idle') bb.reactionTimer = Math.max(bb.reactionTimer, b.arch.reaction.firstShot);
    if (bb.distance < 26) {
      b.setState('cqb');
      return;
    }
    if (bb.distance < 34 || bb.distance > 165) {
      b.setState('waddle');
      return;
    }
    b.setState('bombard');
  },

  states: {
    idle: { update: idleUpdate },
    track: {
      update(b, dt) {
        searchUpdate(b, dt, 0.5);
        if (b.stateTime > 12) b.setState('idle');
      },
    },

    /**
     * Telegraphed indirect fire. A ballistic arc plus ground rings appear ~1.7 s
     * before the shells land and the impact points *walk* toward the player, so
     * standing still is lethal and moving is safe. That's the whole lesson.
     */
    bombard: {
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 3;
        b.aimAtPoint(_t);
        // shuffle just enough to not be a statue, but hold the firing platform
        const speed = b.arch.move.speed * 0.45;
        Steering.orbit(bb.desired, b.pos, _t, b.arch.combat.preferred, speed, bb.strafeSign);
        Steering.separation(bb.desired, b.agent, b.manager?.list, 15, speed);

        const w = b.weapons[0];
        b.requestFire(0, { ignoreAim: true });
        if (w?.telegraph > 0) {
          const tg = b.manager?.telegraphs;
          if (tg) {
            b.muzzlePos('rShoulder', _mz);
            b.solveAim(w.def, _mz, _p);
            tg.arc(b.agent.id * 8 + 1, _mz, _p, 0.55, 0xffa24d);
            tg.ring(b.agent.id * 8 + 2, _p, (w.def.splash ?? 9) * 1.05, 0xff7a2a, 1 - w.telegraph / (w.def.telegraph || 1));
          }
        }
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
    },

    /** Reposition to get back into the artillery band. */
    waddle: {
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        const speed = b.arch.move.speed;
        const want = b.arch.combat.preferred;
        if (bb.distance < want) Steering.flee(bb.desired, b.pos, _t, speed);
        else Steering.seek(bb.desired, b.pos, _t, speed);
        Steering.strafe(bb.desired, b.pos, _t, speed * 0.4, bb.strafeSign);
        Steering.separation(bb.desired, b.agent, b.manager?.list, 15, speed);
        b._avoid(dt, speed);
        _t.y += 3;
        b.aimAtPoint(_t);
      },
    },

    /** Player got inside the minimum range — short, heavily telegraphed scattergun. */
    cqb: {
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 3.5;
        b.aimAtPoint(_t);
        const speed = b.arch.move.speed * 0.8;
        Steering.flee(bb.desired, b.pos, _t, speed);
        Steering.separation(bb.desired, b.agent, b.manager?.list, 15, speed);
        b.requestFire(1);
        if (b.weapons[1]?.telegraph > 0) drawAimLaser(b, 2, 'lArm', 0xffb03a, 0.09);
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
    },

    staggered: STAGGERED_STATE,
  },
};

// ---------------------------------------------------------------------------
// FLYER — fast hovering drone, pack hunter
// ---------------------------------------------------------------------------

const FLYER = {
  id: 'flyer',
  name: 'DRONE',
  displayName: 'LD-2 KITE',
  threat: 2,
  placeholder: { height: 3.2, radius: 1.5, color: 0x3b4550, accent: 0x66e0ff, shape: 'drone' },
  squad: { maxAttackers: 3, tokenHold: 2.4, volleyGap: 0.35 },

  stats(tier) {
    const s = tierScale(tier);
    return {
      apMax: 480 * s.ap,
      acsMax: 240 * s.acs,
      enMax: 1800,
      defKinetic: M.clamp(0.05 * s.def, 0, 0.6),
      defEnergy: M.clamp(0.14 * s.def, 0, 0.6),
      acsDecay: 90,
      staggerTime: 1.7, // staggered flyers sag out of the sky — very readable
      radius: 1.5,
      height: 3.2,
      speedMul: s.speed,
    };
  },
  makeWeapons(tier) {
    return [scaleWeapon(ENEMY_WEAPONS.flyerPulse, tierScale(tier))];
  },

  move: {
    speed: 33, accel: 11, vertAccel: 7, turnRate: 4.4, bodyTurnMul: 0.85,
    separation: 9, hover: true, minAltitude: 9, qbThrust: 20, qbCost: 260, enRecharge: 620,
  },
  perception: { range: 210, fov: 1.6, close: 26, hearing: 150, memory: 5.5, acquire: 2.6, forget: 0.36, losInterval: 0.14 },
  reaction: {
    think: 0.14, firstShot: 0.45, afterStagger: 0.4,
    dodge: true, dodgeCooldown: 1.6, dodgeThreshold: 0.45, dodgeChance: 0.7, lockPatience: 1.8,
  },
  combat: { preferred: 46, accuracyMul: 1, speedPenalty: 1.35, useTokens: true },

  initial: 'orbit',

  onSpawn(b) {
    b.memory.altitude = 16 + b.rng() * 14;
    b.memory.runCd = 2 + b.rng() * 4;
  },

  think(b, dt) {
    const bb = b.bb;
    if (bb.awareness < 0.3) {
      b.setState('orbit');
      return;
    }
    b.memory.runCd -= dt;
    if (b.state === 'strafeRun') return; // runs complete on their own
    if (b.memory.runCd <= 0 && bb.hasLOS && bb.hasToken) {
      // one pass at a time per squad — the volley gate keeps the pack readable
      if (b.agent.squad?.requestVolley?.(2.2) !== false) {
        b.memory.runCd = 5.5 + b.rng() * 4;
        b.setState('strafeRun');
        return;
      }
    }
    b.setState('orbit');
  },

  states: {
    /** Circle high and wide, taking occasional pot shots. Forces the player to look up. */
    orbit: {
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        const speed = b.arch.move.speed * 0.75;
        if (bb.strafeTimer <= 0) {
          bb.strafeSign = b.rng() < 0.5 ? -1 : 1;
          bb.strafeTimer = 2.5 + b.rng() * 3;
        }
        Steering.orbit(bb.desired, b.pos, _t, b.arch.combat.preferred, speed, bb.strafeSign);
        // hold an altitude band above the target
        const wantY = (b.bb.hasLOS ? _t.y : b.pos.y) + b.memory.altitude;
        bb.desired.y += M.clamp(wantY - b.pos.y, -1, 1) * b.arch.move.speed * 0.55;
        // bob so they never look like static sprites
        bb.desired.y += Math.sin(b.elapsed * 1.7 + b.agent.id) * 2.4;
        Steering.separation(bb.desired, b.agent, b.manager?.list, 9, speed);
        _t.y += 4;
        b.aimAtPoint(_t);
        b.requestFire(0);
      },
    },

    /**
     * A committed pass: pick an exit point past the player, boost through it
     * firing, then climb away. Predictable enough to punish, fast enough to hurt.
     */
    strafeRun: {
      enter(b) {
        const bb = b.bb;
        believedTarget(b, _t);
        _u.subVectors(_t, b.pos).setY(0).normalize();
        if (!b.memory.exit) b.memory.exit = new THREE.Vector3();
        const side = b.rng() < 0.5 ? -1 : 1;
        b.memory.exit.set(
          _t.x + _u.x * 52 + -_u.z * side * 26,
          _t.y + 8 + b.rng() * 6,
          _t.z + _u.z * 52 + _u.x * side * 26
        );
        b.memory.runPhase = 0;
      },
      update(b, dt) {
        const bb = b.bb;
        const speed = b.arch.move.speed * 1.5;
        believedTarget(b, _t);
        _t.y += 4;
        b.aimAtPoint(_t);
        Steering.seek(bb.desired, b.pos, b.memory.exit, speed);
        bb.desired.y += M.clamp(b.memory.exit.y - b.pos.y, -1, 1) * speed * 0.5;
        Steering.separation(bb.desired, b.agent, b.manager?.list, 9, speed);
        b.requestFire(0, { ignoreToken: true, rangeMul: 1.2 });
        const done = _p.subVectors(b.memory.exit, b.pos).lengthSq() < 100 || b.stateTime > 3.6;
        if (done) {
          b.memory.altitude = 14 + b.rng() * 16;
          b.setState('orbit');
        }
      },
    },

    staggered: STAGGERED_STATE,
  },
};

// ---------------------------------------------------------------------------
// SNIPER — perches, charges, forces you to break line of sight
// ---------------------------------------------------------------------------

const SNIPER = {
  id: 'sniper',
  name: 'SNIPER',
  displayName: 'LR-9 VERDICT',
  threat: 5,
  placeholder: { height: 7.0, radius: 1.8, color: 0x3a3f4a, accent: 0xff4d6a, shape: 'biped' },
  squad: { maxAttackers: 3, tokenHold: 5, volleyGap: 0.2 },

  stats(tier) {
    const s = tierScale(tier);
    return {
      apMax: 1500 * s.ap,
      acsMax: 720 * s.acs,
      enMax: 2400,
      defKinetic: M.clamp(0.14 * s.def, 0, 0.65),
      defEnergy: M.clamp(0.2 * s.def, 0, 0.65),
      acsDecay: 110,
      staggerTime: 2.4,
      radius: 1.8,
      height: 7.0,
      speedMul: s.speed,
    };
  },
  makeWeapons(tier) {
    return [scaleWeapon(ENEMY_WEAPONS.sniperRail, tierScale(tier))];
  },

  move: {
    speed: 17, accel: 7, turnRate: 1.9, bodyTurnMul: 0.75, separation: 12,
    hover: true, minAltitude: 2, vertAccel: 5, qbThrust: 18, qbCost: 300, enRecharge: 700,
  },
  perception: { range: 400, fov: 1.15, close: 24, hearing: 200, memory: 9, acquire: 1.7, forget: 0.2, losInterval: 0.13 },
  reaction: {
    think: 0.18, firstShot: 1.15, afterStagger: 1.1,
    dodge: true, dodgeCooldown: 2.4, dodgeThreshold: 0.55, dodgeChance: 0.5, lockPatience: 2.2,
  },
  combat: { preferred: 150, accuracyMul: 1, speedPenalty: 1.9, useTokens: false },

  initial: 'perch',

  onSpawn(b) {
    b.memory.perch = new THREE.Vector3().copy(b.pos);
    b.memory.hasPerch = true;
    b.memory.relocateCd = 0;
  },

  think(b, dt) {
    const bb = b.bb;
    b.memory.relocateCd -= dt;
    if (b.state === 'relocate') return;
    if (bb.awareness < 0.3) {
      b.setState(b.memory.hasPerch && _p.subVectors(b.memory.perch, b.pos).lengthSq() > 25 ? 'perch' : 'scan');
      return;
    }
    // player closed the distance or broke LOS → move house
    if ((bb.distance < 46 || (bb.timeSinceSeen > 3.2 && !bb.hasLOS)) && b.memory.relocateCd <= 0) {
      b.memory.relocateCd = 6;
      b.setState('relocate');
      return;
    }
    b.setState(bb.hasLOS ? 'aim' : 'scan');
  },

  states: {
    perch: {
      update(b, dt) {
        const bb = b.bb;
        const speed = b.arch.move.speed;
        Steering.seek(bb.desired, b.pos, b.memory.perch, speed);
        bb.desired.y += M.clamp(b.memory.perch.y - b.pos.y, -1, 1) * speed;
        Steering.separation(bb.desired, b.agent, b.manager?.list, 12, speed);
        b._avoid(dt, speed);
        believedTarget(b, _t);
        _t.y += 4;
        b.aimAtPoint(_t);
        if (_p.subVectors(b.memory.perch, b.pos).lengthSq() < 20) b.setState('scan');
      },
    },

    scan: {
      update(b, dt) {
        const bb = b.bb;
        // hold the perch, sweep the arena
        Steering.seek(bb.desired, b.pos, b.memory.perch, b.arch.move.speed * 0.4);
        bb.desired.y += M.clamp(b.memory.perch.y - b.pos.y, -1, 1) * b.arch.move.speed * 0.6;
        if (bb.awareness > 0.2) {
          believedTarget(b, _t);
          _t.y += 4;
          b.aimAtPoint(_t);
        } else {
          const a = b.elapsed * 0.35 + b.agent.id;
          _p.set(b.pos.x + Math.cos(a) * 60, b.pos.y - 4, b.pos.z + Math.sin(a) * 60);
          b.aimAtPoint(_p);
        }
      },
    },

    /**
     * Charge-up with a laser sight the player can see from across the arena.
     * The sight tracks slowly, so lateral movement beats it — that is the counter.
     */
    aim: {
      enter(b) {
        b.bb.reactionTimer = Math.max(b.bb.reactionTimer, b.arch.reaction.firstShot * (0.7 + b.rng() * 0.5));
      },
      update(b, dt) {
        const bb = b.bb;
        const w = b.weapons[0];
        // hold still while charging — a sniper that jitters is unreadable
        Steering.seek(bb.desired, b.pos, b.memory.perch, b.arch.move.speed * 0.3);
        bb.desired.y += M.clamp(b.memory.perch.y - b.pos.y, -1, 1) * b.arch.move.speed * 0.6;

        believedTarget(b, _t);
        _t.y += 4;
        b.aimAtPoint(_t);
        b.requestFire(0, { ignoreToken: true });

        if (w?.charging) {
          const t = M.clamp(w.charge / (w.def.charge || 1), 0, 1);
          const tg = b.manager?.telegraphs;
          if (tg) {
            b.muzzlePos('rArm', _mz);
            b.solveAim(w.def, _mz, _p);
            // the beam brightens and thickens as the shot approaches
            tg.line(b.agent.id * 8 + 3, _mz, _p, 0xff2b4e, 0.02 + t * 0.075, 0.35 + t * 0.65);
            if (t > 0.7) tg.ring(b.agent.id * 8 + 2, _p, 2.2 + (1 - t) * 6, 0xff2b4e, t);
          }
          // abort if the target breaks line of sight — no shooting through walls
          if (!bb.hasLOS && bb.timeSinceSeen > 0.6) {
            w.charging = false;
            w.charge = 0;
            w.cd = 1.1;
            b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
          }
        }
      },
      exit(b) {
        const w = b.weapons[0];
        if (w?.charging) {
          w.charging = false;
          w.charge = 0;
          w.cd = 1.2;
        }
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
    },

    /** Break contact and climb to a new vantage point. */
    relocate: {
      enter(b) {
        const bb = b.bb;
        believedTarget(b, _t);
        _u.subVectors(b.pos, _t).setY(0);
        if (_u.lengthSq() < 1) _u.set(1, 0, 0);
        _u.normalize();
        const a = (b.rng() - 0.5) * 1.6;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const dist = 55 + b.rng() * 45;
        const nx = b.pos.x + (_u.x * c - _u.z * s) * dist;
        const nz = b.pos.z + (_u.x * s + _u.z * c) * dist;
        const g = b.physics?.groundHeight?.(nx, nz) ?? 0;
        b.memory.perch.set(nx, g + 16 + b.rng() * 14, nz);
        b.memory.hasPerch = true;
      },
      update(b, dt) {
        const bb = b.bb;
        const speed = b.arch.move.speed * 1.5;
        Steering.seek(bb.desired, b.pos, b.memory.perch, speed);
        bb.desired.y += M.clamp(b.memory.perch.y - b.pos.y, -1, 1) * speed;
        Steering.separation(bb.desired, b.agent, b.manager?.list, 12, speed);
        b._avoid(dt, speed);
        believedTarget(b, _t);
        _t.y += 4;
        b.aimAtPoint(_t);
        if (_p.subVectors(b.memory.perch, b.pos).lengthSq() < 36 || b.stateTime > 7) b.setState('scan');
      },
    },

    staggered: STAGGERED_STATE,
  },

  onChargeStart(b) {
    bus.emit(EV.SFX, { id: 'rail_charge', position: b.pos });
  },
  onChargeEnd(b) {
    b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
    bus.emit(EV.SHAKE, { intensity: 0.25, duration: 0.2 });
  },
};

// ---------------------------------------------------------------------------
// BOSS — "IB-C01 OUROBOROS"
// ---------------------------------------------------------------------------

const BOSS_PHASE_LOG = [
  'IB-C01 OUROBOROS — PULSE ARMOUR ONLINE. BREAK THE SHIELD.',
  'PULSE ARMOUR COLLAPSED — TARGET GOING AGGRESSIVE.',
  'OUROBOROS CORE CRITICAL — DESPERATION PROTOCOL.',
];

/** Pick the next attack, never the same one twice, honouring per-attack cooldowns. */
function chooseAttack(b, options) {
  const mem = b.memory;
  if (!mem.atkCd) mem.atkCd = Object.create(null);
  let best = null;
  let bestScore = -1e9;
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    const cd = mem.atkCd[o.state] ?? 0;
    if (cd > 0) continue;
    if (o.state === mem.lastAttack) continue;
    if (o.minRange != null && b.bb.distance < o.minRange) continue;
    if (o.maxRange != null && b.bb.distance > o.maxRange) continue;
    const score = o.weight * (0.55 + b.rng());
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  if (!best) {
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      if ((mem.atkCd[o.state] ?? 0) <= 0) {
        best = o;
        break;
      }
    }
  }
  return best;
}

function tickAttackCooldowns(b, dt) {
  const cds = b.memory.atkCd;
  if (!cds) return;
  for (const k in cds) if (cds[k] > 0) cds[k] -= dt;
}

const BOSS = {
  id: 'boss',
  name: 'OUROBOROS',
  displayName: 'IB-C01 OUROBOROS',
  threat: 20,
  isBoss: true,
  placeholder: { height: 16, radius: 5.5, color: 0x1e2229, accent: 0xff2d6f, shape: 'boss' },
  squad: { maxAttackers: 4, tokenHold: 99, volleyGap: 0.05 },

  stats(tier) {
    const s = tierScale(tier);
    return {
      apMax: 42000 * (1 + 0.25 * (s.tier - 1)),
      acsMax: 13000 * s.acs,
      enMax: 12000,
      defKinetic: 0.34,
      defEnergy: 0.3,
      acsDecay: 900,
      staggerTime: 3.4, // the single biggest punish window in the mission
      radius: 5.5,
      height: 16,
      speedMul: 1,
    };
  },
  makeWeapons(tier) {
    const s = tierScale(tier);
    return [
      scaleWeapon(ENEMY_WEAPONS.bossArtillery, s),
      scaleWeapon(ENEMY_WEAPONS.bossBeam, s),
      scaleWeapon(ENEMY_WEAPONS.bossSwarm, s),
      scaleWeapon(ENEMY_WEAPONS.bossNova, s),
    ];
  },

  shield: { amount: 0.62, color: 0x49c8ff, radius: 13 }, // damage multiplier while up

  move: { speed: 13, accel: 5.5, turnRate: 1.5, bodyTurnMul: 0.85, separation: 18, qbThrust: 0, enRecharge: 1400 },
  perception: { range: 500, fov: 2.6, close: 90, hearing: 400, memory: 30, acquire: 6, forget: 0.05, losInterval: 0.12 },
  reaction: { think: 0.12, firstShot: 1.4, afterStagger: 1.2, dodge: false },
  combat: { preferred: 60, accuracyMul: 1, speedPenalty: 1.1, useTokens: false },

  initial: 'intro',

  onSpawn(b) {
    b.memory.phase = 0;
    b.memory.atkCd = Object.create(null);
    b.memory.lastAttack = '';
    b.memory.sweepAngle = 0;
    b.memory.beamT = 0;
    b.memory.shellT = 0;
    b.memory.shellCount = 0;
    b.memory.impact = new THREE.Vector3();
    b.memory.dir = new THREE.Vector3();
    b.agent.shield = BOSS.shield.amount;
    b.agent.shieldUp = true;
  },

  /** Phase transitions + attack selection. Recovery states are the punish windows. */
  think(b, dt) {
    const bb = b.bb;
    const s = b.stats;
    const ap = s.apMax ? s.ap / s.apMax : 1;
    tickAttackCooldowns(b, dt);

    // ---- phase gates ----
    let phase = 0;
    if (ap < 0.25) phase = 2;
    else if (ap < 0.6) phase = 1;
    if (phase !== b.memory.phase) {
      b.memory.phase = phase;
      if (phase >= 1 && b.agent.shieldUp) {
        b.agent.shieldUp = false;
        b.agent.shield = 0;
        b.manager?.breakShield?.(b.agent);
      }
      // phase speed lives on the brain, never on the shared archetype object
      b.speedMul = phase === 0 ? 1 : phase === 1 ? 1.35 : 1.75;
      b.thinkInterval = phase === 2 ? 0.08 : 0.12;
      bus.emit('mission:log', { text: BOSS_PHASE_LOG[phase] });
      bus.emit(EV.SHAKE, { intensity: 1.1, duration: 1.1 });
      b.setState('recover');
      b.memory.recoverFor = phase === 2 ? 1.2 : 1.9;
      return;
    }

    if (b.state === 'intro' || b.state === 'recover') return; // they self-exit
    if (b.state !== 'reposition' && b.state.indexOf('atk_') === 0) return; // attacks run to completion

    // choose the next attack for the current phase
    const opts = phase === 0 ? BOSS_P1 : phase === 1 ? BOSS_P2 : BOSS_P3;
    const pick = chooseAttack(b, opts);
    if (pick) {
      b.memory.lastAttack = pick.state;
      b.memory.atkCd[pick.state] = pick.cooldown;
      b.setState(pick.state);
    } else b.setState('reposition');
  },

  states: {
    intro: {
      enter(b) {
        b.bb.reactionTimer = 1.6;
        bus.emit('mission:log', { text: BOSS_PHASE_LOG[0] });
      },
      update(b, dt) {
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        if (b.stateTime > 2.6) b.setState('reposition');
      },
    },

    /** Between attacks: walk, keep range, and stay readable. */
    reposition: {
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        const speed = b.arch.move.speed;
        const want = b.memory.phase === 2 ? 42 : 66;
        if (bb.strafeTimer <= 0) {
          bb.strafeSign = b.rng() < 0.5 ? -1 : 1;
          bb.strafeTimer = 1.8 + b.rng() * 2;
        }
        Steering.orbit(bb.desired, b.pos, _t, want, speed, bb.strafeSign);
        b._avoid(dt, speed);
      },
    },

    /** Post-attack vulnerability. Vents open, it barely moves — go hit it. */
    recover: {
      enter(b) {
        b.memory.recoverFor = b.memory.recoverFor ?? (b.memory.phase === 2 ? 0.75 : 1.35);
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        Steering.orbit(bb.desired, b.pos, _t, 60, b.arch.move.speed * 0.35, bb.strafeSign);
        if (b.lod === 0 && b.rng() < 0.25) {
          _p.copy(b.pos);
          _p.y += 9;
          _u.set(b.rng() - 0.5, 0.8, b.rng() - 0.5).normalize();
          b.manager?.vfx?.sparks?.(_p, _u, 0.6);
        }
        if (b.stateTime > b.memory.recoverFor) {
          b.memory.recoverFor = null;
          b.setState('reposition');
        }
      },
    },

    // ---- PHASE 1: shielded siege ----------------------------------------
    /** Four-shell walking barrage with ground rings 1.5 s ahead of impact. */
    atk_barrage: {
      enter(b) {
        b.memory.shellT = 1.5;
        b.memory.shellCount = 0;
        believedTarget(b, b.memory.impact);
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        Steering.orbit(bb.desired, b.pos, _t, 70, b.arch.move.speed * 0.3, bb.strafeSign);

        const tg = b.manager?.telegraphs;
        b.memory.shellT -= dt;
        // impact points creep toward the player: stand still and you eat all four
        believedTarget(b, _p);
        M.dampVec3(b.memory.impact, _p, 1.4, dt);
        if (tg) {
          const t = 1 - M.clamp(b.memory.shellT / 1.5, 0, 1);
          tg.ring(b.agent.id * 8 + 2, b.memory.impact, 12, 0xff8a2a, t);
          b.muzzlePos('rShoulder', _mz);
          tg.arc(b.agent.id * 8 + 1, _mz, b.memory.impact, 0.7, 0xffb14d);
        }
        if (b.memory.shellT <= 0 && b.memory.shellCount < 4) {
          b.memory.shellCount++;
          b.memory.shellT = 0.55;
          b.muzzlePos('rShoulder', _mz);
          _d.copy(b.memory.impact).sub(_mz);
          const flat = Math.sqrt(_d.x * _d.x + _d.z * _d.z);
          _d.y += flat * 0.7;
          _d.normalize();
          emitShot(b, b.weapons[0].def, 'rShoulder', _d, null);
          bus.emit(EV.SHAKE, { intensity: 0.3, duration: 0.2 });
        }
        if (b.memory.shellCount >= 4 && b.memory.shellT < 0.1) {
          b.memory.recoverFor = 1.5;
          b.setState('recover');
        }
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
    },

    /** Shielded advance with a slow homing volley — pressure without a one-shot. */
    atk_volley: {
      enter(b) {
        b.memory.volleyT = 0.9;
        b.memory.volleyLeft = 10;
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        Steering.seek(bb.desired, b.pos, _t, b.arch.move.speed * 0.8);
        b._avoid(dt, b.arch.move.speed);

        b.memory.volleyT -= dt;
        if (b.memory.volleyT > 0) {
          // pods glow before they open
          if (b.lod === 0 && b.rng() < 0.4) {
            b.muzzlePos('lShoulder', _mz);
            _d.set(0, 1, 0);
            b.manager?.vfx?.muzzleFlash?.(_mz, _d, 0.35, 0xff5fbf);
          }
          return;
        }
        if (b.memory.volleyLeft > 0) {
          b.memory.volleyLeft--;
          b.memory.volleyT = 0.11;
          b.muzzlePos('lShoulder', _mz);
          _d.subVectors(_t, _mz).normalize();
          _d.y += 0.55;
          coneDir(_u, _d.normalize(), 12 * DEG, b.rng);
          emitShot(b, b.weapons[2].def, 'lShoulder', _u, b.player);
        } else {
          b.memory.recoverFor = 1.2;
          b.setState('recover');
        }
      },
    },

    // ---- PHASE 2: shield down, aggressive -------------------------------
    /**
     * Sweeping beam. A thin sight line sweeps for 1.1 s (the tell) along exactly
     * the path the beam will take, then the beam follows it. Boost through it or
     * put a building between you and it.
     */
    atk_beam: {
      enter(b) {
        believedTarget(b, _t);
        _d.subVectors(_t, b.pos);
        b.memory.sweepAngle = Math.atan2(_d.z, _d.x) - 0.85 * (b.rng() < 0.5 ? -1 : 1);
        b.memory.sweepDir = b.memory.sweepAngle < Math.atan2(_d.z, _d.x) ? 1 : -1;
        b.memory.beamT = 0;
        bus.emit(EV.SFX, { id: 'beam_charge', position: b.pos });
      },
      update(b, dt) {
        const bb = b.bb;
        const tg = b.manager?.telegraphs;
        b.memory.beamT += dt;
        const tell = 1.1;
        const sweep = 1.7;
        Steering.orbit(bb.desired, b.pos, bb.lastKnownPos, 55, b.arch.move.speed * 0.2, bb.strafeSign);

        if (b.memory.beamT < tell) {
          // sight line rotating into position
          const t = b.memory.beamT / tell;
          const a = b.memory.sweepAngle + b.memory.sweepDir * t * 0.35;
          _p.set(b.pos.x + Math.cos(a) * 220, b.pos.y + 6, b.pos.z + Math.sin(a) * 220);
          b.aimAtPoint(_p);
          if (tg) {
            b.muzzlePos('rArm', _mz);
            tg.line(b.agent.id * 8 + 4, _mz, _p, 0xff3fa0, 0.02 + t * 0.05, 0.3 + t * 0.7);
          }
          return;
        }

        const st = (b.memory.beamT - tell) / sweep;
        if (st <= 1) {
          const a = b.memory.sweepAngle + b.memory.sweepDir * (0.35 + st * 1.9);
          _p.set(b.pos.x + Math.cos(a) * 220, b.pos.y + 4, b.pos.z + Math.sin(a) * 220);
          b.aimAtPoint(_p);
          if (tg) {
            b.muzzlePos('rArm', _mz);
            tg.line(b.agent.id * 8 + 4, _mz, _p, 0xff3fa0, 0.32, 1);
          }
          // the beam is a dense stream of fast segments so it damages via the
          // normal projectile path instead of a bespoke damage volume
          b.memory.emitT = (b.memory.emitT ?? 0) - dt;
          if (b.memory.emitT <= 0) {
            b.memory.emitT = 0.05;
            b.muzzlePos('rArm', _mz);
            _d.set(Math.cos(a), 0.02, Math.sin(a)).normalize();
            emitShot(b, b.weapons[1].def, 'rArm', _d, null);
          }
          bus.emit(EV.SHAKE, { intensity: 0.12, duration: 0.1 });
        } else {
          b.memory.recoverFor = 1.5;
          b.setState('recover');
        }
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
        b.memory.emitT = 0;
      },
    },

    /** Homing swarm: 16 missiles fanned out over 1.5 s. Shoot them or break LOS. */
    atk_swarm: {
      enter(b) {
        b.memory.volleyT = 0.85;
        b.memory.volleyLeft = 16;
        bus.emit(EV.SFX, { id: 'swarm_open', position: b.pos });
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        Steering.orbit(bb.desired, b.pos, _t, 52, b.arch.move.speed * 0.7, bb.strafeSign);
        b.memory.volleyT -= dt;
        if (b.memory.volleyT > 0) {
          if (b.lod === 0) {
            b.muzzlePos('lShoulder', _mz);
            _d.set(0, 1, 0);
            if (b.rng() < 0.5) b.manager?.vfx?.muzzleFlash?.(_mz, _d, 0.4, 0xff5fbf);
          }
          return;
        }
        if (b.memory.volleyLeft > 0) {
          b.memory.volleyLeft--;
          b.memory.volleyT = 0.085;
          const hp = b.memory.volleyLeft % 2 ? 'lShoulder' : 'rShoulder';
          b.muzzlePos(hp, _mz);
          _d.subVectors(_t, _mz).normalize();
          _d.y += 0.8;
          coneDir(_u, _d.normalize(), 22 * DEG, b.rng);
          emitShot(b, b.weapons[2].def, hp, _u, b.player);
        } else {
          b.memory.recoverFor = 1.3;
          b.setState('recover');
        }
      },
    },

    /** Telegraphed charge along a marked lane, ending in a shockwave. */
    atk_charge: {
      enter(b) {
        believedTarget(b, _t);
        b.memory.dir.subVectors(_t, b.pos).setY(0).normalize();
        b.memory.chargeT = 0;
        bus.emit(EV.SFX, { id: 'boss_charge', position: b.pos });
      },
      update(b, dt) {
        const bb = b.bb;
        b.memory.chargeT += dt;
        const tell = 0.95;
        const tg = b.manager?.telegraphs;
        _p.copy(b.pos).addScaledVector(b.memory.dir, 95);
        _p.y = b.pos.y + 1;
        b.aimAtPoint(_p);
        if (b.memory.chargeT < tell) {
          if (tg) {
            const t = b.memory.chargeT / tell;
            _mz.copy(b.pos);
            _mz.y += 2;
            tg.line(b.agent.id * 8 + 5, _mz, _p, 0xffdd44, 0.12 + t * 0.35, 0.25 + t * 0.75);
          }
          // re-aim slowly during the tell so a moving player can leave the lane
          believedTarget(b, _t);
          _u.subVectors(_t, b.pos).setY(0).normalize();
          M.dampVec3(b.memory.dir, _u, 1.1, dt);
          b.memory.dir.normalize();
          return;
        }
        if (b.memory.chargeT < tell + 1.1) {
          bb.desired.addScaledVector(b.memory.dir, b.arch.move.speed * 4.2);
          b.setBoost(2);
          if (bb.distance < 16 || bb.hitWall) {
            b.manager?.shockwave?.(b.pos, 26);
            b.memory.chargeT = 99;
          }
        } else {
          b.manager?.shockwave?.(b.pos, 22);
          b.memory.recoverFor = 1.6;
          b.setState('recover');
        }
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
    },

    // ---- PHASE 3: desperation -------------------------------------------
    /** Arena-wide expanding nova ring. Ground ring telegraph, then 28 orbs outward. */
    atk_nova: {
      enter(b) {
        b.memory.novaT = 0;
        b.memory.novaFired = 0;
        bus.emit('mission:log', { text: 'WARNING — WIDE-AREA DISCHARGE' });
        bus.emit(EV.SFX, { id: 'nova_charge', position: b.pos });
      },
      update(b, dt) {
        const bb = b.bb;
        b.memory.novaT += dt;
        const tell = 1.15;
        const tg = b.manager?.telegraphs;
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        if (b.memory.novaT < tell) {
          const t = b.memory.novaT / tell;
          if (tg) tg.ring(b.agent.id * 8 + 2, b.pos, 14 + t * 34, 0xff2d6f, t);
          if (b.lod === 0 && b.rng() < 0.5) {
            _p.copy(b.pos);
            _p.y += 8;
            _u.set(0, 1, 0);
            b.manager?.vfx?.muzzleFlash?.(_p, _u, 1.2, 0xff2d6f);
          }
          return;
        }
        if (b.memory.novaFired < 2) {
          const wave = b.memory.novaFired;
          b.memory.novaFired++;
          b.memory.novaT = tell - 0.55; // second wave 0.55 s later
          const n = 26;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU + wave * 0.12;
            _d.set(Math.cos(a), 0.02, Math.sin(a));
            emitShot(b, b.weapons[3].def, 'core', _d, null);
          }
          b.manager?.shockwave?.(b.pos, 30);
          bus.emit(EV.SHAKE, { intensity: 0.8, duration: 0.5 });
        } else {
          b.memory.recoverFor = 1.4;
          b.setState('recover');
        }
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
      },
    },

    /** Twin rotating beam arms — keep moving with the rotation to survive. */
    atk_spiral: {
      enter(b) {
        b.memory.spiralT = 0;
        b.memory.sweepDir = b.rng() < 0.5 ? -1 : 1;
        believedTarget(b, _t);
        b.memory.sweepAngle = Math.atan2(_t.z - b.pos.z, _t.x - b.pos.x);
      },
      update(b, dt) {
        const bb = b.bb;
        b.memory.spiralT += dt;
        const tell = 0.9;
        const dur = 3.2;
        const tg = b.manager?.telegraphs;
        Steering.orbit(bb.desired, b.pos, bb.lastKnownPos, 40, b.arch.move.speed * 0.3, bb.strafeSign);
        if (b.memory.spiralT < tell) {
          const t = b.memory.spiralT / tell;
          for (let k = 0; k < 2; k++) {
            const a = b.memory.sweepAngle + k * Math.PI;
            _p.set(b.pos.x + Math.cos(a) * 180, b.pos.y + 5, b.pos.z + Math.sin(a) * 180);
            if (tg) {
              _mz.copy(b.pos);
              _mz.y += 7;
              tg.line(b.agent.id * 8 + 6 + k, _mz, _p, 0xff3fa0, 0.02 + t * 0.06, 0.3 + t * 0.7);
            }
          }
          b.aimAtPoint(_p);
          return;
        }
        const st = b.memory.spiralT - tell;
        if (st < dur) {
          const rot = b.memory.sweepAngle + b.memory.sweepDir * st * 1.05;
          b.memory.emitT = (b.memory.emitT ?? 0) - dt;
          const fire = b.memory.emitT <= 0;
          if (fire) b.memory.emitT = 0.07;
          for (let k = 0; k < 2; k++) {
            const a = rot + k * Math.PI;
            _p.set(b.pos.x + Math.cos(a) * 180, b.pos.y + 5, b.pos.z + Math.sin(a) * 180);
            if (tg) {
              _mz.copy(b.pos);
              _mz.y += 7;
              tg.line(b.agent.id * 8 + 6 + k, _mz, _p, 0xff3fa0, 0.26, 1);
            }
            if (fire) {
              _d.set(Math.cos(a), 0.02, Math.sin(a)).normalize();
              emitShot(b, b.weapons[1].def, 'core', _d, null);
            }
          }
          b.aimAtPoint(_p);
        } else {
          b.memory.recoverFor = 1.5;
          b.setState('recover');
        }
      },
      exit(b) {
        b.manager?.telegraphs?.releaseOwner?.(b.agent.id);
        b.memory.emitT = 0;
      },
    },

    /** Desperation rush: swarm plus a fast pursuit. Short, loud, survivable. */
    atk_rush: {
      enter(b) {
        b.memory.volleyT = 0.6;
        b.memory.volleyLeft = 10;
      },
      update(b, dt) {
        const bb = b.bb;
        believedTarget(b, _t);
        _t.y += 5;
        b.aimAtPoint(_t);
        Steering.seek(bb.desired, b.pos, _t, b.arch.move.speed * 1.6);
        b._avoid(dt, b.arch.move.speed * 1.6);
        b.setBoost(1.6);
        b.memory.volleyT -= dt;
        if (b.memory.volleyT <= 0 && b.memory.volleyLeft > 0) {
          b.memory.volleyLeft--;
          b.memory.volleyT = 0.14;
          const hp = b.memory.volleyLeft % 2 ? 'lShoulder' : 'rShoulder';
          b.muzzlePos(hp, _mz);
          _d.subVectors(_t, _mz).normalize();
          coneDir(_u, _d, 16 * DEG, b.rng);
          emitShot(b, b.weapons[2].def, hp, _u, b.player);
        }
        if (b.stateTime > 3.4) {
          b.memory.recoverFor = 1.1;
          b.setState('recover');
        }
      },
    },

    staggered: STAGGERED_STATE,
  },

  onStagger(b) {
    bus.emit('mission:log', { text: 'OUROBOROS STAGGERED — MAXIMISE DAMAGE' });
    bus.emit(EV.SHAKE, { intensity: 0.9, duration: 0.6 });
  },
};

// attack tables, declared after BOSS so the state names stay in one place
const BOSS_P1 = [
  { state: 'atk_barrage', weight: 1.0, cooldown: 5.5, minRange: 30 },
  { state: 'atk_volley', weight: 0.85, cooldown: 7.5 },
  { state: 'reposition', weight: 0.3, cooldown: 3 },
];
const BOSS_P2 = [
  { state: 'atk_beam', weight: 1.0, cooldown: 8.5 },
  { state: 'atk_swarm', weight: 0.9, cooldown: 9 },
  { state: 'atk_charge', weight: 0.95, cooldown: 7, minRange: 26 },
  { state: 'atk_barrage', weight: 0.55, cooldown: 9, minRange: 40 },
];
const BOSS_P3 = [
  { state: 'atk_nova', weight: 1.0, cooldown: 9 },
  { state: 'atk_spiral', weight: 1.0, cooldown: 10 },
  { state: 'atk_rush', weight: 0.9, cooldown: 6.5 },
  { state: 'atk_swarm', weight: 0.7, cooldown: 8 },
  { state: 'atk_beam', weight: 0.7, cooldown: 8 },
];

// ---------------------------------------------------------------------------

export const ARCHETYPES = { mt: MT, ac: AC, tank: TANK, flyer: FLYER, sniper: SNIPER, boss: BOSS };

export function getArchetype(id) {
  return ARCHETYPES[id] || ARCHETYPES.mt;
}

export default ARCHETYPES;
