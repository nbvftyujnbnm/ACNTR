import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, mulberry32 } from '../core/MathUtils.js';

/**
 * ACNTR arsenal.
 *
 * Every weapon lives on the same two-axis economy that drives AC6 combat:
 *   damage  → strips AP (the health bar)
 *   impact  → fills the ACS / stagger gauge
 *
 * The interesting builds come from mixing the two. Kinetic rifles are damage-per-second
 * with almost no impact; shotguns, bazookas and shoulder cannons are impact bombs that
 * break a target open; energy weapons hit hard on raw damage and are the natural payload
 * for the stagger window they cannot open themselves.
 *
 * Numbers below are tuned against a ~11,000 AP / ~1,800 ACS reference mech.
 */

const _side = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Jitter a direction inside a cone. Uniform over the disc so shotgun patterns do not
 * clump in the middle.
 * @param {THREE.Vector3} dir normalized
 * @param {number} spread half-angle in radians
 * @param {function():number} rng
 * @param {THREE.Vector3} out
 */
export function coneSpread(dir, spread, rng, out) {
  out.copy(dir);
  if (!(spread > 0)) return out;
  _side.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.95) _side.set(1, 0, 0);
  _right.crossVectors(dir, _side).normalize();
  _up.crossVectors(_right, dir).normalize();
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * spread;
  out.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
  return out;
}

// ---------------------------------------------------------------------------
// WEAPON_DEFS
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WeaponDef
 * Fields consumed by Weapon + WeaponSystem + ProjectileManager. See _normalize() for
 * defaults; anything omitted from a def below is filled there.
 */

