// WHAT WOULD MAKING THE `steel` FAMILY DIELECTRIC ACTUALLY BUY, AND COST?
//
// Measured 2026-09-06: the large walkable deck surfaces are the `steel` family
// at metalness 1, and a conductor has no diffuse lobe, so they render at
// display 13-55 from rough environment specular alone. This file already
// documents that exact failure ("a deck full of hardware rendered as one black
// shape with a plastic sheen") and the fix that moved paint, primer, rust and
// concrete to dielectric — `steel` was deliberately kept at 1.0 as "the one
// family that is genuinely bare alloy".
//
// That is an art call, not a bug, so this probe does not make it. It puts
// numbers on both sides of it. `steel` is used for machinery, railings and
// pipes as well as for floor plate, and a conductor is RIGHT for those: they
// are what catches a glint. The question is only whether a large horizontal
// plate under a 13.5-degree sun is bare alloy or oxidised and dust-covered.
//
// Materials are live objects, so this flips metalness at runtime and re-reads
// `rtA` (post-composite, pre-tonemap) rather than rebuilding. No shipped value
// is changed: the original is restored before returning.
//
//   node tools/probe.mjs --file tools/probes/decksteel.js
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.poseMech({ grounded: true, aimYaw: 0.25, aimPitch: -0.05, speed: 0 });
  debug.step(2.0);
  debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.step(0.4);

  // Find every material whose name marks it as the steel family. Report what
  // was found, because a probe that silently matches nothing reads exactly like
  // a term that does not matter — the "dead control" failure this file records
  // four separate instances of.
  const mats = new Map();
  game.scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (!mm || typeof mm.metalness !== 'number') continue;
      if (!/steel/i.test(mm.name || '')) continue;
      if (!mats.has(mm.uuid)) mats.set(mm.uuid, mm);
    }
  });
  const found = [...mats.values()].map((m) => ({
    name: m.name, metalness: m.metalness, roughness: m.roughness,
    color: [+m.color.r.toFixed(3), +m.color.g.toFixed(3), +m.color.b.toFixed(3)],
  }));
  if (!mats.size) return { error: 'no material with "steel" in its name — nothing to A/B', found };

  const pipe = game.pipeline;
  const r = game.engine.renderer;
  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return s * 6.103515625e-5 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  };
  const scan = () => {
    const rt = pipe.rtA, W = rt.width, H = rt.height;
    const isHalf = rt.texture.type === THREE.HalfFloatType;
    const buf = isHalf ? new Uint16Array(W * H * 4) : new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    const dec = isHalf ? half : (v) => v / 255;
    const vals = [];
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      vals.push(0.2126 * dec(buf[p]) + 0.7152 * dec(buf[p + 1]) + 0.0722 * dec(buf[p + 2]));
    }
    vals.sort((a, b) => a - b);
    const q = (f) => +vals[Math.floor(vals.length * f)].toPrecision(3);
    const above = (t) => +(100 * vals.filter((v) => v > t).length / vals.length).toFixed(2);
    return {
      p05: q(0.05), p25: q(0.25), p50: q(0.50), p75: q(0.75), p95: q(0.95), p99: q(0.99),
      pctAbove: { '0.08': above(0.08), '0.15': above(0.15), '0.30': above(0.30), '0.60': above(0.60) },
    };
  };

  // FREEZE, AND LET TAA CONVERGE, OR THE CONTROL SWAMPS THE SIGNAL.
  //
  // The first version of this probe did neither, and its own `restored` arm —
  // identical settings to `asShipped` — differed by MORE than the dielectric
  // arm did (percent-above-0.08 of 37.26 against 34.00, versus the dielectric
  // arm's 35.82). The measurement was reading frame-to-frame drift: the sim
  // advances between arms, the dust bank scrolls, the mech idles, and TAA is
  // still blending an eight-frame history. An A/B whose control moves further
  // than its treatment says nothing at all, whichever way the treatment went.
  //
  // Freeze stops the world; `resetHistory` throws away the TAA accumulation so
  // each arm converges from scratch; the settle loop then runs enough frames
  // for a 0.925-blend history to actually get there.
  debug.freeze(true);
  const settle = async (frames = 24) => {
    game.pipeline?.resetHistory?.();
    for (let i = 0; i < frames; i++) {
      await new Promise((res) => requestAnimationFrame(res));
    }
  };
  const orig = [...mats.values()].map((m) => m.metalness);

  await settle();
  const asShipped = scan();

  // Dielectric arm. `needsUpdate` because metalness 0 vs non-zero can change
  // the compiled program, and a stale program would give a silently unchanged
  // frame — an A/B whose control cannot move.
  for (const m of mats.values()) { m.metalness = 0; m.needsUpdate = true; }
  await settle();
  const dielectric = scan();

  let i = 0;
  for (const m of mats.values()) { m.metalness = orig[i++]; m.needsUpdate = true; }
  await settle();
  const restored = scan();

  debug.freeze(false);

  return {
    materialsFound: found,
    displayCodeReference: '0.08->86  0.15->121  0.30->163  0.60->203',
    asShipped,
    dielectric,
    // THE CONTROL. `restored` has identical settings to `asShipped`, so the
    // difference between those two IS the noise floor, and no difference
    // between `asShipped` and `dielectric` smaller than it means anything.
    restored,
  };
})();
