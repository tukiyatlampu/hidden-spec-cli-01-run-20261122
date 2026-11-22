// Edge tests for mend, beyond the kit's practice set. Each case is one run
// of `node main.ts` in a fresh temp dir. Run: `node tests/edge.mjs`
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

let passed = 0;
let failed = 0;
const failures = [];

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-edge-'));
  try {
    for (const [p, text] of Object.entries(c.files ?? {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], {
      cwd: dir, input: c.stdin ?? '', encoding: 'utf8', timeout: 10_000,
    });
    const exit = r.error !== undefined || r.status === null ? 124 : r.status;
    const out = {};
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    const want = c.expect;
    const problems = [];
    if (exit !== want.exit) problems.push(`exit ${exit} != ${want.exit}`);
    if ((r.stdout ?? '') !== (want.stdout ?? '')) problems.push(`stdout ${JSON.stringify(r.stdout)} != ${JSON.stringify(want.stdout)}`);
    const wantFiles = { ...(c.files ?? {}) };
    for (const [p, v] of Object.entries(want.changes ?? {})) {
      if (v === null) delete wantFiles[p];
      else wantFiles[p] = v;
    }
    for (const p of new Set([...Object.keys(wantFiles), ...Object.keys(out)])) {
      if (wantFiles[p] === undefined) problems.push(`${p} should not exist`);
      else if (out[p] === undefined) problems.push(`${p} is missing`);
      else if (out[p] !== wantFiles[p]) problems.push(`${p} differs: want ${JSON.stringify(wantFiles[p])} got ${JSON.stringify(out[p])}`);
    }
    if (problems.length === 0) passed += 1;
    else {
      failed += 1;
      failures.push(`${c.name}: ${problems.join('; ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const F = (s) => s; // file text, as written

// --- unified ---
runCase({
  name: 'u-nearest-second', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -99,3 +99,3 @@\n alpha\n-beta\n+beta2\n gamma\n',
  files: { 'x.txt': 'alpha\nbeta\ngamma\nalpha\nbeta\ngamma\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'alpha\nbeta\ngamma\nalpha\nbeta2\ngamma\n' } },
});
runCase({
  name: 'u-nearest-tie-earlier', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -2,3 +2,3 @@\n alpha\n-beta\n+beta2\n gamma\n',
  files: { 'x.txt': 'alpha\nbeta\ngamma\nalpha\nbeta\ngamma\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'alpha\nbeta2\ngamma\nalpha\nbeta\ngamma\n' } },
});
runCase({
  name: 'u-noeol-add-break', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -2,2 +2,2 @@\n beta\n-gamma\n+delta\n',
  files: { 'x.txt': 'alpha\nbeta\ngamma' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'alpha\nbeta\ndelta\n' } },
});
runCase({
  name: 'u-noeol-keep-no-break', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -2,2 +2,2 @@\n beta\n-gamma\n+delta\n\\ No newline at end of file\n',
  files: { 'x.txt': 'alpha\nbeta\ngamma' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'alpha\nbeta\ndelta' } },
});
runCase({
  name: 'u-backslash-after-old-only', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -1,3 +1,2 @@\n alpha\n-beta\n-gamma\n\\ No newline at end of file\n',
  files: { 'x.txt': 'alpha\nbeta\ngamma' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'alpha\n' } },
});
runCase({
  name: 'u-create-noeol', argv: ['-'],
  stdin: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n',
  files: {},
  expect: { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'one\ntwo' } },
});
runCase({
  name: 'u-bad-hunk-header', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -x +y @@\n a\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 3\n', changes: {} },
});
runCase({
  name: 'u-hunk-only-auto-format', argv: ['-'],
  stdin: '@@ -1,1 +1,1 @@\n-a\n+b\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: format\n', changes: {} },
});
runCase({
  name: 'u-hunk-before-section', argv: ['--format=unified', '-'],
  stdin: '@@ -1,1 +1,1 @@\n-a\n+b\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'u-lone-dashes-header', argv: ['-'],
  stdin: 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 3\n', changes: {} },
});
runCase({
  name: 'u-bad-diff-git', argv: ['-'],
  stdin: 'diff --git a/x.txt\n--- a/x.txt\n+++ b/x.txt\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'u-rename-only', argv: ['-'],
  stdin: 'diff --git a/old.txt b/new/deep.txt\nsimilarity index 100%\nrename from old.txt\nrename to new/deep.txt\n',
  files: { 'old.txt': 'keep\n' },
  expect: { exit: 0, stdout: 'R old.txt -> new/deep.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new/deep.txt': 'keep\n' } },
});
runCase({
  name: 'u-change-no-hunks', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'ok: 0 files\n', changes: {} },
});
runCase({
  name: 'u-delete-no-hunks', argv: ['-'],
  stdin: '--- a/x.txt\n+++ /dev/null\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'D x.txt\nok: 1 file\n', changes: { 'x.txt': null } },
});
runCase({
  name: 'u-create-no-hunks', argv: ['-'],
  stdin: '--- /dev/null\n+++ b/empty.txt\n',
  files: {},
  expect: { exit: 0, stdout: 'A empty.txt\nok: 1 file\n', changes: { 'empty.txt': '' } },
});
runCase({
  name: 'u-insert-at-end', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -99,0 +100,1 @@\n+tail\n',
  files: { 'x.txt': 'a\nb\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'a\nb\ntail\n' } },
});
runCase({
  name: 'u-drift-two-hunks', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,3 @@\n a\n+b1\n b\n@@ -3,1 +4,1 @@\n-c\n+C\n',
  files: { 'x.txt': 'a\nb\nc\nd\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'a\nb1\nb\nC\nd\n' } },
});
runCase({
  name: 'u-tab-in-header-path', argv: ['-'],
  stdin: '--- a/x.txt\t2026-01-01 00:00:00\n+++ b/x.txt\t2026-01-01 00:00:00\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'b\n' } },
});
runCase({
  name: 'u-crlf-noeol-add-break', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -2,1 +2,1 @@\n-beta\n+delta\n',
  files: { 'x.txt': 'alpha\r\nbeta' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'alpha\r\ndelta\r\n' } },
});
runCase({
  name: 'u-no-sections-forced', argv: ['--format=unified', '-'],
  stdin: 'just some prose\nno diff here\n',
  files: {},
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'u-empty-file-insert', argv: ['-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1,1 @@\n+first\n',
  files: { 'x.txt': '' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'first\n' } },
});

// --- SEARCH/REPLACE ---
runCase({
  name: 's-no-path-first', argv: ['-'],
  stdin: '```\n<<<<<<< SEARCH\n}\n=======\n} // x\n>>>>>>> REPLACE\n```\n',
  files: {},
  expect: { exit: 2, stdout: 'error: parse 2\n', changes: {} },
});
runCase({
  name: 's-inherit-path', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\nb\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'A\nB\n' } },
});
runCase({
  name: 's-no-sep', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 2\n', changes: {} },
});
runCase({
  name: 's-no-end', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n=======\nb\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 2\n', changes: {} },
});
runCase({
  name: 's-create-empty-new', argv: ['-'],
  stdin: 'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n',
  files: {},
  expect: { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': '' } },
});
runCase({
  name: 's-delete-whole-file', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\nb\n=======\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\nb\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': '' } },
});
runCase({
  name: 's-tier2-reindent', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\n  alpha\n  beta\n=======\n  ALPHA\n  new\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'function f() {\n    alpha\n    beta\n}\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'function f() {\n    ALPHA\n    new\n}\n' } },
});
runCase({
  name: 's-crlf', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\nbeta\n=======\nBETA\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'alpha\r\nbeta\r\ngamma\r\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'alpha\r\nBETA\r\ngamma\r\n' } },
});
runCase({
  name: 's-path-spaces', argv: ['-'],
  stdin: '   x.txt   \n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'A\n' } },
});
runCase({
  name: 's-marker-trailing-ws', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH   \na\n=======  \nA\n>>>>>>> REPLACE\t\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'A\n' } },
});

