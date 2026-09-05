// VFX showcase: explosions, muzzle flashes, tracers, impacts, thruster plumes.
//
// TWO traps this pose exists to avoid, both of which it used to fall into.
//
// 1. REAL TIME AND SIM TIME DIVERGE HARD HERE. The shutter is tens of seconds
//    of real time after this script returns (capture.mjs settles 1100 ms and
//    then takes a screenshot that has measured 24-130 s), but only ~0.2-0.5 s
//    of SIMULATION time — the engine clamps dt to 0.1 s and only a handful of
//    frames run in that window. Both of this pose's earlier designs got that
//    wrong. Firing in-script and returning was blamed on effects going stale,
//    which was never the problem at 0.3 s of sim. Driving the volley from a
//    real-time interval instead fired it ~100 times into a static simulation
//    and made the frame so expensive the screenshot timed out and the pose
//    failed. The volley is now staged with `debug.step`, in sim time, and the
//    frame is frozen at the end — so the three-stage structure REVIEW.md grades
//    (white flash, orange fireball, black smoke column) is guaranteed rather
//    than hoped for.
//
// 2. ABSOLUTE WORLD COORDINATES DO NOT SURVIVE REAL TERRAIN. Everything is
//    positioned relative to the mech, and the mech is placed on measured open
//    ground rather than at a fixed coordinate.
(async () => {
  const { debug, THREE, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.32, range: 130 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.35);

  // Lift the mech so it is airborne under thrust for the whole settle window —
  // a grounded mech drops to the 0.07 idle thruster level, and the plumes are
  // half of what this frame is meant to show.
  const rp = game.player.root.position;
  const gy = game.physics?.groundHeight?.(rp.x, rp.z);
  // debug.yaw(), not root.rotation.y — feeding the root's yaw back into
  // placePlayer rotates the mech by however far the two have drifted, and
  // they have been measured a clean 180 deg apart.
  if (Number.isFinite(gy)) debug.placePlayer(rp.x, gy + 16, rp.z, debug.yaw());
  debug.holdKeys(['Space']);
  debug.step(0.6);

  const p = game.player.root.position.clone();
  // The basis the camera actually uses — see the note in gameplay.js.
  const fwd = debug.forward();
  const right = debug.right();
  const at = (f, u, r) => p.clone().addScaledVector(fwd, f).addScaledVector(right, r).setY(p.y + u);

  debug.spawnEnemy('ac', ...at(26, -6, -7).toArray(), 2);
  debug.spawnEnemy('mt', ...at(38, -13, 12).toArray(), 1);
  debug.step(0.3);

  // Three-quarter rear: the mech's exhaust is toward the lens without being
  // aimed down it (a plume aimed at the camera projects as a disc and the
  // shader's fresnel term makes head-on its dimmest view), and the engagement
  // is laid out in depth beyond it.
  debug.setCamera(
    at(-15, 6.5, 11.5),
    at(16, 1.0, -2.0),
    46,
  );
  debug.step(0.05);

  // --- the volley ----------------------------------------------------------
  // Phases are in SIM seconds. They used to be in real milliseconds, on the
  // theory that "the settle window is real time" — which is true of the window
  // and false of the simulation inside it, and that gap is what made this pose
  // fail. See the block above the staging loop below.
  let k = 0;
  const blast = () => {
    const i = k++;
    const lane = (i % 3) - 1;                       // -1 / 0 / +1 across the front
    const c = at(24 + (i % 4) * 7, -4 - (i % 3) * 3, lane * 13 + (i % 2) * 3);
    debug.vfx('explosion', c, 7 + (i % 3) * 3);
    debug.vfx('impact', c.clone().addScaledVector(fwd, -3),
      fwd.clone().negate(), i % 2 ? 'metal' : 'concrete');
  };
  const shoot = () => {
    debug.fireAll();
    const c = at(20 + Math.random() * 16, -3 - Math.random() * 8, (Math.random() - 0.5) * 22);
    debug.vfx('impact', c, fwd.clone().negate(), Math.random() < 0.5 ? 'metal' : 'energy');
  };

  // STAGED IN SIM TIME, NOT ON A REAL-TIME INTERVAL.
  //
  // This used to be `setInterval(blast, 300)` and `setInterval(shoot, 140)`,
  // and both readings of the shutter it was built on were wrong in opposite
  // directions. The shutter is tens of seconds of REAL time after this returns
  // but only ~0.2-0.5 s of SIM time (CONTRACT.md, 2026-09-05), so a real-time
  // interval fires roughly a hundred times into a simulation that has barely
  // moved, and none of what it deposits can expire. Capped at 6 s it starved
  // the frame; uncapped it buried it — measured, this pose's screenshot blew
  // capture.mjs's 180 s timeout and the shot FAILED.
  //
  // So the volley is staged with `debug.step`, which advances sim time
  // deterministically and at the rate the game actually runs. Oldest first, so
  // that when the last one goes off the first has had its full age: at the
  // shutter there is a blast at ~0.9 s (black smoke), one at ~0.6 (rolling fire
  // into smoke), one at ~0.3 (fireball) and one at ~0.0 (white flash) — the
  // three-stage structure REVIEW.md grades, and now it is guaranteed rather
  // than hoped for. Weapons fire between them so a muzzle flash is in the same
  // frame; the LAST volley is fired closest to the freeze because a flash is
  // gone in 80 ms.
  //
  // AND THE MECH IS PINNED WHILE IT RUNS. `Space` is held so the plumes stay
  // lit, which means 0.9 s of stepped sim would carry the mech up to 16 m up —
  // out of a frame whose camera was placed, in world coordinates, before the
  // volley started. `placePlayer` zeroes velocity, so re-seating it at `p` on
  // every step keeps the thrusters commanded and lit while the framing holds.
  const pinYaw = debug.yaw();
  for (const gap of [0.3, 0.3, 0.3]) {
    blast();
    shoot();
    debug.step(gap);
    debug.placePlayer(p.x, p.y, p.z, pinYaw);
  }
  blast();
  shoot();

  // FREEZE. Everything above is now within 0.9 s of its age and the flash
  // within 0. Without this the ~0.3 s of sim that still runs before the shutter
  // would take the muzzle flashes and the youngest fireball with it.
  debug.freeze(true);

  window.__POSE_CLEANUP__ = () => {
    debug.freeze(false);
    debug.releaseKeys();
  };

  const m = game.player.moveState || {};
  window.__POSE_NOTE__ = {
    grounded: !!m.grounded,
    litPlumes: (game.vfx?._flames || []).filter((f) => f.intensity > 0.05).length,
    liveParticles: game.vfx?.liveParticles ?? null,
    volley: 'four blasts staged 0.3 s apart in SIM time, oldest first, plus a '
          + 'weapon volley beside each; frozen after the last so the flash survives',
  };
})();
