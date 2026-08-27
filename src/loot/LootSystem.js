import * as THREE from 'three';
import { bus, EV } from '../core/EventBus.js';
import { clamp, mulberry32, TAU } from '../core/MathUtils.js';
import { getForge } from '../render/TextureForge.js';
import { RARITY, rollPart } from './PartsDB.js';

/**
 * LootSystem — physical salvage in the world.
 *
 * A drop is not an icon. It is a hexagonal salvage canister with a real panelled
 * hull, an emissive core spinning inside an open rib cage, orbiting debris
 * shards, a vertical light shaft, a pulsing ground decal and (from epic up) its
 * own point light. Rarity scales every one of those channels at once — a
 * legendary is a column of amber light you can see from the far side of the
 * arena, a common is a dull grey brick with a faint glow.
 *
 * Everything is generated at runtime: geometry is procedural, the hull material
 * comes from TextureForge's armour panelling, the beam / decal / halo textures
 * are drawn to canvas here.
 *
 * Lifecycle:  launch (ballistic scatter) → idle (hover+spin) → magnet → collect
 *             ...or idle → fade, when the live cap or the lifetime is hit.
 */

// --- tuning -----------------------------------------------------------------
const MAX_LIVE = 40;            // hard cap on world pickups
const MAX_LIGHTS = 6;           // point lights reserved for epic+ drops
const MAGNET_RADIUS = 14;       // m — attraction starts here
const PICKUP_RADIUS = 3.4;      // m — collected on contact
const MAGNET_ACCEL = 62;        // m/s²
const MAGNET_MAX_SPEED = 46;    // m/s
const GRAVITY = 24;             // matches the project's world gravity
const LIFETIME = 165;           // s before a drop starts fading on its own
const FADE_TIME = 0.75;
const COLLECT_TIME = 0.16;
const HOVER_HEIGHT = 1.9;

// --- module-scope scratch (no per-frame allocation) -------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _target = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

// ---------------------------------------------------------------------------
// Drop tables
// ---------------------------------------------------------------------------

/**
 * Per-archetype drop behaviour.
 *  rolls       [min,max] number of parts when the drop fires
 *  chance      probability the enemy drops at all
 *  luck        extra rarity-ladder pressure (see PartsDB.rarityWeights)
 *  tierBonus   added to the world tier for this drop
 *  slots       relative slot weights; null = anything
 *  floor       minimum rarity
 *  guaranteed  extra drops forced to a rarity, independent of the rolls
 */
const DROP_TABLES = {
  default: { rolls: [1, 1], chance: 0.55, luck: 0, tierBonus: 0, slots: null },

  drone: {
    rolls: [1, 1], chance: 0.30, luck: 0, tierBonus: 0,
    slots: { rArm: 3, lArm: 3, rShoulder: 2, lShoulder: 2, booster: 2, head: 1 },
  },
  mt: {
    rolls: [1, 1], chance: 0.48, luck: 0, tierBonus: 0,
    slots: { rArm: 3, lArm: 3, rShoulder: 2, lShoulder: 2, arms: 2, legs: 2, head: 2, core: 1, booster: 1, generator: 1 },
  },
  soldier: {
    rolls: [1, 2], chance: 0.62, luck: 0.2, tierBonus: 0,
    slots: { rArm: 3, lArm: 3, arms: 2, head: 2, core: 2, legs: 2, booster: 2, generator: 2, rShoulder: 2, lShoulder: 2 },
  },
  sniper: {
    rolls: [1, 2], chance: 0.68, luck: 0.3, tierBonus: 0,
    slots: { rArm: 4, rShoulder: 3, head: 3, arms: 2, generator: 1 },
  },
  brawler: {
    rolls: [1, 2], chance: 0.65, luck: 0.3, tierBonus: 0,
    slots: { lArm: 4, arms: 3, legs: 3, booster: 2, core: 1 },
  },
  heavy: {
    rolls: [2, 2], chance: 0.78, luck: 0.5, tierBonus: 1,
    slots: { core: 4, legs: 4, arms: 3, lShoulder: 2, rShoulder: 2, generator: 2 },
  },
  flyer: {
    rolls: [1, 2], chance: 0.6, luck: 0.4, tierBonus: 0,
    slots: { booster: 4, generator: 3, legs: 3, head: 2, lShoulder: 1 },
  },
  artillery: {
    rolls: [2, 2], chance: 0.72, luck: 0.4, tierBonus: 1,
    slots: { rShoulder: 4, lShoulder: 4, arms: 2, core: 2, legs: 1 },
  },
  elite: {
    rolls: [2, 3], chance: 1, luck: 1.0, tierBonus: 1, floor: 'uncommon', slots: null,
  },
  rival: {
    rolls: [3, 4], chance: 1, luck: 1.6, tierBonus: 2, floor: 'rare', slots: null,
    guaranteed: [{ rarity: 'epic', chance: 0.6 }],
  },
  boss: {
    rolls: [4, 6], chance: 1, luck: 2.4, tierBonus: 2, floor: 'rare', slots: null,
    // A boss always hands over something build-changing. That is the payoff.
    guaranteed: [
      { rarity: 'epic', chance: 1 },
      { rarity: 'legendary', chance: 0.55 },
      { rarity: 'prototype', chance: 0.12 },
    ],
  },
};

