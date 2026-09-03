// EXPLOSION FILMSTRIP — six detonations, each frozen at a different age.
//
// DIAGNOSTIC, not a review frame. Do not grade it as a picture of the running
// game; grade it as the only honest look at what an explosion actually
// contains over its life.
//
// Why it has to exist. The gameplay capture showed a detonation as a flat
// white sphere with no fireball, no shock ring and no smoke, and the obvious
// reading was that the explosion is broken. It is not: `VFX.explosion` builds
// a white-hot flash of life 0.06 s and 0.105 s, a fireball of alpha puffs
// living 0.30-0.62 s, rolling smoke over it, and a shock ring. Under
// SwiftShader this harness renders at ~10 fps, so ONE FRAME IS 100 ms — the
// gameplay pose photographed the FLASH, which is white-hot by design and is
// supposed to be gone before the fireball reads. Grading a 500 ms effect from
// a single frame at t=0 is grading its first tenth.
//
// This is the same trap `tools/poses/muzzle.js` documents for muzzle flashes.
// It has now cost two rounds of nearly-fixing code that was working.
//
// Method: fire six explosions spaced along a line, staggering their start
// times so that when the simulation freezes they are all at different ages.
// One capture then shows the whole evolution side by side, which no sequence
// of single-age captures can do on a box this slow.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ ahead: 70 });
  if (!open) debug.placePlayerOnGround(0, 60, 0, 0.05);
  debug.step(0.4);

  const p = game.player.root.position.clone();
  const fwd = debug.forward();
  const right = debug.right();

  // Ages to photograph, in seconds. 0.05 catches the flash at peak, 0.15 the
  // moment it hands over, and the rest the fireball and smoke doing their job.
  const AGES = [0.05, 0.15, 0.30, 0.50, 0.80, 1.20];
  const R = 9;
  const SPACING = 26;
  // AIRBORNE, at a fixed height above the player's own ground. The first
  // version of this pose put the row on the terrain 95 m ahead — past the 70 m
  // the arena scorer vets — and the ground there turned out to be 48 m BELOW
  // the player, so six detonations went off in a valley under the bottom of
  // frame and the capture came back empty. That is the same "spawned past the
  // vetted range" bug already fixed once in the gameplay pose, repeated here.
  // An explosion with `ground: false` does not need terrain at all, so the
  // whole class of problem goes away by not touching it.
  const AHEAD = 70;
  const HEIGHT = 26;

  // NO CAMERA OVERRIDE. `debug.setCamera` combined with `debug.freeze(true)`
  // does not reach the render here: measured, the override stays set and
  // `engine.camera.position` reads the requested value at shutter time, yet
  // the frame is composed from the chase camera — from the override position
  // the player would sit 52 deg off axis against a 37 deg half-FOV, outside
  // the frustum, and it is plainly centred in the picture. Something between
  // the frozen update loop and the render is using a different camera. That is
  // recorded in CONTRACT.md as an open question; this pose simply does not
  // depend on the answer.
  //
  // Using the real chase camera is better for this job anyway: the detonations
  // are then framed exactly as a player would see them, at the distance combat
  // actually happens.
  debug.setPass('motionBlur', false);
  debug.step(0.3);

  // Fire OLDEST first, so that by the time the youngest is triggered the
  // oldest has had its full age to develop.
  // Spread symmetrically about the mech's forward axis so the strip is
  // centred in the chase view rather than running off one edge.
  const half = (AGES.length - 1) / 2;
  const spots = AGES.map((_, i) => {
    const v = debug.aheadOfPlayer(AHEAD, (i - half) * SPACING, new THREE.Vector3());
    v.y = p.y + HEIGHT;
    return v;
  });

  const sorted = AGES.map((a, i) => ({ a, i })).sort((x, y) => y.a - x.a);
  let elapsed = 0;
  for (const { a, i } of sorted) {
    const wait = (sorted[0].a - a) - elapsed;
    if (wait > 0) { debug.step(wait); elapsed += wait; }
    const v = spots[i];
    debug.vfx('explosion', v.clone(), R,
              { ground: false, shake: 0, smoke: true, debris: 1.0 });
  }
  // Advance the remainder so the oldest reaches its full age.
  const rest = sorted[0].a - elapsed;
  if (rest > 0) debug.step(rest);

  // FREEZE. The harness renders about 1.1 s of real time after this returns,
  // which is longer than the whole effect — without this every detonation
  // would be over and the frame would show smoke and nothing else.
  debug.freeze(true);

  // Instrumented, because the first run of this pose produced a frame with no
  // explosions in it at all and there are at least four different reasons that
  // could happen: the camera not going where it was asked, the detonations
  // landing outside the view, `debug.vfx` silently swallowing a bad call, or
  // every particle having expired before the shutter. Report enough to tell
  // them apart in one run instead of four.
  const camNow = game.engine.camera;
  camNow.updateMatrixWorld();
  const ps = game.vfx?.ps;
  window.__POSE_NOTE__ = {
    agesLeftToRight: AGES,
    radius: R,
    cameraActual: camNow.position.toArray().map((n) => +n.toFixed(1)),
    playerAt: p.toArray().map((n) => +n.toFixed(1)),
    detonationSpots: spots.map((v) => v.toArray().map((n) => +n.toFixed(1))),
    // Are there any particles alive at all when the shutter opens?
    liveParticles: (() => {
      for (const k of ['count', '_count', 'alive', '_alive', 'active', '_active']) {
        const v = ps?.[k];
        if (typeof v === 'number') return { field: k, n: v };
        if (Array.isArray(v)) return { field: k, n: v.length };
      }
      return { field: null, n: 'unknown' };
    })(),
    note: 'Each detonation is frozen at the age listed, left to right. '
        + 'The flash lives 0.06-0.105 s, the fireball 0.30-0.62 s, so the '
        + 'first one or two are SUPPOSED to be white-hot and featureless.',
    passes: debug.passes(),
  };

  // The note is read AFTER the screenshot, so a late sample lands in the
  // report. The camera matched what was asked at pose end and the frame still
  // came back composed from the chase view, which means something moves it
  // during the 1.1 s settle — and only a reading taken inside that window can
  // say so.
  setTimeout(() => {
    const c = game.engine.camera;
    window.__POSE_NOTE__.cameraAtShutter = c.position.toArray().map((n) => +n.toFixed(1));
    window.__POSE_NOTE__.timeScaleAtShutter = game.engine.timeScale;
  }, 1000);

  // Leave the session as we found it; poses share one browser. capture.mjs
  // also restores camera, freeze, keys and passes after every shot, so this is
  // belt and braces — but it must fire well after the 1.1 s shutter.
  setTimeout(() => {
    debug.freeze(false);
    debug.releaseCamera();
    debug.setPass('motionBlur', true);
  }, 6000);
})();
