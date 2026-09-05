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
  const AHEAD = 56;
  const HEIGHT = 20;

  // NO CAMERA OVERRIDE — by choice, not by necessity. This used to say that
  // `setCamera` plus `freeze(true)` "does not reach the render", because the
  // frame came back composed from the chase camera while the override still
  // read correctly. RESOLVED: the pose's own 6 s cleanup timer called
  // `releaseCamera()`, and the screenshot takes 24-130 s, so the override was
  // gone before the shutter and the "at shutter" sample was taken at 1 s.
  // Overrides work; teardown on a timer does not. See the cleanup at the foot
  // of this file.
  //
  // Using the real chase camera is better for this job anyway: the detonations
  // are then framed exactly as a player would see them, at the distance combat
  // actually happens.
  // DEPTH OF FIELD OFF. The first run of this pose put the row 98 m from the
  // lens with `dof: true` (its own report says so), and the capture came back
  // as six soft brown smudges — which was then read as "the explosion has no
  // structure". Some of that softness was the defocus, not the effect. This is
  // a diagnostic whose whole job is to show what the fireball CONTAINS, so the
  // lens blur has to come off; grade the running-game look from `combat_vfx`.
  debug.setPass('motionBlur', false);
  debug.setPass('dof', false);
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

  // FREEZE. The harness screenshots tens of seconds after this returns, which
  // is a hundred times the whole effect — without this every detonation would
  // be over and the frame would show smoke and nothing else. The freeze must
  // then be RELEASED IN __POSE_CLEANUP__, never on a timer: a 6 s timer used to
  // hand the clock back well before the shutter and undo the whole point.
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
    // WHERE EACH ONE LANDS ON SCREEN. Without this the strip has to be read by
    // projecting the world positions by hand against a guessed FOV, and the
    // first attempt at that put the youngest detonation on the wrong side of
    // the frame. `agesLeftToRight` is the ORDER OF THE ARRAY, not a promise
    // about the picture: which screen edge age 0.05 lands on depends on the
    // chase camera's yaw, so read the pixels off these coordinates.
    screenPx: spots.map((v) => {
      const q = v.clone().project(camNow);
      return [Math.round((q.x * 0.5 + 0.5) * (game.engine.width || 1920)),
              Math.round((-q.y * 0.5 + 0.5) * (game.engine.height || 1080))];
    }),
    metresFromLens: spots.map((v) => +v.distanceTo(camNow.position).toFixed(1)),
    // Are there any particles alive at all when the shutter opens?
    liveParticles: (() => {
      for (const k of ['count', '_count', 'alive', '_alive', 'active', '_active']) {
        const v = ps?.[k];
        if (typeof v === 'number') return { field: k, n: v };
        if (Array.isArray(v)) return { field: k, n: v.length };
      }
      return { field: null, n: 'unknown' };
    })(),
    note: 'Each detonation is frozen at the age in agesLeftToRight[i], at '
        + 'screenPx[i] — the array order is not necessarily left to right. '
        + 'The flash lives 0.06-0.105 s, the fireball 0.30-0.62 s, so the '
        + 'first one or two are SUPPOSED to be white-hot and featureless.',
    passes: debug.passes(),
  };

  // Sample from a LATE-UPDATE, not a timer. The note is read after the
  // screenshot, so a field rewritten every frame reports what the shutter saw.
  // The old version sampled on a 1000 ms timeout and called the result
  // `cameraAtShutter`, which is where the "setCamera does not reach the
  // render" puzzle in the comment above came from: the 6 s restore below fired
  // before the screenshot (which takes 24-130 s on this box), `releaseCamera`
  // handed the frame back to the chase camera, and the 1 s sample was long
  // gone by then. There was never a second camera.
  // Keep the unsubscribe — a sampler left installed rewrites the NEXT pose's
  // note every frame. See the note in landing.js for the measured case.
  const offNote = game.engine.addLateUpdate(() => {
    const n = window.__POSE_NOTE__;
    if (!n) return;
    const c = game.engine.camera;
    n.cameraAtShutter = c.position.toArray().map((v) => +v.toFixed(1));
    n.timeScaleAtShutter = game.engine.timeScale;
    n.psTimeAtShutter = +(game.vfx?.ps?.time ?? -1).toFixed(3);
    n.liveAtShutter = game.vfx?.liveParticles ?? null;
  });

  // Leave the session as we found it; poses share one browser. capture.mjs
  // runs this AFTER the screenshot and after the note is read, which is the
  // only place it can go: on a timer it unfreezes a 500 ms effect tens of
  // seconds before the picture is taken.
  window.__POSE_CLEANUP__ = () => {
    offNote?.();
    debug.freeze(false);
    debug.releaseCamera();
    debug.setPass('motionBlur', true);
    debug.setPass('dof', true);
  };
})();
