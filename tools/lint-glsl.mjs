#!/usr/bin/env node
/**
 * Guard against the one mistake that has broken this project twice.
 *
 * Shader source lives in tagged template literals:
 *
 *     export const FRAG = /-* glsl *-/ `
 *       // Orthonormal basis rotated by `ang` ...   <-- THIS
 *       void main() { ... }
 *     `;
 *
 * A backtick inside the GLSL — even inside a GLSL *comment*, where it reads as
 * harmless prose — closes the template literal. Everything after it parses as
 * JavaScript. The file usually still BUILDS (it is valid JS), so `vite build`
 * reports success and the failure only appears at import time as something
 * unrelated like `ReferenceError: x is not defined`, taking down every boot and
 * every capture with an error that points nowhere near the real cause.
 *
 * Detection: for each `/-* glsl *-/` tag, take the following backtick as the
 * opener and scan to the next unescaped backtick. A correctly terminated
 * literal closes on a backtick followed only by `;` `,` `)` `}` or end of line.
 * Anything else means the literal closed early, on a stray backtick.
 *
 * Usage: node tools/lint-glsl.mjs [files...]   (defaults to all of src/)
 * Exit 0 clean, 1 on findings.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = '/* glsl */';

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : globSync('src/**/*.js', { cwd: ROOT }).map((f) => resolve(ROOT, f));

const findings = [];

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!src.includes(TAG)) continue;

  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  let from = 0;
  for (;;) {
    const tag = src.indexOf(TAG, from);
    if (tag === -1) break;
    from = tag + TAG.length;

    // Opening backtick after the tag (allow whitespace / a newline between).
    const open = src.indexOf('`', tag + TAG.length);
    if (open === -1) break;
    const between = src.slice(tag + TAG.length, open);
    if (between.trim() !== '') continue; // tag wasn't actually tagging a literal

    // Walk to the next unescaped backtick.
    let close = -1;
    for (let i = open + 1; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '`') { close = i; break; }
    }
    if (close === -1) {
      findings.push({ file, line: lineOf(open), msg: 'GLSL template literal is never closed' });
      break;
    }

    // A real terminator is followed only by ; , ) } or end of line.
    const after = src.slice(close + 1, close + 1 + 40);
    const ok = /^\s*[;,)\]}]/.test(after) || /^\s*$/.test(after.split('\n')[0]);
    if (!ok) {
      const line = lineOf(close);
      const text = src.split('\n')[line - 1] ?? '';
      findings.push({
        file,
        line,
        msg: `GLSL literal closed early on a stray backtick — the rest of the shader is being parsed as JavaScript`,
        text: text.trim().slice(0, 110),
      });
    }
    from = close + 1;
  }
}

if (findings.length) {
  console.error('\n=== STRAY BACKTICK IN GLSL ===');
  for (const f of findings) {
    console.error(`\n${relative(ROOT, f.file)}:${f.line}  ${f.msg}`);
    if (f.text) console.error(`    ${f.text}`);
  }
  console.error(`\n${findings.length} finding(s). Replace backticks in GLSL comments with quotes.\n`);
  process.exit(1);
}

console.log(`glsl-lint: clean (${files.length} files scanned)`);
