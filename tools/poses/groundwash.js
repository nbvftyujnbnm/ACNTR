// GROUND WASH — a mech under thrust a few metres off the deck, blasting dust.
//
// This is a REVIEW-grade frame, not a diagnostic: everything in it is produced
// by the real movement model driving the real VFX path. Nothing is forced.
//
// Three harness facts it is built around, all of them recorded in CONTRACT.md
// and all of them expensive to rediscover:
//
//  1. THE SHUTTER OPENS ~1.1 s AFTER THIS SCRIPT RETURNS. So the mech must be
//     left in a state that KEEPS blasting the deck for that whole window —
//     hence held keys with a self-clearing release, and hence a hover rather
//     than a jump (a jump climbs out of wash height inside the window).
//  2. `debug.freeze(true)` is not usable here. The wash is a per-frame emitter
//     driven by dt, so a frozen sim emits nothing and the frame is empty.
//  3. ROOT ROTATION IS NOT THE AIM — use debug.placePlayer / cameraBehindPlayer,
//     which set rig yaw, entity aimYaw and controller yaw together.
//
// Framing: LOW and near side-on. A ground wash is a flat sheet, and a sheet
// seen from above is a disc with no shape to it. From 2 m off the deck the
// sheet is edge-on against the sky, which is the only angle that shows how far
// out it runs and how it rolls up at the rim.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 160 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.4);

  // Space + a direction is HORIZONTAL thrust (the ground-boost hover skim);
  // Space alone is vertical. We want the skim: the mech stays inside wash
  // height instead of climbing out of it, and it builds enough ground speed
  // for the trailing half of the wash to appear alongside the radial half.
  debug.holdKeys(['KeyW', 'Space']);
  debug.step(1.4);

  // Low, side-on-ish, looking slightly UP at the mech so the dust sheet is
  // silhouetted against the sky rather than seen against the ground it came
  // from. `side` is large and `up` small for exactly that reason.
  debug.cameraBehindPlayer({ back: 9.0, up: 1.6, side: 13.0, lookY: 2.6, fov: 40 });

  // Keys stay down through the settle window and release themselves — the
  // poses share one browser session and a latched key would drive every frame
  // captured after this one.
  setTimeout(() => debug.releaseKeys(), 3200);

  const m = game.player.moveState || {};
  const vfx = game.vfx;
  window.__POSE_NOTE__ = {
    heightAboveGround: +(m.heightAboveGround ?? -1).toFixed(2),
    speed: +(m.speed ?? 0).toFixed(1),
    grounded: !!m.grounded,
    boosting: !!m.boosting,
    washers: vfx?._washers?.length ?? null,
    liveParticles: vfx?.liveParticles ?? null,
    openGround: open ? open.clear : null,
  };
  if (!(vfx?._washers?.length)) {
    window.__POSE_NOTE__.warning = 'no ground-wash target registered — nothing can emit dust';
  } else if (!Number.isFinite(m.heightAboveGround) || m.heightAboveGround > 5.5) {
    window.__POSE_NOTE__.warning =
      `mech is ${(m.heightAboveGround ?? -1).toFixed(1)} m up, above the 5.5 m wash cutoff`;
  }
})();
