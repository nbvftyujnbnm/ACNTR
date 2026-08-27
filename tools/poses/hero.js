// Hero shot: the AC in a cinematic 3/4 view, HUD off, environment behind it.
// This is the frame most directly comparable to an Armored Core VI key render.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayer(0, 0, 0, Math.PI * 0.18);
  debug.poseMech({ grounded: true, aimYaw: 0.25, aimPitch: -0.05, speed: 0 });
  // let the mech settle onto the ground and the rig springs relax
  debug.step(2.0);
  debug.setCamera({ x: 13.5, y: 7.2, z: 15.5 }, { x: 0, y: 5.4, z: 0 }, 34);
  debug.step(0.6);
})();
