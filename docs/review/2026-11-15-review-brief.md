# Full review 2026-11-15 — reviewer brief

The orchestrator's session message gives you five values: BRANCH, FILE, TITLE, PREFIX and your AREA. Substitute them below.

You are one of ten parallel reviewers in a whole-repository review of Dulja (repository aldulja/aldulja, branch `main`, head 6a8d239). An orchestrator session collects your results. You REVIEW ONLY: change no product code, open no pull request.

## Setup
1. `git fetch origin main && git checkout -B {BRANCH} origin/main`.
2. Read `AGENTS.md` in full. It is binding. Its "Current State" lists many KNOWN defects, owner gates (OD-##) and proposed ADRs. Do NOT report anything already listed there as a new finding. You may add a short "Triage of known items in my area" section saying, for each known defect in your area, whether it looks fixable now without an owner decision (and how) or truly needs the owner.
3. `bun install`. To run DB-backed tests, start Docker first: `(dockerd > /tmp/dockerd.log 2>&1 &)`, wait until `docker info` works. The test runtime is Vitest under Node (`bun run --cwd <workspace> test`, or `node node_modules/vitest/vitest.mjs run <file>` from the workspace). Never use `bun test`.

## Your area
Given in the message that started your session.

## How to review
- Read whole files in your area, not excerpts. Use your own subagents (Agent tool) to parallelise reading if useful.
- Do NOT run the `/code-review` or `/security-review` skills and do NOT use the Workflow tool (owner's instruction, 2026-11-15: token cost). Review by reading the code yourself; use plain Agent subagents only sparingly.
- A finding counts ONLY with all of: `file:line`; a concrete failure scenario (inputs/state → wrong result, crash, leak, or a user stuck); severity (blocker / high / medium / low). No style opinions, no "consider", no speculation.
- For every blocker or high finding, REPRODUCE it: write a throwaway failing test (or a script/psql session against a PostgreSQL 18 Testcontainer or `docker run postgres:18`) and paste the exact command and the failing output. If you cannot reproduce it, downgrade it or drop it. Delete throwaway tests from the tree before committing (paste their source into the findings file instead).
- Severity guide: blocker = wrong money, cross-tenant/cross-company data access, privilege escalation, data loss, or the product cannot be installed/used at all; high = a real user hits a wrong result or gets stuck on a core path, or a security control is bypassable under realistic conditions; medium = real defect with a narrow trigger or a workaround; low = minor.

## Output (exactly this)
Write `docs/review/findings/{FILE}.md`:

```
# Findings — {TITLE}
Reviewer session: <your session id if known>. Head reviewed: <sha>.
## Summary
<counts by severity; what you read; what you ran; what you could NOT check>
## Findings
### {PREFIX}-01 · <severity> · <one-line title>
- Evidence: `path:line` (and more)
- Scenario: <inputs → wrong result>
- Reproduction: <command + failing output, or "not reproduced (reason)"; for medium/low a reasoned trace is enough>
- Suggested fix: <one or two sentences; say if it touches money semantics, security, the data model or sync (needs an ADR) or needs an owner decision (name the OD)>
- Files a fix would touch: <list>
...
## Triage of known items in my area
...
```
Then commit only that file (`docs(review): {TITLE} findings`) with the trailers
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and push: `git push -u origin {BRANCH}`.
Your final message: the counts by severity and a one-line list of every blocker/high id with its title.
