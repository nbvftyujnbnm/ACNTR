// Why does silhouette framing only work on some yaws? Report the actual
// numbers the framing is derived from, plus where the camera ended up.
(() => {
  const g = window.__ACNTR__.debug.game;
  const d = window.__ACNTR__.debug;
  const THREE = window.__ACNTR__.THREE;
  const out = { yaws: [] };

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  d.poseMech({ grounded: true });
  d.step(1.5);

  const root = g.player.root;
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  out.rootPos = root.position.toArray().map((n) => +n.toFixed(2));
  out.box = { min: box.min.toArray().map((n) => +n.toFixed(2)), max: box.max.toArray().map((n) => +n.toFixed(2)) };
  out.sceneChildren = g.scene.children.length;
  out.rootIsSceneChild = g.scene.children.includes(root);

  let meshes = 0;
  root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes++; });
  out.rootMeshes = meshes;

  for (const yaw of [0, 90, 180]) {
    d.silhouette({ on: true, yaw: (yaw * Math.PI) / 180 });
    d.step(0.05);
    const cam = g.engine.camera;
    const m = d.silhouetteMask(256);
    let on = 0;
    if (m) for (let i = 0; i < m.mask.length; i++) on += m.mask[i];
    out.yaws.push({
      yaw,
      camPos: cam.position.toArray().map((n) => +n.toFixed(2)),
      camFov: cam.fov,
      camNear: cam.near,
      camFar: cam.far,
      override: d.cameraOverride ? d.cameraOverride.mode : null,
      overridePos: d.cameraOverride ? [d.cameraOverride.pos.x, d.cameraOverride.pos.y, d.cameraOverride.pos.z].map((n) => +n.toFixed(2)) : null,
      maskOn: on,
      maskTotal: m ? m.mask.length : 0,
    });
    d.silhouette({ on: false });
  }
  return out;
})();
