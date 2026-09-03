// WHAT IS ACTUALLY IN THE HDR BUFFER, AND WHAT THE BLOOM PREFILTER MAKES OF IT.
//
// Every tonal argument in this project so far has been made from 8-bit PNGs,
// which are the OUTPUT of exposure + AgX + grade and therefore cannot say
// whether a flat frame is a flat SCENE or a flat TRANSFER. This reads the
// scene-linear radiance back off `pipeline.rtScene` and the prefiltered bloom
// off `pipeline.bloomMips[0]`, so both halves of that question get a number.
//
// It sets up a gameplay-shaped frame first (enemies, firing, damage taken),
// because the emissive population is the point: mech vents, muzzle flashes and
// tracers only exist when the fight does.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  const r3 = (n) => (typeof n === 'number' && isFinite(n) ? +n.toFixed(3) : n);

  debug.setHudVisible(true);
  debug.unpause();
  debug.releaseCamera();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ rank: 0, ahead: 70 });
  if (!open) debug.placePlayerOnGround(0, 40, 0, 1.0);
  debug.step(0.5);
  const at = (a, s) => debug.aheadOfPlayer(a, s, new THREE.Vector3());
  const a = at(34, -12), b = at(46, 16), c = at(58, -2);
  debug.spawnEnemyOnGround('ac', a.x, a.z, 2, 5);
  debug.spawnEnemyOnGround('mt', b.x, b.z, 1, 0);
  debug.spawnEnemyOnGround('mt', c.x, c.z, 1, 0);
  debug.step(1.4);
  debug.hudState({ ap: 0.62, acs: 0.44, en: 0.38, lockProgress: 1 });
  debug.fireAll();
  debug.step(0.12);
  debug.fireAll();
  debug.step(0.2);

  // Let the live rAF loop draw, so the targets hold a real frame rather than
  // whatever the last stepped-but-unrendered state left in them.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  const pipe = game.pipeline || game.engine?.pipeline || window.__ACNTR__.pipeline;
  const r = game.engine.renderer;
  if (!pipe) return { error: 'no pipeline handle' };

  /* --- half-float decode ------------------------------------------------- */
  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return s * 6.103515625e-5 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  };

  /**
   * Radiance statistics for one render target. Returns percentiles of the
   * per-pixel max channel (the quantity the bloom prefilter thresholds on),
   * plus the population above each candidate threshold.
   */
  function scan(rt, label) {
    const W = rt.width, H = rt.height;
    const isHalf = rt.texture.type === THREE.HalfFloatType;
    const buf = isHalf ? new Uint16Array(W * H * 4) : new Uint8Array(W * H * 4);
    try {
      r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    } catch (e) {
      return { label, error: String(e).slice(0, 120), type: isHalf ? 'half' : 'byte' };
    }
    const dec = isHalf ? half : (v) => v / 255;
    const n = W * H;
    // Log2 histogram over [-12, +8] EV in half-EV bins, plus a linear tail.
    const BINS = 40, LO = -12, HI = 8;
    const hist = new Float64Array(BINS + 2);
    let mx = 0, sum = 0;
    const over = { t0_25: 0, t0_5: 0, t1_0: 0, t1_9: 0, t3_0: 0, t10: 0 };
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = Math.max(dec(buf[p]), dec(buf[p + 1]), dec(buf[p + 2]));
      if (!(v >= 0)) continue;
      sum += v;
      if (v > mx) mx = v;
      if (v > 0.25) over.t0_25++;
      if (v > 0.5) over.t0_5++;
      if (v > 1.0) over.t1_0++;
      if (v > 1.9) over.t1_9++;
      if (v > 3.0) over.t3_0++;
      if (v > 10.0) over.t10++;
      const e = v > 0 ? Math.log2(v) : LO - 1;
      const bi = e < LO ? 0 : e >= HI ? BINS + 1 : 1 + Math.floor(((e - LO) / (HI - LO)) * BINS);
      hist[bi]++;
    }
    const q = (f) => {
      let acc = 0;
      for (let i = 0; i < hist.length; i++) {
        acc += hist[i];
        if (acc >= f * n) {
          if (i === 0) return 0;
          if (i === BINS + 1) return Math.pow(2, HI);
          return +Math.pow(2, LO + ((i - 0.5) / BINS) * (HI - LO)).toPrecision(3);
        }
      }
      return mx;
    };
    const pct = (k) => +((100 * over[k]) / n).toFixed(4);
    return {
      label, size: `${W}x${H}`, type: isHalf ? 'half' : 'BYTE-NOT-HDR',
      mean: +sum.toExponential(2) / n ? +(sum / n).toPrecision(3) : 0,
      max: +mx.toPrecision(4),
      radiance_p: [0.5, 0.9, 0.99, 0.999, 0.9999].map(q),
      areaAbove: {
        '0.25': pct('t0_25'), '0.5': pct('t0_5'), '1.0': pct('t1_0'),
        '1.9': pct('t1_9'), '3.0': pct('t3_0'), '10': pct('t10'),
      },
    };
  }

  const scene = scan(pipe.rtScene, 'rtScene (HDR, pre-post)');
  const mip0 = scan(pipe.bloomMips[0], 'bloomMips[0] (prefiltered)');
  const mipN = scan(pipe.bloomMips[pipe.bloomMips.length - 1], 'bloomMips[last]');

  /* --- emissive census: what is SUPPOSED to bloom ------------------------- */
  const emis = new Map();
  const note = (m, where) => {
    if (!m || !m.emissive) return;
    const e = m.emissive;
    const inten = m.emissiveIntensity ?? 1;
    const peak = Math.max(e.r, e.g, e.b) * inten;
    if (peak < 0.02) return;
    const key = `${where}:${m.name || m.type}`;
    const prev = emis.get(key);
    if (!prev || peak > prev.peak) emis.set(key, { peak: +peak.toPrecision(3), inten: r3(inten) });
  };
  const walk = (root, where) => {
    if (!root) return;
    root.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isSprite) return;
      const mm = Array.isArray(o.material) ? o.material : [o.material];
      mm.forEach((m) => note(m, where));
    });
  };
  walk(game.player?.root, 'player');
  (game.enemies?.list || []).slice(0, 2).forEach((e, i) => walk(e.root, 'enemy' + i));

  const emisTop = [...emis.entries()]
    .sort((x, y) => y[1].peak - x[1].peak).slice(0, 12)
    .map(([k, v]) => `${k} peak=${v.peak} i=${v.inten}`);

  /* --- what is driving the red rim --------------------------------------- */
  const d = pipe._dyn;
  const hudVig = document.querySelector('.hud-vig');
  const stats = game.player?.stats;

  return {
    hdrFormat: pipe._floatRT ? 'HalfFloat' : 'BYTE (no HDR!)',
    exposure: pipe.params.exposure,
    bloom: { ...pipe.params.bloom, tint: undefined },
    scene, mip0, mipN,
    emissiveTop: emisTop,
    redRim: {
      uDamage: r3(pipe.mFinal.uniforms.uDamage.value),
      uChromatic: r3(pipe.mFinal.uniforms.uChromatic.value),
      uVignette: r3(pipe.mFinal.uniforms.uVignette.value),
      dyn_crit: r3(d.crit), dyn_hit: r3(d.hit), dyn_scan: r3(d.scan),
      apRatio: stats ? r3(stats.ap / stats.apMax) : null,
      hudHurt: r3(game.hud?.hurt),
      hudVigOpacity: hudVig ? hudVig.style.opacity : 'no element found',
    },
  };
})()
