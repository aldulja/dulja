# 8C → 8D — what the payroll reports, the payslips and Phase 8's exit can rely on

Written at 8C's slice exit (Task 15, 2026-11-07). The running record of what each 8C task shipped, and every
deviation from the plan, is `docs/reports/phase-8-progress.md` (sections "8C T1–T4" to "8C T11–T15"); the
owner-question resolutions are `docs/review/2026-11-07-phase-8-decisions.md`. Contracts round 18 (B1–B20) is 8C's
amendment register, and `scripts/check/contracts-8c-amendments.sh` is its gate.

**This slice's share of the Phase 8 definition of done (spec:2294), each executed against PostgreSQL 18:**

| Clause | Where it is proved |
| --- | --- |
| "Σ payslip net = salaries-payable credit" | acceptance test 30, `tests/invariants/payslip-ties-to-ledger.test.ts` (per employee against the EMPLOYEE-tagged `2400` credit; Σ against the run's movement and January's `account_balance`; a posted batch clears `2400` to zero) |
| "each scheme's schedule = its payable to the cent" | test 30 clause 3 (`total_employee + total_employer` = the scheme payable's credit movement), schedules generated from posted lines only (`packages/db/test/hr/schedule.test.ts`) |
| "a remittance for a different amount is refused" | test 30 clause 4 and `packages/db/test/hr/remittance.test.ts` — 0091's trigger, through the service and direct `app_rw` SQL |
| "`employee_ytd` rebuilds bit-identically" | acceptance test 35 and test 2's re-run, `tests/invariants/employee-ytd-rebuild.test.ts` (one `app.employee_ytd_delta` for the step-12 MERGE and the rebuild; text comparison, so a scale-only drift is caught) |
| test 34 "termination closes everything" | `tests/invariants/termination-closes-everything.test.ts` — server clauses, plus test 20's resume re-run; the till's PIN rejection is 6B's |

**Migrations.** `0091` (`app.statutory_schedule`, the remittance guard, `statutory_schedule_remittance_key`), `0092`
(`app.employee_ytd`, `app.employee_ytd_opening`, `app.employee_ytd_delta`, the four jsonb helpers/aggregates), `0093`
(`app.terminate_employee`, trigger `employee_terminated`), `0094` (`app.assert_cashier_is_employee`, constraint
triggers `pos_cashier_is_employee` and `employee_cashier_still_employed`, both `DEFERRABLE INITIALLY DEFERRED`),
`0095` (`hr.payroll.pay`, `hr.advance.create`), and the tail **`0121`** (`employee_ytd_drift` admitted to
`app.record_system_event`, §3.4.1 "8C overrun, Task 9"). All five of 0091–0095 are used. ADRs **0077** (employee_ytd
is a posting-service projection; one owner question — the tax-year convention) and **0078** (termination is a
trigger and cashiers are employees; three owner questions), both **Proposed**.

**The services** (`@dulja/db` main barrel, `packages/db/src/hr/` unless named):

- Money out: `createPayrollPayment`, `createEmployeeAdvance`, `readMoneyOut`, `listMoneyOut`, `advanceBalance`,
  `MoneyOutError`; `payrollBatchCsv` / `BATCH_CSV_HEADER`. A batch's `notes` is `payroll:<run id>`; it pays each
  employee's `credit − debit` on the run's net-pay lines and excludes anyone on a non-void batch of that run, a draft
  included.
- Schedules: `generateStatutorySchedule(tx, ctx, store, …)`, `readSchedule`, `listSchedules`, `scheduleCsv`,
  `SCHEDULE_CSV_HEADER`, `scheduleFileName`, `ScheduleError`; `settleStatutorySchedule` / `unsettleStatutorySchedule`,
  `RemittanceError`. **`StatutoryScheduleResult.employerRegistration`** (null until OD-23) and
  **`missingEmployerRegistrations(tx, companyId)`** — 8D's annual employer return names the missing scheme from it
  rather than printing an empty box. The generator needs `hr.compensation.read` (the scheme reference is behind 8A's
  `compensation_gate`).
- YTD: `mergeEmployeeYtd` (posting step 12, `packages/db/src/posting/ytd.ts`), **`ytdFromEmployeeYtd(tx, companyId,
  year, employeeIds)`** = projection + opening (round 18 B14) — **8D's annual statements read this**;
  `checkEmployeeYtdProjection` / `EMPLOYEE_YTD_CHECK`; `upsertEmployeeYtdOpening` / `listEmployeeYtdOpening` (9B's
  importer is the caller; no route). `ytdFromPostedLines` (8B) is still the calculator's per-component read — the
  projection carries no per-share keys (ADR 0077's consequence).
- Bank matching: **`PAYROLL_BATCH_SOURCE`** (`kind: "payroll_batch"`) is registered when `@dulja/db` is imported; the
  registry now has four kinds (`payment`, `payroll_batch`, `receipt`, `till_banking`).
- Not wired: `packages/db/src/hr/schedule-layouts/index.ts` (`layoutFor`, empty registry; OD-28) — internal.

**The API.** `payrollPaymentRouteModule` (`/v1/companies/:companyId/payroll-payments`), `employeeAdvanceRouteModule`
(`/employee-advances`, with `GET /balances/{employeeId}?asOf=`) and `statutoryScheduleRouteModule(store)`
(`/statutory-schedules`: generate, list, read, `GET …/{scheduleId}/csv` serving the archived attachment verified by its
sha256, and `POST …/{scheduleId}/settle`). Submit/approve/post go through 2B's `…/documents/{documentId}/transitions`
under `accounting.payment.approve` / `.post`. Three `PROBES` keys (each expects 403) and one `JOB_PROBES` key.

**The job.** `hr.employee_ytd.rebuild` (`apps/worker/src/jobs/employee-ytd-rebuild.ts`): compares, never repairs;
one `employee_ytd_drift` sentinel per drifted run through `app.record_system_event`.

**Termination (0093/0094).** Setting `terminated_on` (any path) expires every live assignment of the employee's
principal **and of each live credential's principal**, as the terminating actor (R4, `forbid_self_grant`,
`keep_last_admin_assignment` hold — terminating the last admin is refused), then revokes the credentials as the
tenant's **system principal**. At COMMIT, 0094 refuses any unrevoked credential whose employee is terminated, reading
as the system principal too. A reinstatement (`terminated_on → null`) restores nothing; the credential may then be
restored by hand. The last pay is a `final` run naming the employee (`loadPayrollInputs` admits a leaver on the run of
the period they left, and off the next regular one).

**Test corpus** (`tests/invariants/support/payroll-money.ts`, round 18 B3): `moneyOutFixture(db, s)` →
`MoneyOutFixture` (8B's fixture + January's posted run `payrollDocumentId`, `payer`, `authorityPartyId`,
`bankAccountId`) — **not idempotent**, one call per `Seed`; `postPayrollPayment`, `postEmployeeAdvance`,
`postRemittance`. SYNTH figures: BASIC 2000.0000, employee share 50.0000, employer share 100.0000, net 1950.0000 per
employee.

**For 8D's `AGENTS.md` rewrite** (8C does not touch "Current phase", Global Constraint 18):

- "In the tree": migrations `0091`–`0095` and `0121`; ADRs `0077`, `0078`; twenty-seven document types
  (`PAYROLL_PAYMENT`, `EMPLOYEE_ADVANCE` added); `scripts/check/contracts-8c-amendments.sh`; the shared helper
  `tests/invariants/support/payroll-money.ts`.
- ADRs awaiting the owner: 0077, 0078 (and 8B's 0074–0076, 8A's 0071–0073).
- Reviewed widenings: **0093's** credential revoke as the system principal and **0094's** check read as the system
  principal — both mirror the fifth, 0067's `refresh_pos_cashier` swap; and 8B's 0090 lookup (the eighth).
- Known limits: a posted `PAYROLL_PAYMENT` or `EMPLOYEE_ADVANCE` cannot be reversed (approval-required type, the
  existing sentence); `unsettleStatutorySchedule`'s reason is stored nowhere; one PAYMENT settles exactly one schedule;
  0094 does not constrain a credential's principal to the employee's login (ADR 0078 question 2); the remittance guard
  and the policies read account `1100` by code.

**What is still open.** OD-28 (schedule layouts — generic CSV; `docs/owner/statutory-layouts/README.md`), OD-14's
item 4 (staff purchases on salary deduction — not built; `docs/owner/od-14-hr-facts.md`), OD-23's two 8C clauses
(registrations null and named; `tax_year` = pay-date year; `docs/owner/od-23-employer-registrations.md`), ADRs 0077
and 0078, staging and the Windows packaged run. 8C ships no screen; a payment or schedule screen is OD-24 work for
whoever draws it (the 8B payroll run screen links to nothing of 8C's yet).
