import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, TAU } from '../core/MathUtils.js';

/**
 * Structures — the procedural kit-bash library for Watchpoint Alpha.
 *
 * Everything in here writes into a `GeoBatch`: a transform-stack accumulator
 * that collects (geometry, matrix, tint) triples keyed by material family and
 * welds them into ONE BufferGeometry per family at the end. That is the whole
 * performance strategy — a refinery made of nine thousand struts, rivets, vents
 * and handrails costs the same number of draw calls as nine boxes.
 *
 * Design rules the whole kit obeys:
 *
 * - **World-scale UVs.** Three's primitive UVs are 0..1 per face, so a 60 m wall
 *   and a 2 m crate would get the same texel density and the scene would read as
 *   a toy. Every primitive is re-UV'd by its real size in metres before it is
 *   batched (`applyBoxUV` / `applyTubeUV`).
 * - **Chamfers, not boxes.** Load-bearing masses use `chamferBox`, so every
 *   silhouette edge is a narrow bevel that catches a specular highlight instead
 *   of a razor edge that aliases.
 * - **Per-piece tint.** Batched pieces carry an optional linear vertex tint so a
 *   single merged mesh still has plate-to-plate colour variation.
 * - **Lattice is free detail.** A truss tower is ~250 struts / 3 k triangles and
 *   reads as enormously expensive machinery. Use it everywhere.
 * - **Silhouette greebles.** Nothing leaves this file as a bare volume: ribs,
 *   vents, ladders, conduit, AC units, antennae, placards and railings all break
 *   the outline so the eye never sees a clean rectangle.
 */

/* ========================================================================== */
/*  Scratch — build-time only, but there is no reason to churn the heap        */
/* ========================================================================== */

const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _nm3 = new THREE.Matrix3();
const _col = new THREE.Color();

/* ========================================================================== */
/*  UV projection                                                              */
/* ========================================================================== */

/**
 * Re-project a geometry's UVs as a world-scale box projection.
 * @param {THREE.BufferGeometry} geo
 * @param {number} scale metres covered by one texture tile
 */
export function applyBoxUV(geo, scale) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  let uv = geo.attributes.uv;
  if (!uv) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  const s = 1 / scale;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    if (nx >= ny && nx >= nz) uv.setXY(i, pz * s, py * s);
    else if (ny >= nz) uv.setXY(i, px * s, pz * s);
    else uv.setXY(i, px * s, py * s);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * World-scale UVs for a lathe/cylinder: the barrel is unwrapped by arc length
 * so the texture never stretches with radius; caps fall back to a planar XZ
 * projection.
 */
export function applyTubeUV(geo, radius, height, scale) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const s = 1 / scale;
  const circ = TAU * radius;
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    if (Math.abs(ny) > 0.86) {
      uv.setXY(i, pos.getX(i) * s, pos.getZ(i) * s);
    } else {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      uv.setXY(i, (a / TAU) * circ * s, pos.getY(i) * s);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/* ========================================================================== */
/*  Chamfered box                                                              */
/* ========================================================================== */

/**
 * Axis-aligned box with all twelve edges bevelled. 44 triangles — an order of
 * magnitude cheaper than a subdivided rounded box and visually indistinguishable
 * at the scales we use it. Flat per-facet normals keep the bevel reading as a
 * crisp highlight strip rather than a smeared gradient.
 */
export function chamferBox(w, h, d, chamfer) {
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  const c = Math.max(0.001, Math.min(chamfer, hx * 0.9, hy * 0.9, hz * 0.9));
  const H = [hx, hy, hz];
  const I = [hx - c, hy - c, hz - c];

  const P = [];
  const N = [];
  const idx = [];

  const pt = (x, y, z) => [x, y, z];

  /** Push a convex polygon as a fan, flipping the winding to match `n`. */
  const poly = (pts, n) => {
    const ax = pts[1][0] - pts[0][0], ay = pts[1][1] - pts[0][1], az = pts[1][2] - pts[0][2];
    const bx = pts[2][0] - pts[0][0], by = pts[2][1] - pts[0][1], bz = pts[2][2] - pts[0][2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const flip = (cx * n[0] + cy * n[1] + cz * n[2]) < 0;
    const base = P.length / 3;
    const order = flip ? pts.slice().reverse() : pts;
    for (const p of order) { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); }
    for (let k = 2; k < order.length; k++) idx.push(base, base + k - 1, base + k);
  };

  // --- 6 faces, inset by the chamfer on their two in-plane axes -------------
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, e = (a + 2) % 3;
    for (const s of [-1, 1]) {
      const n = [0, 0, 0]; n[a] = s;
      const mk = (sb, se) => {
        const p = [0, 0, 0];
        p[a] = s * H[a]; p[b] = sb * I[b]; p[e] = se * I[e];
        return pt(p[0], p[1], p[2]);
      };
      poly([mk(-1, -1), mk(1, -1), mk(1, 1), mk(-1, 1)], n);
    }
  }

  // --- 12 edge bevels -------------------------------------------------------
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const e = 3 - a - b;
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const n = [0, 0, 0];
          const inv = Math.SQRT1_2;
          n[a] = sa * inv; n[b] = sb * inv;
          const mk = (onA, se) => {
            const p = [0, 0, 0];
            p[a] = sa * (onA ? H[a] : I[a]);
            p[b] = sb * (onA ? I[b] : H[b]);
            p[e] = se * I[e];
            return pt(p[0], p[1], p[2]);
          };
          poly([mk(true, -1), mk(true, 1), mk(false, 1), mk(false, -1)], n);
        }
      }
    }
  }

  // --- 8 corner triangles ---------------------------------------------------
  const inv3 = 1 / Math.sqrt(3);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const n = [sx * inv3, sy * inv3, sz * inv3];
        poly([
          pt(sx * H[0], sy * I[1], sz * I[2]),
          pt(sx * I[0], sy * H[1], sz * I[2]),
          pt(sx * I[0], sy * I[1], sz * H[2]),
        ], n);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((P.length / 3) * 2), 2));
  geo.setIndex(idx);
  return geo;
}

/* ========================================================================== */
/*  Primitive cache                                                            */
/* ========================================================================== */

const _cache = new Map();

function ck(...parts) {
  let s = '';
  for (let i = 0; i < parts.length; i++) s += (typeof parts[i] === 'number' ? parts[i].toFixed(3) : parts[i]) + '|';
  return s;
}

/** Cached world-UV box (optionally chamfered). Never mutated after creation. */
export function boxGeo(w, h, d, uv = 7, chamfer = 0) {
  const key = ck('b', w, h, d, uv, chamfer);
  let g = _cache.get(key);
  if (!g) {
    g = chamfer > 0.0005 ? chamferBox(w, h, d, chamfer) : new THREE.BoxGeometry(w, h, d);
    applyBoxUV(g, uv);
    _cache.set(key, g);
  }
  return g;
}

/** Cached world-UV cylinder. `r2` lets you taper (stacks, silo cones). */
export function tubeGeo(r, h, seg = 16, uv = 7, r2 = r, open = false) {
  const key = ck('c', r, r2, h, seg, uv, open ? 1 : 0);
  let g = _cache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(r2, r, h, seg, 1, open);
    applyTubeUV(g, Math.max(r, r2), h, uv);
    _cache.set(key, g);
  }
  return g;
}

/** Cached world-UV sphere / dome (`phi` < PI gives a dome). */
export function domeGeo(r, seg = 18, uv = 7, phiLength = Math.PI) {
  const key = ck('d', r, seg, uv, phiLength);
  let g = _cache.get(key);
  if (!g) {
    g = new THREE.SphereGeometry(r, seg, Math.max(3, Math.round(seg * 0.45)), 0, TAU, 0, phiLength);
    applyTubeUV(g, r, r * 2, uv);
    _cache.set(key, g);
  }
  return g;
}

/** Cached world-UV torus — flange rings, tank bands, hatch collars. */
export function ringGeo(r, tube, seg = 20, uv = 7) {
  const key = ck('t', r, tube, seg, uv);
  let g = _cache.get(key);
  if (!g) {
    g = new THREE.TorusGeometry(r, tube, 6, seg);
    g.rotateX(Math.PI * 0.5);
    applyTubeUV(g, r, tube * 2, uv);
    _cache.set(key, g);
  }
  return g;
}

/** Drop every cached source geometry. Call once the level has been welded. */
export function clearGeoCache() {
  for (const g of _cache.values()) g.dispose();
  _cache.clear();
}

/* ========================================================================== */
/*  GeoBatch                                                                   */
/* ========================================================================== */

/**
 * Transform-stack geometry accumulator.
 *
 * Builders write in convenient local space (`push`/`pop` around each assembly)
 * and the batch bakes the composed matrix into every piece as it is added, so
 * the final weld is a single linear pass with no matrix work left to do.
 */
export class GeoBatch {
  /** @param {number} uv default metres-per-tile for primitives created via helpers */
  constructor(uv = 7) {
    this.uv = uv;
    this.groups = new Map();
    this.stack = [new THREE.Matrix4()];
    this.cur = this.stack[0];
    this.tris = 0;
  }

  push(m) {
    const n = new THREE.Matrix4().multiplyMatrices(this.cur, m);
    this.stack.push(n);
    this.cur = n;
    return this;
  }

  /** Push a rigid transform: translate, then yaw, then pitch (radians). */
  pushTRS(x, y, z, ry = 0, rx = 0, rz = 0) {
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _mA.makeRotationFromQuaternion(_q).setPosition(x, y, z);
    return this.push(_mA);
  }

  pop() {
    if (this.stack.length > 1) this.stack.pop();
    this.cur = this.stack[this.stack.length - 1];
    return this;
  }

  /**
   * Resolve a tint the way `add` does, optionally scaled.
   *
   * Tints are authored as hex *multipliers*, not as colours: read the raw bytes
   * (no sRGB decode) and renormalise so the brightest channel is ~1. Otherwise
   * every "warm off-white" tint would silently darken its piece by 40% once
   * colour management decoded it.
   *
   * `scale` exists so a builder can vary plate-to-plate INSIDE one assembly and
   * still compose with whatever tint the caller passed, rather than replacing it.
   *
   * @param {THREE.Color|number} tint
   * @param {number} [scale]
   * @returns {THREE.Color}
   */
  static tint(tint, scale = 1) {
    if (tint === undefined || tint === null) return new THREE.Color(scale, scale, scale);
    if (tint.isColor) return tint.clone().multiplyScalar(scale);
    _col.setHex(tint, THREE.LinearSRGBColorSpace);
    const mx = Math.max(_col.r, _col.g, _col.b) || 1;
    _col.multiplyScalar(((0.80 + 0.32 * mx) / mx) * scale);
    return _col.clone();
  }

  /**
   * @param {string} key      material family
   * @param {THREE.BufferGeometry} geo  cached source, never mutated
   * @param {THREE.Matrix4} [local]
   * @param {THREE.Color|number} [tint] linear multiplier baked as vertex colour
   */
  add(key, geo, local, tint) {
    let g = this.groups.get(key);
    if (!g) { g = { items: [], verts: 0, indices: 0 }; this.groups.set(key, g); }
    const m = new THREE.Matrix4();
    if (local) m.multiplyMatrices(this.cur, local);
    else m.copy(this.cur);
    const c = (tint !== undefined && tint !== null) ? GeoBatch.tint(tint) : null;
    const vc = geo.attributes.position.count;
    const ic = geo.index ? geo.index.count : vc;
    g.items.push({ geo, m, c });
    g.verts += vc;
    g.indices += ic;
    this.tris += ic / 3;
    return this;
  }

  /* --- convenience primitives ------------------------------------------- */

