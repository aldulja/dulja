# ADR 0097 — Day-one administration routes, and who may call them

**Status:** Proposed — implemented ahead of the owner's approval, as the 2026-11-15 full review's fix sessions are directed to. It touches security (a grant made on the caller's behalf) and the data model's write paths, so it waits on the owner.
**Date:** 2026-11-16
**Branch:** `claude/fix-day-one-routes` — not a slice; a fix branch of the 2026-11-15 full review (`docs/review/2026-11-15-full-review.md` on `claude/busy-davinci-chg32p`). Number allocated by the review's orchestrator. **Migrations:** none. **Permission codes:** none added.
**Findings:** PRD-05, PRD-06, PRD-07, PRD-08 (`docs/review/findings/product-tests.md` on `claude/review-product-tests`).

## Context

Four things a new shop needs in its first weeks could only be done by an engineer: creating a fiscal year (`bun run seed --fiscal-year N`), administering a company created through the API (nobody held any code in it), editing or terminating an employee (no route wrote the employee after creation, and 0093's termination trigger could only be fired by direct SQL), and wiring payroll to its accounts (`bun run --cwd packages/db seed:payroll-accounts`). Screens for these remain OD-24-gated; this ADR gives each an API route the screens will call.

## Decision

1. **`POST /v1/companies/{companyId}/fiscal-years`** under `accounting.period.close`, the code that already governs the period lifecycle. Body `{ fiscalYear, startMonth? }`; omitted, the start month is the month the company's earliest period starts in, and a company with no period must send it (400). The rule is `createFiscalYear` (`packages/db/src/periods/fiscal-year.ts`), which the seed's `fiscal-periods` loader now also calls: twelve `open` monthly periods; a period whose exact bounds exist is kept as it is (a repeat answers 200 with `inserted: 0`); a period overlapping one with other bounds refuses the whole year with 409 `ERR_CONFLICT_UNIQUE` and writes nothing. The seed keeps its 0C behaviour of leaving an overlapping month out. Its own route module, because it is not a period sub-resource.
2. **`POST /v1/companies`** assigns the creator the tenant's `admin` role at the new company's scope, in the create's own transaction, with the tenant's **system principal** as the actor (`forbid_self_grant`, R5, refuses a self-grant), restoring the caller's actor straight after — the `bootstrapOwner` grant and the 0067/0093 actor swap. It widens nothing beyond the one company the caller just created under a gate that already admitted them to create companies. A tenant with no `admin` role (only a test fixture; the roles loader always seeds it) gets the company alone. **The rest of the seed's company bootstrap is not run by the route**: the chart, document types, templates, tax, reports and statutory packs and the BRANCH dimension are pack files the serving image deliberately does not ship (`infra/Dockerfile`), so they stay `bun run seed --tenant <id> --only …` until the owner decides which packs a new company gets (part of OD-21) and how they reach a serving process.
3. **`PATCH /v1/companies/{companyId}/employees/{employeeId}`** edits the non-sensitive master fields — `nameEn`/`nameAr` (on the employee's party), `hiredOn`, `position`, `employmentType` — and nothing else (`.strict()`): not the number (the party code and every import key), not the home branch (branch isolation and the EMPLOYEE dimension hang off it), not `terminatedOn`, and no sensitive or compensation field, which keep their gated sub-resources. **`POST …/employees/{employeeId}/terminate`** sets `terminated_on`, which is all a termination is: 0093's trigger (ADR 0078) expires the person's role assignments as the caller and revokes their till credentials, and `employee_no_self_pay` refuses a self-termination. A date before the hire date is 400; a later call with another date corrects the date only (the trigger fires on null → value). Reinstatement is not a verb here. Both under `hr.employee.manage`, asked at the path company by the directory gate and again at the employee's home branch, like the existing GET.
4. **`POST /v1/companies/{companyId}/payroll-accounts`** runs `linkPayrollAccounts` under `hr.pay_component.manage`, the code that already writes a component's accounts. Unlike the CLI it acts as the caller (a person asked, and the audit row says who), and a missing account code is 422 `ERR_POLICY_REQUIRES_MISSING` naming the codes, rolling the whole wiring back so a company is never half-linked. The payroll run's own missing-account message now names these routes instead of a seed file.
5. Every route is company-bound (the path company reaches every service call), idempotent on its unsafe method, in `openapi.json`, and covered by a tenant-isolation probe and a same-tenant other-company case (`apps/api/test/routes/day-one.test.ts`).

## Consequences

- A new company still needs an engineer for its packs until the owner answers decision 2's question.
- Any holder of `admin.company.manage` in one company can create a company and administer it. That was already the reach of creating it; the grant only makes the company usable. If the owner wants creation to be an owner-only act, the remedy is a narrower gate on `POST /v1/companies`, not removing the grant.
- `accounting.period.close` now also creates periods. A role that may close periods but should not open a new year would need a new code (a permission-seed migration).

## Owner questions

1. Which packs does a company created through the API get, and should the serving image carry them (OD-21; `infra/Dockerfile` excludes them today)?
2. Is `accounting.period.close` the right code for creating a year, or should it be `admin.company.manage`?
3. Should `PATCH …/employees/{id}` also move an employee's home branch (a transfer), and what happens to their branch-scoped roles and till credential when it does?
