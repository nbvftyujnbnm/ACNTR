// Why does the boost pose top out at ~59 m/s when assaultMax is 95?
// Hold the pose's keys, step the real controller, and report what the movement
// model actually sees each step.
(() => {
  const d = window.__ACNTR__.debug;
  const g = d.game;
  const c = g.controller;
  const inp = g.input;
  const out = { steps: [] };

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  d.placePlayerOnGround(0, 150, 0, 40);
  d.unpause();

  const axis = { x: 0, z: 0 };
  const sample = (label) => {
    const a = inp.moveAxis ? inp.moveAxis(axis) : axis;
    const s = c.state || {};
    out.steps.push({
      label,
      keys: [...(inp.keys || [])].join('+'),
      axis: [+a.x.toFixed(2), +a.z.toFixed(2)],
      downW: !!inp.down?.('KeyW'),
      downSpace: !!inp.down?.('Space'),
      downCtrl: !!inp.down?.('ControlLeft'),
      assaultTime: +(c.assaultTime ?? -1).toFixed(3),
      enRecovering: !!c.enRecovering,
      en: +(g.player.stats.en / g.player.stats.enMax).toFixed(2),
      grounded: !!s.grounded,
      assaultBoost: !!s.assaultBoost,
      assaultRamp: +(s.assaultRamp ?? 0).toFixed(2),
      speed: +(s.speed ?? 0).toFixed(1),
    });
  };

  // Exactly what tools/poses/boost.js does.
  d.holdKeys(['KeyW', 'Space', 'ControlLeft']);
  sample('t=0 (W+Space+Ctrl)');
  for (let i = 0; i < 5; i++) { d.step(0.44); sample(`W+Space+Ctrl t=${((i + 1) * 0.44).toFixed(2)}`); }

  // Now without Space — Space is the vertical-thrust key, and an assault boost
  // run should be W + Ctrl only.
  d.releaseKeys();
  d.resetState();
  d.placePlayerOnGround(0, 150, 0, 40);
  d.holdKeys(['KeyW', 'ControlLeft']);
  sample('t=0 (W+Ctrl)');
  for (let i = 0; i < 5; i++) { d.step(0.44); sample(`W+Ctrl t=${((i + 1) * 0.44).toFixed(2)}`); }
  d.releaseKeys();

  out.tunables = {
    walkSpeed: c.T?.walkSpeed, boostSpeed: c.T?.boostSpeed,
    assaultMax: c.T?.assaultMax, assaultRampTime: c.T?.assaultRampTime,
  };
  return out;
})();