  box(key, w, h, d, x, y, z, ry = 0, o) {
    const geo = boxGeo(w, h, d, (o && o.uv) || this.uv, (o && o.chamfer) || 0);
    _mB.makeRotationY(ry).setPosition(x, y, z);
    return this.add(key, geo, _mB, o && o.tint);
  }

  /** Vertical cylinder centred at (x,y,z). */
  tube(key, r, h, x, y, z, seg = 16, o) {
    const geo = tubeGeo(r, h, seg, (o && o.uv) || this.uv, (o && o.r2 !== undefined) ? o.r2 : r, !!(o && o.open));
    _mB.makeRotationY((o && o.ry) || 0).setPosition(x, y, z);
    return this.add(key, geo, _mB, o && o.tint);
  }

  dome(key, r, x, y, z, seg = 18, o) {
    const geo = domeGeo(r, seg, (o && o.uv) || this.uv, (o && o.phi) || Math.PI);
    _mB.makeRotationY((o && o.ry) || 0).setPosition(x, y, z);
    return this.add(key, geo, _mB, o && o.tint);
  }

  ring(key, r, t, x, y, z, seg = 20, o) {
    const geo = ringGeo(r, t, seg, (o && o.uv) || this.uv);
    _mB.makeRotationY(0).setPosition(x, y, z);
    return this.add(key, geo, _mB, o && o.tint);
  }

  /** A square-section member spanning a→b. The backbone of every lattice. */
  strut(key, ax, ay, az, bx, by, bz, t, o) {
    _dir.set(bx - ax, by - ay, bz - az);
    const len = _dir.length();
    if (len < 1e-4) return this;
    _dir.multiplyScalar(1 / len);
    const geo = boxGeo(t, len, t, (o && o.uv) || this.uv, (o && o.chamfer) || 0);
    _q.setFromUnitVectors(_up, _dir);
    _mB.makeRotationFromQuaternion(_q).setPosition((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    return this.add(key, geo, _mB, o && o.tint);
  }

  /** A round pipe spanning a→b. */
  pipe(key, ax, ay, az, bx, by, bz, r, seg = 8, o) {
    _dir.set(bx - ax, by - ay, bz - az);
    const len = _dir.length();
    if (len < 1e-4) return this;
    _dir.multiplyScalar(1 / len);
    const geo = tubeGeo(r, len, seg, (o && o.uv) || this.uv, r, !!(o && o.open));
    _q.setFromUnitVectors(_up, _dir);
    _mB.makeRotationFromQuaternion(_q).setPosition((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    return this.add(key, geo, _mB, o && o.tint);
  }

  /* --- weld -------------------------------------------------------------- */

  /**
   * Weld every group into one indexed BufferGeometry per material family.
   *
   * Written by hand rather than through `mergeGeometries` because this runs over
   * tens of thousands of pieces on every page load: pre-counting lets it fill
   * the final typed arrays in a single pass with no intermediate clones.
   *
   * @returns {Map<string, THREE.BufferGeometry>}
   */
  build() {
    const out = new Map();
    for (const [key, g] of this.groups) {
      if (!g.items.length) continue;
      const P = new Float32Array(g.verts * 3);
      const N = new Float32Array(g.verts * 3);
      const U = new Float32Array(g.verts * 2);
      // Always emitted: the family materials run `vertexColors`, and a missing
      // colour attribute would leave the generic attribute at (0,0,0) — i.e. a
      // silently black mesh.
      const C = new Uint8Array(g.verts * 3);
      const I = g.verts > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices);

      let vo = 0, io = 0;
      for (let n = 0; n < g.items.length; n++) {
        const it = g.items[n];
        const geo = it.geo;
        const pa = geo.attributes.position.array;
        const na = geo.attributes.normal.array;
        const ua = geo.attributes.uv.array;
        const count = geo.attributes.position.count;
        const e = it.m.elements;
        _nm3.setFromMatrix4(it.m);

        const m0 = e[0], m1 = e[1], m2 = e[2];
        const m4 = e[4], m5 = e[5], m6 = e[6];
        const m8 = e[8], m9 = e[9], m10 = e[10];
        const m12 = e[12], m13 = e[13], m14 = e[14];
        const n0 = _nm3.elements;

        for (let i = 0; i < count; i++) {
          const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
          const o3 = (vo + i) * 3;
          P[o3] = m0 * x + m4 * y + m8 * z + m12;
          P[o3 + 1] = m1 * x + m5 * y + m9 * z + m13;
          P[o3 + 2] = m2 * x + m6 * y + m10 * z + m14;

          const nx = na[i * 3], ny = na[i * 3 + 1], nz = na[i * 3 + 2];
          let tx = n0[0] * nx + n0[3] * ny + n0[6] * nz;
          let ty = n0[1] * nx + n0[4] * ny + n0[7] * nz;
          let tz = n0[2] * nx + n0[5] * ny + n0[8] * nz;
          const l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
          N[o3] = tx / l; N[o3 + 1] = ty / l; N[o3 + 2] = tz / l;

          U[(vo + i) * 2] = ua[i * 2];
          U[(vo + i) * 2 + 1] = ua[i * 2 + 1];

          const c = it.c;
          C[o3] = c ? clamp(c.r, 0, 1) * 255 : 255;
          C[o3 + 1] = c ? clamp(c.g, 0, 1) * 255 : 255;
          C[o3 + 2] = c ? clamp(c.b, 0, 1) * 255 : 255;
        }

        const gi = geo.index;
        if (gi) {
          const ia = gi.array;
          for (let i = 0; i < ia.length; i++) I[io + i] = vo + ia[i];
          io += ia.length;
        } else {
          for (let i = 0; i < count; i++) I[io + i] = vo + i;
          io += count;
        }
        vo += count;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
      // aoMap samples uv1 — same layout as uv, so the packed ORM's AO channel
      // lands in the seams it was authored for instead of being silently ignored.
      geo.setAttribute('uv1', new THREE.BufferAttribute(U, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(C, 3, true));
      geo.setIndex(new THREE.BufferAttribute(I, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      out.set(key, geo);
    }
    return out;
  }

  /** Release the piece list; the welded geometries are independent of it. */
  reset() {
    this.groups.clear();
    this.stack.length = 1;
    this.cur = this.stack[0];
    this.tris = 0;
  }
}

/* ========================================================================== */
/*  Greebles — the small stuff that breaks a silhouette                        */
/* ========================================================================== */

/** Horizontal cladding ribs up a wall face. `axis` is 'x' or 'z' (wall run). */
export function ribs(b, key, w, h, d, y0, y1, spacing, rng, tint) {
  const n = Math.max(1, Math.floor((y1 - y0) / spacing));
  for (let i = 0; i <= n; i++) {
    const y = y0 + (i / n) * (y1 - y0);
    const t = 0.30 + rng() * 0.16;
    b.box(key, w + 0.5, t, d + 0.5, 0, y, 0, 0, { tint });
  }
}

/** Vertical louvre stack — reads as an intake or extract grille. */
export function louvres(b, key, cx, cy, cz, w, h, facing, rng, tint) {
  const count = Math.max(2, Math.round(h / 0.55));
  const step = h / count;
  const c = Math.cos(facing), s = Math.sin(facing);
  b.push(new THREE.Matrix4().makeRotationY(facing).setPosition(cx, cy, cz));
  b.box(key, w, h, 0.24, 0, 0, -0.06, 0, { tint });
  for (let i = 0; i < count; i++) {
    const y = -h * 0.5 + step * (i + 0.5);
    b.box(key, w * 0.92, step * 0.46, 0.30, 0, y, 0.14, 0, { tint });
  }
  b.pop();
  void c; void s; void rng;
}

/** Caged access ladder. */
export function ladder(b, key, x, z, y0, y1, facing, tint) {
  const h = y1 - y0;
  if (h < 2) return;
  b.push(new THREE.Matrix4().makeRotationY(facing).setPosition(x, (y0 + y1) * 0.5, z));
  b.box(key, 0.12, h, 0.12, -0.32, 0, 0, 0, { tint });
  b.box(key, 0.12, h, 0.12, 0.32, 0, 0, 0, { tint });
  const rungs = Math.max(2, Math.floor(h / 0.9));
  for (let i = 0; i < rungs; i++) {
    const y = -h * 0.5 + (i + 0.5) * (h / rungs);
    b.box(key, 0.78, 0.09, 0.09, 0, y, 0, 0, { tint });
  }
  // safety cage hoops above 3 m
  const hoops = Math.max(0, Math.floor((h - 3) / 1.6));
  for (let i = 0; i < hoops; i++) {
    const y = -h * 0.5 + 3 + i * 1.6;
    b.box(key, 1.5, 0.09, 0.09, 0, y, 0.62, 0, { tint });
    b.box(key, 0.09, 0.09, 0.62, -0.72, y, 0.31, 0, { tint });
    b.box(key, 0.09, 0.09, 0.62, 0.72, y, 0.31, 0, { tint });
  }
  b.pop();
}

/**
 * Handrail run from (x0,z0) to (x1,z1) at height y.
 *
 * The rails are built in BAYS rather than as one continuous bar, and each bay
 * is rolled a degree or two about its own axis and set a few millimetres off its
 * neighbours. That is how a real welded handrail is made, and it is also the fix
 * for two measured defects on the 312 m conveyor bridge: one unbroken 8 cm bar
 * presents one unbroken top facet to a 13-degree sun (a 300 m specular line that
 * clipped to white), and at vista range that bar is a sub-pixel edge whose
 * highlight aliases into a crawling rainbow. Both need the facet normals to stop
 * agreeing along the run; neither is reachable from a material.
 */
export function railing(b, key, x0, z0, x1, z1, y, h = 1.15, tint) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.4) return;
  const a = Math.atan2(dx, dz);
  b.push(new THREE.Matrix4().makeRotationY(a).setPosition((x0 + x1) * 0.5, y, (z0 + z1) * 0.5));
  const posts = Math.max(2, Math.round(len / 2.2));
  for (let i = 0; i <= posts; i++) {
    const t = -len * 0.5 + (i / posts) * len;
    b.box(key, 0.10, h, 0.10, 0, h * 0.5, t, 0, { tint });
  }
  const bays = Math.max(1, Math.round(posts / 4));
  for (let i = 0; i < bays; i++) {
    const t0 = -len * 0.5 + (i / bays) * len;
    const t1 = -len * 0.5 + ((i + 1) / bays) * len;
    const bl = (t1 - t0) - 0.09;
    if (bl < 0.12) continue;
    // golden-ratio walk: deterministic, never repeats over the run, no rng
    const j = (i * 0.6180339887 + 0.317) % 1 - 0.5;
    const k = (i * 0.7548776662 + 0.611) % 1 - 0.5;
    const roll = j * 0.075;                  // +/- 2.1 degrees about the rail axis
    const sag = k * 0.030;                   // +/- 15 mm
    const ct = GeoBatch.tint(tint, 0.94 + (k + 0.5) * 0.13);
    b.pushTRS(0, h + sag, (t0 + t1) * 0.5, 0, 0, roll);
    b.box(key, 0.08, 0.08, bl, 0, 0, 0, 0, { tint: ct });
    b.box(key, 0.07, 0.07, bl, 0, -h * 0.45 - sag * 0.4, 0, 0, { tint: ct });
    b.pop();
    b.box(key, 0.05, 0.22, bl, 0, 0.11, (t0 + t1) * 0.5, 0, { tint: ct });  // toe plate
  }
  b.pop();
}

/** Rooftop plant: an HVAC / scrubber unit with a fan cowl and ducting. */
export function acUnit(b, key, x, y, z, s, ry, rng, tint) {
  b.push(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z));
  b.box(key, 2.6 * s, 1.5 * s, 1.9 * s, 0, 0.75 * s, 0, 0, { chamfer: 0.12 * s, tint });
  b.box(key, 2.2 * s, 0.18 * s, 1.5 * s, 0, 1.56 * s, 0, 0, { tint });
  b.tube(key, 0.62 * s, 0.34 * s, -0.5 * s, 1.72 * s, 0, 12, { tint });
  b.tube(key, 0.58 * s, 0.10 * s, -0.5 * s, 1.90 * s, 0, 12, { tint });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + rng() * 0.4;
    b.box(key, 0.5 * s, 0.05 * s, 0.16 * s, -0.5 * s + Math.cos(a) * 0.3 * s, 1.94 * s, Math.sin(a) * 0.3 * s, a, { tint });
  }
  b.box(key, 0.9 * s, 1.1 * s, 0.2 * s, 0.8 * s, 0.7 * s, 0.98 * s, 0, { tint });
  b.pipe(key, 1.1 * s, 0.2 * s, -0.9 * s, 1.1 * s, 1.3 * s, -0.9 * s, 0.13 * s, 8, { tint });
  b.pop();
}

/** Whip / dish antenna with a tripod base. */
export function antenna(b, key, x, y, z, h, rng, tint) {
  b.push(new THREE.Matrix4().makeTranslation(x, y, z));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    b.strut(key, 0, 0, 0, Math.cos(a) * 0.8, 1.1, Math.sin(a) * 0.8, 0.13, { tint });
  }
  b.tube(key, 0.16, h, 0, h * 0.5 + 1.0, 0, 8, { r2: 0.07, tint });
  const arms = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < arms; i++) {
    const yy = 1.0 + h * (0.35 + (i / arms) * 0.55);
    const a = rng() * TAU;
    b.box(key, 1.5, 0.07, 0.07, Math.cos(a) * 0.75, yy, Math.sin(a) * 0.75, a, { tint });
  }
  b.pop();
}

/** Surface-run conduit: a bundle of small pipes with clamps. */
export function conduit(b, key, x0, y0, z0, x1, y1, z1, n, r, tint) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz, y1 - y0);
  const a = Math.atan2(dx, dz);
  const px = Math.cos(a), pz = -Math.sin(a);
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) * 0.5) * r * 2.5;
    b.pipe(key, x0 + px * o, y0, z0 + pz * o, x1 + px * o, y1, z1 + pz * o, r, 7, { tint });
  }
  const clamps = Math.max(1, Math.round(len / 6));
  for (let i = 0; i <= clamps; i++) {
    const t = i / clamps;
    b.box(key, n * r * 2.7, 0.22, 0.30, lerp(x0, x1, t), lerp(y0, y1, t), lerp(z0, z1, t), a, { tint });
  }
}

