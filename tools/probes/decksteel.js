// SHOULD THE LARGE DECK PLATE BE BARE ALLOY OR AN OXIDISED DIELECTRIC?
//
// Measured 2026-09-06: the walkable deck is the `steel` family at metalness 1,
// a conductor has no diffuse lobe, and those surfaces render at display 13-55
// from rough environment specular alone. This file already documents that exact
// failure mode ("a deck full of hardware rendered as one black shape with a
// plastic sheen") and the fix that moved paint, primer, rust and concrete to
// dielectric while keeping `steel` metallic as "the one family that is
// genuinely bare alloy".
//
// THE FIRST VERSION OF THIS PROBE COULD NOT ANSWER IT, and said so: whole-frame
// percentiles gave a treatment effect of 0.03 points against a 6.14-point noise
// floor. Two things were wrong and both are fixed here.
//
//   1. WRONG INSTRUMENT. A change confined to particular SURFACES cannot be
//      read off a whole-frame histogram — the deck is a modest share of this
//      framing, so even a large change to it is diluted below the noise. This
//      version builds a PIXEL MASK of the steel surfaces and measures only
//      those. The mask comes from an emissive ID pass, not from raycasting: a
//      12 px ray grid over a 3.1 M triangle scene did not finish inside the
//      probe timeout, while flashing the steel materials to a huge blue
//      emissive costs one render and marks every steel pixel exactly, at full
//      resolution, regardless of shadow or occlusion.
//   2. WRONG ARM ORDER. The noise here is not jitter, it is a monotonic warm-up
//      (most likely the PMREM bake, `bakeInterval: 7.0`, still converging), so
//      a single control arm measured first is guaranteed to understate it.
//      Arms run shipped -> dielectric -> shipped and the TWO SHIPPED ARMS
//      BRACKET the treatment: their difference is the drift over the run, and
//      the treatment is compared against the mean of the two.
//
// This probe does not make the art call. `steel` is right for machinery,
// railings and pipes — they are what catches a glint. The question is only
// whether a large horizontal plate under a 13.5-degree sun is bare alloy.
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
  debug.freeze(true);

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
  }));
  if (!mats.size) return { error: 'no material named steel — nothing to A/B', found };

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
    const dec = isHalf ? half : (v) => v / 255;
    return { W, H, buf, dec };
  };
  // FORCE THE ENVIRONMENT BAKE BEFORE EVERY ARM.
  //
  // The masked run without this measured its two IDENTICAL control arms at mean
  // 0.0234 and 0.0626 — a 2.7x climb across the run, swamping a treatment of
  // 0.0096. That is not jitter and it is not TAA. The deck is METALNESS 1, so
  // its entire appearance is environment specular: it is a mirror of the PMREM
  // cube, and nothing else. `Sky` re-bakes that cube on a 7 s timer
  // (`bakeInterval`), so a probe that runs three arms across a few seconds is
  // measuring the bake converging, not the material.
  //
  // This is worth knowing well beyond this probe: ANY measurement of a metallic
  // surface in this project is a measurement of the env map's state at that
  // moment. Baking explicitly before each arm makes every arm see the same
  // cube, which is what makes them comparable at all.
  const settle = async (frames = 20) => {
    game.sky?.bake?.();
    pipe.resetHistory?.();
    for (let i = 0; i < frames; i++) await new Promise((res) => requestAnimationFrame(res));
  };

  // ---- the mask: flash steel to a huge blue emissive, render, read back ----
  const savedEmissive = [...mats.values()].map((m) => ({
    e: m.emissive ? m.emissive.clone() : null, i: m.emissiveIntensity,
  }));
  for (const m of mats.values()) {
    if (m.emissive) m.emissive.setRGB(0, 0, 60);
    m.emissiveIntensity = 1;
  }
  await settle(8);
  const idPass = readRTA();
  const mask = new Uint8Array(idPass.W * idPass.H);
  let maskN = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const b = idPass.dec(idPass.buf[p + 2]);
    const g = idPass.dec(idPass.buf[p + 1]);
    // Blue enormously over green is only the marker: nothing in this ochre
    // level is remotely blue-dominant at this magnitude.
    if (b > 4 && b > g * 8) { mask[i] = 1; maskN++; }
  }
  let si = 0;
  for (const m of mats.values()) {
    const s = savedEmissive[si++];
    if (m.emissive && s.e) m.emissive.copy(s.e);
    m.emissiveIntensity = s.i;
  }

  // GUARD THE MASK AGAINST A RESIZE. `probe.mjs` now pins the resolution, but a
  // mask read against a buffer that changed size is the failure that produced a
  // 2.8x staircase and two wrong explanations for it, so the invariant is
  // asserted here rather than assumed upstream.
  const maskDims = { W: idPass.W, H: idPass.H };
  const maskedStats = () => {
    const { W, H, buf, dec } = readRTA();
    if (W !== maskDims.W || H !== maskDims.H) {
      throw new Error(`mask built at ${maskDims.W}x${maskDims.H} but the render target is now ${W}x${H} — adaptive resolution resized it mid-probe and every masked number after this point would be wrong`);
    }
    const vals = [];
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      if (!mask[i]) continue;
      vals.push(0.2126 * dec(buf[p]) + 0.7152 * dec(buf[p + 1]) + 0.0722 * dec(buf[p + 2]));
    }
    if (!vals.length) return { error: 'mask empty' };
    vals.sort((a, b) => a - b);
    const q = (f) => +vals[Math.min(vals.length - 1, Math.floor(vals.length * f))].toPrecision(3);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return {
      n: vals.length, mean: +mean.toPrecision(3),
      p05: q(0.05), p25: q(0.25), p50: q(0.50), p75: q(0.75), p95: q(0.95),
    };
  };

  // IS THIS MASK DECK, OR IS IT MACHINERY? It decides the SHAPE of any fix.
  // `steel` is right for pipes, railings and machine housings — a conductor is
  // what catches a glint — so a global flip is only defensible if the family is
  // overwhelmingly being used for large horizontal plate. Sample the mask and
  // classify by world normal: |n.y| > 0.7 is floor or ceiling, the rest is
  // upright. Sampling a few hundred pixels rather than raycasting the grid,
  // because a dense ray grid over 3.1 M triangles does not finish in time.
  const orientation = (() => {
    const rc = new THREE.Raycaster();
    rc.far = 600;
    const ndc = new THREE.Vector2();
    const cam = game.engine.camera;
    cam.updateMatrixWorld(true);
    const idx = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
    let horiz = 0, upright = 0, missed = 0;
    const N = Math.min(300, idx.length);
    const nm = new THREE.Matrix3();
    for (let k = 0; k < N; k++) {
      const i = idx[Math.floor((k + 0.5) * idx.length / N)];
      const px = i % idPass.W, py = Math.floor(i / idPass.W);
      // The ID buffer is bottom-up; NDC y is bottom-up too, so no flip here.
      ndc.set((px / idPass.W) * 2 - 1, (py / idPass.H) * 2 - 1);
      rc.setFromCamera(ndc, cam);
      const h = rc.intersectObject(game.scene, true).find((q) => q.object.visible && q.face);
      if (!h) { missed++; continue; }
      const n = h.face.normal.clone()
        .applyNormalMatrix(nm.getNormalMatrix(h.object.matrixWorld)).normalize();
      if (Math.abs(n.y) > 0.7) horiz++; else upright++;
    }
    const hit = horiz + upright;
    return {
      sampled: N, missed,
      horizontalPct: hit ? +(100 * horiz / hit).toFixed(1) : null,
      uprightPct: hit ? +(100 * upright / hit).toFixed(1) : null,
    };
  })();

  const orig = [...mats.values()].map((m) => m.metalness);
  // No `needsUpdate`: metalness and emissive are UNIFORMS on
  // MeshStandardMaterial, not shader defines, so flagging them only forces a
  // recompile — which under SwiftShader costs minutes and changes nothing.
  const setMetal = (v) => {
    for (const m of mats.values()) m.metalness = v;
  };

  await settle();
  const shippedA = maskedStats();
  setMetal(0);
  await settle();
  const dielectric = maskedStats();
  let i2 = 0;
  for (const m of mats.values()) m.metalness = orig[i2++];
  await settle();
  const shippedB = maskedStats();

  debug.freeze(false);

  const driftMean = shippedB.mean - shippedA.mean;
  const ctrlMean = (shippedA.mean + shippedB.mean) / 2;
  return {
    materialsFound: found,
    maskPixels: maskN,
    maskOrientation: orientation,
    maskFractionOfFrame: +(100 * maskN / (idPass.W * idPass.H)).toFixed(2),
    displayCodeReference: '0.02->32  0.04->54  0.08->86  0.15->121  0.30->163',
    shippedA, dielectric, shippedB,
    // The two shipped arms bracket the treatment, so their gap IS the drift.
    driftBetweenControlArms: +driftMean.toPrecision(3),
    treatmentVsControlMean: +(dielectric.mean - ctrlMean).toPrecision(3),
    separable: Math.abs(dielectric.mean - ctrlMean) > 3 * Math.abs(driftMean),
  };
})();
