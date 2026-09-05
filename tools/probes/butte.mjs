/**
 * Butte-vs-sky luma/chroma probe for the `cliff` pose.
 *
 * Reports, for a set of named rects: mean rgb, luma, sd, and the sky rect
 * immediately beside/above it, so the two numbers the cut-out complaint is
 * actually about (is the landform under its background, and does it have an
 * interior ramp) are both on one line.
 *
 * Usage: node tools/probes/butte.mjs shots/aer_fix/cliff.png [more.png ...]
 */
import { readPng } from '../png.mjs';

const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function patch(img, x, y, w, h) {
  let n = 0, sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const k = (j * img.width + i) * 4;
      const r = img.data[k], g = img.data[k + 1], b = img.data[k + 2];
      const l = LUMA(r, g, b);
      sr += r; sg += g; sb += b; sl += l; sl2 += l * l; n++;
    }
  }
  const l = sl / n;
  return {
    r: sr / n, g: sg / n, b: sb / n, luma: l,
    sd: Math.sqrt(Math.max(0, sl2 / n - l * l)),
    rb: sr / n - sb / n,
  };
}

const fmt = (p) => `rgb(${p.r.toFixed(1).padStart(5)},${p.g.toFixed(1).padStart(5)},${p.b.toFixed(1).padStart(5)})  luma ${p.luma.toFixed(1).padStart(5)}  sd ${p.sd.toFixed(2).padStart(5)}  R-B ${p.rb.toFixed(1).padStart(5)}`;

// Rects measured off shots/aer_fix/cliff.png at 1920x1080.
const RECTS = [
  ['butte L cap    ', 150, 470, 150, 26],
  ['butte L upper  ', 150, 520, 150, 40],
  ['butte L mid    ', 150, 590, 150, 40],
  ['butte L toe    ', 150, 660, 150, 30],
  ['sky above L    ', 150, 400, 150, 40],
  ['sky beside L   ', 640, 520, 90, 120],
  ['butte R cap    ', 1270, 560, 110, 24],
  ['butte R upper  ', 1270, 600, 110, 30],
  ['butte R toe    ', 1270, 650, 110, 26],
  ['sky beside R   ', 1490, 560, 70, 90],
  ['cliff ring mid ', 1500, 700, 200, 40],
  ['far plain      ', 800, 745, 200, 20],
];

for (const f of process.argv.slice(2)) {
  const img = readPng(f);
  console.log(`\n== ${f}  ${img.width}x${img.height}`);
  for (const [name, x, y, w, h] of RECTS) {
    console.log(`${name} ${fmt(patch(img, x, y, w, h))}`);
  }
}
