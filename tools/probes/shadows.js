// The hero frame shows the mech standing on a sunlit deck with NO cast shadow.
// CONTRACT records a measured finding that "the shadows are not weak", so
// before touching any lighting parameter, establish what is actually true:
// is a shadow being cast at all, is anything set up to receive it, and does
// the cascade covering the mech reach the ground it is standing on?
(() => {
  const d = window.__ACNTR__.debug;
  const g = d.game;
  const THREE = window.__ACNTR__.THREE;
  const out = {};

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  const framed = d.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  d.poseMech({ grounded: true });
  d.step(1.5);
  out.framed = !!framed;
  out.playerPos = g.player.root.position.toArray().map((n) => +n.toFixed(2));

  // --- renderer / scene level ---------------------------------------------
  const r = g.engine.renderer;
  out.renderer = {
    shadowMapEnabled: !!r.shadowMap?.enabled,
    shadowMapType: r.shadowMap?.type,
    autoUpdate: r.shadowMap?.autoUpdate,
  };

  // --- every light that could cast ----------------------------------------
  out.lights = [];
  g.scene.traverse((o) => {
    if (!o.isLight) return;
    out.lights.push({
      type: o.type,
      name: o.name || null,
      visible: o.visible,
      intensity: +Number(o.intensity).toFixed(2),
      castShadow: !!o.castShadow,
      mapSize: o.shadow ? [o.shadow.mapSize.x, o.shadow.mapSize.y] : null,
      camNear: o.shadow?.camera?.near ?? null,
      camFar: o.shadow?.camera?.far ?? null,
      bias: o.shadow?.bias ?? null,
      normalBias: o.shadow?.normalBias ?? null,
      hasMap: !!o.shadow?.map,
    });
  });

  // --- does the MECH cast, and does the ground RECEIVE? --------------------
  let mechMeshes = 0, mechCast = 0;
  g.player.root.traverse((o) => {
    if (!o.isMesh) return;
    mechMeshes++;
    if (o.castShadow) mechCast++;
  });
  out.mech = { meshes: mechMeshes, castShadow: mechCast };

  // Sample whatever is directly under the mech's feet.
  const under = [];
  const ray = new THREE.Raycaster(
    g.player.root.position.clone().add(new THREE.Vector3(0, 2, 0)),
    new THREE.Vector3(0, -1, 0), 0.1, 40,
  );
  for (const hit of ray.intersectObjects(g.scene.children, true).slice(0, 6)) {
    under.push({
      name: hit.object.name || hit.object.type,
      dist: +hit.distance.toFixed(2),
      receiveShadow: !!hit.object.receiveShadow,
      castShadow: !!hit.object.castShadow,
      material: hit.object.material?.type || null,
    });
  }
  out.groundUnderMech = under;

  // --- CSM: how far does the shadowed range actually reach? ---------------
  const L = g.lighting;
  out.lightingKeys = L ? Object.keys(L).filter((k) => !k.startsWith('_')).slice(0, 40) : null;
  if (L?.params) {
    out.lightingParams = {};
    for (const k of Object.keys(L.params)) {
      const v = L.params[k];
      if (typeof v === 'number' || typeof v === 'boolean') out.lightingParams[k] = v;
    }
  }
  if (L?.csm) {
    out.csm = {
      cascades: L.csm.cascades ?? null,
      maxFar: L.csm.maxFar ?? null,
      mode: L.csm.mode ?? null,
      lightMargin: L.csm.lightMargin ?? null,
      breaks: L.csm.breaks ? L.csm.breaks.slice() : null,
    };
  }

  // Distance from camera to the mech — if that exceeds the shadowed range,
  // no cascade covers the subject and nothing else matters.
  out.camToMech = +g.engine.camera.position.distanceTo(g.player.root.position).toFixed(1);
  out.stats = d.stats();
  return out;
})();
