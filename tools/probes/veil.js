// WHAT IS THE VEIL'S OWN RADIANCE WHERE THE DISTANT BUTTES ARE, AND HOW MUCH
// OF IT IS THE AERIAL TERM?
//
// The buttes measure BRIGHTER than the sky they are seen against (140.7 vs
// 137.5 in shots/aer_fix/cliff.png), and `BUTTE_ALBEDO` is verified near-inert,
// so the only lever left is the in-scatter itself. Before touching it: the
// composite's colour is a tau-weighted blend of THREE media, so scaling
// `aerialColor` moves the frame by the aerial term's SHARE, not by the whole
// factor. This probe reports that share.
//
// It reproduces `tools/poses/cliff.js`'s camera exactly, raycasts the pixels
// the butte patches are measured at, then evaluates COMPOSITE_FRAG's fog maths
// on the CPU from the LIVE uniform values — so the numbers are the shipped
// ones, not a restatement of them. `dustGain` is not modelled (it multiplies
// deck and band only, and averages 1.0 by construction); everything it would
// change is reported as `tDeck`/`tBand` so its effect is bounded and visible.
//
//   node tools/probe.mjs --file tools/probes/veil.js
(() => {
  const { debug, game, THREE } = window.__ACNTR__;

  debug.setHudVisible(false);
  debug.clearEnemies();

  // ---- reproduce tools/poses/cliff.js exactly ---------------------------
  const open = debug.placePlayerInOpenGround({ ahead: 70 });
  if (!open) debug.placePlayerOnGround(0, 40, 0, 1.0);
  debug.step(1.0);
  const p = game.player.root.position;
  const eye = new THREE.Vector3(p.x, p.y + 16, p.z);
  const sd = game.sky?.sunDirection;
  const sunA = sd ? Math.atan2(sd.z, sd.x) : 0;
  const dir = new THREE.Vector3();
  let best = null;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const off = Math.abs(((a - sunA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (off < Math.PI * 0.39) continue;
    dir.set(Math.cos(a), 0, Math.sin(a));
    const hit = game.physics.raycast(eye, dir, 520);
    const reach = hit ? hit.distance : 520;
    if (!best || reach > best.reach) best = { a, reach };
  }
  const ca = Math.cos(best.a), sa = Math.sin(best.a);
  debug.setCamera({ x: eye.x, y: eye.y, z: eye.z },
    { x: eye.x + ca * 500, y: 150, z: eye.z + sa * 500 }, 38);
  debug.step(0.6);

  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);

  // ---- the live composite uniforms --------------------------------------
  const pipe = game.pipeline;
  if (!pipe || !pipe.mComposite || !pipe.mComposite.uniforms.uAerialColor) {
    return { error: 'no pipeline.mComposite with uAerialColor' };
  }
  const U = pipe.mComposite.uniforms;
  const c3 = (c) => [c.r, c.g, c.b];
  const uni = {
    deckColor: c3(U.uDeckColor.value),
    bandColor: c3(U.uBandColor.value),
    aerialColor: c3(U.uAerialColor.value),
    fogSunColor: c3(U.uFogSunColor.value),
    fogDensity: U.uFogDensity.value,
    fogHeight: U.uFogHeight.value,
    fogFalloff: U.uFogFalloff.value,
    bandDensity: U.uBandDensity.value,
    bandHeight: U.uBandHeight.value,
    bandThickness: U.uBandThickness.value,
    aerialDensity: U.uAerialDensity.value,
    aerialRamp: U.uAerialRamp.value,
    fogStrength: U.uFogStrength.value,
    dustAmount: U.uDustAmount ? U.uDustAmount.value : 0,
    sunDir: c3({ r: U.uSunDir.value.x, g: U.uSunDir.value.y, b: U.uSunDir.value.z }),
    cameraPos: [cam.position.x, cam.position.y, cam.position.z],
  };

  // ---- COMPOSITE_FRAG's fog maths, on the CPU ---------------------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const deckTau = (y0, y1, dist) => {
    const a0 = clamp(-uni.fogFalloff * (y0 - uni.fogHeight), -9, 5);
    const dy = (y1 - y0) * uni.fogFalloff;
    const base = uni.fogDensity * Math.exp(a0) * dist;
    if (Math.abs(dy) < 1e-3) return base;
    return base * (1 - Math.exp(-clamp(dy, -9, 9))) / dy;
  };
  const bandRho = (y) => {
    const t = (y - uni.bandHeight) / Math.max(uni.bandThickness, 1e-3);
    return Math.exp(-t * t);
  };

  const rc = new THREE.Raycaster();
  rc.far = 1e5;
  const ndc = new THREE.Vector2();
  const W = 1920, H = 1080;

  const sample = (x, y) => {
    ndc.set((x / W) * 2 - 1, -((y / H) * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObject(game.scene, true);
    const h = hits.find((q) => q.object.visible && q.object.type === 'Mesh'
      && q.object.name !== 'ContainmentField'
      && !(q.object.material && q.object.material.transparent));
    const rayDir = rc.ray.direction.clone();
    const out = {
      x, y,
      rayDir: [+rayDir.x.toFixed(5), +rayDir.y.toFixed(5), +rayDir.z.toFixed(5)],
      elevDeg: +(Math.asin(rayDir.y) * 180 / Math.PI).toFixed(2),
    };
    if (!h) { out.mesh = 'SKY'; return out; }
    out.mesh = h.object.name || h.object.parent?.name || '(unnamed)';
    const dist = h.distance;
    const wy = h.point.y;
    out.dist = Math.round(dist);
    out.wy = Math.round(wy);

    const tDeck = deckTau(uni.cameraPos[1], wy, dist);
    const midY = (uni.cameraPos[1] + wy) * 0.5;
    const tBand = uni.bandDensity * dist *
      (bandRho(uni.cameraPos[1]) + 4 * bandRho(midY) + bandRho(wy)) / 6;
    const rn = dist / Math.max(uni.aerialRamp, 1);
    const rn2 = rn * rn;
    const tAir = uni.aerialDensity * dist * (rn2 / (1 + rn2));
    const sum = Math.max(tDeck + tBand + tAir, 1e-5);

    const inscat = [0, 1, 2].map((i) =>
      (uni.deckColor[i] * tDeck + uni.bandColor[i] * tBand + uni.aerialColor[i] * tAir) / sum);

    // Forward-scattering lobe, applied exactly as the shader does.
    const mu = Math.max(rayDir.x * uni.sunDir[0] + rayDir.y * uni.sunDir[1]
      + rayDir.z * uni.sunDir[2], 0);
    const g = 0.82, g2 = g * g;
    const den = Math.max(1 + g2 - 2 * g * mu, 1e-4);
    const hg = (1 - g2) / (12.566370614 * den * Math.sqrt(den));
    const w = clamp(hg * 0.55, 0, 0.85);
    const lit = inscat.map((v, i) => v * (1 - w) + uni.fogSunColor[i] * w);

    const tau = (tDeck + tBand + tAir) * uni.fogStrength;
    const f = clamp(1 - Math.exp(-tau), 0, 0.985);

    out.tDeck = +tDeck.toFixed(4);
    out.tBand = +tBand.toFixed(4);
    out.tAir = +tAir.toFixed(4);
    out.wAir = +(tAir / sum).toFixed(4);       // the aerial term's share of the colour
    out.veil = +f.toFixed(4);
    out.hgMix = +w.toFixed(4);
    out.inscat = lit.map((v) => +v.toFixed(5));
    out.inscatLum = +(0.2126 * lit[0] + 0.7152 * lit[1] + 0.0722 * lit[2]).toFixed(5);
    return out;
  };

  // Butte L is the pale shape at x 60-540; butte R sits behind the dune at
  // x 1080-1440. Sky samples are taken at the SAME rows to the side of each.
  const pts = [
    ['butteL cap', 250, 480], ['butteL mid', 250, 570], ['butteL toe', 250, 665],
    ['butteL far', 430, 500], ['butteL low', 120, 690],
    ['butteR cap', 1300, 570], ['butteR mid', 1300, 615], ['butteR toe', 1300, 660],
    ['sky above L', 250, 400], ['sky beside L', 700, 520], ['sky above R', 1300, 500],
    ['sky mid', 950, 340],
    ['plain mid', 700, 745], ['dune right', 1700, 660], ['ground near', 960, 980],
  ];

  return {
    camY: +eye.y.toFixed(1),
    bearingDeg: Math.round((best.a * 180) / Math.PI),
    sunAzDeg: Math.round((sunA * 180) / Math.PI),
    sunElDeg: sd ? +(Math.asin(sd.y) * 180 / Math.PI).toFixed(2) : null,
    uniforms: uni,
    samples: pts.map(([n, x, y]) => Object.assign({ name: n }, sample(x, y))),
  };
})();