/** A stencilled placard / warning plate — pure silhouette + albedo interest. */
export function placard(b, key, x, y, z, w, h, facing, tint) {
  b.push(new THREE.Matrix4().makeRotationY(facing).setPosition(x, y, z));
  b.box(key, w, h, 0.10, 0, 0, 0, 0, { tint });
  b.box(key, w * 1.08, 0.07, 0.14, 0, h * 0.5, 0, 0, { tint });
  b.box(key, w * 1.08, 0.07, 0.14, 0, -h * 0.5, 0, 0, { tint });
  b.pop();
}

/** Flight of stairs climbing +Y along +Z. */
export function stairs(b, key, x, y0, z, y1, run, w, facing, tint) {
  const rise = y1 - y0;
  if (rise < 0.5) return;
  const steps = Math.max(3, Math.round(rise / 0.62));
  b.push(new THREE.Matrix4().makeRotationY(facing).setPosition(x, y0, z));
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    b.box(key, w, 0.14, run / steps + 0.08, 0, rise * t, run * (t - 0.5), 0, { tint });
  }
  const ang = Math.atan2(rise, run);
  for (const s of [-1, 1]) {
    b.push(new THREE.Matrix4().makeRotationX(-ang).setPosition(s * (w * 0.5 + 0.08), rise * 0.5, 0));
    b.box(key, 0.12, 0.46, Math.hypot(rise, run), 0, 0, 0, 0, { tint });
    b.box(key, 0.09, 0.09, Math.hypot(rise, run), 0, 1.05, 0, 0, { tint });
    b.pop();
  }
  b.pop();
}

/* ========================================================================== */
/*  Lattice assemblies                                                         */
/* ========================================================================== */

/**
 * Tapered square lattice tower along +Y. Four chords, ring braces every bay and
 * X-bracing on each face — the single highest detail-per-triangle shape there is.
 *
 * @returns {number[]} y-heights of every bay node, for hanging platforms off
 */
export function trussTower(b, key, o) {
  const {
    height = 100, base = 10, top = 6, bays = 14,
    chord = 0.62, brace = 0.30, rng = Math.random, tint,
    kbrace = true, platformAt = null,
  } = o;

  const nodes = [];
  const rad = (t) => lerp(base, top, t) * 0.5;
  const corner = (i, t) => {
    const r = rad(t);
    const a = i * Math.PI * 0.5 + Math.PI * 0.25;
    return [Math.cos(a) * r * Math.SQRT2, Math.sin(a) * r * Math.SQRT2];
  };

  for (let bi = 0; bi < bays; bi++) {
    const t0 = bi / bays, t1 = (bi + 1) / bays;
    const y0 = t0 * height, y1 = t1 * height;
    nodes.push(y0);
    for (let i = 0; i < 4; i++) {
      const c0 = corner(i, t0), c1 = corner(i, t1);
      const n0 = corner((i + 1) % 4, t0), n1 = corner((i + 1) % 4, t1);
      // chord
      b.strut(key, c0[0], y0, c0[1], c1[0], y1, c1[1], chord, { tint });
      // horizontal ring at the top of the bay
      b.strut(key, c1[0], y1, c1[1], n1[0], y1, n1[1], brace * 1.15, { tint });
      // face bracing — alternate the diagonal so it reads as a real K/X truss
      if (kbrace) {
        const mx = (c1[0] + n1[0]) * 0.5, mz = (c1[1] + n1[1]) * 0.5;
        b.strut(key, c0[0], y0, c0[1], mx, y1, mz, brace, { tint });
        b.strut(key, n0[0], y0, n0[1], mx, y1, mz, brace, { tint });
      } else {
        b.strut(key, c0[0], y0, c0[1], n1[0], y1, n1[1], brace, { tint });
      }
      if (bi === 0) b.strut(key, c0[0], y0, c0[1], n0[0], y0, n0[1], brace * 1.15, { tint });
    }
    // occasional interior cross tie so the tower is not hollow-looking
    if (bi % 3 === 2) {
      const a = corner(0, t1), c = corner(2, t1);
      const d = corner(1, t1), e = corner(3, t1);
      b.strut(key, a[0], y1, a[1], c[0], y1, c[1], brace * 0.8, { tint });
      b.strut(key, d[0], y1, d[1], e[0], y1, e[1], brace * 0.8, { tint });
    }
    if (rng() < 0.22) {
      const a = corner(Math.floor(rng() * 4), t1);
      b.box(key, 1.0, 0.9, 0.7, a[0] * 0.9, y1 + 0.5, a[1] * 0.9, rng() * TAU, { tint });
    }
  }
  nodes.push(height);

  if (platformAt) {
    for (const t of platformAt) {
      const y = t * height;
      const r = rad(t) * 1.35;
      b.box(key, r * 2, 0.24, r * 2, 0, y, 0, 0, { tint });
      railing(b, key, -r, -r, r, -r, y + 0.12, 1.1, tint);
      railing(b, key, r, -r, r, r, y + 0.12, 1.1, tint);
      railing(b, key, r, r, -r, r, y + 0.12, 1.1, tint);
      railing(b, key, -r, r, -r, -r, y + 0.12, 1.1, tint);
    }
  }
  return nodes;
}

/**
 * Horizontal lattice truss spanning +X, `length` metres, `depth` tall.
 * Used for the cantilever arm, pipe bridges and conveyor galleries.
 */
export function trussBeam(b, key, o) {
  const {
    length = 60, depth = 6, width = 5, bays = 10,
    chord = 0.45, brace = 0.24, tint, deck = false, deckKey = key,
  } = o;
  const hw = width * 0.5;
  const step = length / bays;
  for (const s of [-1, 1]) {
    for (let i = 0; i < bays; i++) {
      const x0 = -length * 0.5 + i * step, x1 = x0 + step;
      b.strut(key, x0, 0, s * hw, x1, 0, s * hw, chord, { tint });
      b.strut(key, x0, depth, s * hw, x1, depth, s * hw, chord, { tint });
      b.strut(key, x1, 0, s * hw, x1, depth, s * hw, brace, { tint });
      b.strut(key, x0, i % 2 ? depth : 0, s * hw, x1, i % 2 ? 0 : depth, s * hw, brace, { tint });
    }
    b.strut(key, -length * 0.5, 0, s * hw, -length * 0.5, depth, s * hw, brace, { tint });
  }
  for (let i = 0; i <= bays; i++) {
    const x = -length * 0.5 + i * step;
    b.strut(key, x, depth, -hw, x, depth, hw, brace, { tint });
    b.strut(key, x, 0, -hw, x, 0, hw, brace, { tint });
    if (i < bays) {
      const x1 = x + step;
      b.strut(key, x, 0, -hw, x1, 0, hw, brace * 0.85, { tint });
      b.strut(key, x, depth, hw, x1, depth, -hw, brace * 0.85, { tint });
    }
  }
  if (deck) {
    b.box(deckKey, length, 0.20, width * 0.86, 0, depth + 0.1, 0, 0, { tint });
  }
}

/* ========================================================================== */
/*  Building assemblies                                                        */
/* ========================================================================== */

/**
 * Barrel-vault hangar: buttressed side walls, a ribbed arched roof, a full-height
 * blast door with a hazard-striped surround, and a cluttered roof line.
 */
