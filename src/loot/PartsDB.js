import { clamp, lerp, mulberry32 } from '../core/MathUtils.js';

/**
 * PartsDB — the AC assembly catalogue plus the Diablo layer on top of it.
 *
 * Design intent
 * -------------
 * AC6 has ten assembly slots and no randomisation. Diablo has randomisation and
 * no assembly. ACNTR fuses them: every base part below is a hand-authored AC6-style
 * chassis with a real stat profile, and `rollPart()` then rolls a rarity, a stat
 * multiplier and a set of affixes on top of it. The base defines the *shape* of a
 * build (light/heavy/energy/kinetic/specialist), the roll defines how good this
 * particular instance of it is.
 *
 * Number register
 * ---------------
 * Stats are stored in the AC6 register (weights in the tens of thousands, thrust
 * in the thousands, defence as raw resistance points). They are NOT directly
 * usable by gameplay code — `Loadout.recompute()` owns the conversion into
 * metres-per-second, 0..1 damage reductions and so on. Keeping the raw register
 * here is what lets the constraint model (load limit / arms load / EN output)
 * bind the way it does in AC6.
 *
 * Stat keys by slot
 * -----------------
 *  every frame part : ap, defKinetic, defEnergy, weight, enLoad
 *  head             : systemRecovery, scanDistance, acsBoost
 *  core             : boosterEfficiency, acsMax, generatorOutputAdj
 *  arms             : armsLoadLimit, recoilControl, firearmSpecialization, meleeSpec
 *  legs             : loadLimit, jumpHeight, travelSpeed, acsMax   (+ legType)
 *  booster          : thrust, qbThrust, qbENConsumption, qbReloadTime, upwardThrust
 *  generator        : enCapacity, enOutput, enRecharge, supplyRecovery, postRecoveryENSupply
 *  weapon           : damageMod, impactMod, ammoMod  (+ weaponId)
 */

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export const SLOTS = [
  'head', 'core', 'arms', 'legs',
  'booster', 'generator',
  'rArm', 'lArm', 'rShoulder', 'lShoulder',
];

export const FRAME_SLOTS = ['head', 'core', 'arms', 'legs'];
export const INTERNAL_SLOTS = ['booster', 'generator'];
export const WEAPON_SLOTS = ['rArm', 'lArm', 'rShoulder', 'lShoulder'];
export const ARM_WEAPON_SLOTS = ['rArm', 'lArm'];

/** Human labels for the garage. */
export const SLOT_LABELS = {
  head: 'HEAD', core: 'CORE', arms: 'ARMS', legs: 'LEGS',
  booster: 'BOOSTER', generator: 'GENERATOR',
  rArm: 'R ARM UNIT', lArm: 'L ARM UNIT',
  rShoulder: 'R BACK UNIT', lShoulder: 'L BACK UNIT',
};

export const LEG_TYPES = ['biped', 'reverse', 'tetrapod', 'tank'];

/**
 * Leg-type behaviour modifiers. `Loadout.recompute()` copies the matching entry
 * into `derived.legMods` so PlayerController can multiply movement by it without
 * needing to know part ids. This is the thing that makes the four leg families
 * actually play differently rather than just weighing different amounts.
 */
export const LEG_TYPE_MODS = {
  biped: {
    label: 'BIPEDAL',
    loadLimitMul: 1.0, speedMul: 1.0, boostMul: 1.0, jumpMul: 1.0,
    stabilityMul: 1.0, upwardMul: 1.0, qbReloadMul: 1.0, qbThrustMul: 1.0,
    airDrag: 1.0, canQuickBoost: true, quickBoostCount: 1,
    hoverFire: false, groundDash: false, landingRecovery: 1.0,
    note: 'All-round. Full quick boost, clean air control.',
  },
  reverse: {
    label: 'REVERSE-JOINT',
    loadLimitMul: 0.92, speedMul: 1.06, boostMul: 1.04, jumpMul: 1.0,
    stabilityMul: 0.78, upwardMul: 1.28, qbReloadMul: 0.9, qbThrustMul: 1.05,
    airDrag: 0.86, canQuickBoost: true, quickBoostCount: 1,
    hoverFire: false, groundDash: false, landingRecovery: 0.7,
    note: 'Enormous jump and vertical burst. Staggers early — stability is poor.',
  },
  tetrapod: {
    label: 'TETRAPOD',
    loadLimitMul: 1.24, speedMul: 0.86, boostMul: 0.9, jumpMul: 0.8,
    stabilityMul: 1.14, upwardMul: 1.28, qbReloadMul: 1.08, qbThrustMul: 0.92,
    airDrag: 0.55, canQuickBoost: true, quickBoostCount: 1,
    hoverFire: true, groundDash: false, landingRecovery: 1.1,
    note: 'Hovers and fires without recoil drift. Slow on the ground, heavy load.',
  },
  tank: {
    label: 'TANK',
    loadLimitMul: 1.62, speedMul: 0.74, boostMul: 1.18, jumpMul: 0.8,
    stabilityMul: 1.5, upwardMul: 0.7, qbReloadMul: 1.0, qbThrustMul: 0.0,
    airDrag: 1.35, canQuickBoost: false, quickBoostCount: 0,
    hoverFire: false, groundDash: true, landingRecovery: 1.5,
    note: 'No quick boost — a sustained ground dash instead. Immense load and stability.',
  },
};

// ---------------------------------------------------------------------------
// Rarity
// ---------------------------------------------------------------------------

/**
 * Rarity ladder. Colours are AC6 HUD colours (steel / coolant / scan-cyan /
 * ALLMIND violet / warning amber / critical red) rather than the MMO palette.
 *
 * `roll` is the multiplier band applied to *beneficial* stats; the inverse band
 * is applied to weight and EN load, so a good roll is lighter as well as stronger.
 * `present` drives the world-drop presentation in LootSystem — rarity has to be
 * legible from across the arena, not just a tint in a menu.
 */
export const RARITY = {
  common: {
    id: 'common', index: 0, label: 'SALVAGE',
    color: '#8e989e', glow: '#c3ccd2', weight: 1000,
    affixes: [0, 0], roll: [0.90, 1.00], statBudget: 1.0,
    present: { scale: 0.82, emissive: 1.4, beamH: 4.5, beamR: 0.30, beamOp: 0.14, ring: 1.5, shards: 0, spin: 0.55, bob: 0.16, light: 0, pulse: 0.8 },
  },
  uncommon: {
    id: 'uncommon', index: 1, label: 'SERVICEABLE',
    color: '#5ad1a8', glow: '#9dfad9', weight: 420,
    affixes: [1, 1], roll: [0.97, 1.06], statBudget: 1.03,
    present: { scale: 0.9, emissive: 2.2, beamH: 6.0, beamR: 0.36, beamOp: 0.2, ring: 1.9, shards: 0, spin: 0.7, bob: 0.2, light: 0, pulse: 1.0 },
  },
  rare: {
    id: 'rare', index: 2, label: 'TUNED',
    color: '#54e8ff', glow: '#c8f7ff', weight: 150,
    affixes: [2, 2], roll: [1.03, 1.13], statBudget: 1.07,
    present: { scale: 1.0, emissive: 3.4, beamH: 8.0, beamR: 0.44, beamOp: 0.28, ring: 2.4, shards: 4, spin: 0.95, bob: 0.26, light: 0, pulse: 1.3 },
  },
  epic: {
    id: 'epic', index: 3, label: 'CLASSIFIED',
    color: '#b46cff', glow: '#e6ccff', weight: 42,
    affixes: [2, 3], roll: [1.09, 1.22], statBudget: 1.12,
    present: { scale: 1.12, emissive: 5.0, beamH: 11.0, beamR: 0.54, beamOp: 0.36, ring: 3.1, shards: 7, spin: 1.25, bob: 0.32, light: 9, pulse: 1.7 },
  },
  legendary: {
    id: 'legendary', index: 4, label: 'ARCHIVE-CLASS',
    color: '#ff8a1f', glow: '#ffd9a0', weight: 8,
    affixes: [3, 4], roll: [1.17, 1.34], statBudget: 1.18,
    present: { scale: 1.28, emissive: 7.5, beamH: 16.0, beamR: 0.7, beamOp: 0.48, ring: 4.2, shards: 10, spin: 1.6, bob: 0.4, light: 16, pulse: 2.3 },
  },
  prototype: {
    id: 'prototype', index: 5, label: 'PROTOTYPE',
    color: '#ff2e4d', glow: '#ffc0cb', weight: 1,
    affixes: [4, 5], roll: [1.28, 1.52], statBudget: 1.26,
    present: { scale: 1.42, emissive: 10.5, beamH: 22.0, beamR: 0.86, beamOp: 0.6, ring: 5.4, shards: 14, spin: 2.1, bob: 0.5, light: 24, pulse: 3.0 },
  },
};

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'prototype'];

/** Rarities at or above this index may roll a unique base part. */
const UNIQUE_MIN_RARITY = 4; // legendary

// ---------------------------------------------------------------------------
// Base part definitions
// ---------------------------------------------------------------------------
//
// `tier` is the earliest world tier the base can appear at. `pick` is the
// relative pick weight inside its slot. `role` is a short tag the garage can
// group by.

