// DIAGNOSTIC, not a review frame. The vista framing exactly, as the control
// half of the A/B against fan_nofield — see the Contract Amendment on the
// faint curved streaks in the vista's left sky.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(1.5);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.8);
})();
