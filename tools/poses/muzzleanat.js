// MUZZLE FLASH ANATOMY — the pose that found the harness bug, not a flash bug.
//
// ANSWERED. Read this before re-running it or re-opening the question.
//
// The setup: `addladder` proved the additive particle path is healthy (a raw
// BATCH_ADD sprite at radiance 1 peaks at display luma 181 against a background
// at 76, and radiance 8 and up clip at 254), while `muzzlestrip` — same
// positions, same frame geometry, five real `VFX.muzzleFlash` calls whose core
// sprite is authored at radiance 17 — produced a maximum of 105 across the
// entire row. That looked like a defect between `VFX.muzzleFlash` and the
// batch. IT IS NOT. This pose read the batch directly and found the real flash
// sitting at `maxEff` 13.2 against the raw control's 17: full authored radiance,
// emitting correctly.
//
// What was actually wrong was the harness, and this pose's own `timeScaleTraps`
// caught it: the pose released `debug.freeze(false)` on a 6 s `setTimeout`, and
// `page.screenshot` on this canvas takes 24-130 s. Every short-lived spot was
// dead by the shutter (`atRenderTime.alive` = 0) while the two `life: 30`
// controls read 241 and 252. Teardown now lives in `__POSE_CLEANUP__`, which
// capture.mjs calls AFTER the picture. `Debug.step` was also aging emissions by
// the previous call's `stepDt`; both are written up in CONTRACT.md, 2026-09-05.
//
// What is still open is a design question, not a bug: whether a 42 ms core and
// a 105 ms total READ at gameplay frame rates. Re-run this pose to answer it —
// it is the first version that can.
//
// The layout, in one frame:
//   1  raw core sprite, radiance 17, long life          — the control
//   2  raw core sprite, the flash core's EXACT authored numbers, long life
//   3  raw core sprite, the flash core's exact numbers INCLUDING life 0.042,
//      aged 4 ms — the arithmetic the strip claims to photograph
//   4  VFX.muzzleFlash at the shipped scale 0.7, aged 4 ms
//   5  VFX.muzzleFlash at scale 2.5, aged 4 ms
//   6  VFX.muzzleFlash at scale 0.7, age 0
// and then DUMPS every additive particle within 2 m of each spot with its
// age, t, size and the alpha the vertex shader will compute for it.
//
// No camera override — by choice, not necessity. The old claim that overrides
// "do not reach the render under freeze" was the same 6 s-timer bug:
// `releaseCamera()` fired before the shutter. DOF off.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ ahead: 40 });
  if (!open) debug.placePlayerOnGround(0, 60, 0, 0.05);
  debug.step(0.4);
  debug.setPass('motionBlur', false);
  debug.setPass('dof', false);
  debug.step(0.3);

  const p = game.player.root.position.clone();
  const ps = game.vfx && game.vfx.ps;
  const dir = debug.right().clone().normalize();

  const N = 6;
  const SPACING = 4.0;
  const half = (N - 1) / 2;
  const spots = [];
  for (let i = 0; i < N; i++) {
    const v = debug.aheadOfPlayer(-6, (i - half) * SPACING, new THREE.Vector3());
    v.y = p.y + 11;
    spots.push(v);
  }

  // The flash core's authored numbers, lifted verbatim from VFX.muzzleFlash.
  const S = 0.7;
  const CR = 1.0, CG = 0.78, CB = 0.42;
  const mixf = (a, b, k) => a + (b - a) * k;
  const core = {
    size0: 0.30 * S, size1: 0.62 * S,
    r0: mixf(CR, 1, 0.72) * 17, g0: mixf(CG, 1, 0.7) * 17, b0: mixf(CB, 1, 0.62) * 17,
    r1: CR * 3.5, g1: CG * 0.8 * 3.5, b1: CB * 0.5 * 3.5,
    a0: 1, a1: 0.4, fadeIn: 0, alphaCurve: 1.4, sizeCurve: 0.45, life: 0.042,
  };

  const rawCore = (spot, life) => {
    const d = ps.begin(0);
    d.pos.copy(spot);
    d.life = life;
    d.size0 = core.size0; d.size1 = core.size1;
    d.tile = 1; // TILE.CORE
    d.color0.setRGB(core.r0, core.g0, core.b0);
    d.color1.setRGB(core.r1, core.g1, core.b1);
    d.alpha0 = core.a0; d.alpha1 = core.a1;
    d.fadeIn = core.fadeIn; d.alphaCurve = core.alphaCurve; d.sizeCurve = core.sizeCurve;
    return ps.emit();
  };

  // 1 — plain bright control, long life.
  {
    const d = ps.begin(0);
    d.pos.copy(spots[0]);
    d.life = 30; d.size0 = 0.29; d.size1 = 0.29; d.tile = 1;
    d.color0.setRGB(17, 17, 17); d.color1.setRGB(17, 17, 17);
    d.alpha0 = 1; d.alpha1 = 1; d.fadeIn = 0; d.alphaCurve = 0.05;
    ps.emit();
  }
  // 2 — the flash core's numbers, long life.
  rawCore(spots[1], 30);
  // 3 — the flash core exactly, real life; aged below.
  rawCore(spots[2], core.life);
  // 4/5 — real calls, aged below.
  debug.vfx('muzzleFlash', spots[3].clone(), dir.clone(), 0.7);
  debug.vfx('muzzleFlash', spots[4].clone(), dir.clone(), 2.5);

  debug.step(0.004, 1 / 960);

  // 6 — real call, age 0 (emitted after the step).
  debug.vfx('muzzleFlash', spots[5].clone(), dir.clone(), 0.7);

  debug.freeze(true);

  // ---- WHO UNFREEZES IT? ---------------------------------------------------
  // ANSWERED, and the trap is what answered it: `timeScale` is 0 when this
  // pose returns and 1 by the time the shutter opens, with ~0.52 s of particle
  // time passing in between. The single recorded 0 -> 1 transition came from
  // THIS POSE'S OWN cleanup timer — `debug.freeze(false)` on a 6 s timeout,
  // against a screenshot that takes 24-130 s. Teardown now lives in
  // __POSE_CLEANUP__. The trap stays because it is cheap and it is the only
  // thing that can prove the freeze held.
  const eng = game.engine;
  const traps = [];
  let _ts = eng.timeScale;
  try {
    Object.defineProperty(eng, 'timeScale', {
      configurable: true,
      get() { return _ts; },
      set(v) {
        if (v !== _ts && traps.length < 6) {
          traps.push({
            to: v, from: _ts, frame: eng.clock.frame,
            stack: String(new Error().stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 700),
          });
        }
        _ts = v;
      },
    });
  } catch (e) { traps.push({ error: String(e).slice(0, 200) }); }

  // ---- read the batch, do not guess -----------------------------------------
  const dump = [];
  const b = ps && ps.batches && ps.batches[0];
  const smoothstep = (e0, e1, x) => {
    const k = Math.min(Math.max((x - e0) / Math.max(e1 - e0, 1e-9), 0), 1);
    return k * k * (3 - 2 * k);
  };
  if (b) {
    const a = b.data, ST = 32, now = ps.time;
    for (let i = 0; i < b.high; i++) {
      const o = i * ST;
      const life = a[o + 7];
      if (life <= 0) continue;
      const age = now - a[o + 3];
      if (age < -1e-4 || age > life) continue;
      let which = -1;
      for (let s = 0; s < N; s++) {
        const dx = a[o] - spots[s].x, dy = a[o + 1] - spots[s].y, dz = a[o + 2] - spots[s].z;
        if (dx * dx + dy * dy + dz * dz < 9) { which = s; break; }
      }
      if (which < 0) continue;
      const t = Math.min(Math.max(age / life, 0), 1);
      const fadeIn = smoothstep(0, Math.max(a[o + 26], 1e-4), t);
      const tail = Math.pow(Math.max(1 - t, 0), Math.max(a[o + 30], 0.05)) * smoothstep(0, 0.14, 1 - t);
      const alpha = (a[o + 19] + (a[o + 23] - a[o + 19]) * t) * fadeIn * tail;
      const ts = Math.pow(t, Math.max(a[o + 29], 0.05));
      const size = a[o + 12] + (a[o + 13] - a[o + 12]) * ts;
      dump.push({
        spot: which,
        tile: a[o + 24],
        age: +age.toFixed(4),
        life: +life.toFixed(4),
        t: +t.toFixed(3),
        size: +size.toFixed(3),
        rad: +Math.max(a[o + 16], a[o + 17], a[o + 18]).toFixed(1),
        alpha: +alpha.toFixed(3),
        eff: +(Math.max(a[o + 16], a[o + 17], a[o + 18]) * alpha).toFixed(2),
      });
    }
  }
  dump.sort((x, y) => (x.spot - y.spot) || (y.eff - x.eff));

  const cam = game.engine.camera;
  cam.updateMatrixWorld();
  const W = game.engine.width || 1920;
  const H = game.engine.height || 1080;
  const _v = new THREE.Vector3();
  const screen = spots.map((v) => {
    _v.copy(v).project(cam);
    return [Math.round((_v.x * 0.5 + 0.5) * W), Math.round((-_v.y * 0.5 + 0.5) * H)];
  });

  const perSpot = [];
  for (let s = 0; s < N; s++) {
    const rows = dump.filter((r) => r.spot === s);
    perSpot.push({
      spot: s,
      n: rows.length,
      maxEff: rows.length ? rows[0].eff : 0,
      top: rows.slice(0, 3),
    });
  }

  // ---- AND READ IT AGAIN AT RENDER TIME ------------------------------------
  // The dump above is a POSE-TIME snapshot. The harness renders the captured
  // frame tens of seconds after the pose script returns, and every
  // conclusion about a 40 ms effect depends on whether `debug.freeze(true)`
  // actually holds the particle clock across that gap. `__POSE_NOTE__` is read
  // AFTER the screenshot, so a field rewritten every late-update reports the
  // state the shutter actually saw.
  const liveScan = () => {
    if (!b) return null;
    const a = b.data, ST = 32, now = ps.time;
    const best = new Array(N).fill(0);
    const nAlive = new Array(N).fill(0);
    for (let i = 0; i < b.high; i++) {
      const o = i * ST;
      const life = a[o + 7];
      if (life <= 0) continue;
      const age = now - a[o + 3];
      if (age < -1e-4 || age > life) continue;
      let which = -1;
      for (let s = 0; s < N; s++) {
        const dx = a[o] - spots[s].x, dy = a[o + 1] - spots[s].y, dz = a[o + 2] - spots[s].z;
        if (dx * dx + dy * dy + dz * dz < 9) { which = s; break; }
      }
      if (which < 0) continue;
      nAlive[which]++;
      const t = Math.min(Math.max(age / life, 0), 1);
      const fadeIn = smoothstep(0, Math.max(a[o + 26], 1e-4), t);
      const tail = Math.pow(Math.max(1 - t, 0), Math.max(a[o + 30], 0.05)) * smoothstep(0, 0.14, 1 - t);
      const alpha = (a[o + 19] + (a[o + 23] - a[o + 19]) * t) * fadeIn * tail;
      const eff = Math.max(a[o + 16], a[o + 17], a[o + 18]) * alpha;
      if (eff > best[which]) best[which] = eff;
    }
    const e = game.engine;
    return {
      psTime: +ps.time.toFixed(4),
      maxEff: best.map((v) => +v.toFixed(2)),
      alive: nAlive,
      timeScale: e.timeScale,
      clockDt: +e.clock.dt.toFixed(4),
      clockRaw: +e.clock.raw.toFixed(4),
      clockElapsed: +e.clock.elapsed.toFixed(4),
      clockFrame: e.clock.frame,
      hitstop: +(e._hitstop || 0).toFixed(4),
    };
  };

  window.__POSE_NOTE__ = {
    diagnostic: 'flash anatomy — raw sprite vs real VFX.muzzleFlash, batch read directly',
    layout: [
      '0 raw core radiance 17 life 30',
      '1 raw flash-core numbers life 30',
      '2 raw flash-core numbers life 0.042 aged 4 ms',
      '3 VFX.muzzleFlash scale 0.7 aged 4 ms',
      '4 VFX.muzzleFlash scale 2.5 aged 4 ms',
      '5 VFX.muzzleFlash scale 0.7 age 0',
    ],
    screenPx: screen,
    metresFromLens: spots.map((v) => +v.distanceTo(cam.position).toFixed(1)),
    cameraActual: cam.position.toArray().map((n) => +n.toFixed(1)),
    psTime: ps ? +ps.time.toFixed(4) : null,
    batchHigh: b ? b.high : null,
    instanceCount: b ? b.geometry.instanceCount : null,
    liveParticles: game.vfx ? game.vfx.liveParticles : null,
    dropped: ps && ps.stats ? ps.stats.dropped : null,
    spawned: ps && ps.stats ? ps.stats.spawned : null,
    perSpot,
    atPoseTime: liveScan(),
    timeScaleTraps: traps,
    atRenderTime: null,
    frameCount: 0,
    passes: debug.passes(),
  };

  game.engine.addLateUpdate(() => {
    const n = window.__POSE_NOTE__;
    if (!n) return;
    n.frameCount++;
    n.atRenderTime = liveScan();
  });

  window.__POSE_CLEANUP__ = () => {
    debug.freeze(false);
    debug.setPass('motionBlur', true);
    debug.setPass('dof', true);
  };
})();
