// Hero shot: the AC in a cinematic 3/4 view, HUD off, environment behind it.
// This is the frame most directly comparable to an Armored Core VI key render.
//
// frameHeroShot() places the mech AND validates the camera together. Placing
// only the mech was not enough twice over: the previous scorer summed eight
// clearance rays, so a spot with one close wall still won, and when that wall
// was behind the lens the shot came back as a full-frame close-up of plating.
// It also picks a bearing with the sun side-on, because at a 13.5-degree sun a
// 9 m mech throws a ~37 m shadow — a blade cast far to one side, in frame only
// if the camera azimuth is right.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();

  const framed = debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  if (!framed) {
    console.warn('[pose:hero] no valid sunlit framing found — falling back');
    debug.placePlayerInSun(Math.PI * 0.18);
    debug.cameraRelativeToPlayer({ x: 12.0, y: 6.4, z: 14.0 }, { x: 0, y: 4.7, z: 0 }, 34);
  }

  debug.poseMech({ grounded: true, aimYaw: 0.25, aimPitch: -0.05, speed: 0 });
  debug.step(2.0);
  // Re-apply the framing: step() lets the mech settle onto the terrain.
  if (framed) debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.step(0.4);
})();
