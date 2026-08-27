import * as THREE from 'three';
import { mulberry32, clamp, lerp, smoothstep } from '../core/MathUtils.js';

/**
 * TextureForge — runtime procedural texture generation.
 *
 * The project ships no binary art assets, so every surface in the game is
 * authored here: albedo, roughness/metalness/AO packed maps, normal maps derived
 * from height fields, and emissive masks.
 *
 * Everything is cached by key — call `forge.panel({...})` freely, you get the
 * same GPU texture back. Generation happens on OffscreenCanvas when available.
 *
 * Convention for packed ORM maps (matches glTF): R = AO, G = roughness, B = metalness.
 */

const _canvasPool = [];

function getCanvas(w, h) {
  const c = _canvasPool.pop() || (typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : document.createElement('canvas'));
  c.width = w;
  c.height = h;
  return c;
}

function releaseCanvas(c) {
  if (_canvasPool.length < 8) _canvasPool.push(c);
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Tileable value-noise field. Returns Float32Array of size*size in [0,1]. */
export function valueNoise(size, freq, seed, octaves = 5, persistence = 0.5, lacunarity = 2) {
  const rng = mulberry32(seed);
  const out = new Float32Array(size * size);

  // Precompute octave lattices (tileable: lattice wraps at `f`)
  const layers = [];
  let f = freq;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = Math.max(2, Math.round(f));
    const grid = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) grid[i] = rng();
    layers.push({ n, grid, amp });
    norm += amp;
    amp *= persistence;
    f *= lacunarity;
  }

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let o = 0; o < layers.length; o++) {
        const { n, grid, amp: a } = layers[o];
        const fx = (x / size) * n;
        const fy = (y / size) * n;
        const x0 = Math.floor(fx) % n;
        const y0 = Math.floor(fy) % n;
        const x1 = (x0 + 1) % n;
        const y1 = (y0 + 1) % n;
        const tx = fade(fx - Math.floor(fx));
        const ty = fade(fy - Math.floor(fy));
        const v00 = grid[y0 * n + x0];
        const v10 = grid[y0 * n + x1];
        const v01 = grid[y1 * n + x0];
        const v11 = grid[y1 * n + x1];
        const a0 = v00 + (v10 - v00) * tx;
        const a1 = v01 + (v11 - v01) * tx;
        sum += (a0 + (a1 - a0) * ty) * a;
      }
      out[y * size + x] = sum / norm;
    }
  }
  return out;
}

/** Tileable Worley/cellular noise — F1 distance, normalized. Great for chipped paint. */
export function worley(size, cells, seed) {
  const rng = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < cells * cells; i++) {
    pts.push([((i % cells) + rng()) / cells, ((Math.floor(i / cells)) + rng()) / cells]);
  }
  const out = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x * inv;
      const py = y * inv;
      let best = 4;
      for (let i = 0; i < pts.length; i++) {
        let dx = Math.abs(pts[i][0] - px);
        let dy = Math.abs(pts[i][1] - py);
        if (dx > 0.5) dx = 1 - dx; // wrap
        if (dy > 0.5) dy = 1 - dy;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      out[y * size + x] = clamp(Math.sqrt(best) * cells, 0, 1);
    }
  }
  return out;
}

/** Fractal warp: distorts sample coordinates by a second noise field. Kills the "grid" look. */
export function warp(field, warpField, size, strength) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const w = warpField[y * size + x] - 0.5;
      const sx = (x + w * strength * size) % size;
      const sy = (y + w * strength * size * 0.7) % size;
      const ix = ((sx | 0) + size) % size;
      const iy = ((sy | 0) + size) % size;
      out[y * size + x] = field[iy * size + ix];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Height → normal
// ---------------------------------------------------------------------------

/**
 * Sobel-derive a tangent-space normal map from a height field.
 * `strength` in height-units-per-texel; higher = more pronounced relief.
 */
export function normalFromHeight(height, size, strength = 2.0) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sobel
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len;
      const nzn = nz / len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nzn * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Forge
// ---------------------------------------------------------------------------

export class TextureForge {
  constructor(renderer) {
    this.renderer = renderer;
    this.cache = new Map();
    this.maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
  }

