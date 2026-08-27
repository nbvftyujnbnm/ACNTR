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
import { spawn } from 'node:child_process';
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

let server = null;
(async () => {
  const port = 5900 + Math.floor(Math.random() * 400);
  server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}/`;
  if (!(await waitForServer(url))) { console.error('vite failed:\n' + log); process.exit(3); }

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
    await browser.close(); server.kill(); process.exit(2);
  }
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
  server.kill();
})();
