import { bus, EV } from '../core/EventBus.js';
import { clamp } from '../core/MathUtils.js';
import {
  SLOTS, FRAME_SLOTS, INTERNAL_SLOTS, WEAPON_SLOTS, ARM_WEAPON_SLOTS,
  LEG_TYPE_MODS, RARITY, Part, makePart,
} from './PartsDB.js';

/**
 * Loadout — the AC assembly and the build-maths engine behind it.
 *
 * `recompute()` is the whole point of the module. It turns ten parts written in
 * the AC6 stat register into the handful of numbers gameplay code actually needs
 * (metres per second, 0..1 damage reduction, seconds of cooldown), and it applies
 * the three constraints that make assembling an AC a decision rather than a
 * shopping trip:
 *
 *   1. WEIGHT vs LOAD LIMIT      — over: you slow down, far over: you barely move
 *   2. ARM WEAPON WEIGHT vs ARMS LOAD LIMIT — over: recoil control collapses, aim sways
 *   3. EN LOAD vs EN OUTPUT      — over: EN recharge falls off a cliff
 *
 * None of the three inflate with world tier (see BUDGET_STATS in PartsDB), so a
 * tier-12 legendary bazooka is still a genuinely painful thing to fit.
 *
 * ── Modifier application order (authoritative) ─────────────────────────────
 *   1. Sum / select base part stats in the raw AC6 register.
 *   2. Add every `space:'part'` FLAT affix from every equipped part.
 *   3. Multiply by (1 + Σ `space:'part'` PCT affixes)  — percentages stack
 *      additively with each other, then apply once, multiplicatively.
 *   4. Run the derived-stat formulas (register → gameplay units).
 *   5. Apply `space:'derived'` affixes to the results, same flat-then-pct rule.
 *   6. Apply unique-part structural overrides (zero-cooldown QB, etc).
 *   7. Apply the three constraint penalties last, so the garage can show both
 *      the clean number and the penalised one side by side.
 *   8. Collect `space:'special'` affixes and conditional unique effects into
 *      `derived.effects` for combat/movement code to read at runtime.
 */

// --- register → gameplay unit conversion constants ---------------------------
// Tuned for a ~9 m mech, 1 unit = 1 metre, gravity 24 m/s².
const K_BOOST = 2.15;    // thrust / sqrt(weight) → m/s of ground boost
const K_QB = 0.85;       // qbThrust / sqrt(weight) → m/s of dash impulse
const K_UP = 0.72;       // upwardThrust / sqrt(weight) → m/s of vertical boost
const K_TRAVEL = 0.048;  // legs travelSpeed → m/s walking
const K_JUMP = 0.135;    // legs jumpHeight → m/s of jump impulse
const DEF_K = 900;       // raw defence at which reduction reaches 50%

/** Stats summed across every equipped part. */
const SUMMED = ['ap', 'defKinetic', 'defEnergy', 'weight', 'enLoad', 'acsMax'];

/** Which slot owns which single-source stat. */
const OWNED = {
  head: ['systemRecovery', 'scanDistance', 'acsBoost'],
  core: ['boosterEfficiency', 'generatorOutputAdj'],
  arms: ['armsLoadLimit', 'recoilControl', 'firearmSpecialization', 'meleeSpec'],
  legs: ['loadLimit', 'jumpHeight', 'travelSpeed'],
  booster: ['thrust', 'qbThrust', 'qbENConsumption', 'qbReloadTime', 'upwardThrust'],
  generator: ['enCapacity', 'enOutput', 'enRecharge', 'supplyRecovery', 'postRecoveryENSupply'],
};

/** Fallbacks when a slot is empty — an unfinished AC still has to compute. */
const EMPTY_DEFAULTS = {
  boosterEfficiency: 100, generatorOutputAdj: 100,
  recoilControl: 60, firearmSpecialization: 80, meleeSpec: 80,
  armsLoadLimit: 1, loadLimit: 1, enOutput: 1,
  qbReloadTime: 1.2, supplyRecovery: 50, postRecoveryENSupply: 200,
  travelSpeed: 140, jumpHeight: 40,
};

/**
 * The build every pilot starts on: BAWS frame, mid weight, one rifle, one
 * handgun and two missile racks. Deliberately sitting at ~91% load, ~87% arms
 * load and ~+10% EN surplus so the first upgrade the player picks up already
 * forces a real decision.
 */