  _cached(key, fn) {
    let v = this.cache.get(key);
    if (!v) {
      v = fn();
      this.cache.set(key, v);
    }
    return v;
  }

  _finish(tex, { srgb = false, repeat = 1, aniso = true } = {}) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.setScalar(repeat);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = aniso ? this.maxAniso : 1;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  _fromCanvas(canvas, opts) {
    const tex = new THREE.CanvasTexture(canvas);
    return this._finish(tex, opts);
  }

  /**
   * Armour panelling: a plate layout with bevelled seams, rivets, weld beads,
   * stencil marks and edge wear. This is the workhorse for mech and structure
   * surfaces — it is what stops anything reading as untextured plastic.
   *
   * Returns { map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap }.
   */
  armorPanel(opts = {}) {
    const {
      size = 1024,
      seed = 1,
      baseColor = '#6b7076',
      accentColor = '#c8531f',
      panelScale = 6,
      wear = 0.5,
      grime = 0.55,
      rivets = true,
      stencil = true,
      emissiveColor = '#54e8ff',
      emissiveDensity = 0.12,
      metal = 1.0,
      baseRough = 0.42,
    } = opts;

    const key = `armor:${JSON.stringify(opts)}`;
    return this._cached(key, () => {
      const rng = mulberry32(seed);
      const S = size;

      // --- height field: seams + surface micro-relief -----------------------
      const height = new Float32Array(S * S).fill(0.5);
      const seamMask = new Float32Array(S * S);
      const plateId = new Int32Array(S * S).fill(-1);

      // Recursive binary subdivision → irregular plate layout (never a uniform grid)
      const plates = [];
      const split = (x, y, w, h, depth) => {
        const minSize = S / (panelScale * 2.2);
        if (depth > 5 || (w < minSize * 2 && h < minSize * 2) || (depth > 2 && rng() < 0.28)) {
          plates.push({ x, y, w, h });
          return;
        }
        const horizontal = w > h ? rng() < 0.82 : rng() < 0.18;
        const t = 0.32 + rng() * 0.36;
        if (horizontal) {
          const cut = Math.round(w * t);
          split(x, y, cut, h, depth + 1);
          split(x + cut, y, w - cut, h, depth + 1);
        } else {
          const cut = Math.round(h * t);
          split(x, y, w, cut, depth + 1);
          split(x, y + cut, w, h - cut, depth + 1);
        }
      };
      split(0, 0, S, S, 0);

      // rasterise plates with bevelled edges
      const seamW = Math.max(1.6, S / 512 * 2.2);
      plates.forEach((p, idx) => {
        const inset = seamW * 0.5;
        const lift = (rng() - 0.5) * 0.16; // each plate sits slightly proud/recessed
        for (let y = p.y; y < p.y + p.h; y++) {
          for (let x = p.x; x < p.x + p.w; x++) {
            const i = (y % S) * S + (x % S);
            plateId[i] = idx;
            const dEdge = Math.min(x - p.x, p.x + p.w - 1 - x, y - p.y, p.y + p.h - 1 - y);
            const bevel = smoothstep(0, seamW * 1.8, dEdge);
            height[i] = 0.5 + lift * bevel - (1 - bevel) * 0.22;
            if (dEdge < inset) seamMask[i] = 1 - dEdge / inset;
          }
        }
      });

      // micro surface: brushed metal streaks + fine noise
      const micro = valueNoise(S, 96, seed + 11, 4, 0.55);
      const streak = valueNoise(S, 4, seed + 23, 2, 0.6);
      const grunge = warp(
        valueNoise(S, 8, seed + 31, 6, 0.55),
        valueNoise(S, 5, seed + 47, 3, 0.6),
        S,
        0.06
      );
      const chips = worley(S, Math.round(10 + panelScale), seed + 59);
      const scratch = valueNoise(S, 220, seed + 71, 2, 0.4);

      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          // anisotropic brushing along X
          const brush = (micro[i] - 0.5) * 0.05 + (streak[(y * S + ((x * 3) % S))] - 0.5) * 0.012;
          height[i] += brush;
          // chipped edges eat into the plate near seams
          const chipAmt = (1 - chips[i]) * wear;
          if (chipAmt > 0.62) height[i] -= (chipAmt - 0.62) * 0.5;
        }
      }

      // rivets along plate borders
      const rivetMask = new Float32Array(S * S);
      if (rivets) {
        const rr = Math.max(2, S / 340);
        plates.forEach((p) => {
          if (p.w < S / 14 || p.h < S / 14) return;
          const step = Math.max(14, Math.round(Math.min(p.w, p.h) / 3.2));
          const margin = seamW * 2.6;
          const place = (cx, cy) => {
            for (let dy = -rr * 2; dy <= rr * 2; dy++) {
              for (let dx = -rr * 2; dx <= rr * 2; dx++) {
                const d = Math.hypot(dx, dy);
                if (d > rr * 1.9) continue;
                const xx = ((cx + dx) % S + S) % S;
                const yy = ((cy + dy) % S + S) % S;
                const i = yy * S + xx;
                const dome = Math.cos(clamp(d / (rr * 1.6), 0, 1) * Math.PI * 0.5);
                height[i] += dome * 0.16;
                rivetMask[i] = Math.max(rivetMask[i], dome);
              }
            }
          };
          for (let x = p.x + margin; x < p.x + p.w - margin; x += step) {
            place(Math.round(x), Math.round(p.y + margin));
            place(Math.round(x), Math.round(p.y + p.h - margin));
          }
          for (let y = p.y + margin; y < p.y + p.h - margin; y += step) {
            place(Math.round(p.x + margin), Math.round(y));
            place(Math.round(p.x + p.w - margin), Math.round(y));
          }
        });
      }

      // --- albedo ----------------------------------------------------------
      const canvas = getCanvas(S, S);
      const ctx = canvas.getContext('2d');
      const base = new THREE.Color(baseColor);
      const accent = new THREE.Color(accentColor);
      const img = ctx.createImageData(S, S);
      const d = img.data;

      // per-plate tonal variation — real armour is never one flat colour
      const plateTint = plates.map(() => 0.86 + rng() * 0.3);
      const plateAccent = plates.map(() => rng() < 0.1);

      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const pid = plateId[i];
          const tint = pid >= 0 ? plateTint[pid] : 1;
          const isAccent = pid >= 0 && plateAccent[pid];
          const src = isAccent ? accent : base;

          let r = src.r * tint;
          let g = src.g * tint;
          let b = src.b * tint;

          // grunge darkening, biased into seams (dirt collects in recesses)
          const dirt = clamp(grunge[i] * grime + seamMask[i] * 0.55 * grime, 0, 1);
          const dirtCol = 0.30;
          r = lerp(r, r * dirtCol + 0.035, dirt * 0.72);
          g = lerp(g, g * dirtCol + 0.032, dirt * 0.72);
          b = lerp(b, b * dirtCol + 0.030, dirt * 0.72);

          // paint chipped away → bare metal underneath
          const chipAmt = (1 - chips[i]) * wear;
          const chipped = smoothstep(0.6, 0.86, chipAmt + seamMask[i] * 0.28 * wear);
          const bare = 0.30 + micro[i] * 0.16;
          r = lerp(r, bare * 1.06, chipped);
          g = lerp(g, bare * 1.02, chipped);
          b = lerp(b, bare * 0.98, chipped);

          // fine scratches reveal brighter metal
          const sc = smoothstep(0.80, 0.94, scratch[i]) * wear;
          r = lerp(r, 0.55, sc * 0.5);
          g = lerp(g, 0.55, sc * 0.5);
          b = lerp(b, 0.56, sc * 0.5);

          // rivet highlight
          const rv = rivetMask[i];
          if (rv > 0) {
            r = lerp(r, 0.42, rv * 0.5);
            g = lerp(g, 0.43, rv * 0.5);
            b = lerp(b, 0.45, rv * 0.5);
          }

          // seam line darkening (the single most important mech-detail cue)
          const seam = seamMask[i];
          const sd = smoothstep(0.35, 1, seam);
          r *= 1 - sd * 0.72;
          g *= 1 - sd * 0.72;
          b *= 1 - sd * 0.72;

          const o = i * 4;
          d[o] = clamp(r, 0, 1) * 255;
          d[o + 1] = clamp(g, 0, 1) * 255;
          d[o + 2] = clamp(b, 0, 1) * 255;
          d[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      // stencil markings / hazard stripes / serials, drawn in canvas space
      const emissiveCanvas = getCanvas(S, S);
      const ectx = emissiveCanvas.getContext('2d');
      ectx.fillStyle = '#000';
      ectx.fillRect(0, 0, S, S);

      if (stencil) {
        ctx.save();
        const marks = ['AC-09', 'V.IV', 'RaD', '621', 'ARQ-2', 'CAUTION', 'BAWS', 'MT//7', 'ELCANO'];
        const n = 3 + Math.floor(rng() * 4);
        for (let k = 0; k < n; k++) {
          const p = plates[Math.floor(rng() * plates.length)];
          if (!p || p.w < S / 12) continue;
          const fs = clamp(Math.min(p.w, p.h) * 0.26, 9, 46);
          ctx.font = `700 ${fs}px "Share Tech Mono", monospace`;
          ctx.textBaseline = 'middle';
          ctx.globalAlpha = 0.32 + rng() * 0.3;
          ctx.fillStyle = rng() < 0.35 ? '#e8e2d6' : '#1a1c1f';
          const tx = p.x + p.w * 0.14;
          const ty = p.y + p.h * (0.28 + rng() * 0.44);
          ctx.fillText(marks[Math.floor(rng() * marks.length)], tx, ty);
        }
        // hazard stripe band on one plate
        if (rng() < 0.55) {
          const p = plates[Math.floor(rng() * plates.length)];
          if (p && p.w > S / 10 && p.h > S / 22) {
            const bh = Math.min(p.h * 0.3, S * 0.035);
            const by = p.y + p.h * 0.62;
            ctx.globalAlpha = 0.65;
            ctx.save();
            ctx.beginPath();
            ctx.rect(p.x + 4, by, p.w - 8, bh);
            ctx.clip();
            const sw = bh * 1.15;
            for (let x = p.x - bh * 2; x < p.x + p.w + bh * 2; x += sw * 2) {
              ctx.fillStyle = '#0f1114';
              ctx.beginPath();
              ctx.moveTo(x, by + bh);
              ctx.lineTo(x + sw, by + bh);
              ctx.lineTo(x + sw + bh, by);
              ctx.lineTo(x + bh, by);
              ctx.closePath();
              ctx.fill();
            }
            ctx.fillStyle = 'rgba(214,168,40,0.55)';
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillRect(p.x + 4, by, p.w - 8, bh);
            ctx.restore();
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // emissive strips — thin light channels set into seams
      if (emissiveDensity > 0) {
        ectx.strokeStyle = emissiveColor;
        ectx.lineCap = 'butt';
        const count = Math.round(plates.length * emissiveDensity);
        for (let k = 0; k < count; k++) {
          const p = plates[Math.floor(rng() * plates.length)];
          if (!p || p.w < S / 16) continue;
          const horiz = p.w > p.h;
          const lw = clamp(Math.min(p.w, p.h) * 0.09, 2, 10);
          ectx.lineWidth = lw;
          ectx.beginPath();
          if (horiz) {
            const y = p.y + p.h * (0.3 + rng() * 0.4);
            ectx.moveTo(p.x + p.w * 0.16, y);
            ectx.lineTo(p.x + p.w * 0.84, y);
          } else {
            const x = p.x + p.w * (0.3 + rng() * 0.4);
            ectx.moveTo(x, p.y + p.h * 0.16);
            ectx.lineTo(x, p.y + p.h * 0.84);
          }
          ectx.stroke();
          // also cut the channel into the height field so it reads as recessed
        }
        // paint the emissive channels dark in albedo (unlit glass looks near-black)
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.85;
        ctx.drawImage(emissiveCanvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }

      const map = this._fromCanvas(canvas, { srgb: true });

      // --- normal ----------------------------------------------------------
      const normalMap = normalFromHeight(height, S, 1.8);

      // --- ORM -------------------------------------------------------------
      const ormCanvas = getCanvas(S, S);
      const octx = ormCanvas.getContext('2d');
      const oimg = octx.createImageData(S, S);
      const od = oimg.data;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const seam = smoothstep(0.2, 1, seamMask[i]);
          const dirt = clamp(grunge[i] * grime + seam * 0.4 * grime, 0, 1);
          const chipAmt = (1 - chips[i]) * wear;
          const chipped = smoothstep(0.6, 0.86, chipAmt + seam * 0.28 * wear);
          const sc = smoothstep(0.8, 0.94, scratch[i]) * wear;

          // AO: darken seams + under rivets
          const ao = clamp(1 - seam * 0.62 - rivetMask[i] * 0.14, 0, 1);
          // roughness: dirt is rough, bare metal is smoother, scratches are rougher
          let rough = baseRough + dirt * 0.36 - chipped * 0.14 + sc * 0.22 + (micro[i] - 0.5) * 0.10;
          rough = clamp(rough, 0.06, 0.98);
          // metalness: painted areas still metal underneath; dirt buildup is dielectric
          const met = clamp(metal * (1 - dirt * 0.55), 0, 1);

          const o = i * 4;
          od[o] = ao * 255;
          od[o + 1] = rough * 255;
          od[o + 2] = met * 255;
          od[o + 3] = 255;
        }
      }
      octx.putImageData(oimg, 0, 0);
      const orm = this._fromCanvas(ormCanvas, { srgb: false });

      const emissiveMap = this._fromCanvas(emissiveCanvas, { srgb: true });

      return {
        map,
        normalMap,
        roughnessMap: orm,
        metalnessMap: orm,
        aoMap: orm,
        emissiveMap,
        _size: S,
      };
    });
  }

  /** Industrial floor / hull plating for the level: large scale, tileable. */
  hullPlating(opts = {}) {
    return this.armorPanel({
      size: 1024,
      panelScale: 3,
      baseColor: '#4a4e53',
      accentColor: '#3a3d41',
      wear: 0.72,
      grime: 0.8,
      rivets: true,
      stencil: false,
      emissiveDensity: 0,
      baseRough: 0.62,
      metal: 0.9,
      ...opts,
    });
  }

  /** Rough cast concrete with aggregate, cracks and water staining. */
  concrete(opts = {}) {
    const { size = 1024, seed = 7, tint = '#7d7c78' } = opts;
    const key = `concrete:${size}:${seed}:${tint}`;
    return this._cached(key, () => {
      const S = size;
      const macro = warp(valueNoise(S, 6, seed, 6, 0.55), valueNoise(S, 3, seed + 5, 2, 0.6), S, 0.09);
      const aggregate = worley(S, 46, seed + 13);
      const fine = valueNoise(S, 200, seed + 21, 3, 0.5);
      const stain = warp(valueNoise(S, 3, seed + 33, 5, 0.62), valueNoise(S, 7, seed + 41, 2, 0.5), S, 0.14);

      const height = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) {
        height[i] = 0.5 + (macro[i] - 0.5) * 0.35 + (1 - aggregate[i]) * 0.18 + (fine[i] - 0.5) * 0.09;
      }

      const canvas = getCanvas(S, S);
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(S, S);
      const d = img.data;
      const c = new THREE.Color(tint);
      for (let i = 0; i < S * S; i++) {
        const v = 0.72 + (macro[i] - 0.5) * 0.42 + (fine[i] - 0.5) * 0.14;
        const agg = smoothstep(0.72, 1, 1 - aggregate[i]) * 0.25;
        const st = smoothstep(0.55, 1, stain[i]);
        let r = c.r * v + agg * 0.1;
        let g = c.g * v + agg * 0.1;
        let b = c.b * v + agg * 0.11;
        // damp water staining, cooler and darker
        r = lerp(r, r * 0.48, st * 0.7);
        g = lerp(g, g * 0.50, st * 0.7);
        b = lerp(b, b * 0.56, st * 0.7);
        const o = i * 4;
        d[o] = clamp(r, 0, 1) * 255;
        d[o + 1] = clamp(g, 0, 1) * 255;
        d[o + 2] = clamp(b, 0, 1) * 255;
        d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);

      const ormCanvas = getCanvas(S, S);
      const octx = ormCanvas.getContext('2d');
      const oimg = octx.createImageData(S, S);
      const od = oimg.data;
      for (let i = 0; i < S * S; i++) {
        const st = smoothstep(0.55, 1, stain[i]);
        const ao = clamp(0.82 + (macro[i] - 0.5) * 0.3, 0.35, 1);
        const rough = clamp(0.88 - st * 0.30 + (fine[i] - 0.5) * 0.12, 0.3, 1);
        const o = i * 4;
        od[o] = ao * 255;
        od[o + 1] = rough * 255;
        od[o + 2] = 0;
        od[o + 3] = 255;
      }
      octx.putImageData(oimg, 0, 0);

      return {
        map: this._fromCanvas(canvas, { srgb: true }),
        normalMap: normalFromHeight(height, S, 1.5),
        roughnessMap: this._fromCanvas(ormCanvas),
        aoMap: this._fromCanvas(ormCanvas),
        metalnessMap: null,
        _size: S,
      };
    });
  }

