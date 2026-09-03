#!/usr/bin/env node
/**
 * SKY_FRAG, re-implemented in JS, evaluated over a review pose's frustum.
 *
 *   node tools/skysim.mjs --pose vista --out /tmp/sky.png
 *   node tools/skysim.mjs --pose vista --term cloud --out /tmp/cloud.png
 *   node tools/skysim.mjs --pose vista --set bandStrength=1.6 --out /tmp/b.png
 *   node tools/skysim.mjs --pose vista --compare shots/iter36/vista.png \
 *                         --rect sky:1150,120,600,200
 *
 * WHY THIS EXISTS. Every sky question so far has cost a full Chromium capture
 * (60-100 s on this box, and the container has been killed by memory pressure
 * from running two at once). The sky is a closed-form function of the view ray
 * and ~20 uniforms: it can be evaluated on the CPU in a second, which turns
 * "does raising the cloud fade kill those streaks" from an eight-minute
 * round trip into an eight-second one. Same argument as tools/grade-model.mjs
 * makes for the transfer curve, one layer up.
 *
 * SCOPE AND ITS HONEST LIMITS.
 *   - The uniforms are PARSED from src/render/Sky.js at import time, so the
 *     palette and the densities cannot silently drift from the shipped values.
 *   - The shader body is TRANSCRIBED from src/render/shaders/sky.js by hand.
 *     It can drift. `--compare` exists to catch that: it prints the sim against
 *     a real capture over the same rectangles, and a few code values of
 *     agreement is the licence to trust a prediction.
 *   - The NOISE PHASE WILL NOT MATCH the GPU. hash13 is fract() of a product,
 *     so a 1-ulp difference between float32-with-FMA and JS doubles moves an
 *     individual wisp. Everything statistical — orientation, spatial frequency,
 *     contrast, footprint — does match, and that is what sky tuning is about.
 *     Do not read this tool for "is that specific streak at x=180".
 *   - Bloom, TAA, CA, grain and the vignette are not modelled (bloom lifts the
 *     sky by ~1-2 codes near the sun; the vignette pulls the corners down).
 *     `--compare` reports the residual so you know which way it leans.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readPng } from './png.mjs';
import { writePng } from './crop.mjs';
import { grade, shippedParams } from './grade-model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKY_JS = readFileSync(resolve(ROOT, 'src/render/Sky.js'), 'utf8');

/* --- shipped uniforms, read from Sky.js ---------------------------------- */
function num(name) {
  const m = SKY_JS.match(new RegExp(`\\n\\s*${name}:\\s*(-?[\\d.]+)`));
  if (!m) throw new Error(`skysim: could not read params.${name} from Sky.js`);
  return parseFloat(m[1]);
}
function col(name) {
  const re = new RegExp(`${name}:\\s*new THREE\\.Color\\(\\s*(-?[\\d.]+)\\s*,\\s*(-?[\\d.]+)\\s*,\\s*(-?[\\d.]+)\\s*\\)`);
  const m = SKY_JS.match(re);
  if (!m) throw new Error(`skysim: could not read colors.${name} from Sky.js`);
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

export function skyUniforms() {
  const elDeg = parseFloat(SKY_JS.match(/sunElevation:\s*([\d.]+)\s*\*/)[1]);
  return {
    sunElevation: elDeg * Math.PI / 180,
    sunAzimuth: num('sunAzimuth'),
    hazeFalloff: num('hazeFalloff'),
    mieStrength: num('mieStrength'),
    mieG: num('mieG'),
    rayleigh: num('rayleigh'),
    sunIntensity: num('sunIntensity'),
    sunAngular: num('sunAngular'),
    cloudCover: num('cloudCover'),
    cloudOpacity: num('cloudOpacity'),
    cloudScale: num('cloudScale'),
    bandStrength: num('bandStrength'),
    dither: 0,                       // deterministic output; dither is noise
    zenith: col('zenith'),
    horizon: col('horizon'),
    ground: col('ground'),
    sunTint: col('sunTint'),
    sunDisc: col('sunDisc'),
    cloudDark: col('cloudDark'),
    cloudLit: col('cloudLit'),
    // shader constants that are literals in sky.js, exposed so they can be swept
    cloudFadeLo: 0.03,
    cloudFadeHi: 0.40,
    bandSquash: 26.0,
    bandFalloff: 7.5,
    bandLo: 0.40,
    bandHi: 0.74,
    // upper stratum deck — see the band block in skyRadiance
    bandHiAmp: 0.0,
    bandHiFall: 2.2,
    bandHiIn0: 0.02,
    bandHiIn1: 0.14,
    bandHiOut0: 0.30,
    bandHiOut1: 0.62,
    bandHiLo: 0.36,
    bandHiHi: 0.66,
    // how much of the sun-side extinction veil survives away from the sun
    veilFloor: 0.0,
  };
}

/* --- GLSL primitives ------------------------------------------------------ */
const fr = Math.fround;
const fract = (x) => x - Math.floor(x);
const mix = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function hash13(px, py, pz) {
  let x = fr(fract(fr(px * 0.1031)));
  let y = fr(fract(fr(py * 0.1031)));
  let z = fr(fract(fr(pz * 0.1031)));
  const d = fr(x * fr(z + 31.32) + y * fr(y + 31.32) + z * fr(x + 31.32));
  x = fr(x + d); y = fr(y + d); z = fr(z + d);
  return fr(fract(fr(fr(x + y) * z)));
}

function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const n000 = hash13(ix, iy, iz);
  const n100 = hash13(ix + 1, iy, iz);
  const n010 = hash13(ix, iy + 1, iz);
  const n110 = hash13(ix + 1, iy + 1, iz);
  const n001 = hash13(ix, iy, iz + 1);
  const n101 = hash13(ix + 1, iy, iz + 1);
  const n011 = hash13(ix, iy + 1, iz + 1);
  const n111 = hash13(ix + 1, iy + 1, iz + 1);
  return mix(
    mix(mix(n000, n100, fx), mix(n010, n110, fx), fy),
    mix(mix(n001, n101, fx), mix(n011, n111, fx), fy),
    fz);
}

