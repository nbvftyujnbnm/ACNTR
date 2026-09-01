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

  // The throttle stays OPEN through the harness's settle window, and this is
  // the difference between grading a 95 m/s frame and grading a 56 m/s one.
  // step() advances the simulation but does not render, so the frame that gets
  // screenshotted is one the harness renders AFTER the pose returns, ~1.1 s of
  // real time later. Releasing the keys here handed that window to the
  // deceleration model: measured on this build, the captured frame read 56 m/s
  // on the HUD with no velocity left for the speed cues to key off. Under
  // SwiftShader the engine clamps dt to 0.1 s and only renders a handful of
  // frames in that window, so holding costs a couple of hundred metres of
  // travel and keeps the mech at its assault-boost terminal speed.
  //
  // Self-clearing rather than left latched: the poses run in ONE browser
  // session and boost sorts FIRST, so a stuck key would drive every frame
  // after it.
  setTimeout(() => debug.releaseKeys(), 3000);
})();
