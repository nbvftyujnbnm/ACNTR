import * as THREE from 'three';

/**
 * Physics — static-world collision for a high-speed mech game.
 *
 * There is no physics library here on purpose: we only ever need *one* dynamic
 * shape (a vertical capsule) against a large static triangle-soup + AABB world,
 * and a very large number of ray/sphere queries per frame (weapons, AI LOS,
 * camera pull-in). A general engine would cost far more than it buys.
 *
 * Design notes
 * ------------
 * - Broadphase is a uniform spatial hash (CELL metres). Terrain triangles are
 *   ~3-6 m so they land in 1-4 cells; buildings are registered as AABBs via
 *   `addBox` which is an order of magnitude cheaper than their triangles.
 * - Everything is stored in flat typed arrays. No Vector3 is touched inside the
 *   inner loops — the math is written out on scalars so V8 keeps it in
 *   registers and the whole query path allocates zero bytes.
 * - Movement is substepped so a single substep never advances more than
 *   `radius * 0.5`. Combined with a *conservative swept* capsule test (the
 *   capsule is covered by a chain of overlapping spheres) this makes tunnelling
 *   impossible even at 300+ m/s assault-boost speeds.
 *
 * Conventions
 * -----------
 * - `pos` passed to `moveCapsule` is the capsule **centre** (matching
 *   `Entity.collider.center` in CONTRACT.md), `height` is the full tip-to-tip
 *   height, so the internal segment half-length is `height/2 - radius`.
 * - `moveCapsule` writes the post-collision velocity back into `vel` — sliding
 *   has to remove the into-surface component or the mech accumulates velocity
 *   against walls. `out.velocity` aliases the same vector.
 * - Triangle winding is assumed consistent (outward / upward facing). It is
 *   only used to disambiguate deep-penetration recovery, so a stray flipped
 *   triangle degrades gracefully rather than breaking.
 */

/* ========================================================================== */
/*  Tunables                                                                   */
/* ========================================================================== */

const CELL = 8;
const INV_CELL = 1 / CELL;

// Grid key packing: ix in [-256,255], iy in [-64,63], iz in [-256,255]
// → covers ±2048 m horizontally and ±512 m vertically, which comfortably wraps
// the 1.2 km arena. Keys stay below 2^31 so V8 keeps the Map keys as SMIs.
const OX = 256, OY = 64, OZ = 256;
const KX = 512, KY = 128, KZ = 512;
const K_Y = KX;
const K_Z = KX * KY;

const SKIN = 0.02;                       // contact offset kept between shapes
const GROUND_COS = Math.cos(50 * Math.PI / 180); // walkable slope threshold
const SLIDE_ITER = 4;
const DEPEN_ITER = 4;
const MAX_SUBSTEPS = 64;
const MAX_DDA_STEPS = 768;
const BIG_PRIM_CELLS = 4096;             // above this a primitive goes in the "always test" list

const GH_CACHE_BITS = 13;
const GH_CACHE_N = 1 << GH_CACHE_BITS;
const GH_CACHE_MASK = GH_CACHE_N - 1;
const GH_QUANT = 1.5;                    // metres per ground-height cache cell

/* ========================================================================== */
/*  Module scratch — never reallocated                                         */
/* ========================================================================== */

const _m4 = new THREE.Matrix4();
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

// scalar scratch for the inner math (avoids property loads on Vector3)
let _hitT = 0, _hitNx = 0, _hitNy = 0, _hitNz = 0, _hitObj = -1;
let _cpx = 0, _cpy = 0, _cpz = 0;        // closest-point output
let _pushX = 0, _pushY = 0, _pushZ = 0, _pushD = 0;

/* ========================================================================== */
/*  Small geometric kernels (all scalar, all allocation-free)                  */
/* ========================================================================== */

/** Closest point on triangle ABC to P. Result in _cpx/_cpy/_cpz. (Ericson) */
function closestPtTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { _cpx = ax; _cpy = ay; _cpz = az; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { _cpx = bx; _cpy = by; _cpz = bz; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    _cpx = ax + abx * v; _cpy = ay + aby * v; _cpz = az + abz * v; return;
  }

  const cpx2 = px - cx, cpy2 = py - cy, cpz2 = pz - cz;
  const d5 = abx * cpx2 + aby * cpy2 + abz * cpz2;
  const d6 = acx * cpx2 + acy * cpy2 + acz * cpz2;
  if (d6 >= 0 && d5 <= d6) { _cpx = cx; _cpy = cy; _cpz = cz; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    _cpx = ax + acx * w; _cpy = ay + acy * w; _cpz = az + acz * w; return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    _cpx = bx + (cx - bx) * w; _cpy = by + (cy - by) * w; _cpz = bz + (cz - bz) * w; return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  _cpx = ax + abx * v + acx * w;
  _cpy = ay + aby * v + acy * w;
  _cpz = az + abz * v + acz * w;
}

/** Closest point on segment AB to P. Result in _cpx/_cpy/_cpz. */
function closestPtSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  _cpx = ax + abx * t; _cpy = ay + aby * t; _cpz = az + abz * t;
}

/** Ray (unit dir) vs sphere. Returns nearest t in [0,maxT] or -1. */
function raySphereT(ox, oy, oz, dx, dy, dz, sx, sy, sz, r, maxT) {
  const mx = ox - sx, my = oy - sy, mz = oz - sz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= maxT ? t : -1;
}

/** Ray (unit dir) vs capsule(A,B,r). Returns nearest t in [0,maxT] or -1. */
function rayCapsuleT(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r, maxT) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const aox = ox - ax, aoy = oy - ay, aoz = oz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  if (ab2 < 1e-12) return raySphereT(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxT);

  const abd = abx * dx + aby * dy + abz * dz;
  const abao = abx * aox + aby * aoy + abz * aoz;

  const A = ab2 - abd * abd;
  const B = ab2 * (aox * dx + aoy * dy + aoz * dz) - abao * abd;
  const C = ab2 * (aox * aox + aoy * aoy + aoz * aoz - r * r) - abao * abao;

  let best = -1;

  if (A > 1e-9) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      // Both roots behind the origin means the ray already passed the cylinder
      // — clamping the near root to 0 there would invent a contact.
      if ((-B + sq) / A >= 0) {
        let t = (-B - sq) / A;
        if (t < 0) t = 0;
        if (t <= maxT) {
          const m = abd * t + abao;
          if (m >= 0 && m <= ab2) best = t;
        }
      }
    }
  } else if (C <= 0 && abao >= 0 && abao <= ab2) {
    return 0; // parallel to the axis and already inside the cylinder body
  }

  // spherical caps — a glancing ray can enter one before reaching the barrel
  const t1 = raySphereT(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxT);
  if (t1 >= 0 && (best < 0 || t1 < best)) best = t1;
  const t2 = raySphereT(ox, oy, oz, dx, dy, dz, bx, by, bz, r, maxT);
  if (t2 >= 0 && (best < 0 || t2 < best)) best = t2;
  return best;
}

/* ========================================================================== */