// NOISE_ROT is column-major in GLSL: columns (0,.8,.6) (-.8,.36,-.48) (-.6,-.48,.64)
function rot(p, s) {
  const x = (0.00 * p[0] - 0.80 * p[1] - 0.60 * p[2]) * s;
  const y = (0.80 * p[0] + 0.36 * p[1] - 0.48 * p[2]) * s;
  const z = (0.60 * p[0] - 0.48 * p[1] + 0.64 * p[2]) * s;
  return [x, y, z];
}
function fbm3_2(p) {
  let f = 0.5 * vnoise3(p[0], p[1], p[2]);
  p = rot(p, 2.02);
  f += 0.25 * vnoise3(p[0], p[1], p[2]);
  return f / 0.75;
}
function fbm3_3(p) {
  let f = 0.5 * vnoise3(p[0], p[1], p[2]);
  p = rot(p, 2.02);
  f += 0.25 * vnoise3(p[0], p[1], p[2]);
  p = rot(p, 2.03);
  f += 0.125 * vnoise3(p[0], p[1], p[2]);
  return f / 0.875;
}
function fbm3_5(p) {
  let f = 0.5 * vnoise3(p[0], p[1], p[2]);
  p = rot(p, 2.02);
  f += 0.25 * vnoise3(p[0], p[1], p[2]);
  p = rot(p, 2.03);
  f += 0.125 * vnoise3(p[0], p[1], p[2]);
  p = rot(p, 2.01);
  f += 0.0625 * vnoise3(p[0], p[1], p[2]);
  p = rot(p, 2.04);
  f += 0.03125 * vnoise3(p[0], p[1], p[2]);
  return f / 0.96875;
}

/* --- SKY_FRAG ------------------------------------------------------------- */
/**
 * @param {number[]} V normalised view ray, world space
 * @param {object} u uniforms (see skyUniforms)
 * @param {number} t uTime
 * @returns {{ rgb:number[], cl:number, band:number, veil:number }}
 */
