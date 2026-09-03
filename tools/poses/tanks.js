// DIAGNOSTIC — the tank farm from the range and elevation the gameplay frame
// actually sees it at, because that is where the "untextured grey blob" verdict
// came from and none of the nine review poses frames it deliberately.
//
// D_TANKS is at world (-52, 252). The five vertical tanks sit on a 100 m
// footprint inside it, so a camera 210 m out on the sun side at 40 m up puts
// the whole group across the middle third of frame with the low key raking
// their shells — which is the only light that can show a weld band, a plate
// seam or a compression ring.
//
// The camera is placed absolutely and then VETTED: `setCamera` will happily put
// the lens inside a bund wall, and a full-screen close-up of concrete grades
// nothing. Sweep a small arc of standoff bearings and keep the one whose ray to
// the district centre travels furthest before it hits anything.
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();

  const CX = -52, CZ = 252;
  const target = new THREE.Vector3(CX, 22, CZ);

  // Prefer a bearing that keeps the sun off-axis: dead into it silhouettes the
  // group and grades the tonemap instead of the surface.
  const sd = game.sky?.sunDirection;
  const sunA = sd ? Math.atan2(sd.z, sd.x) : 0;

  const eye = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let best = null;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const off = Math.abs(((a - sunA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    // 55..135 degrees off the sun: cross-lit, so shells carry a terminator.
    if (off < Math.PI * 0.30 || off > Math.PI * 0.75) continue;
    eye.set(CX + Math.cos(a) * 210, 0, CZ + Math.sin(a) * 210);
    eye.y = (game.level?.heightAt ? game.level.heightAt(eye.x, eye.z) : 0) + 40;
    dir.copy(target).sub(eye);
    const reach0 = dir.length();
    dir.multiplyScalar(1 / reach0);
    const hit = game.physics.raycast(eye, dir, reach0);
    const reach = hit ? hit.distance : reach0;
    if (!best || reach > best.reach) best = { a, reach, x: eye.x, y: eye.y, z: eye.z };
  }

  debug.setCamera({ x: best.x, y: best.y, z: best.z },
    { x: CX, y: 24, z: CZ }, 32);
  debug.step(0.6);

  window.__POSE_NOTE__ = {
    bearing: +(best.a * 180 / Math.PI).toFixed(1),
    clearReach: Math.round(best.reach),
    eyeY: +best.y.toFixed(1),
  };
  if (best.reach < 150) {
    window.__POSE_NOTE__.warning =
      'camera is boxed in at ' + Math.round(best.reach) + ' m — the tanks are behind something';
  }
})();
