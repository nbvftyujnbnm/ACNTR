// Interface review frame: HUD under load — multiple tracked targets, low AP,
// draining EN, a locked target, damage numbers in flight.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.releaseCamera();
  debug.clearEnemies();
  debug.placePlayer(0, 16, 30, 0);

  debug.spawnEnemy('ac', -14, 12, -34, 3);
  debug.spawnEnemy('mt', 22, 0, -50, 1);
  debug.spawnEnemy('mt', -30, 0, -44, 1);
  debug.spawnEnemy('flyer', 30, 26, -60, 2);
  debug.spawnEnemy('tank', 4, 0, -78, 2);
  debug.step(2.6);

  debug.hudState({ ap: 0.23, acs: 0.78, en: 0.16, lockProgress: 1 });
  if (game.controller?.state) {
    game.controller.state.enRecovering = true;
    game.controller.state.boosting = true;
    game.controller.state.speed = 84;
  }
  debug.step(0.25);
})();
