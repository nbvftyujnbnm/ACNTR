// High-speed assault boost frame — judges motion blur, speed lines, FOV kick,
// thruster plumes and whether the game reads as FAST.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.releaseCamera();
  debug.clearEnemies();
  debug.placePlayer(0, 26, 120, 0);
  if (game.controller?.state) {
    game.controller.state.assaultBoost = true;
    game.controller.state.boosting = true;
    game.controller.state.grounded = false;
    game.controller.state.speed = 95;
  }
  if (game.player?.velocity) game.player.velocity.set(0, 0, -95);
  debug.poseMech({ assaultBoost: true, boosting: true, grounded: false, speed: 95 });
  debug.step(1.4);
})();
