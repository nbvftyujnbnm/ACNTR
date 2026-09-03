/**
 * vfxShaders.js — GLSL for the ACNTR VFX system.
 *
 * Design notes that matter for anyone reading this later:
 *
 * - Every particle is simulated *in the vertex shader* from its spawn state.
 *   The CPU writes 32 floats once, at spawn, and never touches the particle
 *   again. `age = uTime - birth`; motion is the closed-form solution of
 *   `dv/dt = -k*v + g` so drag is exact regardless of frame rate, and the
 *   whole batch is one draw call with zero per-frame CPU work.
 *
 * - Colours are HDR. Additive particles routinely emit rgb in the 2..40 range
 *   so the bloom pass produces a blown-out core with a soft halo. Anything
 *   clamped to 1.0 reads as flat and cheap, which is the single most common
 *   way stylised VFX fail.
 *
 * - Tone mapping / colour space: we deliberately `#include` the stock three
 *   chunks. When the post pipeline renders the scene into a linear HDR target
 *   three disables TONE_MAPPING and `linearToOutputTexel` is identity, so the
 *   HDR values survive to the bloom pass. When something renders straight to
 *   the canvas instead, the same shader tone maps exactly like every other
 *   material. Both paths are correct without us knowing which one is active.
 */

// ---------------------------------------------------------------------------
// Shared chunks
// ---------------------------------------------------------------------------

export const COMMON = /* glsl */ `
#define VFX_PI 3.141592653589793
#define VFX_TAU 6.283185307179586

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 hash31(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

/** Cheap value noise in 2D — used for smoke erosion and flame flicker. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash11(dot(i, vec2(1.0, 57.0)));
  float b = hash11(dot(i + vec2(1.0, 0.0), vec2(1.0, 57.0)));
  float c = hash11(dot(i + vec2(0.0, 1.0), vec2(1.0, 57.0)));
  float d = hash11(dot(i + vec2(1.0, 1.0), vec2(1.0, 57.0)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  return vnoise(p) * 0.6 + vnoise(p * 2.17 + 11.3) * 0.3 + vnoise(p * 4.51 + 27.1) * 0.1;
}

/** Camera basis pulled out of the view matrix rows (world-space). */
vec3 camRightWS() { return vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); }
vec3 camUpWS()    { return vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]); }
vec3 camFwdWS()   { return -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]); }
`;

/**
 * Soft-particle depth fade. Entirely optional: `uSoftParams.x` is 0 until the
 * render pipeline hands us a depth texture, and the branch is uniform so it is
 * free. Without it particles simply intersect geometry with a hard edge.
 */
export const SOFT_DEPTH = /* glsl */ `
uniform sampler2D uDepthTex;
uniform vec4 uSoftParams; // (enabled, near, far, defaultSoftness metres)

float softDepthFade(vec4 screenPos, float viewZ, float softness) {
  if (uSoftParams.x < 0.5) return 1.0;
  vec2 suv = screenPos.xy / max(abs(screenPos.w), 1e-5) * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return 1.0;
  float d = texture2D(uDepthTex, suv).x;
  if (d >= 0.9999995) return 1.0;
  float n = uSoftParams.y;
  float f = uSoftParams.z;
  float ndc = d * 2.0 - 1.0;
  float sceneZ = (2.0 * n * f) / (f + n - ndc * (f - n));
  float s = softness > 0.0 ? softness : uSoftParams.w;
  return clamp((sceneZ - viewZ) / max(s, 1e-3), 0.0, 1.0);
}
`;

/** Atlas tile lookup with a half-texel inset so mips never bleed across tiles. */
export const ATLAS = /* glsl */ `
uniform vec2 uAtlas; // (grid, 1/grid)

vec2 atlasUv(vec2 uv, float tile) {
  float g = uAtlas.x;
  float col = mod(floor(tile + 0.5), g);
  float row = floor((floor(tile + 0.5) + 0.5) * uAtlas.y);
  // Canvas rows run top-down, texture v runs bottom-up.
  vec2 cell = vec2(col, g - 1.0 - row);
  return (cell + clamp(uv, 0.0015, 0.9985)) * uAtlas.y;
}
`;

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