export const STARTER_BUILD = {
  head: { baseId: 'head_baws_parsons', rarity: 'common' },
  core: { baseId: 'core_baws_orbiter', rarity: 'common' },
  arms: { baseId: 'arms_baws_grit', rarity: 'uncommon', affixIds: ['anchored'] },
  legs: { baseId: 'legs_baws_strider', rarity: 'common' },
  booster: { baseId: 'bst_baws_kickstart', rarity: 'uncommon', affixIds: ['rapid'] },
  generator: { baseId: 'gen_baws_coalsack', rarity: 'common' },
  rArm: { baseId: 'w_baws_scudder', rarity: 'uncommon', affixIds: ['hasty'] },
  lArm: { baseId: 'w_elcano_sidewinder_l', rarity: 'common' },
  rShoulder: { baseId: 'w_baws_sprinkler', rarity: 'common' },
  lShoulder: { baseId: 'w_baws_sprinkler', rarity: 'uncommon', affixIds: ['ammobelt'] },
};

/** A few spare parts in the starting inventory so the garage is never empty. */
const STARTER_INVENTORY = [
  { baseId: 'w_rad_hammerhead', rarity: 'uncommon', affixIds: ['percussive'] },
  { baseId: 'w_dafeng_tiandao', rarity: 'common' },
  { baseId: 'legs_elcano_corrida', rarity: 'uncommon', affixIds: ['tuned'] },
  { baseId: 'gen_elcano_aurora', rarity: 'common' },
];

// ---------------------------------------------------------------------------

function statOf(part, key) {
  const v = part && part.stats ? part.stats[key] : undefined;
  return typeof v === 'number' ? v : undefined;
}

/**
 * Pure build solver. Takes a `{slot: Part|null}` map and returns a fresh derived
 * object. Kept pure so `compare()` can run hypothetical builds without touching
 * the live loadout.
 * @param {Object} slots
 * @returns {Object} derived
 */
