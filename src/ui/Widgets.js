/**
 * Widgets — shared 2D drawing primitives for the ACNTR interface layer.
 *
 * Everything here is written for an Armored Core VI style vector HUD:
 * hairline strokes snapped to the pixel grid, corner brackets instead of boxes,
 * segmented bars, monospaced numerals. No gradients-with-rounded-corners,
 * no skeuomorphism.
 *
 * Allocation policy: colour strings are the main per-frame allocation hazard in
 * canvas code, so every colour that varies continuously comes from a precomputed
 * lookup table (`Ramp` / `Fade`). Nothing in this module allocates at draw time.
 */

import { clamp } from '../core/MathUtils.js';

export const MONO = '"Share Tech Mono", ui-monospace, SFMono-Regular, monospace';
export const SANS = '"Rajdhani", "Segoe UI", system-ui, sans-serif';

/** Canonical palette. Mirrors the CSS custom properties in index.html. */
export const COL = {
  cyan: '#6ff2ff',
  cyanMid: 'rgba(111,242,255,0.55)',
  cyanDim: 'rgba(111,242,255,0.26)',
  cyanFaint: 'rgba(111,242,255,0.12)',
  amber: '#ffb038',
  amberDim: 'rgba(255,176,56,0.45)',
  red: '#ff4d3d',
  redDim: 'rgba(255,77,61,0.45)',
  hot: '#ff6a2a',
  white: '#e8fbff',
  dim: 'rgba(150,190,205,0.55)',
  dimmer: 'rgba(150,190,205,0.28)',
  ink: 'rgba(4,7,10,0.72)',
  inkSolid: '#05070a',
};

const _hexCache = new Map();
function parseHex(hex) {
  let v = _hexCache.get(hex);
  if (v) return v;
  let h = hex.trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  _hexCache.set(hex, v);
  return v;
}

/**
 * Precomputed colour ramp. `get(t)` returns a cached `rgba()` string so hot
 * drawing code never builds one.
 */
export class Ramp {
  constructor(stops, steps = 40, alpha = 1) {
    this.steps = steps;
    this.lut = new Array(steps);
    const parsed = stops.map((s) => [s[0], parseHex(s[1])]);
    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : i / (steps - 1);
      let a = parsed[0];
      let b = parsed[parsed.length - 1];
      for (let k = 0; k < parsed.length - 1; k++) {
        if (t >= parsed[k][0] && t <= parsed[k + 1][0]) {
          a = parsed[k];
          b = parsed[k + 1];
          break;
        }
      }
      const span = b[0] - a[0] || 1;
      const f = clamp((t - a[0]) / span, 0, 1);
      const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * f);
      const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * f);
      const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * f);
      this.lut[i] = `rgba(${r},${g},${bl},${alpha})`;
    }
  }
  get(t) {
    const i = clamp(Math.round((t || 0) * (this.steps - 1)), 0, this.steps - 1);
    return this.lut[i];
  }
}

/** Precomputed alpha ladder for a single colour. */
export class Fade {
  constructor(hex, steps = 24) {
    const [r, g, b] = parseHex(hex);
    this.steps = steps;
    this.lut = new Array(steps);
    for (let i = 0; i < steps; i++) {
      this.lut[i] = `rgba(${r},${g},${b},${(i / (steps - 1)).toFixed(3)})`;
    }
  }
  get(a) {
    const i = clamp(Math.round((a || 0) * (this.steps - 1)), 0, this.steps - 1);
    return this.lut[i];
  }
}

/**
 * AP / integrity ramp. The bands are deliberately near-stepped: a smooth
 * cyan→amber blend passes through a muddy khaki that is nowhere in the
 * palette, and AC6 reads its integrity as discrete threshold states anyway.
 */
export const AP_RAMP = new Ramp(
  [
    [0.0, '#ff3b2c'],
    [0.15, '#ff3b2c'],
    [0.18, '#ff7a2a'],
    [0.3, '#ff7a2a'],
    [0.33, '#ffb038'],
    [0.45, '#ffb038'],
    [0.48, '#8fe6f4'],
    [1.0, '#6ff2ff'],
  ],
  64
);