export function hangar(b, mats, o) {
  const {
    w = 46, d = 68, wallH = 16, roofR = 24, rng = Math.random,
    body = mats.body, trim = mats.trim, dark = mats.dark, glow = mats.glow,
  } = o;
  const hw = w * 0.5, hd = d * 0.5;
  const tint = o.tint;

  // side walls with pilasters
  for (const s of [-1, 1]) {
    b.box(body, 1.6, wallH, d, s * (hw - 0.8), wallH * 0.5, 0, 0, { chamfer: 0.35, tint });
    const n = Math.max(3, Math.round(d / 8));
    for (let i = 0; i <= n; i++) {
      const z = -hd + (i / n) * d;
      b.box(body, 2.6, wallH * 0.94, 1.5, s * (hw - 1.9), wallH * 0.47, z, 0, { chamfer: 0.2, tint });
    }
  }
  // rear wall
  b.box(body, w, wallH, 1.6, 0, wallH * 0.5, -hd + 0.8, 0, { chamfer: 0.35, tint });

  // arched roof: chorded panels + external ribs
  const seg = 13;
  const rise = Math.min(roofR, hw * 0.98);
  for (let i = 0; i < seg; i++) {
    const a0 = Math.PI * (i / seg), a1 = Math.PI * ((i + 1) / seg);
    const x0 = -Math.cos(a0) * hw, y0 = Math.sin(a0) * rise;
    const x1 = -Math.cos(a1) * hw, y1 = Math.sin(a1) * rise;
    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    _mA.makeRotationZ(ang).setPosition(cx, wallH + cy, 0);
    b.add(body, boxGeo(len + 0.3, 0.55, d, b.uv, 0.12), _mA, tint);
  }
  const ribN = Math.max(4, Math.round(d / 6.5));
  for (let r = 0; r <= ribN; r++) {
    const z = -hd + (r / ribN) * d;
    for (let i = 0; i < seg; i++) {
      const a0 = Math.PI * (i / seg), a1 = Math.PI * ((i + 1) / seg);
      b.strut(dark, -Math.cos(a0) * (hw + 0.35), wallH + Math.sin(a0) * (rise + 0.35), z,
        -Math.cos(a1) * (hw + 0.35), wallH + Math.sin(a1) * (rise + 0.35), z, 0.34, { tint });
    }
  }
  // ridge walkway + vent stacks
  b.box(dark, 1.9, 0.18, d * 0.9, 0, wallH + rise + 0.5, 0, 0, { tint });
  railing(b, dark, -0.95, -d * 0.45, -0.95, d * 0.45, wallH + rise + 0.6, 1.05, tint);
  railing(b, dark, 0.95, -d * 0.45, 0.95, d * 0.45, wallH + rise + 0.6, 1.05, tint);
  const vents = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < vents; i++) {
    const z = -hd * 0.7 + (i / Math.max(1, vents - 1)) * d * 0.7;
    b.tube(dark, 1.05, 2.4, 2.6, wallH + rise * 0.82, z, 12, { tint });
    b.tube(dark, 1.25, 0.3, 2.6, wallH + rise * 0.82 + 1.3, z, 12, { tint });
    b.tube(dark, 1.05, 2.4, -2.6, wallH + rise * 0.82, z, 12, { tint });
    b.tube(dark, 1.25, 0.3, -2.6, wallH + rise * 0.82 + 1.3, z, 12, { tint });
  }

  // blast door
  const doorW = w * 0.62, doorH = wallH * 0.86;
  b.box(trim, doorW + 3.0, doorH + 2.4, 1.9, 0, (doorH + 2.4) * 0.5, hd - 0.4, 0, { chamfer: 0.3, tint });
  b.box(dark, doorW, doorH, 1.0, 0, doorH * 0.5, hd + 0.5, 0, { tint });
  const leaves = 6;
  for (let i = 0; i < leaves; i++) {
    b.box(dark, doorW / leaves - 0.18, doorH - 0.5, 0.42,
      -doorW * 0.5 + (i + 0.5) * (doorW / leaves), doorH * 0.5, hd + 1.05, 0, { tint });
  }
  b.box(body, w, wallH - doorH - 0.4, 1.6, 0, doorH + (wallH - doorH) * 0.5 + 0.2, hd - 0.8, 0, { tint });
  // door head beacons
  b.box(glow, 0.7, 0.4, 0.4, -doorW * 0.5 - 1.0, doorH + 1.6, hd + 0.6, 0, { tint: 0xff2a12 });
  b.box(glow, 0.7, 0.4, 0.4, doorW * 0.5 + 1.0, doorH + 1.6, hd + 0.6, 0, { tint: 0xff2a12 });

  // side detail
  for (const s of [-1, 1]) {
    louvres(b, dark, s * (hw + 0.5), wallH * 0.62, -hd * 0.45, 5.0, 4.2, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, rng, tint);
    louvres(b, dark, s * (hw + 0.5), wallH * 0.62, hd * 0.25, 3.4, 3.0, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, rng, tint);
    ladder(b, dark, s * (hw + 0.9), -hd * 0.72, 0.4, wallH + rise * 0.5, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, tint);
    conduit(b, dark, s * (hw + 0.7), wallH * 0.9, -hd + 3, s * (hw + 0.7), wallH * 0.9, hd - 3, 3, 0.20, tint);
    b.box(glow, 0.5, 0.9, 0.25, s * (hw + 0.9), wallH * 0.34, hd - 6, 0, { tint: 0xffb14a });
    placard(b, trim, s * (hw + 1.0), wallH * 0.45, hd * 0.6, 2.6, 1.5, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, tint);
  }
  // plinth
  b.box(mats.concrete, w + 2.4, 1.5, d + 2.4, 0, 0.75, 0, 0, { chamfer: 0.3, tint });

  return { w, d, h: wallH + rise, roofY: wallH + rise };
}

/**
 * Boxy industrial block: recessed bays, cladding ribs, a parapet, roof plant and
 * a stair penthouse. The workhorse mid-scale volume.
 */
export function blockhouse(b, mats, o) {
  const {
    w = 30, d = 24, h = 26, rng = Math.random, tint,
    body = mats.body, trim = mats.trim, dark = mats.dark, glow = mats.glow,
  } = o;
  const hw = w * 0.5, hd = d * 0.5;

  b.box(mats.concrete, w + 2.0, 1.4, d + 2.0, 0, 0.7, 0, 0, { chamfer: 0.3, tint });
  b.box(body, w, h, d, 0, h * 0.5 + 1.0, 0, 0, { chamfer: 0.55, tint });

  // recessed bays on the long faces
  const bays = Math.max(3, Math.round(w / 6));
  for (let i = 0; i < bays; i++) {
    const x = -hw + (i + 0.5) * (w / bays);
    for (const s of [-1, 1]) {
      b.box(dark, w / bays - 1.6, h * 0.68, 0.7, x, h * 0.5 + 1.0, s * (hd - 0.15), 0, { tint });
      if (rng() < 0.45) {
        b.box(glow, w / bays - 2.6, 0.34, 0.30, x, h * 0.5 + 1.0 + h * 0.18, s * (hd + 0.25), 0, { tint: 0xffc25e });
      }
    }
  }
  // corner pilasters + horizontal cladding ribs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(body, 2.2, h + 0.6, 2.2, sx * (hw - 0.6), h * 0.5 + 1.0, sz * (hd - 0.6), 0, { chamfer: 0.25, tint });
    }
  }
  const rn = Math.max(2, Math.round(h / 7));
  for (let i = 1; i <= rn; i++) {
    const y = 1.0 + (i / (rn + 1)) * h;
    b.box(trim, w + 0.6, 0.42, d + 0.6, 0, y, 0, 0, { tint });
  }

  // parapet + roof
  const roofY = h + 1.0;
  b.box(trim, w + 1.2, 1.5, d + 1.2, 0, roofY + 0.75, 0, 0, { chamfer: 0.25, tint });
  b.box(dark, w - 1.2, 0.3, d - 1.2, 0, roofY + 0.15, 0, 0, { tint });

  // roof plant
  const units = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < units; i++) {
    acUnit(b, dark, (rng() - 0.5) * (w - 8), roofY + 0.3, (rng() - 0.5) * (d - 8), 0.9 + rng() * 0.7, rng() * TAU, rng, tint);
  }
  // stair penthouse
  b.box(body, 5.0, 4.2, 4.4, hw * 0.42, roofY + 2.1, -hd * 0.45, 0, { chamfer: 0.3, tint });
  b.box(trim, 5.6, 0.5, 5.0, hw * 0.42, roofY + 4.35, -hd * 0.45, 0, { tint });
  antenna(b, dark, -hw * 0.55, roofY + 0.3, hd * 0.5, 7 + rng() * 6, rng, tint);
  for (let i = 0; i < 3; i++) {
    b.tube(dark, 0.5, 2.0 + rng() * 1.5, (rng() - 0.5) * (w - 6), roofY + 1.2, (rng() - 0.5) * (d - 6), 10, { tint });
  }
  // corner warning lamps
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(glow, 0.42, 0.42, 0.42, sx * (hw - 0.5), roofY + 1.7, sz * (hd - 0.5), 0, { tint: 0xff2410 });
    }
  }

  ladder(b, dark, hw + 0.55, hd * 0.55, 1.4, roofY + 1.3, Math.PI * 0.5, tint);
  conduit(b, dark, -hw - 0.5, h * 0.72, -hd + 2, -hw - 0.5, h * 0.72, hd - 2, 4, 0.18, tint);
  placard(b, trim, 0, h * 0.34, hd + 0.6, 3.4, 1.8, 0, tint);

  return { w, d, h: roofY + 1.5, roofY };
}

/**
 * Vertical containment tank: banded shell, DOMED (not hemispherical) roof with
 * radial plate seams, spiral access stair, roof railing and process pipework.
 *
 * THE ROOF WAS A HEMISPHERE AND THAT IS WHY THESE READ AS "UNTEXTURED GREY
 * BLOBS". A `phi: PI/2` dome of the shell's own radius puts a smooth ball of
 * height `r` on top of a cylinder of height `h`; on the tank farm's 12-16 m
 * radii that is a third to a half of the whole silhouette given over to one
 * unbroken surface with exactly one shading gradient across it, and no map can
 * survive that — the plate texture is there, it is just a 30 m sphere's worth
 * of low-contrast mottle under a 90% veil.
 *
 * A real welded storage tank has a SHALLOW dished roof: the roof plate is
 * pressed to a radius of roughly 1.5x the tank diameter's half-width, so the
 * rise is about a third of the shell radius rather than equal to it, and it
 * meets the shell at a hard compression ring. That single change moves the
 * dome from "half the shape" to "a lid", and everything the eye needs then
 * lands on the two horizontal lines at the eaves and on the radial plate seams
 * that run from the crown to the rim.
 *
 * The seams are CHORDED for the reason `sphereTank` records: the batch cannot
 * build a curved member, and a straight one across the whole 40 degree arc sags
 * into the shell and disappears. Three chords hold the sag under 1% of the roof
 * radius so a bead stands proud the whole way down the lit side.
 */
