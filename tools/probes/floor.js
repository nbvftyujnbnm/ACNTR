// Two Physics guarantees, checked in the live scene:
//
//  (a) A NON-FINITE ray input MISSES. `raycast` used to detect a miss with
//      `best >= maxDist`, and `NaN >= NaN` is false, so a NaN range reported a
//      phantom hit at a NaN distance. Every one of these must return null.
//
//  (b) `floorHeight` finds the surface BELOW you, where `groundHeight` finds
//      the top of the column. Under a deck those two must DISAGREE, and the
//      difference is the whole reason floorHeight exists. The probe hunts for a
//      point that is genuinely under something before it claims either.
(() => {
  const { debug: d, THREE } = window.__ACNTR__;
  const g = d.game;
  const ph = g.physics;
  if (!ph?.raycast) return { error: 'no physics.raycast' };

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  d.placePlayerInOpenGround();
  d.step(0.4);
  const p = g.player.root.position.clone();
  const from = new THREE.Vector3(p.x, p.y + 5, p.z);
  const down = new THREE.Vector3(0, -1, 0);

  const nan = (label, o, dir, dist) => {
    const hit = ph.raycast(o, dir, dist);
    return { label, returnedNull: hit === null, hit: hit ? !!hit.hit : null };
  };

  // Sweep the arena for a column whose top surface is well above its floor —
  // i.e. a point standing under a deck, catwalk or bridge.
  const under = [];
  const R = g.level?.arenaRadius ?? 400;
  for (let i = 0; i < 4000 && under.length < 6; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);
    const r = Math.sqrt((i % 997) / 997) * R;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const top = ph.groundHeight(x, z);
    if (!Number.isFinite(top)) continue;
    // Terrain height is the honest floor here; the level exposes it directly.
    const terr = g.level?.heightAt?.(x, z);
    if (!Number.isFinite(terr)) continue;
    if (top - terr < 4) continue;               // nothing overhead
    const floor = ph.floorHeight(x, z, terr + 1.0);
    under.push({
      x: +x.toFixed(1), z: +z.toFixed(1),
      terrain: +terr.toFixed(2),
      groundHeight: +top.toFixed(2),
      floorHeight: Number.isFinite(floor) ? +floor.toFixed(2) : 'NON-FINITE',
      floorMatchesTerrain: Number.isFinite(floor) ? Math.abs(floor - terr) < 1.5 : false,
      groundHeightIsCeiling: top - terr >= 4,
    });
  }

  return {
    nanGuard: [
      nan('nan-range', from, down, NaN),
      nan('inf-range', from, down, Infinity),
      nan('zero-range', from, down, 0),
      nan('neg-range', from, down, -10),
      nan('nan-origin', new THREE.Vector3(NaN, 5, 0), down, 60),
      nan('nan-dir', from, new THREE.Vector3(0, NaN, 0), 60),
    ],
    // Control: a finite downward ray must still HIT at ~5 m.
    control: (() => {
      const hit = ph.raycast(from, down, 60);
      return { hit: hit ? !!hit.hit : null, distance: hit ? +hit.distance.toFixed(2) : null };
    })(),
    underDeckSamples: under,
    underDeckFound: under.length,
  };
})();
