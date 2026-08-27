import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp } from '../core/MathUtils.js';

/**
 * ACNTR damage model — a faithful reconstruction of the Armored Core VI two-track
 * combat economy.
 *
 * Track 1: AP (armour points). The health bar. Reduced by `defKinetic` / `defEnergy`.
 * Track 2: ACS (impact / stagger gauge). Every hit adds `impact`. The gauge bleeds off
 *          after a short grace window, so sustained pressure is what fills it. When it
 *          tops out the target STAGGERS: stunned, unable to act, and every hit landed
 *          during that window gets the DIRECT HIT multiplier.
 *
 * The loop this creates is the whole point of the game: break the target with impact
 * weapons (shotgun / bazooka / cannon), then dump burst damage into the stagger window.
 */

export const COMBAT = {
  /** Direct-hit bonus applied to AP damage while the victim is staggered. */
  DIRECT_HIT_MUL: 1.6,
  /** Impact also lands harder on a staggered target (keeps them pinned). */
  DIRECT_IMPACT_MUL: 0.85,
  /** How long a stagger lasts, in seconds. */
  STAGGER_DURATION: 2.2,
  /** Seconds of "no hits" before the ACS gauge starts draining. */
  ACS_GRACE: 0.6,
  /** Drain rate the instant the grace window expires (fraction of acsMax per second). */
  ACS_DECAY_MIN: 0.34,
  /** Drain rate once the target has been left alone for ACS_DECAY_RAMP seconds. */
  ACS_DECAY_MAX: 1.05,
  ACS_DECAY_RAMP: 1.25,
  /** Post-stagger recovery: cannot be re-staggered, impact only partially registers. */
  RECOVERY_TIME: 1.0,
  RECOVERY_IMPACT_MUL: 0.3,
  /** Hard cap on defence so nothing becomes immune. */
  DEF_CAP: 0.85,
  /** Defence resists impact at half strength — armour slows the break, never stops it. */
  IMPACT_DEF_SCALE: 0.5,
  /** Entity heat bleed-off per second (fraction). */
  HEAT_DECAY: 0.55,
  /** Fallback when an entity ships without a configured stagger gauge. */
  DEFAULT_ACS_MAX: 1800,
  /** Pulse weapons shred energy shields. */
  PULSE_SHIELD_MUL: 3.0,
  /** Feedback on the stagger frame. */
  STAGGER_HITSTOP: 0.14,
  STAGGER_SHAKE: 1.15,
};

// module-scope scratch — zero per-frame allocation
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * A single live DamageSystem is discoverable module-side so that ProjectileManager can
 * route hits without Game having to wire them together (see CONTRACT amendment).
 */
let _active = null;
/** @returns {DamageSystem|null} the most recently constructed DamageSystem. */
export function getDamageSystem() {
  return _active;
}

/** Per-entity bookkeeping the Stats contract does not own. Allocated once per entity. */
class Record {
  constructor(entity) {
    this.entity = entity;
    this.sinceHit = 99;
    this.recovery = 0;
    this.staggerCount = 0;
    this.staggerDuration = COMBAT.STAGGER_DURATION;
    this.deadFor = 0;
    this.dpsAccum = 0;
    this.lastAttacker = null;
  }
}

export class DamageSystem {
  constructor() {
    /** @type {Entity[]} every entity currently tracked for ACS decay + stagger timers. */
    this.entities = [];
    this._rec = new Map();
    /** Global multipliers a difficulty/mission layer can poke. */
    this.playerDamageTaken = 1.0;
    this.enemyDamageTaken = 1.0;
    /** Rolling stats the HUD / debug overlay can read. */
    this.totalDamageDealt = 0;
    this.totalStaggers = 0;
    this._disposed = false;
    _active = this;
  }

  // ---------------------------------------------------------------- registry

  /** Track an entity so its ACS gauge decays and its stagger timer ticks. */
  register(entity) {
    if (!entity || this._rec.has(entity)) return;
    this._rec.set(entity, new Record(entity));
    this.entities.push(entity);
    // normalise the stagger fields so HUD reads never see undefined
    const s = entity.stats;
    if (s) {
      if (typeof s.acs !== 'number' || !isFinite(s.acs)) s.acs = 0;
      if (typeof s.acsMax !== 'number' || !(s.acsMax > 0)) s.acsMax = COMBAT.DEFAULT_ACS_MAX;
      if (typeof s.staggered !== 'boolean') s.staggered = false;
      if (typeof s.staggerTimer !== 'number') s.staggerTimer = 0;
    }
  }

