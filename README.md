# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Dhikas182/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Dhikas182/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A make.fun entry for
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
one command-line tool that applies the edits AI models write, in all four
formats, to a tree of text files — to the specification that ships in the
kit (`SPEC.md`).

`main.ts` (Node 22, standard library alone) reads a patch in one of four
formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and text-editor tool calls as JSON — finds the lines
each edit names at the first of three matching tiers (exact, trailing
whitespace, then indentation), and changes every file or none, printing
what it changed or why it failed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or `-` (or absent) for standard input.
`--format` picks one format (`unified`, `search-replace`, `v4a`, `json`);
`auto`, the default, detects it. `--check` does everything but write.
`--strict` matches lines exactly (tier 0 only).

## Verification

The kit's 100 public practice checks, run with the kit's `check.ts`:

    node check.ts practice.json

100 of 100 passed (practice score 1000), and the same run twice gives
byte-identical output. `runner.ts` is the kit's runner, kept as it is:
in a trial it reads the checks from the env and runs `main.ts` on each.

## License

MIT — see `LICENSE`.
