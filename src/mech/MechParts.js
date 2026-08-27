import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp } from '../core/MathUtils.js';

/**
 * MechParts — parametric hard-surface primitive library + procedural part builders.
 *
 * Design rules that make this read as an Armored Core and not "boxes stacked in Blender":
 *  - EVERY hard edge is chamfered. Chamfers are what catch anisotropic specular
 *    highlights; a raw 90 degree box edge is the single biggest amateur tell.
 *  - Surfaces are never left bare: greeble fields, bolt rings, recessed vent slats
 *    and cable runs break up every large plate.
 *  - Nothing is UV'd by the primitive generators. UVs are box-projected AFTER the
 *    per-bone merge (see `applyBoxUV`) so texel density is identical on every part
 *    of every mech regardless of part size — inconsistent texel density is a
 *    classic tell that reads instantly in side-by-side comparisons.
 *  - Colour variation is carried in a per-vertex MASK (base / accent / trim), not
 *    in separate materials, so a whole bone is 1 draw call per material bucket.
 */

// ---------------------------------------------------------------------------
// Vertex colour masks. The armour shader remaps these to palette colours.
// ---------------------------------------------------------------------------

/**
 * Per-vertex surface slot. Encoded as a one-hot vec4 in the custom `aMask`
 * attribute and resolved to a palette colour + roughness/metalness offset in the
 * shader. Doing recolouring this way means a whole bone is ONE draw call even
 * though it carries painted armour, an accent stripe, dark structure and bare
 * steel actuators.
 */
export const MASK = { BASE: 0, ACCENT: 1, TRIM: 2, STEEL: 3 };
const MASK_RGBA = [
  [255, 0, 0, 0], // base armour paint
  [0, 255, 0, 0], // accent / hero colour
  [0, 0, 255, 0], // trim: dark structural metal
  [0, 0, 0, 255], // bare machined steel (pistons, rails, axles)
];

// Material buckets. One merged mesh per bucket per bone.
export const BUCKETS = ['armor', 'mech', 'glow'];

// ---------------------------------------------------------------------------
// Low-level triangle emission
// ---------------------------------------------------------------------------

/** Emit one triangle with a single flat normal, auto-correcting winding to face `n`. */
function tri(P, N, a, b, c, n) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  if (cx * n[0] + cy * n[1] + cz * n[2] < 0) { const t = b; b = c; c = t; }
  P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  N.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
}

function quad(P, N, a, b, c, d, n) {
  tri(P, N, a, b, c, n);
  tri(P, N, a, c, d, n);
}

/** Emit a triangle carrying per-vertex normals (smooth shading around lathes). */
function triN(P, N, a, b, c, na, nb, nc, ref) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  if (cx * ref[0] + cy * ref[1] + cz * ref[2] < 0) {
    const t = b; b = c; c = t;
    const tn = nb; nb = nc; nc = tn;
  }
  P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  N.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
}

function finish(P, N) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
  return g;
}

// ---------------------------------------------------------------------------
// Primitive: chamfered box  (6 faces + 12 edge bevels + 8 corner facets = 44 tris)
// ---------------------------------------------------------------------------

/**
 * A box whose every edge and corner is mitred. This is the workhorse primitive —
 * roughly 70% of the mech is built from it.
 *
 * @param {number} w width (X), h height (Y), d depth (Z)
 * @param {number} c chamfer size in metres
 * @param {object} [opts] taperX/taperZ scale the +Y end; shearX/shearZ offset it;
 *                        taperFrontX/taperFrontY scale the -Z end.
 */
export function chamferBox(w, h, d, c = 0.035, opts = null) {
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  const cc = Math.max(0.002, Math.min(c, hx * 0.62, hy * 0.62, hz * 0.62));
  const ax = hx - cc, ay = hy - cc, az = hz - cc;
  const P = [], N = [];
  const H = [hx, hy, hz];
  const A = [ax, ay, az];

  // 6 face quads
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (let s = -1; s <= 1; s += 2) {
      const n = [0, 0, 0]; n[axis] = s;
      const mk = (su, sv) => {
        const p = [0, 0, 0];
        p[axis] = s * H[axis]; p[u] = su * A[u]; p[v] = sv * A[v];
        return p;
      };
      quad(P, N, mk(-1, -1), mk(1, -1), mk(1, 1), mk(-1, 1), n);
    }
  }

  // 12 edge bevels
  for (let a = 0; a < 3; a++) {
    for (let b2 = a + 1; b2 < 3; b2++) {
      const e = 3 - a - b2; // the axis the edge runs along
      for (let sa = -1; sa <= 1; sa += 2) {
        for (let sb = -1; sb <= 1; sb += 2) {
          const n = [0, 0, 0];
          n[a] = sa * Math.SQRT1_2; n[b2] = sb * Math.SQRT1_2;
          const mk = (outerOnA, se) => {
            const p = [0, 0, 0];
            p[a] = sa * (outerOnA ? H[a] : A[a]);
            p[b2] = sb * (outerOnA ? A[b2] : H[b2]);
            p[e] = se * A[e];
            return p;
          };
          quad(P, N, mk(true, -1), mk(true, 1), mk(false, 1), mk(false, -1), n);
        }
      }
    }
  }

  // 8 corner facets
  const k = 1 / Math.sqrt(3);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        tri(P, N,
          [sx * hx, sy * ay, sz * az],
          [sx * ax, sy * hy, sz * az],
          [sx * ax, sy * ay, sz * hz],
          [sx * k, sy * k, sz * k]);
      }
    }
  }

  const g = finish(P, N);
  if (opts) applyDeform(g, hy, hz, opts);
  return g;
}

/** Linear taper/shear. Planarity is preserved so flat re-normalisation stays exact. */
function applyDeform(g, hy, hz, o) {
  const pos = g.attributes.position.array;
  const tX = o.taperX ?? 1, tZ = o.taperZ ?? 1;
  const shX = o.shearX ?? 0, shZ = o.shearZ ?? 0;
  const fX = o.taperFrontX ?? 1, fY = o.taperFrontY ?? 1;
  for (let i = 0; i < pos.length; i += 3) {
    const ty = hy > 0 ? clamp((pos[i + 1] + hy) / (2 * hy), 0, 1) : 0;
    const tz = hz > 0 ? clamp((hz - pos[i + 2]) / (2 * hz), 0, 1) : 0; // 1 at -Z (front)
    pos[i] *= lerp(1, tX, ty) * lerp(1, fX, tz);
    pos[i + 1] *= lerp(1, fY, tz);
    pos[i + 2] *= lerp(1, tZ, ty);
    pos[i] += shX * ty;
    pos[i + 2] += shZ * ty;
  }
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals(); // non-indexed -> exact per-facet normals
  return g;
}

// ---------------------------------------------------------------------------
// Primitive: surface of revolution
// ---------------------------------------------------------------------------

/**
 * Revolve a 2D profile around +Y. Normals are smooth around the circumference and
 * hard between profile segments — exactly what hard-surface cylinders want.
 *
 * Profile order matters: walk it so that "outward" is 90 degrees clockwise from the
 * travel direction. Running the profile back down the inside therefore produces
 * inward-facing normals for free (this is how nozzle interiors are made).
 *
 * @param {Array<[number,number]>} profile [radius, y] pairs
 */
export function revolve(profile, segments = 16, opts = null) {
  const arc = opts?.arc ?? Math.PI * 2;
  const start = opts?.start ?? 0;
  const seg = Math.max(3, segments | 0);
  const P = [], N = [];
  const closed = Math.abs(arc - Math.PI * 2) < 1e-6;
  const steps = closed ? seg : seg;

  for (let i = 0; i < profile.length - 1; i++) {
    const r0 = profile[i][0], y0 = profile[i][1];
    const r1 = profile[i + 1][0], y1 = profile[i + 1][1];
    const dr = r1 - r0, dy = y1 - y0;
    const len = Math.hypot(dr, dy);
    if (len < 1e-7) continue;
    const n2x = dy / len, n2y = -dr / len;
    for (let s = 0; s < steps; s++) {
      const t0 = start + arc * (s / seg);
      const t1 = start + arc * ((s + 1) / seg);
      const c0 = Math.cos(t0), s0 = Math.sin(t0);
      const c1 = Math.cos(t1), s1 = Math.sin(t1);
      const A = [r0 * c0, y0, r0 * s0];
      const B = [r0 * c1, y0, r0 * s1];
      const C = [r1 * c1, y1, r1 * s1];
      const D = [r1 * c0, y1, r1 * s0];
      const nA = [n2x * c0, n2y, n2x * s0];
      const nB = [n2x * c1, n2y, n2x * s1];
      const nC = nB, nD = nA;
      const mid = [n2x * Math.cos((t0 + t1) * 0.5), n2y, n2x * Math.sin((t0 + t1) * 0.5)];
      if (r0 < 1e-6) {
        triN(P, N, A, D, C, nA, nD, nC, mid);
      } else if (r1 < 1e-6) {
        triN(P, N, A, B, C, nA, nB, nC, mid);
      } else {
        triN(P, N, A, D, C, nA, nD, nC, mid);
        triN(P, N, A, C, B, nA, nC, nB, mid);
      }
    }
  }
  return finish(P, N);
}

