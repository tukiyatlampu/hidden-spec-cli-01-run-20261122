// Small fuzzer for mend. Generates random files and random (valid or
// mutated) patches in all four formats, runs `node main.ts` twice on each,
// and checks: exit code in {0,1,2}, no crash trace on stderr, well-formed
// stdout for the exit code, and byte-identical results across the two runs.
// Run: `node tests/fuzz.mjs [iterations]`
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');
const N = Number(process.argv[2] ?? 400);

// Deterministic PRNG (mulberry32).
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'return x;', 'if (a) {', '}', 'total += 1;', '# note', 'x = 42;', 'function f() {', '  // c', ''];
const INDENTS = ['', '', '  ', '    ', '\t'];

function randomFile() {
  const n = 3 + ri(12);
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    let l = pick(INDENTS) + pick(WORDS);
    if (rnd() < 0.15) l += pick([' ', '  ', '\t']);
    lines.push(l);
  }
  const br = rnd() < 0.25 ? '\r\n' : '\n';
  const final = rnd() < 0.8;
  return lines.join(br) + (final ? br : '');
}

function drift(line) {
  // Random whitespace drift of a line, as a model would write it.
  const r = rnd();
  const body = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (r < 0.25) return pick(INDENTS) + body;
  if (r < 0.4) return body + pick([' ', '  ']);
  if (r < 0.5) return pick(INDENTS) + body + ' ';
  return line;
}

function splitLines(text) {
  const br = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.split(br);
  if (text.endsWith(br)) parts.pop();
  return { br, lines: parts, final: text.endsWith(br) };
}

function makePatch(fmt, fname, text) {
  const { lines } = splitLines(text);
  const start = ri(Math.max(1, lines.length - 1));
  const len = 1 + ri(Math.min(3, lines.length - start));
  const old = lines.slice(start, start + len);
  const rep = old.map((l) => (rnd() < 0.5 ? `CHANGED ${l.replace(/^[ \t]+/, '')}` : l));
  const ctxBefore = start > 0 ? [lines[start - 1]] : [];
  const ctxAfter = start + len < lines.length ? [lines[start + len]] : [];
  if (fmt === 'unified') {
    const a = 1 + ri(50); // wrong line numbers on purpose
    const body = [
      ...ctxBefore.map((l) => ` ${l}`),
      ...old.map((l) => `-${l}`),
      ...rep.map((l) => `+${l}`),
      ...ctxAfter.map((l) => ` ${l}`),
    ];
    return `--- a/${fname}\n+++ b/${fname}\n@@ -${a},${old.length + ctxBefore.length + ctxAfter.length} +${a},${rep.length + ctxBefore.length + ctxAfter.length} @@\n${body.join('\n')}\n`;
  }
  if (fmt === 'search-replace') {
    return `${fname}\n<<<<<<< SEARCH\n${old.map(drift).join('\n')}\n=======\n${rep.join('\n')}\n>>>>>>> REPLACE\n`;
  }
  if (fmt === 'v4a') {
    const anchor = start > 0 ? lines[start - 1] : null;
    const head = anchor !== null ? `@@ ${anchor}\n` : '';
    const body = [
      ...ctxBefore.map((l) => ` ${l}`),
      ...old.map((l) => `-${l}`),
      ...rep.map((l) => `+${l}`),
      ...ctxAfter.map((l) => ` ${l}`),
    ];
    return `*** Begin Patch\n*** Update File: ${fname}\n${head}${body.join('\n')}\n*** End Patch\n`;
  }
  return JSON.stringify({ command: 'str_replace', path: fname, old_str: old.join('\n'), new_str: rep.join('\n') }) + '\n';
}

function mutate(patch) {
  const lines = patch.split('\n');
  const op = ri(4);
  if (op === 0 && lines.length > 1) lines.splice(ri(lines.length), 1);
  else if (op === 1) lines.splice(ri(lines.length), 0, lines[ri(lines.length)]);
  else if (op === 2 && lines.length > 0) {
    const i = ri(lines.length);
    lines[i] = lines[i].replace(/[a-z]/, (c) => (c === 'a' ? 'b' : 'a'));
  } else if (op === 3) return patch.slice(0, Math.floor(patch.length / 2));
  return lines.join('\n');
}

function runOnce(dir, argv, stdin) {
  const r = spawnSync(process.execPath, [MAIN, ...argv], { cwd: dir, input: stdin, encoding: 'utf8', timeout: 10_000 });
  const exit = r.error !== undefined || r.status === null ? 124 : r.status;
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p);
    }
  };
  walk(dir);
  return { exit, stdout: r.stdout ?? '', stderr: r.stderr ?? '', files: out };
}

const OK_STDOUT = {
  0: /^(?:[AMD] \S+\n|R \S+ -> \S+\n)*ok: \d+ files?\n$/,
  1: /^(?:error: (?:no-match|ambiguous|missing|exists|unsafe) \S+\n)+failed: \d+ of \d+ edits\n$/,
  2: /^error: (?:usage|no-patch|format|parse \d+)\n$/,
};

let ok = 0;
let bad = 0;
const problems = [];
const counts = { 0: 0, 1: 0, 2: 0, other: 0 };
for (let iter = 0; iter < N; iter += 1) {
  const fname = pick(['a.txt', 'src/b.js', 'lib/c.md']);
  const text = randomFile();
  const fmt = pick(['unified', 'search-replace', 'v4a', 'json']);
  let patch = makePatch(fmt, fname, text);
  const mutated = rnd() < 0.5;
  if (mutated) patch = mutate(patch);
  const dir = mkdtempSync(join(tmpdir(), 'mend-fuzz-'));
  try {
    const f = join(dir, ...fname.split('/'));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    const argv = rnd() < 0.5 ? ['-'] : ['patch.txt'];
    if (argv[0] === 'patch.txt') writeFileSync(join(dir, 'patch.txt'), patch);
    const stdin = argv[0] === '-' ? patch : '';
    const r1 = runOnce(dir, argv, stdin);
    // Reset the tree and run again for determinism.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    if (argv[0] === 'patch.txt') writeFileSync(join(dir, 'patch.txt'), patch);
    const r2 = runOnce(dir, argv, stdin);
    counts[r1.exit] !== undefined ? (counts[r1.exit] += 1) : (counts.other += 1);
    const issues = [];
    if (![0, 1, 2].includes(r1.exit)) issues.push(`exit ${r1.exit}`);
    else if (!OK_STDOUT[r1.exit].test(r1.stdout)) issues.push(`malformed stdout for exit ${r1.exit}: ${JSON.stringify(r1.stdout)}`);
    if (/node:internal|Error:|at\s+\S+ \(/.test(r1.stderr)) issues.push(`stderr trace: ${r1.stderr.slice(0, 200)}`);
    if (r1.exit !== r2.exit || r1.stdout !== r2.stdout) issues.push('nondeterministic exit/stdout');
    for (const p of Object.keys(r1.files)) {
      const a = r1.files[p];
      const b = r2.files[p];
      if (b === undefined || !a.equals(b)) {
        issues.push(`nondeterministic file ${p}`);
        break;
      }
    }
    if (issues.length === 0) ok += 1;
    else {
      bad += 1;
      if (problems.length < 10) problems.push(`iter ${iter} fmt=${fmt} mutated=${mutated}: ${issues.join('; ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`fuzz: ${ok} ok, ${bad} bad of ${N}; exits ${JSON.stringify(counts)}`);
for (const p of problems) console.log(`FAIL ${p}`);
if (bad > 0) process.exitCode = 1;
