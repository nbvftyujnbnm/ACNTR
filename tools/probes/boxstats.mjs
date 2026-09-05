#!/usr/bin/env node
/**
 * Box statistics on a PNG — peak/mean luma, warm-pixel counts, hot-pixel
 * counts, over an arbitrary list of rectangles.
 *
 *   node tools/probes/boxstats.mjs --png shots/x/y.png \
 *        --box 463,219,120,120 --box 693,219,120,120 [--label a,b]
 *
 * Exists because "the flash is weak" has been asserted several times without a
 * number, and because a filmstrip pose reports where each sample PROJECTED,
 * which is the box to sample and not the same question as whether anything is
 * drawn there.
 */
import { readPng } from '../png.mjs';

function args(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1]);
  }
  return out;
}
const png = args('png')[0];
if (!png) { console.error('need --png'); process.exit(2); }
const boxes = args('box').map((s) => s.split(',').map(Number));
const labels = (args('label')[0] || '').split(',');
const img = readPng(png);
const { width: W, height: H, data } = img;

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

console.log(`${png}  ${W}x${H}`);
console.log('label            n     peakL  meanL   p99L   warm(R-B>18 & L>90)  hot(L>200)  max(rgb)');
boxes.forEach((bx, i) => {
  const [x0, y0, w, h] = bx;
  let peak = 0, sum = 0, n = 0, warm = 0, hot = 0;
  let mr = 0, mg = 0, mb = 0;
  const ls = [];
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const o = (y * W + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const L = luma(r, g, b);
      ls.push(L);
      sum += L; n++;
      if (L > peak) { peak = L; mr = r; mg = g; mb = b; }
      if (r - b > 18 && L > 90) warm++;
      if (L > 200) hot++;
    }
  }
  ls.sort((a, b2) => a - b2);
  const p99 = ls.length ? ls[Math.floor(ls.length * 0.99)] : 0;
  const lab = (labels[i] || `box${i}`).padEnd(14);
  console.log(
    `${lab} ${String(n).padStart(6)}  ${peak.toFixed(1).padStart(6)} ${(sum / n).toFixed(1).padStart(6)} `
    + `${p99.toFixed(1).padStart(6)}  ${String(warm).padStart(10)}  ${String(hot).padStart(10)}   ${mr},${mg},${mb}`,
  );
});
