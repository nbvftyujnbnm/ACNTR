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
// THE A/B HALF: identical to plume.js except that the soft-particle depth fade
// is switched OFF by handing VFX a null depth texture.
//
// This is testing a regression I may have introduced. Before the depth texture
// was wired, `uSoftParams.x` was 0 and `softDepthFade()` returned 1.0 — every
// particle fully opaque. Wiring it turned the path on, and the texture handed
// over is `rtScene.depthTexture`: the depth attachment of the very target the
// VFX is drawing into. Sampling a buffer you are writing to is a feedback loop,
// and if the read comes back 0 then `sceneZ` collapses to the near plane,
// `sceneZ - viewZ` goes negative and EVERY soft particle clamps to zero alpha.
// If this frame shows a plume and plume.png does not, that is the answer.
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
  game.vfx.setDepthTexture(null); // soft fade OFF — the whole point of this pose
  debug.step(0.08);

  const g = game;
  const m = g.player.moveState || {};
  const flames = (g.vfx?._flames || [])
    .filter((f) => f.intensity > 0.01)
    .map((f) => +(f.intensity ?? 0).toFixed(2));
  window.__POSE_NOTE__ = {
    grounded: !!m.grounded,
    speed: +(m.speed ?? 0).toFixed(1),
    litPlumes: flames.length,
    intensities: flames,
    passes: debug.passes(),
  };
  if (!flames.length) window.__POSE_NOTE__.warning = 'no plume above idle — the thruster drive is not running';

  // Leave the pass as we found it; poses share one browser session.
  // Restore both, since the poses share one browser session.
  window.__POSE_CLEANUP__ = () => {
    debug.releaseKeys();
    debug.setPass('motionBlur', true);
    game._vfxDepthTex = null;
    game._wireVfxDepth();
  };
})();
