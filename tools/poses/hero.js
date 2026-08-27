// Hero shot: the AC in a cinematic 3/4 view, HUD off, environment behind it.
// This is the frame most directly comparable to an Armored Core VI key render.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerInSun(Math.PI * 0.18); // must stand in sun or there is no contact shadow
  debug.poseMech({ grounded: true, aimYaw: 0.25, aimPitch: -0.05, speed: 0 });
  // let the mech settle onto the ground and the rig springs relax
  debug.step(2.0);
  // Mech is 9 m with its origin at the feet. Camera framing is relative so the
  // composition survives whatever terrain the mech is standing on.
  debug.cameraRelativeToPlayer({ x: 12.0, y: 6.4, z: 14.0 }, { x: 0, y: 4.7, z: 0 }, 34);
  debug.step(0.6);
})();
