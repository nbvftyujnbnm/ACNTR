#!/usr/bin/env node
/**
 * Does the game actually BOOT? The fastest possible answer.
 *
 *   node tools/smoke.mjs          # against a production build (what CI ships)
 *   node tools/smoke.mjs --dev    # against unbuilt source (what you are editing)
 *
 * WHY THIS EXISTS. This project's standing gate is `node tools/lint-glsl.mjs
 * && npx vite build`, and everyone has been treating a green build as
 * permission to commit. It is not. Vite resolves imports and parses syntax; it
 * does not execute anything. A `ReferenceError: bedTint is not defined` inside
 * a function body builds perfectly cleanly and then hard-fails at startup —
 * measured exactly that way, with `vite build` reporting success on a tree
 * whose Level.build() threw on the first frame.
 *
 * Several agents share one branch here, so a bootable-looking commit that does
 * not boot blocks everyone at once, and the failure surfaces at the END of
 * whatever 100-second capture they run next, attributed to whatever they
 * happened to be working on. This turns that into ~20 seconds and an exact
 * stack.
 *
 * Exit codes: 0 booted, 1 boot failed, 3 the server would not start. So it
 * chains: `node tools/lint-glsl.mjs && node tools/smoke.mjs && git commit ...`
 */
import { launch } from './browser.mjs';
import { spawnServer, killTree, waitForServer, buildAndPreview } from './server.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const useDev = process.argv.includes('--dev');

// Console noise that is expected in this harness and means nothing about
// whether the game works: the page asks for a favicon that is not served, and
// the proxy resets font/analytics fetches that the level never needed.
const BENIGN = [
  /favicon/i,
  /ERR_CONNECTION_RESET/,
  /404 \(Not Found\)/,
  /fonts\.googleapis/,
  /net::ERR_/,
];

let server = null;
const bail = async (browser, code, msg) => {
  if (msg) console.error(msg);
  if (browser) await browser.close().catch(() => {});
  killTree(server);
  process.exit(code);
};

(async () => {
  const port = 6300 + Math.floor(Math.random() * 400);
  let url;
  if (useDev) {
    server = spawnServer('npx',
      ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], ROOT);
    url = `http://127.0.0.1:${port}/`;
    if (!(await waitForServer(url))) {
      console.error('vite failed to start:\n' + server.log());
      killTree(server);
      process.exit(3);
    }
  } else {
    const built = await buildAndPreview(ROOT, port);
    if (built.server) server = built.server;
    if (built.error) { console.error(built.error); killTree(server); process.exit(3); }
    url = built.url;
  }

  const browser = await launch();
  // Small viewport on purpose: this test only asks whether the game reaches a
  // ready state, and a 1920x1080 software-rasterised first frame costs many
  // seconds for an answer that does not depend on it.
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => errors.push(String(e.stack || e.message || e).slice(0, 800)));

  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (e) {
    await bail(browser, 1, 'SMOKE FAIL — page would not load\n' + String(e).slice(0, 400));
  }

  try {
    await page.waitForFunction('window.__ACNTR_READY__ === true', { timeout: 180000 });
  } catch {
    // The game records its own boot error, which is far more useful than the
    // timeout — report that first, then the raw console.
    const err = await page.evaluate(() => window.__ACNTR_ERROR__ || null).catch(() => null);
    const real = errors.filter((e) => !BENIGN.some((r) => r.test(e)));
    console.error('SMOKE FAIL — the game never reached __ACNTR_READY__');
    if (err) console.error('\n' + err);
    for (const e of [...new Set(real)].slice(0, 10)) console.error('\n  ' + e);
    if (!err && !real.length) {
      console.error('\n  (no error was reported — the boot is hanging rather than throwing)');
    }
    await bail(browser, 1);
  }

  // Booting is necessary but not sufficient: a scene that reaches ready with
  // nothing in it is also broken, and has happened here.
  const stats = await page.evaluate(() => {
    const d = window.__ACNTR__?.debug;
    try { return d?.stats?.() ?? null; } catch { return null; }
  }).catch(() => null);

  const real = errors.filter((e) => !BENIGN.some((r) => r.test(e)));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`SMOKE OK — booted in ${secs}s`
    + (stats ? `  (${stats.sceneObjects} objects, ${stats.drawCalls} draw calls, ${stats.programs} programs)` : ''));
  if (stats && stats.sceneObjects < 20) {
    console.error(`SMOKE FAIL — booted but the scene has only ${stats.sceneObjects} objects`);
    await bail(browser, 1);
  }
  if (real.length) {
    console.error(`\n${real.length} console error(s) during boot:`);
    for (const e of [...new Set(real)].slice(0, 10)) console.error('  ' + e);
  }

  await browser.close();
  killTree(server);
})();
