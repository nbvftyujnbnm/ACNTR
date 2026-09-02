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
const smoothFindings = [];

/**
 * `smoothstep(edge0, edge1, x)` is UNDEFINED in GLSL ES when `edge0 >= edge1`,
 * and the usual driver implementation short-circuits `if (x < edge0) return 0.0`
 * — so the "obvious" way to write a falling edge, `smoothstep(1.0, 0.55, v)`,
 * returns ZERO FOR EVERY x below the high edge. It compiles, it links, it draws,
 * and it produces no pixels. That is exactly how the thruster plumes and the
 * explosion dome shockwave were dark for weeks while every other VFX batch drew
 * fine. Write `1.0 - smoothstep(lo, hi, x)` instead.
 *
 * Only NUMERIC LITERAL edges are checked. Symbolic ones (`smoothstep(inner,
 * 1.0 - th, r)`) cannot be decided without evaluating the shader, and a lint
 * that guesses is a lint that cries wolf — see the note above about the
 * backtick sweep that was tried and removed.
 */
const SMOOTHSTEP_LITERALS = /\bsmoothstep\s*\(\s*(-?\d+(?:\.\d*)?|-?\.\d+)\s*,\s*(-?\d+(?:\.\d*)?|-?\.\d+)\s*,/g;

/**
 * Blank out GLSL comments, preserving length and newlines so byte offsets still
 * map to the right line. Without this the check fires on the comment that
 * explains the bug, which is how a lint teaches people to ignore it.
 */
function stripGlslComments(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

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

    const code = stripGlslComments(lit.body);
    SMOOTHSTEP_LITERALS.lastIndex = 0;
    let sm;
    while ((sm = SMOOTHSTEP_LITERALS.exec(code)) !== null) {
      const e0 = parseFloat(sm[1]);
      const e1 = parseFloat(sm[2]);
      if (e0 < e1) continue;
      const line = lineOf(lit.open + 1 + sm.index);
      smoothFindings.push({
        file,
        line,
        msg: e0 === e1
          ? `smoothstep(${sm[1]}, ${sm[2]}, ...) has a zero-width edge — undefined, divides by zero`
          : `smoothstep(${sm[1]}, ${sm[2]}, ...) runs backwards — undefined, and returns 0 on the common driver`,
        text: (lines[line - 1] ?? '').trim().slice(0, 110),
      });
    }

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
}

if (smoothFindings.length) {
  console.error('\n=== BACKWARDS smoothstep ===');
  for (const f of smoothFindings) {
    console.error(`\n${relative(ROOT, f.file)}:${f.line}  ${f.msg}`);
    if (f.text) console.error(`    ${f.text}`);
  }
  console.error(`\n${smoothFindings.length} finding(s). Write 1.0 - smoothstep(lo, hi, x) for a falling edge.\n`);
}

if (findings.length || smoothFindings.length) process.exit(1);

console.log(`glsl-lint: clean (${files.length} files scanned)`);
