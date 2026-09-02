import * as THREE from 'three';
import { getForge, valueNoise, warp } from '../render/TextureForge.js';
import { clamp, lerp, mulberry32, TAU } from '../core/MathUtils.js';
import {
  particleVert, particleFrag,
  trailVert, trailFrag,
  decalVert, decalFrag,
  ringVert, ringFrag, ringDistortFrag,
  flameVert, flameFrag,
  shellVert, shellFrag,
} from './vfxShaders.js';

// module-scope scratch — never allocate in a spawn path
const _n = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _white = new THREE.Color(1, 1, 1);

/**
 * ParticleSystem — the GPU-driven effect engine underneath VFX.js.
 *
 * Everything the game can draw as an effect lives in one of eight batches, so
 * the entire VFX budget for a frame is ~9 draw calls no matter how much is
 * happening on screen:
 *
 *   additive particles   1 draw   16384 instances   sparks, flame, flash, plasma
 *   alpha particles      1 draw    9216 instances   smoke, dust, debris
 *   additive ribbons     1 draw      48 ribbons     tracers, afterimages, arcs
 *   alpha ribbons        1 draw      40 ribbons     missile smoke
 *   decals               1 draw     128 quads       scorch, cracks, dust
 *   rings                1 draw      40 instances   shockwaves, shields, discs
 *   distortion rings     1 draw       8 instances   only when a scene colour tex exists
 *   thruster plumes      2 draws     64 nozzles     inner core + outer sheath
 *   scan shells          1 draw      10 spheres     lock-on sweeps
 *
 * Particles are pure GPU: the CPU writes 32 floats into a ring buffer at spawn
 * and never touches them again. Ribbons, decals, rings, plumes and shells are
 * CPU-updated but there are only tens of them.
 */

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

/** Atlas tile indices. Layout is a 4x4 grid of 256px tiles. */
export const TILE = {
  GLOW: 0,    // soft round falloff — halos, bloom seeds
  CORE: 1,    // tight hot centre
  STREAK: 2,  // anisotropic horizontal streak
  SPARK: 3,   // small elongated ember
  SMOKE_A: 4,
  SMOKE_B: 5,
  SMOKE_C: 6,
  DUST: 7,
  RING: 8,    // thin annulus
  FLARE: 9,   // multi-point star flare
  DEBRIS: 10, // angular chunk silhouette
  ARC: 11,    // electrical arc
  HEX: 12,    // hex lattice
  SHARD: 13,  // thin energy spike
  SCORCH: 14, // burn decal
  CRACK: 15,  // impact crack / dust decal
};

const ATLAS_GRID = 4;
const ATLAS_TILE = 256;
const ATLAS_INSET = 11; // transparent padding so mip levels never bleed

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Draw a Float32 alpha mask (white RGB) into a tile. */
function blitMask(ctx, mask, size, ox, oy, dw) {
  const tmp = makeCanvas(size, size);
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
    d[o + 3] = clamp(mask[i], 0, 1) * 255;
  }
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, ox, oy, dw, dw);
}

/**
 * Build the shared particle atlas. Source imagery comes from the TextureForge
 * where it already exists (radial, streak, smokePuff, value noise); the shapes
 * the forge does not provide — arcs, shards, hex, scorch — are composed here
 * from the same noise primitives so nothing reads as a stock sprite.
 */
