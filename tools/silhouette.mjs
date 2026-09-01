#!/usr/bin/env node
/**
 * Silhouette audit — the black-shape-on-white test, scored.
 *
 *   node tools/silhouette.mjs [--out shots/sil01] [--yaws 0,45,90,135,180]
 *
 * "Does the mech read as an Armored Core" had been argued from lit screenshots
 * three times and settled none of them, because a lit render gives the eye
 * paint, panel lines and rim light to latch onto and the shape underneath never
 * has to carry its own weight. This strips all of that away and measures what
 * is left.
 *
 * What the numbers mean — the reason each one is here:
 *
 *   fill          mech pixels / bounding-box pixels. The single best blob
 *                 detector. A real AC silhouette is mostly holes and notches
 *                 and lands around 0.34-0.48; anything over ~0.60 is a lump
 *                 with limbs drawn on it.
 *
 *   openRows      fraction of occupied rows that contain two or more separate
 *                 runs of mech — i.e. rows you can see sky through. This is the
 *                 negative-space measure. It deliberately does NOT require the
 *                 gap to be enclosed, because the most important gap on a biped
 *                 (between the legs) is open at the bottom and an
 *                 enclosed-hole count scores it zero.
 *
 *   holes         enclosed background regions: sky fully ringed by mech, as
 *                 through a shoulder gantry or a knee linkage. Rarer and
 *                 stronger than openRows. Reported with each area.
 *
 *   complexity    perimeter / perimeter-of-a-disc-of-equal-area. 1.0 is a
 *                 circle. A busy, greebled, asymmetric outline runs high; a
 *                 smooth capsule runs low.
 *
 *   widths        normalised width at 12 bands from head to foot, so the leg
 *                 taper is a number instead of an impression. On an AC the
 *                 thigh band is the widest part of the leg — if band 8 is
 *                 narrower than band 10 the proportion is inverted.
 *
 * Exits 2 if the game fails to boot, 1 if any pose produced console errors.
 */
import { launch } from './browser.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const OUT_DIR = arg('out', 'shots/silhouette');
const YAWS = String(arg('yaws', '0,45,90,135,180'))
  .split(',')
  .map((s) => parseFloat(s.trim()))
  .filter((n) => isFinite(n));
const W = parseInt(arg('w', '1000'), 10);
const H = parseInt(arg('h', '1000'), 10);

async function waitForServer(url, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Runs in page context. Kept as one self-contained function because
 * page.evaluate serialises it across the bridge — it cannot close over
 * anything in this file.
 */
function analyseInPage({ yawDeg, maskWidth }) {
  const debug = window.__ACNTR__.debug;
  const got = debug.silhouetteMask(maskWidth);
  if (!got) return { error: 'silhouette mode not active' };
  const { w, h, mask } = got;

  const at = (x, y) => mask[y * w + x];

  // ---- bounds and area ----------------------------------------------------
  let minX = w, maxX = -1, minY = h, maxY = -1, area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (area === 0) return { error: 'empty mask — mech not in frame' };
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  // ---- rows you can see through ------------------------------------------
  let occupiedRows = 0, openRows = 0, maxRuns = 1;
  const runHist = {};
  for (let y = minY; y <= maxY; y++) {
    let runs = 0, prev = 0;
    for (let x = minX; x <= maxX; x++) {
      const v = at(x, y);
      if (v && !prev) runs++;
      prev = v;
    }
    if (runs === 0) continue;
    occupiedRows++;
    if (runs >= 2) openRows++;
    if (runs > maxRuns) maxRuns = runs;
    runHist[runs] = (runHist[runs] || 0) + 1;
  }

  // ---- enclosed holes: background not reachable from the border -----------
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { stack.push(0, y, w - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (seen[i] || mask[i]) continue;
    seen[i] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  const holes = [];
  const visited = new Uint8Array(w * h);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * w + x;
      if (mask[i] || seen[i] || visited[i]) continue;
      let n = 0, cx = 0, cy = 0;
      const s = [x, y];
      visited[i] = 1;
      while (s.length) {
        const py = s.pop(), px = s.pop();
        n++; cx += px; cy += py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] || seen[j] || visited[j]) continue;
          visited[j] = 1;
          s.push(nx, ny);
        }
      }
      // Ignore single-texel pinholes from rasterisation of a thin strut.
      if (n >= 10) {
        holes.push({
          px: n,
          areaPct: +((n / area) * 100).toFixed(2),
          at: [+((cx / n - minX) / bw).toFixed(2), +((cy / n - minY) / bh).toFixed(2)],
        });
      }
    }
  }
  holes.sort((a, b) => b.px - a.px);

  // ---- outline complexity -------------------------------------------------
  let perimeter = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!at(x, y)) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          !at(x + 1, y) || !at(x - 1, y) || !at(x, y + 1) || !at(x, y - 1)) perimeter++;
    }
  }

  // ---- width profile, head to foot ---------------------------------------
  const BANDS = 12;
  const widths = [];
  for (let b = 0; b < BANDS; b++) {
    const y0 = minY + Math.floor((b * bh) / BANDS);
    const y1 = minY + Math.floor(((b + 1) * bh) / BANDS);
    let widest = 0;
    for (let y = y0; y < Math.max(y1, y0 + 1); y++) {
      let lo = -1, hi = -1;
      for (let x = minX; x <= maxX; x++) {
        if (!at(x, y)) continue;
        if (lo < 0) lo = x;
        hi = x;
      }
      if (lo >= 0 && hi - lo + 1 > widest) widest = hi - lo + 1;
    }
    widths.push(+(widest / bw).toFixed(3));
  }

  return {
    yaw: yawDeg,
    mask: [w, h],
    bbox: { w: bw, h: bh, aspect: +(bw / bh).toFixed(3) },
    fill: +(area / (bw * bh)).toFixed(3),
    openRows: +(openRows / occupiedRows).toFixed(3),
    maxRuns,
    runHist,
    holes: holes.slice(0, 12),
    holeCount: holes.length,
    holeAreaPct: +holes.reduce((s, x) => s + x.areaPct, 0).toFixed(2),
    complexity: +(perimeter / (2 * Math.sqrt(Math.PI * area))).toFixed(2),
    widths,
  };
}

