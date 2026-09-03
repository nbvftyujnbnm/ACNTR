// How much of the frame does the player mech eat, and does the fight fit?
//
// The first real gameplay frame this project has ever captured
// (shots/iter31/gameplay.png) shows the player mech filling roughly three
// quarters of the frame height, dead centre, with the enemies it is fighting
// squeezed into the margins. An AC6 gameplay screenshot does not look like
// that: the AC reads as a distinct object with the arena and its targets
// around it.
//
// The rig's boom is `distance: 13.0` at a 58 deg FOV. That is checkable
// rather than arguable: at 13 m the visible height is 2*13*tan(29 deg) =
// 14.4 m, so a 10 m mech covers 69% of the frame — which is what the picture
// shows. But the right distance is not a matter of the mech alone; pulling
// back also decides whether the enemies are in shot, and pulling back too far
// makes the mech a speck and throws away the detail work.
//
// So sweep it. For each candidate (distance, fov) report BOTH numbers that
// matter: the mech's share of frame height, and how many live enemies land
// inside the frustum. Projection only — no re-render — so one browser run
// prices the whole sweep.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const cam = game.engine.camera;

  debug.setHudVisible(false);
  debug.releaseCamera();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ ahead: 70 });
  debug.step(0.5);

  // The same fight the gameplay pose stages.
  const spots = [
    ['ac', 34, -12, 2, 5],
    ['mt', 46, 16, 1, 0],
    ['mt', 58, -2, 1, 0],
    ['flyer', 40, -22, 1, 18],
  ];
  for (const [kind, ahead, side, tier, up] of spots) {
    const v = debug.aheadOfPlayer(ahead, side, new THREE.Vector3());
    debug.spawnEnemyOnGround(kind, v.x, v.z, tier, up);
  }
  debug.step(1.5);

  const live = (game.enemies?.list || []).filter((e) => e && e.alive !== false && e.root);

  // The mech's real extent, measured off its mesh rather than assumed. The
  // collider height is a physics capsule and is not the same as how tall the
  // thing looks — shoulders, weapons and boosters all sit outside it.
  const box = new THREE.Box3().setFromObject(game.player.root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  const mechHeight = size.y;

  const pivot = game.cameraRig?.pivot?.clone?.() || centre.clone();
  const fwd = debug.forward();

  // Reproduce the rig's placement analytically: the boom sits `d` behind the
  // pivot along the flat facing, lifted by the pitch the rig is holding, so a
  // candidate distance can be priced without disturbing the live camera.
  const camPos = new THREE.Vector3();
  const probe = new THREE.PerspectiveCamera(58, cam.aspect, cam.near, cam.far);

  const evaluate = (dist, fov) => {
    camPos.copy(pivot).addScaledVector(fwd, -dist);
    camPos.y = pivot.y + dist * 0.38; // the rig's working pitch, ~21 deg down
    probe.fov = fov;
    probe.aspect = cam.aspect;
    probe.position.copy(camPos);
    probe.lookAt(pivot);
    probe.updateMatrixWorld();
    probe.updateProjectionMatrix();

    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(probe.projectionMatrix, probe.matrixWorldInverse),
    );

    // Project the mech's bounding box corners and measure the screen span it
    // covers. Projecting the centre and dividing by a nominal height would
    // ignore perspective on a body this close to the lens.
    let minY = Infinity; let maxY = -Infinity;
    const c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z);
      c.project(probe);
      minY = Math.min(minY, c.y);
      maxY = Math.max(maxY, c.y);
    }
    // NDC spans 2 units top to bottom, so a half-unit span is a quarter frame.
    const frac = (maxY - minY) / 2;

    let inFrustum = 0;
    const aim = new THREE.Vector3();
    for (const e of live) {
      const h = e.collider?.height;
      aim.copy(e.root.position);
      aim.y += (Number.isFinite(h) ? h : 8) * 0.5;
      if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y) || !Number.isFinite(aim.z)) continue;
      if (frustum.containsPoint(aim)) inFrustum++;
    }
    return {
      dist, fov,
      mechFrameFrac: +frac.toFixed(3),
      enemiesInFrustum: inFrustum,
      camY: +camPos.y.toFixed(1),
    };
  };

  const sweep = [];
  for (const fov of [58, 66, 72]) {
    for (const dist of [13, 16, 19, 22, 26, 30, 36]) sweep.push(evaluate(dist, fov));
  }

  return {
    openGround: open,
    // What the mech actually measures, which is not its capsule height.
    mechMeshHeight: +mechHeight.toFixed(2),
    mechMeshSize: size.toArray().map((n) => +n.toFixed(2)),
    colliderHeight: game.player.entity?.collider?.height ?? null,
    rigDistance: game.cameraRig?.cfg?.distance ?? null,
    rigFov: cam.fov,
    enemiesAlive: live.length,
    // AC6 gameplay framing sits near 0.30 of frame height for the player AC.
    sweep,
  };
})();