/** Cylinder with mitred cap rims. `rt`/`rb` allow cones and truncated cones. */
export function chamferCyl(rb, rt, h, seg = 14, c = 0.03) {
  const cc = Math.max(0.004, Math.min(c, h * 0.4, rb * 0.5, rt * 0.5));
  return revolve([
    [0, -h * 0.5],
    [rb - cc, -h * 0.5],
    [rb, -h * 0.5 + cc],
    [rt, h * 0.5 - cc],
    [rt - cc, h * 0.5],
    [0, h * 0.5],
  ], seg);
}

/** Open tube with wall thickness — pistons sleeves, collars, hardpoint rails. */
export function ring(rInner, rOuter, h, seg = 16, c = 0.015) {
  const cc = Math.min(c, (rOuter - rInner) * 0.4, h * 0.4);
  return revolve([
    [rInner, -h * 0.5],
    [rOuter - cc, -h * 0.5],
    [rOuter, -h * 0.5 + cc],
    [rOuter, h * 0.5 - cc],
    [rOuter - cc, h * 0.5],
    [rInner, h * 0.5],
    [rInner, -h * 0.5],
  ], seg);
}

/**
 * Thruster bell: throat -> flare -> rim -> back down the inside.
 * The interior is a separate inward-facing shell so a dark interior material and a
 * bright emissive core disc read correctly from any angle.
 */
export function nozzle(throat, mouth, len, seg = 20, opts = null) {
  const lip = opts?.lip ?? mouth * 0.10;
  const inner = opts?.innerScale ?? 0.86;
  const prof = [];
  const N = 5;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = lerp(throat, mouth, t * t * 0.75 + t * 0.25);
    prof.push([r, lerp(0, len, t)]);
  }
  prof.push([mouth + lip * 0.35, len + lip * 0.5]);
  prof.push([mouth * inner, len + lip * 0.5]);
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    const r = lerp(throat, mouth, t * t * 0.75 + t * 0.25) * inner;
    prof.push([r, lerp(0, len, t) + 0.004]);
  }
  return revolve(prof, seg);
}

// ---------------------------------------------------------------------------
// Primitive: extruded bevelled armour plate
// ---------------------------------------------------------------------------

/** Rectangle with 45 degree corner cuts — the canonical AC plate silhouette. */
export function beveledRectShape(w, h, cuts = 0.12) {
  const c = typeof cuts === 'number'
    ? { tl: cuts, tr: cuts, br: cuts, bl: cuts }
    : { tl: 0, tr: 0, br: 0, bl: 0, ...cuts };
  const x = w * 0.5, y = h * 0.5;
  const s = new THREE.Shape();
  s.moveTo(-x + c.bl, -y);
  s.lineTo(x - c.br, -y);
  if (c.br) s.lineTo(x, -y + c.br);
  s.lineTo(x, y - c.tr);
  if (c.tr) s.lineTo(x - c.tr, y);
  s.lineTo(-x + c.tl, y);
  if (c.tl) s.lineTo(-x, y - c.tl);
  s.lineTo(-x, -y + c.bl);
  s.closePath();
  return s;
}

/** Bevelled extrusion. Centred on Z. */
export function plate(shape, depth, bevel = 0.025) {
  const b = Math.max(0.002, Math.min(bevel, depth * 0.35));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - b * 2,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 3,
    steps: 1,
  });
  g.translate(0, 0, -(depth - b * 2) * 0.5);
  return g;
}

/** Cable / hose bundle along a Catmull-Rom path. */
export function cable(points, radius = 0.045, tubular = 12, radial = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, tubular, radius, radial, false);
}

// ---------------------------------------------------------------------------
// Face basis helper (used by greebles, vents, bolt rings)
// ---------------------------------------------------------------------------

const FACES = {
  px: { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  py: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  ny: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  nz: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
};

const _fu = new THREE.Vector3();
const _fv = new THREE.Vector3();
const _fn = new THREE.Vector3();

function faceMatrix(face, px, py, pz, out) {
  const f = FACES[face] || FACES.pz;
  _fu.fromArray(f.u); _fv.fromArray(f.v); _fn.fromArray(f.n);
  out.makeBasis(_fu, _fv, _fn);
  out.setPosition(px, py, pz);
  return out;
}

// ---------------------------------------------------------------------------
// Geometry accumulator
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _mr = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _pv = new THREE.Vector3();

/**
 * Collects geometry into per-material buckets, tagging every vertex with a colour
 * mask. `build()` merges each bucket down to a single BufferGeometry so one bone
 * is at most four draw calls.
 */
export class GeoBuilder {
  constructor(rng) {
    this.rng = rng || Math.random;
    this.buckets = { armor: [], mech: [], steel: [], glow: [] };
    this.tris = 0;
  }

  /** Place geometry with an explicit matrix. Takes ownership of `geo`. */
  addM(bucket, mask, geo, matrix) {
    if (geo.index) geo = geo.toNonIndexed();
    // strip everything we don't control so merges never fail on attribute mismatch
    for (const k of Object.keys(geo.attributes)) {
      if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (matrix) geo.applyMatrix4(matrix);

    const n = geo.attributes.position.count;
    const rgba = MASK_RGBA[mask] || MASK_RGBA[0];
    const col = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      col[i * 4] = rgba[0]; col[i * 4 + 1] = rgba[1];
      col[i * 4 + 2] = rgba[2]; col[i * 4 + 3] = rgba[3];
    }
    geo.setAttribute('aMask', new THREE.BufferAttribute(col, 4, true));
    this.tris += n / 3;
    (this.buckets[bucket] || this.buckets.mech).push(geo);
    return this;
  }

  /** Place geometry by TRS. */
  add(bucket, mask, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _pv.set(x, y, z);
    _sc.set(sx, sy, sz);
    _m.compose(_pv, _q, _sc);
    return this.addM(bucket, mask, geo, _m);
  }

  /** Convenience: chamfered box placed by TRS. */
  box(bucket, mask, w, h, d, c, x, y, z, rx = 0, ry = 0, rz = 0, deform = null) {
    return this.add(bucket, mask, chamferBox(w, h, d, c, deform), x, y, z, rx, ry, rz);
  }

  /** Merge each bucket. Returns { armor, mech, steel, glow } of BufferGeometry|null. */
  build() {
    const out = {};
    for (const k of BUCKETS) {
      const list = this.buckets[k];
      if (!list.length) { out[k] = null; continue; }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) for (const g of list) g.dispose();
      out[k] = merged || null;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Greeble / detail generators
// ---------------------------------------------------------------------------

/**
 * Scatter a jittered grid of small chamfered boxes over a rectangular face.
 * This is what turns a flat armour panel into something that survives a 4K render.
 */
let GREEBLE_DENSITY = 1.5;
/** Global greeble multiplier — LOD and low-end quality presets turn this down. */
export function setGreebleDensity(v) { GREEBLE_DENSITY = Math.max(0, v); }

export function greebleFace(b, bucket, mask, face, cx, cy, cz, uSize, vSize, rng, opts = null) {
  const cols = Math.max(1, Math.round((opts?.cols ?? 4) * GREEBLE_DENSITY));
  const rows = Math.max(1, Math.round((opts?.rows ?? 3) * GREEBLE_DENSITY));
  const depth = opts?.depth ?? 0.035;
  const fill = opts?.fill ?? 0.72;
  const accentChance = opts?.accent ?? 0.12;
  const cw = uSize / cols;
  const ch = vSize / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (rng() > fill) continue;
      const u = -uSize * 0.5 + cw * (i + 0.5) + (rng() - 0.5) * cw * 0.25;
      const v = -vSize * 0.5 + ch * (j + 0.5) + (rng() - 0.5) * ch * 0.25;
      const w = cw * (0.35 + rng() * 0.5);
      const h = ch * (0.3 + rng() * 0.55);
      const dp = depth * (0.4 + rng() * 1.1);
      const mk = rng() < accentChance ? MASK.ACCENT : mask;
      faceMatrix(face, cx, cy, cz, _mr);
      _m.makeTranslation(u, v, dp * 0.5);
      _mr.multiply(_m);
      b.addM(bucket, mk, chamferBox(w, h, dp, Math.min(dp, w, h) * 0.22), _mr);
    }
  }
}

/** Ring of bolt heads around a circular joint. */
export function boltRing(b, bucket, mask, face, cx, cy, cz, radius, count, boltR = 0.03, boltH = 0.02) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    faceMatrix(face, cx, cy, cz, _mr);
    _m.makeTranslation(Math.cos(a) * radius, Math.sin(a) * radius, boltH * 0.5);
    _mr.multiply(_m);
    _m.makeRotationX(Math.PI * 0.5);
    _mr.multiply(_m);
    b.addM(bucket, mask, revolve([
      [0, -boltH * 0.5], [boltR * 0.8, -boltH * 0.5],
      [boltR, -boltH * 0.2], [boltR, boltH * 0.5], [0, boltH * 0.5],
    ], 6), _mr);
  }
}

