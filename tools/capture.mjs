#!/usr/bin/env node
/**
 * Batch capture — shoots every review pose in ONE browser session.
 *
 *   node tools/capture.mjs [--out shots/iter03] [--poses hero,gameplay,vista]
 *                          [--w 1920] [--h 1080]
 *
 * Much faster than one browser per shot, and guarantees every frame in a
 * review set came from the same build and the same warmed-up context.
 *
 * Exits 2 if the game fails to boot (and prints the real error), 1 if any
 * WebGL/shader/runtime console errors occurred, 0 on a clean run.
 */
import { launch } from './browser.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const OUT_DIR = arg('out', 'shots/latest');
const W = parseInt(arg('w', '1920'), 10);
const H = parseInt(arg('h', '1080'), 10);
const SETTLE = parseInt(arg('settle', '1100'), 10);

const POSE_DIR = resolve(ROOT, 'tools/poses');
const allPoses = readdirSync(POSE_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => basename(f, '.js'));
const requested = arg('poses', null);
const poses = requested && requested !== true ? String(requested).split(',').map((s) => s.trim()) : allPoses;

async function waitForServer(url, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

let server = null;
/**
 * Capture against a PRODUCTION BUILD served by `vite preview`, not the dev
 * server. The dev server has HMR: an agent editing a source file while a
 * capture is in flight reloads the page mid-run and the capture dies with a
 * misleading error. A built bundle is immutable for the life of the run, so
 * concurrent editing is safe — which matters because several agents edit and
 * capture at the same time.
 *
 * Pass --dev to opt back into the HMR dev server.
 */
async function startServer() {
  const port = 5200 + Math.floor(Math.random() * 600);
  const useDev = !!arg('dev', false);

  // A stray backtick in a GLSL comment still BUILDS (it is valid JS) and only
  // fails at import time with an unrelated-looking error, after ~8 minutes of
  // capture. Catch it in milliseconds instead.
  const lint = await run('node', ['tools/lint-glsl.mjs']);
  if (lint.code !== 0) {
    console.error(lint.out);
    process.exit(3);
  }

  if (!useDev) {
    const b = await run('npx', ['vite', 'build']);
    if (b.code !== 0) {
      console.error('=== BUILD FAILED ===\n' + b.out.slice(-4000));
      process.exit(3);
    }
  }

  const args = useDev
    ? ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  server = spawn('npx', args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d.toString()));
  server.stderr.on('data', (d) => (log += d.toString()));
  const url = `http://127.0.0.1:${port}/`;
  if (!(await waitForServer(url))) {
    console.error('server failed to start:\n' + log);
    process.exit(3);
  }
  return url;
}

(async () => {
  const url = arg('url', null) || (await startServer());
  const outDir = resolve(ROOT, OUT_DIR);
  mkdirSync(outDir, { recursive: true });

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message || e).slice(0, 400)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  try {
    await page.waitForFunction('window.__ACNTR_READY__ === true', { timeout: 180000 });
  } catch {
    const err = await page.evaluate(() => window.__ACNTR_ERROR__ || null);
    console.error('=== GAME FAILED TO BOOT ===');
    if (err) console.error(err);
    for (const e of consoleErrors.slice(0, 40)) console.error('  console: ' + e);
    await browser.close();
    server?.kill();
    process.exit(2);
  }

  // Captures run on SwiftShader (software raster). The engine's adaptive
  // resolution would read the low fps and quietly downscale, which would make
  // every review frame soft and blame the art for a harness artefact. Pin it.
  await page.evaluate(() => {
    const e = window.__ACNTR__?.engine;
    if (!e) return;
    e.adaptiveResolution = false;
    e.resolutionScale = 1;
    e.maxPixelRatio = 1;
    e.resize();
  });

  // Warm-up: let shaders compile, textures upload, and the first frames settle.
  await page.waitForTimeout(3500);

  const report = { out: OUT_DIR, viewport: [W, H], shots: [], consoleErrors: [] };

  for (const pose of poses) {
    const src = readFileSync(resolve(POSE_DIR, `${pose}.js`), 'utf8');
    const before = consoleErrors.length;
    try {
      await page.evaluate(src);
    } catch (e) {
      console.error(`[pose:${pose}] threw: ${String(e).slice(0, 400)}`);
    }
    await page.waitForTimeout(SETTLE);
    const file = `${pose}.png`;
    // A single frame of the full level can take well over Playwright's 30s
    // default under SwiftShader, and a timeout here reads as a broken build
    // rather than a slow one.
    await page.screenshot({ path: resolve(outDir, file), type: 'png', timeout: 180000 });
    const stats = await page.evaluate(() => {
      try { return window.__ACNTR__.debug.stats(); } catch { return null; }
    });
    report.shots.push({ pose, file, stats, newErrors: consoleErrors.length - before });
    console.log(`  captured ${file}${stats ? `  (${stats.drawCalls} calls, ${(stats.triangles / 1000) | 0}k tris, ${stats.fps} fps)` : ''}`);
    // Reset between poses so state doesn't leak.
    await page.evaluate(() => {
      try {
        window.__ACNTR__.debug
          .releaseCamera()
          .freeze(false)
          .setHudVisible(true)
          .resetState()
          .clearEnemies();
      } catch { /* noop */ }
    });
  }

  report.consoleErrors = [...new Set(consoleErrors)].slice(0, 30);
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify({ shots: report.shots.map((s) => s.file), errors: report.consoleErrors }, null, 2));

  await browser.close();
  server?.kill();
  process.exit(report.consoleErrors.length ? 1 : 0);
})();
