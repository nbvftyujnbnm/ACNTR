// Why is nothing in the gameplay frame's frustum?
//
// The phantom-raycast bug is fixed — `blockedAt` is now empty, so no sight line
// is being falsely reported as occluded. But the gameplay pose now reports
// `enemiesInFrustum: 0` out of 4 alive, which is a DIFFERENT failure: the
// enemies are not being rejected as blocked, they are not in front of the
// camera at all.
//
// Three candidates, and they need different fixes:
//   1. The enemies are not where the pose put them — `spawnEnemyOnGround` uses
//      `physics.groundHeight`, which the contract records as the HIGHEST
//      surface in the column, not the walkable floor. On a map with decks and
//      gantries that can drop a mech onto a roof tens of metres up, or leave it
//      at a Y the AI immediately falls from.
//   2. They ARE where the pose put them and the camera is not looking that way
//      — the chase camera lags and orbits, so "the mech faces down the arena"
//      does not mean the camera does.
//   3. The frustum test itself is wrong (stale projection matrix, or a point
//      test at a height the entity does not actually occupy).
//
// So: report the raw geometry. Camera position and forward, player position and
// forward, and for every enemy its world position, the distance, the angle off
// the camera's axis, and the half-FOV it would have to be inside. That
// separates all three without another guess.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const cam = game.engine.camera;

  debug.setHudVisible(false);
  debug.releaseCamera();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ ahead: 70 });
  debug.step(0.5);

  const p = game.player.root.position.clone();
  const yaw = game.player.root.rotation.y;
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  // Which "forward" is the real one? The contract records that root rotation
  // is NOT the aim — CameraRig owns `aimYaw` and re-applies it — so a pose
  // that spawns along the root's facing can put the whole fight behind the
  // lens. Report all three and spawn along the CAMERA's, since the camera is
  // the thing that decides what is in the picture.
  cam.updateMatrixWorld();
  const camFlat = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  camFlat.y = 0;
  camFlat.normalize();
  const camRight = new THREE.Vector3(camFlat.z, 0, -camFlat.x);
  const at = (ahead, side) => p.clone().addScaledVector(camFlat, ahead).addScaledVector(camRight, side);

  // The same four spawns the gameplay pose asks for, and what the ground query
  // said at each spot — so a bad Y is visible next to the request that made it.
  const asked = [
    ['ac', at(34, -12), 2, 5],
    ['mt', at(46, 16), 1, 0],
    ['mt', at(58, -2), 1, 0],
    ['flyer', at(40, -22), 1, 18],
  ];
  const spawnLog = asked.map(([kind, v, tier, above]) => {
    const gh = game.physics?.groundHeight?.(v.x, v.z);
    debug.spawnEnemyOnGround(kind, v.x, v.z, tier, above);
    return {
      kind,
      askedXZ: [+v.x.toFixed(1), +v.z.toFixed(1)],
      groundHeightThere: Number.isFinite(gh) ? +gh.toFixed(2) : 'NON-FINITE',
      above,
    };
  });
  debug.step(0.35);

  // Let the chase camera settle exactly as the pose does.
  debug.step(1.2);
  cam.updateMatrixWorld();

  const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
  const halfFovY = THREE.MathUtils.degToRad(cam.fov) / 2;
  const halfFovX = Math.atan(Math.tan(halfFovY) * cam.aspect);

  const live = (game.enemies?.list || []).filter((e) => e && e.alive !== false && e.root);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );

  const enemies = live.map((e) => {
    const q = e.root.position;
    const h = e.collider?.height;
    const chest = q.clone();
    chest.y += (Number.isFinite(h) ? h : 8) * 0.5;
    const to = chest.clone().sub(cam.position);
    const dist = to.length();
    to.divideScalar(dist || 1);
    // Angle off the camera axis, and the same angle split into the horizontal
    // and vertical components the frustum actually clips against — a target
    // that is 4 deg off axis horizontally but 40 deg below is out of frame for
    // a reason a single "angle" number would hide.
    const local = chest.clone().applyMatrix4(cam.matrixWorldInverse); // camera space: -Z forward
    return {
      kind: e.archetype ?? e.kind ?? '?',
      pos: q.toArray().map((n) => (Number.isFinite(n) ? +n.toFixed(1) : 'NON-FINITE')),
      chestY: Number.isFinite(chest.y) ? +chest.y.toFixed(1) : 'NON-FINITE',
      dist: +dist.toFixed(1),
      angleOffAxisDeg: +THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, to.dot(camFwd))))).toFixed(1),
      // Positive = in front of the lens.
      camSpace: [+local.x.toFixed(1), +local.y.toFixed(1), +local.z.toFixed(1)],
      behindCamera: local.z > 0,
      offAxisXDeg: +THREE.MathUtils.radToDeg(Math.atan2(local.x, -local.z)).toFixed(1),
      offAxisYDeg: +THREE.MathUtils.radToDeg(Math.atan2(local.y, -local.z)).toFixed(1),
      inFrustum: frustum.containsPoint(chest),
      visibleFlag: e.root.visible,
      // Is the mesh itself where the entity says it is? A rig that never
      // syncs would leave the entity in frame and the model at the origin.
      meshWorld: (() => {
        const w = new THREE.Vector3();
        e.root.getWorldPosition(w);
        return w.toArray().map((n) => (Number.isFinite(n) ? +n.toFixed(1) : 'NON-FINITE'));
      })(),
    };
  });

  return {
    openGround: open,
    player: p.toArray().map((n) => +n.toFixed(1)),
    playerYawDeg: +THREE.MathUtils.radToDeg(yaw).toFixed(1),
    playerFwd: fwd.toArray().map((n) => +n.toFixed(2)),
    // The three candidate "forwards", side by side. If these disagree, a pose
    // that picked the wrong one spawned its fight out of shot.
    aimYawDeg: Number.isFinite(game.player.entity?.aimYaw ?? game.player.aimYaw)
      ? +THREE.MathUtils.radToDeg(game.player.entity?.aimYaw ?? game.player.aimYaw).toFixed(1) : null,
    camFlatFwd: camFlat.toArray().map((n) => +n.toFixed(2)),
    rootVsCamFwdDeg: +THREE.MathUtils.radToDeg(
      Math.acos(Math.min(1, Math.max(-1, fwd.dot(camFlat)))),
    ).toFixed(1),
    camera: cam.position.toArray().map((n) => +n.toFixed(1)),
    camFwd: camFwd.toArray().map((n) => +n.toFixed(2)),
    camFov: cam.fov,
    camAspect: +cam.aspect.toFixed(3),
    halfFovXDeg: +THREE.MathUtils.radToDeg(halfFovX).toFixed(1),
    halfFovYDeg: +THREE.MathUtils.radToDeg(halfFovY).toFixed(1),
    camNearFar: [cam.near, cam.far],
    // Does the camera agree with the mech about which way is forward?
    camVsPlayerFwdDeg: +THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, camFwd.dot(fwd))))).toFixed(1),
    spawnRequests: spawnLog,
    enemiesAlive: live.length,
    enemies,
  };
})();