  unregister(entity) {
    if (!entity) return;
    if (this._rec.delete(entity)) {
      const i = this.entities.indexOf(entity);
      if (i >= 0) this.entities.splice(i, 1);
    }
  }

  /** @returns {Record} lazily creating tracking state for entities damaged before registration. */
  _record(entity) {
    let r = this._rec.get(entity);
    if (!r) {
      this.register(entity);
      r = this._rec.get(entity);
    }
    return r;
  }

  // ---------------------------------------------------------------- queries

  /** 0..1 stagger gauge fill, for the HUD. */
  acsRatio(entity) {
    const s = entity?.stats;
    if (!s) return 0;
    const max = s.acsMax > 0 ? s.acsMax : COMBAT.DEFAULT_ACS_MAX;
    return clamp(s.acs / max, 0, 1);
  }

  /** True while the entity eats direct-hit damage. */
  isStaggered(entity) {
    return !!entity?.stats?.staggered;
  }

  // ---------------------------------------------------------------- resolve

  /**
   * Resolve one hit against an entity.
   * @param {Entity} entity victim
   * @param {DamageInfo} info hit description (see CONTRACT.md)
   * @returns {number} AP actually removed
   */
  applyDamage(entity, info) {
    if (this._disposed || !entity || !info) return 0;
    const s = entity.stats;
    if (!s || entity.alive === false) return 0;

    const rec = this._record(entity);
    rec.sinceHit = 0;
    if (info.source) rec.lastAttacker = info.source;

    const acsMax = s.acsMax > 0 ? s.acsMax : COMBAT.DEFAULT_ACS_MAX;
    const wasStaggered = !!s.staggered;

    // ---- defence ---------------------------------------------------------
    const type = info.type || 'kinetic';
    let def;
    if (type === 'energy') def = s.defEnergy;
    else if (type === 'explosive') def = ((s.defKinetic || 0) + (s.defEnergy || 0)) * 0.5;
    else def = s.defKinetic;
    def = clamp(typeof def === 'number' ? def : 0, 0, COMBAT.DEF_CAP);
    const apMul = 1 - def;
    const impactMul = 1 - def * COMBAT.IMPACT_DEF_SCALE;

    let amount = Math.max(0, info.amount || 0) * apMul;
    let impact = Math.max(0, info.impact || 0) * impactMul;

    amount *= entity.isPlayer ? this.playerDamageTaken : this.enemyDamageTaken;

    // ---- deployable shield absorbs first ---------------------------------
    const sh = entity.shield;
    if (sh && sh.active && sh.hp > 0 && (amount > 0 || impact > 0)) {
      const blocked = this._shieldBlocks(entity, sh, info);
      if (blocked) {
        const drain = amount * (info.pulse ? COMBAT.PULSE_SHIELD_MUL : 1);
        sh.hp -= drain;
        bus.emit(EV.IMPACT, { point: info.point, normal: info.normal, type: 'shield' });
        bus.emit('combat:shieldHit', { entity, shield: sh, amount: drain, point: info.point });
        if (sh.hp <= 0) {
          sh.hp = 0;
          sh.active = false;
          sh.broken = true;
          bus.emit('combat:shieldBroken', { entity, point: info.point });
        }
        // a shielded hit still nudges the gauge slightly — it is not a free block
        s.acs = clamp(s.acs + impact * 0.15, 0, acsMax);
        return 0;
      }
    }

    // ---- direct-hit bonus -------------------------------------------------
    const direct = !!info.direct || wasStaggered;
    if (direct) {
      amount *= COMBAT.DIRECT_HIT_MUL;
      impact *= COMBAT.DIRECT_IMPACT_MUL;
    }
    info.direct = direct;

    // ---- ACS accumulation -------------------------------------------------
    if (impact > 0 && !wasStaggered) {
      if (rec.recovery > 0) impact *= COMBAT.RECOVERY_IMPACT_MUL;
      s.acs = clamp(s.acs + impact, 0, acsMax);
    } else if (impact > 0 && wasStaggered) {
      // hits during stagger extend the pin slightly, capped so it cannot loop forever
      s.staggerTimer = Math.min(rec.staggerDuration, s.staggerTimer + impact / acsMax * 0.35);
    }

    // ---- AP depletion -----------------------------------------------------
    const before = s.ap;
    s.ap = Math.max(0, s.ap - amount);
    const dealt = before - s.ap;
    this.totalDamageDealt += dealt;

    if (typeof s.heat === 'number' && type === 'energy') s.heat = clamp(s.heat + amount / (s.apMax || 10000), 0, 2);

    // ---- feedback ---------------------------------------------------------
    if (entity.onDamage) entity.onDamage(info);
    bus.emit(EV.DAMAGE_DEALT, {
      entity,
      amount: dealt,
      direct,
      point: info.point,
      isPlayer: !!entity.isPlayer,
      type,
      impact,
      source: info.source || null,
    });
    if (entity.isPlayer) {
      bus.emit(EV.PLAYER_HIT, { amount: dealt, direct, point: info.point, source: info.source || null });
    }

    // ---- stagger trigger --------------------------------------------------
    if (!wasStaggered && rec.recovery <= 0 && s.acs >= acsMax - 1e-4 && s.ap > 0) {
      this._triggerStagger(entity, rec, info);
    }

    // ---- death ------------------------------------------------------------
    if (s.ap <= 0 && entity.alive !== false) {
      this._kill(entity, info.source || rec.lastAttacker || null, info);
    }

    return dealt;
  }

