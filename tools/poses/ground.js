// GROUND — the dust plateau the mech actually walks on, filling the near field.
//
// WHY THIS POSE HAD TO EXIST. Nine review poses and not one of them shows the
// terrain inside 30 m, which is why "the near-field ground has no readable
// surface detail" survived several rounds of work: nobody could see it.
//
// The reason is `placePlayerInOpenGround`, and it is not a bug in it. That
// scorer picks from `level.spawnPoints`, and most of those are written by the
// STRUCTURE builders (`this._spawn(p.x, p.y + info.roofY + 3, p.z)` — a
// warehouse roof, a tank crown, the conveyor deck). It then takes each
// candidate's height from `Physics.groundHeight`, which returns the TOP of the
// column. Its own criteria do the rest: it wants a wide clear field of fire and
// less than 2.5 m of relief over a 65 m walk, and a megastructure deck is
// flatter and clearer than any dune on the map. So the scorer prefers roofs by
// construction, and `gameplay`, `landing` and `boost` have all been shot
// standing on one.
//
// This pose therefore does not use the scorer at all. It samples the HEIGHT
// FIELD directly, and keeps only points where the top of the column and the
// terrain agree — i.e. nothing is built there — then picks the flattest of
// them. The camera then sits low and looks slightly down, because the question
// being asked is what the surface looks like at 8-40 m, and a chase camera at
// 25 m of boom pitched at the horizon spends most of its frame on the sky.
(async () => {
  const { debug, game } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  const level = game.level;
  const ph = game.physics;
  const R = (level?.arenaRadius ?? 400) * 0.82;

  /** Is (x,z) bare terrain — nothing built on or over it? */
  const bare = (x, z) => {
    const t = level.heightAt(x, z);
    const g = ph.groundHeight(x, z);
    return isFinite(t) && isFinite(g) && Math.abs(g - t) < 1.5;
  };

  // Flattest bare patch, scored over a 26 m box — the ground this frame is
  // about. Relief is wanted but not much of it: a dune FLANK reads better than
  // a pan (a surface tilted toward a 13.5 deg sun is the only place its relief
  // shows at all), while a berm right in front of the lens hides everything
  // behind it.
  let best = null;
  for (let i = 0; i < 700; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);
    const rr = R * Math.sqrt(((i * 0.6180339887) % 1));
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    if (!bare(x, z)) continue;
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let j = 0; j < 9; j++) {
      const ox = ((j % 3) - 1) * 13, oz = (Math.floor(j / 3) - 1) * 13;
      if (!bare(x + ox, z + oz)) { ok = false; break; }
      const h = level.heightAt(x + ox, z + oz);
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
    if (!ok) continue;
    const relief = mx - mn;
    // 1.5-6 m over 26 m is a gentle dune flank. Score prefers the middle.
    const s = -Math.abs(relief - 3.2);
    if (!best || s > best.s) best = { x, z, s, relief };
  }
  if (!best) best = { x: 0, z: 150, relief: -1 };

  // Face down the shallowest gradient, so the camera looks ALONG the flank
  // rather than straight into it — a slope seen face-on is a flat wall.
  const hN = level.heightAt(best.x, best.z - 20), hS = level.heightAt(best.x, best.z + 20);
  const hW = level.heightAt(best.x - 20, best.z), hE = level.heightAt(best.x + 20, best.z);
  const yaw = Math.atan2(-(hE - hW), -(hS - hN));

  debug.placePlayerOnGround(best.x, best.z, yaw);
  debug.step(0.5);

  // LOW and pitched DOWN. `cameraBehindPlayer` aims at `lookY` above the mech's
  // feet; a negative lookY puts the aim point in the dirt ahead of it, which is
  // the only way to give the ground the middle of the frame. `back` is short so
  // the near edge of the frame is a couple of metres from the lens and the far
  // edge is around 60 m — the whole band the detail layers work in.
  debug.cameraBehindPlayer({ back: 11.0, up: 5.2, side: 5.0, lookY: -1.2, lookAhead: 16, fov: 46 });
  debug.step(0.4);

  const p = game.player.root.position;
  window.__POSE_NOTE__ = {
    at: [Math.round(best.x), Math.round(best.z)],
    reliefOver26m: +(best.relief ?? -1).toFixed(2),
    playerY: +p.y.toFixed(2),
    terrainY: +level.heightAt(p.x, p.z).toFixed(2),
    columnTopY: +ph.groundHeight(p.x, p.z).toFixed(2),
    warning: best.relief < 0
      ? 'no bare terrain found — the frame is standing on something built'
      : undefined,
  };
})();
