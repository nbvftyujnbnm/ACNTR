// DIAGNOSTIC — the damage rim, held open so it can be photographed.
//
// A landed hit drives `_dyn.hit` to 0.85 and it decays at 5.5/s, so the whole
// flash is over in 0.155 s. The harness renders the captured frame about 1.1 s
// of real time AFTER this script returns, which means an honestly-timed pose
// photographs an empty frame every time. So this one holds the term open: it
// wraps `RenderPipeline._updateDynamics` and re-arms `hit` (and the incoming
// direction) at the TOP of every frame, before the uniforms are computed from
// it. `uDamage` therefore sits at exactly 0.85 * 0.52 = 0.442 — the same value
// the offline study in tools/retransfer.mjs was run at.
//
// The player is left at full AP on purpose, so `crit` is exactly zero and every
// code value of red in this frame is the HIT term. Its pair, `rim_flat.js`, is
// the same frame with `dirBias` and `lumaWeight` set to 0, which is the rim as
// it was before 0d0f1e8 — shoot both and difference them.
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

  // The attacker: 60 m out on the player's LEFT and slightly behind, so the
  // lobe has a side to be on and the confidence ramp is fully open.
  const fwd = debug.forward(new THREE.Vector3());
  const right = debug.right(new THREE.Vector3());
  const src = { root: { position: new THREE.Vector3()
    .copy(p).addScaledVector(right, -52).addScaledVector(fwd, -26) } };
  src.root.position.y = p.y + 6;

  pipe.params.damage.dirBias = 1.0;
  pipe.params.damage.lumaWeight = 1.0;

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
      arm: 'shipped (dirBias 1, lumaWeight 1)',
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
