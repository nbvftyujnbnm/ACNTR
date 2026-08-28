// Tight detail shot of the mech's upper body — judges panel lines, chamfers,
// texel density, material response and greeble quality. Nowhere to hide here.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  // Validate the camera too, not just the mech — see hero.js.
  debug.frameHeroShot({ dist: 7.6, height: 7.0, lookY: 5.9, fov: 30 });
  debug.poseMech({ grounded: true, aimYaw: 0.4, aimPitch: -0.1 });
  debug.step(2.0);
  debug.step(0.5);
})();
