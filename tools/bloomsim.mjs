#!/usr/bin/env node
/**
 * OFFLINE BLOOM — recover a capture's scene-linear radiance and re-run the
 * whole bloom chain on it in JS, with different parameters, without rendering.
 *
 *   node tools/bloomsim.mjs shots/iter32/gameplay.png
 *   node tools/bloomsim.mjs shots/iter32/gameplay.png shots/w40_base/vista.png \
 *        --set 'order=threshold;threshold=0.55;strength=1.6' --out shots/bloomcand
 *
 * WHY. `tools/probes/tonebloom.js` measured the shipped bloom on the live game
 * and found it dead: with `threshold` 1.90 in scene-linear radiance, 0.054% of
 * the gameplay frame is above it, the accumulated bloom buffer's MEAN is
 * 2.1e-5, and its 99.99th percentile is 0.019 — i.e. the pass contributes
 * roughly a fifth of one code value to everything except a handful of pixels.
 * Fixing that means choosing a threshold, a knee, a taper and a strength, and
 * checking each against BOTH a frame with emissives (gameplay) and a frame with
 * a bright sky (vista) — which is four browser captures per candidate, at 60-100
 * seconds each, on a box that has already been killed once by capture pressure.
 *
 * HOW IT IS EXACT. `agxInverse` in tools/grade-model.mjs takes a display value
 * back to the scene-linear radiance the tonemap saw, and `tools/retransfer.mjs`
 * undoes everything below it. So a capture can be taken back to radiance, the
 * bloom chain re-run over it, and the forward transfer re-applied — this is the
 * SAME frame, not a second render of it, so none of the cross-build
 * contamination the Contract Amendments warn about applies.
 *
 * THE THREE LIMITS, and they all point the same way (conservative):
 *  - CLIPPED PIXELS CANNOT BE RECOVERED. The shipped transfer reaches code 255
 *    at 2.60 scene-linear, and `tonebloom` measured a true frame max of 7.5, so
 *    the hottest sources come back at 2.60 and the simulated bloom from them is
 *    UNDER-estimated by up to ~3x. The report prints the clipped population.
 *  - The bloom the capture ALREADY contains is inside the recovered radiance.
 *    Measured, that is 2.1e-5 of mean radiance, so double-counting it is far
 *    below a code value; it would not be if the shipped bloom were working.
 *  - Grain, dither and the scanline ride along in the radiance. They are
 *    unbiased and sub-code, and the downsample chain averages them away.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { readPng } from './png.mjs';
import { agxDisplay, agxInverse, shippedParams } from './grade-model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = shippedParams();

/* --- the shipped bloom parameters, read from Pipeline.js ------------------ */
const PIPE = (await import('node:fs')).readFileSync(resolve(ROOT, 'src/render/Pipeline.js'), 'utf8');
const bnum = (k, d) => {
  const m = PIPE.match(new RegExp(`${k}:\\s*(-?[\\d.]+)`));
  return m ? parseFloat(m[1]) : d;
};
const SHIPPED_BLOOM = {
  threshold: bnum('threshold', 1.9), knee: bnum('knee', 0.6),
  strength: bnum('strength', 1.0), radius: bnum('radius', 1.35),
  clamp: bnum('clamp', 4), mipTaper: bnum('mipTaper', 0.74),
  mips: 6,
  // 'threshold' = the shipped order since 2026-09-03 (threshold each tap, THEN
  // Karis-average). 'karis' = the old order, kept so the change can be re-measured.
  order: 'threshold',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const LUMA3 = (c, i) => 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2];
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-9)); return t * t * (3 - 2 * t); };

/* --- capture -> scene-linear radiance ------------------------------------- */

/**
 * Undo the grade below the tonemap, then AgX, leaving scene-linear radiance
 * (pre-exposure). Mirrors tools/retransfer.mjs `unGrade` — kept as a separate
 * small copy rather than exported from there, because that file's top level is
 * a CLI that runs on import.
 */
