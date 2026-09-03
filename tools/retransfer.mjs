#!/usr/bin/env node
/**
 * OFFLINE RE-GRADE — measure a capture's tonal placement, and apply a candidate
 * grade change to it NUMERICALLY, without rendering anything.
 *
 *   node tools/retransfer.mjs shots/toefix/hero.png                  # measure only
 *   node tools/retransfer.mjs shots/**\/hero.png --map encode=srgb   # one candidate
 *   node tools/retransfer.mjs shots/w_a0/vista.png \
 *        --map 'encode=srgb;lift=0.010,0.012,0.018' --out shots/cand
 *
 * WHY THIS IS EXACT, and where it stops being exact.
 *
 * FINAL_FRAG computes a display-referred colour `disp`, then writes
 * `agxToLinear(disp)` and lets three's `colorspace_fragment` apply the sRGB
 * OETF. So the shipped 8-bit output is
 *
 *     code = 255 * OETF( disp ^ 2.2 )
 *
 * That map is strictly monotonic per channel, so it INVERTS exactly:
 *
 *     disp = ( EOTF( code / 255 ) ) ^ (1 / 2.2)
 *
 * Every capture in `shots/` can therefore be taken back to the display value
 * the grade actually produced, a candidate change applied there, and the frame
 * re-encoded — with no rebuild, and with none of the cross-build contamination
 * the Contract Amendments warn about (A/B MEASUREMENT RIG): this is the SAME
 * frame, not a second one.
 *
 * The grade stages between the tonemap and the encode are also invertible, so
 * `lift`, `saturation`, `splitShadow`/`splitHighlight` and `gain` can each be
 * re-applied to an existing capture. See `unGrade()` for the exact chain and
 * for which step is solved iteratively.
 *
 * THE LIMITS, which matter and are reported rather than hidden:
 *  - 8-bit quantisation. The shipped encode CRUSHES the toe, so many distinct
 *    `disp` values collide onto one output code down there; the inverse
 *    therefore expands one code into two or three. Region statistics (medians,
 *    percentiles, area fractions) are accurate; a magnified crop of a predicted
 *    image will show posterisation the real build will not have.
 *  - CLIPPING IS INFORMATION LOSS. A channel that hit 0 or 1.0 inside the grade
 *    cannot be recovered, so a candidate that would have opened it up is
 *    UNDER-estimated by this tool. Every report prints the clipped population;
 *    when it is large, believe the direction and not the magnitude.
 *  - Grain, dither and the 1% scanline are inside `disp` and are carried
 *    through with everything else. They are unbiased, so they do not move a
 *    median or a percentile, but they widen a histogram's bottom bins.
 *  - The vignette is undone from the pixel's own screen position, which assumes
 *    `vignette.amount` / `.smoothness` matched the shipped values at capture
 *    time. Pass `--vig a,s` if a capture used different ones.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { readPng } from './png.mjs';
import { agxDisplay, agxInverse, shippedParams } from './grade-model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------------------
 * The shipped grade, mirrored from src/render/Pipeline.js `params.grade` and
 * `params.vignette`. Keep these in step with the pipeline — a candidate is only
 * meaningful relative to the values the capture was actually shot with.
 * ------------------------------------------------------------------------ */
const SHIPPED = {
  exposure: 0.662,
  agxLook: [1.13, 0.0, 0.94, 0.88],
  lift: [0.022, 0.025, 0.038],
  gain: [1.035, 1.0, 0.950],
  gamma: [1.0, 1.0, 1.0],
  contrast: 1.24,
  saturation: 0.94,
  splitShadow: [-0.038, -0.008, 0.058],
  splitHighlight: [0.032, 0.012, -0.024],
  splitBalance: 0.42,
  vignette: 0.26,
  vignetteSmooth: 0.42,
  // THE SHIPPED ENCODE IS NOW AN IDENTITY. Before 2026-09-02 FINAL_FRAG wrote
  // pow(disp, 2.2) and let three's sRGB OETF run on top, so code =
  // 255 * OETF(disp^2.2) — a hard crush below display 0.35. `displayToLinear`
  // is the true sRGB EOTF now, so the pair cancels and code = 255 * disp.
  // Pass `--from 2.2` to measure a capture taken before that commit; every
  // shot directory older than shots/iter31 needs it.
  encode: 'srgb',
};

