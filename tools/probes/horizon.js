// Which boundary layer owns which screen column of the vista frame, and how far
// away is it.
//
// The vista's background is built from three separate meshes at three depth
// bands — `Boundary` (the mesa ring, ~500-900 m), `BoundaryFar` (the free
// standing buttes at 0.95-1.9 km, welded together with the far plain), and the
// terrain. "Aerial perspective is not separating the ridges" is a claim about
// how those bands land in DISPLAY value, and it cannot be checked without first
// knowing which pixels belong to which band — the buttes and the ring are one
// material and one colour ramp, so a screenshot alone cannot tell them apart.
//
// Output is per-column: the silhouette top row (as a screen fraction), the mesh
// that owns it, and its distance. Feed the columns into `tools/detail.mjs
// --rect` to read the value those metres actually rendered at.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;

  // Reproduce tools/poses/vista.js exactly.
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(1.5);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.2);

  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = 9000;
  const v2 = new THREE.Vector2();

  const hitAt = (sx, sy) => {
    v2.set(sx * 2 - 1, 1 - sy * 2);
    ray.setFromCamera(v2, cam);
    const hits = ray.intersectObjects(game.scene.children, true);
    for (const h of hits) {
      if (!h.object.visible) continue;
      const n = h.object.name || h.object.type;
      // Skip the transparent shells; they are not what the eye reads as a ridge.
      if (n === 'ContainmentField' || n === 'Level.glowField' || n === 'Level.dust') continue;
      return { name: n, d: h.distance, y: h.point.y };
    }
    return null;
  };

  // Walk each column down from the top of the frame and record where geometry
  // first appears — that row IS the silhouette edge.
  const cols = [];
  for (let sx = 0.03; sx <= 0.98; sx += 0.02) {
    let first = null;
    for (let sy = 0.05; sy <= 0.62; sy += 0.004) {
      const h = hitAt(sx, sy);
      if (h) { first = { sy: +sy.toFixed(3), ...h }; break; }
    }
    // Also sample 40 px (of 1080) below the edge, i.e. the ridge's own face.
    const face = first ? hitAt(sx, Math.min(0.62, first.sy + 0.037)) : null;
    cols.push({
      sx: +sx.toFixed(2),
      edgeSy: first ? first.sy : null,
      edge: first ? first.name : 'sky',
      edgeD: first ? Math.round(first.d) : null,
      edgeY: first ? Math.round(first.y) : null,
      faceOwner: face ? face.name : null,
      faceD: face ? Math.round(face.d) : null,
    });
  }

  // How much depth SPREAD does the background actually have? If every silhouette
  // pixel sits in one narrow distance band there is nothing for aerial
  // perspective to separate, however the fog is tuned.
  const ds = cols.filter((c) => c.edgeD).map((c) => c.edgeD).sort((a, b) => a - b);
  const owners = {};
  for (const c of cols) owners[c.edge] = (owners[c.edge] || 0) + 1;

  return {
    camera: [cam.position.x, cam.position.y, cam.position.z],
    silhouetteOwners: owners,
    edgeDistance: ds.length
      ? { min: ds[0], p25: ds[(ds.length * 0.25) | 0], median: ds[(ds.length * 0.5) | 0], p75: ds[(ds.length * 0.75) | 0], max: ds[ds.length - 1] }
      : null,
    columns: cols,
  };
})();
