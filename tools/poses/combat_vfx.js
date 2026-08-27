// VFX showcase: explosions, muzzle flashes, tracers, thruster plumes, stagger
// burst — all live in one frame so effect quality can be judged directly.
//
// Everything here is positioned RELATIVE to the mech. Absolute world coordinates
// do not survive real terrain: an earlier version spawned its explosions at a
// fixed Y and framed a camera at fixed coordinates, and the shot came back
// pointing at a shipping container with every effect off-screen.
(async () => {
  const { debug, THREE, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();
  debug.placePlayerOnGround(0, 30, 0, 12); // 12 m above terrain
  debug.poseMech({ boosting: true, grounded: false, speed: 70 });

  const p = game.player.root.position.clone();
  const at = (dx, dy, dz) => new THREE.Vector3(p.x + dx, p.y + dy, p.z + dz);

  const e = debug.spawnEnemy('ac', p.x - 6, p.y - 2, p.z - 18, 2);
  debug.spawnEnemy('mt', p.x + 16, p.y - 12, p.z - 30, 1);
  debug.step(1.0);

  // Layer the effects at staggered offsets so each is caught at a good age:
  // AC6 impacts are gone in ~200 ms, only smoke lingers.
  debug.vfx('explosion', at(-14, -4, -34), 11);
  debug.step(0.10);
  debug.vfx('explosion', at(9, -9, -26), 6);
  debug.vfx('impact', at(-6, -1, -18), new THREE.Vector3(0, 0, 1), 'metal');
  debug.step(0.06);
  debug.fireAll();
  debug.vfx('impact', at(2, -8, -22), new THREE.Vector3(0, 1, 0), 'concrete');
  if (e) debug.vfx('staggerBurst', e);
  debug.step(0.05);
  debug.fireAll();
  debug.step(0.04);

  // Frame the whole engagement from behind and above the mech.
  debug.cameraRelativeToPlayer({ x: 14, y: 7, z: 24 }, { x: -3, y: 0, z: -20 }, 46);
  debug.step(0.03);
})();
