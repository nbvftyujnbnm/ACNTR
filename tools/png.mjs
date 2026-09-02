/**
 * PNG reader — 8-bit, non-interlaced, colour type 2 or 6. That is what every
 * Playwright screenshot is; anything else throws rather than returning
 * plausible-looking garbage.
 *
 * THIS MODULE HAS NO SIDE EFFECTS ON IMPORT, and that is the whole point of
 * its existing separately. It used to live in `measure-frame.mjs`, whose body
 * ends in a top-level async IIFE that runs a vite build, launches a headless
 * browser and finishes with `process.exit(0)`. Any tool that did
 * `import { readPng } from './measure-frame.mjs'` therefore silently started a
 * capture harness and was killed by that exit before printing a single line.
 * Import image helpers from HERE.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * @param {string} path
 * @returns {{ width:number, height:number, data:Uint8Array }} RGBA, row-major, top-down
 */
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
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
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
