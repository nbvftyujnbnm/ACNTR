// Does the INSTANCED PARTICLE PATH produce pixels at all?
//
// The flame layer has been eliminated as a content problem: correct anchor
// positions, correct directions, intensity forced to 6, instanceCount 4,
// mesh visible, material forced to opaque NormalBlending with depthTest off
// and renderOrder 9999 — and the frame does not change by one pixel. A draw
// that is submitted and rasterises nothing points at the vertex stage, whose
// early-out (`gl_Position = vec4(0,0,2,1)`, i.e. clipped) fires when the
// per-instance intensity reads 0.
//
// The main particle system uses the IDENTICAL construction: an
// InstancedBufferGeometry whose per-instance attributes are
// InterleavedBufferAttributes at offsets into one InstancedInterleavedBuffer.
// So if instanced interleaved attributes are not reaching the shader here,
// nothing in this game's particle system has ever been visible — every
// explosion, spark, smoke puff and plume — and every VFX review made from
// these captures was made on frames with no particles in them.
//
// This pose settles it: a large explosion at point-blank range in front of a
// fixed camera, with the live particle count reported alongside.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();

  debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 120 });
  debug.step(0.4);

  const p = game.player.root.position.clone();
  const centre = new THREE.Vector3(p.x, p.y + 7, p.z);

  // Look at the blast from 22 m — big in frame, nothing between it and the lens.
  debug.setCamera(
    { x: centre.x + 16, y: centre.y + 5, z: centre.z + 15 },
    { x: centre.x, y: centre.y, z: centre.z },
    45,
  );

  // Fire several so the frame cannot miss on timing alone, and keep firing
  // through the settle window — the harness renders about 1.1 s after this
  // script returns, and AC6-scale impacts are gone in 200 ms.
  const boom = () => {
    debug.vfx('explosion', centre.clone(), 14);
    debug.vfx('impact', new THREE.Vector3(centre.x + 3, centre.y - 2, centre.z), new THREE.Vector3(0, 1, 0), 'metal');
  };
  boom();
  debug.step(0.05);
  boom();
  debug.step(0.05);

  const ps = game.vfx?.ps;
  window.__POSE_NOTE__ = {
    liveParticles: game.vfx?.liveParticles ?? null,
    psLive: ps?.live ?? null,
    quadInstances: ps?._geo?.instanceCount ?? null,
    // If particles are alive but the frame is empty, the instanced path is
    // producing no pixels and the whole VFX category is unreviewable.
    note: 'if liveParticles > 0 and the frame is empty, the instanced particle path draws nothing',
  };

  // Keep replenishing so something is alive when the shutter actually opens.
  let n = 0;
  const t = setInterval(() => { boom(); if (++n > 12) clearInterval(t); }, 90);
})();