function buildAtlas(forge) {
  const S = ATLAS_GRID * ATLAS_TILE;
  const canvas = makeCanvas(S, S);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const rng = mulberry32(0xac6f);

  const at = (tile) => ({
    x: (tile % ATLAS_GRID) * ATLAS_TILE,
    y: Math.floor(tile / ATLAS_GRID) * ATLAS_TILE,
  });
  const inner = ATLAS_TILE - ATLAS_INSET * 2;

  const place = (tile, image) => {
    const { x, y } = at(tile);
    ctx.drawImage(image, x + ATLAS_INSET, y + ATLAS_INSET, inner, inner);
  };
  const placeMask = (tile, mask, size) => {
    const { x, y } = at(tile);
    blitMask(ctx, mask, size, x + ATLAS_INSET, y + ATLAS_INSET, inner);
  };
  /** Draw into a scratch tile with a 2D context, then blit. */
  const draw = (tile, fn, size = ATLAS_TILE) => {
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    fn(g, size);
    place(tile, c);
  };

  // --- forge-sourced tiles ---------------------------------------------------
  place(TILE.GLOW, forge.radial('#ffffff', 'rgba(255,255,255,0)', 256, 1.05).image);
  place(TILE.CORE, forge.radial('#ffffff', 'rgba(255,255,255,0)', 256, 2.9).image);
  place(TILE.STREAK, forge.streak(256, 0.05).image);
  place(TILE.SMOKE_A, forge.smokePuff(256, 3).image);
  place(TILE.SMOKE_B, forge.smokePuff(256, 17).image);
  place(TILE.SMOKE_C, forge.smokePuff(256, 41).image);
  place(TILE.DUST, forge.smokePuff(256, 73).image);

  // --- SPARK: a tiny ember with a short trailing tail -----------------------
  draw(TILE.SPARK, (g, s) => {
    const h = s / 2;
    const grad = g.createLinearGradient(0, h, s, h);
    grad.addColorStop(0.0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.78, 'rgba(255,255,255,1)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(h, h, h * 0.98, h * 0.13, 0, 0, TAU);
    g.fill();
    const r = g.createRadialGradient(h * 1.25, h, 0, h * 1.25, h, h * 0.3);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });

  // --- RING: thin annulus with a soft outside ------------------------------
  draw(TILE.RING, (g, s) => {
    const h = s / 2;
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0.00, 'rgba(255,255,255,0)');
    grad.addColorStop(0.62, 'rgba(255,255,255,0)');
    grad.addColorStop(0.80, 'rgba(255,255,255,0.42)');
    grad.addColorStop(0.90, 'rgba(255,255,255,1)');
    grad.addColorStop(0.965, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

  // --- FLARE: anamorphic star, 4 major + 8 minor spikes --------------------
  draw(TILE.FLARE, (g, s) => {
    const h = s / 2;
    g.globalCompositeOperation = 'lighter';
    const spike = (angle, len, width, alpha) => {
      g.save();
      g.translate(h, h);
      g.rotate(angle);
      const grad = g.createLinearGradient(0, 0, len, 0);
      grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
      grad.addColorStop(0.35, `rgba(255,255,255,${alpha * 0.35})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, -width);
      g.lineTo(len, 0);
      g.lineTo(0, width);
      g.closePath();
      g.fill();
      g.restore();
    };
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      spike(a, h * 0.97, h * 0.055, 0.95);
      spike(a + Math.PI, h * 0.97, h * 0.055, 0.95);
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.39;
      spike(a, h * 0.5, h * 0.03, 0.4);
    }
    const core = g.createRadialGradient(h, h, 0, h, h, h * 0.3);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, s, s);
  });

  // --- DEBRIS: irregular angular chunk -------------------------------------
  draw(TILE.DEBRIS, (g, s) => {
    const h = s / 2;
    g.fillStyle = '#ffffff';
    g.beginPath();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng() * 0.35;
      const r = h * (0.5 + rng() * 0.46);
      const x = h + Math.cos(a) * r;
      const y = h + Math.sin(a) * r * 0.78;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
    // Chew a soft alpha edge so it does not read as a hard polygon at 4px.
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createRadialGradient(h, h, h * 0.25, h, h, h * 0.99);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.8, 'rgba(0,0,0,0.96)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

  // --- ARC: branching electrical discharge, left to right ------------------
  draw(TILE.ARC, (g, s) => {
    const h = s / 2;
    g.globalCompositeOperation = 'lighter';
    const bolt = (x0, y0, x1, y1, w, alpha, depth) => {
      const pts = [[x0, y0]];
      const segs = 9;
      for (let i = 1; i < segs; i++) {
        const t = i / segs;
        const jitter = (rng() - 0.5) * s * 0.19 * Math.sin(t * Math.PI);
        pts.push([lerp(x0, x1, t), lerp(y0, y1, t) + jitter]);
      }
      pts.push([x1, y1]);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass === 0 ? `rgba(255,255,255,${alpha * 0.22})` : `rgba(255,255,255,${alpha})`;
        g.lineWidth = pass === 0 ? w * 5.5 : w;
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.stroke();
      }
      if (depth > 0) {
        for (let b = 0; b < 2; b++) {
          const i = 2 + Math.floor(rng() * (pts.length - 4));
          const [bx, by] = pts[i];
          bolt(bx, by, bx + s * (0.12 + rng() * 0.2), by + (rng() - 0.5) * s * 0.34, w * 0.6, alpha * 0.6, depth - 1);
        }
      }
    };
    bolt(s * 0.02, h, s * 0.98, h + (rng() - 0.5) * s * 0.1, s * 0.022, 1.0, 2);
  });

  // --- HEX: shield lattice -------------------------------------------------
  draw(TILE.HEX, (g, s) => {
    const R = s / 9;
    const dx = R * 1.5;
    const dy = R * Math.sqrt(3);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = Math.max(1.5, s / 150);
    for (let col = -1; col * dx < s + R; col++) {
      for (let row = -1; row * dy < s + R; row++) {
        const cx = col * dx;
        const cy = row * dy + (col % 2 ? dy * 0.5 : 0);
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU;
          const x = cx + Math.cos(a) * R * 0.92;
          const y = cy + Math.sin(a) * R * 0.92;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
        g.stroke();
      }
    }
    g.globalCompositeOperation = 'destination-in';
    const h = s / 2;
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.65, 'rgba(0,0,0,0.85)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

  // --- SHARD: thin energy spike, bright root tapering to a point -----------
  draw(TILE.SHARD, (g, s) => {
    const h = s / 2;
    const grad = g.createLinearGradient(0, 0, s, 0);
    grad.addColorStop(0.0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.12, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(s * 0.14, h - s * 0.11);
    g.lineTo(s, h - s * 0.006);
    g.lineTo(s, h + s * 0.006);
    g.lineTo(s * 0.14, h + s * 0.11);
    g.closePath();
    g.fill();
  });

  // --- SCORCH: burnt blotch with soot spatter ------------------------------
  {
    const N = 128;
    const n = warp(valueNoise(N, 5, 313, 5, 0.62), valueNoise(N, 3, 977, 2, 0.6), N, 0.16);
    const spat = valueNoise(N, 22, 617, 3, 0.5);
    const mask = new Float32Array(N * N);
    const half = N / 2;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const dx = (x - half) / half;
        const dy = (y - half) / half;
        const r = Math.hypot(dx, dy);
        const edge = clamp(1 - r * (0.72 + n[i] * 0.62), 0, 1);
        let a = Math.pow(edge, 1.35) * (0.55 + n[i] * 0.9);
        // outer soot spatter — keeps the rim from being a clean circle
        if (r > 0.45 && r < 1.05) a += clamp(spat[i] - 0.72, 0, 1) * 2.6 * clamp(1 - r, 0, 1);
        mask[i] = clamp(a, 0, 1);
      }
    }
    placeMask(TILE.SCORCH, mask, N);
  }

  // --- CRACK: radial impact fracture + dust halo ---------------------------
  draw(TILE.CRACK, (g, s) => {
    const h = s / 2;
    const halo = g.createRadialGradient(h, h, 0, h, h, h);
    halo.addColorStop(0, 'rgba(255,255,255,0.55)');
    halo.addColorStop(0.35, 'rgba(255,255,255,0.22)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineCap = 'round';
    const rays = 11;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU + rng() * 0.5;
      const len = h * (0.35 + rng() * 0.6);
      g.lineWidth = Math.max(1, s * (0.016 - i * 0.0004));
      g.beginPath();
      g.moveTo(h, h);
      let x = h, y = h;
      const steps = 4;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const wob = (rng() - 0.5) * 0.34;
        x = h + Math.cos(a + wob * t) * len * t;
        y = h + Math.sin(a + wob * t) * len * t;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createRadialGradient(h, h, 0, h, h, h);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.7, 'rgba(0,0,0,0.9)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, s, s);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Seamless band used by ribbon trails — tiles horizontally. */
function buildTrailTexture(kind) {
  const W = 256;
  const H = 64;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const n = valueNoise(W, kind === 'smoke' ? 5 : 9, kind === 'smoke' ? 21 : 77, 4, 0.58);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.abs((y / (H - 1)) * 2 - 1);
      const across = Math.pow(clamp(1 - v, 0, 1), kind === 'smoke' ? 1.1 : 1.9);
      const nz = n[(y * 4) % W * W + x] ?? n[x];
      const puff = kind === 'smoke' ? 0.35 + nz * 1.25 : 0.75 + nz * 0.5;
      const o = (y * W + x) * 4;
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
      d[o + 3] = clamp(across * puff, 0, 1) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shared quad
// ---------------------------------------------------------------------------

function makeQuadAttrs() {
  return {
    position: new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3),
    uv: new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
    index: new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1),
  };
}

// ---------------------------------------------------------------------------
// Spawn descriptor — one shared, mutable struct, zero allocation per spawn
// ---------------------------------------------------------------------------

class SpawnDesc {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.color0 = new THREE.Color();
    this.color1 = new THREE.Color();
    this.reset();
  }

  reset() {
    this.pos.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.color0.setRGB(1, 1, 1);
    this.color1.setRGB(1, 1, 1);
    this.life = 0.5;
    this.drag = 0;
    this.gravity = 0;
    this.turb = 0;
    this.turbFreq = 6;
    this.size0 = 1;
    this.size1 = 1;
    this.rot = 0;
    this.spin = 0;
    this.alpha0 = 1;
    this.alpha1 = 0;
    this.tile = TILE.GLOW;
    this.stretch = 0;
    this.fadeIn = 0.06;
    this.erode = 0;
    this.sizeCurve = 1;
    this.alphaCurve = 1;
    this.soft = 0;
    return this;
  }
}

// ---------------------------------------------------------------------------
// ParticleBatch
// ---------------------------------------------------------------------------

const P_STRIDE = 32;

class ParticleBatch {
  constructor(capacity, material, quad, renderOrder) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * P_STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, P_STRIDE);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', quad.position);
    geo.setAttribute('uv', quad.uv);
    geo.setIndex(quad.index);
    const names = ['aPosBirth', 'aVelLife', 'aDyn', 'aSize', 'aCol0', 'aCol1', 'aMisc', 'aFlags'];
    for (let i = 0; i < names.length; i++) {
      geo.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4));
    }
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.geometry = geo;
    this.material = material;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    this.head = 0;
    this.high = 0;          // high-water mark: how many instances to draw
    this.latestDeath = 0;
    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
  }

  /** Write one particle from a SpawnDesc. Returns the slot index. */
  write(d, time) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (i + 1 > this.high) this.high = i + 1;
    if (this._dirtyHi >= 0 && i < this._dirtyLo) {
      // The ring buffer wrapped mid-frame: commit the range we already have and
      // start a fresh one rather than re-uploading the whole 2MB buffer.
      this.buffer.addUpdateRange(this._dirtyLo * P_STRIDE, (this._dirtyHi - this._dirtyLo) * P_STRIDE);
      this._dirtyLo = Infinity;
      this._dirtyHi = -Infinity;
    }
    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i + 1 > this._dirtyHi) this._dirtyHi = i + 1;

    const a = this.data;
    let o = i * P_STRIDE;
    a[o] = d.pos.x; a[o + 1] = d.pos.y; a[o + 2] = d.pos.z; a[o + 3] = time;
    a[o + 4] = d.vel.x; a[o + 5] = d.vel.y; a[o + 6] = d.vel.z; a[o + 7] = d.life;
    a[o + 8] = d.drag; a[o + 9] = d.gravity; a[o + 10] = d.turb; a[o + 11] = d.turbFreq;
    a[o + 12] = d.size0; a[o + 13] = d.size1; a[o + 14] = d.rot; a[o + 15] = d.spin;
    a[o + 16] = d.color0.r; a[o + 17] = d.color0.g; a[o + 18] = d.color0.b; a[o + 19] = d.alpha0;
    a[o + 20] = d.color1.r; a[o + 21] = d.color1.g; a[o + 22] = d.color1.b; a[o + 23] = d.alpha1;
    a[o + 24] = d.tile; a[o + 25] = d.stretch; a[o + 26] = d.fadeIn; a[o + 27] = d.seed ?? Math.random();
    a[o + 28] = d.erode; a[o + 29] = d.sizeCurve; a[o + 30] = d.alphaCurve; a[o + 31] = d.soft;

    const death = time + d.life;
    if (death > this.latestDeath) this.latestDeath = death;
    return i;
  }

  update(time) {
    if (this._dirtyHi >= 0) {
      this.buffer.addUpdateRange(this._dirtyLo * P_STRIDE, (this._dirtyHi - this._dirtyLo) * P_STRIDE);
      this._dirtyLo = Infinity;
      this._dirtyHi = -Infinity;
    }
    if (this.buffer.updateRanges.length > 0) this.buffer.needsUpdate = true;
    if (this.high > 0 && time > this.latestDeath) {
      // Nothing alive: collapse the draw so idle frames cost nothing.
      this.high = 0;
      this.head = 0;
    }
    this.geometry.instanceCount = this.high;
  }

  /** A frame that wrapped the ring buffer must upload the whole thing. */
  markWrapped() {
    this._dirtyLo = 0;
    this._dirtyHi = this.capacity;
  }

  clear() {
    this.data.fill(0);
    this.head = 0;
    this.high = 0;
    this.latestDeath = 0;
    this.markWrapped();
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// TrailBatch — tapered ribbons following a position history
// ---------------------------------------------------------------------------

const T_STRIDE = 12; // pos(3) dir(3) uvw(2) col(4)

class Ribbon {
  constructor(index, points) {
    this.index = index;
    this.points = points;
    this.pos = new Float32Array(points * 3);
    this.born = new Float32Array(points);
    this.active = false;
    this.ended = false;
    this.used = 0;
    this.width = 0.4;
    this.widthGrow = 0;
    this.life = 0.6;
    this.minSeg = 0.5;
    this.tile = 1;
    this.scrollRate = 0;
    this.taperHead = 0.35;
    this.color = new THREE.Color(1, 1, 1);
    this.color1 = new THREE.Color(1, 1, 1);
    this.alpha = 1;
    this.drift = new THREE.Vector3();
    this.spread = 0;
    this.target = null;      // Object3D to follow
    this.offset = null;      // optional local offset on target
    this.manual = new THREE.Vector3();
    this.hasManual = false;
    this.dead = true;
    this.gen = 0;
  }
}

class TrailBatch {
  constructor(maxTrails, points, material, renderOrder) {
    this.max = maxTrails;
    this.points = points;
    const verts = maxTrails * points * 2;
    this.data = new Float32Array(verts * T_STRIDE);
    this.buffer = new THREE.InterleavedBuffer(this.data, T_STRIDE);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    const side = new Float32Array(verts);
    for (let i = 0; i < verts; i++) side[i] = i % 2 === 0 ? -1 : 1;

    const segs = points - 1;
    const idx = new Uint32Array(maxTrails * segs * 6);
    let w = 0;
    for (let t = 0; t < maxTrails; t++) {
      const base = t * points * 2;
      for (let s = 0; s < segs; s++) {
        const a = base + s * 2;
        idx[w++] = a; idx[w++] = a + 1; idx[w++] = a + 2;
        idx[w++] = a + 1; idx[w++] = a + 3; idx[w++] = a + 2;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('aDir', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    geo.setAttribute('aUvw', new THREE.InterleavedBufferAttribute(this.buffer, 2, 6));
    geo.setAttribute('aCol', new THREE.InterleavedBufferAttribute(this.buffer, 4, 8));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.geometry = geo;
    this.material = material;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;

    this.ribbons = [];
    this.free = [];
    for (let i = maxTrails - 1; i >= 0; i--) {
      this.ribbons[i] = new Ribbon(i, points);
      this.free.push(i);
    }
    this._dirty = false;
  }

  acquire() {
    const i = this.free.pop();
    if (i === undefined) return null;
    const r = this.ribbons[i];
    r.active = true;
    r.ended = false;
    r.dead = false;
    r.used = 0;
    r.gen++;
    r.target = null;
    r.offset = null;
    r.hasManual = false;
    r.drift.set(0, 0, 0);
    r.spread = 0;
    return r;
  }

  release(r) {
    if (r.dead) return;
    r.dead = true;
    r.active = false;
    r.target = null;
    this._zero(r);
    this.free.push(r.index);
    this._dirty = true;
  }

  _zero(r) {
    const base = r.index * this.points * 2 * T_STRIDE;
    this.data.fill(0, base, base + this.points * 2 * T_STRIDE);
  }

  /** Append or slide the head point. */
  push(r, x, y, z, time) {
    if (r.used === 0) {
      for (let i = 0; i < r.points; i++) {
        r.pos[i * 3] = x; r.pos[i * 3 + 1] = y; r.pos[i * 3 + 2] = z;
        r.born[i] = time;
      }
      r.used = 1;
      return;
    }
    const dx = x - r.pos[0];
    const dy = y - r.pos[1];
    const dz = z - r.pos[2];
    if (dx * dx + dy * dy + dz * dz >= r.minSeg * r.minSeg) {
      // shift down, newest at 0
      for (let i = r.points - 1; i > 0; i--) {
        r.pos[i * 3] = r.pos[(i - 1) * 3];
        r.pos[i * 3 + 1] = r.pos[(i - 1) * 3 + 1];
        r.pos[i * 3 + 2] = r.pos[(i - 1) * 3 + 2];
        r.born[i] = r.born[i - 1];
      }
      if (r.used < r.points) r.used++;
    }
    r.pos[0] = x; r.pos[1] = y; r.pos[2] = z;
    r.born[0] = time;
  }

  /** Rewrite one ribbon's vertices. Called once per active ribbon per frame. */
  build(r, time, dt) {
    const P = this.points;
    const d = this.data;
    const base = r.index * P * 2 * T_STRIDE;
    let anyAlive = false;

    // Smoke drifts and spreads as it ages — makes long trails read as volume.
    if (r.drift.lengthSq() > 0 || r.spread > 0) {
      for (let i = 1; i < P; i++) {
        const age = time - r.born[i];
        const s = r.spread * dt;
        r.pos[i * 3] += r.drift.x * dt + (Math.sin(age * 2.3 + i) * s);
        r.pos[i * 3 + 1] += r.drift.y * dt + (Math.sin(age * 1.7 + i * 2.1) * s * 0.6);
        r.pos[i * 3 + 2] += r.drift.z * dt + (Math.cos(age * 2.9 + i * 1.3) * s);
      }
    }

    for (let i = 0; i < P; i++) {
      const px = r.pos[i * 3], py = r.pos[i * 3 + 1], pz = r.pos[i * 3 + 2];
      // tangent from neighbours
      const ia = Math.max(0, i - 1);
      const ib = Math.min(P - 1, i + 1);
      let tx = r.pos[ib * 3] - r.pos[ia * 3];
      let ty = r.pos[ib * 3 + 1] - r.pos[ia * 3 + 1];
      let tz = r.pos[ib * 3 + 2] - r.pos[ia * 3 + 2];
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-5) { tx /= tl; ty /= tl; tz /= tl; } else { tx = 0; ty = 1; tz = 0; }

      const alive = i < r.used;
      const age = alive ? Math.max(0, time - r.born[i]) : r.life;
      const lt = clamp(age / r.life, 0, 1);
      const along = i / (P - 1);
      // Taper: pinched at the head (so it emerges from the emitter), thick in
      // the body, thinning to nothing at the tail.
      const taper = Math.min(1, along / Math.max(r.taperHead, 0.001)) * (1 - along * along * 0.35);
      const w = r.width * (1 + r.widthGrow * lt) * taper * (1 - lt * 0.15);
      let a = alive ? r.alpha * Math.pow(1 - lt, 1.25) * (1 - Math.pow(along, 3.0) * 0.55) : 0;
      if (i === 0) a *= 0.35; // hide the head cap
      if (a > 0.002) anyAlive = true;

      const cr = lerp(r.color.r, r.color1.r, lt);
      const cg = lerp(r.color.g, r.color1.g, lt);
      const cb = lerp(r.color.b, r.color1.b, lt);
      const u = along * r.tile + r.scrollRate * time;

      for (let s = 0; s < 2; s++) {
        const o = base + (i * 2 + s) * T_STRIDE;
        d[o] = px; d[o + 1] = py; d[o + 2] = pz;
        d[o + 3] = tx; d[o + 4] = ty; d[o + 5] = tz;
        d[o + 6] = u; d[o + 7] = w * 0.5;
        d[o + 8] = cr; d[o + 9] = cg; d[o + 10] = cb; d[o + 11] = a;
      }
    }
    this._dirty = true;
    return anyAlive;
  }

  flush() {
    if (!this._dirty) return;
    this.buffer.needsUpdate = true;
    this._dirty = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Generic instanced batch (decals / rings / flames / shells)
// ---------------------------------------------------------------------------

class InstancedBatch {
  constructor({ capacity, stride, names, baseGeometry, material, renderOrder, extraAttributes }) {
    this.capacity = capacity;
    this.stride = stride;
    this.data = new Float32Array(capacity * stride);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, stride);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.InstancedBufferGeometry();
    const src = baseGeometry;
    for (const key of Object.keys(src.attributes)) geo.setAttribute(key, src.attributes[key]);
    if (src.index) geo.setIndex(src.index);
    if (extraAttributes) for (const k of Object.keys(extraAttributes)) geo.setAttribute(k, extraAttributes[k]);
    for (let i = 0; i < names.length; i++) {
      geo.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4));
    }
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.geometry = geo;
    this.material = material;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.head = 0;
    this.high = 0;
    this.latestDeath = 0;
    this._dirty = false;
  }

  alloc() {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (i + 1 > this.high) this.high = i + 1;
    this._dirty = true;
    return i * this.stride;
  }

  update(time) {
    if (this._dirty) {
      this.buffer.needsUpdate = true;
      this._dirty = false;
    }
    if (this.high > 0 && time > this.latestDeath) {
      this.high = 0;
      this.head = 0;
    }
    this.geometry.instanceCount = this.high;
  }

  clear() {
    this.data.fill(0);
    this.head = 0;
    this.high = 0;
    this.latestDeath = 0;
    this._dirty = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

function buildDiscGeometry(segments = 64, rings = 4) {
  const pos = [];
  const idx = [];
  for (let r = 0; r <= rings; r++) {
    const rad = r / rings;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * TAU;
      pos.push(Math.cos(a) * rad, Math.sin(a) * rad, 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s;
      const b = r * segments + s1;
      const c = (r + 1) * segments + s;
      const d = (r + 1) * segments + s1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Open cone shell in "plume space": xy on the unit circle, z the 0..1 parameter
 * the vertex shader turns into length. `bias` above 1 packs rings toward the
 * throat, where the profile curves hardest; the tip only needs enough rings to
 * keep its taper smooth.
 *
 * `radial` is a silhouette budget, not a fill budget — at 10 the plume showed a
 * decagon rim at 13 m, which REVIEW scores as an automatic failure. Only a
 * handful of instances ever draw (four on the player), so segments are cheap.
 */
function buildPlumeGeometry(radial = 10, axial = 8, bias = 1.0) {
  const pos = [];
  const idx = [];
  for (let j = 0; j <= axial; j++) {
    const v = Math.pow(j / axial, bias);
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * TAU;
      pos.push(Math.cos(a), Math.sin(a), v);
    }
  }
  for (let j = 0; j < axial; j++) {
    for (let i = 0; i < radial; i++) {
      const i1 = (i + 1) % radial;
      const a = j * radial + i;
      const b = j * radial + i1;
      const c = (j + 1) * radial + i;
      const d = (j + 1) * radial + i1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function buildShellGeometry() {
  const ico = new THREE.IcosahedronGeometry(1, 2).toNonIndexed();
  const count = ico.attributes.position.count;
  const bary = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 3) {
    bary[i * 3] = 1;
    bary[(i + 1) * 3 + 1] = 1;
    bary[(i + 2) * 3 + 2] = 1;
  }
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  ico.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  return ico;
}

// ---------------------------------------------------------------------------
// Light pool
// ---------------------------------------------------------------------------

/**
 * Eight PointLights, created once and never added/removed after construction —
 * changing the light count forces every material in the scene to recompile,
 * which would hitch on the first shot of every fight.
 */
class LightPool {
  constructor(scene, count = 8) {
    this.slots = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 30, 2);
      light.castShadow = false;
      light.visible = false;
      scene.add(light);
      this.slots.push({ light, until: 0, start: 0, peak: 0, hold: 0, priority: 0 });
    }
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {THREE.Color|number} color
   * @param {number} intensity peak intensity
   * @param {number} distance falloff radius in metres
   * @param {number} duration seconds
   */
  flash(pos, color, intensity, distance, duration, time, priority = 1) {
    let slot = null;
    let weakest = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.until <= time) { slot = s; break; }
      if (!weakest || s.priority < weakest.priority) weakest = s;
    }
    if (!slot) {
      if (!weakest || weakest.priority > priority) return null;
      slot = weakest;
    }
    slot.light.position.copy(pos);
    slot.light.color.set(color);
    slot.light.distance = distance;
    slot.light.visible = true;
    slot.start = time;
    slot.until = time + duration;
    slot.peak = intensity;
    slot.hold = duration * 0.18;
    slot.priority = priority;
    return slot;
  }

  update(time) {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.until <= time) {
        if (s.light.visible) {
          s.light.visible = false;
          s.light.intensity = 0;
          s.priority = 0;
        }
        continue;
      }
      const age = time - s.start;
      const dur = s.until - s.start;
      // Rise fast, decay on a curve — muzzle and explosion light both want this.
      const rise = clamp(age / Math.max(dur * 0.08, 1e-3), 0, 1);
      const t = clamp((age - s.hold) / Math.max(dur - s.hold, 1e-3), 0, 1);
      s.light.intensity = s.peak * rise * Math.pow(1 - t, 2.2);
    }
  }

  reset() {
    for (const s of this.slots) {
      s.until = 0;
      s.priority = 0;
      s.light.visible = false;
      s.light.intensity = 0;
    }
  }

  dispose(scene) {
    for (const s of this.slots) {
      scene.remove(s.light);
      s.light.dispose?.();
    }
    this.slots.length = 0;
  }
}

// ---------------------------------------------------------------------------
// ParticleSystem
// ---------------------------------------------------------------------------

export const BATCH_ADD = 0;
export const BATCH_ALPHA = 1;

const LIVE_BUCKETS = 96;
const LIVE_BUCKET_S = 0.08; // covers 7.68s of lifetime

export class ParticleSystem {
  constructor(scene, renderer, opts = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 0;
    this.camera = null;

    const forge = getForge(renderer);
    this.atlas = buildAtlas(forge);
    this.trailSmokeTex = buildTrailTexture('smoke');
    this.trailHotTex = buildTrailTexture('hot');

    // 1x1 stand-in so the depth sampler is always bound even when the render
    // pipeline never gives us a real depth texture.
    this._dummyDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    this._dummyDepth.needsUpdate = true;
    this._dummyScene = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this._dummyScene.needsUpdate = true;

    this.softUniform = { value: new THREE.Vector4(0, 0.35, 6000, 0.55) };
    this.depthUniform = { value: this._dummyDepth };
    this.timeUniform = { value: 0 };
    this.atlasUniform = { value: new THREE.Vector2(ATLAS_GRID, 1 / ATLAS_GRID) };
    this.sizeScaleUniform = { value: 1 };

    const quad = makeQuadAttrs();
    this.group = new THREE.Group();
    this.group.name = 'VFX';
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
    scene.add(this.group);

    // --- particles ----------------------------------------------------------
    const capAdd = opts.additiveCapacity ?? 16384;
    const capAlpha = opts.alphaCapacity ?? 9216;

    const particleUniforms = () => ({
      uMap: { value: this.atlas },
      uTime: this.timeUniform,
      uAtlas: this.atlasUniform,
      uDepthTex: this.depthUniform,
      uSoftParams: this.softUniform,
      uAlphaScale: { value: 1 },
      uSizeScale: this.sizeScaleUniform,
    });

    const addMat = new THREE.ShaderMaterial({
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      uniforms: particleUniforms(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const alphaMat = new THREE.ShaderMaterial({
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      uniforms: particleUniforms(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.batches = [
      new ParticleBatch(capAdd, addMat, quad, 22),
      new ParticleBatch(capAlpha, alphaMat, quad, 18),
    ];
    this.group.add(this.batches[0].mesh, this.batches[1].mesh);

    // --- trails -------------------------------------------------------------
    const trailMat = (tex, blending, tile, scroll, order) => new THREE.ShaderMaterial({
      vertexShader: trailVert,
      fragmentShader: trailFrag,
      uniforms: {
        uMap: { value: tex },
        uScroll: { value: scroll },
        uTile: { value: tile },
        uSoftDist: { value: 0.5 },
        uDepthTex: this.depthUniform,
        uSoftParams: this.softUniform,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      side: THREE.DoubleSide,
    });

    this.trailAdd = new TrailBatch(48, 26, trailMat(this.trailHotTex, THREE.AdditiveBlending, 1, 0, 21), 21);
    this.trailAlpha = new TrailBatch(40, 30, trailMat(this.trailSmokeTex, THREE.NormalBlending, 3, 0, 17), 17);
    this.group.add(this.trailAdd.mesh, this.trailAlpha.mesh);

    // --- decals -------------------------------------------------------------
    const decalMat = new THREE.ShaderMaterial({
      vertexShader: decalVert,
      fragmentShader: decalFrag,
      uniforms: {
        uMap: { value: this.atlas },
        uTime: this.timeUniform,
        uAtlas: this.atlasUniform,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const decalBase = new THREE.BufferGeometry();
    decalBase.setAttribute('position', quad.position);
    decalBase.setAttribute('uv', quad.uv);
    decalBase.setIndex(quad.index);
    this.decals = new InstancedBatch({
      capacity: opts.decalCapacity ?? 128,
      stride: 20,
      names: ['aPosBirth', 'aRight', 'aUp', 'aColor', 'aMisc'],
      baseGeometry: decalBase,
      material: decalMat,
      renderOrder: 4,
    });
    this.group.add(this.decals.mesh);

    // --- rings --------------------------------------------------------------
    this._discGeo = buildDiscGeometry(72, 4);
    const ringUniforms = () => ({ uTime: this.timeUniform });
    const ringMat = new THREE.ShaderMaterial({
      vertexShader: ringVert,
      fragmentShader: ringFrag,
      uniforms: ringUniforms(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.rings = new InstancedBatch({
      capacity: 40,
      stride: 20,
      names: ['aOrigin', 'aAxis', 'aShape', 'aColor', 'aExtra'],
      baseGeometry: this._discGeo,
      material: ringMat,
      renderOrder: 20,
    });
    this.group.add(this.rings.mesh);

    // Distortion rings are only drawn when the pipeline supplies a scene colour
    // texture; without one they would sample garbage, so the mesh stays hidden.
    this.sceneColorUniform = { value: this._dummyScene };
    const distortMat = new THREE.ShaderMaterial({
      vertexShader: ringVert,
      fragmentShader: ringDistortFrag,
      uniforms: {
        uTime: this.timeUniform,
        uSceneColor: this.sceneColorUniform,
        // Fraction of the SCREEN the wavefront displaces its sample by. See the
        // note in ringDistortFrag — 0.045 was 86 px at 1920 and smeared the sky.
        uStrength: { value: 0.010 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.distortRings = new InstancedBatch({
      capacity: 8,
      stride: 20,
      names: ['aOrigin', 'aAxis', 'aShape', 'aColor', 'aExtra'],
      baseGeometry: this._discGeo,
      material: distortMat,
      renderOrder: 19,
    });
    this.distortRings.mesh.visible = false;
    this.hasSceneColor = false;
    this.group.add(this.distortRings.mesh);

    // --- thruster plumes ----------------------------------------------------
    this._plumeGeo = buildPlumeGeometry(24, 20, 1.25);
    this.flameCapacity = opts.flameCapacity ?? 64;
    this.flameData = new Float32Array(this.flameCapacity * 12);
    this.flameBuffer = new THREE.InstancedInterleavedBuffer(this.flameData, 12);
    this.flameBuffer.setUsage(THREE.DynamicDrawUsage);
    const flameGeo = new THREE.InstancedBufferGeometry();
    flameGeo.setAttribute('position', this._plumeGeo.attributes.position);
    flameGeo.setIndex(this._plumeGeo.index);
    flameGeo.setAttribute('aOrigin', new THREE.InterleavedBufferAttribute(this.flameBuffer, 4, 0));
    flameGeo.setAttribute('aAxis', new THREE.InterleavedBufferAttribute(this.flameBuffer, 4, 4));
    flameGeo.setAttribute('aParams', new THREE.InterleavedBufferAttribute(this.flameBuffer, 4, 8));
    flameGeo.instanceCount = 0;
    flameGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this._flameGeo = flameGeo;

    const flameLayer = (opt) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: flameVert,
        fragmentShader: flameFrag,
        uniforms: {
          uTime: this.timeUniform,
          uLength: { value: opt.length },
          uRadius: { value: opt.radius },
          uBulge: { value: opt.bulge },
          uWaver: { value: opt.waver ?? 0 },
          uTaper: { value: opt.taper ?? 0.6 },
          uCoolColor: { value: new THREE.Color().setRGB(...opt.cool) },
          uHotColor: { value: new THREE.Color().setRGB(...opt.hot) },
          uEdgeColor: { value: new THREE.Color().setRGB(...opt.edge) },
          uTipColor: { value: new THREE.Color().setRGB(...opt.tip) },
          uDiamonds: { value: opt.diamonds },
          uGain: { value: opt.gain },
          uRimPow: { value: opt.rimPow ?? 1.7 },
          uTipFade: { value: opt.tipFade ?? 0.55 },
          uFibre: { value: opt.fibre ?? 0 },
          uDepthTex: this.depthUniform,
          uSoftParams: this.softUniform,
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(flameGeo, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = opt.order;
      return mesh;
    };

    // THREE layers, and the reason there are three is the tone curve. AgX makes
    // display value almost independent of radiance above ~3 linear, so a plume
    // built as one bright shell renders as a flat white cone with no hue and no
    // structure — which is exactly what the first frame after the smoothstep fix
    // showed. Splitting it lets each layer live in the band where it can be seen
    // for what it is: the CORE is deliberately blown (that is the hot core the
    // bloom needs), the SHEATH stays under ~3 linear so it keeps its blue, and
    // the STREAK is long, thin and faint so bloom turns it into the wide soft
    // halo rather than more white.

    // Core: short, tight, blown white, hard shock diamonds.
    this.flameCore = flameLayer({
      length: 0.60, radius: 0.44, bulge: 0.08, diamonds: 1.25, gain: 2.4, order: 26,
      taper: 0.52, tipFade: 0.42, rimPow: 1.15, waver: 0.10, fibre: 0.25,
      cool: [0.55, 0.85, 1.25], hot: [5.0, 5.6, 6.6], edge: [1.6, 3.0, 5.2],
      tip: [1.2, 2.2, 3.6],
    });
    // Sheath: the part that carries the colour. Kept in the tonemappable band.
    this.flameSheath = flameLayer({
      length: 1.55, radius: 1.05, bulge: 0.20, diamonds: 0.30, gain: 0.85, order: 25,
      taper: 0.60, tipFade: 0.50, rimPow: 1.9, waver: 0.28, fibre: 0.55,
      cool: [0.10, 0.30, 0.85], hot: [0.70, 1.55, 2.85], edge: [0.30, 1.05, 2.60],
      tip: [0.16, 0.52, 1.35],
    });
    // Streak: the long anisotropic tail. Narrow, faint, and by far the longest —
    // this is what makes an assault-boost plume read at 95 m/s.
    this.flameStreak = flameLayer({
      length: 3.40, radius: 0.62, bulge: 0.32, diamonds: 0.0, gain: 0.30, order: 24,
      taper: 0.34, tipFade: 0.30, rimPow: 2.6, waver: 0.75, fibre: 0.70,
      cool: [0.06, 0.18, 0.55], hot: [0.30, 0.85, 1.90], edge: [0.16, 0.62, 1.75],
      tip: [0.09, 0.26, 0.80],
    });
    this.group.add(this.flameStreak, this.flameSheath, this.flameCore);
    // Kept as aliases: older code and probes reach for these two names.
    this.flameInner = this.flameCore;
    this.flameOuter = this.flameSheath;
    this._flameLayers = [this.flameCore, this.flameSheath, this.flameStreak];

    // --- scan shells --------------------------------------------------------
    this._shellGeo = buildShellGeometry();
    const shellMat = new THREE.ShaderMaterial({
      vertexShader: shellVert,
      fragmentShader: shellFrag,
      uniforms: { uTime: this.timeUniform },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.shells = new InstancedBatch({
      capacity: 10,
      stride: 12,
      names: ['aOrigin', 'aParams', 'aColor'],
      baseGeometry: this._shellGeo,
      material: shellMat,
      renderOrder: 25,
    });
    this.group.add(this.shells.mesh);

    // --- lights -------------------------------------------------------------
    this.lights = new LightPool(scene, opts.lightCount ?? 8);

    // --- budgeting ----------------------------------------------------------
    this.desc = new SpawnDesc();
    this._target = this.batches[0];
    this.softCap = opts.softCap ?? 30000;
    this.live = 0;
    this._buckets = new Int32Array(LIVE_BUCKETS);
    this._bucketCursor = 0;
    this._bucketAccum = 0;
    this.quality = 1;
    this.stats = { spawned: 0, dropped: 0 };

    // Capture the active camera without adding a contract dependency.
    this.batches[0].mesh.onBeforeRender = (renderer, scene2, camera) => { this.camera = camera; };
  }

  // -- spawn API ------------------------------------------------------------

  /**
   * Begin a particle spawn. Returns a shared, reset descriptor — fill it in and
   * call `emit()`. Never retains the object, so this allocates nothing.
   * @param {number} batch BATCH_ADD or BATCH_ALPHA
   */
  begin(batch = BATCH_ADD) {
    this._target = this.batches[batch] || this.batches[0];
    const d = this.desc;
    d.reset();
    d.seed = Math.random();
    return d;
  }

  /** Commit the descriptor prepared by `begin()`. */
  emit() {
    const d = this.desc;
    if (d.life <= 0) return -1;
    if (this.live >= this.softCap) {
      this.stats.dropped++;
      return -1;
    }
    const i = this._target.write(d, this.time);
    this._trackLive(d.life);
    this.stats.spawned++;
    return i;
  }

  /** True when there is headroom for `n` more particles of the given priority. */
  canSpawn(n = 1, priority = 0) {
    const cap = priority > 0 ? this.softCap : this.softCap * 0.82;
    return this.live + n <= cap;
  }

  _trackLive(life) {
    const l = Math.min(life, LIVE_BUCKETS * LIVE_BUCKET_S - LIVE_BUCKET_S);
    const b = (this._bucketCursor + Math.max(1, Math.ceil(l / LIVE_BUCKET_S))) % LIVE_BUCKETS;
    this._buckets[b]++;
    this.live++;
  }

  // -- other spawns ---------------------------------------------------------

  /**
   * @param {THREE.Vector3} pos surface point
   * @param {THREE.Vector3} normal surface normal
   * @param {number} size metres
   * @param {number} tile atlas tile
   * @param {THREE.Color} color
   * @param {number} alpha
   * @param {number} life seconds
   */
  decal(pos, normal, size, tile, color, alpha, life, rotation = Math.random() * TAU) {
    const o = this.decals.alloc();
    const d = this.decals.data;
    _n.copy(normal).normalize();
    // Build a tangent frame on the surface, rotated so repeats never tile.
    if (Math.abs(_n.y) < 0.97) _ref.set(0, 1, 0); else _ref.set(1, 0, 0);
    _t1.crossVectors(_ref, _n).normalize();
    _t2.crossVectors(_n, _t1);
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const rx = _t1.x * c + _t2.x * s;
    const ry = _t1.y * c + _t2.y * s;
    const rz = _t1.z * c + _t2.z * s;
    const ux = -_t1.x * s + _t2.x * c;
    const uy = -_t1.y * s + _t2.y * c;
    const uz = -_t1.z * s + _t2.z * c;

    d[o] = pos.x + _n.x * 0.035;
    d[o + 1] = pos.y + _n.y * 0.035;
    d[o + 2] = pos.z + _n.z * 0.035;
    d[o + 3] = this.time;
    d[o + 4] = rx; d[o + 5] = ry; d[o + 6] = rz; d[o + 7] = size;
    d[o + 8] = ux; d[o + 9] = uy; d[o + 10] = uz; d[o + 11] = life;
    d[o + 12] = color.r; d[o + 13] = color.g; d[o + 14] = color.b; d[o + 15] = alpha;
    d[o + 16] = tile; d[o + 17] = 0.02; d[o + 18] = 0.55; d[o + 19] = Math.random();
    this.decals.latestDeath = Math.max(this.decals.latestDeath, this.time + life);
  }

  /**
   * @param {object} o ring parameters
   * @param {THREE.Vector3} o.pos centre
   * @param {THREE.Vector3} o.normal facing
   * @param {number} o.r0 start radius
   * @param {number} o.r1 end radius
   * @param {number} o.thickness normalised band width (0..1)
   * @param {number} o.mode 0 ring, 1 dome, 2 hex shield, 3 energy disc, 4 scan
   */
  ring(o) {
    const target = o.distort && this.hasSceneColor ? this.distortRings : this.rings;
    const off = target.alloc();
    const d = target.data;
    const life = o.life ?? 0.3;
    d[off] = o.pos.x; d[off + 1] = o.pos.y; d[off + 2] = o.pos.z; d[off + 3] = this.time;
    const n = o.normal || _up;
    d[off + 4] = n.x; d[off + 5] = n.y; d[off + 6] = n.z; d[off + 7] = life;
    d[off + 8] = o.r0 ?? 0.1;
    d[off + 9] = o.r1 ?? 4;
    d[off + 10] = o.thickness ?? 0.12;
    d[off + 11] = o.mode ?? 0;
    const c = o.color || _white;
    d[off + 12] = c.r; d[off + 13] = c.g; d[off + 14] = c.b; d[off + 15] = o.alpha ?? 1;
    d[off + 16] = o.dome ?? 0;
    d[off + 17] = o.spin ?? 0;
    d[off + 18] = Math.random();
    d[off + 19] = o.growth ?? 2.4;
    target.latestDeath = Math.max(target.latestDeath, this.time + life);
  }

  /** Expanding wireframe sphere (lock-on scan, shield bubble). */
  shell(pos, r0, r1, life, color, alpha = 1, mode = 0) {
    const o = this.shells.alloc();
    const d = this.shells.data;
    d[o] = pos.x; d[o + 1] = pos.y; d[o + 2] = pos.z; d[o + 3] = this.time;
    d[o + 4] = r0; d[o + 5] = r1; d[o + 6] = life; d[o + 7] = mode;
    d[o + 8] = color.r; d[o + 9] = color.g; d[o + 10] = color.b; d[o + 11] = alpha;
    this.shells.latestDeath = Math.max(this.shells.latestDeath, this.time + life);
  }

  // -- pipeline hooks -------------------------------------------------------

  /**
   * Enable soft particles. Safe to never call — everything degrades to hard
   * intersections. Safe to call repeatedly with a changing texture.
   */
  setDepthTexture(tex, near, far, softness = 0.55) {
    if (!tex) {
      this.depthUniform.value = this._dummyDepth;
      this.softUniform.value.set(0, 0.35, 6000, softness);
      return;
    }
    this.depthUniform.value = tex;
    this.softUniform.value.set(1, near ?? 0.35, far ?? 6000, softness);
  }

  /** Optional: enables true refractive shockwave distortion. */
  setSceneColorTexture(tex) {
    if (!tex) {
      this.sceneColorUniform.value = this._dummyScene;
      this.hasSceneColor = false;
      this.distortRings.mesh.visible = false;
      return;
    }
    this.sceneColorUniform.value = tex;
    this.hasSceneColor = true;
    this.distortRings.mesh.visible = true;
  }

  setQuality(scale) {
    this.quality = clamp(scale, 0.15, 2);
  }

  // -- frame ----------------------------------------------------------------

  update(dt, elapsed) {
    this.time = elapsed;
    this.timeUniform.value = elapsed;

    // Retire live-count buckets that have elapsed.
    this._bucketAccum += dt;
    while (this._bucketAccum >= LIVE_BUCKET_S) {
      this._bucketAccum -= LIVE_BUCKET_S;
      this._bucketCursor = (this._bucketCursor + 1) % LIVE_BUCKETS;
      this.live -= this._buckets[this._bucketCursor];
      this._buckets[this._bucketCursor] = 0;
      if (this.live < 0) this.live = 0;
    }

    this.batches[0].update(elapsed);
    this.batches[1].update(elapsed);
    this.decals.update(elapsed);
    this.rings.update(elapsed);
    this.distortRings.update(elapsed);
    this.shells.update(elapsed);
    this.lights.update(elapsed);
    this.trailAdd.flush();
    this.trailAlpha.flush();
  }

  /** Upload the compacted plume instance list. Called by VFX each frame. */
  setFlameInstances(count) {
    this._flameGeo.instanceCount = Math.min(count, this.flameCapacity);
    this.flameBuffer.needsUpdate = true;
    const on = count > 0;
    for (const m of this._flameLayers) m.visible = on;
  }

  reset() {
    this.batches[0].clear();
    this.batches[1].clear();
    this.decals.clear();
    this.rings.clear();
    this.distortRings.clear();
    this.shells.clear();
    this.lights.reset();
    this._buckets.fill(0);
    this.live = 0;
    for (const b of [this.trailAdd, this.trailAlpha]) {
      for (const r of b.ribbons) if (!r.dead) b.release(r);
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.batches[0].dispose();
    this.batches[1].dispose();
    this.trailAdd.dispose();
    this.trailAlpha.dispose();
    this.decals.dispose();
    this.rings.dispose();
    this.distortRings.dispose();
    this.shells.dispose();
    this._flameGeo.dispose();
    this._plumeGeo.dispose();
    this._discGeo.dispose();
    this._shellGeo.dispose();
    for (const m of this._flameLayers) m.material.dispose();
    this.lights.dispose(this.scene);
    this.atlas.dispose();
    this.trailSmokeTex.dispose();
    this.trailHotTex.dispose();
    this._dummyDepth.dispose();
    this._dummyScene.dispose();
  }
}
