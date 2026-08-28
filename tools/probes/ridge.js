// Boundary geometry facts: terrain height under the mesa toe, and the vista
// camera's real sight lines to the ring, so the ring's profile can be authored
// in metres instead of guessed from a screenshot.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const level = game.level;
  const out = { minHeight: null, maxHeight: null, ringTerrain: [], vista: {} };

  out.minHeight = level.terrain.minHeight;
  out.maxHeight = level.terrain.maxHeight;

  for (const r of [400, 430, 460, 490, 520, 560, 620, 700, 790]) {
    let mn = 1e9, mx = -1e9, sum = 0, n = 0;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const h = level.heightAt(Math.cos(a) * r, Math.sin(a) * r);
      mn = Math.min(mn, h); mx = Math.max(mx, h); sum += h; n++;
    }
    out.ringTerrain.push({ r, min: +mn.toFixed(1), max: +mx.toFixed(1), mean: +(sum / n).toFixed(1) });
  }

  // Vista camera: what is the distance to the boundary along a fan of screen
  // columns, and how many metres of arc does one 384-column step cover there?
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(0.4);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.2);
  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = 6000;
  const boundary = game.scene.getObjectByName('Boundary');
  const samples = [];
  for (let sx = 0.04; sx <= 0.97; sx += 0.06) {
    for (const sy of [0.32, 0.42]) {
      ray.setFromCamera(new THREE.Vector2(sx * 2 - 1, 1 - sy * 2), cam);
      const hits = boundary ? ray.intersectObject(boundary, true) : [];
      if (!hits.length) continue;
      samples.push({ sx: +sx.toFixed(2), sy, dist: Math.round(hits[0].distance), y: Math.round(hits[0].point.y) });
      break;
    }
  }
  out.vista.hits = samples;
  out.vista.camY = 78;
  return out;
})();
