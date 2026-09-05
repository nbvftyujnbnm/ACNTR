// LANDING DUST — 60 tonnes of AC put back on the deck.
//
// Every particle in this frame comes from a REAL landing: the mech is dropped
// and the `EV.LANDED` the controller emits is what calls `VFX.landingDust`.
// Nothing is forced, and the note reports whether the landing actually
// happened so a frame that missed it cannot be graded as though it had.
//
// The timing is the whole trick, and this pose used to get it wrong in the way
// documented at the top of CONTRACT.md's harness section. THE SHUTTER DOES NOT
// OPEN 1.1 s AFTER THIS SCRIPT RETURNS. capture.mjs waits `SETTLE` (1100 ms)
// and THEN calls `page.screenshot`, which on this canvas has measured 24 to
// 130 SECONDS — every `shotMs` in `shots/*/report.json` says so — with the
// page still ticking (slowly) throughout. A sub-second dust sheet timed to
// land "just before the shutter" is therefore a minute old in the picture.
//
// So the pose no longer races the shutter: it drops the mech, and freezes the
// clock 0.18 s AFTER the real `EV.LANDED`. The frame then holds the impact for
// as long as the capture takes, with the fast skirt still expanding and the
// billow rolling up behind it, whatever the box's frame rate is doing.
(async () => {
  const { debug, game, bus, EV } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 140 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.5);

  const rp = game.player.root.position;
  const x = rp.x, z = rp.z;
  const yaw = game.player.root.rotation.y;
  const gy = game.physics?.groundHeight?.(x, z);

  // Frame the GROUND the mech is about to hit, from low down and well off to
  // the side. A landing wash is a flat sheet; from above it is a disc with no
  // shape, and only a near-ground camera shows how far it runs out.
  debug.cameraBehindPlayer({ back: 9.5, up: 2.4, side: 12.5, lookY: 1.4, fov: 42 });

  // Count real landings from here on, so the note can say whether the frame
  // contains one rather than assuming it does.
  // FREEZE ON IMPACT. The dust sheet lives well under a second, and the
  // screenshot of this canvas has measured 24-130 s (every `shotMs` in
  // `shots/*/report.json`). Waiting for the shutter to happen to coincide with
  // the landing is not a plan; holding the clock at the landing is. `hold` is
  // a fraction of a second of dust growth after touchdown, so the sheet has
  // spread rather than being caught as a point.
  const HOLD_AFTER_IMPACT = 0.18;
  let landings = 0;
  let lastImpact = 0;
  let holdLeft = -1;
  const off = bus.on(EV.LANDED, (p) => {
    if (!p || p.entity !== game.player) return;
    landings++;
    lastImpact = p.impactSpeed ?? 0;
    if (holdLeft < 0) holdLeft = HOLD_AFTER_IMPACT;
  });

  // Hang the mech at rest 6.75 m up. placePlayer zeroes velocity, so the fall
  // is a clean 0.75 s and arrives at ~18 m/s — a `hard` of 0.69, well past the
  // 0.55 at which landingDust also throws its dust ring.
  if (Number.isFinite(gy)) debug.placePlayer(x, gy + 6.75, z, yaw);

  // AND FALL IT HERE, IN STEPPED SIM TIME, RATHER THAN RETURNING AND HOPING.
  // The previous version dropped the mech and returned. Measured on
  // shots/rehab1: at the shutter it was still 6.26 m up — a fall of 0.49 m,
  // 0.20 s under this game's 24 m/s^2. Only a fraction of a second of SIM time
  // passes between a pose returning and the shutter however long the capture
  // takes in real seconds (CONTRACT.md, 2026-09-05), so the mech never landed
  // and the pose reported `landings: 0` on every run.
  //
  // `debug.step` advances the simulation deterministically, so the fall
  // completes here, `EV.LANDED` fires here, and the freeze below lands exactly
  // HOLD_AFTER_IMPACT after touchdown whatever the box's frame rate is doing.
  // Stepped at 1/120 so the impact frame is resolved to 8 ms rather than to the
  // 100 ms the engine's clamped dt would give.
  for (let t = 0; t < 1.4 && holdLeft !== 0; t += 1 / 120) {
    debug.step(1 / 120, 1 / 120);
    if (holdLeft > 0) {
      holdLeft -= 1 / 120;
      if (holdLeft <= 0) { holdLeft = 0; debug.freeze(true); }
    }
  }

  // Report from a LATE-UPDATE, not a timer. capture.mjs reads __POSE_NOTE__
  // after the screenshot, so a field rewritten every frame describes the state
  // the shutter actually saw. The old version sampled on a 950 ms timeout and
  // then let the sim run on for the length of the capture, so `landings` and
  // `liveParticles` in report.json belonged to a frame that was tens of
  // seconds older than the picture beside them.
  window.__POSE_NOTE__ = { pending: true };
  // KEEP THE UNSUBSCRIBE. `addLateUpdate` returns one, and dropping it leaves
  // this sampler running for the rest of the browser session — it then
  // overwrites the NEXT pose's `__POSE_NOTE__` every frame. Measured: in
  // shots/rehab2 the `cliff` shot's report carried this pose's landing numbers
  // (`landings: 1, impactSpeed: 17.4, frozenAtImpact: true`), which is a report
  // that looks fine and describes a different picture.
  const offNote = game.engine.addLateUpdate(() => {
    const m = game.player.moveState || {};
    const n = {
      landings,
      impactSpeed: +lastImpact.toFixed(1),
      grounded: !!m.grounded,
      heightAboveGround: +(m.heightAboveGround ?? -1).toFixed(2),
      liveParticles: game.vfx?.liveParticles ?? null,
      openGround: open ? open.clear : null,
      frozenAtImpact: holdLeft === 0 && landings > 0,
      timeScale: game.engine.timeScale,
    };
    if (!landings) {
      n.warning = 'the mech never landed during the stepped fall — this frame has no landing dust in it';
    } else if (!n.liveParticles) {
      n.warning = 'landed, but nothing is alive in the particle system at shutter time';
    }
    window.__POSE_NOTE__ = n;
  });

  window.__POSE_CLEANUP__ = () => { debug.freeze(false); off?.(); offNote?.(); };
})();
