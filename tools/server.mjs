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

const live = new Set();
let hooked = false;

function reapAll() {
  for (const child of live) killTree(child);
  live.clear();
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