const HEADS = [
  { id: 'head_baws_graylock', name: 'BAWS HD-014 GRAYLOCK', mfr: 'BAWS', slot: 'head', tier: 1, pick: 120, role: 'heavy',
    stats: { ap: 318, defKinetic: 238, defEnergy: 196, weight: 4560, enLoad: 246, systemRecovery: 38, scanDistance: 420, acsBoost: 9 },
    desc: 'A cheap armoured skullplate. Terrible optics, excellent at not being a hole.' },
  { id: 'head_baws_parsons', name: 'BAWS HD-021 PARSONS', mfr: 'BAWS', slot: 'head', tier: 1, pick: 130, role: 'balanced',
    stats: { ap: 280, defKinetic: 206, defEnergy: 188, weight: 3820, enLoad: 210, systemRecovery: 45, scanDistance: 500, acsBoost: 7 },
    desc: 'The default Rubicon service head. Nothing outstanding, nothing broken.' },
  { id: 'head_elcano_alcyone', name: 'ELCANO EL-TH-06 ALCYONE', mfr: 'ELCANO', slot: 'head', tier: 1, pick: 100, role: 'light',
    stats: { ap: 186, defKinetic: 142, defEnergy: 172, weight: 2140, enLoad: 288, systemRecovery: 62, scanDistance: 780, acsBoost: 4 },
    desc: 'Featherweight sensor pod. Recovers from system shock faster than anything in its class.' },
  { id: 'head_schneider_kestrel', name: 'SCHNEIDER NS-H-402 KESTREL', mfr: 'SCHNEIDER', slot: 'head', tier: 2, pick: 95, role: 'scan',
    stats: { ap: 212, defKinetic: 162, defEnergy: 214, weight: 2680, enLoad: 316, systemRecovery: 55, scanDistance: 720, acsBoost: 5 },
    desc: 'Coral-assisted tracking optics. Sees further than it can survive.' },
  { id: 'head_arquebus_sentinel', name: 'ARQUEBUS VH-31C SENTINEL', mfr: 'ARQUEBUS', slot: 'head', tier: 2, pick: 85, role: 'premium',
    stats: { ap: 292, defKinetic: 218, defEnergy: 246, weight: 4180, enLoad: 302, systemRecovery: 50, scanDistance: 620, acsBoost: 11 },
    desc: 'Corporate-issue command head. Balanced to the point of arrogance.' },
  { id: 'head_rad_scrapcrown', name: 'RaD RD-HD3 SCRAPCROWN', mfr: 'RaD', slot: 'head', tier: 1, pick: 90, role: 'tank',
    stats: { ap: 372, defKinetic: 268, defEnergy: 154, weight: 5620, enLoad: 194, systemRecovery: 30, scanDistance: 360, acsBoost: 14 },
    desc: 'Welded from three other heads. Blind, deaf, and extremely difficult to stagger.' },
  { id: 'head_dafeng_tianqiang', name: 'DAFENG DF-HD-08 TIANQIANG', mfr: 'DAFENG', slot: 'head', tier: 2, pick: 88, role: 'stability',
    stats: { ap: 306, defKinetic: 240, defEnergy: 218, weight: 4940, enLoad: 262, systemRecovery: 40, scanDistance: 480, acsBoost: 16 },
    desc: 'Gyro-stabilised mass in the neck yoke. Feeds the ACS more headroom than any other head.' },
  { id: 'head_allmind_oracle', name: 'ALLMIND ALM/HD-α ORACLE', mfr: 'ALLMIND', slot: 'head', tier: 3, pick: 40, role: 'unique', unique: true,
    stats: { ap: 148, defKinetic: 108, defEnergy: 236, weight: 1980, enLoad: 486, systemRecovery: 78, scanDistance: 1240, acsBoost: 3 },
    uniqueEffect: { id: 'oracle_weakpoint', value: 0.18, text: 'ORACLE PROTOCOL: locked targets are weak-point mapped. +18% direct hit damage against your current lock. Armour is negligible.' },
    desc: 'An ALLMIND listening head grafted to an AC neck. It sees the seams in things.' },
];

const CORES = [
  { id: 'core_baws_orbiter', name: 'BAWS CC-2000 ORBITER', mfr: 'BAWS', slot: 'core', tier: 1, pick: 130, role: 'balanced',
    stats: { ap: 3120, defKinetic: 268, defEnergy: 238, weight: 24800, enLoad: 480, boosterEfficiency: 102, acsMax: 512, generatorOutputAdj: 100 },
    desc: 'Rubicon workhorse torso. Honest frame, honest numbers.' },
  { id: 'core_baws_wrecker', name: 'BAWS CC-3000 WRECKER', mfr: 'BAWS', slot: 'core', tier: 1, pick: 110, role: 'heavy',
    stats: { ap: 3860, defKinetic: 322, defEnergy: 252, weight: 33600, enLoad: 546, boosterEfficiency: 92, acsMax: 612, generatorOutputAdj: 92 },
    desc: 'Twice the plate, half the agility. Popular with pilots who like standing still.' },
  { id: 'core_elcano_firmeza', name: 'ELCANO EL-TC-10 FIRMEZA', mfr: 'ELCANO', slot: 'core', tier: 1, pick: 100, role: 'light',
    stats: { ap: 2280, defKinetic: 198, defEnergy: 262, weight: 18400, enLoad: 424, boosterEfficiency: 118, acsMax: 402, generatorOutputAdj: 104 },
    desc: 'Racing torso. The booster efficiency adjustment is the best you will find under tier three.' },
  { id: 'core_schneider_vesper', name: 'SCHNEIDER NS-C-181 VESPER', mfr: 'SCHNEIDER', slot: 'core', tier: 2, pick: 92, role: 'energy',
    stats: { ap: 2480, defKinetic: 210, defEnergy: 326, weight: 20600, enLoad: 508, boosterEfficiency: 112, acsMax: 448, generatorOutputAdj: 112 },
    desc: 'Energy-weapon platform. Feeds the generator harder than it feeds the armour.' },
  { id: 'core_arquebus_charoite', name: 'ARQUEBUS VP-40S CHAROITE', mfr: 'ARQUEBUS', slot: 'core', tier: 2, pick: 82, role: 'premium',
    stats: { ap: 3420, defKinetic: 296, defEnergy: 308, weight: 28900, enLoad: 572, boosterEfficiency: 106, acsMax: 588, generatorOutputAdj: 108 },
    desc: 'Everything a corporate budget buys: no weakness worth naming.' },
  { id: 'core_rad_bulwark', name: 'RaD RD-CR7 BULWARK', mfr: 'RaD', slot: 'core', tier: 1, pick: 88, role: 'tank',
    stats: { ap: 4640, defKinetic: 386, defEnergy: 214, weight: 41200, enLoad: 402, boosterEfficiency: 84, acsMax: 742, generatorOutputAdj: 88 },
    desc: 'Scrapyard siege torso. Chews EN output for breakfast and gives back armour.' },
  { id: 'core_dafeng_tianlong', name: 'DAFENG DF-CR-09 TIANLONG', mfr: 'DAFENG', slot: 'core', tier: 2, pick: 86, role: 'stability',
    stats: { ap: 3580, defKinetic: 312, defEnergy: 286, weight: 31500, enLoad: 524, boosterEfficiency: 98, acsMax: 690, generatorOutputAdj: 100 },
    desc: 'Counterweighted gyro cage. Built to keep firing while being hit.' },
  { id: 'core_allmind_choir', name: 'ALLMIND ALM/CR-Ω CHOIR', mfr: 'ALLMIND', slot: 'core', tier: 3, pick: 38, role: 'unique', unique: true,
    stats: { ap: 2960, defKinetic: 248, defEnergy: 344, weight: 22400, enLoad: 612, boosterEfficiency: 114, acsMax: 386, generatorOutputAdj: 118 },
    uniqueEffect: { id: 'choir_stagger_heal', value: 0.08, text: 'CHOIR: every enemy you stagger repairs 8% of your maximum AP. Attitude stability is gutted to pay for it.' },
    desc: 'Coral-threaded torso. It sings when something else breaks.' },
];

const ARMS = [
  { id: 'arms_baws_grit', name: 'BAWS AA-011 GRIT', mfr: 'BAWS', slot: 'arms', tier: 1, pick: 130, role: 'balanced',
    stats: { ap: 980, defKinetic: 232, defEnergy: 186, weight: 12400, enLoad: 320, armsLoadLimit: 7600, recoilControl: 118, firearmSpecialization: 92, meleeSpec: 104 },
    desc: 'Standard manipulators. The arms load limit is tight — pick your guns.' },
  { id: 'arms_baws_hauler', name: 'BAWS AA-024 HAULER', mfr: 'BAWS', slot: 'arms', tier: 1, pick: 105, role: 'heavy',
    stats: { ap: 1290, defKinetic: 288, defEnergy: 204, weight: 18600, enLoad: 384, armsLoadLimit: 15800, recoilControl: 152, firearmSpecialization: 84, meleeSpec: 112 },
    desc: 'Industrial loader arms. Will hold two bazookas without complaining.' },
  { id: 'arms_elcano_alba', name: 'ELCANO EL-AR-04 ALBA', mfr: 'ELCANO', slot: 'arms', tier: 1, pick: 100, role: 'light',
    stats: { ap: 660, defKinetic: 164, defEnergy: 212, weight: 8200, enLoad: 288, armsLoadLimit: 5400, recoilControl: 88, firearmSpecialization: 108, meleeSpec: 96 },
    desc: 'Thin, fast, and allergic to anything heavier than a handgun.' },
  { id: 'arms_schneider_lancet', name: 'SCHNEIDER NS-A-268 LANCET', mfr: 'SCHNEIDER', slot: 'arms', tier: 2, pick: 92, role: 'precision',
    stats: { ap: 748, defKinetic: 180, defEnergy: 252, weight: 9600, enLoad: 356, armsLoadLimit: 6200, recoilControl: 96, firearmSpecialization: 136, meleeSpec: 88 },
    desc: 'Marksman manipulators. Everything you fire lands where you meant it to.' },
  { id: 'arms_arquebus_talon', name: 'ARQUEBUS VP-46S TALON', mfr: 'ARQUEBUS', slot: 'arms', tier: 2, pick: 84, role: 'premium',
    stats: { ap: 1040, defKinetic: 246, defEnergy: 262, weight: 14200, enLoad: 372, armsLoadLimit: 10400, recoilControl: 128, firearmSpecialization: 118, meleeSpec: 108 },
    desc: 'Corporate all-rounders. Good recoil damping, good spec, good price if you steal them.' },
  { id: 'arms_rad_clawhand', name: 'RaD RD-AR6 CLAWHAND', mfr: 'RaD', slot: 'arms', tier: 1, pick: 90, role: 'melee',
    stats: { ap: 1120, defKinetic: 264, defEnergy: 172, weight: 16400, enLoad: 302, armsLoadLimit: 12600, recoilControl: 142, firearmSpecialization: 76, meleeSpec: 158 },
    desc: 'Grapple-rated actuators. Made for hitting things that are already close.' },
  { id: 'arms_melinite_detonator', name: 'MELINITE MN-A-77 DETONATOR', mfr: 'MELINITE', slot: 'arms', tier: 2, pick: 86, role: 'explosive',
    stats: { ap: 940, defKinetic: 228, defEnergy: 208, weight: 13600, enLoad: 344, armsLoadLimit: 9800, recoilControl: 148, firearmSpecialization: 96, meleeSpec: 100 },
    desc: 'Blast-hardened arms with oversized dampers. Built around recoil, not around aim.' },
  { id: 'arms_schneider_nova', name: 'SCHNEIDER NS-A-NOVA', mfr: 'SCHNEIDER', slot: 'arms', tier: 3, pick: 36, role: 'unique', unique: true,
    stats: { ap: 560, defKinetic: 132, defEnergy: 268, weight: 10800, enLoad: 468, armsLoadLimit: 4900, recoilControl: 30, firearmSpecialization: 178, meleeSpec: 74 },
    uniqueEffect: { id: 'nova_precision', value: 0.30, text: 'NOVA: +30% direct hit damage. Recoil control is effectively absent and the arms load limit is the lowest ever shipped.' },
    desc: 'A prototype aiming rig with the recoil dampers deleted for mass. Hold light guns. Do not miss.' },
];

