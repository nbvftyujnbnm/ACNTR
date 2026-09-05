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
import { spawnServer, killTree, waitForServer, run, buildAndPreview } from './server.mjs';
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
const SHOT_TIMEOUT = parseInt(arg('shotTimeout', '180000'), 10);

const POSE_DIR = resolve(ROOT, 'tools/poses');

/**
 * The REVIEW set — what a bare `node tools/capture.mjs` shoots, and what
 * REVIEW.md grades. Everything else in tools/poses/ is a diagnostic and has to
 * be asked for by name.
 *
 * The distinction matters because diagnostics deliberately lie: plume_forced
 * detaches the thruster driver and forces intensity to 6, plume_nosoft disables
 * the soft-particle depth fade, particles fires a point-blank explosion at a
 * fixed camera. Handing a critic those frames alongside the real ones invites a
 * grade on a state the game never actually produces.
 */
const REVIEW_POSES = [
  'hero', 'mech_detail', 'vista', 'gameplay', 'hud', 'combat_vfx', 'boost', 'garage', 'plume',
];

const known = new Set(
  readdirSync(POSE_DIR).filter((f) => f.endsWith('.js')).map((f) => basename(f, '.js')),
);
const requested = arg('poses', null);
const poses = requested && requested !== true
  ? String(requested).split(',').map((s) => s.trim())
  : REVIEW_POSES.filter((p) => known.has(p));

const missing = poses.filter((p) => !known.has(p));
if (missing.length) {
  console.error(`unknown pose(s): ${missing.join(', ')}\navailable: ${[...known].sort().join(', ')}`);
  process.exit(3);
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

  if (useDev) {
    // A stray backtick in a GLSL comment still BUILDS (it is valid JS) and only
    // fails at import time with an unrelated-looking error, after ~8 minutes of
    // capture. Catch it in milliseconds instead.
    const lint = await run('node', ['tools/lint-glsl.mjs'], ROOT);
    if (lint.code !== 0) {
      console.error(lint.out);
      process.exit(3);
    }
    server = spawnServer('npx',
      ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], ROOT);
    const url = `http://127.0.0.1:${port}/`;
    if (!(await waitForServer(url))) {
      console.error('server failed to start:\n' + server.log());
      process.exit(3);
    }
    return url;
  }

  const built = await buildAndPreview(ROOT, port);
  if (built.server) server = built.server;
  if (built.error) {
    console.error(built.error);
    process.exit(3);
  }
  return built.url;
}

