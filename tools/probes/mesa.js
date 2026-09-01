// Mesa-ring form check, straight off the built geometry rather than off a
// screenshot. For a handful of angular columns it walks the profile ring by
// ring and reports the radius, the height, the facet's inclination from
// horizontal and the SMOOTHED vertex normal — the last one because
// computeVertexNormals() averages a 2 m overhang facet with the 20 m riser
// above it, which is exactly how authored relief can be present in the mesh and
// absent from the shading.
(() => {
  const { game, THREE } = window.__ACNTR__;
  const mesh = game.scene.getObjectByName('Boundary');
  if (!mesh) return { error: 'no Boundary mesh' };
  const g = mesh.geometry;
  const pos = g.attributes.position.array;
  const nrm = g.attributes.normal.array;
  const col = g.attributes.color ? g.attributes.color.array : null;
  const count = g.attributes.position.count;

  // The generator lays vertices out as [column][ring]; recover NP by finding
  // the run length over which the polar angle is constant.
  const ang = (i) => Math.atan2(pos[i * 3 + 2], pos[i * 3]);
  let NP = 1;
  const a0 = ang(0);
  while (NP < count && Math.abs(ang(NP) - a0) < 1e-6) NP++;
  const NV = count / NP;

  const out = { vertexCount: count, rings: NP, columns: NV, profiles: [], stats: {} };

  const rad = (i) => Math.hypot(pos[i * 3], pos[i * 3 + 2]);

  for (const c of [0, 40, 96, 190, 300]) {
    const rows = [];
    for (let p = 0; p < NP; p++) {
      const i = c * NP + p;
      const r = rad(i), y = pos[i * 3 + 1];
      let inc = null;
      if (p < NP - 1) {
        const j = i + 1;
        const dr = rad(j) - r, dy = pos[j * 3 + 1] - y;
        inc = +(Math.atan2(dy, dr) * 180 / Math.PI).toFixed(1); // 90 = vertical, 0 = flat out
      }
      rows.push({
        p,
        r: +r.toFixed(1),
        y: +y.toFixed(1),
        facetDeg: inc,
        nY: +nrm[i * 3 + 1].toFixed(3),
        // outward component of the normal in the radial plane
        nR: +((nrm[i * 3] * pos[i * 3] + nrm[i * 3 + 2] * pos[i * 3 + 2]) / (r || 1)).toFixed(3),
        tint: col ? +(col[i * 3] / 255).toFixed(2) : null,
      });
    }
    out.profiles.push({ column: c, angleDeg: +(ang(c * NP) * 180 / Math.PI).toFixed(1), rows });
  }

  // How much does the SHADED normal actually swing over the face? That is the
  // number that decides whether relief becomes value.
  let minNY = 9, maxNY = -9, minNR = 9, maxNR = -9;
  for (let c = 0; c < NV; c += 7) {
    for (let p = 0; p < NP; p++) {
      const i = c * NP + p;
      const r = rad(i) || 1;
      const nY = nrm[i * 3 + 1];
      const nR = (nrm[i * 3] * pos[i * 3] + nrm[i * 3 + 2] * pos[i * 3 + 2]) / r;
      if (nY < minNY) minNY = nY; if (nY > maxNY) maxNY = nY;
      if (nR < minNR) minNR = nR; if (nR > maxNR) maxNR = nR;
    }
  }
  out.stats.normalY = [+minNY.toFixed(3), +maxNY.toFixed(3)];
  out.stats.normalRadial = [+minNR.toFixed(3), +maxNR.toFixed(3)];

  const far = game.scene.getObjectByName('BoundaryFar');
  if (far) {
    far.geometry.computeBoundingBox();
    out.far = {
      tris: far.geometry.index.count / 3,
      box: far.geometry.boundingBox.min.toArray().map(Math.round)
        .concat(far.geometry.boundingBox.max.toArray().map(Math.round)),
    };
  }
  out.ringTris = g.index.count / 3;
  return out;
})();
