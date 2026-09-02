// GRIME / ALLOY BALANCE PROBE.
//
// `MechMaterials.METAL` used to read `smoothstep( 0.62, 0.40, metalnessFactor )`,
// which GLSL ES leaves UNDEFINED for edge0 >= edge1 and which this driver
// evaluates as a constant 0 — so the term meant to let caked grime bury metal
// under a dielectric layer has probably never done anything. It has been
// rewritten as `1.0 - smoothstep( 0.40, 0.62, ... )`, the same curve written the
// defined way, and this measures what it now does.
//
// The signal it gates on is the ORM map's BLUE channel, which
// `TextureForge.armorPanel` writes as `metal * (1 - dirt * 0.55)`. So the whole
// question is a histogram: how much of the baked map falls inside the shader's
// 0.40..0.62 window, and how much of that is on a surface whose metalness the
// term can actually change (bare steel, or paint chipped off it).
(() => {
  const d = window.__ACNTR__.debug;
  const g = d.game;
  const mats = g.mechFactory?.materials;
  if (!mats) return { error: 'no MechMaterials on the factory' };

  /**
   * Histogram of one ORM channel, plus the acGrime the shader derives from B.
   *
   * ALSO the GREEN channel, because three evaluates `roughness * roughnessMap.g`
   * and `MechMaterials` then multiplies AGAIN by a per-slot factor — so the
   * number a slot actually renders at is `map.g * uSlotRough[n]`, never the slot
   * value on its own. `TextureForge` writes a mean near 0.5 with a floor near
   * 0.06, which is exactly the shape that turned the level's `dark` family into
   * a mirror (see the conveyor-blowout amendment). `slotRough` below resolves
   * the same question for the mech.
   */
  function survey(tex, label, slotRough) {
    const img = tex?.metalnessMap?.image;
    if (!img) return { label, error: 'no metalnessMap image' };
    const S = img.width;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, S, S).data;

    // The shader's own curve, so this cannot drift from it by transcription.
    const smoothstep = (e0, e1, x) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };

    let n = 0, sumB = 0, sumG = 0, minB = 1, maxB = 0;
    let any = 0, half = 0, full = 0;
    const hist = new Array(20).fill(0);
    const rough = [];
    for (let i = 0; i < px.length; i += 4) {
      const b = px[i + 2] / 255;
      n++; sumB += b; minB = Math.min(minB, b); maxB = Math.max(maxB, b);
      hist[Math.min(19, Math.floor(b * 20))]++;
      const grime = 1 - smoothstep(0.40, 0.62, b);
      sumG += grime;
      if (grime > 0.01) any++;
      if (grime > 0.5) half++;
      if (grime > 0.9) full++;
      // Sample the roughness channel on a stride — percentiles need an array
      // and a 1M-entry sort is not worth it for a distribution this smooth.
      if ((i & 63) === 0) rough.push(px[i + 1] / 255);
    }
    rough.sort((a, b2) => a - b2);
    const pct = (p) => +rough[Math.min(rough.length - 1, Math.floor(p * rough.length))].toFixed(3);
    // What each mask slot ACTUALLY renders at: three's roughnessFactor is
    // `material.roughness (1) * map.g`, and ROUGH then multiplies by the slot.
    // A slot is a mirror wherever this drops under ~0.25.
    const eff = {};
    if (slotRough) {
      const names = ['base', 'accent', 'trim', 'steel'];
      for (let k = 0; k < 4; k++) {
        eff[names[k]] = {
          k: slotRough[k],
          p05: +Math.min(1, pct(0.05) * slotRough[k]).toFixed(3),
          median: +Math.min(1, pct(0.5) * slotRough[k]).toFixed(3),
          p95: +Math.min(1, pct(0.95) * slotRough[k]).toFixed(3),
        };
      }
    }
    return {
      label,
      size: S,
      ormB: { min: +minB.toFixed(3), max: +maxB.toFixed(3), mean: +(sumB / n).toFixed(3) },
      ormG: {
        min: pct(0), p05: pct(0.05), median: pct(0.5), p95: pct(0.95), max: pct(1),
      },
      effectiveRough: eff,
      // What the term does now that it is defined.
      acGrime: {
        mean: +(sumG / n).toFixed(4),
        pctAny: +((any / n) * 100).toFixed(2),
        pctHalf: +((half / n) * 100).toFixed(2),
        pctFull: +((full / n) * 100).toFixed(2),
      },
      histB: hist.map((v) => +((v / n) * 100).toFixed(2)),
    };
  }

  // How much of the mech is actually in each mask slot. The grime term can only
  // move metalness where `uSlotMetal` is non-zero (bare steel) or where the chip
  // gate has already exposed alloy, so slot coverage bounds its visible effect.
  // aMask is a per-vertex vec4 of slot weights; area-weighting every triangle is
  // the honest measure, since a slot can own many small vertices and little area.
  const slotArea = { base: 0, accent: 0, trim: 0, steel: 0 };
  let totalArea = 0;
  const p = g.player;
  p.root.updateWorldMatrix(true, true);
  const THREE = window.__ACNTR__.THREE;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c2 = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  p.root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    const pos = geo.attributes.position;
    const mask = geo.attributes.aMask;
    if (!pos || !mask) return;
    const idx = geo.index;
    const tri = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < tri; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c2.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      ab.subVectors(b, a); ac.subVectors(c2, a);
      const area = cr.crossVectors(ab, ac).length() * 0.5;
      if (!(area > 0)) continue;
      totalArea += area;
      const w = [0, 0, 0, 0];
      for (const i of [i0, i1, i2]) {
        w[0] += mask.getX(i) / 3; w[1] += mask.getY(i) / 3;
        w[2] += mask.getZ(i) / 3; w[3] += mask.getW(i) / 3;
      }
      slotArea.base += area * w[0]; slotArea.accent += area * w[1];
      slotArea.trim += area * w[2]; slotArea.steel += area * w[3];
    }
  });

  return {
    note: 'ORM.b = metal * (1 - dirt * 0.55); acGrime = 1 - smoothstep(0.40, 0.62, ORM.b)',
    armor: survey(mats.armorTex, 'armorTex (plates)'),
    mech: survey(mats.mechTex, 'mechTex (joints, looms, shrouds)'),
    slotAreaPct: {
      base: +((slotArea.base / totalArea) * 100).toFixed(2),
      accent: +((slotArea.accent / totalArea) * 100).toFixed(2),
      trim: +((slotArea.trim / totalArea) * 100).toFixed(2),
      steel: +((slotArea.steel / totalArea) * 100).toFixed(2),
      totalAreaM2: +totalArea.toFixed(1),
    },
  };
})();
