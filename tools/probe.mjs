#!/usr/bin/env node
/**
 * Boot the game headless and evaluate an expression in page context, printing
 * the JSON result. The diagnostic counterpart to capture.mjs — use it to ask
 * the live scene hard questions instead of guessing from a screenshot.
 *
 *   node tools/probe.mjs --expr "window.__ACNTR__.debug.stats()"
 *   node tools/probe.mjs --file tools/probes/scene.js
 */
import { launch } from './browser.mjs';
import { spawnServer, killTree, waitForServer, run, buildAndPreview } from './server.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

let server = null;
(async () => {
  // Probe a PRODUCTION BUILD served by `vite preview` by default. Under the dev
  // server, editing any source file while a probe is in flight triggers HMR,
  // the page reloads out from under the in-flight page.evaluate, and its
  // promise never settles — the run hangs until its timeout instead of failing.
  // That cost two ten-minute stalls before it was diagnosed. Pass --dev to opt
  // back in when you specifically want to probe unbuilt source.
  const useDev = !!arg('dev', false);
  const port = 5900 + Math.floor(Math.random() * 400);
  let url;
  if (useDev) {
    server = spawnServer('npx',
      ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], ROOT);
    url = `http://127.0.0.1:${port}/`;
    if (!(await waitForServer(url))) { console.error('vite failed:\n' + server.log()); process.exit(3); }
  } else {
    const built = await buildAndPreview(ROOT, port);
    if (built.server) server = built.server;
    if (built.error) { console.error(built.error); process.exit(3); }
    url = built.url;
  }

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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
    await browser.close(); killTree(server); process.exit(2);
  }
  // PIN THE RESOLUTION, exactly as capture.mjs does — and for a sharper reason
  // than image quality.
  //
  // `Engine._adaptResolution` runs every 0.5 s of real time and steps
  // `resolutionScale` DOWN by 0.1 whenever fps is more than 12 under its target
  // of 58. Probes run on SwiftShader at ~10 fps, which is permanently below that floor, so
  // the scale ratchets down every ~2.5 s and calls `resize()` — new render
  // target dimensions, mid-probe, silently.
  //
  // For a probe that reads whole-frame percentiles this is harmless. For one
  // that builds a PIXEL MASK and then reads the target again, it is fatal: the
  // mask indexes a buffer that is no longer the size it was built against, so
  // it samples progressively less of what it was aimed at. Measured: a masked
  // deck probe produced a clean STAIRCASE — plateaus at 0.0237, 0.0490, 0.0626,
  // 0.0670 with steps exactly 36 frames apart — over a run in which nothing at
  // all was changed, and that staircase was read as scene drift twice, once as
  // an env-bake convergence and once as an unexplained warm-up. It was neither.
  // It was the buffer shrinking under the mask.
  await page.evaluate(() => {
    const e = window.__ACNTR__?.engine;
    if (!e) return;
    e.adaptiveResolution = false;
    e.resolutionScale = 1;
    e.maxPixelRatio = 1;
    e.resize();
  }).catch(() => {});
  await page.waitForTimeout(2000);

  const file = arg('file', null);
  const expr = file ? readFileSync(resolve(ROOT, file), 'utf8') : arg('expr', 'window.__ACNTR__.debug.stats()');
  let result;
  try {
    result = await page.evaluate(expr);
  } catch (e) {
    result = { __evalError: String(e).slice(0, 1500) };
  }
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) console.error('\nconsole errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));

  await browser.close();
  killTree(server);
})();
