// Representative gameplay frame: third-person combat framing with the full HUD,
// enemies engaged, weapons firing. This is the frame that gets compared against
// an Armored Core VI gameplay screenshot.
//
// The previous version of this pose produced a frame with NO ENEMIES IN IT,
// which makes it useless for the thing it exists to judge. Three causes, all of
// them lessons this project had already learned and written down elsewhere:
//
//   1. Enemies were spawned at ABSOLUTE world coordinates while the player was
//      placed relative to terrain. tools/poses/combat_vfx.js carries the same
//      note: absolute coordinates do not survive real terrain.
//   2. The player was placed 22 m ABOVE the ground and then the sim was run for
//      3.2 s, so it spent the whole shot falling and the chase camera swung
//      with it.
//   3. Boost was forced by writing controller.state directly. Per the contract
//      amendment, the controller re-derives its state from input every frame,
//      so those flags are overwritten by the next step — the old frame reported
//      0 m/s and GRND CONTACT while claiming to be a boosting combat moment.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.unpause(); // headless never holds pointer lock, so the HUD would sit paused
  debug.releaseCamera(); // the real chase camera — this frame must be authentic
  debug.clearEnemies();
  debug.resetState();

  // Open ground with a real field of fire, facing down it. Placing at a fixed
  // spot put the mech nose-first against a warehouse wall: it could not move,
  // and every enemy spawned ahead of it was behind that wall.
  const open = debug.placePlayerInOpenGround();
  if (!open) debug.placePlayerOnGround(0, 40, 0, 1.0);
  debug.step(0.5);

  // Spawn RELATIVE to where the player actually ended up, along the direction
  // the chase camera is looking, so the engagement is in frame by construction
  // rather than by luck.
  const p = game.player.root.position;
  const yaw = game.player.root.rotation.y;
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  // Placed ON the terrain, not at the player's y plus a guess — ground that
  // rises ahead buried the last set inside a hillside while the frustum test
  // cheerfully reported all four as in frame.
  const at = (ahead, side) => p.clone().addScaledVector(fwd, ahead).addScaledVector(right, side);
  // Close. The first spread put them 52-96 m out, which sounds reasonable and
  // is not: the mech boosts ~20 m during the pose and the open pocket it starts
  // in is smaller than the engagement, so the fight ended up strung out through
  // scenery. An AC6 gameplay screenshot is a knife fight at 30-60 m.
  const a = at(34, -12);
  const b = at(46, 16);
  const c = at(58, -2);
  const d = at(40, -22);
  debug.spawnEnemyOnGround('ac', a.x, a.z, 2, 5);
  debug.spawnEnemyOnGround('mt', b.x, b.z, 1, 0);
  debug.spawnEnemyOnGround('mt', c.x, c.z, 1, 0);
  debug.spawnEnemyOnGround('flyer', d.x, d.z, 1, 18);

  // Let the AI engage, but not long enough for anything to die or to scatter.
  debug.step(1.2);

  // Moving, not sprinting. Real input so the movement model runs, but held
  // briefly: a full boost carries the mech clean out of the pocket it started
  // in and smears it into an unreadable blur.
  debug.holdKeys(['KeyW']);
  debug.step(0.35);

  // Mid-fight: hurt, stagger building, energy spent, lock acquired.
  debug.hudState({ ap: 0.62, acs: 0.44, en: 0.38, lockProgress: 1 });
  debug.fireAll();
  debug.step(0.12);
  debug.fireAll();
  debug.step(0.06);
  debug.releaseKeys();

  // Say what actually made it into the shot, so a frame that misses the fight
  // reports the fact instead of being silently graded as a combat frame.
  // visibleCount() raycasts as well as frustum-testing. The first version of
  // this check reported "4 of 4 enemies in frame" for a shot in which all four
  // were behind a warehouse — being inside the frustum and being visible are
  // different questions.
  const live = (game.enemies?.list || []).filter((e) => e && e.alive !== false && e.root);
  const seen = debug.visibleCount(live);
  const m = game.player.moveState || {};
  window.__POSE_NOTE__ = {
    enemiesAlive: live.length,
    enemiesInFrustum: seen.inFrustum,
    enemiesVisible: seen.visible,
    openGround: open ? open.clear : null,
    speed: +(m.speed ?? 0).toFixed(1),
    grounded: !!m.grounded,
  };
  const problems = [];
  if (!seen.visible) problems.push('NO ENEMIES VISIBLE — cannot judge combat');
  if ((m.speed ?? 0) < 8) problems.push('mech nearly stationary — check it is not against a wall');
  if (problems.length) window.__POSE_NOTE__.warning = problems.join('; ');
})();
