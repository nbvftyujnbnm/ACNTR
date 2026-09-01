// Boundary orientation and relief audit.
//
// Answers three questions that cannot be answered from a screenshot:
//   1. Do the revolves' triangles wind so that the surface a viewer INSIDE the
//      ring sees is the front face? A butte is viewed from outside and a ring
//      from inside, so the two need opposite windings — sharing one is a
//      silent inside-out bug that reads as "smooth featureless blob".
//   2. How much interior relief does each boundary layer actually carry, in
//      terms an image can show: the spread of N.L across the visible faces.
//   3. What the aerial-perspective transmittance is at each layer's distance,
//      i.e. how much of that relief can possibly survive to the frame.
(() => {
  const { game, THREE } = window.__ACNTR__;
  const scene = game.scene;
  const sun = game.sky && game.sky.sunDirection
    ? game.sky.sunDirection.clone().normalize()
    : new THREE.Vector3(0.6, 0.23, -0.76).normalize();

  const out = { sun: sun.toArray().map((v) => +v.toFixed(3)), layers: [] };

  const fog = game.sky ? game.sky.fogParams : null;
  if (fog) {
    out.fog = {
      aerialDensity: fog.aerialDensity, aerialRamp: fog.aerialRamp,
      bandDensity: fog.bandDensity, density: fog.density,
    };
    out.transmittance = {};
    for (const d of [400, 700, 950, 1200, 1500, 1900, 2400, 3000]) {
      const tauA = fog.aerialDensity * (d * d * d) / (fog.aerialRamp * fog.aerialRamp + d * d);
      const tauB = fog.bandDensity * d * 0.30;
      out.transmittance[d] = +Math.exp(-(tauA + tauB)).toFixed(4);
    }
  }

  const camPos = new THREE.Vector3(-150, 78, 210);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const mid = new THREE.Vector3(), toCam = new THREE.Vector3();

  for (const name of ['Boundary', 'BoundaryFar']) {
    const m = scene.getObjectByName(name);
    if (!m) { out.layers.push({ name, missing: true }); continue; }
    const g = m.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const tri = idx ? idx.count / 3 : pos.count / 3;
    let front = 0, back = 0, facing = 0;
    // N.L histogram over triangles whose geometric normal faces the vista camera
    let nlMin = 1, nlMax = -1, nlSum = 0, nlSum2 = 0, nlN = 0;
    const step = Math.max(1, Math.floor(tri / 40000));
    for (let t = 0; t < tri; t += step) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      e1.subVectors(b, a); e2.subVectors(c, a);
      n.crossVectors(e1, e2);
      if (n.lengthSq() < 1e-9) continue;
      n.normalize();
      mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      toCam.subVectors(camPos, mid).normalize();
      const d = n.dot(toCam);
      if (d > 0.02) { front++; } else if (d < -0.02) { back++; }
      if (Math.abs(d) > 0.15) {
        // sun response on the side the camera can see, with the normal flipped
        // to camera-facing so a winding error cannot skew the statistic
        const nl = Math.max(0, (d > 0 ? 1 : -1) * n.dot(sun));
        nlMin = Math.min(nlMin, nl); nlMax = Math.max(nlMax, nl);
        nlSum += nl; nlSum2 += nl * nl; nlN++;
        facing++;
      }
    }
    const mean = nlSum / Math.max(1, nlN);
    out.layers.push({
      name, triangles: tri, sampled: Math.ceil(tri / step),
      cameraFacingCCW: front, cameraFacingCW: back,
      windingNote: front > back * 2 ? 'front faces toward vista camera'
        : back > front * 2 ? 'BACK faces toward vista camera (inside-out for this viewpoint)'
          : 'mixed',
      nl: {
        n: nlN, mean: +mean.toFixed(3),
        sd: +Math.sqrt(Math.max(0, nlSum2 / Math.max(1, nlN) - mean * mean)).toFixed(3),
        min: +nlMin.toFixed(3), max: +nlMax.toFixed(3),
      },
    });
  }

  // Ring crest profile as the vista camera sees it: how much does the skyline
  // move? A crest that varies by a few metres over 90 degrees is a berm.
  const level = game.level;
  if (level) {
    const bMesh = scene.getObjectByName('Boundary');
    if (bMesh) {
      const pos = bMesh.geometry.attributes.position;
      const crest = new Map();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const key = Math.round((Math.atan2(z, x) + Math.PI) / (Math.PI * 2) * 96) % 96;
        if (!crest.has(key) || crest.get(key) < y) crest.set(key, y);
      }
      const vals = [];
      for (let k = 0; k < 96; k++) vals.push(+(crest.get(k) || 0).toFixed(1));
      const mn = Math.min(...vals), mx = Math.max(...vals);
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      let adj = 0;
      for (let k = 0; k < 96; k++) adj += Math.abs(vals[k] - vals[(k + 1) % 96]);
      out.ringCrest = {
        min: mn, max: mx, mean: +mean.toFixed(1),
        sd: +Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length).toFixed(1),
        meanAdjacentStep: +(adj / 96).toFixed(2),
        profile: vals,
      };
    }
  }

  return out;
})();
