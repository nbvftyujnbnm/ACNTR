// Thruster plume close-up, with every timing variable removed.
//
// The flame layer has been proven to rasterise: rendering the shipped
// flameInner/flameOuter meshes into a 128x128 target with a camera pointed at a
// synthetic plume lights 3.7% of the target with saturated cores
// (tools/probes/flamepix.js). So the draw works and the question is entirely
// about the FRAME: where the plume is when the shutter opens, and where the
// camera is looking then.
//
// The harness renders about 1.1 s of real time AFTER this script returns, and
// `debug.setCamera` pins an ABSOLUTE world pose that does not follow the mech.
// Any pose that leaves the mech moving therefore photographs an empty patch of
// sky. So this one:
//   * leaves the mech GROUNDED and stationary, so the fixed camera stays framed
//   * detaches Game._updatePlayerThrusters (`game._plumes = null`) and re-forces
//     the handles on an interval, so nothing can reset them before the shutter
//   * republishes __POSE_NOTE__ on that same interval, so the numbers in
//     report.json describe the frame that was actually photographed rather than
//     the state 1.1 s earlier
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 120 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.5);

  // Detach the per-frame driver BEFORE forcing anything it owns.
  game._plumes = null;

  const force = () => {
    for (const f of (game.vfx?._flames || [])) {
      f.intensity = 4; f.target = 4; f.radius = 1.0; f.length = 6;
    }
  };
  force();
  debug.step(0.05);

  // Three-quarter rear: a cone aimed at the lens projects as a disc and
  // flameFrag weights alpha by fresnel, so head-on is a plume's dimmest view.
  debug.cameraBehindPlayer({ back: 9.0, up: 3.2, side: 7.0, lookY: 5.4, fov: 40 });
  debug.setPass('motionBlur', false);
  debug.step(0.05);

  const cam = game.engine.camera;
  const _v = new THREE.Vector3();

  const report = () => {
    const root = game.player.root.position;
    const ps = game.vfx.ps;
    const flames = (game.vfx?._flames || []).filter((f) => f.intensity > 0.01).map((f) => {
      // Where the plume's midpoint lands on screen, in 0..1 viewport coords.
      _v.copy(f.pos).addScaledVector(f.dirW, f.length * 0.5).project(cam);
      return {
        i: +f.intensity.toFixed(2),
        len: +f.length.toFixed(2),
        off: f.pos.clone().sub(root).toArray().map((n) => +n.toFixed(2)),
        dir: f.dirW.toArray().map((n) => +n.toFixed(2)),
        towardCam: +f.dirW.dot(_v.copy(cam.position).sub(f.pos).normalize()).toFixed(2),
        camDist: +cam.position.distanceTo(f.pos).toFixed(1),
        // NDC of the plume midpoint: |x|,|y| <= 1 and z in 0..1 means on screen.
        ndc: (() => {
          _v.copy(f.pos).addScaledVector(f.dirW, f.length * 0.5).project(cam);
          return [+_v.x.toFixed(2), +_v.y.toFixed(2), +_v.z.toFixed(3)];
        })(),
      };
    });
    const m = game.player.moveState || {};
    window.__POSE_NOTE__ = {
      shutterState: true,
      grounded: !!m.grounded,
      speed: +(m.speed ?? 0).toFixed(1),
      litPlumes: flames.length,
      plumes: flames,
      instanceCount: ps.flameInner.geometry.instanceCount,
      innerVisible: ps.flameInner.visible,
      outerVisible: ps.flameOuter.visible,
      camPos: cam.position.toArray().map((n) => +n.toFixed(1)),
      playerPos: game.player.root.position.toArray().map((n) => +n.toFixed(1)),
      onScreen: flames.filter((f) => Math.abs(f.ndc[0]) <= 1 && Math.abs(f.ndc[1]) <= 1 && f.ndc[2] > 0 && f.ndc[2] < 1).length,
    };
    if (!flames.length) window.__POSE_NOTE__.warning = 'no plume above idle';
    else if (!window.__POSE_NOTE__.onScreen) window.__POSE_NOTE__.warning = 'plumes are off screen at shutter time';
  };
  report();

  const t = setInterval(() => { force(); report(); }, 60);
  setTimeout(() => { clearInterval(t); debug.setPass('motionBlur', true); }, 6000);
})();
