#!/usr/bin/env node
/**
 * Guard against the one mistake that has now broken this project THREE times.
 *
 * Shader source lives in template literals:
 *
 *     export const FRAG = /-* glsl *-/ `
 *       // Orthonormal basis rotated by `ang` ...   <-- THIS
 *       void main() { ... }
 *     `;
 *
 * A backtick inside the GLSL — even inside a GLSL *comment*, where it reads as
 * harmless prose — closes the template literal. Everything after it parses as
 * JavaScript. Sometimes the file still BUILDS (it is valid JS) and the failure
 * only appears at import time as something unrelated like
 * `ReferenceError: x is not defined`; sometimes, as in Terrain.js, it fails the
 * build with a parse error pointing at a comment. Either way the message points
 * nowhere near the real cause.
 *
 * WHY THIS WAS REWRITTEN. The first version only inspected literals carrying a
 * `/-* glsl *-/` tag, and skipped any file that contained no such tag at all.
 * Terrain.js injects its shader through `onBeforeCompile` with plain, untagged
 * template literals — so the file was never examined, the lint reported CLEAN,
 * and the third occurrence of this bug landed on the branch anyway. A guard
 * that only checks the cases you remembered to label is not a guard.
 *
 * Detection now: scan every file properly — tracking line comments, block
 * comments, quoted strings and dollar-brace nesting — to find EVERY template
 * literal. For each one whose contents look like GLSL, check that it closed
 * somewhere sane: a real terminator is followed only by a semicolon, comma,
 * closing bracket or the end of the line. Anything else means it closed early
 * on a stray backtick.
 *
 * Deliberately NOT done: a second "any backtick in a GLSL-looking comment"
 * sweep. It was tried and flagged three ordinary JavaScript comments in
 * Level.js that were nowhere near a shader, because tracking "am I inside a
 * shader" line-by-line cannot be done reliably without the real scan. A lint
 * that cries wolf gets ignored, which is how a guard stops guarding.
 *
 * Usage: node tools/lint-glsl.mjs [files...]   (defaults to all of src/)
 * Exit 0 clean, 1 on findings.
 */
import { readFileSync, globSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : globSync('src/**/*.js', { cwd: ROOT }).map((f) => resolve(ROOT, f));

/** Does this text look like shader source rather than ordinary prose? */
function looksLikeGLSL(text) {
  return /\bvoid\s+main\s*\(|gl_Frag|gl_Position|\bvarying\s|\buniform\s|#include\s*<|\bvec[234]\s|\bfloat\s+\w+\s*=/.test(text);
}

/**
 * Find every template literal in a JS source, skipping the ones that are
 * themselves inside comments or quoted strings. Returns {open, close, body}.
 * `close` is -1 for an unterminated literal.
 */
function findTemplateLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // line comment
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // quoted string
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        if (src[i] === '\n') break; // unterminated; bail rather than run away
        i++;
      }
      i++;
      continue;
    }
    // template literal
    if (c === '`') {
      const open = i;
      i++;
      let depth = 0;
      let close = -1;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (depth === 0 && d === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (depth > 0) {
          // Inside ${...}: only track braces well enough to get back out.
          if (d === '{') depth++;
          else if (d === '}') depth--;
          i++;
          continue;
        }
        if (d === '`') { close = i; break; }
        i++;
      }
      out.push({ open, close, body: src.slice(open + 1, close === -1 ? n : close) });
      i = close === -1 ? n : close + 1;
      continue;
    }
    i++;
  }
  return out;
}

const findings = [];

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!src.includes('`')) continue;

  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const lines = src.split('\n');

  for (const lit of findTemplateLiterals(src)) {
    if (!looksLikeGLSL(lit.body)) continue;

    if (lit.close === -1) {
      findings.push({ file, line: lineOf(lit.open), msg: 'GLSL template literal is never closed' });
      continue;
    }

    // A real terminator is followed only by ; , ) ] } or the end of the line.
    const after = src.slice(lit.close + 1, lit.close + 41);
    const ok = /^\s*[;,)\]}]/.test(after) || /^\s*$/.test(after.split('\n')[0]);
    if (!ok) {
      const line = lineOf(lit.close);
      findings.push({
        file,
        line,
        msg: 'GLSL literal closed early on a stray backtick — the rest of the shader is being parsed as JavaScript',
        text: (lines[line - 1] ?? '').trim().slice(0, 110),
      });
    }
  }

}

if (findings.length) {
  console.error('\n=== STRAY BACKTICK IN GLSL ===');
  for (const f of findings) {
    console.error(`\n${relative(ROOT, f.file)}:${f.line}  ${f.msg}`);
    if (f.text) console.error(`    ${f.text}`);
  }
  console.error(`\n${findings.length} finding(s). Replace backticks in GLSL comments with plain words.\n`);
  process.exit(1);
}

console.log(`glsl-lint: clean (${files.length} files scanned)`);