function unGradeBelowTonemap(c, vig) {
  if (vig > 1e-6) for (let i = 0; i < 3; i++) c[i] /= vig;
  // split
  const y = [c[0], c[1], c[2]];
  const x = [c[0], c[1], c[2]];
  for (let k = 0; k < 6; k++) {
    const lum = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
    const ws = 1 - smoothstep(0, P.splitBalance, lum);
    const wh = smoothstep(P.splitBalance, 1, lum);
    for (let i = 0; i < 3; i++) x[i] = y[i] - P.splitShadow[i] * ws - P.splitHighlight[i] * wh;
  }
  c[0] = x[0]; c[1] = x[1]; c[2] = x[2];
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) / P.saturation;
  for (let i = 0; i < 3; i++) c[i] = (c[i] - P.lift[i]) / (1 - P.lift[i]);
  const k = Math.max(-0.9, Math.min(0.9, (P.contrast - 1) * 2));
  for (let i = 0; i < 3; i++) {
    let lo = 0, hi = 1;
    for (let it = 0; it < 24; it++) {
      const mid = 0.5 * (lo + hi);
      const v = clamp01(mid);
      if (v + k * (v * v * (3 - 2 * v) - v) < c[i]) lo = mid; else hi = mid;
    }
    c[i] = 0.5 * (lo + hi);
  }
  for (let i = 0; i < 3; i++) c[i] = Math.pow(Math.max(c[i], 0), P.gamma[i]) / P.gain[i];
}

function toRadiance(img) {
  const { width: W, height: H, data } = img;
  const lin = new Float32Array(W * H * 3);
  const c = [0, 0, 0];
  let clipped = 0;
  for (let y = 0; y < H; y++) {
    const dy = (y + 0.5) / H - 0.5;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const dx = (x + 0.5) / W - 0.5;
      const rEdge = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.41421356);
      const vig = 1 - 0.26 * smoothstep(Math.min(0.42, 0.98), 1, rEdge);
      if (data[p] === 255 || data[p + 1] === 255 || data[p + 2] === 255) clipped++;
      c[0] = data[p] / 255; c[1] = data[p + 1] / 255; c[2] = data[p + 2] / 255;
      unGradeBelowTonemap(c, vig);
      const s = agxInverse(c, P.agxLook);
      const q = (y * W + x) * 3;
      lin[q] = Math.max(0, s[0]) / P.exposure;
      lin[q + 1] = Math.max(0, s[1]) / P.exposure;
      lin[q + 2] = Math.max(0, s[2]) / P.exposure;
    }
  }
  return { lin, W, H, clipped: (100 * clipped) / (W * H) };
}

/* --- the bloom chain, mirroring shaders/grade.js -------------------------- */

const maxc3 = (a, i) => Math.max(a[i], Math.max(a[i + 1], a[i + 2]));

/** BLOOM_PREFILTER_FRAG `thresholdSoft`, per RGB triple in place. */
function thresholdSoft(out, o, r, g, b, B) {
  const br = Math.max(r, Math.max(g, b));
  const knee = Math.max(B.knee, 1e-4);
  let soft = Math.min(Math.max(br - B.threshold + knee, 0), 2 * knee);
  soft = (soft * soft) / (4 * knee);
  const contrib = Math.max(soft, br - B.threshold) / Math.max(br, 1e-4);
  out[o] = r * contrib; out[o + 1] = g * contrib; out[o + 2] = b * contrib;
}

/**
 * Prefilter + first downsample to half resolution.
 *
 * The ORDER of the Karis average and the threshold is the whole point of this
 * function. The shipped shader Karis-averages the 13-tap neighbourhood FIRST
 * and thresholds the result, which is why a small hot source contributes
 * nothing: Karis weights each quad by 1/(1+luma), so a lone bright texel among
 * dark neighbours is suppressed several-fold BEFORE it is asked whether it
 * clears the threshold — and it then does not.
 */
