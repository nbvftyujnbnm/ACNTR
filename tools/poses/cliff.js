// DIAGNOSTIC — the boundary cliff from a GROUND-LEVEL camera, which is the only
// framing that shows the defect the review frame shows.
//
// `vista` sits at y=78 and looks DOWN across the haze band, so the mesa ring
// arrives 720-1300 m away and ~98% veiled: it reads as a soft distant hill and
// its stratigraphy is invisible. The gameplay camera sits on the deck at y~10,
// which puts the NEAR side of the same ring 350-600 m out with a fraction of
// the veiling, and that is where the "stacked paper layers" banding lives. Two
// cameras, one mesh, completely different verdicts — grade the cliff here.
//
// THE POSE PICKS ITS OWN BEARING, and the first version of it did not, which is
// the trap CONTRACT.md records twice: a fixed coordinate plus a fixed heading
// put the lens inside a wall and the frame came back as a full-screen close-up
// of plating. Being inside the frustum and being visible are different
// questions, and so are "the player has elbow room" and "the camera can see".
// So: sweep the compass from the camera's own position, keep the bearing whose
// ray travels furthest before hitting anything, and report how far that was.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();

  const open = debug.placePlayerInOpenGround({ ahead: 70 });
  if (!open) debug.placePlayerOnGround(0, 40, 0, 1.0);
  debug.step(1.0);

  const p = game.player.root.position;
  const eye = new THREE.Vector3(p.x, p.y + 16, p.z);

  // The ring's crest stands 150-290 m above a base near -26, at a radius of
  // 440-620 m, so from down here it sits 12-25 degrees up. Aim the look point at
  // 500 m out and 150 m up and a 38-degree vertical field holds the whole face.
  // Bearings within 70 degrees of the sun are rejected. The first version took
  // the clearest ray and got bearing 0 against a sun azimuth of -20: the whole
  // frame came back as a silhouette under a blown sky, which grades the
  // TONEMAP, not the rock. The face this pose exists to judge is the one the
  // arena camera sees — cross-lit or beyond the terminator, with the sun out of
  // shot.
  const sd = game.sky?.sunDirection;
  const sunA = sd ? Math.atan2(sd.z, sd.x) : 0;
  const dir = new THREE.Vector3();
  let best = null;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const off = Math.abs(((a - sunA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (off < Math.PI * 0.39) continue;
    dir.set(Math.cos(a), 0, Math.sin(a));
    const hit = game.physics.raycast(eye, dir, 520);
    const reach = hit ? hit.distance : 520;
    if (!best || reach > best.reach) best = { a, reach };
  }

  const ca = Math.cos(best.a), sa = Math.sin(best.a);
  debug.setCamera(
    { x: eye.x, y: eye.y, z: eye.z },
    { x: eye.x + ca * 500, y: 150, z: eye.z + sa * 500 },
    38
  );
  debug.step(0.6);

  window.__POSE_NOTE__ = {
    camY: +eye.y.toFixed(1),
    bearingDeg: Math.round((best.a * 180) / Math.PI),
    clearM: Math.round(best.reach),
    warning: best.reach < 200 ? 'no clear line to the cliff — frame is blocked' : undefined,
  };
})();