const srgbEOTF = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const srgbOETF = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};

/* --- the shipped encode, and its exact inverse ---------------------------- */

/** code (0-255) -> `disp`, the display value FINAL_FRAG produced. Exact. */
function codeToDisp(code, power) {
  if (power === 'srgb') return code / 255;
  return Math.pow(srgbEOTF(code / 255), 1 / power);
}

/**
 * `disp` -> code, for a candidate final transfer.
 *   'srgb'  : agxToLinear replaced by the true sRGB EOTF, so the pair
 *             round-trips and the grade's display intent reaches the screen.
 *   number  : the shipped form with a different power.
 */
function dispToCode(disp, encode) {
  const v = encode === 'srgb' ? disp : srgbOETF(Math.pow(Math.max(disp, 0), encode));
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/* --- the grade chain, forward and back ------------------------------------
 * FINAL_FRAG, from the tonemap down:
 *    GAIN -> GAMMA -> CONTRAST -> LIFT -> SATURATION -> SPLIT -> VIGNETTE
 *    -> damage -> scanline -> grain -> dither -> encode
 *
 * EVERY stage in capitals is undone here, back to the raw AgX output. That is
 * the whole grade: only `exposure` and `agxLook` sit above the tonemap, and
 * those are not functions of the code value so they cannot be evaluated
 * offline at all. Each stage is strictly monotonic per channel, so each one
 * inverts; `contrast` has no closed form and is bisected.
 * ---------------------------------------------------------------------- */

/**
 * Filmic S-contrast, exactly as FINAL_FRAG writes it: a mix toward the
 * smoothstep of the value itself, pivoted at 0.5.
 */
const contrastK = (contrast) => Math.max(-0.9, Math.min(0.9, (contrast - 1) * 2));
const applyContrast1 = (x, k) => {
  const v = clamp01(x);
  return v + k * (v * v * (3 - 2 * v) - v);
};

/**
 * Inverse S-contrast, by bisection. The forward map's derivative is
 * (1 - k) + 6k*x*(1 - x), which is strictly positive for |k| < 0.9 — it is
 * monotonic on [0,1] with fixed endpoints, so 24 halvings land inside 1e-7,
 * three orders of magnitude below a code value.
 */
function unContrast1(y, k) {
  if (Math.abs(k) < 1e-9) return clamp01(y);
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    if (applyContrast1(mid, k) < y) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Forward split toning, exactly as FINAL_FRAG writes it. */
function applySplit(c, g) {
  const lum = LUMA(c[0], c[1], c[2]);
  const ws = 1 - smoothstep(0, g.splitBalance, lum);
  const wh = smoothstep(g.splitBalance, 1, lum);
  for (let i = 0; i < 3; i++) {
    c[i] = clamp01(c[i] + g.splitShadow[i] * ws + g.splitHighlight[i] * wh);
  }
}

/**
 * Inverse split toning. The forward map is additive with weights that depend on
 * the OUTPUT's own luma, so it is solved by fixed-point iteration rather than
 * in closed form: the offsets are bounded by 0.058, which makes the iteration a
 * strong contraction — six passes converge to well under a code value.
 */
function unSplit(c, g) {
  const y = [c[0], c[1], c[2]];
  const x = [c[0], c[1], c[2]];
  for (let k = 0; k < 6; k++) {
    const lum = LUMA(x[0], x[1], x[2]);
    const ws = 1 - smoothstep(0, g.splitBalance, lum);
    const wh = smoothstep(g.splitBalance, 1, lum);
    for (let i = 0; i < 3; i++) x[i] = y[i] - g.splitShadow[i] * ws - g.splitHighlight[i] * wh;
  }
  c[0] = x[0]; c[1] = x[1]; c[2] = x[2];
}

/**
 * Undo the whole chain — VIGNETTE -> SPLIT -> SATURATION -> LIFT -> CONTRAST
 * -> GAMMA -> GAIN — leaving the raw display value the tonemap produced.
 * Saturation is exactly invertible because it is luma-preserving:
 * `luma(out) == luma(in)` by construction, so the pivot is read straight off
 * the output.
 */
/**
 * The low-AP / hit rim, and its inverse. FINAL_FRAG applies it AFTER the
 * vignette as `disp += C * dv * (1 - disp)`, a screen blend, so it inverts per
 * channel as `(disp - C*dv) / (1 - C*dv)`. `dv` already carries uDamage and the
 * pulse; the caller supplies them because a still cannot state the sine's phase.
 */
const DAMAGE_COLOR = [0.85, 0.06, 0.05];
const applyDamage = (c, dv) => {
  for (let i = 0; i < 3; i++) c[i] += DAMAGE_COLOR[i] * dv * (1 - c[i]);
};
const unDamage = (c, dv) => {
  for (let i = 0; i < 3; i++) {
    const k = DAMAGE_COLOR[i] * dv;
    if (k > 1e-6) c[i] = (c[i] - k) / (1 - k);
  }
};

function unGrade(c, g, vig, dv) {
  if (dv > 1e-6) unDamage(c, dv);
  if (vig > 1e-6) for (let i = 0; i < 3; i++) c[i] /= vig;
  unSplit(c, g);
  const l = LUMA(c[0], c[1], c[2]);
  for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) / g.saturation;
  for (let i = 0; i < 3; i++) c[i] = (c[i] - g.lift[i]) / (1 - g.lift[i]);
  const k = contrastK(g.contrast);
  for (let i = 0; i < 3; i++) c[i] = unContrast1(c[i], k);
  for (let i = 0; i < 3; i++) {
    c[i] = Math.pow(Math.max(c[i], 0), g.gamma[i]) / g.gain[i];
  }
}

const applyLift = (c, g) => {
  for (let i = 0; i < 3; i++) c[i] = g.lift[i] + (1 - g.lift[i]) * clamp01(c[i]);
};
const applySat = (c, g) => {
  const l = LUMA(c[0], c[1], c[2]);
  for (let i = 0; i < 3; i++) c[i] = clamp01(l + (c[i] - l) * g.saturation);
};

/**
 * Re-apply the chain with (possibly different) parameters, and optionally in a
 * different ORDER.
 *
 *   'shipped'  lift -> saturation -> split -> vignette   (what FINAL_FRAG does)
 *   'liftlast' saturation -> split -> vignette -> lift
 *
 * The second exists because the black floor's own comment claims it is applied
 * "AFTER the contrast so nothing downstream can crush it" — and split toning
 * and the vignette are both downstream and both crush it. Under 'shipped' the
 * real per-channel floor is `lift + splitShadow` scaled by the vignette, which
 * is NEGATIVE in red; under 'liftlast' it is exactly `lift`.
 */
function reGrade(c, g, vig, dv) {
  for (let i = 0; i < 3; i++) {
    c[i] = Math.pow(Math.max(c[i] * g.gain[i], 0), 1 / Math.max(g.gamma[i], 0.01));
  }
  const k = contrastK(g.contrast);
  for (let i = 0; i < 3; i++) c[i] = applyContrast1(c[i], k);

  if (g.order === 'liftlast') {
    applySat(c, g);
    applySplit(c, g);
    if (vig > 1e-6) for (let i = 0; i < 3; i++) c[i] *= vig;
    applyLift(c, g);
  } else {
    applyLift(c, g);
    applySat(c, g);
    applySplit(c, g);
    if (vig > 1e-6) for (let i = 0; i < 3; i++) c[i] *= vig;
  }
  if (dv > 1e-6) applyDamage(c, dv);
}

/* --- statistics ----------------------------------------------------------- */

function hist256(data, n, ch) {
  const h = new Float64Array(256);
  for (let p = ch, i = 0; i < n; i++, p += 4) h[data[p]]++;
  return h;
}

/** Percentile of a 256-bin histogram, in code values. */
function hq(h, n, f) {
  let acc = 0;
  const want = f * n;
  for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= want) return v; }
  return 255;
}

