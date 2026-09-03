// DIAGNOSTIC, not a review frame. The vista framing with Level's
// `ContainmentField` hidden — the arena-edge curtain a raycast through the
// streak pixels named (tools/probes/fanstreak.js). Difference this against
// fan_base to find out whether the curtain draws the streaks or merely sits
// in front of them.
//
// Hides by name walking the scene graph, so it does not need a handle from
// Level and does not care where in the graph the mesh lives.
(async () => {
  const { debug } = window.__ACNTR__;
  const scene = debug.game.engine.scene;
  let hidden = 0;
  scene.traverse((o) => {
    if (o.name === 'ContainmentField') { o.visible = false; hidden++; }
  });
  console.log(`[fan_nofield] hid ${hidden} ContainmentField mesh(es)`);

  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(1.5);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.8);
})();