const LEGS = [
  { id: 'legs_baws_strider', name: 'BAWS LG-011 STRIDER', mfr: 'BAWS', slot: 'legs', tier: 1, pick: 130, role: 'balanced', legType: 'biped',
    stats: { ap: 2150, defKinetic: 292, defEnergy: 238, weight: 16800, enLoad: 460, loadLimit: 88000, jumpHeight: 118, travelSpeed: 342, acsMax: 620 },
    desc: 'The bipedal baseline. Everything else is measured against this.' },
  { id: 'legs_elcano_corrida', name: 'ELCANO EL-LG-05 CORRIDA', mfr: 'ELCANO', slot: 'legs', tier: 1, pick: 105, role: 'light', legType: 'biped',
    stats: { ap: 1480, defKinetic: 208, defEnergy: 246, weight: 11200, enLoad: 508, loadLimit: 58000, jumpHeight: 142, travelSpeed: 418, acsMax: 448 },
    desc: 'Sprinter legs. Fast, brittle, and permanently one bazooka away from overweight.' },
  { id: 'legs_arquebus_glaive', name: 'ARQUEBUS VP-422 GLAIVE', mfr: 'ARQUEBUS', slot: 'legs', tier: 2, pick: 84, role: 'premium', legType: 'biped',
    stats: { ap: 2380, defKinetic: 316, defEnergy: 298, weight: 19600, enLoad: 552, loadLimit: 94000, jumpHeight: 126, travelSpeed: 368, acsMax: 706 },
    desc: 'Corporate line bipeds. Carries a real loadout without giving up footspeed.' },
  { id: 'legs_schneider_grasshopper', name: 'SCHNEIDER NS-L-119 GRASSHOPPER', mfr: 'SCHNEIDER', slot: 'legs', tier: 1, pick: 96, role: 'jump', legType: 'reverse',
    stats: { ap: 1620, defKinetic: 224, defEnergy: 262, weight: 13400, enLoad: 542, loadLimit: 68000, jumpHeight: 224, travelSpeed: 396, acsMax: 402 },
    desc: 'Reverse-joint sprint frame. Leaves the ground like it resents it.' },
  { id: 'legs_rad_kangaroo', name: 'RaD RD-LG4 KANGAROO', mfr: 'RaD', slot: 'legs', tier: 1, pick: 92, role: 'jump-heavy', legType: 'reverse',
    stats: { ap: 2080, defKinetic: 276, defEnergy: 206, weight: 18200, enLoad: 498, loadLimit: 84000, jumpHeight: 196, travelSpeed: 344, acsMax: 486 },
    desc: 'Heavy reverse-joints welded out of mining walkers. Still jumps a building.' },
  { id: 'legs_dafeng_tianqiang', name: 'DAFENG DF-LG-08 TIANQIANG', mfr: 'DAFENG', slot: 'legs', tier: 2, pick: 88, role: 'platform', legType: 'tetrapod',
    stats: { ap: 2620, defKinetic: 348, defEnergy: 288, weight: 27400, enLoad: 638, loadLimit: 92000, jumpHeight: 96, travelSpeed: 306, acsMax: 828 },
    desc: 'Four-legged fire platform. Hovers, holds, and does not care about recoil.' },
  { id: 'legs_arquebus_spectre', name: 'ARQUEBUS VP-424 SPECTRE', mfr: 'ARQUEBUS', slot: 'legs', tier: 2, pick: 80, role: 'hover', legType: 'tetrapod',
    stats: { ap: 2240, defKinetic: 302, defEnergy: 326, weight: 23800, enLoad: 704, loadLimit: 84000, jumpHeight: 108, travelSpeed: 332, acsMax: 742 },
    desc: 'Light tetrapod. Trades some load for the best hover endurance on the market.' },
  { id: 'legs_rad_juggernaut', name: 'RaD RD-LG9 JUGGERNAUT', mfr: 'RaD', slot: 'legs', tier: 2, pick: 78, role: 'siege', legType: 'tank',
    stats: { ap: 3720, defKinetic: 442, defEnergy: 252, weight: 42600, enLoad: 612, loadLimit: 108000, jumpHeight: 68, travelSpeed: 268, acsMax: 1180 },
    desc: 'Treads. No quick boost, no apology. Load limit that makes every weapon legal.' },
  { id: 'legs_baws_bulldozer', name: 'BAWS LG-033 BULLDOZER', mfr: 'BAWS', slot: 'legs', tier: 1, pick: 86, role: 'siege', legType: 'tank',
    stats: { ap: 3280, defKinetic: 402, defEnergy: 224, weight: 38200, enLoad: 548, loadLimit: 98000, jumpHeight: 72, travelSpeed: 284, acsMax: 1060 },
    desc: 'Rubicon construction treads with guns bolted above them. Cheap, immovable.' },
  { id: 'legs_rad_scrapheap', name: 'RaD RD-LG-X SCRAPHEAP', mfr: 'RaD', slot: 'legs', tier: 3, pick: 34, role: 'unique', unique: true, legType: 'tank',
    stats: { ap: 4180, defKinetic: 486, defEnergy: 198, weight: 40100, enLoad: 386, loadLimit: 118000, jumpHeight: 64, travelSpeed: 302, acsMax: 1340 },
    uniqueEffect: { id: 'scrapheap_bloodtread', value: 0.02, text: 'SCRAPHEAP: load limit is effectively unlimited and the ground dash never runs out of EN — it burns 2% AP per second instead.' },
    desc: 'A junk-hauler chassis with an unlicensed reactor tap. It runs on you.' },
];

const BOOSTERS = [
  { id: 'bst_baws_kickstart', name: 'BAWS BST-G1/P10 KICKSTART', mfr: 'BAWS', slot: 'booster', tier: 1, pick: 130, role: 'budget',
    stats: { weight: 1420, enLoad: 240, thrust: 5620, qbThrust: 13400, qbENConsumption: 380, qbReloadTime: 0.62, upwardThrust: 4980 },
    desc: 'Entry-level thruster set. Adequate. Nobody has ever loved one.' },
  { id: 'bst_elcano_alula', name: 'ELCANO EL-PB-02 ALULA', mfr: 'ELCANO', slot: 'booster', tier: 1, pick: 108, role: 'speed',
    stats: { weight: 980, enLoad: 306, thrust: 6980, qbThrust: 15800, qbENConsumption: 344, qbReloadTime: 0.48, upwardThrust: 5620 },
    desc: 'Racing thrusters. Top ground-boost speed for almost no mass.' },
  { id: 'bst_schneider_buzzsaw', name: 'SCHNEIDER NS-B-247 BUZZSAW', mfr: 'SCHNEIDER', slot: 'booster', tier: 2, pick: 96, role: 'quickboost',
    stats: { weight: 1180, enLoad: 348, thrust: 6240, qbThrust: 17600, qbENConsumption: 418, qbReloadTime: 0.34, upwardThrust: 5240 },
    desc: 'Fastest quick-boost recharge in the catalogue. Chain four dashes before anyone lands a shot.' },
  { id: 'bst_arquebus_lance', name: 'ARQUEBUS VP-60LCS LANCE', mfr: 'ARQUEBUS', slot: 'booster', tier: 2, pick: 84, role: 'premium',
    stats: { weight: 1620, enLoad: 372, thrust: 7460, qbThrust: 19200, qbENConsumption: 466, qbReloadTime: 0.52, upwardThrust: 6180 },
    desc: 'Corporate flagship thrusters. Strong everywhere, cheap nowhere.' },
  { id: 'bst_rad_sledge', name: 'RaD RD-BST5 SLEDGE', mfr: 'RaD', slot: 'booster', tier: 1, pick: 90, role: 'impulse',
    stats: { weight: 2280, enLoad: 288, thrust: 5180, qbThrust: 23400, qbENConsumption: 640, qbReloadTime: 0.82, upwardThrust: 4320 },
    desc: 'One enormous quick boost, then a long wait. Repositioning as a weapon.' },
  { id: 'bst_dafeng_ibis', name: 'DAFENG DF-BST-08 IBIS', mfr: 'DAFENG', slot: 'booster', tier: 2, pick: 88, role: 'vertical',
    stats: { weight: 1340, enLoad: 322, thrust: 6020, qbThrust: 14600, qbENConsumption: 358, qbReloadTime: 0.56, upwardThrust: 6900 },
    desc: 'Vertical-bias thrusters. Fights from above and stays there.' },
  { id: 'bst_allmind_phantasm', name: 'ALLMIND ALM/BST-∅ PHANTASM', mfr: 'ALLMIND', slot: 'booster', tier: 3, pick: 34, role: 'unique', unique: true,
    stats: { weight: 1260, enLoad: 466, thrust: 6640, qbThrust: 18800, qbENConsumption: 402, qbReloadTime: 0.30, upwardThrust: 5980 },
    uniqueEffect: { id: 'phantasm_zero_cooldown', qbReloadMul: 0, qbCostMul: 2.0, value: 1, text: 'PHANTASM: quick boost has no cooldown whatsoever. Each dash costs double EN. Your generator is now the only thing stopping you.' },
    desc: 'Reverse-engineered ALLMIND thrusters with the recharge interlock removed.' },
  { id: 'bst_dafeng_kite', name: 'DAFENG DF-BST-K KITE', mfr: 'DAFENG', slot: 'booster', tier: 3, pick: 32, role: 'unique', unique: true,
    stats: { weight: 1180, enLoad: 344, thrust: 4820, qbThrust: 13200, qbENConsumption: 316, qbReloadTime: 0.58, upwardThrust: 11200 },
    uniqueEffect: { id: 'kite_skyhold', hoverDrainMul: 0.45, groundBoostMul: 0.78, value: 1, text: 'KITE: upward thrust is doubled and hovering costs 55% less EN. Ground boost speed is cut by 22% — you were not meant to be down there.' },
    desc: 'An atmospheric survey rig turned into a combat booster. Lives in the air.' },
];