/** Recessed slatted vent. Slats sit inside a bevelled bezel. */
export function ventGrill(b, bucket, mask, face, cx, cy, cz, w, h, slats = 5, depth = 0.09) {
  faceMatrix(face, cx, cy, cz, _mr);
  // bezel: four thin plates framing the recess
  const t = Math.min(w, h) * 0.10;
  const frame = [
    [0, h * 0.5 - t * 0.5, w, t], [0, -h * 0.5 + t * 0.5, w, t],
    [-w * 0.5 + t * 0.5, 0, t, h - t * 2], [w * 0.5 - t * 0.5, 0, t, h - t * 2],
  ];
  for (const [fx, fy, fw, fh] of frame) {
    faceMatrix(face, cx, cy, cz, _mr);
    _m.makeTranslation(fx, fy, depth * 0.18);
    _mr.multiply(_m);
    b.addM(bucket, mask, chamferBox(fw, fh, depth * 0.36, depth * 0.1), _mr);
  }
  const step = (h - t * 2) / slats;
  for (let i = 0; i < slats; i++) {
    const y = -h * 0.5 + t + step * (i + 0.5);
    faceMatrix(face, cx, cy, cz, _mr);
    _m.makeTranslation(0, y, -depth * 0.42);
    _mr.multiply(_m);
    _e.set(-0.5, 0, 0); _q.setFromEuler(_e); _pv.set(0, 0, 0); _sc.set(1, 1, 1);
    _m.compose(_pv, _q, _sc);
    _mr.multiply(_m);
    b.addM(bucket, mask, chamferBox(w - t * 2, step * 0.62, depth * 0.3, 0.008), _mr);
  }
}

/** Piston: bright steel rod inside a darker sleeve. Two buckets, one call. */
export function piston(b, x0, y0, z0, x1, y1, z1, rSleeve = 0.055, opts = null) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  _pv.set(dx / len, dy / len, dz / len);
  _q.setFromUnitVectors(UP, _pv);
  _sc.set(1, 1, 1);
  const sleeveLen = len * (opts?.sleeve ?? 0.55);
  const rodR = rSleeve * 0.55;
  _pv.set(x0 + dx * 0.5 * (sleeveLen / len), y0 + dy * 0.5 * (sleeveLen / len), z0 + dz * 0.5 * (sleeveLen / len));
  _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.TRIM, chamferCyl(rSleeve, rSleeve * 0.94, sleeveLen, 12, rSleeve * 0.3), _m);
  _pv.set(x0 + dx * 0.65, y0 + dy * 0.65, z0 + dz * 0.65);
  _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.STEEL, chamferCyl(rodR, rodR, len * 0.66, 10, rodR * 0.35), _m);
}

const UP = new THREE.Vector3(0, 1, 0);

/** Cylindrical joint housing lying along X (knees, elbows, hips). */
export function axleJoint(b, bucket, mask, x, y, z, r, w, seg = 14) {
  _e.set(0, 0, Math.PI * 0.5); _q.setFromEuler(_e);
  _pv.set(x, y, z); _sc.set(1, 1, 1);
  _m.compose(_pv, _q, _sc);
  b.addM(bucket, mask, chamferCyl(r, r, w, seg, r * 0.16), _m);
}

// ---------------------------------------------------------------------------
// UVs
// ---------------------------------------------------------------------------

/**
 * Per-triangle box projection. `tilesPerMetre` fixes texel density globally, so a
 * foot and a chest plate show panel lines at exactly the same physical scale.
 * Also writes `uv1` sharing the SAME BufferAttribute so aoMap works for free.
 */
export function applyBoxUV(geo, tilesPerMetre = 1.0, offU = 0, offV = 0) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const count = geo.attributes.position.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 3) {
    const i0 = i * 3, i1 = (i + 1) * 3, i2 = (i + 2) * 3;
    const nx = nrm[i0] + nrm[i1] + nrm[i2];
    const ny = nrm[i0 + 1] + nrm[i1 + 1] + nrm[i2 + 1];
    const nz = nrm[i0 + 2] + nrm[i1 + 2] + nrm[i2 + 2];
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let axis = 2;
    if (ax >= ay && ax >= az) axis = 0;
    else if (ay >= ax && ay >= az) axis = 1;
    for (let k = 0; k < 3; k++) {
      const p = (i + k) * 3;
      let u, v;
      if (axis === 0) { u = nx >= 0 ? -pos[p + 2] : pos[p + 2]; v = pos[p + 1]; }
      else if (axis === 1) { u = pos[p]; v = ny >= 0 ? -pos[p + 2] : pos[p + 2]; }
      else { u = nz >= 0 ? pos[p] : -pos[p]; v = pos[p + 1]; }
      uv[(i + k) * 2] = u * tilesPerMetre + offU;
      uv[(i + k) * 2 + 1] = v * tilesPerMetre + offV;
    }
  }
  const attr = new THREE.BufferAttribute(uv, 2);
  geo.setAttribute('uv', attr);
  geo.setAttribute('uv1', attr); // shared buffer: zero extra VRAM
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

export { faceMatrix };

// ---------------------------------------------------------------------------
// Skeleton dimensions (metres). Origin at the feet, forward is -Z.
// The rig and the factory both read these so geometry and bones cannot drift.
// ---------------------------------------------------------------------------

export const MECH_DIMS = {
  height: 9.0,
  ankleY: 0.52,
  kneeY: 2.10,
  hipY: 3.95,      // hip pivot
  pelvisY: 4.05,   // pelvis bone origin
  waistY: 4.35,    // torso bone origin
  shoulderY: 6.72,
  neckY: 7.28,
  hipX: 0.72,
  footX: 0.95,
  shoulderX: 1.42,
  thigh: 1.85,     // hipY - kneeY
  shin: 1.58,      // kneeY - ankleY
  elbowDrop: 1.30,
  wristDrop: 1.47,
};

export const LEG_TYPES = ['biped', 'reverse', 'tetrapod'];

// ---------------------------------------------------------------------------
// HEAD — small, visored, antenna'd. This is where the character lives.
// Deliberately ~9% of total height: an oversized head reads as a toy instantly.
// ---------------------------------------------------------------------------

