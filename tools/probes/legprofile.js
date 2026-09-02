// Leg profile probe. Replicates tools/silhouette.mjs's staging exactly, then
// reports (a) where every bone actually is in world space and (b) the world
// AABB of every chassis mesh grouped by the bone it hangs off. The silhouette
// audit framed a 5.8 m tall box on a 9 m mech, which is either a folded rig or
// missing meshes, and those two look identical from the mask.
(() => {
  const d = window.__ACNTR__.debug;
  const g = d.game;
  const THREE = window.__ACNTR__.THREE;

  d.setHudVisible(false);
  d.clearEnemies();
  d.resetState();
  d.placePlayerAtSpawn(0, 0);
  d.step(1.2);
  d.poseMech({ grounded: true, aimYaw: 0, aimPitch: 0, speed: 0 });
  d.step(0.4);

  const p = g.player;
  const root = p.root;
  root.updateWorldMatrix(true, true);

  const out = {
    rootPos: root.position.toArray().map((n) => +n.toFixed(3)),
    moveState: p.moveState ? {
      grounded: p.moveState.grounded, airborne: p.moveState.airborne,
      speed: +(p.moveState.speed || 0).toFixed(2),
      heightAboveGround: +(p.moveState.heightAboveGround || 0).toFixed(2),
      landing: p.moveState.landing,
    } : null,
    bones: {},
    meshes: [],
    byBone: {},
  };

  const bones = p.rig?.bones || {};
  const wp = new THREE.Vector3();
  for (const k of Object.keys(bones)) {
    const b = bones[k];
    if (!b) continue;
    b.getWorldPosition(wp);
    out.bones[k] = {
      local: b.position.toArray().map((n) => +n.toFixed(3)),
      rot: [b.rotation.x, b.rotation.y, b.rotation.z].map((n) => +n.toFixed(3)),
      scale: b.scale.toArray().map((n) => +n.toFixed(3)),
      worldY: +(wp.y - root.position.y).toFixed(3),
      worldX: +(wp.x - root.position.x).toFixed(3),
      worldZ: +(wp.z - root.position.z).toFixed(3),
      visible: b.visible,
    };
  }

  const mb = new THREE.Box3();
  root.traverse((o) => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    if (!o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    mb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    // name the owning bone by walking up to the first named ancestor
    let owner = o, name = o.name || '';
    while (owner && !name) { owner = owner.parent; name = owner ? (owner.name || '') : 'root'; }
    const rec = {
      name: name || '?',
      visible: o.visible,
      min: [mb.min.x - root.position.x, mb.min.y - root.position.y, mb.min.z - root.position.z].map((n) => +n.toFixed(2)),
      max: [mb.max.x - root.position.x, mb.max.y - root.position.y, mb.max.z - root.position.z].map((n) => +n.toFixed(2)),
    };
    out.meshes.push(rec);
    const k = rec.name;
    const g0 = out.byBone[k] || (out.byBone[k] = { n: 0, minY: 1e9, maxY: -1e9, minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 });
    g0.n++;
    g0.minY = Math.min(g0.minY, rec.min[1]); g0.maxY = Math.max(g0.maxY, rec.max[1]);
    g0.minX = Math.min(g0.minX, rec.min[0]); g0.maxX = Math.max(g0.maxX, rec.max[0]);
    g0.minZ = Math.min(g0.minZ, rec.min[2]); g0.maxZ = Math.max(g0.maxZ, rec.max[2]);
  });
  for (const k of Object.keys(out.byBone)) {
    const b = out.byBone[k];
    for (const f of ['minY', 'maxY', 'minX', 'maxX', 'minZ', 'maxZ']) b[f] = +b[f].toFixed(2);
  }

  // --- ARM / THIGH CLEARANCE, FROM THE LIVE RIG -----------------------------
  // `tools/legbudget.mjs` reports this off an offline copy of the standing solve,
  // and an offline copy is exactly the thing that goes stale: it had the shoulder
  // pivot 10 cm inboard and the leg built vertical instead of splayed, which
  // between them moved the number by 14 cm. This is the arbiter for it. Both
  // sides of the comparison are sliced AT THE SAME HEIGHT — taking a global max
  // on the leg and a global min on the arm subtracts two numbers measured a
  // metre and a half apart, which is how the old check reported daylight that
  // was not there.
  //
  // Slicing is by mesh AABB, so a mesh counts at every height it spans. That
  // over-reaches for a tilted part and therefore reports LESS clearance than
  // exists — the safe direction for a budget nobody is allowed to overspend.
  const isLeg = (n) => /Thigh|Shin|Foot|Leg/i.test(n);
  const isArm = (n) => /Arm/i.test(n) && !/Shoulder/i.test(n);
  const slices = [];
  for (let y = 2.4; y <= 4.2; y += 0.1) {
    let legHi = -1e9, armLo = 1e9;
    for (const m of out.meshes) {
      if (m.min[1] > y || m.max[1] < y) continue;
      if (m.max[0] <= 0) continue;                 // right-hand side only
      if (isLeg(m.name)) legHi = Math.max(legHi, m.max[0]);
      else if (isArm(m.name)) armLo = Math.min(armLo, m.min[0]);
    }
    if (legHi < -1e8 || armLo > 1e8) continue;
    slices.push({ y: +y.toFixed(2), legX: +legHi.toFixed(3), armX: +armLo.toFixed(3), gap: +(armLo - legHi).toFixed(3) });
  }
  out.armLegClearance = {
    slices,
    worst: slices.reduce((a, b) => (b.gap < a.gap ? b : a), { gap: 1e9 }),
  };

  out.meshCount = out.meshes.length;
  delete out.meshes;
  return out;
})();
