// One-shot world diagnosis: mesa-ring form, the pale "dome" in the combat_vfx
// frame, and what the vista camera actually looks at. Combined into a single
// probe because each probe run costs a full build plus a browser boot.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;
  const out = {};

  /* ---- 1. mesa ring profile, straight off the built geometry -------------- */
  const mesh = game.scene.getObjectByName('Boundary');
  if (mesh) {
    const g = mesh.geometry;
    const pos = g.attributes.position.array;
    const nrm = g.attributes.normal.array;
    const count = g.attributes.position.count;
    const ang = (i) => Math.atan2(pos[i * 3 + 2], pos[i * 3]);
    let NP = 1;
    const a0 = ang(0);
    while (NP < count && Math.abs(ang(NP) - a0) < 1e-6) NP++;
    const NV = count / NP;
    const rad = (i) => Math.hypot(pos[i * 3], pos[i * 3 + 2]);
    const profiles = [];
    for (const c of [0, 96, 200]) {
      const rows = [];
      for (let p = 0; p < NP; p++) {
        const i = c * NP + p;
        const r = rad(i), y = pos[i * 3 + 1];
        let facet = null;
        if (p < NP - 1) {
          const j = i + 1;
          facet = +(Math.atan2(pos[j * 3 + 1] - y, rad(j) - r) * 180 / Math.PI).toFixed(1);
        }
        rows.push([p, +r.toFixed(1), +y.toFixed(1), facet,
          +nrm[i * 3 + 1].toFixed(2),
          +((nrm[i * 3] * pos[i * 3] + nrm[i * 3 + 2] * pos[i * 3 + 2]) / (r || 1)).toFixed(2)]);
      }
      profiles.push({ column: c, legend: '[ring, radius, y, facetDegFromHoriz, normalY, normalRadial]', rows });
    }
    // Plan-form: how much does the radius vary around the ring at a fixed ring
    // index, and how big is the per-column azimuth swing that implies?
    const planAt = (p) => {
      const rs = [];
      for (let c = 0; c < NV - 1; c++) rs.push(rad(c * NP + p));
      let mn = 1e9, mx = -1e9, s = 0;
      for (const r of rs) { mn = Math.min(mn, r); mx = Math.max(mx, r); s += r; }
      const mean = s / rs.length;
      let maxSlope = 0, sumSq = 0;
      const arc = (2 * Math.PI * mean) / (NV - 1);
      for (let c = 0; c < rs.length; c++) {
        const d = Math.abs(rs[(c + 1) % rs.length] - rs[c]) / arc;
        maxSlope = Math.max(maxSlope, d); sumSq += d * d;
      }
      return {
        ring: p, min: +mn.toFixed(0), max: +mx.toFixed(0), mean: +mean.toFixed(0),
        maxAzimuthDeg: +(Math.atan(maxSlope) * 180 / Math.PI).toFixed(1),
        rmsAzimuthDeg: +(Math.atan(Math.sqrt(sumSq / rs.length)) * 180 / Math.PI).toFixed(1),
      };
    };
    out.ring = {
      rings: NP, columns: NV, tris: g.index.count / 3,
      profiles,
      plan: [planAt(2), planAt(Math.floor(NP * 0.35)), planAt(Math.floor(NP * 0.6)), planAt(Math.floor(NP * 0.8))],
    };
  }

  /* ---- 2. the pale dome in combat_vfx ------------------------------------ */
  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.resetState();
  debug.placePlayerOnGround(0, 30, 0, 12);
  debug.step(0.4);
  debug.cameraRelativeToPlayer({ x: 14, y: 7, z: 24 }, { x: -3, y: 0, z: -20 }, 46);
  debug.step(0.05);
  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = 6000;
  const matInfo = (m) => m ? {
    name: m.name || m.type, type: m.type,
    color: m.color ? m.color.getHexString() : null,
    rough: m.roughness, metal: m.metalness,
    emissive: m.emissive ? m.emissive.getHexString() : null,
    emissiveIntensity: m.emissiveIntensity,
    envInt: m.envMapIntensity,
    transparent: !!m.transparent, opacity: m.opacity, blending: m.blending,
  } : null;
  const seen = new Map();
  for (let sx = 0.56; sx <= 0.86; sx += 0.03) {
    for (let sy = 0.20; sy <= 0.46; sy += 0.03) {
      ray.setFromCamera(new THREE.Vector2(sx * 2 - 1, 1 - sy * 2), cam);
      const hits = ray.intersectObjects(game.scene.children, true);
      for (let i = 0; i < Math.min(hits.length, 3); i++) {
        const o = hits[i].object;
        if (!o.visible) continue;
        const key = (o.name || o.uuid) + '#' + i;
        const rec = seen.get(key);
        if (rec) { rec.n++; continue; }
        seen.set(key, {
          depth: i, n: 1, name: o.name || '(unnamed)', objType: o.type,
          dist: +hits[i].distance.toFixed(0),
          pt: [hits[i].point.x, hits[i].point.y, hits[i].point.z].map((v) => +v.toFixed(0)),
          mat: matInfo(o.material),
        });
      }
    }
  }
  out.dome = { camera: cam.position.toArray().map((v) => +v.toFixed(1)), hits: [...seen.values()].sort((a, b) => a.dist - b.dist) };

  /* ---- 3. what the vista camera sees on the ridge ------------------------ */
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(0.3);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.05);
  cam.updateMatrixWorld(true);
  const fan = [];
  for (const sx of [0.10, 0.30, 0.45, 0.62, 0.75, 0.90]) {
    for (const sy of [0.28, 0.34, 0.40, 0.46]) {
      ray.setFromCamera(new THREE.Vector2(sx * 2 - 1, 1 - sy * 2), cam);
      const hits = ray.intersectObjects(game.scene.children, true);
      const h = hits.find((x) => x.object.visible && !/containment|sky/i.test(x.object.name || ''));
      if (!h) continue;
      fan.push({
        screen: [sx, sy], name: h.object.name || '(unnamed)',
        dist: +h.distance.toFixed(0), y: +h.point.y.toFixed(0),
        nY: h.face ? +h.face.normal.y.toFixed(2) : null,
      });
    }
  }
  out.vistaFan = fan;

  /* ---- 4. sun, so relief can be authored against a known key -------------- */
  const sky = game.sky || (game.engine && game.engine.sky);
  if (sky && sky.sunDirection) {
    out.sun = {
      dir: sky.sunDirection.toArray().map((v) => +v.toFixed(3)),
      elevationDeg: +(Math.asin(sky.sunDirection.y) * 180 / Math.PI).toFixed(1),
      azimuthDeg: +(Math.atan2(sky.sunDirection.z, sky.sunDirection.x) * 180 / Math.PI).toFixed(1),
    };
  }
  out.terrain = { min: game.level.terrain.minHeight, max: game.level.terrain.maxHeight };
  return out;
})();
