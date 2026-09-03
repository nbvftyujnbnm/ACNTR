// WHAT IS ACTUALLY DRAWING THE RED ARCS IN shots/iter31/gameplay.png?
//
// Two questions, both answered by printing numbers rather than by reasoning
// about the picture:
//   1. Does `ProjectileManager.spawn` survive a projectile that carries a
//      `trail` block? `_acquireTrail` is CALLED at line 557 and defined
//      nowhere in the file, so every missile and shell should be throwing.
//   2. For everything that IS on screen, what renderable is it, what colour
//      is it, and how wide does it draw in pixels?
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const out = {};
  const pm = game.projectiles;
  const cam = game.engine.camera;

  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ rank: 0, ahead: 70 });
  out.open = open ? { clear: open.clear, rank: open.rank } : null;
  debug.step(0.5);

  // ---- 1. does spawning a trailed projectile throw? -----------------------
  const { WEAPON_DEFS } = window.__ACNTR__.modules?.weapons || {};
  const probeSpawn = (defLike, label) => {
    try {
      const before = pm.stats.spawned;
      const p = pm.spawn(defLike, game.player.root.position.clone().setY(
        game.player.root.position.y + 6), new THREE.Vector3(0, 0.4, -1).normalize(),
        game.player, null);
      return { label, ok: true, returned: !!p, spawnedDelta: pm.stats.spawned - before };
    } catch (err) {
      return { label, ok: false, error: String(err && err.message || err) };
    }
  };
  out.spawnNoTrail = probeSpawn(
    { kind: 'bullet', speed: 300, life: 2, color: [4, 2, 1], radius: 0.12, width: 0.1, length: 3 },
    'bullet without trail');
  out.spawnWithTrail = probeSpawn(
    { kind: 'missile', speed: 120, life: 4, color: [4, 2.2, 0.9], radius: 0.3,
      width: 0.22, length: 1.5, trail: { color: [1.5, 1.0, 0.7], width: 0.34, rate: 55 } },
    'missile WITH trail block');

  // ---- 2. fire the real loadout and census what draws --------------------
  const at = (a, s) => debug.aheadOfPlayer(a, s, new THREE.Vector3());
  const a = at(34, -12);
  debug.spawnEnemyOnGround('ac', a.x, a.z, 2, 5);
  debug.step(0.4);
  debug.fireAll();
  debug.step(0.12);
  debug.fireAll();
  debug.step(0.35);

  const im = pm._im || {};
  cam.updateMatrixWorld();
  const _v = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const rows = {};
  for (const [name, mesh] of Object.entries(im)) {
    if (!mesh) continue;
    const n = mesh.count | 0;
    const info = { count: n, visible: !!mesh.visible, instances: [] };
    for (let i = 0; i < Math.min(n, 6); i++) {
      mesh.getMatrixAt(i, _m);
      _m.decompose(_v, _q, _s);
      const dist = _v.distanceTo(cam.position);
      const ndc = _v.clone().project(cam);
      const col = mesh.instanceColor
        ? [mesh.instanceColor.array[i * 3], mesh.instanceColor.array[i * 3 + 1],
           mesh.instanceColor.array[i * 3 + 2]].map((x) => +x.toFixed(2))
        : null;
      // apparent radius in px on a 720-tall viewport
      const radPx = (Math.max(_s.x, _s.y) / Math.max(dist, 0.01))
        / (2 * Math.tan((cam.fov * Math.PI / 180) / 2)) * 720;
      info.instances.push({
        scale: [+_s.x.toFixed(2), +_s.y.toFixed(2), +_s.z.toFixed(2)],
        distM: +dist.toFixed(1),
        ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2)],
        onScreen: Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1,
        color: col,
        widthPx: +(radPx * 2).toFixed(1),
      });
    }
    rows[name] = info;
  }
  out.instanced = rows;

  // ribbon trail batches
  const ps = game.vfx.ps;
  out.ribbons = {
    handles: game.vfx._trails.length,
    addCount: ps.trailAdd?.mesh?.geometry?.drawRange?.count ?? null,
    alphaCount: ps.trailAlpha?.mesh?.geometry?.drawRange?.count ?? null,
    addVisible: !!ps.trailAdd?.mesh?.visible,
    alphaVisible: !!ps.trailAlpha?.mesh?.visible,
  };

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
  return out;
})();