export const particleVert = /* glsl */ `
${COMMON}
${ATLAS}

attribute vec4 aPosBirth; // xyz spawn position (world), w birth time
attribute vec4 aVelLife;  // xyz spawn velocity (m/s), w lifetime (s)
attribute vec4 aDyn;      // x linear drag k, y gravity, z turbulence amp, w turbulence freq
attribute vec4 aSize;     // x size0, y size1, z rot0, w spin (rad/s)
attribute vec4 aCol0;     // rgb HDR colour at birth, a alpha at birth
attribute vec4 aCol1;     // rgb HDR colour at death, a alpha at death
attribute vec4 aMisc;     // x atlas tile, y velocity stretch (m per m/s), z fade-in fraction, w seed
attribute vec4 aFlags;    // x erode, y size curve exp, z alpha curve exp, w soft distance

uniform float uTime;
uniform float uSizeScale;

varying vec2 vUv;
varying vec4 vColor;
varying float vViewZ;
varying vec4 vScreen;
varying vec3 vSeedErode;

void main() {
  float life = aVelLife.w;
  float age = uTime - aPosBirth.w;

  if (life <= 0.0 || age < 0.0 || age >= life) {
    // Dead slot: push behind the near plane so every vertex is clipped.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vColor = vec4(0.0);
    vViewZ = 1.0;
    vScreen = vec4(0.0, 0.0, 0.0, 1.0);
    vSeedErode = vec3(0.0);
    return;
  }

  float t = age / life;
  float k = aDyn.x;
  vec3 g = vec3(0.0, -aDyn.y, 0.0);

  // --- closed-form drag integration -----------------------------------------
  vec3 p;
  vec3 vel;
  if (k > 0.0015) {
    float e = exp(-k * age);
    vec3 vinf = g / k;
    vec3 v0 = aVelLife.xyz - vinf;
    p = aPosBirth.xyz + v0 * ((1.0 - e) / k) + vinf * age;
    vel = v0 * e + vinf;
  } else {
    p = aPosBirth.xyz + aVelLife.xyz * age + 0.5 * g * age * age;
    vel = aVelLife.xyz + g * age;
  }

  // --- turbulence -----------------------------------------------------------
  float turb = aDyn.z;
  if (turb > 0.0) {
    float f = aDyn.w;
    float s = aMisc.w * 97.0;
    vec3 w1 = vec3(
      sin(age * f + s),
      sin(age * f * 1.31 + s * 1.73 + 2.1),
      sin(age * f * 0.83 + s * 2.31 + 4.7));
    vec3 w2 = vec3(
      sin(age * f * 2.37 + s * 3.11),
      sin(age * f * 2.91 + s * 1.37 + 1.3),
      sin(age * f * 3.13 + s * 5.51 + 3.9));
    // Displacement grows with age so puffs bloom outward instead of vibrating.
    p += (w1 + w2 * 0.42) * turb * age;
  }

  // --- size / colour / alpha ------------------------------------------------
  float ts = pow(t, max(aFlags.y, 0.05));
  float size = mix(aSize.x, aSize.y, ts) * uSizeScale;

  float fadeIn = smoothstep(0.0, max(aMisc.z, 1e-4), t);
  float tail = pow(clamp(1.0 - t, 0.0, 1.0), max(aFlags.z, 0.05));
  // Guaranteed clean exit — nothing ever pops out of existence.
  tail *= smoothstep(0.0, 0.14, 1.0 - t);
  float alpha = mix(aCol0.a, aCol1.a, t) * fadeIn * tail;
  vec3 rgb = mix(aCol0.rgb, aCol1.rgb, t);

  // --- billboard ------------------------------------------------------------
  vec2 q = position.xy;
  vec3 right = camRightWS();
  vec3 up = camUpWS();
  vec3 wp = p;
  vec2 quv = uv;

  float stretch = aMisc.y;
  if (stretch > 0.0) {
    // Velocity-aligned quad: long axis follows motion, width faces the camera.
    float sp = length(vel);
    vec3 dirW = sp > 1e-4 ? vel / sp : up;
    vec3 toCam = cameraPosition - p;
    vec3 sideW = cross(dirW, toCam);
    float sl = length(sideW);
    sideW = sl > 1e-4 ? sideW / sl : right;
    float len = size + stretch * sp;
    wp += dirW * (q.x * len) + sideW * (q.y * size);
  } else {
    float rot = aSize.z + aSize.w * age;
    float c = cos(rot);
    float sn = sin(rot);
    vec2 r = vec2(q.x * c - q.y * sn, q.x * sn + q.y * c);
    wp += right * (r.x * size) + up * (r.y * size);
  }

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
  vUv = atlasUv(quv, aMisc.x);
  vColor = vec4(rgb, alpha);
  vSeedErode = vec3(aMisc.w, aFlags.x * t, aFlags.w);
}
`;

