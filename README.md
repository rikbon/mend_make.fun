# mend — Deterministic Multi-Format AI Patch CLI

[![make.fun](https://make.fun/b/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Verified entry](https://make.fun/b/hidden-spec-cli-01-run-20261122/entry.svg?repo=rikbon/mend_make.fun)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?entry=rikbon/mend_make.fun)
[![Score](https://make.fun/b/hidden-spec-cli-01-run-20261122/score.svg?repo=rikbon/mend_make.fun)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?entry=rikbon/mend_make.fun)

> **Entry for [make.fun — Build mend, one patch tool for every AI edit format (`hidden-spec-cli-01-run-20261122`)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)**

`mend` (`main.ts`) is a zero-dependency Node 22 command-line utility that detects, validates, parses, and atomically applies patches across the four dominant AI coding edit formats specified in [SPEC.md](./SPEC.md):

1. **Unified Diffs (`--format=unified`)** — `git diff` and bare unified headers, multi-hunk cumulative line offsets (`d`), nearest-position matching (`|pos - (A - 1 + d)|`), file creations (`new file mode` / `/dev/null`), deletions (`deleted file mode` / `/dev/null`), renames (`rename from` / `rename to` and `diff --git a/X b/Y`), EOF `\ No newline at end of file` handling, and automatic stripping of surrounding Markdown fences and conversational prose.
2. **SEARCH/REPLACE Blocks (`--format=search-replace`)** — Aider / Bolt / Cline `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks with nearest preceding file path discovery (ignoring blank lines and ```` ``` ```` fences), path inheritance across consecutive blocks, empty-`O` file creation, and uniqueness enforcement (`no-match` vs `ambiguous`).
3. **V4A Patches (`--format=v4a`)** — OpenAI `apply_patch` envelopes (`*** Begin Patch` ... `*** End Patch`) supporting `*** Add File:`, `*** Delete File:`, and `*** Update File:` with `*** Move to:`, advancing cursor semantics, 3-tier `@@ <anchor>` resolution, and `*** End of File` anchored chunks.
4. **JSON / JSONL Tool Calls (`--format=json`)** — Anthropic / SWE-agent `str_replace_editor` payloads (single object, JSON array, or JSONL stream, raw or wrapped in `{ "name": "str_replace_editor", "arguments" | "input": ... }`) supporting `create`, `str_replace`, and `insert` with automatic CRLF/LF normalization.

---

## Architecture & Spec Compliance

- **Strict Error Precedence (Exit Code `2`)**:
  1. `error: usage` — invalid flags, duplicate options (`--check`, `--strict`, `--format`), unknown `--format`, or multiple positional arguments.
  2. `error: no-patch` — missing or unreadable `PATCH` file path.
  3. `error: format` — `--format=auto` unable to classify input.
  4. `error: parse <N>` — 1-based line number syntax errors (or `error: parse 1` when zero edits are found), reported before inspecting any workspace file.
- **3-Tier Fuzzy Matching & Re-Indentation**:
  - **Tier 0**: Exact line equality (`--strict` restricts matching to Tier 0).
  - **Tier 1**: Equality after stripping trailing spaces and tabs (`[\t ]+$`).
  - **Tier 2**: Equality after stripping leading and trailing spaces and tabs (`^[\t ]+|[\t ]+$`), automatically re-indenting non-blank, non-context replacement lines whose leading whitespace starts with `O[0]`'s prefix `P` to match the file's matched prefix `F`.
  - **Context Preservation**: Matched context lines in Unified hunks and V4A chunks are always emitted verbatim from the target file.
- **Atomic In-Memory Execution & Canonical Status Output**:
  - All edits execute in memory against a virtual file map; if any edit fails (`missing`, `exists`, `no-match`, `ambiguous`, `unsafe`), zero files are touched on disk, each failed edit is printed in patch order (`error: <code> <path>`), followed by `failed: <k> of <n> edits` (exit `1`).
  - When all edits succeed, changed paths are reported in UTF-8 byte order (`A`, `D`, `M`, and `R <old> -> <new>` sorted by `<new>`), followed by `ok: <n> file[s]` (exit `0`).

---

## Usage

```bash
# Auto-detect format from a patch file or stdin
node main.ts patch.diff
node main.ts < changes.v4a

# Explicit format, dry-run check, and strict Tier-0 matching
node main.ts --format=search-replace --check --strict edits.txt

# Run the 100-check public practice suite (1000/1000 score)
node check.ts
```

## Verification & Testing

- **Public Practice Suite (`check.ts`)**: `100 of 100 passed: practice score 1000` across `unified` (30), `search_replace` (20), `v4a` (20), `json` (15), and `cli` (15).
- **End-to-End Trial Harness (`runner.ts`)**: Verified against the local `make.fun` trial environment server (`GET /checks` -> `POST /results`) and scorer (`score.mjs`) across practice trials `trial-0`, `trial-1`, and `trial-2`.

## License

Released under the [MIT License](./LICENSE) (`SPDX-License-Identifier: MIT`).
