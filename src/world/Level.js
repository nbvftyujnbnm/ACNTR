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

/**
 * Metres of world covered by one rock tile on the cliffs. 26 m put 115 repeats
 * around the boundary ring, which lands at 37-57 px on the vista pose — right
 * in the band where a repeat reads as striping. At 42 m it is 60-92 px, and
 * `cliffBreakup` overlays two more scales on top of it.
 */
const UV_CLIFF = 42;

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
/*  Band-limited angular fields — the only safe way to modulate a revolve      */
/* ========================================================================== */

/**
 * Build a fixed set of sine harmonics of the revolve angle, amplitudes falling
 * as `order^-falloff`, phases drawn from `rng`, normalised so the field is
 * bounded by about [-1, 1].
 *
 * Why not fbm, which every one of these generators used to call: a noise field
 * sampled on a CIRCLE steps `TAU * R / NA` lattice units per column, and if that
 * lands anywhere near 1 the column-to-column value is INDEPENDENT. One column of
 * the mesa ring is ~8 m of cliff, which at the vista's 600-900 m sight lines is
 * 15-30 px, so an independent per-column value is a vertical stripe by
 * definition. Harmonics cannot do that: the highest order used anywhere here is
 * 27 against 384 columns (14 columns per lobe), the derivative is bounded and
 * analytic, and — the part that actually matters for shading — it is SMOOTH, so
 * a term composed on top of it (strata phase, say) varies as a slow wave around
 * the ring rather than as noise. They also cannot go flat, because their
 * amplitudes are fixed rather than sampled: the failure mode on the other side
 * of this trade is a smooth revolve under a low sun, which is one coherent
 * normal and reads as a pale cardboard cut-out.
 *
 * @param {() => number} rng seeded generator
 * @param {number[]} orders harmonic orders, lowest first
 * @param {number} falloff amplitude exponent
 * @returns {Float64Array} flat [order, amp, phase] triples
 */
function harmonics(rng, orders, falloff = 1) {
  const h = new Float64Array(orders.length * 3);
  let norm = 0;
  for (let i = 0; i < orders.length; i++) {
    const amp = Math.pow(orders[0] / orders[i], falloff);
    h[i * 3] = orders[i];
    h[i * 3 + 1] = amp;
    h[i * 3 + 2] = rng() * TAU;
    norm += amp;
  }
  for (let i = 0; i < orders.length; i++) h[i * 3 + 1] /= norm;
  return h;
}

/** Evaluate a `harmonics()` field at angle `t`. Result is in about [-1, 1]. */
function angField(t, h) {
  let s = 0;
  for (let i = 0; i < h.length; i += 3) s += h[i + 1] * Math.sin(h[i] * t + h[i + 2]);
  return s;
}

/* ========================================================================== */
/*  Stratigraphy — where a cliff's profile rings go                            */
/* ========================================================================== */

/**
 * Sampling schedule for a cliff face, shared by the mesa ring and the buttes.
 * One row per profile ring, as `[s, relief, sky, albedo]`:
 *
 *  - `s`      position along the face, 0 at the toe of the scree, 1 at the crest;
 *  - `relief` radial displacement in units of the bed amplitude, POSITIVE
 *             meaning recessed (a soft bed cut back) and negative meaning proud
 *             (a hard bed standing out). Callers map the sign onto radius —
 *             recessed is a larger radius on a ring seen from inside and a
 *             smaller one on a butte seen from outside;
 *  - `sky`    fraction of the hemisphere this ring can see, 0..1. See below —
 *             on this surface it is the ONLY lighting channel there is;
 *  - `albedo` rock colour multiplier for the course, near 1.
 *
 * Rings are deliberately NOT spread evenly. An even ramp is what produces a
 * smooth cone, and a smooth cone under a 13-degree sun is one coherent normal —
 * a flat pale cut-out, whatever is done to its texture or its colour. The talus
 * gets an even ramp because it really is a cone; the cliff band above it is
 * divided into `beds` and each bed spends its four rings exactly where the
 * surface turns: an OVERHANG (down-facing, roofed by the hard course above), the
 * LIP just under it, a near-vertical RISER, and a BENCH cut back into the soft
 * course at roughly the angle of repose.
 *
 * TWO THINGS THIS FUNCTION EXISTS TO GET RIGHT, both of them measured.
 *
 * (1) `sky`, NOT a tint. `tools/probes/beds.js` walks one column of the ring
 * from the arena camera and reports every ring's N.L against the real sun:
 * the whole visible face runs **-0.15 to -0.89**. The mesa ring is a revolve
 * seen from INSIDE, so the half of it in front of the sun has its inner face
 * turned away from the key and receives, exactly, zero of it. Every scrap of
 * relief authored here therefore modulates nothing, and the face is lit by the
 * hemisphere alone. Ambient is very nearly symmetric in AZIMUTH, so a normal's
 * bearing does nothing to it and only its ELEVATION matters — which is why the
 * gullies were invisible while the beds, the one feature that tips a normal up
 * or down, drew perfectly. Sky visibility is the channel that IS available:
 * an overhang is roofed and sees almost nothing, a bench faces the sky and sees
 * most of it. The caller multiplies it into the vertex colour, which on a
 * vertex-coloured MeshStandardMaterial scales every light term including the
 * ambient. It is baked occlusion, not paint.
 *
 * The previous schedule was paint — [0.56, 1.14, 1.02, 0.84] — and it put its
 * BRIGHTEST value on the lip, the band physically tucked directly under the
 * overhang. A dark line with a bright line hard against it is how you draw a
 * contour, which is exactly what the ridge was rendering.
 *
 * (2) BEDS MUST NOT BE A PERIODIC FUNCTION. Every bed used to get the same
 * thickness, the same recess depth and the same colour, so the ring rendered as
 * a set of uniformly spaced concentric contours curving in lockstep — a
 * topographic map, not rock. Real bedding varies course to course in all three,
 * and it does so on a schedule laid down once and then eroded, not on one that
 * repeats. Hence `rng`: thickness spreads about 3:1, recess depth about 3:1 and
 * albedo about 1.4:1, drawn once per bed from a seeded generator and therefore
 * fixed for the life of the build. The internal proportions vary too, so a thin
 * course is mostly overhang and a thick one mostly riser.
 *
 * The schedule is still indexed by RING and therefore identical in every
 * column, which is what makes it aliasing-proof: nothing in it has a phase that
 * can step from column to column (see the amendment on the strata Nyquist bug).
 * Everything that varies around the landform — the face height, the bed
 * amplitude, the gullies, the drainage chutes — is a band-limited harmonic
 * field.
 *
 * @param {number} talusRings rings spent on the scree apron
 * @param {number} beds hard/soft bed pairs in the cliff band
 * @param {number} sTalus fraction of the face parameter given to the scree
 * @param {() => number} rng seeded generator, consumed 5x per bed
 * @returns {number[][]} rows of [s, relief, sky, albedo], `s` strictly increasing
 */