export const particleFrag = /* glsl */ `
${COMMON}
${SOFT_DEPTH}

uniform sampler2D uMap;
uniform float uAlphaScale;

varying vec2 vUv;
varying vec4 vColor;
varying float vViewZ;
varying vec4 vScreen;
varying vec3 vSeedErode;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a * uAlphaScale;

  // Erosion dissolve: smoke thins out through its own noise instead of
  // uniformly dimming, which is what stops it reading as a grey blob.
  float erode = vSeedErode.y;
  if (erode > 0.0) {
    a *= smoothstep(erode, erode + 0.34, tex.a + 0.0001);
  }

  a *= softDepthFade(vScreen, vViewZ, vSeedErode.z);
  if (a <= 0.002) discard;

  vec3 rgb = vColor.rgb * tex.rgb;
  gl_FragColor = vec4(rgb, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Ribbon trails
// ---------------------------------------------------------------------------

export const trailVert = /* glsl */ `
${COMMON}

attribute vec3 aDir;    // centreline tangent
attribute vec4 aCol;    // rgb HDR, a alpha
attribute vec2 aUvw;    // x: u along ribbon, y: half-width in metres
attribute float aSide;  // -1 / +1

varying vec2 vUv;
varying vec4 vColor;
varying float vViewZ;
varying vec4 vScreen;

