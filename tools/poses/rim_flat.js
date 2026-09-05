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
  // Captured BEFORE the overrides below, or the restore in __POSE_CLEANUP__
  // puts this arm's values back as though they were the defaults — which for
  // the control arm would leave dirBias and lumaWeight at 0 for every pose
  // that runs after it in the same browser session.
  const origBias = pipe.params.damage.dirBias;
  const origLuma = pipe.params.damage.lumaWeight;
  const p = game.player.root.position;

  const fwd = debug.forward(new THREE.Vector3());
  const right = debug.right(new THREE.Vector3());
  const src = { root: { position: new THREE.Vector3()
    .copy(p).addScaledVector(right, -52).addScaledVector(fwd, -26) } };
  src.root.position.y = p.y + 6;

  // The only difference from the shipped arm.
  pipe.params.damage.dirBias = 0.0;
  pipe.params.damage.lumaWeight = 0.0;

  // Re-arm ABOVE the decay: `_updateDynamics` subtracts `step * 5.5` from `hit`
  // BEFORE it computes the uniforms from it, and at the 12 fps a capture runs
  // at that step is 0.083 s -- so setting 0.85 here lands 0.39 in the frame and
  // the first run of this pose photographed a rim at uDamage 0.156 instead of
  // the 0.442 it was aiming for. Adding the decay back makes the post-decay
  // value exactly 0.85 whatever the frame rate is.
  const orig = pipe._updateDynamics.bind(pipe);
  pipe._updateDynamics = (dt) => {
    pipe._dyn.hit = 0.85 + Math.min(dt || 0.016, 0.1) * 5.5;
    pipe._setHitDirection({ source: src });
    orig(dt);
  };
  debug.step(0.2);

  // FREEZE. Not to hold the rim — the re-arm above does that — but to kill the
  // SCENE. The two arms are captured in separate `page.screenshot` calls that
  // have measured 60 s and 114 s, and without a freeze the mech animates, the
  // dust drifts and TAA resolves differently in between, so the difference
  // image carries a whole frame of unrelated motion. Measured on the first
  // A/B (shots/rim01, unfrozen): the central 35% of the frame, which no rim
  // reaches, differed by 1.0 code value of red excess between the two arms —
  // the same order as the lobe being looked for. Frozen, the two frames are
  // identical everywhere except the term under test.
  //
  // `_updateDynamics` still runs when frozen (late updaters and the pipeline
  // render are called every frame regardless of timeScale) but with dt 0, so
  // the re-arm holds and nothing decays.
  debug.freeze(true);

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
  // Sample until cleanup, which capture.mjs calls after the shutter. An
  // interval that is never cleared also survives into the NEXT pose and
  // overwrites its note.
  const t = setInterval(note, 60);
  // RESTORE THE MONKEY-PATCH. `pipe._updateDynamics` is replaced above, and
  // capture.mjs's between-pose reset cannot undo that — it only knows about
  // `debug`. Left in place it pins a 0.85 damage rim over every pose that runs
  // after this one in the same browser session, which is exactly the kind of
  // leak that once carried a red vignette out of the HUD pose and into the VFX
  // frame after it. Same for the two `params.damage` overrides.
  window.__POSE_CLEANUP__ = () => {
    clearInterval(t);
    pipe._updateDynamics = orig;
    pipe.params.damage.dirBias = origBias;
    pipe.params.damage.lumaWeight = origLuma;
    debug.freeze(false);
  };
})();