export function buildHead(o = {}) {
  const rng = o.rng;
  const d = o.detail !== 'low';
  const crude = !!o.crude;
  const b = new GeoBuilder(rng);

  // skull
  b.box('armor', MASK.BASE, 0.78, 0.60, 0.86, 0.055, 0, 0.34, -0.02, 0, 0, 0,
    { taperX: 0.88, taperZ: 0.94, taperFrontX: 0.82, taperFrontY: 0.9 });
  // crest / brow
  b.box('armor', MASK.ACCENT, 0.64, 0.15, 0.72, 0.035, 0, 0.685, -0.06, 0.09, 0, 0,
    { taperX: 0.7, taperZ: 0.72 });
  // rear cowl
  b.box('armor', MASK.BASE, 0.62, 0.44, 0.30, 0.04, 0, 0.36, 0.32, -0.12, 0, 0, { taperZ: 0.6 });
  // jaw
  b.box('mech', MASK.TRIM, 0.60, 0.20, 0.66, 0.03, 0, 0.055, -0.05, 0, 0, 0, { taperX: 0.8 });

  // visor housing + lens
  b.box('mech', MASK.TRIM, 0.72, 0.26, 0.12, 0.03, 0, 0.375, -0.42, 0.08, 0, 0);
  b.box('glow', MASK.BASE, 0.56, 0.125, 0.05, 0.018, 0, 0.375, -0.475, 0.08, 0, 0);
  // main optic: a real lens, not a glowing cube
  _e.set(Math.PI * 0.5, 0, 0); _q.setFromEuler(_e); _pv.set(0, 0.378, -0.49); _sc.set(1, 1, 1);
  _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.TRIM, ring(0.075, 0.115, 0.07, 14, 0.014), _m);
  _pv.set(0, 0.378, -0.50); _m.compose(_pv, _q, _sc);
  b.addM('glow', MASK.BASE, chamferCyl(0.078, 0.062, 0.05, 14, 0.014), _m);

  // chin sub-sensor
  b.box('mech', MASK.TRIM, 0.20, 0.16, 0.20, 0.025, 0, 0.055, -0.36, 0.35, 0, 0);
  b.box('glow', MASK.BASE, 0.11, 0.075, 0.04, 0.012, 0, 0.028, -0.45, 0.35, 0, 0);

  // cheek armour
  for (let s = -1; s <= 1; s += 2) {
    b.box('armor', MASK.BASE, 0.10, 0.40, 0.52, 0.028, s * 0.40, 0.34, -0.08, 0, 0, 0, { taperZ: 0.8 });
    // cooling fins — thin stacked plates, the classic AC head silhouette break
    const fins = crude ? 2 : 4;
    for (let i = 0; i < fins; i++) {
      b.box('mech', MASK.TRIM, 0.055, 0.105, 0.40, 0.012,
        s * 0.435, 0.20 + i * 0.135, 0.06, 0, 0, s * 0.12);
    }
    // antenna cluster
    if (!crude) {
      _e.set(-0.35, 0, s * 0.22); _q.setFromEuler(_e);
      _pv.set(s * 0.22, 0.86, 0.16); _sc.set(1, 1, 1);
      _m.compose(_pv, _q, _sc);
      b.addM('mech', MASK.TRIM, chamferCyl(0.028, 0.011, 0.62, 7, 0.006), _m);
      _pv.set(s * 0.30, 1.15, 0.28); _m.compose(_pv, _q, _sc);
      b.addM('glow', MASK.BASE, chamferCyl(0.017, 0.013, 0.05, 6, 0.005), _m);
    }
  }

  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, 'py', 0, 0.635, 0.10, 0.52, 0.44, rng, { cols: 3, rows: 3, depth: 0.028, fill: 0.6 });
    greebleFace(b, 'armor', MASK.TRIM, 'pz', 0, 0.34, 0.475, 0.5, 0.36, rng, { cols: 3, rows: 3, depth: 0.03, fill: 0.7, accent: 0.2 });
    ventGrill(b, 'mech', MASK.TRIM, 'pz', 0, 0.30, 0.465, 0.34, 0.24, 4, 0.06);
    boltRing(b, 'mech', MASK.TRIM, 'nz', 0, 0.378, -0.49, 0.155, 8, 0.019, 0.014);
    // neck hose bundle
    for (let i = -1; i <= 1; i += 2) {
      b.addM('mech', MASK.TRIM, cable([
        [i * 0.16, 0.02, 0.20], [i * 0.20, -0.06, 0.30], [i * 0.14, -0.16, 0.24],
      ], 0.032, 6, 5), null);
    }
  }

  return { b, anchors: { optic: [0, 0.378, -0.50] }, top: 1.2 };
}

// ---------------------------------------------------------------------------
// CORE — the largest mass. Layered overlapping plates, reactor intake, yokes.
// ---------------------------------------------------------------------------

export function buildCore(o = {}) {
  const rng = o.rng;
  const d = o.detail !== 'low';
  const crude = !!o.crude;
  const wide = o.wide ?? 1;      // tank/boss cores are broader
  const b = new GeoBuilder(rng);
  const W = 1.70 * wide;

  // --- primary mass ------------------------------------------------------
  b.box('armor', MASK.BASE, W, 1.40, 1.28, 0.075, 0, 1.22, -0.04, 0, 0, 0,
    { taperX: 0.90, taperZ: 0.92, taperFrontX: 0.94 });
  // upper deck the shoulders bolt onto
  b.box('armor', MASK.BASE, W * 0.90, 0.46, 1.10, 0.05, 0, 2.12, -0.02, 0, 0, 0, { taperX: 0.9, taperZ: 0.86 });
  // lower waist block (narrow — the classic AC wasp waist)
  b.box('mech', MASK.TRIM, 1.02, 0.55, 0.86, 0.045, 0, 0.26, 0.0, 0, 0, 0, { taperX: 1.12, taperZ: 1.1 });
  // rear spine housing
  b.box('armor', MASK.TRIM, W * 0.80, 1.35, 0.34, 0.045, 0, 1.35, 0.66, -0.05, 0, 0);

  // --- layered front plates (overlap = depth) ----------------------------
  const frontZ = -0.66;
  b.addM('armor', MASK.BASE, plate(beveledRectShape(W * 0.72, 0.80, { tl: 0.20, tr: 0.20, bl: 0.10, br: 0.10 }), 0.12, 0.03),
    _m.compose(_pv.set(0, 1.62, frontZ - 0.02), _q.setFromEuler(_e.set(-0.10, 0, 0)), _sc.set(1, 1, 1)));
  b.addM('armor', MASK.ACCENT, plate(beveledRectShape(W * 0.50, 0.44, 0.14), 0.10, 0.028),
    _m.compose(_pv.set(0, 0.90, frontZ + 0.04), _q.setFromEuler(_e.set(0.14, 0, 0)), _sc.set(1, 1, 1)));
  for (let s = -1; s <= 1; s += 2) {
    b.addM('armor', MASK.BASE, plate(beveledRectShape(0.42, 1.05, { tl: 0.16, bl: 0.16, tr: 0.06, br: 0.24 }), 0.11, 0.028),
      _m.compose(_pv.set(s * W * 0.40, 1.30, frontZ + 0.06), _q.setFromEuler(_e.set(0, s * 0.30, 0)), _sc.set(1, 1, 1)));
  }

  // --- central reactor intake -------------------------------------------
  b.box('mech', MASK.TRIM, 0.56, 0.62, 0.16, 0.03, 0, 1.30, frontZ - 0.03);
  b.box('glow', MASK.BASE, 0.40, 0.46, 0.06, 0.02, 0, 1.30, frontZ - 0.10);
  ventGrill(b, 'mech', MASK.TRIM, 'nz', 0, 1.30, frontZ - 0.09, 0.44, 0.50, 5, 0.10);
  boltRing(b, 'mech', MASK.TRIM, 'nz', 0, 1.30, frontZ - 0.04, 0.36, 10, 0.022, 0.016);
  // side heat sinks
  for (let s = -1; s <= 1; s += 2) {
    ventGrill(b, 'mech', MASK.TRIM, s > 0 ? 'px' : 'nx', s * (W * 0.5 - 0.02), 1.05, 0.10, 0.60, 0.44, 4, 0.09);
    b.box('glow', MASK.BASE, 0.05, 0.06, 0.46, 0.014, s * (W * 0.5 + 0.005), 1.62, 0.02);
  }

  // --- shoulder yokes ----------------------------------------------------
  const sx = MECH_DIMS.shoulderX * wide;
  for (let s = -1; s <= 1; s += 2) {
    b.box('armor', MASK.BASE, 0.92, 0.88, 1.20, 0.065, s * (sx - 0.30), 2.00, 0.02, 0, 0, s * -0.06,
      { taperX: 0.86, taperZ: 0.9 });
    // outer pauldron plate
    b.addM('armor', MASK.ACCENT, plate(beveledRectShape(1.02, 0.72, { tl: 0.26, tr: 0.10, bl: 0.20, br: 0.10 }), 0.13, 0.03),
      _m.compose(_pv.set(s * (sx + 0.16), 2.06, 0.0), _q.setFromEuler(_e.set(0, s * Math.PI * 0.5, 0)), _sc.set(1, 1, 1)));
    // hardpoint deck on top
    b.box('armor', MASK.TRIM, 0.52, 0.14, 0.74, 0.028, s * (sx - 0.26), 2.50, 0.02);
    b.box('mech', MASK.TRIM, 0.34, 0.10, 0.52, 0.02, s * (sx - 0.26), 2.60, 0.02);
    // shoulder socket
    axleJoint(b, 'mech', MASK.TRIM, s * (sx - 0.06), 1.72, 0.0, 0.30, 0.34, 14);
    if (d) {
      boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * (sx + 0.14), 1.72, 0.0, 0.21, 8, 0.026, 0.02);
      greebleFace(b, 'armor', MASK.TRIM, 'py', s * (sx - 0.30), 2.45, -0.30, 0.7, 0.4, rng, { cols: 3, rows: 2, depth: 0.04, fill: 0.7 });
      greebleFace(b, 'armor', MASK.TRIM, 'pz', s * (sx - 0.30), 2.00, 0.62, 0.72, 0.66, rng, { cols: 3, rows: 3, depth: 0.045, accent: 0.18 });
    }
  }

  // --- neck collar -------------------------------------------------------
  b.addM('mech', MASK.TRIM, ring(0.20, 0.32, 0.26, 14, 0.02),
    _m.compose(_pv.set(0, 2.46, 0.02), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  b.box('armor', MASK.TRIM, 0.66, 0.20, 0.62, 0.03, 0, 2.40, 0.06);

  // --- exposed waist hydraulics + cabling --------------------------------
  for (let s = -1; s <= 1; s += 2) {
    piston(b, s * 0.42, 0.10, 0.30, s * 0.50, 0.72, 0.42, 0.062);
    piston(b, s * 0.46, 0.08, -0.26, s * 0.54, 0.66, -0.34, 0.055);
    if (d) {
      b.addM('mech', MASK.TRIM, cable([
        [s * 0.30, 0.02, 0.36], [s * 0.46, 0.28, 0.50], [s * 0.36, 0.72, 0.44],
      ], 0.045, 10, 6), null);
      b.addM('mech', MASK.TRIM, cable([
        [s * 0.20, 0.02, -0.30], [s * 0.34, 0.30, -0.44], [s * 0.26, 0.70, -0.36],
      ], 0.036, 10, 5), null);
    }
  }
  axleJoint(b, 'mech', MASK.STEEL, 0, 0.20, 0.0, 0.20, 1.06, 12);

  // --- surface detail ----------------------------------------------------
  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, 'pz', 0, 1.35, 0.84, W * 0.62, 1.05, rng, { cols: 4, rows: 4, depth: 0.05, accent: 0.14 });
    greebleFace(b, 'armor', MASK.TRIM, 'py', 0, 2.36, 0.30, W * 0.66, 0.44, rng, { cols: 4, rows: 2, depth: 0.035, fill: 0.65 });
    greebleFace(b, 'armor', MASK.TRIM, 'nz', 0, 2.05, -0.56, W * 0.60, 0.30, rng, { cols: 4, rows: 1, depth: 0.03, accent: 0.3 });
    if (!crude) {
      greebleFace(b, 'armor', MASK.TRIM, 'px', W * 0.5 + 0.01, 1.72, -0.30, 0.5, 0.5, rng, { cols: 2, rows: 2, depth: 0.04 });
      greebleFace(b, 'armor', MASK.TRIM, 'nx', -W * 0.5 - 0.01, 1.72, -0.30, 0.5, 0.5, rng, { cols: 2, rows: 2, depth: 0.04 });
    }
  }

  return {
    b,
    anchors: {
      neck: [0, 2.93, 0.02],
      shoulderL: [-sx, 1.72, 0.0],
      shoulderR: [sx, 1.72, 0.0],
      mountL: [-(sx - 0.26), 2.66, 0.02],
      mountR: [sx - 0.26, 2.66, 0.02],
      backpack: [0, 1.35, 0.62],
      coreMuzzle: [0, 1.30, -0.80],
    },
  };
}

