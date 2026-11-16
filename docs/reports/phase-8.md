# Phase 8 implementation record — HR & Payroll (8A, 8B, 8C, 8D)

**Phase 8 is implemented on branch `claude/wonderful-volta-cuglc7` (2026-11-07/08) and has not exited.** It was built
under the owner's direction of 2026-11-07, "implement phase 8 entirely", and the owner's answer of the same day to
build the leave register (OD-13) and the HR screens (OD-24) on the plans' default baseline. This is a local
implementation record: every clause below says what was proved, by which test, and at what strength. It claims no
merge, no staging deployment, no Windows packaged run, no ADR acceptance and no real payroll. Phases 0–7 have not
exited either; Phase 8 was begun on unexited phases as Phases 4–7 were.

**The Phase 8 definition of done is not met.** Five of its six clauses are executed against PostgreSQL 18. The
first — the business's real monthly payroll run in parallel with the legacy system for one month, every difference
explained in writing and accepted by the owner — cannot be closed by CI: it needs the owner's staff list, the legacy
month's figures, accountant-signed rate tables and a signature (OD-23). The tool, its runbook and a self-test over
the synthetic corpus are built; the clause closes when the signed reconciliation is in `docs/reports/`.

Plans: `docs/superpowers/plans/2026-09-05-dulja-phase-8a-hr-master-sensitive-statutory-tables.md`, `…-phase-8b-payroll-engine-payroll-document.md`,
`…-phase-8c-payroll-money-out-ytd-termination.md` and `…-phase-8d-payroll-outputs-reports-parallel-run.md`.
Contracts: **round 16** (8A, A1–A22), **round 17** (8B, A1–A17), **round 18** (8C, B1–B20) and **round 19** (8D,
8D A1–A14, A13 items 1–22), each with an executable gate (`scripts/check/contracts-8a-amendments.sh` …
`contracts-8d-amendments.sh`, all four in CI's `checks` job). ADRs **0071–0080**, all _Proposed_, implemented ahead of
approval as 0054–0070 were. Migrations **0080–0098** (0099 allocated and left unused) and two tail numbers, **0120**
and **0121**, registered in §3.4.1 in the commits that took them. The task-by-task log — every exported name, every
deviation and every test count as each task landed — is `docs/reports/phase-8-progress.md`; the best-practice
resolution of each open question is `docs/review/2026-11-07-phase-8-decisions.md` (implementation authorization,
not acceptance); the slice handoffs are `docs/handoff/8a-to-8b.md`, `8b-to-8c.md` and `8c-to-8d.md`.

## What was built

| Slice | What | Where |
|---|---|---|
| **8A** — HR master, sensitive data, compensation, statutory tables (T0–T14) | `employee` extended (0080: position, employment type, statutory-profile note, `archived_at`; `app.forbid_self_pay`); `app.employee_sensitive` (0081) — nine fields sealed with AES-256-GCM under a versioned key ring, a RESTRICTIVE `sensitive_gate` on `hr.employee.read_sensitive`; `app.employee_statutory_profile` (0082) and `app.compensation_line`, `app.pay_component`, `app.pay_component_scheme` (0083), effective-dated and closed, never edited, behind a RESTRICTIVE `compensation_gate`; `app.statutory_scheme` and `app.statutory_rate_table` (0084) — versioned rate tables loaded by one principal and verified by another (trigger `statutory_rate_table_verifier`, `ERR_HR_SELF_VERIFY`); `app.company_hr_setting` (0085); six permission codes (0086); the rate-table JSON Schema and validator; the `statutory` seed sub-pack with empty real-scheme directories; the `hr.rate_table.lapse_warning` job (tail **0120** admits its system event); routes for sensitive data, statutory profiles, compensation, pay components, statutory schemes and HR settings; five screens | `packages/db/src/hr/{keys,sensitive,employee-sensitive,statutory-profile,compensation,statutory,settings}.ts`, `packages/domain/payroll/{rate-table.schema.json,validate.ts}`, `apps/api/src/routes/hr/`, `apps/worker/src/jobs/rate-table-lapse.ts`, `apps/backoffice/src/routes/hr/`; ADRs 0071–0073 |
| **8B** — the payroll run (T1–T15) | `app.payroll_run` and `app.payroll_line` (0087), the `EMPLOYEE` dimension by trigger (0088), four `hr.payroll.*` codes (0089), R3 — a compensation change returns a submitted or approved run to draft — and the bounded `app.compensation_changes_in_period` lookup (0090); the pure calculator (`payrollCalculator`, three scheme kinds, proration, every figure from a verified table, the table version pinned per line); `PAYROLL` with seven rules and the eleven payroll accounts (`8b-payroll.json`); `loadSnapshot`'s payroll slots; `calculatePayrollRun` / `recalculatePayrollRun` / `setStatutoryOverride`; the `payroll-runs` module; the golden payroll harness; the run register and approval screens | `packages/domain/payroll/`, `packages/db/src/hr/{run,inputs,override,accounts,employee-dimension,ytd}.ts`, `packages/db/src/posting/load.ts`, `apps/api/src/routes/hr/payroll-runs.ts`, `tests/golden/payroll/`; ADRs 0074–0076 |
| **8C** — money out, YTD, termination (T1–T15) | `app.statutory_schedule` and the remittance guard (0091), `app.employee_ytd` / `app.employee_ytd_opening` and their jsonb helpers (0092), posting step 12's `mergeEmployeeYtd`; `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` with `hr.payroll.pay` / `hr.advance.create` (0095); the batch and advance services and the bank-neutral CSV; statutory schedules generated from posted lines, archived as hashed attachments, settled by one exact remittance; the `hr.employee_ytd.rebuild` comparison job (tail **0121** admits its sentinel); termination as a trigger (0093) and "cashiers are employees" as deferred constraint triggers (0094); `PAYROLL_BATCH_SOURCE` in the `Reconcilable` registry | `packages/db/src/hr/{money-out,batch-csv,schedule,remittance,opening,reconcilable}.ts`, `packages/db/src/posting/ytd.ts`, `packages/db/src/integrity/employee-ytd.ts`, `apps/api/src/routes/hr/{payroll-payments,employee-advances,statutory-schedules}.ts`, `apps/worker/src/jobs/employee-ytd-rebuild.ts`; ADRs 0077–0078 |
| **8D** — outputs, reports, leave, key rotation, parallel run (T0–T11; T12 this record) | `hr.filing.generate` (0097); `employee.contract_ends_on` (0098); six HR datasets (`employee`, `attendance_event`, `payroll_line`, `employee_ytd`, `statutory_schedule`, `leave_record` — the registry closes at **34**); **eight** `hr.*` definitions in `packages/db/seed/my/reports/8d/` with executable tie-outs; the permit-expiry route; payslips rendered synchronously and stored one hashed attachment per employee; `hr.annual_statement` (the per-employee statement and the employer return, one code); the `hr.encryption_key.rotate` job and `HR_FIELD_ENCRYPTION_KEY_VERSION`; **the leave register** (0096, ⚠️ OD-13 answered build); `reconcileParallelRun` and `bun run payroll:reconcile`; the payslip, HR-report, permit and leave screens; `ReportCodeSchema` + 8 | `packages/db/src/reports/datasets/hr.ts`, `packages/db/src/hr/{payslip,permit-expiry,rotate,leave,reconcile}.ts`, `apps/api/src/{print/payslip.ts,routes/hr/{payslips,permit-expiry,leave}.ts}`, `apps/worker/src/{hr-keys.ts,jobs/hr-key-rotate.ts}`, `scripts/payroll-reconcile.ts`; ADRs 0079–0080 |

Across the phase: **15** permission codes (8A six, 8B four, 8C two, 8D three — `hr.filing.generate`, `hr.leave.record`,
`hr.leave.approve`); **6** `ERRORS` rows (`ERR_HR_SELF_PAY`, `ERR_HR_SELF_VERIFY`, `ERR_PAYROLL_RATE_TABLE_UNVERIFIED`,
`ERR_PAYROLL_INPUT_MISSING`, `ERR_PAYROLL_REMITTANCE_MISMATCH`, `ERR_HR_CASHIER_NOT_EMPLOYEE`); **3** document types
(`PAYROLL`, `PAYROLL_PAYMENT`, `EMPLOYEE_ADVANCE` — twenty-seven in the pack); **3** jobs
(`hr.rate_table.lapse_warning`, `hr.employee_ytd.rebuild`, `hr.encryption_key.rotate`); **8** new route modules, each
with a `PROBES` key (pay components, statutory schemes, HR settings, payroll runs, payroll payments, employee advances,
statutory schedules, leave records), plus sub-paths composed onto 6C's `employees` module (sensitive data, statutory
profiles, compensation, permit expiry) and onto 8B's `payroll-runs` (overrides, payslips). `ReportCodeSchema` holds
**40** codes — the 32 Phase 7 shipped and §4.16.1's eight `hr.*` — exactly the forty shipped seed files, pinned both
ways in `tests/invariants/report-catalogue-pins.test.ts`.

