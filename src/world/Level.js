import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getForge } from '../render/TextureForge.js';
import { Terrain } from './Terrain.js';
import * as S from './Structures.js';
import { clamp, lerp, smoothstep, mulberry32, hash01, TAU } from '../core/MathUtils.js';

/**
 * Level — "Watchpoint Alpha".
 *
 * A derelict refinery / launch-gantry installation on a dust plateau, ringed by
 * mesa cliffs. Roughly 900 x 900 m of playable ground with 220 m of hard
 * verticality, built to be flown through at 150 m/s.
 *
 * Structure of the build
 * ----------------------
 * 1. `Terrain` gets a concrete pad punched in under every district and under
 *    every haul road *before* the height field is evaluated, so the ground the
 *    buildings stand on is flat by construction rather than by fudging their Y.
 * 2. Every structure is kit-bashed from `Structures.js` into one of four
 *    `GeoBatch`es (the megastructure plus three spatial groups). Each batch
 *    welds down to one mesh per material family — the entire installation, tens
 *    of thousands of struts, vents, ladders and handrails, is ~30 draw calls.
 * 3. Props are `InstancedMesh` — hundreds of containers, drums, spools, wrecks
 *    and rubble for a handful of calls.
 * 4. Emissive life (warning lamps, strobes, floodlight halos), ground dust,
 *    steam plumes and wind-driven tarps are instanced billboard fields whose
 *    animation lives entirely in the vertex shader — `update()` writes exactly
 *    two uniforms and allocates nothing.
 *
 * Collision follows the cheap path deliberately: the terrain and the walkable
 * catwalk decks are registered as triangles (`physics.addStatic`), everything
 * else as AABBs (`physics.addBox`). Rotated buildings are sliced into a handful
 * of axis-aligned slabs so a 30-degree hangar does not carry a fat phantom box
 * around its corners.
 */

/* ========================================================================== */
/*  Layout — authored, not random. Randomness only decorates.                  */
/* ========================================================================== */

const SEED = 0x5ea7a1;

const TERRAIN_SIZE = 1600;
const TERRAIN_SEGS = 320;
const ARENA_R = 430;

/** Districts. `yaw` rotates the whole block; pads are cut to match. */
const D_GANTRY = { x: 152, z: -212, yaw: 0.30, sx: 300, sz: 250 };
const D_HANGAR = { x: -198, z: 52, yaw: -0.24, sx: 250, sz: 175 };
const D_TANKS = { x: -52, z: 252, yaw: 0.13, sx: 215, sz: 195 };
const D_SUBST = { x: 262, z: 118, yaw: -0.36, sx: 170, sz: 155 };
const D_SILOS = { x: -272, z: -178, yaw: 0.44, sx: 180, sz: 155 };
const D_YARD = { x: 22, z: 18, yaw: -0.11, sx: 180, sz: 155 };
const D_POST = { x: 322, z: -58, yaw: 0.56, sx: 115, sz: 100 };

const DISTRICTS = [D_GANTRY, D_HANGAR, D_TANKS, D_SUBST, D_SILOS, D_YARD, D_POST];

const ROADS = [
  [D_HANGAR, D_YARD, 26],
  [D_YARD, D_GANTRY, 30],
  [D_YARD, D_TANKS, 24],
  [D_GANTRY, D_SUBST, 22],
  [D_SILOS, D_HANGAR, 22],
  [D_YARD, D_POST, 20],
  [D_TANKS, D_SUBST, 18],
];

/** Metres of world covered by one texture tile on structure surfaces. */
const UV_STRUCT = 8;

/* ========================================================================== */
/*  Module scratch — update() must never allocate                              */
/* ========================================================================== */

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _poly = [];
const _poly2 = [];

/** Cheap deterministic 2D value noise — cliff erosion and strata only. */
function n2(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const h = (a, b) => hash01((a * 73856093) ^ (b * 19349663) ^ (s * 83492791));
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm2(x, y, s, oct = 4) {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += n2(x, y, s + i * 71) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03; y *= 2.03;
  }
  return sum / norm;
}

/* ========================================================================== */

export class Level {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./Physics.js').Physics} physics
   */
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;