// ---------------------------------------------------------------------------
// PELVIS — hip block, skirt armour, hip thrusters.
// ---------------------------------------------------------------------------

export function buildPelvis(o = {}) {
  const rng = o.rng;
  const d = o.detail !== 'low';
  const b = new GeoBuilder(rng);
  const hx = MECH_DIMS.hipX;

  b.box('armor', MASK.BASE, 1.24, 0.58, 0.94, 0.05, 0, 0.02, 0, 0, 0, 0, { taperX: 0.9, taperZ: 0.92 });
  b.box('mech', MASK.TRIM, 1.42, 0.30, 0.70, 0.035, 0, -0.14, 0);

  for (let s = -1; s <= 1; s += 2) {
    // hip actuator housing
    axleJoint(b, 'mech', MASK.TRIM, s * hx, -0.10, 0, 0.26, 0.36, 14);
    b.addM('armor', MASK.BASE, chamferCyl(0.30, 0.26, 0.22, 14, 0.03),
      _m.compose(_pv.set(s * (hx + 0.02), -0.10, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
    // skirt plates: front and rear, angled outward
    b.addM('armor', MASK.BASE, plate(beveledRectShape(0.50, 0.72, { bl: 0.20, br: 0.20 }), 0.10, 0.026),
      _m.compose(_pv.set(s * 0.40, -0.34, -0.50), _q.setFromEuler(_e.set(0.18, s * 0.22, 0)), _sc.set(1, 1, 1)));
    b.addM('armor', MASK.ACCENT, plate(beveledRectShape(0.46, 0.64, { bl: 0.18, br: 0.18 }), 0.10, 0.026),
      _m.compose(_pv.set(s * 0.44, -0.30, 0.48), _q.setFromEuler(_e.set(-0.16, s * -0.20, 0)), _sc.set(1, 1, 1)));
    // hip thruster: nozzle rearward + emissive core
    _q.setFromEuler(_e.set(Math.PI * 0.5 + 0.28, 0, 0));
    _pv.set(s * (hx + 0.10), 0.10, 0.42); _sc.set(1, 1, 1);
    _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, nozzle(0.10, 0.17, 0.20, 14), _m);
    _pv.set(s * (hx + 0.10), 0.115, 0.46); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.105, 0.10, 0.03, 14, 0.008), _m);
    if (d) boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.62, 0.02, 0, 0.18, 6, 0.024, 0.018);
  }

  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, 'pz', 0, 0.02, 0.48, 0.9, 0.42, rng, { cols: 4, rows: 2, depth: 0.035, accent: 0.2 });
    greebleFace(b, 'armor', MASK.TRIM, 'ny', 0, -0.30, 0, 0.9, 0.5, rng, { cols: 3, rows: 2, depth: 0.03, fill: 0.6 });
  }

  return { b, anchors: { hipL: [-hx, -0.10, 0], hipR: [hx, -0.10, 0] } };
}

// ---------------------------------------------------------------------------
// BACK BOOSTER PACK — two main bells, shoulder-blade verniers, radiators.
// ---------------------------------------------------------------------------

export function buildBackpack(o = {}) {
  const rng = o.rng;
  const d = o.detail !== 'low';
  const scale = o.scale ?? 1;
  const b = new GeoBuilder(rng);

  b.box('armor', MASK.BASE, 1.30, 1.05, 0.72, 0.06, 0, 0.10, 0.24, 0, 0, 0, { taperX: 0.88, taperZ: 0.8 });
  b.box('armor', MASK.TRIM, 1.05, 0.34, 0.52, 0.035, 0, 0.72, 0.22, -0.12, 0, 0);

  // main nozzles
  for (let s = -1; s <= 1; s += 2) {
    _q.setFromEuler(_e.set(Math.PI * 0.5 - 0.06, 0, 0));
    _pv.set(s * 0.40, -0.26, 0.48); _sc.set(scale, scale, scale);
    _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, nozzle(0.16, 0.30, 0.46, 20), _m);
    _pv.set(s * 0.40, -0.28, 0.55); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.155, 0.14, 0.05, 18, 0.012), _m);
    // gimbal collar
    _pv.set(s * 0.40, -0.20, 0.42); _sc.set(1, 1, 1); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, ring(0.20, 0.27, 0.14, 16, 0.02), _m);
    if (d) boltRing(b, 'mech', MASK.STEEL, 'pz', s * 0.40, -0.20, 0.44, 0.235, 8, 0.024, 0.016);
  }

  // shoulder-blade verniers
  for (let s = -1; s <= 1; s += 2) {
    _q.setFromEuler(_e.set(Math.PI * 0.5 - 0.55, 0, s * 0.32));
    _pv.set(s * 0.66, 0.52, 0.34); _sc.set(1, 1, 1);
    _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, nozzle(0.075, 0.135, 0.20, 14), _m);
    _pv.set(s * 0.70, 0.46, 0.40); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.072, 0.066, 0.03, 12, 0.008), _m);
    // radiator fin stack
    for (let i = 0; i < (d ? 5 : 2); i++) {
      b.box('mech', MASK.TRIM, 0.30, 0.045, 0.34, 0.01, s * 0.52, -0.28 + i * 0.10, -0.10, 0, 0, s * 0.06);
    }
  }

  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, 'pz', 0, 0.28, 0.60, 0.9, 0.7, rng, { cols: 3, rows: 3, depth: 0.045, accent: 0.2 });
    greebleFace(b, 'armor', MASK.TRIM, 'py', 0, 0.63, 0.24, 0.9, 0.42, rng, { cols: 4, rows: 2, depth: 0.035 });
    ventGrill(b, 'mech', MASK.TRIM, 'px', 0.66, 0.10, 0.24, 0.5, 0.5, 4, 0.08);
    ventGrill(b, 'mech', MASK.TRIM, 'nx', -0.66, 0.10, 0.24, 0.5, 0.5, 4, 0.08);
    for (let s = -1; s <= 1; s += 2) {
      b.addM('mech', MASK.TRIM, cable([
        [s * 0.30, -0.46, 0.10], [s * 0.44, -0.30, 0.34], [s * 0.40, -0.14, 0.44],
      ], 0.038, 8, 5), null);
    }
  }

  return {
    b,
    anchors: {
      nozzleL: [-0.40, -0.30, 0.62], nozzleR: [0.40, -0.30, 0.62],
      vernL: [-0.72, 0.44, 0.44], vernR: [0.72, 0.44, 0.44],
    },
  };
}

