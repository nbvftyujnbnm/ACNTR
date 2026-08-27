#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 *   node tools/screenshot.mjs --out shots/x.png [--w 1920] [--h 1080]
 *       [--wait 4000] [--script tools/poses/hero.js] [--pose hero]
 *
 * Boots the vite dev server itself (unless --url is given), waits for
 * `window.__ACNTR_READY__`, optionally evaluates a pose script in page context,
 * lets the renderer settle (TAA/temporal effects need frames), then captures.
 *
 * Exits non-zero and prints the page error if the game failed to boot — so a
 * broken build can never be mistaken for a bad-looking one.
 */
import { launch } from './browser.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const OUT = arg('out', 'shots/frame.png');
const W = parseInt(arg('w', '1920'), 10);
const H = parseInt(arg('h', '1080'), 10);
const WAIT = parseInt(arg('wait', '3500'), 10);
const SETTLE = parseInt(arg('settle', '900'), 10);
const POSE = arg('pose', null);
const SCRIPT = arg('script', null);
const URL_ARG = arg('url', null);
const KEEP = arg('keep', false);

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || res.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
async function startServer() {
  const port = 5173 + Math.floor(Math.random() * 400);
  server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d.toString()));
  server.stderr.on('data', (d) => (log += d.toString()));
  const url = `http://127.0.0.1:${port}/`;
  const ok = await waitForServer(url);
  if (!ok) {
    console.error('vite failed to start:\n' + log);
    process.exit(3);
  }
  return url;
}

(async () => {
  const url = URL_ARG || (await startServer());

  const browser = await launch();
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  try {
    await page.waitForFunction('window.__ACNTR_READY__ === true', { timeout: WAIT + 45000 });
  } catch {
    const err = await page.evaluate(() => window.__ACNTR_ERROR__ || null);
    console.error('GAME FAILED TO BOOT');
    if (err) console.error(err);
    for (const e of consoleErrors.slice(0, 25)) console.error('  console: ' + e);
    await browser.close();
    if (server && !KEEP) server.kill();
    process.exit(2);
  }

  // Optional pose script: runs in page context with __ACNTR__ available.
  let poseSrc = null;
  if (SCRIPT) poseSrc = readFileSync(resolve(ROOT, SCRIPT), 'utf8');
  else if (POSE) {
    const p = resolve(ROOT, `tools/poses/${POSE}.js`);
    if (existsSync(p)) poseSrc = readFileSync(p, 'utf8');
    else console.warn(`[shot] pose "${POSE}" not found at ${p} — capturing default view`);
  }
  if (poseSrc) {
    await page.evaluate(poseSrc);
  }

  // Let temporal effects converge and animations reach a representative frame.
  await page.waitForTimeout(SETTLE);

  const outPath = resolve(ROOT, OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, type: 'png' });

  const stats = await page.evaluate(() => {
    const e = window.__ACNTR__?.engine;
    if (!e) return null;
    const i = e.renderer.info;
    return {
      fps: Math.round(e.fps),
      calls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
      resolutionScale: e.resolutionScale,
    };
  });

  console.log(JSON.stringify({ out: OUT, stats, consoleErrors: consoleErrors.slice(0, 10) }, null, 2));

  await browser.close();
  if (server && !KEEP) server.kill();
  process.exit(consoleErrors.length && consoleErrors.some((e) => /THREE|WebGL|Uncaught/i.test(e)) ? 1 : 0);
})();
