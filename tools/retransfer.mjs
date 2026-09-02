#!/usr/bin/env node
/**
 * Apply a change to the grade's FINAL TRANSFER to a capture that already
 * exists, exactly, without rendering anything.
 *
 *   node tools/retransfer.mjs shots/iter11/boost.png [more.png ...] [--out DIR]
 *
 * WHY THIS IS EXACT, and where it stops being exact.
 *
 * FINAL_FRAG computes a display-referred colour `disp`, then writes
 * `agxToLinear(disp)` and lets three's `colorspace_fragment` apply the sRGB
 * OETF. So the shipped 8-bit output is
 *
 *     out  = OETF( pow( disp, 2.2 ) )
 *
 * and `agxToLinear` is supposed to be the INVERSE of that OETF, so that the
 * pair round-trips and the grade's display-space intent survives to the screen.
 * A 2.2 power is not the inverse of the sRGB OETF. Replacing it with the real
 * sRGB EOTF makes the round trip an identity, i.e.
 *
 *     out' = disp = pow( EOTF( out ), 1 / 2.2 )
 *
 * — a function of the SHIPPED CODE VALUE ALONE. Every capture in `shots/` can
 * therefore be converted to what the fixed build would have produced, with no
 * rebuild and, more importantly, with none of the cross-build contamination the
 * Contract Amendments warn about: this is the same frame, not a second one.
 *
 * THE LIMITS, which matter:
 *  - 8-bit quantisation. The shipped encode CRUSHES the toe, so many distinct
 *    `disp` values collide onto one output code down there; the inverse
 *    therefore expands one code into two or three. Region statistics (medians,
 *    percentiles, area fractions) are accurate; a magnified crop of the
 *    predicted image will show posterisation the real build will not have.
 *  - A code value of exactly 0 carries no information. Those pixels were
 *    already clipped before the encode, so this cannot recover them — which is
 *    precisely why the blue-clipped black point is a SEPARATE defect from the
 *    encode, and why the count of hard zeros is reported below.
 *  - Grain and dither are inside `disp` and are remapped with everything else.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { readPng } from './measure-frame.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const srgbEOTF = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

/** out -> out' for the 2.2-power to sRGB-EOTF fix, tabulated over all 256 codes. */
function buildLut() {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const disp = Math.pow(srgbEOTF(i / 255), 1 / 2.2);
    lut[i] = Math.max(0, Math.min(255, Math.round(disp * 255)));
  }
  return lut;
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

/* --- statistics ----------------------------------------------------------- */
const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

function describe(data, n) {
  const lum = new Float64Array(n);
  let zeroR = 0, zeroAll = 0, darkN = 0, dR = 0, dG = 0, dB = 0, dRzero = 0;
  for (let p = 0, i = 0; i < n; i++, p += 4) {
    const l = L(data, p);
    lum[i] = l;
    if (data[p] === 0) zeroR++;
    if (data[p] === 0 && data[p + 1] === 0 && data[p + 2] === 0) zeroAll++;
    if (l < 20) {
      darkN++; dR += data[p]; dG += data[p + 1]; dB += data[p + 2];
      if (data[p] === 0) dRzero++;
    }
  }
  const s = Array.from(lum).sort((a, b) => a - b);
  const q = (f) => s[Math.min(n - 1, Math.floor(f * (n - 1)))];
  const below = (t) => (100 * s.findIndex((v) => v >= t)) / n;
  let sum = 0; for (const v of s) sum += v;
  const mean = sum / n;
  let sd = 0; for (const v of s) sd += (v - mean) * (v - mean);
  return {
    mean, sd: Math.sqrt(sd / n), p05: q(0.05), p25: q(0.25), med: q(0.5), p75: q(0.75), p95: q(0.95),
    b8: below(8), b16: below(16), b24: below(24), b48: below(48),
    zeroR: (100 * zeroR) / n, zeroAll: (100 * zeroAll) / n,
    darkArea: (100 * darkN) / n,
    darkRGB: darkN ? [dR / darkN, dG / darkN, dB / darkN] : null,
    darkRedClipped: darkN ? (100 * dRzero) / darkN : 0,
  };
}

function row(tag, s) {
  return `  ${tag.padEnd(9)} ${s.mean.toFixed(1).padStart(6)} ${s.sd.toFixed(1).padStart(5)} ` +
    `${s.p05.toFixed(0).padStart(4)} ${s.p25.toFixed(0).padStart(4)} ${s.med.toFixed(0).padStart(4)} ` +
    `${s.p75.toFixed(0).padStart(4)} ${s.p95.toFixed(0).padStart(4)}  ` +
    `${s.b8.toFixed(2).padStart(6)} ${s.b16.toFixed(2).padStart(6)} ${s.b24.toFixed(2).padStart(6)} ${s.b48.toFixed(2).padStart(6)}  ` +
    `${s.zeroR.toFixed(2).padStart(6)} ${s.darkArea.toFixed(2).padStart(6)} ` +
    `${s.darkRGB ? s.darkRGB.map((v) => v.toFixed(1).padStart(5)).join('') : '    -'} ${s.darkRedClipped.toFixed(1).padStart(6)}`;
}

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const outDir = oi === -1 ? null : resolve(ROOT, args[oi + 1]);
const files = args.filter((a, i) => !a.startsWith('--') && i !== oi + 1);
if (outDir) mkdirSync(outDir, { recursive: true });

const LUT = buildLut();
console.log('CODE MAPPING  in -> out  (2.2 power replaced by the exact sRGB EOTF)');
console.log('  ' + [0, 1, 2, 3, 5, 8, 12, 16, 24, 32, 48, 64, 96, 128, 180, 255]
  .map((v) => `${v}->${LUT[v]}`).join('  '));

for (const f of files) {
  const path = resolve(ROOT, f);
  const img = readPng(path);
  const n = img.width * img.height;
  const before = describe(img.data, n);
  const after4 = new Uint8Array(img.data.length);
  for (let p = 0; p < img.data.length; p += 4) {
    after4[p] = LUT[img.data[p]];
    after4[p + 1] = LUT[img.data[p + 1]];
    after4[p + 2] = LUT[img.data[p + 2]];
    after4[p + 3] = 255;
  }
  const after = describe(after4, n);
  console.log(`\n=== ${f}  ${img.width}x${img.height} ===`);
  console.log('            mean    sd  p05  p25  med  p75  p95    <8%   <16%   <24%   <48%   R==0%  <20 area  <20 mean RGB  redClip%');
  console.log(row('shipped', before));
  console.log(row('fixed', after));
  if (outDir) {
    const p = resolve(outDir, basename(f).replace(/\.png$/, '_fixed.png'));
    writePng(p, img.width, img.height, after4);
    console.log(`  wrote ${p.replace(ROOT + '/', '')}`);
  }
}
