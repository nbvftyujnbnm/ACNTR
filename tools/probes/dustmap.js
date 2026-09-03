// WHAT IS THE TERRAIN'S DUST MAP ACTUALLY MADE OF?
//
// The lit ground renders bimodal — pale caps with near-black interstices — and
// zeroing EVERY shader term that perturbs the normal (base triplanar strength,
// both detail relief taps, both ripple trains) moves the statistic by five
// percentage points out of forty-six. So it is not a lighting term, which
// leaves the map's own albedo, and that is directly measurable: the forge
// writes to a canvas, so the bytes are readable without rendering anything.
//
// Reports the albedo's luma distribution and the normal map's xy magnitude,
// because the second number is what the "0.62 of relief is 48 degrees of
// flank" arithmetic assumed and never checked.
(() => {
  const { game } = window.__ACNTR__;
  const tex = game.level?._tex;
  if (!tex) return { error: 'no level textures' };

  const read = (t) => {
    const img = t?.image;
    if (!img) return null;
    const w = img.width, h = img.height;
    // A DataTexture / ImageData source already IS the byte array; only a canvas
    // needs a 2d context, and only an <img> needs drawImage.
    if (img.data && img.data.length >= w * h * 4) return { d: img.data, w, h };
    let ctx = null;
    if (img.getContext) ctx = img.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
    }
    return { d: ctx.getImageData(0, 0, w, h).data, w, h };
  };

  const stats = (arr) => {
    arr.sort((a, b) => a - b);
    let s = 0;
    for (const v of arr) s += v;
    const mean = s / arr.length;
    let q = 0;
    for (const v of arr) q += (v - mean) * (v - mean);
    const p = (t) => +arr[Math.floor(t * (arr.length - 1))].toFixed(3);
    return {
      mean: +mean.toFixed(3), sd: +Math.sqrt(q / arr.length).toFixed(3),
      p1: p(0.01), p10: p(0.10), p50: p(0.50), p90: p(0.90), p99: p(0.99),
    };
  };

  const out = {};
  for (const name of ['dust', 'conc']) {
    const set = tex[name];
    if (!set) continue;
    const a = read(set.map);
    if (a) {
      const lum = [];
      // sRGB code values, which is what the canvas holds and what the sampler
      // decodes from — report both so nobody has to guess which space.
      const lin = [];
      for (let i = 0; i < a.w * a.h; i++) {
        const r = a.d[i * 4] / 255, g = a.d[i * 4 + 1] / 255, b = a.d[i * 4 + 2] / 255;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lum.push(L * 255);
        const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        lin.push(0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b));
      }
      out[name + '.albedo_srgb255'] = stats(lum);
      out[name + '.albedo_linear'] = stats(lin);
    }
    const n = read(set.normalMap);
    if (n) {
      const mag = [];
      for (let i = 0; i < n.w * n.h; i++) {
        const x = n.d[i * 4] / 255 * 2 - 1, y = n.d[i * 4 + 1] / 255 * 2 - 1;
        mag.push(Math.hypot(x, y));
      }
      out[name + '.normal_xy'] = stats(mag);
    }
    const r = read(set.roughnessMap);
    if (r) {
      const g = [];
      for (let i = 0; i < r.w * r.h; i++) g.push(r.d[i * 4 + 1] / 255);
      out[name + '.rough_g'] = stats(g);
    }
  }
  return out;
})();