export function computeDerived(slots) {
  // ---- 1. base sums / selections -----------------------------------------
  const base = {};
  for (let i = 0; i < SUMMED.length; i++) base[SUMMED[i]] = 0;

  let armsWeightRaw = 0;
  let equippedCount = 0;
  const parts = [];

  for (let i = 0; i < SLOTS.length; i++) {
    const slot = SLOTS[i];
    const p = slots ? slots[slot] : null;
    if (!p) continue;
    parts.push(p);
    equippedCount++;
    for (let s = 0; s < SUMMED.length; s++) {
      const k = SUMMED[s];
      const v = statOf(p, k);
      if (v !== undefined) base[k] += v;
    }
    if (ARM_WEAPON_SLOTS.indexOf(slot) >= 0) armsWeightRaw += statOf(p, 'weight') || 0;
  }

  for (const ownerSlot in OWNED) {
    const keys = OWNED[ownerSlot];
    const p = slots ? slots[ownerSlot] : null;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = statOf(p, k);
      base[k] = v !== undefined ? v : (EMPTY_DEFAULTS[k] ?? 0);
    }
  }
  // Head does not carry acsMax itself (it carries acsBoost), so the summed
  // acsMax is exactly core + legs, which is what we want.

  // ---- 2/3. affix buckets -------------------------------------------------
  const pFlat = {};
  const pPct = {};
  const dFlat = {};
  const dPct = {};
  const effects = {};
  const uniques = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const list = p.affixes;
    if (list) {
      for (let a = 0; a < list.length; a++) {
        const af = list[a];
        if (!af || typeof af.value !== 'number') continue;
        if (af.space === 'special') {
          effects[af.stat] = (effects[af.stat] || 0) + af.value;
        } else if (af.space === 'derived') {
          const t = af.mode === 'pct' ? dPct : dFlat;
          t[af.stat] = (t[af.stat] || 0) + af.value;
        } else {
          const t = af.mode === 'pct' ? pPct : pFlat;
          t[af.stat] = (t[af.stat] || 0) + af.value;
        }
      }
    }
    if (p.uniqueEffect) {
      uniques.push({ part: p.name, slot: p.slot, ...p.uniqueEffect });
      effects[p.uniqueEffect.id] = p.uniqueEffect.value ?? 1;
    }
  }

  /** base + flat, then × (1 + Σpct). */
  const res = (key, override) => {
    const b = override !== undefined ? override : (base[key] || 0);
    return (b + (pFlat[key] || 0)) * (1 + (pPct[key] || 0));
  };
  /** derived-space equivalent. */
  const dres = (key, value) => (value + (dFlat[key] || 0)) * (1 + (dPct[key] || 0));

  // ---- 4. derived formulas ------------------------------------------------
  const legs = slots ? slots.legs : null;
  const legType = legs?.legType || 'biped';
  const legMods = LEG_TYPE_MODS[legType] || LEG_TYPE_MODS.biped;

  const weight = Math.max(0, res('weight'));
  const armsWeight = Math.max(0, armsWeightRaw * (1 + (pPct.weight || 0)));
  const loadLimit = Math.max(1, res('loadLimit') * legMods.loadLimitMul);
  const armsLoadLimit = Math.max(1, res('armsLoadLimit'));

  const apMax = Math.max(1, res('ap'));
  const defKineticRaw = Math.max(0, res('defKinetic'));
  const defEnergyRaw = Math.max(0, res('defEnergy'));

  const acsBoost = res('acsBoost');
  const acsMax = Math.max(1, res('acsMax') * (1 + acsBoost / 100) * legMods.stabilityMul);

  const bEff = clamp(res('boosterEfficiency'), 40, 200) / 100;
  const genAdj = clamp(res('generatorOutputAdj'), 40, 200) / 100;

  const enLoad = Math.max(0, res('enLoad'));
  const enOutput = Math.max(1, res('enOutput') * genAdj);
  const enCapacity = Math.max(1, res('enCapacity'));
  const enRechargeBase = Math.max(0, res('enRecharge'));
  const supplyRecovery = Math.max(1, res('supplyRecovery'));
  const postRecoveryEN = Math.max(0, res('postRecoveryENSupply'));

  const sqrtW = Math.sqrt(Math.max(1, weight));
  const thrustRaw = res('thrust') * bEff;
  const qbThrustRaw = res('qbThrust') * bEff * legMods.qbThrustMul;
  const upwardRaw = res('upwardThrust') * bEff * legMods.upwardMul;

  let boostSpeed = (K_BOOST * thrustRaw / sqrtW) * legMods.boostMul;
  let qbThrust = (K_QB * qbThrustRaw / sqrtW);
  let upwardThrust = (K_UP * upwardRaw / sqrtW);
  let travelSpeed = res('travelSpeed') * K_TRAVEL * legMods.speedMul;
  let jumpImpulse = res('jumpHeight') * K_JUMP * legMods.jumpMul;
  // Booster efficiency below 100 makes every burst more expensive, above cheaper.
  let qbENConsumption = res('qbENConsumption') * (1 + (100 - bEff * 100) / 220);
  let qbReloadTime = res('qbReloadTime') * legMods.qbReloadMul;

  const recoilControlRaw = res('recoilControl');
  const firearmSpec = res('firearmSpecialization');
  const meleeSpec = res('meleeSpec');
  const systemRecovery = res('systemRecovery');
  const scanDistance = res('scanDistance');

  let directHitMod = 1 + (firearmSpec - 90) * 0.0025;
  let impactMod = 1;
  let damageMod = 1;
  let meleeMod = 1 + (meleeSpec - 100) * 0.004;
  let reloadMod = 1;
  let ammoMod = 1;

  // ---- 5. derived-space affixes ------------------------------------------
  boostSpeed = dres('boostSpeed', boostSpeed);
  travelSpeed = dres('travelSpeed', travelSpeed);
  qbThrust = dres('qbThrust', qbThrust);
  upwardThrust = dres('upwardThrust', upwardThrust);
  qbENConsumption = dres('qbENConsumption', qbENConsumption);
  qbReloadTime = dres('qbReloadTime', qbReloadTime);
  directHitMod = dres('directHitMod', directHitMod);
  impactMod = dres('impactMod', impactMod);
  damageMod = dres('damageMod', damageMod);
  reloadMod = dres('reloadMod', reloadMod);
  ammoMod = dres('ammoMod', ammoMod);

  // ---- 6. unique structural overrides ------------------------------------
  // These are the build-defining effects; they intentionally break the curve.
  let qbCostMul = 1;
  let hoverDrainMul = 1;
  if (effects.phantasm_zero_cooldown) { qbReloadTime = 0; qbCostMul *= 2.0; }
  if (effects.kite_skyhold) { hoverDrainMul *= 0.45; boostSpeed *= 0.78; }
  if (effects.nova_precision) directHitMod += 0.30;
  if (effects.scrapheap_bloodtread) effects.dashCostsAP = effects.scrapheap_bloodtread;
  qbENConsumption *= qbCostMul;

  let enRecoveryTime = clamp(3.2 * (70 / supplyRecovery), 0.55, 6.5);
  if (effects.furnace_instant_supply) enRecoveryTime = 0.15;

  // ---- 7. constraints -----------------------------------------------------
  // (1) total weight vs load limit
  const loadRatio = weight / loadLimit;
  const overweightRelief = clamp(effects.overweightRelief || 0, 0, 0.85);
  const loadExcess = Math.max(0, loadRatio - 1) * (1 - overweightRelief);
  const speedPenalty = clamp(1 - loadExcess * 1.25, 0.10, 1);
  const immobile = loadExcess > 0.55;
  const enDrainMod = 1 + loadExcess * 0.9;

  // (2) arm weapon weight vs arms load limit
  const armsRatio = armsWeight / armsLoadLimit;
  const armsRelief = clamp(effects.armsOverloadRelief || 0, 0, 0.9);
  const armsExcess = Math.max(0, armsRatio - 1) * (1 - armsRelief);
  const armsPenalty = clamp(1 - armsExcess * 1.6, 0.20, 1);
  const aimSway = armsExcess * 2.6;          // degrees of reticle drift
  const recoilKick = 1 + armsExcess * 2.2;   // camera punch multiplier

  // (3) EN load vs generator output
  const enSurplus = enOutput - enLoad;
  const surplusRatio = enSurplus / enOutput;
  const enRechargeFactor = surplusRatio >= 0
    ? 1 + Math.min(surplusRatio, 0.6) * 0.55
    : clamp(1 + surplusRatio * 2.6, 0.10, 1);
  const enRecharge = enRechargeBase * enRechargeFactor;

  const overweight = loadRatio > 1;
  const armsOverloaded = armsRatio > 1;
  const enOverloaded = enSurplus < 0;

  // Penalties land last so the garage can show clean vs penalised.
  const boostSpeedFinal = boostSpeed * speedPenalty;
  const travelSpeedFinal = travelSpeed * speedPenalty;
  const qbThrustFinal = qbThrust * speedPenalty;
  const upwardThrustFinal = upwardThrust * speedPenalty;
  const jumpImpulseFinal = jumpImpulse * speedPenalty;
  const recoilControl = recoilControlRaw * armsPenalty;

  // ---- assembly legality --------------------------------------------------
  const missing = [];
  for (let i = 0; i < FRAME_SLOTS.length; i++) if (!slots?.[FRAME_SLOTS[i]]) missing.push(FRAME_SLOTS[i]);
  for (let i = 0; i < INTERNAL_SLOTS.length; i++) if (!slots?.[INTERNAL_SLOTS[i]]) missing.push(INTERNAL_SLOTS[i]);

  const warnings = [];
  if (missing.length) warnings.push(`ASSEMBLY INCOMPLETE: ${missing.join(', ').toUpperCase()}`);
  if (overweight) {
    warnings.push(immobile
      ? `OVERWEIGHT — CRITICAL (${Math.round(loadRatio * 100)}% load): mobility offline`
      : `OVERWEIGHT (${Math.round(loadRatio * 100)}% load): −${Math.round((1 - speedPenalty) * 100)}% mobility`);
  }
  if (armsOverloaded) warnings.push(`ARMS OVERLOADED (${Math.round(armsRatio * 100)}%): recoil control −${Math.round((1 - armsPenalty) * 100)}%, ${aimSway.toFixed(1)}° sway`);
  if (enOverloaded) warnings.push(`EN OUTPUT EXCEEDED (${Math.round(enLoad)} / ${Math.round(enOutput)}): recharge −${Math.round((1 - enRechargeFactor) * 100)}%`);

  // Per-mount weapon multipliers, resolved once so WeaponSystem never has to.
  const weaponMods = {};
  for (let i = 0; i < WEAPON_SLOTS.length; i++) {
    const s = WEAPON_SLOTS[i];
    const p = slots ? slots[s] : null;
    weaponMods[s] = p
      ? {
        weaponId: p.weaponId || null,
        damage: (statOf(p, 'damageMod') ?? 1) * damageMod,
        impact: (statOf(p, 'impactMod') ?? 1) * impactMod,
        ammo: (statOf(p, 'ammoMod') ?? 1) * ammoMod,
        reload: reloadMod,
        rarity: p.rarity,
        color: RARITY[p.rarity]?.color || '#8e989e',
      }
      : null;
  }

  return {
    // --- survivability ---
    apMax: Math.round(apMax),
    defKinetic: defKineticRaw / (defKineticRaw + DEF_K),
    defEnergy: defEnergyRaw / (defEnergyRaw + DEF_K),
    defKineticRaw: Math.round(defKineticRaw),
    defEnergyRaw: Math.round(defEnergyRaw),
    acsMax: Math.round(acsMax),
    systemRecovery,
    staggerRecoveryMod: 1 - clamp(effects.staggerDurationCut || 0, 0, 0.5),

    // --- mass budget ---
    weight: Math.round(weight),
    loadLimit: Math.round(loadLimit),
    loadRatio,
    armsWeight: Math.round(armsWeight),
    armsLoadLimit: Math.round(armsLoadLimit),
    armsRatio,

    // --- energy budget ---
    enCapacity: Math.round(enCapacity),
    enMax: Math.round(enCapacity),          // contract alias
    enOutput: Math.round(enOutput),
    enLoad: Math.round(enLoad),
    enSurplus: Math.round(enSurplus),
    enRecharge,
    enRechargeBase,
    enRechargeFactor,
    enRecoveryTime,
    postRecoveryEN,
    supplyRecovery,
    enDrainMod,
    hoverDrainMul,

    // --- mobility (gameplay units: m/s, seconds) ---
    boostSpeed: boostSpeedFinal,
    travelSpeed: travelSpeedFinal,
    qbThrust: qbThrustFinal,
    upwardThrust: upwardThrustFinal,
    jumpImpulse: jumpImpulseFinal,
    qbENConsumption,
    qbReloadTime,
    // unpenalised counterparts, for garage deltas
    boostSpeedClean: boostSpeed,
    travelSpeedClean: travelSpeed,
    qbThrustClean: qbThrust,

    // --- gunnery ---
    recoilControl,
    recoilControlClean: recoilControlRaw,
    firearmSpecialization: firearmSpec,
    meleeSpec,
    scanDistance,
    directHitMod,
    impactMod,
    damageMod,
    meleeMod,
    reloadMod,
    ammoMod,
    aimSway,
    recoilKick,
    weaponMods,

    // --- leg family ---
    legType,
    legMods,
    canQuickBoost: legMods.canQuickBoost && !immobile,
    groundDash: legMods.groundDash,
    hoverFire: legMods.hoverFire,

    // --- constraints ---
    overweight,
    armsOverloaded,
    enOverloaded,
    immobile,
    speedPenalty,
    loadPenalty: speedPenalty,   // alias: movement code multiplies this in
    armsPenalty,
    legal: !overweight && !armsOverloaded && !enOverloaded && missing.length === 0,
    missing,
    warnings,

    // --- runtime effect payload ---
    effects,
    uniques,
    equippedCount,
  };
}

