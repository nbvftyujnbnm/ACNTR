// WHICH RENDERABLE DRAWS THE BLACK STREAK AND THE SALMON LOZENGE?
//
// shots/iter32/gameplay.png shows every in-flight round as a flat opaque
// salmon lozenge trailing a solid NEAR-BLACK tapered streak (measured: the
// streak reads 0,5,23 against a 130,118,110 sky). An additively blended
// tracer cannot be darker than its background, so one of these is not the
// mesh it looks like. This settles it by A/B: render the same frame with each
// projectile mesh hidden and attribute the changed pixels.
//
// Also prints the per-instance geometry so the apparent sizes in the picture
// can be checked against the metres the code asked for.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const out = {};
  const pm = game.projectiles;
  const cam = game.engine.camera;

  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  // ---- 1. does spawning a trailed projectile throw? -----------------------
  const open = debug.placePlayerInOpenGround({ rank: 0, ahead: 70 });
  out.open = open ? { clear: open.clear, rank: open.rank } : null;
  debug.step(0.5);
  const probeSpawn = (defLike, label) => {
    try {
      const before = pm.stats.spawned;
      const p = pm.spawn(defLike,
        game.player.root.position.clone().setY(game.player.root.position.y + 6),
        new THREE.Vector3(0, 0.4, -1).normalize(), game.player, null);
      return { label, ok: true, returned: !!p, spawnedDelta: pm.stats.spawned - before };
    } catch (err) {
      return { label, ok: false, error: String((err && err.message) || err) };
    }
  };
  out.spawnNoTrail = probeSpawn(
    { kind: 'bullet', speed: 300, life: 2, color: [4, 2, 1], radius: 0.12, width: 0.1, length: 3 },
    'bullet without trail');
  out.spawnWithTrail = probeSpawn(
    { kind: 'missile', speed: 120, life: 4, color: [4, 2.2, 0.9], radius: 0.3,
      width: 0.22, length: 1.5, trail: { color: [1.5, 1.0, 0.7], width: 0.34, rate: 55 } },
    'missile WITH trail block');

  // ---- 2. a real fight, framed like the gameplay pose ---------------------
  const at = (a, s) => debug.aheadOfPlayer(a, s, new THREE.Vector3());
  const a = at(34, -12), b = at(46, 16), c = at(58, -2), d = at(40, -22);
  debug.spawnEnemyOnGround('ac', a.x, a.z, 2, 5);
  debug.spawnEnemyOnGround('mt', b.x, b.z, 1, 0);
  debug.spawnEnemyOnGround('mt', c.x, c.z, 1, 0);
  debug.spawnEnemyOnGround('flyer', d.x, d.z, 1, 18);
  debug.step(1.6);
  debug.fireAll();
  debug.step(0.12);
  debug.fireAll();
  debug.step(0.2);

  cam.updateMatrixWorld();
  const _v = new THREE.Vector3(), _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const H = 1080;
  const pxPerM = (dist) => (1 / Math.max(dist, 0.01))
    / (2 * Math.tan((cam.fov * Math.PI / 180) / 2)) * H;

  const im = pm._im || {};
  const rows = {};
  for (const [name, mesh] of Object.entries(im)) {
    if (!mesh) continue;
    const n = mesh.count | 0;
    const info = { count: n, visible: !!mesh.visible, instances: [] };
    for (let i = 0; i < Math.min(n, 5); i++) {
      mesh.getMatrixAt(i, _m);
      _m.decompose(_v, _q, _s);
      const dist = _v.distanceTo(cam.position);
      const ndc = _v.clone().project(cam);
      const col = mesh.instanceColor
        ? [0, 1, 2].map((k) => +mesh.instanceColor.array[i * 3 + k].toFixed(2))
        : null;
      info.instances.push({
        sizeM: [+_s.x.toFixed(2), +_s.z.toFixed(2)],
        distM: +dist.toFixed(1),
        ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2)],
        onScreen: Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1,
        color: col,
        lenPx: +(_s.z * pxPerM(dist)).toFixed(1),
        widthPx: +(_s.x * pxPerM(dist)).toFixed(1),
      });
    }
    rows[name] = info;
  }
  out.instanced = rows;
  out.projectiles = {
    live: pm.liveCount,
    kinds: (() => {
      const k = {};
      for (let i = 0; i < pm.liveCount; i++) {
        const p = pm.live[i];
        k[p.kind] = (k[p.kind] || 0) + 1;
      }
      return k;
    })(),
    vfxBad: pm._vfxBad,
  };

  // ---- 3. A/B each mesh against the framebuffer ---------------------------
  const r = game.engine.renderer;
  const gl = r.getContext();
  const W = gl.drawingBufferWidth, HH = gl.drawingBufferHeight;
  const pq = game.pipeline.q;
  const saved = { taa: pq.taa, motionBlur: pq.motionBlur };
  const grain = game.pipeline.params.grain.amount;
  pq.taa = false; pq.motionBlur = false; game.pipeline.params.grain.amount = 0;
  // Freeze the sim so the two renders show the SAME instant.
  debug.freeze(true);

  const shoot = () => {
    for (let i = 0; i < 4; i++) game.pipeline.render(0, game.engine.clock.elapsed);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(W * HH * 4);
    gl.readPixels(0, 0, W, HH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const base = shoot();
  out.ab = {};
  for (const [name, mesh] of Object.entries(im)) {
    if (!mesh || !mesh.visible || !(mesh.count > 0)) continue;
    mesh.visible = false;
    const off = shoot();
    mesh.visible = true;
    let changed = 0, darkened = 0, brightened = 0, maxD = 0;
    let bx0 = 1e9, bx1 = -1, by0 = 1e9, by1 = -1;
    let sampleOn = null, sampleOff = null;
    for (let i = 0; i < W * HH; i++) {
      const o = i * 4;
      const dl = (base[o] + base[o + 1] + base[o + 2]) - (off[o] + off[o + 1] + off[o + 2]);
      const ad = Math.abs(dl) / 3;
      if (ad > 6) {
        changed++;
        if (dl < 0) darkened++; else brightened++;
        const x = i % W, y = (i / W) | 0;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (ad > maxD) {
          maxD = ad;
          sampleOn = [base[o], base[o + 1], base[o + 2]];
          sampleOff = [off[o], off[o + 1], off[o + 2]];
        }
      }
    }
    out.ab[name] = {
      changedPx: changed,
      darkerWithMesh: darkened,
      brighterWithMesh: brightened,
      maxDelta: +maxD.toFixed(1),
      withMesh: sampleOn,
      withoutMesh: sampleOff,
      bbox: changed ? [bx0, HH - by1, bx1 - bx0, by1 - by0] : null,
    };
  }
  // particles too — the lozenge may not be a projectile mesh at all
  const ps = game.vfx.ps;
  for (const [name, mesh] of [['particlesAdd', ps.batches[0].mesh], ['particlesAlpha', ps.batches[1].mesh]]) {
    if (!mesh || !mesh.visible) continue;
    mesh.visible = false;
    const off = shoot();
    mesh.visible = true;
    let changed = 0, darkened = 0, maxD = 0;
    for (let i = 0; i < W * HH; i++) {
      const o = i * 4;
      const dl = (base[o] + base[o + 1] + base[o + 2]) - (off[o] + off[o + 1] + off[o + 2]);
      const ad = Math.abs(dl) / 3;
      if (ad > 6) { changed++; if (dl < 0) darkened++; if (ad > maxD) maxD = ad; }
    }
    out.ab[name] = { changedPx: changed, darkerWithMesh: darkened, maxDelta: +maxD.toFixed(1) };
  }

  debug.freeze(false);
  pq.taa = saved.taa; pq.motionBlur = saved.motionBlur;
  game.pipeline.params.grain.amount = grain;
  return out;
})();
