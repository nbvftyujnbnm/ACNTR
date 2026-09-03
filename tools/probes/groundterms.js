// WHICH TERM IN THE TERRAIN SHADER MAKES THE LIT GROUND BIMODAL?
//
// Measured on shots/L48/ground.png, a 360x220 patch of SUNLIT dune at 20-40 m
// came back mean 70.9 / sd 49.2, with 41.7% of it under code 40 and a tenth
// percentile (14) BELOW the tenth percentile of the deep-shadow ground beside
// it (15). That is not texture, it is holes. Cutting the near-field relief term
// by 4.8x moved it by half a code value, so the guess was wrong and the honest
// move is to hide the candidates one at a time and read the framebuffer — the
// method the tracer probe already established for "an element you cannot name".
//
// Renders a steeply down-looking view where every pixel is ground, into a small
// render target, once per uniform setting, and reports the coefficient of
// variation (sd / mean). CV is the scale-free form of "bimodal" and survives
// the fact that this render bypasses the post stack, so the absolute code
// values here are NOT comparable with a capture — only with each other.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();

  // BARE TERRAIN, the way tools/poses/ground.js finds it. The first version of
  // this probe used placePlayerInOpenGround, which SCORES SPAWN POINTS and
  // therefore prefers megastructure decks — so it pointed the lens at a roof,
  // every case came back identical to five significant figures, and the probe
  // read as "none of these terms does anything". A control that cannot move is
  // a broken probe, not a finding: `everything=0` MUST differ from baseline or
  // the measurement is not looking at the material.
  const level = game.level, ph = game.physics;
  const R = (level?.arenaRadius ?? 400) * 0.82;
  const bare = (x, z) => {
    const t = level.heightAt(x, z), g = ph.groundHeight(x, z);
    return isFinite(t) && isFinite(g) && Math.abs(g - t) < 1.5;
  };
  let best = null;
  for (let i = 0; i < 700; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);
    const rr = R * Math.sqrt(((i * 0.6180339887) % 1));
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    if (!bare(x, z)) continue;
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let j = 0; j < 9; j++) {
      const ox = ((j % 3) - 1) * 13, oz = (Math.floor(j / 3) - 1) * 13;
      if (!bare(x + ox, z + oz)) { ok = false; break; }
      const h = level.heightAt(x + ox, z + oz);
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
    if (!ok) continue;
    const s = -Math.abs((mx - mn) - 3.2);
    if (!best || s > best.s) best = { x, z, s };
  }
  if (!best) best = { x: 0, z: 150 };
  debug.placePlayerOnGround(best.x, best.z, 0);
  debug.step(0.5);

  const p = game.player.root.position;
  // Steeply down, so the frame is ground at 25-45 m and nothing else can get
  // into the statistics.
  debug.setCamera({ x: p.x, y: p.y + 34, z: p.z },
    { x: p.x + 26, y: p.y, z: p.z + 10 }, 40);
  debug.step(0.05);

  const mesh = game.level?.terrainMesh;
  const u = mesh?.material?.userData?.uniforms;
  if (!u) return { error: 'no terrain uniforms' };

  const renderer = game.engine.renderer;
  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);

  const W = 384, H = 216;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    colorSpace: THREE.NoColorSpace,
  });
  const buf = new Uint8Array(W * H * 4);

  const measure = () => {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(game.scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    renderer.setRenderTarget(prev);
    const lum = [];
    let sum = 0;
    for (let i = 0; i < W * H; i++) {
      const L = 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2];
      lum.push(L); sum += L;
    }
    lum.sort((a, b) => a - b);
    const mean = sum / lum.length;
    let v = 0;
    for (const L of lum) v += (L - mean) * (L - mean);
    const sd = Math.sqrt(v / lum.length);
    const q = (t) => lum[Math.floor(t * (lum.length - 1))];
    return {
      mean: +mean.toFixed(1), sd: +sd.toFixed(1), cv: +(sd / Math.max(mean, 1e-3)).toFixed(3),
      p10: q(0.10) | 0, p50: q(0.50) | 0, p90: q(0.90) | 0,
      underHalfMean: +(lum.filter((L) => L < mean * 0.5).length / lum.length * 100).toFixed(1),
    };
  };

  // Snapshot every value this probe touches, so each case is one change off the
  // baseline and the last case restores it.
  const S = {
    nrm: u.uNrmStrength.value,
    detail: u.uDetail.value.clone(),
    ripple: u.uRipple.value.clone(),
    scales: u.uScales.value.clone(),
  };
  const restore = () => {
    u.uNrmStrength.value = S.nrm;
    u.uDetail.value.copy(S.detail);
    u.uRipple.value.copy(S.ripple);
    u.uScales.value.copy(S.scales);
  };

  const cases = [
    ['baseline', () => {}],
    ['uNrmStrength=0', () => { u.uNrmStrength.value = 0; }],
    ['detailRelief=0', () => { u.uDetail.value.w = 0; }],
    ['detailContrast=0', () => { u.uDetail.value.z = 0; }],
    ['detail both=0', () => { u.uDetail.value.z = 0; u.uDetail.value.w = 0; }],
    ['rippleRelief=0', () => { u.uRipple.value.z = 0; }],
    ['rippleAlbedo=0', () => { u.uRipple.value.w = 0; }],
    ['nrm+detail=0', () => { u.uNrmStrength.value = 0; u.uDetail.value.z = 0; u.uDetail.value.w = 0; }],
    ['everything=0', () => {
      u.uNrmStrength.value = 0; u.uDetail.value.z = 0; u.uDetail.value.w = 0;
      u.uRipple.value.z = 0; u.uRipple.value.w = 0;
    }],
  ];

  const out = { pose: { x: +p.x.toFixed(1), z: +p.z.toFixed(1) }, cases: {} };
  for (const [name, fn] of cases) {
    restore();
    fn();
    out.cases[name] = measure();
  }
  restore();
  rt.dispose();
  return out;
})();