function describe(data, n) {
  const H = [hist256(data, n, 0), hist256(data, n, 1), hist256(data, n, 2)];
  const lum = new Float64Array(256);
  let zeroAll = 0, sat255 = 0;
  // darkest-1% colour: collect by luma rank using a luma histogram
  const lumH = new Float64Array(256);
  for (let p = 0, i = 0; i < n; i++, p += 4) {
    const l = Math.round(LUMA(data[p], data[p + 1], data[p + 2]));
    lumH[l < 0 ? 0 : l > 255 ? 255 : l]++;
    if (data[p] === 0 && data[p + 1] === 0 && data[p + 2] === 0) zeroAll++;
    if (data[p] === 255 || data[p + 1] === 255 || data[p + 2] === 255) sat255++;
  }
  lum.set(lumH);
  // mean RGB of the darkest 1% by luma
  const cut = hq(lumH, n, 0.01);
  let dn = 0, dR = 0, dG = 0, dB = 0;
  for (let p = 0, i = 0; i < n; i++, p += 4) {
    if (LUMA(data[p], data[p + 1], data[p + 2]) <= cut) {
      dn++; dR += data[p]; dG += data[p + 1]; dB += data[p + 2];
    }
  }
  const perCh = H.map((h) => ({
    zero: (100 * h[0]) / n,
    p001: hq(h, n, 0.001), p01: hq(h, n, 0.01), p05: hq(h, n, 0.05),
    med: hq(h, n, 0.5),
    p99: hq(h, n, 0.99), p999: hq(h, n, 0.999),
    full: (100 * h[255]) / n,
    shoulder: (100 * (h.slice(230, 255).reduce((a, b) => a + b, 0))) / n,
  }));
  return {
    n, H, lumH,
    ch: perCh,
    zeroAll: (100 * zeroAll) / n,
    sat255: (100 * sat255) / n,
    lumP: [0.001, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99].map((f) => hq(lumH, n, f)),
    darkRGB: dn ? [dR / dn, dG / dn, dB / dn] : [0, 0, 0],
    darkCut: cut,
    b8: (100 * lumH.slice(0, 8).reduce((a, b) => a + b, 0)) / n,
    b16: (100 * lumH.slice(0, 16).reduce((a, b) => a + b, 0)) / n,
    b24: (100 * lumH.slice(0, 24).reduce((a, b) => a + b, 0)) / n,
  };
}

