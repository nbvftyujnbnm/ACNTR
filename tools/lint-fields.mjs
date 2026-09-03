#!/usr/bin/env node
/**
 * Find properties that are READ but never ASSIGNED anywhere in src/.
 *
 *   node tools/lint-fields.mjs
 *   node tools/lint-fields.mjs --min 1     # also report single-use reads
 *
 * WHY. `LootSystem` read `p.body` in three places and never created it — the
 * record it builds is `{root, cage, core, bandA, bandB, shards, beam, decal,
 * halo}`, with no `body` on it and no assignment to one in the file. Picking
 * up ANY loot therefore threw "Cannot read properties of undefined (reading
 * 'scale')" and took the frame loop down with it. The looter half of a looter
 * shooter did not work, and nothing in lint, the build, or a screenshot could
 * see it.
 *
 * That shape is mechanical, so it should be checked mechanically. It is the
 * same family as the never-called-setter sweep recorded in CONTRACT.md, which
 * has found seven real bugs: one side of a contract landed and the other did
 * not.
 *
 * THIS IS A HEURISTIC, NOT A TYPE CHECKER. It is text-based, so it cannot tell
 * `p.body` on a local record from `mesh.material` on a THREE object. Two
 * things keep the noise down: assignments are gathered across ALL of src/ (a
 * property assigned in any file counts as known), and an allowlist covers the
 * library and DOM surface this project actually touches. Everything it prints
 * still needs a human read — treat it as a list of questions, not defects.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const MIN = (() => {
  const i = process.argv.indexOf('--min');
  return i === -1 ? 2 : Math.max(1, parseInt(process.argv[i + 1], 10) || 2);
})();

// Properties that come from three.js, the DOM, or the JS runtime. A read of
// one of these tells us nothing, because the assignment lives in a library
// this scan never sees.
const KNOWN = new Set(`
x y z w r g b a length width height depth top left right bottom size count index
position rotation quaternion scale matrix matrixWorld matrixWorldInverse up
children parent name visible userData type uuid layers renderOrder frustumCulled
matrixAutoUpdate castShadow receiveShadow material geometry attributes uniforms
value needsUpdate array itemSize normalized usage instanceMatrix instanceColor
map color emissive emissiveIntensity opacity transparent blending depthWrite
depthTest side toneMapped fog wireframe roughness metalness normalScale
envMap envMapIntensity alphaTest premultipliedAlpha vertexColors flatShading
vertexShader fragmentShader defines extensions precision lights clipping
fov aspect near far zoom projectionMatrix isVector3 isVector2 isColor isMesh
isObject3D isCamera isPerspectiveCamera isInstancedMesh isPoints isLine isGroup
isBufferGeometry isMaterial isTexture isLight isSprite isSkinnedMesh
intensity distance decay angle penumbra shadow bias normalBias radius blurSamples
target camera mapSize autoUpdate
image wrapS wrapT magFilter minFilter format encoding colorSpace generateMipmaps
anisotropy flipY repeat offset center rotationOffset
boundingBox boundingSphere min max
domElement style className id classList dataset textContent innerHTML innerText
clientWidth clientHeight offsetWidth offsetHeight scrollTop scrollLeft
addEventListener removeEventListener appendChild removeChild querySelector
devicePixelRatio innerWidth innerHeight
code key keyCode button buttons movementX movementY clientX clientY deltaY
altKey ctrlKey shiftKey metaKey repeat pointerType pressure
now performance requestAnimationFrame cancelAnimationFrame
prototype constructor __proto__ then catch finally stack message cause
size add has get set delete clear keys values entries forEach
push pop shift unshift splice slice concat join indexOf lastIndexOf includes
find findIndex filter some every reduce reduceRight sort reverse fill flat
toFixed toString valueOf charAt charCodeAt codePointAt substring substr
split replace replaceAll trim padStart padEnd startsWith endsWith match
toLowerCase toUpperCase normalize localeCompare repeat
context sampleRate destination currentTime gain frequency detune Q type
buffer loop loopStart loopEnd playbackRate onended numberOfChannels duration
pan positionX positionY positionZ orientationX orientationY orientationZ
coneInnerAngle coneOuterAngle coneOuterGain refDistance rolloffFactor maxDistance
distanceModel panningModel
`.trim().split(/\s+/).filter(Boolean));

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(SRC);

// Strip comments and string/template literals so their contents never register
// as either a read or an assignment. A `.foo` inside a doc comment is exactly
// how a stale name looks, and counting it would hide the bug being hunted.
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        // Template substitutions hold real code and must be kept.
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1; i += 2; out += ' ';
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) out += src[i];
            i++;
          }
          continue;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c; i++;
  }
  return out;
}

const assigned = new Set();
const reads = new Map(); // name -> [{file, line}]

const stripped = new Map();
for (const f of files) stripped.set(f, strip(readFileSync(f, 'utf8')));

// Pass 1: every way this codebase brings a property into existence.
for (const [, s] of stripped) {
  // `.foo =` / `.foo +=` etc, but never `==` / `===`
  for (const m of s.matchAll(/\.([A-Za-z_$][\w$]*)\s*(?:[-+*/|&^]|\?\?|\|\||&&)?=(?!=)/g)) assigned.add(m[1]);
  // `foo:` in an object literal or class field
  for (const m of s.matchAll(/(?:^|[{,(\s])([A-Za-z_$][\w$]*)\s*:/gm)) assigned.add(m[1]);
  // shorthand `{ foo, bar }` — both a literal and a destructure
  for (const m of s.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) assigned.add(m[1]);
  // class methods, getters, `foo(` declarations, and `foo =` class fields
  for (const m of s.matchAll(/(?:^|\s)(?:get|set|async)?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) assigned.add(m[1]);
  for (const m of s.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=(?!=)/gm)) assigned.add(m[1]);
  // `Object.assign(x, { ... })` and spreads are covered by the literal rule.
}

// Pass 2: every read.
for (const [f, s] of stripped) {
  const lines = s.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    for (const m of lines[ln].matchAll(/\.([A-Za-z_$][\w$]*)(?!\s*(?:[-+*/|&^]|\?\?|\|\||&&)?=(?!=))/g)) {
      const name = m[1];
      if (KNOWN.has(name)) continue;
      if (!reads.has(name)) reads.set(name, []);
      reads.get(name).push({ file: relative(ROOT, f), line: ln + 1 });
    }
  }
}

const findings = [];
for (const [name, sites] of reads) {
  if (assigned.has(name)) continue;
  if (sites.length < MIN) continue;
  findings.push({ name, sites });
}
findings.sort((a, b) => b.sites.length - a.sites.length);

if (!findings.length) {
  console.log(`field-lint: clean (${files.length} files, no property read ${MIN}+ times without an assignment anywhere in src/)`);
  process.exit(0);
}

console.log(`field-lint: ${findings.length} propert${findings.length === 1 ? 'y' : 'ies'} read but never assigned anywhere in src/\n`);
for (const f of findings) {
  console.log(`  .${f.name}  — read ${f.sites.length}x`);
  for (const s of f.sites.slice(0, 6)) console.log(`      ${s.file}:${s.line}`);
  if (f.sites.length > 6) console.log(`      … and ${f.sites.length - 6} more`);
  console.log('');
}
console.log('These are QUESTIONS, not defects: a text scan cannot tell a local record');
console.log('from a library object. Check each against where it is read.');
// Deliberately exit 0. This is a review aid, not a gate — a heuristic with
// false positives must never be able to block a commit.
process.exit(0);
