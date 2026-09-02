#!/usr/bin/env node
/**
 * Leg width/depth budget — an OFFLINE silhouette of the lower body.
 *
 *   node tools/legbudget.mjs [--yaws 45,90,135] [--px 900] [--straight]
 *
 * `tools/silhouette.mjs` is the arbiter, but it costs a vite build, a browser
 * and four minutes, which is far too slow a loop for the thing it is measuring
 * here: the leg has NO SPARE SCREEN WIDTH (see the amendments), so every
 * centimetre of depth added to it must be paid for out of X, and finding that
 * balance is a search, not a single edit.
 *
 * This builds the leg chain straight out of MechParts in node — no renderer, no
 * materials — projects it orthographically at a given yaw and reports:
 *
 *   gap        the daylight between the two legs, in METRES of screen width, at
 *              every height. This is the quantity the whole exercise is about;
 *              `openRows` in the audit tool is a yes/no version of it.
 *   depth      the leg's own fore-and-aft extent at each height (yaw 90 width).
 *   width      the leg's own left-right extent at each height (yaw 0 width).
 *   armGap     clearance from the outermost thigh point to the innermost point
 *              of the hanging forearm, which is the cap on outboard growth.
 *
 * Orthographic rather than perspective on purpose: the audit's camera is 14 m
 * from a 9 m subject, so perspective spread is a couple of per cent and is the
 * same on both legs. Trends carry; absolute numbers are the audit tool's job.
 *
 * TWO STALE COPIES WERE FOUND IN HERE AND BOTH MOVED THE BUDGET IT REPORTS.
 * The arm hung off `MECH_DIMS.shoulderX`, but `MechFactory` places it off
 * `buildCore`'s `shoulderL/R` anchor at `shoulderX + 0.10` — 10 cm of pure
 * error, in the direction that makes the thigh look like it is already inside
 * the forearm. And the chain was built straight and vertical, while the rig
 * splays it 4.9 degrees outboard, which is worth +4 cm of X at the top of the
 * thigh and +22 cm at the calf. Anchors are now READ, and the standing solve is
 * derived from MECH_DIMS instead of assumed away. `--straight` restores the old
 * vertical chain if you want to separate the leg's own shape from its stance.
 */
import * as THREE from 'three';
import * as MP from '../src/mech/MechParts.js';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const YAWS = String(arg('yaws', '0,45,90,135')).split(',').map(Number).filter(isFinite);
const PX = parseInt(arg('px', '200'), 10); // raster resolution, pixels per metre
const STRAIGHT = !!arg('straight', false); // opt out of the rig's standing solve
const D = MP.MECH_DIMS;

// THE ARM PIVOT IS NOT `MECH_DIMS.shoulderX`, AND ASSUMING IT WAS COST THIS TOOL
// 10 CM OF THE ONE BUDGET IT EXISTS TO REPORT. `buildCore` publishes the shoulder
// bone position as `anchors.shoulderL/R` at `shoulderX + 0.10` (the yoke's own
// armour reaches outboard of the pivot, so the bone sits proud of the nominal
// half-width), and `MechFactory` places the arm off that anchor, not off
// MECH_DIMS. Hard-coding `D.shoulderX` here put the whole arm 10 cm inboard and
// made the tool report the thigh already INSIDE the forearm (-0.025 m at yaw 0)
// when the real rest-pose clearance is +0.075 m. Read the anchor instead of
// copying it: `GeoBuilder` accumulates lazily, so this costs nothing but the
// anchor arithmetic.
const SHOULDER = MP.buildCore({ rng: rng32(23) }).anchors.shoulderR; // [x, y-in-torso, z]
const SHOULDER_X = SHOULDER[0];
const SHOULDER_Y = D.waistY + SHOULDER[1];
// Same argument for the hip: `buildPelvis` publishes `anchors.hipL/R` and
// `MechFactory` places the thigh off that, not off `MECH_DIMS.hipX`.
const HIP = MP.buildPelvis({ rng: rng32(17) }).anchors.hipR;
const HIP_X = HIP[0];
const HIP_Y = D.pelvisY + HIP[1];