function report(tag, s) {
  const [r, g, b] = s.ch;
  const dz = s.darkRGB;
  const br = dz[0] > 0.05 ? (dz[2] / dz[0]).toFixed(2) : 'inf';
  const p = s.lumP;
  console.log(`  ${tag.padEnd(11)} luma p.1/1/5/25/50/75/95/99 = ` +
    `${p.map((v) => String(v).padStart(3)).join(' ')}`);
  console.log(`  ${''.padEnd(11)} BLACK  zero% R ${r.zero.toFixed(2)} G ${g.zero.toFixed(2)} B ${b.zero.toFixed(2)}` +
    `  allzero ${s.zeroAll.toFixed(3)}%  darkest-1% RGB ${dz.map((v) => v.toFixed(1).padStart(5)).join('')}  B/R ${br}`);
  console.log(`  ${''.padEnd(11)} TOE    <8 ${s.b8.toFixed(2)}%  <16 ${s.b16.toFixed(2)}%  <24 ${s.b24.toFixed(2)}%` +
    `   per-ch p1  R ${String(r.p01).padStart(3)} G ${String(g.p01).padStart(3)} B ${String(b.p01).padStart(3)}`);
  console.log(`  ${''.padEnd(11)} SHOULDER 230-254 ${(r.shoulder + g.shoulder + b.shoulder).toFixed(3)}%` +
    `  at-255 R ${r.full.toFixed(3)} G ${g.full.toFixed(3)} B ${b.full.toFixed(3)}  any-255 ${s.sat255.toFixed(3)}%`);
}

