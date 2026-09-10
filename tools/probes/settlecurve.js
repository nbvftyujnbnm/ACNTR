// HOW LONG DOES THIS RENDERER TAKE TO SETTLE, AND DOES IT SETTLE AT ALL?
//
// The masked deck A/B measured its two IDENTICAL control arms at 0.0234 and
// 0.0626 — a 2.7x climb with no treatment between them — and forcing the PMREM
// bake changed nothing, so the environment cube is not what moves. That drift
// is not a deck problem. It sits under EVERY A/B this project has ever run, and
// this file is full of conclusions drawn from two arms measured minutes apart.
//
// So stop guessing at the mechanism and photograph the curve. Freeze the sim,
// change NOTHING, and sample the same masked region every few frames for a long
// run. Three outcomes, each with a different consequence:
//
//   * It rises and PLATEAUS. Then the drift is warm-up, the plateau frame is
//     the settle requirement, and every A/B needs to start after it. Cheap fix,
//     and it retroactively explains the deck result.
//   * It rises WITHOUT plateauing. Then something is accumulating rather than
//     converging, which is a bug in its own right and a much bigger deal than
//     the deck.
//   * It is FLAT. Then the drift is caused by something the arms themselves do
//     — reading pixels back, touching materials — and the A/B harness is what
//     needs fixing, not the wait.
//
// Sampling the SAME mask the deck probe uses (emissive ID pass) so the two
// results are directly comparable; a metalness-1 surface is also the most
// sensitive probe available, since it has no diffuse term to dilute the change.
//
//   node tools/probe.mjs --file tools/probes/settlecurve.js
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
  debug.freeze(true);

  const mats = [];
  game.scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (mm && /steel/i.test(mm.name || '') && !mats.includes(mm)) mats.push(mm);
    }
  });
  if (!mats.length) return { error: 'no steel material found' };

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
  const readRTA = () => {
    const rt = pipe.rtA, W = rt.width, H = rt.height;
    const isHalf = rt.texture.type === THREE.HalfFloatType;
    const buf = isHalf ? new Uint16Array(W * H * 4) : new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    return { W, H, buf, dec: isHalf ? half : (v) => v / 255 };
  };
  const frame = () => new Promise((res) => requestAnimationFrame(res));

  // Mask via the emissive ID pass — exact at full resolution, one render, and
  // no raycasting (a 12 px ray grid over 3.1 M triangles never finished).
  const saved = mats.map((m) => ({ e: m.emissive ? m.emissive.clone() : null, i: m.emissiveIntensity }));
  for (const m of mats) { if (m.emissive) m.emissive.setRGB(0, 0, 60); m.emissiveIntensity = 1; }
  for (let i = 0; i < 6; i++) await frame();
  const id = readRTA();
  const mask = new Uint8Array(id.W * id.H);
  let maskN = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const b = id.dec(id.buf[p + 2]), g = id.dec(id.buf[p + 1]);
    if (b > 4 && b > g * 8) { mask[i] = 1; maskN++; }
  }
  mats.forEach((m, k) => { if (m.emissive && saved[k].e) m.emissive.copy(saved[k].e); m.emissiveIntensity = saved[k].i; });

  const maskedMean = () => {
    const { W, H, buf, dec } = readRTA();
    let s = 0, n = 0;
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      if (!mask[i]) continue;
      s += 0.2126 * dec(buf[p]) + 0.7152 * dec(buf[p + 1]) + 0.0722 * dec(buf[p + 2]);
      n++;
    }
    return n ? s / n : 0;
  };

  // The curve. Nothing is changed between samples — the only variable is time.
  const STEP = 6, SAMPLES = 22;
  const curve = [];
  let f = 0;
  for (let k = 0; k < SAMPLES; k++) {
    for (let i = 0; i < STEP; i++) { await frame(); f++; }
    curve.push({ frame: f, mean: +maskedMean().toPrecision(4) });
  }

  debug.freeze(false);

  const first = curve[0].mean, last = curve[curve.length - 1].mean;
  const tail = curve.slice(-5).map((c) => c.mean);
  const tailSpread = Math.max(...tail) - Math.min(...tail);
  return {
    maskPixels: maskN,
    note: 'Nothing is changed between samples. Any movement here is the renderer '
        + 'settling (or failing to), and it is the floor under every A/B in this project.',
    curve,
    firstToLastRatio: +(last / Math.max(first, 1e-9)).toFixed(2),
    tailSpreadAbsolute: +tailSpread.toPrecision(3),
    tailSpreadRelative: +(tailSpread / Math.max(last, 1e-9)).toFixed(4),
    reading: tailSpread / Math.max(last, 1e-9) < 0.02
      ? 'PLATEAUED — the tail is flat, so the rise is warm-up and the plateau frame is the settle requirement'
      : 'STILL MOVING at the end of the run — not a warm-up that waiting fixes',
  };
})();