const GENERATORS = [
  { id: 'gen_baws_coalsack', name: 'BAWS VE-20A COALSACK', mfr: 'BAWS', slot: 'generator', tier: 1, pick: 130, role: 'budget',
    stats: { weight: 3860, enLoad: 0, enCapacity: 2480, enOutput: 2480, enRecharge: 620, supplyRecovery: 68, postRecoveryENSupply: 460 },
    desc: 'Rubicon surplus reactor. Runs a starter build and not one watt more.' },
  { id: 'gen_elcano_aurora', name: 'ELCANO EL-GN-03 AURORA', mfr: 'ELCANO', slot: 'generator', tier: 1, pick: 106, role: 'light',
    stats: { weight: 2740, enLoad: 0, enCapacity: 2060, enOutput: 2720, enRecharge: 790, supplyRecovery: 84, postRecoveryENSupply: 520 },
    desc: 'Small capacity, superb recharge. Rewards pilots who never stop moving.' },
  { id: 'gen_schneider_volta', name: 'SCHNEIDER NS-G-166 VOLTA', mfr: 'SCHNEIDER', slot: 'generator', tier: 2, pick: 94, role: 'recharge',
    stats: { weight: 4620, enLoad: 0, enCapacity: 2860, enOutput: 3180, enRecharge: 940, supplyRecovery: 76, postRecoveryENSupply: 580 },
    desc: 'Coral-tapped reactor. The recharge curve is close to unfair.' },
  { id: 'gen_arquebus_sapphire', name: 'ARQUEBUS VP-20C SAPPHIRE', mfr: 'ARQUEBUS', slot: 'generator', tier: 2, pick: 82, role: 'premium',
    stats: { weight: 6180, enLoad: 0, enCapacity: 3420, enOutput: 3640, enRecharge: 848, supplyRecovery: 72, postRecoveryENSupply: 644 },
    desc: 'The output ceiling that makes double energy weapons legal.' },
  { id: 'gen_rad_dynamo', name: 'RaD RD-GN8 DYNAMO', mfr: 'RaD', slot: 'generator', tier: 1, pick: 90, role: 'capacity',
    stats: { weight: 7240, enLoad: 0, enCapacity: 4380, enOutput: 3060, enRecharge: 528, supplyRecovery: 56, postRecoveryENSupply: 726 },
    desc: 'A tank battery with a reactor attached. Enormous reserve, glacial refill.' },
  { id: 'gen_dafeng_ming', name: 'DAFENG DF-GN-08 MING', mfr: 'DAFENG', slot: 'generator', tier: 2, pick: 88, role: 'balanced',
    stats: { weight: 5420, enLoad: 0, enCapacity: 3560, enOutput: 3380, enRecharge: 702, supplyRecovery: 66, postRecoveryENSupply: 682 },
    desc: 'Heavy, even-tempered reactor. Never the best column, never the worst.' },
  { id: 'gen_allmind_overseer', name: 'ALLMIND ALM/GN-Ω OVERSEER', mfr: 'ALLMIND', slot: 'generator', tier: 3, pick: 34, role: 'unique', unique: true,
    stats: { weight: 4980, enLoad: 0, enCapacity: 2980, enOutput: 3300, enRecharge: 612, supplyRecovery: 62, postRecoveryENSupply: 540 },
    uniqueEffect: { id: 'overseer_redline', apThreshold: 0.30, rechargeMul: 2.4, costMul: 0.62, value: 1, text: 'REDLINE: below 30% AP the reactor overcharges — EN recharge x2.4 and all EN costs x0.62. Above 30% it is merely adequate.' },
    desc: 'An ALLMIND reactor that reads your armour telemetry and decides when you deserve more power.' },
  { id: 'gen_baws_furnace', name: 'BAWS VE-99 FURNACE', mfr: 'BAWS', slot: 'generator', tier: 3, pick: 32, role: 'unique', unique: true,
    stats: { weight: 8640, enLoad: 0, enCapacity: 6820, enOutput: 2260, enRecharge: 262, supplyRecovery: 100, postRecoveryENSupply: 1180 },
    uniqueEffect: { id: 'furnace_instant_supply', supplyRecoveryOverride: 0.15, value: 1, text: 'FURNACE: an EN-empty redline clears almost instantly and refunds a huge supply burst. Sustained recharge is dreadful — spend it all, then reset.' },
    desc: 'An illegal fission cell the size of a car. Two full tanks of EN and no patience.' },
];

const R_ARM_WEAPONS = [
  { id: 'w_baws_scudder', name: 'BAWS RF-025 SCUDDER', mfr: 'BAWS', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 1, pick: 130, role: 'rifle', weaponId: 'rifle_rf025',
    stats: { weight: 4380, enLoad: 68, damageMod: 1.00, impactMod: 1.00, ammoMod: 1.00 },
    desc: 'Assault rifle. The most honest weapon on Rubicon.' },
  { id: 'w_arquebus_longshot', name: 'ARQUEBUS VP-66LR LONGSHOT', mfr: 'ARQUEBUS', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 2, pick: 92, role: 'rifle', weaponId: 'rifle_lr',
    stats: { weight: 6240, enLoad: 96, damageMod: 1.14, impactMod: 1.06, ammoMod: 0.84 },
    desc: 'Long-barrel rifle. Reaches across the arena and hits like a cannon that is late.' },
  { id: 'w_rad_hammerhead', name: 'RaD SG-027 HAMMERHEAD', mfr: 'RaD', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 1, pick: 112, role: 'shotgun', weaponId: 'shotgun_sg027',
    stats: { weight: 5480, enLoad: 54, damageMod: 1.06, impactMod: 1.22, ammoMod: 0.88 },
    desc: 'Point-blank shotgun. Fills the ACS gauge in one press.' },
  { id: 'w_elcano_sidewinder', name: 'ELCANO HG-003 SIDEWINDER', mfr: 'ELCANO', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 1, pick: 120, role: 'handgun', weaponId: 'handgun_hg003',
    stats: { weight: 2210, enLoad: 46, damageMod: 0.88, impactMod: 0.96, ammoMod: 1.26 },
    desc: 'Fast-cycling handgun. Weighs nothing, never stops firing.' },
  { id: 'w_melinite_chatterbox', name: 'MELINITE GU-A2 CHATTERBOX', mfr: 'MELINITE', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 2, pick: 90, role: 'gatling', weaponId: 'gatling_gu_a2',
    stats: { weight: 8460, enLoad: 84, damageMod: 0.94, impactMod: 0.80, ammoMod: 1.48 },
    desc: 'Rotary cannon. Individually pathetic rounds, collectively a wall.' },
  { id: 'w_melinite_majestic', name: 'MELINITE MJ-24 MAJESTIC', mfr: 'MELINITE', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 2, pick: 88, role: 'bazooka', weaponId: 'bazooka_mj24',
    stats: { weight: 9240, enLoad: 72, damageMod: 1.26, impactMod: 1.38, ammoMod: 0.68 },
    desc: 'Shoulder-fired bazooka held in a hand. Colossal impact, colossal weight.' },
  { id: 'w_schneider_halo', name: 'SCHNEIDER PR-16 HALO', mfr: 'SCHNEIDER', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 2, pick: 86, role: 'plasma', weaponId: 'plasma_pr16',
    stats: { weight: 5960, enLoad: 742, damageMod: 1.16, impactMod: 1.10, ammoMod: 0.90 },
    desc: 'Plasma thrower. Leaves a lingering field where the shot lands. Drinks EN output.' },
  { id: 'w_arquebus_excelsior', name: 'ARQUEBUS LR-37 EXCELSIOR', mfr: 'ARQUEBUS', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 2, pick: 84, role: 'laser', weaponId: 'laser_lr37',
    stats: { weight: 5120, enLoad: 826, damageMod: 1.10, impactMod: 0.88, ammoMod: 0.96 },
    desc: 'Charged laser rifle. Enormous energy damage, and your EN surplus will never forgive you.' },
  { id: 'w_melinite_sundown', name: 'MELINITE PR-16/SUNDOWN', mfr: 'MELINITE', slot: 'rArm', slots: ['rArm', 'lArm'], tier: 3, pick: 32, role: 'unique', unique: true, weaponId: 'plasma_pr16',
    stats: { weight: 6480, enLoad: 1180, damageMod: 1.72, impactMod: 1.24, ammoMod: 0.74 },
    uniqueEffect: { id: 'sundown_overburn', value: 0.06, text: 'SUNDOWN: +72% plasma damage, but every shot vents 6% of your EN capacity. Fire it dry and you fall out of the sky.' },
    desc: 'An unsafe overburn tune of the PR-16. MELINITE denies it exists.' },
];

