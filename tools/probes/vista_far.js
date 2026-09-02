// What is actually drawing the far background of the vista frame, and what
// value does each piece land at? Reproduces `tools/poses/vista.js` exactly,
// then raycasts a grid over the horizon band and reports every hit with the
// material numbers that can blow a surface out (roughness, metalness, emissive,
// albedo, vertex colours) plus the world position and distance.
//
// The pale rounded shape at screen (0.77, 0.30) has been called "a large
// background dome blown to a flat white sheet"; this settles whether it is a
// structure dome, a distant butte, or the far plain.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;

  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(1.5);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.2);

  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);

  const ray = new THREE.Raycaster();
  ray.far = 8000;
  const seen = new Map();

  const matInfo = (m) => {
    if (!m) return null;
    return {
      n: m.name || m.type,
      col: m.color ? m.color.getHexString() : null,
      r: m.roughness !== undefined ? +m.roughness.toFixed(2) : null,
      mt: m.metalness !== undefined ? +m.metalness.toFixed(2) : null,
      em: m.emissive ? m.emissive.getHexString() : null,
      emI: m.emissiveIntensity ?? null,
      env: m.envMapIntensity ?? null,
      vc: !!m.vertexColors,
      map: !!m.map,
    };
  };

  // Screen grid over the whole horizon band of the frame.
  for (let sx = 0.02; sx <= 0.99; sx += 0.025) {
    for (let sy = 0.18; sy <= 0.42; sy += 0.02) {
      ray.setFromCamera(new THREE.Vector2(sx * 2 - 1, 1 - sy * 2), cam);
      const hits = ray.intersectObjects(game.scene.children, true);
      if (!hits.length) continue;
      const h = hits[0];
      const o = h.object;
      if (!o.visible) continue;
      const key = o.name || o.uuid;
      let rec = seen.get(key);
      if (!rec) {
        rec = {
          name: o.name || '(unnamed)', type: o.type,
          parent: o.parent && o.parent.name,
          n: 0, dmin: 1e9, dmax: 0,
          sxMin: 1, sxMax: 0, syMin: 1, syMax: 0,
          yMin: 1e9, yMax: -1e9,
          mat: matInfo(o.material),
        };
        seen.set(key, rec);
      }
      rec.n++;
      rec.dmin = Math.min(rec.dmin, h.distance);
      rec.dmax = Math.max(rec.dmax, h.distance);
      rec.sxMin = Math.min(rec.sxMin, sx); rec.sxMax = Math.max(rec.sxMax, sx);
      rec.syMin = Math.min(rec.syMin, sy); rec.syMax = Math.max(rec.syMax, sy);
      rec.yMin = Math.min(rec.yMin, h.point.y); rec.yMax = Math.max(rec.yMax, h.point.y);
    }
  }

  // The specific screen point the review complaint points at.
  const spot = [];
  for (const [sx, sy] of [[0.77, 0.28], [0.79, 0.31], [0.81, 0.30], [0.78, 0.34], [0.60, 0.46]]) {
    ray.setFromCamera(new THREE.Vector2(sx * 2 - 1, 1 - sy * 2), cam);
    const hits = ray.intersectObjects(game.scene.children, true).filter((h) => h.object.visible);
    spot.push({
      at: [sx, sy],
      stack: hits.slice(0, 3).map((h) => `${h.object.name || h.object.type}@${Math.round(h.distance)}m y=${Math.round(h.point.y)}`),
      mat: hits[0] ? matInfo(hits[0].object.material) : null,
    });
  }

  const rows = [...seen.values()]
    .sort((a, b) => b.n - a.n)
    .map((r) => `${r.name} [${r.type}] n=${r.n} d=${Math.round(r.dmin)}..${Math.round(r.dmax)} `
      + `sx ${r.sxMin.toFixed(2)}-${r.sxMax.toFixed(2)} sy ${r.syMin.toFixed(2)}-${r.syMax.toFixed(2)} `
      + `y ${Math.round(r.yMin)}..${Math.round(r.yMax)} ${JSON.stringify(r.mat)}`);

  return { camera: [cam.position.x, cam.position.y, cam.position.z], rows, spot };
})();
