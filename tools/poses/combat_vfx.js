// VFX showcase: explosions, muzzle flashes, tracers, thruster plumes, stagger
// burst — all live in one frame so effect quality can be judged directly.
(async () => {
  const { debug, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(0, 30, 0, 12); // 12 m above terrain
  debug.poseMech({ boosting: true, grounded: false, speed: 70 });

  const e = debug.spawnEnemy('ac', -6, 10, -18, 2);
  debug.spawnEnemy('mt', 16, 0, -30, 1);
  debug.step(1.0);

  // Layer the effects at staggered offsets so we catch each at a good age.
  debug.explosionAt(-14, 8, -34, 11);
  debug.step(0.10);
  debug.explosionAt(9, 3, -26, 6);
  debug.vfx('impact', new THREE.Vector3(-6, 11, -18), new THREE.Vector3(0, 0, 1), 'metal');
  debug.step(0.06);
  debug.fireAll();
  debug.vfx('impact', new THREE.Vector3(2, 4, -22), new THREE.Vector3(0, 1, 0), 'concrete');
  if (e) debug.vfx('staggerBurst', e);
  debug.step(0.05);
  debug.fireAll();
  debug.step(0.04);

  debug.setCamera({ x: 14, y: 16, z: 24 }, { x: -3, y: 9, z: -20 }, 46);
  debug.step(0.03);
})();