  /**
   * Add raw impact with no AP damage — used by shockwaves, melee shoves and by AI
   * abilities that only want to pressure the stagger gauge.
   */
  applyImpact(entity, impact, source = null) {
    const s = entity?.stats;
    if (!s || entity.alive === false || !(impact > 0)) return;
    const rec = this._record(entity);
    rec.sinceHit = 0;
    const acsMax = s.acsMax > 0 ? s.acsMax : COMBAT.DEFAULT_ACS_MAX;
    if (s.staggered) return;
    s.acs = clamp(s.acs + impact * (rec.recovery > 0 ? COMBAT.RECOVERY_IMPACT_MUL : 1), 0, acsMax);
    if (s.acs >= acsMax - 1e-4) this._triggerStagger(entity, rec, null);
  }

  /** Heal AP (repair kits, mission rewards). */
  heal(entity, amount) {
    const s = entity?.stats;
    if (!s || !(amount > 0)) return 0;
    const before = s.ap;
    s.ap = Math.min(s.apMax || s.ap, s.ap + amount);
    return s.ap - before;
  }

  _shieldBlocks(entity, sh, info) {
    if (!sh.dir || !info.point) return true;
    // block only inside the shield arc, measured from the entity toward the hit
    const c = entity.collider?.center || entity.root?.position;
    if (!c) return true;
    _v.subVectors(info.point, c);
    _v.y *= 0.35; // arc is mostly horizontal
    if (_v.lengthSq() < 1e-6) return true;
    _v.normalize();
    _v2.copy(sh.dir).normalize();
    const cosLimit = typeof sh.arcCos === 'number' ? sh.arcCos : Math.cos(Math.PI * 0.55);
    return _v.dot(_v2) >= cosLimit;
  }

  _triggerStagger(entity, rec, info) {
    const s = entity.stats;
    const acsMax = s.acsMax > 0 ? s.acsMax : COMBAT.DEFAULT_ACS_MAX;
    rec.staggerDuration = typeof s.staggerDuration === 'number' && s.staggerDuration > 0
      ? s.staggerDuration
      : COMBAT.STAGGER_DURATION;
    rec.staggerCount++;
    this.totalStaggers++;

    s.staggered = true;
    s.staggerTimer = rec.staggerDuration;
    s.acs = acsMax; // gauge stays pinned full and drains as the stagger runs out

    if (entity.onStagger) entity.onStagger();

    const point = info?.point || entity.collider?.center || entity.root?.position || null;
    bus.emit(EV.STAGGER, {
      entity,
      point,
      isPlayer: !!entity.isPlayer,
      duration: rec.staggerDuration,
      source: info?.source || null,
    });
    // a stagger is a dramatic moment: freeze frame, shake, klaxon
    bus.emit(EV.HITSTOP, { duration: COMBAT.STAGGER_HITSTOP });
    bus.emit(EV.SHAKE, { intensity: COMBAT.STAGGER_SHAKE, duration: 0.55 });
    bus.emit(EV.SFX, { id: 'stagger', position: point, isPlayer: !!entity.isPlayer });
  }