export function tank(b, mats, o) {
  const {
    r = 11, h = 24, rng = Math.random, tint,
    body = mats.body, trim = mats.trim, dark = mats.dark, glow = mats.glow, seg = 22,
  } = o;

  b.box(mats.concrete, r * 2.4, 1.2, r * 2.4, 0, 0.6, 0, 0, { chamfer: 0.25, tint });
  b.tube(body, r, h, 0, h * 0.5 + 1.0, 0, seg, { tint });

  // --- dished roof --------------------------------------------------------
  const eaves = h + 1.0;             // shell / roof joint
  const KR = 1.55;                   // roof radius as a multiple of shell radius
  const RR = r * KR;
  const PHI = Math.asin(1 / KR);     // polar half-angle that lands the rim on r
  const cosP = Math.cos(PHI);
  const roofC = eaves - RR * cosP;   // centre of the roof plate's sphere
  const crown = roofC + RR;          // apex, = eaves + 0.366 r
  b.dome(body, RR, 0, roofC, 0, seg, { phi: PHI, tint });

  // Radial plate seams, crown to rim. The one place a lid this shallow can
  // still put line work, and they converge on the crown so they read as a roof
  // rather than as stripes.
  const seams = Math.max(8, Math.round(seg * 0.55));
  const beadT = Math.max(0.15, r * 0.017);
  for (let i = 0; i < seams; i++) {
    const a = (i / seams) * TAU + 0.13;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ct = GeoBatch.tint(tint, 0.92 + ((i * 0.6180339887 + 0.31) % 1) * 0.14);
    for (let s = 0; s < 3; s++) {
      const t0 = PHI * (0.14 + 0.86 * (s / 3)), t1 = PHI * (0.14 + 0.86 * ((s + 1) / 3));
      const k = 1.008;
      b.strut(trim,
        ca * RR * k * Math.sin(t0), roofC + RR * k * Math.cos(t0), sa * RR * k * Math.sin(t0),
        ca * RR * k * Math.sin(t1), roofC + RR * k * Math.cos(t1), sa * RR * k * Math.sin(t1),
        beadT, { tint: ct });
    }
  }

  // weld bands
  const bands = Math.max(2, Math.round(h / 5));
  for (let i = 1; i < bands; i++) {
    b.tube(trim, r + 0.14, 0.34, 0, 1.0 + (i / bands) * h, 0, seg, { tint });
  }
  b.tube(trim, r + 0.28, 0.9, 0, 1.5, 0, seg, { tint });
  // Wind girder and compression ring: the two hard horizontals that say "the
  // lid stops here". Without them the roof and the shell are one silhouette.
  b.tube(trim, r + 0.62, 0.42, 0, eaves - 2.4, 0, seg, { tint });
  b.tube(dark, r + 0.34, 0.75, 0, eaves - 0.25, 0, seg, { tint });

  // spiral stair
  const turns = 1.15;
  const stepsN = Math.round(h * 1.9);
  for (let i = 0; i < stepsN; i++) {
    const t = i / stepsN;
    const a = t * TAU * turns;
    const y = 1.2 + t * (h - 1.0);
    b.box(dark, 1.5, 0.12, 0.62, Math.cos(a) * (r + 0.95), y, Math.sin(a) * (r + 0.95), -a, { tint });
    if (i % 3 === 0) {
      b.box(dark, 0.09, 1.05, 0.09, Math.cos(a) * (r + 1.62), y + 0.55, Math.sin(a) * (r + 1.62), -a, { tint });
    }
  }
  // Perimeter handrail, ON the eaves where a real one stands. It used to float
  // at a fixed 0.6 m above the joint regardless of how the roof met it.
  const rr = r + 0.55;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
    b.box(dark, 0.09, 1.1, 0.09, Math.cos(a0) * rr, eaves + 0.6, Math.sin(a0) * rr, 0, { tint });
    b.strut(dark, Math.cos(a0) * rr, eaves + 1.1, Math.sin(a0) * rr, Math.cos(a1) * rr, eaves + 1.1, Math.sin(a1) * rr, 0.08, { tint });
  }

  // Crown works: manway collar, a railed crown platform and a vent stack. On a
  // shallow lid the crown is the one part still facing the sky, so it is where
  // the frame will look — it cannot be an empty plate.
  const cpr = r * 0.26;
  b.tube(dark, cpr, 0.22, 0, crown + 0.10, 0, 14, { tint });
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * TAU, a1 = ((i + 1) / 6) * TAU;
    railing(b, dark, Math.cos(a0) * cpr, Math.sin(a0) * cpr,
      Math.cos(a1) * cpr, Math.sin(a1) * cpr, crown + 0.21, 1.0, tint);
  }
  b.tube(dark, 0.62, 2.6, 0, crown + 1.4, 0, 10, { tint });
  b.tube(trim, 0.78, 0.30, 0, crown + 2.6, 0, 10, { tint });

  // Roof nozzles and a float-gauge box, scattered on the lid at mid-radius.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.9;
    const rad = r * (0.44 + 0.16 * ((i * 0.6180339887) % 1));
    const t = Math.asin(clamp(rad / RR, -1, 1));
    const sy = roofC + RR * Math.cos(t);
    const nx = Math.cos(a) * rad, nz = Math.sin(a) * rad;
    b.tube(dark, 0.34, 1.5, nx, sy + 0.55, nz, 8, { tint });
    if (i === 1) b.box(dark, 1.5, 1.3, 1.1, nx, sy + 0.75, nz, a, { chamfer: 0.12, tint });
  }

  // Stair head: the spiral has to arrive somewhere, and a gooseneck landing off
  // the eaves is a silhouette break exactly where the two masses meet.
  {
    const a = TAU * 1.15 % TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    b.box(dark, 2.2, 0.16, 1.5, ca * (r + 0.9), eaves + 0.08, sa * (r + 0.9), -a, { tint });
    railing(b, dark, ca * (r + 1.7) - sa * 0.8, sa * (r + 1.7) + ca * 0.8,
      ca * (r + 1.7) + sa * 0.8, sa * (r + 1.7) - ca * 0.8, eaves + 0.16, 1.05, tint);
  }

  // process pipework off one side
  const pa = rng() * TAU;
  const px = Math.cos(pa), pz = Math.sin(pa);
  b.pipe(dark, px * r, h * 0.72, pz * r, px * (r + 7), h * 0.72, pz * (r + 7), 0.55, 10, { tint });
  b.pipe(dark, px * (r + 7), h * 0.72, pz * (r + 7), px * (r + 7), 2.2, pz * (r + 7), 0.55, 10, { tint });
  b.tube(dark, 0.75, 1.2, px * (r + 7), h * 0.72, pz * (r + 7), 10, { tint });
  b.box(dark, 1.8, 2.4, 1.8, px * (r + 7), 3.0, pz * (r + 7), pa, { tint });
  // A shell downcomer: one vertical line on an otherwise all-horizontal shell.
  {
    const da = pa + 2.1, dx = Math.cos(da) * (r + 0.55), dz = Math.sin(da) * (r + 0.55);
    b.pipe(dark, dx, eaves - 0.6, dz, dx, 2.4, dz, 0.34, 8, { tint });
    for (let i = 0; i < 3; i++) {
      b.box(trim, 0.8, 0.34, 0.5, dx, 4.0 + i * (h - 6) / 2.6, dz, da, { tint });
    }
  }

  b.box(glow, 0.44, 0.44, 0.44, 0, crown + 2.9, 0, 0, { tint: 0xff2410 });
  placard(b, trim, px * (r + 0.35), h * 0.42, pz * (r + 0.35), 3.0, 1.7, pa + Math.PI * 0.5, tint);

  return { r, h: crown + 3.1, roofY: eaves };
}

/**
 * Sphere tank on a splayed leg frame — LPG/coolant storage.
 *
 * THE SHELL IS NOT ONE SURFACE. A pressure sphere is pressed from flat plate
 * into petals and welded: a bottom head, two courses of petals, a top head,
 * with a girth weld at the equator and at roughly +/-35 degrees, and a meridian
 * weld every petal. Those beads are what the real thing shows from 200 m, and
 * on a shape with no silhouette detail whatsoever they are the only surface cue
 * there is — the reason this read as an untextured grey blob is that a smooth
 * sphere under a smooth environment map has exactly one gradient on it and
 * nothing anywhere to interrupt the specular.
 *
 * The meridian beads are CHORDED in 18-degree arcs rather than run as one
 * member per petal: a straight box across a 70-degree arc sags into the shell
 * by 0.16 of the radius and disappears, and a curved one is not something the
 * batch can build. Four chords hold the sag to about 1% of r, so the bead
 * stands proud everywhere along its length and catches the key the whole way
 * round the lit side.
 */
export function sphereTank(b, mats, o) {
  const {
    r = 9, legH = 7, tint, body = mats.body, dark = mats.dark, trim = mats.trim,
    glow = mats.glow, rng = Math.random,
  } = o;
  const cy = legH + r * 0.82;
  // 28 columns, not 20. At 18 m across and the ranges these sit at in the
  // gameplay frame, a 20-gon shows its facets on the limb, and REVIEW fails a
  // visible polygon silhouette on anything meant to be curved outright.
  b.dome(body, r, 0, cy, 0, 28, { phi: Math.PI, tint });

  // --- girth welds --------------------------------------------------------
  const GIRTH = [-0.61, 0.0, 0.61];
  for (const la of GIRTH) {
    const rl = r * Math.cos(la);
    b.tube(trim, rl + 0.06, la === 0 ? 0.44 : 0.26, 0, cy + r * Math.sin(la), 0, 28,
      { tint: GeoBatch.tint(tint, la === 0 ? 1.0 : 0.93) });
  }

  // --- meridian welds -----------------------------------------------------
  const MER = 10, ARCS = 4, LA0 = -0.61, LA1 = 0.61;
  for (let i = 0; i < MER; i++) {
    const a = (i / MER) * TAU + 0.21;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ct = GeoBatch.tint(tint, 0.90 + ((i * 0.6180339887 + 0.24) % 1) * 0.17);
    for (let s = 0; s < ARCS; s++) {
      const l0 = lerp(LA0, LA1, s / ARCS), l1 = lerp(LA0, LA1, (s + 1) / ARCS);
      const k = 1.012;
      b.strut(trim,
        ca * r * k * Math.cos(l0), cy + r * k * Math.sin(l0), sa * r * k * Math.cos(l0),
        ca * r * k * Math.cos(l1), cy + r * k * Math.sin(l1), sa * r * k * Math.cos(l1),
        0.20, { tint: ct });
    }
  }

  // --- support frame ------------------------------------------------------
  const legs = 8;
  for (let i = 0; i < legs; i++) {
    const a = (i / legs) * TAU;
    const x = Math.cos(a) * r * 0.72, z = Math.sin(a) * r * 0.72;
    b.strut(dark, x, 0, z, x * 1.05, cy - r * 0.55, z * 1.05, 0.55, { tint });
    const a2 = ((i + 1) / legs) * TAU;
    b.strut(dark, x, legH * 0.55, z, Math.cos(a2) * r * 0.74, legH * 0.2, Math.sin(a2) * r * 0.74, 0.24, { tint });
  }

  // --- crown works --------------------------------------------------------
  // A manway collar, a relief stack and a railed platform. The platform is the
  // piece that matters at range: it puts a broken dark line across the pale cap
  // that would otherwise be the brightest, emptiest part of the whole shape.
  const py = cy + r * 0.93;
  const pr = r * 0.30;
  b.tube(dark, pr, 0.22, 0, py, 0, 14, { tint });
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * TAU, a1 = ((i + 1) / 6) * TAU;
    railing(b, dark, Math.cos(a0) * pr, Math.sin(a0) * pr,
      Math.cos(a1) * pr, Math.sin(a1) * pr, py + 0.11, 1.05, tint);
  }
  b.tube(dark, 0.7, 2.0, 0, cy + r * 0.95, 0, 10, { tint });
  b.tube(trim, 0.34, 3.1, r * 0.16, cy + r * 1.02, -r * 0.13, 8, { tint });
  b.box(glow, 0.4, 0.4, 0.4, 0, cy + r + 0.5, 0, 0, { tint: 0xff2410 });

  // --- bottom valve cluster ----------------------------------------------
  // Every one of these has a nest of pipework hanging under it, and a shape
  // with nothing under the pole reads as a ball resting on sticks.
  b.tube(dark, r * 0.16, 1.1, 0, cy - r * 0.99, 0, 12, { tint });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4;
    const x = Math.cos(a) * r * 0.22, z = Math.sin(a) * r * 0.22;
    b.pipe(body, x, cy - r * 1.02, z, x * 2.6, cy - r * 1.02 - 1.9 - i * 0.5, z * 2.6, 0.26, 8, { tint });
    if (rng() < 0.7) b.box(trim, 0.5, 0.5, 0.5, x * 2.2, cy - r * 1.02 - 1.4, z * 2.2, a, { tint });
  }

  ladder(b, dark, r * 0.74, 0, 0.3, cy - r * 0.5, 0, tint);
  return { r, h: cy + r + 0.8 };
}

/**
 * Tapered cooling / flare stack with reinforcement bands, an access ladder cage,
 * a crown platform and aircraft-warning lamps.
 */
