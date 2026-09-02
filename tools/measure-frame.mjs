#!/usr/bin/env node
/**
 * Measure a review frame's tonal placement, per SURFACE CLASS rather than per
 * screen rectangle.
 *
 *   node tools/measure-frame.mjs --pose hero [--out shots/measure] [--w 1600] [--h 900]
 *   node tools/measure-frame.mjs --pose hero --png shots/light_a/hero.png
 *
 * Why this exists. "Does the mech read pale" has been argued from screenshots
 * and from hand-placed rectangles three times in this project, and both methods
 * are unsound for the same reason: a rectangle inside the silhouette is chosen
 * by the person who already has an opinion, and it cannot separate a KEY-LIT
 * panel from a SHADOW-SIDE one — which is the only question the fill/key
 * balance is actually about. So the tool renders a classification buffer from
 * the live scene (world normal per pixel, mech coverage, sky coverage) at the
 * exact viewport of the screenshot, then joins it against the final graded
 * pixels of that screenshot. The population is then defined by geometry, not by
 * a hand-drawn box:
 *
 *   mech.sun    N.L > 0.35   panels facing the key
 *   mech.graze  -0.1..0.35   the terminator
 *   mech.shadow N.L < -0.1   panels facing away from the key
 *   ground      world geometry with normal.y > 0.85
 *   sky         no geometry
 *
 * All values are DISPLAY code values (0-255, sRGB, post-grade) — the same
 * currency every measurement in CONTRACT.md is quoted in. Luma is Rec.709.
 */
import { launch } from './browser.mjs';
import { buildAndPreview, killTree } from './server.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/* -------------------------------------------------------------------------
 * PNG reader — 8-bit, non-interlaced, colour type 2 or 6. That is what every
 * Playwright screenshot is; anything else throws rather than returning
 * plausible-looking garbage.
 * ---------------------------------------------------------------------- */

/**
 * @param {string} path
 * @returns {{ width:number, height:number, data:Uint8Array }} RGBA, row-major, top-down
 */
