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
import { spawnServer, killTree, waitForServer, run } from './server.mjs';
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
  if (!useDev) {
    const lint = await run('node', ['tools/lint-glsl.mjs'], ROOT);
    if (lint.code !== 0) { console.error(lint.out); process.exit(3); }
    const built = await run('npx', ['vite', 'build'], ROOT);
    if (built.code !== 0) { console.error('=== BUILD FAILED ===\n' + built.out.slice(-4000)); process.exit(3); }
  }

  const port = 5900 + Math.floor(Math.random() * 400);
  const serverArgs = useDev
    ? ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  server = spawnServer('npx', serverArgs, ROOT);
  const url = `http://127.0.0.1:${port}/`;
  if (!(await waitForServer(url))) { console.error('vite failed:\n' + server.log()); process.exit(3); }

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