// Deterministic RNG so two runs of the same source produce the same shape.
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collect every triangle a builder emits, transformed into mech space. */
function collect(out, res, matrix, tag) {
  const geos = res.b.build();
  for (const k of Object.keys(geos)) {
    const g = geos[k];
    if (!g) continue;
    const p = g.attributes.position.array;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(matrix);
      out.push(v.x, v.y, v.z);
    }
    if (out.tags) out.tags.push([tag, out.length]);
    g.dispose();
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const trs = (x, y, z, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s);

const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * The rig's STANDING SOLVE, not a straight vertical leg.
 *
 * This used to build the chain straight and vertical, on the stated grounds that
 * the standing solve "moves nothing this measurement cares about". That is false
 * on the axis the whole tool is about. The rig plants each foot at `footX` 1.14
 * against a hip at 0.80, so `_solveLeg` splays the limb 4.9 degrees OUTBOARD —
 * and a splay is a lever: it is worth +4 cm of X at the top of the thigh block
 * and +22 cm at the calf. A vertical chain therefore reports the thigh with 4 cm
 * more arm clearance than it has, and the calf a full 22 cm per side narrower
 * than the frame actually stands, which is most of the reason the lower bands of
 * the silhouette's width profile are wider than the thigh bands.
 *
 * It is `MechRig._solveLeg` re-derived rather than re-typed by eye: same target,
 * same clamps, same basis construction, so a change to the leg lengths or the
 * stance follows automatically. `tools/probes/legprofile.js` is the live-rig
 * arbiter if the two ever disagree.
 */
function standingSolve(side) {
  if (STRAIGHT) return { thigh: new THREE.Quaternion(), shin: new THREE.Quaternion() };
  const L1 = D.thigh, L2 = D.shin;
  const bendZ = -1;                                   // biped: knee juts forward
  // Target is `leg.restLocal` = (side * footX, 0, 0) in root space; the hip is
  // `hipLocal` in pelvis space. Both reduce to the same frame here.
  const dir = new THREE.Vector3(side * (D.footX - HIP_X), -HIP_Y, 0);
  let dist = dir.length();
  dir.normalize();
  dist = Math.min(dist, (L1 + L2) * 0.995);           // target out of reach: leg straightens
  const A = Math.acos(Math.max(-1, Math.min(1,
    (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist))));
  const K = Math.acos(Math.max(-1, Math.min(1,
    (L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2))));
  const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, bendZ)).normalize();
  const up = dir.clone().multiplyScalar(-1);
  const fwd = new THREE.Vector3().crossVectors(right, up);
  const qA = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd));
  const thigh = qA.multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, A));
  const shin = new THREE.Quaternion().setFromAxisAngle(X_AXIS, -(Math.PI - K));
  return { thigh, shin };
}

const rot = (q) => new THREE.Matrix4().makeRotationFromQuaternion(q);
const mul = (...ms) => ms.reduce((a, b) => new THREE.Matrix4().multiplyMatrices(a, b));