let server = null;
let browser = null;
const shutdown = async (code) => {
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  try { if (server) server.kill(); } catch { /* already gone */ }
  process.exit(code);
};

(async () => {
  const outDir = resolve(ROOT, OUT_DIR);
  mkdirSync(outDir, { recursive: true });

  const port = 5900 + Math.floor(Math.random() * 400);
  server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}/`;
  if (!(await waitForServer(url))) { console.error('vite failed:\n' + log); await shutdown(3); }

  browser = await launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction('window.__ACNTR_READY__ === true', { timeout: 180000 });
  } catch {
    const err = await page.evaluate(() => window.__ACNTR_ERROR__ || null);
    console.error('BOOT FAILED\n' + (err || ''));
    for (const e of errors.slice(0, 30)) console.error('  ' + e);
    await shutdown(2);
  }
  await page.waitForTimeout(2500);

  // Settle the rig into a neutral standing pose before shape-judging it. This
  // has to happen BEFORE silhouette mode, which freezes the simulation — the
  // pose must be the one a player would see standing still, not a rag-doll
  // caught mid-fall.
  const placed = await page.evaluate(() => {
    const d = window.__ACNTR__.debug;
    d.setHudVisible(false);
    d.clearEnemies();
    d.resetState();
    d.placePlayerAtSpawn(0, 0);
    d.step(1.2);
    d.poseMech({ grounded: true, aimYaw: 0, aimPitch: 0, speed: 0 });
    d.step(0.4);
    return d.game.player.root.position.toArray().map((n) => +n.toFixed(2));
  });
  console.log(`mech standing at ${JSON.stringify(placed)}`);

  const results = [];
  for (const yaw of YAWS) {
    await page.evaluate((y) => {
      window.__ACNTR__.debug.silhouette({ on: true, yaw: (y * Math.PI) / 180 });
      window.__ACNTR__.debug.step(0.05);
    }, yaw);
    await page.waitForTimeout(400);

    const name = `sil_${String(Math.round(yaw)).padStart(3, '0')}.png`;
    await page.screenshot({ path: resolve(outDir, name), timeout: 180000 });
    const r = await page.evaluate(analyseInPage, { yawDeg: yaw, maskWidth: 512 });
    r.file = name;
    r.framing = await page.evaluate(() => window.__ACNTR__.debug.silhouetteInfo());
    results.push(r);
    if (r.error) console.log(`yaw ${String(yaw).padStart(4)}  ${r.error}  framing ${JSON.stringify(r.framing)}`);

    const bars = (r.widths || []).map((v) => '#'.repeat(Math.max(1, Math.round(v * 24)))).join('|');
    console.log(
      `yaw ${String(yaw).padStart(4)}  fill ${r.fill}  openRows ${r.openRows}  ` +
      `holes ${r.holeCount} (${r.holeAreaPct}%)  cplx ${r.complexity}  maxRuns ${r.maxRuns}`,
    );
    if (r.widths) console.log(`            widths ${r.widths.join(' ')}`);
    if (bars) console.log(`            ${bars}`);
  }

  await page.evaluate(() => window.__ACNTR__.debug.silhouette({ on: false }));

  const mean = (k) => +(results.reduce((s, r) => s + (r[k] || 0), 0) / results.length).toFixed(3);
  const summary = {
    out: OUT_DIR,
    viewport: [W, H],
    mean: {
      fill: mean('fill'),
      openRows: mean('openRows'),
      complexity: mean('complexity'),
      holeCount: mean('holeCount'),
    },
    // Targets derived from the shape language REVIEW.md describes, not from a
    // measurement of the real game — we cannot download AC6 frames here. They
    // are a floor to clear, not a score to hit exactly.
    targets: { fill: '0.34-0.48', openRows: '>= 0.35', complexity: '>= 2.2', holeCount: '>= 2' },
    poses: results,
    consoleErrors: [...new Set(errors)].slice(0, 20),
  };
  writeFileSync(resolve(outDir, 'silhouette.json'), JSON.stringify(summary, null, 2));

  console.log(`\nmean  fill ${summary.mean.fill}  openRows ${summary.mean.openRows}  ` +
              `complexity ${summary.mean.complexity}  holes ${summary.mean.holeCount}`);
  console.log(`targets ${JSON.stringify(summary.targets)}`);
  console.log(`\nwrote ${OUT_DIR}/silhouette.json and ${results.length} PNGs`);
  if (errors.length) console.error('\nconsole errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));

  await shutdown(errors.length ? 1 : 0);
})();
