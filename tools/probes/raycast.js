// Is Physics.raycast reporting spurious hits?
//
// The gameplay pose reports all four enemies occluded from a camera that is not
// buried, on flat ground, at ranges of 34-58 m — and every blocker comes back
// as `hit === true` with a NON-FINITE distance. That combination is not what an
// occluded sight line looks like.
//
// This matters well beyond one review frame: TargetingSystem uses the same
// raycast for line-of-sight lock breaking, so a raycast that reports phantom
// hits would drop the player's lock constantly in real play.
//
// Test: fire rays from a known-open position straight up (nothing can be there),
// straight down (the ground must be there, at a known distance), and along a
// flat bearing, and report exactly what comes back.
(() => {
  const d = window.__ACNTR__.debug;
  const g = d.game;
  const THREE = window.__ACNTR__.THREE;
  const ph = g.physics;
  if (!ph?.raycast) return { error: 'no physics.raycast' };

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  const open = d.placePlayerInOpenGround();
  d.step(0.4);

  const p = g.player.root.position.clone();
  const ground = ph.groundHeight?.(p.x, p.z);
  const from = new THREE.Vector3(p.x, p.y + 5, p.z);

  const shoot = (label, dir, dist) => {
    const v = dir.clone().normalize();
    const hit = ph.raycast(from, v, dist);
    return {
      label,
      dir: v.toArray().map((n) => +n.toFixed(2)),
      maxDist: dist,
      returnedNull: hit === null,
      hit: hit ? !!hit.hit : null,
      distance: hit && typeof hit.distance === 'number'
        ? (isFinite(hit.distance) ? +hit.distance.toFixed(2) : 'NON-FINITE')
        : 'absent',
      objectName: hit?.object?.name ?? null,
      keys: hit ? Object.keys(hit).join(',') : null,
    };
  };

  // The aim the camera follows, not the root's stale rotation — measured a
  // clean 180 deg apart, which would fire this probe's "forward" ray backwards.
  const fwd = d.forward();

  const out = {
    openGround: open,
    playerY: +p.y.toFixed(2),
    groundHeightHere: isFinite(ground) ? +ground.toFixed(2) : 'non-finite',
    rayOrigin: from.toArray().map((n) => +n.toFixed(2)),
    shots: [
      // Straight up from 5 m above the mech's feet: unless it is under a deck,
      // this must MISS.
      shoot('up', new THREE.Vector3(0, 1, 0), 200),
      // Straight down: must HIT, at almost exactly 5 m.
      shoot('down', new THREE.Vector3(0, -1, 0), 60),
      // Along the bearing the arena scorer said was 140 m clear.
      shoot('forward-flat', fwd, 120),
      // A short ray that cannot reach anything.
      shoot('forward-2m', fwd, 2),
    ],
    // Does the scratch object get reused across calls in a way that corrupts a
    // caller holding the previous result?
    sharedScratch: (() => {
      const a = ph.raycast(from, new THREE.Vector3(0, -1, 0), 60);
      const b = ph.raycast(from, new THREE.Vector3(0, 1, 0), 200);
      return { sameObject: a === b, aHitAfterSecondCall: a ? !!a.hit : null };
    })(),
  };
  return out;
})();