(async () => {
  const url = arg('url', null) || (await startServer());
  const outDir = resolve(ROOT, OUT_DIR);
  mkdirSync(outDir, { recursive: true });

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  // Known-benign noise, kept OUT of the pass/fail set but still reported.
  //
  // index.html pulls Rajdhani and Share Tech Mono from Google Fonts, and this
  // sandbox's network policy blocks that host — so every single capture logs a
  // connection reset and a 404 that have nothing to do with the render. Since
  // REVIEW.md makes any console error an automatic failure, that meant every
  // review set in the project's history opened with a spurious automatic fail,
  // which trains a reviewer to ignore the error list entirely. The font link is
  // correct for a real deployment and should stay; the harness is what needs to
  // know the difference between a blocked third-party fetch and a defect.
  //
  // Consequence worth remembering when grading category 8: the HUD in every
  // captured frame is rendering in its FALLBACK stack, not the typeface it will
  // ship with.
  const BENIGN = [
    /net::ERR_CONNECTION_RESET/,
    /Failed to load resource: the server responded with a status of 404/,
    /fonts\.(googleapis|gstatic)\.com/,
  ];
  const isBenign = (t) => BENIGN.some((re) => re.test(t));

  const consoleErrors = [];
  const benignErrors = [];
  const note = (t) => (isBenign(t) ? benignErrors : consoleErrors).push(t);
  page.on('console', (m) => {
    if (m.type() === 'error') note(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => note(String(e.message || e).slice(0, 400)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  try {
    await page.waitForFunction('window.__ACNTR_READY__ === true', { timeout: 180000 });
  } catch {
    const err = await page.evaluate(() => window.__ACNTR_ERROR__ || null);
    console.error('=== GAME FAILED TO BOOT ===');
    if (err) console.error(err);
    for (const e of consoleErrors.slice(0, 40)) console.error('  console: ' + e);
    await browser.close();
    killTree(server);
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
    await page.evaluate(() => {
      delete window.__POSE_NOTE__;
      delete window.__POSE_CLEANUP__;
    }).catch(() => {});
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
    //
    // A pose that still blows the budget must not take the review set with it.
    // One CSS backdrop-filter over the canvas was enough to make the garage
    // pose unscreenshottable, and an unhandled rejection there threw away six
    // frames that had already been captured successfully — including the
    // report.json that says what happened.
    let shotFailed = null;
    const shotStart = Date.now();
    try {
      await page.screenshot({ path: resolve(outDir, file), type: 'png', timeout: SHOT_TIMEOUT });
    } catch (e) {
      shotFailed = String(e.message || e).split('\n')[0].slice(0, 200);
      console.error(`  FAILED ${file}: ${shotFailed}`);
    }
    const shotMs = Date.now() - shotStart;
    const stats = await page.evaluate(() => {
      try { return window.__ACNTR__.debug.stats(); } catch { return null; }
    }).catch(() => null);
    // A pose can report what it actually managed to set up. A "gameplay" frame
    // with no enemies in it, or a "boost" frame at 0 m/s, is worse than a
    // failed shot: it looks fine and gets graded as though it showed the thing
    // it was supposed to show. Both of those had happened.
    const note = await page.evaluate(() => window.__POSE_NOTE__ ?? null).catch(() => null);
    const shot = { pose, file, stats, shotMs, newErrors: consoleErrors.length - before };
    if (note) shot.note = note;
    if (shotFailed) shot.failed = shotFailed;
    report.shots.push(shot);
    if (!shotFailed) {
      console.log(`  captured ${file}  (${(shotMs / 1000).toFixed(1)}s${stats ? `, ${stats.drawCalls} calls, ${(stats.triangles / 1000) | 0}k tris, ${stats.fps} fps` : ''})`);
    }
    if (note?.warning) console.error(`  [pose:${pose}] ${note.warning}`);
    // Reset between poses so state doesn't leak.
    await page.evaluate(() => {
      try {
        // A POSE MUST NOT RESTORE ITS OWN STATE ON A TIMER. `page.screenshot`
        // of a 1920x1080 WebGL canvas under SwiftShader has measured 24-130
        // SECONDS on this box (every `shotMs` in `shots/*/report.json` says
        // so), while the poses that predate this hook all cleaned up on a
        // `setTimeout` of 3000 or 6000 ms. Every one of those fired long
        // before the shutter, so the frame on disk was composed AFTER the
        // pose had unfrozen the clock and released the camera.
        //
        // That is not a subtle bias. `muzzleanat` measured the particle clock
        // running on 0.52 s past freeze, which is five times the longest
        // muzzle-flash particle's life: the pose photographed an empty
        // volume and the flash was written off as broken. The same hook also
        // answers the standing "setCamera does not reach the render" puzzle
        // recorded in CONTRACT.md — `releaseCamera()` on a 6 s timer had
        // handed the frame back to the chase camera before the shutter.
        //
        // So poses hand their teardown to `window.__POSE_CLEANUP__` and it is
        // called HERE, after the screenshot and after the note is read.
        const fn = window.__POSE_CLEANUP__;
        delete window.__POSE_CLEANUP__;
        if (typeof fn === 'function') fn();
      } catch (e) {
        console.warn('[pose cleanup] threw', e);
      }
      try {
        const d = window.__ACNTR__.debug;
        d.silhouette({ on: false })
          .releaseCamera()
          .freeze(false)
          .setHudVisible(true)
          .resetState()
          .clearEnemies()
          .releaseKeys();
        // Poses share ONE browser session, so a pass a pose switched off has to
        // come back on even if that pose's own restore never fired. This is the
        // same class of leak that once carried a low-AP red vignette out of the
        // HUD pose and into the VFX frame after it.
        for (const p of ['taa', 'ssao', 'motionBlur', 'dof']) d.setPass(p, true);
        window.__ACNTR__.game?.closeGarage?.();
      } catch { /* noop */ }
    }).catch(() => {});
  }

  const failed = report.shots.filter((s) => s.failed);
  report.failedShots = failed.map((s) => s.pose);
  report.consoleErrors = [...new Set(consoleErrors)].slice(0, 30);
  report.benignErrors = [...new Set(benignErrors)].slice(0, 10);
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify({ shots: report.shots.map((s) => s.file), errors: report.consoleErrors }, null, 2));

  await browser.close();
  killTree(server);
  process.exit(report.consoleErrors.length || failed.length ? 1 : 0);
})();
