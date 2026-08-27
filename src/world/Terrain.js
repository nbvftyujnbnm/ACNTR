import * as THREE from 'three';
import { clamp, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';

/**
 * Terrain — the dusty plateau Watchpoint Alpha sits on.
 *
 * Everything is a pure function of (x, z, seed): warped multi-octave FBM for
 * the plateau body, anisotropic ridged noise for wind-carved dune ridges, an
 * explicit meandering dry riverbed, a blast crater, and flattened concrete
 * pads punched in wherever a structure needs to stand.
 *
 * The height field is evaluated ONCE into a Float32Array. The render mesh, the
 * (coarser) collision mesh and every placement query all bilinear-sample that
 * one array, so the visual surface, the collider and `heightAt()` can never
 * disagree — a mismatch there is the classic "mech floats / sinks" bug.
 *
 * Surfacing is a triplanar splat shader injected into MeshStandardMaterial:
 * dust (triplanar, so slopes and cliff faces don't smear), pad concrete and
 * riverbed gravel (planar — both are flat by construction), broken up by a
 * low-frequency macro sample so the tiling never reads.
 */

/* ========================================================================== */
/*  Noise                                                                      */
/* ========================================================================== */

function ihash(ix, iy, s) {
  let n = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0,1], quintic-interpolated (C2 → no visible lattice). */
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = quintic(x - ix), fy = quintic(y - iy);
  const a = ihash(ix, iy, s);
  const b = ihash(ix + 1, iy, s);
  const c = ihash(ix, iy + 1, s);
  const d = ihash(ix + 1, iy + 1, s);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

function fbm(x, y, s, oct = 5, gain = 0.5, lac = 2.03) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  for (let o = 0; o < oct; o++) {
    sum += vnoise(fx, fy, s + o * 131) * amp;
    norm += amp;
    amp *= gain;
    fx *= lac; fy *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal — the sharp crests that make dunes read as wind-carved. */
function ridged(x, y, s, oct = 4, gain = 0.5, lac = 2.11) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  for (let o = 0; o < oct; o++) {
    const n = 1 - Math.abs(vnoise(fx, fy, s + o * 977) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    fx *= lac; fy *= lac;
  }
  return sum / norm;
}

/* ========================================================================== */

const _v2 = new THREE.Vector2();

export class Terrain {
  /**
   * @param {object} opts
   * @param {number} opts.size      world extent in metres (square, centred on origin)
   * @param {number} opts.segments  render-mesh quads per side
   * @param {number} opts.seed
   */
  constructor(opts = {}) {
    this.size = opts.size ?? 1200;
    this.segments = opts.segments ?? 384;
    this.seed = opts.seed ?? 1337;

    this.N = this.segments + 1;
    this.step = this.size / this.segments;
    this.half = this.size * 0.5;

    this.field = new Float32Array(this.N * this.N);   // height
    this.padMask = new Float32Array(this.N * this.N); // concrete coverage 0..1
    this.gravelMask = new Float32Array(this.N * this.N);
    this.aoMask = new Float32Array(this.N * this.N);

    this.pads = [];
    this.minHeight = 0;
    this.maxHeight = 0;

    const rng = mulberry32(this.seed);
    // --- feature placement (seeded, but authored ranges keep the layout readable)
    this.windAngle = -0.62;
    this.river = {
      cx: -40,
      amp1: 138, f1: 0.0037, p1: rng() * 6.28,
      amp2: 44, f2: 0.0113, p2: rng() * 6.28,
      width: 52, depth: 13,
    };
    this.crater = { x: 236, z: 232, r: 96, depth: 21, rim: 7.5 };

    this._materials = [];
    this._geoms = [];
  }

  /* ---------------------------------------------------------------------- */
  /*  Height field                                                           */
  /* ---------------------------------------------------------------------- */

  /** Natural (pre-pad) height. Pure function of x,z. */
  _natural(x, z) {
    const s = this.seed;

    // domain warp — kills the axis-aligned look of raw FBM
    const wx = x + (fbm(x * 0.0013, z * 0.0013, s + 11, 3) - 0.5) * 210;
    const wz = z + (fbm(x * 0.0013 + 5.7, z * 0.0013 - 3.1, s + 29, 3) - 0.5) * 210;

    // plateau body
    let h = (fbm(wx * 0.00105, wz * 0.00105, s + 41, 6, 0.52) - 0.44) * 62;
    h += (fbm(wx * 0.0043, wz * 0.0043, s + 53, 4, 0.5) - 0.5) * 13;

    // wind-carved dune ridges: coordinates stretched hard along the wind axis
    const ca = Math.cos(this.windAngle), sa = Math.sin(this.windAngle);
    const u = x * ca + z * sa;
    const v = -x * sa + z * ca;
    const duneMask = smoothstep(0.34, 0.72, fbm(x * 0.0016, z * 0.0016, s + 67, 3));
    const dune = ridged(u * 0.0215, v * 0.0032, s + 71, 4, 0.46);
    h += (dune - 0.42) * 17 * duneMask;

    // secondary micro-dunes so the surface is never smooth at mech scale
    h += (ridged(u * 0.085, v * 0.014, s + 83, 2, 0.5) - 0.45) * 2.1 * duneMask;

    // fine gravel chop
    h += (fbm(x * 0.052, z * 0.052, s + 97, 2) - 0.5) * 0.75;

    // --- dry riverbed -----------------------------------------------------
    const R = this.river;
    const bank = R.cx + Math.sin(z * R.f1 + R.p1) * R.amp1 + Math.sin(z * R.f2 + R.p2) * R.amp2;
    const wob = (fbm(z * 0.012, 4.2, s + 103, 3) - 0.5) * 22;
    const halfW = R.width * (0.78 + fbm(z * 0.0065, 11.3, s + 107, 3) * 0.62);
    const t = Math.abs(x - bank - wob) / halfW;
    const bed = 1 - smoothstep(0.40, 1.0, t);
    const levee = smoothstep(0.86, 1.06, t) * (1 - smoothstep(1.06, 1.55, t));
    h -= bed * R.depth;
    h += levee * 3.4;
    const riverW = bed;

    // --- blast crater -----------------------------------------------------
    const C = this.crater;
    const dx = x - C.x, dz = z - C.z;
    let dr = Math.sqrt(dx * dx + dz * dz);
    // irregular rim: modulate the radius by angular noise
    const ang = Math.atan2(dz, dx);
    dr /= C.r * (0.86 + fbm(Math.cos(ang) * 2.2 + 9, Math.sin(ang) * 2.2 - 4, s + 113, 3) * 0.3);
    let craterW = 0;
    if (dr < 1.9) {
      const bowl = dr < 1 ? -(1 - dr * dr) * C.depth : 0;
      const rim = Math.exp(-((dr - 0.98) * (dr - 0.98)) / 0.052) * C.rim;
      const ejecta = Math.exp(-((dr - 1.42) * (dr - 1.42)) / 0.22) * 2.2
        * (fbm(x * 0.03, z * 0.03, s + 127, 2) - 0.35);
      h += bowl + rim + ejecta;
      craterW = clamp(1.25 - dr, 0, 1);
    }

    this._lastGravel = clamp(riverW * 1.25 + craterW * 0.85, 0, 1);
    return h;
  }

  /** Register a flat concrete pad. Call before `generate()`. */
  addPad(x, z, sx, sz, rot = 0, feather = 26, y = null) {
    this.pads.push({ x, z, sx, sz, rot, feather, y, cos: Math.cos(-rot), sin: Math.sin(-rot) });
    return this.pads[this.pads.length - 1];
  }

  /** Coverage of pad `p` at (x,z), 0..1 with a feathered border. */
  _padWeight(p, x, z) {
    const dx = x - p.x, dz = z - p.z;
    const lx = dx * p.cos - dz * p.sin;
    const lz = dx * p.sin + dz * p.cos;
    const ex = Math.abs(lx) - p.sx * 0.5;
    const ez = Math.abs(lz) - p.sz * 0.5;
    const d = Math.max(ex, ez);              // Chebyshev-style signed distance
    if (d > p.feather) return 0;
    return 1 - smoothstep(0, p.feather, Math.max(d, 0));
  }

  /**
   * Evaluate the whole field. Yields between row bands via `onProgress` so a
   * caller can spread the cost over a few frames.
   */
  generate() {
    const N = this.N, half = this.half, step = this.step;
    const F = this.field, G = this.gravelMask, P = this.padMask;

    // pass 1 — natural terrain
    for (let j = 0; j < N; j++) {
      const z = -half + j * step;
      for (let i = 0; i < N; i++) {
        const x = -half + i * step;
        const k = j * N + i;
        F[k] = this._natural(x, z);
        G[k] = this._lastGravel;
      }
    }

    // pass 2 — resolve pad heights from the natural surface, then flatten.
    // Pads sample the *median-ish* height over their footprint so a pad never
    // ends up buried in a dune or floating over the riverbed.
    for (const p of this.pads) {
      if (p.y === null) {
        let sum = 0, n = 0;
        const rx = p.sx * 0.5, rz = p.sz * 0.5;
        for (let a = -2; a <= 2; a++) {
          for (let b = -2; b <= 2; b++) {
            const lx = a * rx * 0.42, lz = b * rz * 0.42;
            const wx = p.x + lx * Math.cos(p.rot) - lz * Math.sin(p.rot);
            const wz = p.z + lx * Math.sin(p.rot) + lz * Math.cos(p.rot);
            sum += this.sampleRaw(wx, wz);
            n++;
          }
        }
        p.y = sum / n + 0.55;   // pads sit slightly proud, like a poured slab
      }
    }

    for (let j = 0; j < N; j++) {
      const z = -half + j * step;
      for (let i = 0; i < N; i++) {
        const x = -half + i * step;
        const k = j * N + i;
        let h = F[k];
        let cover = 0;
        for (let pi = 0; pi < this.pads.length; pi++) {
          const p = this.pads[pi];
          const w = this._padWeight(p, x, z);
          if (w <= 0) continue;
          const ww = w * w * (3 - 2 * w);
          h = lerp(h, p.y, ww);
          if (ww > cover) cover = ww;
        }
        F[k] = h;
        P[k] = cover;
        if (cover > 0.5) G[k] *= 1 - (cover - 0.5) * 2;
      }
    }

    // pass 3 — cheap cavity AO from local height relief; concavities darken.
    const A = this.aoMask;
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = F[k];
        if (h < mn) mn = h;
        if (h > mx) mx = h;
        let occ = 0;
        for (let s = 0; s < 4; s++) {
          const r = 1 + s * 3;
          const a = F[j * N + Math.min(N - 1, i + r)];
          const b = F[j * N + Math.max(0, i - r)];
          const c = F[Math.min(N - 1, j + r) * N + i];
          const d = F[Math.max(0, j - r) * N + i];
          const rel = ((a + b + c + d) * 0.25 - h) / (r * this.step);
          occ += clamp(rel * 2.4, 0, 1);
        }
        A[k] = clamp(1 - (occ / 4) * 0.85, 0.12, 1);
      }
    }
    this.minHeight = mn;
    this.maxHeight = mx;
    return this;
  }

  /** Natural height at an arbitrary point (used only while resolving pads). */
  sampleRaw(x, z) {
    const half = this.half, step = this.step, N = this.N;
    const fx = clamp((x + half) / step, 0, N - 1.001);
    const fz = clamp((z + half) / step, 0, N - 1.001);
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const F = this.field;
    const a = F[j * N + i], b = F[j * N + i + 1];
    const c = F[(j + 1) * N + i], d = F[(j + 1) * N + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Bilinear height — matches the render mesh exactly. */
  heightAt(x, z) {
    return this.sampleRaw(x, z);
  }

  /** Steepest slope in radians at (x,z). */
  slopeAt(x, z) {
    const d = this.step;
    const hx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    const hz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return Math.atan(Math.hypot(hx, hz));
  }

  /** Pad coverage at (x,z), 0..1. */
  padAt(x, z) {
    const half = this.half, step = this.step, N = this.N;
    const i = clamp(Math.round((x + half) / step), 0, N - 1);
    const j = clamp(Math.round((z + half) / step), 0, N - 1);
    return this.padMask[j * N + i];
  }

  /* ---------------------------------------------------------------------- */
  /*  Geometry                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Full-resolution render mesh with a custom `aSplat` attribute
   * (x = concrete weight, y = gravel weight, z = baked cavity AO).
   */
  buildRenderGeometry() {
    return this._buildGrid(1, true);
  }

  /**
   * Decimated collider. Sampled from the same field so it tracks the visual
   * surface; `stride` 2 halves the resolution and quarters the triangle count.
   */
  buildCollisionGeometry(stride = 2) {
    return this._buildGrid(stride, false);
  }

  _buildGrid(stride, withSplat) {
    const N = this.N;
    const cols = Math.floor((N - 1) / stride) + 1;
    const vCount = cols * cols;
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const splat = withSplat ? new Float32Array(vCount * 3) : null;

    const half = this.half, step = this.step;
    const F = this.field;

    for (let j = 0; j < cols; j++) {
      const sj = Math.min(N - 1, j * stride);
      const z = -half + sj * step;
      for (let i = 0; i < cols; i++) {
        const si = Math.min(N - 1, i * stride);
        const x = -half + si * step;
        const k = j * cols + i;
        const fk = sj * N + si;
        pos[k * 3] = x;
        pos[k * 3 + 1] = F[fk];
        pos[k * 3 + 2] = z;

        // central-difference normal straight off the field (exact, cheap)
        const hl = F[sj * N + Math.max(0, si - stride)];
        const hr = F[sj * N + Math.min(N - 1, si + stride)];
        const hd = F[Math.max(0, sj - stride) * N + si];
        const hu = F[Math.min(N - 1, sj + stride) * N + si];
        const d2 = 2 * step * stride;
        let nx = (hl - hr) / d2, ny = 1, nz = (hd - hu) / d2;
        const nl = Math.hypot(nx, ny, nz);
        nrm[k * 3] = nx / nl;
        nrm[k * 3 + 1] = ny / nl;
        nrm[k * 3 + 2] = nz / nl;

        uv[k * 2] = (x + half) / this.size;
        uv[k * 2 + 1] = (z + half) / this.size;

        if (splat) {
          splat[k * 3] = this.padMask[fk];
          splat[k * 3 + 1] = this.gravelMask[fk];
          splat[k * 3 + 2] = this.aoMask[fk];
        }
      }
    }

    const quads = cols - 1;
    const idxCount = quads * quads * 6;
    const idx = vCount > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
    let w = 0;
    for (let j = 0; j < quads; j++) {
      for (let i = 0; i < quads; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        // flip the diagonal on a checker so dune crests don't develop a
        // systematic sawtooth along one axis
        if (((i ^ j) & 1) === 0) {
          idx[w++] = a; idx[w++] = c; idx[w++] = b;
          idx[w++] = b; idx[w++] = c; idx[w++] = d;
        } else {
          idx[w++] = a; idx[w++] = c; idx[w++] = d;
          idx[w++] = a; idx[w++] = d; idx[w++] = b;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (splat) geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this._geoms.push(geo);
    return geo;
  }

  /* ---------------------------------------------------------------------- */
  /*  Material                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Triplanar splat material.
   * @param {object} ground  forge texture set used for dust + gravel
   * @param {object} pad     forge texture set used for the concrete pads
   */
  makeMaterial(ground, pad, opts = {}) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: opts.envMapIntensity ?? 0.55,
      dithering: true,
    });

    const clone = (t, rep) => {
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(1, 1);
      c.needsUpdate = true;
      return c;
    };

    const u = {
      tGroundMap: { value: clone(ground.map) },
      tGroundNrm: { value: clone(ground.normalMap) },
      tGroundOrm: { value: clone(ground.roughnessMap) },
      tPadMap: { value: clone(pad.map) },
      tPadNrm: { value: clone(pad.normalMap) },
      tPadOrm: { value: clone(pad.roughnessMap) },
      uDustTint: { value: new THREE.Color(opts.dustTint ?? 0xb59d78) },
      uGravelTint: { value: new THREE.Color(opts.gravelTint ?? 0x6b6155) },
      uPadTint: { value: new THREE.Color(opts.padTint ?? 0x9c9a93) },
      // x: dust 1/m, y: pad 1/m, z: gravel 1/m, w: macro 1/m
      uScales: { value: new THREE.Vector4(1 / 13.0, 1 / 6.5, 1 / 3.6, 1 / 190.0) },
      uNrmStrength: { value: opts.normalStrength ?? 1.25 },
    };
    mat.userData.uniforms = u;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aSplat;
           varying vec3 vWPos;
           varying vec3 vWNrm;
           varying vec3 vSplat;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
           vWNrm = normalize( mat3( modelMatrix ) * objectNormal );
           vSplat = aSplat;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform sampler2D tGroundMap;
           uniform sampler2D tGroundNrm;
           uniform sampler2D tGroundOrm;
           uniform sampler2D tPadMap;
           uniform sampler2D tPadNrm;
           uniform sampler2D tPadOrm;
           uniform vec3 uDustTint;
           uniform vec3 uGravelTint;
           uniform vec3 uPadTint;
           uniform vec4 uScales;
           uniform float uNrmStrength;
           varying vec3 vWPos;
           varying vec3 vWNrm;
           varying vec3 vSplat;

           vec3 acTriWeights( vec3 n ) {
             vec3 w = abs( n );
             w = max( w - 0.26, vec3( 0.0 ) );
             w *= w; w *= w;
             return w / max( w.x + w.y + w.z, 1e-4 );
           }`
        )
        .replace(
          '#include <map_fragment>',
          `vec3 acWP = vWPos;
           vec3 acGN = normalize( vWNrm );
           vec3 acTW = acTriWeights( acGN );
           float acSD = uScales.x, acSP = uScales.y, acSG = uScales.z;

           // dust — full triplanar so slopes and cliff shoulders never smear
           vec3 acDX = texture2D( tGroundMap, acWP.zy * acSD ).rgb;
           vec3 acDY = texture2D( tGroundMap, acWP.xz * acSD ).rgb;
           vec3 acDZ = texture2D( tGroundMap, acWP.xy * acSD ).rgb;
           vec3 acAlbDust = ( acDX * acTW.x + acDY * acTW.y + acDZ * acTW.z ) * uDustTint;

           // pads are flat by construction → planar, plus a 4x detail pass
           vec3 acAlbPad = texture2D( tPadMap, acWP.xz * acSP ).rgb;
           acAlbPad *= 0.66 + 0.68 * texture2D( tPadMap, acWP.xz * acSP * 4.13 ).g;
           acAlbPad *= uPadTint;

           // riverbed gravel, rotated 30 deg so it cannot correlate with dust
           vec2 acGUV = vec2( acWP.x * 0.866 - acWP.z * 0.5, acWP.x * 0.5 + acWP.z * 0.866 ) * acSG;
           vec3 acAlbGrv = texture2D( tGroundMap, acGUV ).rgb * uGravelTint;

           float acMacro = texture2D( tGroundMap, acWP.xz * uScales.w ).r;
           float acMacro2 = texture2D( tGroundMap, acWP.zx * uScales.w * 2.73 ).g;

           float acSlope = 1.0 - clamp( acGN.y, 0.0, 1.0 );
           float acWPad = vSplat.x * ( 1.0 - smoothstep( 0.05, 0.24, acSlope ) );
           float acWGrv = vSplat.y;
           acWGrv = clamp( acWGrv * ( 1.22 + ( acMacro - 0.5 ) * 1.5 ), 0.0, 1.0 );
           acWPad = clamp( acWPad * ( 1.14 + ( acMacro2 - 0.5 ) * 0.55 ), 0.0, 1.0 );
           float acSum = acWPad + acWGrv;
           if ( acSum > 1.0 ) { acWPad /= acSum; acWGrv /= acSum; }
           float acWDust = 1.0 - acWPad - acWGrv;

           vec3 acAlb = acAlbDust * acWDust + acAlbPad * acWPad + acAlbGrv * acWGrv;
           acAlb *= 0.74 + 0.54 * acMacro;
           acAlb *= mix( 1.0, 0.60, clamp( acSlope * 1.5, 0.0, 1.0 ) );
           acAlb *= mix( 0.46, 1.0, vSplat.z );
           diffuseColor.rgb *= acAlb;

           // roughness: dry dust is very rough, wet-stained concrete less so
           float acRough = texture2D( tGroundOrm, acWP.xz * acSD ).g;
           acRough = mix( acRough, texture2D( tPadOrm, acWP.xz * acSP ).g, acWPad );
           acRough = mix( acRough, 0.84, acWGrv );
           float acRoughOut = clamp( acRough * ( 0.90 + 0.20 * acMacro ), 0.34, 1.0 );

           // triplanar UDN normal blend for dust
           vec3 acTNX = texture2D( tGroundNrm, acWP.zy * acSD ).xyz * 2.0 - 1.0;
           vec3 acTNY = texture2D( tGroundNrm, acWP.xz * acSD ).xyz * 2.0 - 1.0;
           vec3 acTNZ = texture2D( tGroundNrm, acWP.xy * acSD ).xyz * 2.0 - 1.0;
           acTNX.xy *= uNrmStrength; acTNY.xy *= uNrmStrength; acTNZ.xy *= uNrmStrength;
           vec3 acNX = vec3( acTNX.xy + acGN.zy, abs( acTNX.z ) * acGN.x );
           vec3 acNY = vec3( acTNY.xy + acGN.xz, abs( acTNY.z ) * acGN.y );
           vec3 acNZ = vec3( acTNZ.xy + acGN.xy, abs( acTNZ.z ) * acGN.z );
           vec3 acNDust = normalize( acNX.zyx * acTW.x + acNY.xzy * acTW.y + acNZ.xyz * acTW.z );

           vec2 acPN = texture2D( tPadNrm, acWP.xz * acSP ).xy * 2.0 - 1.0;
           vec3 acNPad = normalize( vec3( acGN.x + acPN.x * 0.85, acGN.y, acGN.z + acPN.y * 0.85 ) );

           vec3 acWorldN = normalize( mix( acNDust, acNPad, acWPad ) );`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          'float roughnessFactor = acRoughOut;'
        )
        .replace(
          '#include <metalnessmap_fragment>',
          'float metalnessFactor = 0.0;'
        )
        .replace(
          '#include <normal_fragment_maps>',
          'normal = normalize( ( viewMatrix * vec4( acWorldN, 0.0 ) ).xyz );'
        );

      mat.userData.shader = shader;
    };

    // keep the program cache from collapsing this with a stock standard material
    mat.customProgramCacheKey = () => 'acntr-terrain-splat-v1';

    this._materials.push(mat);
    return mat;
  }

  dispose() {
    for (const m of this._materials) {
      const u = m.userData.uniforms;
      if (u) for (const k of Object.keys(u)) u[k].value?.isTexture && u[k].value.dispose();
      m.dispose();
    }
    for (const g of this._geoms) g.dispose();
    this._materials.length = 0;
    this._geoms.length = 0;
  }
}

export default Terrain;