/** Rest-pose lower body, in the pose the rig actually holds when standing. */
function buildParts(which) {
  const parts = [];
  for (const side of which.sides ?? [-1, 1]) {
    if (which.leg) {
      const q = standingSolve(side);
      const hipM = mul(trs(side * HIP_X, HIP_Y, 0), rot(q.thigh));
      collect(parts, MP.buildThigh({ rng: rng32(7), side, legType: 'biped' }), hipM, 'thigh');
      const kneeM = mul(hipM, trs(0, -D.thigh, 0), rot(q.shin));
      collect(parts, MP.buildShin({ rng: rng32(11), side, legType: 'biped' }), kneeM, 'shin');
      // The rig cancels the accumulated chain at the ankle so the foot lands in
      // the orientation it was asked for — flat and forward, at rest.
      const qFoot = q.thigh.clone().multiply(q.shin).invert();
      const ankM = mul(kneeM, trs(0, -D.shin, 0), rot(qFoot));
      collect(parts, MP.buildFoot({ rng: rng32(13), side, legType: 'biped' }), ankM, 'foot');
    }
    if (which.arm) {
      // Rest arm pose, read straight off `MechRig._updateArms` with every weight
      // (wBoost/wAssault/wStagger/aimPitch) at zero: shoulder rotation
      // (0, 0, side * 0.14), elbow rotation.x 0.14. The roll is the knob that
      // sets arm-to-thigh daylight, so a stale copy of it here silently moves
      // the cap this whole tool exists to report — it was 0.095 for one pass,
      // which put the wrist 13 cm further inboard than the rig actually holds it.
      const shM = trs(side * SHOULDER_X, SHOULDER_Y, SHOULDER[2], 0, 0, side * 0.14);
      collect(parts, MP.buildUpperArm({ rng: rng32(3), side }), shM, 'upperArm');
      const foreM = new THREE.Matrix4().multiplyMatrices(shM, trs(0, -D.elbowDrop, 0, 0.14, 0, 0));
      collect(parts, MP.buildForeArm({ rng: rng32(5), side }), foreM, 'foreArm');
    }
    if (which.pelvis && side < 0) {
      collect(parts, MP.buildPelvis({ rng: rng32(17) }), trs(0, D.pelvisY, 0), 'pelvis');
    }
  }
  return parts;
}

/**
 * Rasterise the projection into a per-row list of filled column spans.
 *
 * A FIXED world grid (`GRID`) is used for every raster so that columns taken
 * from different builds — one leg, both legs, legs + arm — can be joined row by
 * row. An auto-fitted grid per raster silently compares different heights,
 * which is exactly the mistake the old arm/thigh clearance line made: it took a
 * global max on the leg and a global min on the arm and subtracted two numbers
 * measured 1.5 m apart.
 */
const GRID = { minU: -3.2, maxV: 4.35, minV: -0.45, scale: PX }; // pixels per metre
function raster(tris, yawDeg) {
  const th = (yawDeg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const n = tris.length / 3;
  const u = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    u[i] = x * c - z * s; v[i] = y;
  }
  const { minU, maxV, scale } = GRID;
  const W = Math.ceil((-minU * 2) * scale);
  const H = Math.ceil((maxV - GRID.minV) * scale);
  const mask = new Uint8Array(W * H);
  const toX = (a) => (a - minU) * scale;
  const toY = (a) => (maxV - a) * scale;

  for (let t = 0; t < n; t += 3) {
    const ax = toX(u[t]), ay = toY(v[t]);
    const bx = toX(u[t + 1]), by = toY(v[t + 1]);
    const cx = toX(u[t + 2]), cy = toY(v[t + 2]);
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    if (x1 < x0 || y1 < y0) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-9) continue;
    const inv = 1 / d;
    for (let py = y0; py <= y1; py++) {
      const fy = py + 0.5;
      for (let pxi = x0; pxi <= x1; pxi++) {
        const fx = pxi + 0.5;
        const l1 = ((by - cy) * (fx - cx) + (cx - bx) * (fy - cy)) * inv;
        if (l1 < -1e-6 || l1 > 1 + 1e-6) continue;
        const l2 = ((cy - ay) * (fx - cx) + (ax - cx) * (fy - cy)) * inv;
        if (l2 < -1e-6) continue;
        const l3 = 1 - l1 - l2;
        if (l3 < -1e-6) continue;
        mask[py * W + pxi] = 1;
      }
    }
  }
  return { mask, W, H, minU, maxV, scale };
}

/** Row index for a world height. */
const rowAt = (yM) => Math.round((GRID.maxV - yM) * GRID.scale);

/** Per-height runs, in metres, from the top of the raster down. */
function rowRuns(r, y) {
  const runs = [];
  let start = -1;
  for (let x = 0; x < r.W; x++) {
    const on = r.mask[y * r.W + x];
    if (on && start < 0) start = x;
    if (!on && start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, r.W - 1]);
  return runs;
}

const fmt = (n, w = 6, p = 2) => String(n.toFixed(p)).padStart(w);