export function coolingStack(b, mats, o) {
  const {
    rBase = 7, rTop = 4.6, h = 110, tint,
    body = mats.body, trim = mats.trim, dark = mats.dark, glow = mats.glow, seg = 20,
  } = o;
  b.box(mats.concrete, rBase * 2.9, 2.0, rBase * 2.9, 0, 1.0, 0, 0, { chamfer: 0.4, tint });
  b.tube(body, rBase, h, 0, h * 0.5 + 1.4, 0, seg, { r2: rTop, tint });
  const bands = Math.max(4, Math.round(h / 12));
  for (let i = 1; i <= bands; i++) {
    const t = i / (bands + 1);
    const r = lerp(rBase, rTop, t) + 0.2;
    b.tube(trim, r, 0.5, 0, 1.4 + t * h, 0, seg, { tint });
  }
  // crown
  b.tube(dark, rTop + 1.5, 0.9, 0, h + 1.6, 0, seg, { tint });
  b.tube(body, rTop * 0.92, 2.4, 0, h + 2.6, 0, seg, { r2: rTop * 0.86, tint, open: true });
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
    const rr = rTop + 1.9;
    b.box(dark, 0.10, 1.15, 0.10, Math.cos(a0) * rr, h + 2.6, Math.sin(a0) * rr, 0, { tint });
    b.strut(dark, Math.cos(a0) * rr, h + 3.1, Math.sin(a0) * rr, Math.cos(a1) * rr, h + 3.1, Math.sin(a1) * rr, 0.09, { tint });
  }
  // ladder all the way up, in 20 m runs with rest platforms
  const runs = Math.max(1, Math.round(h / 20));
  for (let i = 0; i < runs; i++) {
    const y0 = 1.4 + (i / runs) * h, y1 = 1.4 + ((i + 1) / runs) * h;
    const t = (i + 0.5) / runs;
    const r = lerp(rBase, rTop, t);
    ladder(b, dark, r + 0.55, 0, y0, y1, -Math.PI * 0.5, tint);
    if (i > 0) {
      b.box(dark, 2.6, 0.16, 2.2, r + 1.2, y0, 0, 0, { tint });
      railing(b, dark, r + 0.1, -1.1, r + 2.4, -1.1, y0 + 0.1, 1.0, tint);
      railing(b, dark, r + 0.1, 1.1, r + 2.4, 1.1, y0 + 0.1, 1.0, tint);
    }
  }
  // aircraft warning lamps, three around the crown and one mid-height
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    b.box(glow, 0.55, 0.55, 0.55, Math.cos(a) * (rTop + 1.6), h + 3.9, Math.sin(a) * (rTop + 1.6), 0, { tint: 0xff1d0c });
  }
  b.box(glow, 0.5, 0.5, 0.5, rBase * 0.2 + rTop, h * 0.55, 0, 0, { tint: 0xff1d0c });
  return { h: h + 4.4, rTop };
}

/** Grain / ore silo bank: N tall cylinders under a shared head house. */
export function siloBank(b, mats, o) {
  const {
    n = 5, r = 7.5, h = 52, gap = 0.6, tint,
    body = mats.body, trim = mats.trim, dark = mats.dark, glow = mats.glow, rng = Math.random,
  } = o;
  const pitch = r * 2 + gap;
  const span = pitch * (n - 1);
  b.box(mats.concrete, span + r * 2.8, 2.0, r * 2.8, 0, 1.0, 0, 0, { chamfer: 0.35, tint });
  for (let i = 0; i < n; i++) {
    const x = -span * 0.5 + i * pitch;
    b.tube(body, r, h, x, h * 0.5 + 1.6, 0, 18, { tint });
    b.tube(trim, r + 0.16, 0.5, x, 3.0, 0, 18, { tint });
    b.tube(trim, r + 0.16, 0.5, x, h + 1.1, 0, 18, { tint });
    b.tube(body, r, 3.4, x, h + 3.3, 0, 18, { r2: r * 0.55, tint });
    // hopper cone at the bottom
    b.tube(dark, r * 0.9, 3.0, x, 3.1, 0, 16, { r2: r * 0.3, tint });
  }
  // head house + conveyor gallery on top
  const hy = h + 5.0;
  b.box(body, span + r * 1.4, 9.0, r * 1.9, 0, hy + 4.5, 0, 0, { chamfer: 0.4, tint });
  b.box(trim, span + r * 1.8, 0.7, r * 2.3, 0, hy + 9.2, 0, 0, { tint });
  const ribN = Math.max(3, Math.round(n * 1.6));
  for (let i = 0; i <= ribN; i++) {
    const x = -(span + r * 1.4) * 0.5 + (i / ribN) * (span + r * 1.4);
    b.box(dark, 0.5, 9.0, r * 2.05, x, hy + 4.5, 0, 0, { tint });
  }
  for (let i = 0; i < 3; i++) {
    b.tube(dark, 0.8, 3.0, -span * 0.3 + i * span * 0.3, hy + 10.5, 0, 10, { tint });
  }
  b.box(glow, 0.5, 0.5, 0.5, -(span * 0.5), hy + 9.9, 0, 0, { tint: 0xff1d0c });
  b.box(glow, 0.5, 0.5, 0.5, (span * 0.5), hy + 9.9, 0, 0, { tint: 0xff1d0c });
  antenna(b, dark, span * 0.5 - 2, hy + 9.4, 0, 9, rng, tint);
  // external stair tower
  const sx = -span * 0.5 - r - 2.2;
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5 + Math.PI * 0.25;
    b.strut(dark, sx + Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2, sx + Math.cos(a) * 2.2, hy + 2, Math.sin(a) * 2.2, 0.4, { tint });
  }
  const flights = Math.round(hy / 4);
  for (let i = 0; i < flights; i++) {
    b.box(dark, 4.6, 0.14, 4.6, sx, (i + 1) * (hy / flights), 0, 0, { tint });
    if (i % 2 === 0) {
      b.strut(dark, sx - 2.2, i * (hy / flights), -2.2, sx + 2.2, (i + 1) * (hy / flights), 2.2, 0.18, { tint });
    } else {
      b.strut(dark, sx + 2.2, i * (hy / flights), -2.2, sx - 2.2, (i + 1) * (hy / flights), 2.2, 0.18, { tint });
    }
  }
  b.pipe(dark, sx, hy + 2, 0, -span * 0.5, hy + 2, 0, 0.4, 8, { tint });
  return { w: span + r * 2.8, d: r * 2.8, h: hy + 10, roofY: hy + 9.2, span, r };
}

/** Segmented blast wall with buttresses and hazard trim. */
export function blastWall(b, mats, o) {
  const {
    length = 60, h = 7, t = 1.6, segs = 6, tint,
    body = mats.concrete, trim = mats.trim, dark = mats.dark, rng = Math.random,
  } = o;
  const sl = length / segs;
  for (let i = 0; i < segs; i++) {
    const x = -length * 0.5 + (i + 0.5) * sl;
    const hh = h * (0.86 + rng() * 0.24);
    b.box(body, sl - 0.35, hh, t, x, hh * 0.5, 0, 0, { chamfer: 0.22, tint });
    b.box(trim, sl - 0.15, 0.42, t + 0.35, x, hh + 0.2, 0, 0, { tint });
    b.box(body, 1.4, hh * 0.85, t * 2.6, x - sl * 0.5 + 0.2, hh * 0.42, 0, 0, { chamfer: 0.18, tint });
    if (rng() < 0.35) b.box(dark, 0.7, 0.7, t + 0.5, x + sl * 0.2, hh * 0.7, 0, 0, { tint });
  }
  b.box(body, length, 0.9, t + 1.4, 0, 0.45, 0, 0, { chamfer: 0.2, tint });
  return { length, h };
}

/** Substation: lattice pylons, transformer cans, bushings and cable catenaries. */
export function transformerYard(b, mats, o) {
  const {
    w = 44, d = 34, rng = Math.random, tint,
    body = mats.body, dark = mats.dark, trim = mats.trim, glow = mats.glow,
  } = o;
  b.box(mats.concrete, w, 0.8, d, 0, 0.4, 0, 0, { chamfer: 0.2, tint });

  const pylons = 4;
  const heads = [];
  for (let i = 0; i < pylons; i++) {
    const x = -w * 0.38 + (i / (pylons - 1)) * w * 0.76;
    b.pushTRS(x, 0.8, -d * 0.3);
    trussTower(b, dark, { height: 22 + (i % 2) * 5, base: 4.4, top: 2.4, bays: 7, chord: 0.3, brace: 0.15, rng, tint });
    b.pop();
    const hy = 0.8 + 22 + (i % 2) * 5;
    heads.push([x, hy, -d * 0.3]);
    b.box(dark, 8.0, 0.4, 0.4, x, hy + 0.6, -d * 0.3, 0, { tint });
    for (const s of [-1, 0, 1]) {
      b.tube(mats.glass || dark, 0.30, 2.0, x + s * 3.2, hy + 1.7, -d * 0.3, 8, { tint });
      for (let k = 0; k < 5; k++) {
        b.tube(mats.glass || dark, 0.55, 0.14, x + s * 3.2, hy + 0.95 + k * 0.4, -d * 0.3, 8, { tint });
      }
    }
  }
  // catenary cables between pylon heads
  for (let i = 0; i < heads.length - 1; i++) {
    const a = heads[i], c = heads[i + 1];
    for (const s of [-3.2, 0, 3.2]) {
      const segsN = 6;
      for (let k = 0; k < segsN; k++) {
        const t0 = k / segsN, t1 = (k + 1) / segsN;
        const sag = (t) => -Math.sin(t * Math.PI) * 1.6;
        b.pipe(dark,
          lerp(a[0], c[0], t0) + s, a[1] + 2.8 + sag(t0), a[2],
          lerp(a[0], c[0], t1) + s, a[1] + 2.8 + sag(t1), a[2], 0.075, 5, { tint });
      }
    }
  }
  // transformer cans
  const cans = 4;
  for (let i = 0; i < cans; i++) {
    const x = -w * 0.34 + (i / (cans - 1)) * w * 0.68;
    const z = d * 0.22;
    b.box(body, 5.4, 4.4, 4.0, x, 3.0, z, 0, { chamfer: 0.3, tint });
    // radiator fins
    for (let k = 0; k < 8; k++) {
      b.box(dark, 0.16, 3.4, 1.5, x - 2.9, 3.0, z - 1.7 + k * 0.48, 0, { tint });
      b.box(dark, 0.16, 3.4, 1.5, x + 2.9, 3.0, z - 1.7 + k * 0.48, 0, { tint });
    }
    b.tube(dark, 0.85, 1.2, x, 5.6, z, 12, { tint });
    for (const s of [-1.4, 0, 1.4]) {
      b.tube(mats.glass || dark, 0.24, 1.8, x + s, 6.2, z - 1.2, 8, { tint });
    }
    b.box(glow, 0.34, 0.34, 0.34, x + 2.5, 5.4, z + 2.1, 0, { tint: 0x39ff9a });
    if (rng() < 0.5) placard(b, trim, x, 2.4, z + 2.2, 2.0, 1.2, 0, tint);
  }
  // perimeter fence
  const fh = 3.0;
  for (const sz of [-1, 1]) {
    const n = Math.round(w / 4);
    for (let i = 0; i <= n; i++) {
      b.box(dark, 0.16, fh, 0.16, -w * 0.5 + (i / n) * w, fh * 0.5 + 0.8, sz * d * 0.5, 0, { tint });
    }
    b.box(dark, w, 0.10, 0.10, 0, fh + 0.8, sz * d * 0.5, 0, { tint });
    b.box(dark, w, 0.10, 0.10, 0, fh * 0.5 + 0.8, sz * d * 0.5, 0, { tint });
  }
  return { w, d, h: 30 };
}

/**
 * Elevated pipe bridge / conveyor gallery between two points, with trestle bents,
 * a walkable deck and a bundle of process pipes.
 *
 * @returns {{deck: Array<number[]>}} deck quads in local space for a collision proxy
 */
