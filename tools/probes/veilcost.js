// WHAT DOES THE ATMOSPHERE COST THE FRAME'S TOP END?
//
// The recorded diagnosis (CONTRACT.md 2026-09-03) is that the frame "has no
// highlight at all" and that this is a scene/exposure PLACEMENT problem. The
// first half is confirmed on the corrected hero frame — 1% of it exceeds code
// 172 — but the second half does not survive a look at where in the chain the
// highlights disappear.
//
// `tools/probes/tonebloom.js` reads `rtScene`, which is PASS 1 and therefore
// PRE-FOG, and reports scene-linear percentiles of p50 0.105, p90 0.297,
// p99 0.595 with 10.9% of the frame above 0.25. Through the shipped transfer
// curve (tools/grade-model.mjs) 0.297 is display 163 and 0.595 is 203. So the
// SCENE is not placed low. The atmosphere is applied at PASS 6, into `rtA`,
// where COMPOSITE_FRAG does `color = mix(color, inscat, f)` — and `inscat`
// measured 0.19-0.32 linear across the cliff frame with `f` reaching 0.85 on
// distant geometry. A surface 85% veiled keeps 15% of its own radiance.
//
// That is a HYPOTHESIS, and `params.atmosphere.strength` is a live control that
// scales tau directly, so test it instead of arguing it: hold one camera, read
// `rtA` back at several strengths, and report what each one does to the
// distribution. Reading rtA rather than the PNG isolates the composite from
// TAA, bloom, the grade and the vignette.
//
// This is NOT a proposal to turn the atmosphere down. Aerial perspective is
// what carries depth in this level and the veil ramp was tuned against the
// sky's own radiance only yesterday. The point is to attribute the missing top
// end to a pass, so whoever fixes it changes the right number.
//
//   node tools/probe.mjs --file tools/probes/veilcost.js
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  // The hero framing, because that is the frame the complaint is about.
  debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.poseMech({ grounded: true, aimYaw: 0.25, aimPitch: -0.05, speed: 0 });
  debug.step(2.0);
  debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.step(0.4);

  const pipe = game.pipeline;
  const r = game.engine.renderer;
  if (!pipe?.rtA) return { error: 'no pipeline.rtA' };

  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return s * 6.103515625e-5 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  };

  const scan = (rt) => {
    const W = rt.width, H = rt.height;
    const isHalf = rt.texture.type === THREE.HalfFloatType;
    const buf = isHalf ? new Uint16Array(W * H * 4) : new Uint8Array(W * H * 4);
    try { r.readRenderTargetPixels(rt, 0, 0, W, H, buf); }
    catch (e) { return { error: String(e).slice(0, 120) }; }
    const dec = isHalf ? half : (v) => v / 255;
    const vals = [];
    // Luma, not max-channel: the question is about the frame's tonal range, and
    // max-channel over-reads any saturated colour.
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const v = 0.2126 * dec(buf[p]) + 0.7152 * dec(buf[p + 1]) + 0.0722 * dec(buf[p + 2]);
      if (v >= 0) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const q = (f) => +vals[Math.min(vals.length - 1, Math.floor(vals.length * f))].toPrecision(3);
    const above = (t) => +(100 * vals.filter((v) => v > t).length / vals.length).toFixed(2);
    return {
      p05: q(0.05), p50: q(0.50), p90: q(0.90), p95: q(0.95), p99: q(0.99),
      pctAbove: { '0.15': above(0.15), '0.30': above(0.30), '0.60': above(0.60) },
    };
  };

  // Render one frame at a given strength and read rtA back. `render` is the
  // real per-frame path, so this measures the shipped composite rather than a
  // reconstruction of it.
  const at = async (strength) => {
    pipe.params.atmosphere.strength = strength;
    // Two frames: TAA and the composite both read last frame's state, and one
    // frame after a uniform change is still blending the old one.
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { strength, ...scan(pipe.rtA) };
  };

  const orig = pipe.params.atmosphere.strength;
  const rows = [];
  for (const s of [1.0, 0.75, 0.5, 0.25, 0.0]) rows.push(await at(s));
  pipe.params.atmosphere.strength = orig;

  return {
    note: 'rtA is POST-composite (AO, SSR, fog) and PRE tonemap/grade, so these '
        + 'are scene-linear luma percentiles of exactly what the grade receives.',
    displayCodeReference: '0.08->86  0.15->121  0.30->163  0.60->203  1.20->234',
    restoredStrength: orig,
    rows,
  };
})();
