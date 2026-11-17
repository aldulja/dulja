# 8B → 8C (and 8D) — what payroll payment, the statutory schedules and the reports can rely on

Written at 8B's slice exit (Task 15, 2026-11-07). The running record of what each 8B task shipped, and every
deviation from the plan, is `docs/reports/phase-8-progress.md` (sections "8B T1–T4" to "8B T11–T15"); the
owner-question resolutions are `docs/review/2026-11-07-phase-8-decisions.md`. Contracts round 17 is 8B's amendment
register, and `scripts/check/contracts-8b-amendments.sh` is its gate.

**Tables and migrations.** `app.payroll_run` (1:1 with `document`, keyed `document_id`) and `app.payroll_line` (1:1
with `document_line`, keyed `document_line_id`) — 0087, with `payroll_line_change_draft_only` (the period lock on the
lines, `ERR_DOC_NOT_DRAFT`) and `payroll_line_override_check` (a reason and `entered_by`, or neither). The
`EMPLOYEE` dimension, created by trigger on `app.employee` — 0088 (`ensureEmployeeDimensionValue(tx, companyId,
employeeId)` repairs an employee that predates it). The four `hr.payroll.*` codes — 0089. R3 and the approver's
compensation-change lookup — **0090** (below). Migrations 0087–0090, all four used; ADRs 0074–0076, all
**Proposed**. Both tables are in `EXPORT_TABLES` gated on `hr.payroll.read`; `document_line` and `ledger_entry` export
ungated, so a PAYROLL's amounts leave with them — 8D's export/test-32 question.

**The run service** (`@dulja/db` main barrel, `packages/db/src/hr/`):

- `calculatePayrollRun(tx, ctx, CalculateRunInput)` → `PayrollRunResult` — writes `document`, `document_line`,
  `payroll_run`, `payroll_line` and **nothing else**; `postDocument` posts it through 2B's shared transitions route.
  The preparer must hold `hr.compensation.read` (8A's RESTRICTIVE `compensation_gate`), else `ERR_RBAC_FORBIDDEN`.
- `recalculatePayrollRun(tx, ctx, documentId, scope?)` — a draft is recalculated in place; a **submitted** run is
  first returned to draft (reason `recalculated`); an approved or later run is refused (`ERR_DOC_NOT_DRAFT`).
- `readPayrollRun(tx, documentId, scope?)` → `PayrollRunDetail` — lines (with `componentCode`/`schemeCode`), the
  run's `overrides` (with `enteredByName`) and `compensationChangedBy`. **8D's payroll register reads this.**
- `setStatutoryOverride(tx, ctx, SetOverrideInput, scope?)` and `listOverrides(tx, documentId, scope?)` — spec:2087's
  per-employee override, an input to an immediate recalculation of a DRAFT.
- `loadPayrollInputs(tx, LoadInputsOptions)` and **`ytdFromPostedLines(tx, companyId, year, employeeIds)`** — the
  one place year-to-date figures are read until 8C's `employee_ytd` lands; **when it does, exactly this call site
  changes** (`calculatePayrollRun` and `recalculatePayrollRun` call it through `loadPayrollInputs`).
- `PayrollRunError` (codes already in `ERRORS`); the calculator's `PayrollCalculationError` maps to
  `ERR_PAYROLL_RATE_TABLE_UNVERIFIED` / `ERR_PAYROLL_INPUT_MISSING` (422).
- `RunScope = { companyId? }`: a route that clears a path company passes it, so another company's run is 404.

**The API.** `payrollRunRouteModule` at `/v1/companies/:companyId/payroll-runs`: `POST /` (prepare), `GET /` and
`GET /{documentId}` (read), `POST /{documentId}/recalculate` and `POST /{documentId}/overrides` (prepare). There is
**no** payroll transition route — submit, approve and post are `POST …/documents/{documentId}/transitions`, where R1
and R2 are 2B's triggers reading the PAYROLL policy (`approval.required`, approve `hr.payroll.approve`, post
`hr.payroll.post`, create `hr.payroll.prepare`). One `PROBES` key. `/v1/staff-context` now lists a company to a
holder of `hr.payroll.read` (seven codes).

**The accounts, already seeded and wired** (`chart-of-accounts/8b-payroll.json`, `linkPayrollAccounts(tx,
companyId)`, `PAYROLL_ACCOUNT_CODES`): `1400` staff advances (`staffAdvances` — what `EMPLOYEE_ADVANCE` debits),
`2400` salaries payable (`salariesPayable` — what `PAYROLL_PAYMENT` clears; every run's net-pay line credits it
with BRANCH and EMPLOYEE), `2411`–`2414` statutory payable and `5311`–`5314` employer expense per scheme (EPF, SOCSO,
EIS, PCB), `5300` salaries expense. `linkPayrollAccountsForTenant` (seed barrel) **throws** for a company holding a
scheme §4.15 has no row for (e.g. a test `SYNTH`); `linkPayrollAccounts` returns it in `missingCodes` instead.
`PAYROLL` refuses reversal (ADR 0076): a posted run is corrected by a `supplementary` run.

