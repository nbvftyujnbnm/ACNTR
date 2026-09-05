// Does the damage rim point at the thing that shot you?
//
// The rim's direction is the one part of this change that cannot be checked
// offline: `tools/retransfer.mjs` models the SHADER exactly, but the screen
// direction it is given is computed in `Pipeline._setHitDirection` from the
// camera's own basis, and a sign error there produces a rim that is beautifully
// lobed and points the wrong way — which a still of one hit cannot distinguish
// from a correct one.
//
// So this probe does not trust the basis arithmetic at all. For each test
// attacker it PROJECTS the world position through the live camera to get the
// screen position three itself would put it at, then asks whether the rim's
// direction agrees. For attackers in FRONT of the camera those two must match;
// for attackers BEHIND, the projection is mirrored and they must be opposite —
// that mirroring is exactly why the code uses the camera-space (x, y) rather
// than the projection.
//
//   node tools/probe.mjs --file tools/probes/damagerim.js
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const pipe = game.pipeline;
  if (!pipe || !pipe._setHitDirection) return { error: 'no pipeline / no _setHitDirection' };

  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(1.0);

  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);
  const camPos = cam.position.clone();
  const m = cam.matrixWorld.elements;
  const right = new THREE.Vector3(m[0], m[1], m[2]);
  const up = new THREE.Vector3(m[4], m[5], m[6]);
  const fwd = new THREE.Vector3(-m[8], -m[9], -m[10]);

  // Attackers placed in the CAMERA's own frame, so the expected answer is
  // written in the name rather than inferred from world coordinates.
  const cases = [
    ['ahead',         0.00,  0.00,  1.0],
    ['ahead+8deg-L', -0.14,  0.00,  1.0],
    ['left',         -1.00,  0.00,  1.0],
    ['right',         1.00,  0.00,  1.0],
    ['above',         0.00,  1.00,  1.0],
    ['below',         0.00, -1.00,  1.0],
    ['upper-left',   -0.70,  0.70,  1.0],
    ['behind-left',  -0.70,  0.00, -1.0],
    ['behind-right',  0.70,  0.00, -1.0],
  ];

  const v3 = new THREE.Vector3();
  const out = [];
  for (const [name, rx, ry, fz] of cases) {
    const p = camPos.clone()
      .add(right.clone().multiplyScalar(rx * 60))
      .add(up.clone().multiplyScalar(ry * 60))
      .add(fwd.clone().multiplyScalar(fz * 60));

    pipe._setHitDirection({ source: { root: { position: p } } });
    const dir = { x: +pipe._damageDir.x.toFixed(3), y: +pipe._damageDir.y.toFixed(3) };
    const conf = +pipe._dyn.hitConf.toFixed(3);

    // Where three itself puts that point on screen. NDC x is +right and y is
    // +up, which is the same convention the rim's direction uses.
    v3.copy(p).project(cam);
    const behind = fwd.dot(v3.copy(p).sub(camPos)) < 0;
    v3.copy(p).project(cam);
    const nl = Math.hypot(v3.x, v3.y) || 1;
    const proj = { x: +(v3.x / nl).toFixed(3), y: +(v3.y / nl).toFixed(3) };
    // Agreement, as a cosine. In front: +1 is correct. Behind: -1 is correct,
    // because the projection has flipped and the rim deliberately has not.
    const agree = +(dir.x * proj.x + dir.y * proj.y).toFixed(3);

    out.push({ case: name, behind, dir, projDir: proj, agree, conf });
  }

  // And the uniform plumbing, which is the other half of "does it reach the
  // frame": drive the dynamics the way a landed hit does and read what the
  // final material actually holds.
  const f = pipe.mFinal.uniforms;
  const read = () => ({
    uDamage: +f.uDamage.value.toFixed(3),
    uDamageBias: +f.uDamageBias.value.toFixed(3),
    uDamageLuma: +f.uDamageLuma.value.toFixed(3),
    dir: [+f.uDamageDir.value.x.toFixed(3), +f.uDamageDir.value.y.toFixed(3)],
  });

  const uniforms = {};
  // A hit at full health, from the left: fully directional.
  pipe._setHitDirection({ source: { root: {
    position: camPos.clone().add(right.clone().multiplyScalar(-60)).add(fwd.clone().multiplyScalar(60)) } } });
  pipe._dyn.hit = 0.85; pipe._dyn.crit = 0;
  pipe._updateDynamics(0);
  uniforms.hitOnly = read();

  // The same hit on a dying mech: the crit term owns most of the rim, so the
  // bias must fall away and the warning go back to symmetric.
  pipe._dyn.hit = 0.85; pipe._dyn.crit = 1;
  pipe._updateDynamics(0);
  uniforms.hitPlusCrit = read();

  // Low AP with no incoming fire: symmetric, whatever the last direction was.
  pipe._dyn.hit = 0; pipe._dyn.crit = 1;
  pipe._updateDynamics(0);
  uniforms.critOnly = read();

  // And the params switch, which is how a future A/B turns this off.
  game.pipeline.params.damage.dirBias = 0;
  pipe._dyn.hit = 0.85; pipe._dyn.crit = 0;
  pipe._updateDynamics(0);
  uniforms.dirBiasOff = read();
  game.pipeline.params.damage.dirBias = 1;

  return { fov: cam.fov, cases: out, uniforms };
})()
