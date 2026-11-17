# Plan — <feature title>

**Feature folder:** `docs/features/<YYYY-MM-DD>-<slug>/`
**Written:** in the spec role, <date>, against `main` at `<sha>`
**Owner approval:** recorded in `approval.md` beside this file, in the orchestrator role only. No `approval.md`, no build.

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

- **Migrations:** <`NNNN_<verb>_<noun>.sql` + down, one line each — numbers are allocated in stage 4 — or "none">
- **Routes:** <method, path, permission code, Zod schema, idempotency, tenant-isolation test — or "none">
- **Permission codes, `ERRORS` rows, document types, jobs:** <or "none">
- **Exported names another workspace imports:** <or "none">
- **Proposed Plan Contracts amendments:** <section and text — or "none">

## 6. Tasks

One task is one thing that can be finished and verified on its own. Test first, always.

### T1 — <title>

- **Files:** <paths this task creates or changes, tests included>
- **Test first:** <the test, and why it fails before this task>
- **Then:** <what to implement>
- **Run:** `<the command that runs the test>`
- **Depends on:** <task numbers, or "none">

### T2 — …

## 7. Files the build may change

Globs, one per line. Stage 5's `verify` holds the build to them, so a file missing here sends the plan back to spec.

- `<glob>`

## 8. Definition of done

| # | Clause (something a test can prove) | Proving test |
| - | ----------------------------------- | ------------ |
| 1 | | |

## 9. What will not be verified

<Staging, Windows packaged execution, real data, real statutory rates — whatever applies, said now.>

## 10. Change log

| Date | Change | Why | Owner re-approval needed? |
| ---- | ------ | --- | ------------------------- |
