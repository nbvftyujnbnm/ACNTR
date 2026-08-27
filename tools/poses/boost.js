// High-speed assault boost frame — judges motion blur, speed lines, FOV kick,
// thruster plumes and whether the game reads as FAST.
//
// This drives real INPUT rather than setting controller.state flags. The
// controller re-derives its state from input every frame, so forced flags were
// simply overwritten by the next step() and the pose captured a mech standing
// still on the ground at 9 m/s.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.unpause();
  debug.releaseCamera();
  debug.clearEnemies();
  debug.resetState();

  // Start high and with clear air ahead so the run doesn't end in a wall.
  debug.placePlayerOnGround(0, 150, 0, 40);

  // Hold forward + boost + assault boost, then let the real movement model
  // spin up: assault boost ramps to ~95 m/s over roughly 1.2 s.
  debug.holdKeys(['KeyW', 'Space', 'ControlLeft']);
  debug.step(2.2);

  debug.releaseKeys();
  debug.step(0.02); // one frame so velocity-based post has fresh history
})();