function prefilter(lin, W, H, B) {
  const w = Math.max(1, W >> 1), h = Math.max(1, H >> 1);
  const out = new Float32Array(w * h * 3);
  const at = (x, y, i) => lin[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3 + i];
  const quad = new Float32Array(12);
  const acc = [0, 0, 0];
  const t = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The five Karis quads of the 13-tap kernel, at source resolution.
      const cx = x * 2, cy = y * 2;
      const groups = [
        [[cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]],          // centre, weight 0.5
        [[cx - 2, cy - 2], [cx, cy - 2], [cx - 2, cy], [cx, cy]],
        [[cx, cy - 2], [cx + 2, cy - 2], [cx, cy], [cx + 2, cy]],
        [[cx - 2, cy], [cx, cy], [cx - 2, cy + 2], [cx, cy + 2]],
        [[cx, cy], [cx + 2, cy], [cx, cy + 2], [cx + 2, cy + 2]],
      ];
      const gw = [0.5, 0.125, 0.125, 0.125, 0.125];
      acc[0] = acc[1] = acc[2] = 0;
      for (let g = 0; g < 5; g++) {
        for (let k = 0; k < 4; k++) {
          const [sx, sy] = groups[g][k];
          let r = at(sx, sy, 0), gg = at(sx, sy, 1), b = at(sx, sy, 2);
          if (B.order === 'threshold') {
            thresholdSoft(t, 0, r, gg, b, B);
            r = t[0]; gg = t[1]; b = t[2];
          }
          quad[k * 3] = r; quad[k * 3 + 1] = gg; quad[k * 3 + 2] = b;
        }
        let ws = 0, kr = 0, kg = 0, kb = 0;
        for (let k = 0; k < 4; k++) {
          const wk = 1 / (1 + LUMA3(quad, k * 3));
          ws += wk; kr += quad[k * 3] * wk; kg += quad[k * 3 + 1] * wk; kb += quad[k * 3 + 2] * wk;
        }
        acc[0] += (kr / ws) * gw[g]; acc[1] += (kg / ws) * gw[g]; acc[2] += (kb / ws) * gw[g];
      }
      const o = (y * w + x) * 3;
      if (B.order === 'threshold') { out[o] = acc[0]; out[o + 1] = acc[1]; out[o + 2] = acc[2]; }
      else thresholdSoft(out, o, acc[0], acc[1], acc[2], B);
      for (let i = 0; i < 3; i++) out[o + i] = Math.min(Math.max(out[o + i], 0), B.clamp);
    }
  }
  return { buf: out, w, h };
}

/** 13-tap downsample, halving. */
function down(src, W, H) {
  const w = Math.max(1, W >> 1), h = Math.max(1, H >> 1);
  const out = new Float32Array(w * h * 3);
  const at = (x, y, i) => src[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3 + i];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = x * 2 + 0.5, cy = y * 2 + 0.5;
      const o = (y * w + x) * 3;
      for (let i = 0; i < 3; i++) {
        const p = (ox, oy) => at(Math.round(cx + ox), Math.round(cy + oy), i);
        let r = p(0, 0) * 0.125;
        r += (p(-2, 2) + p(2, 2) + p(-2, -2) + p(2, -2)) * 0.03125;
        r += (p(0, 2) + p(-2, 0) + p(2, 0) + p(0, -2)) * 0.0625;
        r += (p(-1, 1) + p(1, 1) + p(-1, -1) + p(1, -1)) * 0.125;
        out[o + i] = r;
      }
    }
  }
  return { buf: out, w, h };
}

/** 9-tap tent upsample of `src` onto a `w x h` grid, accumulated into `dst`. */
function upAdd(dst, w, h, src, sw, sh, radius, weight) {
  const at = (x, y, i) => src[(Math.min(sh - 1, Math.max(0, y)) * sw + Math.min(sw - 1, Math.max(0, x))) * 3 + i];
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) * sh / h - 0.5;
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * sw / w - 0.5;
      const o = (y * w + x) * 3;
      for (let i = 0; i < 3; i++) {
        const p = (ox, oy) => at(Math.round(sx + ox), Math.round(sy + oy), i);
        let s = p(-radius, radius) + p(radius, radius) + p(-radius, -radius) + p(radius, -radius);
        s += (p(0, radius) + p(-radius, 0) + p(radius, 0) + p(0, -radius)) * 2;
        s += p(0, 0) * 4;
        dst[o + i] += (s / 16) * weight;
      }
    }
  }
}

