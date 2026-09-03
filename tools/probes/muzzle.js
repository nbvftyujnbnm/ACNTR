// WHERE IS THE MUZZLE FLASH, AND WHAT DOES THE ORDNANCE MEASURE ON SCREEN?
//
// Three questions in one boot, because a probe boot costs a minute:
//   1. The muzzle pose framed a booster nozzle, not a gun. Print the real
//      anchors — hardpoint world position, `WeaponSystem._ctx[slot].origin`
//      (hardpoint + muzzleOffset, which is what the flash is actually spawned
//      at, up to 2.2 m ahead of the anchor) — and where each lands in the NDC
//      of the camera the pose chooses.
//   2. Ordnance "has no motion streak": measure the drawn instances in PIXELS,
//      not metres. A 5.5 m tracer at 300 m is 5 px; a bloom halo around it is
//      round whatever the core's aspect ratio is.
//   3. Explosion structure: what the spawn actually contains, bucketed by
//      lifetime, so "bright core / shock ring / smoke column / debris" can be
//      graded against a list instead of an impression.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const out = {};
  const v3 = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];

  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();
  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 130 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.4);

  const P = game.player;
  const cam = game.engine.camera;
  const fwd = debug.forward();
  const right = debug.right();
  out.player = { root: v3(P.root.position), forward: v3(fwd), right: v3(right) };

  out.hardpoints = {};
  const _w = new THREE.Vector3();
  for (const k of Object.keys(P.hardpoints || {})) {
    const hp = P.hardpoints[k];
    if (!hp?.getWorldPosition) continue;
    hp.getWorldPosition(_w);
    out.hardpoints[k] = v3(_w);
  }

  // ---- fire, then read the context the flash was actually spawned at -------
  debug.fireAll();
  const ctxs = game.weapons?._ctx || {};
  out.fireCtx = {};
  for (const k of Object.keys(ctxs)) {
    const c = ctxs[k];
    if (!c?.origin) continue;
    out.fireCtx[k] = { origin: v3(c.origin), dir: v3(c.dir) };
  }
  out.slots = Object.entries(game.weapons?.slots || {})
    .filter(([, w]) => w)
    .map(([k, w]) => `${k}:${w.def?.id}@flash${w.def?.flashScale}/mz${w.def?.muzzleOffset?.z ?? 0}`);

  debug.step(0.030, 1 / 480);

  // ---- what the muzzle POSE frames ---------------------------------------
  const mz = new THREE.Vector3();
  P.hardpoints?.rArm?.getWorldPosition(mz);
  const poseCam = mz.clone().addScaledVector(fwd, 4.4).addScaledVector(right, 3.2);
  poseCam.y += 0.9;
  const poseLook = mz.clone().addScaledVector(fwd, -0.8).addScaledVector(right, -1.4);
  const probe = new THREE.PerspectiveCamera(34, 16 / 9, 0.1, 4000);
  probe.position.copy(poseCam);
  probe.lookAt(poseLook);
  probe.updateMatrixWorld();
  const ndc = (p) => {
    const q = p.clone().project(probe);
    return { ndc: [+q.x.toFixed(2), +q.y.toFixed(2)], onScreen: Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1 && q.z < 1 };
  };
  out.posesCamera = { pos: v3(poseCam), look: v3(poseLook), fov: 34 };
  out.poseFraming = { rArmAnchor: ndc(mz) };
  for (const k of Object.keys(out.fireCtx)) {
    out.poseFraming[k + 'Origin'] = ndc(new THREE.Vector3().fromArray(out.fireCtx[k].origin));
  }

  // ---- live additive particles: what the flash actually put in the world ---
  const ps = game.vfx.ps;
  const now = ps.time ?? game.vfx.time;
  const readBatch = (bi, maxAgeS) => {
    const b = ps.batches[bi];
    const a = b.data, S = 32;
    const rows = [];
    for (let i = 0; i < b.high; i++) {
      const o = i * S;
      const birth = a[o + 3], life = a[o + 7];
      if (life <= 0) continue;
      const age = now - birth;
      if (age < -0.001 || age > life || age > maxAgeS) continue;
      rows.push({
        p: [a[o], a[o + 1], a[o + 2]],
        life: +life.toFixed(3),
        age: +age.toFixed(3),
        s0: +a[o + 12].toFixed(2), s1: +a[o + 13].toFixed(2),
        tile: a[o + 24], stretch: +a[o + 25].toFixed(2),
        c0: [+a[o + 16].toFixed(1), +a[o + 17].toFixed(1), +a[o + 18].toFixed(1)],
        peak: +Math.max(a[o + 16], a[o + 17], a[o + 18]).toFixed(1),
      });
    }
    return rows;
  };
  const add = readBatch(0, 0.2);
  const alp = readBatch(1, 0.6);
  const summarise = (rows) => {
    const byTile = {};
    for (const r of rows) {
      const k = 't' + r.tile;
      byTile[k] = byTile[k] || { n: 0, life: [], peak: 0, size: 0, stretch: 0 };
      const e = byTile[k];
      e.n++; e.life.push(r.life);
      e.peak = Math.max(e.peak, r.peak);
      e.size = Math.max(e.size, r.s1);
      e.stretch = Math.max(e.stretch, r.stretch);
    }
    for (const k of Object.keys(byTile)) {
      const e = byTile[k];
      e.lifeMs = [Math.round(Math.min(...e.life) * 1000), Math.round(Math.max(...e.life) * 1000)];
      delete e.life;
    }
    return byTile;
  };
  out.flashParticles = {
    additive: add.length, alpha: alp.length,
    addByTile: summarise(add), alphaByTile: summarise(alp),
    onScreenInPose: add.filter((r) => ndc(new THREE.Vector3(r.p[0], r.p[1], r.p[2])).onScreen).length,
  };

  // ---- ordnance on screen, in pixels --------------------------------------
  debug.step(0.35);
  const pm = game.projectiles;
  cam.updateMatrixWorld();
  const H = 1080;
  const pxPerM = (d) => (1 / Math.max(d, 0.01)) / (2 * Math.tan((cam.fov * Math.PI / 180) / 2)) * H;
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  out.ordnance = {};
  for (const [name, mesh] of Object.entries(pm._im || {})) {
    if (!mesh || !(mesh.count > 0)) continue;
    const rows = [];
    for (let i = 0; i < Math.min(mesh.count, 4); i++) {
      mesh.getMatrixAt(i, _m);
      _m.decompose(_p, _q, _s);
      const d = _p.distanceTo(cam.position);
      const k = pxPerM(d);
      rows.push({
        distM: +d.toFixed(1),
        sizeM: [+_s.x.toFixed(2), +_s.z.toFixed(2)],
        px: [+(_s.x * k).toFixed(1), +(_s.z * k).toFixed(1)],
        aspect: +(_s.z / Math.max(_s.x, 1e-4)).toFixed(1),
      });
    }
    out.ordnance[name] = { count: mesh.count, sample: rows };
  }
  out.live = { n: pm.liveCount, kinds: (() => { const k = {}; for (let i = 0; i < pm.liveCount; i++) k[pm.live[i].kind] = (k[pm.live[i].kind] || 0) + 1; return k; })() };

  // ---- explosion structure -------------------------------------------------
  const before0 = ps.batches[0].head, before1 = ps.batches[1].head;
  const epos = P.root.position.clone().addScaledVector(fwd, 30).setY(P.root.position.y + 4);
  game.vfx.explosion(epos, 7);
  out.explosion = {
    additiveSpawned: (ps.batches[0].head - before0 + ps.batches[0].capacity) % ps.batches[0].capacity,
    alphaSpawned: (ps.batches[1].head - before1 + ps.batches[1].capacity) % ps.batches[1].capacity,
  };
  debug.step(0.001);
  const eAdd = readBatch(0, 0.05), eAlp = readBatch(1, 0.05);
  out.explosion.addByTile = summarise(eAdd);
  out.explosion.alphaByTile = summarise(eAlp);
  out.explosion.longestAlphaMs = eAlp.length ? Math.round(Math.max(...eAlp.map((r) => r.life)) * 1000) : 0;
  out.explosion.longestAddMs = eAdd.length ? Math.round(Math.max(...eAdd.map((r) => r.life)) * 1000) : 0;
  out.explosion.rings = (game.vfx.ps._rings?.head ?? game.vfx.ps.ringBatch?.head ?? null);

  return out;
})();
