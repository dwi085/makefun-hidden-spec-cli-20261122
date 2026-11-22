# mend — one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` reads all four, finds the lines each edit names at the
first of three matching tiers (exact, trailing whitespace, full trim with
re-indentation), and writes every change or none, printing what it changed
or why it failed.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI
edit format" bounty.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Exit codes

- `0` — the tree is written; one line per changed path (`A`/`D`/`M`/`R`),
  then `ok: <n> files`.
- `1` — one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`; no file is written.
- `2` — one line only: `error: usage`, `error: no-patch`, `error: format`,
  or `error: parse <N>`.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept as it is; `main.ts` hands a
  trial over to it when `MAKEFUN_ENV_URL` is set.

## Practice checks

The kit's practice set (100 checks with the house reference's expected
results) passes 100/100. The kit's `check.ts` (from the kit starter) runs
it against `main.ts` beside it:

```sh
cp <kit>/starter/check.ts .
node check.ts <kit>/program/generator/practice.json
```
