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
//
// ---------------------------------------------------------------------------
// FRAMING, and why the first version of this pose photographed a booster nozzle
//
// 1. THE FLASH IS NOT AT THE HARDPOINT. `WeaponSystem._muzzle` adds the weapon
//    def's `muzzleOffset` (-1.35 m for the rifle, -2.2 m for the laser) to the
//    hardpoint, and the flash is spawned at THAT point — `ctx.origin`. Framing
//    on `hardpoints.rArm` misses by up to two metres at a three-metre lens.
// 2. `debug.forward()` IS THE AIM YAW, NOT THE BARREL. They agree in the
//    running game; they did not here, and the camera ended up 4.4 m behind the
//    mech looking at its back. Measured: forward() = (0,0,1) while every slot
//    fired along (0.94,-0.34,0.05). That disagreement was a real bug (the aim
//    point was never written and every weapon shot at the world origin — fixed
//    in WeaponSystem), but the lesson outlives the bug: FRAME OFF THE EFFECT'S
//    OWN MEASURED ANCHOR, never off a predicted one. This pose fires a first
//    volley purely to populate `weapons._ctx`, reads the real origin and
//    direction out of it, and only then places the lens.
// 3. THE GUN AIMS WHERE THIS CAMERA LOOKS. With no hard lock, `_aimPoint`
//    falls through to `TargetingSystem.getAimRay`, which is built from the LIVE
//    camera — the one `debug.setCamera` has just overridden. So a lens placed
//    in front of the muzzle looking back makes the mech shoot at the lens. The
//    only framing that is stable under that feedback is OVER THE BARREL: sit
//    behind and outboard of the muzzle looking down-range, so the direction the
//    pose asks for and the direction the gun takes are the same one.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const open = debug.placePlayerInOpenGround({ arc: Math.PI * 0.3, range: 130 });
  if (!open) debug.placePlayerOnGround(0, 150, 0, 0.05);
  debug.step(0.4);

  // Something down-range: the aim ray converges on the first thing the
  // crosshair hits, so an enemy ahead both aims the barrel at a real target and
  // gives the tracer somewhere to go.
  const tgt = debug.aheadOfPlayer(46, 4, new THREE.Vector3());
  debug.spawnEnemyOnGround('mt', tgt.x, tgt.z, 1, 0);
  debug.step(0.5);

  // ---- volley one: populate the fire context, then throw the frame away ----
  debug.fireAll();
  const ctx = game.weapons?._ctx?.rArm;
  const mz = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);
  if (ctx?.origin) {
    mz.copy(ctx.origin);
    dir.copy(ctx.dir);
  } else {
    game.player.hardpoints?.rArm?.getWorldPosition(mz);
    dir.copy(debug.forward());
  }
  dir.normalize();
  debug.step(0.3); // clear the cooldown and let volley one die

  // ---- over-the-barrel: behind the muzzle, outboard, looking down-range ----
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const cam = mz.clone().addScaledVector(dir, -3.4).addScaledVector(side, 1.9);
  cam.y += 0.75;
  const look = mz.clone().addScaledVector(dir, 26);
  debug.setCamera(cam, look, 34);
  debug.setPass('motionBlur', false);
  debug.step(0.05);

  // Fire, advance 30 ms of simulation, hold. The core sprite lives 42 ms and
  // the cross blades 38 ms, so 30 ms is late enough that the expanding gas and
  // the sparks have moved and early enough that the hot core is still there.
  debug.fireAll();
  debug.step(0.030, 1 / 480);
  debug.freeze(true);

  // ---- report what was actually photographed ------------------------------
  const ps = game.vfx?.ps;
  const lights = (ps?.lights?.slots || []).filter((s) => s.light?.visible);
  const camera = game.engine.camera;
  camera.updateMatrixWorld();
  const _p = new THREE.Vector3();
  const onScreen = (x, y, z) => {
    _p.set(x, y, z).project(camera);
    return Math.abs(_p.x) <= 1 && Math.abs(_p.y) <= 1 && _p.z < 1;
  };
  // Additive particles born in the last 40 ms, i.e. this volley's flash.
  let fresh = 0, freshOnScreen = 0;
  const b = ps?.batches?.[0];
  if (b) {
    const a = b.data, S = 32, now = ps.time;
    for (let i = 0; i < b.high; i++) {
      const o = i * S;
      const age = now - a[o + 3];
      if (a[o + 7] <= 0 || age < -1e-3 || age > 0.04) continue;
      fresh++;
      if (onScreen(a[o], a[o + 1], a[o + 2])) freshOnScreen++;
    }
  }
  window.__POSE_NOTE__ = {
    diagnostic: 'simulation frozen 30 ms after the volley — not a running-game frame',
    weaponsFired: debug.fireCount?.() ?? null,
    liveParticles: game.vfx?.liveParticles ?? null,
    muzzleOrigin: [+mz.x.toFixed(2), +mz.y.toFixed(2), +mz.z.toFixed(2)],
    fireDir: [+dir.x.toFixed(2), +dir.y.toFixed(2), +dir.z.toFixed(2)],
    muzzleOnScreen: onScreen(mz.x, mz.y, mz.z),
    flashParticles: fresh,
    flashParticlesOnScreen: freshOnScreen,
    flashLights: lights.length,
    flashPeak: lights.length ? +Math.max(...lights.map((s) => s.peak)).toFixed(1) : 0,
    flashIntensityNow: lights.length ? +Math.max(...lights.map((s) => s.light.intensity)).toFixed(2) : 0,
    weapons: Object.entries(game.weapons?.slots || {})
      .filter(([, w]) => w)
      .map(([k, w]) => `${k}:${w.def?.id ?? '?'}@${w.def?.flashScale ?? '?'}`),
  };
  if (!lights.length) {
    window.__POSE_NOTE__.warning = 'no muzzle light is alive — either nothing fired or the pool dropped it';
  } else if (!freshOnScreen) {
    window.__POSE_NOTE__.warning = 'a flash exists but NONE of it is in frame — grade nothing from this image';
  }

  setTimeout(() => {
    debug.freeze(false);
    debug.setPass('motionBlur', true);
  }, 3000);
})();
