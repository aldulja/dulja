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

**Also added: the feature workflow.** `AGENTS.md` gains a "Feature Workflow" section: five roles — orchestrator, spec, build, review, fix — worked **by one session, one role at a time**, each with one brief in `docs/agents/`. It generalises the 2026-11-15 full review's reviewer and fix briefs. Its rules restate existing ones — owner approval before a build, ADR proposals, failing-first tests — and add: eight stages each ended by a gate recorded in a ledger, one folder per feature, a three-round limit on review and fix, a wrong plan going back to spec, and no subagents.

**How it got to one session (all 2026-11-17, at the owner's direction).** The roles were first separate agents with briefs in `docs/agents/` and thin pointers in `.claude/agents/`; the owner asked for one copy, and the briefs moved into `.claude/agents/`; the owner then asked that the roles run in line and not as subagents, because subagents spend the usage limit — each one reloads `AGENTS.md` and re-reads the code, and a live subagent that made three tool calls cost about 30,000 tokens. So `.claude/agents/` is deleted, the briefs are plain documents in `docs/agents/` again, and nothing registers a role as a subagent. What this gives up is an independent review: the session that built the change reviews it. The review brief is written for that, the ledger records it, and for a feature that carries an ADR draft the session asks the owner whether a fresh session — started by the owner, never a subagent — should review instead.

**The role guard.** `scripts/agents/role-guard.ts` (tests beside it, run by the `tests` workspace) holds the session to the role it is in. `enter <role>` records where the tree stands and, like `leave`, refuses to move on while the role being left has changed a file it may not leave changed. A hook registered once in `.claude/settings.json` refuses the role's file tools a path outside its own, refuses a merge, a push to the default branch, the GitHub merge tools and the Agent tool, and tells the spec and review roles straight after a shell command that changed another file. `verify <role> --base <sha> [--allow <glob>]…` checks what changed since a commit and needs no hook. With no role in force the hook lets everything through. The role in force is `.claude/role-state.json`, ignored by git and bound to the session that entered it.

What live runs in a cloud session showed: hooks written in an agent's own frontmatter never ran there (Claude Code runs those only after a trust dialog a cloud or `-p` session never shows), and a refused stop did not keep a subagent from finishing — both reasons the guard is a settings hook plus `enter`/`leave`. In the final form, run in the session that wrote it: in the review role a Write to a product path was refused, the Agent tool was refused, a shell redirect that created a product file was reported straight after the command, `enter fix` was refused until that file was deleted, and `leave` then succeeded. Its limits: it holds a session to the role it says it is in and cannot stop it entering another, so it is a guardrail against a stage doing another stage's work, not a wall between two parties; a path rule cannot protect one section of a file, so Plan Contracts' two register tables stay a rule of the briefs; and the hook runs on each shell and file-edit call of every session in the repository, returning at once when no role is in force. `.gitignore` ignores `.claude/*` except `.claude/settings.json`.

**One folder per feature.** `docs/features/<YYYY-MM-DD>-<slug>/` holds a feature's ledger, the owner's approval, the plan, its ADR drafts and the review findings, so a new session can resume from it. Only the orchestrator role can write `approval.md`, and the build brief refuses a plan without one. An ADR draft takes its number, and moves to `docs/adr/`, only when it is allocated in Plan Contracts §3.9. The executed slice plans stay in `docs/superpowers/plans/`.

**Consequences.** An agent no longer has the known-defects list in its context by default; it must open `docs/status/current-state.md`, and `AGENTS.md` says when. `docs/status/current-state.md` was moved as it stood on 2026-11-16 and does not yet carry the 2026-11-15/16 review's additions (migrations `0124`–`0129`, ADRs `0089`–`0097`); its header says so and points at the review ledger.