/** Stats surfaced by `compare()`, in garage display order. */
export const COMPARE_STATS = [
  { key: 'apMax', label: 'AP', better: 1, dp: 0 },
  { key: 'defKineticRaw', label: 'KINETIC DEF', better: 1, dp: 0 },
  { key: 'defEnergyRaw', label: 'ENERGY DEF', better: 1, dp: 0 },
  { key: 'acsMax', label: 'ATTITUDE STABILITY', better: 1, dp: 0 },
  { key: 'weight', label: 'WEIGHT', better: -1, dp: 0 },
  { key: 'loadLimit', label: 'LOAD LIMIT', better: 1, dp: 0 },
  { key: 'armsWeight', label: 'ARM UNIT WEIGHT', better: -1, dp: 0 },
  { key: 'armsLoadLimit', label: 'ARMS LOAD LIMIT', better: 1, dp: 0 },
  { key: 'enLoad', label: 'EN LOAD', better: -1, dp: 0 },
  { key: 'enOutput', label: 'EN OUTPUT', better: 1, dp: 0 },
  { key: 'enSurplus', label: 'EN SURPLUS', better: 1, dp: 0 },
  { key: 'enCapacity', label: 'EN CAPACITY', better: 1, dp: 0 },
  { key: 'enRecharge', label: 'EN RECHARGE', better: 1, dp: 0 },
  { key: 'boostSpeed', label: 'BOOST SPEED', better: 1, dp: 1, unit: 'm/s' },
  { key: 'travelSpeed', label: 'TRAVEL SPEED', better: 1, dp: 1, unit: 'm/s' },
  { key: 'qbThrust', label: 'QB THRUST', better: 1, dp: 1, unit: 'm/s' },
  { key: 'qbENConsumption', label: 'QB EN COST', better: -1, dp: 0 },
  { key: 'qbReloadTime', label: 'QB RELOAD', better: -1, dp: 2, unit: 's' },
  { key: 'upwardThrust', label: 'UPWARD THRUST', better: 1, dp: 1, unit: 'm/s' },
  { key: 'recoilControl', label: 'RECOIL CONTROL', better: 1, dp: 0 },
  { key: 'directHitMod', label: 'DIRECT HIT', better: 1, dp: 3 },
  { key: 'impactMod', label: 'IMPACT', better: 1, dp: 3 },
];

