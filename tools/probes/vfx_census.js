// Why does shots/*/combat_vfx.png contain almost no VFX, and why is the player's
// thruster plume invisible in the boost frame?
//
// Nothing here is inferred from a screenshot. It replays the two poses against
// the live scene, decodes the particle ring buffers the same way the vertex
// shader does (closed-form drag integration), projects every live particle into
// the capture camera, and then renders the frame twice — plumes on and plumes
// hidden — reading the back buffer both times to measure what the plume is
// actually worth in pixels.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const out = {};
  const ps = game.vfx.ps;
  const cam = game.engine.camera;
  const _p = new THREE.Vector3();

  const P_STRIDE = 32;

  /** Decode one particle slot exactly as particleVert does. */
  function decode(batch, i, time) {
    const a = batch.data;
    const o = i * P_STRIDE;
    const life = a[o + 7];
    const age = time - a[o + 3];
    if (life <= 0 || age < 0 || age >= life) return null;
    const k = a[o + 8];
    const g = -a[o + 9];
    let px, py, pz;
    if (k > 0.0015) {
      const e = Math.exp(-k * age);
      const vinfY = g / k;
      const v0x = a[o + 4], v0y = a[o + 5] - vinfY, v0z = a[o + 6];
      const f = (1 - e) / k;
      px = a[o] + v0x * f;
      py = a[o + 1] + v0y * f + vinfY * age;
      pz = a[o + 2] + v0z * f;
    } else {
      px = a[o] + a[o + 4] * age;
      py = a[o + 1] + a[o + 5] * age + 0.5 * g * age * age;
      pz = a[o + 2] + a[o + 6] * age;
    }
    const t = age / life;
    const ts = Math.pow(t, Math.max(a[o + 29], 0.05));
    const size = a[o + 12] * (1 - ts) + a[o + 13] * ts;
    const alpha = a[o + 19] * (1 - t) + a[o + 23] * t;
    const lum = (a[o + 16] * (1 - t) + a[o + 20] * t) * 0.2126
      + (a[o + 17] * (1 - t) + a[o + 21] * t) * 0.7152
      + (a[o + 18] * (1 - t) + a[o + 22] * t) * 0.0722;
    return { x: px, y: py, z: pz, age, life, t, size, alpha, lum, tile: a[o + 24] };
  }

  /** Census of both particle batches against the current camera. */
  function census(label) {
    const time = ps.time;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const rows = [];
    for (let b = 0; b < 2; b++) {
      const batch = ps.batches[b];
      let live = 0, onScreen = 0, behind = 0, offEdge = 0;
      let bright = 0, maxPx = 0, minDist = 1e9, maxDist = 0;
      const tiles = {};
      for (let i = 0; i < batch.high; i++) {
        const d = decode(batch, i, time);
        if (!d) continue;
        live++;
        _p.set(d.x, d.y, d.z);
        const dist = _p.distanceTo(cam.position);
        _p.project(cam);
        if (_p.z > 1 || _p.z < -1) { behind++; continue; }
        if (Math.abs(_p.x) > 1.05 || Math.abs(_p.y) > 1.05) { offEdge++; continue; }
        onScreen++;
        if (dist < minDist) minDist = dist;
        if (dist > maxDist) maxDist = dist;
        // apparent radius in pixels at a 720-tall viewport
        const px = (d.size / Math.max(dist, 0.01))
          / (2 * Math.tan((cam.fov * Math.PI / 180) / 2)) * 720;
        if (px > maxPx) maxPx = px;
        if (d.lum * d.alpha > 1.0 && px > 1.5) bright++;
        tiles[d.tile | 0] = (tiles[d.tile | 0] || 0) + 1;
      }
      rows.push({
        batch: b === 0 ? 'additive' : 'alpha',
        high: batch.high, live, onScreen, behindCam: behind, offEdge,
        brightAndBigEnough: bright,
        maxRadiusPx: +maxPx.toFixed(1),
        distM: live ? [+minDist.toFixed(1), +maxDist.toFixed(1)] : null,
        tiles,
      });
    }
    return {
      label,
      time: +time.toFixed(2),
      psLive: ps.live,
      particles: rows,
      rings: ps.rings.mesh.geometry.instanceCount,
      decals: ps.decals.mesh.geometry.instanceCount,
      shells: ps.shells.mesh.geometry.instanceCount,
      flames: ps._flameGeo.instanceCount,
      camera: {
        pos: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)],
        fov: cam.fov,
      },
    };
  }

  // ======================================================================
  // A — the combat_vfx pose, exactly as tools/poses/combat_vfx.js runs it
  // ======================================================================
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();
  debug.placePlayerOnGround(0, 30, 0, 12);
  debug.poseMech({ boosting: true, grounded: false, speed: 70 });

  const p = game.player.root.position.clone();
  const at = (dx, dy, dz) => new THREE.Vector3(p.x + dx, p.y + dy, p.z + dz);
  out.playerPos = [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)];

  const e = debug.spawnEnemy('ac', p.x - 6, p.y - 2, p.z - 18, 2);
  debug.spawnEnemy('mt', p.x + 16, p.y - 12, p.z - 30, 1);
  debug.step(1.0);

  debug.vfx('explosion', at(-14, -4, -34), 11);
  debug.step(0.10);
  debug.vfx('explosion', at(9, -9, -26), 6);
  debug.vfx('impact', at(-6, -1, -18), new THREE.Vector3(0, 0, 1), 'metal');
  debug.step(0.06);
  debug.fireAll();
  debug.vfx('impact', at(2, -8, -22), new THREE.Vector3(0, 1, 0), 'concrete');
  if (e) debug.vfx('staggerBurst', e);
  debug.step(0.05);
  debug.fireAll();
  debug.step(0.04);
  debug.cameraRelativeToPlayer({ x: 14, y: 7, z: 24 }, { x: -3, y: 0, z: -20 }, 46);
  debug.step(0.03);

  out.atPoseEnd = census('pose end (what the author intended to capture)');

  // The harness screenshots SETTLE ms of REAL time after the pose returns, and
  // the engine keeps ticking through it. Replay that.
  debug.step(0.3);
  out.after300ms = census('+300 ms');
  debug.step(0.8);
  out.afterSettle1100ms = census('+1100 ms — this is the frame that gets shot');
  debug.step(1.0);
  out.after2100ms = census('+2100 ms');

  // Where did the explosions land relative to the capture camera?
  const probePts = {
    explosionA: at(-14, -4, -34), explosionB: at(9, -9, -26),
    impactMetal: at(-6, -1, -18), impactConcrete: at(2, -8, -22),
    mech: p.clone(),
  };
  out.framing = {};
  for (const [k, v] of Object.entries(probePts)) {
    const dist = v.distanceTo(cam.position);
    const q = v.clone().project(cam);
    out.framing[k] = {
      distM: +dist.toFixed(1),
      ndc: [+q.x.toFixed(2), +q.y.toFixed(2)],
      onScreen: Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1 && q.z < 1,
    };
  }

  // ======================================================================
  // B — thruster plumes in the boost pose
  // ======================================================================
  debug.releaseCamera();
  debug.resetState();
  debug.placePlayerOnGround(0, 150, 0, 40);
  debug.holdKeys(['KeyW', 'Space', 'ControlLeft']);
  debug.step(2.2);

  const fd = ps.flameData;
  const n = ps._flameGeo.instanceCount;
  const plumes = [];
  cam.updateMatrixWorld();
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const pos = new THREE.Vector3(fd[o], fd[o + 1], fd[o + 2]);
    const dir = new THREE.Vector3(fd[o + 4], fd[o + 5], fd[o + 6]);
    const len = fd[o + 7];
    const tip = pos.clone().addScaledVector(dir, len);
    const dist = pos.distanceTo(cam.position);
    const a = pos.clone().project(cam);
    const b = tip.clone().project(cam);
    plumes.push({
      intensity: +fd[o + 9].toFixed(3),
      temp: +fd[o + 10].toFixed(3),
      radius: +fd[o + 8].toFixed(2),
      lengthM: +len.toFixed(2),
      distM: +dist.toFixed(1),
      nozzleNdc: [+a.x.toFixed(2), +a.y.toFixed(2)],
      tipNdc: [+b.x.toFixed(2), +b.y.toFixed(2)],
      // how long the plume draws on a 1280x720 viewport, in pixels
      lengthPx: +(Math.hypot((b.x - a.x) * 640, (b.y - a.y) * 360)).toFixed(1),
      radiusPx: +((fd[o + 8] / Math.max(dist, 0.01))
        / (2 * Math.tan((cam.fov * Math.PI / 180) / 2)) * 720).toFixed(1),
      // is the plume pointing at the camera, across it, or away?
      dotToCam: +dir.dot(cam.position.clone().sub(pos).normalize()).toFixed(2),
    });
  }
  out.plumes = { count: n, moveState: {
    grounded: !!game.player.moveState?.grounded,
    boosting: !!game.player.moveState?.boosting,
    assaultBoost: !!game.player.moveState?.assaultBoost,
    assaultRamp: +(game.player.moveState?.assaultRamp ?? 0).toFixed(2),
    speed: +(game.player.moveState?.speed ?? 0).toFixed(1),
  }, list: plumes };

  // --- what is the plume worth in pixels? -------------------------------
  const r = game.engine.renderer;
  const gl = r.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const buf = new Uint8Array(W * H * 4);
  const shoot = (visible) => {
    ps.flameInner.visible = visible;
    ps.flameOuter.visible = visible;
    // Several frames so TAA history holds this variant, then read the back buffer.
    for (let i = 0; i < 8; i++) game.pipeline.render(1 / 60, game.engine.clock.elapsed);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const on = shoot(true);
  const off = shoot(false);
  ps.flameInner.visible = true;
  ps.flameOuter.visible = true;
  let changed = 0, sumDelta = 0, maxDelta = 0;
  let bx0 = 1e9, bx1 = -1, by0 = 1e9, by1 = -1;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const d = Math.abs(on[o] - off[o]) + Math.abs(on[o + 1] - off[o + 1]) + Math.abs(on[o + 2] - off[o + 2]);
    if (d > 6) {
      changed++;
      sumDelta += d / 3;
      if (d / 3 > maxDelta) maxDelta = d / 3;
      const x = i % W, y = (i / W) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  out.plumeContribution = {
    viewport: [W, H],
    pixelsChanged: changed,
    fractionOfFrame: +(changed / (W * H)).toFixed(5),
    meanDeltaCodeValues: changed ? +(sumDelta / changed).toFixed(1) : 0,
    maxDeltaCodeValues: +maxDelta.toFixed(1),
    bboxPx: changed ? [bx0, by0, bx1 - bx0, by1 - by0] : null,
  };
  buf.fill(0);
  debug.releaseKeys();
  return out;
})();