    /** @type {THREE.Vector3[]} authored spawn locations, varied in height */
    this.spawnPoints = [];
    /** @type {THREE.Box3} */
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-ARENA_R - 60, -60, -ARENA_R - 60),
      new THREE.Vector3(ARENA_R + 60, 320, ARENA_R + 60)
    );
    this.arenaRadius = ARENA_R;

    this.root = new THREE.Group();
    this.root.name = 'Level';
    this.scene.add(this.root);

    this.terrain = null;
    this.stats = { meshes: 0, triangles: 0, colliders: 0, instances: 0, buildMs: 0 };

    // --- shared animation uniforms (one object, referenced by every FX shader)
    this._uTime = { value: 0 };
    this._uPlayer = { value: new THREE.Vector3() };
    this._uDustCentre = { value: new THREE.Vector3() };
    this._uFog = { value: 0.003 };

    this._rng = mulberry32(SEED);

    this._meshes = [];
    this._geometries = [];
    this._materials = [];
    this._textures = [];

    /** world AABBs of everything solid — used to keep props out of walls */
    this._blockers = [];
    /** halo/strobe emitters harvested while placing structures */
    this._glows = [];
    /** steam vent anchors */
    this._vents = [];
    /** catwalk deck quads, registered as walkable triangles */
    this._decks = [];

    this._dustTimer = 0;
    this._groundY = 0;
  }

  /* ---------------------------------------------------------------------- */
  /*  Build                                                                  */
  /* ---------------------------------------------------------------------- */

  /** @returns {Promise<Level>} */
  async build() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this._forge = getForge(this.scene.userData && this.scene.userData.renderer);
    this._makeMaterials();
    await this._tick();

    this._buildTerrain();
    await this._tick();

    this._buildBoundary();
    await this._tick();

    this._buildStructures();
    await this._tick();

    this._buildProps();
    await this._tick();

    this._buildAtmosphere();
    this._finalise();

    S.clearGeoCache();
    this.stats.buildMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    return this;
  }

  /** Yield to the event loop so the boot progress bar can actually paint. */
  _tick() {
    return new Promise((r) => setTimeout(r, 0));
  }

  /* ---------------------------------------------------------------------- */
  /*  Materials                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Two procedural plating sets plus two concrete sets carry the whole level.
   * Families are derived by tint / roughness / metalness rather than by baking
   * six more 500 ms noise fields: the panel layout differs per set, the world
   * position differs per piece, and every batched piece carries its own vertex
   * tint, so nothing reads as "the same texture again".
   */
  _makeMaterials() {
    const forge = this._forge;

    // Big industrial cladding — large plates, heavy wear, no stencils.
    const plateA = forge.hullPlating({
      size: 640, seed: 7717, panelScale: 2,
      baseColor: '#8d949a', accentColor: '#7b8288',
      wear: 0.74, grime: 0.82, baseRough: 0.58, metal: 1.0,
    });
    // Fine machinery plating — small plates, rivets, stencilled markings.
    const plateB = forge.armorPanel({
      size: 512, seed: 3313, panelScale: 5,
      baseColor: '#9aa0a6', accentColor: '#b8632a',
      wear: 0.66, grime: 0.72, rivets: true, stencil: true,
      emissiveDensity: 0, baseRough: 0.5, metal: 1.0,
    });
    const conc = forge.concrete({ size: 320, seed: 4409, tint: '#9a9790' });
    const dust = forge.concrete({ size: 384, seed: 2101, tint: '#a08f72' });

    this._tex = { plateA, plateB, conc, dust };

    const mk = (name, tex, o) => {
      const m = new THREE.MeshStandardMaterial({
        map: tex.map,
        normalMap: tex.normalMap,
        roughnessMap: tex.roughnessMap,
        metalnessMap: tex.metalnessMap || null,
        aoMap: tex.aoMap,
        color: new THREE.Color(o.color),
        roughness: o.rough,
        metalness: o.metal,
        envMapIntensity: o.env !== undefined ? o.env : 1.0,
        aoMapIntensity: o.ao !== undefined ? o.ao : 0.85,
        vertexColors: true,
        dithering: true,
      });
      if (o.normalScale) m.normalScale.set(o.normalScale, o.normalScale);
      m.name = 'Level.' + name;
      this._materials.push(m);
      return m;
    };

    /**
     * Structure families. Deliberately spread across the AC6 palette: gunmetal,
     * oxidised teal, rusted orange, faded hazard yellow, near-black machinery,
     * safety-orange trim, poured concrete.
     */
    this.mat = {
      steel: mk('steel', plateA, { color: 0x7d848b, rough: 0.52, metal: 1.0, env: 1.05, normalScale: 1.0 }),
      teal: mk('teal', plateA, { color: 0x4e7d76, rough: 0.62, metal: 0.9, env: 0.9, normalScale: 1.05 }),
      rust: mk('rust', plateA, { color: 0x8c4f2c, rough: 0.78, metal: 0.72, env: 0.75, normalScale: 1.15 }),
      ochre: mk('ochre', plateB, { color: 0x9c8340, rough: 0.70, metal: 0.8, env: 0.85 }),
      dark: mk('dark', plateB, { color: 0x3a3f44, rough: 0.48, metal: 1.0, env: 1.15 }),
      trim: mk('trim', plateB, { color: 0xb1541c, rough: 0.66, metal: 0.55, env: 0.8 }),
      concrete: mk('concrete', conc, { color: 0x8e8b83, rough: 0.95, metal: 0.0, env: 0.45, ao: 1.0 }),
    };

    // Emissive family: one draw call for every lit grille, lamp housing and
    // hazard strobe in the level. The vertex tint drives the emissive colour so
    // red aircraft lamps and amber sodium fittings share the material.
    const glow = new THREE.MeshStandardMaterial({
      map: plateB.map,
      color: 0x0d0f11,
      emissive: 0xffffff,
      emissiveIntensity: 5.5,
      roughness: 0.35,
      metalness: 0.0,
      vertexColors: true,
      envMapIntensity: 0.2,
    });
    glow.name = 'Level.glow';
    glow.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor;'
      );
    };
    this._materials.push(glow);
    this.mat.glow = glow;

    // Cliffs: stratified rock, vertex-coloured banding, no metal at all.
    const cliff = new THREE.MeshStandardMaterial({
      map: dust.map,
      normalMap: dust.normalMap,
      roughnessMap: dust.roughnessMap,
      aoMap: dust.aoMap,
      color: 0xb2a184,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.55,
      vertexColors: true,
      dithering: true,
    });
    cliff.name = 'Level.cliff';
    cliff.normalScale.set(1.35, 1.35);
    this._materials.push(cliff);
    this.mat.cliff = cliff;

    // Named handles the Structures kit expects.
    this.kit = {
      body: 'steel', trim: 'trim', dark: 'dark', glow: 'glow',
      concrete: 'concrete', glass: 'dark',
    };
  }

  /** Material family key → material, for the weld step. */
  _matFor(key) {
    return this.mat[key] || this.mat.steel;
  }

  /* ---------------------------------------------------------------------- */
  /*  Terrain                                                                */
  /* ---------------------------------------------------------------------- */

  _buildTerrain() {
    const terrain = new Terrain({ size: TERRAIN_SIZE, segments: TERRAIN_SEGS, seed: 90210 });
    this.terrain = terrain;

    for (const d of DISTRICTS) terrain.addPad(d.x, d.z, d.sx, d.sz, d.yaw, 30);
    for (const [a, b, w] of ROADS) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      terrain.addPad((a.x + b.x) * 0.5, (a.z + b.z) * 0.5, len, w, Math.atan2(dz, dx), 12);
    }
    // apron in front of the gantry — the wide open plate the mech lands on
    terrain.addPad(60, -110, 150, 110, 0.3, 26);

    terrain.generate();

    const geo = terrain.buildRenderGeometry();
    const mat = terrain.makeMaterial(this._tex.dust, this._tex.conc, {
      envMapIntensity: 0.5,
      dustTint: 0xc3ab84,
      gravelTint: 0x6f6555,
      padTint: 0x9d9a92,
      normalStrength: 1.35,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Terrain';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    this._meshes.push(mesh);
    this.terrainMesh = mesh;

    // Collision: a half-resolution sample of the SAME height field, so the
    // collider can never disagree with what the player can see.
    const collGeo = terrain.buildCollisionGeometry(2);
    const proxy = new THREE.Mesh(collGeo);
    proxy.updateMatrixWorld(true);
    this.physics.addStatic(proxy, mesh);
    collGeo.dispose();

    this.bounds.min.set(-ARENA_R - 80, terrain.minHeight - 40, -ARENA_R - 80);
    this.bounds.max.set(ARENA_R + 80, 330, ARENA_R + 80);
  }

  /** Terrain height, clamped to the sampled plate. */
  heightAt(x, z) {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
  }

  /* ---------------------------------------------------------------------- */
  /*  Boundary — mesa ring, far plain, distant buttes, containment field      */
  /* ---------------------------------------------------------------------- */

  _buildBoundary() {
    const parts = [];
    parts.push(this._mesaRing());
    parts.push(this._farPlain());
    for (const g of this._distantButtes()) parts.push(g);

    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    merged.setAttribute('uv1', merged.attributes.uv);
    merged.computeBoundingSphere();

    const mesh = new THREE.Mesh(merged, this.mat.cliff);
    mesh.name = 'Boundary';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    this._meshes.push(mesh);
    this._geometries.push(merged);

    this._buildContainmentField();
  }

  /**
   * The cliff wall. A revolved mesa profile with per-angle height/radius noise
   * and per-vertex erosion, vertex-coloured into horizontal strata so the rock
   * reads as sedimentary rather than as a grey cone.
   */
  _mesaRing() {
    const NA = 288;
    // radialOffset, heightFraction — steep face, broken shoulder, long back-slope
    const PROF = [
      [0, 0.00], [3, 0.16], [1.5, 0.34], [6, 0.56], [3.5, 0.72],
      [9, 0.87], [6, 0.95], [22, 1.00], [58, 0.95], [120, 0.80],
      [220, 0.55], [360, 0.26], [520, 0.02],
    ];
    const NP = PROF.length;
    const pos = new Float32Array(NA * NP * 3);
    const col = new Uint8Array(NA * NP * 3);
    const uv = new Float32Array(NA * NP * 2);
    const idx = new Uint32Array((NA) * (NP - 1) * 6);

    const baseY = this.terrain ? this.terrain.minHeight - 6 : -20;

    for (let a = 0; a < NA; a++) {
      const ang = (a / NA) * TAU;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = Math.cos(ang) * 3.2, nz = Math.sin(ang) * 3.2;
      // low-frequency ridge modulation: some sections are tall mesas, some are
      // eroded saddles, so the horizon is never a constant-height wall
      const big = fbm2(nx, nz, 17, 3);
      const mid = fbm2(nx * 3.1, nz * 3.1, 41, 3);
      const r0 = 462 + big * 46 + mid * 22;
      const h = 96 + Math.pow(big, 1.6) * 190 + mid * 34;

      for (let p = 0; p < NP; p++) {
        const [off, frac] = PROF[p];
        const ero = (fbm2(nx * 9 + p * 0.7, nz * 9 - p * 1.3, 89, 3) - 0.5);
        const r = r0 + off * (1 + ero * 0.16) + ero * 7 * (p > 0 && p < NP - 1 ? 1 : 0.2);
        const y = baseY + h * frac + ero * 5.5 * frac;
        const k = a * NP + p;
        pos[k * 3] = ca * r;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = sa * r;
        uv[k * 2] = (ang * r0) / 26;
        uv[k * 2 + 1] = (y) / 26;

        // strata: sharp value bands with a slow hue drift, plus cavity dirt
        const band = Math.sin(y * 0.42 + big * 9) * 0.5 + 0.5;
        const band2 = Math.sin(y * 1.35 + mid * 14) * 0.5 + 0.5;
        const shade = 0.62 + band * 0.30 + band2 * 0.12 + ero * 0.18;
        const warm = 0.86 + band * 0.22;
        const k3 = k * 3;
        col[k3] = clamp(shade * warm, 0, 1) * 255;
        col[k3 + 1] = clamp(shade * (0.94 + band2 * 0.06), 0, 1) * 255;
        col[k3 + 2] = clamp(shade * 0.80, 0, 1) * 255;
      }
    }

    let w = 0;
    for (let a = 0; a < NA; a++) {
      const a1 = (a + 1) % NA;
      for (let p = 0; p < NP - 1; p++) {
        const i0 = a * NP + p, i1 = a * NP + p + 1;
        const j0 = a1 * NP + p, j1 = a1 * NP + p + 1;
        idx[w++] = i0; idx[w++] = j0; idx[w++] = i1;
        idx[w++] = i1; idx[w++] = j0; idx[w++] = j1;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    return g;
  }

  /** Dust plain beyond the cliffs — gives the horizon something to sit on. */
  _farPlain() {
    const NA = 128, NR = 7;
    const R0 = 900, R1 = 3200;
    const pos = new Float32Array(NA * NR * 3);
    const col = new Uint8Array(NA * NR * 3);
    const uv = new Float32Array(NA * NR * 2);
    const idx = new Uint32Array(NA * (NR - 1) * 6);
    const baseY = this.terrain ? this.terrain.minHeight + 4 : 0;

    for (let a = 0; a < NA; a++) {
      const ang = (a / NA) * TAU;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let r = 0; r < NR; r++) {
        const t = r / (NR - 1);
        const rad = lerp(R0, R1, t * t);
        const n = fbm2(ca * rad * 0.004, sa * rad * 0.004, 133, 4);
        const y = baseY - 6 + (n - 0.5) * 34 * (0.35 + t);
        const k = a * NR + r;
        pos[k * 3] = ca * rad; pos[k * 3 + 1] = y; pos[k * 3 + 2] = sa * rad;
        uv[k * 2] = ca * rad / 40; uv[k * 2 + 1] = sa * rad / 40;
        const sh = 0.72 + n * 0.32;
        col[k * 3] = clamp(sh * 1.02, 0, 1) * 255;
        col[k * 3 + 1] = clamp(sh * 0.97, 0, 1) * 255;
        col[k * 3 + 2] = clamp(sh * 0.86, 0, 1) * 255;
      }
    }
    let w = 0;
    for (let a = 0; a < NA; a++) {
      const a1 = (a + 1) % NA;
      for (let r = 0; r < NR - 1; r++) {
        const i0 = a * NR + r, i1 = a * NR + r + 1;
        const j0 = a1 * NR + r, j1 = a1 * NR + r + 1;
        idx[w++] = i0; idx[w++] = i1; idx[w++] = j0;
        idx[w++] = i1; idx[w++] = j1; idx[w++] = j0;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    return g;
  }

  /** Silhouette buttes on the far plain: the third depth layer. */
  _distantButtes() {
    const rng = mulberry32(SEED ^ 0x9a1);
    const out = [];
    const baseY = this.terrain ? this.terrain.minHeight - 4 : -20;
    for (let i = 0; i < 17; i++) {
      const ang = (i / 17) * TAU + (rng() - 0.5) * 0.28;
      const rad = 980 + rng() * 1250;
      const cx = Math.cos(ang) * rad, cz = Math.sin(ang) * rad;
      const r = 90 + rng() * 240;
      const h = 90 + rng() * 300;
      const NA = 26, NP = 6;
      const PROF = [[0, 0], [0.10, 0.42], [0.06, 0.66], [0.22, 0.88], [0.30, 1.0], [0.62, 0.72]];
      const pos = new Float32Array(NA * NP * 3);
      const col = new Uint8Array(NA * NP * 3);
      const uv = new Float32Array(NA * NP * 2);
      const idx = new Uint32Array(NA * (NP - 1) * 6);
      const seed = 200 + i * 13;
      for (let a = 0; a < NA; a++) {
        const t = (a / NA) * TAU;
        const ca = Math.cos(t), sa = Math.sin(t);
        const wob = 0.78 + fbm2(ca * 2.4, sa * 2.4, seed, 3) * 0.5;
        for (let p = 0; p < NP; p++) {
          const rr = r * (1 - PROF[p][0]) * wob;
          const y = baseY + h * PROF[p][1] * (0.85 + fbm2(ca * 1.2, sa * 1.2, seed + 7, 2) * 0.3);
          const k = a * NP + p;
          pos[k * 3] = cx + ca * rr; pos[k * 3 + 1] = y; pos[k * 3 + 2] = cz + sa * rr;
          uv[k * 2] = t * rr / 40; uv[k * 2 + 1] = y / 40;
          const band = Math.sin(y * 0.25 + i) * 0.5 + 0.5;
          const sh = 0.66 + band * 0.3;
          col[k * 3] = clamp(sh * 1.04, 0, 1) * 255;
          col[k * 3 + 1] = clamp(sh * 0.96, 0, 1) * 255;
          col[k * 3 + 2] = clamp(sh * 0.84, 0, 1) * 255;
        }
      }
      let w = 0;
      for (let a = 0; a < NA; a++) {
        const a1 = (a + 1) % NA;
        for (let p = 0; p < NP - 1; p++) {
          const i0 = a * NP + p, i1 = a * NP + p + 1;
          const j0 = a1 * NP + p, j1 = a1 * NP + p + 1;
          idx[w++] = i0; idx[w++] = j0; idx[w++] = i1;
          idx[w++] = i1; idx[w++] = j0; idx[w++] = j1;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      out.push(g);
    }
    return out;
  }

  /**
   * Containment field at `arenaRadius`: a barely-there vertical curtain that
   * only resolves when the player gets near it, so the arena edge is legible
   * without a wall of light dominating every wide shot.
   */
  _buildContainmentField() {
    const baseY = this.terrain ? this.terrain.minHeight : -20;
    const geo = new THREE.CylinderGeometry(ARENA_R, ARENA_R, 200, 168, 6, true);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._uTime,
        uPlayer: this._uPlayer,
        uFog: this._uFog,
        uColor: { value: new THREE.Color(0x2fa8ff) },
      },
      vertexShader: /* glsl */`
        varying vec3 vW;
        varying vec2 vUvv;
        void main() {
          vUvv = uv;
          vec4 wp = modelMatrix * vec4( position, 1.0 );
          vW = wp.xyz;
          vec4 mv = viewMatrix * wp;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        uniform float uFog;
        uniform vec3 uPlayer;
        uniform vec3 uColor;
        varying vec3 vW;
        varying vec2 vUvv;
        void main() {
          float d = length( vW.xz - uPlayer.xz );
          float prox = 1.0 - smoothstep( 55.0, 210.0, d );
          float vert = smoothstep( 0.02, 0.30, vUvv.y ) * ( 1.0 - smoothstep( 0.45, 0.98, vUvv.y ) );
          float bars = 0.55 + 0.45 * sin( vUvv.x * 1340.0 );
          float scan = 0.5 + 0.5 * sin( vW.y * 0.34 - uTime * 1.7 );
          float pulse = 0.72 + 0.28 * sin( uTime * 2.3 + vUvv.x * 40.0 );
          float a = ( 0.035 + prox * 0.62 ) * vert * ( 0.28 + 0.72 * bars * scan ) * pulse;
          float cam = length( vW - cameraPosition );
          a *= exp( -uFog * cam * 0.55 );
          vec3 c = uColor * ( 0.5 + prox * 3.4 );
          gl_FragColor = vec4( c * a, a );
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'ContainmentField';
    mesh.position.y = baseY + 92;
    mesh.renderOrder = 4;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    this._meshes.push(mesh);
    this._geometries.push(geo);
    this._materials.push(mat);
  }

  /* ---------------------------------------------------------------------- */
  /*  Placement helpers                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Push a district-local frame onto the batch and return the resolved world
   * transform. Structures are grounded on the terrain they actually stand on.
   */
  _at(b, D, lx, lz, lyaw = 0) {
    const c = Math.cos(D.yaw), s = Math.sin(D.yaw);
    const wx = D.x + c * lx + s * lz;
    const wz = D.z - s * lx + c * lz;
    const wy = this.heightAt(wx, wz);
    b.pushTRS(wx, wy, wz, D.yaw + lyaw);
    return { x: wx, y: wy, z: wz, yaw: D.yaw + lyaw };
  }

  /** Clip a convex polygon to the vertical strip [xa,xb]. Build-time only. */
  static _clipX(src, dst, x, keepGreater) {
    dst.length = 0;
    const n = src.length;
    for (let i = 0; i < n; i++) {
      const a = src[i], c = src[(i + 1) % n];
      const ina = keepGreater ? a[0] >= x : a[0] <= x;
      const inc = keepGreater ? c[0] >= x : c[0] <= x;
      if (ina) dst.push(a);
      if (ina !== inc) {
        const t = (x - a[0]) / (c[0] - a[0]);
        dst.push([x, a[1] + (c[1] - a[1]) * t]);
      }
    }
    return dst;
  }

  /**
   * Register a rotated footprint as a small run of axis-aligned slabs. A single
   * AABB around a 30-degree hangar would put an invisible wall on each corner;
   * four or six slabs track the real outline closely enough that the mech can
   * hug it at 150 m/s without noticing.
   */
  _addOBB(cx, cz, w, d, yaw, y0, y1, slices, owner) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hw = w * 0.5, hd = d * 0.5;
    const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([ax, az]) => [
      cx + c * ax + s * az,
      cz - s * ax + c * az,
    ]);
    let minx = Infinity, maxx = -Infinity;
    for (const p of corners) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; }

    const n = Math.max(1, slices | 0);
    for (let i = 0; i < n; i++) {
      const xa = lerp(minx, maxx, i / n);
      const xb = lerp(minx, maxx, (i + 1) / n);
      let poly = Level._clipX(corners, _poly, xa, true);
      if (poly.length < 3) continue;
      poly = Level._clipX(poly.slice(), _poly2, xb, false);
      if (poly.length < 3) continue;
      let zmin = Infinity, zmax = -Infinity;
      for (const p of poly) { if (p[1] < zmin) zmin = p[1]; if (p[1] > zmax) zmax = p[1]; }
      _box.min.set(xa, y0, zmin);
      _box.max.set(xb, y1, zmax);
      this.physics.addBox(_box, owner);
      this._blockers.push([xa, zmin, xb, zmax, y1]);
      this.stats.colliders++;
    }
  }

  /** Axis-aligned collider convenience (towers, tanks, props). */
  _addAABB(cx, cz, w, d, y0, y1, owner) {
    _box.min.set(cx - w * 0.5, y0, cz - d * 0.5);
    _box.max.set(cx + w * 0.5, y1, cz + d * 0.5);
    this.physics.addBox(_box, owner);
    this._blockers.push([cx - w * 0.5, cz - d * 0.5, cx + w * 0.5, cz + d * 0.5, y1]);
    this.stats.colliders++;
  }

  /** Is (x,z) inside (or within `pad` of) anything already placed? */
  _blocked(x, z, pad) {
    const B = this._blockers;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (x > b[0] - pad && x < b[2] + pad && z > b[1] - pad && z < b[3] + pad) return true;
    }
    return false;
  }

  /**
   * Record an emissive halo. `mode` 0 = steady, 1 = fast hazard strobe,
   * 2 = slow aircraft-warning blink.
   */
  _beacon(x, y, z, color, size, mode, period, phase) {
    this._glows.push({
      x, y, z, color, size,
      mode: mode || 0,
      period: period || 2.0,
      phase: phase !== undefined ? phase : this._rng(),
    });
  }

  _spawn(x, y, z) {
    this.spawnPoints.push(new THREE.Vector3(x, y, z));
  }

  /* ---------------------------------------------------------------------- */
  /*  Structures                                                             */
  /* ---------------------------------------------------------------------- */

  _buildStructures() {
    const rng = this._rng;
    const K = this.kit;

    // Four batches: the landmark, plus three spatial groups so the shadow
    // cascades and the camera frustum still have something to cull.
    const bMega = new S.GeoBatch(UV_STRUCT);
    const bWest = new S.GeoBatch(UV_STRUCT);
    const bEast = new S.GeoBatch(UV_STRUCT);
    const bCore = new S.GeoBatch(UV_STRUCT);

    this._megastructure(bMega, rng, K);
    this._hangarRow(bWest, rng, K);
    this._siloCluster(bWest, rng, K);
    this._tankFarm(bCore, rng, K);
    this._stagingYard(bCore, rng, K);
    this._substation(bEast, rng, K);
    this._outpost(bEast, rng, K);
    this._pylonLine(bEast, rng, K);
    this._longSpans(bCore, rng, K);

    this._weld(bMega, 'Mega');
    this._weld(bWest, 'West');
    this._weld(bCore, 'Core');
    this._weld(bEast, 'East');

    // Walkable catwalk decks — the only structure geometry that goes into the
    // triangle soup, because the player has to be able to stand on them.
    this._registerDecks();
  }

  /** Weld a batch into one mesh per material family. */
  _weld(batch, label) {
    const geos = batch.build();
    for (const [key, geo] of geos) {
      const mat = this._matFor(key);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `Level.${label}.${key}`;
      const isGlow = key === 'glow';
      mesh.castShadow = !isGlow;
      mesh.receiveShadow = !isGlow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this._meshes.push(mesh);
      this._geometries.push(geo);
      this.stats.triangles += geo.index.count / 3;
    }
    batch.reset();
  }

  /* --- THE GANTRY: the landmark ----------------------------------------- */

  /**
   * A refinery and launch-gantry complex: a 196 m lattice tower carrying a 160 m
   * cantilevered arm over a bank of cooling stacks, containment tanks and a
   * process hall, laced together with pipe bridges and catwalks. Visible from
   * every corner of the arena and the thing every wide shot is composed around.
   */
  _megastructure(b, rng, K) {
    const D = D_GANTRY;

    // --- main tower -------------------------------------------------------
    const towerH = 196;
    let t = this._at(b, D, 0, 0);
    S.trussTower(b, K.dark, {
      height: towerH, base: 30, top: 15, bays: 24,
      chord: 1.25, brace: 0.5, rng, platformAt: [0.32, 0.58, 0.80],
    });
    // clad the lower third so it is not pure lattice — mass at the base sells
    // the height of everything above it
    b.box(K.body, 22, 46, 22, 0, 24, 0, 0, { chamfer: 1.1, tint: 0xc8c2b6 });
    b.box(K.trim, 25, 1.8, 25, 0, 47.5, 0, 0, { tint: 0xd8cfbe });
    b.box(K.concrete, 40, 3.0, 40, 0, 1.5, 0, 0, { chamfer: 0.6 });
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5 + Math.PI * 0.25;
      S.louvres(b, K.dark, Math.cos(a) * 11.2, 28, Math.sin(a) * 11.2, 9, 12, a + Math.PI * 0.5, rng, 0xb9b2a6);
      b.box(K.glow, 0.6, 2.4, 0.3, Math.cos(a) * 11.4, 14, Math.sin(a) * 11.4, a, { tint: 0xffb14a });
    }
    S.ladder(b, K.dark, 11.6, 0, 3, 48, -Math.PI * 0.5);
    this._addAABB(t.x, t.z, 26, 26, t.y - 4, t.y + towerH);
    this._spawn(t.x + 20, t.y + towerH * 0.32 + 3, t.z);
    this._spawn(t.x - 18, t.y + towerH * 0.80 + 3, t.z + 6);
    this._beacon(t.x, t.y + towerH + 6, t.z, 0xff2008, 4.5, 2, 2.6, 0.0);
    this._beacon(t.x + 11, t.y + towerH * 0.58 + 4, t.z, 0xff2008, 3.0, 2, 3.1, 0.35);
    this._beacon(t.x - 11, t.y + towerH * 0.32 + 4, t.z, 0xff2008, 3.0, 2, 2.9, 0.7);
    b.pop();

    // --- the cantilever arm ----------------------------------------------
    const armY = 152, armLen = 162;
    t = this._at(b, D, armLen * 0.5 - 16, 0);
    b.pushTRS(0, armY, 0);
    S.trussBeam(b, K.dark, {
      length: armLen, depth: 11, width: 12,
      bays: 20, chord: 0.85, brace: 0.42,
    });
    b.box(K.dark, armLen, 0.30, 9.5, 0, 11.3, 0, 0, { tint: 0xa9a49b });
    S.railing(b, K.dark, -armLen * 0.5, -4.8, armLen * 0.5, -4.8, 11.5, 1.2);
    S.railing(b, K.dark, -armLen * 0.5, 4.8, armLen * 0.5, 4.8, 11.5, 1.2);
    // service rails + trolley
    for (const s of [-1, 1]) {
      b.box(K.trim, armLen, 0.4, 0.55, 0, 11.75, s * 3.2, 0, { tint: 0xd2c8b6 });
    }
    b.box(K.body, 9, 6, 11, armLen * 0.22, 15.0, 0, 0, { chamfer: 0.5, tint: 0xbfb9ad });
    b.box(K.dark, 11, 1.2, 12.4, armLen * 0.22, 11.8, 0, 0);
    // head block hanging on cables at the arm tip
    const tipX = armLen * 0.5 - 8;
    for (const s of [-1, 1]) {
      b.pipe(K.dark, tipX, 0.4, s * 2.0, tipX, -34, s * 2.0, 0.16, 6, { tint: 0x8f8a82 });
    }
    b.box(K.trim, 6.5, 3.4, 6.5, tipX, -36.5, 0, 0, { chamfer: 0.3, tint: 0xe0c98a });
    b.box(K.dark, 4.0, 2.4, 4.0, tipX, -39.4, 0, 0, { chamfer: 0.2 });
    b.box(K.glow, 1.0, 0.5, 0.5, tipX, -35.0, 3.4, 0, { tint: 0xff2008 });
    // pipes running the length of the arm
    for (let i = 0; i < 3; i++) {
      b.pipe(K.body, -armLen * 0.5, -1.4, -3.2 + i * 3.2, armLen * 0.5, -1.4, -3.2 + i * 3.2, 0.5, 9, { tint: 0xb38a5f });
    }
    b.pop();
    b.pop();

    // back-stay: from the tower crown down to the arm, in world space
    {
      const t2 = this._at(b, D, 0, 0);
      for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const x0 = 14 + i * 34, x1 = 14 + (i + 1) * 34;
          const y0 = towerH - 4 - i * 8.5, y1 = towerH - 4 - (i + 1) * 8.5;
          b.strut(K.dark, x0, y0, s * 5.5, x1, y1, s * 5.5, 0.5, { tint: 0x9c968c });
          b.strut(K.dark, x0, y0, s * 5.5, x1, armY + 11, s * 5.5, 0.28, { tint: 0x9c968c });
        }
        // counterweight tail on the far side
        b.strut(K.dark, -6, towerH - 12, s * 5.5, -46, armY + 6, s * 5.5, 0.6, { tint: 0x9c968c });
      }
      b.box(K.body, 16, 10, 16, -50, armY + 2, 0, 0, { chamfer: 0.7, tint: 0x9d968a });
      b.box(K.trim, 17.5, 1.0, 17.5, -50, armY + 7.6, 0, 0);
      this._spawn(t2.x - 50 * Math.cos(D.yaw), t2.y + armY + 9, t2.z + 50 * Math.sin(D.yaw));
      b.pop();
    }

    // --- cooling stacks ---------------------------------------------------
    const stacks = [
      [-74, -46, 152, 8.0, 5.2], [-98, 12, 122, 7.0, 4.6],
      [-62, 62, 96, 6.2, 4.2], [-88, -92, 134, 7.6, 4.9],
    ];
    for (let i = 0; i < stacks.length; i++) {
      const [lx, lz, h, r0, r1] = stacks[i];
      const p = this._at(b, D, lx, lz);
      const r = S.coolingStack(b, {
        body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { rBase: r0, rTop: r1, h, tint: i % 2 ? 0xb7a58c : 0xc4bcae });
      b.pop();
      this._addAABB(p.x, p.z, r0 * 2.1, r0 * 2.1, p.y - 4, p.y + h);
      this._vents.push([p.x, p.y + h + 3, p.z, 3.6 + i * 0.4]);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU;
        this._beacon(p.x + Math.cos(a) * (r1 + 1.6), p.y + h + 3.9, p.z + Math.sin(a) * (r1 + 1.6),
          0xff2008, 2.4, 2, 2.2 + i * 0.37, i * 0.21 + k * 0.11);
      }
      this._beacon(p.x, p.y + h * 0.55, p.z + r0, 0xff2008, 1.8, 2, 3.4 + i * 0.2, i * 0.3);
      this._spawn(p.x + r0 + 3, p.y + h * 0.6, p.z);
      void r;
    }

    // --- process hall -----------------------------------------------------
    {
      const p = this._at(b, D, -22, -78, 0.06);
      const r = S.hangar(b, {
        body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w: 58, d: 92, wallH: 22, roofR: 27, rng, tint: 0xb6ae9e });
      b.pop();
      this._addOBB(p.x, p.z, 60, 94, p.yaw, p.y - 4, p.y + r.h, 6);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
      this._beacon(p.x, p.y + r.roofY + 2, p.z, 0xffb14a, 1.6, 1, 1.1, 0.2);
      this._vents.push([p.x + 8, p.y + r.roofY - 1, p.z - 20, 2.2]);
    }

    // --- tank cluster -----------------------------------------------------
    const tanks = [[62, -58, 14, 30], [88, 42, 12, 24], [34, 74, 16, 34], [104, -18, 10, 20]];
    for (let i = 0; i < tanks.length; i++) {
      const [lx, lz, r0, h] = tanks[i];
      const p = this._at(b, D, lx, lz, rng() * TAU);
      const info = S.tank(b, {
        body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { r: r0, h, rng, tint: i % 2 ? 0x9fb0a6 : 0xc0b6a4 });
      b.pop();
      this._addAABB(p.x, p.z, r0 * 2, r0 * 2, p.y - 4, p.y + info.roofY);
      this._spawn(p.x, p.y + info.roofY + 3, p.z);
      this._beacon(p.x, p.y + info.h, p.z, 0xff2008, 1.6, 2, 3.0 + i * 0.4, i * 0.25);
      if (i % 2 === 0) this._vents.push([p.x + r0 * 0.4, p.y + h + 3, p.z, 2.4]);
    }
    {
      const p = this._at(b, D, 128, 36);
      const info = S.sphereTank(b, { body: K.body, trim: K.trim, dark: K.dark, glow: K.glow }, { r: 11, legH: 8, tint: 0xa9b7ad });
      b.pop();
      this._addAABB(p.x, p.z, 20, 20, p.y - 4, p.y + info.h * 0.9);
      this._beacon(p.x, p.y + info.h, p.z, 0xff2008, 1.5, 2, 2.7, 0.6);
    }

    // --- pipe bridges + catwalks -----------------------------------------
    {
      const p = this._at(b, D, 36, -6, Math.PI * 0.5);
      S.pipeBridge(b, { body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete },
        { length: 128, y: 30, width: 7, bents: 5, groundY: 0, tint: 0xb0a795 });
      this._deckWorld(p, -64, 33.7, 0, 64, 33.7, 0, 5.4);
      this._spawn(p.x, p.y + 35, p.z);
      b.pop();
    }
    {
      const p = this._at(b, D, -56, 10, 0.0);
      S.pipeBridge(b, { body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete },
        { length: 104, y: 46, width: 6, bents: 4, groundY: 0, tint: 0xa39a89 });
      this._deckWorld(p, -52, 49.7, 0, 52, 49.7, 0, 4.6);
      this._spawn(p.x + 20, p.y + 51, p.z);
      b.pop();
    }

    // ground-level pipe runs weaving between the tanks
    {
      const p = this._at(b, D, 0, 0);
      S.pipeRun(b, { body: K.body, dark: K.dark, trim: K.trim }, {
        pts: [[62, -58], [92, -58], [92, 40], [40, 72]], r: 0.85, count: 4, y: 5.5, rng, tint: 0xb0895c,
      });
      S.pipeRun(b, { body: K.body, dark: K.dark, trim: K.trim }, {
        pts: [[-74, -46], [-30, -46], [-30, 40], [30, 60]], r: 0.7, count: 3, y: 4.2, rng, tint: 0x8fa39a,
      });
      b.pop();
    }

    // perimeter blast walls + floodlights
    for (let i = 0; i < 5; i++) {
      const a = -0.4 + i * 0.34;
      const lx = Math.cos(a) * 132, lz = Math.sin(a) * 132;
      const p = this._at(b, D, lx, lz, a + Math.PI * 0.5);
      S.blastWall(b, { concrete: K.concrete, trim: K.trim, dark: K.dark }, { length: 52, h: 8, t: 1.8, segs: 5, rng });
      this._addOBB(p.x, p.z, 52, 2.2, p.yaw, p.y - 2, p.y + 8, 3);
      b.pop();
    }
    for (const [lx, lz] of [[70, -110], [-110, -110], [-118, 88], [116, 92]]) {
      const p = this._at(b, D, lx, lz, rng() * TAU);
      S.floodMast(b, { concrete: K.concrete, dark: K.dark, trim: K.trim, glow: K.glow }, { h: 26, rng });
      this._addAABB(p.x, p.z, 2.6, 2.6, p.y, p.y + 26);
      for (let i = 0; i < 4; i++) {
        this._beacon(p.x + (i - 1.5) * 0.75, p.y + 26.6, p.z, 0xffc078, 3.4, 0, 1, 0);
      }
      b.pop();
    }
  }

  /* --- HANGAR ROW -------------------------------------------------------- */

  _hangarRow(b, rng, K) {
    const D = D_HANGAR;
    const specs = [
      [-72, -22, 46, 70, 16, 0.0, 0xb9b2a2],
      [-8, -30, 54, 84, 19, 0.02, 0xa6b0a8],
      [62, -20, 42, 62, 15, -0.03, 0xbaa48c],
    ];
    for (let i = 0; i < specs.length; i++) {
      const [lx, lz, w, d, wh, ly, tint] = specs[i];
      const p = this._at(b, D, lx, lz, ly);
      const r = S.hangar(b, {
        body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w, d, wallH: wh, roofR: w * 0.52, rng, tint });
      b.pop();
      this._addOBB(p.x, p.z, w + 2.4, d + 2.4, p.yaw, p.y - 4, p.y + r.h, 5);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
      this._beacon(p.x, p.y + r.roofY + 1.5, p.z, 0xffb14a, 1.5, 1, 1.3 + i * 0.2, i * 0.4);
      this._beacon(p.x + w * 0.3, p.y + wh * 0.9, p.z + d * 0.5, 0xff2008, 1.2, 2, 2.4, i * 0.3);
      this._vents.push([p.x - w * 0.18, p.y + r.roofY - 2, p.z + d * 0.2, 2.0]);
    }

    // support blocks behind the row
    const blocks = [[-88, 46, 28, 22, 24], [12, 52, 34, 26, 30], [76, 44, 24, 20, 18]];
    for (let i = 0; i < blocks.length; i++) {
      const [lx, lz, w, d, h] = blocks[i];
      const p = this._at(b, D, lx, lz, (rng() - 0.5) * 0.12);
      const r = S.blockhouse(b, {
        body: i === 1 ? 'teal' : K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w, d, h, rng, tint: i === 1 ? 0xbfd0c6 : 0xb6ada0 });
      b.pop();
      this._addOBB(p.x, p.z, w + 1.6, d + 1.6, p.yaw, p.y - 3, p.y + r.h, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
      for (const sx of [-1, 1]) {
        this._beacon(p.x + sx * w * 0.45, p.y + r.roofY + 1.8, p.z, 0xff2008, 1.1, 2, 2.8 + i * 0.3, i * 0.2 + (sx > 0 ? 0.5 : 0));
      }
    }

    // conveyor gallery over the apron
    {
      const p = this._at(b, D, 0, 12, 0);
      S.pipeBridge(b, { body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete },
        { length: 176, y: 28, width: 6, bents: 6, groundY: 0, tint: 0xa79c8a });
      this._deckWorld(p, -88, 31.7, 0, 88, 31.7, 0, 4.6);
      this._spawn(p.x + 40, p.y + 33, p.z);
      this._spawn(p.x - 40, p.y + 33, p.z);
      b.pop();
    }

    // blast walls framing the apron
    for (let i = 0; i < 3; i++) {
      const p = this._at(b, D, -100 + i * 100, -74, 0);
      S.blastWall(b, { concrete: K.concrete, trim: K.trim, dark: K.dark }, { length: 68, h: 7.5, t: 1.7, segs: 6, rng });
      this._addOBB(p.x, p.z, 68, 2.0, p.yaw, p.y - 2, p.y + 7.5, 4);
      b.pop();
    }
    for (const [lx, lz] of [[-108, -46], [104, -48], [-104, 70], [102, 68]]) {
      const p = this._at(b, D, lx, lz, rng() * TAU);
      S.floodMast(b, { concrete: K.concrete, dark: K.dark, trim: K.trim, glow: K.glow }, { h: 22, rng });
      this._addAABB(p.x, p.z, 2.4, 2.4, p.y, p.y + 22);
      for (let i = 0; i < 4; i++) this._beacon(p.x + (i - 1.5) * 0.7, p.y + 22.6, p.z, 0xffc078, 3.0, 0, 1, 0);
      b.pop();
    }
    this._spawn(D.x, this.heightAt(D.x, D.z) + 3, D.z - 60);
  }

  /* --- SILO CLUSTER ------------------------------------------------------ */

  _siloCluster(b, rng, K) {
    const D = D_SILOS;
    {
      const p = this._at(b, D, -14, -18, 0);
      const r = S.siloBank(b, {
        body: 'teal', trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { n: 6, r: 8.2, h: 58, rng, tint: 0xc3d2c8 });
      b.pop();
      this._addOBB(p.x, p.z, r.span + 17, 18, p.yaw, p.y - 4, p.y + r.roofY, 6);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
      this._beacon(p.x - r.span * 0.5, p.y + r.roofY + 1, p.z, 0xff2008, 2.0, 2, 2.5, 0.1);
      this._beacon(p.x + r.span * 0.5, p.y + r.roofY + 1, p.z, 0xff2008, 2.0, 2, 2.5, 0.6);
      this._vents.push([p.x, p.y + r.roofY + 2, p.z, 2.4]);
    }
    {
      const p = this._at(b, D, 46, 40, 0.7);
      const r = S.siloBank(b, {
        body: 'rust', trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { n: 3, r: 6.4, h: 40, rng, tint: 0xd6b49a });
      b.pop();
      this._addOBB(p.x, p.z, r.span + 14, 15, p.yaw, p.y - 4, p.y + r.roofY, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
      this._beacon(p.x, p.y + r.roofY + 1, p.z, 0xff2008, 1.6, 2, 3.3, 0.4);
    }
    {
      const p = this._at(b, D, -8, 52, 0.1);
      const r = S.blockhouse(b, {
        body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w: 26, d: 20, h: 16, rng, tint: 0xafa899 });
      b.pop();
      this._addOBB(p.x, p.z, 27, 21, p.yaw, p.y - 3, p.y + r.h, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
    }
    for (let i = 0; i < 2; i++) {
      const p = this._at(b, D, -60 + i * 120, -60, 0.2);
      S.blastWall(b, { concrete: K.concrete, trim: K.trim, dark: K.dark }, { length: 44, h: 6.5, t: 1.6, segs: 4, rng });
      this._addOBB(p.x, p.z, 44, 2.0, p.yaw, p.y - 2, p.y + 6.5, 3);
      b.pop();
    }
    {
      const p = this._at(b, D, 62, -40, rng() * TAU);
      S.floodMast(b, { concrete: K.concrete, dark: K.dark, trim: K.trim, glow: K.glow }, { h: 20, rng });
      this._addAABB(p.x, p.z, 2.4, 2.4, p.y, p.y + 20);
      for (let i = 0; i < 4; i++) this._beacon(p.x + (i - 1.5) * 0.7, p.y + 20.6, p.z, 0xffc078, 2.8, 0, 1, 0);
      b.pop();
    }
  }

  /* --- TANK FARM --------------------------------------------------------- */

  _tankFarm(b, rng, K) {
    const D = D_TANKS;
    const tanks = [[-52, -34, 15, 26], [-6, -46, 13, 22], [42, -30, 16, 30], [-42, 30, 12, 20], [16, 34, 14, 27]];
    for (let i = 0; i < tanks.length; i++) {
      const [lx, lz, r0, h] = tanks[i];
      const p = this._at(b, D, lx, lz, rng() * TAU);
      const info = S.tank(b, {
        body: i % 2 ? 'teal' : K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { r: r0, h, rng, tint: i % 2 ? 0xc6d6cc : 0xc9bfae });
      b.pop();
      this._addAABB(p.x, p.z, r0 * 2, r0 * 2, p.y - 4, p.y + info.roofY);
      this._spawn(p.x, p.y + info.roofY + 3, p.z);
      this._beacon(p.x, p.y + info.h, p.z, 0xff2008, 1.5, 2, 2.6 + i * 0.31, i * 0.19);
      if (i % 2 === 1) this._vents.push([p.x + r0 * 0.35, p.y + h + 2.5, p.z, 2.6]);
    }
    for (let i = 0; i < 2; i++) {
      const p = this._at(b, D, 62 - i * 96, 60, 0);
      const info = S.sphereTank(b, { body: K.body, trim: K.trim, dark: K.dark, glow: K.glow },
        { r: 9.5 - i, legH: 7, tint: 0xb9c3bb });
      b.pop();
      this._addAABB(p.x, p.z, 18, 18, p.y - 3, p.y + info.h * 0.9);
      this._beacon(p.x, p.y + info.h, p.z, 0xff2008, 1.3, 2, 3.0 + i * 0.4, i * 0.5);
    }
    {
      const p = this._at(b, D, 64, -2, -0.2);
      const r = S.blockhouse(b, {
        body: 'ochre', trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w: 24, d: 18, h: 18, rng, tint: 0xd9c893 });
      b.pop();
      this._addOBB(p.x, p.z, 25, 19, p.yaw, p.y - 3, p.y + r.h, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
    }
    // bund walls + pipework
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5 + 0.3;
      const p = this._at(b, D, Math.cos(a) * 82, Math.sin(a) * 76, a + Math.PI * 0.5);
      S.blastWall(b, { concrete: K.concrete, trim: K.trim, dark: K.dark }, { length: 56, h: 6.0, t: 1.5, segs: 5, rng });
      this._addOBB(p.x, p.z, 56, 1.9, p.yaw, p.y - 2, p.y + 6, 4);
      b.pop();
    }
    {
      const p = this._at(b, D, 0, 0);
      S.pipeRun(b, { body: K.body, dark: K.dark, trim: K.trim }, {
        pts: [[-52, -34], [-6, -46], [42, -30], [64, -2]], r: 0.8, count: 4, y: 5.0, rng, tint: 0xb98f60,
      });
      S.pipeRun(b, { body: K.body, dark: K.dark, trim: K.trim }, {
        pts: [[-42, 30], [16, 34], [64, -2]], r: 0.65, count: 3, y: 3.6, rng, tint: 0x93a89e,
      });
      b.pop();
    }
    for (const [lx, lz] of [[-84, -68], [86, 66]]) {
      const p = this._at(b, D, lx, lz, rng() * TAU);
      S.floodMast(b, { concrete: K.concrete, dark: K.dark, trim: K.trim, glow: K.glow }, { h: 21, rng });
      this._addAABB(p.x, p.z, 2.4, 2.4, p.y, p.y + 21);
      for (let i = 0; i < 4; i++) this._beacon(p.x + (i - 1.5) * 0.7, p.y + 21.6, p.z, 0xffc078, 2.8, 0, 1, 0);
      b.pop();
    }
  }

  /* --- STAGING YARD (arena centre) --------------------------------------- */

  _stagingYard(b, rng, K) {
    const D = D_YARD;
    const blocks = [
      [-58, -40, 30, 22, 20, 0x9fb3ab, 'teal'],
      [46, -46, 24, 20, 26, 0xc7b49a, 'rust'],
      [58, 40, 28, 24, 15, 0xb5ad9e, 'steel'],
      [-52, 46, 20, 18, 22, 0xd4c391, 'ochre'],
    ];
    for (let i = 0; i < blocks.length; i++) {
      const [lx, lz, w, d, h, tint, fam] = blocks[i];
      const p = this._at(b, D, lx, lz, (rng() - 0.5) * 0.3);
      const r = S.blockhouse(b, {
        body: fam, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w, d, h, rng, tint });
      b.pop();
      this._addOBB(p.x, p.z, w + 1.6, d + 1.6, p.yaw, p.y - 3, p.y + r.h, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
      this._beacon(p.x, p.y + r.roofY + 1.6, p.z, 0xffb14a, 1.2, 1, 1.0 + i * 0.17, i * 0.3);
    }

    // lane walls — cover to fight around at ground level
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.4;
      const p = this._at(b, D, Math.cos(a) * 34, Math.sin(a) * 30, a);
      S.blastWall(b, { concrete: K.concrete, trim: K.trim, dark: K.dark }, { length: 34, h: 9.0, t: 1.8, segs: 3, rng });
      this._addOBB(p.x, p.z, 34, 2.2, p.yaw, p.y - 2, p.y + 9, 3);
      b.pop();
    }

    // a catwalk gantry straddling the yard — mid-air cover and a perch
    {
      const p = this._at(b, D, 0, 0, 0.4);
      for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI * 0.5 + Math.PI * 0.25;
          b.strut(K.dark, s * 36 + Math.cos(a) * 2.6, 0, Math.sin(a) * 2.6,
            s * 36 + Math.cos(a) * 1.8, 26, Math.sin(a) * 1.8, 0.5, { tint: 0xa39c90 });
        }
        for (let k = 1; k < 6; k++) {
          const y = k * 4.2;
          b.strut(K.dark, s * 36 - 2.4, y, -2.4, s * 36 + 2.4, y, 2.4, 0.2, { tint: 0xa39c90 });
          b.strut(K.dark, s * 36 + 2.4, y, -2.4, s * 36 - 2.4, y, 2.4, 0.2, { tint: 0xa39c90 });
        }
        this._addAABB(p.x + s * 36 * Math.cos(D.yaw + 0.4), p.z - s * 36 * Math.sin(D.yaw + 0.4), 6, 6, p.y, p.y + 26);
      }
      S.catwalk(b, K.dark, -36, 26, 0, 36, 26, 0, 5.0, 0xa8a094, K.glow);
      this._deckWorld(p, -36, 26.2, 0, 36, 26.2, 0, 4.6);
      this._spawn(p.x, p.y + 28, p.z);
      b.pop();
    }

    for (const [lx, lz] of [[-74, 6], [74, -8]]) {
      const p = this._at(b, D, lx, lz, rng() * TAU);
      S.floodMast(b, { concrete: K.concrete, dark: K.dark, trim: K.trim, glow: K.glow }, { h: 24, rng });
      this._addAABB(p.x, p.z, 2.4, 2.4, p.y, p.y + 24);
      for (let i = 0; i < 4; i++) this._beacon(p.x + (i - 1.5) * 0.7, p.y + 24.6, p.z, 0xffc078, 3.2, 0, 1, 0);
      b.pop();
    }
    // ground-level spawn right in the middle of the arena
    this.spawnPoints.unshift(new THREE.Vector3(D.x, this.heightAt(D.x, D.z) + 4, D.z));
  }

  /* --- SUBSTATION -------------------------------------------------------- */

  _substation(b, rng, K) {
    const D = D_SUBST;
    {
      const p = this._at(b, D, 0, -6, 0);
      S.transformerYard(b, {
        body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete, glass: K.glass,
      }, { w: 66, d: 48, rng, tint: 0xb8b0a2 });
      this._addOBB(p.x, p.z, 66, 48, p.yaw, p.y - 2, p.y + 7, 5);
      for (let i = 0; i < 4; i++) {
        const x = -25 + i * 16.6;
        this._beacon(p.x + x * Math.cos(D.yaw), p.y + 29, p.z - x * Math.sin(D.yaw), 0x39ff9a, 1.4, 1, 1.7 + i * 0.2, i * 0.25);
      }
      b.pop();
    }
    {
      const p = this._at(b, D, -8, 54, 0.15);
      const r = S.blockhouse(b, {
        body: 'ochre', trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w: 30, d: 22, h: 24, rng, tint: 0xd8c793 });
      b.pop();
      this._addOBB(p.x, p.z, 31, 23, p.yaw, p.y - 3, p.y + r.h, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
    }
    {
      const p = this._at(b, D, 56, 42, -0.25);
      const r = S.blockhouse(b, {
        body: 'rust', trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w: 22, d: 18, h: 30, rng, tint: 0xcda183 });
      b.pop();
      this._addOBB(p.x, p.z, 23, 19, p.yaw, p.y - 3, p.y + r.h, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
      this._vents.push([p.x, p.y + r.roofY, p.z, 2.0]);
    }
    for (let i = 0; i < 2; i++) {
      const p = this._at(b, D, -60 + i * 118, -50, 0.1);
      S.blastWall(b, { concrete: K.concrete, trim: K.trim, dark: K.dark }, { length: 48, h: 7, t: 1.6, segs: 4, rng });
      this._addOBB(p.x, p.z, 48, 2.0, p.yaw, p.y - 2, p.y + 7, 3);
      b.pop();
    }
  }

  /* --- OUTPOST ----------------------------------------------------------- */

  _outpost(b, rng, K) {
    const D = D_POST;
    {
      const p = this._at(b, D, -10, 0, 0);
      const h = 78;
      S.trussTower(b, K.dark, {
        height: h, base: 11, top: 5, bays: 13, chord: 0.5, brace: 0.24, rng,
        platformAt: [0.55, 0.92],
      });
      // dishes near the top
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + 0.3;
        const y = h * (0.6 + i * 0.11);
        b.box(K.dark, 1.0, 1.0, 0.5, Math.cos(a) * 3.2, y, Math.sin(a) * 3.2, a);
        b.dome(K.body, 2.3, Math.cos(a) * 4.6, y, Math.sin(a) * 4.6, 12, { phi: Math.PI * 0.42, tint: 0xd0c9bb });
      }
      S.antenna(b, K.dark, 0, h, 0, 14, rng);
      this._addAABB(p.x, p.z, 12, 12, p.y - 3, p.y + h);
      this._spawn(p.x + 6, p.y + h * 0.92 + 2, p.z);
      this._spawn(p.x - 6, p.y + h * 0.55 + 2, p.z);
      this._beacon(p.x, p.y + h + 15, p.z, 0xff2008, 2.6, 2, 2.1, 0.15);
      this._beacon(p.x, p.y + h * 0.55, p.z + 5, 0xff2008, 1.5, 2, 2.9, 0.55);
      b.pop();
    }
    {
      const p = this._at(b, D, 26, 22, 0.2);
      const r = S.blockhouse(b, {
        body: 'teal', trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete,
      }, { w: 22, d: 18, h: 14, rng, tint: 0xb9cec4 });
      this._addOBB(p.x, p.z, 23, 19, p.yaw, p.y - 3, p.y + r.h, 4);
      this._spawn(p.x, p.y + r.roofY + 3, p.z);
    }
    {
      const p = this._at(b, D, 4, -34, 0.5);
      S.blastWall(b, { concrete: K.concrete, trim: K.trim, dark: K.dark }, { length: 40, h: 7, t: 1.6, segs: 4, rng });
      this._addOBB(p.x, p.z, 40, 2.0, p.yaw, p.y - 2, p.y + 7, 3);
      b.pop();
    }
  }

  /* --- transmission line: a rhythm of pylons across the midground -------- */

  _pylonLine(b, rng, K) {
    const pts = [];
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const x = lerp(300, -160, t) + Math.sin(t * 3.1) * 26;
      const z = lerp(190, 330, t) + Math.cos(t * 2.2) * 30;
      pts.push([x, z]);
    }
    let prev = null;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const y = this.heightAt(x, z);
      const h = 44 + (i % 3) * 9;
      b.pushTRS(x, y, z, rng() * 0.4);
      S.trussTower(b, K.dark, { height: h, base: 8.5, top: 3.6, bays: 11, chord: 0.42, brace: 0.2, rng });
      for (let k = 0; k < 2; k++) {
        const ay = h * (0.74 + k * 0.16);
        b.box(K.dark, 15 - k * 3, 0.42, 0.42, 0, ay, 0, 0);
        for (const s of [-1, 1]) {
          b.strut(K.dark, s * (7.5 - k * 1.5), ay, 0, 0, ay - 5, 0, 0.22);
          for (let g = 0; g < 3; g++) {
            b.tube(K.dark, 0.34, 0.16, s * (7.5 - k * 1.5), ay - 0.4 - g * 0.34, 0, 7);
          }
        }
      }
      b.pop();
      this._addAABB(x, z, 9, 9, y - 3, y + h);
      this._beacon(x, y + h + 2, z, 0xff2008, 1.4, 2, 3.2 + i * 0.23, i * 0.17);

      if (prev) {
        // catenaries between the two pylons, in world space
        const [px, pz, py, ph] = prev;
        for (let k = 0; k < 2; k++) {
          for (const s of [-1, 1]) {
            const ay0 = py + ph * (0.74 + k * 0.16) - 0.9;
            const ay1 = y + h * (0.74 + k * 0.16) - 0.9;
            const seg = 7;
            for (let q = 0; q < seg; q++) {
              const t0 = q / seg, t1 = (q + 1) / seg;
              const sag = (tt) => -Math.sin(tt * Math.PI) * 7.5;
              b.pipe(K.dark,
                lerp(px, x, t0), lerp(ay0, ay1, t0) + sag(t0), lerp(pz, z, t0) + s * 0.0,
                lerp(px, x, t1), lerp(ay0, ay1, t1) + sag(t1), lerp(pz, z, t1) + s * 0.0,
                0.09, 4);
            }
          }
        }
      }
      prev = [x, z, y, h];
    }
  }

  /* --- long spans: connective tissue over the open ground ---------------- */

  _longSpans(b, rng, K) {
    // tank farm → gantry, a 220 m elevated pipe run crossing the open middle
    const A = [D_TANKS.x + 40, D_TANKS.z - 80];
    const B = [D_GANTRY.x - 60, D_GANTRY.z + 90];
    const mid = [(A[0] + B[0]) * 0.5, (A[1] + B[1]) * 0.5];
    const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const y = this.heightAt(mid[0], mid[1]) + 34;
    b.pushTRS(mid[0], 0, mid[1], -ang);
    S.pipeBridge(b, { body: K.body, trim: K.trim, dark: K.dark, glow: K.glow, concrete: K.concrete },
      { length: len, y, width: 7, bents: Math.max(4, Math.round(len / 55)), groundY: this.heightAt(mid[0], mid[1]), tint: 0xb3a58e });
    b.pop();

    const ca = Math.cos(-ang), sa = Math.sin(-ang);
    const wpt = (lx, lz) => [mid[0] + ca * lx + sa * lz, mid[1] - sa * lx + ca * lz];
    const p0 = wpt(-len * 0.5, 0), p1 = wpt(len * 0.5, 0);
    this._decks.push([p0[0], y + 3.6, p0[1], p1[0], y + 3.6, p1[1], 5.4]);
    this._spawn(mid[0], y + 5, mid[1]);
    this._spawn(wpt(len * 0.25, 0)[0], y + 5, wpt(len * 0.25, 0)[1]);

    // bent colliders so the legs are solid
    const bents = Math.max(4, Math.round(len / 55));
    for (let i = 0; i < bents; i++) {
      const lx = -len * 0.5 + (i / (bents - 1)) * len;
      const w = wpt(lx, 0);
      this._addAABB(w[0], w[1], 5, 14, this.heightAt(w[0], w[1]) - 2, y);
    }
    for (let i = 0; i <= Math.round(len / 40); i++) {
      const w = wpt(-len * 0.5 + i * 40, 0);
      this._beacon(w[0], y + 5.2, w[1], 0xffb14a, 1.3, 1, 1.2, i * 0.3);
    }
    void rng;
  }

  /* --- catwalk deck registration ---------------------------------------- */

  /** Convert a district-local deck span into world space for the collider. */
  _deckWorld(p, x0, y0, z0, x1, y1, z1, width) {
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    const w0x = p.x + c * x0 + s * z0, w0z = p.z - s * x0 + c * z0;
    const w1x = p.x + c * x1 + s * z1, w1z = p.z - s * x1 + c * z1;
    this._decks.push([w0x, p.y + y0, w0z, w1x, p.y + y1, w1z, width]);
  }

  /**
   * Build one thin triangle strip per catwalk deck and hand it to the physics
   * triangle soup. Everything else in the level is an AABB; walkable decks earn
   * the extra cost because standing on them has to feel exact.
   */
  _registerDecks() {
    if (!this._decks.length) return;
    const n = this._decks.length;
    const pos = new Float32Array(n * 4 * 3);
    const idx = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      const [x0, y0, z0, x1, y1, z1, w] = this._decks[i];
      const dx = x1 - x0, dz = z1 - z0;
      const l = Math.hypot(dx, dz) || 1;
      const px = (-dz / l) * w * 0.5, pz = (dx / l) * w * 0.5;
      const o = i * 12;
      pos[o] = x0 + px; pos[o + 1] = y0; pos[o + 2] = z0 + pz;
      pos[o + 3] = x1 + px; pos[o + 4] = y1; pos[o + 5] = z1 + pz;
      pos[o + 6] = x1 - px; pos[o + 7] = y1; pos[o + 8] = z1 - pz;
      pos[o + 9] = x0 - px; pos[o + 10] = y0; pos[o + 11] = z0 - pz;
      const v = i * 4, k = i * 6;
      idx[k] = v; idx[k + 1] = v + 2; idx[k + 2] = v + 1;
      idx[k + 3] = v; idx[k + 4] = v + 3; idx[k + 5] = v + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const proxy = new THREE.Mesh(geo);
    proxy.updateMatrixWorld(true);
    this.physics.addStatic(proxy, proxy);
    geo.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /*  Props                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Everything loose on the ground. Nine `InstancedMesh` draw calls carry well
   * over a thousand objects; each instance gets its own tint so a container yard
   * reads as a container yard and not as a hundred clones.
   */
  _buildProps() {
    const rng = mulberry32(SEED ^ 0x1d0f);

    const propMat = (name, tex, o) => {
      const m = new THREE.MeshStandardMaterial({
        map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
        metalnessMap: tex.metalnessMap || null, aoMap: tex.aoMap,
        color: new THREE.Color(o.color), roughness: o.rough, metalness: o.metal,
        envMapIntensity: o.env !== undefined ? o.env : 0.9,
        dithering: true,
      });
      m.name = 'Level.prop.' + name;
      this._materials.push(m);
      return m;
    };
    const A = this._tex.plateA, B = this._tex.plateB, C = this._tex.conc;
    const mContainer = propMat('container', B, { color: 0xffffff, rough: 0.62, metal: 0.9 });
    const mSteel = propMat('steel', B, { color: 0xffffff, rough: 0.55, metal: 1.0 });
    const mRough = propMat('rough', A, { color: 0xffffff, rough: 0.82, metal: 0.6 });
    const mConc = propMat('concrete', C, { color: 0xffffff, rough: 0.96, metal: 0.0, env: 0.4 });

    // container yard clusters, mostly on pads and along roads
    const clusters = [
      [D_HANGAR.x + 20, D_HANGAR.z - 58, 62, 34],
      [D_HANGAR.x - 70, D_HANGAR.z - 52, 46, 22],
      [D_YARD.x + 6, D_YARD.z - 6, 62, 40],
      [D_GANTRY.x + 40, D_GANTRY.z + 78, 58, 26],
      [D_GANTRY.x - 96, D_GANTRY.z + 46, 46, 18],
      [D_TANKS.x + 66, D_TANKS.z + 40, 44, 18],
      [D_SILOS.x + 52, D_SILOS.z + 6, 44, 16],
      [D_SUBST.x - 46, D_SUBST.z + 34, 40, 14],
      [D_POST.x - 34, D_POST.z + 30, 34, 12],
    ];

    this._instance('containers', S.containerGeo(6.1), mContainer, 168, rng, (r, out) => {
      const cl = clusters[Math.floor(r() * clusters.length)];
      const stackAng = cl[0] * 0.001;
      // rows and stacks — a real yard is orthogonal, not scattered
      const row = Math.floor(r() * 6) - 3;
      const col = Math.floor(r() * 7) - 3;
      const lx = col * 7.2 + (r() - 0.5) * 1.2;
      const lz = row * 3.4 + (r() - 0.5) * 0.8;
      const c = Math.cos(stackAng), s = Math.sin(stackAng);
      out.x = cl[0] + c * lx + s * lz;
      out.z = cl[1] - s * lx + c * lz;
      out.yaw = stackAng + (r() < 0.12 ? (r() - 0.5) * 0.6 : 0);
      out.stack = r() < 0.34 ? 1 : 0;
      out.h = 2.59;
      out.tintPool = [0xc9622b, 0x3f7a72, 0x8a8f96, 0x9c7f33, 0x6d4a3a, 0x4a5c68];
      out.w = 6.5; out.d = 2.9;
      return true;
    }, cl => cl, true);

    this._instance('drums', S.drumGeo(), mSteel, 240, rng, (r, out) => {
      const cl = clusters[Math.floor(r() * clusters.length)];
      const a = r() * TAU, rad = Math.sqrt(r()) * cl[2] * 0.5;
      out.x = cl[0] + Math.cos(a) * rad;
      out.z = cl[1] + Math.sin(a) * rad;
      out.yaw = r() * TAU;
      out.tintPool = [0x9d5427, 0x8a8f96, 0x3f6f68, 0xa08a3a];
      out.w = 0.7; out.d = 0.7; out.h = 0.9;
      return true;
    }, null, false);

    this._instance('spools', S.spoolGeo(), mRough, 46, rng, (r, out) => {
      const cl = clusters[Math.floor(r() * clusters.length)];
      const a = r() * TAU, rad = Math.sqrt(r()) * cl[2] * 0.6;
      out.x = cl[0] + Math.cos(a) * rad;
      out.z = cl[1] + Math.sin(a) * rad;
      out.yaw = r() * TAU;
      out.tintPool = [0x8a7150, 0x6f665a, 0x7d5a3c];
      out.w = 3.2; out.d = 3.2; out.h = 3.0;
      return true;
    }, null, true);

    this._instance('crates', S.crateGeo(rng), mRough, 130, rng, (r, out) => {
      const cl = clusters[Math.floor(r() * clusters.length)];
      const a = r() * TAU, rad = Math.sqrt(r()) * cl[2] * 0.55;
      out.x = cl[0] + Math.cos(a) * rad;
      out.z = cl[1] + Math.sin(a) * rad;
      out.yaw = r() * TAU;
      out.tintPool = [0x8f7a54, 0x6d6a60, 0x99733f];
      out.w = 1.8; out.d = 1.8; out.h = 1.8;
      return true;
    }, null, false);

    this._instance('barriers', S.barrierGeo(), mConc, 108, rng, (r, out) => {
      // lines of barriers along the haul roads
      const road = ROADS[Math.floor(r() * ROADS.length)];
      const t = r();
      const bx = lerp(road[0].x, road[1].x, t);
      const bz = lerp(road[0].z, road[1].z, t);
      const ang = Math.atan2(road[1].z - road[0].z, road[1].x - road[0].x);
      const side = r() < 0.5 ? -1 : 1;
      const off = (road[2] * 0.5 + 1.2) * side;
      out.x = bx - Math.sin(ang) * off;
      out.z = bz + Math.cos(ang) * off;
      out.yaw = -ang + (r() - 0.5) * 0.15;
      out.tintPool = [0xa8a49b, 0x928e86, 0xb0a894];
      out.w = 3.4; out.d = 1.0; out.h = 1.2;
      return true;
    }, null, false);

    this._instance('wrecks', S.wreckGeo(rng), mRough, 22, rng, (r, out) => {
      const a = r() * TAU, rad = 60 + Math.sqrt(r()) * 320;
      out.x = Math.cos(a) * rad;
      out.z = Math.sin(a) * rad;
      out.yaw = r() * TAU;
      out.tintPool = [0x4a4239, 0x5c4a3a, 0x3f4348];
      out.w = 9; out.d = 5; out.h = 4;
      return true;
    }, null, true);

    this._instance('rebar', S.rebarGeo(rng), mConc, 84, rng, (r, out) => {
      const a = r() * TAU, rad = 40 + Math.sqrt(r()) * 340;
      out.x = Math.cos(a) * rad;
      out.z = Math.sin(a) * rad;
      out.yaw = r() * TAU;
      out.tintPool = [0x9a9186, 0x8b8478, 0xa79a86];
      out.w = 2.4; out.d = 2.0; out.h = 2.0;
      return true;
    }, null, false);

    this._instance('debris', S.debrisGeo(rng), mConc, 420, rng, (r, out) => {
      const a = r() * TAU, rad = 24 + Math.sqrt(r()) * 380;
      out.x = Math.cos(a) * rad;
      out.z = Math.sin(a) * rad;
      out.yaw = r() * TAU;
      out.tintPool = [0x968d80, 0x847c70, 0xa2988a, 0x6f685e];
      out.w = 2.2; out.d = 2.2; out.h = 1.2;
      return true;
    }, null, false);

    this._instance('slag', S.debrisGeo(rng), mSteel, 200, rng, (r, out) => {
      const cl = clusters[Math.floor(r() * clusters.length)];
      const a = r() * TAU, rad = Math.sqrt(r()) * cl[2] * 0.9;
      out.x = cl[0] + Math.cos(a) * rad;
      out.z = cl[1] + Math.sin(a) * rad;
      out.yaw = r() * TAU;
      out.tintPool = [0x5a5148, 0x484440, 0x6b5a4a];
      out.w = 2.0; out.d = 2.0; out.h = 1.0;
      return true;
    }, null, false);
  }

  /**
   * Scatter one instanced prop.
   * @param {Function} sample fills `out` with a candidate placement
   * @param {boolean} collide register an AABB collider per instance
   */
  _instance(name, geo, material, count, rng, sample, _unused, collide) {
    const im = new THREE.InstancedMesh(geo, material, count);
    im.name = 'Level.prop.' + name;
    im.castShadow = collide === true || count < 260;
    im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const e = new THREE.Euler();
    const out = { x: 0, z: 0, yaw: 0, stack: 0, tintPool: null, w: 1, d: 1, h: 1 };

    let placed = 0;
    let guard = 0;
    while (placed < count && guard < count * 24) {
      guard++;
      if (!sample(rng, out)) continue;
      const x = out.x, z = out.z;
      if (Math.hypot(x, z) > ARENA_R - 12) continue;
      if (this._blocked(x, z, Math.max(out.w, out.d) * 0.5 + 1.0)) continue;
      const slope = this.terrain.slopeAt(x, z);
      if (slope > 0.42) continue;
      const y = this.heightAt(x, z);

      const tiltX = (rng() - 0.5) * (slope * 1.2 + 0.05);
      const tiltZ = (rng() - 0.5) * (slope * 1.2 + 0.05);
      const stackH = out.stack ? out.h : 0;
      e.set(tiltX, out.yaw, tiltZ, 'YXZ');
      q.setFromEuler(e);
      p.set(x, y + stackH, z);
      const sc = 0.92 + rng() * 0.18;
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      im.setMatrixAt(placed, m);

      if (out.tintPool) {
        const hex = out.tintPool[Math.floor(rng() * out.tintPool.length)];
        _c.setHex(hex).convertSRGBToLinear();
        const v = 0.78 + rng() * 0.42;
        _c.multiplyScalar(v);
        im.setColorAt(placed, _c);
      }

      if (collide) {
        this._addAABB(x, z, out.w, out.d, y - 1, y + stackH + out.h);
      }
      placed++;
    }
    im.count = placed;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    this.root.add(im);
    this._meshes.push(im);
    this._geometries.push(geo);
    this.stats.instances += placed;
    this.stats.triangles += (geo.index.count / 3) * placed;
    return im;
  }

  /* ---------------------------------------------------------------------- */
  /*  Atmosphere & emissive life                                             */
  /* ---------------------------------------------------------------------- */

  _buildAtmosphere() {
    this._buildGlowField();
    this._buildDust();
    this._buildSteam();
    this._buildBanners();
  }

  /** Shared instanced-billboard geometry factory. */
  _billboards(count, attrs) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(quad.index);
    g.setAttribute('position', quad.attributes.position);
    g.setAttribute('uv', quad.attributes.uv);
    for (const k of Object.keys(attrs)) {
      g.setAttribute(k, new THREE.InstancedBufferAttribute(attrs[k].array, attrs[k].size));
    }
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 60, 0), 1400);
    quad.dispose();
    this._geometries.push(g);
    return g;
  }

  /**
   * Every warning lamp, hazard strobe and floodlight halo in the level, in one
   * additive draw call. Blink timing is a pure function of `uTime` and a
   * per-instance phase, so the strobes on two adjacent stacks are permanently
   * out of sync without a single line of CPU work.
   */
  _buildGlowField() {
    const n = this._glows.length;
    if (!n) return;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const par = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const g = this._glows[i];
      pos[i * 3] = g.x; pos[i * 3 + 1] = g.y; pos[i * 3 + 2] = g.z;
      _c.setHex(g.color).convertSRGBToLinear();
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      par[i * 4] = g.size;
      par[i * 4 + 1] = g.phase;
      par[i * 4 + 2] = g.period;
      par[i * 4 + 3] = g.mode;
    }
    const geo = this._billboards(n, {
      aPos: { array: pos, size: 3 },
      aColor: { array: col, size: 3 },
      aParam: { array: par, size: 4 },
    });

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this._uTime, uFog: this._uFog },
      vertexShader: /* glsl */`
        attribute vec3 aPos;
        attribute vec3 aColor;
        attribute vec4 aParam;
        uniform float uTime;
        varying vec3 vCol;
        varying vec2 vQ;
        varying float vI;
        varying float vDepth;
        void main() {
          vQ = uv;
          vCol = aColor;
          float f = fract( uTime / max( aParam.z, 0.05 ) + aParam.y );
          float inten = 1.0;
          if ( aParam.w > 1.5 ) {
            // slow aircraft-warning blink: soft rise, long dark
            inten = 0.06 + 1.25 * smoothstep( 0.0, 0.14, f ) * ( 1.0 - smoothstep( 0.20, 0.42, f ) );
          } else if ( aParam.w > 0.5 ) {
            // hazard strobe: hard, short
            inten = 0.10 + 1.7 * ( 1.0 - smoothstep( 0.0, 0.07, f ) );
          }
          vI = inten;
          vec4 mv = modelViewMatrix * vec4( aPos, 1.0 );
          vDepth = -mv.z;
          // keep distant lamps from vanishing below a pixel
          float sz = aParam.x * ( 1.0 + vDepth * 0.0016 );
          mv.xy += position.xy * sz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uFog;
        varying vec3 vCol;
        varying vec2 vQ;
        varying float vI;
        varying float vDepth;
        void main() {
          vec2 d = ( vQ - 0.5 ) * 2.0;
          float r2 = dot( d, d );
          if ( r2 > 1.0 ) discard;
          float halo = exp( -r2 * 3.4 );
          float core = exp( -r2 * 30.0 );
          float atten = exp( -uFog * vDepth * 0.65 );
          vec3 c = vCol * ( halo * 0.9 + core * 4.2 ) * vI * atten;
          gl_FragColor = vec4( c, 1.0 );
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this._materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Level.glowField';
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.root.add(mesh);
    this._meshes.push(mesh);
  }

  /**
   * Ground dust. A slab of motes that wraps around the player, so 1800 quads
   * cover the whole arena's worth of particulate for one draw call.
   */
  _buildDust() {
    const n = 1800;
    const rng = mulberry32(SEED ^ 0xd0d0);
    const seed = new Float32Array(n * 3);
    const par = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      seed[i * 3] = rng();
      seed[i * 3 + 1] = Math.pow(rng(), 1.7);   // bias toward the ground
      seed[i * 3 + 2] = rng();
      par[i * 3] = 0.10 + rng() * 0.34;         // size
      par[i * 3 + 1] = rng();                   // phase
      par[i * 3 + 2] = 0.55 + rng() * 0.9;      // drift multiplier
    }
    const geo = this._billboards(n, {
      aSeed: { array: seed, size: 3 },
      aParam: { array: par, size: 3 },
    });
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._uTime,
        uCentre: this._uDustCentre,
        uBox: { value: new THREE.Vector3(300, 64, 300) },
        uWind: { value: new THREE.Vector3(3.4, 0.35, -2.1) },
        uColor: { value: new THREE.Color(0xd8bd93).convertSRGBToLinear() },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        attribute vec3 aParam;
        uniform float uTime;
        uniform vec3 uCentre;
        uniform vec3 uBox;
        uniform vec3 uWind;
        varying vec2 vQ;
        varying float vA;
        void main() {
          vQ = uv;
          vec3 p = aSeed * uBox + uWind * uTime * aParam.z;
          // wrap the slab around the player so it is always populated
          vec3 rel = mod( p - uCentre + uBox * 0.5, uBox ) - uBox * 0.5;
          vec3 wp = uCentre + rel;
          wp.y += sin( uTime * 0.7 + aParam.y * 31.4 ) * 0.6;
          vec4 mv = modelViewMatrix * vec4( wp, 1.0 );
          float d = -mv.z;
          // fade at the slab edges and very close to the lens
          vec3 f = 1.0 - smoothstep( vec3( 0.30 ), vec3( 0.5 ), abs( rel ) / uBox );
          vA = f.x * f.y * f.z * smoothstep( 3.0, 16.0, d ) * ( 1.0 - smoothstep( 90.0, 165.0, d ) );
          mv.xy += position.xy * aParam.x * ( 1.0 + d * 0.012 );
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3 uColor;
        varying vec2 vQ;
        varying float vA;
        void main() {
          vec2 d = ( vQ - 0.5 ) * 2.0;
          float r2 = dot( d, d );
          if ( r2 > 1.0 ) discard;
          float a = exp( -r2 * 3.0 ) * vA * 0.42;
          gl_FragColor = vec4( uColor * a * 1.6, a );
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this._materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Level.dust';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.root.add(mesh);
    this._meshes.push(mesh);
  }

  /** Steam / vapour plumes off stack crowns, tank relief valves and roof vents. */
  _buildSteam() {
    if (!this._vents.length) return;
    const perVent = 9;
    const n = this._vents.length * perVent;
    const rng = mulberry32(SEED ^ 0x57ea);
    const pos = new Float32Array(n * 3);
    const par = new Float32Array(n * 4);
    let k = 0;
    for (const [x, y, z, scale] of this._vents) {
      for (let i = 0; i < perVent; i++) {
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        par[k * 4] = rng();                       // phase
        par[k * 4 + 1] = 0.055 + rng() * 0.045;   // rate
        par[k * 4 + 2] = 16 + rng() * 20;         // rise height
        par[k * 4 + 3] = scale * (0.8 + rng() * 0.7);
        k++;
      }
    }
    const geo = this._billboards(n, {
      aPos: { array: pos, size: 3 },
      aParam: { array: par, size: 4 },
    });

    const tex = this._forge.smokePuff(128, 9);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._uTime,
        uMap: { value: tex },
        uColor: { value: new THREE.Color(0xcfd3d6).convertSRGBToLinear() },
      },
      vertexShader: /* glsl */`
        attribute vec3 aPos;
        attribute vec4 aParam;
        uniform float uTime;
        varying vec2 vQ;
        varying float vA;
        void main() {
          vQ = uv;
          float t = fract( uTime * aParam.y + aParam.x );
          float ph = aParam.x * 43.7;
          vec3 wp = aPos;
          wp.y += t * aParam.z;
          wp.x += sin( ph + t * 2.3 ) * t * aParam.z * 0.34 + t * t * 5.0;
          wp.z += cos( ph * 1.7 + t * 1.9 ) * t * aParam.z * 0.30;
          vA = smoothstep( 0.0, 0.10, t ) * ( 1.0 - smoothstep( 0.30, 1.0, t ) );
          vec4 mv = modelViewMatrix * vec4( wp, 1.0 );
          float sz = aParam.w * ( 0.5 + t * 3.4 );
          mv.xy += position.xy * sz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uMap;
        uniform vec3 uColor;
        varying vec2 vQ;
        varying float vA;
        void main() {
          float m = texture2D( uMap, vQ ).a;
          float a = m * vA * 0.30;
          if ( a < 0.002 ) discard;
          gl_FragColor = vec4( uColor * 0.9, a );
        }`,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this._materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Level.steam';
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.root.add(mesh);
    this._meshes.push(mesh);
  }

  /**
   * Torn tarps and banners lashed to railings and walls. A two-term wave in the
   * vertex shader, weighted so the lashed edge stays put — about as much motion
   * as a still frame needs and it costs one uniform.
   */
  _buildBanners() {
    const rng = mulberry32(SEED ^ 0xba33);
    const pieces = [];
    const anchors = [];

    for (const D of DISTRICTS) {
      const count = D === D_GANTRY ? 6 : 3;
      for (let i = 0; i < count; i++) {
        const a = rng() * TAU;
        const rad = 40 + rng() * (Math.min(D.sx, D.sz) * 0.42);
        const x = D.x + Math.cos(a) * rad;
        const z = D.z + Math.sin(a) * rad;
        if (Math.hypot(x, z) > ARENA_R - 30) continue;
        anchors.push([x, this.heightAt(x, z) + 6 + rng() * 16, z, rng() * TAU, 4 + rng() * 8, 3 + rng() * 6]);
      }
    }

    for (const [x, y, z, yaw, w, h] of anchors) {
      const g = new THREE.PlaneGeometry(w, h, 6, 5);
      const pa = g.attributes.position;
      const wave = new Float32Array(pa.count);
      for (let i = 0; i < pa.count; i++) {
        // 0 at the top edge (lashed) → 1 at the free bottom corner
        const u = (pa.getX(i) / w) + 0.5;
        const v = 0.5 - (pa.getY(i) / h);
        wave[i] = clamp(v * (0.35 + u * 0.9), 0, 1.4);
        pa.setZ(i, pa.getZ(i) + (rng() - 0.5) * 0.25);
      }
      g.setAttribute('aWave', new THREE.BufferAttribute(wave, 1));
      g.rotateY(yaw);
      g.translate(x, y, z);
      pieces.push(g);
    }
    if (!pieces.length) return;

    const merged = mergeGeometries(pieces, false);
    for (const p of pieces) p.dispose();
    merged.setAttribute('uv1', merged.attributes.uv);
    merged.computeBoundingSphere();
    this._geometries.push(merged);

    const mat = new THREE.MeshStandardMaterial({
      map: this._tex.plateB.map,
      normalMap: this._tex.plateB.normalMap,
      roughnessMap: this._tex.plateB.roughnessMap,
      aoMap: this._tex.plateB.aoMap,
      color: 0x8f5a2c,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.5,
    });
    mat.name = 'Level.banners';
    const uT = this._uTime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uT;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWave;\nuniform float uTime;')
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          float ph = transformed.x * 0.6 + transformed.z * 0.4;
          float amp = aWave * 0.55;
          transformed.x += sin( uTime * 2.1 + ph ) * amp;
          transformed.z += cos( uTime * 1.7 + ph * 1.3 ) * amp * 0.8;
          transformed.y -= aWave * ( 0.12 + 0.10 * sin( uTime * 2.6 + ph ) );
        `);
    };
    this._materials.push(mat);

    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'Level.banners';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this._meshes.push(mesh);
  }

  /* ---------------------------------------------------------------------- */
  /*  Finalise                                                               */
  /* ---------------------------------------------------------------------- */

  _finalise() {
    // A few extra ground spawns spread around the ring so hostiles can arrive
    // from anywhere, not only from a rooftop.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.4;
      const r = 210 + (i % 3) * 55;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (this._blocked(x, z, 8)) continue;
      this._spawn(x, this.heightAt(x, z) + 3, z);
    }

    // Guarantee the contract even if a placement pass was unlucky.
    let guard = 0;
    while (this.spawnPoints.length < 14 && guard++ < 64) {
      const a = this._rng() * TAU;
      const r = 90 + this._rng() * 280;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (this._blocked(x, z, 10)) continue;
      this._spawn(x, this.heightAt(x, z) + 3 + this._rng() * 30, z);
    }

    this.physics.build();
    this.stats.meshes = this._meshes.length;
    this.stats.triangles = Math.round(this.stats.triangles);

    this._uPlayer.value.set(0, this.heightAt(0, 0) + 8, 0);
    this._uDustCentre.value.set(0, this.heightAt(0, 0) + 20, 0);
  }

  /* ---------------------------------------------------------------------- */
  /*  Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Two scalar writes and two vector copies. Every animated thing in the level
   * derives its motion from `uTime` inside a vertex shader, so there is nothing
   * per-object to step and nothing to allocate.
   *
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Vector3} [playerPos]
   */
  update(dt, elapsed, playerPos) {
    this._uTime.value = elapsed;

    const fog = this.scene.fog;
    if (fog && fog.density !== undefined) this._uFog.value = fog.density;

    if (!playerPos) return;
    this._uPlayer.value.copy(playerPos);

    // The dust slab tracks the player but only re-grounds a few times a second;
    // `groundHeight` is cached on a lattice so this is nearly free either way.
    this._dustTimer -= dt;
    if (this._dustTimer <= 0) {
      this._dustTimer = 0.22;
      const g = this.physics.groundHeight(playerPos.x, playerPos.z);
      this._groundY = isFinite(g) ? g : this._groundY;
    }
    const c = this._uDustCentre.value;
    c.x = playerPos.x;
    c.z = playerPos.z;
    c.y = Math.min(playerPos.y, this._groundY + 26) + 6;
  }

  /* ---------------------------------------------------------------------- */

  dispose() {
    for (const m of this._meshes) {
      if (m.parent) m.parent.remove(m);
      if (m.dispose) m.dispose();
    }
    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) m.dispose();
    if (this.terrain) this.terrain.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
    this._meshes.length = 0;
    this._geometries.length = 0;
    this._materials.length = 0;
    this._blockers.length = 0;
    this._glows.length = 0;
    this._vents.length = 0;
    this._decks.length = 0;
    S.clearGeoCache();
  }
}

export default Level;