export class Loadout {
  constructor(opts = {}) {
    /** @type {Object<string, Part|null>} */
    this.slots = {};
    for (let i = 0; i < SLOTS.length; i++) this.slots[SLOTS[i]] = null;

    /** @type {Part[]} */
    this.inventory = [];

    /** Progression counters — Persistence saves these alongside the build. */
    this.progress = { tier: 1, salvage: 0, kills: 0, drops: 0, missions: 0 };

    this.derived = computeDerived(this.slots);
    this._silent = false;

    if (opts.empty !== true) this.loadStarter();
  }

  /** Fill every slot with the deterministic starter AC. */
  loadStarter() {
    this._silent = true;
    for (const slot in STARTER_BUILD) {
      const spec = STARTER_BUILD[slot];
      const p = makePart(spec.baseId, { rarity: spec.rarity, tier: 1, affixIds: spec.affixIds || [] });
      if (p) {
        p.slot = slot;
        this.slots[slot] = p;
      }
    }
    this.inventory.length = 0;
    for (let i = 0; i < STARTER_INVENTORY.length; i++) {
      const spec = STARTER_INVENTORY[i];
      const p = makePart(spec.baseId, { rarity: spec.rarity, tier: 1, affixIds: spec.affixIds || [] });
      if (p) this.inventory.push(p);
    }
    this._silent = false;
    this.recompute();
    return this;
  }

