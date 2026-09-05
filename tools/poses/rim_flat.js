// DIAGNOSTIC — the CONTROL arm for `rim_shipped.js`: the damage rim as it was
// before 0d0f1e8, i.e. radially symmetric and applied as a flat screen blend.
//
// Identical to `rim_shipped.js` in every other respect — same placement, same
// held-open hit at `uDamage` 0.442, same attacker 52 m to the player's left —
// so a pixel difference between the two frames is the two terms and nothing
// else. Both are DIAGNOSTICS: they hold a 0.155 s transient open so the shutter
// can find it, and must not be graded as review frames.
//
//   node tools/capture.mjs --out shots/rim01 --poses rim_shipped,rim_flat
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 120 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(1.0);

  const pipe = game.pipeline;
  const p = game.player.root.position;

  const fwd = debug.forward(new THREE.Vector3());
  const right = debug.right(new THREE.Vector3());
  const src = { root: { position: new THREE.Vector3()
    .copy(p).addScaledVector(right, -52).addScaledVector(fwd, -26) } };
  src.root.position.y = p.y + 6;

  // The only difference from the shipped arm.
  pipe.params.damage.dirBias = 0.0;
  pipe.params.damage.lumaWeight = 0.0;

  const orig = pipe._updateDynamics.bind(pipe);
  pipe._updateDynamics = (dt) => {
    pipe._dyn.hit = 0.85;
    pipe._setHitDirection({ source: src });
    orig(dt);
  };
  debug.step(0.2);

  const note = () => {
    const f = pipe.mFinal.uniforms;
    window.__POSE_NOTE__ = {
      arm: 'control (dirBias 0, lumaWeight 0)',
      uDamage: +f.uDamage.value.toFixed(3),
      uDamageBias: +f.uDamageBias.value.toFixed(3),
      uDamageLuma: +f.uDamageLuma.value.toFixed(3),
      dir: [+f.uDamageDir.value.x.toFixed(2), +f.uDamageDir.value.y.toFixed(2)],
      hitConf: +pipe._dyn.hitConf.toFixed(3),
      crit: +pipe._dyn.crit.toFixed(3),
      apRatio: +(game.player.stats.ap / game.player.stats.apMax).toFixed(2),
      warning: pipe._dyn.crit > 0.01
        ? 'crit is non-zero — the rim is not pure hit' : undefined,
    };
  };
  note();
  setInterval(note, 60);
})();