  _kill(entity, killer, info) {
    entity.alive = false;
    const s = entity.stats;
    if (s) {
      s.ap = 0;
      s.staggered = false;
      s.staggerTimer = 0;
    }
    if (entity.onDeath) entity.onDeath();
    bus.emit(EV.ENTITY_KILLED, {
      entity,
      killer: killer || null,
      point: info?.point || entity.root?.position || null,
      isPlayer: !!entity.isPlayer,
    });
    const r = this._rec.get(entity);
    if (r) r.deadFor = 0;
  }

  // ---------------------------------------------------------------- update

  /**
   * Per-frame: ACS bleed-off, stagger countdown, post-stagger recovery, heat decay.
   * @param {number} dt seconds
   */
  update(dt) {
    if (this._disposed || dt <= 0) return;
    const list = this.entities;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const rec = this._rec.get(e);
      if (!rec) {
        list.splice(i, 1);
        continue;
      }
      const s = e.stats;
      if (!s) continue;

      if (e.alive === false) {
        // keep corpses around briefly so late projectiles resolve, then drop them
        rec.deadFor += dt;
        if (rec.deadFor > 6 && !e.isPlayer) {
          this._rec.delete(e);
          list.splice(i, 1);
        }
        continue;
      }
      rec.deadFor = 0;

      const acsMax = s.acsMax > 0 ? s.acsMax : COMBAT.DEFAULT_ACS_MAX;

      if (s.staggered) {
        s.staggerTimer -= dt;
        // gauge visibly drains across the stagger — the HUD reads this directly
        s.acs = acsMax * clamp(s.staggerTimer / (rec.staggerDuration || COMBAT.STAGGER_DURATION), 0, 1);
        if (s.staggerTimer <= 0) {
          s.staggered = false;
          s.staggerTimer = 0;
          s.acs = 0;
          rec.recovery = COMBAT.RECOVERY_TIME;
          rec.sinceHit = 0;
          bus.emit('combat:staggerEnd', { entity: e, isPlayer: !!e.isPlayer });
        }
      } else {
        if (rec.recovery > 0) rec.recovery -= dt;
        rec.sinceHit += dt;
        if (s.acs > 0 && rec.sinceHit > COMBAT.ACS_GRACE) {
          const ramp = clamp((rec.sinceHit - COMBAT.ACS_GRACE) / COMBAT.ACS_DECAY_RAMP, 0, 1);
          const rate = acsMax * (COMBAT.ACS_DECAY_MIN + (COMBAT.ACS_DECAY_MAX - COMBAT.ACS_DECAY_MIN) * ramp);
          s.acs = Math.max(0, s.acs - rate * dt);
        }
      }

      if (typeof s.heat === 'number' && s.heat > 0) {
        s.heat = Math.max(0, s.heat - COMBAT.HEAT_DECAY * dt);
      }

      // deployable shield lifetime
      const sh = e.shield;
      if (sh && sh.active) {
        sh.timer -= dt;
        if (sh.timer <= 0) {
          sh.active = false;
          bus.emit('combat:shieldExpired', { entity: e });
        }
      }
    }
  }

  /** Clear all gauges (mission restart). */
  reset() {
    for (const e of this.entities) {
      const s = e?.stats;
      if (!s) continue;
      s.acs = 0;
      s.staggered = false;
      s.staggerTimer = 0;
    }
    for (const r of this._rec.values()) {
      r.sinceHit = 99;
      r.recovery = 0;
      r.deadFor = 0;
      r.lastAttacker = null;
    }
    this.totalDamageDealt = 0;
    this.totalStaggers = 0;
  }

  dispose() {
    this._disposed = true;
    this.entities.length = 0;
    this._rec.clear();
    if (_active === this) _active = null;
  }
}

export default DamageSystem;