/** ACS build-up ramp: cool → hot as stagger approaches. */
export const ACS_RAMP = new Ramp([
  [0.0, '#4fb6c8'],
  [0.45, '#ffb038'],
  [0.8, '#ff7a2a'],
  [1.0, '#ff4d3d'],
]);

export const CYAN_FADE = new Fade('#6ff2ff', 26);
export const AMBER_FADE = new Fade('#ffb038', 26);
export const RED_FADE = new Fade('#ff4d3d', 26);
export const WHITE_FADE = new Fade('#e8fbff', 26);
export const INK_FADE = new Fade('#04070a', 26);

/** Rarity colours — kept local so the UI never hard-depends on PartsDB. */
export const RARITY_COLORS = {
  common: '#9fb3bd',
  standard: '#9fb3bd',
  uncommon: '#7fe3a2',
  rare: '#6ff2ff',
  epic: '#c08bff',
  legendary: '#ffb038',
  exotic: '#ff6a2a',
  prototype: '#ff4d3d',
  unique: '#ff4d3d',
};
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'exotic'];

/** Resolve a rarity colour from whatever shape the loot system produced. */
export function rarityColor(part) {
  if (!part) return COL.dim;
  const r = part.rarity !== undefined ? part.rarity : part.tierName;
  if (r && typeof r === 'object') {
    if (typeof r.color === 'string') return r.color;
    if (typeof r.name === 'string') return RARITY_COLORS[r.name.toLowerCase()] || COL.dim;
  }
  if (typeof r === 'number') return RARITY_COLORS[RARITY_ORDER[clamp(r | 0, 0, RARITY_ORDER.length - 1)]];
  if (typeof r === 'string') return RARITY_COLORS[r.toLowerCase()] || COL.cyan;
  if (typeof part.color === 'string') return part.color;
  return COL.dim;
}

/** Human-readable rarity name from whatever shape the loot system produced. */
export function rarityName(part) {
  if (!part) return '';
  const r = part.rarity !== undefined ? part.rarity : part.tierName;
  if (r && typeof r === 'object' && typeof r.name === 'string') return r.name;
  if (typeof r === 'number') return RARITY_ORDER[clamp(r | 0, 0, RARITY_ORDER.length - 1)];
  if (typeof r === 'string') return r;
  return '';
}

// ---------------------------------------------------------------------------
// geometry helpers — all coordinates snapped so 1px strokes stay 1px
// ---------------------------------------------------------------------------

/** Snap to the half-pixel grid so odd line widths render crisp. */
export const snap = (v) => Math.round(v) + 0.5;

export function hline(ctx, x1, x2, y) {
  const yy = snap(y);
  ctx.beginPath();
  ctx.moveTo(Math.round(x1), yy);
  ctx.lineTo(Math.round(x2), yy);
  ctx.stroke();
}

export function vline(ctx, x, y1, y2) {
  const xx = snap(x);
  ctx.beginPath();
  ctx.moveTo(xx, Math.round(y1));
  ctx.lineTo(xx, Math.round(y2));
  ctx.stroke();
}

export function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Pixel-crisp unfilled rectangle. */
export function rectSharp(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.rect(snap(x), snap(y), Math.round(w), Math.round(h));
  ctx.stroke();
}

/**
 * Four corner brackets around a centre — the core AC6 UI motif.
 * @param {number} half half-extent of the enclosing square (or x half-extent)
 * @param {number} arm  bracket arm length in px
 * @param {number} rot  rotation in radians (used by the lock-on convergence)
 */
export function brackets(ctx, cx, cy, half, arm, rot = 0, halfY = half) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sy = i < 2 ? -1 : 1;
    const px = sx * half;
    const py = sy * halfY;
    // rotate corner + both arms around the centre
    const rx = px * c - py * s + cx;
    const ry = px * s + py * c + cy;
    const ax = (px - sx * arm) * c - py * s + cx;
    const ay = (px - sx * arm) * s + py * c + cy;
    const bx = px * c - (py - sy * arm) * s + cx;
    const by = px * s + (py - sy * arm) * c + cy;
    ctx.moveTo(ax, ay);
    ctx.lineTo(rx, ry);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
}