/** Full chain: returns the bloom buffer at half resolution. */
function bloomChain(lin, W, H, B) {
  const mips = [];
  let cur = prefilter(lin, W, H, B);
  mips.push(cur);
  for (let i = 1; i < B.mips; i++) {
    if (cur.w <= 2 || cur.h <= 2) break;
    cur = down(cur.buf, cur.w, cur.h);
    mips.push(cur);
  }
  // Upsample back down the chain, geometrically tapered: mip k reaches the
  // frame at taper^k, which is the tight-core / wide-skirt shape.
  for (let i = mips.length - 1; i >= 1; i--) {
    upAdd(mips[i - 1].buf, mips[i - 1].w, mips[i - 1].h,
      mips[i].buf, mips[i].w, mips[i].h, B.radius, B.mipTaper);
  }
  return mips[0];
}

/* --- forward transfer ----------------------------------------------------- */

function applySplit(c) {
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const ws = 1 - smoothstep(0, P.splitBalance, lum);
  const wh = smoothstep(P.splitBalance, 1, lum);
  for (let i = 0; i < 3; i++) c[i] = clamp01(c[i] + P.splitShadow[i] * ws + P.splitHighlight[i] * wh);
}

function forward(c, vig) {
  for (let i = 0; i < 3; i++) c[i] = Math.pow(Math.max(c[i] * P.gain[i], 0), 1 / Math.max(P.gamma[i], 0.01));
  const k = Math.max(-0.9, Math.min(0.9, (P.contrast - 1) * 2));
  for (let i = 0; i < 3; i++) { const v = clamp01(c[i]); c[i] = v + k * (v * v * (3 - 2 * v) - v); }
  for (let i = 0; i < 3; i++) c[i] = P.lift[i] + (1 - P.lift[i]) * clamp01(c[i]);
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (let i = 0; i < 3; i++) c[i] = clamp01(l + (c[i] - l) * P.saturation);
  applySplit(c);
  if (vig > 1e-6) for (let i = 0; i < 3; i++) c[i] *= vig;
}

/* --- PNG out -------------------------------------------------------------- */
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(path, W, H, rgb) {
  const raw = Buffer.alloc(H * (1 + W * 3));
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W * 3; x++) raw[o++] = rgb[y * W * 3 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* --- main ----------------------------------------------------------------- */
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
const sets = argv.reduce((a, v, i) => (v === '--set' ? [...a, argv[i + 1]] : a), []);
const outDir = flag('out') ? resolve(ROOT, flag('out')) : null;
const skip = new Set();
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) skip.add(i + 1);
const files = argv.filter((a, i) => !a.startsWith('--') && !skip.has(i));
if (!files.length) {
  console.error("usage: node tools/bloomsim.mjs <png ...> [--set 'k=v;...']... [--out DIR]");
  console.error('  keys: order(karis|threshold) threshold knee strength radius clamp mipTaper mips');
  process.exit(1);
}
if (outDir) mkdirSync(outDir, { recursive: true });

const cands = [SHIPPED_BLOOM, ...sets.map((s) => {
  const c = { ...SHIPPED_BLOOM };
  for (const part of s.split(';').map((v) => v.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!(k in c)) throw new Error(`unknown bloom key '${k}'`);
    c[k] = k === 'order' ? v : Number(v);
  }
  return c;
})];

const stat = (buf, n) => {
  const s = new Float64Array(n);
  let mx = 0, sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const v = Math.max(buf[p], Math.max(buf[p + 1], buf[p + 2]));
    s[i] = v; sum += v; if (v > mx) mx = v;
  }
  s.sort();
  const q = (f) => s[Math.min(n - 1, Math.floor(f * n))];
  return { mean: sum / n, max: mx, p999: q(0.999), p9999: q(0.9999), p99: q(0.99) };
};