export function skyRadiance(V, u, t) {
  const S = u.sunDir;
  const up = V[1];
  const mu = V[0] * S[0] + V[1] * S[1] + V[2] * S[2];
  const sunUp = smoothstep(-0.12, 0.10, S[1]);

  const hz = Math.exp(-Math.max(up, 0) * u.hazeFalloff);
  const sky = [
    mix(u.zenith[0], u.horizon[0], hz),
    mix(u.zenith[1], u.horizon[1], hz),
    mix(u.zenith[2], u.horizon[2], hz),
  ];

  const phaseR = 0.75 * (1 + mu * mu);
  for (let i = 0; i < 3; i++) sky[i] += u.zenith[i] * u.rayleigh * phaseR * (1 - hz);

  const g = u.mieG, g2 = g * g;
  const denom = Math.max(1 + g2 - 2 * g * mu, 1e-4);
  const phaseM = (1 - g2) / (4 * Math.PI * denom * Math.sqrt(denom));
  for (let i = 0; i < 3; i++) sky[i] += u.sunTint[i] * phaseM * u.mieStrength * (0.22 + 1.15 * hz) * sunUp;

  const wash = Math.pow(Math.max(mu, 0), 7.0) * 0.31 * sunUp;
  for (let i = 0; i < 3; i++) sky[i] += u.sunTint[i] * wash;

  // the 16:1 stratum field, needed by BOTH the band deck and the sun veil
  const hp = [V[0] * 3.0, V[1] * 16.0, V[2] * 3.0];
  hp[1] -= t * 0.011;
  hp[2] += t * 0.008;
  const hn = fbm3_3(hp);

  // stratified dust bands
  const bp = [V[0] * 3.2, V[1] * u.bandSquash, V[2] * 3.2];
  bp[1] -= t * 0.018;
  bp[0] += t * 0.010;
  const bn = fbm3_3(bp);
  const strat = smoothstep(u.bandLo, u.bandHi, bn);
  // Two altitude profiles on ONE stratum field. The 26:1 squash is the scale
  // that reads as layering at a hero framing's elevations (~50 px bands); the
  // 16:1 field the sun veil uses is 120-200 px up there, which is a gradient,
  // not a layer. So the upper deck is a REACH change, not a second field.
  const low = Math.exp(-Math.max(up, 0) * u.bandFalloff);
  const high = u.bandHiAmp
    * Math.exp(-Math.max(up, 0) * u.bandHiFall)
    * smoothstep(u.bandHiIn0, u.bandHiIn1, up)
    * (1 - smoothstep(u.bandHiOut0, u.bandHiOut1, up));
  const bandMask = strat * (low + high) * smoothstep(-0.14, 0.01, up);
  const sunw = Math.pow(Math.max(mu, 0), 3.0) * sunUp;
  const bandCol = [
    mix(u.horizon[0] * 1.22, u.sunTint[0] * 1.7, sunw),
    mix(u.horizon[1] * 1.22, u.sunTint[1] * 1.7, sunw),
    mix(u.horizon[2] * 1.22, u.sunTint[2] * 1.7, sunw),
  ];
  const bandF = Math.min(0.9, Math.max(0, bandMask * u.bandStrength));
  for (let i = 0; i < 3; i++) sky[i] = mix(sky[i], bandCol[i], bandF);

  // high dust silhouetted across the sun's glow (same field as `high` above)
  const hstrat = smoothstep(0.36, 0.66, hn);
  const sunSide = u.veilFloor + (1 - u.veilFloor) * Math.pow(Math.max(mu, 0), 1.4);
  const sunCore = Math.pow(Math.max(mu, 0), 70.0);
  let veil = hstrat * sunSide * (1 - sunCore)
    * Math.exp(-Math.max(up, 0) * 0.8)
    * smoothstep(0.04, 0.16, up) * sunUp;
  veil = Math.min(0.85, Math.max(0, veil));
  for (let i = 0; i < 3; i++) sky[i] = sky[i] * (1 - 0.90 * veil) + bandCol[i] * 0.20 * veil;

  // cloud deck
  const inv = 1 / (Math.max(up, 0) * 0.85 + 0.22);
  let cp = [V[0] * inv, V[1] * inv, V[2] * inv];
  cp[0] *= u.cloudScale; cp[2] *= u.cloudScale;
  cp[0] += t * 0.012;
  cp[2] += t * 0.007;
  const warp = fbm3_2([cp[0] * 0.55, cp[1] * 0.55, cp[2] * 0.55]) - 0.5;
  cp = [cp[0] + warp * 1.4, cp[1] + warp * 1.4, cp[2] + warp * 1.4];
  const cn = fbm3_5(cp);
  const cover = Math.min(1, Math.max(0, u.cloudCover));
  let cl = smoothstep(1 - cover - 0.16, 1 - cover + 0.18, cn);
  cl *= smoothstep(u.cloudFadeLo, u.cloudFadeHi, up);
  cl *= u.cloudOpacity;
  const lit = smoothstep(0.34, 0.92, cn);
  const cloudCol = [0, 0, 0];
  const sunw4 = Math.pow(Math.max(mu, 0), 4.0) * 0.55 * sunUp;
  for (let i = 0; i < 3; i++) {
    cloudCol[i] = mix(u.cloudDark[i], u.cloudLit[i], lit);
    cloudCol[i] = mix(cloudCol[i], u.sunTint[i] * 1.5, sunw4);
  }
  const clc = Math.min(1, Math.max(0, cl));
  for (let i = 0; i < 3; i++) sky[i] = mix(sky[i], cloudCol[i], clc);
  const silver = Math.pow(Math.max(mu, 0), 16.0) * cl * (1 - cl) * 3.0 * sunUp;
  for (let i = 0; i < 3; i++) sky[i] += u.sunTint[i] * silver;

  // sun disc
  const ang = Math.sqrt(Math.max(2 - 2 * mu, 0));
  const r = ang / Math.max(u.sunAngular, 1e-4);
  const disc = 1 - smoothstep(0.90, 1.02, r);
  const limb = Math.pow(Math.max(1 - r * r * 0.92, 0), 0.45);
  for (let i = 0; i < 3; i++) {
    sky[i] += u.sunDisc[i] * disc * limb * u.sunIntensity * sunUp * (1 - clc * 0.85);
  }

  // below horizon
  const bl = 1 - smoothstep(-0.10, 0.0, up);
  for (let i = 0; i < 3; i++) sky[i] = mix(sky[i], u.ground[i], bl);

  return { rgb: sky.map((c) => Math.max(0, c)), cl: clc, band: bandF, veil };
}

