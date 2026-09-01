// Compact follow-up: the previous probe's output was truncated before the
// renderer and light rows. Report only what decides whether a shadow can
// possibly appear under the hero mech.
(() => {
  const d = window.__ACNTR__.debug;
  const g = d.game;
  const r = g.engine.renderer;

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  d.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  d.poseMech({ grounded: true });
  d.step(1.5);

  const lights = [];
  g.scene.traverse((o) => {
    if (!o.isLight || !o.castShadow) return;
    lights.push([
      o.type.replace('Light', ''),
      o.name || '-',
      `i=${(+o.intensity).toFixed(1)}`,
      `vis=${o.visible ? 1 : 0}`,
      `map=${o.shadow?.map ? `${o.shadow.map.width}x${o.shadow.map.height}` : 'NONE'}`,
      `far=${o.shadow?.camera?.far ?? '-'}`,
      `bias=${o.shadow?.bias ?? '-'}`,
    ].join(' '));
  });

  // How many lights exist at all, casting or not.
  let total = 0;
  g.scene.traverse((o) => { if (o.isLight) total++; });

  return {
    shadowMapEnabled: !!r.shadowMap?.enabled,
    shadowMapType: r.shadowMap?.type,
    shadowAutoUpdate: !!r.shadowMap?.autoUpdate,
    shadowNeedsUpdate: !!r.shadowMap?.needsUpdate,
    lightsTotal: total,
    lightsCasting: lights.length,
    casting: lights,
    sunLightCount: g.lighting?.sunLights?.length ?? null,
    csmLightsInScene: (g.lighting?.sunLights || []).filter((l) => !!l.parent).length,
    playerY: +g.player.root.position.y.toFixed(2),
    camToMech: +g.engine.camera.position.distanceTo(g.player.root.position).toFixed(1),
  };
})();