**The ledger shape 8C's schedules tie to.** Per employee: each earning debits its component's expense account; each
deduction credits its component's account (an advance recovery credits `1400`); each scheme's employee share credits
the scheme's payable account; each employer share debits the scheme's employer-expense account and credits its
payable account; net pay credits `2400`. Every ledger line carries **BRANCH = the employee's home branch** (per line,
amendment A3) and **EMPLOYEE**. `payroll_line.amount` is a magnitude; `side` is the policy's. Every statutory line
pins `rate_table_id` / `rate_table_version`, and `payroll_run.pinned_tables` the run's set (LEGACY-013).

**R3 (migration 0090).** A compensation change (insert, update — old AND new window — or delete) effective inside a
`submitted` or `approved` run's period returns every such run the employee is on to draft, reason
`compensation_changed`; a posted run is never touched. **8C's termination flow writes `employee.terminated_on`, not
`compensation_line`, so it does not fire R3** — if a termination must bounce an open run, that is 8C's own trigger.
Recorded limit: the trigger runs with the writer's visibility (a branch-restricted writer may not see a run).

**The approver's lookup (0090) — a security widening, recorded.** `app.compensation_changes_in_period(company, from,
to)` is an `app_auth`-owned `SECURITY DEFINER` function returning `(principal_id, employee_id, effective_from)` only,
to a holder of `hr.payroll.read` or `hr.compensation.read`; `compensation_gate` is scoped to `app_rw, app_migrator`
so `app_auth` can read four non-amount columns. 8C/8D must not widen its column list.

**Test corpus** (`tests/invariants/support/payroll.ts`, contracts A7): `payrollFixture(db, s)` → `PayrollFixture`
(twelve open 2026 periods, the chart, PAYROLL, EPF on `SYNTH_TABLE`, BASIC and ADV_RECOVERY, E-0001 at `s.hq` and
E-0002 at `branchB`, each BASIC 2000.0000 from 2026-01-01, plus `approver` and `verifier` principals; `s.human`
gains `hr.compensation.read`). **Not idempotent** — one call per `Seed`; a regression block mints its own tenant.
`postPayrollRun(db, s, f, {…})` drafts, submits (as `s.human`, who must hold `hr.payroll.prepare`), approves and
posts (as `f.approver`). `secondApprover(db, s, codes)` mints a further principal. `seedPayrollRun` (fixtures.ts, A6)
gives a DRAFT run with zero-amount lines, never calculated. `JournalLine.dimensions` (A13) lets a hand-keyed journal
carry EMPLOYEE.

**Golden payroll** (`tests/golden/payroll.test.ts`, `tests/golden/payroll/<case>/{input,expected}.json`): three
SYNTH cases; regenerate only with `bun run --cwd tests golden:payroll` (`GOLDEN_WRITE=1`) and review every figure.
**OD-23's worked examples become cases here** (`<scheme>-worked-<n>/`) — 8D's parallel run consumes them too.

**The screens** (`docs/ui/od-24-phase-8b.md`): `/hr/payroll-runs` and `/hr/payroll-runs/$documentId?company=`
(`apps/backoffice/src/routes/hr/payroll-run{,s}.tsx`, `lib/payroll-api.ts`); `tests/e2e/payroll.spec.ts` and its
seeded corpus in `tests/e2e/support/boot.ts` (EPF, two submitted supplementary runs prepared by a second principal).
A payment screen (8C) links from a posted run.

**Acceptance tests owned and where they run.** 28 (`tests/invariants/payroll-one-posting-path.test.ts`), 29 and 38
and the PAYROLL re-runs of 9, 10 and 31 (`tests/invariants/payroll-pinning.test.ts`; the API leg of 29 and the wire
R1 case in `apps/api/test/routes/hr/payroll-runs.test.ts`), 33 (`tests/golden/payroll.test.ts`), 35's recalculation
clause (`packages/db/test/payroll/recalculation.test.ts`). Regression appends: legacy-003, 009, 011, 013, 019, 020, 031,
032, 042.

**What is still open.** OD-23 (accountant-signed tables and worked examples — `SYNTH` only), OD-28 (the proration
rule's confirmation: `calendar_days` default, `working_days` built), OD-14 (the four HR facts — none built), OD-24's
legacy keyboard parity for the payroll screens, ADRs 0074–0076 (Proposed), and the eighth security widening (0090)
for the owner's review. 8D closes Phase 8 and rewrites `AGENTS.md`'s "Current phase".
