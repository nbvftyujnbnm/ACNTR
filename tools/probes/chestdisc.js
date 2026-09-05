// WHAT ARE THE TWO CIRCULAR BLUE-WHITE DISCS ON THE MECH IN THE HERO FRAME?
//
// In shots/rev01/hero.png they read as a pair of EYES: circular, same size,
// same height, symmetric about the centreline, a bright pale-blue ring around a
// dark pupil, on a broad flat plate. That is an anatomical accident, and if it
// is on the mech's FRONT it is the most un-AC6 thing in the frame — AC6 chest
// hardware is vents, intakes and radiators, never a paired optic. If it is the
// BACK, they are main booster nozzles and they are exactly right.
//
// The first version of this probe hard-coded the disc pixels off the capture.
// `frameHeroShot` scores candidate bearings and does not pick the same one on
// every run, so every ray missed and hit the level 170 m away. Do not assume
// where the mech is on screen: FIND it, then report which way it is facing.
//
//   node tools/probe.mjs --file tools/probes/chestdisc.js
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();

  const framed = debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.poseMech({ grounded: true, aimYaw: 0.25, aimPitch: -0.05, speed: 0 });
  debug.step(2.0);
  if (framed) debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.step(0.4);

  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);
  const W = game.engine.width || 1920;
  const H = game.engine.height || 1080;
  const root = game.player.root;
  root.updateMatrixWorld(true);

  // WHICH SIDE ARE WE LOOKING AT? The mech's local -z is forward (the plumes
  // exhaust along +z, measured in tools/poses/plume.js), so the sign of the
  // camera offset in mech-local space says front or back outright.
  const camLocal = root.worldToLocal(cam.position.clone());
  const facing = camLocal.z < 0 ? 'FRONT (camera is on the mech -z side)'
                                : 'BACK (camera is on the mech +z side)';

  // Find the mech on screen by raycasting a coarse grid and keeping the hits
  // that belong to the player.
  const rc = new THREE.Raycaster();
  rc.far = 400;
  const ndc = new THREE.Vector2();
  const chain = (o) => {
    const names = [];
    for (let n = o; n && names.length < 6; n = n.parent) names.push(n.name || `(${n.type})`);
    return names.join(' < ');
  };
  // INTERSECT THE MECH, NOT THE SCENE. The first version raycast the whole level
  // on a 12 px grid — 14,400 rays through a 3.1 M triangle world — and did not
  // finish inside the probe timeout. The mech is the only thing being asked
  // about, so intersect it alone and step 24 px.
  const hitAt = (x, y) => {
    ndc.set((x / W) * 2 - 1, -((y / H) * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hs = rc.intersectObject(root, true).filter((h) => h.object.visible);
    return hs[0] || null;
  };

  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
  for (let y = 0; y < H; y += 24) for (let x = 0; x < W; x += 24) {
    if (!hitAt(x, y)) continue;
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!n) return { error: 'the mech is not on screen at all', facing, camLocal: camLocal.toArray() };

  // The discs sit at roughly 40-50% of the mech's screen height and are
  // symmetric about its centre. Sample a row of points across that band and
  // report every distinct piece of geometry, with the hit in MECH-LOCAL
  // coordinates so it can be found in MechParts.js by number rather than by eye.
  const cx = (x0 + x1) / 2, w = x1 - x0, h = y1 - y0;
  const rows = [0.34, 0.40, 0.46, 0.52];
  const cols = [-0.30, -0.22, -0.14, -0.06, 0, 0.06, 0.14, 0.22, 0.30];
  const samples = [];
  for (const ry of rows) for (const cxo of cols) {
    const x = Math.round(cx + cxo * w), y = Math.round(y0 + ry * h);
    const hit = hitAt(x, y);
    if (!hit) continue;
    const m = hit.object.material;
    const mats = Array.isArray(m) ? m : [m];
    const mat = mats[hit.face && typeof hit.face.materialIndex === 'number'
      ? Math.min(hit.face.materialIndex, mats.length - 1) : 0];
    const lp = root.worldToLocal(hit.point.clone());
    samples.push({
      px: [x, y],
      object: chain(hit.object),
      material: mat?.name || `(unnamed ${mat?.type})`,
      emissive: mat?.emissive ? [+mat.emissive.r.toFixed(2), +mat.emissive.g.toFixed(2), +mat.emissive.b.toFixed(2)] : null,
      emissiveIntensity: mat?.emissiveIntensity ?? null,
      metalness: mat?.metalness ?? null,
      roughness: mat?.roughness ?? null,
      localOnMech: [+lp.x.toFixed(2), +lp.y.toFixed(2), +lp.z.toFixed(2)],
    });
  }

  return {
    facing,
    cameraLocalToMech: camLocal.toArray().map((v) => +v.toFixed(2)),
    mechScreenBox: [x0, y0, x1, y1],
    gridHits: n,
    // Distinct materials seen in the band, which is the short answer.
    materialsInBand: [...new Set(samples.map((s) => s.material))],
    samples,
  };
})();
