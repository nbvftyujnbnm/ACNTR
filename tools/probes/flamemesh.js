// The plume handles are live (4 of them, intensity 0.62) and disabling the
// soft-depth fade changed nothing, so the failure is not in the fragment
// shader. Look at the MESH: is it in the scene, visible, instanced, and — the
// prime suspect — is it being frustum-culled against a bounding volume that
// does not describe where its instances actually are?
(() => {
  const d = window.__ACNTR__.debug;
  const g = d.game;
  const ps = g.vfx?.ps;
  if (!ps) return { error: 'no particle system' };

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  d.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 120 });
  d.step(0.4);
  d.holdKeys(['Space']);
  d.step(1.1);
  d.cameraRelativeToPlayer({ x: 2.6, y: 3.4, z: -11.5 }, { x: 0, y: 4.6, z: 2.0 }, 38);
  d.step(0.08);

  const describe = (m, label) => {
    if (!m) return { label, missing: true };
    const geo = m.geometry;
    const bs = geo?.boundingSphere;
    return {
      label,
      type: m.type,
      inScene: !!m.parent,
      parentName: m.parent?.name || m.parent?.type || null,
      visible: m.visible,
      frustumCulled: m.frustumCulled,
      renderOrder: m.renderOrder,
      layersMask: m.layers?.mask,
      instanceCount: geo?.instanceCount,
      drawRange: geo?.drawRange ? { ...geo.drawRange } : null,
      boundingSphere: bs ? { c: bs.center.toArray().map((n) => +n.toFixed(1)), r: +bs.radius.toFixed(1) } : null,
      matDepthWrite: m.material?.depthWrite,
      matTransparent: m.material?.transparent,
      matBlending: m.material?.blending,
      matVisible: m.material?.visible,
      worldPos: m.getWorldPosition(new (window.__ACNTR__.THREE.Vector3)()).toArray().map((n) => +n.toFixed(1)),
    };
  };

  const cam = g.engine.camera;
  return {
    litFlames: (g.vfx._flames || []).filter((f) => f.intensity > 0.01).length,
    flameCapacity: ps.flameCapacity,
    inner: describe(ps.flameInner, 'flameInner'),
    outer: describe(ps.flameOuter, 'flameOuter'),
    cameraLayers: cam.layers.mask,
    cameraPos: cam.position.toArray().map((n) => +n.toFixed(1)),
    playerPos: g.player.root.position.toArray().map((n) => +n.toFixed(1)),
  };
})();