const L_ARM_WEAPONS = [
  { id: 'w_dafeng_tiandao', name: 'DAFENG PB-033 TIANDAO', mfr: 'DAFENG', slot: 'lArm', tier: 1, pick: 120, role: 'melee', weaponId: 'pulse_blade',
    stats: { weight: 3260, enLoad: 388, damageMod: 1.22, impactMod: 1.34, ammoMod: 1.00 },
    desc: 'Pulse blade. Two-hit combo, obscene stagger damage, no range whatsoever.' },
  { id: 'w_arquebus_bulwark', name: 'ARQUEBUS VE-61PSA BULWARK', mfr: 'ARQUEBUS', slot: 'lArm', slots: ['lArm', 'lShoulder'], tier: 2, pick: 92, role: 'shield', weaponId: 'pulse_shield',
    stats: { weight: 4120, enLoad: 596, damageMod: 0.00, impactMod: 0.00, ammoMod: 1.00 },
    desc: 'Pulse shield. Eats one committed alpha strike, then needs a moment alone.' },
  { id: 'w_rad_hammerhead_l', name: 'RaD SG-027/L HAMMERHEAD', mfr: 'RaD', slot: 'lArm', tier: 1, pick: 108, role: 'shotgun', weaponId: 'shotgun_sg027',
    stats: { weight: 5480, enLoad: 54, damageMod: 1.06, impactMod: 1.22, ammoMod: 0.88 },
    desc: 'Mirrored shotgun. Twin HAMMERHEADs is the oldest stagger recipe there is.' },
  { id: 'w_elcano_sidewinder_l', name: 'ELCANO HG-003/L SIDEWINDER', mfr: 'ELCANO', slot: 'lArm', tier: 1, pick: 118, role: 'handgun', weaponId: 'handgun_hg003',
    stats: { weight: 2210, enLoad: 46, damageMod: 0.88, impactMod: 0.96, ammoMod: 1.26 },
    desc: 'Off-hand handgun. Weighs nothing, so it is always the right answer for a tight arms load.' },
  { id: 'w_arquebus_excelsior_l', name: 'ARQUEBUS LR-37/L EXCELSIOR', mfr: 'ARQUEBUS', slot: 'lArm', tier: 2, pick: 82, role: 'laser', weaponId: 'laser_lr37',
    stats: { weight: 5120, enLoad: 826, damageMod: 1.10, impactMod: 0.88, ammoMod: 0.96 },
    desc: 'Off-hand charged laser. Two of these will collapse any generator under 3400 output.' },
  { id: 'w_melinite_shredder_l', name: 'MELINITE GU-A2/L SHREDDER', mfr: 'MELINITE', slot: 'lArm', tier: 2, pick: 86, role: 'gatling', weaponId: 'gatling_gu_a2',
    stats: { weight: 8460, enLoad: 84, damageMod: 0.94, impactMod: 0.80, ammoMod: 1.48 },
    desc: 'Left-hand rotary. Needs HAULER arms or it will never leave the garage.' },
  { id: 'w_dafeng_wuxin', name: 'DAFENG PB-∞ WUXIN', mfr: 'DAFENG', slot: 'lArm', tier: 3, pick: 30, role: 'unique', unique: true, weaponId: 'pulse_blade',
    stats: { weight: 3040, enLoad: 512, damageMod: 1.48, impactMod: 1.62, ammoMod: 1.00 },
    uniqueEffect: { id: 'wuxin_reap', value: 0.35, text: 'WUXIN: a blade kill refunds 35% of your EN capacity instantly. Chain kills and you never touch the ground.' },
    desc: 'A coral-fed blade that gets hungrier the more it is used.' },
];

const R_SHOULDER_WEAPONS = [
  { id: 'w_baws_sprinkler', name: 'BAWS BML-G2/P05 SPRINKLER', mfr: 'BAWS', slot: 'rShoulder', slots: ['rShoulder', 'lShoulder'], tier: 1, pick: 130, role: 'missile', weaponId: 'missile_bml',
    stats: { weight: 3240, enLoad: 96, damageMod: 1.00, impactMod: 1.02, ammoMod: 1.10 },
    desc: 'Five-tube missile rack. Cheap, light, always useful.' },
  { id: 'w_arquebus_swarmer', name: 'ARQUEBUS VP-60LCD SWARMER', mfr: 'ARQUEBUS', slot: 'rShoulder', slots: ['rShoulder', 'lShoulder'], tier: 2, pick: 92, role: 'missile', weaponId: 'missile_swarm',
    stats: { weight: 5980, enLoad: 148, damageMod: 0.92, impactMod: 1.16, ammoMod: 0.94 },
    desc: 'Swarm launcher. Twenty-four small warheads that arrive from three directions.' },
  { id: 'w_rad_earshot', name: 'RaD EARSHOT', mfr: 'RaD', slot: 'rShoulder', slots: ['rShoulder', 'lShoulder'], tier: 2, pick: 86, role: 'cannon', weaponId: 'cannon_earshot',
    stats: { weight: 9860, enLoad: 132, damageMod: 1.34, impactMod: 1.52, ammoMod: 0.60 },
    desc: 'Grenade cannon. One shot ends a stagger window permanently.' },
  { id: 'w_allmind_attendant', name: 'ALLMIND ORBT-C ATTENDANT', mfr: 'ALLMIND', slot: 'rShoulder', slots: ['rShoulder', 'lShoulder'], tier: 2, pick: 84, role: 'pod', weaponId: 'orbit_pod',
    stats: { weight: 4460, enLoad: 512, damageMod: 0.86, impactMod: 0.78, ammoMod: 1.00 },
    desc: 'Deployable orbit pod. Fires on its own while you are busy being shot at.' },
  { id: 'w_melinite_majestic_s', name: 'MELINITE MJ-24/S MAJESTIC', mfr: 'MELINITE', slot: 'rShoulder', slots: ['rShoulder', 'lShoulder'], tier: 2, pick: 82, role: 'bazooka', weaponId: 'bazooka_mj24',
    stats: { weight: 8720, enLoad: 78, damageMod: 1.30, impactMod: 1.44, ammoMod: 0.64 },
    desc: 'Back-mounted bazooka. Frees your hands for something with a trigger discipline problem.' },
  { id: 'w_schneider_needle', name: 'SCHNEIDER LR-37/S NEEDLE', mfr: 'SCHNEIDER', slot: 'rShoulder', slots: ['rShoulder', 'lShoulder'], tier: 2, pick: 80, role: 'laser', weaponId: 'laser_lr37',
    stats: { weight: 6340, enLoad: 918, damageMod: 1.18, impactMod: 0.84, ammoMod: 0.92 },
    desc: 'Shoulder laser lance. Precise, silent, and ruinous to your EN surplus.' },
  { id: 'w_allmind_conductor', name: 'ALLMIND ORBT-Ω CONDUCTOR', mfr: 'ALLMIND', slot: 'rShoulder', slots: ['rShoulder', 'lShoulder'], tier: 3, pick: 30, role: 'unique', unique: true, weaponId: 'orbit_pod',
    stats: { weight: 5240, enLoad: 884, damageMod: 1.24, impactMod: 1.06, ammoMod: 1.00 },
    uniqueEffect: { id: 'conductor_echo', value: 0.22, text: 'CONDUCTOR: the pod re-fires every weapon you fire at 22% power. It never runs out and it never stops.' },
    desc: 'An ALLMIND relay that mirrors your trigger. Whatever you shoot, it shoots too.' },
];

const L_SHOULDER_WEAPONS = [
  { id: 'w_arquebus_aegis', name: 'ARQUEBUS VE-61PSA AEGIS', mfr: 'ARQUEBUS', slot: 'lShoulder', tier: 2, pick: 96, role: 'shield', weaponId: 'pulse_shield',
    stats: { weight: 4680, enLoad: 648, damageMod: 0.00, impactMod: 0.00, ammoMod: 1.00 },
    desc: 'Shoulder pulse shield. Deploys wide enough to cover a stationary reload.' },
  { id: 'w_baws_deluge', name: 'BAWS BML-G1/P20 DELUGE', mfr: 'BAWS', slot: 'lShoulder', tier: 1, pick: 126, role: 'missile', weaponId: 'missile_bml',
    stats: { weight: 4340, enLoad: 108, damageMod: 1.06, impactMod: 1.08, ammoMod: 0.96 },
    desc: 'Twenty-tube vertical rack. Empty the whole thing into one lock.' },
  { id: 'w_dafeng_locust', name: 'DAFENG SWARM-08 LOCUST', mfr: 'DAFENG', slot: 'lShoulder', tier: 2, pick: 90, role: 'missile', weaponId: 'missile_swarm',
    stats: { weight: 6120, enLoad: 156, damageMod: 0.90, impactMod: 1.20, ammoMod: 0.98 },
    desc: 'Wide-dispersal swarm pod. Impossible to fully dodge, impossible to fully block.' },
  { id: 'w_allmind_acolyte', name: 'ALLMIND ORBT-D ACOLYTE', mfr: 'ALLMIND', slot: 'lShoulder', tier: 2, pick: 84, role: 'pod', weaponId: 'orbit_pod',
    stats: { weight: 4260, enLoad: 486, damageMod: 0.82, impactMod: 0.86, ammoMod: 1.00 },
    desc: 'Support orbit pod tuned for impact rather than damage. Holds a stagger open.' },
  { id: 'w_rad_siege', name: 'RaD EARSHOT/L SIEGE', mfr: 'RaD', slot: 'lShoulder', tier: 2, pick: 82, role: 'cannon', weaponId: 'cannon_earshot',
    stats: { weight: 10240, enLoad: 138, damageMod: 1.38, impactMod: 1.56, ammoMod: 0.56 },
    desc: 'The heavier EARSHOT mount. Only tank and tetrapod builds will carry it and stay legal.' },
  { id: 'w_melinite_shredder_s', name: 'MELINITE GU-A2/S SHREDDER', mfr: 'MELINITE', slot: 'lShoulder', tier: 2, pick: 80, role: 'gatling', weaponId: 'gatling_gu_a2',
    stats: { weight: 8940, enLoad: 92, damageMod: 0.96, impactMod: 0.84, ammoMod: 1.42 },
    desc: 'Back-mounted rotary. Suppression from a shoulder, hands free.' },
  { id: 'w_arquebus_relay', name: 'ARQUEBUS VE-61/RELAY AEGIS', mfr: 'ARQUEBUS', slot: 'lShoulder', tier: 3, pick: 30, role: 'unique', unique: true, weaponId: 'pulse_shield',
    stats: { weight: 5120, enLoad: 812, damageMod: 0.00, impactMod: 0.00, ammoMod: 1.00 },
    uniqueEffect: { id: 'relay_reflect', value: 0.55, text: 'RELAY: the shield returns 55% of blocked impact to whoever fired it. Block a bazooka, stagger the pilot who threw it.' },
    desc: 'A prototype pulse shield with the dissipation stage wired backwards.' },
];