  /** Radial gradient sprite — the base of most particle effects. */
  radial(inner = '#ffffff', outer = 'rgba(255,255,255,0)', size = 128, power = 1) {
    const key = `radial:${inner}:${outer}:${size}:${power}`;
    return this._cached(key, () => {
      const c = getCanvas(size, size);
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      const steps = 12;
      const ci = new THREE.Color(inner);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = Math.pow(1 - t, power * 2.2);
        g.addColorStop(t, `rgba(${(ci.r * 255) | 0},${(ci.g * 255) | 0},${(ci.b * 255) | 0},${a})`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    });
  }

  /** Soft turbulent puff for smoke — noise-modulated alpha, not a clean circle. */
  smokePuff(size = 256, seed = 3) {
    const key = `smoke:${size}:${seed}`;
    return this._cached(key, () => {
      const n = warp(valueNoise(size, 5, seed, 5, 0.6), valueNoise(size, 3, seed + 9, 2, 0.6), size, 0.12);
      const c = getCanvas(size, size);
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(size, size);
      const d = img.data;
      const half = size / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const dx = (x - half) / half;
          const dy = (y - half) / half;
          const r = Math.hypot(dx, dy);
          const falloff = clamp(1 - r, 0, 1);
          const a = clamp(Math.pow(falloff, 1.5) * (0.45 + n[i] * 1.1) - 0.06, 0, 1);
          const o = i * 4;
          d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
          d[o + 3] = a * 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    });
  }

  /** Anisotropic streak used for muzzle flashes and lens flares. */
  streak(size = 256, thickness = 0.035) {
    const key = `streak:${size}:${thickness}`;
    return this._cached(key, () => {
      const c = getCanvas(size, size);
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(size, size);
      const d = img.data;
      const half = size / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = (x - half) / half;
          const dy = (y - half) / half;
          const a = clamp(Math.exp(-(dy * dy) / (thickness * thickness)) * Math.exp(-(dx * dx) / 0.5), 0, 1);
          const o = (y * size + x) * 4;
          d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = a * 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    });
  }

  /** Blue-noise style dither / grain tile for post-processing. */
  blueNoise(size = 128) {
    return this._cached(`bn:${size}`, () => {
      const rng = mulberry32(0xb10e);
      const data = new Uint8Array(size * size * 4);
      // void-and-cluster is overkill; a well-scrambled white noise + high-pass
      // is visually sufficient at grain strengths we use.
      const w = new Float32Array(size * size);
      for (let i = 0; i < w.length; i++) w[i] = rng();
      const lp = new Float32Array(size * size);
      const R = 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let s = 0, n = 0;
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              s += w[(((y + dy) % size) + size) % size * size + ((((x + dx) % size) + size) % size)];
              n++;
            }
          }
          lp[y * size + x] = s / n;
        }
      }
      for (let i = 0; i < w.length; i++) {
        const v = clamp((w[i] - lp[i]) * 2.2 + 0.5, 0, 1);
        const o = i * 4;
        data[o] = data[o + 1] = data[o + 2] = v * 255;
        data[o + 3] = 255;
      }
      const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      return tex;
    });
  }

  dispose() {
    for (const v of this.cache.values()) {
      if (v?.isTexture) v.dispose();
      else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) v[k]?.isTexture && v[k].dispose();
      }
    }
    this.cache.clear();
  }
}

/** Singleton — created once the renderer exists. */
let _forge = null;
export function getForge(renderer) {
  if (!_forge) _forge = new TextureForge(renderer);
  return _forge;
}
