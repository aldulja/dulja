# Payroll — the parallel run and the year-end outputs

This runbook is 8D's. Task 9 (⚠️ OD-23, the one-month parallel run and its written reconciliation) wrote the
sections down to "What is not allowed"; Task 6 wrote "Annual statements and the employer return".

The parallel run is the Phase 8 definition of done's first clause (spec, Part V): _the business's real monthly payroll
runs in Dulja in parallel with the legacy system for one month; every gross, statutory and net figure matches the legacy
run and the authorities' calculators to the cent, **or every difference is explained in writing and accepted by the
owner**_. The tool that makes the second half mechanical is `bun run payroll:reconcile`
(`scripts/payroll-reconcile.ts` over `reconcileParallelRun` / `renderReconciliation` in `packages/db/src/hr/reconcile.ts`).

**⚠️ OD-23 is open** (`docs/owner/od-23-employer-registrations.md`). Until the owner supplies the staff list, the legacy
month's payslip figures, the accountant-signed statutory tables and a written acceptance, the run is proved on the
`SYNTH` fixture corpus only:

```bash
bun run payroll:reconcile --self-test
```

prints `differences: 0 — clean to the cent`. It runs `packages/db/test/hr/reconcile.test.ts`'s "clean to the cent"
case, which posts a `SYNTH` run (`hrReportFixture`), derives the "legacy" figures from the run itself and reconciles
them. No real statutory figure enters the repository at any point (hazard 1).

## Before the month

1. **Load the accountant-signed tables** for every scheme the month uses:
   `APP_ENV=production bun run seed --tenant <id> --only statutory` (staging: `APP_ENV=staging`). The loader records
   the seed principal as `loaded_by`.
2. **Verify each table as a different principal** holding `hr.statutory_table.verify`:
   `POST /v1/companies/{companyId}/statutory-schemes/{schemeId}/rate-tables/{version}/verify`. The loader is refused
   with `ERR_HR_SELF_VERIFY` (spec:2080); a run never calculates under an unverified table.
3. **Confirm the pay-period and pay-date convention with the owner** in writing — the `periodStart`, `periodEnd` and
   `payDate` the run is created with, and the calendar year a pay date accumulates into (contracts round 18 B7).
4. **Agree the staff list**: every employee the legacy system pays that month exists in Dulja with the same
   `employee_number` — the reconciliation matches the two sides by that number and nothing else.

## During the month

1. Run payroll in Dulja on **the same inputs** as the legacy system: `POST /v1/companies/{companyId}/payroll-runs`
   (`hr.payroll.prepare`) for the period, then review it on the payroll run screen (`/hr/payroll-runs`).
2. **Prepare and approve as two different principals** (R1, spec:2175): the preparer submits through
   `POST /v1/companies/{companyId}/documents/{documentId}/transitions` with `{"to": "submitted"}`; a second principal
   holding `hr.payroll.approve` approves (`{"to": "approved"}`), and a holder of `hr.payroll.post` posts
   (`{"to": "posted"}`). The data layer refuses a
   self-approval; never work round it with a shared login.
3. A manual statutory override is entered on the draft with its reason
   (`POST …/payroll-runs/{documentId}/overrides`) and is listed on the approval screen; every override is a row the
   reconciliation will show if the legacy system did otherwise.

## After the run

1. **Export the legacy payslips** for the month as a CSV with a header row and one row per employee:

   ```text
   employee_number,gross,total_deductions,net,<scheme code>_employee,…
   ```

   One `<scheme code>_employee` column per scheme, named by the scheme's code in Dulja (`GET …/statutory-schemes`),
   holding the employee share the legacy system deducted; an empty cell means the legacy system did not compute that
   scheme for that employee. Amounts are plain decimals of at most four places (`1950.00`, never `1,950.00` or
   `RM 1950`); a cell may not hold a comma or a quote.
2. **Reconcile** against the POSTED run, as the tenant's system principal over `DATABASE_URL` (`app_rw`; the tool only
   reads):

   ```bash
   DATABASE_URL=<app_rw url> bun run payroll:reconcile --tenant "$TENANT_ID" --company "$COMPANY_ID" \
     --run "$PAYROLL_DOCUMENT_ID" --legacy ./legacy-2026-01.csv --out ./docs/reports/parallel-run-2026-01.md
   ```

   It prints `differences: 0 — clean to the cent` or `differences: N — see <out>` and exits **0** in both cases — a
   difference is a finding, not a failure. It exits **2** on a configuration or input error (a missing flag, an
   unknown tenant, a CSV it cannot read exactly, a run that is not a posted run of the company), naming the cause.
3. **Attach the Markdown report to the pull request** that records the parallel run. The report lists, sorted by
   employee number and field, every employee on one side only (`missing_in_dulja`, `missing_in_legacy`), every
   gross, deductions and net difference with its signed delta (`Dulja − legacy`, 4 dp), every scheme share that
   differs (`scheme`) and every scheme computed on one side only (`scheme_absent`). The Dulja figures are the
   payslips' own (`payslipRows`), so the report reconciles what the employees received on paper.