  /**
   * Equip a part. Accepts a part that is in the inventory or a loose one.
   * The previously equipped part goes back to the inventory.
   * @param {Part} part
   * @param {string} [slot] override mount (weapons fit several)
   * @returns {boolean} whether anything changed
   */
  equip(part, slot) {
    if (!part) return false;
    const target = slot || part.slot;
    if (SLOTS.indexOf(target) < 0) return false;
    if (part.fits && !part.fits(target)) return false;
    if (this.slots[target] === part) return false;

    const idx = this.inventory.indexOf(part);
    if (idx >= 0) this.inventory.splice(idx, 1);

    const prev = this.slots[target];
    if (prev) this.inventory.push(prev);

    part.slot = target;
    this.slots[target] = part;

    this.recompute();
    bus.emit(EV.PART_EQUIPPED, { part, slot: target, previous: prev || null, loadout: this });
    return true;
  }

  /**
   * Remove whatever is in `slot` and return it to the inventory.
   * @param {string} slot
   * @returns {Part|null} the removed part
   */
  unequip(slot) {
    const p = this.slots?.[slot];
    if (!p) return null;
    this.slots[slot] = null;
    this.inventory.push(p);
    this.recompute();
    bus.emit(EV.PART_EQUIPPED, { part: null, slot, previous: p, loadout: this });
    return p;
  }

  /** Push a rolled part into the inventory (LootSystem calls this on pickup). */
  addToInventory(part) {
    if (!part) return false;
    if (this.inventory.indexOf(part) >= 0) return false;
    this.inventory.push(part);
    this.progress.drops++;
    return true;
  }

  /** Permanently destroy a part for salvage credit. */
  scrap(part) {
    const idx = this.inventory.indexOf(part);
    if (idx < 0) return 0;
    this.inventory.splice(idx, 1);
    const value = Math.round(40 * (1 + (RARITY[part.rarity]?.index ?? 0) * 1.8) * (part.tier || 1));
    this.progress.salvage += value;
    return value;
  }

