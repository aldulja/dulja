# ADR 0088 — `AGENTS.md` is the single agent instruction file

**Status:** Accepted — the owner's decision, 2026-09-28. It touches no money semantics, security, data model or sync protocol, so spec:95 does not require it to be asked before it is implemented.
**Date:** 2026-09-28
**Deciders:** owner
**Branch:** `claude/friendly-einstein-t3k68n` — not a slice. **Number allocated from the §3.9 tail** under §3.4.1's proposed rule for a branch that is not a slice; the register row is in Plan Contracts §3.9, added in the same PR. **Migrations:** none.
**Supersedes:** in part, spec §5.2's root `CLAUDE.md` entry (v1.1 change 12). **Superseded by:** nothing.

## Context

Since Plan 0A the repository has carried two agent instruction files: `CLAUDE.md`, the entry point spec §5.2 names (v1.1 change 12, from `docs/review/2026-09-04-dulja-docs-review.md`), and `AGENTS.md`, which `CLAUDE.md` pointed at as canonical. Both carried a current-state record rewritten by hand at each phase exit, so every phase-closing slice had two copies to keep in step. By the end of Phase 3 they disagreed on the verified test figure and on whether seven cases were still red, and both had fallen behind the tree.

Claude Code reads `AGENTS.md` as project instructions when no `CLAUDE.md` is present (v2.1.277 or later). While a `CLAUDE.md` exists it reads that file instead, and reaches `AGENTS.md` only through an `@AGENTS.md` import.

## Decision

1. `CLAUDE.md` is deleted. `AGENTS.md` is the only agent instruction file and carries everything §5.2 asks of the entry point: the §0 reading order, pointers to `CONTRIBUTING.md` and `docs/spec/`, the never/always lists, and which phase is in progress.
2. `AGENTS.md` has a **"Current phase"** section, the name Plan Contracts §3.8 and every phase-closing plan already use, so their rewrite steps apply to it unchanged except for the file name. It holds only the phase's status; the records that outlive a phase (owner gates, ADRs awaiting the owner, known defects, the tree inventory) sit in a separate **"Current State"** section, and the standing rules in the sections below it, so a phase-closing rewrite deletes none of them.
3. Plan Contracts §3.8 is amended in place and recorded as §4.18 Round 6. The plans not yet executed (4A–9B) name `AGENTS.md` wherever they named `CLAUDE.md` (4A and 9A named neither), and `.github/pull_request_template.md` points at `AGENTS.md`.
4. The spec is not edited. Read §5.2's `CLAUDE.md` line as `AGENTS.md` under this ADR.

## Consequences

- A Claude Code older than v2.1.277 loads no project instructions in this repository.
- A `CLAUDE.md` added later would take precedence over `AGENTS.md` for Claude Code. If one is ever needed, it holds only an `@AGENTS.md` import and no content of its own, so there is still one copy.
- Historical records — `docs/reports/`, `docs/review/`, the executed plans and accepted ADRs — keep their `CLAUDE.md` references, because they describe what was true when they were written.