// --- V4A ---
runCase({
  name: 'v-no-end', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: x.txt\n a\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 4\n', changes: {} },
});
runCase({
  name: 'v-bad-first', argv: ['--format=v4a', '-'],
  stdin: 'hello\n*** Begin Patch\n*** End Patch\n',
  files: {},
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'v-bad-line', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: x.txt\n a\ngarbage line\n*** End Patch\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 4\n', changes: {} },
});
runCase({
  name: 'v-update-no-chunk', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: x.txt\n*** End Patch\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 2\n', changes: {} },
});
runCase({
  name: 'v-move-only', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n',
  files: { 'old.txt': 'keep\n' },
  expect: { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'keep\n' } },
});
runCase({
  name: 'v-add-trailing-blank', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Add File: n.txt\n+one\n+two\n\n\n*** End Patch\n',
  files: {},
  expect: { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'one\ntwo\n' } },
});
runCase({
  name: 'v-eof-nomatch', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: x.txt\n a\n-b\n+B\n*** End of File\n*** End Patch\n',
  files: { 'x.txt': 'a\nb\nc\n' },
  expect: { exit: 1, stdout: 'error: no-match x.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'v-anchor-tier2', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: x.txt\n@@   def f():\n   alpha\n-  beta\n+  BETA\n*** End Patch\n',
  files: { 'x.txt': 'def g():\n  x = 1\n\ndef f():\n    alpha\n    beta\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'def g():\n  x = 1\n\ndef f():\n    alpha\n    BETA\n' } },
});
runCase({
  name: 'v-cursor-advance', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: x.txt\n@@ one\n-a\n+A\n@@ two\n-b\n+B\n*** End Patch\n',
  files: { 'x.txt': 'one\na\ntwo\nb\none\na\ntwo\nb\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'one\nA\ntwo\nB\none\na\ntwo\nb\n' } },
});
runCase({
  name: 'v-add-empty-middle', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Add File: n.txt\n+one\n+\n+three\n*** End Patch\n',
  files: {},
  expect: { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'one\n\nthree\n' } },
});
runCase({
  name: 'v-unsafe-path', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Add File: ../evil.txt\n+x\n*** End Patch\n',
  files: {},
  expect: { exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'v-blank-between-sections', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Add File: a.txt\n+x\n\n\n*** Add File: b.txt\n+y\n*** End Patch\n',
  files: {},
  expect: { exit: 0, stdout: 'A a.txt\nA b.txt\nok: 2 files\n', changes: { 'a.txt': 'x\n', 'b.txt': 'y\n' } },
});
runCase({
  name: 'v-empty-patch', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** End Patch\n',
  files: {},
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'v-update-trailing-blank-chunk', argv: ['--format=v4a', '-'],
  stdin: '*** Begin Patch\n*** Update File: x.txt\n a\n-b\n+B\n\n\n*** End Patch\n',
  files: { 'x.txt': 'a\nb\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'a\nB\n' } },
});

// --- JSON ---
runCase({
  name: 'j-bad-command', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '{"command":"explode","path":"x.txt"}\n', 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'j-insert-neg', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '{"command":"insert","path":"x.txt","insert_line":-1,"new_str":"z"}\n', 'x.txt': 'a\n' },
  expect: { exit: 1, stdout: 'error: no-match x.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'j-insert-oob', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '{"command":"insert","path":"x.txt","insert_line":5,"new_str":"z"}\n', 'x.txt': 'a\n' },
  expect: { exit: 1, stdout: 'error: no-match x.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'j-array-multiline', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '[\n  {"command":"create","path":"n.txt","file_text":"hi\\n"},\n  {"command":"insert","path":"x.txt","insert_line":1,"new_str":"// note"}\n]\n', 'x.txt': 'a\nb\n' },
  expect: { exit: 0, stdout: 'A n.txt\nM x.txt\nok: 2 files\n', changes: { 'n.txt': 'hi\n', 'x.txt': 'a\n// note\nb\n' } },
});
runCase({
  name: 'j-array-bad', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '[\n  {"command":"create","path":"n.txt","file_text":"hi"},\n  {"command":"nope","path":"x.txt"}\n]\n', 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'j-str-overlap', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '{"command":"str_replace","path":"x.txt","old_str":"aa","new_str":"b"}\n', 'x.txt': 'aaa\n' },
  expect: { exit: 1, stdout: 'error: ambiguous x.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'j-create-noeol-bytes', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '{"command":"create","path":"n.txt","file_text":"no-newline"}\n' },
  expect: { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'no-newline' } },
});
runCase({
  name: 'j-empty-array', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '[]\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'j-blank-lines', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '\n{"command":"create","path":"n.txt","file_text":"x"}\n\n{"command":"insert","path":"n.txt","insert_line":1,"new_str":"y"}\n\n', 'n.txt': 'placeholder\n' },
  expect: { exit: 1, stdout: 'error: exists n.txt\nfailed: 1 of 2 edits\n', changes: {} },
});

// --- CLI ---
runCase({
  name: 'c-dup-option', argv: ['--check', '--check', '-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: usage\n', changes: {} },
});
runCase({
  name: 'c-bad-format', argv: ['--format=xml', '-'],
  stdin: '',
  files: {},
  expect: { exit: 2, stdout: 'error: usage\n', changes: {} },
});
runCase({
  name: 'c-two-positional', argv: ['a', 'b'],
  stdin: '',
  files: {},
  expect: { exit: 2, stdout: 'error: usage\n', changes: {} },
});
runCase({
  name: 'c-dashdash', argv: ['--', '--check'],
  stdin: '',
  files: {},
  expect: { exit: 2, stdout: 'error: no-patch\n', changes: {} },
});
runCase({
  name: 'c-unsafe-json-abs', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '{"command":"create","path":"/etc/x","file_text":"x"}\n' },
  expect: { exit: 1, stdout: 'error: unsafe /etc/x\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'c-unsafe-backslash', argv: ['p.json'],
  stdin: null,
  files: { 'p.json': '{"command":"create","path":"a\\\\b.txt","file_text":"x"}\n' },
  expect: { exit: 1, stdout: 'error: unsafe a\\b.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'c-unsafe-dotdot-sr', argv: ['-'],
  stdin: '../x.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  files: {},
  expect: { exit: 1, stdout: 'error: unsafe ../x.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'c-strict-tier1', argv: ['--strict', '-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n alpha  \n-beta\n+BETA\n',
  files: { 'x.txt': 'alpha\nbeta\n' },
  expect: { exit: 1, stdout: 'error: no-match x.txt\nfailed: 1 of 1 edits\n', changes: {} },
});
runCase({
  name: 'c-check-no-write', argv: ['--check', '-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: {} },
});
runCase({
  name: 'c-empty-stdin', argv: [],
  stdin: '',
  files: {},
  expect: { exit: 2, stdout: 'error: format\n', changes: {} },
});
runCase({
  name: 'c-format-json-flag', argv: ['--format=json', '-'],
  stdin: '--- a/x.txt\n+++ b/x.txt\n',
  files: {},
  expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
});
runCase({
  name: 'c-noop', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n=======\na\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'ok: 0 files\n', changes: {} },
});
runCase({
  name: 'c-multi-fail', argv: ['-'],
  stdin: 'nope1.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n\nnope2.txt\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  files: {},
  expect: { exit: 1, stdout: 'error: missing nope1.txt\nerror: missing nope2.txt\nfailed: 2 of 2 edits\n', changes: {} },
});
runCase({
  name: 'c-rollback', argv: ['-'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n\nnope.txt\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\nb\n' },
  expect: { exit: 1, stdout: 'error: missing nope.txt\nfailed: 1 of 2 edits\n', changes: {} },
});
runCase({
  name: 'c-option-after-positional', argv: ['-', '--check'],
  stdin: 'x.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  files: { 'x.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: {} },
});
runCase({
  name: 'c-move-then-edit', argv: ['-'],
  stdin: 'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'a.txt': 'a\n' },
  expect: { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', changes: { 'a.txt': null, 'b.txt': 'A\n' } },
});
runCase({
  name: 'c-utf8-sort', argv: ['-'],
  stdin: 'z.txt\n<<<<<<< SEARCH\nz\n=======\nZ\n>>>>>>> REPLACE\n\na.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  files: { 'z.txt': 'z\n', 'a.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M a.txt\nM z.txt\nok: 2 files\n', changes: { 'a.txt': 'A\n', 'z.txt': 'Z\n' } },
});

console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exitCode = 1;
}