// ---------------------------------------------------------------------------
// ARMS. `s` is +1 for the right arm, -1 for the left. Bone origin is the
// shoulder pivot / elbow pivot respectively, geometry hangs down -Y.
// ---------------------------------------------------------------------------

export function buildUpperArm(o = {}) {
  const rng = o.rng;
  const s = o.side ?? 1;
  const d = o.detail !== 'low';
  const L = MECH_DIMS.elbowDrop;
  const b = new GeoBuilder(rng);

  // shoulder cap sits over the socket
  b.box('armor', MASK.BASE, 0.62, 0.50, 0.66, 0.05, 0, -0.06, 0, 0, 0, 0, { taperX: 1.05, taperZ: 1.05 });
  b.addM('mech', MASK.TRIM, ring(0.16, 0.25, 0.40, 14, 0.02),
    _m.compose(_pv.set(s * -0.16, -0.04, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));

  // upper arm armour, tapering into the elbow
  b.box('armor', MASK.BASE, 0.54, L * 0.82, 0.58, 0.05, 0, -L * 0.52, 0.0, 0, 0, 0,
    { taperX: 1.18, taperZ: 1.14 });
  // outer shell plate
  b.addM('armor', MASK.ACCENT, plate(beveledRectShape(0.80, 0.44, { tl: 0.20, bl: 0.10, tr: 0.20, br: 0.10 }), 0.10, 0.026),
    _m.compose(_pv.set(s * 0.30, -L * 0.48, 0), _q.setFromEuler(_e.set(0, s * Math.PI * 0.5, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  // inner actuator + hose
  b.addM('mech', MASK.TRIM, chamferCyl(0.10, 0.10, L * 0.7, 10, 0.02),
    _m.compose(_pv.set(s * -0.22, -L * 0.5, 0.06), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  if (d) {
    b.addM('mech', MASK.TRIM, cable([
      [s * -0.20, -0.12, 0.26], [s * -0.26, -L * 0.5, 0.32], [s * -0.18, -L * 0.94, 0.24],
    ], 0.040, 10, 6), null);
    greebleFace(b, 'armor', MASK.TRIM, s > 0 ? 'px' : 'nx', s * 0.29, -L * 0.5, 0.0, 0.44, 0.6, rng, { cols: 2, rows: 3, depth: 0.03, fill: 0.6 });
    greebleFace(b, 'armor', MASK.TRIM, 'pz', 0, -L * 0.5, 0.31, 0.4, 0.7, rng, { cols: 2, rows: 3, depth: 0.032, accent: 0.2 });
    boltRing(b, 'mech', MASK.TRIM, s > 0 ? 'px' : 'nx', s * 0.32, -0.06, 0, 0.20, 7, 0.024, 0.016);
  }
  return { b, anchors: { elbow: [0, -L, 0] } };
}

export function buildForeArm(o = {}) {
  const rng = o.rng;
  const s = o.side ?? 1;
  const d = o.detail !== 'low';
  const L = MECH_DIMS.wristDrop;
  const b = new GeoBuilder(rng);

  // --- exposed elbow: actuator drum + piston + cable loom -----------------
  axleJoint(b, 'mech', MASK.STEEL, 0, 0, 0, 0.19, 0.46, 14);
  b.addM('mech', MASK.TRIM, ring(0.19, 0.27, 0.30, 14, 0.02),
    _m.compose(_pv.set(s * 0.20, 0, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  piston(b, s * -0.10, 0.16, 0.22, s * -0.10, -0.46, 0.30, 0.048);
  if (d) {
    for (let i = -1; i <= 1; i += 2) {
      b.addM('mech', MASK.TRIM, cable([
        [s * 0.02 + i * 0.07, 0.20, 0.22], [s * 0.06 + i * 0.09, 0.0, 0.30], [s * 0.02 + i * 0.07, -0.30, 0.24],
      ], 0.028, 8, 5), null);
    }
    boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.24, 0, 0, 0.13, 6, 0.022, 0.014);
  }

  // --- forearm shell ------------------------------------------------------
  b.box('armor', MASK.BASE, 0.56, L * 0.80, 0.62, 0.05, 0, -L * 0.50, 0.0, 0, 0, 0,
    { taperX: 0.86, taperZ: 0.88 });
  b.box('armor', MASK.TRIM, 0.46, 0.22, 0.54, 0.03, 0, -0.20, 0.0);
  // top shell plate, overlapping
  b.addM('armor', MASK.BASE, plate(beveledRectShape(0.52, L * 0.66, { tl: 0.16, tr: 0.16, bl: 0.08, br: 0.08 }), 0.10, 0.026),
    _m.compose(_pv.set(0, -L * 0.50, -0.33), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));

  // --- weapon hardpoint on the OUTER face ---------------------------------
  const hx = s * 0.33;
  b.box('armor', MASK.ACCENT, 0.16, 0.62, 0.56, 0.03, hx, -L * 0.46, 0.0);
  b.box('mech', MASK.TRIM, 0.10, 0.44, 0.40, 0.02, s * 0.42, -L * 0.46, 0.0);
  for (let i = -1; i <= 1; i += 2) {
    b.addM('mech', MASK.STEEL, chamferCyl(0.035, 0.035, 0.48, 8, 0.01),
      _m.compose(_pv.set(s * 0.44, -L * 0.46, i * 0.15), _q.setFromEuler(_e.set(Math.PI * 0.5, 0, 0)), _sc.set(1, 1, 1)));
  }
  b.box('glow', MASK.BASE, 0.03, 0.05, 0.22, 0.008, s * 0.475, -L * 0.24, 0.0);

  // --- grip claw (weapons cover it, so keep it cheap but not empty) -------
  b.box('mech', MASK.TRIM, 0.34, 0.20, 0.36, 0.03, 0, -L * 0.94, 0.0);
  for (let i = -1; i <= 1; i += 2) {
    b.box('mech', MASK.TRIM, 0.09, 0.30, 0.10, 0.02, i * 0.11, -L - 0.12, -0.11, 0.30, 0, 0, { taperX: 0.7, taperZ: 0.7 });
    b.box('mech', MASK.TRIM, 0.09, 0.26, 0.10, 0.02, i * 0.11, -L - 0.10, 0.12, -0.34, 0, 0, { taperX: 0.7, taperZ: 0.7 });
  }
  b.addM('mech', MASK.STEEL, ring(0.10, 0.16, 0.10, 12, 0.015),
    _m.compose(_pv.set(0, -L * 0.86, 0), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));

  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, 'pz', 0, -L * 0.50, 0.32, 0.42, L * 0.6, rng, { cols: 2, rows: 4, depth: 0.03, accent: 0.15 });
    greebleFace(b, 'armor', MASK.TRIM, s > 0 ? 'nx' : 'px', s * -0.29, -L * 0.5, 0, 0.44, L * 0.6, rng, { cols: 2, rows: 3, depth: 0.028, fill: 0.55 });
    ventGrill(b, 'mech', MASK.TRIM, 'nz', 0, -L * 0.72, -0.32, 0.3, 0.26, 3, 0.05);
  }

  return { b, anchors: { muzzle: [s * 0.46, -L * 0.46, -0.62], wrist: [0, -L, 0] } };
}

// ---------------------------------------------------------------------------
// LEGS. Reverse-joint variants get a heavier shin shroud and a shorter foot,
// which is what actually sells the silhouette difference at distance.
// ---------------------------------------------------------------------------

export function buildThigh(o = {}) {
  const rng = o.rng;
  const s = o.side ?? 1;
  const rev = o.legType === 'reverse';
  const d = o.detail !== 'low';
  const L = MECH_DIMS.thigh;
  const b = new GeoBuilder(rng);

  // hip joint housing
  axleJoint(b, 'mech', MASK.TRIM, 0, 0, 0, 0.30, 0.52, 16);
  b.box('armor', MASK.BASE, 0.86, 0.52, 0.92, 0.055, 0, -0.18, 0, 0, 0, 0, { taperX: 0.94 });

  // main thigh mass
  b.box('armor', MASK.BASE, 0.80, L * 0.74, 0.90, 0.06, 0, -L * 0.50, rev ? 0.06 : -0.02, 0, 0, 0,
    { taperX: rev ? 1.06 : 0.86, taperZ: rev ? 1.02 : 0.88 });
  // outer / front armour plates
  b.addM('armor', MASK.ACCENT, plate(beveledRectShape(0.60, L * 0.60, { tl: 0.20, tr: 0.20, bl: 0.12, br: 0.12 }), 0.12, 0.03),
    _m.compose(_pv.set(0, -L * 0.48, (rev ? 0.52 : -0.48)), _q.setFromEuler(_e.set(0, rev ? Math.PI : 0, 0)), _sc.set(1, 1, 1)));
  b.addM('armor', MASK.BASE, plate(beveledRectShape(0.52, L * 0.52, { tl: 0.18, bl: 0.18, tr: 0.10, br: 0.10 }), 0.12, 0.03),
    _m.compose(_pv.set(s * 0.44, -L * 0.46, 0), _q.setFromEuler(_e.set(0, s * Math.PI * 0.5, 0)), _sc.set(1, 1, 1)));

  // knee actuator arm + hydraulics
  const kz = rev ? -0.34 : 0.34;
  piston(b, s * 0.0, -0.30, kz * 0.7, 0, -L + 0.22, kz, 0.070);
  b.box('mech', MASK.TRIM, 0.44, 0.34, 0.30, 0.03, 0, -L + 0.12, kz * 0.9);
  axleJoint(b, 'mech', MASK.TRIM, 0, -L, 0, 0.26, 0.60, 14);

  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, s > 0 ? 'px' : 'nx', s * 0.42, -L * 0.5, 0, 0.7, L * 0.5, rng, { cols: 3, rows: 3, depth: 0.035, fill: 0.6 });
    greebleFace(b, 'armor', MASK.TRIM, rev ? 'nz' : 'pz', 0, -L * 0.5, rev ? -0.44 : 0.44, 0.6, L * 0.5, rng, { cols: 3, rows: 3, depth: 0.04, accent: 0.16 });
    b.addM('mech', MASK.TRIM, cable([
      [s * 0.20, -0.16, kz * 0.8], [s * 0.26, -L * 0.5, kz * 1.05], [s * 0.18, -L + 0.14, kz * 0.9],
    ], 0.042, 10, 6), null);
    boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.30, 0, 0, 0.22, 8, 0.026, 0.018);
  }
  return { b, anchors: { knee: [0, -L, 0] } };
}

export function buildShin(o = {}) {
  const rng = o.rng;
  const s = o.side ?? 1;
  const rev = o.legType === 'reverse';
  const d = o.detail !== 'low';
  const L = MECH_DIMS.shin;
  const b = new GeoBuilder(rng);

  // knee cap
  b.box('armor', MASK.ACCENT, 0.62, 0.44, 0.56, 0.045, 0, -0.10, rev ? 0.24 : -0.24, 0, 0, 0, { taperZ: 0.9 });
  axleJoint(b, 'mech', MASK.STEEL, 0, 0, 0, 0.17, 0.68, 14);

  // structural shin core
  b.box('mech', MASK.TRIM, 0.56, L * 0.86, 0.60, 0.04, 0, -L * 0.50, 0);

  // LARGE armour shroud — the dominant leg silhouette element
  const shroudZ = rev ? 0.46 : -0.44;
  b.addM('armor', MASK.BASE, plate(beveledRectShape(0.94, L * 0.90, { tl: 0.30, tr: 0.30, bl: 0.22, br: 0.22 }), 0.20, 0.045),
    _m.compose(_pv.set(0, -L * 0.48, shroudZ), _q.setFromEuler(_e.set(rev ? -0.06 : 0.06, rev ? Math.PI : 0, 0)), _sc.set(1, 1, 1)));
  // side skirts wrapping the shroud
  for (let i = -1; i <= 1; i += 2) {
    b.box('armor', MASK.BASE, 0.16, L * 0.84, 0.78, 0.04, i * 0.40, -L * 0.50, shroudZ * 0.35, 0, 0, i * -0.05,
      { taperX: 0.8, taperZ: 0.86 });
  }
  b.box('armor', MASK.TRIM, 0.66, L * 0.5, 0.30, 0.035, 0, -L * 0.44, -shroudZ * 0.78);

  // ankle piston cluster
  for (let i = -1; i <= 1; i += 2) {
    piston(b, i * 0.20, -L * 0.42, shroudZ * 0.30, i * 0.24, -L + 0.10, shroudZ * 0.5, 0.052);
  }
  piston(b, 0, -L * 0.40, -shroudZ * 0.55, 0, -L + 0.12, -shroudZ * 0.62, 0.060);
  axleJoint(b, 'mech', MASK.TRIM, 0, -L, 0, 0.22, 0.52, 14);

  // ankle thruster
  _q.setFromEuler(_e.set(Math.PI * 0.5 - 0.30, 0, 0));
  _pv.set(0, -L * 0.62, -shroudZ * 0.9); _sc.set(1, 1, 1);
  _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.TRIM, nozzle(0.085, 0.15, 0.22, 14), _m);
  _pv.set(0, -L * 0.63, -shroudZ * 1.02); _m.compose(_pv, _q, _sc);
  b.addM('glow', MASK.BASE, chamferCyl(0.082, 0.076, 0.03, 12, 0.008), _m);
  b.box('glow', MASK.BASE, 0.04, 0.05, 0.30, 0.01, s * 0.47, -L * 0.55, shroudZ * 0.30);

  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, s > 0 ? 'px' : 'nx', s * 0.48, -L * 0.5, shroudZ * 0.35, 0.66, L * 0.55, rng, { cols: 3, rows: 3, depth: 0.032, fill: 0.6 });
    greebleFace(b, 'armor', MASK.TRIM, rev ? 'pz' : 'nz', 0, -L * 0.5, shroudZ * 1.12, 0.72, L * 0.6, rng, { cols: 3, rows: 4, depth: 0.038, accent: 0.16 });
    ventGrill(b, 'mech', MASK.TRIM, rev ? 'nz' : 'pz', 0, -L * 0.36, -shroudZ * 0.94, 0.44, 0.42, 4, 0.07);
    boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.35, 0, 0, 0.19, 8, 0.024, 0.016);
  }
  return { b, anchors: { ankle: [0, -L, 0] } };
}