/* --- camera --------------------------------------------------------------- */
export const POSES = {
  // mirrors tools/poses/vista.js
  vista: { eye: [-150, 78, 210], look: [40, 55, -60], fov: 52 },
  // mirrors tools/poses/sky.js framing intent (pitched up 34 deg)
  sky: { eye: [-150, 78, 210], look: [40, 78 + 0.674 * 330, -60], fov: 52 },
};

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function makeRayFn(pose, W, H) {
  const fwd = norm([pose.look[0] - pose.eye[0], pose.look[1] - pose.eye[1], pose.look[2] - pose.eye[2]]);
  const right = norm(cross(fwd, [0, 1, 0]));
  const camUp = cross(right, fwd);
  const tanV = Math.tan(pose.fov * Math.PI / 360);
  const tanH = tanV * (W / H);
  return (x, y) => {
    const ndcX = ((x + 0.5) / W) * 2 - 1;
    const ndcY = 1 - ((y + 0.5) / H) * 2;
    const sr = ndcX * tanH, su = ndcY * tanV;
    return norm([
      fwd[0] + right[0] * sr + camUp[0] * su,
      fwd[1] + right[1] * sr + camUp[1] * su,
      fwd[2] + right[2] * sr + camUp[2] * su,
    ]);
  };
}

