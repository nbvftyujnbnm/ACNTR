import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bus, EV } from '../core/EventBus.js';
import { clamp, mulberry32 } from '../core/MathUtils.js';
import { getForge } from '../render/TextureForge.js';
import { MechMaterials, MECH_PALETTES, MECH_TILE_METRES } from './MechMaterials.js';
import { MechRig } from './MechRig.js';
import * as MP from './MechParts.js';

/**
 * MechFactory — builds every mech in the game from procedural geometry.
 *
 * Cost model: `init()` is the expensive call (armour texture bake). After that,
 * geometry is cached per (part, variant, side, detail) and SHARED between every
 * mech that uses it, so spawning an enemy allocates meshes and a handful of
 * materials, not vertices.
 *
 * Draw-call budget: each bone carries a THREE.LOD with a full-detail group
 * (armour / dark-mechanical / emissive meshes) and a merged low group. A player
 * AC is 36 draw calls up close and 18 past the LOD switch, while still animating
 * — LOD is applied per bone precisely so distant mechs keep their gait.
 */

// ONE tiling for the entire mech. `MECH_TILE_METRES` is 3.2 m and every mech map
// is baked at 3.2 m * 320 texels/m = 1024², so this single number fixes both
// texels-per-metre and feature-size-per-metre on every part of every mech.
//
// It used to be three numbers — 1024*0.3125, 768*0.4167, 512*0.625 — which agree
// on 320 texels/m and disagree on everything else. The forge specifies its noise
// in cycles PER TILE and its plate splitter is depth-capped, so the tile's WORLD
// size, not its resolution, sets how big a plate, a grime blotch or a chip cell
// is in metres. Three tile sizes meant grime blotches at 40 cm on the chest, 30
// on the arms and 20 on the joint housings, which is exactly the "that plate is
// a different resolution" tell the review rubric fails a frame for.
//
// The absolute figure matters as much as the consistency. At the original 691
// texels/m one armour plate spanned 22 cm, so from any real camera distance a
// screen pixel covered ten texels and every seam, rivet and stencil mipped away
// into flat grey. At 3.2 m per tile the splitter's ~30-60 plates land at
// 0.25-1.25 m, so every armour face crosses one or more seams.
//
// A seam's WORLD width follows from the same number: the forge draws it at
// (size/512)*2.2 texels, i.e. always 2.2/(512*tiles) metres — 1.4 cm here, with a
// 2.5 cm bevel in the normal map behind it doing the work at distance.
const TILES_MAIN = 1 / MECH_TILE_METRES;
const TILES_FINE = TILES_MAIN;
const TILES_MECH = TILES_MAIN;

const LOD_DIST = 46;
const TARGET_HEIGHT = 9.0;

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