for (const f of files) {
  const path = resolve(ROOT, f);
  const img = readPng(path);
  const { lin, W, H, clipped } = toRadiance(img);
  const n = W * H;
  const rs = stat(lin, n);
  console.log(`\n=== ${f}  ${W}x${H} ===`);
  console.log(`  recovered radiance: mean ${rs.mean.toPrecision(3)}  p99 ${rs.p99.toPrecision(3)}` +
    `  p99.9 ${rs.p999.toPrecision(3)}  p99.99 ${rs.p9999.toPrecision(3)}  max ${rs.max.toPrecision(3)}` +
    `   (${clipped.toFixed(3)}% of pixels were clipped in the capture and come back at the rail)`);
  for (const t of [0.2, 0.35, 0.55, 0.8, 1.2, 1.9]) {
    let c = 0;
    for (let i = 0, p = 0; i < n; i++, p += 3) if (Math.max(lin[p], Math.max(lin[p + 1], lin[p + 2])) > t) c++;
    process.stdout.write(`  above ${t}: ${((100 * c) / n).toFixed(3)}%`);
  }
  console.log('');

  for (const B of cands) {
    const bl = bloomChain(lin, W, H, B);
    const bs = stat(bl.buf, bl.w * bl.h);
    const tag = `${B.order} thr=${B.threshold} str=${B.strength} taper=${B.mipTaper} clamp=${B.clamp}`;
    console.log(`  -- ${tag}`);
    console.log(`     bloom buffer: mean ${bs.mean.toExponential(2)}  p99 ${bs.p99.toExponential(2)}` +
      `  p99.9 ${bs.p999.toExponential(2)}  p99.99 ${bs.p9999.toExponential(2)}  max ${bs.max.toPrecision(3)}`);

    // Composite and re-grade, so the effect is stated in code values too.
    const out = new Uint8Array(W * H * 3);
    const c = [0, 0, 0];
    let lifted = 0;
    for (let y = 0; y < H; y++) {
      const dy = (y + 0.5) / H - 0.5;
      const by = Math.min(bl.h - 1, y >> 1);
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5) / W - 0.5;
        const rEdge = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.41421356);
        const vig = 1 - 0.26 * smoothstep(0.42, 1, rEdge);
        const q = (y * W + x) * 3;
        const bq = (by * bl.w + Math.min(bl.w - 1, x >> 1)) * 3;
        // FINAL_FRAG adds the bloom, tinting the SKIRT amber and leaving the
        // core its own colour; the tint is not simulated here because it does
        // not change magnitude, only hue.
        for (let i = 0; i < 3; i++) c[i] = lin[q + i] + bl.buf[bq + i] * B.strength;
        const before = agxDisplay([lin[q] * P.exposure, lin[q + 1] * P.exposure, lin[q + 2] * P.exposure], P.agxLook);
        const d = agxDisplay([c[0] * P.exposure, c[1] * P.exposure, c[2] * P.exposure], P.agxLook);
        if (d[0] - before[0] > 2 / 255) lifted++;
        c[0] = d[0]; c[1] = d[1]; c[2] = d[2];
        forward(c, vig);
        const o = (y * W + x) * 3;
        out[o] = Math.round(clamp01(c[0]) * 255);
        out[o + 1] = Math.round(clamp01(c[1]) * 255);
        out[o + 2] = Math.round(clamp01(c[2]) * 255);
      }
    }
    console.log(`     frame area the bloom lifts by 2+ code values: ${((100 * lifted) / n).toFixed(3)}%`);
    if (outDir) {
      const nm = `${basename(f, '.png')}_${B.order}_t${B.threshold}_s${B.strength}.png`;
      writePng(resolve(outDir, nm), W, H, out);
      console.log(`     wrote ${nm}`);
    }
  }
}
