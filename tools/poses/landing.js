// LANDING DUST — 60 tonnes of AC put back on the deck.
//
// Every particle in this frame comes from a REAL landing: the mech is dropped
// and the `EV.LANDED` the controller emits is what calls `VFX.landingDust`.
// Nothing is forced, and the note reports whether the landing actually
// happened so a frame that missed it cannot be graded as though it had.
//
// The timing is the whole trick, and it is built on the harness fact that has
// bitten three separate diagnoses: THE SHUTTER OPENS ~1.1 s OF REAL TIME AFTER
// THIS SCRIPT RETURNS. So the pose does NOT land the mech and then return —
// that dust would be 1.1 s old and mostly gone. It returns with the mech
// hanging at rest 6.75 m up, which under this game's 24 m/s^2 gravity is
// exactly 0.75 s of fall: the impact lands about a third of a second before
// the shutter, with the fast skirt still expanding and the billow rolling up
// behind it.
//
// The one way this degrades is toward a YOUNGER effect, never a missing one:
// the engine clamps dt to 0.1 s, so if the box is loaded enough that the sim
// runs behind real time the impact simply happens closer to the shutter.
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
  let landings = 0;
  let lastImpact = 0;
  const off = bus.on(EV.LANDED, (p) => {
    if (!p || p.entity !== game.player) return;
    landings++;
    lastImpact = p.impactSpeed ?? 0;
  });

  // Hang the mech at rest 6.75 m up and RETURN. placePlayer zeroes velocity, so
  // the fall is a clean 0.75 s and arrives at ~18 m/s — a `hard` of 0.69, well
  // past the 0.55 at which landingDust also throws its dust ring.
  if (Number.isFinite(gy)) debug.placePlayer(x, gy + 6.75, z, yaw);

  // Read the note back after the impact should have happened, not now: at this
  // point the mech has not fallen a millimetre. capture.mjs reads
  // __POSE_NOTE__ after the screenshot, so a timer that fires inside the
  // settle window still lands in report.json.
  setTimeout(() => {
    const m = game.player.moveState || {};
    window.__POSE_NOTE__ = {
      landings,
      impactSpeed: +lastImpact.toFixed(1),
      grounded: !!m.grounded,
      heightAboveGround: +(m.heightAboveGround ?? -1).toFixed(2),
      liveParticles: game.vfx?.liveParticles ?? null,
      openGround: open ? open.clear : null,
    };
    if (!landings) {
      window.__POSE_NOTE__.warning =
        'the mech never landed inside the settle window — this frame has no landing dust in it';
    }
    off?.();
  }, 950);

  // Placeholder in case the timer has not fired when the note is read.
  window.__POSE_NOTE__ = { pending: true };
})();