export class Physics {
  constructor() {
    // --- triangle soup ----------------------------------------------------
    this._triCap = 4096;
    this._triCount = 0;
    this._triPos = new Float32Array(this._triCap * 9);
    this._triNrm = new Float32Array(this._triCap * 3);
    this._triObj = new Int32Array(this._triCap);

    // --- AABB colliders ---------------------------------------------------
    this._boxCap = 512;
    this._boxCount = 0;
    this._boxes = new Float32Array(this._boxCap * 6);
    this._boxObj = new Int32Array(this._boxCap);

    this._objects = [null];   // index 0 == "anonymous static"

    // --- broadphase -------------------------------------------------------
    this._cells = new Map();
    this._bigTris = [];
    this._bigBoxes = [];
    this._dirty = true;

    this._triStamp = new Int32Array(0);
    this._boxStamp = new Int32Array(0);
    this._qid = 0;

    this._cand = new Int32Array(8192);
    this._candB = new Int32Array(1024);
    this._nCand = 0;
    this._nCandB = 0;

    this.worldMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.worldMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    // --- ground-height cache ---------------------------------------------
    this._ghKey = new Int32Array(GH_CACHE_N).fill(-1);
    this._ghVal = new Float32Array(GH_CACHE_N);

    // --- reusable result objects -----------------------------------------
    this._rayOut = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null };
    this._sphOut = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null };
    this._ghOut = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null };
    this._moveOut = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      grounded: false,
      hitWall: false,
      impactSpeed: 0,
      groundY: -Infinity,
    };

    // capsule sweep scratch
    this._sampX = new Float64Array(24);
    this._sampY = new Float64Array(24);
    this._sampZ = new Float64Array(24);

    this.stats = { tris: 0, boxes: 0, cells: 0 };
  }

  /* ---------------------------------------------------------------------- */
  /*  Registration                                                           */
  /* ---------------------------------------------------------------------- */

  _objId(obj) {
    if (!obj) return 0;
    if (obj.__phId === undefined || this._objects[obj.__phId] !== obj) {
      obj.__phId = this._objects.length;
      this._objects.push(obj);
    }
    return obj.__phId;
  }

  _growTris(need) {
    if (this._triCount + need <= this._triCap) return;
    let cap = this._triCap;
    while (cap < this._triCount + need) cap *= 2;
    const p = new Float32Array(cap * 9); p.set(this._triPos);
    const n = new Float32Array(cap * 3); n.set(this._triNrm);
    const o = new Int32Array(cap); o.set(this._triObj);
    this._triPos = p; this._triNrm = n; this._triObj = o;
    this._triCap = cap;
  }

  _growBoxes(need) {
    if (this._boxCount + need <= this._boxCap) return;
    let cap = this._boxCap;
    while (cap < this._boxCount + need) cap *= 2;
    const b = new Float32Array(cap * 6); b.set(this._boxes);
    const o = new Int32Array(cap); o.set(this._boxObj);
    this._boxes = b; this._boxObj = o;
    this._boxCap = cap;
  }

  /**
   * Register a mesh (or a subtree, or an InstancedMesh) as static triangle
   * geometry. World matrices are read as-is, so call after the object is
   * positioned. Reserve this for terrain and walkable surfaces — boxy
   * structures belong in `addBox`.
   * @param {THREE.Object3D} mesh
   * @param {object} [owner] object reported back by queries (defaults to `mesh`)
   */
  addStatic(mesh, owner) {
    if (!mesh) return this;
    mesh.updateWorldMatrix(true, false);
    mesh.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      if (o.userData && o.userData.noCollide) return;
      const id = this._objId(owner || o);
      if (o.isInstancedMesh) {
        const im = o.instanceMatrix;
        for (let i = 0; i < o.count; i++) {
          _m4.fromArray(im.array, i * 16).premultiply(o.matrixWorld);
          this._addGeometry(o.geometry, _m4, id);
        }
      } else {
        this._addGeometry(o.geometry, o.matrixWorld, id);
      }
    });
    this._dirty = true;
    return this;
  }

  _addGeometry(geo, matrix, objId) {
    const pos = geo.attributes.position;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    const triN = (count / 3) | 0;
    this._growTris(triN);

    const e = matrix.elements;
    const m0 = e[0], m1 = e[1], m2 = e[2];
    const m4a = e[4], m5 = e[5], m6 = e[6];
    const m8 = e[8], m9 = e[9], m10 = e[10];
    const m12 = e[12], m13 = e[13], m14 = e[14];

    const P = this._triPos, N = this._triNrm, O = this._triObj;
    let w = this._triCount;

    for (let t = 0; t < triN; t++) {
      const base = t * 3;
      const i0 = idx ? idx.getX(base) : base;
      const i1 = idx ? idx.getX(base + 1) : base + 1;
      const i2 = idx ? idx.getX(base + 2) : base + 2;

      let x = pos.getX(i0), y = pos.getY(i0), z = pos.getZ(i0);
      const ax = m0 * x + m4a * y + m8 * z + m12;
      const ay = m1 * x + m5 * y + m9 * z + m13;
      const az = m2 * x + m6 * y + m10 * z + m14;

      x = pos.getX(i1); y = pos.getY(i1); z = pos.getZ(i1);
      const bx = m0 * x + m4a * y + m8 * z + m12;
      const by = m1 * x + m5 * y + m9 * z + m13;
      const bz = m2 * x + m6 * y + m10 * z + m14;

      x = pos.getX(i2); y = pos.getY(i2); z = pos.getZ(i2);
      const cx = m0 * x + m4a * y + m8 * z + m12;
      const cy = m1 * x + m5 * y + m9 * z + m13;
      const cz = m2 * x + m6 * y + m10 * z + m14;

      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-9) continue; // degenerate
      nx /= nl; ny /= nl; nz /= nl;

      const o9 = w * 9;
      P[o9] = ax; P[o9 + 1] = ay; P[o9 + 2] = az;
      P[o9 + 3] = bx; P[o9 + 4] = by; P[o9 + 5] = bz;
      P[o9 + 6] = cx; P[o9 + 7] = cy; P[o9 + 8] = cz;
      const o3 = w * 3;
      N[o3] = nx; N[o3 + 1] = ny; N[o3 + 2] = nz;
      O[w] = objId;
      w++;

      this._expand(ax, ay, az); this._expand(bx, by, bz); this._expand(cx, cy, cz);
    }
    this._triCount = w;
  }

  _expand(x, y, z) {
    const mn = this.worldMin, mx = this.worldMax;
    if (x < mn.x) mn.x = x; if (y < mn.y) mn.y = y; if (z < mn.z) mn.z = z;
    if (x > mx.x) mx.x = x; if (y > mx.y) mx.y = y; if (z > mx.z) mx.z = z;
  }

  /**
   * Register an axis-aligned box collider. Roughly 20x cheaper to query than
   * the equivalent 12 triangles — use it for every boxy structure.
   * @param {THREE.Box3} box3
   * @param {object} [owner]
   */
  addBox(box3, owner) {
    if (!box3) return this;
    this._growBoxes(1);
    const i = this._boxCount * 6;
    const B = this._boxes;
    B[i] = box3.min.x; B[i + 1] = box3.min.y; B[i + 2] = box3.min.z;
    B[i + 3] = box3.max.x; B[i + 4] = box3.max.y; B[i + 5] = box3.max.z;
    this._boxObj[this._boxCount] = this._objId(owner);
    this._boxCount++;
    this._expand(box3.min.x, box3.min.y, box3.min.z);
    this._expand(box3.max.x, box3.max.y, box3.max.z);
    this._dirty = true;
    return this;
  }

  /** Convenience: register an object's world AABB as a box collider. */
  addBoxFromObject(obj) {
    return this.addBox(new THREE.Box3().setFromObject(obj), obj);
  }

  /** Drop every collider (used by `dispose` and level reloads). */
  clear() {
    this._triCount = 0;
    this._boxCount = 0;
    this._objects.length = 1;
    this._cells.clear();
    this._bigTris.length = 0;
    this._bigBoxes.length = 0;
    this.worldMin.set(Infinity, Infinity, Infinity);
    this.worldMax.set(-Infinity, -Infinity, -Infinity);
    this._ghKey.fill(-1);
    this._dirty = true;
  }

  /* ---------------------------------------------------------------------- */
  /*  Broadphase build                                                       */
  /* ---------------------------------------------------------------------- */

  /** Called lazily by every query; safe to call directly after registration. */
  build() {
    if (!this._dirty) return;
    this._dirty = false;

    const cells = this._cells;
    cells.clear();
    this._bigTris.length = 0;
    this._bigBoxes.length = 0;

    if (this._triStamp.length < this._triCount) this._triStamp = new Int32Array(this._triCount);
    if (this._boxStamp.length < this._boxCount) this._boxStamp = new Int32Array(this._boxCount);
    this._triStamp.fill(0);
    this._boxStamp.fill(0);
    this._qid = 0;

    const P = this._triPos;
    for (let t = 0; t < this._triCount; t++) {
      const o = t * 9;
      const ax = P[o], ay = P[o + 1], az = P[o + 2];
      const bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
      const cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
      const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx);
      const miny = Math.min(ay, by, cy), maxy = Math.max(ay, by, cy);
      const minz = Math.min(az, bz, cz), maxz = Math.max(az, bz, cz);
      this._insert(t, minx, miny, minz, maxx, maxy, maxz, true);
    }

    const B = this._boxes;
    for (let b = 0; b < this._boxCount; b++) {
      const o = b * 6;
      this._insert(b, B[o], B[o + 1], B[o + 2], B[o + 3], B[o + 4], B[o + 5], false);
    }

    for (const rec of cells.values()) {
      if (rec.tl) { rec.t = Int32Array.from(rec.tl); rec.tl = null; }
      if (rec.bl) { rec.b = Int32Array.from(rec.bl); rec.bl = null; }
    }

    this.stats.tris = this._triCount;
    this.stats.boxes = this._boxCount;
    this.stats.cells = cells.size;
    this._ghKey.fill(-1);
  }

  _insert(id, minx, miny, minz, maxx, maxy, maxz, isTri) {
    let ix0 = Math.floor(minx * INV_CELL), ix1 = Math.floor(maxx * INV_CELL);
    let iy0 = Math.floor(miny * INV_CELL), iy1 = Math.floor(maxy * INV_CELL);
    let iz0 = Math.floor(minz * INV_CELL), iz1 = Math.floor(maxz * INV_CELL);
    if (ix1 < -OX || ix0 >= KX - OX || iy1 < -OY || iy0 >= KY - OY || iz1 < -OZ || iz0 >= KZ - OZ) return;
    if (ix0 < -OX) ix0 = -OX; if (ix1 >= KX - OX) ix1 = KX - OX - 1;
    if (iy0 < -OY) iy0 = -OY; if (iy1 >= KY - OY) iy1 = KY - OY - 1;
    if (iz0 < -OZ) iz0 = -OZ; if (iz1 >= KZ - OZ) iz1 = KZ - OZ - 1;

    const span = (ix1 - ix0 + 1) * (iy1 - iy0 + 1) * (iz1 - iz0 + 1);
    if (span > BIG_PRIM_CELLS) {
      (isTri ? this._bigTris : this._bigBoxes).push(id);
      return;
    }

    const cells = this._cells;
    for (let iz = iz0; iz <= iz1; iz++) {
      const kz = (iz + OZ) * K_Z;
      for (let iy = iy0; iy <= iy1; iy++) {
        const ky = kz + (iy + OY) * K_Y;
        for (let ix = ix0; ix <= ix1; ix++) {
          const key = ky + (ix + OX);
          let rec = cells.get(key);
          if (rec === undefined) {
            rec = { t: null, b: null, tl: null, bl: null };
            cells.set(key, rec);
          }
          if (isTri) (rec.tl || (rec.tl = [])).push(id);
          else (rec.bl || (rec.bl = [])).push(id);
        }
      }
    }
  }

  /** Per-frame hook. The static world does not integrate; this only finalises. */
  update() {
    if (this._dirty) this.build();
  }

  _nextQid() {
    if (++this._qid > 2000000000) {
      this._triStamp.fill(0);
      this._boxStamp.fill(0);
      this._qid = 1;
    }
    return this._qid;
  }

  /** Fill _cand/_candB with the primitives overlapping an AABB. */
  _gather(minx, miny, minz, maxx, maxy, maxz) {
    if (this._dirty) this.build();
    const q = this._nextQid();
    const ts = this._triStamp, bs = this._boxStamp;
    let cand = this._cand, candB = this._candB;
    let nt = 0, nb = 0;

    let ix0 = Math.floor(minx * INV_CELL), ix1 = Math.floor(maxx * INV_CELL);
    let iy0 = Math.floor(miny * INV_CELL), iy1 = Math.floor(maxy * INV_CELL);
    let iz0 = Math.floor(minz * INV_CELL), iz1 = Math.floor(maxz * INV_CELL);
    if (ix0 < -OX) ix0 = -OX; if (ix1 >= KX - OX) ix1 = KX - OX - 1;
    if (iy0 < -OY) iy0 = -OY; if (iy1 >= KY - OY) iy1 = KY - OY - 1;
    if (iz0 < -OZ) iz0 = -OZ; if (iz1 >= KZ - OZ) iz1 = KZ - OZ - 1;

    const cells = this._cells;
    for (let iz = iz0; iz <= iz1; iz++) {
      const kz = (iz + OZ) * K_Z;
      for (let iy = iy0; iy <= iy1; iy++) {
        const ky = kz + (iy + OY) * K_Y;
        for (let ix = ix0; ix <= ix1; ix++) {
          const rec = cells.get(ky + (ix + OX));
          if (rec === undefined) continue;
          const tl = rec.t;
          if (tl !== null) {
            for (let i = 0, n = tl.length; i < n; i++) {
              const id = tl[i];
              if (ts[id] === q) continue;
              ts[id] = q;
              if (nt === cand.length) { const g = new Int32Array(nt * 2); g.set(cand); cand = this._cand = g; }
              cand[nt++] = id;
            }
          }
          const bl = rec.b;
          if (bl !== null) {
            for (let i = 0, n = bl.length; i < n; i++) {
              const id = bl[i];
              if (bs[id] === q) continue;
              bs[id] = q;
              if (nb === candB.length) { const g = new Int32Array(nb * 2); g.set(candB); candB = this._candB = g; }
              candB[nb++] = id;
            }
          }
        }
      }
    }

    const bt = this._bigTris;
    for (let i = 0; i < bt.length; i++) {
      const id = bt[i];
      if (ts[id] === q) continue;
      ts[id] = q;
      if (nt === cand.length) { const g = new Int32Array(nt * 2); g.set(cand); cand = this._cand = g; }
      cand[nt++] = id;
    }
    const bb = this._bigBoxes;
    for (let i = 0; i < bb.length; i++) {
      const id = bb[i];
      if (bs[id] === q) continue;
      bs[id] = q;
      if (nb === candB.length) { const g = new Int32Array(nb * 2); g.set(candB); candB = this._candB = g; }
      candB[nb++] = id;
    }

    this._nCand = nt;
    this._nCandB = nb;
  }

  /* ---------------------------------------------------------------------- */
  /*  Raycast                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Nearest hit along a ray. Allocation-free when `out` is supplied; the
   * default `out` is a shared object so consumers must copy anything they keep.
   *
   * NON-FINITE INPUTS RETURN null. That guard is not defensive padding, it
   * closes a real class of bug: the miss test at the bottom is
   * `if (best >= maxDist) return null`, and `NaN >= NaN` is FALSE, so a NaN
   * range used to fall through and report a HIT at a NaN distance. One NaN
   * component anywhere upstream (a `?? ` default that catches undefined but not
   * NaN, a normalise of a zero vector, a collider height that was never set)
   * therefore turned every cast into a phantom occluder. It cost four
   * iterations of chasing the arena scorer when the real symptom was
   * "4 enemies in frustum, 0 visible", and `TargetingSystem` uses this same
   * call for line-of-sight, where it would have dropped the player's lock
   * permanently and looked exactly like scenery.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir      must be normalised
   * @param {number} maxDist         must be finite and > 0, else null
   * @param {object} [out]
   * @returns {{hit:boolean,point:THREE.Vector3,normal:THREE.Vector3,distance:number,object:*}|null}
   */
  raycast(origin, dir, maxDist, out) {
    const res = out || this._rayOut;
    res.hit = false;
    res.object = null;
    res.distance = 0;
    // `!(maxDist > 0)` and not `maxDist <= 0`, because NaN fails BOTH
    // comparisons and only the negated form rejects it.
    if (!(maxDist > 0) || !Number.isFinite(maxDist)) return null;
    if (!origin || !dir) return null;
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) return null;
    if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z)) return null;
    res.distance = maxDist;
    if (this._dirty) this.build();
    if (this._triCount === 0 && this._boxCount === 0) return null;

    const ox = origin.x, oy = origin.y, oz = origin.z;
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-9) return null;
    if (Math.abs(dl - 1) > 1e-4) { dx /= dl; dy /= dl; dz /= dl; }

    // clip to the world AABB so we never DDA through empty space
    let tEnter = this._clipToWorld(ox, oy, oz, dx, dy, dz, maxDist);
    if (tEnter < 0) return null;

    const q = this._nextQid();
    const ts = this._triStamp, bs = this._boxStamp;

    let best = maxDist;
    let bnx = 0, bny = 1, bnz = 0, bobj = 0;

    // --- always-test oversized primitives ---------------------------------
    const bt = this._bigTris;
    for (let i = 0; i < bt.length; i++) {
      const id = bt[i];
      ts[id] = q;
      const t = this._rayTri(ox, oy, oz, dx, dy, dz, id, best);
      if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; bobj = this._triObj[id]; }
    }
    const bb = this._bigBoxes;
    for (let i = 0; i < bb.length; i++) {
      const id = bb[i];
      bs[id] = q;
      const t = this._rayBox(ox, oy, oz, dx, dy, dz, id, best);
      if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; bobj = this._boxObj[id]; }
    }

    // --- DDA --------------------------------------------------------------
    const sx = ox + dx * tEnter, sy = oy + dy * tEnter, sz = oz + dz * tEnter;
    let ix = Math.floor(sx * INV_CELL);
    let iy = Math.floor(sy * INV_CELL);
    let iz = Math.floor(sz * INV_CELL);

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
    const tdX = adx > 1e-9 ? CELL / adx : Infinity;
    const tdY = ady > 1e-9 ? CELL / ady : Infinity;
    const tdZ = adz > 1e-9 ? CELL / adz : Infinity;
    let tmX = adx > 1e-9 ? tEnter + ((dx > 0 ? (ix + 1) * CELL - sx : sx - ix * CELL) / adx) : Infinity;
    let tmY = ady > 1e-9 ? tEnter + ((dy > 0 ? (iy + 1) * CELL - sy : sy - iy * CELL) / ady) : Infinity;
    let tmZ = adz > 1e-9 ? tEnter + ((dz > 0 ? (iz + 1) * CELL - sz : sz - iz * CELL) / adz) : Infinity;

    const cells = this._cells;
    const triObj = this._triObj, boxObj = this._boxObj;

    for (let steps = 0; steps < MAX_DDA_STEPS; steps++) {
      if (ix < -OX || ix >= KX - OX || iy < -OY || iy >= KY - OY || iz < -OZ || iz >= KZ - OZ) break;

      const rec = cells.get((iz + OZ) * K_Z + (iy + OY) * K_Y + (ix + OX));
      if (rec !== undefined) {
        const tl = rec.t;
        if (tl !== null) {
          for (let i = 0, n = tl.length; i < n; i++) {
            const id = tl[i];
            if (ts[id] === q) continue;
            ts[id] = q;
            const t = this._rayTri(ox, oy, oz, dx, dy, dz, id, best);
            if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; bobj = triObj[id]; }
          }
        }
        const bl = rec.b;
        if (bl !== null) {
          for (let i = 0, n = bl.length; i < n; i++) {
            const id = bl[i];
            if (bs[id] === q) continue;
            bs[id] = q;
            const t = this._rayBox(ox, oy, oz, dx, dy, dz, id, best);
            if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; bobj = boxObj[id]; }
          }
        }
      }

      const exit = tmX < tmY ? (tmX < tmZ ? tmX : tmZ) : (tmY < tmZ ? tmY : tmZ);
      if (best <= exit) break;          // nearest hit is inside the cell we just tested
      if (exit > maxDist) break;

      if (tmX < tmY) {
        if (tmX < tmZ) { ix += stepX; tmX += tdX; }
        else { iz += stepZ; tmZ += tdZ; }
      } else if (tmY < tmZ) { iy += stepY; tmY += tdY; }
      else { iz += stepZ; tmZ += tdZ; }
    }

    if (best >= maxDist) return null;

    res.hit = true;
    res.distance = best;
    res.point.set(ox + dx * best, oy + dy * best, oz + dz * best);
    res.normal.set(bnx, bny, bnz);
    res.object = this._objects[bobj] || null;
    return res;
  }

  /** @returns entry parameter along the ray, or -1 if it misses the world. */
  _clipToWorld(ox, oy, oz, dx, dy, dz, maxDist) {
    const mn = this.worldMin, mx = this.worldMax;
    if (!isFinite(mn.x)) return -1;
    let t0 = 0, t1 = maxDist;
    // x
    if (Math.abs(dx) < 1e-9) { if (ox < mn.x - CELL || ox > mx.x + CELL) return -1; }
    else {
      const inv = 1 / dx;
      let a = (mn.x - CELL - ox) * inv, b = (mx.x + CELL - ox) * inv;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    if (Math.abs(dy) < 1e-9) { if (oy < mn.y - CELL || oy > mx.y + CELL) return -1; }
    else {
      const inv = 1 / dy;
      let a = (mn.y - CELL - oy) * inv, b = (mx.y + CELL - oy) * inv;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    if (Math.abs(dz) < 1e-9) { if (oz < mn.z - CELL || oz > mx.z + CELL) return -1; }
    else {
      const inv = 1 / dz;
      let a = (mn.z - CELL - oz) * inv, b = (mx.z + CELL - oz) * inv;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    return t0;
  }

  /** Möller–Trumbore, double sided. Normal written to _hitN*. */
  _rayTri(ox, oy, oz, dx, dy, dz, id, maxT) {
    const P = this._triPos;
    const o = id * 9;
    const ax = P[o], ay = P[o + 1], az = P[o + 2];
    const e1x = P[o + 3] - ax, e1y = P[o + 4] - ay, e1z = P[o + 5] - az;
    const e2x = P[o + 6] - ax, e2y = P[o + 7] - ay, e2z = P[o + 8] - az;

    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) return -1;
    const invDet = 1 / det;

    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return -1;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) return -1;

    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t < 0 || t >= maxT) return -1;

    const n = this._triNrm;
    const o3 = id * 3;
    let nx = n[o3], ny = n[o3 + 1], nz = n[o3 + 2];
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    _hitNx = nx; _hitNy = ny; _hitNz = nz;
    return t;
  }

  /** Slab test. Normal written to _hitN*. */
  _rayBox(ox, oy, oz, dx, dy, dz, id, maxT) {
    const B = this._boxes;
    const o = id * 6;
    let tmin = 0, tmax = maxT;
    let axis = 0, sign = 1;

    // x
    if (Math.abs(dx) < 1e-9) { if (ox < B[o] || ox > B[o + 3]) return -1; }
    else {
      const inv = 1 / dx;
      let a = (B[o] - ox) * inv, b = (B[o + 3] - ox) * inv;
      let s = -1;
      if (a > b) { const t = a; a = b; b = t; s = 1; }
      if (a > tmin) { tmin = a; axis = 0; sign = s; }
      if (b < tmax) tmax = b;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dy) < 1e-9) { if (oy < B[o + 1] || oy > B[o + 4]) return -1; }
    else {
      const inv = 1 / dy;
      let a = (B[o + 1] - oy) * inv, b = (B[o + 4] - oy) * inv;
      let s = -1;
      if (a > b) { const t = a; a = b; b = t; s = 1; }
      if (a > tmin) { tmin = a; axis = 1; sign = s; }
      if (b < tmax) tmax = b;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dz) < 1e-9) { if (oz < B[o + 2] || oz > B[o + 5]) return -1; }
    else {
      const inv = 1 / dz;
      let a = (B[o + 2] - oz) * inv, b = (B[o + 5] - oz) * inv;
      let s = -1;
      if (a > b) { const t = a; a = b; b = t; s = 1; }
      if (a > tmin) { tmin = a; axis = 2; sign = s; }
      if (b < tmax) tmax = b;
      if (tmin > tmax) return -1;
    }
    if (tmin >= maxT) return -1;

    _hitNx = axis === 0 ? sign : 0;
    _hitNy = axis === 1 ? sign : 0;
    _hitNz = axis === 2 ? sign : 0;
    if (tmin <= 0) {
      // origin inside — report the surface we are moving toward
      _hitNx = -dx; _hitNy = -dy; _hitNz = -dz;
      const l = Math.hypot(_hitNx, _hitNy, _hitNz) || 1;
      _hitNx /= l; _hitNy /= l; _hitNz /= l;
      return 0;
    }
    return tmin;
  }

  /* ---------------------------------------------------------------------- */
  /*  Swept sphere                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Swept sphere against the static world.
   * @returns {{hit:boolean,point:THREE.Vector3,normal:THREE.Vector3,distance:number,object:*}|null}
   */
  sphereCast(origin, dir, radius, maxDist, out) {
    const res = out || this._sphOut;
    res.hit = false;
    res.object = null;
    res.distance = maxDist;

    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-9) return null;
    if (Math.abs(dl - 1) > 1e-4) { dx /= dl; dy /= dl; dz /= dl; }

    // Long casts are chunked so the swept AABB never balloons.
    const CHUNK = 48;
    let travelled = 0;
    while (travelled < maxDist) {
      const seg = Math.min(CHUNK, maxDist - travelled);
      const ox = origin.x + dx * travelled;
      const oy = origin.y + dy * travelled;
      const oz = origin.z + dz * travelled;
      const t = this._sweepSphereSegment(ox, oy, oz, dx, dy, dz, radius, seg);
      if (t >= 0) {
        const d = travelled + t;
        res.hit = true;
        res.distance = d;
        res.normal.set(_hitNx, _hitNy, _hitNz);
        res.point.set(
          origin.x + dx * d - _hitNx * radius,
          origin.y + dy * d - _hitNy * radius,
          origin.z + dz * d - _hitNz * radius
        );
        res.object = this._objects[_hitObj] || null;
        return res;
      }
      travelled += seg;
    }
    return null;
  }

  /** Sweep one sphere over a short segment. Result lands in the _hit scratch. */
  _sweepSphereSegment(ox, oy, oz, dx, dy, dz, r, maxT) {
    const ex = ox + dx * maxT, ey = oy + dy * maxT, ez = oz + dz * maxT;
    this._gather(
      Math.min(ox, ex) - r, Math.min(oy, ey) - r, Math.min(oz, ez) - r,
      Math.max(ox, ex) + r, Math.max(oy, ey) + r, Math.max(oz, ez) + r
    );

    let best = maxT;
    let bnx = 0, bny = 1, bnz = 0, bobj = 0, found = false;

    const cand = this._cand, nT = this._nCand;
    for (let i = 0; i < nT; i++) {
      const id = cand[i];
      const t = this._sweepTri(ox, oy, oz, dx, dy, dz, r, id, best);
      if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; bobj = this._triObj[id]; found = true; }
    }
    const candB = this._candB, nB = this._nCandB;
    for (let i = 0; i < nB; i++) {
      const id = candB[i];
      const t = this._sweepBox(ox, oy, oz, dx, dy, dz, r, id, best);
      if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; bobj = this._boxObj[id]; found = true; }
    }

    if (!found) return -1;
    _hitT = best; _hitNx = bnx; _hitNy = bny; _hitNz = bnz; _hitObj = bobj;
    return best;
  }

  /** Swept sphere vs triangle. Returns t in [0,maxT] or -1. */
  _sweepTri(ox, oy, oz, dx, dy, dz, r, id, maxT) {
    const P = this._triPos, N = this._triNrm;
    const o = id * 9, o3 = id * 3;
    const ax = P[o], ay = P[o + 1], az = P[o + 2];
    const bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
    const cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
    const nx = N[o3], ny = N[o3 + 1], nz = N[o3 + 2];

    const d0 = nx * (ox - ax) + ny * (oy - ay) + nz * (oz - az);
    const nd = nx * dx + ny * dy + nz * dz;

    let t;
    if (d0 >= r) {
      if (nd >= -1e-8) return -1;                 // parallel or receding
      t = (d0 - r) / -nd;
      if (t > maxT) return -1;
    } else if (d0 > -r) {
      // touching the plane slab already (front or, after a tunnel, behind it)
      t = 0;
    } else {
      return -1;                                  // fully past the plane
    }

    // orthogonal projection of the sphere centre at time t onto the plane
    const sx0 = ox + dx * t, sy0 = oy + dy * t, sz0 = oz + dz * t;
    const dd = nx * (sx0 - ax) + ny * (sy0 - ay) + nz * (sz0 - az);
    const px = sx0 - nx * dd;
    const py = sy0 - ny * dd;
    const pz = sz0 - nz * dd;

    // inside test using the true winding
    let ux = bx - ax, uy = by - ay, uz = bz - az;
    let wx = px - ax, wy = py - ay, wz = pz - az;
    if ((uy * wz - uz * wy) * nx + (uz * wx - ux * wz) * ny + (ux * wy - uy * wx) * nz >= 0) {
      ux = cx - bx; uy = cy - by; uz = cz - bz;
      wx = px - bx; wy = py - by; wz = pz - bz;
      if ((uy * wz - uz * wy) * nx + (uz * wx - ux * wz) * ny + (ux * wy - uy * wx) * nz >= 0) {
        ux = ax - cx; uy = ay - cy; uz = az - cz;
        wx = px - cx; wy = py - cy; wz = pz - cz;
        if ((uy * wz - uz * wy) * nx + (uz * wx - ux * wz) * ny + (ux * wy - uy * wx) * nz >= 0) {
          _hitNx = nx; _hitNy = ny; _hitNz = nz;
          return t;
        }
      }
    }

    // edge / vertex region: three ray-capsule tests (caps cover the vertices)
    let best = -1;
    let e = rayCapsuleT(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r, maxT);
    if (e >= 0) best = e;
    e = rayCapsuleT(ox, oy, oz, dx, dy, dz, bx, by, bz, cx, cy, cz, r, maxT);
    if (e >= 0 && (best < 0 || e < best)) best = e;
    e = rayCapsuleT(ox, oy, oz, dx, dy, dz, cx, cy, cz, ax, ay, az, r, maxT);
    if (e >= 0 && (best < 0 || e < best)) best = e;
    if (best < 0) return -1;

    const sx = ox + dx * best, sy = oy + dy * best, sz = oz + dz * best;
    closestPtTriangle(sx, sy, sz, ax, ay, az, bx, by, bz, cx, cy, cz);
    let vx = sx - _cpx, vy = sy - _cpy, vz = sz - _cpz;
    const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vl < 1e-6) { _hitNx = nx; _hitNy = ny; _hitNz = nz; }
    else { _hitNx = vx / vl; _hitNy = vy / vl; _hitNz = vz / vl; }
    return best;
  }

  /**
   * Swept sphere vs AABB. Slab test on the box grown by r gives the candidate
   * time; the Voronoi region of the contact then selects face / edge / corner
   * so corners stay properly rounded instead of clipping early.
   */
  _sweepBox(ox, oy, oz, dx, dy, dz, r, id, maxT) {
    const B = this._boxes;
    const o = id * 6;
    const nx0 = B[o] - r, ny0 = B[o + 1] - r, nz0 = B[o + 2] - r;
    const nx1 = B[o + 3] + r, ny1 = B[o + 4] + r, nz1 = B[o + 5] + r;

    let tmin = 0, tmax = maxT;
    let axis = -1, sign = 1;

    if (Math.abs(dx) < 1e-9) { if (ox < nx0 || ox > nx1) return -1; }
    else {
      const inv = 1 / dx;
      let a = (nx0 - ox) * inv, b = (nx1 - ox) * inv, s = -1;
      if (a > b) { const t = a; a = b; b = t; s = 1; }
      if (a > tmin) { tmin = a; axis = 0; sign = s; }
      if (b < tmax) tmax = b;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dy) < 1e-9) { if (oy < ny0 || oy > ny1) return -1; }
    else {
      const inv = 1 / dy;
      let a = (ny0 - oy) * inv, b = (ny1 - oy) * inv, s = -1;
      if (a > b) { const t = a; a = b; b = t; s = 1; }
      if (a > tmin) { tmin = a; axis = 1; sign = s; }
      if (b < tmax) tmax = b;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dz) < 1e-9) { if (oz < nz0 || oz > nz1) return -1; }
    else {
      const inv = 1 / dz;
      let a = (nz0 - oz) * inv, b = (nz1 - oz) * inv, s = -1;
      if (a > b) { const t = a; a = b; b = t; s = 1; }
      if (a > tmin) { tmin = a; axis = 2; sign = s; }
      if (b < tmax) tmax = b;
      if (tmin > tmax) return -1;
    }
    if (tmin >= maxT) return -1;

    const bx0 = B[o], by0 = B[o + 1], bz0 = B[o + 2];
    const bx1 = B[o + 3], by1 = B[o + 4], bz1 = B[o + 5];

    // Classify the contact against the *true* box to pick face / edge / corner.
    const tc = tmin > 0 ? tmin : 0;
    const hx = ox + dx * tc, hy = oy + dy * tc, hz = oz + dz * tc;
    const outX = hx < bx0 ? -1 : hx > bx1 ? 1 : 0;
    const outY = hy < by0 ? -1 : hy > by1 ? 1 : 0;
    const outZ = hz < bz0 ? -1 : hz > bz1 ? 1 : 0;
    const regions = (outX !== 0 ? 1 : 0) + (outY !== 0 ? 1 : 0) + (outZ !== 0 ? 1 : 0);

    if (regions <= 1) {
      if (tmin > 0) {
        _hitNx = axis === 0 ? sign : 0;
        _hitNy = axis === 1 ? sign : 0;
        _hitNz = axis === 2 ? sign : 0;
        return tmin;
      }
      // already overlapping in a face (or interior) region
      const qx = hx < bx0 ? bx0 : hx > bx1 ? bx1 : hx;
      const qy = hy < by0 ? by0 : hy > by1 ? by1 : hy;
      const qz = hz < bz0 ? bz0 : hz > bz1 ? bz1 : hz;
      const vx = hx - qx, vy = hy - qy, vz = hz - qz;
      const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vl > 1e-6) {
        if (vl >= r) return -1;                   // grown-box overlap only, not a real contact
        _hitNx = vx / vl; _hitNy = vy / vl; _hitNz = vz / vl;
      } else {
        // centre inside the solid: escape along the shallowest face
        const ex = Math.min(hx - bx0, bx1 - hx);
        const ey = Math.min(hy - by0, by1 - hy);
        const ez = Math.min(hz - bz0, bz1 - hz);
        if (ex <= ey && ex <= ez) { _hitNx = hx - bx0 < bx1 - hx ? -1 : 1; _hitNy = 0; _hitNz = 0; }
        else if (ey <= ez) { _hitNx = 0; _hitNy = hy - by0 < by1 - hy ? -1 : 1; _hitNz = 0; }
        else { _hitNx = 0; _hitNy = 0; _hitNz = hz - bz0 < bz1 - hz ? -1 : 1; }
      }
      return 0;
    }

    // edge (2) or corner (3): exact ray-vs-capsule / ray-vs-sphere
    let t;
    if (regions === 3) {
      const vx = outX < 0 ? bx0 : bx1;
      const vy = outY < 0 ? by0 : by1;
      const vz = outZ < 0 ? bz0 : bz1;
      t = raySphereT(ox, oy, oz, dx, dy, dz, vx, vy, vz, r, maxT);
      if (t < 0) return -1;
      const cxp = ox + dx * t, cyp = oy + dy * t, czp = oz + dz * t;
      let ux = cxp - vx, uy = cyp - vy, uz = czp - vz;
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      _hitNx = ux / ul; _hitNy = uy / ul; _hitNz = uz / ul;
      return t;
    }

    // edge: the free axis runs along the box
    let ax1, ay1, az1, ax2, ay2, az2;
    if (outX === 0) {
      ay1 = ay2 = outY < 0 ? by0 : by1;
      az1 = az2 = outZ < 0 ? bz0 : bz1;
      ax1 = bx0; ax2 = bx1;
    } else if (outY === 0) {
      ax1 = ax2 = outX < 0 ? bx0 : bx1;
      az1 = az2 = outZ < 0 ? bz0 : bz1;
      ay1 = by0; ay2 = by1;
    } else {
      ax1 = ax2 = outX < 0 ? bx0 : bx1;
      ay1 = ay2 = outY < 0 ? by0 : by1;
      az1 = bz0; az2 = bz1;
    }
    t = rayCapsuleT(ox, oy, oz, dx, dy, dz, ax1, ay1, az1, ax2, ay2, az2, r, maxT);
    if (t < 0) return -1;
    const cxp = ox + dx * t, cyp = oy + dy * t, czp = oz + dz * t;
    closestPtSegment(cxp, cyp, czp, ax1, ay1, az1, ax2, ay2, az2);
    let ux = cxp - _cpx, uy = cyp - _cpy, uz = czp - _cpz;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    _hitNx = ux / ul; _hitNy = uy / ul; _hitNz = uz / ul;
    return t;
  }

  /* ---------------------------------------------------------------------- */
  /*  Capsule movement                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Move a vertical capsule through the static world with collide-and-slide.
   *
   * @param {THREE.Vector3} pos    capsule CENTRE (read, not written)
   * @param {THREE.Vector3} vel    m/s — rewritten with the post-slide velocity
   * @param {number} radius
   * @param {number} height        full tip-to-tip height
   * @param {number} dt
   * @param {object} [out]
   * @returns {{position:THREE.Vector3,grounded:boolean,normal:THREE.Vector3,hitWall:boolean}}
   */
  moveCapsule(pos, vel, radius, height, dt, out) {
    const res = out || this._moveOut;
    if (!res.position) res.position = new THREE.Vector3();
    if (!res.normal) res.normal = new THREE.Vector3();
    if (!res.velocity) res.velocity = new THREE.Vector3();

    if (this._dirty) this.build();

    const r = Math.max(0.05, radius);
    const half = Math.max(0.0001, height * 0.5 - r);

    let px = pos.x, py = pos.y, pz = pos.z;
    let vx = vel.x, vy = vel.y, vz = vel.z;

    let grounded = false, hitWall = false;
    let gnx = 0, gny = 1, gnz = 0;
    let impact = 0;
    let groundY = -Infinity;

    // Substep so a step never advances more than half a radius. This alone
    // makes tunnelling geometrically impossible; the swept test below is the
    // second line of defence for the pathological (dt spike) case.
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    let steps = Math.ceil((speed * dt) / (r * 0.5));
    if (!isFinite(steps) || steps < 1) steps = 1;
    if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
    const sdt = dt / steps;

    // sphere samples covering the capsule segment (spacing <= r, so the swept
    // spheres always overlap and their union encloses the swept capsule)
    const ns = Math.max(2, Math.ceil((2 * half) / r) + 1);
    const nSamp = ns > 24 ? 24 : ns;

    for (let s = 0; s < steps; s++) {
      let rx = vx * sdt, ry = vy * sdt, rz = vz * sdt;

      for (let it = 0; it < SLIDE_ITER; it++) {
        const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (len < 1e-7) break;
        const dx = rx / len, dy = ry / len, dz = rz / len;

        const t = this._capsuleSweep(px, py, pz, dx, dy, dz, r, half, nSamp, len);
        if (t < 0) { px += rx; py += ry; pz += rz; break; }

        const travel = t - SKIN > 0 ? t - SKIN : 0;
        px += dx * travel; py += dy * travel; pz += dz * travel;

        const nx = _hitNx, ny = _hitNy, nz = _hitNz;
        if (ny > GROUND_COS) {
          grounded = true; gnx = nx; gny = ny; gnz = nz;
          const foot = py - half - r;
          if (foot > groundY) groundY = foot;
        } else if (ny < 0.5 && ny > -0.5) hitWall = true;

        // kill the into-surface component of both the remaining motion and the velocity
        const remain = len - travel;
        let ux = dx * remain, uy = dy * remain, uz = dz * remain;
        const dn = ux * nx + uy * ny + uz * nz;
        ux -= nx * dn; uy -= ny * dn; uz -= nz * dn;
        rx = ux; ry = uy; rz = uz;

        const vn = vx * nx + vy * ny + vz * nz;
        if (vn < 0) {
          if (-vn > impact) impact = -vn;
          vx -= nx * vn; vy -= ny * vn; vz -= nz * vn;
        }
      }

      // depenetration — recovers from spawn-inside-geometry and from any
      // residual overlap the swept pass left behind
      for (let k = 0; k < DEPEN_ITER; k++) {
        if (!this._depenetrate(px, py, pz, r, half)) break;
        px += _pushX * _pushD; py += _pushY * _pushD; pz += _pushZ * _pushD;
        if (_pushY > GROUND_COS) {
          grounded = true; gnx = _pushX; gny = _pushY; gnz = _pushZ;
        } else if (_pushY < 0.5 && _pushY > -0.5) hitWall = true;
        const vn = vx * _pushX + vy * _pushY + vz * _pushZ;
        if (vn < 0) { vx -= _pushX * vn; vy -= _pushY * vn; vz -= _pushZ * vn; }
      }
    }

    // Ground probe. Sprinting across a slope, the slide has already produced
    // exactly surface-following velocity, so the next step generates no
    // contact at all — without this probe `grounded` strobes once per terrain
    // quad. Steeper ground always produces a real contact (gravity pushes the
    // capsule into it), so the probe only has to cover the near-parallel case:
    // reject it only when the capsule is unambiguously launching.
    if (!grounded) {
      const vh = Math.sqrt(vx * vx + vz * vz);
      const launching = vy > 0.6 && vy > vh * 0.25;
      if (!launching) {
        const probe = 0.5 + r * 0.15;
        const t = this._capsuleSweep(px, py, pz, 0, -1, 0, r, half, nSamp, probe);
        if (t >= 0 && _hitNy > GROUND_COS) {
          grounded = true; gnx = _hitNx; gny = _hitNy; gnz = _hitNz;
          if (vy <= 0.6) {
            const drop = t - SKIN;
            if (drop > 0) py -= drop;
          }
          groundY = py - half - r;
        }
      }
    }

    // Flatten residual motion into the ground plane: kills both the landing
    // spike and the "ski-jump" a convex crease imparts. A deliberate launch
    // (v·n >= 2 m/s) is left alone.
    if (grounded) {
      const vn = vx * gnx + vy * gny + vz * gnz;
      if (vn < 2) { vx -= gnx * vn; vy -= gny * vn; vz -= gnz * vn; }
    }

    res.position.set(px, py, pz);
    res.velocity.set(vx, vy, vz);
    res.normal.set(gnx, gny, gnz);
    res.grounded = grounded;
    res.hitWall = hitWall;
    res.impactSpeed = impact;
    res.groundY = groundY;

    vel.set(vx, vy, vz);
    return res;
  }

  /**
   * Conservative capsule sweep: the capsule is covered by `nSamp` overlapping
   * spheres (spacing <= radius by construction), each swept along `dir`.
   * Returns the earliest t, with the normal in _hitN*.
   */
  _capsuleSweep(px, py, pz, dx, dy, dz, r, half, nSamp, maxT) {
    const ex = px + dx * maxT, ey = py + dy * maxT, ez = pz + dz * maxT;
    const minx = Math.min(px, ex) - r, maxx = Math.max(px, ex) + r;
    const miny = Math.min(py, ey) - half - r, maxy = Math.max(py, ey) + half + r;
    const minz = Math.min(pz, ez) - r, maxz = Math.max(pz, ez) + r;
    this._gather(minx, miny, minz, maxx, maxy, maxz);

    const cand = this._cand, nT = this._nCand;
    const candB = this._candB, nB = this._nCandB;
    if (nT === 0 && nB === 0) return -1;

    const SX = this._sampX, SY = this._sampY, SZ = this._sampZ;
    const step = nSamp > 1 ? (2 * half) / (nSamp - 1) : 0;
    for (let i = 0; i < nSamp; i++) {
      SX[i] = px;
      SY[i] = py - half + step * i;
      SZ[i] = pz;
    }

    let best = maxT;
    let bnx = 0, bny = 1, bnz = 0, found = false;

    for (let i = 0; i < nT; i++) {
      const id = cand[i];
      for (let s = 0; s < nSamp; s++) {
        const t = this._sweepTri(SX[s], SY[s], SZ[s], dx, dy, dz, r, id, best);
        if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; found = true; }
      }
    }
    for (let i = 0; i < nB; i++) {
      const id = candB[i];
      for (let s = 0; s < nSamp; s++) {
        const t = this._sweepBox(SX[s], SY[s], SZ[s], dx, dy, dz, r, id, best);
        if (t >= 0) { best = t; bnx = _hitNx; bny = _hitNy; bnz = _hitNz; found = true; }
      }
    }

    if (!found) return -1;
    _hitNx = bnx; _hitNy = bny; _hitNz = bnz;
    return best;
  }

  /**
   * One depenetration pass. Writes the deepest push into _pushX/Y/Z/_pushD.
   * @returns true if a push is needed
   */
  _depenetrate(px, py, pz, r, half) {
    const ay = py - half, by = py + half;
    this._gather(px - r, ay - r, pz - r, px + r, by + r, pz + r);

    let deepest = 0;
    let nx = 0, ny = 1, nz = 0;

    const P = this._triPos, N = this._triNrm;
    const cand = this._cand, nT = this._nCand;
    for (let i = 0; i < nT; i++) {
      const id = cand[i];
      const o = id * 9, o3 = id * 3;
      const tax = P[o], tay = P[o + 1], taz = P[o + 2];
      const tbx = P[o + 3], tby = P[o + 4], tbz = P[o + 5];
      const tcx = P[o + 6], tcy = P[o + 7], tcz = P[o + 8];
      const tnx = N[o3], tny = N[o3 + 1], tnz = N[o3 + 2];

      // Reference point: where the capsule axis (extended) meets the triangle
      // plane, clamped to the triangle. Standard capsule-vs-triangle reduction.
      let refY;
      if (Math.abs(tny) > 1e-5) {
        refY = py + ((tnx * (tax - px) + tny * (tay - py) + tnz * (taz - pz)) / tny);
      } else {
        refY = py;
      }
      if (refY < ay) refY = ay; else if (refY > by) refY = by;
      closestPtTriangle(px, refY, pz, tax, tay, taz, tbx, tby, tbz, tcx, tcy, tcz);
      const qx = _cpx, qy = _cpy, qz = _cpz;

      // closest point on the capsule axis to that triangle point
      let cy = qy;
      if (cy < ay) cy = ay; else if (cy > by) cy = by;

      let vx = px - qx, vy = cy - qy, vz = pz - qz;
      const d2 = vx * vx + vy * vy + vz * vz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);

      let depth, ux, uy, uz;
      if (d < 1e-5 || (vx * tnx + vy * tny + vz * tnz) < 0) {
        // degenerate or behind the face — push out along the face normal
        ux = tnx; uy = tny; uz = tnz;
        depth = r + d;
      } else {
        ux = vx / d; uy = vy / d; uz = vz / d;
        depth = r - d;
      }
      if (depth > deepest) { deepest = depth; nx = ux; ny = uy; nz = uz; }
    }

    const B = this._boxes;
    const candB = this._candB, nB = this._nCandB;
    for (let i = 0; i < nB; i++) {
      const id = candB[i];
      const o = id * 6;
      const bx0 = B[o], by0 = B[o + 1], bz0 = B[o + 2];
      const bx1 = B[o + 3], by1 = B[o + 4], bz1 = B[o + 5];
      if (px + r < bx0 || px - r > bx1 || by + r < by0 || ay - r > by1 || pz + r < bz0 || pz - r > bz1) continue;

      // The capsule axis is vertical, so the exact closest pair is analytic:
      // x/z clamp independently, y depends only on the two intervals.
      const qx = px < bx0 ? bx0 : px > bx1 ? bx1 : px;
      const qz = pz < bz0 ? bz0 : pz > bz1 ? bz1 : pz;
      let cy, qy;
      if (by < by0) { cy = by; qy = by0; }
      else if (ay > by1) { cy = ay; qy = by1; }
      else { cy = qy = ay > by0 ? ay : by0; }   // y ranges overlap → zero y distance

      const vx = px - qx, vy = cy - qy, vz = pz - qz;
      const d2 = vx * vx + vy * vy + vz * vz;
      let depth, ux, uy, uz;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        if (d >= r) continue;
        ux = vx / d; uy = vy / d; uz = vz / d;
        depth = r - d;
      } else {
        // axis point inside the box: escape along the shallowest face
        const ex0 = px - bx0, ex1 = bx1 - px;
        const ey0 = cy - by0, ey1 = by1 - cy;
        const ez0 = pz - bz0, ez1 = bz1 - pz;
        const mx = Math.min(ex0, ex1), my = Math.min(ey0, ey1), mz = Math.min(ez0, ez1);
        if (my <= mx && my <= mz) { ux = 0; uy = ey0 < ey1 ? -1 : 1; uz = 0; depth = r + my; }
        else if (mx <= mz) { ux = ex0 < ex1 ? -1 : 1; uy = 0; uz = 0; depth = r + mx; }
        else { ux = 0; uy = 0; uz = ez0 < ez1 ? -1 : 1; depth = r + mz; }
      }
      if (depth > deepest) { deepest = depth; nx = ux; ny = uy; nz = uz; }
    }

    if (deepest <= 1e-5) return false;
    _pushX = nx; _pushY = ny; _pushZ = nz;
    _pushD = deepest + SKIN * 0.5;
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /*  Ground height                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * World Y of the **TOPMOST** static surface in the column at (x,z), cast from
   * above the whole world downward. Cached on a 1.5 m lattice — AI steering and
   * prop placement hammer this and the terrain is static.
   *
   * ### READ THIS BEFORE CALLING IT. IT IS NOT "THE GROUND".
   *
   * Under a deck, catwalk, gantry, bridge or hangar roof this returns the
   * **CEILING ABOVE YOU**, not the floor you are standing on. The name reads
   * like "height of the ground", every caller so far has assumed that, and it
   * has already caused two separate bugs: a mech solving both legs to a full
   * crouch and folding them over its own head (spawn at y 18.6, sampler
   * answered 26.5 — the catwalk above), and enemies placed on roofs. Several
   * review poses stand under a catwalk, so it is not a corner case.
   *
   * Use it only when you genuinely want the top of the column — silhouette
   * tests, "is anything at all here", a fallback for a point outside the
   * collision geometry. For "what am I standing on", call
   * {@link Physics#floorHeight}, which casts DOWN from a height you supply.
   *
   * @returns {number} height, or -Infinity if nothing is below
   */
  groundHeight(x, z) {
    if (this._dirty) this.build();
    const qx = Math.round(x / GH_QUANT);
    const qz = Math.round(z / GH_QUANT);
    const key = ((qx & 0xffff) << 16) | (qz & 0xffff);
    let h = (Math.imul(key, 0x9e3779b1) >>> 19) & GH_CACHE_MASK;
    if (this._ghKey[h] === key) return this._ghVal[h];

    const top = (isFinite(this.worldMax.y) ? this.worldMax.y : 0) + 20;
    const bottom = (isFinite(this.worldMin.y) ? this.worldMin.y : -50) - 20;
    _v3a.set(qx * GH_QUANT, top, qz * GH_QUANT);
    _v3b.set(0, -1, 0);
    const hit = this.raycast(_v3a, _v3b, top - bottom, this._ghOut);
    const val = hit ? hit.point.y : -Infinity;

    this._ghKey[h] = key;
    this._ghVal[h] = val;
    return val;
  }

  /**
   * World Y of the first static surface **BELOW** `fromY` at (x,z) — the floor
   * a body at that height is actually standing on, deck or terrain.
   *
   * This is the companion `groundHeight` should have shipped with. It casts
   * down from where the caller already is instead of from the top of the world,
   * so a mech under a catwalk gets the catwalk's underside skipped and the
   * apron beneath it returned. `Game.js` open-codes exactly this twice for the
   * rig's foot sampler; new callers should use this instead.
   *
   * Not cached: the answer depends on `fromY`, so a 2-D lattice cache would be
   * wrong, and the raycast is already grid-accelerated.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} fromY   start height; the cast begins `lift` above it
   * @param {object} [opts]
   * @param {number} [opts.lift=3]     head-room so a body slightly sunk into the
   *                                   floor still sees it
   * @param {number} [opts.maxDrop=400] how far down to look
   * @param {boolean} [opts.fallback=true] fall back to `groundHeight` on a miss
   * @returns {number} height, or -Infinity when nothing is below and fallback is off
   */
  floorHeight(x, z, fromY, opts) {
    const lift = opts?.lift ?? 3;
    const maxDrop = opts?.maxDrop ?? 400;
    const fallback = opts?.fallback !== false;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(fromY)) return -Infinity;
    _v3a.set(x, fromY + lift, z);
    _v3b.set(0, -1, 0);
    // `_ghOut` is the groundHeight scratch and is safe to share: raycast results
    // are read out immediately here, never held across another cast (see the
    // contract amendment on the shared mutable scratch object).
    const hit = this.raycast(_v3a, _v3b, maxDrop + lift, this._ghOut);
    if (hit && hit.hit) return _v3a.y - hit.distance;
    return fallback ? this.groundHeight(x, z) : -Infinity;
  }

  /** Line-of-sight helper used by AI; true when nothing blocks a → b. */
  lineOfSight(a, b, pad = 0.5) {
    _v3a.subVectors(b, a);
    const d = _v3a.length();
    if (d < 1e-4) return true;
    _v3a.multiplyScalar(1 / d);
    const hit = this.raycast(a, _v3a, d - pad, this._ghOut);
    return hit === null;
  }

  dispose() {
    this.clear();
    this._triPos = new Float32Array(0);
    this._triNrm = new Float32Array(0);
    this._triObj = new Int32Array(0);
    this._boxes = new Float32Array(0);
    this._boxObj = new Int32Array(0);
    this._triStamp = new Int32Array(0);
    this._boxStamp = new Int32Array(0);
  }
}

export default Physics;