export const WEAPON_DEFS = {
  // ============================ ARM — KINETIC ==============================
  rifle_rf025: {
    id: 'rifle_rf025',
    name: 'RF-025 SCUDDER',
    category: 'rifle',
    slot: 'arm',
    blurb: 'Assault rifle. Steady AP attrition, negligible impact. The chip damage build.',
    trigger: 'auto',
    type: 'kinetic',
    damage: 108,
    impact: 62,
    fireRate: 3.8,
    magazine: 24,
    reloadTime: 2.2,
    ammo: 480,
    spread: 0.0075,
    spreadBloom: 0.004,
    spreadMax: 0.026,
    projectileSpeed: 640,
    recoil: 0.32,
    heat: 0.028,
    weight: 4100,
    muzzleOffset: { x: 0, y: 0, z: -1.35 },
    flashScale: 0.55,
    flashColor: 0xffc474,
    sfx: 'rifle',
    projectile: {
      kind: 'bullet',
      radius: 0.16,
      life: 2.6,
      color: [3.4, 2.1, 0.9],
      width: 0.085,
      length: 5.5,
    },
  },

  rifle_lr: {
    id: 'rifle_lr',
    name: 'LR-037 HELICOIL',
    category: 'linear',
    slot: 'arm',
    blurb: 'Linear rifle. Coil-charged slug — hold to overcharge for a rail shot.',
    trigger: 'charge',
    chargeable: true,
    chargeTime: 1.1,
    chargeMin: 0.28,
    chargeDamageMul: 2.2,
    chargeImpactMul: 2.4,
    type: 'kinetic',
    damage: 224,
    impact: 132,
    fireRate: 0.62,
    magazine: 6,
    reloadTime: 3.1,
    ammo: 90,
    spread: 0.0012,
    projectileSpeed: 1500,
    chargeSpeedMul: 1.4,
    recoil: 1.45,
    chargeRecoilMul: 2.0,
    heat: 0.14,
    enCost: 40,
    chargeEnCost: 120,
    weight: 6300,
    muzzleOffset: { x: 0, y: 0, z: -1.9 },
    flashScale: 1.3,
    flashColor: 0x7fd8ff,
    sfx: 'linear',
    projectile: {
      kind: 'bullet',
      radius: 0.3,
      life: 2.2,
      color: [1.8, 4.6, 6.8],
      width: 0.16,
      length: 15,
      pierce: 1,
      chargePierce: 3,
      chargeWidthMul: 2.8,
      chargeLengthMul: 2.4,
      chargeRadiusMul: 2.1,
    },
  },

  shotgun_sg027: {
    id: 'shotgun_sg027',
    name: 'SG-027 ZIMMER',
    category: 'shotgun',
    slot: 'arm',
    blurb: 'Twelve pellets of pure stagger pressure. Useless past 60 m, decisive inside 25.',
    trigger: 'single',
    holdRepeat: true,
    type: 'kinetic',
    damage: 58,
    impact: 26,
    pellets: 12,
    fireRate: 0.85,
    magazine: 6,
    reloadTime: 2.9,
    ammo: 108,
    spread: 0.085,
    projectileSpeed: 430,
    recoil: 1.35,
    heat: 0.1,
    weight: 7400,
    muzzleOffset: { x: 0, y: 0, z: -1.15 },
    flashScale: 1.5,
    flashColor: 0xffb257,
    sfx: 'shotgun',
    projectile: {
      kind: 'pellet',
      radius: 0.13,
      life: 0.7,
      color: [3.2, 1.9, 0.7],
      width: 0.075,
      length: 3.2,
      falloff: { start: 34, end: 92, min: 0.22 },
    },
  },

  handgun_hg003: {
    id: 'handgun_hg003',
    name: 'HG-003 COQUILLE',
    category: 'handgun',
    slot: 'arm',
    blurb: 'Three-round burst. Fires clean while boosting — the mobile-build sidearm.',
    trigger: 'burst',
    holdRepeat: true,
    burst: 3,
    burstDelay: 0.075,
    type: 'kinetic',
    damage: 76,
    impact: 56,
    fireRate: 1.55,
    magazine: 12,
    reloadTime: 1.7,
    ammo: 288,
    spread: 0.013,
    projectileSpeed: 560,
    recoil: 0.5,
    heat: 0.05,
    weight: 2600,
    boostAccurate: true,
    muzzleOffset: { x: 0, y: 0, z: -0.85 },
    flashScale: 0.7,
    flashColor: 0xffd08a,
    sfx: 'handgun',
    projectile: {
      kind: 'bullet',
      radius: 0.15,
      life: 2.0,
      color: [3.6, 2.4, 1.0],
      width: 0.095,
      length: 5.0,
    },
  },

  gatling_gu_a2: {
    id: 'gatling_gu_a2',
    name: 'GU-A2 HU-BEN',
    category: 'gatling',
    slot: 'arm',
    blurb: 'Spins up, then hoses. Nothing per bullet, everything per second.',
    trigger: 'auto',
    type: 'kinetic',
    damage: 44,
    impact: 20,
    fireRate: 16,
    spinUpTime: 0.5,
    spinDownTime: 0.8,
    magazine: 320,
    reloadTime: 4.4,
    ammo: 1280,
    spread: 0.016,
    spreadBloom: 0.006,
    spreadMax: 0.042,
    projectileSpeed: 560,
    recoil: 0.09,
    heat: 0.011,
    weight: 8800,
    muzzleOffset: { x: 0, y: 0, z: -1.55 },
    flashScale: 0.42,
    flashColor: 0xffc060,
    sfx: 'gatling',
    projectile: {
      kind: 'bullet',
      radius: 0.12,
      life: 1.9,
      color: [3.0, 1.9, 0.8],
      width: 0.065,
      length: 4.2,
    },
  },

  // ============================ ARM — EXPLOSIVE ============================
  bazooka_mj24: {
    id: 'bazooka_mj24',
    name: 'MJ-24 MAJESTIC',
    category: 'bazooka',
    slot: 'arm',
    blurb: 'Arcing shell. Enormous impact — the fastest way to open a heavy target.',
    trigger: 'single',
    holdRepeat: true,
    type: 'explosive',
    damage: 640,
    impact: 620,
    fireRate: 0.5,
    magazine: 6,
    reloadTime: 4.0,
    ammo: 48,
    spread: 0.004,
    projectileSpeed: 135,
    recoil: 2.1,
    heat: 0.2,
    weight: 9600,
    muzzleOffset: { x: 0, y: 0, z: -1.6 },
    flashScale: 2.0,
    flashColor: 0xffa040,
    sfx: 'bazooka',
    projectile: {
      kind: 'shell',
      radius: 0.42,
      life: 7,
      gravity: 9.5,
      color: [4.5, 2.0, 0.5],
      width: 0.34,
      length: 1.7,
      splash: { radius: 9, damage: 260, impact: 300 },
      explosion: { radius: 9, power: 1.0 },
      trail: { color: [1.6, 1.0, 0.6], width: 0.5, rate: 40 },
    },
  },

  plasma_pr16: {
    id: 'plasma_pr16',
    name: 'PR-16 IRIDIUM',
    category: 'plasma',
    slot: 'arm',
    blurb: 'Lobs a plasma bolus that ruptures into a lingering ionisation field.',
    trigger: 'single',
    holdRepeat: true,
    type: 'energy',
    damage: 300,
    impact: 210,
    fireRate: 0.75,
    magazine: 5,
    reloadTime: 3.6,
    ammo: 60,
    spread: 0.006,
    projectileSpeed: 95,
    recoil: 0.85,
    heat: 0.16,
    enCost: 55,
    weight: 7100,
    muzzleOffset: { x: 0, y: 0, z: -1.3 },
    flashScale: 1.2,
    flashColor: 0x66ffe0,
    sfx: 'plasma',
    projectile: {
      kind: 'plasma',
      radius: 0.75,
      life: 5,
      gravity: 5.5,
      color: [1.1, 4.4, 3.8],
      light: { color: 0x5cffe0, intensity: 26, distance: 34 },
      splash: { radius: 7, damage: 140, impact: 120 },
      explosion: { radius: 7, power: 0.8, color: 0x66ffe0 },
      field: { duration: 3.0, radius: 6.5, dps: 110, impactPerSec: 70, tick: 0.25, color: [0.7, 3.4, 3.0] },
    },
  },

  laser_lr37: {
    id: 'laser_lr37',
    name: 'VP-66LR VESPER',
    category: 'laser',
    slot: 'arm',
    blurb: 'Sustained coherent beam. Charge builds while the trigger is down.',
    trigger: 'beam',
    chargeable: true,
    chargeTime: 1.25,
    chargeDamageMul: 2.4,
    chargeImpactMul: 1.8,
    type: 'energy',
    damage: 96,
    impact: 44,
    fireRate: 9,
    magazine: 60,
    reloadTime: 2.6,
    ammo: 600,
    spread: 0.0,
    projectileSpeed: 0, // hitscan
    range: 900,
    recoil: 0.18,
    heat: 0.055,
    coolRate: 0.5,
    enCost: 16,
    weight: 5400,
    muzzleOffset: { x: 0, y: 0, z: -1.5 },
    flashScale: 0.8,
    flashColor: 0xff3b6b,
    sfx: 'laser',
    projectile: {
      kind: 'beam',
      radius: 0.4,
      life: 0.16,
      color: [7.0, 1.2, 2.4],
      width: 0.14,
      chargeWidthMul: 3.6,
      chargeLifeMul: 2.6,
      chargeRadiusMul: 2.4,
      impactType: 'energy',
    },
  },

  // ============================ ARM — MELEE ================================
  pulse_blade: {
    id: 'pulse_blade',
    name: 'PB-033M ASHMEAD',
    category: 'melee',
    slot: 'arm',
    blurb: 'Lunging pulse blade. Two-hit combo, colossal impact, shreds energy shields.',
    trigger: 'melee',
    type: 'energy',
    pulse: true,
    damage: 520,
    impact: 360,
    fireRate: 0.95,
    magazine: 0,
    reloadTime: 0,
    ammo: Infinity,
    projectileSpeed: 0,
    recoil: 0.65,
    heat: 0.22,
    enCost: 190,
    weight: 3300,
    muzzleOffset: { x: 0, y: 0, z: -2.2 },
    flashScale: 1.6,
    flashColor: 0x9fd8ff,
    sfx: 'blade',
    melee: {
      reach: 17,
      radius: 4.6,
      dashDistance: 15,
      dashDuration: 0.24,
      windup: 0.1,
      active: 0.2,
      recovery: 0.3,
      combo: 2,
      comboWindow: 1.05,
      comboDamageMul: 1.38,
      comboImpactMul: 1.3,
      comboDashMul: 1.25,
    },
  },

  // ============================ SHOULDER ===================================
  missile_bml: {
    id: 'missile_bml',
    name: 'BML-G1 VERTICAL',
    category: 'missile',
    slot: 'shoulder',
    blurb: 'Six-cell vertical launch. Pops up, noses over, dives. Needs a lock.',
    trigger: 'single',
    holdRepeat: true,
    requiresLock: true,
    type: 'explosive',
    damage: 118,
    impact: 92,
    salvo: 6,
    salvoDelay: 0.07,
    salvoSpread: 0.1,
    fireRate: 0.45,
    magazine: 24,
    reloadTime: 3.8,
    ammo: 144,
    spread: 0.02,
    projectileSpeed: 165,
    recoil: 0.45,
    heat: 0.05,
    weight: 6200,
    muzzleOffset: { x: 0, y: 0.4, z: -0.2 },
    flashScale: 0.9,
    flashColor: 0xffb060,
    sfx: 'missile',
    projectile: {
      kind: 'missile',
      radius: 0.3,
      life: 8,
      color: [4.0, 2.2, 0.9],
      width: 0.22,
      length: 1.5,
      homing: {
        turnRate: 2.5,
        turnRateBoost: 3.4,
        fuse: 2.8,
        boostDelay: 0.5,
        launchSpeed: 26,
        launchUp: 0.92,
        accel: 190,
        maxSpeed: 175,
        leadStrength: 1.0,
      },
      splash: { radius: 5.5, damage: 62, impact: 54 },
      explosion: { radius: 5.5, power: 0.55 },
      trail: { color: [1.5, 1.0, 0.7], width: 0.34, rate: 55 },
    },
  },

  missile_swarm: {
    id: 'missile_swarm',
    name: 'BML-G2 SWARM',
    category: 'missile',
    slot: 'shoulder',
    blurb: 'Twelve light seekers in a fan. Fast, twitchy, relentless.',
    trigger: 'single',
    holdRepeat: true,
    requiresLock: true,
    type: 'explosive',
    damage: 62,
    impact: 40,
    salvo: 12,
    salvoDelay: 0.035,
    salvoSpread: 0.26,
    fireRate: 0.5,
    magazine: 36,
    reloadTime: 4.4,
    ammo: 216,
    spread: 0.05,
    projectileSpeed: 210,
    recoil: 0.28,
    heat: 0.03,
    weight: 5100,
    muzzleOffset: { x: 0, y: 0.35, z: -0.3 },
    flashScale: 0.7,
    flashColor: 0xffc884,
    sfx: 'missile',
    projectile: {
      kind: 'missile',
      radius: 0.22,
      life: 6.5,
      color: [4.2, 2.6, 1.2],
      width: 0.15,
      length: 1.05,
      homing: {
        turnRate: 3.4,
        turnRateBoost: 4.6,
        fuse: 2.2,
        boostDelay: 0.24,
        launchSpeed: 40,
        launchUp: 0.4,
        accel: 260,
        maxSpeed: 215,
        leadStrength: 0.85,
      },
      splash: { radius: 3.5, damage: 26, impact: 22 },
      explosion: { radius: 3.5, power: 0.35 },
      trail: { color: [1.4, 1.0, 0.8], width: 0.22, rate: 50 },
    },
  },

  cannon_earshot: {
    id: 'cannon_earshot',
    name: 'SONGBIRDS EARSHOT',
    category: 'cannon',
    slot: 'shoulder',
    blurb: 'Deploys, then removes a limb. Nothing in the arsenal breaks a target faster.',
    trigger: 'single',
    holdRepeat: true,
    needsDeploy: true,
    deployTime: 0.7,
    stowTime: 0.5,
    type: 'explosive',
    damage: 980,
    impact: 940,
    fireRate: 0.28,
    magazine: 4,
    reloadTime: 5.2,
    ammo: 28,
    spread: 0.0025,
    projectileSpeed: 320,
    recoil: 3.0,
    heat: 0.3,
    weight: 12400,
    muzzleOffset: { x: 0, y: 0.55, z: -1.0 },
    flashScale: 2.6,
    flashColor: 0xffa030,
    sfx: 'cannon',
    projectile: {
      kind: 'shell',
      radius: 0.6,
      life: 7,
      gravity: 2.5,
      color: [5.0, 2.4, 0.8],
      width: 0.5,
      length: 2.4,
      splash: { radius: 14, damage: 420, impact: 400 },
      explosion: { radius: 14, power: 1.6 },
      trail: { color: [1.8, 1.1, 0.6], width: 0.7, rate: 45 },
    },
  },

  pulse_shield: {
    id: 'pulse_shield',
    name: 'IA-C01W3 PULSE ARMOR',
    category: 'shield',
    slot: 'shoulder',
    blurb: 'Deployable pulse barrier. Eats everything inside its arc until the charge is gone.',
    trigger: 'deploy',
    type: 'energy',
    damage: 0,
    impact: 0,
    fireRate: 0.4,
    magazine: 0,
    reloadTime: 0,
    ammo: Infinity,
    projectileSpeed: 0,
    recoil: 0,
    heat: 0.1,
    enCost: 140,
    weight: 4400,
    muzzleOffset: { x: 0, y: 0.5, z: -0.3 },
    flashScale: 0,
    flashColor: 0x7fe0ff,
    sfx: 'shield',
    deployable: {
      mode: 'shield',
      duration: 6.0,
      cooldownTime: 9.0,
      absorb: 2400,
      arcDeg: 130,
      radius: 7.5,
      color: 0x66d8ff,
    },
  },

  orbit_pod: {
    id: 'orbit_pod',
    name: 'ORBT-A9 VESSEL',
    category: 'support',
    slot: 'shoulder',
    blurb: 'Releases two autonomous pods that orbit and suppress the locked target.',
    trigger: 'deploy',
    type: 'energy',
    damage: 42,
    impact: 18,
    fireRate: 0.35,
    magazine: 0,
    reloadTime: 0,
    ammo: Infinity,
    projectileSpeed: 520,
    recoil: 0,
    heat: 0.08,
    enCost: 110,
    weight: 3900,
    muzzleOffset: { x: 0, y: 0.6, z: 0.1 },
    flashScale: 0.35,
    flashColor: 0x9fe8ff,
    sfx: 'pod',
    deployable: {
      mode: 'drones',
      duration: 9.0,
      cooldownTime: 12.0,
      count: 2,
      droneFireRate: 4,
      orbitRadius: 6.5,
      orbitSpeed: 1.9,
      range: 320,
    },
    projectile: {
      kind: 'bullet',
      radius: 0.13,
      life: 1.6,
      color: [1.6, 3.6, 5.2],
      width: 0.07,
      length: 4.0,
    },
  },
};