/** FNV-1a over a cache key — deterministic per part, stable across runs. */
function hashKey(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Entity support types
// ---------------------------------------------------------------------------

/** Implements the Stats half of the Entity contract. */
class MechStats {
  constructor(o = {}) {
    this.apMax = o.apMax ?? 9200;
    this.acsMax = o.acsMax ?? 2400;
    this.enMax = o.enMax ?? 3400;
    this.defKinetic = o.defKinetic ?? 0.28;
    this.defEnergy = o.defEnergy ?? 0.24;
    this.enRecharge = o.enRecharge ?? 1200;
    this.reset();
  }
  reset() {
    this.ap = this.apMax;
    this.acs = 0;
    this.staggered = false;
    this.staggerTimer = 0;
    this.en = this.enMax;
    this.heat = 0;
  }
}

/**
 * Shared Entity implementation. PlayerMech and EnemyMech differ only in defaults,
 * so the interface lives here exactly once.
 */
class BaseMech {
  constructor(root, opts) {
    this.root = root;
    this.rig = null;
    this.isPlayer = !!opts.isPlayer;
    this.faction = opts.faction;
    this.alive = true;
    this.stats = new MechStats(opts.stats);
    this.velocity = new THREE.Vector3();
    this.collider = {
      radius: opts.radius,
      height: opts.height,
      center: new THREE.Vector3(),
    };
    this.hardpoints = opts.hardpoints;
    this.bones = opts.bones;
    this.materials = opts.materials;
    /** Materials other systems may modulate — see MechMaterials.MaterialSet. */
    this.emissives = opts.materials.emissives;
    this.archetype = opts.archetype;
    this.tier = opts.tier ?? 1;
    this.scaleFactor = opts.scaleFactor ?? 1;
    /** 0..1 — VFX reads this to decide smoke emission rate. */
    this.damageT = 0;
    this._aimOffsetY = opts.aimY;
    this._factory = opts.factory;
    this._state = {
      velocity: this.velocity, grounded: true, boosting: false, quickBoost: false,
      assaultBoost: false, aimYaw: 0, aimPitch: 0, speed: 0, staggered: false, firing: null,
    };
    this.syncCollider();
  }

  /** Convenience tick: drives the rig and keeps the capsule in sync. */
  update(dt, state) {
    this.rig?.update(dt, state || this._state);
    this.syncCollider();
  }

  syncCollider() {
    this.collider.center.set(
      this.root.position.x,
      this.root.position.y + this.collider.height * 0.5,
      this.root.position.z,
    );
  }

  getAimPoint(out) {
    return (out || _v).set(
      this.root.position.x,
      this.root.position.y + this._aimOffsetY,
      this.root.position.z,
    );
  }

  onDamage(info) {
    if (!this.alive) return;
    // Visual battle damage tracks remaining armour, so a mech visibly cooks as it dies.
    const t = 1 - clamp(this.stats.ap / this.stats.apMax, 0, 1);
    if (t > this.damageT + 0.02) this.applyDamageVisual(t);
    // hit flinch: a short torso impulse away from the impact
    if (this.rig && info?.normal) {
      this.rig.sPitch.kick(-info.normal.z * 0.8);
      this.rig.sYawKick.kick(info.normal.x * 0.6);
    }
  }

  onStagger() {
    this.stats.staggered = true;
    if (this.rig) {
      this.rig.sPitch.kick(3.2);
      this.rig.sLand.kick(2.4);
    }
  }

  onDeath() {
    if (!this.alive) return;
    this.alive = false;
    this.applyDamageVisual(1);
    this.materials.setEmissiveScale(0.15);
  }

  /** 0..1 battle damage: soot, roughened paint, heat glow in the panel gaps. */
  applyDamageVisual(t) {
    this.damageT = clamp(t, 0, 1);
    this.materials.setDamage(this.damageT);
  }

  /** Modulate every emissive element at once (charge-ups, EMP, death fade). */
  setEmissiveScale(k) { this.materials.setEmissiveScale(k); }

  setLoadout(loadout) {
    this.loadout = loadout;
    const d = loadout?.derived;
    if (d) {
      if (d.apMax) this.stats.apMax = d.apMax;
      if (d.enMax) this.stats.enMax = d.enMax;
      if (d.acsMax) this.stats.acsMax = d.acsMax;
      if (d.enRecharge) this.stats.enRecharge = d.enRecharge;
      this.stats.ap = Math.min(this.stats.ap, this.stats.apMax);
      this.stats.en = Math.min(this.stats.en, this.stats.enMax);
    }
    return this;
  }

  dispose() {
    this.root.removeFromParent();
    this.materials.dispose();
  }
}

export class PlayerMech extends BaseMech {}
export class EnemyMech extends BaseMech {}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

/**
 * Enemy archetypes. `scale` multiplies the fitted 9 m frame; `palettes` are
 * cycled by tier so waves stay visually distinct.
 */
export const ARCHETYPES = {
  mt: {
    label: 'MT', scale: 0.80, legType: 'biped', crude: true, hover: false,
    wide: 1.18, palettes: ['baws', 'elcano'], radius: 1.6, height: 6.4,
    stats: { apMax: 2200, acsMax: 900, enMax: 1400, defKinetic: 0.14, defEnergy: 0.10 },
  },
  ac: {
    label: 'AC', scale: 1.0, legType: 'reverse', crude: false, hover: false,
    palettes: ['balteus', 'arquebus', 'vespers', 'schneider'], radius: 1.9, height: 8.6,
    stats: { apMax: 8600, acsMax: 2300, enMax: 3200, defKinetic: 0.30, defEnergy: 0.26 },
  },
  tank: {
    label: 'HEAVY', scale: 1.15, legType: 'tetrapod', crude: false, hover: false,
    wide: 1.35, palettes: ['elcano', 'baws'], radius: 3.0, height: 7.6,
    stats: { apMax: 15400, acsMax: 4200, enMax: 2200, defKinetic: 0.46, defEnergy: 0.30 },
  },
  flyer: {
    label: 'DRONE', scale: 1.35, legType: 'none', crude: false, hover: true,
    palettes: ['schneider', 'balteus'], radius: 2.2, height: 2.0,
    stats: { apMax: 1500, acsMax: 700, enMax: 2600, defKinetic: 0.10, defEnergy: 0.20 },
  },
  boss: {
    label: 'ORDNANCE PLATFORM', scale: 2.95, legType: 'tetrapod', crude: false, hover: false,
    wide: 1.55, shield: true, cannon: true, palettes: ['vespers', 'arquebus'],
    radius: 7.0, height: 21.0,
    stats: { apMax: 74000, acsMax: 16000, enMax: 6000, defKinetic: 0.52, defEnergy: 0.44 },
  },
};

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export class MechFactory {
  /** @param {THREE.WebGLRenderer} [renderer] only needed to size texture anisotropy */
  constructor(renderer) {
    this.forge = getForge(renderer);
    this.materials = new MechMaterials(this.forge);
    this._geo = new Map();   // key -> { armor, mech, glow }
    this._sets = [];
    this._fitScale = 1;
    this._seq = 0;
    this.ready = false;
  }

  /** Bake shared textures. Everything after this is cheap. */
  async init(onProgress) {
    if (this.ready) return this;
    await this.materials.bake((t, label) => {
      onProgress?.(t * 0.85, label);
      bus.emit(EV.BOOT_PROGRESS, { t: 0.5 + t * 0.08, label: `mech: ${label}` });
    });
    // Build a throwaway prototype: warms the geometry cache AND measures the frame
    // so the finished mech lands on exactly 9 m regardless of part proportions.
    onProgress?.(0.9, 'fitting frame');
    const proto = this._assembleBiped({ legType: 'biped', seed: 1, palette: 'raven' });
    proto.root.updateWorldMatrix(true, true);
    _box.setFromObject(proto.root);
    const h = _box.max.y - _box.min.y;
    this._fitScale = h > 0.5 ? TARGET_HEIGHT / h : 1;
    proto.materials.dispose();
    this.ready = true;
    onProgress?.(1, 'mech ready');
    return this;
  }

  // -------------------------------------------------------------------------
  // Geometry cache
  // -------------------------------------------------------------------------

  /**
   * Build (or fetch) one part's merged geometry.
   * `low` merges the armour and dark-mechanical buckets into a single mesh so a
   * distant bone is one draw call.
   */
  _partGeo(key, builder, opts, mode) {
    const ck = `${key}|${mode}`;
    let g = this._geo.get(ck);
    if (g) return g;

    const low = mode === 'lo';
    const rng = mulberry32(opts.seed ?? 1);
    const res = builder({ ...opts, rng, detail: low ? 'low' : 'high' });
    const buckets = res.b.build();

    // Per-part UV offset, so two parts never show the identical patch of
    // panelling. Seeded off the PART key, not the mech seed — the old version
    // hashed `opts.seed`, which is one value for the whole mech, so every part
    // received the same offset and the whole frame sampled one patch of the
    // tile. `key` deliberately excludes `mode`, so a part's hi and lo LODs get
    // the same offset and the texture cannot jump at the LOD switch.
    const jr = mulberry32(hashKey(key) ^ ((opts.seed ?? 1) * 7919 + 13));
    const ou = jr() * 8, ov = jr() * 8;

    if (low || mode === 'merged') {
      const solid = [buckets.armor, buckets.mech].filter(Boolean);
      const merged = solid.length > 1 ? mergeGeometries(solid, false) : (solid[0] || null);
      if (solid.length > 1) for (const s of solid) s.dispose();
      g = { armor: merged, mech: null, glow: buckets.glow };
      if (g.armor) MP.applyBoxUV(g.armor, opts.tiles ?? TILES_MAIN, ou, ov);
    } else {
      g = buckets;
      if (g.armor) MP.applyBoxUV(g.armor, opts.tiles ?? TILES_MAIN, ou, ov);
      if (g.mech) MP.applyBoxUV(g.mech, TILES_MECH, ou, ov);
    }
    if (g.glow) MP.applyBoxUV(g.glow, TILES_MAIN, ou, ov);
    g.anchors = res.anchors || {};
    this._geo.set(ck, g);
    return g;
  }

  /** Turn a merged bucket set into meshes on `parent`, with shadow flags set. */
  _meshes(parent, geo, mats, fine) {
    if (geo.armor) {
      const m = new THREE.Mesh(geo.armor, mats.armorFor(fine));
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
    }
    if (geo.mech) {
      const m = new THREE.Mesh(geo.mech, mats.m.mech);
      m.castShadow = true;
      m.receiveShadow = false;
      parent.add(m);
    }
    if (geo.glow) {
      const m = new THREE.Mesh(geo.glow, mats.m.glow);
      m.castShadow = false;   // emissive trim casting shadows is wasted fill
      m.receiveShadow = false;
      parent.add(m);
    }
    return parent;
  }

  /**
   * Attach a part to a bone as a two-level LOD. The LOD sits UNDER the bone, so
   * the skeleton still animates at any distance — only the mesh detail drops.
   */
  _attach(bone, key, builder, opts, mats, fine, mergeSolid) {
    // Texel density must match the texture this part samples, not the part size.
    const o = { ...opts, tiles: fine ? TILES_FINE : TILES_MAIN };
    const hi = this._partGeo(key, builder, o, mergeSolid ? 'merged' : 'hi');
    const lo = this._partGeo(key, builder, o, 'lo');
    const lod = new THREE.LOD();
    const gHi = new THREE.Group();
    const gLo = new THREE.Group();
    this._meshes(gHi, hi, mats, fine);
    this._meshes(gLo, lo, mats, fine);
    lod.addLevel(gHi, 0);
    lod.addLevel(gLo, LOD_DIST);
    bone.add(lod);
    return hi.anchors;
  }

  // -------------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------------

  /**
   * Humanoid / quadruped frame. Bone hierarchy:
   *   root > hips > pelvis > { torso > { neck > headYaw > head, lShoulder > lArm >
   *   lForeArm, rShoulder > rArm > rForeArm, backpack, l/rShoulderMount },
   *   l/rLegUpper > l/rLegLower > l/rFoot }
   */
  _assembleBiped(cfg) {
    const D = MP.MECH_DIMS;
    const seed = cfg.seed ?? 1;
    const legType = cfg.legType || 'biped';
    const quad = legType === 'tetrapod';
    const mats = this.materials.createSet(cfg.palette || 'raven', {
      emissiveBoost: cfg.emissiveBoost ?? 1,
      roughBias: cfg.crude ? 0.16 : 0,
    });
    this._sets.push(mats);

    const root = new THREE.Object3D();
    root.name = 'mech';
    const hips = new THREE.Object3D(); hips.position.y = D.pelvisY; root.add(hips);
    const pelvis = new THREE.Object3D(); hips.add(pelvis);
    const torso = new THREE.Object3D(); torso.position.y = D.waistY - D.pelvisY; pelvis.add(torso);

    const common = { seed, crude: cfg.crude, wide: cfg.wide ?? 1 };

    // --- pelvis + core ---------------------------------------------------
    const pa = this._attach(pelvis, `pelvis:${seed}`, MP.buildPelvis, { ...common }, mats, false);
    const ca = this._attach(torso, `core:${seed}:${cfg.wide ?? 1}:${cfg.crude ? 1 : 0}`,
      MP.buildCore, { ...common }, mats, false);

    // --- head ------------------------------------------------------------
    const neck = new THREE.Object3D();
    neck.position.fromArray(ca.neck || [0, 2.72, 0.02]);
    torso.add(neck);
    const headYaw = new THREE.Object3D(); neck.add(headYaw);
    const head = new THREE.Object3D(); headYaw.add(head);
    this._attach(head, `head:${seed}:${cfg.crude ? 1 : 0}`, MP.buildHead, { ...common }, mats, true);

    // --- backpack --------------------------------------------------------
    const backpack = new THREE.Object3D();
    backpack.position.fromArray(ca.backpack || [0, 1.38, 0.66]);
    torso.add(backpack);
    const ba = this._attach(backpack, `pack:${seed}`, MP.buildBackpack, { ...common }, mats, false);

    // --- arms ------------------------------------------------------------
    const arms = {};
    const muzzles = {};
    /** Where each shoulder's ORDNANCE actually fires from, when it carries any. */
    const shoulderMuzzles = {};
    for (const side of [-1, 1]) {
      const p = side < 0 ? 'l' : 'r';
      const shoulder = new THREE.Object3D();
      shoulder.position.fromArray(side < 0 ? (ca.shoulderL || [-1.46, 1.72, 0]) : (ca.shoulderR || [1.46, 1.72, 0]));
      torso.add(shoulder);
      const arm = new THREE.Object3D(); shoulder.add(arm);
      this._attach(arm, `uarm:${seed}:${side}`, MP.buildUpperArm, { ...common, side }, mats, true);
      const fore = new THREE.Object3D(); fore.position.y = -D.elbowDrop; arm.add(fore);
      const fa = this._attach(fore, `farm:${seed}:${side}`, MP.buildForeArm, { ...common, side }, mats, true);
      arms[`${p}Shoulder`] = shoulder;
      arms[`${p}Arm`] = arm;
      arms[`${p}ForeArm`] = fore;
      muzzles[p] = fa.muzzle || [side * 0.55, -D.wristDrop * 0.46, -0.62];

      // Shoulder weapon mount (the deck on top of the yoke), and the ordnance
      // bolted to it. This is where the frame stops being a mirror: the LEFT
      // shoulder always carries a missile rack and the RIGHT always carries a
      // cannon, so the two halves of the silhouette can never match. Both mounts
      // used to be empty anchors, which is why the mech read as a symmetrical
      // procedural robot rather than an AC. The mount still carries the firing
      // hardpoint underneath, so nothing in the combat path changes.
      const mount = new THREE.Object3D();
      mount.position.fromArray(side < 0 ? (ca.mountL || [-1.16, 2.66, 0]) : (ca.mountR || [1.16, 2.66, 0]));
      torso.add(mount);
      arms[`${p}ShoulderMount`] = mount;

      // Merged into one solid bucket (`mergeSolid`) so a shoulder weapon is 2
      // draw calls, not 3 — the frame is close to its 40-call budget up close.
      // Crude MTs get the rack only: cheap mass-produced units would not be
      // issued a cannon, and one-sided ordnance is still asymmetric.
      if (side < 0) {
        const oa = this._attach(mount, `srack:${seed}:${cfg.crude ? 1 : 0}`, MP.buildMissileRack,
          { ...common, side }, mats, true, true);
        shoulderMuzzles[p] = oa.muzzle;
      } else if (!cfg.crude) {
        const oa = this._attach(mount, `scannon:${seed}`, MP.buildShoulderCannon,
          { ...common, side }, mats, true, true);
        shoulderMuzzles[p] = oa.muzzle;
      }
    }

    // --- legs -------------------------------------------------------------
    const legs = {};
    const pairs = quad ? [0, 1] : [0];
    for (const pair of pairs) {
      for (const side of [-1, 1]) {
        const p = side < 0 ? 'l' : 'r';
        const sfx = pair ? '2' : '';
        const hip = side < 0 ? (pa.hipL || [-D.hipX, -0.10, 0]) : (pa.hipR || [D.hipX, -0.10, 0]);
        const upper = new THREE.Object3D();
        const zOff = quad ? (pair ? 1.30 : -1.05) : 0;
        const xOff = quad ? 0.42 * side : 0;
        upper.position.set(hip[0] + xOff, hip[1], hip[2] + zOff);
        upper.userData.restFoot = new THREE.Vector3(side * (D.footX + (quad ? 0.5 : 0)), 0, zOff * 1.15);
        pelvis.add(upper);
        // Quadrupeds carry twice the leg bones, so their legs collapse the armour
        // and dark-mechanical buckets into one mesh to stay inside the draw budget.
        const mg = quad;
        this._attach(upper, `thigh:${seed}:${side}:${legType}`, MP.buildThigh, { ...common, side, legType }, mats, false, mg);

        const lower = new THREE.Object3D(); lower.position.y = -D.thigh; upper.add(lower);
        this._attach(lower, `shin:${seed}:${side}:${legType}`, MP.buildShin, { ...common, side, legType }, mats, false, mg);

        const foot = new THREE.Object3D(); foot.position.y = -D.shin; lower.add(foot);
        this._attach(foot, `foot:${seed}:${side}:${legType}`, MP.buildFoot, { ...common, side, legType }, mats, true, mg);

        legs[`${p}LegUpper${sfx}`] = upper;
        legs[`${p}LegLower${sfx}`] = lower;
        legs[`${p}Foot${sfx}`] = foot;
      }
    }

    // --- boss ordnance ----------------------------------------------------
    let cannon = null;
    if (cfg.cannon) {
      cannon = new THREE.Object3D();
      cannon.position.set(0, 1.05, 0.30);
      backpack.add(cannon);
      const cg = this._attach(cannon, `cannon:${seed}`, MP.buildCannonArray, { ...common }, mats, false);
      cannon.userData.muzzle = cg.muzzle || [0, 0, -2.2];
    }
    if (cfg.shield) {
      const sh = new THREE.Object3D();
      sh.position.set(-0.55, -D.wristDrop * 0.55, -0.15);
      sh.rotation.set(0, 0.22, 0);
      arms.lForeArm.add(sh);
      this._attach(sh, `shield:${seed}`, MP.buildShieldPlate, { ...common }, mats, false);
    }

    const bones = {
      root, hips, pelvis, torso, neck, headYaw, head, backpack, cannon,
      ...arms, ...legs,
    };

    // --- hardpoints: empty anchors with -Z forward ------------------------
    const hardpoints = {};
    for (const side of [-1, 1]) {
      const p = side < 0 ? 'l' : 'r';
      const hpArm = new THREE.Object3D();
      hpArm.position.fromArray(muzzles[p]);
      bones[`${p}ForeArm`].add(hpArm);
      hardpoints[`${p}Arm`] = hpArm;

      // Fire from the ordnance's own muzzle when the shoulder carries some, so a
      // launch plume leaves the cell mouths / the barrel instead of appearing
      // inside the pod. Falls back to the bare deck anchor for an empty mount.
      const hpSh = new THREE.Object3D();
      hpSh.position.fromArray(shoulderMuzzles[p] || [0, 0.22, -0.42]);
      bones[`${p}ShoulderMount`].add(hpSh);
      hardpoints[`${p}Shoulder`] = hpSh;
    }
    const hpCore = new THREE.Object3D();
    hpCore.position.fromArray(ca.coreMuzzle || [0, 1.30, -0.86]);
    torso.add(hpCore);
    hardpoints.core = hpCore;
    if (cannon) {
      const hpC = new THREE.Object3D();
      hpC.position.fromArray(cannon.userData.muzzle);
      cannon.add(hpC);
      hardpoints.cannon = hpC;
    }

    // thruster anchors for VFX boost flames
    const thrusters = [];
    const addThruster = (parent, arr) => {
      if (!arr) return;
      const o = new THREE.Object3D();
      o.position.fromArray(arr);
      o.rotation.x = Math.PI * 0.5; // -Z points down the exhaust
      parent.add(o);
      thrusters.push(o);
    };
    addThruster(backpack, ba.nozzleL); addThruster(backpack, ba.nozzleR);
    addThruster(backpack, ba.vernL); addThruster(backpack, ba.vernR);

    return { root, bones, hardpoints, materials: mats, thrusters, legType };
  }

  /** Hovering drone: one rigid pod, no legs, wing-mounted lift fans. */
  _assembleFlyer(cfg) {
    const seed = cfg.seed ?? 1;
    const mats = this.materials.createSet(cfg.palette || 'schneider', { emissiveBoost: 1.35 });
    this._sets.push(mats);

    const root = new THREE.Object3D();
    root.name = 'drone';
    const hips = new THREE.Object3D(); hips.position.y = 0.9; root.add(hips);
    const pelvis = new THREE.Object3D(); hips.add(pelvis);
    const torso = new THREE.Object3D(); pelvis.add(torso);
    const headYaw = new THREE.Object3D(); torso.add(headYaw);
    const head = new THREE.Object3D(); headYaw.add(head);

    const fa = this._attach(torso, `flyer:${seed}`, MP.buildFlyerBody, { seed }, mats, false);

    const hardpoints = {};
    for (const side of [-1, 1]) {
      const p = side < 0 ? 'l' : 'r';
      const hp = new THREE.Object3D();
      hp.position.fromArray(side < 0 ? (fa.muzzleL || [-0.36, -0.42, -0.9]) : (fa.muzzleR || [0.36, -0.42, -0.9]));
      torso.add(hp);
      hardpoints[`${p}Arm`] = hp;
      hardpoints[`${p}Shoulder`] = hp;
    }
    const hpCore = new THREE.Object3D();
    hpCore.position.set(0, 0, -1.15);
    torso.add(hpCore);
    hardpoints.core = hpCore;

    return {
      root,
      bones: { root, hips, pelvis, torso, headYaw, head },
      hardpoints, materials: mats, thrusters: [], legType: 'none',
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * @param {object} [loadout] a Loadout instance — read defensively, it is built
   *                 by a sibling module and may be partially populated.
   */
  buildPlayer(loadout) {
    const slots = loadout?.slots || {};
    const legType = slots.legs?.legType || slots.legs?.variant
      || (typeof slots.legs?.id === 'string' && slots.legs.id.includes('rev') ? 'reverse' : null)
      || 'biped';
    const palette = loadout?.palette || slots.core?.palette || 'raven';

    const a = this._assembleBiped({
      legType: MP.LEG_TYPES.includes(legType) ? legType : 'biped',
      seed: 11,
      palette,
      emissiveBoost: 1.15,
    });
    const scale = this._fitScale;
    a.root.scale.setScalar(scale);

    const mech = new PlayerMech(a.root, {
      isPlayer: true, faction: 'player',
      radius: 1.85, height: 8.5, aimY: 5.6,
      hardpoints: a.hardpoints, bones: a.bones, materials: a.materials,
      archetype: 'player', tier: 1, scaleFactor: scale, factory: this,
      stats: { apMax: 9600, acsMax: 2600, enMax: 3600, defKinetic: 0.30, defEnergy: 0.28 },
    });
    mech.thrusters = a.thrusters;
    mech.rig = new MechRig(a.root, a.bones, {
      legType: a.legType, dims: MP.MECH_DIMS, mech, scale,
    });
    mech.setLoadout(loadout);
    return mech;
  }

  /**
   * @param {'mt'|'ac'|'tank'|'flyer'|'boss'} archetype
   * @param {number} [tier] 1..5 — tints, scales and buffs the unit
   */
  buildEnemy(archetype, tier = 1) {
    const def = ARCHETYPES[archetype] || ARCHETYPES.mt;
    const t = clamp(Math.round(tier), 1, 5);
    const seed = 200 + this._seq++;
    const palette = def.palettes[(t - 1) % def.palettes.length];
    const tierScale = 1 + (t - 1) * 0.045;

    const a = def.hover
      ? this._assembleFlyer({ seed, palette })
      : this._assembleBiped({
        seed: archetype === 'mt' ? 41 : archetype === 'tank' ? 61 : archetype === 'boss' ? 81 : 21,
        legType: def.legType, palette, crude: def.crude, wide: def.wide,
        shield: def.shield, cannon: def.cannon,
        emissiveBoost: 0.85 + t * 0.12,
      });

    const scale = this._fitScale * def.scale * tierScale;
    a.root.scale.setScalar(scale);

    const st = { ...def.stats };
    const buff = 1 + (t - 1) * 0.35;
    st.apMax = Math.round(st.apMax * buff);
    st.acsMax = Math.round(st.acsMax * (1 + (t - 1) * 0.20));

    const mech = new EnemyMech(a.root, {
      isPlayer: false, faction: 'enemy',
      radius: def.radius * tierScale, height: def.height * tierScale,
      aimY: def.hover ? def.height * tierScale * 0.55 : def.height * tierScale * 0.62,
      hardpoints: a.hardpoints, bones: a.bones, materials: a.materials,
      archetype, tier: t, scaleFactor: scale, factory: this, stats: st,
    });
    mech.thrusters = a.thrusters;
    mech.rig = new MechRig(a.root, a.bones, {
      legType: a.legType, dims: MP.MECH_DIMS, mech, scale, hover: !!def.hover,
    });
    return mech;
  }

  /**
   * A single part on its own, centred and lit for the garage viewport.
   * @param {string} partId e.g. 'head', 'core', 'arms', 'legs', 'legs:reverse', 'booster'
   */
  buildPartPreview(partId) {
    const [rawSlot, variant] = String(partId || 'core').split(':');
    const slot = rawSlot.toLowerCase();
    const legType = variant && MP.LEG_TYPES.includes(variant) ? variant
      : (slot.includes('rev') ? 'reverse' : 'biped');

    if (!this._previewMats) {
      this._previewMats = this.materials.createSet('raven', { emissiveBoost: 1.4 });
      this._sets.push(this._previewMats);
    }
    const mats = this._previewMats;
    const group = new THREE.Object3D();
    group.name = `preview:${partId}`;
    const seed = 900;
    const opts = { seed };

    const one = (bone, key, builder, o, fine) => {
      const g = this._partGeo(key, builder, { ...opts, ...o, tiles: fine ? TILES_FINE : TILES_MAIN }, 'hi');
      this._meshes(bone, g, mats, fine);
      return g.anchors;
    };

    const pick = slot.includes('head') ? 'head'
      : slot.includes('core') || slot.includes('chest') ? 'core'
        : slot.includes('arm') ? 'arms'
          : slot.includes('leg') ? 'legs'
            : slot.includes('boost') || slot.includes('pack') ? 'booster'
              : slot.includes('gen') ? 'core' : 'core';

    if (pick === 'head') {
      one(group, `head:${seed}:0`, MP.buildHead, { crude: false }, true);
    } else if (pick === 'core') {
      one(group, `core:${seed}:1:0`, MP.buildCore, { wide: 1, crude: false }, false);
      group.position.y = -1.3;
    } else if (pick === 'booster') {
      one(group, `pack:${seed}`, MP.buildBackpack, {}, false);
    } else if (pick === 'arms') {
      for (const side of [-1, 1]) {
        const arm = new THREE.Object3D();
        arm.position.x = side * 0.75;
        group.add(arm);
        one(arm, `uarm:${seed}:${side}`, MP.buildUpperArm, { side }, true);
        const fore = new THREE.Object3D();
        fore.position.y = -MP.MECH_DIMS.elbowDrop;
        arm.add(fore);
        one(fore, `farm:${seed}:${side}`, MP.buildForeArm, { side }, true);
      }
      group.position.y = 1.2;
    } else {
      for (const side of [-1, 1]) {
        const th = new THREE.Object3D();
        th.position.set(side * MP.MECH_DIMS.hipX, 0, 0);
        group.add(th);
        one(th, `thigh:${seed}:${side}:${legType}`, MP.buildThigh, { side, legType }, false);
        const sh = new THREE.Object3D(); sh.position.y = -MP.MECH_DIMS.thigh; th.add(sh);
        one(sh, `shin:${seed}:${side}:${legType}`, MP.buildShin, { side, legType }, false);
        const ft = new THREE.Object3D(); ft.position.y = -MP.MECH_DIMS.shin; sh.add(ft);
        one(ft, `foot:${seed}:${side}:${legType}`, MP.buildFoot, { side, legType }, true);
      }
      group.position.y = MP.MECH_DIMS.thigh + MP.MECH_DIMS.shin + 0.5;
    }

    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return group;
  }

  /** Triangle / draw-call accounting — used by the perf overlay and tests. */
  stats() {
    let tris = 0, meshes = 0;
    for (const g of this._geo.values()) {
      for (const k of ['armor', 'mech', 'glow']) {
        if (g[k]) { tris += g[k].attributes.position.count / 3; meshes++; }
      }
    }
    return { cachedParts: this._geo.size, cachedTris: Math.round(tris), cachedMeshes: meshes };
  }

  dispose() {
    for (const g of this._geo.values()) {
      g.armor?.dispose(); g.mech?.dispose(); g.glow?.dispose();
    }
    this._geo.clear();
    for (const s of this._sets) s.dispose();
    this._sets.length = 0;
    this._previewMats = null;
    this.materials.dispose();
    this.ready = false;
  }
}

export default MechFactory;