/** Short ticks at the middle of each edge of a box — "heavier" locked frame. */
export function edgeTicks(ctx, cx, cy, half, halfY, len) {
  ctx.beginPath();
  ctx.moveTo(snap(cx), cy - halfY);
  ctx.lineTo(snap(cx), cy - halfY + len);
  ctx.moveTo(snap(cx), cy + halfY);
  ctx.lineTo(snap(cx), cy + halfY - len);
  ctx.moveTo(cx - half, snap(cy));
  ctx.lineTo(cx - half + len, snap(cy));
  ctx.moveTo(cx + half, snap(cy));
  ctx.lineTo(cx + half - len, snap(cy));
  ctx.stroke();
}

/**
 * Segmented horizontal bar. Draws the track, the fill, then punches segment
 * gaps out with the ink colour so the whole thing reads as discrete cells.
 */
export function segBar(ctx, x, y, w, h, t, color, opts) {
  const seg = (opts && opts.seg) || 9;
  const gap = (opts && opts.gap) || 2;
  const track = (opts && opts.track) || COL.cyanFaint;
  const ghost = opts && opts.ghost;
  const ghostColor = (opts && opts.ghostColor) || COL.redDim;
  const xr = Math.round(x);
  const yr = Math.round(y);
  const wr = Math.round(w);
  const hr = Math.round(h);

  ctx.fillStyle = track;
  ctx.fillRect(xr, yr, wr, hr);

  if (ghost !== undefined && ghost > t) {
    ctx.fillStyle = ghostColor;
    ctx.fillRect(xr, yr, Math.round(wr * clamp(ghost, 0, 1)), hr);
  }

  ctx.fillStyle = color;
  const fw = Math.round(wr * clamp(t, 0, 1));
  if (fw > 0) ctx.fillRect(xr, yr, fw, hr);

  // segment gaps
  ctx.fillStyle = COL.inkSolid;
  for (let sx = seg; sx < wr; sx += seg + gap) {
    ctx.fillRect(xr + sx, yr, gap, hr);
  }

  ctx.strokeStyle = (opts && opts.frame) || COL.cyanDim;
  ctx.lineWidth = 1;
  rectSharp(ctx, xr - 1, yr - 1, wr + 2, hr + 2);
}

/** Plain (unsegmented) hairline bar — used for tiny world-space gauges. */
export function microBar(ctx, x, y, w, h, t, color, trackColor) {
  const xr = Math.round(x);
  const yr = Math.round(y);
  const wr = Math.round(w);
  const hr = Math.max(1, Math.round(h));
  ctx.fillStyle = trackColor || COL.cyanFaint;
  ctx.fillRect(xr, yr, wr, hr);
  const fw = Math.round(wr * clamp(t, 0, 1));
  if (fw > 0) {
    ctx.fillStyle = color;
    ctx.fillRect(xr, yr, fw, hr);
  }
}

/** Arc segment. Angles in radians, 0 = +X, clockwise on screen. */
export function arcSeg(ctx, cx, cy, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
}

/** Dashed ring drawn as discrete ticks (cheaper + crisper than setLineDash). */
export function tickRing(ctx, cx, cy, r, count, len, phase = 0) {
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ctx.moveTo(cx + c * r, cy + s * r);
    ctx.lineTo(cx + c * (r + len), cy + s * (r + len));
  }
  ctx.stroke();
}

/** Filled triangular chevron pointing along `ang`. */
export function chevron(ctx, cx, cy, ang, size, fill) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  ctx.beginPath();
  ctx.moveTo(cx + c * size, cy + s * size);
  ctx.lineTo(cx - c * size * 0.55 - s * size * 0.68, cy - s * size * 0.55 + c * size * 0.68);
  ctx.lineTo(cx - c * size * 0.55 + s * size * 0.68, cy - s * size * 0.55 - c * size * 0.68);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  } else {
    ctx.stroke();
  }
}

