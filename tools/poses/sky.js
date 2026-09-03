// SKY DIAGNOSTIC — is there anything up there?
//
// The gameplay frame's sky is a near-uniform pink-grey with no cloud
// structure at all, and the obvious reading is that the cloud layer is broken.
// The live uniforms say otherwise: cover 0.52, opacity 0.86, and a cloud
// palette separated from 0.062 to 0.42. Every smoothstep in the sky shader has
// ascending edges, so this is not the reversed-edge trap either.
//
// The suspect is instead `cl *= smoothstep( 0.03, 0.40, up )` — the cloud deck
// is faded out below `up` 0.40, which is about 24 degrees of elevation. The
// chase camera looks slightly DOWN, so a gameplay frame only ever contains the
// first ~20 degrees above the horizon, where that term has knocked the clouds
// back to a fraction of their strength.
//
// If that is right, the clouds are fine and simply live above the frame. This
// pose settles it by pointing the camera up: if structure appears here and not
// in gameplay, nothing is broken and the fix is about WHERE the deck sits, not
// whether it draws.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ ahead: 70 });
  if (!open) debug.placePlayerOnGround(0, 60, 0, 0.05);
  debug.step(0.4);

  const p = game.player.root.position.clone();
  const fwd = debug.forward();

  // Look UP along the mech's own bearing. 34 degrees puts the horizon at the
  // bottom of frame and fills the rest with the elevations the gameplay
  // camera never reaches, so the two frames together separate "the clouds do
  // not render" from "the clouds are above the shot".
  const pitch = THREE.MathUtils.degToRad(34);
  const look = p.clone()
    .addScaledVector(fwd, Math.cos(pitch) * 400)
    .add(new THREE.Vector3(0, 6 + Math.sin(pitch) * 400, 0));
  debug.setCamera({ x: p.x, y: p.y + 6, z: p.z }, { x: look.x, y: look.y, z: look.z }, 62);
  // Teleporting the camera is an enormous apparent velocity, so motion blur
  // smears the whole first frame — the first run of this pose came back with
  // the mech drawn as vertical streaks. Turn it off and let TAA settle, since
  // nothing here is about movement.
  debug.setPass('motionBlur', false);
  debug.step(0.5);

  // Report the elevation band this frame covers, so the number in the note can
  // be compared against the 0.03..0.40 fade the shader applies.
  const cam = game.engine.camera;
  const halfV = THREE.MathUtils.degToRad(cam.fov) / 2;
  const centre = pitch;
  window.__POSE_NOTE__ = {
    pitchDeg: 34,
    elevationBandDeg: [
      +THREE.MathUtils.radToDeg(centre - halfV).toFixed(1),
      +THREE.MathUtils.radToDeg(centre + halfV).toFixed(1),
    ],
    // `up` in the shader is the view ray's y, so these are the values the
    // cloud fade is actually evaluated at across the frame.
    upBand: [
      +Math.sin(centre - halfV).toFixed(3),
      +Math.sin(centre + halfV).toFixed(3),
    ],
    cloudFadeEdges: [0.03, 0.40],
    passes: debug.passes(),
  };

  // Leave the pass as we found it; poses share one browser session.
  setTimeout(() => { debug.releaseCamera(); debug.setPass('motionBlur', true); }, 3000);
})();
