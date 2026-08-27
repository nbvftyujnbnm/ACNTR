// Identify the flat panel floating in the sky in the upper-right of the hero
// frame. Rather than traversing the whole scene (too slow under CPU contention
// from concurrent agents), reproduce the hero camera and raycast through the
// exact screen point where the panel appears.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;

  // Reproduce tools/poses/hero.js framing.
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerAtSpawn(0, Math.PI * 0.18);
  debug.step(1.2);
  debug.cameraRelativeToPlayer({ x: 12.0, y: 6.4, z: 14.0 }, { x: 0, y: 4.7, z: 0 }, 34);
  debug.step(0.2);

  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);

  const ray = new THREE.Raycaster();
  ray.far = 5000;
  const results = [];

  // Sweep a small grid around the panel's apparent position (normalised screen
  // ~0.888, 0.189 in the 1600x900 hero frame) so we hit it even if framing drifts.
  for (let sx = 0.80; sx <= 0.96; sx += 0.02) {
    for (let sy = 0.10; sy <= 0.28; sy += 0.02) {
      const ndc = new THREE.Vector2(sx * 2 - 1, 1 - sy * 2);
      ray.setFromCamera(ndc, cam);
      const hits = ray.intersectObjects(game.scene.children, true);
      for (const h of hits) {
        const o = h.object;
        if (!o.visible) continue;
        const nm = o.name || '(unnamed)';
        // Skip the sky dome and the arena boundary field — the boundary is a
        // large transparent shell that sits in front of everything out here and
        // swallows every ray before it reaches the actual geometry.
        if (/sky|dome|background|containmentfield/i.test(nm)) continue;
        const p = h.point;
        const ground = game.physics?.groundHeight?.(p.x, p.z);
        results.push({
          screen: `${sx.toFixed(2)},${sy.toFixed(2)}`,
          name: nm,
          type: o.type,
          parent: o.parent?.name || '(no parent name)',
          grandparent: o.parent?.parent?.name || '',
          dist: +h.distance.toFixed(1),
          point: `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`,
          groundY: isFinite(ground) ? +ground.toFixed(1) : null,
          clearance: isFinite(ground) ? +(p.y - ground).toFixed(1) : null,
          mat: o.material?.name || o.material?.type,
        });
        break; // nearest hit only
      }
    }
  }

  // Report only hits that are clearly airborne.
  const airborne = results.filter((r) => r.clearance != null && r.clearance > 15);
  return {
    camera: `${cam.position.x.toFixed(1)},${cam.position.y.toFixed(1)},${cam.position.z.toFixed(1)}`,
    totalHits: results.length,
    airborneCount: airborne.length,
    airborne: airborne.slice(0, 20),
    sampleAll: results.slice(0, 8),
  };
})();