export function readPng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);

  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`${path}: unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNGs unsupported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`${path}: unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rawB; break;
        case 1: v = rawB + a; break;
        case 2: v = rawB + b; break;
        case 3: v = rawB + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${path}: bad filter ${filter} on row ${y}`);
      }
      line[x] = v & 0xff;
    }
    src += stride;
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      out[o + x * 4] = line[x * channels];
      out[o + x * 4 + 1] = line[x * channels + 1];
      out[o + x * 4 + 2] = line[x * channels + 2];
      out[o + x * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

/* -------------------------------------------------------------------------
 * In-page classification pass. Runs against the live scene at the screenshot's
 * exact viewport and returns one class byte per pixel, top-down, base64'd.
 * ---------------------------------------------------------------------- */

const CLASSIFY = String.raw`
(() => {
  const { game, THREE } = window.__ACNTR__;
  const renderer = game.engine.renderer;
  const scene = game.scene;
  const camera = game.engine.camera;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const W = size.x | 0, H = size.y | 0;

  const VERT = [
    '#include <common>',
    '#include <batching_pars_vertex>',
    '#include <morphtarget_pars_vertex>',
    '#include <skinning_pars_vertex>',
    'uniform mat3 uViewToWorld;',
    'varying vec3 vWN;',
    'void main() {',
    '  #include <batching_vertex>',
    '  #include <beginnormal_vertex>',
    '  #include <morphinstance_vertex>',
    '  #include <morphnormal_vertex>',
    '  #include <skinbase_vertex>',
    '  #include <skinnormal_vertex>',
    '  #include <defaultnormal_vertex>',
    '  vWN = uViewToWorld * transformedNormal;',
    '  #include <begin_vertex>',
    '  #include <morphtarget_vertex>',
    '  #include <skinning_vertex>',
    '  #include <project_vertex>',
    '}',
  ].join('\n');

  const FRAG = [
    'uniform vec3 uSunDir;',
    'varying vec3 vWN;',
    'void main() {',
    '  vec3 n = normalize( vWN );',
    '  if ( ! gl_FrontFacing ) n = - n;',
    '  gl_FragColor = vec4( dot( n, uSunDir ) * 0.5 + 0.5, n.y * 0.5 + 0.5, 0.0, 1.0 );',
    '}',
  ].join('\n');

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uViewToWorld: { value: new THREE.Matrix3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  mat.uniforms.uViewToWorld.value.setFromMatrix4(camera.matrixWorld);
  if (game.sky?.sunDirection) mat.uniforms.uSunDir.value.copy(game.sky.sunDirection).normalize();

  const rt = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: true,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });

  // Additive / alpha-blended shells (the arena containment field, VFX quads,
  // sprites) would be drawn as OPAQUE geometry by an override material and
  // would then swallow the whole sky. Hide anything that is not a solid.
  const hidden = [];
  const hide = (o) => { if (o.visible) { hidden.push(o); o.visible = false; } };
  // EVERY mech in frame, not just the player's. The combat pose's subject is a
  // spawned enemy AC and the boost pose's is the player; classifying only
  // game.player.root silently scored the combat frame's mech as "world" and
  // made the two poses' numbers incomparable.
  const mechRoots = [game.player.root];
  for (const e of (game.enemies?.list || [])) if (e && e.root) mechRoots.push(e.root);
  const isMechDescendant = (o) => {
    for (let p = o; p; p = p.parent) if (mechRoots.indexOf(p) !== -1) return true;
    return false;
  };
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isBatchedMesh) {
      if (o.isPoints || o.isSprite || o.isLine) hide(o);
      return;
    }
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m) return;
    if (m.transparent === true || m.depthWrite === false || m.blending !== THREE.NormalBlending) hide(o);
  });

  const prevBg = scene.background;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  scene.background = null;
  scene.overrideMaterial = mat;
  renderer.setClearColor(0x000000, 0);

  const px = new Uint8Array(W * H * 4);
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);

  // Second pass: mech only, for an exact silhouette.
  const worldHidden = [];
  scene.traverse((o) => {
    if ((o.isMesh || o.isInstancedMesh || o.isBatchedMesh) && o.visible && !isMechDescendant(o)) {
      worldHidden.push(o);
      o.visible = false;
    }
  });
  const mechPx = new Uint8Array(W * H * 4);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, mechPx);
  for (const o of worldHidden) o.visible = true;

  scene.overrideMaterial = null;
  scene.background = prevBg;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  for (const o of hidden) o.visible = true;
  rt.dispose();
  mat.dispose();

  // Pack one class byte per pixel, flipped to top-down so it joins the PNG.
  //   0 sky   1 ground   2 world   3 mech.sun   4 mech.graze   5 mech.shadow
  const cls = new Uint8Array(W * H);
  let bboxMinX = W, bboxMinY = H, bboxMaxX = -1, bboxMaxY = -1;
  for (let y = 0; y < H; y++) {
    const srcRow = (H - 1 - y) * W * 4;
    const dstRow = y * W;
    for (let x = 0; x < W; x++) {
      const i = srcRow + x * 4;
      let c;
      if (mechPx[i + 3] > 0) {
        const ndl = mechPx[i] / 255 * 2 - 1;
        c = ndl > 0.35 ? 3 : ndl < -0.1 ? 5 : 4;
        if (x < bboxMinX) bboxMinX = x;
        if (x > bboxMaxX) bboxMaxX = x;
        if (y < bboxMinY) bboxMinY = y;
        if (y > bboxMaxY) bboxMaxY = y;
      } else if (px[i + 3] === 0) {
        c = 0;
      } else {
        c = (px[i + 1] / 255 * 2 - 1) > 0.85 ? 1 : 2;
      }
      cls[dstRow + x] = c;
    }
  }

  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < cls.length; i += CH) {
    bin += String.fromCharCode.apply(null, cls.subarray(i, Math.min(i + CH, cls.length)));
  }

  return {
    width: W,
    height: H,
    classes: btoa(bin),
    bbox: bboxMaxX < 0 ? null : [bboxMinX, bboxMinY, bboxMaxX, bboxMaxY],
    sunDir: game.sky?.sunDirection ? game.sky.sunDirection.toArray().map((n) => +n.toFixed(4)) : null,
    exposure: renderer.toneMappingExposure,
    camera: camera.position.toArray().map((n) => +n.toFixed(2)),
    fov: camera.fov,
    lighting: game.lighting ? {
      sun: game.lighting.params.sunIntensity,
      fill: game.lighting.params.fillIntensity,
      bounce: game.lighting.params.bounceIntensity,
      hemi: game.lighting.params.hemiIntensity,
      env: game.lighting.params.envIntensity,
    } : null,
  };
})()
`;

/* -------------------------------------------------------------------------
 * Statistics
 * ---------------------------------------------------------------------- */

const CLASS_NAMES = ['sky', 'ground', 'world', 'mech.sun', 'mech.graze', 'mech.shadow'];

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Silhouette separation. Splits a `band`-pixel collar either side of the mech's
 * outline and reports what each side of that edge actually renders at.
 *
 * This is the number the "backlit mech reads as a black blob" complaint is
 * really about, and neither a whole-mech median nor a hand-drawn rectangle can
 * answer it: a subject can be correctly exposed everywhere and still have no
 * edge, and a subject that is 40 code values darker than its surround reads as
 * a hole in the frame however much internal detail it carries.
 *
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {Uint8Array} cls  per-pixel class, 3..5 = mech
 * @param {number} band     collar width in pixels
 */
function rimStats(img, cls, W, H, band = 3) {
  const isMech = (i) => cls[i] >= 3;
  const inner = [], outer = [];
  const px = img.data;
  const L = (i) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];

  for (let y = band; y < H - band; y++) {
    for (let x = band; x < W - band; x++) {
      const i = y * W + x;
      const me = isMech(i);
      let edge = false;
      for (let dy = -band; dy <= band && !edge; dy++) {
        for (let dx = -band; dx <= band; dx++) {
          if (isMech(i + dy * W + dx) !== me) { edge = true; break; }
        }
      }
      if (!edge) continue;
      (me ? inner : outer).push(L(i));
    }
  }
  if (!inner.length || !outer.length) return null;
  inner.sort((a, b) => a - b);
  outer.sort((a, b) => a - b);
  const mi = pct(inner, 50), mo = pct(outer, 50);
  return {
    band,
    innerPx: inner.length, outerPx: outer.length,
    innerMed: +mi.toFixed(1), innerP95: +pct(inner, 95).toFixed(1),
    outerMed: +mo.toFixed(1), outerP95: +pct(outer, 95).toFixed(1),
    // Weber contrast across the outline. Negative = the mech is darker than
    // what it sits against, i.e. a silhouette; near zero = it disappears.
    contrast: +((mi - mo) / Math.max(mo, 1)).toFixed(3),
  };
}

/**
 * Where the frame bottoms out, PER CHANNEL. A grade that pushes a channel
 * negative before the final clamp does not merely tint the shadows — it
 * destroys every value below the crossing point in that channel, so the whole
 * toe collapses onto one hue and the detail in it is unrecoverable. That is
 * invisible in a luminance histogram, which is why this is reported separately.
 *
 * @param {{width:number,height:number,data:Uint8Array}} img
 */
function blackPoint(img) {
  const px = img.data;
  const n = img.width * img.height;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let dark = 0, darkR = 0, darkG = 0, darkB = 0, rZeroDark = 0;
  for (let p = 0; p < n * 4; p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    hist[0][r]++; hist[1][g]++; hist[2][b]++;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b < 20) {
      dark++; darkR += r; darkG += g; darkB += b;
      if (r === 0) rZeroDark++;
    }
  }
  const floor = (h) => { for (let v = 0; v < 256; v++) if (h[v] > n * 0.0005) return v; return 255; };
  return {
    // % of the whole frame at a hard channel zero.
    zeroPct: [0, 1, 2].map((c) => +((100 * hist[c][0]) / n).toFixed(2)),
    // First code value holding at least 0.05% of the frame — the practical floor.
    floor: [0, 1, 2].map((c) => floor(hist[c])),
    darkPx: dark,
    darkArea: +((100 * dark) / n).toFixed(2),
    darkMeanRGB: dark ? [darkR / dark, darkG / dark, darkB / dark].map((v) => +v.toFixed(1)) : null,
    darkROverB: dark && darkB ? +(darkR / darkB).toFixed(3) : null,
    // Of the pixels under display 20, what fraction has red hard-clipped to 0.
    darkRedClippedPct: dark ? +((100 * rZeroDark) / dark).toFixed(2) : null,
  };
}

/**
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {Uint8Array} cls
 */
function stats(img, cls) {
  const n = CLASS_NAMES.length;
  const lumas = Array.from({ length: n }, () => []);
  const sat = new Float64Array(n);
  const rb = new Float64Array(n);
  const chan = Array.from({ length: n }, () => new Float64Array(3));
  const px = img.data;

  for (let i = 0, p = 0; i < cls.length; i++, p += 4) {
    const c = cls[i];
    const r = px[p], g = px[p + 1], b = px[p + 2];
    lumas[c].push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat[c] += mx > 0 ? (mx - mn) / mx : 0;
    rb[c] += b > 0 ? r / b : 0;
    chan[c][0] += r; chan[c][1] += g; chan[c][2] += b;
  }

  const rows = [];
  for (let c = 0; c < n; c++) {
    const L = lumas[c];
    if (!L.length) { rows.push({ class: CLASS_NAMES[c], px: 0 }); continue; }
    L.sort((a, b) => a - b);
    let sum = 0;
    for (const v of L) sum += v;
    const mean = sum / L.length;
    let sd = 0;
    for (const v of L) sd += (v - mean) * (v - mean);
    rows.push({
      class: CLASS_NAMES[c],
      px: L.length,
      area: +((100 * L.length) / cls.length).toFixed(2),
      mean: +mean.toFixed(1),
      sd: +Math.sqrt(sd / L.length).toFixed(1),
      p05: +pct(L, 5).toFixed(0),
      p25: +pct(L, 25).toFixed(0),
      median: +pct(L, 50).toFixed(0),
      p75: +pct(L, 75).toFixed(0),
      p95: +pct(L, 95).toFixed(0),
      below24: +((100 * L.filter((v) => v < 24).length) / L.length).toFixed(1),
      above128: +((100 * L.filter((v) => v > 128).length) / L.length).toFixed(1),
      sat: +(sat[c] / L.length).toFixed(3),
      rOverB: +(rb[c] / L.length).toFixed(3),
      meanRGB: [0, 1, 2].map((k) => +(chan[c][k] / L.length).toFixed(1)),
    });
  }
  return rows;
}

/* -------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------- */

// Server ownership belongs to tools/server.mjs, and this file was the last
// holdout. It spawned `npx vite preview` itself and killed only the npx
// wrapper, so every run left a live server behind — the exact leak the
// 2026-09-01 amendment fixed for capture/probe/silhouette, and it was still
// here: two orphans from earlier runs were holding ports and CPU while this
// tool's own measurement waited on SwiftShader. Worse for a MEASUREMENT tool
// specifically, it also built into the shared `dist/`, so a second agent
// starting any capture mid-run cleared the directory this run was being served
// from. `buildAndPreview` builds into a per-run outDir and reaps the process
// group on exit, which is what makes a single-build A/B trustworthy while
// other agents are working.
let server = null;
async function startServer() {
  const port = 5300 + Math.floor(Math.random() * 400);
  const r = await buildAndPreview(ROOT, port);
  if (r.error) { console.error(r.error); process.exit(3); }
  server = r.server;
  return r.url;
}

(async () => {
  const poses = String(arg('pose', 'hero')).split(',').map((s) => s.trim());
  const W = parseInt(arg('w', '1600'), 10);
  const H = parseInt(arg('h', '900'), 10);
  const SETTLE = parseInt(arg('settle', '1100'), 10);
  const outDir = resolve(ROOT, arg('out', 'shots/measure'));
  // Variants: a JS expression evaluated in page context before each pose, so a
  // whole parameter sweep runs off ONE build. See the CONTRACT amendment on
  // cross-build measurement — a rebuild between two frames invalidates them.
  const variantFile = arg('variants', null);
  const variants = variantFile
    ? JSON.parse(readFileSync(resolve(ROOT, variantFile), 'utf8'))
    : [{ name: 'base', apply: '' }];

  mkdirSync(outDir, { recursive: true });
  const url = arg('url', null) || (await startServer());

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction('window.__ACNTR_READY__ === true', { timeout: 180000 });
  } catch {
    console.error('BOOT FAILED\n' + (await page.evaluate(() => window.__ACNTR_ERROR__ || '')));
    await browser.close(); killTree(server); process.exit(2);
  }
  await page.evaluate(() => {
    const e = window.__ACNTR__?.engine;
    if (!e) return;
    e.adaptiveResolution = false;
    e.resolutionScale = 1;
    e.maxPixelRatio = 1;
    e.resize();
  });
  await page.waitForTimeout(3500);

  const report = [];
  for (const v of variants) {
    // A variant may pin its own pose list; otherwise it runs every --pose.
    for (const pose of (v.poses ? String(v.poses).split(',') : poses)) {
      if (v.apply) await page.evaluate(v.apply);
      const src = readFileSync(resolve(ROOT, 'tools/poses', `${pose}.js`), 'utf8');
      await page.evaluate(src);
      await page.waitForTimeout(SETTLE);

      const tag = v.name === 'base' && variants.length === 1 ? pose : `${pose}_${v.name}`;
      const png = resolve(outDir, `${tag}.png`);
      // A pose that blows Playwright's screenshot budget under SwiftShader (the
      // VFX-heavy ones do) must not discard the poses already measured — the
      // same defect capture.mjs was fixed for.
      try {
        await page.screenshot({ path: png, type: 'png', timeout: 180000 });
      } catch (err) {
        console.error(`!! ${tag}: screenshot failed — ${String(err.message || err).split('\n')[0]}`);
        report.push({ pose, variant: v.name, failed: true });
        await page.evaluate(() => {
          try { window.__ACNTR__.debug.releaseCamera().freeze(false).setHudVisible(true).resetState().clearEnemies(); } catch { /* noop */ }
        });
        continue;
      }
      const meta = await page.evaluate(CLASSIFY);

      const img = readPng(png);
      if (img.width !== meta.width || img.height !== meta.height) {
        console.error(`size mismatch: png ${img.width}x${img.height} vs buffer ${meta.width}x${meta.height}`);
        process.exit(4);
      }
      const cls = new Uint8Array(Buffer.from(meta.classes, 'base64'));
      const rows = stats(img, cls);
      const rim = rimStats(img, cls, meta.width, meta.height, 3);
      const black = blackPoint(img);
      const entry = { pose, variant: v.name, png: png.replace(ROOT + '/', ''), bbox: meta.bbox, sunDir: meta.sunDir, exposure: +meta.exposure.toFixed(3), lighting: meta.lighting, rows, rim, black };
      report.push(entry);

      console.log(`\n=== ${tag}  cam ${meta.camera.join(',')} fov ${meta.fov}  exposure ${entry.exposure} ===`);
      if (meta.lighting) console.log('    lighting ' + JSON.stringify(meta.lighting));
      console.log('    bbox ' + JSON.stringify(meta.bbox));
      console.log('class         px     area%  mean   sd   p05  p25  med  p75  p95  <24%  >128%  sat   R/B       R     G     B');
      for (const r of rows) {
        if (!r.px) { console.log(`${r.class.padEnd(12)}  (none)`); continue; }
        console.log(
          `${r.class.padEnd(12)} ${String(r.px).padStart(8)} ${String(r.area).padStart(6)} ` +
          `${String(r.mean).padStart(6)} ${String(r.sd).padStart(5)} ${String(r.p05).padStart(4)} ` +
          `${String(r.p25).padStart(4)} ${String(r.median).padStart(4)} ${String(r.p75).padStart(4)} ` +
          `${String(r.p95).padStart(4)} ${String(r.below24).padStart(5)} ${String(r.above128).padStart(6)} ` +
          `${String(r.sat).padStart(6)} ${String(r.rOverB).padStart(5)}` +
          `   ${r.meanRGB.map((n) => String(n).padStart(5)).join(' ')}`
        );
      }
      if (rim) {
        console.log(
          `silhouette  inner(med/p95) ${rim.innerMed}/${rim.innerP95}   ` +
          `outer(med/p95) ${rim.outerMed}/${rim.outerP95}   weber ${rim.contrast}`
        );
      }
      console.log(
        `blackpoint  zero% RGB ${black.zeroPct.join('/')}   floor ${black.floor.join('/')}   ` +
        `under20 ${black.darkArea}% mean ${black.darkMeanRGB ? black.darkMeanRGB.join('/') : '-'} ` +
        `R/B ${black.darkROverB}   redClipped ${black.darkRedClippedPct}%`
      );

      await page.evaluate(() => {
        try {
          window.__ACNTR__.debug.releaseCamera().freeze(false).setHudVisible(true).resetState().clearEnemies();
        } catch { /* noop */ }
      });
    }
  }

  writeFileSync(resolve(outDir, 'measure.json'), JSON.stringify(report, null, 2));
  if (errors.length) console.error('\nconsole errors:\n' + [...new Set(errors)].slice(0, 10).join('\n'));
  await browser.close();
  killTree(server);
  process.exit(0);
})();
