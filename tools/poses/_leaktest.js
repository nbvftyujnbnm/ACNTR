// A POSE THAT DELIBERATELY LEAKS A HOOK, TO PROVE THE LEAK CHECK FIRES.
//
// `capture.mjs` counts `engine._updaters` / `_lateUpdaters` before each pose and
// after its cleanup, and reports growth as `leakedHooks`. That guard exists
// because a pose which installs an `addLateUpdate` sampler and drops the
// unsubscribe rewrites the NEXT pose's `__POSE_NOTE__` every frame — measured,
// `cliff` in shots/rehab2 carried the landing pose's numbers beside a
// photograph of a cliff.
//
// A GUARD THAT HAS NEVER FIRED IS NOT A VERIFIED GUARD. Since the three real
// poses were fixed, nothing leaks, so the reporting branch has never executed
// and an inverted comparison or a typo in it would look exactly like success.
// This pose installs one updater and one late-updater and throws both
// unsubscribes away, so a run over it MUST report
// `leakedHooks: { update: 1, lateUpdate: 1 }`.
//
//   node tools/capture.mjs --poses _leaktest --out shots/leak
//
// Leading underscore so it sorts out of the way and reads as a fixture rather
// than a review frame. It is NOT in REVIEW_POSES and must never be added.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.resetState();
  debug.step(0.2);

  // Both kinds, because the check counts them separately and a bug could
  // plausibly catch one and miss the other.
  game.engine.addUpdate(() => { /* deliberately never removed */ });
  game.engine.addLateUpdate(() => { /* deliberately never removed */ });

  window.__POSE_NOTE__ = {
    fixture: 'leaks 1 update + 1 late-update on purpose',
    expect: 'report.json must carry leakedHooks {update:1, lateUpdate:1} for this pose',
  };
  // No __POSE_CLEANUP__ on purpose — that is the whole point of the fixture.
})();
