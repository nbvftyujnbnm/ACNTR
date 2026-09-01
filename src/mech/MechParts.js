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
 *
 * Greebles take the colour of the plate they sit on (callers pass MASK.BASE) and
 * read through relief, AO and specular break-up. Tinting them dark, or sprinkling
 * hero-colour blocks through them, turns an armour panel into a mosaic of tiles —
 * which is the single loudest "hobby project" tell in a mech render.
 */
let GREEBLE_DENSITY = 1.5;
/** Global greeble multiplier — LOD and low-end quality presets turn this down. */
export function setGreebleDensity(v) { GREEBLE_DENSITY = Math.max(0, v); }

export function greebleFace(b, bucket, mask, face, cx, cy, cz, uSize, vSize, rng, opts = null) {
  const cols = Math.max(1, Math.round((opts?.cols ?? 4) * GREEBLE_DENSITY));
  const rows = Math.max(1, Math.round((opts?.rows ?? 3) * GREEBLE_DENSITY));
  const depth = opts?.depth ?? 0.035;
  const fill = opts?.fill ?? 0.72;
  const accentChance = opts?.accent ?? 0.03;
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
  shoulderY: 6.07, // waistY + buildCore's shoulder anchor
  neckY: 7.07,     // waistY + buildCore's neck anchor (top of the neck column)
  // Hip pivots sit 8 cm further outboard than they used to (0.72). The thigh
  // block is the widest part of the leg now, and it had to grow OUTBOARD:
  // growing it inboard would have eaten the gap between the legs, which is the
  // one hole this silhouette has always had. `footX` went out with it so the
  // stance keeps its splay — the legs still angle out from hip to sole, which
  // is what turns that gap into a wedge that stays open at a 3/4 camera.
  hipX: 0.80,
  footX: 1.14,
  // Shoulder PIVOT, not the outer edge of the shoulder. The arm's own armour
  // reaches ~0.33 m outboard of this and the pauldron caps it at ~1.61, so the
  // frame measures 3.2 m across the shoulders — 36% of its 9 m height. It used
  // to be 1.46, which put the outermost arm plate at 1.81 and the shoulders at
  // 40% of height: a slab that overhung a thin arm instead of capping a thick one.
  shoulderX: 1.26,
  thigh: 1.85,     // hipY - kneeY
  shin: 1.58,      // kneeY - ankleY
  // Arm length is set so the fingertips hang just past mid-thigh (3.03 m), which
  // is the AC silhouette. 1.50/1.60 put them at 2.69 — past the knee, and a
  // 3.1 m arm on a 0.52 m-wide upper arm is what read as "long and thin".
  // 1.40/1.48 lands the fingertips at ~2.91 with 30% more section on the arm.
  elbowDrop: 1.40,
  wristDrop: 1.48,
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

  // --- neck sleeve -------------------------------------------------------
  // The head bone's origin is the TOP of the core's neck column, and this sleeve
  // hangs below the origin and slides down over that column. It is the reason the
  // head cannot detach: the join is a telescoping overlap, not two surfaces meeting
  // at a plane, so it stays closed through the whole yaw/pitch range. (Previously
  // the head hung off a bare anchor 0.3 m clear of the collar and visibly floated.)
  b.addM('mech', MASK.TRIM, ring(0.32, 0.40, 0.40, 14, 0.03),
    _m.compose(_pv.set(0, -0.16, 0.01), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  // gorget: the armoured base plate the skull sits on, capping the sleeve
  b.box('armor', MASK.BASE, 0.60, 0.16, 0.66, 0.035, 0, 0.02, 0.0, 0, 0, 0,
    { taperX: 0.90, taperZ: 0.92 });

  // skull
  b.box('armor', MASK.BASE, 0.74, 0.58, 0.84, 0.055, 0, 0.37, -0.02, 0, 0, 0,
    { taperX: 0.88, taperZ: 0.94, taperFrontX: 0.82, taperFrontY: 0.9 });
  // crest / brow
  b.box('armor', MASK.ACCENT, 0.60, 0.15, 0.70, 0.035, 0, 0.70, -0.06, 0.09, 0, 0,
    { taperX: 0.7, taperZ: 0.72 });
  // rear cowl
  b.box('armor', MASK.BASE, 0.60, 0.44, 0.30, 0.04, 0, 0.38, 0.32, -0.12, 0, 0, { taperZ: 0.6 });
  // jaw
  b.box('mech', MASK.TRIM, 0.58, 0.20, 0.64, 0.03, 0, 0.10, -0.05, 0, 0, 0, { taperX: 0.8 });

  // visor housing + lens
  b.box('mech', MASK.TRIM, 0.70, 0.26, 0.12, 0.03, 0, 0.40, -0.41, 0.08, 0, 0);
  b.box('glow', MASK.BASE, 0.54, 0.125, 0.05, 0.018, 0, 0.40, -0.465, 0.08, 0, 0);
  // main optic: a real lens, not a glowing cube
  _e.set(Math.PI * 0.5, 0, 0); _q.setFromEuler(_e); _pv.set(0, 0.405, -0.48); _sc.set(1, 1, 1);
  _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.TRIM, ring(0.075, 0.115, 0.07, 14, 0.014), _m);
  _pv.set(0, 0.405, -0.49); _m.compose(_pv, _q, _sc);
  b.addM('glow', MASK.BASE, chamferCyl(0.078, 0.062, 0.05, 14, 0.014), _m);

  // chin sub-sensor
  b.box('mech', MASK.TRIM, 0.20, 0.16, 0.20, 0.025, 0, 0.10, -0.35, 0.35, 0, 0);
  b.box('glow', MASK.BASE, 0.11, 0.075, 0.04, 0.012, 0, 0.073, -0.44, 0.35, 0, 0);

  // cheek armour
  for (let s = -1; s <= 1; s += 2) {
    b.box('armor', MASK.BASE, 0.10, 0.40, 0.52, 0.028, s * 0.385, 0.37, -0.08, 0, 0, 0, { taperZ: 0.8 });
    // cooling fins — thin stacked plates, the classic AC head silhouette break
    const fins = crude ? 2 : 4;
    for (let i = 0; i < fins; i++) {
      b.box('mech', MASK.TRIM, 0.055, 0.105, 0.40, 0.012,
        s * 0.42, 0.23 + i * 0.135, 0.06, 0, 0, s * 0.12);
    }
    // antenna cluster
    if (!crude) {
      _e.set(-0.35, 0, s * 0.22); _q.setFromEuler(_e);
      _pv.set(s * 0.21, 0.88, 0.16); _sc.set(1, 1, 1);
      _m.compose(_pv, _q, _sc);
      b.addM('mech', MASK.TRIM, chamferCyl(0.028, 0.011, 0.62, 7, 0.006), _m);
      _pv.set(s * 0.29, 1.17, 0.28); _m.compose(_pv, _q, _sc);
      b.addM('glow', MASK.BASE, chamferCyl(0.017, 0.013, 0.05, 6, 0.005), _m);
    }
  }

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, 'py', 0, 0.655, 0.10, 0.50, 0.44, rng, { cols: 3, rows: 3, depth: 0.028, fill: 0.6 });
    greebleFace(b, 'armor', MASK.BASE, 'pz', 0, 0.37, 0.465, 0.48, 0.36, rng, { cols: 3, rows: 3, depth: 0.03, fill: 0.7, accent: 0.04 });
    ventGrill(b, 'mech', MASK.TRIM, 'pz', 0, 0.33, 0.455, 0.34, 0.24, 4, 0.06);
    boltRing(b, 'mech', MASK.TRIM, 'nz', 0, 0.405, -0.48, 0.155, 8, 0.019, 0.014);
    // neck hose bundle: runs from the gorget down over the sleeve
    for (let i = -1; i <= 1; i += 2) {
      b.addM('mech', MASK.TRIM, cable([
        [i * 0.17, 0.04, 0.24], [i * 0.23, -0.12, 0.32], [i * 0.16, -0.30, 0.24],
      ], 0.034, 6, 5), null);
    }
    // RANGEFINDER, left temple only. The single most recognisable piece of
    // Armored Core head furniture, and the cheapest asymmetry on the whole
    // frame: everything else up here is mirrored, so one boxy pod cantilevered
    // off one temple is what stops the head reading as a symmetrical helmet.
    // It hangs FORWARD of the cheek so it breaks the head's outline in profile
    // rather than sitting flush against it.
    if (!crude) {
      b.box('mech', MASK.TRIM, 0.09, 0.10, 0.13, 0.02, -0.42, 0.52, -0.22);
      b.box('armor', MASK.BASE, 0.15, 0.20, 0.34, 0.028, -0.50, 0.52, -0.32, 0, 0.14, -0.10,
        { taperFrontX: 0.78, taperFrontY: 0.82 });
      b.box('glow', MASK.BASE, 0.035, 0.10, 0.09, 0.012, -0.575, 0.53, -0.46, 0, 0.14, -0.10);
      // counterweight stub on the opposite temple — related hardware, not a mirror
      b.box('mech', MASK.TRIM, 0.10, 0.13, 0.18, 0.02, 0.45, 0.55, 0.10, 0, 0, 0.10);
    }
  }

  return { b, anchors: { optic: [0, 0.405, -0.49] }, top: 1.22 };
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
  const W = 1.86 * wide;

  // --- primary mass ------------------------------------------------------
  // Deliberately heavy: the chest is the single largest volume on an AC and
  // everything else has to look outgunned by it.
  // taperX 0.84, not 0.90: the flank has to fall AWAY from the arm as it climbs,
  // or the armpit closes. The arm hangs from y 1.72 with its inner face at 0.99,
  // and at 0.90 the hull was still 0.86-0.89 wide up there — a 0-3 cm joint that
  // read as one welded mass. At 0.84 the hull is 0.82 at the shoulder, so there
  // is 12-17 cm of daylight between torso and arm for the whole run.
  b.box('armor', MASK.BASE, W, 1.56, 1.40, 0.085, 0, 1.26, -0.04, 0, 0, 0,
    { taperX: 0.84, taperZ: 0.92, taperFrontX: 0.94 });
  // Upper deck the shoulders bolt onto, plus the collar step above it. Two
  // stacked masses instead of one 0.50-tall box: the chest-to-shoulder run was a
  // plain vertical wall, and a plain wall is what makes a torso read as a crate.
  b.box('armor', MASK.BASE, W * 0.90, 0.38, 1.14, 0.055, 0, 2.10, -0.02, 0, 0, 0, { taperX: 0.94, taperZ: 0.90 });
  b.box('armor', MASK.TRIM, W * 0.74, 0.20, 0.92, 0.035, 0, 2.38, 0.02, 0, 0, 0, { taperX: 0.88, taperZ: 0.88 });
  // Load buttresses: angled struts carrying the shoulder deck down onto the
  // waist. They break the flat flank with a diagonal, which is the line the
  // silhouette was missing between a narrow waist and a wide shoulder.
  for (let s = -1; s <= 1; s += 2) {
    b.box('armor', MASK.BASE, 0.20, 1.10, 0.46, 0.035, s * (W * 0.44), 1.44, -0.30, 0, 0, s * 0.16,
      { taperX: 0.7, taperZ: 0.86 });
    piston(b, s * (W * 0.40), 0.62, -0.36, s * (W * 0.46), 1.86, -0.26, 0.052);
  }
  // Lower waist block (narrow — the classic AC wasp waist). It plunges well below
  // the torso bone's origin so that pitching/twisting the torso can never open a
  // gap onto the pelvis underneath it.
  // 1.24, not 1.06: the wasp waist was pinching to 57% of the chest's width and
  // the frame read as an hourglass rather than as a machine. 67% still reads as a
  // waist against a 1.86 m chest, and it stops the torso looking like it is about
  // to snap at the belt line from hero distance.
  b.box('mech', MASK.TRIM, 1.24, 0.80, 1.02, 0.045, 0, 0.14, 0.0, 0, 0, 0, { taperX: 1.10, taperZ: 1.08 });
  // rear spine housing
  b.box('armor', MASK.TRIM, W * 0.80, 1.45, 0.34, 0.045, 0, 1.38, 0.70, -0.05, 0, 0);

  // --- layered front plates (overlap = depth) ----------------------------
  // Tracks the primary mass's front face (z = -0.04 - 1.40/2) so the plates sit
  // proud of the hull instead of sinking into it.
  const frontZ = -0.74;
  b.addM('armor', MASK.BASE, plate(beveledRectShape(W * 0.72, 0.80, { tl: 0.20, tr: 0.20, bl: 0.10, br: 0.10 }), 0.12, 0.03),
    _m.compose(_pv.set(0, 1.62, frontZ - 0.02), _q.setFromEuler(_e.set(-0.10, 0, 0)), _sc.set(1, 1, 1)));
  b.addM('armor', MASK.ACCENT, plate(beveledRectShape(W * 0.50, 0.44, 0.14), 0.10, 0.028),
    _m.compose(_pv.set(0, 0.90, frontZ + 0.04), _q.setFromEuler(_e.set(0.14, 0, 0)), _sc.set(1, 1, 1)));
  for (let s = -1; s <= 1; s += 2) {
    b.addM('armor', MASK.BASE, plate(beveledRectShape(0.42, 1.05, { tl: 0.16, bl: 0.16, tr: 0.06, br: 0.24 }), 0.11, 0.028),
      _m.compose(_pv.set(s * W * 0.40, 1.30, frontZ + 0.06), _q.setFromEuler(_e.set(0, s * 0.30, 0)), _sc.set(1, 1, 1)));
  }

  // --- central reactor intake -------------------------------------------
  // The emissive core sits BEHIND the vent slats and is deliberately small — a
  // hot glow leaking between louvres. Scaled up to fill the whole housing it
  // stopped reading as a reactor and became a chest lamp: a blown white square
  // that was the brightest object in every frame the mech appeared in.
  b.box('mech', MASK.TRIM, 0.56, 0.62, 0.16, 0.03, 0, 1.30, frontZ - 0.03);
  b.box('glow', MASK.BASE, 0.30, 0.34, 0.05, 0.015, 0, 1.30, frontZ - 0.055);
  // light channels flanking the intake, set into the chest plate
  for (let s = -1; s <= 1; s += 2) {
    b.box('mech', MASK.TRIM, 0.10, 0.52, 0.10, 0.02, s * 0.42, 1.30, frontZ - 0.02);
    b.box('glow', MASK.BASE, 0.04, 0.40, 0.04, 0.010, s * 0.42, 1.30, frontZ - 0.075);
  }
  ventGrill(b, 'mech', MASK.TRIM, 'nz', 0, 1.30, frontZ - 0.09, 0.44, 0.50, 5, 0.10);
  boltRing(b, 'mech', MASK.TRIM, 'nz', 0, 1.30, frontZ - 0.04, 0.36, 10, 0.022, 0.016);
  // Side heat sinks. X positions follow the tapered flank rather than the box's
  // nominal half-width — the hull narrows toward the top, so anything pinned to
  // W*0.5 up there floats several centimetres clear of the surface.
  for (let s = -1; s <= 1; s += 2) {
    ventGrill(b, 'mech', MASK.TRIM, s > 0 ? 'px' : 'nx', s * (W * 0.485), 1.05, 0.10, 0.62, 0.46, 4, 0.09);
    // raised bezel, then the light channel set into its outer face
    b.box('armor', MASK.ACCENT, 0.08, 0.16, 0.64, 0.022, s * (W * 0.465), 1.62, 0.02);
    b.box('glow', MASK.BASE, 0.03, 0.075, 0.50, 0.010, s * (W * 0.484), 1.62, 0.02);
  }

  // --- shoulder yokes ----------------------------------------------------
  // Everything here is placed relative to the shoulder PIVOT (`sx`), and the
  // whole cluster now sits further inboard and reaches less far outboard: the
  // yoke's outer face is at sx+0.27 and the pauldron caps it at sx+0.35, where
  // the previous build ran the yoke to sx+0.16 and let the ARM's own plating
  // stick out past it to sx+0.35. A pauldron that a thin arm pokes out of reads
  // as an overhanging slab; a pauldron that caps a thick arm reads as a shoulder.
  const sx = MECH_DIMS.shoulderX * wide;
  for (let s = -1; s <= 1; s += 2) {
    // STEPPED yoke. This used to be one 0.90 x 0.90 x 1.16 box, which from the
    // front was a plain slab with a single silhouette edge — the shape reads as a
    // placeholder no matter how good the texture on it is. It is now three
    // stacked masses with the upper two set BACK, so the front profile is a
    // staircase and the top of the shoulder catches a separate highlight.
    b.box('armor', MASK.BASE, 0.90, 0.52, 1.16, 0.06, s * (sx - 0.30), 1.86, 0.02, 0, 0, s * -0.06,
      { taperX: 0.94, taperZ: 0.94 });
    // DAYLIGHT SLOT. The upper mass is lifted 12 cm clear of the lower one and
    // carried on two short posts, so an 11 cm slot runs right through the top of
    // each shoulder. This is the only gap on the frame that is guaranteed to have
    // SKY behind it rather than more mech: it is above the torso's shoulder line
    // and outboard of the neck, so at hero framing (80 px/m) it is ~9 px of
    // background cutting the widest part of the silhouette in half. Stacking the
    // two blocks flush, as they were, is what made the torso and both yokes read
    // as one filled rectangle no matter how much surface detail went on them.
    b.box('armor', MASK.BASE, 0.84, 0.34, 0.96, 0.05, s * (sx - 0.32), 2.40, 0.10, 0, 0, s * -0.06,
      { taperX: 0.90 });
    for (let r = -1; r <= 1; r += 2) {
      b.box('mech', MASK.TRIM, 0.16, 0.16, 0.22, 0.02, s * (sx - 0.32), 2.175, 0.10 + r * 0.30);
    }
    // forward nose block, dropped and raked: the step you actually see head-on
    b.box('armor', MASK.TRIM, 0.66, 0.30, 0.34, 0.04, s * (sx - 0.32), 2.03, -0.50, -0.22, 0, s * -0.06,
      { taperFrontX: 0.82, taperFrontY: 0.8 });
    // NEGATIVE SPACE. The yoke's outer face stops at sx+0.15 and the pauldron's
    // inner face starts at sx+0.255, so there is a 10 cm daylight gap between
    // them bridged by two brackets. The pauldron now reads as ARMOUR HUNG OFF a
    // shoulder on visible hardware, which is how AC shoulders are built; before,
    // yoke and plate were one continuous lump and the joint was invisible.
    for (let r = -1; r <= 1; r += 2) {
      b.box('mech', MASK.TRIM, 0.20, 0.17, 0.22, 0.022, s * (sx + 0.28), 2.06, r * 0.30, 0, 0, 0);
    }
    // Outer pauldron plate. Moved out with the arm pivot below (sx+0.10) so it
    // still CAPS the arm: its outer face sits at 1.705 and the arm's outermost
    // plating at 1.70. If these two ever swap order the pauldron turns back into
    // an overhanging slab with a thin arm poking through it.
    b.addM('armor', MASK.ACCENT, plate(beveledRectShape(0.96, 0.76, { tl: 0.26, tr: 0.10, bl: 0.20, br: 0.10 }), 0.13, 0.03),
      _m.compose(_pv.set(s * (sx + 0.38), 2.06, 0.0), _q.setFromEuler(_e.set(0, s * Math.PI * 0.5, 0)), _sc.set(1, 1, 1)));
    // Raised centre panel on the pauldron. This is the mech's hero colour on its
    // largest single face, and flat accent paint on a flat plane reads as a
    // coloured decal rather than as armour — the one part of the frame a reviewer
    // called "a plain red shape". A 5 cm step gives it a cast shadow along two
    // edges and a lit chamfer along the other two, at 4 triangles' worth of cost.
    // It also restores the ordering the yoke depends on: its face lands at 1.755
    // and the arm's outermost plating at 1.715, so the pauldron still caps the arm.
    b.addM('armor', MASK.ACCENT, plate(beveledRectShape(0.54, 0.42, { tl: 0.14, tr: 0.06, bl: 0.10, br: 0.06 }), 0.07, 0.022),
      _m.compose(_pv.set(s * (sx + 0.46), 2.08, 0.04), _q.setFromEuler(_e.set(0, s * Math.PI * 0.5, 0)), _sc.set(1, 1, 1)));
    if (d) boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * (sx + 0.50), 2.08, 0.04, 0.20, 5, 0.024, 0.016);
    // HARDPOINT RAIL, standing off the shoulder on two pylons.
    //
    // This used to be a 0.14 base plate with a 0.10 riser sat flush on top of it,
    // and the ordnance anchor 6 cm above that. Everything from the waist to the
    // top of the shoulder was therefore ONE unbroken filled rectangle: from hero
    // distance the torso, both yokes and both weapon decks read as a single crate
    // with no sky anywhere inside the outline. Real ACs hang their ordnance off
    // visible hardware and you see daylight under it, which is most of what makes
    // the silhouette read as a machine rather than a box.
    //
    // Base plate on the yoke, two pylons with a 27 cm gap between them, and the
    // rail the ordnance actually bolts to 35 cm above the plate. The two open
    // slots are 27 cm and 2 x 10 cm — at hero framing (78 px per metre) that is
    // 8-21 px of visible sky per shoulder.
    // (all of this moved up 12 cm with the yoke's upper block below it)
    const mx = s * (sx - 0.16);
    b.box('armor', MASK.TRIM, 0.52, 0.13, 0.74, 0.028, mx, 2.62, 0.02);
    for (let r = -1; r <= 1; r += 2) {
      b.box('mech', MASK.TRIM, 0.16, 0.34, 0.17, 0.022, mx, 2.86, 0.02 + r * 0.22);
    }
    b.box('armor', MASK.TRIM, 0.44, 0.10, 0.68, 0.024, mx, 3.08, 0.02);
    // tie-down cleats on the rail, so it reads as a mount and not a floating slab
    if (d) boltRing(b, 'mech', MASK.STEEL, 'py', mx, 3.13, 0.02, 0.17, 6, 0.022, 0.014);
    // status light channel recessed into the pauldron's leading edge
    b.box('mech', MASK.TRIM, 0.10, 0.14, 0.30, 0.02, s * (sx + 0.31), 2.30, -0.34);
    b.box('glow', MASK.BASE, 0.05, 0.075, 0.24, 0.012, s * (sx + 0.37), 2.30, -0.34);
    // Shoulder socket — sits ON the arm pivot (sx + 0.10), so it must move with
    // the anchor in `anchors.shoulderL/R` below, never independently.
    axleJoint(b, 'mech', MASK.TRIM, s * (sx + 0.10), 1.72, 0.0, 0.30, 0.34, 14);
    if (d) {
      boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * (sx + 0.30), 1.72, 0.0, 0.21, 8, 0.026, 0.02);
      greebleFace(b, 'armor', MASK.BASE, 'py', s * (sx - 0.32), 2.57, 0.10, 0.66, 0.4, rng, { cols: 3, rows: 2, depth: 0.04, fill: 0.7 });
      greebleFace(b, 'armor', MASK.BASE, 'pz', s * (sx - 0.30), 1.86, 0.60, 0.72, 0.40, rng, { cols: 3, rows: 2, depth: 0.045, accent: 0.04 });
      // EDGE BUSYNESS: a lifting eye and a hose run that project past the yoke's
      // outline. Detail painted on a flat face does nothing for a silhouette —
      // only geometry that crosses the outline against the sky does.
      // Lifting eye half-sunk into the raised block's top face (2.57), and a hose
      // run that now arcs OVER the block instead of through where the slot is.
      b.addM('mech', MASK.STEEL, ring(0.055, 0.095, 0.05, 10, 0.012),
        _m.compose(_pv.set(s * (sx - 0.42), 2.60, 0.22), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
      b.addM('mech', MASK.TRIM, cable([
        [s * (sx - 0.58), 2.62, 0.46], [s * (sx - 0.30), 2.84, 0.54], [s * (sx + 0.06), 2.66, 0.44],
      ], 0.034, 10, 5), null);
    }
  }

  // --- ASYMMETRIC FLANK ASSEMBLIES ---------------------------------------
  // The torso was a mirror of itself from the waist up, and its flanks between
  // the hip and the shoulder were an unbroken tapered box — the two things a
  // reviewer means by "procedural robot, not an Armored Core". Real ACs carry
  // DIFFERENT hardware on their two flanks, and that hardware stands proud of
  // the hull so the waist-to-shoulder run has a profile instead of an edge.
  //
  // Both assemblies live in the rear third of the flank (z 0.30..0.60), clear of
  // the raked strake at z -0.30 and the heat-sink vent at z -0.21..0.41, and both
  // run y 0.9..2.0 so they physically bridge waist to shoulder. The hull tapers
  // inward with height and these do not, so each one emerges further from the
  // surface as it climbs — the profile widens toward the shoulder for free.
  // OUTBOARD BUDGET: nothing in this block may pass x = 0.96. The upper arm's
  // inner face is at 0.99 and the armpit gap is the whole point of the taper
  // above — hardware that reaches past 0.96 does not "stand proud of the hull",
  // it is buried inside the arm. The previous values ran the conduit to 1.00,
  // the header tank to 1.07 and the bleed line to 1.15, i.e. up to 16 cm INSIDE
  // the upper arm, which is also why the shoulder read as one solid mass.
  if (d && !crude) {
    // RIGHT: armoured coolant conduit, clamped to the hull at three points.
    const cz = 0.44;
    b.box('mech', MASK.TRIM, 0.19, 1.26, 0.23, 0.028, W * 0.455, 1.38, cz, 0.05, 0, 0);
    // header tank capping it under the shoulder
    b.box('armor', MASK.BASE, 0.25, 0.32, 0.31, 0.035, W * 0.45, 2.02, cz - 0.03, 0, 0, -0.09,
      { taperX: 0.86 });
    for (let i = 0; i < 3; i++) {
      b.addM('mech', MASK.STEEL, ring(0.115, 0.145, 0.055, 10, 0.012),
        _m.compose(_pv.set(W * 0.425, 1.00 + i * 0.38, cz), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
    }
    // Bleed line running off the header, out past the hull's outline. Its high
    // point used to reach x 0.962 at y 6.15, which is 1 cm from the upper arm's
    // shoulder collar — inside the tolerance the arm's own roll eats when it
    // swings. Pulled to 0.930 so the clearance survives the animation.
    b.addM('mech', MASK.TRIM, cable([
      [W * 0.44, 1.96, cz - 0.16], [W * 0.475, 1.80, cz - 0.34], [W * 0.45, 1.52, cz - 0.30],
    ], 0.032, 10, 5), null);

    // LEFT: a countermeasure/ammo box — a different SHAPE, not a mirrored one.
    // Sits ABOVE and BEHIND the flank heat sink (which occupies y 0.82..1.28,
    // z -0.21..0.41) so it never grows out of the vent bezel, and its hinged lid
    // is the accent slot so it reads as a serviceable sub-assembly.
    b.box('armor', MASK.BASE, 0.26, 0.62, 0.36, 0.04, -W * 0.45, 1.52, 0.48, 0, 0, 0.06,
      { taperZ: 0.94 });
    b.box('armor', MASK.ACCENT, 0.28, 0.10, 0.38, 0.022, -W * 0.45, 1.87, 0.48, 0, 0, 0.06);
    // stub exhaust off its back face, canted down and outboard
    _e.set(Math.PI * 0.5 - 0.5, 0, -0.30); _q.setFromEuler(_e); _sc.set(1, 1, 1);
    _pv.set(-W * 0.485, 1.34, 0.64); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, nozzle(0.055, 0.095, 0.17, 12), _m);
    boltRing(b, 'mech', MASK.STEEL, 'nx', -W * 0.485, 1.52, 0.48, 0.14, 6, 0.022, 0.014);

    // Whip antenna off the RIGHT yoke's rear corner, raked back and outboard.
    // A 1.2 m mast against the sky is worth more to a silhouette than any amount
    // of surface detail, and it costs 60 triangles.
    _e.set(-0.24, 0, -0.20); _q.setFromEuler(_e);
    _pv.set(sx + 0.10, 2.94, 0.52); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, chamferCyl(0.026, 0.008, 1.16, 5, 0.007), _m);
    _pv.set(sx + 0.22, 3.50, 0.66); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.016, 0.012, 0.05, 6, 0.005), _m);
    // and a stubby blade antenna on the LEFT yoke, so the two never match
    b.box('mech', MASK.TRIM, 0.045, 0.46, 0.20, 0.014, -(sx + 0.06), 2.72, 0.44, -0.16, 0, 0.10,
      { taperX: 0.5, taperZ: 0.6 });
  }

  // --- neck: a load-bearing column, not an anchor point -------------------
  // The head bone origin is the TOP of this column (anchors.neck below) and the
  // head's sleeve slides down over it, so there is a 0.3 m telescoping overlap
  // holding the join closed at every head angle. The previous build had the head
  // pinned to a bare point 0.34 m clear of the collar with nothing between them,
  // which is exactly what "the head is floating" looked like.
  // Collar plate is wider than the head's sleeve (r 0.40) so the sleeve emerges
  // from a recess in it rather than clipping through its edges.
  b.box('armor', MASK.TRIM, 0.98, 0.26, 0.92, 0.035, 0, 2.30, 0.04, 0, 0, 0, { taperX: 0.86, taperZ: 0.88 });
  // flange around the column BASE, clear of the sleeve's travel
  b.addM('mech', MASK.TRIM, ring(0.30, 0.44, 0.18, 16, 0.025),
    _m.compose(_pv.set(0, 2.14, 0.02), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  b.addM('mech', MASK.TRIM, chamferCyl(0.28, 0.255, 0.66, 14, 0.035),
    _m.compose(_pv.set(0, 2.42, 0.02), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  // hydraulic neck jacks, outboard of the sleeve so they stay visible
  for (let s = -1; s <= 1; s += 2) {
    piston(b, s * 0.50, 2.18, 0.30, s * 0.40, 2.60, 0.22, 0.048);
  }

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
  // Waist axle. TRIM, not STEEL: a polished 1 m chrome cylinder across the front
  // of the pelvis is the brightest thing on the whole mech and reads as a codpiece.
  axleJoint(b, 'mech', MASK.TRIM, 0, 0.20, 0.0, 0.20, 1.06, 12);

  // --- surface detail ----------------------------------------------------
  if (d) {
    greebleFace(b, 'armor', MASK.BASE, 'pz', 0, 1.38, 0.86, W * 0.62, 1.10, rng, { cols: 4, rows: 4, depth: 0.05, accent: 0.04 });
    greebleFace(b, 'armor', MASK.BASE, 'py', 0, 2.40, 0.32, W * 0.62, 0.42, rng, { cols: 4, rows: 2, depth: 0.035, fill: 0.65 });
    greebleFace(b, 'armor', MASK.BASE, 'nz', 0, 2.08, -0.58, W * 0.58, 0.30, rng, { cols: 4, rows: 1, depth: 0.03, accent: 0.04 });
    if (!crude) {
      // y = 1.05 is low enough on the flank that the taper has barely started,
      // so these sit ON the hull rather than hovering off the narrowed top.
      greebleFace(b, 'armor', MASK.BASE, 'px', W * 0.478, 1.05, -0.34, 0.5, 0.5, rng, { cols: 2, rows: 2, depth: 0.04 });
      greebleFace(b, 'armor', MASK.BASE, 'nx', -W * 0.478, 1.05, -0.34, 0.5, 0.5, rng, { cols: 2, rows: 2, depth: 0.04 });
    }
  }

  return {
    b,
    anchors: {
      // top of the neck column — the head's sleeve overlaps 0.3 m of it
      neck: [0, 2.72, 0.02],
      // Arm pivot, set OUTBOARD of the yoke reference `sx` on purpose. The arm
      // used to hang at exactly sx, which put its inner face 4 cm INSIDE the
      // torso flank: no armpit, and the flank hardware physically intersected
      // the upper arm. At sx + 0.10 the inner face clears the hull by 12-17 cm.
      // The shoulder socket, the pauldron and its brackets are all placed off
      // the same offset above — move one and you must move all of them.
      shoulderL: [-(sx + 0.10), 1.72, 0.0],
      shoulderR: [sx + 0.10, 1.72, 0.0],
      // top of the raised hardpoint rail, not the top of the yoke
      mountL: [-(sx - 0.16), 3.14, 0.02],
      mountR: [sx - 0.16, 3.14, 0.02],
      backpack: [0, 1.38, 0.66],
      coreMuzzle: [0, 1.30, -0.86],
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

  // Hip block, widened with the waist above and the legs below it. The pelvis is
  // where the frame's mass has to visibly transfer into the legs; at 1.24 it was
  // narrower than the waist block sitting on top of it, which is why the whole
  // middle of the mech read as a taper down to nothing.
  b.box('armor', MASK.BASE, 1.52, 0.62, 1.06, 0.055, 0, 0.02, 0, 0, 0, 0, { taperX: 0.9, taperZ: 0.92 });
  b.box('mech', MASK.TRIM, 1.68, 0.32, 0.80, 0.035, 0, -0.14, 0);

  for (let s = -1; s <= 1; s += 2) {
    // Hip actuator housing. Tighter than it was (0.26/0.30) because the thigh
    // no longer reaches up to meet it: there is a 22 cm horizontal slot of
    // daylight between this housing and the top of the thigh block, and a fat
    // housing simply fills the hole back in. See buildThigh.
    axleJoint(b, 'mech', MASK.TRIM, s * hx, -0.10, 0, 0.22, 0.34, 14);
    b.addM('armor', MASK.BASE, chamferCyl(0.26, 0.23, 0.20, 14, 0.03),
      _m.compose(_pv.set(s * (hx + 0.03), -0.10, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
    // skirt plates: front and rear, angled outward
    b.addM('armor', MASK.BASE, plate(beveledRectShape(0.60, 0.80, { bl: 0.22, br: 0.22 }), 0.11, 0.028),
      _m.compose(_pv.set(s * 0.50, -0.36, -0.54), _q.setFromEuler(_e.set(0.18, s * 0.22, 0)), _sc.set(1, 1, 1)));
    // Hardware ON the front skirt. This is the largest unbroken plate on the
    // whole frame and it hangs clear of the hip cavity, so it is the one surface
    // the sky can reach unoccluded — measured at 129,127,129 in the hero frame
    // while the armour immediately behind it sat at 28,31,45. A plate that
    // bright cannot also be empty or it reads as a blank shield bolted to the
    // pelvis. Greebles cannot be used here (the plate is rotated on two axes and
    // greebleFace only builds axis-aligned frames), so the detail is placed by
    // composing the plate's own transform and then translating along its face.
    if (d) {
      _q.setFromEuler(_e.set(0.18, s * 0.22, 0)); _sc.set(1, 1, 1);
      const onSkirt = (bucket, mask, geo, lx, ly) => {
        _pv.set(s * 0.44, -0.34, -0.50);
        _m.compose(_pv, _q, _sc);
        _mr.makeTranslation(lx, ly, -0.072);
        _m.multiply(_mr);
        b.addM(bucket, mask, geo, _m);
      };
      onSkirt('armor', MASK.BASE, chamferBox(0.11, 0.20, 0.05, 0.012), -0.13, 0.12);
      onSkirt('armor', MASK.BASE, chamferBox(0.09, 0.13, 0.045, 0.011), 0.02, 0.19);
      onSkirt('armor', MASK.BASE, chamferBox(0.13, 0.16, 0.05, 0.012), 0.14, 0.08);
      // stencilled hazard strip: the accent slot, so it also breaks the hue
      onSkirt('armor', MASK.ACCENT, chamferBox(0.34, 0.065, 0.035, 0.010), 0, -0.10);
      onSkirt('mech', MASK.TRIM, chamferBox(0.30, 0.05, 0.04, 0.010), 0, -0.22);
    }
    b.addM('armor', MASK.BASE, plate(beveledRectShape(0.56, 0.72, { bl: 0.20, br: 0.20 }), 0.11, 0.028),
      _m.compose(_pv.set(s * 0.54, -0.32, 0.52), _q.setFromEuler(_e.set(-0.16, s * -0.20, 0)), _sc.set(1, 1, 1)));
    // hip thruster: nozzle rearward + emissive core
    _q.setFromEuler(_e.set(Math.PI * 0.5 + 0.28, 0, 0));
    _pv.set(s * (hx + 0.10), 0.10, 0.42); _sc.set(1, 1, 1);
    _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, nozzle(0.10, 0.17, 0.20, 14), _m);
    _pv.set(s * (hx + 0.10), 0.115, 0.46); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.105, 0.10, 0.03, 14, 0.008), _m);
    if (d) boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.68, 0.02, 0, 0.18, 6, 0.024, 0.018);
  }

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, 'pz', 0, 0.02, 0.48, 0.9, 0.42, rng, { cols: 4, rows: 2, depth: 0.035, accent: 0.04 });
    greebleFace(b, 'armor', MASK.BASE, 'ny', 0, -0.30, 0, 0.9, 0.5, rng, { cols: 3, rows: 2, depth: 0.03, fill: 0.6 });
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
    // --- silhouette breakers ----------------------------------------------
    // Antenna mast, sensor boom and a rear hook. All three exist to cross the
    // OUTLINE: an AC is recognisable at 200 m by the spikes and booms coming off
    // its back, and this pack was a smooth box with the fins buried inside it.
    // The boom is deliberately on one side only — more asymmetry.
    _e.set(-0.30, 0, 0.16); _q.setFromEuler(_e); _sc.set(1, 1, 1);
    _pv.set(-0.52, 0.86, 0.44); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, chamferCyl(0.030, 0.010, 0.98, 6, 0.008), _m);
    _pv.set(-0.66, 1.34, 0.60); _m.compose(_pv, _q, _sc);
    b.addM('glow', MASK.BASE, chamferCyl(0.018, 0.014, 0.05, 6, 0.005), _m);
    // sensor boom + dish, right side only
    _e.set(-0.62, 0, -0.34); _q.setFromEuler(_e);
    _pv.set(0.60, 0.72, 0.40); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, chamferCyl(0.036, 0.028, 0.62, 7, 0.01), _m);
    _pv.set(0.78, 1.02, 0.52); _q.setFromEuler(_e.set(-1.05, 0, -0.34)); _m.compose(_pv, _q, _sc);
    b.addM('mech', MASK.TRIM, revolve([[0, 0], [0.14, 0.02], [0.17, 0.09], [0.10, 0.10], [0, 0.04]], 12), _m);
    // rear towing hook, projecting past the pack's back face
    b.box('mech', MASK.STEEL, 0.12, 0.10, 0.34, 0.02, 0.30, -0.10, 0.72, 0.34, 0, 0);
    b.box('mech', MASK.STEEL, 0.12, 0.24, 0.10, 0.02, 0.30, -0.24, 0.86, 0, 0, 0);

    greebleFace(b, 'armor', MASK.BASE, 'pz', 0, 0.28, 0.60, 0.9, 0.7, rng, { cols: 3, rows: 3, depth: 0.045, accent: 0.04 });
    greebleFace(b, 'armor', MASK.BASE, 'py', 0, 0.63, 0.24, 0.9, 0.42, rng, { cols: 4, rows: 2, depth: 0.035 });
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

  // Shoulder ball: a machined steel sphere-ish drum riding in the core's socket.
  // Without a visible pivot the arm looks glued to the pauldron rather than hung
  // from it, which is most of why the old arms read as stubs.
  b.addM('mech', MASK.STEEL, chamferCyl(0.28, 0.28, 0.52, 14, 0.10),
    _m.compose(_pv.set(0, 0, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  // shoulder cap sits over the socket
  b.box('armor', MASK.BASE, 0.68, 0.56, 0.84, 0.055, 0, -0.12, 0, 0, 0, 0, { taperX: 1.02, taperZ: 1.04 });
  b.addM('mech', MASK.TRIM, ring(0.18, 0.28, 0.46, 14, 0.022),
    _m.compose(_pv.set(s * -0.20, -0.06, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));

  // Upper arm armour. 0.66 x 0.78 in section against a 1.40 m drop: an AC's
  // upper arm is a short thick limb, not a rod. At the previous 0.52 x 0.56 over
  // 1.50 m the aspect ratio was 1:2.9 and it read as tubing bolted to a pauldron
  // — the single loudest proportion tell in the hero frame.
  b.box('armor', MASK.BASE, 0.66, L * 0.86, 0.78, 0.055, 0, -L * 0.52, 0.0, 0, 0, 0,
    // taperX 1.02, not 1.10: the pivot moved 10 cm outboard to open the armpit,
    // and the arm's outer plating has to give most of that back or the shoulders
    // grow from 36% of height to 39% and the pauldron stops capping the arm.
    { taperX: 1.02, taperZ: 1.06 });
  // front bicep plate — breaks up the long flat run down to the elbow
  b.addM('armor', MASK.BASE, plate(beveledRectShape(0.50, L * 0.54, { tl: 0.14, tr: 0.14, bl: 0.08, br: 0.08 }), 0.10, 0.026),
    _m.compose(_pv.set(0, -L * 0.50, -0.41), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  // Outer shell — the outermost armour on the whole frame, and the one face on
  // the mech that points straight at the key light. As a single 0.86 x 0.52 m
  // plate it was the brightest thing in every frame AND completely unbroken: a
  // pale slab that no amount of texture detail could rescue, because a flat plane
  // under a directional light has exactly one value on it. Split into two plates
  // with a 10 cm channel between them, so the run is cut by a hard shadow line
  // and the two halves catch fractionally different amounts of sun. Same outer
  // extent (0.315), same silhouette — the difference is entirely in the shading.
  for (let q = -1; q <= 1; q += 2) {
    b.addM('armor', MASK.BASE, plate(beveledRectShape(0.38, 0.52,
      { tl: q > 0 ? 0.20 : 0.05, tr: q > 0 ? 0.20 : 0.05, bl: q < 0 ? 0.14 : 0.05, br: q < 0 ? 0.14 : 0.05 }), 0.11, 0.028),
    _m.compose(_pv.set(s * 0.26, -L * 0.48 + q * 0.24, 0), _q.setFromEuler(_e.set(0, s * Math.PI * 0.5, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  }
  // strap across the channel, so the split reads as two plates on a frame
  b.box('mech', MASK.TRIM, 0.10, 0.09, 0.30, 0.016, s * 0.30, -L * 0.48, 0.0);
  // inner actuator + hose
  b.addM('mech', MASK.TRIM, chamferCyl(0.11, 0.11, L * 0.7, 10, 0.022),
    _m.compose(_pv.set(s * -0.30, -L * 0.5, 0.08), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  if (d) {
    b.addM('mech', MASK.TRIM, cable([
      [s * -0.28, -0.14, 0.34], [s * -0.34, -L * 0.5, 0.40], [s * -0.26, -L * 0.94, 0.32],
    ], 0.042, 10, 6), null);
    greebleFace(b, 'armor', MASK.BASE, s > 0 ? 'px' : 'nx', s * 0.35, -L * 0.5, 0.0, 0.52, 0.62, rng, { cols: 2, rows: 3, depth: 0.032, fill: 0.6 });
    greebleFace(b, 'armor', MASK.BASE, 'pz', 0, -L * 0.5, 0.40, 0.50, 0.72, rng, { cols: 2, rows: 3, depth: 0.034, accent: 0.04 });
    boltRing(b, 'mech', MASK.TRIM, s > 0 ? 'px' : 'nx', s * 0.38, -0.08, 0, 0.22, 7, 0.026, 0.018);
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
  // The drum is deliberately almost as wide as the forearm and proud of it on
  // both sides. AC elbows are a visible mechanical break between two armoured
  // masses; at r=0.19 / w=0.46 this one was thinner than the limb it joined and
  // the arm read as one continuous stick from pauldron to hand.
  axleJoint(b, 'mech', MASK.STEEL, 0, 0, 0, 0.25, 0.66, 16);
  b.addM('mech', MASK.TRIM, ring(0.25, 0.34, 0.36, 16, 0.024),
    _m.compose(_pv.set(s * 0.26, 0, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  // inboard bearing cheek, so the joint reads from the body side too
  b.addM('mech', MASK.TRIM, ring(0.22, 0.30, 0.20, 14, 0.02),
    _m.compose(_pv.set(s * -0.28, 0, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  piston(b, s * -0.18, 0.20, 0.30, s * -0.18, -0.52, 0.38, 0.056);
  if (d) {
    for (let i = -1; i <= 1; i += 2) {
      b.addM('mech', MASK.TRIM, cable([
        [s * 0.02 + i * 0.08, 0.22, 0.28], [s * 0.06 + i * 0.10, 0.0, 0.38], [s * 0.02 + i * 0.08, -0.32, 0.30],
      ], 0.030, 8, 5), null);
    }
    boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.32, 0, 0, 0.17, 6, 0.024, 0.016);
  }

  // --- forearm shell ------------------------------------------------------
  // 0.72 wide x 0.82 deep: deeper than it is wide, which is what makes a mech
  // forearm read as a weapon mount rather than a limb.
  b.box('armor', MASK.BASE, 0.72, L * 0.82, 0.82, 0.055, 0, -L * 0.50, 0.0, 0, 0, 0,
    { taperX: 0.90, taperZ: 0.92 });
  b.box('armor', MASK.TRIM, 0.60, 0.26, 0.68, 0.035, 0, -0.22, 0.0);
  // top shell plate, overlapping
  b.addM('armor', MASK.BASE, plate(beveledRectShape(0.64, L * 0.68, { tl: 0.16, tr: 0.16, bl: 0.08, br: 0.08 }), 0.11, 0.028),
    _m.compose(_pv.set(0, -L * 0.50, -0.43), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));

  // --- weapon hardpoint on the OUTER face ---------------------------------
  const hx = s * 0.41;
  b.box('armor', MASK.BASE, 0.18, 0.68, 0.62, 0.03, hx, -L * 0.46, 0.0);
  b.box('mech', MASK.TRIM, 0.10, 0.48, 0.44, 0.02, s * 0.50, -L * 0.46, 0.0);
  for (let i = -1; i <= 1; i += 2) {
    b.addM('mech', MASK.STEEL, chamferCyl(0.035, 0.035, 0.52, 8, 0.01),
      _m.compose(_pv.set(s * 0.53, -L * 0.46, i * 0.16), _q.setFromEuler(_e.set(Math.PI * 0.5, 0, 0)), _sc.set(1, 1, 1)));
  }
  b.box('glow', MASK.BASE, 0.03, 0.05, 0.22, 0.008, s * 0.565, -L * 0.24, 0.0);

  // --- wrist + grip claw (weapons cover it, so cheap but not empty) -------
  // The cuff reads as a real wrist break and stops the forearm looking like one
  // undifferentiated block from elbow to fingers.
  b.addM('mech', MASK.STEEL, ring(0.17, 0.24, 0.18, 12, 0.022),
    _m.compose(_pv.set(0, -L * 0.86, 0), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  b.box('armor', MASK.BASE, 0.56, 0.18, 0.60, 0.035, 0, -L * 0.80, 0.0, 0, 0, 0, { taperX: 0.9, taperZ: 0.92 });
  b.box('mech', MASK.TRIM, 0.44, 0.22, 0.46, 0.03, 0, -L * 0.94, 0.0);
  for (let i = -1; i <= 1; i += 2) {
    b.box('mech', MASK.TRIM, 0.11, 0.30, 0.12, 0.02, i * 0.14, -L - 0.12, -0.13, 0.30, 0, 0, { taperX: 0.7, taperZ: 0.7 });
    b.box('mech', MASK.TRIM, 0.11, 0.26, 0.12, 0.02, i * 0.14, -L - 0.10, 0.14, -0.34, 0, 0, { taperX: 0.7, taperZ: 0.7 });
  }
  b.addM('mech', MASK.STEEL, ring(0.13, 0.20, 0.11, 12, 0.016),
    _m.compose(_pv.set(0, -L * 0.86, 0), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, 'pz', 0, -L * 0.50, 0.42, 0.52, L * 0.6, rng, { cols: 2, rows: 4, depth: 0.032, accent: 0.04 });
    greebleFace(b, 'armor', MASK.BASE, s > 0 ? 'nx' : 'px', s * -0.37, -L * 0.5, 0, 0.52, L * 0.6, rng, { cols: 2, rows: 3, depth: 0.030, fill: 0.55 });
    ventGrill(b, 'mech', MASK.TRIM, 'nz', 0, -L * 0.72, -0.42, 0.36, 0.28, 3, 0.055);
  }

  return { b, anchors: { muzzle: [s * 0.55, -L * 0.46, -0.62], wrist: [0, -L, 0] } };
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

  // -----------------------------------------------------------------------
  // HIP YOKE — and the daylight slot under the pelvis.
  //
  // The thigh no longer reaches the pelvis. Its armour starts 48 cm below the
  // hip pivot and hangs off a narrow neck under a slim axle, so a ~26 cm
  // horizontal slot runs right through the hip with nothing in it but the
  // axle, the neck and two exposed rams.
  //
  // A HORIZONTAL slot is the only kind of negative space that survives a 3/4
  // camera. A vertical gap between two masses of depth `d` closes as soon as
  // the camera swings, because each mass sweeps `d * sin(az)` of extra screen
  // width — at the review's 35 degree hero azimuth a 1 m deep mass eats 57 cm
  // of gap, and nothing on this frame has 57 cm to give. Yaw cannot change a
  // height, so a slot cut in Y stays exactly as open at 35 degrees as it is
  // head-on. Both legs carry it at the SAME height on purpose: the sight line
  // through the near hip exits through the far one, so what is behind the hole
  // is sky rather than the other leg.
  const TOP = -0.48;                 // top face of the thigh block, thigh-local
  axleJoint(b, 'mech', MASK.STEEL, 0, -0.05, 0, 0.21, 0.66, 16);
  b.box('mech', MASK.TRIM, 0.42, 0.52, 0.58, 0.035, 0, -0.26, 0.02);
  // The rams are the connective structure that justifies the hole: they read as
  // detail at 200 m and as hip actuators up close.
  piston(b, s * 0.29, 0.02, -0.30, s * 0.23, TOP - 0.16, -0.42, 0.052);
  piston(b, s * 0.29, 0.02, 0.32, s * 0.23, TOP - 0.16, 0.44, 0.052);

  // --- MAIN THIGH BLOCK --------------------------------------------------
  // The widest part of the whole leg, and it is meant to be: an AC's upper leg
  // is a slab, not a rod. It was 0.90 m across against a 1.22 m shin, i.e. the
  // limb tapered the wrong way and read as a spindly toy. It is 1.00 m across
  // at the hip now, wider than the 1.06 m shin is deep and 6 cm wider than the
  // shin, and the taper runs the right way (wide at the hip, narrow at the
  // knee).
  //
  // The OUTBOARD budget is set by the hanging forearm, not by taste. With the
  // hip pivot at 0.80 the block's outer face is 1.30 in torso space, and the
  // forearm's inner face at the same height is 1.37 (rest roll 0.13). That
  // 7 cm is not slack — it is a deliberate sky gap between arm and thigh, and
  // it is the second hole this silhouette gained. Re-run the arm/leg clearance
  // check in any tool that measures it before widening this further.
  b.box('armor', MASK.BASE, 0.94, 1.22, 1.20, 0.075, 0, TOP - 0.61, rev ? 0.10 : 0.06, 0, 0, 0,
    { taperX: 1.06, taperZ: rev ? 0.92 : 0.80 });
  // front / rear armour plate over the block
  b.addM('armor', MASK.BASE, plate(beveledRectShape(0.66, 1.00, { tl: 0.22, tr: 0.22, bl: 0.14, br: 0.14 }), 0.12, 0.03),
    _m.compose(_pv.set(0, TOP - 0.60, (rev ? 0.66 : -0.54)), _q.setFromEuler(_e.set(0, rev ? Math.PI : 0, 0)), _sc.set(1, 1, 1)));
  // Outboard cheek, stepped off the block face so the widest plane on the leg
  // is broken by a shadow line rather than presenting one flat slab to the key.
  b.addM('armor', MASK.BASE, plate(beveledRectShape(0.56, 0.86, { tl: 0.20, bl: 0.20, tr: 0.12, br: 0.12 }), 0.06, 0.026),
    _m.compose(_pv.set(s * 0.47, TOP - 0.56, 0.04), _q.setFromEuler(_e.set(0, s * Math.PI * 0.5, 0)), _sc.set(1, 1, 1)));

  // --- KNEE ---------------------------------------------------------------
  // The block stops 15 cm above the knee pivot, which opens a second horizontal
  // slot at exactly the height the shin's own cap stops below. The axle crosses
  // it in the middle (z +-0.17) and the actuator crosses it at the back, so the
  // hole is a pair of windows fore and aft of the joint — you see the mechanism
  // AND you see sky through it.
  const kz = rev ? -0.34 : 0.34;
  piston(b, s * 0.0, TOP - 0.30, kz * 0.7, 0, -L + 0.10, kz, 0.070);
  b.box('mech', MASK.TRIM, 0.46, 0.34, 0.32, 0.03, 0, TOP - 0.98, kz * 0.94);
  // Knee FORK: two cheeks either side of the shin's axle instead of one drum
  // straddling it, so the joint reads as a hinge and the middle stays open.
  for (let i = -1; i <= 1; i += 2) {
    b.addM('mech', MASK.STEEL, ring(0.10, 0.23, 0.10, 14, 0.02),
      _m.compose(_pv.set(i * 0.28, -L, 0), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  }

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, s > 0 ? 'px' : 'nx', s * 0.50, TOP - 0.60, 0.06, 0.72, 0.86, rng, { cols: 3, rows: 3, depth: 0.035, fill: 0.6 });
    greebleFace(b, 'armor', MASK.BASE, rev ? 'nz' : 'pz', 0, TOP - 0.60, rev ? -0.44 : 0.54, 0.62, 0.90, rng, { cols: 3, rows: 3, depth: 0.04, accent: 0.04 });
    // Cable loom bridging the hip slot, and a second one down to the knee. A
    // hole in a silhouette only reads as engineering if something crosses it.
    b.addM('mech', MASK.TRIM, cable([
      [s * 0.14, -0.02, 0.30], [s * 0.30, -0.30, 0.44], [s * 0.24, TOP - 0.18, 0.52],
    ], 0.040, 10, 6), null);
    b.addM('mech', MASK.TRIM, cable([
      [s * 0.22, TOP - 0.20, kz * 0.9], [s * 0.28, TOP - 0.70, kz * 1.12], [s * 0.18, -L + 0.12, kz * 0.96],
    ], 0.042, 10, 6), null);
    boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.22, -0.05, 0, 0.16, 6, 0.024, 0.016);
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

  // THE LOWER LEG NO LONGER CARRIES THE WHOLE READ.
  // It was 1.22 m across against a 0.90 m thigh — the limb tapered the wrong
  // way and the frame read spindly at the top of the leg and clubbed at the
  // bottom. AC legs run the other way round: a slab thigh, a slightly narrower
  // shin, a splayed foot. The shin is 1.02 m across now and it did NOT lose
  // mass doing it — the 20 cm came off X and went into Z (skirt depth 0.86 ->
  // 1.02, shroud 0.24 -> 0.32), which is the cheaper axis anyway: at the
  // review's 35 degree hero azimuth depth contributes sin(35) = 0.57 of itself
  // to the screen width, so 16 cm of extra depth buys back 9 cm of the 20.
  //
  // The masses also stop 24 cm short of the ankle pivot and 10 cm short of the
  // knee pivot. Those two horizontal bands, plus the hip band in buildThigh,
  // are the negative space: three see-through slots per leg that a 3/4 camera
  // cannot close, because yaw does not change a height.
  const BOT = -L + 0.34;             // bottom face of the shin masses
  // knee cap — dropped clear of the thigh block's underside
  b.box('armor', MASK.ACCENT, 0.72, 0.48, 0.66, 0.05, 0, -0.26, rev ? 0.26 : -0.26, 0, 0, 0, { taperZ: 0.9 });
  axleJoint(b, 'mech', MASK.STEEL, 0, 0, 0, 0.17, 0.60, 14);

  // structural shin core
  b.box('mech', MASK.TRIM, 0.62, 1.16, 0.92, 0.045, 0, BOT + 0.58, 0);

  // LARGE armour shroud — the dominant leg silhouette element
  const shroudZ = rev ? 0.50 : -0.48;
  b.addM('armor', MASK.BASE, plate(beveledRectShape(1.00, 1.20, { tl: 0.30, tr: 0.30, bl: 0.22, br: 0.22 }), 0.32, 0.05),
    _m.compose(_pv.set(0, BOT + 0.60, shroudZ), _q.setFromEuler(_e.set(rev ? -0.06 : 0.06, rev ? Math.PI : 0, 0)), _sc.set(1, 1, 1)));
  // side skirts wrapping the shroud — narrower across, deeper fore-and-aft
  for (let i = -1; i <= 1; i += 2) {
    b.box('armor', MASK.BASE, 0.18, 1.16, 1.02, 0.045, i * 0.42, BOT + 0.58, shroudZ * 0.30, 0, 0, i * -0.05,
      { taperX: 0.82, taperZ: 0.88 });
  }
  b.box('armor', MASK.TRIM, 0.72, 0.80, 0.42, 0.04, 0, BOT + 0.66, -shroudZ * 0.76);

  // --- ANKLE ------------------------------------------------------------
  // Everything above stops at BOT; the foot's own block starts 17 cm lower, so
  // the ankle is an open cage of an axle and three rams rather than a filled
  // taper. Same trick as the hip and the knee, and the three slots land at
  // three different heights so the leg reads as jointed rather than sliced.
  for (let i = -1; i <= 1; i += 2) {
    piston(b, i * 0.20, BOT + 0.24, shroudZ * 0.26, i * 0.24, -L + 0.04, shroudZ * 0.46, 0.052);
  }
  piston(b, 0, BOT + 0.22, -shroudZ * 0.50, 0, -L + 0.06, -shroudZ * 0.58, 0.060);
  axleJoint(b, 'mech', MASK.TRIM, 0, -L, 0, 0.16, 0.48, 14);

  // ankle thruster
  _q.setFromEuler(_e.set(Math.PI * 0.5 - 0.30, 0, 0));
  _pv.set(0, BOT + 0.52, -shroudZ * 0.86); _sc.set(1, 1, 1);
  _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.TRIM, nozzle(0.085, 0.15, 0.22, 14), _m);
  _pv.set(0, BOT + 0.51, -shroudZ * 0.98); _m.compose(_pv, _q, _sc);
  b.addM('glow', MASK.BASE, chamferCyl(0.082, 0.076, 0.03, 12, 0.008), _m);
  b.box('glow', MASK.BASE, 0.04, 0.05, 0.30, 0.01, s * 0.49, BOT + 0.62, shroudZ * 0.28);

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, s > 0 ? 'px' : 'nx', s * 0.50, BOT + 0.58, shroudZ * 0.30, 0.78, 0.86, rng, { cols: 3, rows: 3, depth: 0.032, fill: 0.6 });
    greebleFace(b, 'armor', MASK.BASE, rev ? 'pz' : 'nz', 0, BOT + 0.60, shroudZ * 1.16, 0.66, 0.90, rng, { cols: 3, rows: 4, depth: 0.038, accent: 0.04 });
    ventGrill(b, 'mech', MASK.TRIM, rev ? 'nz' : 'pz', 0, BOT + 0.74, -shroudZ * 0.92, 0.44, 0.42, 4, 0.07);
    boltRing(b, 'mech', MASK.STEEL, s > 0 ? 'px' : 'nx', s * 0.30, -0.26, rev ? 0.26 : -0.26, 0.19, 8, 0.024, 0.016);
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
  const len = rev ? 1.26 : 1.66;
  const fwd = rev ? -0.38 : -0.10;

  // ankle block
  b.box('mech', MASK.TRIM, 0.58, 0.34, 0.58, 0.035, 0, -0.15, 0);
  b.box('armor', MASK.BASE, 0.80, 0.30, 0.84, 0.045, 0, -0.26, 0.02, 0, 0, 0, { taperX: 1.1, taperZ: 1.05 });

  // Sole. A 60-tonne machine needs a footprint you could land a helicopter on —
  // small feet are the fastest way to make a mech read as a toy. Widened with the
  // shin above it: the foot has to stay the widest thing on the leg or the whole
  // limb reads as a peg rather than as something the mech is standing ON.
  b.box('armor', MASK.BASE, 1.22, 0.26, len, 0.06, 0, -0.40, fwd, 0, 0, 0,
    { taperFrontX: 0.74, taperZ: 1.0 });
  // toe plate, angled up
  b.box('armor', MASK.BASE, 0.90, 0.19, 0.52, 0.04, 0, -0.36, fwd - len * 0.50, -0.24, 0, 0, { taperFrontX: 0.7 });
  // heel plate + spur
  b.box('armor', MASK.BASE, 0.84, 0.24, 0.44, 0.04, 0, -0.34, fwd + len * 0.48, 0.20, 0, 0, { taperFrontX: 0.86 });
  b.box('mech', MASK.TRIM, 0.34, 0.38, 0.26, 0.03, 0, -0.30, fwd + len * 0.60, 0.35, 0, 0);

  // splay claws
  for (let i = -1; i <= 1; i += 2) {
    b.box('armor', MASK.BASE, 0.30, 0.20, 0.70, 0.035,
      i * 0.62, -0.40, fwd - len * 0.16, 0, i * -0.16, i * -0.22, { taperFrontX: 0.6 });
    // outrigger stabiliser bar tying the claw back into the sole
    b.box('mech', MASK.TRIM, 0.26, 0.11, 0.28, 0.02, i * 0.54, -0.38, fwd + len * 0.16, 0, 0, i * -0.14);
  }

  // ankle actuators
  for (let i = -1; i <= 1; i += 2) {
    piston(b, i * 0.18, 0.02, 0.0, i * 0.26, -0.34, fwd + len * 0.30, 0.042);
  }
  axleJoint(b, 'mech', MASK.STEEL, 0, -0.02, 0, 0.14, 0.44, 12);

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, 'py', 0, -0.27, fwd + len * 0.10, 0.78, len * 0.5, rng, { cols: 3, rows: 3, depth: 0.028, fill: 0.55 });
    greebleFace(b, 'armor', MASK.BASE, s > 0 ? 'px' : 'nx', s * 0.52, -0.40, fwd, 0.8, 0.18, rng, { cols: 4, rows: 1, depth: 0.026, accent: 0.04 });
    // sole grip pads
    for (let i = 0; i < 3; i++) {
      b.box('mech', MASK.TRIM, 0.80, 0.07, 0.16, 0.014, 0, -0.52, fwd - len * 0.28 + i * len * 0.28);
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
  b.box('armor', MASK.BASE, 0.90, 0.26, 1.20, 0.04, 0, 0.44, 0.10, -0.06, 0, 0, { taperFrontX: 0.6 });
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
      greebleFace(b, 'armor', MASK.BASE, 'py', s * 0.95, 0.18, 0.26, 0.8, 0.6, rng, { cols: 3, rows: 2, depth: 0.03, accent: 0.04 });
      boltRing(b, 'mech', MASK.STEEL, 'py', s * 1.42, 0.20, 0.30, 0.40, 10, 0.026, 0.016);
    }
  }
  if (d) {
    greebleFace(b, 'armor', MASK.BASE, 'py', 0, 0.58, 0.40, 0.7, 0.7, rng, { cols: 3, rows: 3, depth: 0.035 });
    greebleFace(b, 'armor', MASK.BASE, 'ny', 0, -0.44, 0.30, 0.9, 1.0, rng, { cols: 3, rows: 3, depth: 0.03, fill: 0.6 });
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
  greebleFace(b, 'armor', MASK.BASE, 'pz', 0, 0, 0.83, 1.0, 0.8, rng, { cols: 3, rows: 3, depth: 0.05, accent: 0.04 });
  return { b, anchors: { muzzle: [0, 0, -2.20] } };
}

/** Boss defence: a huge layered tower shield with an emissive projector strip. */
export function buildShieldPlate(o = {}) {  const rng = o.rng;
  const b = new GeoBuilder(rng);
  b.addM('armor', MASK.BASE, plate(beveledRectShape(2.30, 3.40, { tl: 0.70, tr: 0.70, bl: 0.45, br: 0.45 }), 0.34, 0.07),
    _m.compose(_pv.set(0, 0, 0), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  b.addM('armor', MASK.ACCENT, plate(beveledRectShape(1.40, 2.40, { tl: 0.45, tr: 0.45, bl: 0.30, br: 0.30 }), 0.20, 0.05),
    _m.compose(_pv.set(0, 0.10, -0.26), _q.setFromEuler(_e.set(0, 0, 0)), _sc.set(1, 1, 1)));
  b.box('mech', MASK.TRIM, 0.50, 2.60, 0.40, 0.045, 0, 0, 0.30);
  b.box('glow', MASK.BASE, 0.14, 2.10, 0.05, 0.02, 0, 0.10, -0.40);
  for (let i = -1; i <= 1; i += 2) {
    piston(b, i * 0.30, 0.90, 0.44, i * 0.30, -0.90, 0.44, 0.075);
    greebleFace(b, 'armor', MASK.BASE, 'nz', i * 0.78, 0.20, -0.20, 0.5, 2.0, rng, { cols: 2, rows: 6, depth: 0.05, accent: 0.04 });
  }
  boltRing(b, 'mech', MASK.STEEL, 'nz', 0, 0.10, -0.20, 0.92, 14, 0.036, 0.024);
  return { b, anchors: {} };
}

// ---------------------------------------------------------------------------
// SHOULDER ORDNANCE — the mech's asymmetry lives here.
//
// Every AC in the game this is modelled on carries DIFFERENT ordnance on its two
// shoulders: a missile rack one side, a cannon or nothing the other. Until now
// both shoulder mounts on this frame were empty anchors, so the whole machine was
// perfectly bilaterally symmetric — which is the single loudest "procedural
// robot, not an Armored Core" tell in a silhouette. These two parts are attached
// to the l/r shoulder mounts by MechFactory, one each, never the same one twice.
//
// Both are built to merge into a single solid bucket (MechFactory passes
// `mergeSolid`), so a shoulder weapon costs 2 draw calls, not 3.
// ---------------------------------------------------------------------------

/**
 * Vertical-launch missile rack. Boxy, cell-gridded, canted outboard — its job in
 * the silhouette is to add a big angular mass ABOVE the shoulder line.
 * @param {object} o `side` -1 left / +1 right; the pod cants away from the body.
 */
export function buildMissileRack(o = {}) {
  const rng = o.rng;
  const d = o.detail !== 'low';
  const s = o.side ?? -1;
  const small = !!o.crude;
  const W = small ? 0.56 : 0.80;
  const H = small ? 0.34 : 0.46;
  const D = small ? 0.74 : 1.04;
  const b = new GeoBuilder(rng);

  // mounting saddle + trunnion: the rack has to look BOLTED ON, not grown
  b.box('mech', MASK.TRIM, W * 0.60, 0.13, D * 0.62, 0.02, 0, 0.05, 0);
  axleJoint(b, 'mech', MASK.STEEL, 0, 0.12, D * 0.22, 0.07, W * 0.52, 10);

  // main pod, canted outboard so the two shoulders never read as a mirror pair
  const cant = s * -0.13;
  b.box('armor', MASK.BASE, W, H, D, 0.045, s * 0.05, 0.10 + H * 0.5, -0.02, 0.05, 0, cant,
    { taperFrontX: 0.90, taperFrontY: 0.94 });
  // hinged lid, a slightly different colour so the rack reads as a sub-assembly
  b.box('armor', MASK.ACCENT, W * 0.90, 0.085, D * 0.88, 0.022, s * 0.05, 0.10 + H + 0.02, -0.02, 0.05, 0, cant);

  // launch cells, recessed into the front face
  const cols = small ? 2 : 3, rows = 2;
  const cw = W * 0.80 / cols, chh = H * 0.74 / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = s * 0.05 + (-W * 0.40 + cw * (i + 0.5));
      const cy = 0.10 + H * 0.5 + (-H * 0.37 + chh * (j + 0.5));
      // bezel + dark bore: reads as a tube mouth at any distance
      b.box('mech', MASK.TRIM, cw * 0.82, chh * 0.82, 0.10, 0.015, cx, cy, -D * 0.5 - 0.01, 0.05, 0, cant);
      b.box('mech', MASK.TRIM, cw * 0.54, chh * 0.54, 0.16, 0.012, cx, cy, -D * 0.5 + 0.06, 0.05, 0, cant);
    }
  }
  // status lamp strip down the outboard flank
  b.box('glow', MASK.BASE, 0.035, 0.05, D * 0.44, 0.01, s * (W * 0.52 + 0.04), 0.10 + H * 0.62, 0.02);

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, 'py', s * 0.05, 0.10 + H + 0.08, -0.02, W * 0.62, D * 0.5, rng,
      { cols: 3, rows: 3, depth: 0.028, fill: 0.6 });
    greebleFace(b, 'armor', MASK.BASE, s > 0 ? 'px' : 'nx', s * (W * 0.5 + 0.02), 0.10 + H * 0.5, 0.06, D * 0.52, H * 0.6, rng,
      { cols: 3, rows: 2, depth: 0.026, accent: 0.05 });
    // feed conduit from the pod down into the shoulder deck
    b.addM('mech', MASK.TRIM, cable([
      [s * -0.16, 0.10 + H * 0.4, D * 0.34], [s * -0.24, 0.16, D * 0.30], [s * -0.20, 0.0, D * 0.10],
    ], 0.035, 8, 5), null);
    boltRing(b, 'mech', MASK.STEEL, 'py', 0, 0.12, 0, W * 0.30, 6, 0.022, 0.014);
  }
  return { b, anchors: { muzzle: [0, 0.10 + H + 0.06, -D * 0.30] } };
}

/**
 * Shoulder cannon. The barrel is the point: it projects ~1.4 m forward of the
 * shoulder, which is the one element on this frame that breaks the outline
 * against the sky instead of sitting inside the main volumes.
 */
export function buildShoulderCannon(o = {}) {
  const rng = o.rng;
  const d = o.detail !== 'low';
  const s = o.side ?? 1;
  const b = new GeoBuilder(rng);

  // cradle + elevation trunnion
  b.box('mech', MASK.TRIM, 0.42, 0.13, 0.58, 0.02, 0, 0.05, 0);
  axleJoint(b, 'mech', MASK.STEEL, 0, 0.30, 0.12, 0.10, 0.50, 12);

  // recoil housing / receiver
  b.box('armor', MASK.BASE, 0.50, 0.44, 0.92, 0.04, 0, 0.36, 0.08, -0.04, 0, 0,
    { taperFrontX: 0.86, taperFrontY: 0.88 });
  // top rail + optics block
  b.box('armor', MASK.TRIM, 0.26, 0.10, 0.62, 0.02, 0, 0.60, 0.06, -0.04, 0, 0);
  b.box('mech', MASK.TRIM, 0.22, 0.16, 0.24, 0.02, 0, 0.70, -0.16, -0.04, 0, 0);
  b.box('glow', MASK.BASE, 0.12, 0.055, 0.03, 0.01, 0, 0.70, -0.29);

  // barrel: sleeve, then the rifled tube, then a slotted muzzle brake
  _q.setFromEuler(_e.set(Math.PI * 0.5 - 0.04, 0, 0)); _sc.set(1, 1, 1);
  _pv.set(0, 0.40, -0.62); _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.TRIM, chamferCyl(0.115, 0.10, 0.52, 12, 0.022), _m);
  _pv.set(0, 0.43, -1.28); _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.STEEL, chamferCyl(0.072, 0.066, 1.00, 12, 0.016), _m);
  _pv.set(0, 0.46, -1.86); _m.compose(_pv, _q, _sc);
  b.addM('mech', MASK.TRIM, ring(0.066, 0.115, 0.24, 12, 0.02), _m);
  // brake ports — three fins that catch a rim light on the outline
  for (let i = 0; i < 3; i++) {
    b.box('mech', MASK.TRIM, 0.20, 0.028, 0.05, 0.008, 0, 0.46 + 0.005, -1.80 + i * 0.09, -0.04, 0, 0);
  }

  // ammo feed: drum on the inboard side + a belt cover running to the receiver
  b.addM('mech', MASK.TRIM, chamferCyl(0.20, 0.20, 0.22, 12, 0.03),
    _m.compose(_pv.set(s * -0.28, 0.34, 0.40), _q.setFromEuler(_e.set(0, 0, Math.PI * 0.5)), _sc.set(1, 1, 1)));
  b.box('armor', MASK.ACCENT, 0.16, 0.26, 0.42, 0.022, s * -0.24, 0.36, 0.10, -0.04, 0, 0);

  // heat vanes stacked along the receiver's outboard flank
  for (let i = 0; i < (d ? 5 : 2); i++) {
    b.box('mech', MASK.TRIM, 0.05, 0.16, 0.34, 0.012, s * 0.27, 0.22 + i * 0.085, 0.16, 0, 0, s * 0.05);
  }

  if (d) {
    greebleFace(b, 'armor', MASK.BASE, s > 0 ? 'nx' : 'px', s * -0.26, 0.40, 0.02, 0.5, 0.34, rng,
      { cols: 3, rows: 2, depth: 0.024, fill: 0.6 });
    boltRing(b, 'mech', MASK.STEEL, 'py', 0, 0.12, 0, 0.16, 6, 0.022, 0.014);
    b.addM('mech', MASK.TRIM, cable([
      [s * -0.18, 0.22, 0.44], [s * -0.26, 0.08, 0.34], [s * -0.16, -0.02, 0.12],
    ], 0.032, 8, 5), null);
  }
  return { b, anchors: { muzzle: [0, 0.47, -2.00] } };
}
