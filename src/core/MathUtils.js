import * as THREE from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Frame-rate independent exponential smoothing. `rate` ~ how much closes per second. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export const dampVec3 = (out, target, rate, dt) => {
  const t = 1 - Math.exp(-rate * dt);
  out.x += (target.x - out.x) * t;
  out.y += (target.y - out.y) * t;
  out.z += (target.z - out.z) * t;
  return out;
};

export const dampAngle = (a, b, rate, dt) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-rate * dt));
};

export const shortestAngle = (a, b) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export const randRange = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Deterministic 32-bit hash → [0,1). */
export function hash01(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Mulberry32 seeded PRNG — used everywhere procedural content must be stable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Predictive aim: where to shoot so a constant-speed projectile intercepts a moving target. */
const _rel = new THREE.Vector3();
const _relV = new THREE.Vector3();
export function interceptPoint(shooterPos, targetPos, targetVel, projSpeed, out = new THREE.Vector3()) {
  _rel.subVectors(targetPos, shooterPos);
  _relV.copy(targetVel);
  const a = _relV.lengthSq() - projSpeed * projSpeed;
  const b = 2 * _rel.dot(_relV);
  const c = _rel.lengthSq();
  let t;
  if (Math.abs(a) < 1e-4) {
    t = Math.abs(b) < 1e-6 ? 0 : -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) {
      out.copy(targetPos);
      return out;
    }
    const s = Math.sqrt(disc);
    const t1 = (-b + s) / (2 * a);
    const t2 = (-b - s) / (2 * a);
    t = Math.min(t1 < 0 ? Infinity : t1, t2 < 0 ? Infinity : t2);
    if (!isFinite(t)) t = 0;
  }
  out.copy(targetVel).multiplyScalar(t).add(targetPos);
  return out;
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
