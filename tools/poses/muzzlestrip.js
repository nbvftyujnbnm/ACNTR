// MUZZLE FLASH FILMSTRIP — six flashes, each frozen at a different age.
//
// DIAGNOSTIC, not a review frame. `tools/poses/muzzle.js` is the in-situ shot:
// the real gun, the real barrel, one age. This is the other half — what the
// effect CONTAINS over its whole life, side by side, which is the only way to
// answer "is the flash bright/long/shaped enough" on a box that renders at
// 10 fps and therefore samples a 40 ms sprite once at a random age.
//
// THE MEASUREMENT THAT MADE THIS NECESSARY. `particleVert` fades every
// particle TWICE: `alpha = mix(aCol0.a, aCol1.a, t) * fadeIn * tail`, where
// `tail = pow(1 - t, alphaCurve)`. Anything authored `alpha0 = 1, alpha1 = 0`
// therefore runs at (1-t)^(1+curve), not (1-t). For the flash core
// (life 0.042, alphaCurve 1.4) that is (1-t)^2.4: 44% alpha at a THIRD of its
// life, 5% at 71%. `muzzle.js` shoots at 30 ms — 71% — and photographs a flash
// that is arithmetically over. The ages below bracket the part that is
// actually visible.
//
// Same framing rule as the explosion filmstrip: NO CAMERA OVERRIDE (it does
// not reach the render under freeze, recorded in CONTRACT.md). The row is
// placed ahead of the player and photographed by the real chase camera.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ ahead: 40 });
  if (!open) debug.placePlayerOnGround(0, 60, 0, 0.05);
  debug.step(0.4);

  const p = game.player.root.position.clone();

  // Ages in seconds. The core sprite lives 42 ms, the cross blades 38 ms, the
  // flare 62 ms, the gas cone 60-100 ms — so this brackets birth to death.
  // WHERE THE ROW GOES, AND WHY IT IS BEHIND THE PLAYER.
  // Run 1 put it 17 m AHEAD, which is ~44 m from the chase lens with the mech
  // sitting in the middle of it, and with DOF focused on the mech. It came
  // back as five faint smudges and two hot pixels that were the mech's own
  // lamps: nothing gradeable. A muzzle flash is a ~2 m object, so it has to be
  // photographed from ~20 m, not 44. `ahead` is negative — the row is placed
  // BETWEEN the chase camera and the player — and lifted clear of the mech's
  // head so nothing occludes it.
  const AGES = [0.004, 0.014, 0.030, 0.050, 0.080];
  const AHEAD = -6;
  const SPACING = 4.4;
  const HEIGHT = 11;
  // In-game flashScale: rifle 0.55, handgun 0.7, missile 0.9. Grade the shape
  // at the scale the game actually uses, not at a flattering one.
  const SCALE = 0.7;

  // Blow the flash ACROSS the view. The cross blade and the barrel streaks are
  // world-space and anisotropic; pointed at the lens they collapse to a disc
  // and the one thing this pose exists to grade cannot be seen.
  const dir = debug.right().clone().normalize();

  // DOF OFF: the row is nowhere near the focus plane, and run 1 photographed
  // the defocus rather than the effect.
  debug.setPass('motionBlur', false);
  debug.setPass('dof', false);
  debug.step(0.3);

  const half = (AGES.length - 1) / 2;
  const spots = AGES.map((_, i) => {
    const v = debug.aheadOfPlayer(AHEAD, (i - half) * SPACING, new THREE.Vector3());
    v.y = p.y + HEIGHT;
    return v;
  });

  // Oldest first, so the youngest is triggered last.
  const sorted = AGES.map((a, i) => ({ a, i })).sort((x, y) => y.a - x.a);
  let elapsed = 0;
  for (const { a, i } of sorted) {
    const wait = (sorted[0].a - a) - elapsed;
    if (wait > 0) { debug.step(wait, 1 / 960); elapsed += wait; }
    debug.vfx('muzzleFlash', spots[i].clone(), dir.clone(), SCALE);
  }
  const rest = sorted[0].a - elapsed;
  if (rest > 0) debug.step(rest, 1 / 960);

  debug.freeze(true);

  // Report where each flash landed ON SCREEN, so the next reader can crop
  // straight to it instead of hunting. Being inside the frustum and being
  // visible are different questions, but a pixel box at least says where to
  // look for the answer.
  const cam = game.engine.camera;
  cam.updateMatrixWorld();
  const W = game.engine.width || 1920;
  const H = game.engine.height || 1080;
  const _p = new THREE.Vector3();
  const screen = spots.map((v) => {
    _p.copy(v).project(cam);
    return [Math.round((_p.x * 0.5 + 0.5) * W), Math.round((-_p.y * 0.5 + 0.5) * H)];
  });

  window.__POSE_NOTE__ = {
    diagnostic: 'six muzzle flashes frozen at the ages listed — not a running-game frame',
    agesLeftToRight: AGES,
    flashScale: SCALE,
    blowDirection: dir.toArray().map((n) => +n.toFixed(2)),
    playerAt: p.toArray().map((n) => +n.toFixed(1)),
    spots: spots.map((v) => v.toArray().map((n) => +n.toFixed(1))),
    screenPx: screen,
    metresFromLens: spots.map((v) => +v.distanceTo(cam.position).toFixed(1)),
    cameraActual: cam.position.toArray().map((n) => +n.toFixed(1)),
    liveParticles: game.vfx?.liveParticles ?? null,
    note: 'Left to right = youngest to oldest. If the strip fades to nothing by '
        + 'the third box the flash is over inside one 60 fps frame.',
    passes: debug.passes(),
  };

  setTimeout(() => {
    debug.freeze(false);
    debug.releaseCamera();
    debug.setPass('motionBlur', true);
    debug.setPass('dof', true);
  }, 6000);
})();
