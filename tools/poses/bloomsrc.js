// DIAGNOSTIC, NOT A REVIEW POSE — do not grade this frame.
//
// The gameplay framing with the HUD OFF and the low-AP/hit rim held at zero, so
// the capture contains nothing but what the renderer drew. It exists to feed
// `tools/bloomsim.mjs`, which recovers scene-linear radiance from a capture and
// re-runs the bloom chain on it offline: the HUD is a DOM overlay composited
// AFTER post, so it never reaches the real bloom prefilter, but it is in the
// PNG and a simulator run on an ordinary gameplay shot blooms it. Measured, the
// HUD is most of the frame's above-threshold population — 0.64% of
// shots/iter32/gameplay.png sits above 1.9 scene-linear against the 0.054% that
// `tools/probes/tonebloom.js` measured off rtScene itself.
//
// WEAPONS ARE HELD DOWN THROUGH THE SETTLE WINDOW. `capture.mjs` screenshots
// ~1.1 s of real time after this script returns (see the Contract Amendment),
// and a muzzle flash lasts two or three frames — so a pose that fires once at
// the end photographs no flash at all. The interval keeps the emissive
// population alive until well past the shutter and then stops.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.releaseCamera();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ rank: 0, ahead: 70 });
  if (!open) debug.placePlayerOnGround(0, 40, 0, 1.0);
  debug.step(0.5);

  const at = (ahead, side) => debug.aheadOfPlayer(ahead, side, new THREE.Vector3());
  const a = at(34, -12), b = at(46, 16), c = at(58, -2), d = at(40, -22);
  debug.spawnEnemyOnGround('ac', a.x, a.z, 2, 5);
  debug.spawnEnemyOnGround('mt', b.x, b.z, 1, 0);
  debug.spawnEnemyOnGround('mt', c.x, c.z, 1, 0);
  debug.spawnEnemyOnGround('flyer', d.x, d.z, 1, 18);
  debug.step(1.2);

  debug.holdKeys(['KeyW']);
  debug.step(0.35);
  debug.releaseKeys();

  // The rim is a post effect keyed off damage taken, and it paints the frame's
  // whole border red — which would be inverted back into "radiance" by the
  // simulator and blooms as a wide red halo that the renderer never produced.
  // Pin it off for the whole settle window; the pipeline re-reads these every
  // frame, so one write is not enough.
  const pipe = game.pipeline;
  const hold = setInterval(() => {
    debug.fireAll();
    if (pipe) { pipe._dyn.hit = 0; pipe._dyn.crit = 0; pipe._dyn.critT = 0; pipe._dyn.scan = 0; }
  }, 60);
  setTimeout(() => clearInterval(hold), 3200);

  const live = (game.enemies?.list || []).filter((e) => e && e.alive !== false && e.root);
  const seen = debug.visibleCount(live);
  window.__POSE_NOTE__ = {
    diagnostic: 'bloom source frame — HUD off, damage rim pinned off. DO NOT GRADE.',
    enemiesVisible: seen.visible,
    enemiesAlive: live.length,
  };
  if (!seen.visible) window.__POSE_NOTE__.warning = 'no enemies visible — few emissives in frame';
})();
