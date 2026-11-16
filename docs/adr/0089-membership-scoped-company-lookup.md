# ADR 0089 — A membership-scoped company and branch lookup, `GET /v1/me/companies`

**Status:** Proposed — a widening of the API's security surface, implemented ahead of the owner's approval on the fix branch of the 2026-11-15 full review, as earlier proposals were.
**Date:** 2026-11-15
**Deciders:** owner (pending)
**Branch:** `claude/fix-company-lookup` — not a slice; the number was allocated by the review's orchestrator. **Migrations:** none.
**Findings:** UI-03 (high) and UI-11 (medium), `docs/review/findings/frontend.md` on `claude/review-frontend`; ledger `docs/review/2026-11-15-full-review.md`.
**Contracts:** Plan Contracts §4.2.7 (module table row `/v1/me`) and §4.18 round 21, item R21 UI-03/UI-11.

## Context

The back office needs to know which company a signed-in operator works in before it can build any company-scoped URL. Since 0E it asked `GET /v1/companies` and took the first row. That route is the company administration route, gated `admin.company.manage`. The seeded `accountant` and `auditor` roles do not hold that code, and spec:2163 gives them exactly the screens that need the company: Tax returns, Reports (list, run, designer) and Data export. For them Tax returns stayed on "Loading…" for ever and the other screens said "The company could not be determined" (UI-03).

A report's `branch` parameter took its choices from `GET /v1/staff-context`, which answers only the seven staff-screen codes. A warehouse or report-only reader got 403 and could not pick a branch (UI-11).

Neither route can be widened without changing what it means: `/v1/companies` is administration and returns company settings, and `/v1/staff-context` is the staff screens' projection, defined by its seven codes.

## Decision

1. A new module `/v1/me` mounts **`GET /v1/me/companies`** behind `membershipOnly()`, with no permission code. It is a safe-method, read-only route, so `assertRouteGates` admits it as it admits `GET /v1/jobs/{jobId}`.
2. **What it returns:** `{ companies: [{ id, code, name, branches: [{ id, code, nameEn, nameAr }] }] }` (`MyCompaniesSchema`, strict). Nothing else: no base currency, timezone, settings, counts or roles.
3. **To whom, and what:** the caller's own tenant only (the transaction runs under the caller's tenant RLS). A company is listed when the caller holds at least one role assignment in it that has not expired, whatever that role's permissions. In each company the branches are the unarchived values of its `BRANCH` dimension that `app.actor_in_branch` admits: all of them for a company-wide assignment, and only the assignment's own branches otherwise. A member with no live role gets `{ companies: [] }`, not a refusal.
4. **Why it grants nothing:** it tells callers only where their own role assignments already place them. They could already reach those ids through any route their roles admit. It adds no permission code and widens no gate. Every screen opened with a company from it still asks its own permission at that company, and RLS and `branch_isolation` still bound every row. A branch-restricted principal sees only their own branches, which is the same set `branch_isolation` already lets them read.
5. The back office's `useCompanyId` reads it (still the first company, as before), and so does the report parameter form's `branch` lookup. `GET /v1/companies` and `/v1/staff-context` are unchanged.
6. No migration and no `SECURITY DEFINER` function. `app.company`, `app.dimension_type`, `app.dimension_value`, `app.role_assignment` and `app.role_assignment_branch` carry tenant RLS only, so the caller's own transaction can read them.

## Consequences

- The seeded `accountant` and `auditor` can open Tax returns, Reports and Data export.
- Any reader can pick a branch for a report among the branches their roles admit.
- A member of a tenant learns the ids, codes and names of the companies and branches they hold a role in. That is the whole disclosure, and it is about their own assignments.
- An operator with roles in several companies still lands in the first one by code. A company switcher is not part of this change.
- Like `markPermissionGate` and `membershipOnly()` before it, this is a widening of a Phase 0 security control and wants the owner's review as such.

## Owner questions

1. Is listing a company for a role with **no** permissions acceptable, or should the lookup require at least one permission code in that company?
2. Should a later company switcher use this route, or should the back office keep "the first company" for v1's single-company tenants?
