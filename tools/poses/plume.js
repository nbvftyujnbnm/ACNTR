// Thruster plume close-up — the frame that isolates whether the plumes render.
//
// The boost pose reports its flame handles at intensity 1.4, anchored, radius
// 0.36, length 3.6 — i.e. the VFX side is doing everything it is asked — and
// the frame still shows no bright core anywhere on the mech. At 93 m/s that
// could be motion blur spreading a small bright object into nothing, or the
// soft-particle depth fade zeroing the alpha, or the plume simply being 40 px
// tall in a hazy frame. Those are different bugs and a full-speed wide shot
// cannot tell them apart.
//
// So: airborne and nearly stationary, camera close and BEHIND in the mech's own
// frame so the exhaust blows toward the lens, motion blur OFF. If the plume is
// invisible here it is not a framing problem.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 120 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.4);

  // Start HIGH, then hold Space. The harness renders the captured frame about
  // tens of seconds after this script returns, so a mech that is merely
  // airborne at pose end can be back on the ground by the shutter — and a
  // grounded mech drops to the 0.07 idle thruster level, which is correctly
  // almost invisible. Starting 30 m up means it cannot reach the ground inside
  // that window even if energy runs out, so whatever is photographed is a mech
  // under thrust.
  const gy = game.physics?.groundHeight?.(game.player.root.position.x, game.player.root.position.z);
  if (Number.isFinite(gy)) {
    // debug.yaw(), not root.rotation.y — the two have been measured 180 deg
    // apart, and feeding the root's back in spins the mech by the difference.
    debug.placePlayer(game.player.root.position.x, gy + 30, game.player.root.position.z,
                      debug.yaw());
  }
  debug.holdKeys(['Space']);
  debug.step(1.1);

  // Behind and slightly below, looking up the exhaust.
  // BEHIND the mech in its own frame. The first version used world-space
  // offsets, which put the camera in front of whichever way the mech happened
  // to be facing — so the pose that exists to photograph the exhaust had the
  // body between the lens and the plumes, and the empty frame was very nearly
  // diagnosed as a rendering failure.
  // Three-quarter rear, not straight behind. A cone aimed at the lens projects
  // as a small disc, and the shader weights alpha by fresnel so a head-on plume
  // is its own dimmest view — the worst possible angle for the one frame whose
  // job is to show it.
  debug.cameraBehindPlayer({ back: 11.0, up: 3.0, side: 7.5, lookY: 5.2, fov: 42 });
  debug.setPass('motionBlur', false);
  debug.step(0.08);

  // FREEZE. The harness screenshots tens of seconds after this returns, and a
  // mech holding vertical thrust climbs at up to 18 m/s — so the last frame put
  // it 15 m above where the camera was aimed and cropped its head off. Freezing
  // stops the simulation but not the renderer, and the flame handles keep the
  // intensity they were driven to, so the shot is exactly what was set up here.
  debug.freeze(true);

  const g = game;
  const m = g.player.moveState || {};
  // Where the plumes actually ARE, in world space, and which way they point —
  // relative to the mech and to the camera. Everything structural about the
  // flame layer has already been verified correct, so if nothing is on screen
  // the remaining possibilities are all geometric and all visible here.
  const cam = g.engine.camera;
  const root = g.player.root.position;
  const flames = (g.vfx?._flames || [])
    .filter((f) => f.intensity > 0.01)
    .map((f) => ({
      i: +f.intensity.toFixed(2),
      len: +f.length.toFixed(2),
      // offset from the mech's origin, so a plume buried in the body is obvious
      off: f.pos.clone().sub(root).toArray().map((n) => +n.toFixed(2)),
      dir: f.dirW.toArray().map((n) => +n.toFixed(2)),
      // does the plume run toward the camera or away from it?
      towardCam: +f.dirW.dot(cam.position.clone().sub(f.pos).normalize()).toFixed(2),
      camDist: +cam.position.distanceTo(f.pos).toFixed(1),
    }));
  window.__POSE_NOTE__ = {
    grounded: !!m.grounded,
    speed: +(m.speed ?? 0).toFixed(1),
    litPlumes: flames.length,
    plumes: flames,
    passes: debug.passes(),
  };
  if (!flames.length) window.__POSE_NOTE__.warning = 'no plume above idle — the thruster drive is not running';

  // Leave the pass as we found it; poses share one browser session.
  window.__POSE_CLEANUP__ = () => {
    debug.freeze(false);
    debug.releaseKeys();
    debug.setPass('motionBlur', true);
  };
})();
