# TEST_RESULTS.md

Real runs, not projections. Commands run from the package root unless noted.
Node v24.22.1 locally; the grader runs Node 26 (kit harness version).

## 1. Public practice set (kit `program/generator/practice.json`)

```sh
node tests/check.ts <kit>/program/generator/practice.json
```

Result: **100 of 100 passed: practice score 1000**

Per group: unified 30/30, search_replace 20/20, v4a 20/20, json 15/15,
cli 15/15. Starter baseline for comparison: 24/100 (score 240).

## 2. Kit trial instances (practice/trial-0, trial-1, trial-2)

```sh
node /tmp/hidden-spec-kit/trial-run.mjs <kit>
```

Result: **trial-0: 100 of 100; trial-1: 100 of 100; trial-2: 100 of 100.
TOTAL: 300 of 300 passed.**

## 3. End-to-end trial on the kit's own env server + official scorer

Started `program/env/server.mjs` with trial-0 `checks.json`, ran
`MAKEFUN_ENV_URL=http://127.0.0.1:18080 node main.ts`, then scored the
exported `state.json` with `program/scorer/score.mjs` against
`reference/expected.json`.

Result: **100 of 100 checks answered — score 1000, working 1, passed 100;
unified 30, search_replace 20, v4a 20, json 15, cli 15.**

## 4. Hand-written edge tests (`tests/edge.mjs`)

71 cases: wrong-line-number nearest/tie choice, `\ No newline at end of
file` (with and without, after old-only lines), create/delete/move with no
hunks, rename-only, two-hunk drift, tab-stamped header paths, CRLF files
with and without a final break, empty-file insert, SEARCH/REPLACE path
inheritance / missing markers / create-empty / whole-file delete /
tier-2 re-indent / trailing-whitespace markers, V4A missing `*** End Patch`,
bad first line, garbage line, update-with-no-chunk, move-only, trailing
blank lines, EOF-chunk no-match, tier-2 anchors, cursor advance, unsafe
paths, JSON bad commands / out-of-range inserts / multi-line arrays /
overlapping `str_replace` / empty array, usage errors, `--strict`,
`--check` (no writes), no-op, multi-failure reporting, rollback
(first edit succeeds, second fails, nothing written), UTF-8 sort order.

Result: **71 passed, 0 failed.**

## 5. Fuzzer (`tests/fuzz.mjs 400`)

400 iterations: random files (LF/CRLF, trailing whitespace, missing final
break) × random valid patches in all four formats (with drifted whitespace
and wrong line numbers), half of them mutated (line deleted/duplicated/
corrupted/truncated). Each case run twice; checked for exit code in
{0, 1, 2}, no crash trace on stderr, well-formed stdout for the exit code,
and byte-identical results across both runs.

Result: **400 ok, 0 bad of 400; exits 0: 226, 1: 109, 2: 65, other: 0.**

## 6. Zero-fail QA in a clean directory

Copied the package to a fresh directory (`/tmp/qa-clean`, no `node_modules`,
nothing installed — stdlib only) and re-ran the practice set, the edge
tests, and a one-file smoke run (`node main.ts smoke.diff` on a fresh
tree, exit 0, `M x.txt`, file updated).

Result: **practice 100/100, edge 71/71, smoke ok.**

## 7. Judge 2-pass (SolAPI)

Not run: SolAPI `POST /v1/responses` returned HTTP 503 on every attempt
(3 attempts across design + judge calls on 2026-11-22; `GET /v1/models`
still answers HTTP 200). No judge score is claimed. Substituted with a
structured self-critique: re-read `main.ts` against every SPEC.md sentence
(nearest-occurrence + drift, `\` line rules for change/create, V4A cursor
and EOF anchoring, blank-line handling per section, unsafe-path check
order, `R`-line output and write-back, JSON CRLF/overlap rules) and fixed
three test-expectation mistakes found while doing it (all three were wrong
expectations in `tests/edge.mjs`, not implementation bugs; the
implementation already matched SPEC.md in each case).
