#!/usr/bin/env node
/**
 * An EXACT numerical model of this project's grade chain, in JS.
 *
 *   node tools/grade-model.mjs                 # black point + toe table
 *   node tools/grade-model.mjs --params '{"lift":[0.022,0.025,0.038]}'
 *   node tools/grade-model.mjs --invert 43     # display code -> scene linear
 *
 * Why this exists. Every tonal question in this project — "is the mech pale",
 * "where is the black point", "how much does lift buy at display 38" — has so
 * far been answered by rebuilding, capturing, and differencing two PNGs, which
 * costs ~8 minutes and (per the Contract Amendments on cross-build measurement)
 * is only valid if nobody else committed in between. The chain is deterministic
 * and only ~40 lines of arithmetic, so the derivable half of those questions can
 * be answered exactly, in milliseconds, before a build is ever started.
 *
 * SCOPE, and the honest limits of it. This models FINAL_FRAG from `color *=
 * uExposure` to the sRGB write, for a pixel whose scene-linear radiance is
 * given. It therefore covers exposure, AgX, gain/gamma/contrast/lift/
 * saturation/split-tone, and the 2.2-EOTF-vs-sRGB-OETF round trip at the end.
 * It does NOT model bloom, CA, sharpen, vignette, grain or dither — those are
 * neighbourhood or screen-position effects and have no meaning for a single
 * radiance. Anything this file predicts about a whole FRAME must still be
 * checked with tools/measure-frame.mjs; what it is FOR is the per-pixel
 * transfer curve, which a screenshot can only sample and never state.
 *
 * The constants are read from src/render/Pipeline.js and src/render/shaders at
 * import time by regex, so this cannot silently drift from the shipped values.
 * If the parse fails it throws rather than falling back to a stale default.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------------------
 * Read the shipped constants rather than restating them.
 * ------------------------------------------------------------------------ */
const PIPE = readFileSync(resolve(ROOT, 'src/render/Pipeline.js'), 'utf8');