const ALL_DEFS = [
  ...HEADS, ...CORES, ...ARMS, ...LEGS,
  ...BOOSTERS, ...GENERATORS,
  ...R_ARM_WEAPONS, ...L_ARM_WEAPONS, ...R_SHOULDER_WEAPONS, ...L_SHOULDER_WEAPONS,
];

// Normalise: every def gets a `slots` array (a weapon may fit several mounts).
for (const d of ALL_DEFS) {
  if (!d.slots) d.slots = [d.slot];
  d.pick = d.pick ?? 100;
  d.tier = d.tier ?? 1;
  d.unique = !!d.unique;
  Object.freeze(d.stats);
}

/** id -> base definition. */
export const PART_DEFS = Object.freeze(
  ALL_DEFS.reduce((acc, d) => { acc[d.id] = d; return acc; }, {})
);

/** Flat list, in catalogue order. */
export const PART_LIST = Object.freeze(ALL_DEFS.slice());

/** slot -> base definitions mountable in that slot. */
export const PARTS_BY_SLOT = (() => {
  const m = {};
  for (const s of SLOTS) m[s] = [];
  for (const d of ALL_DEFS) for (const s of d.slots) if (m[s]) m[s].push(d);
  return Object.freeze(m);
})();

/** Diagnostics for the garage / debug overlay. */
export const PART_COUNTS = Object.freeze(
  SLOTS.reduce((acc, s) => { acc[s] = PARTS_BY_SLOT[s].length; return acc; }, { total: ALL_DEFS.length })
);

// ---------------------------------------------------------------------------
// Affixes
// ---------------------------------------------------------------------------
//
// `space`  'part'    -> modifies a summed base part stat (ap, weight, thrust...)
//          'derived' -> modifies a computed derived stat (boostSpeed, qbReloadTime...)
//          'special' -> contributes a named effect into derived.effects
// `mode`   'flat'    -> additive, in the stat's own units
//          'pct'     -> fractional, summed with other pct affixes then applied once
// `sign`   -1 marks an affix whose *negative* value is the good outcome
//          (e.g. -18% QB EN cost). Stored negative, displayed as a reduction.

export const AFFIXES = [
  // --- frame / survivability ------------------------------------------------
  { id: 'reinforced', name: 'Reinforced', kind: 'prefix', space: 'part', stat: 'ap', mode: 'flat',
    min: 90, max: 320, tierScale: 0.16, weight: 110, slots: FRAME_SLOTS, fmt: '+{v} AP' },
  { id: 'monolithic', name: 'Monolithic', kind: 'prefix', space: 'part', stat: 'ap', mode: 'pct',
    min: 0.04, max: 0.13, tierScale: 0.03, weight: 55, slots: FRAME_SLOTS, fmt: '+{p}% AP' },
  { id: 'ablative', name: 'Ablative', kind: 'prefix', space: 'part', stat: 'defKinetic', mode: 'pct',
    min: 0.06, max: 0.20, tierScale: 0.035, weight: 92, slots: FRAME_SLOTS, fmt: '+{p}% kinetic defence' },
  { id: 'insulated', name: 'Insulated', kind: 'prefix', space: 'part', stat: 'defEnergy', mode: 'pct',
    min: 0.06, max: 0.22, tierScale: 0.04, weight: 92, slots: FRAME_SLOTS, fmt: '+{p}% energy defence' },
  { id: 'braced', name: 'Braced', kind: 'prefix', space: 'part', stat: 'acsMax', mode: 'flat',
    min: 55, max: 220, tierScale: 0.14, weight: 96, slots: ['core', 'legs', 'head'], fmt: '+{v} ACS limit' },
  { id: 'gyroscopic', name: 'Gyroscopic', kind: 'prefix', space: 'part', stat: 'acsMax', mode: 'pct',
    min: 0.05, max: 0.16, tierScale: 0.03, weight: 60, slots: ['core', 'legs'], fmt: '+{p}% ACS limit' },
  { id: 'lightened', name: 'Lightened', kind: 'prefix', space: 'part', stat: 'weight', mode: 'pct', sign: -1,
    min: -0.14, max: -0.04, tierScale: 0.028, weight: 100, fmt: '{p}% part weight' },
  { id: 'loadbearing', name: 'Load-Bearing', kind: 'prefix', space: 'part', stat: 'loadLimit', mode: 'pct',
    min: 0.05, max: 0.17, tierScale: 0.03, weight: 78, slots: ['legs'], fmt: '+{p}% load limit' },
  { id: 'reinforced_mounts', name: 'Hardmount', kind: 'prefix', space: 'part', stat: 'armsLoadLimit', mode: 'pct',
    min: 0.07, max: 0.24, tierScale: 0.04, weight: 78, slots: ['arms'], fmt: '+{p}% arms load limit' },
  { id: 'rebooting', name: 'Rebooting', kind: 'prefix', space: 'part', stat: 'systemRecovery', mode: 'flat',
    min: 4, max: 22, tierScale: 0.12, weight: 64, slots: ['head'], fmt: '+{v} system recovery' },
  { id: 'scanning', name: 'Farsight', kind: 'prefix', space: 'part', stat: 'scanDistance', mode: 'pct',
    min: 0.08, max: 0.32, tierScale: 0.05, weight: 58, slots: ['head'], fmt: '+{p}% scan distance' },

  // --- energy ---------------------------------------------------------------
  { id: 'capacious', name: 'Capacious', kind: 'prefix', space: 'part', stat: 'enCapacity', mode: 'flat',
    min: 90, max: 420, tierScale: 0.16, weight: 100, slots: ['generator', 'core'], fmt: '+{v} EN capacity' },
  { id: 'overclocked', name: 'Overclocked', kind: 'prefix', space: 'part', stat: 'enRecharge', mode: 'pct',
    min: 0.06, max: 0.22, tierScale: 0.04, weight: 100, slots: ['generator', 'core'], fmt: '+{p}% EN recharge' },
  { id: 'dynamo', name: 'of the Dynamo', kind: 'suffix', space: 'part', stat: 'enOutput', mode: 'pct',
    min: 0.04, max: 0.14, tierScale: 0.025, weight: 70, slots: ['generator', 'core'], fmt: '+{p}% EN output' },
  { id: 'efficient', name: 'Efficient', kind: 'prefix', space: 'part', stat: 'enLoad', mode: 'pct', sign: -1,
    min: -0.16, max: -0.05, tierScale: 0.03, weight: 96, fmt: '{p}% EN load' },
  { id: 'vented', name: 'of Venting', kind: 'suffix', space: 'part', stat: 'supplyRecovery', mode: 'pct',
    min: 0.08, max: 0.28, tierScale: 0.045, weight: 62, slots: ['generator'], fmt: '+{p}% supply recovery' },

  // --- mobility -------------------------------------------------------------
  { id: 'tuned', name: 'Tuned', kind: 'prefix', space: 'derived', stat: 'boostSpeed', mode: 'pct',
    min: 0.04, max: 0.15, tierScale: 0.028, weight: 104, fmt: '+{p}% boost speed' },
  { id: 'striding', name: 'Striding', kind: 'prefix', space: 'derived', stat: 'travelSpeed', mode: 'pct',
    min: 0.05, max: 0.18, tierScale: 0.03, weight: 88, slots: ['legs', 'booster'], fmt: '+{p}% travel speed' },
  { id: 'kicked', name: 'Kicked', kind: 'prefix', space: 'part', stat: 'qbThrust', mode: 'pct',
    min: 0.06, max: 0.21, tierScale: 0.035, weight: 96, slots: ['booster'], fmt: '+{p}% QB thrust' },
  { id: 'frugal', name: 'Frugal', kind: 'prefix', space: 'derived', stat: 'qbENConsumption', mode: 'pct', sign: -1,
    min: -0.24, max: -0.07, tierScale: 0.04, weight: 96, slots: ['booster', 'generator'], fmt: '{p}% QB EN cost' },
  { id: 'rapid', name: 'of Quickening', kind: 'suffix', space: 'derived', stat: 'qbReloadTime', mode: 'pct', sign: -1,
    min: -0.22, max: -0.06, tierScale: 0.035, weight: 92, slots: ['booster', 'arms'], fmt: '{p}% QB reload time' },
  { id: 'buoyant', name: 'Buoyant', kind: 'prefix', space: 'part', stat: 'upwardThrust', mode: 'pct',
    min: 0.07, max: 0.26, tierScale: 0.04, weight: 84, slots: ['booster', 'legs'], fmt: '+{p}% upward thrust' },
  { id: 'athletic', name: 'of Leaping', kind: 'suffix', space: 'part', stat: 'jumpHeight', mode: 'pct',
    min: 0.08, max: 0.30, tierScale: 0.05, weight: 70, slots: ['legs'], fmt: '+{p}% jump height' },

  // --- gunnery --------------------------------------------------------------
  { id: 'honed', name: 'Honed', kind: 'prefix', space: 'derived', stat: 'directHitMod', mode: 'pct',
    min: 0.05, max: 0.18, tierScale: 0.032, weight: 100, fmt: '+{p}% direct hit damage' },
  { id: 'percussive', name: 'Percussive', kind: 'prefix', space: 'derived', stat: 'impactMod', mode: 'pct',
    min: 0.05, max: 0.19, tierScale: 0.033, weight: 100, fmt: '+{p}% impact' },
  { id: 'boring', name: 'Piercing', kind: 'prefix', space: 'derived', stat: 'damageMod', mode: 'pct',
    min: 0.04, max: 0.14, tierScale: 0.026, weight: 86, slots: WEAPON_SLOTS, fmt: '+{p}% weapon damage' },
  { id: 'hasty', name: 'of Haste', kind: 'suffix', space: 'derived', stat: 'reloadMod', mode: 'pct',
    min: 0.06, max: 0.22, tierScale: 0.038, weight: 92, slots: [...WEAPON_SLOTS, 'arms'], fmt: '+{p}% reload speed' },
  { id: 'ammobelt', name: 'of the Belt', kind: 'suffix', space: 'derived', stat: 'ammoMod', mode: 'pct',
    min: 0.10, max: 0.38, tierScale: 0.05, weight: 78, slots: WEAPON_SLOTS, fmt: '+{p}% magazine' },
  { id: 'anchored', name: 'Anchored', kind: 'prefix', space: 'part', stat: 'recoilControl', mode: 'flat',
    min: 8, max: 42, tierScale: 0.12, weight: 84, slots: ['arms'], fmt: '+{v} recoil control' },
  { id: 'spooled', name: 'Calibrated', kind: 'prefix', space: 'part', stat: 'firearmSpecialization', mode: 'flat',
    min: 5, max: 30, tierScale: 0.11, weight: 80, slots: ['arms'], fmt: '+{v} firearm spec.' },
  { id: 'whetted', name: 'of the Whetstone', kind: 'suffix', space: 'part', stat: 'meleeSpec', mode: 'flat',
    min: 6, max: 34, tierScale: 0.12, weight: 70, slots: ['arms'], fmt: '+{v} melee spec.' },

  // --- special / proc -------------------------------------------------------
  { id: 'surge', name: 'of Surge', kind: 'suffix', space: 'special', stat: 'onStaggerEN', mode: 'flat',
    min: 90, max: 380, tierScale: 0.18, weight: 46, fmt: 'On stagger: restore {v} EN' },
  { id: 'reaper', name: 'of the Reaper', kind: 'suffix', space: 'special', stat: 'onKillSpeed', mode: 'pct',
    min: 0.08, max: 0.26, tierScale: 0.04, weight: 42, fmt: 'On kill: +{p}% speed for 3s' },
  { id: 'scavenger', name: 'of Scavengers', kind: 'suffix', space: 'special', stat: 'onKillAP', mode: 'flat',
    min: 40, max: 260, tierScale: 0.18, weight: 40, fmt: 'On kill: repair {v} AP' },
  { id: 'backlash', name: 'of Backlash', kind: 'suffix', space: 'special', stat: 'onStaggerBurst', mode: 'flat',
    min: 120, max: 620, tierScale: 0.2, weight: 34, fmt: 'On stagger: {v} energy burst around the target' },
  { id: 'overpressure', name: 'of Overpressure', kind: 'suffix', space: 'special', stat: 'lowACSDamage', mode: 'pct',
    min: 0.08, max: 0.28, tierScale: 0.042, weight: 36, fmt: '+{p}% damage while your own ACS is below 50%' },
  { id: 'vanguard', name: 'of the Vanguard', kind: 'suffix', space: 'special', stat: 'assaultBoostDamage', mode: 'pct',
    min: 0.12, max: 0.44, tierScale: 0.06, weight: 34, fmt: '+{p}% damage during assault boost' },
  { id: 'reserves', name: 'of Deep Reserves', kind: 'suffix', space: 'special', stat: 'lowAPRecharge', mode: 'pct',
    min: 0.15, max: 0.55, tierScale: 0.07, weight: 32, fmt: '+{p}% EN recharge below 30% AP' },
  { id: 'recoilnull', name: 'of Null Recoil', kind: 'suffix', space: 'special', stat: 'armsOverloadRelief', mode: 'pct',
    min: 0.20, max: 0.70, tierScale: 0.08, weight: 30, slots: ['arms', 'core'], fmt: 'Arms overload penalty reduced {p}%' },
  { id: 'ballast', name: 'of Ballast', kind: 'suffix', space: 'special', stat: 'overweightRelief', mode: 'pct',
    min: 0.15, max: 0.55, tierScale: 0.07, weight: 30, slots: ['legs', 'booster'], fmt: 'Overweight speed penalty reduced {p}%' },
  { id: 'coolant', name: 'of Coolant', kind: 'suffix', space: 'special', stat: 'staggerDurationCut', mode: 'pct',
    min: 0.08, max: 0.26, tierScale: 0.04, weight: 34, slots: ['head', 'core'], fmt: 'Your stagger recovery {p}% faster' },
];