/** Widest daylight between consecutive runs, and the run count, on one row. */
function rowStats(r, py) {
  const runs = rowRuns(r, py);
  if (!runs.length) return null;
  let gap = 0;
  for (let i = 1; i < runs.length; i++) {
    gap = Math.max(gap, (runs[i][0] - runs[i - 1][1] - 1) / r.scale);
  }
  return {
    n: runs.length,
    gap,
    lo: runs[0][0] / r.scale + r.minU,
    hi: (runs[runs.length - 1][1] + 1) / r.scale + r.minU,
    span: (runs[runs.length - 1][1] - runs[0][0] + 1) / r.scale,
  };
}

// One leg's own extent in X and in Z is fixed geometry: it does not depend on
// the camera, and it is the pair of numbers the whole budget is spent from.
const RIGHT = { leg: true, sides: [1] };
const wR = raster(buildParts(RIGHT), 0);
const dR = raster(buildParts(RIGHT), 90);

const yTop = D.pelvisY + 0.15;
const HEIGHTS = [];
for (let y = yTop; y > -0.15; y -= 0.125) HEIGHTS.push(y);

console.log('\n=== ONE LEG: the section budget (camera-independent) ===');
console.log('  height   width   depth   w+d    su45   (metres; su45 = screen width at a 3/4 yaw)');
for (const y of HEIGHTS) {
  const a = rowStats(wR, rowAt(y));
  const b = rowStats(dR, rowAt(y));
  if (!a || !b) continue;
  const s45 = (a.span + b.span) * Math.SQRT1_2;
  console.log(`  ${fmt(y)}  ${fmt(a.span)}  ${fmt(b.span)}  ${fmt(a.span + b.span)}  ${fmt(s45)}`);
}

for (const yaw of YAWS) {
  const legs = raster(buildParts({ leg: true }), yaw);
  const one = raster(buildParts(RIGHT), yaw);
  const withArm = raster(buildParts({ leg: true, arm: true, sides: [1] }), yaw);
  console.log(`\n=== yaw ${yaw} ===`);
  console.log('  height  1leg-su  legGap  nRuns   armGap  (armGap: right leg to right arm)');
  for (const y of HEIGHTS) {
    const py = rowAt(y);
    const L = rowStats(legs, py);
    if (!L) continue;
    const O = rowStats(one, py);
    const A = rowStats(withArm, py);
    const armGap = A && A.n >= 2 ? A.gap : 0;
    console.log(`  ${fmt(y)}  ${fmt(O ? O.span : 0)}  ${fmt(L.gap)}   ${String(L.n).padStart(2)}    ${fmt(armGap)}`);
  }
  let occ = 0, open = 0;
  for (let py = 0; py < legs.H; py++) {
    const L = rowStats(legs, py);
    if (!L) continue;
    occ++; if (L.n >= 2) open++;
  }
  console.log(`  legs-only openRows ${(open / occ).toFixed(3)}   (${open}/${occ} rows with daylight between the legs)`);
}

// --- arm / thigh clearance, measured AT THE SAME HEIGHT -----------------------
// The cap on outboard growth. Reported in world X (what buildThigh's comment is
// written in) and in screen-u at 45 deg, which is what actually closes the hole.
for (const yaw of [0, 45]) {
  const leg = raster(buildParts(RIGHT), yaw);
  const arm = raster(buildParts({ arm: true, sides: [1] }), yaw);
  let worst = Infinity, worstY = 0;
  for (let py = 0; py < leg.H; py++) {
    const L = rowStats(leg, py);
    const A = rowStats(arm, py);
    if (!L || !A) continue;
    const c = A.lo - L.hi;          // inner face of the arm minus outer face of the leg
    if (c < worst) { worst = c; worstY = GRID.maxV - py / GRID.scale; }
  }
  console.log(`\narm/leg clearance at yaw ${yaw}: ${worst.toFixed(3)} m at y ${worstY.toFixed(2)}` +
    (worst === Infinity ? '  (no shared height)' : ''));
}
