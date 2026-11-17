# Plan — <feature title>

**Feature folder:** `docs/features/<YYYY-MM-DD>-<slug>/`
**Written by:** spec agent, <date>, against `main` at `<sha>`
**Owner approval:** recorded in `approval.md` beside this file, by the orchestrator only. No `approval.md`, no build.

## 1. The request

<The owner's request, verbatim.>

## 2. Scope

- **In:** <what this plan builds>
- **Out:** <what it does not, and why>
- **Assumptions about the tree:** <what the plan relies on, each checked against the code>

## 3. Read before building

| Document | Sections (with lines) | Why |
| -------- | --------------------- | --- |
| `docs/spec/rebuild-spec.md` | | |
| Plan Contracts | | |

## 4. Owner gates and decisions

| Item | What it blocks | What this plan does (wait / build the documented default) |
| ---- | -------------- | --------------------------------------------------------- |
| OD-## | | |

**ADR drafts** (money semantics, security, the data model, the sync protocol): <`adr/<slug>.md` each, or "none">

**Questions for the owner:** <numbered; each with the options and the recommended one — or "none">

## 5. Contracts

- **Migrations:** <`NNNN_<verb>_<noun>.sql` + down, one line each — numbers are the orchestrator's — or "none">
- **Routes:** <method, path, permission code, Zod schema, idempotency, tenant-isolation test — or "none">
- **Permission codes, `ERRORS` rows, document types, jobs:** <or "none">
- **Exported names another workspace imports:** <or "none">
- **Proposed Plan Contracts amendments:** <section and text — or "none">

## 6. Tasks

One task is one thing a builder can finish and verify. Test first, always.

### T1 — <title>

- **Files:** <paths this task creates or changes, tests included>
- **Test first:** <the test, and why it fails before this task>
- **Then:** <what to implement>
- **Run:** `<the command that runs the test>`
- **Depends on:** <task numbers, or "none">

### T2 — …

## 7. Parallel groups

| Group | Tasks | File globs | Can run beside |
| ----- | ----- | ---------- | -------------- |
| A | T1, T2 | `packages/db/**` | B |

## 8. Definition of done

| # | Clause (something a test can prove) | Proving test |
| - | ----------------------------------- | ------------ |
| 1 | | |

## 9. What will not be verified

<Staging, Windows packaged execution, real data, real statutory rates — whatever applies, said now.>

## 10. Change log

| Date | Change | Why | Owner re-approval needed? |
| ---- | ------ | --- | ------------------------- |