/** Loose names from EnemyManager mapped onto the tables above. */
const ARCHETYPE_ALIASES = {
  grunt: 'mt', trooper: 'mt', infantry: 'mt', light: 'drone', scout: 'drone',
  turret: 'artillery', cannon: 'artillery', missile: 'artillery', support: 'artillery',
  tank: 'heavy', juggernaut: 'heavy', bruiser: 'heavy', tetrapod: 'heavy',
  melee: 'brawler', blade: 'brawler', rusher: 'brawler', assault: 'soldier',
  marksman: 'sniper', railgun: 'sniper', laser: 'sniper',
  air: 'flyer', hover: 'flyer', drone: 'drone',
  ac: 'rival', ace: 'rival', named: 'rival', miniboss: 'elite', veteran: 'elite',
  captain: 'elite', commander: 'elite', raven: 'rival',
};

function tableFor(archetype) {
  if (!archetype) return DROP_TABLES.default;
  const key = String(archetype).toLowerCase().replace(/[^a-z]/g, '');
  return DROP_TABLES[key] || DROP_TABLES[ARCHETYPE_ALIASES[key]] || DROP_TABLES.default;
}

function pickSlot(weights, rand) {
  if (!weights) return null;
  let total = 0;
  for (const k in weights) total += weights[k];
  let r = rand() * total;
  for (const k in weights) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Procedural textures for the drop presentation
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
  if (!c) return null;
  c.width = w; c.height = h;
  return c;
}

/** Vertical light-shaft gradient: hot at the base, dissolving upward. */
function beamTexture() {
  const W = 64, H = 256;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);          // 0 = top of the shaft
    const rise = Math.pow(1 - v, 1.7);
    // faint horizontal banding so the shaft reads as volumetric, not as a decal
    const band = 0.72 + 0.28 * Math.sin(v * 34.0) * Math.sin(v * 7.3);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      // slight brightening toward the tube seams keeps the silhouette crisp
      const edge = 0.78 + 0.22 * Math.abs(Math.cos(u * Math.PI));
      const a = clamp(rise * band * edge, 0, 1);
      const o = (y * W + x) * 4;
      const l = (a * 255) | 0;
      d[o] = l; d[o + 1] = l; d[o + 2] = l; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Ground decal: HUD-style targeting annulus with tick marks and a soft bloom. */
function decalTexture() {
  const S = 256;
  const c = makeCanvas(S, S);
  if (!c) return null;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const cx = S / 2;

  // soft inner bloom
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.30)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  ctx.globalCompositeOperation = 'lighter';
  // main annulus, drawn as several passes so it blooms outward
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.40, 0, TAU);
    ctx.strokeStyle = `rgba(255,255,255,${0.55 / (i + 1)})`;
    ctx.lineWidth = 2 + i * 4;
    ctx.stroke();
  }
  // inner hairline
  ctx.beginPath();
  ctx.arc(cx, cx, S * 0.235, 0, TAU);
  ctx.strokeStyle = 'rgba(255,255,255,0.34)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // eight bracket ticks — the AC6 scan-marker cue
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * TAU - 0.10;
    const a1 = a0 + 0.20;
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.455, a0, a1);
    ctx.stroke();
  }
  // four long radial spokes
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * S * 0.26, cx + Math.sin(a) * S * 0.26);
    ctx.lineTo(cx + Math.cos(a) * S * 0.47, cx + Math.sin(a) * S * 0.47);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------