function lowHist(s) {
  const names = ['R', 'G', 'B'];
  console.log('  low-end histogram, codes 0..15 (per mille of frame)');
  for (let c = 0; c < 3; c++) {
    const row = [];
    for (let v = 0; v < 16; v++) row.push(((1000 * s.H[c][v]) / s.n).toFixed(1).padStart(6));
    console.log(`    ${names[c]} ${row.join('')}`);
  }
}

/* --- minimal PNG writer (RGB, filter 0) ---------------------------------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(path, W, H, rgba) {
  const raw = Buffer.alloc(H * (1 + W * 3));
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* --- candidate spec parsing ---------------------------------------------- */

function parseMap(spec) {
  const cand = { ...SHIPPED, lift: [...SHIPPED.lift], gain: [...SHIPPED.gain],
    gamma: [...SHIPPED.gamma], agxLook: [...SHIPPED.agxLook],
    splitShadow: [...SHIPPED.splitShadow], splitHighlight: [...SHIPPED.splitHighlight] };
  let touchesGrade = false;
  let touchesAgx = false;
  for (const part of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    const nums = () => v.split(',').map(Number);
    const tri = () => (v.includes(',') ? nums() : [Number(v), Number(v), Number(v)]);
    switch (k) {
      case 'encode': cand.encode = v === 'srgb' ? 'srgb' : Number(v); break;
      case 'exposure': cand.exposure = Number(v); touchesGrade = true; touchesAgx = true; break;
      case 'agx': cand.agxLook = nums(); touchesGrade = true; touchesAgx = true; break;
      case 'slope': cand.agxLook = [Number(v), cand.agxLook[1], cand.agxLook[2], cand.agxLook[3]];
        touchesGrade = true; touchesAgx = true; break;
      case 'power': cand.agxLook = [cand.agxLook[0], cand.agxLook[1], Number(v), cand.agxLook[3]];
        touchesGrade = true; touchesAgx = true; break;
      case 'damage': cand.damage = Number(v); touchesGrade = true; break;
      case 'lift': cand.lift = tri(); touchesGrade = true; break;
      case 'gain': cand.gain = tri(); touchesGrade = true; break;
      case 'gamma': cand.gamma = tri(); touchesGrade = true; break;
      case 'contrast': cand.contrast = Number(v); touchesGrade = true; break;
      case 'split': cand.splitShadow = nums(); touchesGrade = true; break;
      case 'splitHi': cand.splitHighlight = nums(); touchesGrade = true; break;
      case 'bal': cand.splitBalance = Number(v); touchesGrade = true; break;
      case 'sat': cand.saturation = Number(v); touchesGrade = true; break;
      case 'vig': cand.vignette = Number(v); touchesGrade = true; break;
      case 'vigSmooth': cand.vignetteSmooth = Number(v); touchesGrade = true; break;
      case 'order': cand.order = v; touchesGrade = true; break;
      default: throw new Error(
        `unknown map key '${k}' ` +
        '(encode|exposure|agx|slope|power|lift|gain|gamma|contrast|split|splitHi|' +
        'bal|sat|vig|vigSmooth|damage|order)');
    }
  }
  cand._grade = touchesGrade;
  cand._agx = touchesAgx;
  return cand;
}