function cliffFaceProfile(talusRings, beds, sTalus, rng) {
  const rows = [];
  for (let i = 0; i < talusRings; i++) {
    // Up the apron toward the wall, the wall fills more and more of the sky:
    // 200 m out on the plain a 150 m cliff subtends ~35 degrees, and at its
    // foot it fills a full half of the hemisphere.
    const t = i / (talusRings - 1);
    rows.push([sTalus * t, 1, lerp(0.90, 0.52, t), lerp(1.08, 0.96, t)]);
  }

  // Draw the per-bed character first so the thicknesses can be normalised to
  // fill the band exactly.
  const thick = [], deep = [], alb = [], prop = [];
  let tsum = 0;
  for (let b = 0; b < beds; b++) {
    const th = 0.44 + rng() * 1.42;
    thick.push(th);
    tsum += th;
    deep.push(0.32 + rng() * 0.92);          // how far the soft course is cut back
    alb.push(0.86 + rng() * 0.34);           // grey hard courses vs pale sandy ones
    prop.push([0.05 + rng() * 0.06, 0.55 + rng() * 0.26]);
  }

  let base = sTalus;
  for (let b = 0; b < beds; b++) {
    const span = (1 - sTalus) * (thick[b] / tsum);
    const d = deep[b];
    const a = alb[b];
    const oh = prop[b][0];                   // share of the bed spent overhanging
    const lip = oh + 0.035 + oh * 0.5;
    const riser = Math.max(lip + 0.18, prop[b][1]);
    //         s                 relief    sky   albedo
    rows.push([base + span * oh, -1.00 * d, 0.13, a * 0.88]);   // roofed, sees nothing
    rows.push([base + span * lip, -0.97 * d, 0.31, a * 1.06]);  // fresh broken rock
    rows.push([base + span * riser, -0.85 * d, 0.63, a * 1.00]); // vertical wall
    rows.push([base + span * 1.000, 1.00 * d, 0.94, a * 0.93]); // bench, open to sky
    base += span;
  }
  return rows;
}

/* ========================================================================== */
/*  Surface breakup — WORLD-space grime, shared by every structure family      */
/* ========================================================================== */

/**
 * A tiled texture repeats every 8 m; this varies over 20 m and 5.5 m in WORLD
 * space, so two pieces welded into the same batch never wear identically and a
 * long run of one material is never uniform along its length.
 *
 * It exists because of a measured defect: the 312 m conveyor bridge is one
 * continuous plane of one roughness, which puts every square metre of it at the
 * same angle to a 13-degree sun. The specular lobe therefore lit up as ONE
 * unbroken mirror band several stops past the tonemap shoulder — 75% of every
 * pixel at or above display 245 in the vista frame sat inside it. A blown
 * highlight is fixed at the source, and the source of a mirror band is a large
 * surface with no variation in it.
 *
 * Two deliberate constraints:
 *  - roughness is only ever ADDED, so this can break a highlight up but can
 *    never sharpen one, whatever the family's base value is;
 *  - the shortest wavelength is 5.5 m, which is ~12 px at the vista's 400 m
 *    sight lines. A sub-metre procedural term would alias into a crawling
 *    speckle at that range, and the baked roughness map already owns that scale.
 *
 * One function object shared by every family on purpose: three keys its program
 * cache on `onBeforeCompile.toString()`, so the families keep sharing a single
 * compiled program instead of forking one each.
 *
 * @param {object} sh three's shader object, mutated in place
 */
