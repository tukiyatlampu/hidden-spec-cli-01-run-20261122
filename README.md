[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tukiyatlampu/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tukiyatlampu/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies AI-written edits in four formats — unified diffs (with wrong
line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a
tree of text files, exactly as `SPEC.md` (version 1) says. Every file is
changed or nothing is. Node 22, standard library only, no dependencies.

## Quick test

```sh
node tests/check.ts <path-to-practice.json>   # 100 public practice checks
node tests/edge.mjs                          # 71 hand-written edge cases
node tests/fuzz.mjs 400                      # 400 random + mutated patches
```

Practice score: **1000/1000** (100/100 checks, all three kit trials 100/100,
official scorer on the kit's env server: score 1000, working 1).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file; absent or `-` reads standard input.
- `--format=NAME`: `auto` (default), `unified`, `search-replace`, `v4a`, `json`.
- `--check`: same output and exit code, writes nothing.
- `--strict`: tier-0 (exact) line matching only.

Exit 0 prints one line per changed path (`A`/`D`/`M`, `R old -> new` for a
move) plus `ok: N files`. Exit 1 lists each failed edit plus
`failed: K of N edits` and writes nothing. Exit 2 is one line:
`error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.

## How it works

- **Matching (SPEC §5).** Old lines are found at the first of three tiers
  with an occurrence: 0 exact, 1 trailing spaces/tabs ignored, 2 leading
  and trailing spaces/tabs ignored. Unified hunks take the occurrence
  nearest the (wrong) header line number plus drift; SEARCH/REPLACE
  requires exactly one occurrence; V4A walks a cursor with anchors and an
  end-of-file form. At tier 2, added lines are re-indented from the file's
  own first matched line, and context lines are always written as the
  file's own lines.
- **Safety (§3, §10).** Every path is checked before anything else about
  it; unsafe, missing, existing, ambiguous, and no-match edits fail
  individually, later edits still run, and any failure writes nothing.
  CRLF files keep CRLF and their final line break, except where §6 moves
  it; created files are LF.
- **Formats (§6–§9).** Unified diffs (sections, renames, creates,
  deletes, moves, `\ No newline at end of file`), SEARCH/REPLACE blocks
  (path inheritance, fenced prose), V4A patches (Add/Delete/Update,
  `*** Move to:`, `@@` anchors, `*** End of File`), JSON arrays and
  JSON Lines (`create`, `str_replace`, `insert`).

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (unchanged); `main.ts` hands a trial
  over to it when `MAKEFUN_ENV_URL` is set.
- `SPEC.md` — the specification this implements.
- `tests/` — `check.ts` (kit practice runner), `edge.mjs`, `fuzz.mjs`.
- `TEST_RESULTS.md` — measured results.
