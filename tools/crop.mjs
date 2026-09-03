#!/usr/bin/env node
/**
 * Crop and nearest-neighbour zoom a region of a captured frame into a new PNG.
 *
 *   node tools/crop.mjs --png shots/iter31/gameplay.png --rect 1360,320,480,200 \
 *        --zoom 2 --out /tmp/ridge.png
 *
 * Why this exists. Every review note in this project is about a REGION — the
 * ridge face, the dome flank, the ground the mech stands on — and a 1920x1080
 * frame read whole shows none of them at the scale the complaint is about. The
 * numeric tools (`detail.mjs`, `measure-frame.mjs`) answer "how much contrast is
 * in this band"; this answers "what does it look like", which is the question
 * CONTRACT.md says to believe when the two disagree.
 *
 * Nearest-neighbour on purpose: a smooth resample invents gradients, and the
 * defects being hunted here (banding, faceting, stipple, tile rhythm) are
 * exactly the things an interpolating upscale hides.
 */
import { readPng } from './png.mjs';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Write an RGB PNG. Filter type 0 on every row — these are small diagnostic
 * crops, so the extra bytes cost nothing and the writer stays auditable.
 * @param {string} path
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} rgb tightly packed, w*h*3
 */
export function writePng(path, w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3)
      .copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = arg('png');
  const out = arg('out', '/tmp/crop.png');
  const zoom = Math.max(1, Math.round(+arg('zoom', 1)));
  const png = readPng(src);
  const r = String(arg('rect', `0,0,${png.width},${png.height}`)).split(',').map(Number);
  const [rx, ry] = r;
  const rw = Math.min(r[2], png.width - rx);
  const rh = Math.min(r[3], png.height - ry);
  const w = rw * zoom, h = rh * zoom;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = ry + Math.floor(y / zoom);
    for (let x = 0; x < w; x++) {
      const sx = rx + Math.floor(x / zoom);
      const si = (sy * png.width + sx) * 4;
      const di = (y * w + x) * 3;
      rgb[di] = png.data[si];
      rgb[di + 1] = png.data[si + 1];
      rgb[di + 2] = png.data[si + 2];
    }
  }
  writePng(out, w, h, rgb);
  console.log(`${out}  ${w}x${h}  from ${src} rect ${rx},${ry},${rw},${rh} zoom ${zoom}`);
}
