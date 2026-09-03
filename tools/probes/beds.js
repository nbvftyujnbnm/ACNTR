// Are the cliff's stratigraphic beds actually IN the mesh, and where do they
// land on screen from the vista camera?
//
// `cliffFaceProfile` claims to build 5 hard/soft bed pairs with an overhang at
// each boundary, and the measured frame says the ridge face carries 0.14-0.25
// display code values of variation at 16-64 px scales — i.e. nothing. Either
// the geometry is not there, or it is there and lands sub-pixel, or it is there
// at a readable size and the LIGHTING is not separating it. Those three want
// completely different fixes, so read the mesh before touching it.
//
// Walks one angular column of the `Boundary` mesh and reports every profile
// ring: world y, radius, distance from the vista camera, projected screen row,
// and the vertex normal that decides how it shades.
(() => {
  const { debug, game, THREE } = window.__ACNTR__;

  debug.setHudVisible(false);
  debug.clearEnemies();
  debug.placePlayerOnGround(-120, 160, 0);
  debug.step(1.0);
  debug.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  debug.step(0.2);
  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);

  let mesh = null;
  game.scene.traverse((o) => { if (o.name === 'Boundary') mesh = o; });
  if (!mesh) return { error: 'no Boundary mesh' };

  const pos = mesh.geometry.attributes.position;
  const nrm = mesh.geometry.attributes.normal;
  const col = mesh.geometry.attributes.color;
  const total = pos.count;

  // The generator lays vertices out as [column][ring]; recover NP by finding the
  // stride at which the angle repeats rather than hard-coding it.
  const ang0 = Math.atan2(pos.getZ(0), pos.getX(0));
  let NP = 0;
  for (let i = 1; i < Math.min(total, 400); i++) {
    if (Math.abs(Math.atan2(pos.getZ(i), pos.getX(i)) - ang0) > 1e-6) { NP = i; break; }
  }
  if (!NP) return { error: 'could not recover ring stride' };
  const NV = total / NP;

  const sun = game.sky?.sunDirection?.clone?.() || new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  // Pick the column nearest the centre of the frame.
  const fwd = new THREE.Vector3();
  cam.getWorldDirection(fwd);
  const wantAng = Math.atan2(fwd.z, fwd.x);
  let bestA = 0, bestErr = 1e9;
  for (let a = 0; a < NV; a++) {
    const i = a * NP;
    const t = Math.atan2(pos.getZ(i), pos.getX(i));
    let e = Math.abs(((t - wantAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (e < bestErr) { bestErr = e; bestA = a; }
  }

  const H = 1080;
  const rings = [];
  for (let p = 0; p < NP; p++) {
    const i = bestA * NP + p;
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const r = Math.hypot(v.x, v.z);
    const d = v.distanceTo(cam.position);
    const proj = v.clone().project(cam);
    n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    rings.push({
      p,
      y: +v.y.toFixed(1),
      radius: +r.toFixed(1),
      dist: Math.round(d),
      screenRow: Math.round((1 - proj.y) * 0.5 * H),
      nDotL: +n.dot(sun).toFixed(3),
      ny: +n.y.toFixed(2),
      vcol: col ? +(col.getX(i)).toFixed(3) : null,
    });
  }

  // Screen-row gaps between successive rings: this is the number that says
  // whether a bed is a 20 px band or a sub-pixel crease.
  const gaps = [];
  for (let p = 1; p < rings.length; p++) gaps.push(rings[p].screenRow - rings[p - 1].screenRow);

  return {
    stride: { NP, NV },
    column: bestA,
    sun: sun.toArray().map((x) => +x.toFixed(3)),
    rings,
    screenRowGaps: gaps,
    nDotLRange: {
      min: Math.min(...rings.map((r) => r.nDotL)),
      max: Math.max(...rings.map((r) => r.nDotL)),
    },
    vcolRange: col ? {
      min: Math.min(...rings.map((r) => r.vcol)),
      max: Math.max(...rings.map((r) => r.vcol)),
    } : null,
  };
})();
