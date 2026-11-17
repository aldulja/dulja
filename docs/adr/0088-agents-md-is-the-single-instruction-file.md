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

## Amendment — 2026-11-17: the standing records move to `docs/status/`, and a feature workflow is added

**Status:** implemented at the owner's direction of 2026-11-17 ("slim it down and also write the workflow"). The layout below is the implementer's choice of how to do that, for the owner to confirm or replace at merge. It touches no money semantics, security, data model or sync protocol. **Branch:** `claude/peaceful-gates-dwnalz` — not a slice; it takes no migration or ADR number.

**Why.** By Phase 9 `AGENTS.md` was about 90 KB, nearly all of it in "Current phase" and "Current State". Every agent session loads the whole file, so every session paid for ten phases of history to reach one page of rules.

**What changes in decision 2.**

1. `AGENTS.md` keeps both sections under their names — "Current phase" and "Current State" — so Plan Contracts §3.8's rewrite step, the pull-request template and the code comments that cite them still have their targets. Each now holds a short form: the phase table and the latest work; the open owner gates by id, and where to read the rest.
2. The full text of each phase's status is `docs/status/phase-history.md`, moved unchanged. A slice that closes a phase rewrites the short status in `AGENTS.md` **and** that phase's entry there.
3. The records that outlive a phase — owner gates, ADRs awaiting the owner and the widenings of security controls, known defects, the tree inventory — are `docs/status/current-state.md`, moved unchanged and split under headings. `AGENTS.md` declares that file part of "Current State" and as binding, and says which heading to read before which kind of work. Where a document or code comment says "`AGENTS.md`'s recorded defect" or "`AGENTS.md` 'In the tree'", read that file.
4. There is still one copy of everything: nothing in `docs/status/` is repeated in `AGENTS.md` beyond the short form.

**Also added.** `AGENTS.md` gains a "Feature Workflow" section: an orchestrator and four roles (spec, build, review, fix), each with a brief under `docs/agents/`. It generalises the 2026-11-15 full review's orchestrator, reviewer brief and fix brief. Its rules restate existing ones — owner approval before a build, ADR proposals, failing-first tests — and add three: the reviewer is never the builder, only the orchestrator edits the shared registers and `AGENTS.md`, and a small fix does not use the chain.

**Claude Code agent files.** `.claude/agents/{orchestrator,spec,build,review,fix}.md` register the five roles with Claude Code. Each holds a name, a description, tool limits for spec and review, and a pointer to its brief in `docs/agents/`; none holds instructions of its own, so decision 1's "one copy" stands. `.gitignore` now ignores `.claude/*` except `.claude/agents/`, so local settings stay untracked. This is not the `CLAUDE.md` decision 1 deleted, and it does not bring one back.

**Consequences.** An agent no longer has the known-defects list in its context by default; it must open `docs/status/current-state.md`, and `AGENTS.md` says when. `docs/status/current-state.md` was moved as it stood on 2026-11-16 and does not yet carry the 2026-11-15/16 review's additions (migrations `0124`–`0129`, ADRs `0089`–`0097`); its header says so and points at the review ledger.
