// Representative gameplay frame: third-person combat framing with the full HUD,
// enemies engaged, weapons firing. This is the frame that gets compared against
// an Armored Core VI gameplay screenshot.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.releaseCamera();
  debug.clearEnemies();
  debug.placePlayer(0, 22, 40, 0);

  debug.spawnEnemy('ac', -18, 14, -30, 2);
  debug.spawnEnemy('mt', 26, 0, -46, 1);
  debug.spawnEnemy('mt', 8, 0, -62, 1);
  debug.spawnEnemy('flyer', -34, 30, -55, 1);

  // Run the sim so AI engages, weapons fire and VFX populate the frame.
  debug.step(3.2);

  // Player mid-boost, mid-fight, partially damaged — a real combat moment.
  debug.hudState({ ap: 0.62, acs: 0.44, en: 0.38, lockProgress: 1 });
  if (game.controller?.state) {
    game.controller.state.boosting = true;
    game.controller.state.speed = 62;
  }
  debug.fireAll();
  debug.step(0.12);
  debug.fireAll();
  debug.step(0.08);
})();