export class LootSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object} player entity (needs .root and ideally .collider)
   * @param {import('./Loadout.js').Loadout} loadout
   * @param {object} vfx VFX instance (all calls are optional-chained)
   */
  constructor(scene, player, loadout, vfx) {
    this.scene = scene;
    this.player = player;
    this.loadout = loadout;
    this.vfx = vfx;

    this.enabled = true;
    this.magnetRadius = MAGNET_RADIUS;
    this.tier = loadout?.progress?.tier || 1;

    this._t = 0;
    this._rand = mulberry32(0x10071e ^ ((Date.now() / 1000) | 0));
    this._active = [];
    this._pool = [];
    this._kit = null;
    this._lights = [];
    this._lightBusy = [];
    this._group = new THREE.Group();
    this._group.name = 'LootSystem';
    scene?.add(this._group);

    this._disposables = [];
    this._offDrop = bus.on(EV.LOOT_DROP, (e) => this._onLootDrop(e));
    this._offBuild = bus.on(EV.BUILD_CHANGED, () => {
      this.tier = this.loadout?.progress?.tier || this.tier;
    });

    this._initLights();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Drop a single rolled part at a world position (contract signature).
   * @param {THREE.Vector3} pos
   * @param {number} [tier]
   * @param {object} [opts] forwarded to rollPart (rarityFloor, luck, slotFilter)
   * @returns {object|null} the spawned pickup
   */
  dropAt(pos, tier = this.tier, opts = {}) {
    if (!this.enabled || !pos) return null;
    const part = rollPart(tier, this._rand, opts.slotFilter || null, opts);
    return this.spawnPart(part, pos, opts.impulse !== false);
  }

  /**
   * Roll a full archetype drop table. This is what EnemyManager's LOOT_DROP
   * event routes into.
   * @param {THREE.Vector3} pos
   * @param {number} tier
   * @param {string} archetype
   * @returns {number} how many pickups were spawned
   */
  dropLoot(pos, tier = this.tier, archetype = null) {
    if (!this.enabled || !pos) return 0;
    const table = tableFor(archetype);
    const rand = this._rand;
    if (rand() > table.chance) return 0;

    const t = clamp(Math.round((tier || 1) + (table.tierBonus || 0)), 1, 14);
    const [lo, hi] = table.rolls;
    const n = lo + ((rand() * (hi - lo + 1)) | 0);

    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const slot = pickSlot(table.slots, rand);
      const part = rollPart(t, rand, slot, { luck: table.luck || 0, rarityFloor: table.floor || null });
      if (this.spawnPart(part, pos, true)) spawned++;
    }

    if (table.guaranteed) {
      for (let i = 0; i < table.guaranteed.length; i++) {
        const g = table.guaranteed[i];
        if (g.chance != null && rand() > g.chance) continue;
        const part = rollPart(t, rand, null, { rarity: g.rarity, luck: table.luck || 0 });
        if (this.spawnPart(part, pos, true)) spawned++;
      }
    }
    return spawned;
  }

  /**
   * Materialise a specific Part in the world.
   * @param {object} part
   * @param {THREE.Vector3} pos
   * @param {boolean} [impulse] scatter it ballistically from `pos`
   */
  spawnPart(part, pos, impulse = true) {
    if (!part || !pos) return null;
    this._enforceCap();

    const p = this._acquire();
    this._dress(p, part);

    const rand = this._rand;
    p.groundY = pos.y;
    p.root.position.set(pos.x, pos.y + 1.2, pos.z);
    p.basePos.copy(p.root.position);

    if (impulse) {
      const a = rand() * TAU;
      const speed = 5 + rand() * 7;
      p.vel.set(Math.cos(a) * speed, 9 + rand() * 6, Math.sin(a) * speed);
      p.state = 'launch';
    } else {
      p.vel.set(0, 0, 0);
      p.basePos.y = pos.y;
      p.state = 'idle';
    }

    p.age = 0;
    p.alive = true;
    p.phase = rand() * TAU;
    p.spin = 0;
    p.fade = 0;
    p.root.visible = true;
    p.root.scale.setScalar(p.present.scale);

    this._active.push(p);

    // Announce loudly in proportion to how much the player should care.
    const idx = RARITY[part.rarity]?.index ?? 0;
    bus.emit(EV.SFX, { id: 'loot_drop', rarity: part.rarity, tier: part.tier, position: pos, pitch: 1 + idx * 0.08 });
    if (idx >= 4) bus.emit(EV.SHAKE, { intensity: 0.12 + idx * 0.05, duration: 0.35 });
    this._flourish(pos, idx, p.color, false);

    return p;
  }

  /** Live pickup count. */
  get count() { return this._active.length; }

  /** Remove every live pickup immediately (mission reset). */
  clear() {
    for (let i = this._active.length - 1; i >= 0; i--) this._release(this._active[i]);
    this._active.length = 0;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {number} [elapsed] seconds since boot
   */
  update(dt, elapsed) {
    if (!dt) return;
    this._t = elapsed !== undefined ? elapsed : this._t + dt;
    const t = this._t;
    const list = this._active;
    if (!list.length) return;

    // Player attraction point — centre of mass, not the feet.
    const pc = this.player?.collider?.center;
    if (pc && pc.isVector3) _target.copy(pc);
    else if (this.player?.root) _target.copy(this.player.root.position).addScaledVector(_up, 4.5);
    else _target.set(0, 4.5, 0);

    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;

      switch (p.state) {
        case 'launch': this._stepLaunch(p, dt); break;
        case 'idle':
        case 'magnet': this._stepIdle(p, dt, t); break;
        case 'collect': {
          // Snapped up: the canister collapses inward and the glow whites out.
          p.fade += dt / COLLECT_TIME;
          const k = clamp(1 - p.fade, 0, 1);
          p.body.scale.setScalar(p.present.scale * k * k);
          p.body.rotation.y += dt * 26;
          p.vis = k;
          if (p.fade >= 1) { this._release(p); list.splice(i, 1); continue; }
          break;
        }
        case 'fade': {
          // Timed out: sinks into the ground and dims.
          p.fade += dt / FADE_TIME;
          const k = clamp(1 - p.fade, 0, 1);
          p.body.scale.setScalar(p.present.scale * (0.2 + 0.8 * k));
          p.root.position.y -= dt * 1.6;
          p.vis = k;
          if (p.fade >= 1) { this._release(p); list.splice(i, 1); continue; }
          break;
        }
        default: break;
      }

      this._animate(p, dt, t);

      // magnet + collection
      if (p.state === 'idle' || p.state === 'magnet') {
        _v.subVectors(_target, p.root.position);
        const dist = _v.length();
        if (dist < PICKUP_RADIUS) {
          this._collect(p);
          continue;
        }
        if (dist < MAGNET_RADIUS) {
          p.state = 'magnet';
          const pull = 1 - dist / MAGNET_RADIUS;      // ramps in as it closes
          _v.multiplyScalar(1 / (dist || 1));
          p.vel.addScaledVector(_v, MAGNET_ACCEL * (0.35 + pull * 1.65) * dt);
          const sp = p.vel.length();
          if (sp > MAGNET_MAX_SPEED) p.vel.multiplyScalar(MAGNET_MAX_SPEED / sp);
          p.root.position.addScaledVector(p.vel, dt);
          p.basePos.copy(p.root.position);
        } else if (p.state === 'magnet') {
          // player left the radius — settle back into a hover where it is
          p.state = 'idle';
          p.basePos.copy(p.root.position);
          p.vel.set(0, 0, 0);
        }
        if (p.age > LIFETIME) { p.state = 'fade'; p.fade = 0; }
      }
    }
  }

  _stepLaunch(p, dt) {
    p.vel.y -= GRAVITY * dt;
    p.root.position.addScaledVector(p.vel, dt);
    const floor = p.groundY + 0.55;
    if (p.root.position.y <= floor) {
      p.root.position.y = floor;
      if (p.vel.y < -3.5) {
        p.vel.y *= -0.34;                 // one lively bounce
        p.vel.x *= 0.55; p.vel.z *= 0.55;
      } else {
        p.vel.set(0, 0, 0);
        p.basePos.copy(p.root.position);
        p.basePos.y = p.groundY;
        p.state = 'idle';
      }
    }
  }

  _stepIdle(p, dt, t) {
    if (p.state !== 'idle') return;
    const pr = p.present;
    const bob = Math.sin(t * 1.35 + p.phase) * pr.bob;
    p.root.position.set(
      p.basePos.x,
      p.basePos.y + HOVER_HEIGHT + bob,
      p.basePos.z
    );
  }

  /**
   * Rotation, orbiting shards, beam and decal pulsing.
   * Runs for every live pickup every frame — strictly allocation-free.
   *
   * `body` is the only scaled node; the beam, decal and halo hang off the
   * unscaled root so their world sizes stay purely rarity-driven and the
   * ground-anchoring maths stays in world units.
   */
  _animate(p, dt, t) {
    const pr = p.present;
    p.spin += dt * pr.spin;

    p.core.rotation.y = p.spin * 1.7;
    p.core.rotation.x = p.spin * 0.9;
    p.cage.rotation.y = -p.spin * 0.55;
    p.bandA.rotation.z = p.spin * 1.15;
    p.bandB.rotation.x = -p.spin * 0.85;

    // Pulse the emissive so the drop breathes rather than sitting there.
    const pulse = 0.75 + 0.25 * Math.sin(t * (1.4 + pr.pulse) + p.phase);
    const vis = p.vis;
    p.mats.core.emissiveIntensity = pr.emissive * pulse * vis;
    p.mats.band.emissiveIntensity = pr.emissive * 0.55 * pulse * vis;
    p.mats.shard.emissiveIntensity = pr.emissive * 0.7 * pulse * vis;

    // The shaft and the decal belong to the ground, not to the hovering item —
    // they only make sense while the drop is actually sitting somewhere.
    const grounded = p.state === 'idle' || p.state === 'fade';
    const showBeam = grounded && pr.beamH > 0;
    p.beam.visible = showBeam;
    p.decal.visible = grounded;

    if (showBeam) {
      p.beam.rotation.y += dt * 0.22;
      p.beam.position.y = p.groundY - p.root.position.y + pr.beamH * 0.5;
      p.mats.beam.opacity = pr.beamOp * (0.72 + 0.28 * Math.sin(t * 2.1 + p.phase * 1.7)) * vis;
    }

    if (grounded) {
      // Expanding scan ping, so the marker reads as active telemetry.
      const ping = (t * 0.55 + p.phase * 0.16) % 1;
      const ringS = pr.ring * 1.8 * (0.86 + 0.3 * ping);
      p.decal.position.y = p.groundY - p.root.position.y + 0.06;
      p.decal.scale.set(ringS, ringS, ringS);
      p.mats.decal.opacity = (0.30 + pr.beamOp * 0.9) * (1 - ping * 0.72) * vis;
      p.decal.rotation.z += dt * 0.35;
    }

    // Orbiting debris shards (rare and above).
    if (p.shardCount > 0) {
      const inst = p.shards;
      for (let s = 0; s < p.shardCount; s++) {
        const f = s / p.shardCount;
        const a = t * (0.9 + pr.spin * 0.5) * (s % 2 ? 1 : -1) + f * TAU;
        const tilt = (f - 0.5) * 1.5;
        const rad = 1.15 + 0.35 * Math.sin(t * 1.1 + f * 9.0);
        _v2.set(Math.cos(a) * rad, Math.sin(a * 1.3 + f * 4.0) * 0.55 + tilt * 0.35, Math.sin(a) * rad);
        _euler.set(a * 2.1, a * 1.4, f * 6.0);
        _q.setFromEuler(_euler);
        const sc = (0.7 + 0.5 * Math.sin(f * 12.0)) * vis;
        _scale.set(sc, sc, sc);
        _m4.compose(_v2, _q, _scale);
        inst.setMatrixAt(s, _m4);
      }
      inst.instanceMatrix.needsUpdate = true;
    }

    // Halo sprite — the "legible from across the arena" channel.
    const halo = pr.ring * (1.15 + 0.3 * pulse);
    p.halo.scale.set(halo, halo, 1);
    p.mats.halo.opacity = clamp(0.14 + pr.beamOp * 0.8, 0, 1) * pulse * vis;

    if (p.light) {
      p.light.position.copy(p.root.position);
      p.light.intensity = pr.light * pulse * vis;
    }
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  _collect(p) {
    if (p.state === 'collect') return;
    p.state = 'collect';
    p.fade = 0;

    const part = p.part;
    if (part) {
      if (this.loadout?.addToInventory) this.loadout.addToInventory(part);
      else if (this.loadout?.inventory) this.loadout.inventory.push(part);

      const idx = RARITY[part.rarity]?.index ?? 0;
      bus.emit(EV.LOOT_PICKUP, { part, rarity: part.rarity, tier: part.tier, position: p.root.position });
      bus.emit(EV.SFX, { id: 'loot_pickup', rarity: part.rarity, pitch: 1 + idx * 0.11 });
      if (idx >= 3) bus.emit(EV.SHAKE, { intensity: 0.06 + idx * 0.03, duration: 0.18 });
      this._flourish(p.root.position, idx, p.color, true);
    }
  }

  /** Fire whatever VFX hooks exist. Signatures are still landing in parallel. */
  _flourish(pos, rarityIdx, colorHex, isPickup) {
    const v = this.vfx;
    if (!v) return;
    _col.set(colorHex || '#8e989e');
    try {
      const n = 10 + rarityIdx * 9 + (isPickup ? 8 : 0);
      v.sparks?.(pos, n, _col);
      v.shockwave?.(pos, (isPickup ? 1.6 : 2.4) + rarityIdx * 0.7, _col);
      if (rarityIdx >= 3) v.impact?.(pos, _up, 'energy');
      if (!isPickup && rarityIdx >= 4) v.explosion?.(pos, 1.4 + rarityIdx * 0.4, { color: _col, smoke: false });
    } catch (err) {
      // A VFX signature mismatch must never take the loot system down.
      this.vfx = { ...v };
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  _onLootDrop(e) {
    if (!e) return;
    const pos = e.position || e.pos || e.point || e.entity?.root?.position;
    if (!pos) return;
    const tier = e.tier ?? this.tier;
    if (e.part) { this.spawnPart(e.part, pos, true); return; }
    this.dropLoot(pos, tier, e.archetype);
  }

  // -------------------------------------------------------------------------
  // Pickup construction
  // -------------------------------------------------------------------------

  /** Build the shared geometry/texture kit once. */
  _buildKit() {
    if (this._kit) return this._kit;
    const forge = getForge(this.scene?.userData?.renderer);

    // Panelled hull material set — the drops are made of the same metal the
    // mechs are, at a smaller panel scale.
    let tex = null;
    try {
      tex = forge?.armorPanel?.({
        size: 256, seed: 4211, panelScale: 5,
        baseColor: '#5b6167', accentColor: '#2f3439',
        wear: 0.66, grime: 0.62, rivets: true, stencil: true,
        emissiveDensity: 0, baseRough: 0.46, metal: 1.0,
      });
    } catch (err) { tex = null; }

    const beamTex = beamTexture();
    const decalTex = decalTexture();
    let haloTex = null;
    try { haloTex = forge?.radial?.('#ffffff', 'rgba(255,255,255,0)', 128, 1.35); } catch (err) { haloTex = null; }

    const kit = {
      tex,
      beamTex,
      decalTex,
      haloTex,
      geo: {
        // hexagonal end caps, so the silhouette reads as engineered salvage
        capTop: new THREE.CylinderGeometry(0.26, 0.56, 0.34, 6, 1),
        capBot: new THREE.CylinderGeometry(0.56, 0.26, 0.34, 6, 1),
        rib: new THREE.BoxGeometry(0.11, 1.18, 0.14),
        core: new THREE.OctahedronGeometry(0.40, 0),
        band: new THREE.TorusGeometry(0.63, 0.035, 6, 6),
        band2: new THREE.TorusGeometry(0.74, 0.022, 6, 24),
        shard: new THREE.TetrahedronGeometry(0.13, 0),
        beam: new THREE.CylinderGeometry(1.0, 0.42, 1, 16, 1, true),
        decal: new THREE.PlaneGeometry(1, 1),
      },
    };
    this._kit = kit;
    return kit;
  }

  _initLights() {
    for (let i = 0; i < MAX_LIGHTS; i++) {
      // Created up front and never added/removed: a changing light count forces
      // every material in the scene to recompile, which would hitch on drops.
      const l = new THREE.PointLight(0xffffff, 0, 46, 2);
      l.castShadow = false;
      l.visible = true;
      this._group.add(l);
      this._lights.push(l);
      this._lightBusy.push(false);
    }
  }

  _takeLight() {
    for (let i = 0; i < this._lights.length; i++) {
      if (!this._lightBusy[i]) { this._lightBusy[i] = true; return this._lights[i]; }
    }
    return null;
  }

  _giveLight(light) {
    const i = this._lights.indexOf(light);
    if (i >= 0) { this._lightBusy[i] = false; light.intensity = 0; }
  }

  /** Create one pickup rig. Called at most MAX_LIVE times over a session. */
  _create() {
    const kit = this._buildKit();
    const root = new THREE.Group();
    root.name = 'salvage';

    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x9aa2a8,
      map: kit.tex?.map || null,
      normalMap: kit.tex?.normalMap || null,
      roughnessMap: kit.tex?.roughnessMap || null,
      metalnessMap: kit.tex?.metalnessMap || null,
      aoMap: kit.tex?.aoMap || null,
      metalness: 1.0,
      roughness: 0.44,
      emissive: 0x000000,
      transparent: true,
      opacity: 1,
    });

    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x0a0c0e, emissive: 0xffffff, emissiveIntensity: 3,
      metalness: 0.0, roughness: 0.22, transparent: true, opacity: 1,
    });

    const bandMat = new THREE.MeshStandardMaterial({
      color: 0x14181c, emissive: 0xffffff, emissiveIntensity: 2,
      metalness: 1.0, roughness: 0.3, transparent: true, opacity: 1,
    });

    const shardMat = new THREE.MeshStandardMaterial({
      color: 0x2a3036, emissive: 0xffffff, emissiveIntensity: 2.2,
      metalness: 1.0, roughness: 0.34, transparent: true, opacity: 1,
    });

    const beamMat = new THREE.MeshBasicMaterial({
      map: kit.beamTex, color: 0xffffff, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: true,
    });

    const decalMat = new THREE.MeshBasicMaterial({
      map: kit.decalTex, color: 0xffffff, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide, toneMapped: true,
    });

    const haloMat = new THREE.SpriteMaterial({
      map: kit.haloTex, color: 0xffffff, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });

    // --- body -------------------------------------------------------------
    const cage = new THREE.Group();
    const ribs = new THREE.InstancedMesh(kit.geo.rib, hullMat, 6);
    ribs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      _v2.set(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
      _euler.set(0, -a, 0);
      _q.setFromEuler(_euler);
      _scale.set(1, 1, 1);
      _m4.compose(_v2, _q, _scale);
      ribs.setMatrixAt(i, _m4);
    }
    ribs.instanceMatrix.needsUpdate = true;
    cage.add(ribs);

    const capTop = new THREE.Mesh(kit.geo.capTop, hullMat);
    capTop.position.y = 0.76;
    const capBot = new THREE.Mesh(kit.geo.capBot, hullMat);
    capBot.position.y = -0.76;
    cage.add(capTop, capBot);

    const core = new THREE.Mesh(kit.geo.core, coreMat);
    const bandA = new THREE.Mesh(kit.geo.band, bandMat);
    bandA.rotation.x = Math.PI / 2;
    const bandB = new THREE.Mesh(kit.geo.band2, bandMat);
    bandB.rotation.y = Math.PI / 2;

    const shards = new THREE.InstancedMesh(kit.geo.shard, shardMat, 14);
    shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shards.count = 0;
    shards.frustumCulled = false;

    const beam = new THREE.Mesh(kit.geo.beam, beamMat);
    beam.frustumCulled = false;
    beam.renderOrder = 6;

    const decal = new THREE.Mesh(kit.geo.decal, decalMat);
    decal.rotation.x = -Math.PI / 2;
    decal.frustumCulled = false;
    decal.renderOrder = 5;

    const halo = new THREE.Sprite(haloMat);
    halo.renderOrder = 7;

    root.add(cage, core, bandA, bandB, shards, beam, decal, halo);
    root.visible = false;
    this._group.add(root);

    return {
      root, cage, core, bandA, bandB, shards, beam, decal, halo,
      mats: { hull: hullMat, core: coreMat, band: bandMat, shard: shardMat, beam: beamMat, decal: decalMat, halo: haloMat },
      part: null, present: RARITY.common.present, color: RARITY.common.color,
      shardCount: 0, light: null, vis: 1,
      state: 'idle', age: 0, fade: 0, phase: 0, spin: 0, groundY: 0, alive: false,
      vel: new THREE.Vector3(), basePos: new THREE.Vector3(),
    };
  }

  /** Re-skin a pooled rig for a specific part's rarity. */
  _dress(p, part) {
    const rd = RARITY[part.rarity] || RARITY.common;
    const pr = rd.present;
    p.part = part;
    p.present = pr;
    p.color = rd.color;
    p.vis = 1;

    _col.set(rd.color);
    p.mats.core.emissive.copy(_col);
    p.mats.band.emissive.copy(_col);
    p.mats.shard.emissive.copy(_col);
    p.mats.beam.color.copy(_col);
    p.mats.decal.color.copy(_col);
    p.mats.halo.color.set(rd.glow);
    // Higher rarities read as cleaner, less scavenged hardware.
    p.mats.hull.color.setHex(rd.index >= 3 ? 0xc2cad1 : 0x8e969c);
    p.mats.hull.emissive.copy(_col).multiplyScalar(rd.index >= 4 ? 0.10 : 0.02);

    p.shardCount = pr.shards;
    p.shards.count = pr.shards;
    p.shards.visible = pr.shards > 0;

    p.beam.visible = pr.beamH > 0;
    p.beam.scale.set(pr.beamR, pr.beamH, pr.beamR);

    p.bandB.visible = rd.index >= 2;

    if (p.light) { this._giveLight(p.light); p.light = null; }
    if (pr.light > 0) {
      const l = this._takeLight();
      if (l) {
        l.color.copy(_col);
        l.distance = 24 + pr.light * 1.6;
        l.intensity = pr.light;
        p.light = l;
      }
    }
    this._setOpacity(p, 1);
  }

  _setOpacity(p, k) {
    p.vis = k;
    p.mats.hull.opacity = k;
    p.mats.core.opacity = k;
    p.mats.band.opacity = k;
    p.mats.shard.opacity = k;
    // beam / decal / halo opacity is driven per-frame in _animate and folded
    // through `vis`, so nothing to do for them here.
  }

  _acquire() {
    const p = this._pool.pop() || this._create();
    p.alive = true;
    return p;
  }

  _release(p) {
    p.alive = false;
    p.part = null;
    p.root.visible = false;
    p.state = 'idle';
    if (p.light) { this._giveLight(p.light); p.light = null; }
    if (this._pool.length < MAX_LIVE) this._pool.push(p);
    else this._destroy(p);
  }

  /** Cap enforcement: the oldest idle drop starts fading out. */
  _enforceCap() {
    let live = 0;
    for (let i = 0; i < this._active.length; i++) {
      if (this._active[i].state !== 'fade' && this._active[i].state !== 'collect') live++;
    }
    if (live < MAX_LIVE) return;
    let oldest = null;
    for (let i = 0; i < this._active.length; i++) {
      const p = this._active[i];
      if (p.state === 'fade' || p.state === 'collect') continue;
      if (!oldest || p.age > oldest.age) oldest = p;
    }
    if (oldest) { oldest.state = 'fade'; oldest.fade = 0; }
  }

  _destroy(p) {
    this._group.remove(p.root);
    for (const k in p.mats) p.mats[k].dispose();
  }

  dispose() {
    this._offDrop?.();
    this._offBuild?.();
    for (let i = 0; i < this._active.length; i++) this._destroy(this._active[i]);
    for (let i = 0; i < this._pool.length; i++) this._destroy(this._pool[i]);
    this._active.length = 0;
    this._pool.length = 0;
    for (let i = 0; i < this._lights.length; i++) this._lights[i].dispose?.();
    this._lights.length = 0;
    const kit = this._kit;
    if (kit) {
      for (const k in kit.geo) kit.geo[k].dispose();
      kit.beamTex?.dispose();
      kit.decalTex?.dispose();
      // kit.tex / haloTex are owned by the shared TextureForge cache.
    }
    this._kit = null;
    this.scene?.remove(this._group);
  }
}

export { DROP_TABLES, ARCHETYPE_ALIASES };
export default LootSystem;
