// DIAGNOSTIC — the boundary cliff from a GROUND-LEVEL camera, which is the only
// framing that shows the defect the review frame shows.
//
// `vista` sits at y=78 and looks DOWN across the haze band, so the mesa ring
// arrives 720-1300 m away and 98% veiled: it reads as a soft distant hill and
// its stratigraphy is invisible. The gameplay camera sits on the deck at y~10,
// which puts the NEAR side of the same ring 350-600 m out with a fraction of
// the veiling, and that is where the "stacked paper layers" banding lives. Two
// cameras, one mesh, completely different verdicts — grade the cliff here.
//
// Deliberately aimed at +X, which is where the SUN is (sunDirection ~
// (0.91, 0.23, -0.33)): the ring is a revolve, so the half of it we look at
// from the middle of the arena has its inner face turned AWAY from the key.
// Every ring on that face measures N.L < 0 (tools/probes/beds.js), so this is
// the worst case and the one worth fixing.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.releaseCamera();

  debug.placePlayerOnGround(-120, 60, Math.PI * 0.5);
  debug.step(1.0);

  const gy = game.level?.heightAt ? game.level.heightAt(-120, 60) : 0;
  debug.setCamera({ x: -120, y: gy + 14, z: 60 }, { x: 420, y: 150, z: -40 }, 38);
  debug.step(0.6);

  window.__POSE_NOTE__ = { camY: +(gy + 14).toFixed(1) };
})();
