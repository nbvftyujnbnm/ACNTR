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

  // Hold Space with no direction: per the contract's control-resolution note
  // that is pure vertical thrust, so the mech climbs and hovers rather than
  // travelling — the mains and verniers all fire while it stays put.
  debug.holdKeys(['Space']);
  debug.step(1.1);

  // Behind and slightly below, looking up the exhaust.
  // BEHIND the mech in its own frame. The first version used world-space
  // offsets, which put the camera in front of whichever way the mech happened
  // to be facing — so the pose that exists to photograph the exhaust had the
  // body between the lens and the plumes, and the empty frame was very nearly
  // diagnosed as a rendering failure.
  debug.cameraBehindPlayer({ back: 11.5, up: 3.4, side: 2.6, lookY: 4.6, fov: 38 });
  debug.setPass('motionBlur', false);
  debug.step(0.08);

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
  setTimeout(() => { debug.releaseKeys(); debug.setPass('motionBlur', true); }, 3000);
})();
