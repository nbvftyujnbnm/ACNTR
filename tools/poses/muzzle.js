// MUZZLE FLASH — the one effect this harness cannot photograph by accident.
//
// DIAGNOSTIC, not a review frame: it freezes the simulation mid-flash. Do not
// grade it as a picture of the running game; grade it as the only honest look
// at what a muzzle flash actually contains.
//
// Why it has to freeze. A muzzle flash is 38-105 ms of particle life, which is
// 2-6 frames at 60 fps and exactly what REVIEW.md asks for. Under SwiftShader
// this harness renders at 10 fps, so ONE FRAME IS 100 ms: a flash spawned just
// after a frame is dead before the next one, and a flash that survives is
// caught at a uniformly random age. The combat_vfx pose fires every 140 ms and
// therefore photographs a muzzle flash roughly half the time, at a random point
// in its life — which is why "the muzzle flashes are weak" has never been
// possible to check. Firing, stepping 30 ms, and freezing puts the shutter on
// the flash at its peak, every time.
//
// `debug.freeze(true)` sets engine.timeScale = 0, which stops dt reaching
// VFX.update, so the particle system's uTime stops and every particle holds its
// age. The renderer keeps running. `debug.step()` still advances the sim while
// frozen (it forces timeScale locally), so the ORDER here matters: fire, step
// to the age you want, then freeze.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 130 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.4);

  // `debug.forward()`/`right()`, never a basis rebuilt from `root.rotation.y`:
  // the root trails the aim by up to 180 deg, which put this camera behind the
  // mech with its own torso between the lens and the muzzle.
  const fwd = debug.forward();
  const right = debug.right();

  // Frame the RIGHT arm's muzzle from ahead and outboard, with the mech's own
  // torso behind it. A flash photographed against sky shows its shape and
  // nothing else; against the machine it also shows whether it LIGHTS the
  // machine, which is half of what REVIEW asks of it.
  const hp = game.player.hardpoints?.rArm;
  const mz = new THREE.Vector3();
  if (hp) hp.getWorldPosition(mz);
  else mz.copy(game.player.root.position).addScaledVector(fwd, 1.2).setY(game.player.root.position.y + 4.6);

  const cam = mz.clone().addScaledVector(fwd, 4.4).addScaledVector(right, 3.2);
  cam.y += 0.9;
  const look = mz.clone().addScaledVector(fwd, -0.8).addScaledVector(right, -1.4);
  debug.setCamera(cam, look, 34);
  debug.setPass('motionBlur', false);
  debug.step(0.05);

  // Fire, advance 30 ms of simulation, hold. The core sprite lives 42 ms and
  // the cross blades 38 ms, so 30 ms is late enough that the expanding gas and
  // the sparks have moved and early enough that the hot core is still there.
  debug.fireAll();
  debug.step(0.030, 1 / 480);
  debug.freeze(true);

  const ps = game.vfx?.ps;
  const lights = (ps?.lights?.slots || []).filter((s) => s.light?.visible);
  window.__POSE_NOTE__ = {
    diagnostic: 'simulation frozen 30 ms after the volley — not a running-game frame',
    liveParticles: game.vfx?.liveParticles ?? null,
    flashLights: lights.length,
    flashPeak: lights.length ? +Math.max(...lights.map((s) => s.peak)).toFixed(1) : 0,
    flashIntensityNow: lights.length ? +Math.max(...lights.map((s) => s.light.intensity)).toFixed(2) : 0,
    weapons: Object.entries(game.weapons?.slots || {})
      .filter(([, w]) => w)
      .map(([k, w]) => `${k}:${w.def?.id ?? '?'}@${w.def?.flashScale ?? '?'}`),
  };
  if (!lights.length) {
    window.__POSE_NOTE__.warning = 'no muzzle light is alive — either nothing fired or the pool dropped it';
  }

  setTimeout(() => {
    debug.freeze(false);
    debug.setPass('motionBlur', true);
  }, 3000);
})();
