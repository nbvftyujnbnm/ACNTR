// Wide environment vista — judges level art direction, atmospheric depth,
// silhouette reading and sense of scale.
(async () => {
  const { debug } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayer(-120, 0, 160, 0);
  debug.step(1.5);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.8);
})();