export function pipeBridge(b, mats, o) {
  const {
    length = 90, y = 22, width = 6, bents = 5, tint,
    dark = mats.dark, body = mats.body, trim = mats.trim, glow = mats.glow, groundY = 0,
  } = o;

  b.pushTRS(0, y, 0);
  trussBeam(b, dark, { length, depth: 3.4, width, bays: Math.max(6, Math.round(length / 9)), chord: 0.38, brace: 0.2, tint });

  // --- deck ---------------------------------------------------------------
  // NOT one box. A 312 m slab of deck plate is a single plane presenting a
  // single normal to a low sun for its whole length, which is exactly the
  // geometry that produced the vista's continuous blown-white specular band.
  // Real decking is laid in plates that are bolted down one at a time, sit
  // proud of each other, and rust at different rates. Each plate here gets its
  // own roll about the run axis, its own height and its own tint, so the sun
  // finds a different angle every few metres and the highlight can only ever be
  // a broken chain of glints. Peak tilt is 1.4 degrees, which lifts a plate edge
  // by 6 cm — the walkable collision quad sits at deck + 9 cm, so nothing pokes
  // through the surface the player actually stands on.
  const dw = width * 0.78;
  const plates = Math.max(2, Math.round(length / 7.5));
  const pl = length / plates;
  for (let i = 0; i < plates; i++) {
    // golden-ratio walk keeps this deterministic and non-repeating without rng
    const j = (i * 0.6180339887 + 0.211) % 1 - 0.5;
    const k = (i * 0.7548776662 + 0.733) % 1 - 0.5;
    b.pushTRS(-length * 0.5 + (i + 0.5) * pl, 3.5 + k * 0.055, 0, 0, j * 0.049, 0);
    b.box(dark, pl - 0.05, 0.22, dw, 0, 0, 0, 0, { tint: GeoBatch.tint(tint, 0.92 + (k + 0.5) * 0.16) });
    b.pop();
  }
  // grating treads across the run: 8 cm of relief every ~2.5 m, so even a plate
  // caught square-on to the sun is broken into short segments
  const treads = Math.max(2, Math.round(length / 2.5));
  for (let i = 0; i < treads; i++) {
    const t = (i * 0.6180339887 + 0.44) % 1 - 0.5;
    b.box(dark, 0.16, 0.14, dw + 0.20, -length * 0.5 + (i + 0.5) * (length / treads), 3.62, 0, 0,
      { tint: GeoBatch.tint(tint, 0.84 + (t + 0.5) * 0.16) });
  }
  railing(b, dark, -length * 0.5, -width * 0.39, length * 0.5, -width * 0.39, 3.61, 1.15, tint);
  railing(b, dark, -length * 0.5, width * 0.39, length * 0.5, width * 0.39, 3.61, 1.15, tint);
  // pipe bundle slung under the truss
  const pipes = 4;
  for (let i = 0; i < pipes; i++) {
    const z = -width * 0.3 + (i / (pipes - 1)) * width * 0.6;
    const r = 0.38 + (i % 2) * 0.22;
    b.pipe(body, -length * 0.5, -0.9 - (i % 2) * 0.5, z, length * 0.5, -0.9 - (i % 2) * 0.5, z, r, 9, { tint });
  }
  const cl = Math.round(length / 10);
  for (let i = 0; i <= cl; i++) {
    b.box(trim, 0.3, 1.6, width * 0.8, -length * 0.5 + (i / cl) * length, -1.1, 0, 0, { tint });
  }
  // strobes along the run
  for (let i = 0; i <= Math.round(length / 22); i++) {
    b.box(glow, 0.34, 0.34, 0.34, -length * 0.5 + i * 22, 4.9, width * 0.42, 0, { tint: 0xffb14a });
  }
  b.pop();

  // trestle bents
  for (let i = 0; i < bents; i++) {
    const x = -length * 0.5 + (i / (bents - 1)) * length;
    const legY = y - groundY;
    for (const s of [-1, 1]) {
      b.strut(dark, x, groundY, s * (width * 0.5 + 2.2), x, y, s * width * 0.5, 0.55, { tint });
    }
    const ties = Math.max(2, Math.round(legY / 6));
    for (let k = 1; k < ties; k++) {
      const t = k / ties;
      const yy = groundY + t * legY;
      const zz = lerp(width * 0.5 + 2.2, width * 0.5, t);
      b.strut(dark, x, yy, -zz, x, yy, zz, 0.24, { tint });
      const t2 = (k + 1) / ties;
      const yy2 = groundY + t2 * legY;
      const zz2 = lerp(width * 0.5 + 2.2, width * 0.5, t2);
      b.strut(dark, x, yy, -zz, x, yy2, zz2, 0.18, { tint });
      b.strut(dark, x, yy, zz, x, yy2, -zz2, 0.18, { tint });
    }
    b.box(mats.concrete, 3.6, 1.2, width + 6.4, x, groundY + 0.6, 0, 0, { chamfer: 0.2, tint });
  }
  return { length, y, width, deckY: y + 3.6 };
}

/**
 * Free-standing catwalk deck between two world points. Returns the deck corner
 * quad so the caller can register a walkable triangle collider for it.
 */
export function catwalk(b, key, x0, y0, z0, x1, y1, z1, width, tint, glowKey) {
  const dx = x1 - x0, dz = z1 - z0, dy = y1 - y0;
  const len = Math.hypot(dx, dz, dy);
  if (len < 1) return null;
  const a = Math.atan2(dx, dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  b.push(new THREE.Matrix4().makeRotationY(a).setPosition((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5));
  b.push(new THREE.Matrix4().makeRotationX(-pitch));
  // laid in plates, for the same reason the bridge deck is (see `pipeBridge`)
  const cp = Math.max(1, Math.round(len / 6.5));
  for (let i = 0; i < cp; i++) {
    const j = (i * 0.6180339887 + 0.529) % 1 - 0.5;
    const k = (i * 0.7548776662 + 0.084) % 1 - 0.5;
    b.pushTRS(0, k * 0.045, -len * 0.5 + (i + 0.5) * (len / cp), 0, 0, j * 0.028);
    b.box(key, width, 0.22, len / cp - 0.05, 0, 0, 0, 0, { tint: GeoBatch.tint(tint, 0.90 + (k + 0.5) * 0.20) });
    b.pop();
  }
  const n = Math.max(2, Math.round(len / 3.2));
  for (let i = 0; i <= n; i++) {
    const z = -len * 0.5 + (i / n) * len;
    b.box(key, width + 0.5, 0.28, 0.24, 0, -0.22, z, 0, { tint });
  }
  railing(b, key, -width * 0.5, -len * 0.5, -width * 0.5, len * 0.5, 0.12, 1.15, tint);
  railing(b, key, width * 0.5, -len * 0.5, width * 0.5, len * 0.5, 0.12, 1.15, tint);
  if (glowKey) {
    for (let i = 0; i <= Math.round(len / 12); i++) {
      b.box(glowKey, 0.24, 0.24, 0.24, width * 0.5, 1.2, -len * 0.5 + i * 12, 0, { tint: 0xffb14a });
    }
  }
  b.pop();
  b.pop();
  return { x0, y0, z0, x1, y1, z1, width, len };
}

/** A run of large process pipes with elbows, valves and pipe-rack supports. */
export function pipeRun(b, mats, o) {
  const {
    pts = [], r = 0.7, count = 3, y = 4, tint,
    body = mats.body, dark = mats.dark, trim = mats.trim, rng = Math.random,
  } = o;
  if (pts.length < 2) return;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1];
    const ang = Math.atan2(c[0] - a[0], c[1] - a[1]);
    const px = Math.cos(ang), pz = -Math.sin(ang);
    for (let k = 0; k < count; k++) {
      const off = (k - (count - 1) * 0.5) * r * 2.9;
      const yy = y + (k % 2) * 0.15;
      b.pipe(body, a[0] + px * off, yy, a[1] + pz * off, c[0] + px * off, yy, c[1] + pz * off, r * (0.8 + (k % 3) * 0.16), 10, { tint });
      // elbow ball at the joint
      b.dome(body, r * 1.15, c[0] + px * off, yy, c[1] + pz * off, 10, { phi: Math.PI, tint });
    }
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const sup = Math.max(1, Math.round(len / 11));
    for (let s = 0; s <= sup; s++) {
      const t = s / sup;
      const x = lerp(a[0], c[0], t), z = lerp(a[1], c[1], t);
      b.box(dark, count * r * 3.2, 0.35, 0.5, x, y - r * 1.5, z, ang, { tint });
      b.box(dark, 0.4, y - r * 1.5, 0.4, x + px * count * r * 1.4, (y - r * 1.5) * 0.5, z + pz * count * r * 1.4, ang, { tint });
      b.box(dark, 0.4, y - r * 1.5, 0.4, x - px * count * r * 1.4, (y - r * 1.5) * 0.5, z - pz * count * r * 1.4, ang, { tint });
      if (rng() < 0.28) {
        b.tube(trim, r * 1.5, 0.5, x, y + r * 1.4, z, 10, { tint });
        b.box(trim, 0.22, 1.3, 0.22, x, y + r * 2.2, z, 0, { tint });
      }
    }
  }
}

/* ========================================================================== */
/*  Props — standalone geometries destined for InstancedMesh                   */
/* ========================================================================== */

function weld(list) {
  const g = mergeGeometries(list, false);
  for (const s of list) s.dispose();
  g.setAttribute('uv1', g.attributes.uv);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function prep(geo, uv, tube) {
  if (tube) applyTubeUV(geo, tube[0], tube[1], uv);
  else applyBoxUV(geo, uv);
  const keep = ['position', 'normal', 'uv'];
  for (const k of Object.keys(geo.attributes)) if (!keep.includes(k)) geo.deleteAttribute(k);
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/** ISO shipping container: corrugated sides, door end, corner castings. */
export function containerGeo(len = 6.1, uv = 2.0) {
  const w = 2.44, h = 2.59;
  const parts = [];
  const push = (g, x, y, z, ry) => {
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    parts.push(g);
  };
  push(prep(chamferBox(len - 0.16, h - 0.2, w - 0.14, 0.05), uv), 0, h * 0.5, 0);
  const ribs2 = Math.round(len / 0.42);
  for (let i = 0; i < ribs2; i++) {
    const x = -len * 0.5 + 0.35 + (i + 0.5) * ((len - 0.7) / ribs2);
    push(prep(new THREE.BoxGeometry(0.14, h - 0.6, 0.1), uv), x, h * 0.5, w * 0.5 - 0.02);
    push(prep(new THREE.BoxGeometry(0.14, h - 0.6, 0.1), uv), x, h * 0.5, -w * 0.5 + 0.02);
  }
  // door end
  push(prep(new THREE.BoxGeometry(0.1, h - 0.35, w - 0.3), uv), len * 0.5 - 0.02, h * 0.5, 0);
  for (const s of [-1, 1]) {
    push(prep(new THREE.BoxGeometry(0.09, h - 0.6, 0.09), uv), len * 0.5 + 0.04, h * 0.5, s * 0.32);
    push(prep(new THREE.BoxGeometry(0.22, 0.16, 0.16), uv), len * 0.5 + 0.06, h * 0.62, s * 0.32);
  }
  // rails + corner castings
  for (const sy of [0.06, h - 0.06]) {
    for (const sz of [-1, 1]) push(prep(new THREE.BoxGeometry(len, 0.16, 0.18), uv), 0, sy, sz * (w * 0.5 - 0.04));
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const sy of [0.1, h - 0.1]) {
        push(prep(new THREE.BoxGeometry(0.3, 0.24, 0.26), uv), sx * (len * 0.5 - 0.12), sy, sz * (w * 0.5 - 0.1));
      }
    }
  }
  return weld(parts);
}