export const AFFIX_BY_ID = Object.freeze(
  AFFIXES.reduce((acc, a) => { acc[a.id] = a; return acc; }, {})
);

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

/** Stats that get *worse* when the roll multiplier goes up (mass, draw). */
const INVERSE_STATS = new Set(['weight', 'enLoad', 'qbENConsumption', 'qbReloadTime']);

/**
 * Budget stats. These deliberately do NOT grow with world tier.
 *
 * Weight and EN load do not inflate with tier either, so if load limit and EN
 * output did, the three overload constraints would stop binding by tier 6 and
 * every build would converge. Keeping the budget flat means a tier-12 legendary
 * bazooka is a genuinely painful thing to fit — which is the entire point.
 */
const BUDGET_STATS = new Set(['loadLimit', 'armsLoadLimit', 'enOutput']);

/** Percentage-adjustment stats: scale the deviation from the pivot, not the value. */
const ADJUST_STATS = { damageMod: 1, impactMod: 1, ammoMod: 1, boosterEfficiency: 100, generatorOutputAdj: 100 };

const _partCounter = { n: 0 };

function toRng(rng) {
  if (typeof rng === 'function') return rng;
  if (typeof rng === 'number') return mulberry32(rng >>> 0);
  return Math.random;
}

/** Stable 32-bit hash of a string — used for preview seeds. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Rarity weights for a world tier. Each step up the ladder gains multiplicatively
 * with tier, so tier 1 is a sea of grey and tier 10 genuinely showers epics.
 * @param {number} tier
 * @param {number} [luck] extra ladder pressure (boss drops pass 1..3)
 */
export function rarityWeights(tier = 1, luck = 0) {
  const factor = 1 + 0.20 * (clamp(tier, 1, 14) - 1) + 0.28 * luck;
  const out = [];
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    out.push(RARITY[RARITY_ORDER[i]].weight * Math.pow(factor, i));
  }
  return out;
}

/** @returns {string} rarity id */
export function rollRarity(tier, rand, { floor = null, luck = 0 } = {}) {
  const w = rarityWeights(tier, luck);
  const floorIdx = floor ? (RARITY[floor]?.index ?? 0) : 0;
  let total = 0;
  for (let i = floorIdx; i < w.length; i++) total += w[i];
  let r = rand() * total;
  for (let i = floorIdx; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) return RARITY_ORDER[i];
  }
  return RARITY_ORDER[floorIdx];
}

function eligibleBases(tier, slotFilter, allowUnique) {
  const slots = normaliseSlotFilter(slotFilter);
  const out = [];
  for (let i = 0; i < ALL_DEFS.length; i++) {
    const d = ALL_DEFS[i];
    if (d.tier > tier) continue;
    if (d.unique && !allowUnique) continue;
    if (slots) {
      let ok = false;
      for (let s = 0; s < d.slots.length; s++) if (slots.indexOf(d.slots[s]) >= 0) { ok = true; break; }
      if (!ok) continue;
    }
    out.push(d);
  }
  return out;
}

function normaliseSlotFilter(slotFilter) {
  if (!slotFilter || slotFilter === 'any') return null;
  if (slotFilter === 'frame') return FRAME_SLOTS;
  if (slotFilter === 'internal') return INTERNAL_SLOTS;
  if (slotFilter === 'weapon') return WEAPON_SLOTS;
  if (Array.isArray(slotFilter)) return slotFilter;
  return [slotFilter];
}

function pickBase(list, tier, rand) {
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    // Junk tiers fade out slowly as the world tier climbs — never fully gone,
    // because a legendary roll on a starter chassis is a good story.
    const spread = Math.max(0, tier - d.tier - 2);
    total += d.pick * Math.pow(0.86, spread);
  }
  let r = rand() * total;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const spread = Math.max(0, tier - d.tier - 2);
    r -= d.pick * Math.pow(0.86, spread);
    if (r <= 0) return d;
  }
  return list[list.length - 1];
}

function pickAffixes(slot, count, rand, taken) {
  const chosen = [];
  if (count <= 0) return chosen;
  const pool = [];
  let total = 0;
  for (let i = 0; i < AFFIXES.length; i++) {
    const a = AFFIXES[i];
    if (a.slots && a.slots.indexOf(slot) < 0) continue;
    pool.push(a);
    total += a.weight;
  }
  for (let n = 0; n < count && pool.length; n++) {
    let r = rand() * total;
    let picked = null;
    let pickedIdx = -1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) { picked = pool[i]; pickedIdx = i; break; }
    }
    if (!picked) { picked = pool[pool.length - 1]; pickedIdx = pool.length - 1; }
    total -= picked.weight;
    pool.splice(pickedIdx, 1);
    if (taken.has(picked.id)) continue; // caller pre-excluded this line
    taken.add(picked.id);
    chosen.push(picked);
  }
  return chosen;
}