function describeCand(c) {
  const bits = [];
  if (c.encode !== SHIPPED.encode) bits.push(`encode ${SHIPPED.encode} -> ${c.encode}`);
  if (c.exposure !== SHIPPED.exposure) bits.push(`exposure ${c.exposure}`);
  if (String(c.agxLook) !== String(SHIPPED.agxLook)) bits.push(`agxLook ${c.agxLook}`);
  if ((c.damage || 0) !== 0) bits.push(`damage ${c.damage}`);
  if (String(c.lift) !== String(SHIPPED.lift)) bits.push(`lift ${c.lift}`);
  if (String(c.gain) !== String(SHIPPED.gain)) bits.push(`gain ${c.gain}`);
  if (String(c.gamma) !== String(SHIPPED.gamma)) bits.push(`gamma ${c.gamma}`);
  if (c.contrast !== SHIPPED.contrast) bits.push(`contrast ${c.contrast}`);
  if (c.vignette !== SHIPPED.vignette) bits.push(`vignette ${c.vignette}`);
  if (c.vignetteSmooth !== SHIPPED.vignetteSmooth) bits.push(`vigSmooth ${c.vignetteSmooth}`);
  if (c.order) bits.push(`order ${c.order}`);
  if (String(c.splitShadow) !== String(SHIPPED.splitShadow)) bits.push(`splitShadow ${c.splitShadow}`);
  if (String(c.splitHighlight) !== String(SHIPPED.splitHighlight)) bits.push(`splitHigh ${c.splitHighlight}`);
  if (c.splitBalance !== SHIPPED.splitBalance) bits.push(`balance ${c.splitBalance}`);
  if (c.saturation !== SHIPPED.saturation) bits.push(`sat ${c.saturation}`);
  return bits.length ? bits.join(', ') : 'identity';
}

/* --- transform ------------------------------------------------------------ */

function transform(img, cand, vigParams, dmgParams) {
  const { width: W, height: H, data } = img;
  const out = new Uint8Array(data.length);
  const c = [0, 0, 0];
  let clipLo = 0, clipHi = 0;
  const [vA, vS] = vigParams;
  const [dmgShipped, dmgPulse] = dmgParams;
  // A change above the tonemap needs the scene radiance back, which costs an
  // AgX inversion per pixel — so only pay for it when the candidate asks.
  const deep = cand._agx;
  for (let y = 0; y < H; y++) {
    const dy = (y + 0.5) / H - 0.5;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const dx = (x + 0.5) / W - 0.5;
      const rEdge = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.41421356);
      const vig = 1 - vA * smoothstep(Math.min(vS, 0.98), 1, rEdge);
      const vigC = 1 - cand.vignette *
        smoothstep(Math.min(cand.vignetteSmooth, 0.98), 1, rEdge);
      // FINAL_FRAG: dv = smoothstep(0.60, 1.02, rEdge)^2 * uDamage * pulse.
      const dr = smoothstep(0.60, 1.02, rEdge);
      const dmgRamp = dr * dr;

      c[0] = codeToDisp(data[p], SHIPPED.encode);
      c[1] = codeToDisp(data[p + 1], SHIPPED.encode);
      c[2] = codeToDisp(data[p + 2], SHIPPED.encode);

      if (cand._grade) {
        // A channel already at the rail carried no information into the code
        // value; count it so the caveat is quantified rather than assumed away.
        if (data[p] === 0 || data[p + 1] === 0 || data[p + 2] === 0) clipLo++;
        if (data[p] === 255 || data[p + 1] === 255 || data[p + 2] === 255) clipHi++;
        const dvS = dmgShipped > 1e-6 ? dmgShipped * dmgPulse * dmgRamp : 0;
        const dvC = cand.damage > 1e-6 ? cand.damage * dmgPulse * dmgRamp : 0;
        unGrade(c, SHIPPED, vig, dvS);
        if (deep) {
          const lin = agxInverse(c, SHIPPED.agxLook);
          for (let i = 0; i < 3; i++) lin[i] *= cand.exposure / SHIPPED.exposure;
          const d2 = agxDisplay(lin, cand.agxLook);
          c[0] = d2[0]; c[1] = d2[1]; c[2] = d2[2];
        }
        reGrade(c, cand, vigC, dvC);
      }

      out[p] = dispToCode(clamp01(c[0]), cand.encode);
      out[p + 1] = dispToCode(clamp01(c[1]), cand.encode);
      out[p + 2] = dispToCode(clamp01(c[2]), cand.encode);
      out[p + 3] = 255;
    }
  }
  return { out, clipLo: (100 * clipLo) / (W * H), clipHi: (100 * clipHi) / (W * H) };
}