export function buildFoot(o = {}) {
  const rng = o.rng;
  const s = o.side ?? 1;
  const rev = o.legType === 'reverse';
  const d = o.detail !== 'low';
  const b = new GeoBuilder(rng);
  // reverse-joint feet are shorter and more claw-like
  const len = rev ? 1.10 : 1.46;
  const fwd = rev ? -0.36 : -0.10;

  // ankle block
  b.box('mech', MASK.TRIM, 0.46, 0.30, 0.46, 0.035, 0, -0.16, 0);
  b.box('armor', MASK.BASE, 0.62, 0.26, 0.66, 0.04, 0, -0.26, 0.02, 0, 0, 0, { taperX: 1.1, taperZ: 1.05 });

  // sole
  b.box('armor', MASK.BASE, 0.88, 0.22, len, 0.05, 0, -0.40, fwd, 0, 0, 0,
    { taperFrontX: 0.74, taperZ: 1.0 });
  // toe plate, angled up
  b.box('armor', MASK.ACCENT, 0.66, 0.16, 0.42, 0.035, 0, -0.36, fwd - len * 0.50, -0.24, 0, 0, { taperFrontX: 0.7 });
  // heel plate + spur
  b.box('armor', MASK.BASE, 0.62, 0.20, 0.36, 0.035, 0, -0.34, fwd + len * 0.48, 0.20, 0, 0, { taperFrontX: 0.86 });
  b.box('mech', MASK.TRIM, 0.28, 0.34, 0.22, 0.03, 0, -0.30, fwd + len * 0.60, 0.35, 0, 0);

  // splay claws
  for (let i = -1; i <= 1; i += 2) {
    b.box('armor', MASK.BASE, 0.22, 0.16, 0.56, 0.03,
      i * 0.46, -0.40, fwd - len * 0.18, 0, i * -0.16, i * -0.22, { taperFrontX: 0.6 });
  }

  // ankle actuators
  for (let i = -1; i <= 1; i += 2) {
    piston(b, i * 0.18, 0.02, 0.0, i * 0.26, -0.34, fwd + len * 0.30, 0.042);
  }
  axleJoint(b, 'mech', MASK.STEEL, 0, -0.02, 0, 0.14, 0.44, 12);

  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, 'py', 0, -0.29, fwd + len * 0.10, 0.66, len * 0.5, rng, { cols: 3, rows: 3, depth: 0.028, fill: 0.55 });
    greebleFace(b, 'armor', MASK.TRIM, s > 0 ? 'px' : 'nx', s * 0.44, -0.40, fwd, 0.7, 0.16, rng, { cols: 4, rows: 1, depth: 0.026, accent: 0.3 });
    // sole grip pads
    for (let i = 0; i < 3; i++) {
      b.box('mech', MASK.TRIM, 0.66, 0.06, 0.14, 0.014, 0, -0.51, fwd - len * 0.28 + i * len * 0.28);
    }
  }
  return { b, anchors: {} };
}

