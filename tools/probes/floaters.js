// Hunt for geometry floating in the sky: anything whose bounding box sits well
// above the terrain under it, with no support. A flat panel has been visible in
// the upper-right of the hero frame across several iterations.
(() => {
  const { game, THREE } = window.__ACNTR__;
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const out = [];

  game.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (!o.visible) return;
    try {
      box.setFromObject(o);
    } catch {
      return;
    }
    if (!isFinite(box.min.y) || box.isEmpty()) return;
    box.getSize(size);
    box.getCenter(centre);
    // Ignore the sky dome and anything enormous.
    if (size.x > 400 || size.z > 400) return;
    const ground = game.physics?.groundHeight?.(centre.x, centre.z);
    if (!isFinite(ground)) return;
    const clearance = box.min.y - ground;
    if (clearance > 12) {
      out.push({
        name: o.name || '(unnamed)',
        type: o.type,
        parent: o.parent?.name || '(no parent name)',
        instances: o.isInstancedMesh ? o.count : 1,
        clearance: +clearance.toFixed(1),
        centre: `${centre.x.toFixed(1)},${centre.y.toFixed(1)},${centre.z.toFixed(1)}`,
        size: `${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}`,
        mat: o.material?.name || o.material?.type,
      });
    }
  });

  out.sort((a, b) => b.clearance - a.clearance);
  return { count: out.length, floaters: out.slice(0, 25) };
})();
