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

  // Point the run down the LONGEST clear lane on the map, not at a fixed
  // coordinate. Assault boost now reaches 95.5 m/s (a units bug had it capped
  // at 61.8 until this was measured and fixed), and at that speed a fixed
  // start burns through its clearance and ends against terrain: the captured
  // frame read 38 m/s after a collision, i.e. the frame that exists to judge
  // whether the game reads FAST was graded on 40% of the speed it should show.
  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 260 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 40);
  debug.step(0.4);

  // Hold forward + boost + assault boost, then let the real movement model
  // spin up: assault boost ramps to ~95 m/s over roughly 1.3 s (measured).
  debug.holdKeys(['KeyW', 'Space', 'ControlLeft']);
  debug.step(1.5);

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

  // Report the speed the pose actually reached. Because of the render-after-
  // return behaviour above, this is a LOWER bound on what the captured frame
  // shows rather than the exact value — but a run that is already slow here
  // was never going to produce a fast frame.
  const m = window.__ACNTR__.game.player.moveState || {};
  window.__POSE_NOTE__ = {
    speedAtPoseEnd: +(m.speed ?? 0).toFixed(1),
    assaultBoost: !!m.assaultBoost,
    assaultRamp: +(m.assaultRamp ?? 0).toFixed(2),
    openGround: open ? open.clear : null,
  };
  if ((m.speed ?? 0) < 70) {
    window.__POSE_NOTE__.warning = `only ${(m.speed ?? 0).toFixed(0)} m/s at pose end — cannot judge whether the game reads fast`;
  }
})();
