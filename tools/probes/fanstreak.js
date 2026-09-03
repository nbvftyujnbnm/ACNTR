// WHAT DRAWS THE FAINT CURVED STREAKS IN THE VISTA'S LEFT SKY?
//
// shots/iter36/vista.png carries a bundle of low-contrast curved wisps around
// rect 40,330,340,320. Contrast-stretched they resolve into a diagonal LATTICE
// with bright nodes at the crossings, and tools/skysim.mjs proves they are not
// in the sky shader (a full CPU evaluation of SKY_FRAG on the same frustum
// shows only horizontal strata there) and that the region is 49 code values
// darker than bare sky would be, i.e. it is GEOMETRY.
//
// So: fire the vista camera's own rays through the streak pixels and ask the
// scene what is actually there. Names beat theories — see the Contract
// Amendment about hiding candidates instead of arguing about them.
(() => {
  const d = window.__ACNTR__.debug;
  const THREE = window.__ACNTR__.THREE;
  const g = d.game;

  d.setHudVisible(false);
  d.clearEnemies();
  d.placePlayerOnGround(-120, 160, 0);
  d.step(1.5);
  d.setCamera({ x: -150, y: 78, z: 210 }, { x: 40, y: 55, z: -60 }, 52);
  d.step(0.8);

  const cam = g.engine.camera;
  cam.updateMatrixWorld(true);

  // The capture is 1920x1080; the probe page is 1280x720. Rays are built from
  // NDC so the resolution does not matter.
  const W = 1920, H = 1080;
  const rc = new THREE.Raycaster();
  rc.far = 6000;

  const shoot = (px, py) => {
    const ndc = new THREE.Vector2((px / W) * 2 - 1, 1 - (py / H) * 2);
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObjects(g.engine.scene.children, true);
    const out = [];
    for (const h of hits) {
      if (!h.object.visible) continue;
      const o = h.object;
      out.push({
        px, py,
        dist: +h.distance.toFixed(1),
        name: o.name || '(unnamed)',
        type: o.type,
        count: o.isInstancedMesh ? o.count : undefined,
        instanceId: h.instanceId,
        parent: o.parent?.name || null,
        point: h.point.toArray().map((n) => +n.toFixed(1)),
      });
      if (out.length >= 3) break;
    }
    return out.length ? out : [{ px, py, miss: true }];
  };

  // A grid across the streak bundle, plus two controls: one on clean sky above
  // the ridge, one on the distant mountain away from the streaks.
  const probes = [];
  for (const py of [340, 400, 460, 520, 580, 620]) {
    for (const px of [60, 110, 160, 210]) probes.push([px, py]);
  }
  probes.push([200, 200]);   // control: clean sky
  probes.push([450, 450]);   // control: mountain, no streaks

  const rays = [];
  for (const [px, py] of probes) rays.push(...shoot(px, py));

  // Tally what got hit, so the answer is one line rather than 26.
  const tally = {};
  for (const r of rays) {
    const k = r.miss ? 'SKY (no hit)' : `${r.name} [${r.type}]`;
    tally[k] = (tally[k] || 0) + 1;
  }

  return {
    camera: cam.position.toArray().map((n) => +n.toFixed(1)),
    tally,
    rays: rays.slice(0, 40),
  };
})();
