// VFX showcase: explosions, muzzle flashes, tracers, impacts, thruster plumes.
//
// TWO traps this pose exists to avoid, both of which it used to fall into.
//
// 1. THE SHUTTER OPENS TENS OF SECONDS AFTER THIS SCRIPT RETURNS — capture.mjs
//    waits 1100 ms and then screenshots, and the screenshot itself has measured
//    24-130 s on this box. The old version fired its effects inside the script
//    and returned; AC6-scale impacts are gone in 200 ms and a fireball in under
//    a second, so the frame that got graded for "VFX" contained nothing but
//    stale smoke. Everything here is driven from a REAL-TIME interval that runs
//    until __POSE_CLEANUP__ (which capture.mjs calls AFTER the shutter), and the
//    volley is phased so that whenever the shutter opens there is one blast in
//    its white-flash stage, one in its orange-fireball stage, and one that is
//    already a black smoke column — which is exactly the three-stage structure
//    REVIEW.md grades.
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
  // Phases are in REAL milliseconds because the settle window is real time.
  // At any shutter time from ~0.6 s on, `blast` has produced a blast at every
  // age from 0 to 900 ms.
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

  blast();
  shoot();

  // 300 ms apart: at the shutter one blast is ~0.05-0.3 s old (white flash and
  // fireball), the one before it 0.35-0.6 s (rolling fire into smoke), the one
  // before that ~0.9 s (black smoke). Weapons fire twice as often so there is
  // always a muzzle flash inside its 60 ms life.
  const tb = setInterval(blast, 300);
  const ts = setInterval(shoot, 140);
  // Both volleys run until cleanup, which capture.mjs calls AFTER the shutter.
  window.__POSE_CLEANUP__ = () => {
    clearInterval(tb); clearInterval(ts); debug.releaseKeys();
  };

  const m = game.player.moveState || {};
  window.__POSE_NOTE__ = {
    grounded: !!m.grounded,
    litPlumes: (game.vfx?._flames || []).filter((f) => f.intensity > 0.05).length,
    liveParticles: game.vfx?.liveParticles ?? null,
    volley: 'explosion every 300 ms, weapons every 140 ms, through the settle window',
  };
})();