## The acceptance

The owner signs the report. Each difference the owner accepts gets one line under the report's **Accepted
differences** heading: the row, the reason, and the owner's initials — a row with no reason is not accepted. The
accountant's sign-off on the statutory tables the month used is recorded beside it. **The Phase 8 definition of done is
met by that signature, not by a zero.** A zero-difference report still needs the owner's signature.

## What is not allowed

- **Changing a Dulja figure to match the legacy one.** A difference is exactly one of: a **Dulja defect** — fix it
  with a failing test first, and re-run the month; a **legacy defect** — record it under Accepted differences; or a
  **rule difference** the accountant explains — record it, and if it is a rate-table fact, correct the table through
  the seed (a new version, verified by a different principal) and re-run.
- **Editing a posted line.** Correction after posting is a reversal plus a supplementary run (spec:2081, ADR 0076);
  the reconciliation is then re-run against the run that stands.
- **Committing the legacy export or real figures to the repository.** The CSV holds real pay; it is handed over
  outside the repository, and only the owner-signed report — which names employee numbers, not names — is attached.


## Annual statements and the employer return

The annual per-employee statement and the employer return are the same report code, `hr.annual_statement`, run through
7A's queued path, `POST /v1/companies/{companyId}/reports/hr.annual_statement/runs` (`reporting.render`; the run needs
`hr.payroll.read` and `accounting.report.export`):

- **one employee's statement** — `{"parameters": {"taxYear": "2026", "employeeId": "<employee id>"}, "format": "pdf", "lang": "en"}`;
- **the employer return** — the same body without `employeeId`; the report groups by employee, with each employee's
  scheme shares subtotalled and the year's shares totalled. `branchId` narrows either to one home branch.

`taxYear` is the calendar year of the runs' **pay date** (contracts round 18 B7, ADR 0077; a convention OD-23 confirms).
Gross and net are each employee's year-to-date figures: the posted deltas in `app.employee_ytd` **plus** the cut-over
opening in `app.employee_ytd_opening`, added at read time by the `employee_ytd` dataset exactly as `ytdFromEmployeeYtd`
adds them (contracts round 18 B14 — the opening is never merged into the projection). The per-scheme shares are the
projection's `by_scheme` bag plus the opening's, scheme by scheme. The definition (`definitionVersion` 2 since 9B; its
footer names the opening) keeps `tieOut: projection: employee_ytd`, executed by
`packages/db/test/reports/hr-definitions.test.ts` against the two tables read independently and added as `Money`; the
projection itself is compared against the posted lines by the nightly `hr.employee_ytd.rebuild` (test 35), which — like
the projection — never reads the opening.

**⚠️ OD-28 is not answered** (`docs/owner/od-28-form-names.md`). `formName` and `formYear` are free-text parameters
with no enumerated options, so unless a caller types one the rendered header carries the statement's own name and no
form identifier. Until the owner supplies the verified identifiers, **the statement is an internal document**: it
reconciles to `employee_ytd` and through it to the ledger, and it is not a filing. When the identifiers arrive, turn
`formName` in `packages/db/seed/my/reports/8d/hr.annual_statement.json` into an `enum` whose `options` are those
identifiers (bump the envelope's `definitionVersion`), re-run `APP_ENV=<staging|production> bun run seed --tenant <id> --only reports`, and record
the source and retrieval date in the pull request exactly as a statutory rate table records its `source` (§4.12.3).

**What the statement carries since 9B, and one thing it does not carry yet.**

1. **The cut-over opening — carried.** 9B's employee load (Task 8) writes `app.employee_ytd_opening` at cut-over,
   reconciled to each employee's own legacy payslips (gross and net only; no statutory shares — `by_scheme` is `{}`),
   and the `employee_ytd` dataset adds it to the projection at read time, so a company that switches mid-year prints
   the whole year: the legacy months from the opening, the Dulja months from the posted runs. An employee with an
   opening and no Dulja run that year is on the statement too. Two limits remain, and both stop the statement from
   being the year's whole truth: the opening carries **no per-scheme shares** (9B loads gross and net only — §5.1 #11's statutory
   shares are an unconfirmed column set, hazard 1 — so the legacy months' contributions are absent from the scheme
   columns), and
   the payroll **calculator** still reads posted lines (`ytdFromPostedLines`), so the first Dulja run's PCB does not see
   the opening (spec:2084's "computes PCB correctly" is unmet for a mid-year switch).
2. **The employer's registration numbers.** They live on `app.statutory_scheme.employer_registration` (OD-23) and are
   null until the owner supplies them; `missingEmployerRegistrations(tx, companyId)` names the gaps. The definition
   prints no registration box, so a missing number is never printed as an empty one. When OD-28 names a form that
   carries them, they become a column or a header parameter of the same definition — not a second report code.

Nothing in the repository states an authority's form name, deadline, channel or schema version. That is deliberate
(spec:2226, hazard 2), and a pull request that adds one without citing the authority's current publication is refused.
