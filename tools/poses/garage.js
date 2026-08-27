// Garage / assembly screen — judges the build UI, part list, live mech preview
// and the constraint readouts.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.clearEnemies();
  // Give the player some inventory so the list isn't empty.
  try {
    const { rollPart } = await import('/src/loot/PartsDB.js');
    const { mulberry32 } = await import('/src/core/MathUtils.js');
    const rng = mulberry32(20240826);
    for (let i = 0; i < 24; i++) game.loadout.inventory.push(rollPart(1 + (i % 5), rng));
  } catch (e) {
    console.warn('[pose] could not seed inventory', e);
  }
  game.openGarage();
  debug.step(1.2);
})();