/* --- cli ------------------------------------------------------------------ */
function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const all = (n) => argv.map((a, i) => (a === `--${n}` ? argv[i + 1] : null)).filter(Boolean);
  const has = (n) => argv.includes(`--${n}`);

  const u = skyUniforms();
  for (const s of all('set')) {
    const [k, v] = s.split('=');
    if (!(k in u)) throw new Error(`skysim: unknown uniform '${k}'`);
    u[k] = Number(v);
  }
  const ce = Math.cos(u.sunElevation);
  u.sunDir = norm([ce * Math.cos(u.sunAzimuth), Math.sin(u.sunElevation), ce * Math.sin(u.sunAzimuth)]);

  const poseName = flag('pose', 'vista');
  const pose = POSES[poseName];
  if (!pose) throw new Error(`skysim: no pose '${poseName}'`);
  const W = Number(flag('width', 1920)), H = Number(flag('height', 1080));
  const t = Number(flag('time', 6));
  const term = flag('term', 'rgb');
  const ray = makeRayFn(pose, W, H);
  const gp = shippedParams();
  // The vignette is a screen-position multiply on the graded value, so unlike
  // bloom it CAN be modelled here — and it has to be, or the sim reads 15 codes
  // high at the frame edges and every comparison against a capture is wrong.
  const PIPE = readFileSync(resolve(ROOT, 'src/render/Pipeline.js'), 'utf8');
  const vg = PIPE.match(/vignette:\s*\{\s*amount:\s*([\d.]+),\s*smoothness:\s*([\d.]+)/);
  const vAmount = vg ? parseFloat(vg[1]) : 0;
  const vSmooth = vg ? parseFloat(vg[2]) : 0.5;
  const noVig = has('novignette');

  const rgb = new Uint8Array(W * H * 3);
  const lumaOf = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const V = ray(x, y);
      const s = skyRadiance(V, u, t);
      let c;
      if (term === 'cloud') { const v = Math.round(s.cl * 255 / Math.max(u.cloudOpacity, 1e-3)); c = [v, v, v]; }
      else if (term === 'band') { const v = Math.round(s.band * 255 / 0.9); c = [v, v, v]; }
      else if (term === 'veil') { const v = Math.round(s.veil * 255 / 0.85); c = [v, v, v]; }
      else {
        const d = grade(s.rgb, gp).disp;
        let vig = 1;
        if (!noVig) {
          const ux = (x + 0.5) / W - 0.5, uy = (y + 0.5) / H - 0.5;
          const rEdge = Math.min(1, Math.hypot(ux, uy) * 1.41421356);
          vig = 1 - vAmount * smoothstep(Math.min(0.98, Math.max(0, vSmooth)), 1, rEdge);
        }
        c = d.map((v) => Math.round(Math.min(1, Math.max(0, v * vig)) * 255));
      }
      const o = (y * W + x) * 3;
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
      lumaOf[y * W + x] = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
  }

  // Rects are given in FULL-FRAME (1920x1080) coordinates whatever --width is,
  // so the same command can compare a half-res sim against a full-res capture.
  const rects = all('rect').map((r) => {
    const [name, spec] = r.includes(':') ? r.split(':') : ['rect', r];
    const [rx, ry, rw, rh] = spec.split(',').map(Number);
    return { name, rx, ry, rw, rh };
  });
  const scaled = (r, w) => {
    const k = w / 1920;
    return { name: r.name, rx: Math.round(r.rx * k), ry: Math.round(r.ry * k),
      rw: Math.max(1, Math.round(r.rw * k)), rh: Math.max(1, Math.round(r.rh * k)) };
  };
  const statsOf = (arr, W, r) => {
    let s = 0, s2 = 0, n = 0, mn = 1e9, mx = -1e9;
    for (let y = r.ry; y < r.ry + r.rh; y++) for (let x = r.rx; x < r.rx + r.rw; x++) {
      const v = arr[y * W + x];
      s += v; s2 += v * v; n++; mn = Math.min(mn, v); mx = Math.max(mx, v);
    }
    const m = s / n;
    return { mean: m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)), min: mn, max: mx };
  };

  for (const r of rects) {
    const st = statsOf(lumaOf, W, scaled(r, W));
    console.log(`sim   ${r.name.padEnd(10)} mean ${st.mean.toFixed(1)}  sd ${st.sd.toFixed(2)}  range ${st.min.toFixed(0)}..${st.max.toFixed(0)}`);
  }

  const cmp = flag('compare', null);
  if (cmp) {
    const img = readPng(resolve(ROOT, cmp));
    const L = new Float64Array(img.width * img.height);
    for (let i = 0; i < L.length; i++) {
      L[i] = 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2];
    }
    for (const r of rects) {
      const st = statsOf(L, img.width, scaled(r, img.width));
      console.log(`shot  ${r.name.padEnd(10)} mean ${st.mean.toFixed(1)}  sd ${st.sd.toFixed(2)}  range ${st.min.toFixed(0)}..${st.max.toFixed(0)}`);
    }
  }

  const out = flag('out', null);
  if (out) { writePng(out, W, H, rgb); console.log(`wrote ${out} ${W}x${H} term=${term} t=${t}`); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
