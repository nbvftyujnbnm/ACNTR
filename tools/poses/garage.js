// Garage / assembly screen — judges the build UI, part list, live mech preview
// and the constraint readouts.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(true);
  debug.clearEnemies();
  await debug.seedInventory(24);
  game.openGarage();
  debug.step(1.2);
})();