/** 200-litre fuel drum with rolling hoops and a bung. */
export function drumGeo(uv = 1.1) {
  const parts = [];
  const r = 0.29, h = 0.88;
  let g = prep(new THREE.CylinderGeometry(r, r, h, 12), uv, [r, h]);
  g.translate(0, h * 0.5, 0); parts.push(g);
  for (const y of [h * 0.32, h * 0.68]) {
    g = prep(new THREE.CylinderGeometry(r + 0.025, r + 0.025, 0.07, 12), uv, [r, 0.07]);
    g.translate(0, y, 0); parts.push(g);
  }
  for (const y of [0.03, h - 0.03]) {
    g = prep(new THREE.CylinderGeometry(r * 0.99, r * 0.99, 0.06, 12), uv, [r, 0.06]);
    g.translate(0, y, 0); parts.push(g);
  }
  g = prep(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8), uv, [0.05, 0.05]);
  g.translate(r * 0.55, h + 0.01, 0); parts.push(g);
  return weld(parts);
}

/** Wooden/steel cable spool. */
export function spoolGeo(uv = 1.4) {
  const parts = [];
  const R = 1.5, hub = 0.62, w = 1.5;
  for (const s of [-1, 1]) {
    const g = prep(new THREE.CylinderGeometry(R, R, 0.16, 16), uv, [R, 0.16]);
    g.rotateZ(Math.PI * 0.5);
    g.translate(s * w * 0.5, R, 0);
    parts.push(g);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const sp = prep(new THREE.BoxGeometry(0.1, 0.22, R * 1.6), uv);
      sp.rotateX(a);
      sp.translate(s * (w * 0.5 + 0.1), R, 0);
      parts.push(sp);
    }
  }
  let g = prep(new THREE.CylinderGeometry(hub, hub, w, 14), uv, [hub, w]);
  g.rotateZ(Math.PI * 0.5); g.translate(0, R, 0); parts.push(g);
  // wound cable
  for (let i = 0; i < 5; i++) {
    g = prep(new THREE.CylinderGeometry(hub + 0.08 + i * 0.075, hub + 0.08 + i * 0.075, w - 0.24, 14, 1, true), uv, [hub, w]);
    g.rotateZ(Math.PI * 0.5); g.translate(0, R, 0); parts.push(g);
  }
  return weld(parts);
}

/** Burnt-out hauler hulk — reads as scale reference and story. */
export function wreckGeo(rng, uv = 2.0) {
  const parts = [];
  const push = (g) => parts.push(g);
  const L = 7.5 + rng() * 3;
  push(prep(chamferBox(L, 1.5, 3.0, 0.18), uv));
  parts[0].translate(0, 1.5, 0);
  let g = prep(chamferBox(3.0, 2.4, 2.8, 0.2), uv); g.rotateZ(-0.12); g.translate(-L * 0.32, 3.0, 0); push(g);
  g = prep(new THREE.BoxGeometry(L * 0.5, 0.25, 2.6), uv); g.rotateZ(0.22); g.translate(L * 0.22, 2.7, 0); push(g);
  for (let i = 0; i < 4; i++) {
    const x = -L * 0.34 + (i / 3) * L * 0.68;
    const s = i === 2 ? 0.45 : 1;
    g = prep(new THREE.CylinderGeometry(0.85 * s, 0.85 * s, 0.65, 10), uv, [0.85, 0.65]);
    g.rotateX(Math.PI * 0.5);
    g.translate(x, 0.85 * s, 1.55); push(g);
    g = prep(new THREE.CylinderGeometry(0.85 * s, 0.85 * s, 0.65, 10), uv, [0.85, 0.65]);
    g.rotateX(Math.PI * 0.5);
    g.translate(x, 0.85 * s, -1.55); push(g);
  }
  for (let i = 0; i < 7; i++) {
    g = prep(new THREE.BoxGeometry(0.16, 0.9 + rng() * 1.4, 0.16), uv);
    g.rotateZ((rng() - 0.5) * 0.9); g.rotateX((rng() - 0.5) * 0.9);
    g.translate(L * (0.1 + rng() * 0.35), 2.4 + rng() * 0.8, (rng() - 0.5) * 2.4);
    push(g);
  }
  return weld(parts);
}

/** Concrete rubble chunk. */
export function debrisGeo(rng, uv = 1.6) {
  const s = 0.7 + rng() * 1.9;
  const g = prep(chamferBox(s * (0.7 + rng() * 0.8), s * (0.4 + rng() * 0.5), s * (0.7 + rng() * 0.8), s * 0.13), uv);
  g.rotateY(rng() * TAU);
  g.rotateX((rng() - 0.5) * 0.5);
  g.translate(0, s * 0.22, 0);
  return weld([g]);
}

/**
 * Wind-scoured rock: an icosahedron pushed around by three sinusoid pairs and
 * squashed on Y, then flat-shaded.
 *
 * WHY A DISPLACED POLYHEDRON AND NOT A CHAMFERED BOX. `debrisGeo` is a box and
 * reads as poured concrete, which is right for rubble in a yard and wrong for
 * the thing the near field is missing: this plateau has no NATURAL scatter at
 * all, so every object within 30 m of the camera is man-made and rectilinear,
 * and the ground between them is bare. A rock has to be irregular in plan or it
 * joins the rubble.
 *
 * The displacement is a pure function of the vertex POSITION, which is what
 * makes it safe on a non-indexed polyhedron: `PolyhedronGeometry` duplicates
 * every shared corner once per face, and any displacement that varied per
 * vertex INDEX would tear the hull into 20 loose triangles. Because it varies
 * per position instead, duplicated corners move identically and the hull stays
 * closed. `computeVertexNormals` on that non-indexed mesh then gives per-face
 * normals for free, which is exactly the faceting a fractured rock wants — a
 * smoothed one reads as a potato.
 *
 * The mass is lifted by less than its own half-height so the base is BURIED.
 * At a 13.5 degree sun a rock resting exactly on the surface has a contact
 * shadow the length of its own shadow and nothing under it, and reads as
 * pasted on; sinking it 40% of the way removes the tell for free.
 */
export function boulderGeo(rng, grade = 'rock', uv = 1.1) {
  /*
   * THE GRADE IS A TRIANGLE BUDGET, and on a scatter the budget is what decides
   * the DENSITY, which is the only thing the scatter is for. Measured on the
   * ground pose: 620 shadow-casting boulders at 80 triangles each added 393 k
   * triangles to the frame, not the 50 k the geometry implies — a caster is
   * re-submitted once per shadow cascade, so anything that casts costs about
   * 5x its own mesh. Dropping the boulder from a subdivided icosahedron (80) to
   * a plain one (20) bought back 480 k triangles at 2-3 m, where the faceting
   * is the point anyway, and paid for four times as many pebbles.
   */
  const g = grade === 'pebble' ? new THREE.OctahedronGeometry(1, 0)   // 8 tris
    : grade === 'boulder' ? new THREE.IcosahedronGeometry(1, 1)       // 80 tris
      : new THREE.IcosahedronGeometry(1, 0);                          // 20 tris
  const p = g.attributes.position;
  const ph = [];
  for (let i = 0; i < 6; i++) ph.push(rng() * TAU);
  const sx = 0.66 + rng() * 0.5;
  const sy = 0.34 + rng() * 0.26;
  const sz = 0.66 + rng() * 0.5;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 1
      + 0.22 * Math.sin(x * 2.7 + ph[0]) * Math.sin(z * 2.3 + ph[1])
      + 0.14 * Math.sin(y * 4.1 + ph[2]) * Math.sin(x * 3.7 + ph[3])
      + 0.09 * Math.sin(z * 6.3 + ph[4]) * Math.sin(y * 5.9 + ph[5]);
    p.setXYZ(i, x * d * sx, y * d * sy, z * d * sz);
  }
  g.computeVertexNormals();
  g.translate(0, sy * 0.60, 0);
  return prep(g, uv);
}

/** Bent rebar bundle sticking out of a slab fragment. */
export function rebarGeo(rng, uv = 1.2) {
  const parts = [];
  let g = prep(chamferBox(2.2, 0.5, 1.7, 0.1), uv);
  g.translate(0, 0.25, 0); parts.push(g);
  for (let i = 0; i < 9; i++) {
    const h = 0.9 + rng() * 1.7;
    g = prep(new THREE.CylinderGeometry(0.045, 0.045, h, 5), uv, [0.045, h]);
    g.rotateZ((rng() - 0.5) * 1.1);
    g.rotateX((rng() - 0.5) * 1.1);
    g.translate((rng() - 0.5) * 1.8, 0.4 + h * 0.45, (rng() - 0.5) * 1.4);
    parts.push(g);
  }
  return weld(parts);
}

/** Stacked crate / pallet load. */
export function crateGeo(rng, uv = 1.2) {
  const parts = [];
  const n = 1 + Math.floor(rng() * 3);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = 1.5 - i * 0.18;
    const g = prep(chamferBox(s, s * 0.72, s * 0.9, 0.06), uv);
    g.rotateY((rng() - 0.5) * 0.5);
    g.translate((rng() - 0.5) * 0.2, y + s * 0.36, (rng() - 0.5) * 0.2);
    parts.push(g);
    for (const sy of [0.1, s * 0.62]) {
      const band = prep(new THREE.BoxGeometry(s + 0.04, 0.06, s * 0.94), uv);
      band.translate(0, y + sy, 0);
      parts.push(band);
    }
    y += s * 0.72;
  }
  return weld(parts);
}

/** Jersey barrier. */
export function barrierGeo(uv = 1.2) {
  const parts = [];
  let g = prep(chamferBox(3.2, 0.42, 0.78, 0.06), uv); g.translate(0, 0.21, 0); parts.push(g);
  g = prep(chamferBox(3.2, 0.5, 0.5, 0.06), uv); g.translate(0, 0.66, 0); parts.push(g);
  g = prep(chamferBox(3.2, 0.24, 0.34, 0.05), uv); g.translate(0, 1.02, 0); parts.push(g);
  return weld(parts);
}

/** Floodlight mast — a tower with a head of lamp housings. */
export function floodMast(b, mats, o) {
  const { h = 18, tint, dark = mats.dark, trim = mats.trim, glow = mats.glow, lamps = 4, rng = Math.random } = o;
  b.box(mats.concrete, 2.4, 1.0, 2.4, 0, 0.5, 0, 0, { chamfer: 0.2, tint });
  b.tube(dark, 0.42, h, 0, h * 0.5 + 0.9, 0, 10, { r2: 0.26, tint });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4;
    b.strut(dark, Math.cos(a) * 1.0, 1.0, Math.sin(a) * 1.0, Math.cos(a) * 0.32, h * 0.34, Math.sin(a) * 0.32, 0.16, { tint });
  }
  b.box(dark, 3.4, 0.28, 0.5, 0, h + 0.9, 0, 0, { tint });
  for (let i = 0; i < lamps; i++) {
    const x = -1.5 + (i / Math.max(1, lamps - 1)) * 3.0;
    b.push(new THREE.Matrix4().makeRotationX(0.55).setPosition(x, h + 0.6, 0));
    b.box(dark, 0.66, 0.44, 0.30, 0, 0, 0, 0, { tint });
    b.box(glow, 0.56, 0.36, 0.10, 0, 0, 0.19, 0, { tint: 0xffd39a });
    b.pop();
  }
  b.box(trim, 0.9, 0.9, 0.7, 0, 2.2, 0.6, 0, { tint });
  ladder(b, dark, 0.55, 0, 1.0, h * 0.9, -Math.PI * 0.5, tint);
  void rng;
  return { h: h + 1.4 };
}