function surfaceBreakup(sh) {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      varying vec3 vLvlW;
    `)
    .replace('#include <project_vertex>', /* glsl */`
      vec4 lvlP = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        lvlP = instanceMatrix * lvlP;
      #endif
      vLvlW = ( modelMatrix * lvlP ).xyz;
      #include <project_vertex>
    `);

  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      varying vec3 vLvlW;
      float lvlGrime( vec3 p ) {
        float a = sin( p.x * 0.31 + p.z * 0.19 ) * sin( p.z * 0.28 - p.x * 0.12 + 1.9 );
        float b = sin( p.x * 1.14 - p.z * 0.87 + 0.7 ) * sin( p.y * 0.63 + p.z * 0.41 + 2.6 );
        return clamp( 0.5 + 0.31 * a + 0.19 * b, 0.0, 1.0 );
      }
    `)
    .replace('#include <map_fragment>', /* glsl */`
      #include <map_fragment>
      float lvlG = lvlGrime( vLvlW );
      diffuseColor.rgb *= 0.90 + 0.17 * lvlG;
    `)
    .replace('#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      roughnessFactor = clamp( roughnessFactor + 0.26 * lvlG, 0.04, 1.0 );
    `);
}

/**
 * Cliff anti-tiling. The rock maps repeat every `CLIFF_TILE` metres, which on
 * the boundary ring is 71 repeats around the horizon, and a repeat is a rhythm:
 * measured on the vista pose, the distant ridge carried a periodic column
 * pattern whose screen pitch matched the tile and its second harmonic (44 px
 * and 22 px predicted, 41.5 px and 21.5 px measured) and which did NOT move
 * when the ring was rebuilt from 288 columns to 384 — so it was never the mesh.
 *
 * Two more taps of the SAME map at incommensurate scales — 4.7x coarser and
 * 3.2x finer — put three periods on the surface at once (about 200 m, 42 m and
 * 13 m), and three periods that share no common factor do not read as a rhythm.
 * Both are used as RATIOS with a mean near 1.0, so this varies the rock without
 * shifting its overall value, and the coarse tap also drives roughness so it
 * reads as surface rather than as a stain.
 *
 * @param {object} sh three's shader object, mutated in place
 */
function cliffBreakup(sh) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <map_fragment>', /* glsl */`
      #include <map_fragment>
      float cliffMacro = dot( texture2D( map, vMapUv * 0.2137 ).rgb, vec3( 0.3333 ) );
      float cliffFine = dot( texture2D( map, vMapUv * 3.17 ).rgb, vec3( 0.3333 ) );
      diffuseColor.rgb *= ( 0.74 + 0.54 * cliffMacro ) * ( 0.90 + 0.20 * cliffFine );
    `)
    .replace('#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      roughnessFactor = clamp( roughnessFactor * ( 1.16 - 0.30 * cliffMacro ), 0.32, 1.0 );
    `);
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
      m.onBeforeCompile = surfaceBreakup;
      this._materials.push(m);
      return m;
    };

    /**
     * Structure families. Deliberately spread across the AC6 palette: gunmetal,
     * oxidised teal, rusted orange, faded hazard yellow, near-black machinery,
     * safety-orange trim, poured concrete.
     *
     * `rough` is a MULTIPLIER on the baked roughness map, not a roughness — three
     * evaluates `roughness * roughnessMap.g`, and the forge writes a mean near
     * 0.62 with a floor around 0.45 (the chipped-to-bare-metal texels). So the
     * effective range of a family is roughly `rough * [0.45, 0.80]`, and a family
     * needs `rough` above ~0.78 before its SMOOTHEST texels clear the 0.35 that
     * keeps a low sun off the shoulder. `dark` at 0.48 was landing those texels at
     * 0.22 — a mirror — which is what blew the conveyor deck out; every family
     * here was in the same neighbourhood. They are all weathered structural steel
     * on a dust plateau, so none of them should have been.
     *
     * `metal` IS NOW A HARD 0 OR 1, and the families that carry paint or oxide
     * are dielectric. This is the same defect the mech went through and wrote
     * up ("Painted armour is now metalness = 0; the previous all-metal setup
     * gave the armour no diffuse lobe at all, which is what made a dark palette
     * render as black plastic"), and it is why the deck the player stands on in
     * the gameplay frame measures a mean of display 37 with railings, gratings
     * and plate seams all over it that nothing can read. A conductor has NO
     * diffuse lobe: with the key behind the structure, `dark` at metalness 1.0
     * and albedo 0x3a3f44 had literally nothing left but a dim environment
     * specular, so a deck full of hardware rendered as one black shape with a
     * plastic sheen. Paint, primer, rust and concrete are all dielectrics;
     * `steel` is the one family that is genuinely bare alloy and it keeps 1.0.
     * The fractional values (0.9 / 0.8 / 0.72 / 0.55) were never physical
     * anyway — the contract's style rules forbid them outside a rust transition.
     *
     * The albedos of the two paint families that lost their conductor came UP
     * with the change, but only a little and deliberately not to compensate for
     * it: a dielectric with a real diffuse lobe reads at its albedo, so paint
     * owns darkness here exactly as it does on the mech.
     */
    this.mat = {
      steel: mk('steel', plateA, { color: 0x7d848b, rough: 0.80, metal: 1.0, env: 0.95, normalScale: 1.0 }),
      teal: mk('teal', plateA, { color: 0x53837c, rough: 0.86, metal: 0.0, env: 0.85, normalScale: 1.05 }),
      rust: mk('rust', plateA, { color: 0x8c4f2c, rough: 0.96, metal: 0.0, env: 0.7, normalScale: 1.15 }),
      ochre: mk('ochre', plateB, { color: 0x9c8340, rough: 0.90, metal: 0.0, env: 0.8 }),
      dark: mk('dark', plateB, { color: 0x474d54, rough: 0.96, metal: 0.0, env: 0.85 }),
      trim: mk('trim', plateB, { color: 0xb1541c, rough: 0.86, metal: 0.0, env: 0.75 }),
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

    /*
     * Cliffs: stratified rock, vertex-coloured banding, no metal at all.
     *
     * NO `aoMap`. A baked ambient-occlusion map is a per-tile blotch pattern,
     * and it multiplies INDIRECT light — which on a cliff face turned away from
     * a 13-degree sun is nearly all the light there is. Tiled every few tens of
     * metres across a 200 m landform that is a regular value rhythm applied to
     * exactly the surfaces with no key light to hide it, which is why the
     * shadowed half of the ring striped far harder than the sunlit half.
     * Occlusion on a landform belongs to its own geometry (the gullies and
     * benches cast) and to SSAO, not to a repeating texture.
     */
    const cliff = new THREE.MeshStandardMaterial({
      map: dust.map,
      normalMap: dust.normalMap,
      roughnessMap: dust.roughnessMap,
      color: 0xa2917a,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.55,
      vertexColors: true,
      dithering: true,
    });
    cliff.name = 'Level.cliff';
    // 1.95 was too much. The rock map's aggregate is ~1 m, which at the 250 m
    // sight line of the hero pose is three pixels, and a normal map's variance
    // does not fall away with mip level the way its albedo does — so the whole
    // cliff came back as an even stipple, the closest thing to stucco this
    // level has ever rendered. Relief on a landform at that range has to come
    // from the mesh; the map's job here is grain, not form.
    cliff.normalScale.set(1.3, 1.3);
    cliff.onBeforeCompile = cliffBreakup;
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

  /**
   * Two meshes, not one, and the split is a shadow-cost decision. The cliff ring
   * stands 440-1130 m out and a 13-degree sun throws its shadow right across the
   * far half of the arena, so it has to cast. The far plain and the buttes are
   * 0.8-3 km out with nothing behind them and nothing in front of them to catch
   * a shadow, and they are also the larger half of the boundary's triangles —
   * carrying them through four cascades cost 194k rendered triangles a frame and
   * put the boost pose over the 3M budget for no pixel anywhere. One extra draw
   * call buys all of it back.
   */
  _buildBoundary() {
    const ring = this._mesaRing();
    ring.setAttribute('uv1', ring.attributes.uv);
    ring.computeBoundingSphere();
    const ringMesh = new THREE.Mesh(ring, this.mat.cliff);
    ringMesh.name = 'Boundary';
    ringMesh.castShadow = true;
    ringMesh.receiveShadow = true;
    ringMesh.matrixAutoUpdate = false;
    ringMesh.updateMatrix();
    this.root.add(ringMesh);
    this._meshes.push(ringMesh);
    this._geometries.push(ring);

    const parts = [this._farPlain()];
    for (const g of this._distantButtes()) parts.push(g);
    const far = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    far.setAttribute('uv1', far.attributes.uv);
    far.computeBoundingSphere();
    const farMesh = new THREE.Mesh(far, this.mat.cliff);
    farMesh.name = 'BoundaryFar';
    farMesh.castShadow = false;
    farMesh.receiveShadow = false;
    farMesh.matrixAutoUpdate = false;
    farMesh.updateMatrix();
    this.root.add(farMesh);
    this._meshes.push(farMesh);
    this._geometries.push(far);

    this._buildContainmentField();
  }

  /**
   * The cliff wall: a revolved mesa with a scree apron at the toe, a near
   * vertical caprock band above it, and gullies incised down the face.
   *
   * Two defects were measured on the version this replaces and both are
   * addressed by construction rather than by tuning.
   *
   * (1) VERTICAL STRIPING. Per-column shade came out as white noise — the
   * adjacent-column difference was 0.82 of the whole-ring standard deviation,
   * i.e. neighbouring columns were essentially independent. It was NOT the
   * radius or height fields, which measured smooth (ratios 0.09-0.24); it was
   * the two strata terms, at 0.83 and 1.22. `y` steps 1.6 m per column and the
   * strata had periods of 15 m and 4.6 m, so their PHASE stepped 0.7 and 2.2 rad
   * per column — the second past Nyquist outright. Both were also far finer than
   * the 30 m ring spacing could carry, so they were being point-sampled at a
   * random phase at every vertex. Fine strata belong in the texture; the vertex
   * layer now carries beds at 132 m and 60 m against a ~10 m ring spacing, and
   * every angular field is a bounded harmonic sum, so the worst phase step
   * anywhere on the ring is 0.71 rad and it advances SMOOTHLY — beds bend over a
   * spur instead of flickering column to column.
   *
   * (2) NO LANDFORM. A revolve whose radius barely varies presents one coherent
   * normal to a 13-degree sun and reads as a flat pale cut-out however it is
   * lit or graded. Interior value has to come from real relief: the gully field
   * swings the surface azimuth about +/-27 degrees over a 55-110 m arc, which
   * is 100-190 px of light-and-shade at the vista's sight lines — landform
   * scale, an order of magnitude coarser than a column.
   *
   * (3) NO STRATA, which is what was left after (1) and (2) were fixed. The
   * beds were a pair of `sin(worldY)` terms in the VERTEX COLOUR, and colour is
   * the one channel aerial perspective can reach: at the vista's 700 m sight
   * line the veil is about 65%, and through AgX a 2:1 albedo ratio on the
   * remaining 35% arrives as under 8 display code values — measured on the face,
   * a vertical run of 14 samples spanning 130 px varied by +/-3. Beds are now
   * GEOMETRY (see `cliffFaceProfile`), because relief moves N.L instead of
   * albedo.
   *
   * (4) THE STRATA WERE A PERIODIC FUNCTION, which is what (3) left behind and
   * what the review frame actually shows: uniformly spaced, perfectly parallel
   * dark grooves curving in lockstep across the whole ridge, i.e. contour lines
   * on a topographic map. Three things were true at once and all three are
   * fixed in `cliffFaceProfile` and in the chute field below — every bed had the
   * same thickness, the same recess depth and the same colour; the tonal bands
   * were painted at full strength even where the geometry carrying them had
   * eroded away; and NOTHING on the face ran vertically, because with the face
   * beyond the terminator (measured: N.L -0.15..-0.89 on every ring) the only
   * light is ambient, and ambient is symmetric in azimuth, so the gullies that
   * were already there could not draw. Occlusion, not paint, is the channel.
   */
  _mesaRing() {
    const NA = 384;               // face columns; 7.8 m of arc each
    /** talus rings, bed count and the share of the face parameter given to scree */
    const S_TALUS = 0.30;
    // Its own generator, so retuning the stratigraphy cannot reshuffle the
    // harmonic phases below and reshape the whole landform underneath it.
    const FACE = cliffFaceProfile(8, 6, S_TALUS, mulberry32(SEED ^ 0x9e17));
    const NF = FACE.length;       // profile rings on the visible face
    const NP = NF + 8;            // plus the back slope down to the far plain
    const NV = NA + 1;            // duplicated seam column, see the UV note
    const rng = mulberry32(SEED ^ 0x31d5);

    /*
     * Every angular field is band-limited. Highest order anywhere is 29 against
     * 384 columns = 13 columns per cycle, so nothing here can step per column.
     */
    const H_MASS = harmonics(rng, [1, 2, 3, 5, 8, 13], 1.0);  // mesas vs saddles
    const H_CROWN = harmonics(rng, [5, 9, 15, 23], 1.0);      // ragged skyline
    const H_NOTCH = harmonics(rng, [3, 5, 9, 14, 21], 0.7);   // erosion clefts
    const H_SPUR = harmonics(rng, [2, 3, 5, 8], 1.0);         // buttresses in plan
    const H_GULLY = harmonics(rng, [7, 11, 17, 24], 0.8);     // erosion channels
    const H_CHUTE = harmonics(rng, [8, 13, 21, 29], 0.75);    // drainage down the face
    const H_CTOP = harmonics(rng, [7, 11, 19], 0.8);          // how high each chute heads
    const H_CLIFF = harmonics(rng, [2, 3, 6], 1.0);           // sheer .. eroded
    const H_TONE = harmonics(rng, [2, 4, 7], 1.0);            // slow value drift
    const H_SLIDE = harmonics(rng, [2, 3, 5], 1.0);           // breaks the UV repeat

    /** back slope: [radial offset beyond the face, height fraction] */
    const BACK = [
      [26, 0.97], [62, 0.90], [112, 0.76], [176, 0.57],
      [248, 0.38], [318, 0.22], [380, 0.09], [430, 0.00],
    ];

    const pos = new Float32Array(NV * NP * 3);
    const col = new Uint8Array(NV * NP * 3);
    const uv = new Float32Array(NV * NP * 2);
    const idx = new Uint32Array(NA * (NP - 1) * 6);

    const baseY = this.terrain ? this.terrain.minHeight - 6 : -20;
    const R_NOM = 476;
    /*
     * U is a CONSTANT step per column, and the ring carries a whole number of
     * tiles (115) so the duplicated seam column closes exactly. The old form was
     * `ang * r0 / 26` with a per-column `r0`: at the far side of the ring that
     * derivative is `ang * dr0 / 26`, which reached 2.2x the nominal step, so
     * the rock texture was being compressed and stretched column by column — a
     * second, independent source of vertical banding on top of the strata one.
     * It also had no seam column at all, which crammed one whole tile into the
     * last quad.
     */
    const U_TILES = 71;
    const U_STEP = U_TILES / NA;

    for (let a = 0; a < NV; a++) {
      const t = ((a % NA) / NA) * TAU;
      const ca = Math.cos(t), sa = Math.sin(t);
      const mass = angField(t, H_MASS);
      const crown = angField(t, H_CROWN);
      const spur = angField(t, H_SPUR);
      const gully = angField(t, H_GULLY);
      const tone = angField(t, H_TONE);
      const slide = angField(t, H_SLIDE);
      const cw = clamp(0.5 + 0.62 * angField(t, H_CLIFF), 0, 1);

      /*
       * A harmonic sum normalised to a peak of 1 has an RMS near 0.38, so these
       * amplitudes are roughly 2.6x the standard deviation they buy. The first
       * pass here used 96 m across orders 1-5 and rendered a single smooth arc
       * spanning the whole frame — one lobe is one lobe however tall it is. The
       * read comes from orders 8 and 13 (30 and 18 columns per lobe, i.e. 230
       * and 140 m of crest), which is what puts several mesas and saddles inside
       * the ~90 degrees of ring a wide shot actually sees.
       */
      /*
       * The floor is not cosmetic. The vista camera sits at y=78 and the ring's
       * base at about -26, so a section under ~104 m of relief is LOOKED DOWN
       * ON: its rim and back slope, both broad up-facing planes, come into view
       * as a pale flat band above the crest line. Clamping costs a few of the
       * deepest saddles and buys a silhouette that is always a silhouette.
       */
      /*
       * `notch` only ever CUTS. A crest built from a signed sine is a berm: it
       * rises as often as it falls and the two average out into a smooth arc.
       * Erosion is one-sided — it removes material at the drainages and leaves
       * the divides standing — so the deviation has to be rectified. It is
       * multiplicative, so a tall section gets a deep cleft and a short one is
       * barely touched, which keeps every saddle above the floor below.
       */
      const notch = Math.max(0, angField(t, H_NOTCH) - 0.08);
      const h = Math.max(112, (176 + mass * 128 + crown * 40) * (1 - notch * 0.40));
      const r0 = R_NOM + spur * 46;
      const talus = lerp(0.16, 0.46, cw);       // fraction of height that is scree
      /*
       * DRAINAGE CHUTES — the vertical erosion the face had none of. Every
       * feature on the old ring ran horizontally, so the beds drew as unbroken
       * concentric contours all the way round; what breaks a real cliff up is
       * water running DOWN it, which incises a chute, washes the bedding out
       * inside it and dumps a debris fan at the toe.
       *
       * Rectified, because erosion is one-sided: it removes material at the
       * drainages and leaves the divides standing, so a signed sine would raise
       * as many ribs as it cuts channels and the two would average out — the
       * same argument `notch` already makes for the crest line.
       *
       * Order 29 against 384 columns is 13 columns per cycle, about 100 m of
       * cliff, which is 60-90 px at the arena camera's 350-600 m sight lines and
       * still well clear of the 5-columns-per-feature floor the strata Nyquist
       * amendment sets.
       */
      const chuteA = clamp(Math.max(0, -angField(t, H_CHUTE) - 0.14) * 2.4, 0, 1);
      // Where each chute HEADS. Without this every chute ran from the same
      // height and the set of them was as periodic as the beds had been; with
      // it some bite in just under the rim and others only reach the middle of
      // the face, so the bedding is truncated at a different height each time.
      const chuteTop = 0.56 + 0.42 * (0.5 + 0.5 * angField(t, H_CTOP));
      // Scree stands at its angle of repose (~34 deg), so the apron's RUN follows
      // from the height it has to cover. A fixed radial run gave an 11-degree
      // ramp under a short eroded section and a 48-degree one under a tall
      // sheer section, neither of which is a talus.
      // A chute delivers its debris to the apron below it, so the fan runs out
      // further there than the apron either side of it does.
      const talusRun = Math.min(h * talus * 1.45, 210) * (1 + 0.26 * chuteA);
      const cliffRun = lerp(7, 34, cw);         // the caprock leans back a little
      // Bed relief in metres. A sheer section carries deeper benches than an
      // eroded one, and the amplitude is the ONLY thing about the stratigraphy
      // that varies around the ring — the schedule itself is fixed, which is
      // what keeps it aliasing-proof.
      const bedAmp = lerp(4.0, 10.5, cw);

      for (let p = 0; p < NP; p++) {
        let f, off, skyRow, albRow, chute;
        if (p < NF) {
          const s = FACE[p][0];
          // The RING schedule is fixed but the talus FRACTION is per-column, so
          // the two are composed rather than merged: `s` decides which ring this
          // is, `talus` decides how much of the column's height the scree covers.
          f = s < S_TALUS
            ? talus * (s / S_TALUS)
            : talus + (1 - talus) * (s - S_TALUS) / (1 - S_TALUS);
          off = f < talus
            ? talusRun * Math.pow(f / talus, 0.86)
            : talusRun + cliffRun * (f - talus) / (1 - talus);
          // A chute is a channel, so it is deepest where the water has been
          // running longest — low and mid face — and dies out near the crest,
          // which has no catchment above it.
          // The die-out height is `chuteTop` rather than a fixed 0.99. Every
          // chute heading at the same height was itself a periodic feature —
          // the exact defect the chutes exist to break — so the set of them
          // read as one more evenly-ruled band. The fade keeps its 0.33 width,
          // so at chuteTop = 0.99 this is the original 0.66..0.99 curve.
          // Both edges stay ordered (chuteTop spans 0.56..0.98, so the low
          // edge spans 0.23..0.65), which matters: a reversed-edge smoothstep
          // is UNDEFINED in GLSL and returns 0 everywhere on the common
          // driver, and this same expression is mirrored in the terrain
          // shader.
          chute = chuteA * (1 - smoothstep(chuteTop - 0.33, chuteTop, f)) * smoothstep(0.0, 0.14, f);
          // Beds are buried at the toe by their own scree and roll over at the
          // crest, so the relief fades in and out rather than ending on a step.
          // A chute WASHES THE BEDDING OUT: inside one there is no bench and no
          // overhang left to cast, which is what truncates the horizontal bands
          // instead of merely shading over them.
          off += FACE[p][1] * bedAmp * (1 - 0.85 * chute)
            * smoothstep(S_TALUS * 0.55, S_TALUS * 1.25, s)
            * (1 - smoothstep(0.94, 1.0, s));
          skyRow = FACE[p][2];
          albRow = FACE[p][3];
        } else {
          const b = BACK[p - NF];
          off = talusRun + cliffRun + b[0];
          f = b[1];
          skyRow = 0.95;                       // open back slope, nothing above it
          albRow = 0.94;
          chute = 0;
        }
        // Gullies bite deepest in the scree and die out under the caprock. The
        // residue on the cliff itself was 0.24 and is now 0.45: the caprock is
        // most of what an arena camera sees, and with the face beyond the
        // terminator a smooth cylinder up there has no interior value at all.
        const gd = Math.pow(Math.sin(Math.PI * clamp((f - 0.02) / 0.74, 0, 1)), 0.7)
          + 0.45 * smoothstep(0.52, 0.96, f);
        // Seen from inside the ring, cutting INTO the wall means a larger radius.
        const r = r0 + off + gully * gd * 24 + chute * 15;
        const y = baseY + h * f - clamp(gully, 0, 1) * gd * 4.5;

        const k = a * NP + p;
        pos[k * 3] = ca * r;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = sa * r;
        // `slide` walks the tile phase 1.2 tiles around the ring. Measured on
        // the previous capture, the residual 27 px vertical rhythm on the ridge
        // was not the mesh at all — per-column vertex shade and N.L both came
        // out smooth (adjacent-column difference 0.17 and 0.05 of their own
        // standard deviations) — it was the rock map repeating 115 times around
        // the ring, which lands ~16 repeats inside a 500 px window. Sliding the
        // phase breaks the rhythm; the amplitude is held low so the local U
        // density still varies by only about a sixth, which is what stops this
        // becoming the per-column density stripe the old `ang * r0` form had.
        uv[k * 2] = a * U_STEP + slide * 1.2;
        uv[k * 2 + 1] = y / UV_CLIFF;

        // One SLOW colour bed survives from the old scheme, at 150 m against a
        // per-column height step of about 0.9 m: it is the large-scale "this
        // whole band of rock is redder" drift, and at that period its phase
        // cannot alias. It is phased off the LOW-ORDER height only, because the
        // crown wobble and the gully cut move the surface, not the beds that
        // were laid down before it eroded.
        const yBed = baseY + (176 + mass * 128) * f;
        const s1 = smoothstep(0.32, 0.68, Math.sin(yBed * 0.0419 + tone * 1.7) * 0.5 + 0.5);
        const scree = 1 - smoothstep(talus * 0.72, talus * 1.30, f);
        const cut = clamp(-gully * gd, 0, 1);   // shaded floor of a channel
        const rib = clamp(gully * gd, 0, 1);    // a spur, standing clear of the wall
        /*
         * THE VERTEX COLOUR IS OCCLUSION, NOT PAINT. Measured with
         * tools/probes/beds.js: every ring of the face this camera sees runs
         * N.L -0.15..-0.89, so the key delivers nothing and the surface is lit
         * by the hemisphere alone — under which a normal's AZIMUTH is worth
         * almost nothing and only its ELEVATION counts. That is the whole
         * explanation for the defect: the beds tip a normal up and down so they
         * drew, the gullies and spurs only swing it sideways so they did not,
         * and the face rendered as horizontal contour lines on flat brown.
         * Baked sky visibility puts the sideways features back on a channel the
         * ambient can actually deliver.
         *
         * `bedSharp` ties the tonal contrast of the beds to the same `cw` that
         * sets their PHYSICAL amplitude. Without it an eroded stretch of ring
         * whose benches have almost no relief left still drew its bands at full
         * strength, which is the other half of why they ran unbroken for 360
         * degrees.
         */
        const bedSharp = clamp(0.34 + 0.80 * cw, 0, 1);
        let sv = 1 - (1 - skyRow) * bedSharp;
        sv *= 1 - 0.50 * chute;                 // a chute is walled on both sides
        sv *= 1 - 0.34 * cut;                   // and so is the floor of a gully
        sv *= 1 + 0.11 * rib;                   // a spur sees more sky than the wall
        // Albedo carries the material difference between courses — that is what
        // `albRow` is for — plus fresh pale debris in the chutes and on the
        // apron. It is deliberately a narrow range: through a 40-60% veil an
        // albedo ratio arrives at a fraction of its size, so contrast has to
        // come from the occlusion term.
        const shade = albRow * sv
          * (0.68 + s1 * 0.26 + scree * 0.13 + tone * 0.06 + chute * 0.11);
        const warm = 0.90 + s1 * 0.20 + scree * 0.06 - chute * 0.07;
        const k3 = k * 3;
        col[k3] = clamp(shade * warm, 0, 1) * 255;
        col[k3 + 1] = clamp(shade * (0.93 + s1 * 0.05), 0, 1) * 255;
        col[k3 + 2] = clamp(shade * 0.78, 0, 1) * 255;
      }
    }

    let w = 0;
    for (let a = 0; a < NA; a++) {
      for (let p = 0; p < NP - 1; p++) {
        const i0 = a * NP + p, i1 = a * NP + p + 1;
        const j0 = (a + 1) * NP + p, j1 = (a + 1) * NP + p + 1;
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
    // The seam column exists so U can run 0..115 without wrapping a whole tile
    // into one quad, but a duplicated vertex only collects half its ring of
    // faces, so average the two halves back together or the seam lights as a
    // one-column crease.
    const nrm = g.attributes.normal.array;
    for (let p = 0; p < NP; p++) {
      const i = p * 3, j = (NA * NP + p) * 3;
      const x = nrm[i] + nrm[j], y = nrm[i + 1] + nrm[j + 1], z = nrm[i + 2] + nrm[j + 2];
      const l = Math.hypot(x, y, z) || 1;
      nrm[i] = nrm[j] = x / l;
      nrm[i + 1] = nrm[j + 1] = y / l;
      nrm[i + 2] = nrm[j + 2] = z / l;
    }
    return g;
  }

  /** Dust plain beyond the cliffs — gives the horizon something to sit on. */
  _farPlain() {
    // 224 columns, not 128: the plain's outer edge is the horizon line itself,
    // and one column there was 157 m of straight edge.
    const NA = 224, NR = 9;
    const R0 = 840, R1 = 3400;
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
        // 128 columns at 3200 m is a 157 m step. The old field at 0.004 units/m
        // put one lattice unit at 250 m and its fourth octave at 30 m — five
        // times finer than the mesh can carry — so the far plain's height and
        // value both changed at every column, sawing the horizon line and
        // striping the haze band behind it. 0.0011 with two octaves lands the
        // finest feature at ~450 m, i.e. three columns, and a hazed dust plain
        // at 1-3 km has no business carrying detail finer than that anyway.
        const n = fbm2(ca * rad * 0.0011, sa * rad * 0.0011, 133, 2);
        const y = baseY - 6 + (n - 0.5) * 34 * (0.35 + t);
        const k = a * NR + r;
        pos[k * 3] = ca * rad; pos[k * 3 + 1] = y; pos[k * 3 + 2] = sa * rad;
        uv[k * 2] = ca * rad / (UV_CLIFF * 1.6); uv[k * 2 + 1] = sa * rad / (UV_CLIFF * 1.6);
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

  /**
   * The vista's whole background layer: two rings of free-standing mesas on the
   * far plain, the near group deliberately close enough to overlap the cliff
   * ring's saddles.
   *
   * This layer read as flat pale cut-outs, and the reason is worth keeping. At
   * 1.5 km a butte is ~95% veiled, so lighting contributes almost nothing and
   * the SILHOUETTE plus a few code values of interior ramp is the entire read.
   * The shape it had could not carry that: six profile rings whose last one
   * folded back inward, giving a hard-edged trapezoid with a roof, and a plan
   * that was a near-circle. A real mesa is a scree cone that flares out at the
   * toe, a vertical caprock band, and a rim that rolls over — the toe is what
   * stops the shape sitting on the plain like pasted paper, and the rim is what
   * says "rock" rather than "hill". Three further things carry the depth read:
   * the plan is anisotropic and turned (a squashed butte across the sight line
   * is a RIDGE, not another cylinder), the near group is at 0.8-1.4 km so its
   * silhouettes cross both the ring in front and the far group behind, and the
   * crest is darker than the toe so every shape has an interior ramp.
   *
   * Beds are phased off the UNMODULATED height, so the ragged crown cannot walk
   * their phase from column to column — the aliasing failure that striped the
   * cliff ring.
   */
  _distantButtes() {
    const rng = mulberry32(SEED ^ 0x9a1);
    const out = [];
    const baseY = this.terrain ? this.terrain.minHeight - 4 : -20;

    /** [radius factor, height fraction] — scree cone, caprock, rim, cap. */
    const PROF = [
      [1.000, 0.000], [0.905, 0.115], [0.828, 0.235], [0.762, 0.350],
      [0.712, 0.455], [0.686, 0.560], [0.672, 0.665], [0.664, 0.760],
      // The caprock stands PROUD of the slope it sits on. That flare is the
      // overhang line every real mesa carries just under its rim, and it is the
      // one place a shape this veiled can still put a hard dark edge.
      [0.708, 0.802], [0.702, 0.898], [0.672, 0.952],
      // The cap CLOSES. It used to stop at 0.08 of the plan radius, which on a
      // 300 m butte is a 24 m hole, and the vista pose looked straight through
      // one at bright sky — a white pennant sitting in the middle of a
      // silhouette. A revolve that is meant to be solid needs its pole.
      [0.585, 0.988], [0.430, 1.000], [0.230, 0.997], [0.000, 0.990],
    ];
    const NP = PROF.length;
    const NA = 64, NV = NA + 1;

    /*
     * count, radius min/span, plan radius min/span, height min/span, contrast.
     *
     * The minimum HEIGHT is load-bearing and was 85 m. A butte's cap is a flat,
     * up-facing plane, and an up-facing plane under a bright sky is the
     * brightest surface a landform owns — so any butte whose top came out below
     * the camera was seen from above and read as a pale slab floating over the
     * ridge line, which is the exact defect this level has already been through
     * once with the banners. Base sits at terrain minimum minus 4 (about -24 m)
     * and the vista camera is at 78 m, so nothing below ~105 m of relief is
     * safe. At 130 m the shortest cap is 28 m above that camera and further
     * above any gameplay one.
     */
    /*
     * ONE band, 0.95-1.9 km, not two out to 3 km. Working the fog numbers: the
     * aerial term alone reaches tau 1.2 at 1 km (70% veiled), 2.5 at 1.5 km
     * (92%) and 3.5 at 2.4 km (97%). Past about 2 km a landform retains so
     * little of its own radiance that it renders as one flat patch of fog
     * colour with a hard edge — measured on the previous capture, a 3 km butte
     * came back as a uniform pale rounded rectangle with ZERO interior
     * variation, which is the paper cut-out this whole layer exists to stop
     * being. A shape only reads as rock while it still owns some of its own
     * light. The far horizon is the far plain's job.
     *
     * The height minimum is the other hard constraint: base is about -24 and
     * the crown modulation can take 0.81 of the nominal height, so anything
     * under ~150 m of relief can put its flat, up-facing cap below the vista
     * camera at y=78 and read as a floating slab.
     */
    const GROUPS = [
      [22, 950, 950, 85, 145, 150, 150, 1.00],
    ];

    /*
     * PLACED IN CLUSTERS, NOT EVENLY ROUND THE RING, and this is the single
     * change with the most authority over how this layer reads.
     *
     * Measured (see the amendment): a butte's interior comes back with a
     * standard deviation of 2.05 code values and a total range of seven, so
     * every gram of contrast this layer owns is in the boundary between a
     * butte and the sky. An evenly-spaced ring spends that boundary badly —
     * each shape is an isolated island with sky all round it, which is the
     * literal definition of a cut-out, and no amount of vertex colour inside
     * one can say otherwise.
     *
     * Two shapes whose outlines CROSS say something the veil cannot take away:
     * one of them is in front. That is a depth cue made entirely of silhouette,
     * and it costs nothing. So the ring is eight clusters of 2-4, members
     * within a cluster a tenth of a radian apart (about 120 m of lateral offset
     * at this range, against plan radii of 85-230 m, so they must overlap) and
     * deliberately spread across the WHOLE 950-1900 m band so the overlap is
     * always near-against-far rather than two shapes at one depth merging into
     * a single blob.
     *
     * `needle` is the other half of it. A narrow spire standing beside a broad
     * mesa reads as erosion and gives the group a scale reference, and being
     * thin it is nothing BUT outline — exactly the shape this range can carry.
     */
    const CLUSTERS = 8;
    const place = [];
    {
      let left = GROUPS[0][0];
      for (let c = 0; c < CLUSTERS; c++) {
        const k = Math.min(left - (CLUSTERS - 1 - c), 2 + Math.floor(rng() * 3));
        const base = ((c + 0.5) / CLUSTERS) * TAU + (rng() - 0.5) * (TAU / CLUSTERS) * 0.5;
        const spread = 0.07 + rng() * 0.07;
        // Members are handed one slice each of the depth band, shuffled, so no
        // two in a cluster can land at the same range and fuse.
        const slot = [];
        for (let m = 0; m < k; m++) slot.push(m);
        for (let m = slot.length - 1; m > 0; m--) {
          const j = Math.floor(rng() * (m + 1));
          const t = slot[m]; slot[m] = slot[j]; slot[j] = t;
        }
        for (let m = 0; m < k; m++) {
          place.push({
            ang: base + (m - (k - 1) * 0.5) * spread,
            radT: (slot[m] + rng()) / k,
            needle: k > 2 && m === k - 1 && rng() < 0.7,
          });
        }
        left -= k;
      }
    }

    for (const [, rad0, rads, br0, brs, bh0, bhs, con] of GROUPS) {
      for (let i = 0; i < place.length; i++) {
        const ang = place[i].ang;
        const rad = rad0 + place[i].radT * rads;
        const cx = Math.cos(ang) * rad, cz = Math.sin(ang) * rad;
        const nd = place[i].needle;
        const r = (br0 + rng() * brs) * (nd ? 0.30 : 1.0);
        const h = (bh0 + rng() * bhs) * (nd ? 1.28 : 1.0);
        const squash = 0.42 + rng() * 0.58;
        const turn = rng() * TAU;
        const cq = Math.cos(turn), sq = Math.sin(turn);

        // Highest plan order is 17 against 64 columns — 3.8 columns per lobe,
        // which is coarse enough to survive the mesh and fine enough to put
        // notches in an outline rather than a smooth oval.
        const H_PLAN = harmonics(rng, [2, 3, 5, 8, 11, 17], 1.0);
        const H_CROWN = harmonics(rng, [1, 2, 3, 5, 9], 1.0);
        // The crown CLEFT. `H_CROWN` is a signed sine and averages out into a
        // smooth dome; erosion is one-sided, so this one is rectified and only
        // ever cuts — the same argument the cliff ring's `notch` makes. It is
        // what turns a flat-topped loaf into a group of summits with a saddle
        // between them, and a saddle is an outline feature, which is the only
        // kind this range can deliver.
        const H_CLEFT = harmonics(rng, [2, 3, 5, 9], 0.8);
        const H_TONE = harmonics(rng, [1, 3, 6], 1.0);
        const bedPhase = rng() * TAU;

        const pos = new Float32Array(NV * NP * 3);
        const col = new Uint8Array(NV * NP * 3);
        const uv = new Float32Array(NV * NP * 2);
        const idx = new Uint32Array(NA * (NP - 1) * 6);

        for (let a = 0; a < NV; a++) {
          const t = ((a % NA) / NA) * TAU;
          const ca = Math.cos(t), sa = Math.sin(t);
          const planN = angField(t, H_PLAN);
          const plan = 1 + 0.27 * planN;
          const cleft = Math.max(0, angField(t, H_CLEFT) - 0.10);
          /*
           * The floor is the same constraint the height minimum above is: base
           * sits at about -24 and the vista camera at 78, so a column that
           * drops under ~112 m of relief shows the reviewer the TOP of its cap,
           * a broad up-facing plane that renders as a pale slab floating in
           * front of the ridge. Expressed in metres rather than as a fraction
           * so a 300 m butte can still be cut nearly twice as deep as a 150 m
           * one, which is what keeps the clefts from all looking the same size.
           */
          const hs = Math.max(112 / h, (1 + 0.19 * angField(t, H_CROWN)) * (1 - cleft * 0.38));
          const tone = angField(t, H_TONE);
          for (let p = 0; p < NP; p++) {
            const frac = PROF[p][1];
            // The plan wobble tapers out toward the cap. At full strength on the
            // rim it drove thin slivers off the caprock flare that caught the
            // sun edge-on and rendered as bright pennants on the silhouette.
            // Taper 0.50, not 0.62, and the amplitude is up from 0.27. The
            // taper exists because full-strength wobble on the caprock flare
            // threw thin slivers that caught the sun edge-on and drew as bright
            // pennants on the silhouette; at a 92-95% veil a sliver keeps about
            // a twentieth of its own radiance, so the risk that bought the
            // taper has mostly gone and the outline needs the buttresses back.
            const rr = r * PROF[p][0] * (1 + 0.31 * planN * (1 - 0.50 * frac));
            const y = baseY + h * frac * hs;
            const lx = ca * rr, lz = sa * rr * squash;
            const k = a * NP + p;
            pos[k * 3] = cx + lx * cq - lz * sq;
            pos[k * 3 + 1] = y;
            pos[k * 3 + 2] = cz + lx * sq + lz * cq;
            uv[k * 2] = (a / NA) * (TAU * r / UV_CLIFF);
            uv[k * 2 + 1] = y / UV_CLIFF;

            const yBed = baseY + h * frac;
            const s1 = Math.sin(yBed * 0.0532 + bedPhase) * 0.5 + 0.5;      // 118 m
            const s2 = Math.sin(yBed * 0.1208 + bedPhase * 1.7) * 0.5 + 0.5; // 52 m
            const scree = 1 - smoothstep(0.26, 0.58, frac);
            // The band right under the caprock flare is in its own shadow.
            const under = smoothstep(0.62, 0.76, frac) * (1 - smoothstep(0.78, 0.84, frac));
            /*
             * Base 0.44, not 0.57. At 1-3 km the veil is 75-95%, so what a
             * butte renders is mostly the fog colour and only a little of its
             * own albedo — which means a pale rock lands ABOVE the sky around
             * it and reads as pasted paper. The albedo has to be pulled down
             * for the veiled result to sit below the sky, which is where a
             * distant landform belongs.
             */
            let sh = 0.44 + s1 * 0.23 + s2 * 0.09 + scree * 0.13
              + (plan - 1) * 0.40 + tone * 0.05 - under * 0.14;
            // Desert varnish. The cap is the oldest surface on the landform and
            // the only one facing the sky, so it needs to come down or it wins
            // the frame. Keyed to the ring INDEX, not the height fraction — the
            // cap rings sit BELOW the rim (that is what makes it a cap and not
            // a cone), so a height test darkens exactly the wrong ring.
            if (p >= NP - 3) sh *= 0.70;
            else if (p === NP - 4) sh *= 0.86;
            // Crest darker than toe: a shape at one flat value is what reads as
            // a cut-out, and a ramp is the only interior cue that survives a
            // 95% veil.
            sh *= 1.09 - 0.27 * frac;
            sh = 0.60 + (sh - 0.60) * con;
            const k3 = k * 3;
            col[k3] = clamp(sh * 1.03, 0, 1) * 255;
            col[k3 + 1] = clamp(sh * 0.95, 0, 1) * 255;
            col[k3 + 2] = clamp(sh * 0.83, 0, 1) * 255;
          }
        }

        let w = 0;
        for (let a = 0; a < NA; a++) {
          for (let p = 0; p < NP - 1; p++) {
            const i0 = a * NP + p, i1 = a * NP + p + 1;
            const j0 = (a + 1) * NP + p, j1 = (a + 1) * NP + p + 1;
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
        const nrm = g.attributes.normal.array;
        for (let p = 0; p < NP; p++) {
          const u = p * 3, v = (NA * NP + p) * 3;
          const x = nrm[u] + nrm[v], y = nrm[u + 1] + nrm[v + 1], z = nrm[u + 2] + nrm[v + 2];
          const l = Math.hypot(x, y, z) || 1;
          nrm[u] = nrm[v] = x / l;
          nrm[u + 1] = nrm[v + 1] = y / l;
          nrm[u + 2] = nrm[v + 2] = z / l;
        }
        out.push(g);
      }
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
          // The bar pattern is 213 cycles around a 430 m ring, i.e. ~12.7 m of
          // arc, which from anywhere across the arena is 20-30 px. Modulating
          // the FAR alpha by it (0.28..1.0, a 3.6x swing) put a fine regular
          // vertical rhythm across every distant sight line for no design gain
          // whatsoever, since the boundary is supposed to be invisible until it
          // is approached. It now resolves with proximity along with everything
          // else about the curtain.
          float detail = mix( 1.0, 0.28 + 0.72 * bars * scan, prox );
          float a = ( 0.035 + prox * 0.62 ) * vert * detail * pulse;
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
      // slot 5 flags "this slab tracks a real flat wall". Only the sliced
      // footprints do; `_addAABB` circumscribes towers, tanks and lattice, whose
      // faces can stand many metres inside the box. `_buildBanners` is the one
      // consumer that needs to tell them apart — everything else only reads 0..3.
      this._blockers.push([xa, zmin, xb, zmax, y1, 1]);
      this.stats.colliders++;
    }
  }

  /** Axis-aligned collider convenience (towers, tanks, props). */
  _addAABB(cx, cz, w, d, y0, y1, owner) {
    _box.min.set(cx - w * 0.5, y0, cz - d * 0.5);
    _box.max.set(cx + w * 0.5, y1, cz + d * 0.5);
    this.physics.addBox(_box, owner);
    this._blockers.push([cx - w * 0.5, cz - d * 0.5, cx + w * 0.5, cz + d * 0.5, y1, 0]);
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
    // Deck and crane rails in bolted sections, not single 162 m extrusions —
    // same reasoning as the conveyor deck: one plane 162 m long at 152 m up is
    // a mirror pointed at the horizon, and this one is silhouetted against sky.
    const armPlates = Math.round(armLen / 8);
    for (let i = 0; i < armPlates; i++) {
      const j = (i * 0.6180339887 + 0.077) % 1 - 0.5;
      const k = (i * 0.7548776662 + 0.482) % 1 - 0.5;
      b.pushTRS(-armLen * 0.5 + (i + 0.5) * (armLen / armPlates), 11.3 + k * 0.06, 0, 0, j * 0.026, 0);
      b.box(K.dark, armLen / armPlates - 0.06, 0.30, 9.5, 0, 0, 0, 0,
        { tint: S.GeoBatch.tint(0xa9a49b, 0.90 + (k + 0.5) * 0.20) });
      b.pop();
    }
    S.railing(b, K.dark, -armLen * 0.5, -4.8, armLen * 0.5, -4.8, 11.5, 1.2);
    S.railing(b, K.dark, -armLen * 0.5, 4.8, armLen * 0.5, 4.8, 11.5, 1.2);
    // service rails + trolley
    for (const s of [-1, 1]) {
      for (let i = 0; i < armPlates; i++) {
        const k = (i * 0.7548776662 + 0.155) % 1 - 0.5;
        b.box(K.trim, armLen / armPlates - 0.08, 0.4, 0.55,
          -armLen * 0.5 + (i + 0.5) * (armLen / armPlates), 11.75 + k * 0.02, s * 3.2, 0,
          { tint: S.GeoBatch.tint(0xd2c8b6, 0.92 + (k + 0.5) * 0.16) });
      }
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
        { r: 9.5 - i, legH: 7, rng, tint: 0xb9c3bb });
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
      // Instanced props share one geometry and one material, so world-space
      // grime is the only thing that stops 168 containers wearing identically.
      m.onBeforeCompile = surfaceBreakup;
      this._materials.push(m);
      return m;
    };
    const A = this._tex.plateA, B = this._tex.plateB, C = this._tex.conc;
    const mContainer = propMat('container', B, { color: 0xffffff, rough: 0.76, metal: 0.9 });
    const mSteel = propMat('steel', B, { color: 0xffffff, rough: 0.74, metal: 1.0 });
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
   * Torn tarps and banners LASHED TO SOMETHING. A two-term wave in the vertex
   * shader, weighted so the lashed edge stays put — about as much motion as a
   * still frame needs and it costs one uniform.
   *
   * This used to scatter its anchors on a random bearing from each district
   * centre at `heightAt + 6..22`, i.e. hanging in open air with nothing behind
   * them and `castShadow` off. Confirmed by raycast as the flat panel that had
   * been floating in the upper-right of the hero frame for several iterations:
   * the ray through that screen point hits `Level.banners` at 89 m, world
   * (6.4, 34.9, -52.4), 20 m above the ground with clear sky behind it. It was
   * previously diagnosed as the `ContainmentField`; the field is the SECOND hit
   * along that ray, 380 m further out, and its shader cannot draw an opaque grey
   * plate — the raycast reached it because a raycast does not read alpha.
   *
   * Two things had to change together. Anchors now come from real geometry —
   * `_blockers` (every structure footprint placed so far) and `_decks` (the
   * walkable bridge decks) — so every tarp hangs off a parapet or a handrail
   * with mass behind it. And the UVs are world-scaled: a `PlaneGeometry`'s
   * default 0..1 UVs stretched ONE tile of the armour-panel map across the whole
   * 12 m piece, so its plates rendered a metre wide each and the thing read as a
   * rigid bulkhead rather than as cloth. At 1.7 m per tile the same map reads as
   * coarse weave and stitched seams.
   */
  _buildBanners() {
    const rng = mulberry32(SEED ^ 0xba33);
    const pieces = [];
    const sites = [];

    // --- lashed under a parapet, flush to a wall face ---------------------
    const B = this._blockers;
    for (let guard = 0; guard < 400 && sites.length < 26 && B.length; guard++) {
      const bl = B[Math.floor(rng() * B.length)];
      // Only sliced building footprints (`_addOBB`) bound a real flat wall.
      // Measured: allowing every blocker left 8 of 29 tarps with no geometry
      // within 6 m, because a tank's or a lattice tower's AABB face stands
      // metres clear of anything solid — which is how they got back into open
      // sky, just less obviously than before.
      if (!bl[5]) continue;
      const sx = bl[2] - bl[0], sz = bl[3] - bl[1];
      if (sx < 6 || sz < 6) continue;                    // a post, not a wall
      const cx = (bl[0] + bl[2]) * 0.5, cz = (bl[1] + bl[3]) * 0.5;
      const gy = this.heightAt(cx, cz);
      const wallH = bl[4] - gy;
      if (wallH < 8 || wallH > 70) continue;
      const w = 2.4 + rng() * 3.2;
      const h = Math.min(2.2 + rng() * 3.4, wallH - 3.6);
      if (h < 1.5) continue;
      // Sit on the footprint face. `_addOBB` slices along X, so a slab's +/-Z
      // faces always lie on the real outline while its +/-X faces are usually
      // an interior cut through the building — only the Z pair is offered, and
      // only near the middle of it, where the axis-aligned slab and the rotated
      // wall it bounds agree to about a metre. Erring INWARD just tucks the
      // tarp behind the wall, which is a far cheaper failure than erring
      // outward into open sky, so the 0.2 m stand-off is deliberately small.
      const along = (rng() - 0.5) * 0.5;
      const x = cx + along * sx;
      const z = rng() < 0.5 ? bl[1] - 0.2 : bl[3] + 0.2;
      const yaw = z < cz ? Math.PI : 0;
      if (Math.hypot(x, z) > ARENA_R - 20) continue;
      const yTop = bl[4] - 0.7 - rng() * 2.2;
      if (yTop - h < gy + 1.4) continue;
      sites.push([x, yTop, z, yaw, w, h]);
    }

    // --- lashed to a bridge handrail, hanging over the edge ---------------
    for (const d of this._decks) {
      if (rng() < 0.45) continue;
      const t = 0.12 + rng() * 0.76;
      const x = lerp(d[0], d[3], t), z = lerp(d[2], d[5], t);
      const y = lerp(d[1], d[4], t);
      const ang = Math.atan2(d[3] - d[0], d[5] - d[2]);
      const s = rng() < 0.5 ? -1 : 1;
      const off = d[6] * 0.5 + 0.12;
      sites.push([
        x + Math.cos(ang) * off * s, y + 1.02, z - Math.sin(ang) * off * s,
        ang + (s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5),
        2.2 + rng() * 2.6, 1.8 + rng() * 2.4,
      ]);
    }

    // 1.7 m per texture tile: the armour-panel map's plates land at ~0.3 m,
    // which reads as weave and stitching instead of as bolted bulkhead plate.
    const UV_TARP = 1.7;
    for (const [x, yTop, z, yaw, w, h] of sites) {
      const g = new THREE.PlaneGeometry(w, h, 6, 5);
      const pa = g.attributes.position;
      const ua = g.attributes.uv;
      const wave = new Float32Array(pa.count);
      for (let i = 0; i < pa.count; i++) {
        const px = pa.getX(i);
        // 0 at the top edge (lashed) → 1 at the free bottom corner
        const u = (px / w) + 0.5;
        const v = 0.5 - (pa.getY(i) / h);
        // eat the free edge away irregularly — a clean rectangle in silhouette
        // is what made these read as panels rather than as rag
        let py = pa.getY(i);
        if (v > 0.99) py += (0.12 + rng() * 0.62) * h * 0.30;
        else if (v > 0.78) py += (rng() - 0.35) * h * 0.10;
        pa.setY(i, py);
        pa.setZ(i, pa.getZ(i) + (rng() - 0.5) * 0.22);
        wave[i] = clamp(v * (0.30 + u * 0.85), 0, 1.3);
        ua.setXY(i, (px + x * 0.37) / UV_TARP, (py + yTop * 0.29) / UV_TARP);
      }
      g.setAttribute('aWave', new THREE.BufferAttribute(wave, 1));
      g.computeVertexNormals();
      g.rotateY(yaw);
      g.translate(x, yTop - h * 0.5, z);
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
          // 0.28 not 0.55: these now hang 30 cm off a wall, and half a metre of
          // swing would drive the free corner straight through it
          float amp = aWave * 0.28;
          transformed.x += sin( uTime * 2.1 + ph ) * amp;
          transformed.z += cos( uTime * 1.7 + ph * 1.3 ) * amp * 0.8;
          transformed.y -= aWave * ( 0.10 + 0.08 * sin( uTime * 2.6 + ph ) );
        `);
    };
    this._materials.push(mat);

    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'Level.banners';
    // A tarp with no shadow is a decal floating in front of the wall it is
    // lashed to; it is 1.3 k triangles, so the cascade cost is noise.
    mesh.castShadow = true;
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