function num(re, what) {
  const m = PIPE.match(re);
  if (!m) throw new Error(`grade-model: could not read ${what} from Pipeline.js`);
  return parseFloat(m[1]);
}
function vec3(name) {
  const re = new RegExp(`${name}:\\s*new THREE\\.Vector3\\(\\s*(-?[\\d.]+)\\s*,\\s*(-?[\\d.]+)\\s*,\\s*(-?[\\d.]+)\\s*\\)`);
  const m = PIPE.match(re);
  if (!m) throw new Error(`grade-model: could not read ${name} from Pipeline.js`);
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

export function shippedParams() {
  const look = PIPE.match(/agxLook:\s*new THREE\.Vector4\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
  if (!look) throw new Error('grade-model: could not read agxLook from Pipeline.js');
  return {
    exposure: num(/\n\s*exposure:\s*([\d.]+)/, 'exposure'),
    agxLook: [1, 2, 3, 4].map((i) => parseFloat(look[i])),
    lift: vec3('lift'),
    gamma: vec3('gamma'),
    gain: vec3('gain'),
    contrast: num(/\n\s*contrast:\s*([\d.]+)/, 'contrast'),
    saturation: num(/\n\s*saturation:\s*([\d.]+)/, 'saturation'),
    splitShadow: vec3('splitShadow'),
    splitHighlight: vec3('splitHighlight'),
    splitBalance: num(/\n\s*splitBalance:\s*([\d.]+)/, 'splitBalance'),
  };
}

/* ---------------------------------------------------------------------------
 * The chain. Mirrors shaders/lib.js agxDisplay() and shaders/grade.js
 * FINAL_FRAG line for line; the comments name the source line.
 * ------------------------------------------------------------------------ */

// GLSL mat3(a,b,c, d,e,f, g,h,i) is COLUMN-major — see the Contract Amendment
// forbidding the "fix" that transposes these. Column k is (a,b,c) for k=0.
const AGX_IN_COLS = [
  [0.8566271533, 0.1373189729, 0.1118982130],
  [0.0951212405, 0.7612419906, 0.0767994186],
  [0.0482516061, 0.1014390365, 0.8113023684],
];
const AGX_OUT_COLS = [
  [1.1271005818, -0.1413297635, -0.1413297635],
  [-0.1106066431, 1.1578237022, -0.1106066431],
  [-0.0164939387, -0.0164939387, 1.2519364066],
];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

const mul = (cols, v) => [0, 1, 2].map((r) => cols[0][r] * v[0] + cols[1][r] * v[1] + cols[2][r] * v[2]);
const LUMA = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

function agxContrast(x) {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

export function agxDisplay(color, look) {
  let c = color.map((v) => Math.max(v, 0));
  c = mul(AGX_IN_COLS, c).map((v) => Math.max(v, 1e-10));
  c = c.map((v) => (Math.log2(v) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV));
  c = c.map(clamp01).map(agxContrast);
  c = c.map((v) => v * look[0] + look[1]);
  c = c.map((v) => Math.pow(Math.max(v, 0), look[2]));
  const l = LUMA(c);
  c = c.map((v) => clamp01(l + look[3] * (v - l)));
  return mul(AGX_OUT_COLS, c).map(clamp01);
}

/* ---------------------------------------------------------------------------
 * AgX, BACKWARDS.
 *
 * Every stage of `agxDisplay` is invertible, which is what lets a candidate
 * `exposure` or `agxLook` be scored against a capture that already exists
 * instead of against a fresh 90-second render:
 *
 *   AGX_OUT matrix        exact (3x3 inverse)
 *   saturation about luma exact — the forward map preserves luma, so the pivot
 *                         is read straight off the output
 *   pow(x, power)         exact
 *   x * slope + offset    exact
 *   agxContrast()         a monotonic 6th-order polynomial on [0,1]; bisected
 *   log2 / EV normalise   exact
 *   AGX_IN matrix         exact
 *
 * WHERE IT STOPS BEING EXACT, and it is the same caveat the rest of the
 * offline path carries: the forward chain clamps to [0,1] in three places. A
 * channel that arrived at a rail carried no information into the display
 * value, so the inverse can only return the rail. Count those pixels before
 * believing a magnitude.
 * ------------------------------------------------------------------------ */

/** Invert a 3x3 given as COLUMNS, returning columns. */
function invCols(cols) {
  const m = (r, c) => cols[c][r];
  const a = m(0, 0), b = m(0, 1), c0 = m(0, 2);
  const d = m(1, 0), e = m(1, 1), f = m(1, 2);
  const g = m(2, 0), h = m(2, 1), i = m(2, 2);
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c0 * C;
  if (Math.abs(det) < 1e-12) throw new Error('grade-model: singular AgX matrix');
  // Each row below is a COLUMN of the inverse — the adjugate's cofactors come
  // out transposed, which is exactly the layout `mul()` wants. Do NOT add a
  // transpose here: the same column-major/row-major confusion that CONTRACT.md
  // warns about for AGX_IN/AGX_OUT applies to their inverses, and transposing
  // once too often silently tints every result rather than throwing.
  return [
    [A / det, B / det, C / det],
    [-(b * i - c0 * h) / det, (a * i - c0 * g) / det, -(a * h - b * g) / det],
    [(b * f - c0 * e) / det, -(a * f - c0 * d) / det, (a * e - b * d) / det],
  ];
}

const AGX_IN_INV = invCols(AGX_IN_COLS);
const AGX_OUT_INV = invCols(AGX_OUT_COLS);

/** Inverse of `agxContrast` on [0,1], by bisection. Monotonic there. */
function agxContrastInv(y) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = 0.5 * (lo + hi);
    if (agxContrast(mid) < y) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Display-referred AgX output -> scene-linear radiance (PRE-exposure, POST
 * bloom — bloom is added upstream of `color *= uExposure`).
 * @param {number[]} disp
 * @param {number[]} look slope, offset, power, saturation
 * @returns {number[]} scene-linear RGB, pre-exposure
 */
export function agxInverse(disp, look) {
  let c = mul(AGX_OUT_INV, disp);
  const l = LUMA(c);                       // saturation is luma-preserving
  c = c.map((v) => l + (v - l) / look[3]);
  c = c.map((v) => Math.pow(Math.max(v, 0), 1 / look[2]));
  c = c.map((v) => (v - look[1]) / look[0]);
  c = c.map((v) => agxContrastInv(clamp01(v)));
  c = c.map((v) => Math.pow(2, v * (AGX_MAX_EV - AGX_MIN_EV) + AGX_MIN_EV));
  return mul(AGX_IN_INV, c);
}

/** sRGB OETF, as the renderer's colorspace_fragment applies it. */
export function srgbOETF(x) {
  x = clamp01(x);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/**
 * Scene-linear RGB radiance -> final 8-bit sRGB code values.
 * @param {number[]} linear scene-referred RGB (pre-exposure)
 * @param {object} p grade params
 * @returns {{disp:number[], code:number[], luma:number}}
 */
export function grade(linear, p) {
  let disp = agxDisplay(linear.map((v) => v * p.exposure), p.agxLook);

  // FINAL_FRAG: gain, then inverse gamma.
  disp = disp.map((v, i) => v * p.gain[i]);
  disp = disp.map((v, i) => Math.pow(Math.max(v, 0), 1 / Math.max(p.gamma[i], 0.01)));

  // Filmic S-contrast, mixed toward smoothstep so it cannot leave [0,1].
  const k = Math.min(0.9, Math.max(-0.9, (p.contrast - 1) * 2));
  disp = disp.map((v) => v + (v * v * (3 - 2 * v) - v) * k);

  // Black floor.
  disp = disp.map((v, i) => p.lift[i] + (1 - p.lift[i]) * clamp01(v));

  // Saturation about luma.
  const l1 = LUMA(disp);
  disp = disp.map((v) => l1 + (v - l1) * p.saturation).map(clamp01);

  // Split toning.
  const bal = Math.min(0.95, Math.max(0.05, p.splitBalance));
  const lum = LUMA(disp);
  const sw = 1 - smoothstep(0, bal, lum);
  const hw = smoothstep(bal, 1, lum);
  disp = disp.map((v, i) => clamp01(v + p.splitShadow[i] * sw + p.splitHighlight[i] * hw));

  // FINAL_FRAG writes displayToLinear(disp) and three's colorspace_fragment
  // applies the sRGB OETF on top. Since 2026-09-02 `displayToLinear` is the
  // true sRGB EOTF, so the pair CANCELS and the code value is the display
  // value. It used to be `pow(disp, 2.2)`, which is not that inverse and
  // crushed everything below display 0.35 — every toe exchange rate this file
  // printed before the fix was computed through that crush and is too small.
  const code = disp.map((v) => clamp01(v) * 255);
  return { disp, code, luma: 0.2126 * code[0] + 0.7152 * code[1] + 0.0722 * code[2] };
}

/** Neutral scene-linear radiance L -> final code values. */
export const greyCode = (L, p) => grade([L, L, L], p);

/** Invert: what neutral scene-linear radiance lands at this display luma? */
export function inverse(targetLuma, p) {
  let lo = 1e-6, hi = 64;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (greyCode(mid, p).luma < targetLuma) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------ */
function main() {
  const argv = process.argv;
  const p = shippedParams();
  const over = argv.indexOf('--params');
  if (over !== -1) Object.assign(p, JSON.parse(argv[over + 1]));

  const inv = argv.indexOf('--invert');
  if (inv !== -1) {
    const t = parseFloat(argv[inv + 1]);
    const L = inverse(t, p);
    console.log(`display luma ${t}  <-  scene-linear ${L.toExponential(4)}  (${(Math.log2(L)).toFixed(2)} EV rel. 1.0)`);
    return;
  }

  console.log('shipped grade parameters');
  for (const [k, v] of Object.entries(p)) console.log(`  ${k.padEnd(16)} ${JSON.stringify(v)}`);

  // The black point: what a zero-radiance pixel actually renders as.
  const black = grade([0, 0, 0], p);
  console.log('\nBLACK POINT (scene radiance 0)');
  console.log(`  display-space RGB ${black.disp.map((v) => v.toFixed(4)).join(' / ')}`);
  console.log(`  8-bit code    RGB ${black.code.map((v) => v.toFixed(1)).join(' / ')}   luma ${black.luma.toFixed(1)}`);
  const mx = Math.max(...black.code), mn = Math.min(...black.code);
  console.log(`  HSV saturation    ${(mx > 0 ? (mx - mn) / mx : 0).toFixed(3)}   (1.000 = a fully saturated hue)`);

  // Where each channel crosses zero, i.e. how much of the toe is destroyed.
  console.log('\nPER-CHANNEL CLIP POINT on a NEUTRAL ramp');
  console.log('  the display luma below which that channel is hard-clipped to 0');
  for (let c = 0; c < 3; c++) {
    let lo = 1e-6, hi = 64, found = false;
    for (let i = 0; i < 80; i++) {
      const mid = Math.sqrt(lo * hi);
      if (greyCode(mid, p).code[c] <= 0.5) { lo = mid; found = true; } else hi = mid;
    }
    const L = Math.sqrt(lo * hi);
    const at = greyCode(L, p);
    console.log(`  ${'RGB'[c]}: ${found ? `clipped below display luma ${at.luma.toFixed(1)} (scene-linear ${L.toExponential(3)})` : 'never clipped'}`);
  }

  console.log('\nNEUTRAL TRANSFER CURVE');
  console.log('  scene-linear   ->   code R    G    B    luma    sat');
  for (const L of [0, 0.002, 0.005, 0.01, 0.02, 0.04, 0.08, 0.15, 0.3, 0.6, 1.2, 2.5, 5, 10]) {
    const g = greyCode(L, p);
    const mx2 = Math.max(...g.code), mn2 = Math.min(...g.code);
    console.log(
      `  ${L.toFixed(3).padStart(8)}       ${g.code.map((v) => v.toFixed(0).padStart(4)).join(' ')}  ` +
      `${g.luma.toFixed(1).padStart(6)}  ${(mx2 > 0 ? (mx2 - mn2) / mx2 : 0).toFixed(3)}`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