/* --- main ----------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const outDir = flag('out') ? resolve(ROOT, flag('out')) : null;
const mapSpecs = argv.reduce((acc, a, i) => (a === '--map' ? [...acc, argv[i + 1]] : acc), []);
const vigParams = flag('vig') ? flag('vig').split(',').map(Number)
  : [SHIPPED.vignette, SHIPPED.vignetteSmooth];
// `--dmg uDamage[,pulse]` states what the low-AP/hit rim was doing WHEN THE
// CAPTURE WAS TAKEN, which nothing in the PNG records. Read it off
// tools/probes/tonebloom.js (`redRim.uDamage`) or a pose note. Default 0: with
// no rim to undo, a candidate that adds one still works.
const dmgParams = flag('dmg')
  ? (() => { const a = flag('dmg').split(',').map(Number); return [a[0], a.length > 1 ? a[1] : 0.86]; })()
  : [0, 0.86];
const skip = new Set();
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) skip.add(i + 1);
const files = argv.filter((a, i) => !a.startsWith('--') && !skip.has(i));

if (!files.length) {
  console.error('usage: node tools/retransfer.mjs <png ...> [--map SPEC]... [--out DIR]' +
    ' [--hist] [--vig a,s] [--from 2.2|srgb]\n' +
    "  SPEC keys: encode lift gain gamma contrast split splitHi bal sat vig vigSmooth order\n" +
    "  e.g. --map 'contrast=1.40;lift=0.014,0.016,0.026'");
  process.exit(1);
}
if (outDir) mkdirSync(outDir, { recursive: true });

// `--from 2.2` measures a capture taken BEFORE the encode fix (2026-09-02);
// without it those frames are read through the wrong inverse and every toe
// statistic comes out wrong. Must run before parseMap, which snapshots SHIPPED.
const fromEncode = flag('from');
if (fromEncode) SHIPPED.encode = fromEncode === 'srgb' ? 'srgb' : Number(fromEncode);

const cands = mapSpecs.map(parseMap);

// The code mapping is the whole story for an encode-only candidate, so print it.
for (const cand of cands) {
  if (cand._grade) continue;
  const probe = [0, 1, 2, 3, 5, 8, 12, 16, 24, 32, 48, 64, 96, 128, 180, 230, 255];
  console.log(`CODE MAPPING  [${describeCand(cand)}]`);
  console.log('  ' + probe.map((v) =>
    `${v}->${dispToCode(codeToDisp(v, SHIPPED.encode), cand.encode)}`).join('  '));
}

for (const f of files) {
  const path = resolve(ROOT, f);
  let img;
  try { img = readPng(path); } catch (e) { console.log(`\n=== ${f} — SKIPPED (${e.message})`); continue; }
  const n = img.width * img.height;
  console.log(`\n=== ${f}  ${img.width}x${img.height} ===`);
  const base = describe(img.data, n);
  report('shipped', base);
  if (has('hist')) lowHist(base);

  for (const cand of cands) {
    const { out, clipLo, clipHi } = transform(img, cand, vigParams, dmgParams);
    const s = describe(out, n);
    console.log(`  -- candidate: ${describeCand(cand)}`);
    report('candidate', s);
    if (has('hist')) lowHist(s);
    if (cand._grade) {
      console.log(`  ${''.padEnd(11)} CLIPPED IN THE CAPTURE (magnitude under-estimated here):` +
        ` lo ${clipLo.toFixed(2)}%  hi ${clipHi.toFixed(2)}%`);
    }
    if (outDir) {
      const nm = basename(f).replace(/\.png$/, '') + '_' +
        (cand.encode === 'srgb' ? 'srgb' : `e${cand.encode}`) + (cand._grade ? '_g' : '') + '.png';
      const p = resolve(outDir, nm);
      writePng(p, img.width, img.height, out);
      console.log(`  wrote ${p.replace(ROOT + '/', '')}`);
    }
  }
}
