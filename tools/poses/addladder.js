// ADDITIVE RADIANCE LADDER — the transfer curve of the particle path.
//
// DIAGNOSTIC, not a review frame. It emits eight sprites straight into
// `ParticleSystem` (bypassing VFX entirely) with nothing varying but the
// authored radiance, holds them still, and photographs them against the sky.
// Reading the peak display value out of each box gives the one number every
// VFX argument in this project has been made without: what an authored
// radiance of R actually composites to on screen.
//
// WHY IT EXISTS. `muzzlestrip` at flashScale 0.7 measured peak luma 60-86
// across all five ages against a sky that peaks at 215 and a control patch
// 100 px above each flash at 47-63 — i.e. the entire flash, whose core sprite
// is authored at radiance 17, moves the frame by under 20 code values and
// produces ZERO pixels over L=200. Either the additive particle path is not
// drawing what it is asked to draw, or radiance 17 is simply not bright. Those
// two demand opposite fixes and no amount of looking at the picture separates
// them.
//
// Same framing rule as the other filmstrips: NO CAMERA OVERRIDE (it does not
// reach the render under freeze — see CONTRACT.md), DOF off, row placed
// between the chase lens and the player so a ~1 m sprite is photographed from
// ~20 m rather than 44.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ ahead: 40 });
  if (!open) debug.placePlayerOnGround(0, 60, 0, 0.05);
  debug.step(0.4);

  debug.setPass('motionBlur', false);
  debug.setPass('dof', false);
  debug.step(0.3);

  const p = game.player.root.position.clone();
  const ps = game.vfx && game.vfx.ps;

  // Radiance ladder. The last entry is the ALPHA batch at radiance 1 — the
  // control, because the alpha path is the one the explosion amendment proved
  // is carrying the colour, so it is known to draw.
  const RUNGS = [
    { r: 1, batch: 0 },
    { r: 2, batch: 0 },
    { r: 4, batch: 0 },
    { r: 8, batch: 0 },
    { r: 16, batch: 0 },
    { r: 32, batch: 0 },
    { r: 64, batch: 0 },
    { r: 1, batch: 1 },
  ];
  const SPACING = 3.0;
  const HEIGHT = 11;
  const AHEAD = -6;
  const SIZE = 0.5;
  const TILE_CORE = 1;

  const half = (RUNGS.length - 1) / 2;
  const spots = RUNGS.map((_, i) => {
    const v = debug.aheadOfPlayer(AHEAD, (i - half) * SPACING, new THREE.Vector3());
    v.y = p.y + HEIGHT;
    return v;
  });

  let emitted = 0;
  if (ps) {
    for (let i = 0; i < RUNGS.length; i++) {
      const g = RUNGS[i];
      const d = ps.begin(g.batch);
      d.pos.copy(spots[i]);
      d.life = 30;                 // outlives the harness's ~1.1 s settle
      d.size0 = SIZE; d.size1 = SIZE;
      d.tile = TILE_CORE;
      d.color0.setRGB(g.r, g.r, g.r);
      d.color1.setRGB(g.r, g.r, g.r);
      d.alpha0 = 1; d.alpha1 = 1;
      d.fadeIn = 0;
      d.alphaCurve = 0.05;         // flat: alpha stays ~1 for the whole shot
      d.sizeCurve = 1;
      d.erode = 0;
      if (ps.emit() >= 0) emitted++;
    }
  }

  debug.step(0.05, 1 / 480);
  debug.freeze(true);

  const cam = game.engine.camera;
  cam.updateMatrixWorld();
  const W = game.engine.width || 1920;
  const H = game.engine.height || 1080;
  const _v = new THREE.Vector3();
  const screen = spots.map((v) => {
    _v.copy(v).project(cam);
    return [Math.round((_v.x * 0.5 + 0.5) * W), Math.round((-_v.y * 0.5 + 0.5) * H)];
  });

  window.__POSE_NOTE__ = {
    diagnostic: 'eight particle sprites, identical but for authored radiance — not a running-game frame',
    rungs: RUNGS.map((g) => `${g.batch === 0 ? 'add' : 'alpha'}@${g.r}`),
    emitted,
    sizeMetres: SIZE,
    screenPx: screen,
    metresFromLens: spots.map((v) => +v.distanceTo(cam.position).toFixed(1)),
    cameraActual: cam.position.toArray().map((n) => +n.toFixed(1)),
    liveParticles: game.vfx ? game.vfx.liveParticles : null,
    passes: debug.passes(),
    note: 'Left to right: additive radiance 1,2,4,8,16,32,64 then ALPHA radiance 1. '
        + 'Peak display luma per box is the additive transfer curve.',
  };
  if (emitted !== RUNGS.length) {
    window.__POSE_NOTE__.warning = `only ${emitted}/${RUNGS.length} sprites were accepted by the particle system`;
  }

  setTimeout(() => {
    debug.freeze(false);
    debug.setPass('motionBlur', true);
    debug.setPass('dof', true);
  }, 6000);
})();
