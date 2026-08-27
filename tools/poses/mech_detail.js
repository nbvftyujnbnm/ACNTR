// Tight detail shot of the mech's upper body — judges panel lines, chamfers,
// texel density, material response and greeble quality. Nowhere to hide here.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerAtSpawn(0, 0.5);
  debug.poseMech({ grounded: true, aimYaw: 0.4, aimPitch: -0.1 });
  debug.step(2.0);
  debug.cameraRelativeToPlayer({ x: 4.6, y: 7.0, z: 5.0 }, { x: 0.1, y: 5.9, z: 0 }, 30);
  debug.step(0.5);
})();
