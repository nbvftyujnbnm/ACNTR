// WHICH MESH IS THE PALE SHAPE IN THE `cliff` FRAME?
//
// Zeroing the distant buttes' whole vertex colour moved shots/aer_fix ->
// shots/bt_zero by 0.1 code values in the region the buttes appear to occupy,
// against a 2.2-code grain floor everywhere else. A control that cannot move is
// a broken probe, not a finding (CONTRACT.md), so before touching a coefficient
// again: rebuild the pose camera exactly, cast a THREE.Raycaster through the
// screen pixels the butte patches were measured at, and report the mesh name,
// range and world height that is actually there.
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

  // ---- what is at each screen pixel? ------------------------------------
  const W = 1920, H = 1080;
  const rc = new THREE.Raycaster();
  rc.far = 1e5;
  const ndc = new THREE.Vector2();
  const probe = (x, y) => {
    ndc.set((x / W) * 2 - 1, -((y / H) * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObject(game.scene, true);
    const h = hits.find((q) => q.object.visible && q.object.type === 'Mesh'
      && q.object.name !== 'ContainmentField'
      && !(q.object.material && q.object.material.transparent));
    if (!h) return { x, y, hit: 'SKY' };
    let n = h.object.name || '(unnamed)';
    for (let o = h.object.parent; o && !h.object.name; o = o.parent) if (o.name) { n = o.name + '/child'; break; }
    return {
      x, y, mesh: n,
      dist: Math.round(h.distance),
      wy: Math.round(h.point.y),
      mat: h.object.material?.name || h.object.material?.type,
    };
  };

  const pts = [
    [225, 483], [225, 540], [225, 610], [225, 675],
    [330, 500], [420, 520], [470, 620],
    [640, 580], [800, 755],
    [1150, 640], [1325, 572], [1325, 615], [1325, 663],
    [1500, 570], [1600, 720], [960, 900],
  ];

  const far = game.scene.getObjectByName('BoundaryFar');
  const col = far?.geometry?.attributes?.color;
  let cmin = 999, cmax = -999;
  if (col) for (let i = 0; i < col.count * 3; i++) {
    const v = col.array[i];
    if (v < cmin) cmin = v;
    if (v > cmax) cmax = v;
  }

  return {
    camY: +eye.y.toFixed(1),
    bearingDeg: Math.round((best.a * 180) / Math.PI),
    sunAzDeg: Math.round((sunA * 180) / Math.PI),
    boundaryFar: far ? {
      visible: far.visible, verts: col ? col.count : -1,
      colorMin: cmin, colorMax: cmax,
      normalized: col ? !!col.normalized : null,
      arrayType: col ? col.array.constructor.name : null,
    } : 'MISSING',
    pixels: pts.map(([x, y]) => probe(x, y)),
  };
})();