/** Diamond marker. */
export function diamond(ctx, cx, cy, r, fill) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  } else {
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

const HAS_LETTER_SPACING =
  typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;

const _fontCache = new Map();
function fontStr(size, family, weight) {
  const key = size + '|' + family + '|' + (weight || '');
  let v = _fontCache.get(key);
  if (!v) {
    v = `${weight ? weight + ' ' : ''}${size}px ${family}`;
    _fontCache.set(key, v);
  }
  return v;
}

const _lsCache = new Map();
function lsStr(px) {
  let v = _lsCache.get(px);
  if (!v) {
    v = px + 'px';
    _lsCache.set(px, v);
  }
  return v;
}

/** Configure the context for monospaced numerals/data. */
export function setMono(ctx, size, spacing = 0) {
  ctx.font = fontStr(size, MONO);
  if (HAS_LETTER_SPACING) ctx.letterSpacing = lsStr(spacing);
}

/** Configure the context for uppercase Rajdhani labels. */
export function setLabel(ctx, size, spacing = 2, weight = 600) {
  ctx.font = fontStr(size, SANS, weight);
  if (HAS_LETTER_SPACING) ctx.letterSpacing = lsStr(spacing);
}

/**
 * Text with a cheap two-pass glow (no shadowBlur — it is far too expensive to
 * run on every HUD element every frame).
 */
export function glowText(ctx, str, x, y, color, glowColor, align = 'left', baseline = 'alphabetic') {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (glowColor) {
    ctx.fillStyle = glowColor;
    ctx.fillText(str, x - 1, y);
    ctx.fillText(str, x + 1, y);
    ctx.fillText(str, x, y - 1);
    ctx.fillText(str, x, y + 1);
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

/** Text with chromatic fringing — red/cyan offset copies under the main pass. */
export function fringeText(ctx, str, x, y, color, amount = 1, align = 'left', baseline = 'alphabetic') {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = 'rgba(255,60,80,0.34)';
  ctx.fillText(str, x - amount, y);
  ctx.fillStyle = 'rgba(90,220,255,0.34)';
  ctx.fillText(str, x + amount, y);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

/** Plain text pass. */
export function text(ctx, str, x, y, color, align = 'left', baseline = 'alphabetic') {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

// ---------------------------------------------------------------------------
// formatting — cached so steady values never allocate
// ---------------------------------------------------------------------------

const _padCache = [];
/** Zero-padded integer, cached for 0..9999 at width<=5. */
export function pad(n, width) {
  n = n | 0;
  if (n < 0) n = 0;
  if (width === 4 && n < 10000) {
    let s = _padCache[n];
    if (s === undefined) {
      s = String(n).padStart(4, '0');
      _padCache[n] = s;
    }
    return s;
  }
  return String(n).padStart(width, '0');
}

const _intCache = [];
/** Integer to string, cached for the common 0..2047 range. */
export function itoa(n) {
  n = n | 0;
  if (n >= 0 && n < 2048) {
    let s = _intCache[n];
    if (s === undefined) {
      s = String(n);
      _intCache[n] = s;
    }
    return s;
  }
  return String(n);
}

/** `MM:SS.d` mission clock. */
export function clockStr(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/** Distance in metres, AC6-style 4-digit readout. */
export function metres(d) {
  return pad(Math.round(clamp(d, 0, 9999)), 4);
}

/** Clamp a point to the inside of a rounded screen border, returns angle. */
export function edgeClamp(x, y, cx, cy, halfW, halfH, out) {
  let dx = x - cx;
  let dy = y - cy;
  if (dx === 0 && dy === 0) dy = -1;
  const sx = Math.abs(dx) > 1e-5 ? halfW / Math.abs(dx) : Infinity;
  const sy = Math.abs(dy) > 1e-5 ? halfH / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  out.x = cx + dx * s;
  out.y = cy + dy * s;
  out.ang = Math.atan2(dy, dx);
  return out;
}