**No real statutory figure is anywhere in the tree** (hazard 1). Every payroll figure a test asserts comes from the
synthetic `SYNTH` table (`packages/db/seed/test/statutory/SYNTH/v1.json`); the real-scheme directories
(`packages/db/seed/my/statutory/{EPF,SOCSO,EIS,PCB}/`) are empty and `packages/db/test/payroll/synth-guard.test.ts`
and the sah-020 blocks fail on a rate in code.

## Phase 8's definition of done (spec:2294)

> _The business's real monthly payroll runs in Dulja **in parallel with the legacy system for one month**: every
> gross, statutory and net figure matches the legacy run and the authorities' calculators to the cent, or every
> difference is explained in writing and accepted by the owner; the run posts through the posting service under
> pinned policy and rate-table versions; Σ payslip net = salaries-payable credit; each scheme's schedule = its payable
> to the cent; preparer ≠ approver is enforced by the data layer; `employee_ytd` rebuilds bit-identically._

| Clause | Evidence | Strength |
|---|---|---|
| **One month in parallel with the legacy run; every figure matches to the cent, or every difference is explained and accepted by the owner** | 8D T9: `reconcileParallelRun` / `renderReconciliation` / `parseLegacyCsv` (`packages/db/src/hr/reconcile.ts`) and `bun run payroll:reconcile --tenant --company --run --legacy --out` (`scripts/payroll-reconcile.ts`); `docs/runbooks/payroll-parallel-run.md` (before, during and after the month, the acceptance, what is not allowed, the annual statements). `packages/db/test/hr/reconcile.test.ts` (13) proves the comparison, the refusals and the real CLI spawned against the Testcontainers database; `bun run payroll:reconcile --self-test` prints `differences: 0 — clean to the cent` over the SYNTH corpus. | **NOT MET.** The tool is executed; the clause is not. The staff list, the legacy month, the accountant-signed real rate tables, the authorities' calculators and the owner's written acceptance are all OD-23, and no real figure may enter the tree before them. A SYNTH self-test proves the tool, not the business's payroll. |
| **The run posts through the posting service under pinned policy and rate-table versions** | Test 28 `tests/invariants/payroll-one-posting-path.test.ts` (a PAYROLL and a hand-keyed JOURNAL with the same lines give identical `ledger_entry` and `ledger_entry_dimension` rows); test 29 in `tests/invariants/payroll-pinning.test.ts` (run M keeps its table after a later version lands; a supplementary run in M+1 pins the new one; an unverified or non-covering table refuses `ERR_PAYROLL_RATE_TABLE_UNVERIFIED`), with tests 38, 9 and 10 in the same file; `packages/db/test/payroll/{snapshot,run}.test.ts`; test 33's golden payroll `tests/golden/payroll.test.ts` (three reviewed cases). | **Executed, Testcontainers PostgreSQL 18**, over SYNTH. |
| **Σ payslip net = salaries-payable credit** | Test 30 `tests/invariants/payslip-ties-to-ledger.test.ts` (per employee against the EMPLOYEE-tagged `2400` credit; Σ against the run's movement and the period's `account_balance`; a posted batch clears `2400` to zero); `packages/db/test/hr/payslip.test.ts` (`payslipRows` per employee and in total, in SQL); `hr.payroll_register`'s `ledger_sum` tie-out on `2400` over `net_contribution` (`packages/db/test/reports/hr-definitions.test.ts`). | **Executed.** The register's measure re-derives net from the component and scheme lines (it scores the net-pay leg zero), so the tie-out compares two paths, not the posting with itself. |
| **Each scheme's schedule = its payable to the cent** | Test 30 clause 3 (`total_employee + total_employer` = the scheme payable's credit movement) and clause 4 (a remittance one cent over is refused by 0091's guard through the service and by direct `app_rw` SQL); `packages/db/test/hr/{schedule,remittance}.test.ts`; `hr.payable_reconciliation`'s per-scheme `ledger_sum` against that scheme's own `241n` (`hr-definitions.test.ts`). | **Executed.** The `statutory_schedule` projection arm beside it proves only that the definition reads the stored rows; the ledger proof is the `ledger_sum`. |
| **Preparer ≠ approver is enforced by the data layer** | Test 31 in `tests/invariants/payroll-pinning.test.ts` (PAYROLL, through the service, a job's system principal and direct `app_rw` SQL) and `tests/invariants/money-out-sod.test.ts` (`PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` on all three paths, with test 10); R4 (a principal cannot approve their own compensation, sensitive data or leave) in `packages/db/test/hr/{sensitive,compensation,leave}.test.ts` and `apps/api/test/routes/hr/leave.test.ts`, including a branch-restricted approver; a rate table is verified only by a principal other than its loader in `packages/db/test/hr/statutory.test.ts` and test 35. | **Executed**, on the triggers and policies, not on route checks. |
| **`employee_ytd` rebuilds bit-identically** | Test 35 and test 2's re-run, `tests/invariants/employee-ytd-rebuild.test.ts` (one `app.employee_ytd_delta` for posting step 12's MERGE and for the rebuild; compared as text, so a scale-only drift is caught); `apps/worker/test/jobs/employee-ytd-rebuild.test.ts`; the `employee_ytd` projection arm re-reads it through the `employee_ytd` dataset. | **Executed.** The nightly job compares and writes one drift sentinel; it never repairs. |

### The scope sentence

| Scope item (spec:2294) | Evidence | Strength and limits |
|---|---|---|
| Employee master and sensitive data | 8A T1–T4; `packages/db/test/hr/{employee-extend,sensitive}.test.ts`, `apps/api/test/routes/hr/sensitive.test.ts`; test 32 `tests/invariants/hr-sensitive-side-channels.test.ts` (API, OpenAPI, export and the permit list) and sah-033's 8A and 8D blocks | Executed. The key ring rotates (8D T7, ADR 0080); the deployed key and its version are OD-20's to bind. |
| Effective-dated compensation and pay components | 8A T5–T7; `packages/db/test/hr/{statutory-profile,compensation}.test.ts`; ADR 0072 (closed, never edited) | Executed. A mid-period raise is paid at the line in force at period end (below). |
| Statutory schemes as versioned, verified rate tables | 8A T8–T10; `packages/db/test/hr/{statutory,statutory-loader}.test.ts`, `packages/domain/test/payroll/`; ADR 0073 | Executed **over SYNTH only**. No real scheme table exists; the real directories are empty (OD-23, hazard 1). |
| PAYROLL / PAYROLL_PAYMENT / EMPLOYEE_ADVANCE and statutory remittances | 8B T4, 8C T5–T8; `packages/db/test/hr/{money-out-types,money-out,remittance}.test.ts`, the three route tests | Executed. A posted batch or advance cannot be reversed (an approval-required type, the recorded `reverseDocument` limit). |
| Payslips and monthly schedules | 8D T5 (`apps/api/test/routes/hr/payslips.test.ts`: one hashed attachment per employee, tests 33 and 23 at the rendered-text layer through `pdfText`); 8C T7 (`schedule.test.ts`, the archived CSV served by its hash) | Executed with this container's Chromium. Schedules are a generic CSV until the authorities' layouts are supplied (OD-28). |
| `employee_ytd` projection | 8C T2–T3, T9 | Executed (above). The cut-over opening is a read-time addend no row yet carries (9B). |
| A minimal leave register ⚠️ | 8D T8, **OD-13 answered build** on 2026-11-07: `leave_type`, `leave_entitlement`, `leave_record` (approved by a different principal; a decided record is final), `public_holiday` (0096); `packages/db/test/hr/leave.test.ts`, `apps/api/test/routes/hr/leave.test.ts`, `tests/e2e/leave.spec.ts` | Executed. No accrual engine (spec:2085) and no payroll input: unpaid leave is still a compensation quantity, and the register feeds no figure. |
| Attendance events | 6C's table; 8D's `attendance_event` dataset and `hr.attendance` (`tieOut: none`, never a pay input — spec:2089) | Executed as a report. |
| Termination flow | 8C T10–T11; test 34 `tests/invariants/termination-closes-everything.test.ts` (with test 20's resume re-run), `packages/db/test/hr/{termination,cashier-is-employee}.test.ts` | Executed server-side; the till's PIN rejection is 6B's. A reinstatement restores nothing. |
| Five HR reports (spec:2091) | `hr.employee_list`, `hr.payroll_register`, `hr.statutory_summary`, `hr.payable_reconciliation`, `hr.contract_expiry` — and `hr.attendance`, `hr.payslip`, `hr.annual_statement` — in `packages/db/test/reports/hr-definitions.test.ts` (each definition run over the payroll corpus, every declared `tieOut` executed: two `ledger_sum`, two `projection`, four `none` with a row witness) | Executed. `hr.contract_expiry`'s permit half is a gated route, not a report column (8D A3). |

## Acceptance tests owned and re-run

| Test | File(s) | Slice |
|---|---|---|
| **28** one payroll posting path | `tests/invariants/payroll-one-posting-path.test.ts` | 8B |
| **29** rate-table pinning; **38** payroll period lock; **9** period lock; **10** approval authority; **31** SoD (PAYROLL) | `tests/invariants/payroll-pinning.test.ts` | 8B |
| **30** payslip ties to the ledger | `tests/invariants/payslip-ties-to-ledger.test.ts`; `hr.payroll_register` / `hr.payable_reconciliation` tie-outs | 8C, 8D |
| **31** SoD (money out), **10**, **39** (payroll batch) | `tests/invariants/money-out-sod.test.ts` | 8C |
| **31** the leave clause (R4) | `packages/db/test/hr/leave.test.ts`, `apps/api/test/routes/hr/leave.test.ts` | 8D |
| **32** no sensitive side channel | `tests/invariants/hr-sensitive-side-channels.test.ts` (API, export, permit list); the report clause in `hr-definitions.test.ts` and sah-033's 8D block | 8A, 8D |
| **33** golden payroll | `tests/golden/payroll.test.ts` (`GOLDEN_WRITE=1` only, reviewed figure by figure); payslips identical at the text layer in `payslips.test.ts` | 8B, 8D |
| **34** termination closes everything (**20** re-run) | `tests/invariants/termination-closes-everything.test.ts` | 8C |
| **35** YTD rebuild and recalculation (**2** re-run) | `tests/invariants/employee-ytd-rebuild.test.ts`; `packages/db/test/payroll/recalculation.test.ts` | 8B, 8C |
| **23** RTL/LTR parity | `payslips.test.ts` (the PDF); `apps/backoffice/test/{hr,payroll,hr-8d}.test.tsx`; `tests/e2e/{hr,payroll,payslips,leave}.spec.ts` (each in EN/LTR and AR/RTL); sah-085's 8D block | 8A, 8B, 8D |
| **12 / 13** isolation and audit | `tests/invariants/tenant-isolation.test.ts` (eight new `PROBES` keys), `job-isolation.test.ts` (three new `JOB_PROBES`), `audit-chain` | all |

Regression blocks appended (no SAH file created; `tests/regression/` still holds 83): **8A** sah-029, 030, 033, 044, 045,
078; **8B** sah-003, 009, 011, 013, 019, 020, 031, 032, 042; **8C** sah-004, 011, 016, 019, 021, 044; **8D** sah-011
(the payslip and reconciliation output), sah-020 (no rate in an 8D source or definition), sah-033 (the report side of
test 32) and sah-085 (the payslip in both directions).

## Migrations and ADRs

| Number | What | Slice |
|---|---|---|
| 0080 | `alter_employee_extend` — four columns, `app.forbid_self_pay` | 8A |
| 0081 | `create_employee_sensitive` — `sensitive_gate`, `app.stamp_actor_always` | 8A |
| 0082 | `create_employee_statutory_profile` — `compensation_gate` | 8A |
| 0083 | `create_pay_component_compensation` | 8A |
| 0084 | `create_statutory_scheme_rate_table` — the verifier trigger, the same-company join | 8A |
| 0085 | `create_company_hr_settings` | 8A |
| 0086 | `seed_permission_phase8a` | 8A |
| 0087 | `create_payroll_run_line` | 8B |
| 0088 | `create_employee_dimension` | 8B |
| 0089 | `seed_permission_phase8b` | 8B |
| 0090 | `create_compensation_change_returns_run` — R3 and `app.compensation_changes_in_period` | 8B |
| 0091 | `create_statutory_schedule_and_remittance_guard` (+ `statutory_schedule_remittance_key`, amended in place) | 8C |
| 0092 | `create_employee_ytd` | 8C |
| 0093 | `create_termination_trigger` | 8C |
| 0094 | `create_cashier_is_employee_constraint` | 8C |
| 0095 | `seed_permission_phase8c` | 8C |
| 0096 | `create_leave_register` (+ the two `hr.leave.*` rows) | 8D |
| 0097 | `seed_permission_phase8d` | 8D |
| 0098 | `add_employee_contract_end` | 8D |
| 0099 | **allocated and unused** (§3.4.1: unused numbers stay unused) | 8D |
| **0120** | `admit_rate_table_lapse_warning_system_event` — tail, "8A overrun" | 8A |
| **0121** | `admit_employee_ytd_drift_system_event` — tail, "8C overrun" | 8C |

The two tail numbers exist because `app.record_system_event` (0105, re-created by 0111) is the only door to
`app.audit_log` for `app_rw`, and Phase 8's own range sorts before it. Every migration has a handwritten down and
passes up → down → up (`packages/db/test/migrations.test.ts`).

ADRs, all **Proposed** (spec:95 — each touches money, security or the data model): **0071** the HR field-encryption
envelope · **0072** effective-dated HR rows are closed, not edited · **0073** statutory tables are seed-pack data with a
break-glass door · **0074** the payroll calculator seam and rate-table pinning · **0075** the employee dimension is
created by trigger · **0076** a payroll correction is a supplementary run · **0077** `employee_ytd` is a
posting-service projection · **0078** termination is a trigger and cashiers are employees · **0079** payslips are
attachments rendered synchronously · **0080** the HR key-rotation procedure. Each owner question each one asks is
listed in the ADR; the decisions record resolves each as implementation authorization.

## Deviations from the plans

Every one is recorded where it was made: contracts round 16's A21–A22, round 17's A17, round 18's B16–B20 and round
19's A13 items 1–22 list each place a plan was stale against the tree, and `docs/reports/phase-8-progress.md` lists each
task's own. The ones a reader most needs:

- **Every HR sub-resource binds the employee to the PATH company** (`requireEmployeeInCompany`, one 404): RLS bounds
  the tenant only and the HR gates ask the code at the employee's company.
- **Test actors hold a live role in the company:** 6C's Form A′ `branch_isolation` on `employee` hides every employee
  from a principal with none, so a gate's refusal is proved with a company member holding an empty role.
- **The preparer must hold `hr.compensation.read`** (the RESTRICTIVE gate would otherwise hide every compensation
  line and a run would compute nothing); a schedule generator too (the scheme reference is behind the same gate).
- **A manual override is an input to an immediate recalculation**, not an UPDATE of the line (`entered_by` is a
  write-once stamp). R3 evaluates both the OLD and the NEW window of a compensation write.
- **Intermediate arithmetic uses `@dulja/domain`'s `D`** (precision 40), not the global `Decimal`; a scheme
  calculator refuses a definition whose shape does not match its kind; every `required_profile_fields` entry is
  enforced in all three kinds.
- **Both system-event writers go through `app.record_system_event`** (tails 0120, 0121); the YTD rebuild is a CTE,
  never a temporary table (no DDL from application code), and compares as text.
- **0093 and 0094 read and revoke as the tenant's system principal**, restoring the caller's actor (below).
- **`taxYear` is spelled `year`** in every payload and service parameter (`no-number-money` reads `tax`; the plans'
  constraint forbids an allow-list entry); the tax year is the calendar year of `pay_date` (ADR 0077).
- **No `companyId` parameter** on any 8D definition (`assertParameters` would demand one a run ignores);
  `LEDGER_MEASURE` maps `net_contribution` / `payable_contribution` to `credit_net`, not A10's `credit`, so a
  negative-net supplementary run still ties; report widths are pixels.
- **A decided leave record is final** (`app.guard_leave_record`, `ERR_TABLE_IMMUTABLE`) and the record and entitlement
  tables carry a RESTRICTIVE `employee_parent_visibility`, without which a branch-restricted principal could approve
  their own leave (reproduced against PostgreSQL 18 before the fix).
- **`hr.annual_statement`'s `formName` is a `text` parameter**, not an `enum` with no options, which 7A's schema
  refuses; the owner's verified identifiers make it an enum in one seed edit (OD-28).
- **The screens were built** (OD-24 answered build), where every Phase 8 plan defaulted to a blocked screen task; they
  follow the tree's layout (`apps/backoffice/src/routes/hr/`), and the HR reports reuse 7A's list and run screen.
- **The `ReportCodeSchema` case lives in `tests/invariants/report-catalogue-pins.test.ts`**, not in `packages/db`
  (which may not import `@dulja/contracts`); its Phase 7 total of thirty-two moved to forty.

## Defects found and fixed during the phase

- **The runtime image could not load the payroll code** (8D T7, `093cd34`): 8B's calculator is imported by
  `apps/api/src/problem.ts` and the payroll services, and `infra/Dockerfile` did not copy `packages/domain/payroll`;
  `infra/test/dockerfile.test.ts` had been red since 8B because no Phase 8 agent had run `infra`.
- **Pins a later slice moved**, each in the commit that moved the registry: the accountant's role catalogue
  (22 → 23 → 26), `DOCUMENT_STAGE_CODES`, the `openapi.json` path list, the `Reconcilable` registry (three → four
  kinds), `app.policy_extends_credit` (the two outbound money types), the branch-policy count (20 → 21 for
  `public_holiday`), 6C's pinned `pos_cashier` trigger list, the dataset registry (28 → 33 → 34), `projections.checked`
  in seven files, and the runbook seed-command check (`APP_ENV` named).

## Review pass (2026-11-08)

The final review-and-fix pass on Phase 8's diff (`6bbf287..`), under the owner's direction of 2026-11-07. Each fix has a
regression test that fails on the tree before it (each was run red first); decisions are rows of
`docs/review/2026-11-07-phase-8-decisions.md`, contracts the "Phase 8 review — amendments" section after Round 19.

| # | Finding | Fix | Proved by |
|---|---|---|---|
| 1 | **Test 32's export channel**: `document`, `document_line`, `ledger_entry`, `ledger_entry_dimension`, `document_link`, `allocation`, `bank_match`, `custom_field_value`, `document_event` and `attachment` exported every row, so a PAYROLL's per-employee pay and a PAYROLL_PAYMENT's per-employee nets (with names) left in the archive of a requester without `hr.payroll.read` | Row-level module gates: `MODULE_ROW_GATES` (`hr` → `hr.payroll.read`) bounds the ten document-keyed tables; the rows kept out are named in the manifest's new `excludedRows`, listed by the export screen in EN/AR; a pin fails on a future document-keyed table that is neither bounded nor hr-gated (ADR 0069's 8-review amendment; contracts R1). An `hr` document's attachment bytes were already kept out by ADR 0070's recorded modules | `tests/invariants/hr-sensitive-side-channels.test.ts` (test 32, payroll documents); `packages/db/test/export/tables.test.ts` (two pins); `apps/backoffice/test/routes/admin/exports.test.tsx` |
| 2 | **Earlier payslips unlisted for `hr_payroll`**: 2C's list gate asked `accounting.ledger.read` whatever the named document | The list gate asks the named document's `MODULE_READ_CODE` row at its branch (contracts R2); the payroll run screen lists the payslips already on the run, newest first, Enter downloads, refreshed after a generation | `apps/api/test/routes/hr/payslips.test.ts`; `apps/backoffice/test/hr-8d.test.tsx` (EN/AR); `tests/e2e/payslips.spec.ts` |
| 3 | **Test 32's endpoint channel**: `GET …/documents/{id}` was gated on the three accounting read codes alone, so the seeded `user` (`accounting.journal.create`) read a posted PAYROLL's lines and a PAYROLL_PAYMENT's per-employee nets | An `hr` document's read also asks `hr.payroll.read` at its branch, as its print and events do | `apps/api/test/routes/hr/payslips.test.ts` |
| 4 | **R1 bypass on the generic routes**: `POST …/documents` and `PUT …/documents/{id}/lines` resolve their gate from the type's policy, so the preparer could replace a draft run's calculated lines with hand-keyed ones carrying no `payroll_line` — invisible on the approval screen (read through `payroll_line`) and uncounted by `employee_ytd` — and a PAYROLL_PAYMENT or EMPLOYEE_ADVANCE could be drafted by hand around its service's rules | The three `hr` types join FX_REVALUATION in `refuseServiceOnlyType` | `apps/api/test/routes/hr/payslips.test.ts` |

**Reviewed and found sound:** the RESTRICTIVE `sensitive_gate`, `compensation_gate` (0082, 0083, and 0090's re-scoping to
`app_rw, app_migrator` with `app_auth`'s four non-amount columns), `employee_parent_visibility` and `branch_isolation` on
the leave tables, `guard_leave_record` with R4's trigger; 0090's `SECURITY DEFINER` lookup (tenant bound, three
columns, both codes asked in the supplied company); 0093's and 0094's system-principal swaps (restored on every path; a
failure aborts the transaction and the transaction-local setting with it); the company binding of every Phase 8 route
(each service call takes the path's `companyId`, or `requireEmployeeInCompany` / `requireScheme` first); step 12's
`employee_ytd` MERGE (one delta function shared with the rebuild, keys locked in order, no type branch); and the
payslip route's two gates (`hr.filing.generate` and the definition's read code, which 7A's `assertDatasetGate` holds at
`hr.payroll.read`). Two channels judged real but not fixable inside a review pass are recorded under "Known limits".

## Security-control widenings and tightenings for review

- **Review pass (2026-11-08):** the attachment list's company gate asks the **named document's module read code** at its
  branch (`hr.payroll.read` for a run; `inventory.stock.read`, `pos.report.read` for those modules' documents) instead
  of `accounting.ledger.read` — a widening for a module reader listing their own module's document and a tightening
  for a ledger reader naming another module's document; the company-wide list is unchanged. Tightenings: `GET
  …/documents/{id}` of an `hr` document also asks `hr.payroll.read`; the generic document routes refuse the three `hr`
  types as service-only; the tenant export bounds an `hr` document's rows by `hr.payroll.read` (`MODULE_ROW_GATES`).

- **0090 `app.compensation_changes_in_period(company, from, to)`** — an `app_auth`-owned `SECURITY DEFINER` lookup on
  the 0068/0119 pattern, returning three columns (`principal_id`, `employee_id`, `effective_from`; never an amount) to
  a holder of `hr.payroll.read` or `hr.compensation.read` in that company, so an approver sees who changed compensation
  in the period (spec:2174). `compensation_gate` is scoped `to app_rw, app_migrator` for it, and `app_auth` gains SELECT
  on four `compensation_line` columns and on `role_permission`.
- **0093 `app.terminate_employee()`** revokes the till credential as the **tenant's system principal**, restoring the
  terminating actor (the assignments expire first, under the actor, so R4 and `keep_last_admin_assignment` hold) —
  0067's `refresh_pos_cashier` swap applied to a revoke.
- **0094 `app.assert_cashier_is_employee()`** reads `pos_cashier` and `employee` as the system principal for its
  check (each table's RESTRICTIVE branch policy is on a different branch); it writes nothing.
- **`/v1/staff-context`** carries `hr.payroll.read` (8B T15; seven codes); it grants nothing.
- **Tightenings:** the RESTRICTIVE `sensitive_gate` and `compensation_gate`; `employee_parent_visibility` on
  `leave_entitlement` and `leave_record`; `app.guard_leave_record`; the rate-table verifier on INSERT as well as UPDATE;
  the same-company checks on `pay_component_scheme` and on a remittance.

## Owner gates and questions

- **OD-13** (the leave register) — **answered 2026-11-07: build**; built whole (8D T8, contracts round 19 A14). OD-05's
  8D row (spec:1060, "leave ⚠️") is discharged with it.
- **OD-24** (screens) — **answered 2026-11-07: build on the plans' default baseline.** Built: 8A T13's five HR screens,
  8B T15's run register and approval screen, 8D T10's payslip panel, HR-reports entry, permit list and leave register;
  each verified in EN/LTR and AR/RTL; **legacy keyboard parity unproven** (`docs/ui/od-24-phase-8a.md`,
  `od-24-phase-8b.md`, `od-24-phase-8d.md`). 8C ships no screen.
- **OD-23** — open. The owner's staff list, the legacy month, the accountant-signed rate tables, the employer
  registration numbers (null and named by `missingEmployerRegistrations`), the pay day, and the written acceptance of
  the parallel run (`docs/owner/od-23-employer-registrations.md`). The DoD's first clause waits on it.
- **OD-28** — open, built on defaults: the statutory-profile field list (`docs/owner/od-28-statutory-profile-fields.md`),
  the proration rule (`calendar_days` default, `working_days` selectable, holidays not subtracted;
  `od-28-proration-rule.md`), the schedule upload layouts (generic CSV; `docs/owner/statutory-layouts/README.md`) and the
  annual statement's form names (configuration; `od-28-form-names.md`).
- **OD-14** — open: none of the four HR facts (an employer levy, foreign workers, hourly staff, staff purchases on
  salary deduction) is built; `docs/owner/od-14-hr-facts.md` records each one's seam and cost. The 8D plan's open
  question (a) — the orchestrator's slice list named OD-14 among 8D's gates while §2.9 and §2.12 assign it to 8A/8B — is
  carried for the architect; no 8D task was written for it.
- **ADRs 0071–0080**, all Proposed; their owner questions are in each ADR and resolved for implementation in the
  decisions record.
- **Raises carried forward:** the annual statement's cut-over opening (9B's importer and the dataset); a key-rotation
  operator route (ADR 0080 question 2); and, from the review pass, the two report-and-file channels below (the ledger
  datasets and the archived schedule file). The export's ungated `document_line` / `ledger_entry` and the payslip list
  for `hr_payroll` were closed by the review pass.

## Known limits, recorded and not fixed

- **A mid-period raise is paid at the compensation line in force at period end** — no split of a period between two
  lines (8B T10's decision; the plan's form paid it twice).
- **R3 runs with the writer's visibility**: a compensation writer restricted to a branch other than the run's does not
  see, and so does not return, that run.
- **A recalculation re-creates an override line**, so `entered_by` then names the recalculating principal; the audit
  trail keeps the original. A manual override on a scheme the employee no longer feeds refuses the recalculation until
  it is cleared.
- **The calculator's per-component YTD still reads posted lines** (`ytdFromPostedLines`): the projection carries no
  per-share key (ADR 0077's consequence).
- **A posted `PAYROLL`, `PAYROLL_PAYMENT` or `EMPLOYEE_ADVANCE` cannot be reversed** — the existing
  approval-required-type limit; a payroll is corrected by a supplementary run (ADR 0076).
- **`unsettleStatutorySchedule`'s reason is stored nowhere** and has no route; **one PAYMENT settles exactly one
  schedule**; the remittance guard and the money-out policies read account `1100` by code.
- **0094 does not constrain a credential's principal to the employee's login** (ADR 0078 question 2); a reinstated
  employee's credential is restored by hand.
- **The annual statement carries no cut-over opening**: the dataset reads the projection only, so a company switching
  mid-year must not issue that year's statement from Dulja alone (the runbook says so).
- **`hr.payslip` through 7A's queued `POST …/reports/hr.payslip/runs`** prints the net-pay leg as a blank row (the
  dataset has no column to exclude it); the synchronous payslip route drops it. The total is the net either way.
- **7A's `DataGrid` takes focus from a button inside a cell**, so in-row Approve/Reject/Download are mouse-only; every
  8D screen gives a row-Enter keyboard path.
- **No route writes `employee.contract_ends_on`**; `hr.contract_expiry` reports what a migration or fixture set.
- **A principal holding only `hr.statutory_table.verify`** is in no staff-context company, so the statutory-tables
  screen shows them none; the seeded `accountant` also holds `hr.payroll.read` (8B), which puts their companies in the
  picker.
- **7A's ledger datasets serve an `hr` document's rows under the accounting codes** (review pass, not fixed): `document`,
  `document_line` and `ledger_entry` are gated on `accounting.report.read` / `accounting.ledger.read`, so a definition
  over them prints a PAYROLL's per-line amounts and a PAYROLL_PAYMENT's per-employee nets (its line descriptions name
  each employee) to a company-wide holder without `hr.payroll.read`. No seeded role is such a holder (the `accountant`
  and the `auditor` hold both codes); a tenant-made role holding either accounting code alone is. Closing it is a module row bound in
  `DATASET_ROW_BOUNDS` evaluated against the requester's codes at render time — the run executes as the system
  principal — which is an ADR 0065 change, recorded as an owner question rather than made in a review pass.
- **The archived statutory-schedule file is read under `hr.payroll.read`** (review pass, not fixed): its generator must
  hold `hr.compensation.read` because the scheme reference comes from the compensation-gated statutory profile's
  `extra`, but the file is then served by `GET …/statutory-schedules/{id}/csv` and 2C's attachment door under
  `hr.payroll.read` alone, so a payroll reader without the compensation code reads each employee's scheme reference.
  Requiring both codes on the file is the fix; the attachment door has no per-file gate, so it is an ADR 0079/§4.5.8
  question.
- **The export's aggregates still leave whole** (ADR 0069's 8-review amendment): `account_balance` carries a period's
  total per payroll account, as the trial balance does, and `dimension_value` keeps the `EMPLOYEE` dimension's rows (an
  employee number and the name `party` already exports) — never a per-employee amount.
- **The key rotation has no operator route** (ADR 0080 question 2): the runbook enqueues `hr.encryption_key.rotate`
  through pg-boss. The worker refuses to boot outside `dev` without `HR_FIELD_ENCRYPTION_KEY`.
- **ADR 0073 question 1:** the API's rate-table load does not refuse the test-fixture authority outside `dev` (the
  route layer has no `APP_ENV`); the second-principal verify is the control.
- **The leave register feeds no payroll figure** and has no accrual engine.
- **Payslip PDFs render in `apps/api` with Chromium**, and the runtime image still carries no Chromium and no
  Arabic-capable font (OD-20, as Phase 7).

## Verification

**Re-run after the review pass (2026-11-08, head `2400263` plus the fixture commit; Linux, Bun 1.4, Node 22,
PostgreSQL 18 Testcontainers):** `packages/db` 2,384 passed, 5 skipped in 238 files (+2: the two export pins);
`apps/api` 1,061 in 107 (+9); `apps/worker` 147 in 22 plus its 2 Bun cases; `tests` 981 passed, 5 skipped, **1
failed** in 145 files (+2: test 32's payroll-document export cases; the failure is test 15's known PDF hyphen case);
`apps/backoffice` 289 in 15 (+7); `bun run e2e` 33/33 (the payslips spec now asserts the earlier-payslips list in
EN and AR); `packages/contracts` 69, `packages/i18n` 41; the back-office build. Static: `typecheck` 14/14, `lint`,
`lint:rules` (11 rules, 0 violations), `format:check`, all seventeen `scripts/check/*.sh` gates, and `openapi.json`
regenerated with no diff (the `excludedRows` schema change is committed with fix 1). The first full `tests` run also
failed SAH-038's object-key source scan on the new back-office fixture; the fixture's key was made opaque and the scan
re-run green.

The record below is the pre-review run.


Run on 2026-11-08 on the finished tree (head after 8D T11, `4f129e7`; Linux, Bun 1.4, Node 22, PostgreSQL 18
Testcontainers, the container's Chromium), every workspace's own `test` script in sequence, uncached:

| Workspace | Result |
|---|---|
| `packages/db` | 2,382 passed, 5 skipped in 238 files (the five skips are 8C's owner-gate cases: four OD-28 schedule-layout cases, T13, and one OD-23 tax-year case, T15) |
| `apps/api` | 1,052 passed in 107 files |
| `apps/worker` | 147 passed in 22 files, plus its 2 Bun health cases |
| `tests` | 979 passed, 5 skipped, **1 failed** in 145 files — test 15's PDF (`invariants/zero-code-document-type.test.ts`, "prints: a PDF in each direction"): this container's Chromium hands the hyphen to the text layer as a Private Use glyph; the known pre-existing failure, not Phase 8's |
| `bun run e2e` | 33/33 (Phase 8 added `hr`, `payroll`, `payslips` and `leave`, each in EN/LTR and AR/RTL) |
| `packages/domain` | 424 passed, 3 skipped (the OD-28 proration and OD-14 hourly owner-gate cases) in 43 files |
| `packages/contracts` | 69 |
| `packages/sync` | 58 |
| `packages/i18n` | 41 |
| `packages/ui` | 22 |
| `apps/pos` | 251 |
| `apps/backoffice` | 282 in 15 files |
| `apps/edge` | 47 |
| `apps/desktop` | 54 |
| `infra` | 25 |

Against Phase 7's final verification (`a72fa50`): `packages/db` +403, `apps/api` +157, `apps/worker` +28, `tests` +106
passed, e2e +8, domain +42, backoffice +56, edge +2.

Static checks on the finished tree: `bun run typecheck` 14/14 workspaces, `bun run lint`, `bun run lint:rules` (11
rules, 0 violations), `bun run format:check`, all seventeen `scripts/check/*.sh` gates (the sixteen contract gates,
`contracts-8a`…`8d` among them, and `no-authority-literals.sh`), and `bun run --cwd apps/api openapi:generate` with no
diff to `packages/contracts/openapi.json`; the back-office (`vite build`), POS (`vite build`) and desktop (`build`,
`build:pos`) builds pass. `bun run --cwd packages/db db:lint` needs `DATABASE_URL_MIGRATOR` and was not run standalone;
the same `lintSchema` runs with zero violations inside `packages/db/test/schema-lint.test.ts`.

**Not verified:** the Windows packaged run (CI's `desktop` job), staging and deployment (OD-19–OD-21), a built Docker
image (`infra/test/dockerfile.test.ts` walks the entrypoints' import graph instead), a PDF render inside the runtime
image, any real statutory figure or real payroll (OD-23), and the screens' parity with the legacy screens (OD-24).
`bun run seed --tenant <id> --only reports` was not run against a deployed tenant; the loader over the real `8d/`
directory is proved by `packages/db/test/seed/reports.test.ts` and by the e2e boot, which applies every report
directory.
