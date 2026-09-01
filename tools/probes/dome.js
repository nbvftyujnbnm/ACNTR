// What is the large pale "dome" on the horizon of the combat_vfx frame, and is
// its own MATERIAL responsible for it reading as a light source? Reproduce the
// pose's camera, raycast a grid across the shape, and report every hit with the
// material numbers that could blow it out (roughness, metalness, emissive,
// albedo) rather than only the nearest one — the shape reads translucent, so
// the answer may be behind the first surface.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;

  // tools/poses/combat_vfx.js framing, without the VFX.
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();
  debug.placePlayerOnGround(0, 30, 0, 12);
  debug.step(0.4);
  debug.cameraRelativeToPlayer({ x: 14, y: 7, z: 24 }, { x: -3, y: 0, z: -20 }, 46);
  debug.step(0.05);

  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);

  const ray = new THREE.Raycaster();
  ray.far = 6000;
  const seen = new Map();

  const matInfo = (m) => {
    if (!m) return null;
    const c = m.color ? m.color.getHexString() : null;
    const e = m.emissive ? m.emissive.getHexString() : null;
    return {
      name: m.name || m.type,
      type: m.type,
      color: c,
      rough: m.roughness !== undefined ? +m.roughness.toFixed(3) : null,
      metal: m.metalness !== undefined ? +m.metalness.toFixed(3) : null,
      emissive: e,
      emissiveIntensity: m.emissiveIntensity !== undefined ? m.emissiveIntensity : null,
      envInt: m.envMapIntensity !== undefined ? m.envMapIntensity : null,
      transparent: !!m.transparent,
      opacity: m.opacity,
      blending: m.blending,
      hasMap: !!m.map,
      hasRoughMap: !!m.roughnessMap,
      vertexColors: !!m.vertexColors,
    };
  };

  // Grid across the pale shape: full-frame x 870..1370, y 190..430 of 1600x900.
  for (let sx = 0.56; sx <= 0.86; sx += 0.03) {
    for (let sy = 0.22; sy <= 0.47; sy += 0.03) {
      ray.setFromCamera(new THREE.Vector2(sx * 2 - 1, 1 - sy * 2), cam);
      const hits = ray.intersectObjects(game.scene.children, true);
      for (let i = 0; i < Math.min(hits.length, 3); i++) {
        const h = hits[i];
        const o = h.object;
        if (!o.visible) continue;
        const key = (o.name || o.uuid) + '|' + i;
        const rec = seen.get(key);
        if (rec) { rec.hits++; rec.dist = Math.min(rec.dist, +h.distance.toFixed(0)); continue; }
        seen.set(key, {
          order: i,
          name: o.name || '(unnamed)',
          objType: o.type,
          parent: o.parent && o.parent.name,
          hits: 1,
          dist: +h.distance.toFixed(0),
          point: [+h.point.x.toFixed(0), +h.point.y.toFixed(0), +h.point.z.toFixed(0)],
          mat: matInfo(o.material),
        });
      }
    }
  }

  return {
    camera: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)],
    fov: cam.fov,
    hits: [...seen.values()].sort((a, b) => a.dist - b.dist),
  };
})();
