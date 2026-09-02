#!/usr/bin/env node
/**
 * Per-OCTAVE contrast of a rectangle of a captured frame.
 *
 *   node tools/detail.mjs --png shots/x/gameplay.png --rect 900,600,500,240 [--rect ...]
 *
 * Why this and not a standard deviation. "The foreground has no detail" is a
 * statement about a BAND of spatial frequencies, and a single standard
 * deviation cannot tell a surface carrying 40 code values of 200-px lighting
 * gradient from one carrying 40 code values of 4-px aggregate — the two look
 * nothing alike and the number is identical. CONTRACT.md already records one
 * measurement trap of exactly this shape (a moving-average detrend planting a
 * false autocorrelation peak at the window width), so the decomposition here is
 * a Burt-Adelson pyramid: repeated 1-2-1 blur + decimate, and each level's
 * detail is the difference between that level and the next one expanded back.
 * The bands are then genuinely disjoint and their energies sum to the total,
 * which a moving-average detrend does not give you.
 *
 * Output is RMS code values per band, where band k is roughly 2^k px of
 * wavelength. At the gameplay camera 1 px is about 2-4 cm of ground at 8 m and
 * ~15 cm at 40 m, so bands 1-4 are the aggregate/grit the near-field layer is
 * supposed to be adding and bands 6+ are landform and lighting.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/*
 * The PNG reader is a copy of `measure-frame.mjs`'s rather than an import:
 * that module runs a top-level IIFE which launches a browser, so importing one
 * function out of it boots Playwright and hangs a pure image measurement.
 */
/** 8-bit non-interlaced PNG, colour type 2 or 6 → RGBA, top-down. */
export function readPng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`${path}: unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNGs unsupported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`${path}: unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rawB; break;
        case 1: v = rawB + a; break;
        case 2: v = rawB + b; break;
        case 3: v = rawB + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${path}: bad filter ${filter} on row ${y}`);
      }
      line[x] = v & 0xff;
    }
    src += stride;
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      out[o + x * 4] = line[x * channels];
      out[o + x * 4 + 1] = line[x * channels + 1];
      out[o + x * 4 + 2] = line[x * channels + 2];
      out[o + x * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : (process.argv[i + 1] ?? true);
}

/** Rec.709 luma of a rectangle, as a Float64Array plus its dimensions. */
function lumaRect(img, x0, y0, w, h) {
  const out = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = ((y0 + j) * img.width + (x0 + i)) * 4;
      out[j * w + i] = 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2];
    }
  }
  return out;
}

/** Separable 1-2-1 blur with clamped edges. */
function blur(src, w, h) {
  const t = new Float64Array(w * h);
  const d = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const a = src[j * w + Math.max(0, i - 1)];
      const b = src[j * w + i];
      const c = src[j * w + Math.min(w - 1, i + 1)];
      t[j * w + i] = (a + 2 * b + c) * 0.25;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const a = t[Math.max(0, j - 1) * w + i];
      const b = t[j * w + i];
      const c = t[Math.min(h - 1, j + 1) * w + i];
      d[j * w + i] = (a + 2 * b + c) * 0.25;
    }
  }
  return d;
}

function rms(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - m; s += d * d; }
  return Math.sqrt(s / a.length);
}

/**
 * Laplacian-pyramid band energies, in place at full resolution (no decimation,
 * so a small rectangle keeps its statistics).
 * @returns {{ bands:number[], total:number, mean:number }}
 */
export function bandEnergies(lum, w, h, levels = 7) {
  let cur = lum;
  const bands = [];
  for (let k = 0; k < levels; k++) {
    let next = cur;
    // 2^k blur passes approximates a Gaussian of sigma ~ 2^k
    const passes = 1 << k;
    for (let p = 0; p < passes; p++) next = blur(next, w, h);
    const diff = new Float64Array(w * h);
    for (let i = 0; i < diff.length; i++) diff[i] = cur[i] - next[i];
    bands.push(rms(diff));
    cur = next;
  }
  let mean = 0;
  for (let i = 0; i < lum.length; i++) mean += lum[i];
  return { bands, total: rms(lum), mean: mean / lum.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const png = arg('png');
  if (!png) { console.error('usage: --png FILE --rect x,y,w,h [--rect ...]'); process.exit(1); }
  const img = readPng(png);
  const rects = argAll('rect');
  if (!rects.length) rects.push(`0,0,${img.width},${img.height}`);
  console.log(`${png}  ${img.width}x${img.height}`);
  console.log('rect                     mean   total   b1     b2     b4     b8     b16    b32    b64');
  for (const r of rects) {
    const [x, y, w, h] = r.split(',').map(Number);
    const lum = lumaRect(img, x, y, w, h);
    const e = bandEnergies(lum, w, h);
    const f = (n) => n.toFixed(2).padStart(6);
    console.log(
      `${r.padEnd(22)} ${e.mean.toFixed(1).padStart(6)} ${f(e.total)} ${e.bands.map(f).join(' ')}`
    );
  }
}