export const WEAPON_IDS = Object.keys(WEAPON_DEFS);

/** @returns {WeaponDef|null} */
export function getWeaponDef(id) {
  return WEAPON_DEFS[id] || null;
}

/** Ids that fit a given hardpoint kind ('arm' | 'shoulder'). */
export function weaponIdsForSlot(kind) {
  return WEAPON_IDS.filter((id) => WEAPON_DEFS[id].slot === kind);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const PROJECTILE_DEFAULTS = {
  kind: 'bullet',
  radius: 0.15,
  life: 3,
  gravity: 0,
  color: [3, 2, 1],
  width: 0.09,
  length: 5,
  pierce: 0,
};

const _normalized = new Map();

function _normalize(raw) {
  let def = _normalized.get(raw.id);
  if (def) return def;
  const p = Object.assign({}, PROJECTILE_DEFAULTS, raw.projectile || {});
  def = Object.assign(
    {
      category: 'weapon',
      slot: 'arm',
      trigger: 'single',
      holdRepeat: false,
      type: 'kinetic',
      pulse: false,
      damage: 0,
      impact: 0,
      pellets: 1,
      burst: 0,
      burstDelay: 0.07,
      salvo: 0,
      salvoDelay: 0.06,
      salvoSpread: 0.1,
      fireRate: 1,
      magazine: 0,
      reloadTime: 0,
      ammo: Infinity,
      spread: 0,
      spreadBloom: 0,
      spreadMax: 0,
      spreadRecover: 3.5,
      projectileSpeed: 400,
      range: 1400,
      recoil: 0.4,
      heat: 0,
      coolRate: 0.45,
      enCost: 0,
      chargeEnCost: 0,
      chargeable: false,
      chargeTime: 1,
      chargeMin: 0.25,
      chargeDamageMul: 2,
      chargeImpactMul: 2,
      chargeSpeedMul: 1,
      chargeRecoilMul: 1.6,
      needsDeploy: false,
      deployTime: 0,
      stowTime: 0.4,
      spinUpTime: 0,
      spinDownTime: 0.5,
      requiresLock: false,
      weight: 4000,
      muzzleOffset: { x: 0, y: 0, z: -1 },
      flashScale: 0.7,
      flashColor: 0xffc080,
      sfx: 'rifle',
      melee: null,
      deployable: null,
    },
    raw
  );
  def.projectile = p;
  def.shotInterval = def.fireRate > 0 ? 1 / def.fireRate : 0.25;
  /** total damage/impact a single trigger pull puts downrange (HUD + build maths) */
  def.burstDamage = def.damage * (def.pellets || 1) * (def.salvo || def.burst || 1);
  def.burstImpact = def.impact * (def.pellets || 1) * (def.salvo || def.burst || 1);
  def.dps = def.burstDamage * def.fireRate;
  def.ips = def.burstImpact * def.fireRate;
  _normalized.set(raw.id, def);
  return def;
}

// ---------------------------------------------------------------------------
// Weapon
// ---------------------------------------------------------------------------

let _weaponSeed = 0x5eed;

/**
 * A live weapon instance. Owns its own ammo / heat / charge / cycle state and knows
 * how to put rounds downrange; it does NOT know where the muzzle is or what it is
 * aiming at — WeaponSystem supplies that through the `ctx` object each frame.
 */
export class Weapon {
  /** @param {WeaponDef} def normalized definition */
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.slot = null; // assigned by WeaponSystem ('rArm' | 'lArm' | ...)

    this.cooldown = 0;
    this.charge = 0;
    this.charging = false;
    this._chargeFull = false;
    this.heat = 0;
    this.overheated = false;
    this.magLeft = def.magazine > 0 ? def.magazine : Infinity;
    this.ammoLeft = def.ammo;
    this.reloading = false;
    this.reloadT = 0;
    this.spin = 0;
    this.deploy = def.needsDeploy ? 0 : 1;
    this.deploying = false;
    this.queued = 0; // burst / salvo rounds still to leave the tube
    this.queueT = 0;
    this.queueIndex = 0;
    this.bloom = 0;
    this.firing = false;
    this.wantFire = false;
    this.comboIndex = 0;
    this.comboT = 0;
    this.meleeT = 0;
    this.deployTimer = 0;
    this.deployCooldown = 0;
    this.deployActive = false;
    this.shotsFired = 0;
    this.lastShotAt = -999;
    this.time = 0;
    this.uiFlash = 0;
    this.blocked = ''; // why it will not fire, for the HUD ('' | 'reload' | 'heat' | 'en' | 'lock' | 'ammo')

    this.rng = mulberry32((_weaponSeed = (_weaponSeed * 1664525 + 1013904223) >>> 0));
    // mutable projectile description handed to ProjectileManager.spawn(); the manager
    // copies out of it immediately, so one instance per weapon is safe and allocation-free
    this._pdef = {};
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
  }

  // ------------------------------------------------------------- accessors

  /** 0..1 reload progress for the HUD ring. */
  get reloadProgress() {
    return this.reloading && this.def.reloadTime > 0 ? 1 - this.reloadT / this.def.reloadTime : 1;
  }
  get magazine() {
    return this.def.magazine;
  }
  get chargeReady() {
    return this.charge >= this.def.chargeMin;
  }
  get spinRatio() {
    return this.def.spinUpTime > 0 ? clamp(this.spin, 0, 1) : 1;
  }
  get isMelee() {
    return this.def.trigger === 'melee';
  }
  get isDeployable() {
    return this.def.trigger === 'deploy';
  }
  /** True when a trigger pull would produce a shot right now. */
  get ready() {
    return this.cooldown <= 0 && !this.reloading && !this.overheated && this.magLeft > 0 && this.deploy >= 1;
  }

  // --------------------------------------------------------------- update

  /**
   * Advance timers and, when `ctx` carries trigger state, drive the fire logic.
   * @param {number} dt
   * @param {object} ctx supplied by WeaponSystem (origin/dir/target/held/pressed/released)
   */
  update(dt, ctx) {
    const d = this.def;
    this.time += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.uiFlash > 0) this.uiFlash -= dt * 5;
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.comboIndex = 0;
    }
    if (this.meleeT > 0) this.meleeT -= dt;
    if (this.deployCooldown > 0) this.deployCooldown -= dt;

    // heat bleed
    if (this.heat > 0) {
      this.heat = Math.max(0, this.heat - d.coolRate * dt);
      if (this.overheated && this.heat <= 0.32) this.overheated = false;
    }

    // spread bloom recovery
    if (this.bloom > 0) this.bloom = Math.max(0, this.bloom - d.spreadRecover * dt * (d.spreadMax || 0.03));

    // reload
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this._finishReload();
    }

    // deploy / stow
    if (d.needsDeploy) {
      const want = ctx && (ctx.held || ctx.pressed || this.queued > 0);
      const rate = want ? (d.deployTime > 0 ? dt / d.deployTime : 1) : -(d.stowTime > 0 ? dt / d.stowTime : 1);
      const prev = this.deploy;
      this.deploy = clamp(this.deploy + rate, 0, 1);
      this.deploying = want && this.deploy < 1;
      if (prev < 1 && this.deploy >= 1) {
        bus.emit('combat:weaponDeployed', { weapon: this, slot: this.slot });
        bus.emit(EV.SFX, { id: 'deploy', position: ctx?.origin || null });
      }
    }

    // gatling spin — the SFX fires once on spool-up, never per frame
    if (d.spinUpTime > 0) {
      const want = ctx && ctx.held && !this.reloading && !this.overheated && this.magLeft > 0;
      const prev = this.spin;
      this.spin = clamp(this.spin + (want ? dt / d.spinUpTime : -dt / d.spinDownTime), 0, 1);
      if (want && prev <= 0.001 && this.spin > 0.001) {
        bus.emit(EV.SFX, { id: 'gatling_spin', slot: this.slot, weapon: this.id });
      }
      if (want && this.spin < 1) this.blocked = 'spin';
    }

    // queued burst / salvo rounds keep leaving the tube even if the trigger is released
    if (this.queued > 0) {
      this.queueT -= dt;
      while (this.queued > 0 && this.queueT <= 0) {
        if (ctx) this._shot(ctx, this.charge, this.queueIndex);
        this.queueIndex++;
        this.queued--;
        this.queueT += d.salvo > 0 ? d.salvoDelay : d.burstDelay;
      }
      if (this.queued <= 0) this.charge = 0;
    }

    // deployable lifetime
    if (this.deployActive) {
      this.deployTimer -= dt;
      if (this.deployTimer <= 0) {
        this.deployActive = false;
        this.deployCooldown = d.deployable?.cooldownTime || 8;
        ctx?.system?._onDeployEnd?.(this, ctx);
      }
    }

    if (!ctx) return;

    // ---- trigger state machine -------------------------------------------
    const trig = d.trigger;
    this.firing = false;
    if (trig === 'auto') {
      if (ctx.held) this.tryFire(ctx);
    } else if (trig === 'charge') {
      // begin spooling as soon as the trigger is down AND the weapon is able to shoot,
      // so holding through a reload charges the moment the mag seats
      if (ctx.held && !this.charging && this.ready) {
        this.charging = true;
        this.charge = 0;
        this._chargeFull = false;
        bus.emit(EV.SFX, { id: 'charge_start', slot: this.slot, weapon: this.id });
      }
      if (this.charging) {
        if (ctx.held) {
          this.charge = clamp(this.charge + dt / d.chargeTime, 0, 1);
          if (!this._chargeFull && this.charge >= 1) {
            this._chargeFull = true;
            bus.emit(EV.SFX, { id: 'charge_full', slot: this.slot, weapon: this.id });
          }
        } else {
          this.release(ctx);
        }
      }
    } else if (trig === 'beam') {
      if (ctx.held) {
        this.charge = clamp(this.charge + dt / d.chargeTime, 0, 1);
        this.tryFire(ctx);
      } else if (this.charge > 0) {
        this.charge = Math.max(0, this.charge - dt / (d.chargeTime * 0.5));
      }
    } else if (trig === 'deploy') {
      if (ctx.pressed) this.tryFire(ctx);
    } else if (trig === 'melee') {
      if (ctx.pressed) this.tryFire(ctx);
    } else {
      // 'single' | 'burst'
      if (ctx.pressed || (d.holdRepeat && ctx.held)) this.tryFire(ctx);
    }

    // auto-reload when the mag runs dry
    if (!this.reloading && this.magLeft <= 0 && d.magazine > 0 && this.ammoLeft > 0 && this.queued <= 0) {
      this.reload();
    }
  }

  // ----------------------------------------------------------------- fire

  /**
   * Attempt to start a fire action.
   * @param {object} ctx
   * @returns {boolean} true if the weapon committed to a shot
   */
  tryFire(ctx) {
    const d = this.def;
    this.blocked = '';

    if (this.isDeployable) return this._tryDeploy(ctx);

    if (this.cooldown > 0) return false;
    if (this.reloading) {
      this.blocked = 'reload';
      return false;
    }
    if (this.overheated) {
      this.blocked = 'heat';
      return false;
    }
    if (this.magLeft <= 0) {
      this.blocked = this.ammoLeft > 0 ? 'reload' : 'ammo';
      if (this.ammoLeft > 0) this.reload();
      return false;
    }
    if (d.needsDeploy && this.deploy < 1) {
      this.blocked = 'deploy';
      return false;
    }
    if (d.spinUpTime > 0 && this.spin < 1) {
      this.blocked = 'spin';
      return false;
    }
    if (d.requiresLock && (ctx?.lockProgress ?? 0) < 1) {
      this.blocked = 'lock';
      return false;
    }
    const enCost = d.enCost;
    if (enCost > 0) {
      const st = ctx?.owner?.stats;
      if (st && typeof st.en === 'number') {
        if (st.en < enCost) {
          this.blocked = 'en';
          return false;
        }
        st.en -= enCost;
      }
    }

    if (this.isMelee) return this._swing(ctx);

    // commit
    this.cooldown = d.shotInterval;
    this.firing = true;
    this.uiFlash = 1;

    if (d.salvo > 0) {
      this.queued = d.salvo;
      this.queueIndex = 0;
      this.queueT = 0;
      return true;
    }
    if (d.burst > 0) {
      this.queued = d.burst;
      this.queueIndex = 0;
      this.queueT = 0;
      return true;
    }
    this._shot(ctx, this.charge, 0);
    return true;
  }

  /** Trigger release — fires chargeables. */
  release(ctx) {
    const d = this.def;
    if (!this.charging) return false;
    this.charging = false;
    this._chargeFull = false;
    const c = this.charge;
    this.charge = 0;
    if (this.cooldown > 0 || this.reloading || this.overheated || this.magLeft <= 0) return false;
    if (d.chargeEnCost > 0 && c >= d.chargeMin) {
      const st = ctx?.owner?.stats;
      if (st && typeof st.en === 'number') {
        const extra = d.chargeEnCost - d.enCost;
        if (extra > 0) st.en = Math.max(0, st.en - extra);
      }
    }
    this.cooldown = d.shotInterval * (c >= d.chargeMin ? 1.35 : 1);
    this.firing = true;
    this.uiFlash = 1;
    this._shot(ctx, c >= d.chargeMin ? c : 0, 0);
    return true;
  }

  /** Begin a reload if there is reserve ammunition. */
  reload() {
    const d = this.def;
    if (this.reloading || d.magazine <= 0) return false;
    if (this.magLeft >= d.magazine) return false;
    if (!(this.ammoLeft > 0)) return false;
    this.reloading = true;
    this.reloadT = d.reloadTime;
    this.charging = false;
    this.charge = 0;
    bus.emit(EV.SFX, { id: 'reload', weapon: this.id, slot: this.slot });
    return true;
  }

  _finishReload() {
    const d = this.def;
    this.reloading = false;
    this.reloadT = 0;
    const need = d.magazine - this.magLeft;
    const take = Math.min(need, this.ammoLeft);
    this.magLeft += take;
    if (isFinite(this.ammoLeft)) this.ammoLeft -= take;
  }

  // ------------------------------------------------------------- internals

  /**
   * Put one round (or one pellet spread, or one salvo missile) downrange.
   * @param {object} ctx
   * @param {number} chargeAmt 0..1
   * @param {number} index index within a burst/salvo
   */
  _shot(ctx, chargeAmt, index) {
    const d = this.def;
    const pm = ctx?.projectiles;
    const charged = d.chargeable && chargeAmt >= d.chargeMin;
    const cm = charged ? chargeAmt : 0;

    const dmgMul = charged ? 1 + (d.chargeDamageMul - 1) * cm : 1;
    const impMul = charged ? 1 + (d.chargeImpactMul - 1) * cm : 1;
    const spdMul = charged ? 1 + (d.chargeSpeedMul - 1) * cm : 1;

    // ---- build the projectile description (reused object, no allocation) ---
    const src = d.projectile;
    const p = this._pdef;
    p.kind = src.kind;
    p.type = d.type;
    p.pulse = !!d.pulse;
    p.damage = d.damage * dmgMul;
    p.impact = d.impact * impMul;
    p.speed = d.projectileSpeed * spdMul;
    p.life = src.life * (charged && src.chargeLifeMul ? src.chargeLifeMul : 1);
    p.radius = src.radius * (charged && src.chargeRadiusMul ? src.chargeRadiusMul : 1);
    p.width = src.width * (charged && src.chargeWidthMul ? src.chargeWidthMul : 1);
    p.length = src.length * (charged && src.chargeLengthMul ? src.chargeLengthMul : 1);
    p.color = src.color;
    p.gravity = src.gravity;
    p.pierce = charged && src.chargePierce ? src.chargePierce : src.pierce;
    p.splash = src.splash || null;
    p.explosion = src.explosion || null;
    p.field = src.field || null;
    p.homing = src.homing || null;
    p.trail = src.trail || null;
    p.light = src.light || null;
    p.falloff = src.falloff || null;
    p.range = d.range;
    p.charged = charged;
    p.chargeAmt = cm;
    p.weaponId = d.id;
    p.splashScale = charged ? 1 + cm * 0.5 : 1;

    // ---- direction ---------------------------------------------------------
    const baseSpread = (d.spread || 0) + this.bloom;
    const pellets = d.pellets || 1;
    const origin = this._origin.copy(ctx.origin);
    const aim = ctx.dir;

    if (src.homing) {
      // vertical-launch style: fly up first, guidance takes over after boostDelay
      const h = src.homing;
      const lateral = d.salvo > 1 ? ((index % 2 === 0 ? 1 : -1) * (0.35 + 0.65 * ((index / d.salvo) || 0))) : 0;
      this._dir.copy(aim).multiplyScalar(1 - h.launchUp);
      this._dir.addScaledVector(WORLD_UP, h.launchUp);
      _side.crossVectors(aim, WORLD_UP).normalize();
      if (!isFinite(_side.x)) _side.set(1, 0, 0);
      this._dir.addScaledVector(_side, lateral * (d.salvoSpread || 0.1) * 3.0);
      this._dir.addScaledVector(WORLD_UP, (this.rng() - 0.5) * 0.06);
      this._dir.normalize();
      p.speed = h.launchSpeed;
      pm?.spawn?.(p, origin, this._dir, ctx.owner, ctx.target || null);
    } else {
      for (let i = 0; i < pellets; i++) {
        coneSpread(aim, baseSpread, this.rng, this._dir);
        pm?.spawn?.(p, origin, this._dir, ctx.owner, ctx.target || null);
      }
    }

    // ---- costs -------------------------------------------------------------
    if (isFinite(this.magLeft)) this.magLeft = Math.max(0, this.magLeft - 1);
    this.shotsFired++;
    this.lastShotAt = this.time;
    if (d.heat > 0) {
      this.heat = clamp(this.heat + d.heat * (charged ? 1.8 : 1), 0, 1.2);
      if (this.heat >= 1) this.overheated = true;
    }
    if (d.spreadBloom > 0) this.bloom = Math.min(d.spreadMax || 0.03, this.bloom + d.spreadBloom);

    // ---- feedback ----------------------------------------------------------
    ctx.system?._onFired?.(this, ctx, charged ? 1 + cm : 1);
  }

  /** Melee swing — WeaponSystem owns the dash + hitbox, we own the cadence. */
  _swing(ctx) {
    const d = this.def;
    const m = d.melee;
    const combo = m ? m.combo : 1;
    const idx = this.comboIndex % combo;
    this.comboIndex = (this.comboIndex + 1) % combo;
    this.comboT = m ? m.comboWindow : 0.8;
    this.cooldown = d.shotInterval * (idx === combo - 1 ? 1.5 : 0.62);
    this.meleeT = (m?.windup || 0) + (m?.active || 0) + (m?.recovery || 0);
    this.firing = true;
    this.uiFlash = 1;
    if (d.heat > 0) this.heat = clamp(this.heat + d.heat, 0, 1.2);
    ctx.system?._onMeleeSwing?.(this, ctx, idx);
    ctx.system?._onFired?.(this, ctx, 1.4);
    return true;
  }

  _tryDeploy(ctx) {
    const d = this.def;
    if (this.deployActive) {
      this.blocked = 'active';
      return false;
    }
    if (this.deployCooldown > 0) {
      this.blocked = 'cooldown';
      return false;
    }
    const st = ctx?.owner?.stats;
    if (d.enCost > 0 && st && typeof st.en === 'number') {
      if (st.en < d.enCost) {
        this.blocked = 'en';
        return false;
      }
      st.en -= d.enCost;
    }
    this.deployActive = true;
    this.deployTimer = d.deployable?.duration || 6;
    this.uiFlash = 1;
    this.firing = true;
    if (d.heat > 0) this.heat = clamp(this.heat + d.heat, 0, 1.2);
    ctx.system?._onDeployStart?.(this, ctx);
    ctx.system?._onFired?.(this, ctx, 1);
    return true;
  }

  /** Restore to a fresh-from-the-garage state. */
  reset() {
    const d = this.def;
    this.cooldown = 0;
    this.charge = 0;
    this.charging = false;
    this._chargeFull = false;
    this.heat = 0;
    this.overheated = false;
    this.magLeft = d.magazine > 0 ? d.magazine : Infinity;
    this.ammoLeft = d.ammo;
    this.reloading = false;
    this.reloadT = 0;
    this.spin = 0;
    this.deploy = d.needsDeploy ? 0 : 1;
    this.queued = 0;
    this.queueT = 0;
    this.bloom = 0;
    this.comboIndex = 0;
    this.comboT = 0;
    this.deployActive = false;
    this.deployTimer = 0;
    this.deployCooldown = 0;
    this.blocked = '';
  }

  dispose() {
    this._pdef = null;
  }
}

/**
 * Build a live weapon from a definition id.
 * @param {string} id key into WEAPON_DEFS
 * @returns {Weapon|null}
 */
export function createWeapon(id) {
  const raw = WEAPON_DEFS[id];
  if (!raw) return null;
  return new Weapon(_normalize(raw));
}

export default WEAPON_DEFS;
