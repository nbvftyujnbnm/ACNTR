// IS THE FRAME DARK BECAUSE OF ALBEDO, OR BECAUSE THE LIGHT IS NOT ARRIVING?
//
// The top end is thin (1% of the hero frame above code 172) and the causes
// ruled out so far are the transfer curve, `contrast`, `sunIntensity` and — as
// of 2026-09-06, measured across five strengths — the atmosphere. The renderer's
// own ACES is also NOT double-applied: Pipeline sets NoToneMapping over Engine's
// ACESFilmicToneMapping, so that lead is closed too.
//
// What is left is the top of the chain, and there are two very different
// possibilities that a screenshot cannot separate:
//   (a) the materials are dark — albedo far below a real desert's 0.3-0.4;
//   (b) the light is not being delivered — the key is nominally 24 but the
//       surface receives a fraction of that.
// (a) says raise albedo, (b) says find what is eating the key. They demand
// opposite fixes, which is exactly the situation this project's contract says
// to measure rather than argue.
//
// METHOD. For a set of pixels: raycast to find the surface, read its material
// albedo and its world normal, then read the SAME pixel's scene-linear radiance
// out of `rtScene` (pass 1, pre-fog, pre-AO). Lambert says
// radiance = albedo/PI * E, so E = radiance * PI / albedo is the irradiance the
// surface ACTUALLY received. Compare that against sunIntensity * max(N.L, 0),
// which is what a physically-correct DirectionalLight should deliver. The ratio
// is the answer, and it does not depend on believing either number alone.
//
// `BUTTE_ALBEDO` is recorded in CONTRACT.md as a near-inert control, so the
// albedo a material DECLARES and the albedo the frame RECEIVES are not
// automatically the same here; this reads the declared value and reports it
// beside the measured radiance so a discrepancy shows up rather than hiding.
//
//   node tools/probe.mjs --file tools/probes/irradiance.js
(async () => {
  const { debug, game, THREE } = window.__ACNTR__;
  debug.setHudVisible(false);
  debug.unpause();
  debug.clearEnemies();
  debug.resetState();

  debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.poseMech({ grounded: true, aimYaw: 0.25, aimPitch: -0.05, speed: 0 });
  debug.step(2.0);
  debug.frameHeroShot({ dist: 18.4, height: 6.4, lookY: 4.7, fov: 34 });
  debug.step(0.4);
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  const pipe = game.pipeline;
  const r = game.engine.renderer;
  const cam = game.engine.camera;
  cam.updateMatrixWorld(true);
  const rt = pipe.rtScene;
  const sun = game.sky.sunDirection.clone().normalize();
  const sunI = game.lighting?.params?.sunIntensity ?? null;

  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return s * 6.103515625e-5 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  };
  const RW = rt.width, RH = rt.height;
  const isHalf = rt.texture.type === THREE.HalfFloatType;
  const buf = isHalf ? new Uint16Array(RW * RH * 4) : new Uint8Array(RW * RH * 4);
  r.readRenderTargetPixels(rt, 0, 0, RW, RH, buf);
  const dec = isHalf ? half : (v) => v / 255;
  // readRenderTargetPixels returns BOTTOM-UP rows; screen y is top-down.
  const radianceAt = (sx, sy) => {
    const rx = Math.round((sx / (game.engine.width || 1920)) * RW);
    const ry = Math.round((1 - sy / (game.engine.height || 1080)) * RH);
    const p = ((Math.min(RH - 1, Math.max(0, ry)) * RW) + Math.min(RW - 1, Math.max(0, rx))) * 4;
    return [dec(buf[p]), dec(buf[p + 1]), dec(buf[p + 2])];
  };

  const rc = new THREE.Raycaster();
  rc.far = 600;
  const ndc = new THREE.Vector2();
  const W = game.engine.width || 1920, H = game.engine.height || 1080;

  // A spread across the frame: near deck, mid ground, the mech, far terrain.
  const pts = [
    ['deck near', 1500, 950], ['deck mid', 1150, 880], ['ground L', 300, 900],
    ['mech body', 960, 500], ['mech upper', 940, 330],
    ['midground', 600, 700], ['far terrain', 300, 300], ['far terrain R', 1650, 350],
  ];

  const out = [];
  for (const [label, x, y] of pts) {
    ndc.set((x / W) * 2 - 1, -((y / H) * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObject(game.scene, true).filter((h) => h.object.visible);
    const h = hits[0];
    const rad = radianceAt(x, y);
    const lum = 0.2126 * rad[0] + 0.7152 * rad[1] + 0.0722 * rad[2];
    if (!h) { out.push({ label, px: [x, y], hit: 'SKY', radiance: rad.map((v) => +v.toPrecision(3)), lum: +lum.toPrecision(3) }); continue; }
    const m = h.object.material;
    const mats = Array.isArray(m) ? m : [m];
    const mat = mats[h.face && typeof h.face.materialIndex === 'number'
      ? Math.min(h.face.materialIndex, mats.length - 1) : 0];
    // World normal of the hit face.
    const n = h.face ? h.face.normal.clone().applyNormalMatrix(
      new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize() : null;
    const NdotL = n ? Math.max(n.dot(sun), 0) : null;
    const alb = mat?.color ? [mat.color.r, mat.color.g, mat.color.b] : null;
    const hasVC = !!(mat && mat.vertexColors);

    // THE VERTEX COLOUR IS THE HALF THAT MATTERS. Every surface in this level
    // is merged geometry with `vertexColors` on, so `material.color` is a
    // multiplier and NOT the albedo — reading it alone made the first run of
    // this probe report an `impliedE` that could be out by any factor and was
    // therefore worthless for separating "dark paint" from "missing light".
    // Interpolate the actual attribute across the hit face's barycentric.
    let vcLum = null, vc = null;
    const geo = h.object.geometry;
    const cAttr = geo?.attributes?.color;
    if (cAttr && h.face) {
      const bary = (() => {
        // three.js gives the face indices but not the barycentric weights, so
        // recompute them from the hit point against the face's world vertices.
        const pa = new THREE.Vector3().fromBufferAttribute(geo.attributes.position, h.face.a);
        const pb = new THREE.Vector3().fromBufferAttribute(geo.attributes.position, h.face.b);
        const pc = new THREE.Vector3().fromBufferAttribute(geo.attributes.position, h.face.c);
        h.object.localToWorld(pa); h.object.localToWorld(pb); h.object.localToWorld(pc);
        const out = new THREE.Vector3();
        THREE.Triangle.getBarycoord(h.point, pa, pb, pc, out);
        return out;
      })();
      const ca = new THREE.Color().fromBufferAttribute(cAttr, h.face.a);
      const cb = new THREE.Color().fromBufferAttribute(cAttr, h.face.b);
      const cc = new THREE.Color().fromBufferAttribute(cAttr, h.face.c);
      vc = [
        ca.r * bary.x + cb.r * bary.y + cc.r * bary.z,
        ca.g * bary.x + cb.g * bary.y + cc.g * bary.z,
        ca.b * bary.x + cb.b * bary.y + cc.b * bary.z,
      ];
      vcLum = 0.2126 * vc[0] + 0.7152 * vc[1] + 0.0722 * vc[2];
    }
    // The albedo the shader actually uses: material colour TIMES vertex colour.
    const albLum = alb
      ? (0.2126 * alb[0] + 0.7152 * alb[1] + 0.0722 * alb[2]) * (vcLum == null ? 1 : vcLum)
      : null;
    out.push({
      label, px: [x, y],
      object: (h.object.name || h.object.parent?.name || '(unnamed)'),
      dist: +h.distance.toFixed(1),
      albedoLum: albLum != null ? +albLum.toPrecision(3) : null,
      matColorLum: alb ? +(0.2126 * alb[0] + 0.7152 * alb[1] + 0.0722 * alb[2]).toPrecision(3) : null,
      vertexColorLum: vcLum != null ? +vcLum.toPrecision(3) : null,
      vertexColors: hasVC,
      metalness: mat?.metalness ?? null,
      roughness: mat?.roughness ?? null,
      normal: n ? n.toArray().map((v) => +v.toFixed(2)) : null,
      NdotL: NdotL != null ? +NdotL.toFixed(3) : null,
      radiance: rad.map((v) => +v.toPrecision(3)),
      radianceLum: +lum.toPrecision(3),
      // The whole point: irradiance implied by what was rendered.
      impliedE: albLum ? +((lum * Math.PI) / albLum).toPrecision(3) : null,
      // What a physically-correct directional light alone should deliver.
      expectedSunE: NdotL != null && sunI != null ? +(sunI * NdotL).toPrecision(3) : null,
    });
  }

  return {
    sunIntensity: sunI,
    sunElevationDeg: +(Math.asin(sun.y) * 180 / Math.PI).toFixed(2),
    fillIntensity: game.lighting?.params?.fillIntensity ?? null,
    hemiIntensity: game.lighting?.params?.hemiIntensity ?? null,
    bounceIntensity: game.lighting?.params?.bounceIntensity ?? null,
    rtSceneSize: `${RW}x${RH}`,
    note: 'impliedE = radianceLum * PI / albedoLum, i.e. the irradiance the '
        + 'surface actually received. expectedSunE = sunIntensity * N.L, the key '
        + 'alone. impliedE well under expectedSunE means the light is not '
        + 'arriving; impliedE at or above it with a low radiance means the '
        + 'albedo is the limiter. albedoLum is matColorLum * vertexColorLum, '
        + 'which is what the shader actually multiplies the irradiance by.',
    samples: out,
  };
})();