// ---------------------------------------------------------------------------
// Non-humanoid bodies
// ---------------------------------------------------------------------------

/** Hovering drone: pod fuselage, ring thrusters, folded weapon arms. */
export function buildFlyerBody(o = {}) {
  const rng = o.rng;
  const d = o.detail !== 'low';
  const b = new GeoBuilder(rng);

  b.box('armor', MASK.BASE, 1.30, 0.86, 2.10, 0.09, 0, 0, 0, 0, 0, 0,
    { taperFrontX: 0.52, taperFrontY: 0.62, taperX: 0.9 });
  b.box('armor', MASK.ACCENT, 0.90, 0.26, 1.20, 0.04, 0, 0.44, 0.10, -0.06, 0, 0, { taperFrontX: 0.6 });
  // sensor cluster
  b.box('mech', MASK.TRIM, 0.52, 0.30, 0.20, 0.03, 0, 0.02, -1.00, 0.12, 0, 0);
  b.box('glow', MASK.BASE, 0.38, 0.16, 0.06, 0.015, 0, 0.02, -1.07, 0.12, 0, 0);

  for (let s = -1; s <= 1; s += 2) {
    // wing pylon
    b.box('armor', MASK.BASE, 1.05, 0.22, 0.90, 0.045, s * 1.00, 0.06, 0.26, 0, s * 0.14, s * -0.16,
      { taperFrontX: 0.7 });
    // ducted lift fan
    _q.setFromEuler(_e.set(0, 0, s * 0.10));
    _pv.set(s * 1.42, 0.02, 0.30); _sc.set(1, 1, 1); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, ring(0.34, 0.46, 0.34, 20, 0.04), _m);
    _pv.set(s * 1.42, -0.14, 0.30); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.33, 0.28, 0.04, 18, 0.01), _m);
    // rear thruster
    _q.setFromEuler(_e.set(Math.PI * 0.5, 0, 0));
    _pv.set(s * 0.42, 0.0, 0.98); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, nozzle(0.12, 0.21, 0.30, 16), _m);
    _pv.set(s * 0.42, 0.0, 1.06); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.115, 0.105, 0.04, 14, 0.01), _m);
    // chin weapon pod
    b.box('mech', MASK.TRIM, 0.26, 0.26, 0.70, 0.03, s * 0.36, -0.42, -0.50, 0, 0, 0);
    if (d) {
      greebleFace(b, 'armor', MASK.TRIM, 'py', s * 0.95, 0.18, 0.26, 0.8, 0.6, rng, { cols: 3, rows: 2, depth: 0.03, accent: 0.2 });
      boltRing(b, 'mech', MASK.STEEL, 'py', s * 1.42, 0.20, 0.30, 0.40, 10, 0.026, 0.016);
    }
  }
  if (d) {
    greebleFace(b, 'armor', MASK.TRIM, 'py', 0, 0.58, 0.40, 0.7, 0.7, rng, { cols: 3, rows: 3, depth: 0.035 });
    greebleFace(b, 'armor', MASK.TRIM, 'ny', 0, -0.44, 0.30, 0.9, 1.0, rng, { cols: 3, rows: 3, depth: 0.03, fill: 0.6 });
    ventGrill(b, 'mech', MASK.TRIM, 'pz', 0, 0.10, 1.02, 0.5, 0.5, 4, 0.08);
  }
  return { b, anchors: { muzzleL: [-0.36, -0.42, -0.90], muzzleR: [0.36, -0.42, -0.90] } };
}

/** Boss ordnance: rotating multi-barrel artillery array. */
export function buildCannonArray(o = {}) {
  const rng = o.rng;
  const barrels = o.barrels ?? 6;
  const b = new GeoBuilder(rng);
  b.addM('mech', MASK.TRIM, ring(0.30, 0.62, 0.50, 20, 0.05),
    _m.compose(_pv.set(0, 0, 0), _q.setFromEuler(_e.set(Math.PI * 0.5, 0, 0)), _sc.set(1, 1, 1)));
  b.box('armor', MASK.BASE, 1.30, 1.10, 0.80, 0.07, 0, 0, 0.42);
  for (let i = 0; i < barrels; i++) {
    const a = (i / barrels) * Math.PI * 2;
    const x = Math.cos(a) * 0.42, y = Math.sin(a) * 0.42;
    b.addM('mech', MASK.STEEL, chamferCyl(0.13, 0.115, 2.10, 12, 0.025),
      _m.compose(_pv.set(x, y, -1.05), _q.setFromEuler(_e.set(Math.PI * 0.5, 0, 0)), _sc.set(1, 1, 1)));
    b.addM('mech', MASK.TRIM, ring(0.115, 0.17, 0.16, 12, 0.02),
      _m.compose(_pv.set(x, y, -2.02), _q.setFromEuler(_e.set(Math.PI * 0.5, 0, 0)), _sc.set(1, 1, 1)));
  }
  b.box('glow', MASK.BASE, 0.9, 0.10, 0.05, 0.015, 0, 0.62, 0.02);
  greebleFace(b, 'armor', MASK.TRIM, 'pz', 0, 0, 0.83, 1.0, 0.8, rng, { cols: 3, rows: 3, depth: 0.05, accent: 0.2 });
  return { b, anchors: { muzzle: [0, 0, -2.20] } };
}

/** Boss defence: a huge layered tower shield with an emissive projector strip. */
export function buildShieldPlate(o = {}) {
  const rng = o.rng;
  const b = new GeoBuilder(rng);
  b.addM('armor', MASK.BASE, plate(beveledRectShape(2.30, 3.40, { tl: 0.70, tr: 0.70, bl: 0.45, br: 0.45 }), 0.34, 0.07),
    _m.compose(_pv.set(0, 0, 0), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  b.addM('armor', MASK.ACCENT, plate(beveledRectShape(1.40, 2.40, { tl: 0.45, tr: 0.45, bl: 0.30, br: 0.30 }), 0.20, 0.05),
    _m.compose(_pv.set(0, 0.10, -0.26), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  b.box('mech', MASK.TRIM, 0.50, 2.60, 0.40, 0.045, 0, 0, 0.30);
  b.box('glow', MASK.BASE, 0.14, 2.10, 0.05, 0.02, 0, 0.10, -0.40);
  for (let i = -1; i <= 1; i += 2) {
    piston(b, i * 0.30, 0.90, 0.44, i * 0.30, -0.90, 0.44, 0.075);
    greebleFace(b, 'armor', MASK.TRIM, 'nz', i * 0.78, 0.20, -0.20, 0.5, 2.0, rng, { cols: 2, rows: 6, depth: 0.05, accent: 0.14 });
  }
  boltRing(b, 'mech', MASK.STEEL, 'nz', 0, 0.10, -0.20, 0.92, 14, 0.036, 0.024);
  return { b, anchors: {} };
}