  /** Parts in the inventory that can go in `slot`, best-first. */
  candidatesFor(slot) {
    const out = [];
    for (let i = 0; i < this.inventory.length; i++) {
      const p = this.inventory[i];
      if (p.fits ? p.fits(slot) : p.slot === slot) out.push(p);
    }
    out.sort((a, b) => {
      const d = (RARITY[b.rarity]?.index ?? 0) - (RARITY[a.rarity]?.index ?? 0);
      return d !== 0 ? d : (b.tier || 0) - (a.tier || 0);
    });
    return out;
  }

  /**
   * Recompute every derived stat and broadcast the new build.
   * Cheap enough to call on every equip; never called per frame.
   */
  recompute() {
    this.derived = computeDerived(this.slots);
    if (!this._silent) bus.emit(EV.BUILD_CHANGED, { derived: this.derived, slots: this.slots });
    return this.derived;
  }

  /**
   * Per-stat delta between two candidate parts in the same mount.
   * Runs two full hypothetical builds, so the answer accounts for constraints —
   * a lighter gun that pulls you back under the load limit shows the real
   * mobility swing, not just its own weight line.
   *
   * @param {Part|null} partA baseline (defaults to whatever is equipped)
   * @param {Part|null} partB candidate
   * @returns {{slot:string, stats:Array, summary:{better:number,worse:number}, a:Object, b:Object}}
   */
  compare(partA, partB) {
    // compare(candidate) → against whatever occupies its mount
    if (arguments.length === 1) {
      partB = partA;
      partA = partB ? this.slots[partB.slot] || null : null;
    }
    const slot = partB?.slot || partA?.slot;
    if (!slot) return { slot: null, stats: [], summary: { better: 0, worse: 0 }, a: this.derived, b: this.derived };

    const hypo = {};
    for (let i = 0; i < SLOTS.length; i++) hypo[SLOTS[i]] = this.slots[SLOTS[i]];

    hypo[slot] = partA;
    const a = computeDerived(hypo);
    hypo[slot] = partB;
    const b = computeDerived(hypo);

    const stats = [];
    let better = 0;
    let worse = 0;
    for (let i = 0; i < COMPARE_STATS.length; i++) {
      const def = COMPARE_STATS[i];
      const av = a[def.key] ?? 0;
      const bv = b[def.key] ?? 0;
      const delta = bv - av;
      if (Math.abs(delta) < 1e-6) continue;
      const dir = Math.sign(delta) * def.better;
      if (dir > 0) better++; else if (dir < 0) worse++;
      stats.push({
        key: def.key, label: def.label, unit: def.unit || '', dp: def.dp,
        a: av, b: bv, delta,
        pct: av !== 0 ? delta / Math.abs(av) : 0,
        improvement: dir,
      });
    }

    return {
      slot, stats, a, b,
      summary: {
        better, worse,
        legalA: a.legal, legalB: b.legal,
        breaksBuild: a.legal && !b.legal,
        fixesBuild: !a.legal && b.legal,
      },
    };
  }

  /** Snapshot for saving. */
  toJSON() {
    const slots = {};
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i];
      slots[s] = this.slots[s] ? this.slots[s].toJSON() : null;
    }
    return {
      slots,
      inventory: this.inventory.map((p) => p.toJSON()),
      progress: { ...this.progress },
    };
  }

  /** Restore from a `toJSON()` snapshot. Unknown parts are dropped, never thrown on. */
  fromJSON(data) {
    if (!data) return false;
    this._silent = true;
    try {
      for (let i = 0; i < SLOTS.length; i++) {
        const s = SLOTS[i];
        const raw = data.slots ? data.slots[s] : null;
        this.slots[s] = raw ? Part.fromJSON(raw) : null;
      }
      this.inventory.length = 0;
      const inv = Array.isArray(data.inventory) ? data.inventory : [];
      for (let i = 0; i < inv.length; i++) {
        const p = Part.fromJSON(inv[i]);
        if (p) this.inventory.push(p);
      }
      if (data.progress) Object.assign(this.progress, data.progress);
    } finally {
      this._silent = false;
    }
    this.recompute();
    return true;
  }

  dispose() {
    this.inventory.length = 0;
    for (let i = 0; i < SLOTS.length; i++) this.slots[SLOTS[i]] = null;
  }
}

export default Loadout;