/**
 * Roll a concrete affix instance.
 * Value = lerp(min,max,roll) * tierGrowth * rarityBudget, rounded per mode.
 */
function rollAffixValue(def, tier, rand, budget) {
  const t = clamp(tier, 1, 14);
  const growth = 1 + (t - 1) * (def.tierScale ?? 0.05);
  const raw = lerp(def.min, def.max, rand()) * growth * budget;
  if (def.mode === 'flat') {
    const mag = Math.abs(raw);
    const rounded = mag >= 100 ? Math.round(raw / 5) * 5 : Math.round(raw);
    return rounded === 0 ? (raw < 0 ? -1 : 1) : rounded;
  }
  return Math.round(raw * 1000) / 1000;
}

function formatAffix(def, value) {
  const p = Math.round(Math.abs(value) * 1000) / 10;
  return (def.fmt || '{v}')
    .replace('{v}', String(Math.abs(Math.round(value * 100) / 100)))
    .replace('{p}', (def.sign === -1 ? '-' : '') + p);
}

/**
 * A rolled part instance.
 * Deliberately a plain-ish class: it must survive JSON round-tripping.
 */
export class Part {
  constructor(o) {
    this.id = o.id;
    this.baseId = o.baseId;
    this.name = o.name;
    this.slot = o.slot;
    this.slots = o.slots;
    this.rarity = o.rarity;
    this.tier = o.tier;
    this.stats = o.stats;
    this.affixes = o.affixes;
    this.seed = o.seed;
    this.description = o.description;
    this.mfr = o.mfr;
    this.role = o.role;
    if (o.weaponId) this.weaponId = o.weaponId;
    if (o.legType) this.legType = o.legType;
    if (o.uniqueEffect) this.uniqueEffect = o.uniqueEffect;
    this.unique = !!o.uniqueEffect;
  }

  /** Rarity descriptor (colour, presentation, budget). */
  get rarityDef() { return RARITY[this.rarity] || RARITY.common; }
  get color() { return this.rarityDef.color; }
  get isWeapon() { return WEAPON_SLOTS.indexOf(this.slot) >= 0; }
  get isFrame() { return FRAME_SLOTS.indexOf(this.slot) >= 0; }

  /** Can this part legally sit in `slot`? Weapons often fit several mounts. */
  fits(slot) { return this.slots ? this.slots.indexOf(slot) >= 0 : this.slot === slot; }

  /** One-line summary for compact HUD toasts. */
  get shortLabel() { return `${this.rarityDef.label} · ${SLOT_LABELS[this.slot] || this.slot}`; }

  toJSON() {
    return {
      id: this.id, baseId: this.baseId, name: this.name, slot: this.slot, slots: this.slots,
      rarity: this.rarity, tier: this.tier, stats: this.stats,
      affixes: this.affixes, seed: this.seed, description: this.description,
      mfr: this.mfr, role: this.role,
      weaponId: this.weaponId, legType: this.legType, uniqueEffect: this.uniqueEffect,
    };
  }

  static fromJSON(o) {
    if (!o || !o.baseId) return null;
    return new Part(o);
  }
}

/**
 * Roll a complete part.
 *
 * @param {number}   tier        world tier, 1..14. Drives rarity pressure and stat growth.
 * @param {Function|number} [rng] mulberry32 instance, a seed, or omitted for Math.random.
 * @param {string|string[]} [slotFilter] restrict to slot(s); also accepts
 *        'frame' | 'internal' | 'weapon' | 'any'.
 * @param {object}   [opts]
 * @param {string}   [opts.rarityFloor] minimum rarity id
 * @param {number}   [opts.luck]        extra rarity pressure (0..3)
 * @param {string}   [opts.baseId]      force a specific base def
 * @param {string}   [opts.rarity]      force a rarity
 * @param {boolean}  [opts.allowUnique] default true
 * @returns {Part}
 */
export function rollPart(tier = 1, rng = Math.random, slotFilter = null, opts = {}) {
  const outer = toRng(rng);

  // One seed drives the entire roll, so a part is reproducible from
  // (seed, tier) alone — the garage preview and the world drop always agree.
  const seed = (outer() * 4294967295) >>> 0;
  const rand = mulberry32(seed);

  const t = clamp(Math.round(tier) || 1, 1, 14);
  const luck = opts.luck || 0;
  const rarity = opts.rarity && RARITY[opts.rarity]
    ? opts.rarity
    : rollRarity(t, rand, { floor: opts.rarityFloor, luck });
  const rDef = RARITY[rarity];

  const allowUnique = opts.allowUnique !== false && rDef.index >= UNIQUE_MIN_RARITY;

  let base = opts.baseId ? PART_DEFS[opts.baseId] : null;
  if (!base) {
    let pool = eligibleBases(t, slotFilter, allowUnique);
    if (!pool.length) pool = eligibleBases(14, slotFilter, allowUnique);
    if (!pool.length) pool = ALL_DEFS;
    // At legendary+ bias hard toward the named uniques — that is the payoff.
    if (allowUnique && rand() < 0.42) {
      const uniques = pool.filter((d) => d.unique);
      if (uniques.length) pool = uniques;
    }
    base = pickBase(pool, t, rand);
  }

  // Concrete mount for multi-slot weapons.
  const filterSlots = normaliseSlotFilter(slotFilter);
  let slot = base.slots[0];
  if (filterSlots) {
    for (let i = 0; i < base.slots.length; i++) {
      if (filterSlots.indexOf(base.slots[i]) >= 0) { slot = base.slots[i]; break; }
    }
  } else if (base.slots.length > 1) {
    slot = base.slots[(rand() * base.slots.length) | 0];
  }

  // --- stat roll -----------------------------------------------------------
  const rollMul = lerp(rDef.roll[0], rDef.roll[1], rand());
  const tierGrowth = 1 + (t - 1) * 0.075;              // beneficial stats climb with tier
  const inverseMul = clamp(2 - rollMul, 0.78, 1.08);    // a good roll is also a lighter one

  const stats = {};
  for (const k in base.stats) {
    const v = base.stats[k];
    if (INVERSE_STATS.has(k)) {
      stats[k] = k === 'qbReloadTime'
        ? Math.round(v * inverseMul * 1000) / 1000
        : Math.round(v * inverseMul);
    } else if (k in ADJUST_STATS) {
      // Percentage adjustments sit around a pivot (100 / 1.0). Scale the deviation,
      // not the value, or a legendary core would read as +50% generator output.
      const pivot = ADJUST_STATS[k];
      stats[k] = Math.round((v + pivot * (rollMul - 1) * 0.55) * 1000) / 1000;
    } else if (BUDGET_STATS.has(k)) {
      stats[k] = Math.round(v * rollMul);
    } else {
      stats[k] = Math.round(v * rollMul * tierGrowth * 100) / 100;
    }
  }

  // --- affixes -------------------------------------------------------------
  const [aMin, aMax] = rDef.affixes;
  const count = aMin + ((rand() * (aMax - aMin + 1)) | 0);
  const taken = new Set();
  const defs = pickAffixes(slot, count, rand, taken);
  const affixes = [];
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const value = rollAffixValue(d, t, rand, rDef.statBudget);
    affixes.push({
      id: d.id, name: d.name, kind: d.kind, space: d.space, stat: d.stat,
      mode: d.mode, value, text: formatAffix(d, value),
    });
  }

  // --- identity ------------------------------------------------------------
  let name = base.name;
  if (!base.unique) {
    const pre = affixes.find((a) => a.kind === 'prefix');
    const suf = affixes.find((a) => a.kind === 'suffix');
    if (pre) name = `${pre.name} ${name}`;
    if (suf) name = `${name} ${suf.name.startsWith('of ') ? suf.name : `of ${suf.name}`}`;
  }
  if (rDef.index >= 5) name = `${name} [PROTO]`;

  const id = `p${(_partCounter.n++).toString(36)}_${seed.toString(36)}`;

  const description = base.unique && base.uniqueEffect
    ? `${base.desc}\n✦ ${base.uniqueEffect.text}`
    : base.desc;

  return new Part({
    id, baseId: base.id, name, slot, slots: base.slots.slice(),
    rarity, tier: t, stats, affixes, seed, description,
    mfr: base.mfr, role: base.role,
    weaponId: base.weaponId, legType: base.legType,
    uniqueEffect: base.uniqueEffect,
  });
}

/**
 * Build a part from a known base at a fixed rarity — used for the starter build
 * and for anything that must be byte-identical every session.
 */
export function makePart(baseId, { rarity = 'common', tier = 1, seed = null, affixIds = [] } = {}) {
  const base = PART_DEFS[baseId];
  if (!base) return null;
  const s = seed == null ? hashString(`${baseId}:${rarity}:${tier}`) : (seed >>> 0);
  const part = rollPart(tier, mulberry32(s), base.slots[0], { baseId, rarity, allowUnique: true });
  if (affixIds.length) {
    const rand = mulberry32(s ^ 0x5bf03635);
    part.affixes = affixIds.map((aid) => {
      const d = AFFIX_BY_ID[aid];
      if (!d) return null;
      const value = rollAffixValue(d, tier, rand, RARITY[rarity].statBudget);
      return { id: d.id, name: d.name, kind: d.kind, space: d.space, stat: d.stat, mode: d.mode, value, text: formatAffix(d, value) };
    }).filter(Boolean);
  }
  return part;
}

/** Convenience for HUD toasts / audio pitch. */
export function rarityRank(rarity) { return RARITY[rarity]?.index ?? 0; }

export default {
  SLOTS, FRAME_SLOTS, INTERNAL_SLOTS, WEAPON_SLOTS, ARM_WEAPON_SLOTS,
  SLOT_LABELS, LEG_TYPES, LEG_TYPE_MODS,
  RARITY, RARITY_ORDER, AFFIXES, AFFIX_BY_ID,
  PART_DEFS, PART_LIST, PARTS_BY_SLOT, PART_COUNTS,
  Part, rollPart, makePart, rollRarity, rarityWeights, rarityRank, hashString,
};
