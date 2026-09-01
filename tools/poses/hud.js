// Interface review frame: HUD under load — multiple tracked targets, low AP,
// draining EN, a locked target, damage numbers in flight.
//
// Like the gameplay pose, this used to force `controller.state` directly. The
// controller re-derives its state from input every frame, so the flags were
// overwritten by the next step and the frame came back reading 1 m/s and GRND
// CONTACT while the pose claimed 84 m/s and boosting — i.e. the HUD was being
// graded on a state it was never actually showing. Drive real input instead.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.unpause(); // headless never holds pointer lock, so the HUD would sit paused
  debug.releaseCamera();
  debug.clearEnemies();
  debug.resetState();

  // Open ground with a real field of fire, facing down it — see the note in
  // gameplay.js about the mech that ended up nose-first against a warehouse.
  const open = debug.placePlayerInOpenGround();
  if (!open) debug.placePlayerOnGround(0, 30, 0, 1.0);
  debug.step(0.5);

  // Spawn relative to the player, ahead of the chase camera — absolute world
  // coordinates do not survive real terrain.
  const p = game.player.root.position;
  const yaw = game.player.root.rotation.y;
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const at = (ahead, side, up) => {
    const v = p.clone().addScaledVector(fwd, ahead).addScaledVector(right, side);
    v.y += up;
    return v;
  };
  const spots = [
    ['ac', at(46, -16, 8), 3],
    ['mt', at(68, 24, 0), 1],
    ['mt', at(58, -34, 0), 1],
    ['flyer', at(80, 30, 22), 2],
    ['tank', at(98, 2, 0), 2],
  ];
  for (const [kind, v, tier] of spots) debug.spawnEnemy(kind, v.x, v.y, v.z, tier);
  debug.step(2.0);

  // Boosting hard, so the speed readout and the movement-state chips are
  // showing something. Real keys, so the movement model actually runs.
  debug.holdKeys(['KeyW', 'Space', 'ControlLeft']);
  debug.step(1.4);

  // Near death, stagger nearly full, energy almost gone, target locked — the
  // state the interface has to stay readable in.
  debug.hudState({ ap: 0.23, acs: 0.78, en: 0.16, lockProgress: 1 });
  debug.step(0.2);
  debug.releaseKeys();

  const m = game.player.moveState || {};
  const live = (game.enemies?.list || []).filter((e) => e && e.alive !== false && e.root);
  const seen = debug.visibleCount(live);
  window.__POSE_NOTE__ = {
    speed: +(m.speed ?? 0).toFixed(1),
    grounded: !!m.grounded,
    assaultBoost: !!m.assaultBoost,
    enemiesAlive: live.length,
    enemiesVisible: seen.visible,
    openGround: open ? open.clear : null,
  };
  if ((m.speed ?? 0) < 20) window.__POSE_NOTE__.warning = 'HUD pose nearly stationary — speed readout and movement chips are not under load';
})();
