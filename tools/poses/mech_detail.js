// Tight detail shot of the mech's upper body — judges panel lines, chamfers,
// texel density, material response and greeble quality. Nowhere to hide here.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayer(0, 0, 0, 0.5);
  debug.poseMech({ grounded: true, aimYaw: 0.4, aimPitch: -0.1 });
  debug.step(2.0);
  debug.setCamera({ x: 5.2, y: 7.6, z: 5.6 }, { x: 0.1, y: 6.4, z: 0 }, 30);
  debug.step(0.5);
})();