void main() {
  vec3 toCam = cameraPosition - position;
  float d = length(toCam);
  toCam = d > 1e-4 ? toCam / d : camFwdWS();
  vec3 side = cross(aDir, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : camRightWS();

  vec3 wp = position + side * (aSide * aUvw.y);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
  vUv = vec2(aUvw.x, aSide * 0.5 + 0.5);
  vColor = aCol;
}
`;

export const trailFrag = /* glsl */ `
${COMMON}
${SOFT_DEPTH}

uniform sampler2D uMap;
uniform float uScroll;
uniform float uTile;
uniform float uSoftDist;

varying vec2 vUv;
varying vec4 vColor;
varying float vViewZ;
varying vec4 vScreen;

void main() {
  vec2 uv = vec2(vUv.x * uTile + uScroll, vUv.y);
  vec4 tex = texture2D(uMap, uv);
  // Feather the ribbon edges so the strip never shows a hard silhouette.
  float edge = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = tex.a * vColor.a * smoothstep(0.0, 0.42, edge);
  a *= softDepthFade(vScreen, vViewZ, uSoftDist);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(vColor.rgb * tex.rgb, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Decals — surface-oriented quads
// ---------------------------------------------------------------------------

export const decalVert = /* glsl */ `
${COMMON}
${ATLAS}

attribute vec4 aPosBirth; // xyz centre, w birth
attribute vec4 aRight;    // xyz tangent, w size
attribute vec4 aUp;       // xyz bitangent, w life
attribute vec4 aColor;    // rgb, a peak alpha
attribute vec4 aMisc;     // x tile, y fade-in, z hold fraction, w seed

uniform float uTime;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  float life = aUp.w;
  float age = uTime - aPosBirth.w;
  if (life <= 0.0 || age < 0.0 || age >= life) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vColor = vec4(0.0);
    return;
  }
  float t = age / life;
  float fin = smoothstep(0.0, max(aMisc.y, 1e-4), t);
  float fout = 1.0 - smoothstep(clamp(aMisc.z, 0.0, 0.98), 1.0, t);

  vec3 wp = aPosBirth.xyz + aRight.xyz * (position.x * aRight.w) + aUp.xyz * (position.y * aRight.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vUv = atlasUv(uv, aMisc.x);
  vColor = vec4(aColor.rgb, aColor.a * fin * fout);
}
`;

export const decalFrag = /* glsl */ `
${COMMON}

uniform sampler2D uMap;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * tex.rgb, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Rings / shockwaves / shield ripples
// ---------------------------------------------------------------------------

export const ringVert = /* glsl */ `
${COMMON}

attribute vec4 aOrigin; // xyz centre, w birth
attribute vec4 aAxis;   // xyz normal, w life
attribute vec4 aShape;  // x r0, y r1, z thickness, w mode
attribute vec4 aColor;  // rgb HDR, a alpha
attribute vec4 aExtra;  // x dome, y spin, z seed, w growth exponent

uniform float uTime;

varying vec2 vLocal;
varying float vRad;
varying vec4 vColor;
varying vec4 vShape;
varying vec3 vExtra;
varying float vT;
varying vec3 vNormalW;
varying vec3 vViewDirW;
varying vec4 vScreen;

void main() {
  float life = aAxis.w;
  float age = uTime - aOrigin.w;
  if (life <= 0.0 || age < 0.0 || age >= life) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vColor = vec4(0.0);
    vLocal = vec2(0.0); vRad = 0.0; vShape = vec4(0.0); vExtra = vec3(0.0);
    vT = 1.0; vNormalW = vec3(0.0, 1.0, 0.0); vViewDirW = vec3(0.0, 0.0, 1.0);
    vScreen = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float t = age / life;

  vec3 z = normalize(aAxis.xyz);
  vec3 ref = abs(z.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 x = normalize(cross(ref, z));
  vec3 y = cross(z, x);

  float spin = aExtra.y * age;
  float cs = cos(spin);
  float sn = sin(spin);
  vec2 lp = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);

  float r = length(position.xy);
  // Ease-out growth: shockwaves explode outward then decelerate.
  float grow = 1.0 - pow(1.0 - t, max(aExtra.w, 0.05));
  float radius = mix(aShape.x, aShape.y, grow);

  float domeH = aExtra.x * radius * sqrt(max(0.0, 1.0 - r * r));
  vec3 wp = aOrigin.xyz + x * (lp.x * radius) + y * (lp.y * radius) + z * domeH;

  // Approximate surface normal for the rim/fresnel term.
  vec3 nrm = normalize(x * (lp.x * aExtra.x) + y * (lp.y * aExtra.x) + z * (1.0 - aExtra.x * 0.75 * r));
  vNormalW = nrm;
  vViewDirW = normalize(cameraPosition - wp);

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
  vLocal = lp;
  vRad = r;
  vColor = aColor;
  vShape = aShape;
  vExtra = vec3(aExtra.x, aExtra.z, radius);
  vT = t;
}
`;

export const ringFrag = /* glsl */ `
${COMMON}

varying vec2 vLocal;
varying float vRad;
varying vec4 vColor;
varying vec4 vShape;
varying vec3 vExtra;
varying float vT;
varying vec3 vNormalW;
varying vec3 vViewDirW;
varying vec4 vScreen;

uniform float uTime;

void main() {
  float mode = vShape.w;
  float th = max(vShape.z, 0.006);
  float r = vRad;
  float a = 0.0;
  vec3 rgb = vColor.rgb;

  float ang = atan(vLocal.y, vLocal.x);
  float seed = vExtra.y;

  if (mode < 0.5) {
    // 0 — expanding shockwave ring, hot leading edge.
    //
    // THE OUTER EDGE MUST BE AS SOFT AS THE INNER ONE. The old band fell off
    // over th * 0.12 — 0.7% of the radius, which on a 17 m ring is a 12 cm
    // ramp, i.e. a hard line. Measured on shots/vfx00/combat_vfx.png: the
    // frame was three enormous white ellipse OUTLINES, "a visible hard polygon
    // silhouette on something meant to be curved" in everything but name.
    // Both edges now ramp over 45% of the thickness, so the ring reads as a
    // band of compressed dust rather than as a stroked circle.
    float band = smoothstep(1.0 - th, 1.0 - th * 0.45, r)
               * (1.0 - smoothstep(1.0 - th * 0.45, 1.0, r));
    // ragged edge so it never looks like a CAD circle
    float ragged = 0.72 + 0.28 * fbm2(vec2(ang * 3.2 + seed * 9.0, seed * 4.0));
    band *= ragged;
    float lead = smoothstep(1.0 - th * 0.7, 1.0 - th * 0.15, r);
    rgb = mix(rgb, rgb * 2.0 + vec3(0.2), lead);
    a = band;
  } else if (mode < 1.5) {
    // 1 — dome shockwave: rim-lit shell, brightest at grazing angles.
    float fres = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewDirW)));
    fres = pow(clamp(fres, 0.0, 1.0), 2.4);
    // Same undefined-smoothstep trap as flameFrag: edge0 (1.0) was greater than
    // edge1, so on a driver that short-circuits the low edge this returned 0 and
    // the explosion's DOME shockwave never drew a pixel. Solid inside, feathered
    // out at the rim.
    float shell = 1.0 - smoothstep(1.0 - max(th * 2.0, 0.02), 1.0, r);
    a = fres * shell;
    rgb *= 1.0 + fres * 2.0;
  } else if (mode < 2.5) {
    // 2 — hex shield impact: ripple travelling out across a hex lattice.
    vec2 hp = vLocal * 9.0;
    // hex distance field
    vec2 h = abs(mat2(1.0, 0.0, -0.57735, 1.15470) * hp);
    float hex = max(h.x, max(h.y * 0.5 + h.x * 0.5, h.y));
    float cell = fract(hex);
    float grid = smoothstep(0.72, 0.98, cell);
    float ripple = exp(-pow((r - vT * 1.05) * 7.5, 2.0));
    float fill = (0.09 + grid * 0.7) * (1.0 - smoothstep(0.86, 1.0, r));
    a = clamp(fill * (0.25 + ripple * 2.6), 0.0, 3.0);
    rgb *= 1.0 + ripple * 3.2;
  } else if (mode < 3.5) {
    // 3 — energy disc with radial spikes (stagger / lock bursts).
    float band = smoothstep(1.0 - th, 1.0 - th * 0.45, r) * (1.0 - smoothstep(1.0 - th * 0.45, 1.0, r));
    float spikes = pow(abs(sin(ang * 6.0 + seed * 12.0)), 22.0)
                 + pow(abs(sin(ang * 14.0 + seed * 5.0)), 34.0) * 0.6;
    float radial = spikes * (1.0 - smoothstep(0.15, 1.0, r)) * 1.4;
    a = band + radial;
    rgb *= 1.0 + radial * 1.6;
  } else {
    // 4 — scan sweep: concentric pulses + rotating wiper.
    float rings = pow(abs(sin((r - vT * 1.6) * 26.0)), 12.0);
    float wipe = pow(max(0.0, cos(ang - uTime * 4.5)), 24.0);
    a = (rings * 0.55 + wipe * 0.8) * (1.0 - smoothstep(0.6, 1.0, r));
  }

  // Life envelope: snap in, hold, ease out.
  float env = smoothstep(0.0, 0.07, vT) * (1.0 - smoothstep(0.35, 1.0, vT));
  a *= vColor.a * env;
  if (a <= 0.003) discard;

  gl_FragColor = vec4(rgb, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Distortion variant of the ring — refracts whatever the pipeline gave us as a
 * scene colour texture. Only ever drawn when `setSceneColorTexture()` was
 * called; otherwise the additive ring above carries the shockwave alone.
 */
export const ringDistortFrag = /* glsl */ `
${COMMON}

uniform sampler2D uSceneColor;
uniform float uTime;
uniform float uStrength;

varying vec2 vLocal;
varying float vRad;
varying vec4 vColor;
varying vec4 vShape;
varying vec3 vExtra;
varying float vT;
varying vec3 vNormalW;
varying vec3 vViewDirW;
varying vec4 vScreen;

void main() {
  float th = max(vShape.z, 0.01);
  float r = vRad;
  float band = smoothstep(1.0 - th * 2.2, 1.0 - th * 0.3, r) * (1.0 - smoothstep(1.0 - th * 0.2, 1.0, r));
  float env = smoothstep(0.0, 0.05, vT) * (1.0 - smoothstep(0.25, 1.0, vT));
  float amt = band * env;
  if (amt <= 0.004) discard;

  vec2 suv = vScreen.xy / max(abs(vScreen.w), 1e-5) * 0.5 + 0.5;
  vec2 dir = normalize(vLocal + 1e-5);
  // Push the sample outward through the wavefront — compression at the front.
  //
  // uStrength is a fraction of the SCREEN, not of the ring, so it must stay
  // small: at 0.045 a full-strength fragment sampled 86 px away at 1920 wide,
  // which on shots/vfx00/combat_vfx.png turned the whole sky into wavy
  // horizontal bands wherever a blast ring crossed it. Refraction through a
  // shock front is a few pixels of displacement, not a lens.
  vec2 off = dir * amt * uStrength * (0.6 + 0.4 * fbm2(vLocal * 6.0 + uTime));
  vec3 scene = texture2D(uSceneColor, clamp(suv + off, vec2(0.001), vec2(0.999))).rgb;
  // Bent air does not EMIT. The old +0.35 gain and +0.25 colour term were what
  // made this pass draw a bright white ellipse outline over the frame rather
  // than a distortion you have to look for.
  vec3 rgb = scene * (1.0 + amt * 0.10) + vColor.rgb * amt * 0.05;

  gl_FragColor = vec4(rgb, clamp(amt * 1.2, 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Projectile bodies — tracers, motor flares, plasma bolts, beams
// ---------------------------------------------------------------------------

/**
 * Ordnance in flight used to be solid geometry wearing a `MeshBasicMaterial`:
 * a 6-gon tube of ONE constant colour with a hard silhouette. Measured on
 * shots/iter32/gameplay.png, an enemy round drew as an 86 px line of uniform
 * width and uniform brightness — "a clean constant-width curve with no glow,
 * no taper and no head-bright falloff", i.e. a debug line.
 *
 * Three things fix that, and all three have to be in the SHADER because the
 * geometry is shared and instanced:
 *
 *  1. CROSS-SECTION SOFTNESS. `|N·V|` is 1 where the surface faces the lens
 *     and 0 at the silhouette, for a tube and for a sphere alike. Raising it
 *     to a power turns a hard-edged solid into a glow whose edge dissolves,
 *     which is the whole difference between a lit cylinder and a light.
 *  2. AN AXIAL PROFILE. Real tracer luminance is concentrated at the head and
 *     dies along the trail. The vertex stage ALSO pinches the tail radius, so
 *     the streak is a wedge rather than a bar — a constant-width line reads as
 *     vector art no matter how it is shaded.
 *  3. HDR OUTPUT. `uGain` is applied on top of the instance colour so the core
 *     lands well past the bloom prefilter (1.90 scene-linear) while the skirt
 *     falls under it. That ordering is what produces a tight hot core with a
 *     wide soft halo instead of a uniform veil.
 */
export const projectileVert = /* glsl */ `
${COMMON}

uniform float uTube;       // 1 = unit cylinder about +Z, 0 = unit sphere
uniform float uTaper;      // 0..1 how strongly the head-bright profile applies
uniform float uTailWidth;  // radius multiplier at the tail (1 = no pinch)
uniform float uHeadPow;    // axial profile exponent
uniform float uTailGain;   // brightness floor at the tail
uniform float uWidth;      // extra radial scale — the halo instance runs wide

varying vec3 vCol;
varying vec3 vNrmW;
varying vec3 vViewW;
varying float vProfile;

void main() {
  // Geometry contract: the tube is a unit cylinder about +Z spanning z -0.5
  // (tail) .. +0.5 (head); a blob is a unit sphere. "a" is 1 at the head.
  float a = mix(1.0, clamp(position.z + 0.5, 0.0, 1.0), uTaper);
  float widthMul = mix(uTailWidth, 1.0, a) * uWidth;

  vec3 local = vec3(position.xy * widthMul, position.z);
  mat4 mi = modelMatrix * instanceMatrix;
  vec4 wp = mi * vec4(local, 1.0);

  // A tube's normal is radial (z component zero); a blob's is its own
  // direction. Both go to world space through the INSTANCE matrix, because a
  // tracer's scale is 30:1 along its axis. For the tube the two live
  // components share one scale factor, so the plain basis normalises to the
  // right direction; the blob's scale is near-uniform and the small
  // inverse-transpose error is invisible inside a soft glow.
  vec3 nLocal = uTube > 0.5
    ? vec3(normalize(position.xy + vec2(1e-5, 0.0)), 0.0)
    : normalize(position + vec3(1e-5));
  vNrmW = normalize(mat3(mi) * nLocal);
  vViewW = cameraPosition - wp.xyz;

  vProfile = mix(uTailGain, 1.0, pow(a, uHeadPow));
  vCol = instanceColor;

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const projectileFrag = /* glsl */ `
${COMMON}

uniform float uSoftPow;   // cross-section falloff exponent
uniform float uGain;      // HDR multiplier on the instance colour
uniform float uAlpha;

varying vec3 vCol;
varying vec3 vNrmW;
varying vec3 vViewW;
varying float vProfile;

void main() {
  vec3 n = normalize(vNrmW);
  vec3 v = normalize(vViewW);
  // Soft cross-section. Front and back faces both draw (DoubleSide), which is
  // what gives the core its extra stop over the rim for free.
  float soft = pow(clamp(abs(dot(n, v)), 0.0, 1.0), uSoftPow);
  float w = soft * vProfile;
  if (w <= 0.002) discard;
  gl_FragColor = vec4(vCol * (w * uGain), clamp(w * uAlpha, 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Thruster plumes
// ---------------------------------------------------------------------------

export const flameVert = /* glsl */ `
${COMMON}

attribute vec4 aOrigin; // xyz nozzle position, w seed
attribute vec4 aAxis;   // xyz plume direction (unit), w length in metres
attribute vec4 aParams; // x radius, y intensity 0..1.6, z colour temperature, w flicker phase

uniform float uTime;
uniform float uLength;  // per-layer length multiplier
uniform float uRadius;  // per-layer radius multiplier
uniform float uBulge;   // where along the plume the widest point sits
uniform float uWaver;   // lateral snake, in throat radii, at the tip
uniform float uTaper;   // tip taper exponent — low is a long thin needle

varying float vV;
varying vec3 vNrmW;
varying vec3 vViewW;
varying vec3 vSeedInt;
varying vec4 vScreen;
varying float vViewZ;
varying float vAng;

void main() {
  float intensity = aParams.y;
  if (intensity <= 0.001) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vV = 0.0; vNrmW = vec3(0.0, 0.0, 1.0); vViewW = vec3(0.0, 0.0, 1.0);
    vSeedInt = vec3(0.0); vScreen = vec4(0.0, 0.0, 0.0, 1.0); vViewZ = 1.0; vAng = 0.0;
    return;
  }

  float seed = aOrigin.w;
  float v = position.z;              // 0 at nozzle, 1 at tip
  vec2 ring = position.xy;           // unit circle
  float ang = atan(ring.y, ring.x);

  vec3 z = normalize(aAxis.xyz);
  vec3 ref = abs(z.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 x = normalize(cross(ref, z));
  vec3 y = cross(z, x);

  // Turbulent flicker — two incommensurate rates so it never looks periodic.
  float ph = uTime * 41.0 + aParams.w;
  float flick = 0.88
    + 0.08 * sin(ph + seed * 6.28)
    + 0.06 * sin(ph * 1.77 + seed * 11.3)
    + 0.05 * sin(ph * 3.11 + seed * 3.7);

  // Length is superlinear in intensity: an idle pilot flame is a stub, an
  // assault-boost plume is a streak several times the mech's own height. A
  // linear ramp made 0.07 and 1.4 differ by less than 2x, which is why idle
  // and full burn used to photograph nearly the same.
  float ic = clamp(intensity, 0.0, 1.6);
  float len = aAxis.w * uLength * (0.18 + 0.95 * ic * ic / (0.50 + ic)) * flick;

  // Profile: pinched at the throat, bulges just past it, tapers to the tip.
  float bulge = max(uBulge, 0.02);
  float prof = smoothstep(0.0, bulge, v) * 0.62 + 0.38;
  prof *= pow(clamp(1.0 - v, 0.0, 1.0), uTaper);
  prof = max(prof, 0.015);
  // Fluted wobble on the sheath — two orders so the rim is never a clean circle.
  prof *= 1.0
    + 0.09 * sin(ang * 5.0 + uTime * 22.0 + seed * 9.0) * v
    + 0.05 * sin(ang * 9.0 - uTime * 31.0 + seed * 4.3) * v;

  float radius = aParams.x * uRadius * prof * mix(0.72, 1.20, clamp(intensity, 0.0, 1.3));

  vec3 wp = aOrigin.xyz + x * (ring.x * radius) + y * (ring.y * radius) + z * (v * len);

  // Lateral snake, anchored at the throat (v*v) so the nozzle stays put while
  // the tail whips. This is what separates exhaust from a solid cone.
  float sway = uWaver * aParams.x * uRadius * v * v;
  wp += x * (sin(uTime * 12.7 + seed * 7.1 + v * 2.6) * sway)
      + y * (sin(uTime * 9.3 + seed * 3.7 + v * 3.3) * sway);

  vNrmW = x * ring.x + y * ring.y + z * 0.42;
  vViewW = cameraPosition - wp;

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
  vV = v;
  vAng = ang;
  vSeedInt = vec3(seed, intensity, aParams.z);
}
`;

export const flameFrag = /* glsl */ `
${COMMON}
${SOFT_DEPTH}

uniform float uTime;
uniform vec3 uCoolColor;   // low-intensity tint (deep blue)
uniform vec3 uHotColor;    // high-intensity tint (white-blue)
uniform vec3 uEdgeColor;   // rim tint seen at grazing angles
uniform vec3 uTipColor;    // tint at the far end — the plume cools as it goes
uniform float uDiamonds;   // shock-diamond strength
uniform float uGain;
uniform float uRimPow;     // fresnel exponent: high = a thin bright rim only
uniform float uTipFade;    // v at which the tip starts fading out
uniform float uFibre;      // longitudinal streak contrast

varying float vV;
varying vec3 vNrmW;
varying vec3 vViewW;
varying vec3 vSeedInt;
varying vec4 vScreen;
varying float vViewZ;
varying float vAng;

void main() {
  float v = vV;
  float seed = vSeedInt.x;
  float intensity = vSeedInt.y;
  float temp = vSeedInt.z;

  // Fresnel resolved per FRAGMENT, not per vertex. Interpolating the finished
  // scalar across a 20-gon quantised the rim into visible facets, which is the
  // "hard polygon silhouette on something meant to be curved" automatic fail.
  vec3 nrm = normalize(vNrmW);
  vec3 vw = normalize(vViewW);
  float fres = pow(clamp(1.0 - abs(dot(nrm, vw)), 0.0, 1.0), uRimPow);

  // Shock diamonds: standing wave nodes scrolling slowly down the plume.
  float dia = 0.0;
  if (uDiamonds > 0.0) {
    float band = sin(v * VFX_PI * (4.0 + intensity * 3.0) - uTime * 7.0 + seed * 6.0);
    dia = pow(abs(band), 8.0) * uDiamonds * (1.0 - smoothstep(0.12, 0.66, v));
  }

  float core = pow(clamp(1.0 - v, 0.0, 1.0), 1.35);
  float body = core * 0.85 + dia * 0.9;

  // Fibrous longitudinal streaking. A plume that is a smooth gradient reads as
  // a plastic cone; real exhaust is combed into filaments along its own flow.
  float fib = 1.0;
  if (uFibre > 0.0) {
    float n = fbm2(vec2(vAng * 2.6 + seed * 31.0, v * 3.2 - uTime * 3.4));
    fib = mix(1.0, 0.42 + 1.24 * n, uFibre);
  }

  vec3 col = mix(uCoolColor, uHotColor, clamp(temp, 0.0, 1.0));
  col = mix(col, uTipColor, smoothstep(0.10, 0.92, v));
  col = mix(col, uEdgeColor, fres * 0.62);
  col += vec3(1.0, 0.94, 0.88) * dia * 1.6;

  float a = (body * 0.6 + fres * 0.8) * fib * intensity * uGain;
  // NEVER write smoothstep(hi, lo, x) to get a falling edge. GLSL ES leaves
  // edge0 >= edge1 UNDEFINED, and the usual driver implementation short-circuits
  // with "if x is below edge0, return 0" — which for smoothstep(1.0, 0.55, v)
  // with v in [0,1] returns ZERO FOR EVERY FRAGMENT. That is what made this layer
  // rasterise nothing while every other VFX batch drew fine: the draw was
  // submitted, the vertex stage was correct, and then every fragment hit the
  // discard below. Write 1.0 - smoothstep(lo, hi, x) instead; it is the same
  // curve and it is defined.
  a *= 1.0 - smoothstep(uTipFade, 1.0, v);  // fade the tip out, never a cut edge
  a *= smoothstep(0.0, 0.05, v);            // hide the open throat inside the nozzle
  a *= softDepthFade(vScreen, vViewZ, 0.35);
  if (a <= 0.003) discard;

  gl_FragColor = vec4(col * (0.55 + intensity * 1.7), a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Scan shells (lock-on sweep, shield bubbles)
// ---------------------------------------------------------------------------

export const shellVert = /* glsl */ `
${COMMON}

attribute vec4 aOrigin; // xyz centre, w birth
attribute vec4 aParams; // x r0, y r1, z life, w mode
attribute vec4 aColor;
attribute vec3 aBary;

uniform float uTime;

varying vec3 vBary;
varying vec4 vColor;
varying float vT;
varying float vMode;
varying vec3 vLocal;
varying float vFres;

void main() {
  float life = aParams.z;
  float age = uTime - aOrigin.w;
  if (life <= 0.0 || age < 0.0 || age >= life) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vBary = vec3(0.0); vColor = vec4(0.0); vT = 1.0; vMode = 0.0;
    vLocal = vec3(0.0, 1.0, 0.0); vFres = 0.0;
    return;
  }
  float t = age / life;
  float grow = 1.0 - pow(1.0 - t, 2.6);
  float radius = mix(aParams.x, aParams.y, grow);

  vec3 n = normalize(position);
  vec3 wp = aOrigin.xyz + n * radius;
  vec3 viewDir = normalize(cameraPosition - wp);
  vFres = 1.0 - abs(dot(n, viewDir));

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vBary = aBary;
  vColor = aColor;
  vT = t;
  vMode = aParams.w;
  vLocal = n;
}
`;

export const shellFrag = /* glsl */ `
${COMMON}

uniform float uTime;

varying vec3 vBary;
varying vec4 vColor;
varying float vT;
varying float vMode;
varying vec3 vLocal;
varying float vFres;

void main() {
  // Analytic wireframe from barycentrics — crisp at any distance.
  vec3 d = fwidth(vBary);
  vec3 f = smoothstep(vec3(0.0), d * 1.6, vBary);
  float wire = 1.0 - min(min(f.x, f.y), f.z);

  float fres = pow(clamp(vFres, 0.0, 1.0), 2.2);

  // Latitude sweep band races up the sphere.
  float band = exp(-pow((vLocal.y - (vT * 2.4 - 1.2)) * 5.5, 2.0));

  float a = wire * 0.75 + fres * 0.28 + band * 0.55;
  if (vMode > 0.5) {
    // Reticle mode: quantised rings instead of a smooth sweep.
    a = wire * 0.9 + pow(abs(sin(vLocal.y * 14.0 - uTime * 5.0)), 16.0) * 0.5;
  }

  float env = smoothstep(0.0, 0.09, vT) * (1.0 - smoothstep(0.45, 1.0, vT));
  a *= vColor.a * env;
  if (a <= 0.004) discard;

  gl_FragColor = vec4(vColor.rgb * (1.0 + band * 2.0), a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
