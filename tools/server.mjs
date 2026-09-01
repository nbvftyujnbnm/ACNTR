/**
 * Spawning and — the part that actually needed fixing — REAPING the static
 * server the headless tools drive.
 *
 * `spawn('npx', ['vite', 'preview', ...])` produces a three-deep process tree:
 * npx -> sh -c -> node vite. `child.kill()` signals only the npx wrapper, so
 * every capture, probe and silhouette run left a live vite server behind. Seven
 * of them had accumulated in one session, each holding a port and competing for
 * the CPU that SwiftShader needs; a `vite build` that normally takes four
 * seconds was taking minutes, which read as "the harness is mysteriously slow"
 * rather than "we are leaking servers".
 *
 * The fix is to put the child in its own process group (`detached: true`) and
 * signal the GROUP with `process.kill(-pid)`, which reaches the real node
 * process. Exit handlers are attached too, so a crash or a Ctrl-C reaps the
 * server rather than orphaning it.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const live = new Set();
const tempBuilds = new Set();
let hooked = false;

function reapAll() {
  for (const child of live) killTree(child);
  live.clear();
  for (const dir of tempBuilds) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tempBuilds.clear();
}

function hookExit() {
  if (hooked) return;
  hooked = true;
  for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
    process.on(sig, () => {
      reapAll();
      if (sig !== 'exit') process.exit(sig === 'uncaughtException' ? 1 : 130);
    });
  }
}

/** Kill a detached child and everything it spawned. Safe to call twice. */
export function killTree(child) {
  if (!child || child.killed === undefined) return;
  live.delete(child);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // No process group (not detached, or already reaped) — fall back.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Spawn a long-lived server in its own process group and register it for
 * reaping. Returns the child; read `child.log()` for everything it has printed.
 */
export function spawnServer(cmd, args, cwd) {
  hookExit();
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));
  child.log = () => log;
  live.add(child);
  return child;
}

/** Poll a URL until it answers or the deadline passes. */
export async function waitForServer(url, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Build the app into a directory of this run's own, and start a preview server
 * on it. Returns `{ url, outDir }`.
 *
 * The per-run directory is the point. Several agents capture at the same time,
 * and `vite build` into a shared `dist/` lets two builds interleave — the
 * second one clears the directory while the first is still writing it, and the
 * preview that follows serves a bundle that is half one revision and half
 * another. That failure does not announce itself; it shows up as a review frame
 * that disagrees with the source, which is worse than a crash. Directories are
 * removed when the process exits.
 */
export async function buildAndPreview(root, port, { lint = true } = {}) {
  hookExit();
  if (lint) {
    const l = await run('node', ['tools/lint-glsl.mjs'], root);
    if (l.code !== 0) return { error: l.out };
  }
  const outDir = resolve(root, '.builds', `run-${process.pid}-${Date.now().toString(36)}`);
  tempBuilds.add(outDir);
  const b = await run('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], root);
  if (b.code !== 0) return { error: '=== BUILD FAILED ===\n' + b.out.slice(-4000) };

  const child = spawnServer('npx', [
    'vite', 'preview', '--outDir', outDir,
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], root);
  const url = `http://127.0.0.1:${port}/`;
  if (!(await waitForServer(url))) return { error: 'vite preview failed:\n' + child.log(), server: child };
  return { url, outDir, server: child };
}

/** Run a command to completion, capturing combined output. */
export function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}
