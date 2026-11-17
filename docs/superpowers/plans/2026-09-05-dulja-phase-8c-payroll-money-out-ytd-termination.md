# Dulja Phase 8C — Money out, `employee_ytd`, statutory schedules, termination

**For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` and implement this plan task by task, in order. Each task is self-contained: it names every file it creates or modifies, gives the exact signatures it consumes and produces, carries the real code, and ends with a commit. Do not skip the failing-test step — the expected failure text is written out so you can compare it against what you actually see. If what you see differs, stop and read that task's row in the **Execution handoff** section rather than adjusting the test until it passes.

## Goal

Turn a posted payroll run into **money that leaves the bank, a record each authority can be paid against, a year-to-date projection that rebuilds bit-identically, and a termination that closes every door in one transaction.** This slice ships `PAYROLL_PAYMENT` (one bank batch, one line per employee, clearing salaries payable per employee, released under `hr.payroll.pay` with a bank-neutral CSV), statutory remittances as ordinary `PAYMENT` documents to authority vendor parties **refused when the amount differs from the `statutory_schedule` they settle** (`ERR_PAYROLL_REMITTANCE_MISMATCH`), `EMPLOYEE_ADVANCE` (debit staff advances per employee, credit bank, recovered by the advance-recovery component), `app.statutory_schedule` (one row per scheme per period, generated from **posted lines only**, carrying the attachment hash and the settling PAYMENT), `app.employee_ytd` + `app.employee_ytd_opening` with the **`postDocument` step-12 MERGE** that makes YTD a posting-service-only projection, the nightly `hr.employee_ytd.rebuild` compare, and the AFTER UPDATE OF `terminated_on` trigger that revokes the cashier, expires every role assignment and tombstones the catalogue — plus the deferrable constraint trigger that makes "cashiers are employees" true on both sides.

## Architecture

- **Money out reuses Phase 4's machinery and adds no second payment path.** `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` are ordinary `document` rows with ordinary posting policies, approved and posted under `accounting.payment.approve` / `.post` on 2B's shared state machine (spec:2082 chose Phase 4's machinery deliberately). Their `document_type.module` is **`hr`**, not `accounting`, because the column is the attachment download gate (§4.5.8) and their attachments carry per-employee pay — hazard 34 states this exact pair by name. Nothing in this slice writes a ledger row: `postDocument` does, from the policy.
- **`employee_ytd` is a posting-service projection, and there is exactly one aggregation.** `app.employee_ytd_delta(p_document_id uuid)` is one SQL function returning the per-employee, per-tax-year delta of a posted `PAYROLL` document, with `by_component` and `by_scheme` built in SQL. §4.3.2 step 12's `MERGE` consumes it and so does the nightly rebuild — one function, two callers, which is the only way "rebuilds bit-identically" (the DoD clause) is true by construction rather than by luck. Two hand-written `jsonb` aggregations would disagree on numeric text formatting the first time a scheme share ended in a trailing zero.
- **A schedule is a record, not a lodgement state machine** (spec:2083). `app.statutory_schedule` is generated from posted `payroll_line` rows, carries `total_employee` / `total_employer`, an `attachment_id` for the generic CSV and its hash, and `remittance_document_id` for the PAYMENT that settled it. The mismatch refusal is a **trigger** on that column, not a handler check, so a direct `app_rw` update cannot settle a schedule with the wrong PAYMENT (test 30's last clause).
- **Termination is a trigger, and every door it closes belongs to a slice that already exists.** 0093's AFTER UPDATE OF `terminated_on` sets `pos_cashier.revoked_at` (6C's own `pos_cashier_tombstone` then writes the catalogue tombstone), expires every `role_assignment` of `employee.principal_id` (6C's `refresh_pos_cashier_for_assignment` then refreshes the snapshot), and calls `app.refresh_pos_cashier` for the revoked row — the call 6C's Task 7 already names as *"and by 8C's termination trigger"*. It runs **under the terminating actor**, so 8A's `employee_no_self_pay` (R4) and Plan 0A's `forbid_self_grant` / `keep_last_admin_assignment` still hold and `hr_payroll` needs no `admin.role.assign`.
- **`payroll_batch` joins 4B's matching through the registry, editing no 4B file.** One `ReconcilableSource` over `PAYROLL_PAYMENT`'s `1100` ledger leg, one module-level `registerReconcilableSource` call — the seam 4B's Task 7 built for exactly this (test 39's payroll-batch clause).

## Tech Stack

Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript 5 strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates for every write and every read · Drizzle ORM mirrors for typed reads and as the migration diff source (ADR-0002) · Hono + `@hono/zod-openapi` · Zod · `@dulja/domain`'s `Money` for every amount · pg-boss through `JobClient` / `registerHandler` (this slice registers **one** handler, for the `JOBS` name it already owns) · Vitest + Testcontainers · oxlint + oxfmt · Turborepo. **No new dependency is added and no package version appears in any source file** — the lockfile owns versions (§3.3, spec:104).

## Spec

`C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` v1.2 — **§3.10.1** *Money out on Phase 4 machinery* (spec:2082), *Outputs* (spec:2083), *Year-to-date* (spec:2084), *Termination* (spec:2090); **§3.10.2 Identity: employee, principal, cashier** (spec:2097); §3.10.3 Posting (spec:2099–2101); §3.10.4 (spec:2105); §3.10.5 (spec:2109); **§3.7.5** the termination sentence and the cashier-identity paragraph (spec:1324); §3.9 (spec:2037–2063); §0.2 (spec:97–110); §4.2.2 **R1** (spec:2172), R2 (spec:2173), R4 (spec:2175), **R8** the system principal and the override rule (spec:2179); §4.3 the AR/AP bank-reconciliation row (spec:1043); §4.11 the report format rule (spec:2262–2267) and the secret inventory (spec:2273); Part V Phase 8 (spec:2294, 2301); Part VI tests **2** (spec:2420), **30** (spec:2448), **31** (spec:2449), **34** (spec:2452), **35** (spec:2453), **39** (spec:2457); §5.3 the Phase 8 owner rows (spec:2407, 2478); Part I **LEGACY-004** (spec:231), **LEGACY-011** (spec:311), **LEGACY-016** (spec:354), **LEGACY-019** (spec:381), **LEGACY-021** (spec:403), **LEGACY-044** (spec:593).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 8C — Money out, `employee_ytd`, statutory schedules, termination. **Phase:** 8. **Phase gate:** this plan starts only when **8B**, **6C** and **4B** are merged and Phase 4's definition of done is green in CI (spec:87, spec:2301 — Phase 8 depends on Phases 1, 2 and 4 and "may start as soon as Phase 4 is green and run alongside Phases 5–7").
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.forbid_change`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.stamp_actor`, `app.assert_period_open`, `app.posting_seq`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `ErrCode`, `Problem`, `fromDatabaseError`, `createLogger`, `Logger`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `PermissionDef`, `SliceId`, `requirePermission`, `ScopeSource`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `encodeCursor`, `decodeCursor`, `Cursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `CurrencySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`, `postLines`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`, `toBase`, `UNIT_RATE`, `ExchangeRate`, `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS`, `seedBranch`, `seedCurrency`, `JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `EnqueueOptions`, `registerHandler`, `runJob`, `eachTenant`, `JOB_PROBES`, `JobIsolationProbe`, `startWorker`, `log`. **0C** — the seed CLI, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, and the `0c-base.json` chart rows `1000`, `1100`, `1200`, `2100`, `5920`. **0E** — `packages/ui`, `packages/i18n`, `bootLocalStack`, `grantAdminRole`. **1A** — `postDocument`, `issueDocument`, `reverseDocument`, `voidDocument`, `loadSnapshot`, `resolvePolicy`, `PostResult`, `PostingError`, `PostingErrorCode`, `insertLedger`, `documentRoutes`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `JOURNAL_POLICY_V1`, `documentTypesLoader`, `loadDocumentTypes`, `document.posting_seq`, `fiscal_period.reopen_reason`. **1B** — `postJournal`, `JournalLine`, `ProjectionCheck`, `ProjectionMismatch`, `registerProjectionCheck`, `projectionChecks`, `runIntegrityCheck`, `recordIntegrityIncident`, `IntegrityReport`, `ACCOUNT_BALANCE_CHECK`, `reportsRouteModule`. **2A** — `evaluatePolicy`, `balanceInBase`, `parsePolicy`, `validatePolicy`, `validateDocumentTypeSeed`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PostingPlan`, `PolicyEvaluationError`, `PayrollLineRef`, `requireDocumentPermission`, `DocumentStage`, `stageCode`, `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`, `seedDocumentType`, `seedParty`, `DocumentLineInput`, `app.party`. **2B** — `transitionDocument`, `TransitionResult`, `setEventContext`, `listDocumentEvents`, `grantCodes`, `app.principal_has`, `app.effective_policy`, `app.document_event`, `app.document_status_before`, `ERR_DOC_NOT_DRAFT`, `SERIES_GAP_CHECK`. **2C** — `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, `requireDocumentModuleRead`, `ObjectStore`, `MemoryObjectStore`, `objectKeyFor`, `app.attachment`. **3A** — `STOCK_ON_HAND_CHECK`. **3B** — `COST_LAYER_CHECK`, `ensureOpenPeriods(db: Db, s: Seed, year: number): Promise<void>` in `tests/invariants/support/post-inventory.ts`. **3C** — `draftTypedDocument(db, s, opts) → { documentId, lineIds }`, `DraftLine`. **4A** — `app.payment_term`, `app.allocation`, `allocateSettlement`, `openBalance`, `partyBalance`, the `PAYMENT` document type and its policy, `accounting.payment.create` / `.approve` / `.post`, `seedPaymentTerm`. **4B** — `Reconcilable`, `ReconcilableSource`, `registerReconcilableSource`, `reconcilableSources`, `RECONCILABLE_DIRECTION`, `importStatement`, `match`, `unmatch`, `reconciledBalance`, `ReconcilableKindSchema`, `app.bank_statement`, `app.bank_statement_line`, `app.bank_match`, `ITEM_PROFITABILITY_CHECK`'s consequence for `projections.checked`. **6C** — `app.employee` (migration 0064), `app.pos_cashier`, `app.branch_pos_policy`, `app.attendance_event`, `app.refresh_pos_cashier(p_principal_id uuid)`, `app.pos_cashier_tombstone()` and its `after update of revoked_at` trigger, `app.pos_cashier_sync(uuid, uuid, bigint)`, `app.actor_in_branch`, `app.actor_in_warehouse`, the five `branch_isolation` forms, the `branch_isolation_policy` linter rule, `seedEmployee`, `seedCashier`, `seedBranchPosPolicy`. **6A** — `app.catalogue_revision()`, `app.catalogue_revision_seq`, `app.catalogue_tombstone`, `readCatalogue`, `currentCatalogueRevision`, `seedTerminal`. **8A** — `app.employee` as extended by 0080 with 8A's `employee_no_self_pay` R4 trigger, `app.employee_sensitive`, `app.employee_statutory_profile`, `app.pay_component`, `app.pay_component_scheme`, `app.compensation_line`, `app.statutory_scheme`, `app.statutory_rate_table`, `app.company_hr_setting`, `packages/domain/payroll/rate-table.schema.json` and the committed `RateTable`, the `statutory` sub-pack loader, `ERR_HR_SELF_PAY`, `ERR_HR_SELF_VERIFY`, the `sensitive_gate` linter rule, `seedEmployee`, `seedPayComponent`, `seedStatutoryScheme`, `seedRateTable`. **8B** — `app.payroll_run`, `app.payroll_line`, `app.forbid_payroll_line_change_unless_draft()`, `app.employee_dimension()`, `ensureEmployeeDimensionValue`, `EMPLOYEE_DIMENSION_CODE`, `linkPayrollAccounts`, `PAYROLL_ACCOUNT_CODES`, `calculatePayrollRun`, `recalculatePayrollRun`, `readPayrollRun`, `PayrollRunDetail`, `loadPayrollInputs`, `ytdFromPostedLines`, `payrollCalculator`, `PayrollCalculationError`, `EmployeeResult`, `SchemeResult`, the `PAYROLL` document type and its policy, the eleven §4.15 chart rows of `8b-payroll.json`, the four `hr.payroll.*` codes, the `hr` row of `MODULE_READ_CODE`, `seedPayrollRun`, and the test-tier helpers `payrollFixture`, `PayrollFixture`, `postPayrollRun`, `secondApprover`, `SYNTH_TABLE`, `PAYROLL_PACK_ROOT` in `tests/invariants/support/payroll.ts`.
- **Migration numbers:** 0091–0095, **all five used, five PRs** — `0091_create_statutory_schedule_and_remittance_guard.sql` (T1, renamed by amendment **B1**), `0092_create_employee_ytd.sql` (T2), `0093_create_termination_trigger.sql` (T10), `0094_create_cashier_is_employee_constraint.sql` (T11), `0095_seed_permission_phase8c.sql` (T4). **ADR numbers:** 0077–0078 — `0077-employee-ytd-is-a-posting-service-projection` (a **PROPOSAL**, spec:95 — it touches money semantics and the data model) and `0078-termination-is-a-trigger-and-cashiers-are-employees` (a **PROPOSAL** — it touches security).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `RoundingMode`, `MONEY_SCALE`, `toBase`, `UNIT_RATE`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, the fixed middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError` — **this slice adds two `ERRORS` rows**: `ERR_PAYROLL_REMITTANCE_MISMATCH`, already allocated, and `ERR_HR_CASHIER_NOT_EMPLOYEE`, allocated by amendment B13), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `PermissionDef`, `requirePermission`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), **§4.2.6** (`JOBS` — this slice registers the handler for the one name it owns, `hr.employee_ytd.rebuild`; `JobPayload` gains that one key; the audit `table_name` sentinel paragraph — this slice registers one), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IsolationProbe`, `IdempotencyHeader`, `createApp`), §4.2.8 (the common schemas, the list envelope, the cursor codec, **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`), §4.2.11 (`app.dimension_type` / `app.dimension_value`), §4.2.12 (`startApi`, `StartedApi`, `ApiRequest`), §4.2.13 (`readPackFile`, `SUB_PACKS`), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `transitionDocument`, `setEventContext`), **§4.3.2 (the fixed algorithm — this slice extends step 12 and the closed write list)**, §4.3.4 (`document_line`, `document.branch_id`), §4.3.5 (`posting_seq`), §4.3.6 (numbering at issue), §4.3.7 (the seed envelope), §4.4.1 (`posting-policy.schema.json` — consumed **unchanged**, same `$id`, same `"version": 1`), **§4.4.2 in full** (`DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, and **sign normalisation A9**), §4.5.1 (legal transitions), §4.5.2 (`document_event`), §4.5.4 (`requireDocumentPermission`, `stageCode`, `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`), §4.5.6 (Form A′ on `employee`, Form A on `pos_cashier` — consumed), §4.5.8 (`MODULE_READ_CODE` — consumed, **this slice adds no row**; 8B shipped `hr`), **§4.8.3 in full** (`Reconcilable`, `ReconcilableSource`, `registerReconcilableSource`), §4.6.1 (the register rows for `statutory_schedule`, `employee_ytd`, `employee_ytd_opening`, `pos_cashier`, `employee`), §4.6.2, §4.6.3, **§4.12 in full — especially §4.12.6 and §4.12.8**, §4.14 (document-type codes), §4.15 (account codes), §4.16.1–§4.16.2 (consulted: **this slice ships no report and no `DatasetId` member**), **§4.16.3** (`ProjectionCheck`, `registerProjectionCheck`, `projectionChecks`, `recordIntegrityIncident`), §4.17 (**no row is assigned to 8C**), §4.17.1, §4.18 (both rounds, plus 8A's and 8B's round-3 rows), §5 (all thirty-five hazards), §6.1 rows 2, 30, 31, 34, 35, 39, §6.2 rows spec:1043, 1058, 1059, 1061.
- **Interfaces produced:** §4.6.1's `statutory_schedule`, `employee_ytd` and `employee_ytd_opening` rows; **§4.12.8 in full** (`app.employee_ytd`, the step-12 MERGE, the nightly rebuild-and-compare); §4.14's `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` rows with their envelopes and policies; §3.6.2's two codes `hr.payroll.pay` and `hr.advance.create`; §4.2.6's `hr.employee_ytd.rebuild` handler and its `JobPayload` key; §4.8.3's `payroll_batch` `ReconcilableSource`; §4.16.3's `EMPLOYEE_YTD_CHECK`; three §4.2.7 route modules with their three `PROBES` keys; three §4.2.8 contracts modules; and the §4.17.1 helper file `tests/invariants/support/payroll-money.ts`.
- **Owner decisions:** **OD-28** (the ⚠️ schedule layouts of spec:2083, verified against the authorities) → **Task 13**, isolated; default **a generic CSV** with the column set named in that task, `statutory_schedule.attachment_id` pointing at it, and the authority layout swapped in as a template when verified. **OD-14** (spec:2093 — the money-out clause, *staff purchases at the till on salary deduction*) → **Task 14**, isolated; default **not built**. OD-14's other three clauses — HRD Corp or other levy, foreign workers, hourly/part-time staff — are **8B's Task 8** and are not re-opened here (§2.12 gates OD-14 at "8A/8B → one task each if yes"; the orchestrator's card also lists it for 8C, and the money-out clause is the only half that lands in this slice). **OD-23** is **split, and the split is not a re-opening**: its *rate-table* clause (current EPF/SOCSO/EIS/PCB tables and worked examples signed off by the accountant) is **8B's Task 12** and is not touched here, while its **two clauses this slice is the first consumer of** — the **employer registration number** per scheme and the **pay-period / pay-date convention** — land as **Task 15**, isolated. 8A's own OD-23 task says so in as many words: *"Nothing in 8A, 8B or 8C reads a registration number — the first consumer is 8C's statutory schedule and 8D's annual employer return"*, and the pay-date convention is what amendment **B7** fixes `employee_ytd.tax_year` on. Default: `statutory_scheme.employer_registration` is null and the schedule **names the scheme whose registration is missing** rather than printing an empty box; `tax_year` is the calendar year of `payroll_run.pay_date`. **OD-24** (screens) is not gated here — this slice ships no screen; its three route modules are API surface that 8D's reports and any later screen consume.
- **Part VI tests owned / re-run:** owns **30** (payslip ties to the ledger — Task 8), **34** (termination closes everything — Task 11), **35** (YTD rebuild and recalculation — Task 9; the *recalculation* clause is 8B's Task 11 and is re-run here, the *verify ≠ load* clause is 8A's and is re-run here). **Re-runs:** **2** (deterministic projections, over `employee_ytd` — Task 9), **20** (catalogue resume, the *termination tombstone* half §6.1's row 20 assigns this slice — Task 11's clause 2, which pulls the cashier stream from the revision a synced till already holds rather than from `0n`), **31** (the `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` clauses of segregation of duties — Task 12), **39** (the payroll-batch clause of bank reconciliation — Task 12), **12**, **13** and **36** for this slice's three new tables, two codes and three route modules (Tasks 1, 2, 4, 6, 7). **§3.0.4 rows owned:** spec:**1058** (PAYROLL / PAYROLL_PAYMENT / remittances / EMPLOYEE_ADVANCE — 8B contributes PAYROLL) and spec:**1061** (Termination — 6C contributes the cashier and the tombstone); contributes to spec:1043 (Bank reconciliation, 4B's row) and spec:1059 (`employee_ytd`, 8D's row). **Regression files created / appended:** **creates none.** **Appends** a `— 8C` block to `tests/regression/legacy-004.test.ts` and `legacy-016.test.ts` (both created by **3B**), `legacy-011.test.ts` (**1A**), `legacy-019.test.ts` (**0D**), `legacy-021.test.ts` and `legacy-044.test.ts` (both **0B**) — never editing an earlier block (§3.7.3).
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14)** — exactly two, **`PAYROLL_PAYMENT`** (`module: "hr"`, series `PAYB`) and **`EMPLOYEE_ADVANCE`** (`module: "hr"`, series `ADV`), seeded as `packages/db/seed/my/document-types/PAYROLL_PAYMENT.json` and `EMPLOYEE_ADVANCE.json`. Consumed and never seeded here: **`PAYROLL`** (8B), **`PAYMENT`** (4A — the statutory remittance is an ordinary `PAYMENT`), `JOURNAL` (1A). **Account codes (§4.15) — none seeded.** Consumed, with their seeding slice: `2400` Salaries payable, `1400` Staff advances, `2411`–`2414` Statutory payable per scheme (**8B**); `1100` Bank, `2100` Trade payables, `5920` FX rounding (**0C**). Hazard 33's rule is discharged by **Task 5 Step 1**, which asserts every one of them resolves in the company before a policy names it. **Report codes (§4.16.1) — none**, and **`DatasetId` members (§4.16.2) — none**: `employee_ytd` and `statutory_schedule` are 8D's rows in the frozen union, and 7A creates `datasets.ts`. **`fixtures.ts` helpers (§4.17) — none**: §4.17 assigns 8C no row and hazard 9 forbids inventing one beside the register. **Shared test helpers (§4.17.1) — one new file**, `tests/invariants/support/payroll-money.ts` (amendment **B3**), **plus one new row on §4.17.1's cross-workspace allowance paragraph**: `packages/db/test/**` may import `tests/support/**` and `tests/invariants/support/**` (amendment **B15**), which ten suites in this slice do and which 3B and 8B already did without registering it.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Contract amendments this plan discovered

§4.18 carries Round 1 and Round 2. 8A and 8B each add a **Round 3** table; this plan's Task 1 Step 1 **appends its rows to that table if it is already there and creates it if it is not** — the create-if-absent shape §3.7.3 uses for a slice whose predecessors may land in either order — and then applies each row to its own section, as one amendment PR **before** any code in this slice is written. **Fifteen rows, B1–B15.**

| # | § | Name or decision | Source |
|---|---|---|---|
| **B1** | 2.9 (8C card), 3.4.2 | **Migration 0091 is renamed `0091_create_statutory_schedule_and_remittance_guard.sql`.** The card's `0091_create_statutory_schedule.sql` understates the file: it also creates `app.assert_remittance_matches_schedule()` and its BEFORE UPDATE trigger, which is the whole of `ERR_PAYROLL_REMITTANCE_MISMATCH` and one of test 30's four clauses. §3.4.2's round-2 rule ("a file whose name understates what it does is renamed, not left") gives the longer name; 2A's `0018_…`, 2B's `0023_…` and 8B's `0088_…` are the precedents | correction |
| **B2** | 4.2.6 (the audit `table_name` sentinel paragraph) | **`employee_ytd_drift` is registered as the third audit sentinel**, beside 1B's `integrity_incident` and `month_end_ready`. The nightly `hr.employee_ytd.rebuild` handler reports drift rather than repairing it silently (6C's `pos.cashier.compare` precedent), and a projection that has no row of its own to audit writes a sentinel row — §4.2.6 says in as many words that "a slice that needs a third registers it here first" | plan |
| **B3** | 4.17.1 | **`tests/invariants/support/payroll-money.ts`** (8C) — `MoneyOutFixture`, `moneyOutFixture`, `postPayrollPayment`, `postEmployeeAdvance`, `postRemittance`. Registered on §4.17.1's terms. §4.17 assigns 8C **no `fixtures.ts` row**, and hazard 9 forbids inventing one beside the register, so every shared helper this slice needs lives here | plan |
| **B4** | 4.2.6 (`JobPayload`) | **`JobPayload["hr.employee_ytd.rebuild"] = { companyId?: string; taxYear?: number }`** — both optional; omitting both is the nightly whole-tenant run, exactly the shape 1B chose for `accounting.ledger.integrity_check`. This slice adds **only** its own key and touches no other line of `payloads.ts` | plan |
| **B5** | 4.16.3 | **`EMPLOYEE_YTD_CHECK` joins 1B's `projectionChecks` registry** (§4.16.3 already names 8C as an extender), so `IntegrityReport.projections.checked` gains `employee_ytd`. `projectionChecks()` sorts by name, so the array stays alphabetical and no earlier member moves. **After 4B it is `["account_balance", "cost_layer", "document_series", "item_profitability", "stock_on_hand"]`; after this slice it is `["account_balance", "cost_layer", "document_series", "employee_ytd", "item_profitability", "stock_on_hand"]`**, and the three pinned assertions that read it move in the same PR, exactly as 2B, 3A, 3B and 4B each did | plan |
| **B6** | 4.12.8 | **`app.employee_ytd_delta(p_document_id uuid)` is the one aggregation**, returning `table (company_id uuid, employee_id uuid, tax_year smallint, gross numeric(19,4), net numeric(19,4), by_component jsonb, by_scheme jsonb)`. §4.3.2 step 12's MERGE and the nightly rebuild both consume it. Two hand-written `jsonb` aggregations would differ on numeric text formatting and "rebuilds bit-identically" — the DoD clause — would be false at the first trailing zero | plan |
| **B7** | 4.12.8 | **`employee_ytd.tax_year` is the calendar year of `payroll_run.pay_date`**, not of `period_end` and not of `document.effective_date`. It is a **convention this slice fixes and OD-23 confirms** (spec:2407 names "pay-period/pay-date conventions" as an owner question) — it is **not** a statutory claim, and no rate, threshold or deadline follows from it. ADR 0077 records it; **Task 15's OD-23 gate** is where it is confirmed and says, in one table, exactly what changes if the accountant answers otherwise — one `extract(year from …)` expression and one job run | plan |
| **B8** | 4.12.2, 4.14 | **The `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` policy shapes.** §4.12.2 fixes the `PAYROLL` policy and the two account literals these types resolve, but not their rules. Both use `document_line.kind = 'payroll'` lines carrying `amount` (never `debit`/`credit`), `account: { "code": "2400" }` / `{ "code": "1400" }` on an `each_line` rule with `dimensions: { "from": ["line.dimensions"] }`, one `for: "document"` rule crediting `{ "code": "1100" }` at `document.total_excl_tax`, and **`dimensions.required: ["BRANCH"]` — not `["BRANCH", "EMPLOYEE"]`**, because the document-scoped bank leg has no employee and requiring EMPLOYEE would refuse the whole document. `approval.create` is `hr.payroll.pay` / `hr.advance.create`; `approve` / `post` are `accounting.payment.approve` / `.post` with `required: true` (§4.14) | plan |
| **B9** | 4.3.4 (the `document_line.dimensions` comment, as 8B's A3 left it) | **`kind = 'payroll'` lines on `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` carry no `payroll_line` row.** `payroll_line` is a 1:1 extension of a **run's** lines (§4.12.6) and 8D's `payroll_line` dataset reads it as such; a row on a batch line would make the payroll register double-count. These lines therefore never resolve `line.employee`, which is why B8's rules read EMPLOYEE out of `line.dimensions` instead. 8B's A3 already amended that comment to say BRANCH lives in the bag on `PAYROLL` lines; this row extends the same sentence to the two money-out types and adds EMPLOYEE to it | plan |
| **B10** | 4.2.7, 4.2.8 | **Three route modules, three `PROBES` keys, three contracts modules.** `/v1/companies/:companyId/payroll-payments` (`payrollPaymentRoutes`, `payrollPaymentRouteModule`), `/v1/companies/:companyId/employee-advances` (`employeeAdvanceRoutes`, `employeeAdvanceRouteModule`), `/v1/companies/:companyId/statutory-schedules` (**`createStatutoryScheduleRoutes(store)`** and **`statutoryScheduleRouteModule(store)`** — a factory pair, because the generator needs `AppDeps.objectStore` and §4.2.3's `AppEnv` carries no `deps` for a handler to read; it is 2C's `createAttachmentRoutes(deps.objectStore)` shape, 2c:1633/1706); `packages/contracts/src/hr/payroll-payment.ts`, `employee-advance.ts`, `statutory-schedule.ts`. Submit, approve and post go through 2B's existing `…/documents/{documentId}/transitions`, which inherits `documents`' key | plan |
| **B11** | 4.6.1 (the `statutory_schedule` row) | **`statutory_schedule` gains `currency char(3) not null` and `generated_by uuid` (stamped), and its unique key is `(scheme_id, period_start, payroll_document_id)` exactly as §4.6.1 states.** The currency is needed because `total_employee` / `total_employer` are `numeric(19,4)` with no currency of their own and the remittance guard compares them to a PAYMENT's ledger leg; `generated_by` is the `*_by` column §3.3's naming rule then forces a `stamp_generated_by` trigger onto. Both are additive to §4.6.1's compact column list | plan |
| **B12** | 4.8.3 | **`PAYROLL_BATCH_SOURCE: ReconcilableSource`** in `packages/db/src/hr/reconcilable.ts`, registered at module level and re-exported from `packages/db/src/index.ts`. 4B's `ledgerLegSource` is **module-private** to `packages/db/src/ar-ap/reconciliation.ts`, so this slice writes its own list over `PAYROLL_PAYMENT`'s `1100` leg rather than importing a private function, and **edits no 4B file** — which is what 4B's Task 7 Step 7 built the registry to allow | plan |
| **B13** | 4.2.4 (the allocated code space) | **`ERR_HR_CASHIER_NOT_EMPLOYEE` (409)**, raised as a DB token by 0094's deferrable constraint trigger (8C). §4.2.4's table allocates every code the v1 system will ever raise and this condition has none: "an unrevoked `pos_cashier` must reference an employee with `terminated_on IS NULL`" (spec:2090) is neither `ERR_CONFLICT_REFERENCE` (no foreign key is violated — the employee row exists) nor `ERR_VALIDATION_FAILED` (it is a state conflict, not a body). The row is added to the table first, then to `ERRORS` in the same commit as the migration whose SQL text raises it | plan |
| **B14** | 4.12.8 | **`app.employee_ytd` and its rebuild cover POSTED DELTAS ONLY; `app.employee_ytd_opening` is a READ-TIME addend, never a row of the projection.** §4.12.8 currently reads "rebuilt nightly from `employee_ytd_opening` + posted `payroll_line` rows", which describes a projection whose *maintained* side no writer could ever produce: only `packages/db/src/posting/**` may write `app.employee_ytd` (spec:98, §3.7.5, and Task 2 adds the table to `posting-only-tables`), the step-12 MERGE runs on a posted document and never on an opening load, and `upsertEmployeeYtdOpening` lives in `packages/db/src/hr/**` where that rule forbids it to write the projection at all. An opening added to the rebuild alone would report every cut-over employee as permanent `amount_differs` drift, for ever. The rule is therefore: **`employee_ytd` = Σ posted deltas; `employee_ytd_opening` = the cut-over figure; a YTD *reading* is their sum, produced in one place, `ytdFromEmployeeYtd` (Task 3).** §4.12.8's sentence becomes "rebuilt nightly from posted `payroll_line` rows and compared row for row; `employee_ytd_opening` is added at read time by `ytdFromEmployeeYtd`, never merged into the projection". spec:2453's *"rebuilt from opening rows plus posted lines"* is satisfied by the read, and Task 9's test 35 clause 1 asserts both halves — that an opening perturbs neither side of the compare, and that the read returns projection + opening | correction |
| **B15** | 4.17.1 (the closing cross-workspace paragraph) | **`packages/db/test/**` joins `apps/api/test/**` and `apps/worker/test/**` as a named allowance to import from `tests/support/**` and `tests/invariants/support/**`**, with the same two mechanics §4.17.1 already prescribes: a line on `scripts/lint/rules/dependency-rule.ts` carrying its reason, and one `include` entry per imported directory in `packages/db/tsconfig.json` (`"../../tests/support/**/*.ts"`, `"../../tests/invariants/support/**/*.ts"`). **No `package.json` dependency is added** in that direction — it would close a cycle in the workspace graph turbo walks, which is why 1B built the allowance as a lint exception rather than a dependency. The paragraph names only the two `apps` directories today, and `packages/db/test/**` is **inside** `scripts/lint/run.ts`'s `ROOTS` (`apps`, `packages`, `scripts` — §3.7.5), so `dependency-rule` scans it; `tests/` is outside the roots, so the *imported* side was never the problem. The register is behind the plans rather than the plans being wrong: **3B** was first (`packages/db/test/costing/apply-movements.test.ts` → `tests/invariants/support/post-inventory`, 3b:2713) and **8B** followed (8b:3886, 8b:5291); neither filed the row. This slice needs it in **ten** files across T2, T3, T6, T7, T8, T9, T12 and T15, for the reason §4.17.1 itself gives: a fixture that posts a payroll run through the real `postDocument` cannot live in `fixtures.ts`, and `packages/db` may not import an app (§3.1). Task 1 Step 1 files the row **and checks that the allowance line and the `include` entries are actually in the repository**, adding them if a predecessor's executor did not | correction |

## Global Constraints

1. **Never write to a ledger or movement table outside the posting service** (spec:97, hazard 22). Every figure this slice puts in the ledger is a `document` posted by `postDocument`. **`app.employee_ytd` joins that protected set in this slice**: Task 2 adds it to `posting-only-tables`' table list (§3.7.5) and Task 3 adds it to §4.3.2's closed write list, so from this PR onward only `packages/db/src/posting/**`, `packages/db/src/costing/**`, `packages/db/test/**` and `scripts/lint/rules/**` may name it in DML. `app.employee_ytd_opening` is **not** in that set — it is a loaded figure written through `upsertEmployeeYtdOpening` (Task 9) by 9B's importer at cut-over, and by no route — amendment B10 fixes this slice's API surface at three modules.
2. **Never money as a float.** `numeric(19,4)` in Postgres, `Money` in TypeScript, `string` on the wire. `no-number-money` (§3.7.5) fires on any property, parameter or variable whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` typed `number`. `gross`, `net`, `totalEmployee`, `totalEmployer` and every `amount` in this slice carry `Money` or `string`. **This slice adds no entry to that rule's `ALLOWED` set** — 8B's `rateTableVersion` is the only one in the repository and the rule stays the control.
3. **Never SQL by string concatenation.** Every statement is a `tx`-tagged `postgres.js` template or a Drizzle read; `sql.unsafe` has exactly three homes and none is in this slice (§3.3, hazard 21). The CSV writers build **text**, never SQL.
4. **Never DDL from application code.** DDL lives only in `packages/db/migrations/NNNN_<verb>_<noun>.sql` with a hand-written `NNNN.down.sql` (§3.4.2, §3.4.5). The rebuild's scratch table is a `create temp table` **inside** a migration-free read path — and that is the one exception the codebase already makes for 1B's and 3A's projection checks, which do exactly the same thing (`checkAccountBalanceProjection`); a temp table is session-local and creates no object in schema `app`.
5. **Every new table** carries `tenant_id`, RLS via `app_meta.enable_tenant_rls`, FORCE RLS, `created_at`, the audit trigger via `app_meta.attach_audit` unless the table is in `AUDIT_EXEMPT`, `stamp_<col>` for every `*_by` column, composite `(tenant_id, x)` FKs, `unique (tenant_id, id)` (or the natural-key equivalent for a `NO_ID_TABLES` member), `snake_case` singular names, and a test that a second tenant cannot see it (§3.3, §3.5.1).
6. **`side` carries direction; a planned ledger amount is never negative** (§4.4.2 amendment A9). Nothing in `packages/db/src/hr/**` reads the sign of a `PlannedLedgerLine.amount`, and nothing reads the sign of `payroll_line.amount`, which 8B constrains `>= 0` for exactly that reason. `employee_ytd.net` **is** signed, and the sign comes from the **source line's own direction** — `sum(document_line.credit − document_line.debit)` over the run's `kind = 'account'` lines, which is where 8B's rules 6 and 7 put the direction (8b:1526–1528; rule 7 exists so a `supplementary` run can carry a **debit** net-pay line for an over-payment recovery). It is a projection arithmetic over a stored `debit`/`credit` pair, never an inference from a magnitude, so A9 is untouched. **`gross`, `by_component` and `by_scheme` stay magnitudes**: a `kind = 'payroll'` line carries no `debit`/`credit` at all in 8B's model, so there is no direction to read and no negative earning to represent. Task 2 states the convention in the migration, Task 3 in the MERGE, and ADR 0077 decision 5 records it.
7. **No real statutory rate, threshold, ceiling or formula appears anywhere** — not in a plan, a test, a fixture, a seed file or a comment (hazard 1; spec:2080, spec:2229). Every figure in every test of this slice comes from 8B's clearly synthetic `SYNTH` table (§4.12.4) through `payrollFixture`. **No file is created under `packages/db/seed/my/statutory/`.** A number that looks like an EPF, SOCSO, EIS or PCB rate in this slice is a defect.
8. **No invented LHDN or authority detail** (hazard 2). No form name, box name, file-layout version, submission endpoint or deadline appears. The schedule CSV is **generic** — its columns are named in Task 7 and are the ones the data already has — and Task 13 is the isolated OD-28 gate that swaps in a verified layout.
9. **Per-tenant rows cannot be written by a migration** (hazard 10). `FORCE ROW LEVEL SECURITY` binds `app_migrator`, so 0091–0095 create objects and seed `app.permission` (global) only. Document types and their policies are seed-pack data applied by `bun run seed --tenant <id> --only document-types`.
10. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly two `ERRORS` rows: `ERR_PAYROLL_REMITTANCE_MISMATCH` (422), already allocated in §4.2.4, and `ERR_HR_CASHIER_NOT_EMPLOYEE` (409), which amendment B13 allocates before Task 1 runs.** Each lands in **the same commit as the migration whose SQL text raises it** — 0091 and 0094 respectively — because `error-codes` scans `packages/db/migrations/**` and must be green at every commit. Everything else this slice raises is already shipped: `ERR_NOT_FOUND`, `ERR_VALIDATION_FAILED`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_DOC_NOT_DRAFT`, `ERR_DOC_NO_LINES`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_SOD_NO_SUBMISSION`, `ERR_SOD_MAKER_IS_CHECKER`, `ERR_PERIOD_NOT_OPEN`, `ERR_PERIOD_NOT_FOUND`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_INVALID`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_LEDGER_UNBALANCED`, `ERR_HR_SELF_PAY`, `ERR_RBAC_LAST_ADMIN`, `ERR_ACTOR_IMMUTABLE`, `ERR_TABLE_IMMUTABLE`, `ERR_BANK_MATCH_AMOUNT`, **`ERR_IDEMPOTENCY_KEY_MISSING`** (0B's subset, §4.2.4 — the route tests of Tasks 6 and 7 assert it on an unsafe call with no header), `ERR_INTERNAL`. **This list is closed:** a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.
11. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the two codes §3.6.2 assigns it — `hr.payroll.pay` and `hr.advance.create` — and invents none. `accounting.payment.approve` / `.post` are 4A's, the four `hr.payroll.*` are 8B's, the six `hr.*` of 8A are 8A's, `hr.employee.read` / `.manage` are 6C's. All are consumed, never re-seeded.
12. **No plan invents a literal in a shared namespace** (hazard 32). Every document-type code, account code, report code, `DatasetId` member, `fixtures.ts` helper name and `ERR_*` code this slice writes appears in the Assumptions block's namespace list; a literal not there is a review-blocking finding.
13. **The slice that seeds a policy seeds the accounts that policy names by code** (hazard 33). This slice's two policies name `2400`, `1400` and `1100` — **all seeded elsewhere** (`2400` and `1400` by 8B, `1100` by 0C) — so **Task 5 Step 1 asserts each one resolves in the company before the policy is seeded**, which is exactly what hazard 33 requires of a consuming slice: "it never re-seeds it and never falls back to a null account".
14. **Jobs run as the tenant's system principal** (hazard 20, spec:2179). This slice registers the handler for **one** already-registered `JOBS` name, `hr.employee_ytd.rebuild`, and adds **no** name — the registry stays closed at sixteen.
15. **Every route needs a probe entry in `tests/invariants/probes.ts`**, keyed by its `RouteModule.path` (hazard 31). This slice mounts **three** modules and therefore adds **three** `PROBES` entries, and one `JOB_PROBES` entry for its handler.
16. **`lint-schema.ts` is a merge hotspot** (hazard 13). Tasks 1 and 2 edit the sets to exactly §3.5.3's declared state for this slice — `employee_ytd` joins **`NO_ID_TABLES`** (it is `AUDIT_EXEMPT` already per §3.5.3's "already" column), `statutory_schedule` and `employee_ytd_opening` join **nothing** — and add nothing else.
17. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [8C T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root are **green after every task, with no exception**.
18. **This slice does not rewrite `AGENTS.md`'s "Current phase" section.** §3.8 names **8D** as Phase 8's closing slice.
19. **One migration per PR** (spec:2057). Five migrations, five PRs.
20. **Plan 0A is frozen and `fixtures.ts` is extended only with the helpers §4.17 assigns the slice.** §4.17 assigns 8C none, so `packages/db/test/fixtures.ts` is **not edited by this plan at all** (hazard 9).
21. **Four facts about writing rows in this slice's tests, stated once because each one fails silently or several frames away from its cause.** They are the reason every `beforeAll` below looks the way it does; if a test in this plan behaves oddly, check these first.
    - **(a) `s.human` must be granted before it may touch `app.document`, `app.employee` or `app.pos_cashier`.** All three carry a `branch_isolation` policy from 6C's migration 0068 — Form A, Form A′ and Form A again (§4.5.6) — and every one of the five forms is **`AS RESTRICTIVE`**. `app.actor_in_branch` is true only for a *system* principal or one holding a live `role_assignment` in that company, and **`seedTenant` grants `s.human` no role, no `role_permission` and no `role_assignment` at all** (§4.1, pinned 2026-09-07; 6c:33 fact 2). So every suite that writes one of those tables as `s.human` calls **2B's `grantCodes(db, s, { codes: [...] })`** in `beforeAll` first — **T1, T2, T3, T10 and T11 do it explicitly**, and T6, T7, T8, T9 and T12 inherit it from `moneyOutFixture`, which grants `hr.payroll.pay` and `hr.advance.create` on `s.human`. For *these three tables* the codes barely matter: it is the `role_assignment` row that makes `actor_in_branch` true, and passing no `branchIds` keeps it company-wide. **The one place a code does matter is `app.employee_sensitive`**, which carries 8A's separate `sensitive_gate` `AS RESTRICTIVE` policy (spec:2076, §4.6's `employee_sensitive` row) keyed on `hr.employee.read_sensitive` — and nothing in this slice reads or writes that table, by design (test 32 is 8A's). No other 8A or 8B table this slice touches — `payroll_run`, `payroll_line`, `pay_component`, `pay_component_scheme`, `statutory_scheme`, `statutory_rate_table` — carries `sensitive_gate` or a branch key, so tenant RLS is the whole of their access control.
    - **(b) The two failure shapes are different, and only one is loud.** A restrictive policy with no `WITH CHECK` uses its `USING` expression as the insert check, so a forbidden **INSERT** raises *"new row violates row-level security policy"* — loud, if misleading. A forbidden **UPDATE** or **DELETE** simply matches zero rows and raises nothing. The termination tests of T10 and T11 are all UPDATEs, which is why the grant there is called out twice.
    - **(c) `document.series` is `not null` (plan0A:1780) and is written on the DRAFT.** Numbering is at issue (§4.3.6) — `number` and `fiscal_period_id` stay null until `issueDocument` assigns them — but the *series* is a column of every document from the moment it exists. Every direct `insert into app.document` in this plan names it; `draftMoneyOut` reads it from the resolved policy's `numbering.series` rather than repeating the `PAYB` / `ADV` literals the Task 5 envelopes already declare.
    - **(d) A hand-written `ledger_entry` needs both legs.** Plan 0A attaches `ledger_entry_balanced` as a **`DEFERRABLE INITIALLY DEFERRED`** constraint trigger that fires at COMMIT (§4.3.2 step 15, spec:1865). A one-sided insert therefore does not fail on the insert — it fails when `withTenant` returns, as `ERR_LEDGER_UNBALANCED`, pointing at nothing in particular. `postedRemittance` in T1 is the one helper in this slice that writes ledger rows by hand, and it writes a balancing debit for exactly this reason.

## This slice's share of the Phase 8 definition of done

Phase 8's DoD is one long sentence (spec:2294). This slice owns three of its clauses verbatim: *"Σ payslip net = salaries-payable credit"*, *"each scheme's schedule = its payable to the cent"* and *"`employee_ytd` rebuilds bit-identically"*.

| Clause | Where it becomes true |
|---|---|
| **"Σ payslip net = salaries-payable credit"** | **Task 8**, acceptance test 30, in `tests/invariants/payslip-ties-to-ledger.test.ts`: for every employee in a posted run, the net figure `readPayrollRun` reports equals the `2400` credit on `ledger_entry` tagged with that employee's EMPLOYEE dimension value, and Σ over the run equals the account's period movement in `account_balance`. |
| **"each scheme's schedule = its payable to the cent"** | **Task 7** generates `statutory_schedule` from posted `payroll_line` rows only, and **Task 8 Step 4** asserts `total_employee + total_employer` equals the credit movement on that scheme's `241n` payable account for the same period, to the cent. |
| **"a remittance for a different amount is refused"** (test 30's fourth clause) | **Task 8 Step 5**: `app.assert_remittance_matches_schedule()` — the 0091 trigger — raises `ERR_PAYROLL_REMITTANCE_MISMATCH` when a PAYMENT whose `1100` leg differs from `total_employee + total_employer` is written into `statutory_schedule.remittance_document_id`, **through the service and through direct `app_rw` SQL**. The trigger's `UPDATE OF` list is **three columns — `remittance_document_id, total_employee, total_employer`** — so moving a settled schedule's totals is refused by the same rule: a row may not go on claiming it was settled for an amount it no longer holds. Task 8 Step 5's last `describe` is where both halves are asserted. **One operating consequence, stated once and asserted in Task 8 Step 6:** because the guard measures the payment's *whole* bank leg, **one PAYMENT settles exactly one schedule**. Where an authority owns two schemes the officer writes two remittances. That is the right shape anyway — 8A made `statutory_scheme.payable_account_id` **nullable** (its amendment A2), so a guard on the scheme's payable leg would have a null branch that passes vacuously, and the bank leg is the figure 4B's `Reconcilable` later matches against a statement line (§4.8.3). |
| **"`employee_ytd` rebuilds bit-identically"** | **Task 9**, acceptance test 35 and the re-run of test 2, in `tests/invariants/employee-ytd-rebuild.test.ts`: `checkEmployeeYtdProjection` rebuilds from every **posted** run through **the same `app.employee_ytd_delta` the step-12 MERGE used** and reports zero `ProjectionMismatch` rows; the nightly `hr.employee_ytd.rebuild` handler runs the same function per tenant. **`employee_ytd_opening` is on neither side of that compare** — amendment **B14**: the projection is Σ posted deltas, the opening is a cut-over figure, and a YTD *reading* is their sum, produced once by `ytdFromEmployeeYtd` (Task 3). Test 35 clause 1 asserts both halves. |
| **"Termination closes everything"** (test 34, not a DoD clause but this slice's headline row) | **Task 11**, in `tests/invariants/termination-closes-everything.test.ts`: a `terminated_on` written **by direct `app_rw` SQL** revokes `pos_cashier`, expires every `role_assignment`, writes the catalogue tombstone at the bumped revision, drops the row out of `app.pos_cashier_sync`, and the employee is absent from the next **regular** run's inputs. |

**What is deliberately *not* in this slice's DoD share:** the employee master, sensitive data, compensation, pay components, statutory schemes and rate tables (**8A**); the calculator, the `PAYROLL` document, pinning, the golden payroll and the period lock (**8B**); payslip PDFs, annual statements, the five HR reports, the leave register ⚠️, key rotation and the one-month parallel run (**8D**); the `employee_ytd_opening` **load** at cut-over (**9B** — this slice creates the table and the `upsertEmployeeYtdOpening` / `listEmployeeYtdOpening` service functions, and 9B's importer is what calls them from the legacy system; **no route and no fourth `PROBES` key** — amendment B10 fixes this slice's route surface at three modules, and an opening figure is loaded by the importer under `systemContext`, never typed into a screen).

## File Structure

```
docs/adr/
  0077-employee-ytd-is-a-posting-service-projection.md        NEW  T2  (a PROPOSAL — spec:95)
  0078-termination-is-a-trigger-and-cashiers-are-employees.md NEW  T10 (a PROPOSAL — spec:95)

packages/db/
  migrations/
    0091_create_statutory_schedule_and_remittance_guard.sql   NEW  T1  (amendment B1)
    0091.down.sql                                             NEW  T1
    0092_create_employee_ytd.sql                              NEW  T2
    0092.down.sql                                             NEW  T2
    0093_create_termination_trigger.sql                       NEW  T10
    0093.down.sql                                             NEW  T10
    0094_create_cashier_is_employee_constraint.sql            NEW  T11
    0094.down.sql                                             NEW  T11
    0095_seed_permission_phase8c.sql                          NEW  T4
    0095.down.sql                                             NEW  T4
  src/
    schema/statutory-schedule.ts        NEW  T1   — Drizzle mirror (reads only)
    schema/employee-ytd.ts              NEW  T2   — Drizzle mirrors for both YTD tables
    lint-schema.ts                      EDIT T1, T2 — §3.5.3's exact state for this slice
    posting/ytd.ts                      NEW  T3   — mergeEmployeeYtd (posting-service only)
    posting/post.ts                     EDIT T3   — §4.3.2 step 12 gains the PAYROLL branch
    posting/index.ts                    EDIT T3   — re-export mergeEmployeeYtd
    integrity/employee-ytd.ts           NEW  T9   — checkEmployeeYtdProjection, EMPLOYEE_YTD_CHECK
    integrity/index.ts                  EDIT T9   — registerProjectionCheck(EMPLOYEE_YTD_CHECK)
    hr/money-out.ts                     NEW  T6   — createPayrollPayment, createEmployeeAdvance, readMoneyOut
    hr/batch-csv.ts                     NEW  T6   — payrollBatchCsv (bank-neutral, spec:2083)
    hr/schedule.ts                      NEW  T7   — generateStatutorySchedule, scheduleCsv, listSchedules, readSchedule
    hr/remittance.ts                    NEW  T8   — settleStatutorySchedule, unsettleStatutorySchedule
    hr/ytd.ts                           EDIT T3   — ytdFromEmployeeYtd beside 8B's ytdFromPostedLines
    hr/reconcilable.ts                  NEW  T12  — PAYROLL_BATCH_SOURCE (amendment B12)
    hr/opening.ts                       NEW  T9   — upsertEmployeeYtdOpening, listEmployeeYtdOpening
    index.ts                            EDIT T1, T2, T3, T6, T7, T8, T9, T12 — re-exports
  seed/my/document-types/
    PAYROLL_PAYMENT.json                NEW  T5   — the §4.3.7 envelope
    EMPLOYEE_ADVANCE.json               NEW  T5   — the §4.3.7 envelope
  test/
    hr/statutory-schedule-table.test.ts NEW  T1   — DDL, RLS, isolation, the remittance guard
    hr/employee-ytd-table.test.ts       NEW  T2   — DDL, RLS, isolation, the delta function
    hr/ytd-merge.test.ts                NEW  T3   — step 12, and the posting-only lint
    hr/permissions-8c.test.ts           NEW  T4   — the two codes, their role grants, POLICY_RESOLVED_CODES
    hr/money-out-types.test.ts          NEW  T5   — the two §4.3.7 envelopes, and hazard 33's account check
    hr/money-out.test.ts                NEW  T6
    hr/schedule.test.ts                 NEW  T7
    hr/remittance.test.ts               NEW  T8
    hr/employee-ytd-opening.test.ts     NEW  T9
    hr/termination.test.ts              NEW  T10
    hr/cashier-is-employee.test.ts      NEW  T11
    hr/reconcilable.test.ts             NEW  T12
    permission-catalogue.test.ts        (unchanged — T4 re-runs it)
    schema-lint.test.ts                 (unchanged — its "zero violations" case is the gate)
    privileges.test.ts                  (unchanged — T1/T2 re-run it; 8C grants no DELETE, §3.5.4)

packages/contracts/
  permissions.ts                        EDIT T4   — the two hr rows
  src/errors.ts                         EDIT T1   — ERR_PAYROLL_REMITTANCE_MISMATCH, with its raiser
  src/hr/payroll-payment.ts             NEW  T6
  src/hr/employee-advance.ts            NEW  T6
  src/hr/statutory-schedule.ts          NEW  T7
  openapi.json                          EDIT T6, T7 — regenerated

packages/db/seed/roles.ts               EDIT T4   — hr_payroll and accountant grants

apps/api/src/
  middleware/require-document-permission.ts EDIT T4 — POLICY_RESOLVED_CODES gains two codes
  routes/hr/payroll-payments.ts         NEW  T6
  routes/hr/employee-advances.ts        NEW  T6
  routes/hr/statutory-schedules.ts      NEW  T7
  routes/index.ts                       EDIT T6, T7 — buildRoutes mounts the three modules
apps/api/test/routes/hr/payroll-payments.test.ts     NEW  T6
apps/api/test/routes/hr/employee-advances.test.ts    NEW  T6
apps/api/test/routes/hr/statutory-schedules.test.ts  NEW  T7

apps/worker/src/
  handlers/employee-ytd-rebuild.ts      NEW  T9
  index.ts                              EDIT T9   — register the handler
apps/worker/test/handlers/employee-ytd-rebuild.test.ts        NEW  T9
apps/worker/test/handlers/integrity-check.test.ts             EDIT T9 — the pinned checked array

packages/db/src/jobs/payloads.ts        EDIT T9   — the one JobPayload key (amendment B4)

tests/
  invariants/support/payroll-money.ts             NEW  T6  (amendment B3)
  invariants/probes.ts                            EDIT T6, T7, T9 — three PROBES, one JOB_PROBES
  invariants/payslip-ties-to-ledger.test.ts       NEW  T8  — acceptance test 30
  invariants/employee-ytd-rebuild.test.ts         NEW  T9  — acceptance test 35, re-run of test 2
  invariants/termination-closes-everything.test.ts NEW T11 — acceptance test 34
  invariants/money-out-sod.test.ts                NEW  T12 — re-runs of tests 31 and 39
  invariants/audit-chain.test.ts                  EDIT T9  — the pinned checked array
  invariants/projection-rebuild.test.ts           EDIT T9  — the pinned checked array
  regression/legacy-004.test.ts                      EDIT T9  (3B's file)
  regression/legacy-011.test.ts                      EDIT T8  (1A's file)
  regression/legacy-016.test.ts                      EDIT T9  (3B's file)
  regression/legacy-019.test.ts                      EDIT T8  (0D's file)
  regression/legacy-021.test.ts                      EDIT T11 (0B's file)
  regression/legacy-044.test.ts                      EDIT T10 (0B's file)

scripts/lint/rules/posting-only-tables.ts         EDIT T2  — app.employee_ytd joins the table list
scripts/lint/rules/dependency-rule.ts             EDIT T1  — amendment B15: packages/db/test/** may import tests/**
packages/db/tsconfig.json                         EDIT T1  — the two `include` entries B15's allowance needs

⚠️ owner-gate tasks — each is one droppable PR and touches nothing another task owns
packages/db/src/hr/schedule-layouts/index.ts      NEW  T13 ⚠️ OD-28 — ScheduleLayout, EmployerIdentifiers, layoutFor; registry ships EMPTY
packages/db/test/hr/schedule-layouts.test.ts      NEW  T13 ⚠️ OD-28 — four skipped shape cases + four "unverified" cases
docs/owner/statutory-layouts/README.md            NEW  T13 ⚠️ OD-28 — the request, per scheme
docs/owner/od-14-staff-purchases.md               NEW  T14 ⚠️ OD-14 — the question, the default and the change list; NO code
packages/db/test/hr/tax-year-convention.test.ts   NEW  T15 ⚠️ OD-23 — pay_date year + employer registration
apps/api/src/routes/hr/statutory-schedules.ts     EDIT T15 ⚠️ — one line in `present` for the new wire field
```

**PR boundaries.** PR 1 = T1 (migration 0091). PR 2 = T2 (0092). PR 3 = T3. PR 4 = T4 (0095). PR 5 = T5 + T6. PR 6 = T7 + T8. PR 7 = T9. PR 8 = T10 (0093). PR 9 = T11 (0094). PR 10 = T12. PR 11 = T13 ⚠️. PR 12 = T14 ⚠️. PR 13 = T15 ⚠️. **Five migrations, five of the thirteen PRs** (§3.4.3, spec:2057); the three ⚠️ PRs carry no migration and each is droppable on its own without renumbering a neighbour.

---

### Task 1: Migration 0091 — `app.statutory_schedule` and the remittance-amount guard

**Files:**
- Create: `packages/db/migrations/0091_create_statutory_schedule_and_remittance_guard.sql`, `packages/db/migrations/0091.down.sql`, `packages/db/src/schema/statutory-schedule.ts`
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`, `scripts/lint/rules/dependency-rule.ts`, `packages/db/tsconfig.json` (all three Step 1 only), `packages/db/src/lint-schema.ts`, `packages/db/src/index.ts`, `packages/contracts/src/errors.ts`
- Test: `packages/db/test/hr/statutory-schedule-table.test.ts`

**Interfaces:**
- Consumes: `startDb(opts?): Promise<Db>`, `Db`, `withTenant(sql, tenantId, actorId, fn)` (the 4-argument **test** helper), `uuidv7(sql): Promise<string>`, `seedTenantV2(db, name): Promise<Seed>`, `Seed`, `seedAccount(db, s, { code, nameEn, type })`, `lintSchema(sql): Promise<Violation[]>`, `Violation`, `AUDIT_EXEMPT` / `IMMUTABLE` (§4.1), `up` / `down` / `listApplied` / `MIGRATIONS_DIR` (§4.1), `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.current_actor`, `app.statutory_scheme` (8A), `app.payroll_run` (8B), `app.document` and `app.ledger_entry` (plan0A), `app.attachment` (2C), `ERRORS` / `ErrorDef` (§4.2.4), `seedStatutoryScheme(db, s, opts?)` (8A), `seedPayrollRun(db, s, opts)` (8B), `grantCodes(db, s, opts?)` (2B).
- Produces:

```sql
-- app.statutory_schedule — §4.6.1's row plus amendment B11's two columns.
-- app.assert_remittance_matches_schedule() — the BEFORE UPDATE trigger raising ERR_PAYROLL_REMITTANCE_MISMATCH.
```

```ts
// packages/db/src/schema/statutory-schedule.ts — the Drizzle mirror (reads only, §3.4.9)
export const statutorySchedule: PgTable;   // exported as `statutorySchedule`
```

and the `ERRORS` row `ERR_PAYROLL_REMITTANCE_MISMATCH: { status: 422, title: "Remittance does not match the schedule", remedy: "…" }`.

- [ ] **Step 1: File the fifteen contract amendments, open the §4.17.1 allowance, and assert the phase gate**

This step writes no product code. Open `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` and find the `### Round 3 —` heading under §4.18. **If it exists** (8A or 8B landed first), append rows B1–B15 to that table exactly as the "Contract amendments this plan discovered" table above states them. **If it does not exist**, create it directly under §4.18's Round 2 table with the same three-column header 8B's table uses (`| § | Name or decision | Slice | Source |`), then add the rows. Either order produces the identical file, which is why the rule is create-if-absent rather than "create" (§3.7.3's own reasoning for a slice with no fixed predecessor).

Then apply each row to its own section: §2.9's 8C row for **B1**; §4.2.6's audit-sentinel paragraph for **B2** and its `JobPayload` block for **B4**; §4.17.1 for **B3** and **B15** (B3 adds the helper-file row to the table; B15 rewrites the closing cross-workspace paragraph — apply them in one edit, since both change §4.17.1); §4.16.3 for **B5**; §4.12.8 for **B6**, **B7** and **B14** (B14 rewrites §4.12.8's *"rebuilt nightly from `employee_ytd_opening` + posted `payroll_line` rows"* sentence — apply it in the same edit as B6's, since both change that paragraph); §4.12.2 and §4.14 for **B8**; §4.3.4's `document_line.dimensions` comment for **B9**; §4.2.7's module table and §4.2.8's module table for **B10**; §4.6.1's `statutory_schedule` row for **B11**; §4.8.3 for **B12**; **§4.2.4's allocated-code table for B13**. Commit that as its own PR before anything else — a plan whose names disagree with the register is the one failure hazard 32 exists to prevent.

```bash
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "docs(contracts): record 8C amendments B1-B15 [8C T1]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Then make B15 true in the repository, in a second commit on the same PR.** An amendment row registers an allowance; it does not create one, and `bun run lint:rules` reads the rule file, not the contracts document. Ten test files in this slice — T2's `employee-ytd-table.test.ts`, T3's `ytd-merge.test.ts`, T6's `money-out.test.ts`, T7's `schedule.test.ts`, T8's `remittance.test.ts`, T9's two suites, T12's and T15's — import from `tests/support/**` or `tests/invariants/support/**` while living under `packages/db/test/`, which is inside `run.ts`'s `ROOTS`. Check first, because **3B and 8B already needed this and one of their executors may have added it ad hoc**:

```bash
grep -n "packages/db/test" scripts/lint/rules/dependency-rule.ts
grep -n "tests/" packages/db/tsconfig.json
```

If the first prints nothing, add the allowance beside the two `apps` entries, in the same shape and with its reason on the line — the importing path **and** the imported paths, both halves, exactly as 1B built it (1b:1696–1700), so `packages/db/src/**` gains nothing and no other directory under `tests/` becomes reachable:

```ts
  // packages/db/test/** may import the test tier's shared helpers: a fixture that posts through the real
  // postDocument cannot live in fixtures.ts, and packages/db may not import an app (§3.1, §4.17.1, B15).
  { from: "packages/db/test/**", to: "tests/support/**" },
  { from: "packages/db/test/**", to: "tests/invariants/support/**" },
```

— matching whatever shape `dependency-rule.ts`'s existing two allowances take; **copy their form, do not invent a second one**, and if the merged rule spells them differently, spell these the same way and record what it was in the Execution handoff table. If the second `grep` shows no `tests/` entry, add both to `packages/db/tsconfig.json`'s `include`:

```json
    "../../tests/support/**/*.ts",
    "../../tests/invariants/support/**/*.ts"
```

Then:

```bash
bun run lint:rules && bun run --cwd packages/db typecheck
git add scripts/lint/rules/dependency-rule.ts packages/db/tsconfig.json
git commit -m "chore(lint): allow packages/db/test to import the test tier's shared helpers [8C T1]

Amendment B15. 3B (3b:2713) and 8B (8b:3886, 8b:5291) already import this way;
the allowance was never registered. Both halves are named — the importing path
and the two imported paths — so packages/db/src gains nothing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

If both greps already print the entries, this commit is empty and the step is a no-op — say so and move on.

Then assert the gate:

```bash
bun run --cwd packages/db src/cli.ts status
```

**Expected:** the applied list contains **87, 88, 89, 90** (8B's range), **80–86** (8A's), **64–69** (6C's) and **48–52** (4B's). If any of those is missing, that predecessor has not merged and this plan does not start; stop and say so. The list may or may not contain 53–58 (Phase 5) or 74–79 (Phase 7) — Phase 8 may execute before or after them (spec:2301) and **no step in this plan asserts `max(version)`** (hazard 14).

- [ ] **Step 2: Write the failing test `packages/db/test/hr/statutory-schedule-table.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { grantCodes, seedAccount, seedStatutoryScheme, seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "Sched A");
  b = await seedTenantV2(db, "Sched B");
  // **Every helper below writes `app.document`, and `app.document` carries Form A `branch_isolation`
  // (`AS RESTRICTIVE`, `app.actor_in_branch(company_id, branch_id)` — 6C's migration 0068, §4.5.6).**
  // `actor_in_branch` is true only for a system principal or one with a live `role_assignment` in the
  // company, and `seedTenant` gives `s.human` none (§4.1, pinned; 6c:33 fact 2). A restrictive policy with
  // no `WITH CHECK` uses `USING` as the insert check, so without this the very first `draftPayrollShell`
  // fails with *"new row violates row-level security policy for table document"* — a message that names RLS,
  // not the missing role, and sends the reader looking at 0091 instead.
  //
  // Nothing here calls a permission-gated service; it is the `role_assignment` row `grantCodes` writes that
  // matters, and passing no `branchIds` keeps it company-wide.
  for (const s of [a, b]) await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.employee.read"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

/** Every column §4.6.1 and amendment B11 name, with its type — a table the linter passes but whose
 *  columns drifted would silently break Task 7's generator and Task 8's tie-out. */
const EXPECTED_COLUMNS: Readonly<Record<string, string>> = {
  id: "uuid", tenant_id: "uuid", company_id: "uuid", scheme_id: "uuid",
  period_start: "date", period_end: "date", payroll_document_id: "uuid",
  total_employee: "numeric", total_employer: "numeric", currency: "bpchar",
  attachment_id: "uuid", remittance_document_id: "uuid",
  generated_by: "uuid", created_at: "timestamptz",
};

describe("app.statutory_schedule (§4.6.1, amendment B11; spec:2083)", () => {
  it("has exactly the fourteen columns of §4.6.1 including B11's two, and no others", async () => {
    const rows = await db.admin<{ column_name: string; udt_name: string }[]>`
      select column_name, udt_name from information_schema.columns
       where table_schema = 'app' and table_name = 'statutory_schedule'
       order by column_name`;
    expect(Object.fromEntries(rows.map((r) => [r.column_name, r.udt_name]))).toEqual(EXPECTED_COLUMNS);
  });

  it("is unique on (scheme_id, period_start, payroll_document_id) — one schedule per scheme per period per run", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.statutory_schedule'::regclass and contype = 'u'
         and pg_get_constraintdef(oid) like '%scheme_id%'`;
    expect(c!.def).toBe("UNIQUE (scheme_id, period_start, payroll_document_id)");
  });

  it("reports zero linter violations and is neither audit-exempt nor immutable", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "statutory_schedule")).toEqual([]);
    expect(AUDIT_EXEMPT.has("statutory_schedule")).toBe(false);
    expect(IMMUTABLE.has("statutory_schedule")).toBe(false);
  });

  it("stamps generated_by from the session and refuses a supplied value (LEGACY-044)", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH" });
    const docId = await draftPayrollShell(a);
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.statutory_schedule
        (id, tenant_id, company_id, scheme_id, period_start, period_end, payroll_document_id,
         total_employee, total_employer, currency, generated_by)
      values (${id}, ${a.tenant}, ${a.company}, ${schemeId}, '2026-01-01', '2026-01-31', ${docId},
              10.0000, 20.0000, 'MYR', ${a.system})`);
    const [row] = await db.admin<{ generated_by: string }[]>`
      select generated_by from app.statutory_schedule where id = ${id}`;
    expect(row!.generated_by).toBe(a.human);          // the SESSION actor, not the supplied a.system
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const n = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.statutory_schedule`);
    expect(n[0]!.n).toBe(0);
  });
});

describe("app.assert_remittance_matches_schedule (test 30's fourth clause)", () => {
  it("refuses a remittance whose bank leg differs from total_employee + total_employer", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_M" });
    const payrollId = await draftPayrollShell(a);
    const scheduleId = await insertSchedule(a, schemeId, payrollId, "100.0000", "200.0000");
    const wrong = await postedRemittance(a, "299.0000");
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.statutory_schedule set remittance_document_id = ${wrong} where id = ${scheduleId}`))
      .rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles 300\.0000, payment .* moves 299\.0000/);
  });

  it("accepts a remittance whose bank leg equals the schedule total, to the cent", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_OK" });
    const payrollId = await draftPayrollShell(a);
    const scheduleId = await insertSchedule(a, schemeId, payrollId, "100.0000", "200.0000");
    const right = await postedRemittance(a, "300.0000");
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.statutory_schedule set remittance_document_id = ${right} where id = ${scheduleId}`);
    const [row] = await db.admin<{ remittance_document_id: string }[]>`
      select remittance_document_id from app.statutory_schedule where id = ${scheduleId}`;
    expect(row!.remittance_document_id).toBe(right);
  });

  it("refuses a remittance that is not posted", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_D" });
    const payrollId = await draftPayrollShell(a);
    const scheduleId = await insertSchedule(a, schemeId, payrollId, "5.0000", "5.0000");
    const draft = await draftPayrollShell(a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.statutory_schedule set remittance_document_id = ${draft} where id = ${scheduleId}`))
      .rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH: payment .* is not posted/);
  });
});
```

**The three helpers this file uses, at the bottom of the same file.** They are deliberately file-local, and the reason is **ordering, not permission**: `tests/invariants/support/payroll-money.ts` does not exist until Task 6, five PRs later, and this suite is what proves migration 0091 before anything consumes it. (The §4.17.1 allowance for `packages/db/test/**` **is** extended by this slice — amendment **B15**, opened in Step 1 above, because ten later suites do import the shared helpers. It is registered before the first of them is written; it simply has nothing to offer this file.) Each helper is four to twelve lines, needed by one suite, and duplicating it into `payroll-money.ts` later would put a second `draftPayrollShell` beside a real fixture — hazard 9's shape.

```ts
/** A minimal posted-shaped document of the JOURNAL type, used only as an FK target for
 *  `payroll_document_id`. The guard reads `app.document.status` and the `1100` ledger leg; the *shape*
 *  of a payroll run is Task 6's business, not this table's. */
async function draftPayrollShell(s: Seed): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.document (id, tenant_id, company_id, document_type_id, series, branch_id, status,
                              effective_date, currency, exchange_rate, created_by)
    values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', ${s.hq}, 'draft',
            '2026-01-31', 'MYR', 1, ${s.human})`);
  return id;
}

async function insertSchedule(
  s: Seed, schemeId: string, payrollId: string, employee: string, employer: string,
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.statutory_schedule
      (id, tenant_id, company_id, scheme_id, period_start, period_end, payroll_document_id,
       total_employee, total_employer, currency)
    values (${id}, ${s.tenant}, ${s.company}, ${schemeId}, '2026-01-01', '2026-01-31', ${payrollId},
            ${employee}, ${employer}, 'MYR')`);
  return id;
}

/** A document flagged posted with a CREDIT on the `1100` bank account — the leg the guard measures — and
 *  the balancing DEBIT that keeps the transaction commitable.
 *  Written with `postLines`-style direct inserts because this suite is in `packages/db/test/**`, which is
 *  on `posting-only-tables`' allow-list (§3.7.5); a production path may never do this. */
async function postedRemittance(s: Seed, amount: string): Promise<string> {
  const bank = await seedAccount(db, s, { code: "1100", nameEn: "Bank", type: "asset" });
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, branch_id, status,
                                effective_date, currency, exchange_rate, created_by, posted_by, posted_at)
      values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', ${s.hq}, 'posted',
              '2026-02-15', 'MYR', 1, ${s.human}, ${s.human}, now())`;
    await tx`
      insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id,
                                    debit, credit, currency, exchange_rate, base_debit, base_credit,
                                    effective_date, fiscal_period_id, posting_policy_id)
      values (${s.tenant}, ${s.company}, ${id}, 1, ${bank},
              0, ${amount}, 'MYR', 1, 0, ${amount}, '2026-02-15', ${s.period}, ${s.policy})`;
    // **The second leg is not optional and the suite will not commit without it.** Plan 0A attaches
    // `ledger_entry_balanced` as a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires at COMMIT
    // (§4.3.2 step 15, spec:1865), so a one-sided insert does not fail here — it fails when `withTenant`
    // returns, as `ERR_LEDGER_UNBALANCED`, several frames away from the line that caused it. `s.cash`
    // (`1000`, Plan 0A's seed) is the counter-account; the guard reads only the `1100` credit, so what the
    // debit lands on is arbitrary as long as it exists.
    await tx`
      insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id,
                                    debit, credit, currency, exchange_rate, base_debit, base_credit,
                                    effective_date, fiscal_period_id, posting_policy_id)
      values (${s.tenant}, ${s.company}, ${id}, 2, ${s.cash},
              ${amount}, 0, 'MYR', 1, ${amount}, 0, '2026-02-15', ${s.period}, ${s.policy})`;
  });
  return id;
}
```

⚠️ **`document.series` is `not null` (plan0A:1780) even on a hand-written row**, which is why the insert above names `'JV'`. Every direct `insert into app.document` in this plan carries a series for the same reason; the *value* is meaningless on a row that never goes through `issueDocument`, because `number` stays null and `document_series` is never touched.

⚠️ **`seedAccount` is idempotent on `(company_id, code)` by 1A's own contract** — the first call inserts `1100`, later calls return the existing id. If your merged `seedAccount` throws on a duplicate instead, wrap the call in a `try`/`catch` that re-reads the id and file it as a plan-side note; do **not** change `seedAccount`, which is 1A's (hazard 9).

- [ ] **Step 3: Run the test and watch it fail**

```bash
bun run --cwd packages/db test hr/statutory-schedule-table.test.ts
```

**Expected: FAIL.** The first case fails with `expected {} to deeply equal { id: 'uuid', … }` — `information_schema.columns` returns nothing because the table does not exist. Every later case fails with `relation "app.statutory_schedule" does not exist`. If instead you see a *passing* first case, migration 0091 already exists from an interrupted run: read it against Step 4 before writing anything.

- [ ] **Step 4: Write `packages/db/migrations/0091_create_statutory_schedule_and_remittance_guard.sql`**

```sql
-- 0091_create_statutory_schedule_and_remittance_guard.sql
-- §3.10.1 Outputs (spec:2083): "a monthly contribution/deduction schedule per scheme … recorded as one
-- statutory_schedule row per scheme per period (generated from posted lines only; attachment hash; the
-- remittance PAYMENT that settled it) — A RECORD, NOT A LODGEMENT STATE MACHINE."
-- There is therefore no `status` column and no transition anywhere in this file: a schedule exists, and it
-- either has a settling payment or it has not.

-- ── 1. the table (§4.6.1 + amendment B11) ───────────────────────────────────────────────────────────
create table app.statutory_schedule (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  scheme_id              uuid not null,
  period_start           date not null,
  period_end             date not null,
  payroll_document_id    uuid not null,                    -- the PAYROLL run these figures were generated from
  total_employee         numeric(19,4) not null,
  total_employer         numeric(19,4) not null,
  currency               char(3) not null,                 -- amendment B11: the totals carry no currency of their own
  attachment_id          uuid,                             -- the generated CSV and its sha256 (2C's app.attachment)
  remittance_document_id uuid,                             -- the PAYMENT that settled it (spec:2083)
  generated_by           uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at             timestamptz not null default now(),
  constraint statutory_schedule_period_check check (period_end >= period_start),
  constraint statutory_schedule_total_employee_check check (total_employee >= 0),
  constraint statutory_schedule_total_employer_check check (total_employer >= 0),
  unique (scheme_id, period_start, payroll_document_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)             references app.company(tenant_id, id),
  foreign key (tenant_id, scheme_id)              references app.statutory_scheme(tenant_id, id),
  foreign key (tenant_id, payroll_document_id)    references app.document(tenant_id, id),
  foreign key (tenant_id, attachment_id)          references app.attachment(tenant_id, id),
  foreign key (tenant_id, remittance_document_id) references app.document(tenant_id, id)
);
comment on table app.statutory_schedule is
  'spec:2083 — one row per scheme per period, generated from POSTED payroll lines only. A record, not a lodgement state machine.';
comment on column app.statutory_schedule.total_employer is
  'The employer share. A scheme with no employer share carries 0.0000 here — whether it has one is a rate-table fact (contracts §4.12.3), never a code fact.';

call app_meta.enable_tenant_rls('app.statutory_schedule');
call app_meta.attach_audit('app.statutory_schedule');
call app_meta.attach_stamp('app.statutory_schedule', 'generated_by');

create index statutory_schedule_scheme_period_idx
  on app.statutory_schedule (company_id, scheme_id, period_start);
create index statutory_schedule_payroll_idx
  on app.statutory_schedule (payroll_document_id);

-- ── 2. the remittance-amount guard (spec:2082 "refused if the amount differs from the schedule they
--       settle"; contracts §2.9's 8C card; acceptance test 30's fourth clause) ───────────────────────
-- A TRIGGER, not a handler check, because test 30 exercises "through any path" and a direct `app_rw`
-- update is one of them. It measures the PAYMENT's own bank leg rather than a stored total: a document
-- has no `total` column, the ledger is the record, and a leg is what a bank statement will later match
-- (4B's `Reconcilable`, §4.8.3). `1100` is the §4.15 bank account, seeded by 0C.
create function app.assert_remittance_matches_schedule() returns trigger language plpgsql as $$
declare
  paid   numeric(19,4);
  status app.document_status;
  total  numeric(19,4) := new.total_employee + new.total_employer;
begin
  if new.remittance_document_id is null then
    return new;
  end if;

  select d.status into status from app.document d where d.id = new.remittance_document_id;
  if status is null then
    raise exception 'ERR_PAYROLL_REMITTANCE_MISMATCH: payment % is not visible', new.remittance_document_id
      using errcode = 'check_violation';
  end if;
  if status <> 'posted' then
    raise exception 'ERR_PAYROLL_REMITTANCE_MISMATCH: payment % is not posted (status %)',
      new.remittance_document_id, status using errcode = 'check_violation';
  end if;

  -- The money that LEFT the bank on that document: credits minus debits on the company's `1100` account.
  -- coalesce, deliberately (LEGACY-011): a payment with no bank leg reads 0 and is refused by the comparison
  -- below, never NULL-propagated into a silent pass.
  select coalesce(sum(le.credit) - sum(le.debit), 0) into paid
    from app.ledger_entry le
    join app.account a on a.id = le.account_id
   where le.document_id = new.remittance_document_id
     and a.company_id = new.company_id
     and a.code = '1100';

  if paid <> total then
    raise exception
      'ERR_PAYROLL_REMITTANCE_MISMATCH: schedule % settles %, payment % moves %',
      new.id, to_char(total, 'FM999999999999990.0000'), new.remittance_document_id,
      to_char(paid, 'FM999999999999990.0000')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger statutory_schedule_remittance_guard
  before insert or update of remittance_document_id, total_employee, total_employer
    on app.statutory_schedule
  for each row execute function app.assert_remittance_matches_schedule();
```

`packages/db/migrations/0091.down.sql`:

```sql
drop trigger if exists statutory_schedule_remittance_guard on app.statutory_schedule;
drop function if exists app.assert_remittance_matches_schedule() cascade;
drop table if exists app.statutory_schedule;
```

**Three choices worth stating.**

- **`to_char(…, 'FM999999999999990.0000')` and not `%`.** PL/pgSQL's `%` on a `numeric` renders `300.0000` as `300.0000` but `300` as `300`, so the assertion regex in Step 2 would pass or fail depending on how the caller wrote the amount. The explicit format makes the message a **contract**, which is what "asserting exact error strings" means.
- **The mask carries fifteen integer positions, and that is the column's range and not a round number.** `'FM999999999999990.0000'` is the canonical money-to-text form of this whole slice — the guard's message, `employee_ytd_delta`'s jsonb strings, every `to_char` on a money column in a read. Every one of those columns is `numeric(19,4)`, which admits **fifteen** integer digits, and `to_char` renders a value that does not fit its mask as a row of `#` rather than raising. A narrower mask (`'FM9999999990.0000'`, ten positions — what an earlier draft of this plan used everywhere) would turn a figure at or above 10¹⁰ into `##########` in `by_component`, in both CSVs, in the guard's exception text and in every `/^-?\d+\.\d{4}$/` assertion, silently and only for a large tenant. No test in this slice would catch it, because `payrollFixture`'s figures are two-digit. The mask therefore matches the column, everywhere, and a `to_char` on a money column written with any other mask in this slice is a defect.
- **The guard fires on INSERT too, and on a move of either total.** A row inserted with `remittance_document_id` already set would otherwise skip it entirely, so `before insert or update of` covers both. The **column list is three names, not one**, and that is the difference between a guard and a guard with a hole in it: a column-scoped `UPDATE OF` trigger fires only when one of its named columns appears in the statement's `SET` list, so `update app.statutory_schedule set total_employee = …` on an **already-settled** row would not have fired it — the totals would move, `remittance_document_id` would stay put, and the row would go on claiming it was settled by a payment for a different amount. That is precisely the state test 30's fourth clause and the DoD clause *"each scheme's schedule = its payable to the cent"* exist to refuse, and reaching it needs no direct SQL trickery, only a second writer of the totals. Adding `total_employee, total_employer` costs nothing: the function's **first** statement returns early when `new.remittance_document_id is null`, which is every unsettled row and therefore every ordinary generation. An ordinary `attachment_id` write still pays nothing, because `attachment_id` is not on the list.
- **No `on delete` action on either document FK.** Financial rows are never deleted (spec:2049) and a posted document cannot be, so a cascade would be a mechanism with no reachable trigger.

- [ ] **Step 5: Write the Drizzle mirror `packages/db/src/schema/statutory-schedule.ts`**

Reads only (§3.4.9) — every write in this slice is a `postgres.js` tagged template.

```ts
import { char, date, index, numeric, pgSchema, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const statutorySchedule = app.table(
  "statutory_schedule",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    schemeId: uuid("scheme_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payrollDocumentId: uuid("payroll_document_id").notNull(),
    totalEmployee: numeric("total_employee", { precision: 19, scale: 4 }).notNull(),
    totalEmployer: numeric("total_employer", { precision: 19, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    attachmentId: uuid("attachment_id"),
    remittanceDocumentId: uuid("remittance_document_id"),
    generatedBy: uuid("generated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    schemePeriod: unique("statutory_schedule_scheme_id_period_start_payroll_document_id_key")
      .on(t.schemeId, t.periodStart, t.payrollDocumentId),
    schemePeriodIdx: index("statutory_schedule_scheme_period_idx")
      .on(t.companyId, t.schemeId, t.periodStart),
    payrollIdx: index("statutory_schedule_payroll_idx").on(t.payrollDocumentId),
  }),
);
```

- [ ] **Step 6: Add the one `ERRORS` row, in this same commit**

`packages/contracts/src/errors.ts` — insert the row in the object literal, keeping the file's existing ordering convention:

```ts
  ERR_PAYROLL_REMITTANCE_MISMATCH: {
    status: 422,
    title: "Remittance does not match the schedule",
    remedy: "Pay exactly the schedule's employee plus employer total, or regenerate the schedule from the posted run before settling it.",
  },
```

**It lands here and not in Task 8** because `scripts/lint/rules/error-codes.ts` scans `packages/db/migrations/**` as well as source (§4.2.4), the 0091 SQL text is what raises the token, and the check must be green at **every** commit. Adding the row in a later PR would leave 0091 raising a code that `ERRORS` does not carry; adding it earlier would leave `ERRORS` carrying a code nothing raises. Same commit, both directions satisfied.

- [ ] **Step 7: Edit `packages/db/src/lint-schema.ts` — §3.5.3's exact state, and nothing else**

`statutory_schedule` joins **no** set: it has an `id`, a `created_at`, an audit trigger and is mutable (its `attachment_id` and `remittance_document_id` are filled later). The only edit is to any literal list the file keeps of *known* tables, if your merged file has one; if it does not, this step is a **no-op and you commit nothing for it** — say so in the commit body rather than inventing a set membership (hazard 13).

```bash
grep -n "statutory_schedule\|NO_ID_TABLES\|AUDIT_EXEMPT" packages/db/src/lint-schema.ts
```

**Expected:** no line mentions `statutory_schedule`, and that is the correct final state.

- [ ] **Step 8: Re-export from `packages/db/src/index.ts`**

```ts
export { statutorySchedule } from "./schema/statutory-schedule";
```

- [ ] **Step 9: Run the migration and the test**

```bash
bun run --cwd packages/db src/cli.ts up && bun run --cwd packages/db test hr/statutory-schedule-table.test.ts
```

**Expected: PASS**, eight cases — five in the table `describe`, three in the guard `describe`. Then the three suites this table must not disturb:

```bash
bun run --cwd packages/db test schema-lint.test.ts privileges.test.ts
bun run lint:rules
```

**Expected: PASS** — `lintSchema` reports zero violations across the whole schema, the pinned DELETE list is unchanged (`["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]` — 8C grants no DELETE, §3.5.4), and `error-codes` is green because the row and its raiser landed together.

- [ ] **Step 10: Prove the down file, then commit**

```bash
bun run --cwd packages/db test privileges.test.ts -t "up → down → up"
```

**Expected: PASS** — §3.4.6's reversibility test drops to zero tables in schema `app` and rebuilds a byte-identical fingerprint, which is what catches a down file that forgot the function or the trigger.

```bash
git add packages/db/migrations/0091_create_statutory_schedule_and_remittance_guard.sql \
        packages/db/migrations/0091.down.sql \
        packages/db/src/schema/statutory-schedule.ts \
        packages/db/src/index.ts \
        packages/contracts/src/errors.ts \
        packages/db/test/hr/statutory-schedule-table.test.ts
git commit -m "feat(db): add statutory_schedule and the remittance-amount guard [8C T1]

The schedule is a record, not a lodgement state machine (spec:2083). The guard
measures the settling PAYMENT's own 1100 ledger leg and raises
ERR_PAYROLL_REMITTANCE_MISMATCH from a trigger, so a direct app_rw update is
refused the same way the service is (acceptance test 30).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0092 — `app.employee_ytd`, `app.employee_ytd_opening`, and the one delta function

**Files:**
- Create: `packages/db/migrations/0092_create_employee_ytd.sql`, `packages/db/migrations/0092.down.sql`, `packages/db/src/schema/employee-ytd.ts`, `docs/adr/0077-employee-ytd-is-a-posting-service-projection.md`
- Modify: `packages/db/src/lint-schema.ts`, `packages/db/src/index.ts`, `scripts/lint/rules/posting-only-tables.ts`
- Test: `packages/db/test/hr/employee-ytd-table.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant` (test helper), `uuidv7`, `seedTenantV2`, `Seed`, `grantCodes(db, s, opts?)` (2B — **required before any write to `app.employee` or `app.document`; see the `beforeAll` note in Step 1**), `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.current_actor`, `app.employee` (6C/8A), `app.payroll_run` / `app.payroll_line` (8B), `app.document_line` and `app.document` (1A), `sourceFiles(roots?)` and `REPO_ROOT` (§4.17.1, 0B).
- Produces:

```sql
-- app.employee_ytd        — §4.12.8's projection, natural key (company_id, employee_id, tax_year)
-- app.employee_ytd_opening — the cut-over figures 9B loads, same measures plus loaded_by and source
-- app.employee_ytd_delta(p_document_id uuid) returns table (
--   company_id uuid, employee_id uuid, tax_year smallint,
--   gross numeric(19,4), net numeric(19,4), by_component jsonb, by_scheme jsonb)
--   — amendment B6: THE one aggregation, consumed by the step-12 MERGE (T3) and by the rebuild (T9).
-- app.jsonb_add_money(a jsonb, b jsonb)  returns jsonb  — key-wise addition, fixed-scale strings (T3's MERGE)
-- app.jsonb_add_scheme(a jsonb, b jsonb) returns jsonb  — the same for {employee, employer} shares
-- app.jsonb_add_money_agg(jsonb) / app.jsonb_add_scheme_agg(jsonb) — their aggregate forms (T9's rebuild)
```

```ts
// packages/db/src/schema/employee-ytd.ts
export const employeeYtd: PgTable;
export const employeeYtdOpening: PgTable;
```

- [ ] **Step 1: Write the failing test `packages/db/test/hr/employee-ytd-table.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { REPO_ROOT, sourceFiles } from "../../../../tests/support/source";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, grantCodes, seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "YTD A");
  b = await seedTenantV2(db, "YTD B");
  // **Both `human`s need a role assignment before anything may touch `app.employee`, and the reason is RLS,
  // not permissions.** 6C's migration 0068 attaches `branch_isolation` to `app.employee` in **Form A′**
  // (`app.actor_in_branch(company_id, home_branch_id)`, §4.5.6) and every one of the five forms is
  // `AS RESTRICTIVE`. `actor_in_branch` is true only for a *system* principal or one holding a live
  // `role_assignment` in that company — and `seedTenant` grants `s.human` no role, no role_permission and
  // no role_assignment at all (contracts §4.1, pinned 2026-09-07). A restrictive policy with no `WITH CHECK`
  // uses its `USING` expression as the check on INSERT, so without this line `seedMinimalEmployee` below is
  // refused outright ("new row violates row-level security policy"), and any later UPDATE would silently
  // match zero rows instead — the failure mode that costs an afternoon.
  //
  // The *codes* are almost incidental (this suite calls no gated service); it is the `role_assignment` row
  // `grantCodes` writes that makes `actor_in_branch` true. With no `role_assignment_branch` beside it the
  // assignment is company-wide, which is what a table-shape suite wants.
  for (const s of [a, b]) await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("app.employee_ytd (§4.12.8)", () => {
  it("is keyed on (company_id, employee_id, tax_year) and carries no id column", async () => {
    const [pk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.employee_ytd'::regclass and contype = 'p'`;
    expect(pk!.def).toBe("PRIMARY KEY (company_id, employee_id, tax_year)");
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'employee_ytd' and column_name = 'id'`;
    expect(cols).toEqual([]);
  });

  it("is in NO_ID_TABLES and AUDIT_EXEMPT, and is not immutable (§3.5.3)", async () => {
    const { NO_ID_TABLES } = await import("../../src/lint-schema");
    expect(NO_ID_TABLES.has("employee_ytd")).toBe(true);
    expect(AUDIT_EXEMPT.has("employee_ytd")).toBe(true);
    expect(IMMUTABLE.has("employee_ytd")).toBe(false);   // the MERGE updates it every post
  });

  it("reports zero linter violations for both new tables", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "employee_ytd" || v.table === "employee_ytd_opening"))
      .toEqual([]);
  });

  it("a second tenant cannot see either table's rows (spec:106)", async () => {
    const employeeId = await seedMinimalEmployee(a, "E-YTD-1");
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.employee_ytd (tenant_id, company_id, employee_id, tax_year, gross, net, by_component, by_scheme)
      values (${a.tenant}, ${a.company}, ${employeeId}, 2026, 100.0000, 90.0000, '{}'::jsonb, '{}'::jsonb)`);
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.employee_ytd`);
    expect(seen[0]!.n).toBe(0);
    const openings = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.employee_ytd_opening`);
    expect(openings[0]!.n).toBe(0);
  });
});

describe("app.employee_ytd_delta (amendment B6 — THE one aggregation)", () => {
  it("returns nothing for a document that is not a posted PAYROLL run", async () => {
    // **A real JOURNAL document, not a company id.** Plan 0A's `draftDocument` gives one (series `JV`,
    // §4.1). An earlier draft passed `a.company` here: it compiled, it passed, and it passed for the wrong
    // reason — no `payroll_run` row carries that id, so the assertion would have stayed green even if the
    // function stopped filtering on document type altogether. The parameter is `p_document_id uuid`; give
    // it a document id that is genuinely not a payroll run.
    const journalId = await draftDocument(db, a);
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ employee_id: string }[]>`select employee_id from app.employee_ytd_delta(${journalId})`);
    expect(rows).toEqual([]);
  });

  it("groups by (employee, tax year) and builds by_component and by_scheme in SQL", async () => {
    const { documentId, employeeId } = await postedRunWithTwoLines(a);
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{
      employee_id: string; tax_year: number; gross: string; net: string;
      by_component: Record<string, string>; by_scheme: Record<string, { employee: string; employer: string }>;
    }[]>`select employee_id, tax_year, gross::text as gross, net::text as net, by_component, by_scheme
           from app.employee_ytd_delta(${documentId})`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employee_id).toBe(employeeId);
    expect(rows[0]!.tax_year).toBe(2026);                 // amendment B7 — the year of pay_date
    expect(rows[0]!.gross).toBe("1000.0000");
    expect(rows[0]!.net).toBe("900.0000");
    expect(rows[0]!.by_component).toEqual({ BASIC: "1000.0000" });
    expect(rows[0]!.by_scheme).toEqual({ SYNTH: { employee: "100.0000", employer: "200.0000" } });
  });
});
```

**`seedMinimalEmployee` and `postedRunWithTwoLines`, file-local, at the bottom of the same file.** They insert rows directly on `db.rw` — legal here because `packages/db/test/**` is on `posting-only-tables`' allow-list (§3.7.5) and the point of this suite is the **table and the function**, not the run service, which is 8B's and is exercised end-to-end from Task 3 onward.

```ts
async function seedMinimalEmployee(s: Seed, number: string): Promise<string> {
  const partyId = await uuidv7(db.admin);
  const employeeId = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.party (id, tenant_id, company_id, kind, code, name_en)
      values (${partyId}, ${s.tenant}, ${s.company}, 'employee', ${number}, ${`Employee ${number}`})`;
    await tx`
      insert into app.employee (id, tenant_id, company_id, party_id, employee_number, home_branch_id, hired_on)
      values (${employeeId}, ${s.tenant}, ${s.company}, ${partyId}, ${number}, ${s.hq}, '2025-01-01')`;
  });
  return employeeId;
}

/**
 * A PAYROLL document flagged `posted` with a payroll_run (pay_date in 2026) and three payroll_line rows:
 * one earning of 1000, one employee scheme share of 100, one employer share of 200, plus the net-pay
 * `account` line of 900. Every figure is invented for this test; none is a statutory rate (hazard 1).
 */
async function postedRunWithTwoLines(s: Seed): Promise<{ documentId: string; employeeId: string }> {
  const employeeId = await seedMinimalEmployee(s, "E-YTD-2");
  const componentId = await uuidv7(db.admin);
  const schemeId = await uuidv7(db.admin);
  const documentId = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.pay_component (id, tenant_id, company_id, code, name_en, kind)
      values (${componentId}, ${s.tenant}, ${s.company}, 'BASIC', 'Basic salary', 'earning')`;
    await tx`
      insert into app.statutory_scheme (id, tenant_id, company_id, code, name_en, payable_account_id, rounding_mode)
      values (${schemeId}, ${s.tenant}, ${s.company}, 'SYNTH', 'Synthetic scheme', ${s.cash}, 'HALF_AWAY_FROM_ZERO')`;
    await tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, branch_id, status,
                                effective_date, currency, exchange_rate, created_by, posted_by, posted_at)
      values (${documentId}, ${s.tenant}, ${s.company}, ${s.docType}, 'PAY', ${s.hq}, 'posted',
              '2026-01-31', 'MYR', 1, ${s.human}, ${s.human}, now())`;
    await tx`
      insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date, pinned_tables)
      values (${documentId}, ${s.tenant}, ${s.company}, 'regular', '2026-01-01', '2026-01-31', '2026-02-05', '[]'::jsonb)`;
    const lines: [number, string, string, string | null, string | null, string | null][] = [
      [1, "payroll", "1000.0000", componentId, null, null],
      [2, "payroll", "100.0000", null, schemeId, "employee"],
      [3, "payroll", "200.0000", null, schemeId, "employer"],
      [4, "account", "900.0000", null, null, null],
    ];
    for (const [lineNo, kind, amount, component, scheme, share] of lines) {
      const lineId = await uuidv7(db.admin);
      await tx`
        insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount, credit)
        values (${lineId}, ${s.tenant}, ${s.company}, ${documentId}, ${lineNo}, ${kind}, ${amount},
                ${lineNo === 4 ? amount : "0"})`;
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id,
                                      component_id, scheme_id, share, amount)
        values (${lineId}, ${s.tenant}, ${s.company}, ${employeeId}, ${component}, ${scheme}, ${share}, ${amount})`;
    }
  });
  return { documentId, employeeId };
}
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
bun run --cwd packages/db test hr/employee-ytd-table.test.ts
```

**Expected: FAIL** — the first case fails with `relation "app.employee_ytd" does not exist`, and the `NO_ID_TABLES` case fails with `The requested module '../../src/lint-schema' does not provide an export named 'NO_ID_TABLES'` **if** your merged `lint-schema.ts` keeps that set private. If that is what you see, export it in Step 4 — §4.1 already exports `AUDIT_EXEMPT` and `IMMUTABLE` from the same file and §3.5.3 treats all six sets as one pre-declared surface, so exporting the third is additive and breaks nothing.

- [ ] **Step 3: Write `packages/db/migrations/0092_create_employee_ytd.sql`**

```sql
-- 0092_create_employee_ytd.sql
-- §3.10.1 Year-to-date (spec:2084): "employee_ytd (per employee per tax year) is a projection rebuilt from
-- posted lines nightly and compared (D14); employee_ytd_opening rows are loaded at cut-over so a mid-year
-- switch computes PCB correctly (Phase 9)."
-- contracts §4.12.8: MERGE'd by the PAYROLL posting at §4.3.2 step 12, alongside account_balance and
-- stock_on_hand. spec:1978 groups it with account_balance/cost_layer and spec:98 forbids writing such a
-- table outside the posting service — enforced from this PR by `posting-only-tables` (§3.7.5).

-- ── 1. the projection ───────────────────────────────────────────────────────────────────────────────
create table app.employee_ytd (
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  employee_id   uuid not null,
  tax_year      smallint not null,
  gross         numeric(19,4) not null default 0,
  net           numeric(19,4) not null default 0,
  by_component  jsonb not null default '{}'::jsonb,   -- {"<pay_component.code>": "<amount>"}
  by_scheme     jsonb not null default '{}'::jsonb,   -- {"<statutory_scheme.code>": {"employee": "…", "employer": "…"}}
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (company_id, employee_id, tax_year),
  constraint employee_ytd_tax_year_check check (tax_year between 2000 and 2200),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);
comment on table app.employee_ytd is
  'contracts §4.12.8 — a POSTING-SERVICE projection. Written only by postDocument step 12 and rebuilt by hr.employee_ytd.rebuild; never by a handler (spec:98).';
comment on column app.employee_ytd.tax_year is
  'amendment B7 — the calendar year of payroll_run.pay_date. A convention this slice fixes and OD-23 confirms; NOT a statutory claim.';

call app_meta.enable_tenant_rls('app.employee_ytd');
-- No attach_audit: AUDIT_EXEMPT (§3.5.3), like account_balance and stock_on_hand — a derived row whose
-- before/after image is a second copy of a figure the ledger already carries.

-- ── 2. the cut-over openings 9B loads (spec:2084) ───────────────────────────────────────────────────
-- NOT audit-exempt and NOT posting-service-only: this is a LOADED figure, entered by a human or by the
-- Phase 9 importer, and "who loaded which opening from where" is exactly what an audit row is for.
create table app.employee_ytd_opening (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  employee_id   uuid not null,
  tax_year      smallint not null,
  gross         numeric(19,4) not null default 0,
  net           numeric(19,4) not null default 0,
  by_component  jsonb not null default '{}'::jsonb,
  by_scheme     jsonb not null default '{}'::jsonb,
  source        text not null,                        -- 'legacy:<run>' (9B) or 'manual:<reason>'
  loaded_by     uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at    timestamptz not null default now(),
  constraint employee_ytd_opening_tax_year_check check (tax_year between 2000 and 2200),
  constraint employee_ytd_opening_source_check check (length(source) between 1 and 200),
  unique (company_id, employee_id, tax_year),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);
comment on table app.employee_ytd_opening is
  'spec:2084 — the cut-over figures a mid-year switch starts from. Loaded by 9B''s importer through upsertEmployeeYtdOpening; audited, because a loaded figure has a provenance.';

call app_meta.enable_tenant_rls('app.employee_ytd_opening');
call app_meta.attach_audit('app.employee_ytd_opening');
call app_meta.attach_stamp('app.employee_ytd_opening', 'loaded_by');

-- ── 3. THE one aggregation (amendment B6) ───────────────────────────────────────────────────────────
-- Consumed by §4.3.2 step 12's MERGE and by the nightly rebuild. One function, two callers: two
-- hand-written jsonb aggregations would differ on numeric text formatting the first time a share ended
-- in a trailing zero, and "employee_ytd rebuilds bit-identically" (the Phase 8 DoD) would be false.
--
-- `jsonb_object_agg` over `to_char(…, 'FM999999999999990.0000')` rather than over the numeric itself: jsonb
-- stores a numeric as `numeric` and renders it by Postgres's own rules, so 100.0000 and 100.00 would be
-- the same jsonb value written two ways. A fixed-scale STRING is the same discipline `Money.toString()`
-- applies in TypeScript (§4.2.1) and is what makes a row-for-row jsonb comparison meaningful.
--
-- **The sign convention, stated here because every consumer depends on it.** `payroll_line.amount` is a
-- MAGNITUDE — 8B constrains it `>= 0` (8b:506) because §4.4.2 A9 makes `side` the sole carrier of direction
-- — so no measure below infers a direction from it. `net` is nevertheless SIGNED, and the sign comes from
-- the source line's own `document_line.debit` / `document_line.credit` pair: 8B's rule 6 credits the net-pay
-- `account` line and its rule 7 debits it, and rule 7 exists precisely so a `supplementary` run can carry a
-- NEGATIVE net for an over-payment being recovered (8b:1526–1528). `credit - debit` is therefore the
-- projection arithmetic that makes a correction move `employee_ytd.net` DOWN, which is what ADR 0077's
-- decision 5 promises and what `legacy-016`'s 8C block asserts.
-- `gross`, `by_component` and `by_scheme` stay MAGNITUDES and can only grow: a `kind = 'payroll'` line
-- carries no `debit`/`credit` at all in 8B's model, so there is no direction to read and no negative earning
-- to represent. A correction that must reduce a gross figure is not expressible in 8B's frozen line shapes
-- and would be an amendment to §4.12.6, not a change here.
--
-- **The status predicate admits `issued` as well as `posted`, and it has to.** §4.3.2 fixes the order:
-- step 7 issues, step 12 MERGEs, step **13** writes `status = 'posted'`. A function that demanded
-- `status = 'posted'` would therefore return zero rows every time step 12 called it, the projection would
-- never be maintained at all, and the only symptom would be a nightly rebuild reporting every employee as
-- `missing_in_projection`. A draft or submitted run still contributes nothing (spec:2083 "generated from
-- posted lines only"), which is what keeps step 12 safe to call unconditionally; the REBUILD (T9) narrows
-- to `status = 'posted'` in its own document list, because by then every contributing run has finished
-- posting and an `issued`-but-never-posted run must not appear on either side of the comparison.
create function app.employee_ytd_delta(p_document_id uuid)
returns table (
  company_id   uuid,
  employee_id  uuid,
  tax_year     smallint,
  gross        numeric(19,4),
  net          numeric(19,4),
  by_component jsonb,
  by_scheme    jsonb
)
language sql stable as $$
  with run as (
    select r.company_id, extract(year from r.pay_date)::smallint as tax_year
      from app.payroll_run r
      join app.document d on d.id = r.document_id
     where r.document_id = p_document_id
       and d.status in ('issued', 'posted')
  ),
  line as (
    select pl.employee_id, pl.amount, pl.share,
           dl.debit, dl.credit,                    -- the DIRECTION of an `account` line; see the sign note above
           pc.code as component_code, pc.kind as component_kind,
           ss.code as scheme_code, dl.kind as line_kind
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      left join app.pay_component     pc on pc.id = pl.component_id
      left join app.statutory_scheme  ss on ss.id = pl.scheme_id
     where dl.document_id = p_document_id
       and exists (select 1 from run)
  ),
  per_employee as (
    select l.employee_id,
           -- Gross is the sum of EARNING components. A deduction reduces net, never gross; an employer
           -- share is the employer's cost and is in neither (spec:2101).
           coalesce(sum(l.amount) filter (where l.component_kind = 'earning'), 0)::numeric(19,4) as gross,
           -- Net is the `account` line the run service writes per employee — the credit to salaries
           -- payable, MINUS any debit on the same shape. It is read, not recomputed, so this projection
           -- and the ledger cannot disagree, and a supplementary run's debit net moves it down.
           coalesce(sum(l.credit - l.debit) filter (where l.line_kind = 'account'), 0)::numeric(19,4) as net
      from line l
     group by l.employee_id
  ),
  -- TWO stages, and it must be two: `jsonb_object_agg(k, sum(v))` nests one aggregate inside another and
  -- Postgres rejects it outright (42803, "aggregate function calls cannot be nested"). The first stage
  -- sums per (employee, component) — a component may legitimately appear on more than one line of one run
  -- for one employee, two ad-hoc allowance lines say — and the second folds those sums into one object per
  -- employee. Doing it in one pass would either drop the second line's amount or raise a duplicate key.
  per_component as (
    select l.employee_id, l.component_code, sum(l.amount) as amount
      from line l
     where l.component_code is not null
     group by l.employee_id, l.component_code
  ),
  components_rolled as (
    select c.employee_id,
           jsonb_object_agg(c.component_code, to_char(c.amount, 'FM999999999999990.0000')) as by_component
      from per_component c
     group by c.employee_id
  ),
  schemes as (
    select l.employee_id, l.scheme_code,
           to_char(coalesce(sum(l.amount) filter (where l.share = 'employee'), 0), 'FM999999999999990.0000') as employee_share,
           to_char(coalesce(sum(l.amount) filter (where l.share = 'employer'), 0), 'FM999999999999990.0000') as employer_share
      from line l
     where l.scheme_code is not null
     group by l.employee_id, l.scheme_code
  ),
  schemes_rolled as (
    select s.employee_id,
           jsonb_object_agg(s.scheme_code,
             jsonb_build_object('employee', s.employee_share, 'employer', s.employer_share)) as by_scheme
      from schemes s
     group by s.employee_id
  )
  select r.company_id, p.employee_id, r.tax_year, p.gross, p.net,
         coalesce(cr.by_component, '{}'::jsonb), coalesce(sr.by_scheme, '{}'::jsonb)
    from per_employee p
    cross join run r
    left join components_rolled cr on cr.employee_id = p.employee_id
    left join schemes_rolled    sr on sr.employee_id = p.employee_id
$$;
grant execute on function app.employee_ytd_delta(uuid) to app_rw;

create index employee_ytd_company_year_idx on app.employee_ytd (company_id, tax_year);
create index employee_ytd_opening_company_year_idx on app.employee_ytd_opening (company_id, tax_year);

-- ── 4. jsonb money arithmetic — the two binary helpers the step-12 MERGE uses (T3) ──────────────────
-- `||` would REPLACE a key rather than add to it, so a February run would overwrite January's BASIC
-- instead of accumulating it. These two do the addition, keeping the fixed-scale string form
-- app.employee_ytd_delta produces so the projection and its rebuild compare byte for byte.
--
-- They live HERE, in the migration that created the tables they serve, and not in a later file appended
-- to this one: §3.4.7 forbids editing an applied migration, Plan 0A's runner skips a version already in
-- app_meta.schema_migration (plan0A:736–748), and a database that applied 0092 before the addition would
-- never receive it. Everything about them is known at this task, so nothing is gained by deferring them.
--
-- `#>> '{}'` and not `->>`: `jsonb_each` yields the value as `jsonb`; `->>` extracts a FIELD of an object
-- and is wrong here, while `#>> '{}'` is the documented way to render a scalar jsonb as text. Getting it
-- wrong returns NULL for every component and silently zeroes `by_component` — LEGACY-011 in a new place, which
-- is why Task 3's fourth case asserts the string form and not only the total.
-- **`stable`, not `immutable`, and the label is a claim rather than a preference.** Both helpers build
-- their result with `to_char(numeric, text)`, which PostgreSQL marks STABLE (`provolatile = 's'`) because
-- its output depends on `lc_numeric`. A function is never more volatility-stable than what it calls, and
-- PostgreSQL does not verify the declaration — it takes the author's word and then makes constant-folding
-- and inlining decisions on it. Nothing here needs immutability: `create aggregate` places no volatility
-- requirement on its `sfunc` (section 5), the MERGE and the rebuild both call these inside a normal query,
-- and neither is an index expression. So the stronger label would buy nothing and assert something untrue.
create function app.jsonb_add_money(a jsonb, b jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(k, to_char(v, 'FM999999999999990.0000')), '{}'::jsonb)
    from (
      select k, sum(v) as v
        from (
          select key as k, (value #>> '{}')::numeric as v from jsonb_each(coalesce(a, '{}'::jsonb))
          union all
          select key as k, (value #>> '{}')::numeric as v from jsonb_each(coalesce(b, '{}'::jsonb))
        ) parts
       group by k
    ) summed
$$;

-- `stable` for the same reason as its neighbour: `to_char(numeric, text)` is STABLE.
create function app.jsonb_add_scheme(a jsonb, b jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_object(
           'employee', to_char(sum(e), 'FM999999999999990.0000'),
           'employer', to_char(sum(r), 'FM999999999999990.0000'))), '{}'::jsonb)
    from (
      select key as k, (value ->> 'employee')::numeric as e, (value ->> 'employer')::numeric as r
        from jsonb_each(coalesce(a, '{}'::jsonb))
      union all
      select key as k, (value ->> 'employee')::numeric as e, (value ->> 'employer')::numeric as r
        from jsonb_each(coalesce(b, '{}'::jsonb))
    ) parts
   group by k
$$;
grant execute on function app.jsonb_add_money(jsonb, jsonb) to app_rw;
grant execute on function app.jsonb_add_scheme(jsonb, jsonb) to app_rw;

-- ── 5. the AGGREGATE forms the rebuild folds a whole year's deltas with (T9) ────────────────────────
-- Postgres builds an aggregate from an existing binary state function in one statement each, and reusing
-- **the very functions the MERGE uses** is what keeps the maintained and rebuilt objects byte-identical.
-- That is the whole reason section 4's two are functions rather than inline SQL.
create aggregate app.jsonb_add_money_agg(jsonb) (
  sfunc = app.jsonb_add_money, stype = jsonb, initcond = '{}'
);
create aggregate app.jsonb_add_scheme_agg(jsonb) (
  sfunc = app.jsonb_add_scheme, stype = jsonb, initcond = '{}'
);
-- The rebuild runs as `app_rw` inside `withTenant`, exactly as the MERGE does, so both aggregates carry
-- the same explicit grant every other function in this slice does.
grant execute on function app.jsonb_add_money_agg(jsonb) to app_rw;
grant execute on function app.jsonb_add_scheme_agg(jsonb) to app_rw;
```

`packages/db/migrations/0092.down.sql` — **seven statements, in reverse dependency order**: the two aggregates before the two state functions they were built from, then the delta function, then the two tables (`employee_ytd_opening` before `employee_ytd` only for symmetry with the create order — neither references the other):

```sql
drop aggregate if exists app.jsonb_add_scheme_agg(jsonb);
drop aggregate if exists app.jsonb_add_money_agg(jsonb);
drop function if exists app.jsonb_add_scheme(jsonb, jsonb);
drop function if exists app.jsonb_add_money(jsonb, jsonb);
drop function if exists app.employee_ytd_delta(uuid);
drop table if exists app.employee_ytd_opening;
drop table if exists app.employee_ytd;
```

**Everything 0092 will ever contain is in this one file, and that is a rule and not a preference.** An earlier draft of this plan created the two binary functions in Task 3 and the two aggregates in Task 9 by *appending sections to a migration that had already been committed and run*. Plan 0A's `up()` skips any version already recorded in `app_meta.schema_migration` (plan0A:736–748), so any database that applied 0092 at Task 2 would never have received them; spec:2057 makes production forward-only; and §3.4.7 forbids editing an applied migration — a rule this plan itself states in Task 15. All four objects are fully known here, nothing about them depends on Task 3 or Task 9, and "one migration per PR" (Global Constraint 19) means 0092 is written once, in PR 2, and never touched again.

- [ ] **Step 4: Edit `packages/db/src/lint-schema.ts` — §3.5.3's exact state**

**One edit, and no others (hazard 13):**

```ts
// `employee_ytd` is a derived projection with a natural key — the account_balance / stock_on_hand shape.
export const NO_ID_TABLES = new Set([ /* … existing members, unchanged … */ , "employee_ytd"]);
```

**`AUDIT_EXEMPT` is NOT touched, and that is §3.5.3's instruction rather than an omission.** Its row for `employee_ytd` reads `NO_ID_TABLES` **yes**, `AUDIT_EXEMPT` **already** — the same table writes **add** for `stock_on_hand`, `party_ageing` and `tax_transaction`, so the distinction is deliberate. Plan 0A shipped the set with the member in it: `AUDIT_EXEMPT = new Set(["ledger_entry", "ledger_entry_dimension", "inventory_movement", "document_event", "audit_log", "account_balance", "cost_layer", "cost_consumption", "employee_ytd", "idempotency_key", "permission"])` (plan0A:2706–2709). Adding it again would put a duplicate literal into a `Set` on the file hazard 13 names as a merge hotspot — harmless at run time, which is exactly why it would survive review, and misleading for ever after about who owns the membership. **Step 1's `expect(AUDIT_EXEMPT.has("employee_ytd")).toBe(true)` is the pin**, and it is green before this step and after it — it asserts the declared state rather than this slice's contribution to it, which is the right assertion for a membership another plan already made true.

`NO_CREATED_AT_TABLES` is **derived** (`new Set([...NO_ID_TABLES, "ledger_entry"])`, plan0A:2702) and is not rewritten — `employee_ytd` joins it automatically by joining `NO_ID_TABLES`, which is exactly §3.5.3's stated mechanism. It nevertheless **has** a `created_at`, and that is fine: the set is what the linter *permits* to lack one, not what must.

If `NO_ID_TABLES` is not currently exported, add `export` to its declaration in this step (Step 2's expected failure names this).

- [ ] **Step 5: Edit `scripts/lint/rules/posting-only-tables.ts` — `app.employee_ytd` joins the protected list**

§3.7.5 already names it ("`app.employee_ytd` (added by 8C with the table)"); this is the PR that adds it.

```ts
const PROTECTED = [
  "app.ledger_entry", "app.ledger_entry_dimension", "app.inventory_movement",
  "app.cost_layer", "app.cost_consumption", "app.account_balance", "app.stock_on_hand",
  "app.tax_transaction",
  "app.employee_ytd",        // 8C — spec:1978 groups it with account_balance; spec:98 forbids the rest
];
```

**`app.employee_ytd_opening` is deliberately absent.** It is a loaded figure written by 9B's importer through Task 9's `upsertEmployeeYtdOpening`, which does not live under `packages/db/src/posting/**`; putting it on the list would make 9B unimplementable and would be protecting the wrong thing.

- [ ] **Step 6: Write the Drizzle mirrors `packages/db/src/schema/employee-ytd.ts`**

```ts
import { index, jsonb, numeric, pgSchema, primaryKey, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const employeeYtd = app.table(
  "employee_ytd",
  {
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    taxYear: smallint("tax_year").notNull(),
    gross: numeric("gross", { precision: 19, scale: 4 }).notNull(),
    net: numeric("net", { precision: 19, scale: 4 }).notNull(),
    byComponent: jsonb("by_component").notNull(),
    byScheme: jsonb("by_scheme").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companyId, t.employeeId, t.taxYear] }),
    companyYear: index("employee_ytd_company_year_idx").on(t.companyId, t.taxYear),
  }),
);

export const employeeYtdOpening = app.table(
  "employee_ytd_opening",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    taxYear: smallint("tax_year").notNull(),
    gross: numeric("gross", { precision: 19, scale: 4 }).notNull(),
    net: numeric("net", { precision: 19, scale: 4 }).notNull(),
    byComponent: jsonb("by_component").notNull(),
    byScheme: jsonb("by_scheme").notNull(),
    source: text("source").notNull(),
    loadedBy: uuid("loaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    natural: unique("employee_ytd_opening_company_id_employee_id_tax_year_key")
      .on(t.companyId, t.employeeId, t.taxYear),
    companyYear: index("employee_ytd_opening_company_year_idx").on(t.companyId, t.taxYear),
  }),
);
```

- [ ] **Step 7: Re-export and write ADR 0077**

`packages/db/src/index.ts`:

```ts
export { employeeYtd, employeeYtdOpening } from "./schema/employee-ytd";
```

`docs/adr/0077-employee-ytd-is-a-posting-service-projection.md`, in Plan 0A's format (plan0A:189–203):

```markdown
# ADR 0077 — `employee_ytd` is a posting-service projection with one aggregation

- **Status:** PROPOSED (spec:95 — this touches money semantics and the data model, so it is asked before it is relied on)
- **Date:** 2026-09-05
- **Slice:** 8C

## Context

spec:2084 makes `employee_ytd` "a projection rebuilt from posted lines nightly and compared (D14)".
contracts §4.12.8 puts its MERGE at §4.3.2 **step 12**, beside `account_balance` and `stock_on_hand`, and
spec:1978 groups the three; spec:98 then forbids writing such a table outside the posting service. The Phase 8
definition of done requires it to rebuild **bit-identically**.

Two figures in it are `jsonb` objects — `by_component` and `by_scheme` — and jsonb has no canonical text form
for a `numeric`. A MERGE that built them one way and a rebuild that built them another would agree on every
`gross` and `net` and disagree on the objects, intermittently, only when an amount ended in a trailing zero.

## Decision

1. `app.employee_ytd` is written **only** by `packages/db/src/posting/**` — the step-12 MERGE, and nothing
   else. `scripts/lint/rules/posting-only-tables.ts` enforces it, and its allow-list for that table is
   `packages/db/src/posting/**`, `packages/db/src/costing/**`, `packages/db/test/**` and
   `scripts/lint/rules/**` (§3.7.5); **`packages/db/src/integrity/**` is not on it and must not be.** The
   nightly rebuild in `integrity/**` **reads and compares and never writes**: `checkEmployeeYtdProjection`
   folds the posted deltas into a session-local `create temp table`, compares it row for row with the
   projection, and returns `ProjectionMismatch` rows — the 1B/6C shape, where drift is *reported* rather
   than silently repaired. A repair path would need a writer under `posting/**` that this slice does not
   build; if one is ever wanted, it is a new function there and an amendment before it, not a mode of this
   job.
2. **One SQL function, `app.employee_ytd_delta(p_document_id uuid)`, is the only aggregation.** The MERGE and
   the rebuild both call it. Its jsonb values are fixed-scale **strings** (`to_char(…, 'FM999999999999990.0000')`),
   the same discipline `Money.toString()` applies in TypeScript.
3. **`tax_year` is the calendar year of `payroll_run.pay_date`** (amendment B7) — a convention, confirmed by
   the owner under OD-23 ("pay-period/pay-date conventions", spec:2407). **No statutory rule follows from it**
   and none is stated here.
4. `app.employee_ytd_opening` is **not** in the protected set: it is a loaded figure with a provenance, is
   audited, and is written through `upsertEmployeeYtdOpening` (T9) — by 9B's importer at cut-over, which is
   the loader spec:2084 names. **There is no route for it**: amendment B10 fixes this slice's API surface at
   three modules, and an opening figure is loaded under `systemContext`, never typed into a screen.
   **An opening is never merged into `app.employee_ytd` and never appears in the rebuild** (amendment B14).
   The projection is Σ posted deltas on both sides of the compare; the opening is added at READ time, in one
   place — `ytdFromEmployeeYtd`. The alternative was tried on paper and is unbuildable: only
   `packages/db/src/posting/**` may write `app.employee_ytd` (spec:98, §3.7.5, and T2 puts the table on that
   list), so `upsertEmployeeYtdOpening` — which lives in `packages/db/src/hr/**` — cannot seed it, and an
   opening that reached only the rebuild would report every cut-over employee as permanent drift. spec:2453's
   *"rebuilt from opening rows plus posted lines"* is therefore a statement about the **reading**, and T9's
   test 35 clause 1 asserts exactly that: the opening perturbs neither side of the compare, and
   `ytdFromEmployeeYtd` returns projection + opening.
5. There is **no un-MERGE path**, because `PAYROLL` refuses reversal (8B, ADR 0076): a correction is a
   `supplementary` run whose own delta is MERGE'd like any other. **A supplementary run's `net` delta may be
   negative and the MERGE adds it**, which is why the columns carry no non-negative CHECK. The sign is read
   from the source line's own `document_line.debit` / `credit` — 8B's rule 7 is the debit half of the
   net-pay pair and exists for exactly this correction (8b:1526–1528) — and never from
   `payroll_line.amount`, which 8B constrains `>= 0` so that §4.4.2 A9 keeps `side` as the sole carrier of
   direction. `gross`, `by_component` and `by_scheme` are magnitudes and only grow: a `kind = 'payroll'`
   line carries no direction in 8B's model, so a correction that must reduce a gross figure would be an
   amendment to §4.12.6 rather than a change to this function.

## Consequences

- A projection drift is visible rather than silent: `EMPLOYEE_YTD_CHECK` joins 1B's registry and the nightly
  `hr.employee_ytd.rebuild` reports it as the `employee_ytd_drift` audit sentinel. Neither repairs silently.
- 8B's `ytdFromPostedLines` stays as the between-slices read and is not deleted; `ytdFromEmployeeYtd` reads the
  projection and is what 8D's annual statement consumes. **They are not interchangeable and 8C does not make
  them so.** `ytdFromPostedLines` feeds 8B's calculator, whose `ytdBefore` is keyed by `ytdKey` and
  `schemeYtdKey` — per component and per scheme share, because that is what a ceiling or a cumulative
  threshold is asked against. `ytdFromEmployeeYtd` returns the two *headline* measures, `gross` and `net`,
  which is what a statement prints. Substituting one for the other inside `payrollCalculator` would hand it a
  bag with no per-scheme keys and it would read every accumulated share as zero — a wrong number, not an
  error. If a later slice wants the projection to drive the calculator, it widens this function from
  `by_component`/`by_scheme` (both are already on the row) and amends §4.12.8; 8C deliberately does not,
  because 8B's calculator is frozen and its `ytdBefore` shape is its contract.
- A change to how a component or scheme total is derived is one function, in one file, with one test.
```

- [ ] **Step 8: Run everything and commit**

```bash
bun run --cwd packages/db src/cli.ts up
bun run --cwd packages/db test hr/employee-ytd-table.test.ts schema-lint.test.ts privileges.test.ts
bun run lint:rules
bun run --cwd packages/db test privileges.test.ts -t "up → down → up"
```

**Expected: PASS** at every line. `lint:rules` is the one to watch: `posting-only-tables` now protects `app.employee_ytd`, and the **test file you just wrote inserts into it** — that is legal because `packages/db/test/**` is on the rule's allow-list (§3.7.5). If `lint:rules` reports a violation in `packages/db/test/hr/employee-ytd-table.test.ts`, your merged rule's allow-list has drifted from §3.7.5; fix the allow-list, not the test.

```bash
git add packages/db/migrations/0092_create_employee_ytd.sql packages/db/migrations/0092.down.sql \
        packages/db/src/schema/employee-ytd.ts packages/db/src/lint-schema.ts packages/db/src/index.ts \
        scripts/lint/rules/posting-only-tables.ts \
        docs/adr/0077-employee-ytd-is-a-posting-service-projection.md \
        packages/db/test/hr/employee-ytd-table.test.ts
git commit -m "feat(db): add employee_ytd, employee_ytd_opening and the one delta function [8C T2]

employee_ytd joins the posting-only table list (spec:98, spec:1978).
app.employee_ytd_delta is the single aggregation the step-12 MERGE and the
nightly rebuild both consume, so 'rebuilds bit-identically' holds by
construction (ADR 0077, a proposal).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `postDocument` step 12 — the `employee_ytd` MERGE, and the closed write list

**Files:**
- Create: `packages/db/src/posting/ytd.ts`
- Modify: `packages/db/src/posting/post.ts`, `packages/db/src/posting/index.ts`, `packages/db/src/hr/ytd.ts` (8B's file — one new export, additive), `packages/db/src/index.ts`
- Test: `packages/db/test/hr/ytd-merge.test.ts`

**Interfaces:**
- Consumes: `postDocument(tx, ctx, { documentId })` and `PostResult` (§4.3.1, 1A), `TenantContext` (§4.2.2), `app.employee_ytd_delta` (T2), `Money` / `currency` (§4.2.1), `payrollFixture(db, s)` / `PayrollFixture` / `postPayrollRun(db, s, f, input)` (8B, `tests/invariants/support/payroll.ts` — imported from `packages/db/test` by relative path, the same way 8B's own `packages/db/test/payroll/run.test.ts` does at 8b:3665), `seedTenantV2`, `grantCodes` (2B), `startDb`, `withTenant` (test helper), `ytdFromPostedLines(tx, companyId, taxYear, employeeIds)` (8B).
- Produces:

```ts
// packages/db/src/posting/ytd.ts — the ONLY writer of app.employee_ytd outside the rebuild
import type { Sql } from "postgres";

export interface EmployeeYtdMergeResult {
  /** How many (employee, tax_year) rows the MERGE inserted or updated. Zero for a non-PAYROLL document. */
  readonly rows: number;
}
/** §4.3.2 step 12, the PAYROLL branch. Idempotent per call only in the sense that `postDocument` runs it
 *  once per document; a second call would add the delta twice, which is why nothing else may call it. */
export async function mergeEmployeeYtd(tx: Sql, documentId: string): Promise<EmployeeYtdMergeResult>;

// packages/db/src/hr/ytd.ts — 8B's file, one additive export
/** Reads the PROJECTION. From this slice on, this is what a payslip and 8D's annual statement consume;
 *  8B's `ytdFromPostedLines` stays as the between-slices read and is not deleted. */
export async function ytdFromEmployeeYtd(
  tx: Sql, companyId: string, taxYear: number, employeeIds: readonly string[],
): Promise<Record<string, Record<string, Money>>>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/hr/ytd-merge.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { mergeEmployeeYtd } from "../../src/posting/ytd";
import { ytdFromEmployeeYtd } from "../../src/hr/ytd";
import { startDb, withTenant, type Db } from "../harness";
import { draftDocument, grantCodes, seedTenantV2, type Seed } from "../fixtures";
import { payrollFixture, postPayrollRun, type PayrollFixture } from "../../../../tests/invariants/support/payroll";

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: PayrollFixture;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "YTD merge");
  f = await payrollFixture(db, s);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.payroll.approve", "hr.payroll.post"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("§4.3.2 step 12 — the employee_ytd MERGE (contracts §4.12.8)", () => {
  it("writes one row per employee per tax year when a PAYROLL run posts", async () => {
    await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05", effectiveDate: "2026-01-31",
    });
    const rows = await db.admin<{ employee_id: string; tax_year: number; gross: string; net: string }[]>`
      select employee_id, tax_year, gross::text as gross, net::text as net
        from app.employee_ytd where company_id = ${s.company} order by employee_id`;
    expect(rows).toHaveLength(2);                    // payrollFixture seeds two employees
    expect(rows[0]!.tax_year).toBe(2026);
    expect(Number(rows[0]!.gross)).toBeGreaterThan(0);
    expect(Number(rows[0]!.net)).toBeGreaterThan(0);
  });

  it("ACCUMULATES a second period into the same row rather than replacing it", async () => {
    const before = await db.admin<{ employee_id: string; gross: string }[]>`
      select employee_id, gross::text as gross from app.employee_ytd
       where company_id = ${s.company} and tax_year = 2026 order by employee_id`;
    await postPayrollRun(db, s, f, {
      periodStart: "2026-02-01", periodEnd: "2026-02-28", payDate: "2026-03-05", effectiveDate: "2026-02-28",
    });
    const after = await db.admin<{ employee_id: string; gross: string }[]>`
      select employee_id, gross::text as gross from app.employee_ytd
       where company_id = ${s.company} and tax_year = 2026 order by employee_id`;
    expect(after).toHaveLength(before.length);        // no new row: same employees, same year
    for (let i = 0; i < after.length; i += 1) {
      expect(Number(after[i]!.gross)).toBe(Number(before[i]!.gross) * 2);
    }
  });

  it("starts a NEW row when the pay date crosses into the next tax year (amendment B7)", async () => {
    await postPayrollRun(db, s, f, {
      periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2027-01-05", effectiveDate: "2026-12-31",
    });
    const years = await db.admin<{ tax_year: number }[]>`
      select distinct tax_year from app.employee_ytd where company_id = ${s.company} order by tax_year`;
    expect(years.map((r) => r.tax_year)).toEqual([2026, 2027]);
  });

  it("by_component and by_scheme are fixed-scale STRINGS, so a rebuild can compare them byte for byte", async () => {
    const [row] = await db.admin<{ by_component: Record<string, unknown>; by_scheme: Record<string, unknown> }[]>`
      select by_component, by_scheme from app.employee_ytd
       where company_id = ${s.company} and tax_year = 2026 limit 1`;
    for (const v of Object.values(row!.by_component)) {
      expect(typeof v).toBe("string");
      expect(v as string).toMatch(/^-?\d+\.\d{4}$/);
    }
    for (const v of Object.values(row!.by_scheme)) {
      const share = v as { employee: string; employer: string };
      expect(share.employee).toMatch(/^-?\d+\.\d{4}$/);
      expect(share.employer).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it("does nothing for a document that is not a PAYROLL run", async () => {
    // A real JOURNAL document (Plan 0A's `draftDocument`, series `JV`), not a company id — the parameter is
    // `documentId: string`, and an argument of the wrong kind would keep this case green even if the
    // MERGE's `payroll_run` guard were deleted. Same correction as T2's delta case.
    const journalId = await draftDocument(db, s);
    const before = await db.admin<{ n: number }[]>`select count(*)::int as n from app.employee_ytd`;
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) => mergeEmployeeYtd(tx, journalId));
    expect(r.rows).toBe(0);
    const after = await db.admin<{ n: number }[]>`select count(*)::int as n from app.employee_ytd`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("ytdFromEmployeeYtd reads the projection as Money, keyed by employee then measure", async () => {
    const ytd = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2026, [f.employeeAId]));
    expect(Object.keys(ytd)).toEqual([f.employeeAId]);
    expect(ytd[f.employeeAId]!.gross).toBeInstanceOf(Money);
    expect(ytd[f.employeeAId]!.gross!.currency).toBe(MYR);
    expect(ytd[f.employeeAId]!.net).toBeInstanceOf(Money);
  });
});

describe("the closed write list (§4.3.2, hazard 22)", () => {
  // **`packages/db/src/integrity/` is NOT excluded here, and that is the point.** The nightly rebuild lives
  // there and it only ever reads: it folds posted deltas into a `create temp table`, compares, and reports
  // `ProjectionMismatch` rows. §3.7.5's allow-list for `app.employee_ytd` is `posting/**`, `costing/**`,
  // `packages/db/test/**` and `scripts/lint/rules/**` — `integrity/**` is absent from it, so a write there
  // would fail `lint:rules` anyway, and reserving an exclusion for a writer that does not exist would let
  // one appear later without either check noticing. The one exclusion below is `/test/`, which §3.7.5 grants.
  it("no file outside packages/db/src/posting names app.employee_ytd in DML", async () => {
    const { REPO_ROOT, sourceFiles } = await import("../../../../tests/support/source");
    const offenders = sourceFiles(["apps", "packages"])
      .filter((f) => !f.path.includes("packages/db/src/posting/"))
      .filter((f) => !f.path.includes("/test/"))
      .filter((f) => /(insert\s+into|update|delete\s+from|merge\s+into)[\s\S]{0,80}app\.employee_ytd\b/i.test(f.text))
      .map((f) => f.path.replace(REPO_ROOT, ""));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
bun run --cwd packages/db test hr/ytd-merge.test.ts
```

**Expected: FAIL** with `Cannot find module '../../src/posting/ytd'` on the very first import. If instead the *first* case fails with `expected [] to have a length of 2`, `postDocument` is running but step 12 has no PAYROLL branch — write Steps 3 and 4 and re-run.

- [ ] **Step 3: Write `packages/db/src/posting/ytd.ts`**

```ts
import type { Sql } from "postgres";

export interface EmployeeYtdMergeResult {
  readonly rows: number;
}

/**
 * contracts §4.3.2 **step 12**, the PAYROLL branch: `MERGE` into `app.employee_ytd` alongside
 * `account_balance` and `stock_on_hand`, in the same transaction (D14).
 *
 * Everything it aggregates comes from `app.employee_ytd_delta` (amendment B6) — the same function the
 * nightly rebuild calls — so the maintained projection and its rebuild cannot disagree about how a total
 * was derived. A document with no `payroll_run` row — every type but `PAYROLL` — makes the function return
 * zero rows, so this is safe to call unconditionally from `postDocument` and there is no document-type
 * branch here and no HR import into the posting service.
 *
 * **On the status:** at step 12 the document is `issued`, not yet `posted` — step 13 is what writes that.
 * `app.employee_ytd_delta` admits both labels for exactly this reason (see its comment in 0092); a draft
 * or submitted run still yields nothing.
 *
 * The deltas are ADDED, never replaced: a `supplementary` run (8B's ADR 0076 — the correction path, since
 * `PAYROLL` refuses reversal) carries the difference and may legitimately be **negative on `net`** — the
 * delta function reads that sign from the source line's `document_line.debit`/`credit`, which is where 8B's
 * rule 7 puts it. That is why `app.employee_ytd` carries no non-negative CHECK and why the jsonb merge
 * below is arithmetic rather than `||`. `gross` and the two jsonb bags are magnitudes and only grow (a
 * `kind = 'payroll'` line carries no direction in 8B's model); ADR 0077 decision 5 records the pair.
 */
export async function mergeEmployeeYtd(tx: Sql, documentId: string): Promise<EmployeeYtdMergeResult> {
  const merged = await tx<{ employee_id: string }[]>`
    merge into app.employee_ytd y
    using (
      select d.company_id, d.employee_id, d.tax_year, d.gross, d.net, d.by_component, d.by_scheme,
             (select t.tenant_id from app.company t where t.id = d.company_id) as tenant_id
        from app.employee_ytd_delta(${documentId}::uuid) d
    ) s
       on y.company_id = s.company_id and y.employee_id = s.employee_id and y.tax_year = s.tax_year
     when matched then update set
       gross        = y.gross + s.gross,
       net          = y.net + s.net,
       by_component = app.jsonb_add_money(y.by_component, s.by_component),
       by_scheme    = app.jsonb_add_scheme(y.by_scheme, s.by_scheme),
       updated_at   = now()
     when not matched then insert
       (tenant_id, company_id, employee_id, tax_year, gross, net, by_component, by_scheme)
       values (s.tenant_id, s.company_id, s.employee_id, s.tax_year, s.gross, s.net, s.by_component, s.by_scheme)
    returning y.employee_id`;
  return { rows: merged.length };
}
```

**`app.jsonb_add_money` and `app.jsonb_add_scheme` already exist**: they are sections 4 and 5 of `0092_create_employee_ytd.sql`, written and applied in Task 2 (PR 2). **This task adds no DDL and does not reopen 0092** — a migration is written once and never edited after it has run (§3.4.7, spec:2057, and Plan 0A's runner skips an applied version, plan0A:736–748). If the MERGE fails with `function app.jsonb_add_money(jsonb, jsonb) does not exist`, your database is on a 0092 from a checkout that predates Task 2's final form: roll the *test* container down to 0091 and up again (`bun run --cwd packages/db src/cli.ts down 91 && … up`) so it re-applies the committed file, and do **not** append anything to the migration.

- [ ] **Step 4: Edit `packages/db/src/posting/post.ts` — one call at step 12**

Find the block that MERGEs `account_balance` and (from 3A) `stock_on_hand`, and add the third line **after** both, with its comment:

```ts
  // §4.3.2 step 12 — the third MERGE. 8C: `app.employee_ytd` for a PAYROLL document only, and the
  // function itself decides that (it returns zero rows for anything else), so there is no type branch
  // here and no import of an HR module into the posting service.
  await mergeEmployeeYtd(tx, input.documentId);
```

with `import { mergeEmployeeYtd } from "./ytd";` at the top of the file. Then extend the file's own header comment listing the tables it may write (§4.3.2's closed list) with `app.employee_ytd (8C, PAYROLL only)`.

- [ ] **Step 5: Add `ytdFromEmployeeYtd` to 8B's `packages/db/src/hr/ytd.ts`**

Additive — 8B's `ytdFromPostedLines` is untouched and stays exported (hazard 9: a later slice extends, it does not rewrite).

```ts
/**
 * Reads the PROJECTION `app.employee_ytd`. From 8C onward this is the authoritative YTD read: a payslip
 * (8D) and the annual statement (8D) consume it, and `ytdFromPostedLines` above stays as the
 * between-slices read 8B shipped and as the second opinion the rebuild compares against.
 *
 * **This is the ONE place an opening is added in** (amendment B14). A mid-year cut-over's YTD is
 * `employee_ytd_opening` plus every posted run since (spec:2084), and the projection carries only the
 * second half of that sum: `app.employee_ytd` is written solely by the step-12 MERGE, which runs on a
 * posted document and never on an opening load, and `upsertEmployeeYtdOpening` may not write it at all
 * (spec:98, §3.7.5). Adding the opening at READ time is therefore not a convenience — it is the only place
 * the sum can legally be formed, and it is why the nightly rebuild compares deltas against deltas and
 * reports no drift for a company that loaded openings. A company with no openings simply adds zero.
 */
export async function ytdFromEmployeeYtd(
  tx: Sql, companyId: string, taxYear: number, employeeIds: readonly string[],
): Promise<Record<string, Record<string, Money>>> {
  if (employeeIds.length === 0) return {};
  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${companyId}`;
  if (!company) return {};
  const ccy = currency(company.base_currency);

  const rows = await tx<{ employee_id: string; gross: string; net: string }[]>`
    select e.id as employee_id,
           to_char(coalesce(y.gross, 0) + coalesce(o.gross, 0), 'FM999999999999990.0000') as gross,
           to_char(coalesce(y.net,   0) + coalesce(o.net,   0), 'FM999999999999990.0000') as net
      from app.employee e
      left join app.employee_ytd y
             on y.company_id = ${companyId} and y.employee_id = e.id and y.tax_year = ${taxYear}
      left join app.employee_ytd_opening o
             on o.company_id = ${companyId} and o.employee_id = e.id and o.tax_year = ${taxYear}
     where e.company_id = ${companyId} and e.id = any(${employeeIds as string[]}::uuid[])
     order by e.id`;

  const out: Record<string, Record<string, Money>> = {};
  for (const r of rows) {
    out[r.employee_id] = { gross: Money.of(r.gross, ccy), net: Money.of(r.net, ccy) };
  }
  return out;
}
```

- [ ] **Step 6: Re-export and run**

`packages/db/src/posting/index.ts` gains `export { mergeEmployeeYtd, type EmployeeYtdMergeResult } from "./ytd";`, and `packages/db/src/index.ts` gains `export { ytdFromEmployeeYtd } from "./hr/ytd";` beside 8B's existing `ytdFromPostedLines` export.

```bash
bun run --cwd packages/db test hr/ytd-merge.test.ts hr/employee-ytd-table.test.ts
bun run lint:rules && bun run typecheck
```

**Expected: PASS.** Then the whole posting suite, because step 12 now has a third statement and a regression there is a ledger regression:

```bash
bun run --cwd packages/db test posting
bun run --cwd tests test invariants/ledger-balance.test.ts
```

**Expected: PASS**, unchanged. If a JOURNAL posting slowed measurably, check that `app.employee_ytd_delta` short-circuits on `exists (select 1 from run)` — a document with no `payroll_run` row must never scan `payroll_line`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/posting/ytd.ts packages/db/src/posting/post.ts packages/db/src/posting/index.ts \
        packages/db/src/hr/ytd.ts packages/db/src/index.ts \
        packages/db/test/hr/ytd-merge.test.ts
git commit -m "feat(db): MERGE employee_ytd at postDocument step 12 [8C T3]

The PAYROLL branch of step 12, through app.employee_ytd_delta — the same
aggregation the nightly rebuild consumes. Deltas ADD, so a supplementary run
corrects rather than replaces (ADR 0076/0077). app.employee_ytd is now on the
posting-only table list and a source scan proves nothing else writes it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Migration 0095 — `hr.payroll.pay`, `hr.advance.create`, their role grants and the policy-resolved references

**Files:**
- Create: `packages/db/migrations/0095_seed_permission_phase8c.sql`, `packages/db/migrations/0095.down.sql`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`, `apps/api/src/middleware/require-document-permission.ts`
- Test: `packages/db/test/permission-catalogue.test.ts` (existing — re-run), `packages/db/test/hr/permissions-8c.test.ts`

**Interfaces:**
- Consumes: `PERMISSIONS`, `PermissionDef`, `PERMISSION`, `PermissionCode`, `SliceId` (§4.2.5), `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§3.6.4), `POLICY_RESOLVED_CODES` (§4.5.4, 2A), `startDb`, `seedTenantV2`, `lintSchema`.
- Produces: the two `PermissionDef` rows and the `app.permission` rows behind them; `POLICY_RESOLVED_CODES` gains `hr.payroll.pay` and `hr.advance.create`.

- [ ] **Step 1: Write the failing test `packages/db/test/hr/permissions-8c.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { startDb, type Db } from "../harness";

let db: Db;
beforeAll(async () => { db = await startDb(); }, 180_000);
afterAll(async () => { await db.stop(); });

const CODES = ["hr.payroll.pay", "hr.advance.create"] as const;

describe("8C's two permission codes (§3.6.2)", () => {
  it("both are in the catalogue, in module hr, mutating, and attributed to slice 8C", () => {
    for (const code of CODES) {
      const def = PERMISSIONS.find((p) => p.code === code);
      expect(def, `${code} missing from PERMISSIONS`).toBeDefined();
      expect(def!.module).toBe("hr");
      expect(def!.mutating).toBe(true);
      expect(def!.phase).toBe("8C");
    }
  });

  it("app.permission carries exactly the same (code, module, mutating) triples", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = any(${[...CODES]}) order by code`;
    expect(rows).toEqual([
      { code: "hr.advance.create", module: "hr", mutating: true },
      { code: "hr.payroll.pay", module: "hr", mutating: true },
    ]);
  });

  it("hr_payroll holds both; auditor holds neither (R7); no seeded role gains an R6 pair", () => {
    const hr = ROLES.find((r) => r.code === "hr_payroll")!;
    expect(hr.permissions).toContain("hr.payroll.pay");
    expect(hr.permissions).toContain("hr.advance.create");
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    for (const code of CODES) expect(auditor.permissions).not.toContain(code);

    for (const role of ROLES) {
      if (role.code === "admin") continue;             // R6 exempts admin (spec:2177)
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`).toBe(false);
      }
    }
  });

  it("hr_payroll does NOT gain accounting.payment.approve — R1 is what separates release from approval", () => {
    const hr = ROLES.find((r) => r.code === "hr_payroll")!;
    expect(hr.permissions).not.toContain("accounting.payment.approve");
    expect(hr.permissions).not.toContain("accounting.payment.post");
  });
});
```

**The fourth case is the point of this task and is worth reading twice.** `hr.payroll.pay` is the *release* code — it lets the payroll officer create the batch — while approval and posting are `accounting.payment.approve` / `.post`, which the **accountant** holds. spec:2082 chose Phase 4's money-out machinery precisely so that payroll money leaves the bank under the same two-person control as every other payment. Granting the payroll officer the approval code would collapse that to one person and R1 would have nothing left to enforce.

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/db test hr/permissions-8c.test.ts
```

**Expected: FAIL** — `hr.payroll.pay missing from PERMISSIONS` on the first case, and `expected [] to deeply equal [ … ]` on the second.

- [ ] **Step 3: Add the two catalogue rows to `packages/contracts/permissions.ts`**

Append inside the `PERMISSIONS` array, keeping the file's module ordering (the `hr` block, after 8B's four):

```ts
  { code: "hr.payroll.pay", module: "hr", mutating: true, phase: "8C",
    description: "Release a payroll payment batch and settle a statutory remittance" },
  { code: "hr.advance.create", module: "hr", mutating: true, phase: "8C",
    description: "Create a staff advance" },
```

`SliceId` already includes `"8C"` (§4.2.5's union), so no type edit is needed.

- [ ] **Step 4: Write `packages/db/migrations/0095_seed_permission_phase8c.sql`**

```sql
-- 0095_seed_permission_phase8c.sql — §3.6.2's two 8C codes, §3.6.3's insert shape.
-- app.permission is GLOBAL (no RLS, read-only for app_rw — plan0A:1254), so it is migration data and not
-- seed-pack data (§3.4.8, hazard 10).
insert into app.permission (code, module, mutating, description) values
  ('hr.payroll.pay',    'hr', true, 'Release a payroll payment batch and settle a statutory remittance'),
  ('hr.advance.create', 'hr', true, 'Create a staff advance')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
```

`packages/db/migrations/0095.down.sql`:

```sql
delete from app.permission where code in ('hr.payroll.pay', 'hr.advance.create');
```

- [ ] **Step 5: Add the role grants in `packages/db/seed/roles.ts`**

`hr_payroll` gains both (spec:2161 gives it the payroll function end to end short of approval); nobody else gains either. Record it in the same PR, as §3.6.4's sentence requires: **`hr.payroll.pay` → `hr_payroll` and `hr.advance.create` → `hr_payroll` (8C).**

```ts
  {
    code: "hr_payroll",
    // … existing fields unchanged …
    permissions: [
      // … existing codes, unchanged …
      "hr.payroll.pay",
      "hr.advance.create",
    ],
  },
```

**`accountant` gains nothing here.** It already holds `accounting.payment.approve` and `.post` from 4A, which is the whole of its part in this slice; adding a payroll code to it would put both sides of R6's `[hr.payroll.prepare, hr.payroll.approve]` reasoning in one place for no gain.

- [ ] **Step 6: Add the two codes to `POLICY_RESOLVED_CODES`**

`apps/api/src/middleware/require-document-permission.ts` — the constant 2A ships so that a gate resolved from *data* still has a `PERMISSION[…]` reference for the bidirectional `permission-catalogue` lint (§3.6.3):

```ts
export const POLICY_RESOLVED_CODES: readonly PermissionCode[] = [
  // … every existing member, unchanged …
  PERMISSION["hr.payroll.pay"],       // 8C — PAYROLL_PAYMENT's approval.create
  PERMISSION["hr.advance.create"],    // 8C — EMPLOYEE_ADVANCE's approval.create
];
```

**This is not optional and it is not cosmetic.** Task 5's two policies name these codes in `approval.create`; the code is resolved from the policy JSON at request time and **no source scan can see it**, so without the reference `permission-catalogue` fails with "code introduced in 8C has no reference" on the very PR that seeds it. `DOCUMENT_STAGE_CODES` is initialised **from** this constant (§4.5.4), so the documents module's declared permissions follow automatically and `apps/api/src/routes/accounting/documents.ts` needs no edit.

- [ ] **Step 7: Run everything and commit**

```bash
bun run --cwd packages/db src/cli.ts up
bun run --cwd packages/db test hr/permissions-8c.test.ts permission-catalogue.test.ts
bun run lint:rules
bun run --cwd packages/db test privileges.test.ts -t "up → down → up"
```

**Expected: PASS.** `permission-catalogue.test.ts` (0B) asserts the `app.permission` set equals `PERMISSIONS` in **both** directions, so a row added to one and not the other fails here rather than at run time. `lint:rules` covers the handler ↔ catalogue half through the `POLICY_RESOLVED_CODES` reference.

```bash
git add packages/db/migrations/0095_seed_permission_phase8c.sql packages/db/migrations/0095.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        apps/api/src/middleware/require-document-permission.ts \
        packages/db/test/hr/permissions-8c.test.ts
git commit -m "feat(db): seed hr.payroll.pay and hr.advance.create [8C T4]

Release is the payroll officer's; approval and posting stay accounting.payment.*
so payroll money leaves the bank under the same two-person control as every
other payment (spec:2082, R1). Both codes join POLICY_RESOLVED_CODES because
Task 5's policies resolve them from data.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` document types and their policies

**Files:**
- Create: `packages/db/seed/my/document-types/PAYROLL_PAYMENT.json`, `packages/db/seed/my/document-types/EMPLOYEE_ADVANCE.json`
- Test: `packages/db/test/hr/money-out-types.test.ts`

**Interfaces:**
- Consumes: `validateDocumentTypeSeed(envelope)` and `validatePolicy(definition, catalogue)` (2A), `loadDocumentTypes(sql, ctx, packDir, catalogue)` / `documentTypesLoader` (1A, reachable as `@dulja/db/seed`), `PERMISSIONS` (for the catalogue argument), `readPackFile` (§4.2.13), `PAYROLL_ACCOUNT_CODES` (8B), `seedTenantV2`, `seedAccount`, `payrollFixture` (8B), `startDb`, `withTenant` (test helper).
- Produces: §4.14's `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` rows as §4.3.7 envelopes, with the policy shapes amendment B8 fixes.

- [ ] **Step 1: Write the failing test `packages/db/test/hr/money-out-types.test.ts` — hazard 33 first**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { payrollFixture, PAYROLL_PACK_ROOT, type PayrollFixture } from "../../../../tests/invariants/support/payroll";

let db: Db;
let s: Seed;
let f: PayrollFixture;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Money-out types");
  f = await payrollFixture(db, s);          // applies 8B's chart file, so 1400/2400/241n exist
}, 180_000);
afterAll(async () => { await db.stop(); });

const CATALOGUE = PERMISSIONS.map((p) => p.code);
const envelopeOf = (code: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PAYROLL_PACK_ROOT, `document-types/${code}.json`), "utf8")) as Record<string, unknown>;

/**
 * HAZARD 33, discharged. This slice's two policies name `2400`, `1400` and `1100` by code and seeds none
 * of them — `2400` and `1400` are 8B's, `1100` is 0C's. §4.15's rule for a consuming slice is that its
 * "first task in that area asserts the account resolves"; this is that assertion, and it runs BEFORE any
 * policy naming those codes is loaded.
 */
describe("the three account codes these policies name (hazard 33, §4.15)", () => {
  it.each(["2400", "1400", "1100"])("%s resolves in the company and was seeded elsewhere", async (code) => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      // The column is `type`, of enum type `app.account_type` (plan0A:1492); `account_type` is the TYPE's
      // name, not a column, and selecting it raises `column "account_type" does not exist`.
      tx<{ id: string; type: string }[]>`
        select id, type::text as type from app.account
         where company_id = ${s.company} and code = ${code}`);
    expect(rows, `account ${code} does not resolve — 8B's chart file or 0C's base chart has not been applied`)
      .toHaveLength(1);
  });
});

describe("PAYROLL_PAYMENT.json and EMPLOYEE_ADVANCE.json (§4.3.7, §4.14, amendment B8)", () => {
  it.each([
    ["PAYROLL_PAYMENT", "PAYB", "hr.payroll.pay", "2400"],
    ["EMPLOYEE_ADVANCE", "ADV", "hr.advance.create", "1400"],
  ])("%s is a valid envelope in module hr with series %s", (code, series, create, accountCode) => {
    const envelope = envelopeOf(code) as {
      code: string; module: string; policy: Record<string, unknown>;
    };
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope.code).toBe(code);
    expect(envelope.module).toBe("hr");                       // hazard 34: NOT the module of approval.post

    const policy = envelope.policy as {
      direction: string; numbering: { series: string };
      approval: { required: boolean; create: string; approve: string; post: string };
      reversal: { allowed: boolean; producesType: string | null };
      dimensions: { required: string[] };
      lines: { for: string; side: string; account: Record<string, string>; amount: string;
               when?: Record<string, string>; dimensions?: { from: string[] } }[];
      tax: { applies: boolean };
      inventory: { effect: string };
    };
    expect(validatePolicy(policy, CATALOGUE)).toEqual({ ok: true, errors: [] });
    expect(policy.direction).toBe("outbound");
    expect(policy.inventory.effect).toBe("none");
    expect(policy.tax.applies).toBe(false);
    expect(policy.numbering.series).toBe(series);
    expect(policy.approval).toEqual({
      required: true, create, approve: "accounting.payment.approve", post: "accounting.payment.post",
    });
    expect(policy.reversal).toEqual({ allowed: true, producesType: code });
    expect(policy.dimensions.required).toEqual(["BRANCH"]);   // amendment B8 — NOT ["BRANCH","EMPLOYEE"]

    const perLine = policy.lines.find((l) => l.for === "each_line")!;
    expect(perLine.side).toBe("debit");
    expect(perLine.account).toEqual({ code: accountCode });
    expect(perLine.amount).toBe("line.amount");
    expect(perLine.when).toEqual({ "line.kind": "payroll" });
    expect(perLine.dimensions).toEqual({ from: ["line.dimensions"] });   // amendment B8/B9

    const bank = policy.lines.find((l) => l.for === "document")!;
    expect(bank.side).toBe("credit");
    expect(bank.account).toEqual({ code: "1100" });
    expect(bank.amount).toBe("document.total_excl_tax");
    expect(bank.dimensions).toBeUndefined();                 // the schema default: line bag + document.branch
  });

  it("loads into the tenant as a document_type with module hr and one posting_policy version", async () => {
    const { loadDocumentTypes } = await import("../../src/seed/document-types");
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: "00000000-0000-0000-0000-000000000000" };
    const results = await loadDocumentTypes(db.rw, ctx, PAYROLL_PACK_ROOT, CATALOGUE);
    for (const code of ["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"]) {
      const r = results.find((x) => x.code === code);
      expect(r, `${code} was not loaded`).toBeDefined();
      const [row] = await db.admin<{ module: string; versions: number }[]>`
        select t.module,
               (select count(*)::int from app.posting_policy p where p.document_type_id = t.id) as versions
          from app.document_type t where t.company_id = ${s.company} and t.code = ${code}`;
      expect(row!.module).toBe("hr");
      expect(row!.versions).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/db test hr/money-out-types.test.ts
```

**Expected: FAIL.** The hazard-33 block **passes** (8B's chart file is applied by `payrollFixture`); the envelope cases fail with `ENOENT: no such file or directory, open '…/document-types/PAYROLL_PAYMENT.json'`. If the hazard-33 block itself fails, 8B has not merged its chart file — stop and re-read Task 1 Step 1's gate.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/PAYROLL_PAYMENT.json`**

```json
{
  "code": "PAYROLL_PAYMENT",
  "nameEn": "Payroll Payment Batch",
  "nameAr": "دفعة رواتب",
  "module": "hr",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "PAYROLL_PAYMENT",
    "direction": "outbound",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit", "account": { "code": "2400" }, "amount": "line.amount",
        "when": { "line.kind": "payroll" },
        "dimensions": { "from": ["line.dimensions"] } },
      { "for": "document", "side": "credit", "account": { "code": "1100" }, "amount": "document.total_excl_tax" }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "PAYB", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "PAYROLL_PAYMENT" },
    "approval": { "required": true, "approve": "accounting.payment.approve", "post": "accounting.payment.post", "create": "hr.payroll.pay" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

- [ ] **Step 4: Write `packages/db/seed/my/document-types/EMPLOYEE_ADVANCE.json`**

```json
{
  "code": "EMPLOYEE_ADVANCE",
  "nameEn": "Employee Advance",
  "nameAr": "سلفة موظف",
  "module": "hr",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "EMPLOYEE_ADVANCE",
    "direction": "outbound",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit", "account": { "code": "1400" }, "amount": "line.amount",
        "when": { "line.kind": "payroll" },
        "dimensions": { "from": ["line.dimensions"] } },
      { "for": "document", "side": "credit", "account": { "code": "1100" }, "amount": "document.total_excl_tax" }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "ADV", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "EMPLOYEE_ADVANCE" },
    "approval": { "required": true, "approve": "accounting.payment.approve", "post": "accounting.payment.post", "create": "hr.advance.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

**Six choices, and each is the difference between a policy that posts spec:2082 and one that posts something else.**

- **`module: "hr"` while `approval.post` is `accounting.payment.post`.** Hazard 34 names this exact pair. `document_type.module` is the **attachment download gate** (§4.5.8) and nothing else; these documents' attachments are the bank batch and the advance authorisation, both carrying per-employee pay, so `accounting` there would open the side channel test 32 exists to close. 8B shipped the `hr → hr.payroll.read` row of `MODULE_READ_CODE`, so the gate resolves today and **this slice adds no row to that map**.
- **`account: { "code": "…" }` and not `line.account`.** §4.4.1's `accountRef` enum has no `line.employee.advance_account` and none is invented (hazard 32). `2400` and `1400` are §4.15 rows seeded by 8B, `1100` by 0C, and Step 1's first block asserts all three resolve before either file is loaded — hazard 33's requirement of a consuming slice, discharged.
- **`amount: "line.amount"` on a `kind: "payroll"` line, and `document.total_excl_tax` on the bank leg.** 2A's `documentAmount` sums `l.amount` for `document.total_excl_tax` (2a:1742), so the credit is exactly the sum of the debits and the document balances by construction — no `fx_rounding` line is ever appended in base currency. Writing the per-line figure into `debit` instead would leave `amount` at zero and the bank leg at zero: a document that balances at `0 = 0` and posts nothing, which §4.3.2 step 6's *output* `ERR_DOC_NO_LINES` would catch but only after the fact.
- **`dimensions: { "from": ["line.dimensions"] }` on the per-line rule.** 2A's `dimensionsFor` gives `document.branch` the **last word** (2a:1766), so a rule that named it — or that took the schema default, which includes it — would stamp every employee's salaries-payable debit with the *batch's* branch. The batch is one document for the whole company; the employees are not. The service writes `{"BRANCH": <the employee's home_branch_id>, "EMPLOYEE": <the employee's dimension value>}` into `document_line.dimensions`, and this `from` is what lets both through. It is 8B's amendment A3 applied to the money-out side, and amendment B9 records it.
- **`dimensions.required: ["BRANCH"]`, not `["BRANCH", "EMPLOYEE"]`.** The document-scoped bank leg has **no source line**, so `dimensionsFor(rule, null, snapshot)` can produce only BRANCH; requiring EMPLOYEE would make `evaluatePolicy` raise `ERR_POLICY_REQUIRES_MISSING` on the bank line of every batch. EMPLOYEE still reaches every *payable* line, because the service writes it into the bag — required and *present* are different things, and the per-employee tie-out of test 30 reads the tag, not the requirement.
- **`reversal: { "allowed": true, "producesType": "<self>" }`, unlike `PAYROLL`.** 8B refused reversal for `PAYROLL` because `reverseDocument` copies no `payroll_line` and because `approval.required = true` makes the inner `draft → issued` illegal (8B's amendment A4). **The first reason does not apply here** — amendment B9 means these lines carry **no** `payroll_line` row at all, so a mirrored line resolves everything it needs from `document_line` alone. **The second does**, and it is why `reverseDocument` on one of these types will raise `ERR_DOC_STATUS_ILLEGAL` in practice; the flag is `true` because the *policy's* answer to "may this be reversed" is yes — a mispaid batch is corrected by a reversing batch, exactly as `PAYMENT` is — and the state machine, not the policy, is what will ask for a second approver. **Task 6 Step 3's last `createPayrollPayment` case pins that behaviour with a test rather than leaving it to be discovered** — it reverses the posted batch, asserts `ERR_DOC_STATUS_ILLEGAL`, and asserts that no half-built mirror was left behind. A flag that nothing can ever exercise is a policy that lies, and this one is deliberately `true`.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd packages/db test hr/money-out-types.test.ts
bun run lint:rules && bun run typecheck
```

**Expected: PASS**, all six cases — three from `it.each(["2400", "1400", "1100"])`, two from the two-row envelope `it.each`, and the one plain `it` that loads the pack into the tenant. Then apply the sub-pack to a scratch tenant to prove the CLI path, which is how a release actually installs them:

```bash
bun run --cwd packages/db src/cli.ts --help | grep -- "--only"
```

**Expected:** the flag is listed. `document-types` is an **existing** sub-pack (1A shipped its loader, §3.4.8), so this slice adds **files, never a loader**, and `SubPack`, `SUB_PACKS` and `PHASE_0_SUB_PACK_DIRECTORIES` are not edited.

```bash
git add packages/db/seed/my/document-types/PAYROLL_PAYMENT.json \
        packages/db/seed/my/document-types/EMPLOYEE_ADVANCE.json \
        packages/db/test/hr/money-out-types.test.ts
git commit -m "feat(seed): add the PAYROLL_PAYMENT and EMPLOYEE_ADVANCE types [8C T5]

module hr (the attachment gate, hazard 34) with accounting.payment.* approval
(spec:2082). Per-employee debits carry the EMPLOYEE'S branch through
line.dimensions; the bank leg is document-scoped, which is why
dimensions.required is BRANCH alone (amendment B8).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The money-out services, the bank-neutral CSV, and the two route modules

**Files:**
- Create: `packages/db/src/hr/money-out.ts`, `packages/db/src/hr/batch-csv.ts`, `packages/contracts/src/hr/payroll-payment.ts`, `packages/contracts/src/hr/employee-advance.ts`, `apps/api/src/routes/hr/payroll-payments.ts`, `apps/api/src/routes/hr/employee-advances.ts`, `tests/invariants/support/payroll-money.ts`
- Modify: `packages/db/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/contracts/openapi.json`
- Test: `packages/db/test/hr/money-out.test.ts`, `apps/api/test/routes/hr/payroll-payments.test.ts`, `apps/api/test/routes/hr/employee-advances.test.ts`

**Interfaces:**
- Consumes: `withTenant` / `TenantContext` (§4.2.2), `postDocument` / `transitionDocument` / `resolvePolicy` (§4.3.1), `Money` / `currency` / `CurrencyCode` (§4.2.1), `ensureEmployeeDimensionValue` / `EMPLOYEE_DIMENSION_CODE` / `readPayrollRun` / `PayrollRunDetail` (8B), `requirePermission` / `requireDocumentPermission` / `PERMISSION` (§4.2.5, §4.5.4), `RouteModule` / `buildRoutes` / `IdempotencyHeader` / `PROBES` / `IsolationProbe` (§4.2.7), `ListEnvelope` / `ListQuery` / `UuidSchema` / `DateSchema` / `MoneySchema` / `CursorSchema` / `encodeCursor` / `decodeCursor` (§4.2.8), `startApi` / `StartedApi` / `ApiRequest` (§4.2.12), `AppError` / `fromDatabaseError` (§4.2.4), `payrollFixture` / `postPayrollRun` / `secondApprover` / `PayrollFixture` (8B), `ensureOpenPeriods(db, s, year)` (3B, via `payrollFixture`), `grantCodes` (2B), `seedTenantV2` (1A).
- Produces:

```ts
// packages/db/src/hr/money-out.ts
import type { Sql } from "postgres";
import type { Money } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";

export interface PayrollPaymentInput {
  companyId: string;
  /** The POSTED PAYROLL run whose net pay this batch clears. */
  payrollDocumentId: string;
  /** The accounting date of the batch — never derived from `now()` (spec:2039). */
  effectiveDate: string;
  /** The batch's own branch. Every LINE carries the employee's home branch instead (amendment B8). */
  branchId: string;
  /** Restrict the batch to these employees; omit for every unpaid employee on the run. */
  employeeIds?: readonly string[];
}
export interface MoneyOutLine {
  documentLineId: string; employeeId: string; employeeNumber: string;
  employeeName: string; amount: Money; branchId: string;
}
export type MoneyOutStatus =
  "draft" | "submitted" | "approved" | "issued" | "void" | "posted" | "reversed";
export interface MoneyOutResult {
  documentId: string; series: string;
  /** Null until `issueDocument` assigns it — numbering is at issue (§4.3.6). */
  number: string | null;
  status: MoneyOutStatus;
  effectiveDate: string;
  /** `payroll:<run id>` on a batch, `advance:<reason>` on an advance — `draftMoneyOut` writes both. */
  notes: string | null;
  employeeCount: number; total: Money; lines: MoneyOutLine[];
}
/** Drafts the batch. Approval and posting go through 2B's shared transitions; this writes no ledger row. */
export async function createPayrollPayment(
  tx: Sql, ctx: TenantContext, input: PayrollPaymentInput,
): Promise<MoneyOutResult>;

export interface EmployeeAdvanceInput {
  companyId: string; employeeId: string; effectiveDate: string; branchId: string;
  amount: Money; reason: string;
}
export async function createEmployeeAdvance(
  tx: Sql, ctx: TenantContext, input: EmployeeAdvanceInput,
): Promise<MoneyOutResult>;

/** Reads either type back, by document id. `ERR_NOT_FOUND` (as a `MoneyOutError`) when invisible. */
export async function readMoneyOut(tx: Sql, documentId: string): Promise<MoneyOutResult>;

export interface MoneyOutListFilter {
  companyId: string;
  typeCode: "PAYROLL_PAYMENT" | "EMPLOYEE_ADVANCE";
  /** Matches `document.notes = 'payroll:<id>'` — the same marker `draftMoneyOut` writes. */
  payrollDocumentId?: string;
  employeeId?: string;
  status?: MoneyOutStatus;
  from?: string; to?: string;
  limit: number;
  /** Keyset on `(effective_date, id)`, decoded from the §4.2.8 cursor by the route. */
  cursor?: { effectiveDate: string; id: string } | null;
}
/** The list behind both `GET /`s. The ROUTE never writes SQL (test 27's `no-bare-db`), so every filter the
 *  two `…Query` schemas declare is a typed member here. */
export async function listMoneyOut(tx: Sql, filter: MoneyOutListFilter): Promise<MoneyOutResult[]>;

/** The staff-advance balance is a LEDGER PROJECTION, never a loan ledger (spec:2082). */
export async function advanceBalance(
  tx: Sql, input: { companyId: string; employeeId: string; asOf: string },
): Promise<Money>;

export class MoneyOutError extends Error {
  constructor(readonly code: "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED" | "ERR_DOC_STATUS_ILLEGAL", readonly detail: string);
}

// packages/db/src/hr/batch-csv.ts
export interface BatchCsvRow {
  employeeNumber: string; employeeName: string; bankAccountMasked: string;
  amount: string; currency: string; reference: string;
}
/** spec:2083 "a bank-neutral CSV of the net-pay batch. Bank-specific formats are out." */
export function payrollBatchCsv(rows: readonly BatchCsvRow[]): string;
export const BATCH_CSV_HEADER: readonly string[];
```

- [ ] **Step 1: Write the shared fixture `tests/invariants/support/payroll-money.ts` (amendment B3)**

§4.17 assigns 8C **no `fixtures.ts` row** and hazard 9 forbids inventing one, so every helper this slice shares lives here, registered against §4.17.1 by amendment B3.

```ts
// ONE `@dulja/db` statement, and it names ONLY what a body in this file calls. `generateStatutorySchedule`
// (T7) and `settleStatutorySchedule` (T8) are PR 6; importing either here would end PR 5 on **TS2305**,
// *"Module '@dulja/db' has no exported member 'generateStatutorySchedule'"* — the same PR-boundary failure
// the note under this block gives as the reason `postRemittance` is not declared here either. Neither name
// is used by any helper in this file, in PR 5 or after T8 appends the fourth one.
import { createEmployeeAdvance, createPayrollPayment, postDocument, transitionDocument } from "@dulja/db";
import { Money, currency } from "@dulja/domain";
import { grantCodes, withTenant, type Db, type Seed } from "@dulja/db/test";
import { payrollFixture, postPayrollRun, secondApprover, type PayrollFixture } from "./payroll";

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
const ctxOf = (s: Seed, actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

export interface MoneyOutFixture extends PayrollFixture {
  /** A posted PAYROLL run for 2026-01, from which every money-out case in this slice starts. */
  payrollDocumentId: string;
  /** A principal holding accounting.payment.approve and .post — R1's second person for the batch. */
  payer: string;
  /** The authority vendor party a statutory remittance is paid to (spec:2082 models it as a vendor). */
  authorityPartyId: string;
}

/**
 * `payrollFixture` (8B) plus everything money-out needs: the two money-out document types loaded from the
 * real pack files, a posted January run, the release and approval grants on two DIFFERENT principals, and
 * the authority vendor party. Like 8B's fixture it seeds from the SHIPPED files rather than restating
 * them, so a test and the pack can never disagree (§4.17.1's reasoning).
 */
export async function moneyOutFixture(db: Db, s: Seed): Promise<MoneyOutFixture> { /* … Step 2 … */ }

/** Drafts, approves and posts a PAYROLL_PAYMENT through the REAL state machine. Returns the document id. */
export async function postPayrollPayment(
  db: Db, s: Seed, f: MoneyOutFixture,
  input?: { effectiveDate?: string; employeeIds?: readonly string[] },
): Promise<string> { /* … Step 2 … */ }

/** The same for an EMPLOYEE_ADVANCE. */
export async function postEmployeeAdvance(
  db: Db, s: Seed, f: MoneyOutFixture,
  input: { employeeId: string; amount: string; reason: string; effectiveDate?: string },
): Promise<string> { /* … Step 2 … */ }
```

**`postRemittance` — B3's fourth helper — is deliberately NOT declared here.** It is added, signature and body together, by **Task 8 Step 3**, which is a different PR (PR 6, not PR 5). A declaration written here with its body deferred would be an `async` function whose declared return type is `Promise<string>` and whose body returns nothing — **TS2355**, *"A function whose declared type is neither 'undefined', 'void', nor 'any' must return a value"* — so PR 5 would end on a tree that fails `bun run typecheck`, which Global Constraint 17 forbids after **every** task and which would make PR 5 un-mergeable on its own. The cross-reference convention this plan uses elsewhere (a signature in one step, its body in a later step of the **same** task) is safe precisely because both land in one commit; it is not safe across a PR boundary, and this is the one place in the slice where the boundary falls between the two. Amendment **B3** still registers all four names against §4.17.1 — the register describes the finished file, not the order its helpers arrive in.

- [ ] **Step 2: Write the three fixture bodies**

```ts
export async function moneyOutFixture(db: Db, s: Seed): Promise<MoneyOutFixture> {
  const base = await payrollFixture(db, s);

  // The two money-out types, from the SHIPPED envelopes — the same route the release takes.
  const { loadDocumentTypes } = await import("@dulja/db/seed");
  const { PERMISSIONS } = await import("@dulja/contracts/permissions");
  const { PAYROLL_PACK_ROOT } = await import("./payroll");
  await loadDocumentTypes(db.rw, ctxOf(s, s.system), PAYROLL_PACK_ROOT, PERMISSIONS.map((p) => p.code));

  // R1 needs three distinct people across this slice: the preparer (s.human), the payroll approver
  // (base.approver, 8B's) and the PAYER, who holds the accounting.payment codes and nothing HR.
  const payer = await secondApprover(db, s, ["accounting.payment.approve", "accounting.payment.post"]);
  await grantCodes(db, s, { codes: ["hr.payroll.pay", "hr.advance.create"] });   // on s.human, the preparer

  // The authority vendor party, with `payable_account_id` set to THE SCHEME'S OWN payable account.
  //
  // **This is not decoration and the whole remittance path depends on it.** 4A's `PAYMENT` policy puts its
  // **debit** leg on `party.payable_account` and its **credit** leg on `line.account` (4a:5211). A statutory
  // remittance must debit the scheme's payable (`2411`, clearing what payroll credited) and credit the bank
  // (`1100`, the leg 0091's guard measures). The only way to make the debit land on `2411` through a policy
  // this slice may not edit is for the authority party's payable account to BE `2411`. Left null — which is
  // what a bare `insert into app.party` gives, and what 2A's `seedParty` would default to `2100` — the post
  // fails with `ERR_POLICY_REQUIRES_MISSING` on `party.payable_account`, or clears the wrong control account.
  //
  // It is also the right model: an authority is a vendor whose balance with the company IS that scheme's
  // payable, so the two are the same account by construction rather than by coincidence.
  const authorityPartyId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.party (tenant_id, company_id, kind, code, name_en, payable_account_id)
      select ${s.tenant}, ${s.company}, 'vendor', 'AUTHORITY-SYNTH', 'Synthetic scheme authority',
             ss.payable_account_id
        from app.statutory_scheme ss where ss.id = ${base.schemeId}
      returning id, payable_account_id`;
    if (row!.payable_account_id === null) {
      throw new Error(
        "moneyOutFixture: statutory_scheme.payable_account_id is null — 8B's linkPayrollAccounts did not run, " +
        "or 2411 is missing from the company's chart. Every remittance case depends on it (see 4a:5211).");
    }
    return row!.id;
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    update app.statutory_scheme set authority_party_id = ${authorityPartyId} where id = ${base.schemeId}`);

  const payrollDocumentId = await postPayrollRun(db, s, base, {
    periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05", effectiveDate: "2026-01-31",
  });

  return { ...base, payrollDocumentId, payer, authorityPartyId };
}

export async function postPayrollPayment(
  db: Db, s: Seed, f: MoneyOutFixture,
  input: { effectiveDate?: string; employeeIds?: readonly string[] } = {},
): Promise<string> {
  const effectiveDate = input.effectiveDate ?? "2026-02-05";
  const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    createPayrollPayment(tx, ctxOf(s, s.human), {
      companyId: s.company, payrollDocumentId: f.payrollDocumentId,
      effectiveDate, branchId: s.hq, employeeIds: input.employeeIds,
    }));
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    transitionDocument(tx, ctxOf(s, s.human), { documentId: r.documentId, to: "submitted" }));
  await withTenant(db.rw, s.tenant, f.payer, (tx) =>
    transitionDocument(tx, ctxOf(s, f.payer), { documentId: r.documentId, to: "approved" }));
  await withTenant(db.rw, s.tenant, f.payer, (tx) =>
    postDocument(tx, ctxOf(s, f.payer), { documentId: r.documentId }));
  return r.documentId;
}

export async function postEmployeeAdvance(
  db: Db, s: Seed, f: MoneyOutFixture,
  input: { employeeId: string; amount: string; reason: string; effectiveDate?: string },
): Promise<string> {
  const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    createEmployeeAdvance(tx, ctxOf(s, s.human), {
      companyId: s.company, employeeId: input.employeeId,
      effectiveDate: input.effectiveDate ?? "2026-01-10", branchId: s.hq,
      amount: Money.of(input.amount, currency("MYR")), reason: input.reason,
    }));
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    transitionDocument(tx, ctxOf(s, s.human), { documentId: r.documentId, to: "submitted" }));
  await withTenant(db.rw, s.tenant, f.payer, (tx) =>
    transitionDocument(tx, ctxOf(s, f.payer), { documentId: r.documentId, to: "approved" }));
  await withTenant(db.rw, s.tenant, f.payer, (tx) =>
    postDocument(tx, ctxOf(s, f.payer), { documentId: r.documentId }));
  return r.documentId;
}
```

**Why the payer is a third principal and not `base.approver`.** R1 compares the approver against *"every actor of the `submitted` transition on that document"* (spec:2172) — per document, not per person — so 8B's payroll approver could legally approve a batch they did not submit. The fixture uses a third principal anyway because R6's pairs are about *seeded roles*, and a fixture that quietly gave one person `hr.payroll.approve` **and** `accounting.payment.approve` would model a tenant the role seed forbids and would make every later assertion about separation weaker than the system actually is.

- [ ] **Step 3: Write the failing test `packages/db/test/hr/money-out.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import {
  advanceBalance, createEmployeeAdvance, createPayrollPayment, MoneyOutError, readMoneyOut,
} from "../../src/hr/money-out";
import { BATCH_CSV_HEADER, payrollBatchCsv } from "../../src/hr/batch-csv";
import { postDocument, reverseDocument, transitionDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import {
  moneyOutFixture, postEmployeeAdvance, type MoneyOutFixture,
} from "../../../../tests/invariants/support/payroll-money";

const MYR = currency("MYR");
const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let s: Seed; let f: MoneyOutFixture;
const ctxOf = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Money out");
  f = await moneyOutFixture(db, s);
}, 240_000);
afterAll(async () => { await db.stop(); });

describe("createPayrollPayment (spec:2082)", () => {
  // **ONE draft serves the first three cases, and that is a correctness requirement, not economy.**
  // `createPayrollPayment` excludes an employee already carried by *any* batch against this run that is not
  // void — a draft included, deliberately: an unposted batch is money about to leave, and two drafts for one
  // payslip is exactly the double payment LEGACY-032 is about. So a second call in this `describe` would raise
  // `ERR_VALIDATION_FAILED: every employee … is already paid` rather than draft anything, and three
  // independent `it`s would leave two of them red for a reason that has nothing to do with what they assert.
  // Case 5 below is what proves the exclusion, on purpose and last.
  let draft: Awaited<ReturnType<typeof createPayrollPayment>>;

  beforeAll(async () => {
    draft = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPayrollPayment(tx, ctxOf(s.human), {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
        effectiveDate: "2026-02-05", branchId: s.hq,
      }));
  }, 60_000);

  it("drafts ONE document with one line per employee and no ledger row", async () => {
    const r = draft;
    expect(r.employeeCount).toBe(2);
    expect(r.lines).toHaveLength(2);
    // The series is on the DRAFT (`document.series` is `not null`, plan0A:1780) and comes from the
    // envelope's `numbering.series`; the NUMBER is not, because numbering is at issue (§4.3.6).
    expect(r.series).toBe("PAYB");
    expect(r.total.equals(r.lines.reduce((a, l) => a.add(l.amount), Money.zero(MYR)))).toBe(true);

    const [doc] = await db.admin<{ status: string; number: string | null }[]>`
      select status::text as status, number::text as number from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("draft");
    expect(doc!.number).toBeNull();                 // numbering is at issue, inside the posting service
    const led = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${r.documentId}`;
    expect(led[0]!.n).toBe(0);
  });

  it("every line carries the EMPLOYEE'S home branch and their EMPLOYEE value in document_line.dimensions", async () => {
    const rows = await db.admin<{ dimensions: Record<string, string>; line_no: number }[]>`
      select dimensions, line_no from app.document_line where document_id = ${draft.documentId} order by line_no`;
    for (const row of rows) {
      expect(Object.keys(row.dimensions).sort()).toEqual(["BRANCH", "EMPLOYEE"]);
    }
    // employeeB is in branchB (payrollFixture), so at least one line's BRANCH differs from the batch's.
    expect(new Set(rows.map((r2) => r2.dimensions["BRANCH"])).size).toBe(2);
  });

  it("writes NO payroll_line row (amendment B9 — that table belongs to runs)", async () => {
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${draft.documentId}`;
    expect(rows[0]!.n).toBe(0);
  });

  it("refuses a run that is not posted", async () => {
    const draftRun = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.document (tenant_id, company_id, document_type_id, series, branch_id, status,
                                  effective_date, currency, exchange_rate, created_by)
        select ${s.tenant}, ${s.company}, document_type_id, series, ${s.hq}, 'draft',
               '2026-03-31', 'MYR', 1, ${s.human}
          from app.document where id = ${f.payrollDocumentId}
        returning id`;
      return row!.id;
    });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPayrollPayment(tx, ctxOf(s.human), {
        companyId: s.company, payrollDocumentId: draftRun,
        effectiveDate: "2026-04-05", branchId: s.hq,
      })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: payroll run .* is not posted/);
  });

  it("refuses a second batch for an employee already paid on this run", async () => {
    // Take the ONE draft the whole `describe` shares all the way to `posted`, through the real state
    // machine and the real posting service — submit as the preparer, approve and post as the payer (R1).
    // Only then ask for a second batch. Calling `postPayrollPayment` here instead would try to draft a
    // *second* document and would fail with this very error before it reached a transition, which passes
    // the assertion for the wrong reason and hides a regression in the state machine behind it.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s.human), { documentId: draft.documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, f.payer, (tx) =>
      transitionDocument(tx, ctxOf(f.payer), { documentId: draft.documentId, to: "approved" }));
    await withTenant(db.rw, s.tenant, f.payer, (tx) =>
      postDocument(tx, ctxOf(f.payer), { documentId: draft.documentId }));

    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPayrollPayment(tx, ctxOf(s.human), {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
        effectiveDate: "2026-02-07", branchId: s.hq,
      })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: every employee on payroll run .* is already paid/);
  });

  it("declares reversal.allowed = true, and the STATE MACHINE is what refuses it (Task 5's claim, pinned)", async () => {
    // Task 5 sets `reversal: { "allowed": true, "producesType": "PAYROLL_PAYMENT" }` and argues, at length,
    // that the *policy's* answer to "may a mispaid batch be reversed" is yes while `approval.required = true`
    // makes the inner `draft → issued` illegal, so `reverseDocument` raises `ERR_DOC_STATUS_ILLEGAL` in
    // practice (8B's amendment A4, mechanic 1 — mechanic 2 does not apply here, because amendment B9 means
    // these lines carry no `payroll_line` for a mirror to lose). A flag nothing exercises is a policy that
    // lies, so the claim is pinned here rather than left in prose. The batch posted by the previous case is
    // the subject; this `it` therefore runs after it and the file's order is load-bearing.
    await expect(withTenant(db.rw, s.tenant, f.payer, (tx) =>
      reverseDocument(tx, ctxOf(f.payer), {
        documentId: draft.documentId, effectiveDate: "2026-02-08", reason: "mispaid batch",
      })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);

    // …and the original is untouched: no mirror was left half-created.
    const [orig] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${draft.documentId}`;
    expect(orig!.status).toBe("posted");
    const mirrors = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where reverses_document_id = ${draft.documentId}`;
    expect(mirrors[0]!.n).toBe(0);
  });
});

describe("createEmployeeAdvance (spec:2082)", () => {
  it("drafts one line at the requested amount and reports the outstanding balance from the LEDGER", async () => {
    const documentId = await postEmployeeAdvance(db, s, f, {
      employeeId: f.employeeAId, amount: "250.0000", reason: "Advance against February",
    });
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) => readMoneyOut(tx, documentId));
    expect(r.employeeCount).toBe(1);
    expect(r.total.toString()).toBe("250.0000");

    const balance = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      advanceBalance(tx, { companyId: s.company, employeeId: f.employeeAId, asOf: "2026-01-31" }));
    expect(balance.toString()).toBe("250.0000");     // debit 1400 tagged EMPLOYEE, nothing recovered yet
  });

  it("refuses a non-positive amount", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      createEmployeeAdvance(tx, ctxOf(s.human), {
        companyId: s.company, employeeId: f.employeeAId, effectiveDate: "2026-01-10",
        branchId: s.hq, amount: Money.zero(MYR), reason: "nothing",
      })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: an advance must be greater than zero/);
  });

  it("refuses an employee of another company", async () => {
    const other = await seedTenantV2(db, "Other co");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      createEmployeeAdvance(tx, ctxOf(s.human), {
        companyId: s.company, employeeId: other.company, effectiveDate: "2026-01-10",
        branchId: s.hq, amount: Money.of("10.0000", MYR), reason: "wrong employee",
      })))
      .rejects.toThrow(MoneyOutError);
  });
});

describe("payrollBatchCsv (spec:2083 — bank-neutral)", () => {
  it("emits the fixed header and one quoted row per employee, CRLF-terminated", () => {
    const csv = payrollBatchCsv([
      { employeeNumber: "E-1", employeeName: "Aisyah, binti Omar", bankAccountMasked: "****4321",
        amount: "1234.5000", currency: "MYR", reference: "PAYB-1" },
    ]);
    expect(csv.split("\r\n")[0]).toBe(BATCH_CSV_HEADER.join(","));
    expect(csv).toContain('"Aisyah, binti Omar"');    // a comma inside a field is quoted, not escaped away
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("carries no bank-specific field — the header is exactly six columns", () => {
    expect(BATCH_CSV_HEADER).toEqual([
      "employee_number", "employee_name", "bank_account", "amount", "currency", "reference",
    ]);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
bun run --cwd packages/db test hr/money-out.test.ts
```

**Expected: FAIL** with `Cannot find module '../../src/hr/money-out'`. If instead `moneyOutFixture` throws `function app.employee_ytd_delta(uuid) does not exist`, migrations 0091–0092 have not been applied to the test container — run `bun run --cwd packages/db src/cli.ts up` first, or check that `startDb()`'s default `migrate: true` is in force.

- [ ] **Step 5: Write `packages/db/src/hr/batch-csv.ts`**

```ts
/**
 * spec:2083: "a bank-neutral CSV of the net-pay batch. **Bank-specific formats are out.**"
 *
 * Six columns, chosen because the data already has all six and no authority or bank is named by any of
 * them. RFC 4180 quoting, CRLF terminators: a field containing a comma, a quote or a newline is wrapped
 * in double quotes and its own quotes are doubled. Nothing here is locale-dependent — `amount` arrives as
 * a fixed-scale string from `Money.toString()` and is never formatted.
 */
export const BATCH_CSV_HEADER: readonly string[] = [
  "employee_number", "employee_name", "bank_account", "amount", "currency", "reference",
];

export interface BatchCsvRow {
  employeeNumber: string;
  employeeName: string;
  /** Masked in the service, never the raw account — the raw value lives only in `employee_sensitive` (8A). */
  bankAccountMasked: string;
  amount: string;
  currency: string;
  reference: string;
}

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function payrollBatchCsv(rows: readonly BatchCsvRow[]): string {
  const lines = [BATCH_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push([
      r.employeeNumber, r.employeeName, r.bankAccountMasked, r.amount, r.currency, r.reference,
    ].map(field).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
```

**`bankAccountMasked`, never `bankAccount`.** The real number is an `employee_sensitive` field behind 8A's `sensitive_gate` RESTRICTIVE policy (spec:2076) and is readable only with `hr.employee.read_sensitive` (§3.6.2's `module.resource.action`, not an underscore). Task 6's service therefore emits a masked form and **Task 13's OD-28 task is where the owner decides whether the verified bank layout needs the full number** — at which point it becomes a `hr.employee.read_sensitive`-gated download, not a widening of this function.

- [ ] **Step 6: Write `packages/db/src/hr/money-out.ts`**

```ts
import type { Sql } from "postgres";
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";
import { resolvePolicy } from "../posting/load";   // 1A's I/O half — the path 1A shipped (1a:2639)
import { ensureEmployeeDimensionValue } from "./employee-dimension";

export class MoneyOutError extends Error {
  constructor(
    readonly code: "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED" | "ERR_DOC_STATUS_ILLEGAL",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "MoneyOutError";
  }
}

export interface MoneyOutLine {
  documentLineId: string; employeeId: string; employeeNumber: string;
  employeeName: string; amount: Money; branchId: string;
}
/** `app.document_status`'s seven labels, as text. The service reads `status::text`, so this is the
 *  union the two route contracts' `filter[status][eq]` enums mirror. */
export type MoneyOutStatus =
  "draft" | "submitted" | "approved" | "issued" | "void" | "posted" | "reversed";
/**
 * **Nine members, and the four header fields are not optional decoration.** A route may not write SQL
 * (test 27's `no-bare-db`), so every field `PayrollPaymentSchema` and `EmployeeAdvanceSchema` put on the
 * wire — `number`, `status`, `effectiveDate`, `notes` among them — comes from this shape or from nowhere.
 * `draftMoneyOut` and `readMoneyOut` below both return exactly these nine, and TypeScript's
 * excess-property check on a returned object literal makes a shorter interface a compile error rather than
 * a silent narrowing.
 */
export interface MoneyOutResult {
  documentId: string; series: string;
  /** Null until `issueDocument` assigns it — numbering is at issue (§4.3.6). */
  number: string | null;
  status: MoneyOutStatus;
  effectiveDate: string;
  /** `payroll:<run id>` on a batch, `advance:<reason>` on an advance — `draftMoneyOut` writes both. */
  notes: string | null;
  employeeCount: number; total: Money; lines: MoneyOutLine[];
}
export interface MoneyOutListFilter {
  companyId: string;
  typeCode: "PAYROLL_PAYMENT" | "EMPLOYEE_ADVANCE";
  /** Matches `document.notes = 'payroll:<id>'` — the same marker `draftMoneyOut` writes. */
  payrollDocumentId?: string;
  employeeId?: string;
  status?: MoneyOutStatus;
  from?: string; to?: string;
  limit: number;
  /** Keyset on `(effective_date, id)`, decoded from the §4.2.8 cursor by the route. */
  cursor?: { effectiveDate: string; id: string } | null;
}
export interface PayrollPaymentInput {
  companyId: string; payrollDocumentId: string; effectiveDate: string; branchId: string;
  employeeIds?: readonly string[];
}
export interface EmployeeAdvanceInput {
  companyId: string; employeeId: string; effectiveDate: string; branchId: string;
  amount: Money; reason: string;
}

interface Candidate {
  employeeId: string; employeeNumber: string; employeeName: string;
  homeBranchId: string; amount: string;
}

async function typeIdFor(tx: Sql, companyId: string, code: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${companyId} and code = ${code} and archived_at is null`;
  if (!row) {
    throw new MoneyOutError("ERR_VALIDATION_FAILED",
      `document type ${code} is not configured for company ${companyId}; apply the document-types sub-pack`);
  }
  return row.id;
}

async function baseCurrencyOf(tx: Sql, companyId: string): Promise<CurrencyCode> {
  const [row] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${companyId}`;
  if (!row) throw new MoneyOutError("ERR_NOT_FOUND", `company ${companyId} is not visible`);
  return currency(row.base_currency);
}

/**
 * The shared write: one draft document plus one `kind: 'payroll'` line per candidate, each carrying the
 * EMPLOYEE'S OWN branch and EMPLOYEE dimension value in `document_line.dimensions` (amendments B8/B9).
 * No `payroll_line` row is written — that table is a 1:1 extension of a RUN's lines (§4.12.6) and 8D's
 * payroll register reads it as such.
 *
 * `amount` is the column the policy addresses (`"amount": "line.amount"`); `debit`/`credit` stay 0 and the
 * SIDE comes from the policy rule (§4.4.2 amendment A9 — direction is never inferred from a sign).
 */
async function draftMoneyOut(
  tx: Sql, ctx: TenantContext, opts: {
    companyId: string; typeCode: string; effectiveDate: string; branchId: string;
    candidates: readonly Candidate[]; notes: string | null;
  },
): Promise<MoneyOutResult> {
  const ccy = await baseCurrencyOf(tx, opts.companyId);
  const documentTypeId = await typeIdFor(tx, opts.companyId, opts.typeCode);

  // **`document.series` is `not null` (plan0A:1780) and it is written HERE, on the draft.** Numbering is at
  // issue (§4.3.6) — `number` and `fiscal_period_id` stay null until the posting service assigns them — but
  // the *series* is a column of every document from the moment it exists, so a draft insert that omits it is
  // a NOT NULL violation, not a null value. The series is read from the resolved policy rather than written
  // as a literal: `PAYB` and `ADV` are declared once, in the two §4.3.7 envelopes of Task 5, and a second
  // spelling here would be a literal that could drift from the file the posting service actually reads at
  // issue. (8B writes `'PAY'` inline at 8b:4375; this is the same fact expressed without the duplicate.)
  const { definition } = await resolvePolicy(tx, documentTypeId, opts.effectiveDate);
  const series = definition.numbering.series;

  const [doc] = await tx<{
    id: string; series: string; number: string | null; status: MoneyOutStatus;
    effective_date: string; notes: string | null;
  }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, branch_id, status,
                              effective_date, currency, exchange_rate, created_by, notes)
    values (${ctx.tenantId}, ${opts.companyId}, ${documentTypeId}, ${series}, ${opts.branchId}, 'draft',
            ${opts.effectiveDate}::date, ${ccy}, 1, app.current_actor(), ${opts.notes})
    returning id, series, number::text as number, status::text as status,
              to_char(effective_date, 'YYYY-MM-DD') as effective_date, notes`;

  const lines: MoneyOutLine[] = [];
  let lineNo = 0;
  for (const c of opts.candidates) {
    lineNo += 1;
    const employeeValueId = await ensureEmployeeDimensionValue(tx, opts.companyId, c.employeeId);
    const [line] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, amount, dimensions)
      values (${ctx.tenantId}, ${opts.companyId}, ${doc!.id}, ${lineNo}, 'payroll',
              ${`${c.employeeNumber} ${c.employeeName}`}, ${c.amount},
              ${JSON.stringify({ BRANCH: c.homeBranchId, EMPLOYEE: employeeValueId })}::jsonb)
      returning id`;
    lines.push({
      documentLineId: line!.id, employeeId: c.employeeId, employeeNumber: c.employeeNumber,
      employeeName: c.employeeName, amount: Money.of(c.amount, ccy), branchId: c.homeBranchId,
    });
  }

  return {
    documentId: doc!.id,
    series: doc!.series,
    number: doc!.number,
    status: doc!.status,
    effectiveDate: doc!.effective_date,
    notes: doc!.notes,
    employeeCount: lines.length,
    total: lines.reduce((a, l) => a.add(l.amount), Money.zero(ccy)),
    lines,
  };
}

export async function createPayrollPayment(
  tx: Sql, ctx: TenantContext, input: PayrollPaymentInput,
): Promise<MoneyOutResult> {
  const [run] = await tx<{ status: string; period_start: string; period_end: string }[]>`
    select d.status::text as status,
           to_char(r.period_start, 'YYYY-MM-DD') as period_start,
           to_char(r.period_end,   'YYYY-MM-DD') as period_end
      from app.payroll_run r join app.document d on d.id = r.document_id
     where r.document_id = ${input.payrollDocumentId} and r.company_id = ${input.companyId}`;
  if (!run) throw new MoneyOutError("ERR_NOT_FOUND", `payroll run ${input.payrollDocumentId} is not visible`);
  if (run.status !== "posted") {
    throw new MoneyOutError("ERR_DOC_STATUS_ILLEGAL",
      `payroll run ${input.payrollDocumentId} is not posted (status ${run.status})`);
  }

  // The net pay per employee is the `account` line the run service wrote (8B's rules 6/7) — read, never
  // recomputed, so the batch and the ledger cannot disagree about what net was.
  // A payment already made for this run is excluded: `document_line.description` is not a key, so the
  // exclusion is by the EMPLOYEE dimension value on a posted or in-flight PAYROLL_PAYMENT that names the
  // same run through `document.notes`, which `draftMoneyOut` writes as `payroll:<run id>`.
  const candidates = await tx<Candidate[]>`
    with net as (
      select pl.employee_id, sum(pl.amount)::numeric(19,4) as amount
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${input.payrollDocumentId} and dl.kind = 'account'
       group by pl.employee_id
    ),
    paid as (
      select (dl.dimensions ->> 'EMPLOYEE') as employee_value_id
        from app.document d
        join app.document_line dl on dl.document_id = d.id
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'PAYROLL_PAYMENT'
         and d.company_id = ${input.companyId}
         and d.notes = ${`payroll:${input.payrollDocumentId}`}
         and d.status <> 'void'
    )
    select e.id as "employeeId", e.employee_number as "employeeNumber", p.name_en as "employeeName",
           e.home_branch_id as "homeBranchId", to_char(n.amount, 'FM999999999999990.0000') as amount
      from net n
      join app.employee e on e.id = n.employee_id
      join app.party    p on p.id = e.party_id
      -- **The EMPLOYEE dimension value is reached THROUGH its type.** `app.dimension_value` has no
      -- `company_id` (plan0A:1820–1832) — the company lives on `app.dimension_type` — so the join is two
      -- hops, and the `dt.code = 'EMPLOYEE'` predicate is not optional either: without it a BRANCH value
      -- whose code happened to equal an employee number would match and exclude a real employee from the
      -- batch. This is the shape `advanceBalance` below uses, for the same reason.
      left join app.dimension_type dt
             on dt.company_id = ${input.companyId} and dt.code = 'EMPLOYEE'
      left join app.dimension_value dv
             on dv.dimension_type_id = dt.id and dv.code = e.employee_number
     where n.amount > 0
       and (${input.employeeIds ?? null}::uuid[] is null or e.id = any(${input.employeeIds ?? null}::uuid[]))
       and (dv.id is null or dv.id::text not in (select employee_value_id from paid))
     order by e.employee_number`;

  if (candidates.length === 0) {
    throw new MoneyOutError("ERR_VALIDATION_FAILED",
      `every employee on payroll run ${input.payrollDocumentId} is already paid`);
  }

  return draftMoneyOut(tx, ctx, {
    companyId: input.companyId, typeCode: "PAYROLL_PAYMENT",
    effectiveDate: input.effectiveDate, branchId: input.branchId,
    candidates, notes: `payroll:${input.payrollDocumentId}`,
  });
}

export async function createEmployeeAdvance(
  tx: Sql, ctx: TenantContext, input: EmployeeAdvanceInput,
): Promise<MoneyOutResult> {
  if (!input.amount.isPositive()) {
    throw new MoneyOutError("ERR_VALIDATION_FAILED", "an advance must be greater than zero");
  }
  if (input.reason.trim().length === 0) {
    throw new MoneyOutError("ERR_VALIDATION_FAILED", "an advance needs a reason");
  }
  const [e] = await tx<{ employee_number: string; name_en: string; home_branch_id: string }[]>`
    select e.employee_number, p.name_en, e.home_branch_id
      from app.employee e join app.party p on p.id = e.party_id
     where e.id = ${input.employeeId} and e.company_id = ${input.companyId} and e.terminated_on is null`;
  if (!e) {
    throw new MoneyOutError("ERR_NOT_FOUND",
      `employee ${input.employeeId} is not an active employee of company ${input.companyId}`);
  }

  return draftMoneyOut(tx, ctx, {
    companyId: input.companyId, typeCode: "EMPLOYEE_ADVANCE",
    effectiveDate: input.effectiveDate, branchId: input.branchId,
    candidates: [{
      employeeId: input.employeeId, employeeNumber: e.employee_number, employeeName: e.name_en,
      homeBranchId: e.home_branch_id, amount: input.amount.toString(),
    }],
    notes: `advance:${input.reason}`,
  });
}

export async function readMoneyOut(tx: Sql, documentId: string): Promise<MoneyOutResult> {
  const [doc] = await tx<{
    company_id: string; series: string; number: string | null; status: MoneyOutStatus;
    effective_date: string; notes: string | null;
  }[]>`
    select company_id, series, number::text as number, status::text as status,
           to_char(effective_date, 'YYYY-MM-DD') as effective_date, notes
      from app.document where id = ${documentId}`;
  if (!doc) throw new MoneyOutError("ERR_NOT_FOUND", `document ${documentId} is not visible`);
  const ccy = await baseCurrencyOf(tx, doc.company_id);

  const rows = await tx<{
    documentLineId: string; employeeId: string; employeeNumber: string; employeeName: string;
    amount: string; branchId: string;
  }[]>`
    select dl.id as "documentLineId", e.id as "employeeId", e.employee_number as "employeeNumber",
           p.name_en as "employeeName", to_char(dl.amount, 'FM999999999999990.0000') as amount,
           (dl.dimensions ->> 'BRANCH') as "branchId"
      from app.document_line dl
      left join app.dimension_value dv on dv.id = (dl.dimensions ->> 'EMPLOYEE')::uuid
      left join app.employee e on e.company_id = dl.company_id and e.employee_number = dv.code
      left join app.party    p on p.id = e.party_id
     where dl.document_id = ${documentId} and dl.kind = 'payroll'
     order by dl.line_no`;

  const lines: MoneyOutLine[] = rows.map((r) => ({
    documentLineId: r.documentLineId, employeeId: r.employeeId, employeeNumber: r.employeeNumber,
    employeeName: r.employeeName, amount: Money.of(r.amount, ccy), branchId: r.branchId,
  }));
  return {
    documentId, series: doc.series, number: doc.number, status: doc.status,
    effectiveDate: doc.effective_date, notes: doc.notes, employeeCount: lines.length,
    total: lines.reduce((a, l) => a.add(l.amount), Money.zero(ccy)), lines,
  };
}

/**
 * The list behind both `GET /` routes. Keyset on `(effective_date, id)` — the pair the §4.2.8 cursor
 * carries — because `effective_date` alone is not unique and an OFFSET page shifts under a concurrent
 * draft. Every filter is a typed member: no field name reaches SQL as text (test 27).
 *
 * It reads the headers in one statement and then calls `readMoneyOut` per row rather than joining the
 * lines in. A batch has at most a few hundred lines and a page at most `limit` batches, and one shape of
 * "what a money-out document looks like" is worth more than one round trip — a second assembly here is
 * the drift hazard 9 forbids.
 */
export async function listMoneyOut(tx: Sql, filter: MoneyOutListFilter): Promise<MoneyOutResult[]> {
  const cursorDate = filter.cursor?.effectiveDate ?? null;
  const cursorId = filter.cursor?.id ?? null;
  const rows = await tx<{ id: string }[]>`
    select d.id
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.company_id = ${filter.companyId}
       and t.code = ${filter.typeCode}
       and (${filter.payrollDocumentId ?? null}::text is null
            or d.notes = ${filter.payrollDocumentId ? `payroll:${filter.payrollDocumentId}` : null})
       and (${filter.status ?? null}::text is null or d.status::text = ${filter.status ?? null})
       and (${filter.from ?? null}::date is null or d.effective_date >= ${filter.from ?? null}::date)
       and (${filter.to ?? null}::date is null   or d.effective_date <= ${filter.to ?? null}::date)
       and (${filter.employeeId ?? null}::uuid is null or exists (
             select 1
               from app.document_line dl
               join app.dimension_value dv on dv.id = (dl.dimensions ->> 'EMPLOYEE')::uuid
               join app.dimension_type  dt on dt.id = dv.dimension_type_id and dt.code = 'EMPLOYEE'
               join app.employee e on e.company_id = d.company_id and e.employee_number = dv.code
              where dl.document_id = d.id and e.id = ${filter.employeeId ?? null}::uuid))
       and (${cursorDate}::date is null
            or (d.effective_date, d.id) > (${cursorDate}::date, ${cursorId}::uuid))
     order by d.effective_date, d.id
     limit ${filter.limit}`;

  const out: MoneyOutResult[] = [];
  for (const row of rows) out.push(await readMoneyOut(tx, row.id));
  return out;
}

/**
 * spec:2082: "the outstanding balance is a LEDGER PROJECTION, never a loan ledger." Debits to `1400`
 * tagged with the employee, minus credits — the advance-recovery `pay_component` posts the credit as part
 * of the next PAYROLL run, so nothing here knows about a recovery schedule and there is no second table.
 */
export async function advanceBalance(
  tx: Sql, input: { companyId: string; employeeId: string; asOf: string },
): Promise<Money> {
  const ccy = await baseCurrencyOf(tx, input.companyId);
  const [row] = await tx<{ balance: string }[]>`
    select to_char(coalesce(sum(le.base_debit) - sum(le.base_credit), 0), 'FM999999999999990.0000') as balance
      from app.ledger_entry le
      join app.account a on a.id = le.account_id
      -- `entry_id`, not `ledger_entry_id`: Plan 0A's join table is
      -- `app.ledger_entry_dimension(tenant_id, entry_id, dimension_type_id, dimension_value_id)`
      -- (plan0A:2041–2050) and it is frozen (hazard 8).
      join app.ledger_entry_dimension led on led.entry_id = le.id
      join app.dimension_value dv on dv.id = led.dimension_value_id
      join app.dimension_type  dt on dt.id = dv.dimension_type_id
      join app.employee e on e.company_id = le.company_id and e.employee_number = dv.code
     where le.company_id = ${input.companyId}
       and a.code = '1400'
       and dt.code = 'EMPLOYEE'
       and e.id = ${input.employeeId}
       and le.effective_date <= ${input.asOf}::date`;
  return Money.of(row!.balance, ccy);
}
```

- [ ] **Step 7: Write the two Zod contracts modules**

`packages/contracts/src/hr/payroll-payment.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, DateSchema, ListEnvelope, MoneySchema, UuidSchema } from "../common";

export const PayrollPaymentLineSchema = z.object({
  documentLineId: UuidSchema,
  employeeId: UuidSchema,
  employeeNumber: z.string(),
  employeeName: z.string(),
  amount: MoneySchema,
  branchId: UuidSchema,
}).openapi("PayrollPaymentLine");

export const PayrollPaymentSchema = z.object({
  documentId: UuidSchema,
  series: z.string(),
  number: z.string().nullable(),
  status: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]),
  effectiveDate: DateSchema,
  payrollDocumentId: UuidSchema,
  employeeCount: z.number().int().nonnegative(),
  total: MoneySchema,
  lines: z.array(PayrollPaymentLineSchema),
}).openapi("PayrollPayment");

export const CreatePayrollPaymentBody = z.object({
  payrollDocumentId: UuidSchema,
  effectiveDate: DateSchema,
  branchId: UuidSchema,
  employeeIds: z.array(UuidSchema).min(1).optional(),
}).openapi("CreatePayrollPaymentBody");

/** Layer-2 of the one list-filter convention (§4.2.8): literal `filter[…]` keys, checked by Zod. */
export const PayrollPaymentQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  "filter[payrollDocumentId][eq]": UuidSchema.optional(),
  "filter[status][eq]": z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]).optional(),
  "filter[effectiveDate][gte]": DateSchema.optional(),
  "filter[effectiveDate][lte]": DateSchema.optional(),
});

export const PayrollPaymentList = ListEnvelope(PayrollPaymentSchema).openapi("PayrollPaymentList");
```

`packages/contracts/src/hr/employee-advance.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, DateSchema, ListEnvelope, MoneySchema, UuidSchema } from "../common";

export const EmployeeAdvanceSchema = z.object({
  documentId: UuidSchema,
  series: z.string(),
  number: z.string().nullable(),
  status: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]),
  effectiveDate: DateSchema,
  employeeId: UuidSchema,
  employeeNumber: z.string(),
  employeeName: z.string(),
  amount: MoneySchema,
  reason: z.string(),
}).openapi("EmployeeAdvance");

export const CreateEmployeeAdvanceBody = z.object({
  employeeId: UuidSchema,
  effectiveDate: DateSchema,
  branchId: UuidSchema,
  amount: MoneySchema,
  reason: z.string().min(1).max(500),
}).openapi("CreateEmployeeAdvanceBody");

export const EmployeeAdvanceBalanceSchema = z.object({
  employeeId: UuidSchema,
  asOf: DateSchema,
  balance: MoneySchema,
}).openapi("EmployeeAdvanceBalance");

export const EmployeeAdvanceQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  "filter[employeeId][eq]": UuidSchema.optional(),
  "filter[status][eq]": z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]).optional(),
});

export const EmployeeAdvanceList = ListEnvelope(EmployeeAdvanceSchema).openapi("EmployeeAdvanceList");
```

- [ ] **Step 8: Write the two route modules**

`apps/api/src/routes/hr/payroll-payments.ts` — four routes: create, list, read, and the CSV download.

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { UuidSchema, decodeCursor, encodeCursor } from "@dulja/contracts/common";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  CreatePayrollPaymentBody, PayrollPaymentList, PayrollPaymentQuery, PayrollPaymentSchema,
} from "@dulja/contracts/hr/payroll-payment";
import {
  createPayrollPayment, listMoneyOut, MoneyOutError, payrollBatchCsv, readMoneyOut,
} from "@dulja/db";
import type { MoneyOutResult } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader, type RouteModule } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const payrollPaymentRoutes = new OpenAPIHono<AppEnv>();

const asAppError = (e: unknown): never => {
  if (e instanceof MoneyOutError) throw new AppError(e.code, e.detail);
  throw e;
};

/** `document.notes` is `payroll:<run id>` on every batch — `draftMoneyOut` writes it (Step 6) and
 *  `createPayrollPayment` reads it back to exclude an employee already paid on that run. A batch without
 *  it is a row this module did not create, which is a bug and not a client error. */
const payrollRunOf = (notes: string | null): string => {
  const id = notes?.startsWith("payroll:") === true ? notes.slice("payroll:".length) : null;
  if (id === null) {
    throw new AppError("ERR_INTERNAL", `payroll payment carries no payroll: note (notes = ${notes ?? "null"})`);
  }
  return id;
};

/** The ONE place a `MoneyOutResult` becomes `PayrollPaymentSchema`'s body. Every route below returns
 *  through it, so the `201`, the list item and the detail are the same object by construction. */
const present = (r: MoneyOutResult): z.infer<typeof PayrollPaymentSchema> => ({
  documentId: r.documentId,
  series: r.series,
  number: r.number,
  status: r.status,
  effectiveDate: r.effectiveDate,
  payrollDocumentId: payrollRunOf(r.notes),
  employeeCount: r.employeeCount,
  total: r.total.toJSON(),
  lines: r.lines.map((l) => ({
    documentLineId: l.documentLineId,
    employeeId: l.employeeId,
    employeeNumber: l.employeeNumber,
    employeeName: l.employeeName,
    amount: l.amount.toJSON(),
    branchId: l.branchId,
  })),
});

payrollPaymentRoutes.openapi(
  createRoute({
    method: "post", path: "/",
    request: { headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreatePayrollPaymentBody } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: PayrollPaymentSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      422: { description: "Unprocessable", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    // `hr.payroll.pay` gates the RELEASE. Approval and posting are accounting.payment.* through the
    // shared transitions route, which is what keeps the two-person rule (spec:2082, R1).
    middleware: [requirePermission(PERMISSION["hr.payroll.pay"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const body = c.req.valid("json");
    const companyId = c.req.param("companyId")!;
    const result = await c.var.withTenant((tx) =>
      createPayrollPayment(tx, c.var.ctx, {
        companyId, payrollDocumentId: body.payrollDocumentId,
        effectiveDate: body.effectiveDate, branchId: body.branchId, employeeIds: body.employeeIds,
      })).catch(asAppError);
    return c.json(present(result), 201);
  },
);

payrollPaymentRoutes.openapi(
  createRoute({
    method: "get", path: "/",
    request: { query: PayrollPaymentQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PayrollPaymentList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const q = c.req.valid("query");
    const companyId = c.req.param("companyId")!;
    // Keyset on `(effective_date, id)` through the ONE cursor codec (§4.2.8) — a base64url round-trip
    // written here would be a second spelling of it (hazard 9).
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    const items = await c.var.withTenant((tx) =>
      listMoneyOut(tx, {
        companyId, typeCode: "PAYROLL_PAYMENT",
        payrollDocumentId: q["filter[payrollDocumentId][eq]"],
        status: q["filter[status][eq]"],
        from: q["filter[effectiveDate][gte]"],
        to: q["filter[effectiveDate][lte]"],
        limit: q.limit,
        cursor: cursor === null ? null : { effectiveDate: String(cursor.k[0]), id: cursor.id },
      })).catch(asAppError);
    const last = items.at(-1);
    return c.json({
      items: items.map(present),
      next_cursor: items.length < q.limit || last === undefined
        ? null
        : encodeCursor({ k: [last.effectiveDate], id: last.documentId }),
    }, 200);
  },
);

payrollPaymentRoutes.openapi(
  createRoute({
    method: "get", path: "/{documentId}",
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PayrollPaymentSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) => readMoneyOut(tx, documentId)).catch(asAppError);
    return c.json(present(result), 200);
  },
);

payrollPaymentRoutes.openapi(
  createRoute({
    method: "get", path: "/{documentId}/csv",
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: { description: "The bank-neutral batch file", content: { "text/csv": { schema: z.string() } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) => readMoneyOut(tx, documentId)).catch(asAppError);
    const reference = result.number === null ? result.series : `${result.series}-${result.number}`;
    const csv = payrollBatchCsv(result.lines.map((l) => ({
      employeeNumber: l.employeeNumber,
      employeeName: l.employeeName,
      // **A CONSTANT MASK, and not a read of the real number.** The account itself is
      // `employee_sensitive.bank_account_enc`, behind 8A's `sensitive_gate` RESTRICTIVE policy
      // (spec:2076), and this route is gated on `hr.payroll.read`, not `hr.employee.read_sensitive` —
      // widening it here would be the side channel test 32 exists to close. Task 13 is where the owner's
      // verified layout decides whether a bank file needs the digits, and it becomes a separately gated
      // download rather than a change to this line.
      bankAccountMasked: "****",
      amount: l.amount.toString(),
      currency: l.amount.currency,
      reference,
    })));
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-batch-${reference}.csv"`,
    });
  },
);

export const payrollPaymentRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/payroll-payments",
  router: payrollPaymentRoutes,
  permissions: [PERMISSION["hr.payroll.pay"], PERMISSION["hr.payroll.read"]],
  auth: "human",
};
```

⚠️ **The CSV route is a `GET` and therefore carries no `Idempotency-Key`** — §4.2.9 requires the header on unsafe methods only, and the route writes nothing. It is deliberately **not** added to `REPLAY_BY_RERUN` (2C's list is for unsafe, write-free routes whose body is not JSON; a `GET` never reaches the idempotency middleware at all).

`apps/api/src/routes/hr/employee-advances.ts` — four routes: create, list, read, and the per-employee balance.

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { DateSchema, UuidSchema, decodeCursor, encodeCursor } from "@dulja/contracts/common";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  CreateEmployeeAdvanceBody, EmployeeAdvanceBalanceSchema, EmployeeAdvanceList,
  EmployeeAdvanceQuery, EmployeeAdvanceSchema,
} from "@dulja/contracts/hr/employee-advance";
import { advanceBalance, createEmployeeAdvance, listMoneyOut, MoneyOutError, readMoneyOut } from "@dulja/db";
import type { MoneyOutResult } from "@dulja/db";
import { Money, currency } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { IdempotencyHeader, type RouteModule } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const employeeAdvanceRoutes = new OpenAPIHono<AppEnv>();

const asAppError = (e: unknown): never => {
  if (e instanceof MoneyOutError) throw new AppError(e.code, e.detail);
  throw e;
};

/** `document.notes` is `advance:<reason>` — `createEmployeeAdvance` writes it (Step 6). */
const reasonOf = (notes: string | null): string =>
  notes?.startsWith("advance:") === true ? notes.slice("advance:".length) : "";

/** An advance has exactly one line, by construction: `createEmployeeAdvance` passes one candidate. */
const present = (r: MoneyOutResult): z.infer<typeof EmployeeAdvanceSchema> => {
  const line = r.lines[0];
  if (line === undefined) {
    throw new AppError("ERR_INTERNAL", `employee advance ${r.documentId} has no payroll line`);
  }
  return {
    documentId: r.documentId,
    series: r.series,
    number: r.number,
    status: r.status,
    effectiveDate: r.effectiveDate,
    employeeId: line.employeeId,
    employeeNumber: line.employeeNumber,
    employeeName: line.employeeName,
    amount: line.amount.toJSON(),
    reason: reasonOf(r.notes),
  };
};

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "post", path: "/",
    request: { headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreateEmployeeAdvanceBody } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: EmployeeAdvanceSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      422: { description: "Unprocessable", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.advance.create"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const body = c.req.valid("json");
    const companyId = c.req.param("companyId")!;
    const result = await c.var.withTenant(async (tx) => {
      // **The currency is checked here and not in the service**, because the refusal is about the REQUEST:
      // `Money.add` would raise `ERR_MONEY_CURRENCY_MISMATCH` deep inside `draftMoneyOut` (§4.2.1) and the
      // operator would see a 500 for a body they could have fixed.
      const [company] = await tx<{ base_currency: string }[]>`
        select base_currency from app.company where id = ${companyId}`;
      if (company === undefined) throw new AppError("ERR_NOT_FOUND", `no company ${companyId}`);
      if (body.amount.currency !== company.base_currency) {
        throw new AppError("ERR_VALIDATION_FAILED",
          `an advance is paid in the company's base currency ${company.base_currency}, not ${body.amount.currency}`);
      }
      return createEmployeeAdvance(tx, c.var.ctx, {
        companyId, employeeId: body.employeeId, effectiveDate: body.effectiveDate,
        branchId: body.branchId, amount: Money.of(body.amount.amount, currency(body.amount.currency)),
        reason: body.reason,
      });
    }).catch(asAppError);
    return c.json(present(result), 201);
  },
);

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "get", path: "/",
    request: { query: EmployeeAdvanceQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: EmployeeAdvanceList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const q = c.req.valid("query");
    const companyId = c.req.param("companyId")!;
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    const items = await c.var.withTenant((tx) =>
      listMoneyOut(tx, {
        companyId, typeCode: "EMPLOYEE_ADVANCE",
        employeeId: q["filter[employeeId][eq]"],
        status: q["filter[status][eq]"],
        limit: q.limit,
        cursor: cursor === null ? null : { effectiveDate: String(cursor.k[0]), id: cursor.id },
      })).catch(asAppError);
    const last = items.at(-1);
    return c.json({
      items: items.map(present),
      next_cursor: items.length < q.limit || last === undefined
        ? null
        : encodeCursor({ k: [last.effectiveDate], id: last.documentId }),
    }, 200);
  },
);

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "get", path: "/{documentId}",
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: EmployeeAdvanceSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) => readMoneyOut(tx, documentId)).catch(asAppError);
    return c.json(present(result), 200);
  },
);

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "get", path: "/balances/{employeeId}",
    // `/balances/{employeeId}` and NOT `/{employeeId}/balance`: the two `{…}` segments would otherwise
    // both match `/{documentId}`, and a document id and an employee id are the same shape, so the router
    // would resolve by declaration order and one of the two routes would be unreachable.
    request: {
      params: z.object({ companyId: UuidSchema, employeeId: UuidSchema }),
      query: z.object({ asOf: DateSchema }),
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: EmployeeAdvanceBalanceSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const balance = await c.var.withTenant((tx) =>
      advanceBalance(tx, { companyId, employeeId, asOf })).catch(asAppError);
    return c.json({ employeeId, asOf, balance: balance.toJSON() }, 200);
  },
);

export const employeeAdvanceRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/employee-advances",
  router: employeeAdvanceRoutes,
  permissions: [PERMISSION["hr.advance.create"], PERMISSION["hr.payroll.read"]],
  auth: "human",
};
```

**The two modules' import blocks are symmetric, and `payroll-payments.ts`'s was the one that drifted.** It uses `listMoneyOut` (the list route), `MoneyOutResult` (as `present`'s parameter type), `UuidSchema` (the two `params` objects), and `decodeCursor` / `encodeCursor` (the keyset round-trip) — all five are now in the block above, where `employee-advances.ts` already had them. It does **not** use `Money` or `currency`: the CSV route reads `l.amount.toString()` and `l.amount.currency` off a `Money` the service already built, and the batch total is never re-summed here. That line is therefore gone rather than kept "for symmetry" — `oxlint` reports an unused import and `bun run lint` is a definition-of-done command for every task (Global Constraint 17).

⚠️ **`EmployeeAdvanceBalanceSchema` carries `asOf`, so the route must be given one.** `advanceBalance` has no default date and inventing `today` in a handler would make the answer depend on the clock (spec:2039). `asOf` is therefore a **required** query parameter, and the balance case of Step 10's test passes it explicitly.

- [ ] **Step 9: Mount both in `buildRoutes` and add the two `PROBES` entries**

`apps/api/src/routes/index.ts` — inside `buildRoutes(deps)`, never by pushing onto `ROUTES` (§4.2.7):

```ts
    payrollPaymentRouteModule,
    employeeAdvanceRouteModule,
```

`tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/payroll-payments": {
    async seed(db, owner) {
      // The victim's run and batch exist; the attacker asks for them by id and must be refused.
      const s = await moneyOutFixture(db, owner);
      const documentId = await postPayrollPayment(db, owner, s);
      return { path: `/v1/companies/${owner.company}/payroll-payments/${documentId}`, method: "GET" };
    },
    expect: 404,
  },
  "/v1/companies/:companyId/employee-advances": {
    async seed(db, owner) {
      const s = await moneyOutFixture(db, owner);
      const documentId = await postEmployeeAdvance(db, owner, s, {
        employeeId: s.employeeAId, amount: "100.0000", reason: "probe",
      });
      return { path: `/v1/companies/${owner.company}/employee-advances/${documentId}`, method: "GET" };
    },
    expect: 404,
  },
```

**404 and not 403**, matching the registry's rule that a cross-tenant read never reveals existence (§4.2.4's `ERR_NOT_FOUND` row).

- [ ] **Step 10: Write the two route tests**

`apps/api/test/routes/hr/payroll-payments.test.ts` asserts, through `startApi()`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import { grantAdmin } from "../../../../../tests/support/api";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { moneyOutFixture, type MoneyOutFixture } from "../../../../../tests/invariants/support/payroll-money";
import type { Problem } from "@dulja/contracts";

let api: StartedApi; let s: Seed; let f: MoneyOutFixture;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "PAYB routes");
  f = await moneyOutFixture(api.db, s);
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => { await api.stop(); });

describe("POST /v1/companies/{companyId}/payroll-payments", () => {
  it("403s a principal without hr.payroll.pay", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-payments`, as: s.human,
      body: { payrollDocumentId: f.payrollDocumentId, effectiveDate: "2026-02-05", branchId: s.hq },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s without an Idempotency-Key", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-payments`, as: f.payer,
      idempotencyKey: null,
      body: { payrollDocumentId: f.payrollDocumentId, effectiveDate: "2026-02-05", branchId: s.hq },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("201s for the payroll officer and replays the same key", async () => {
    await grantAdmin(api, s);                       // the officer in this suite holds hr.payroll.pay via admin
    const key = crypto.randomUUID();
    const body = { payrollDocumentId: f.payrollDocumentId, effectiveDate: "2026-02-05", branchId: s.hq };
    const first = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-payments`, as: s.human,
      body, idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const second = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-payments`, as: s.human,
      body, idempotencyKey: key,
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });

  it("GET …/{id}/csv returns text/csv with the six-column header and no bank-specific field", async () => {
    const created = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-payments`, as: s.human,
      body: { payrollDocumentId: f.payrollDocumentId, effectiveDate: "2026-02-06", branchId: s.hq },
    });
    const { documentId } = (await created.json()) as { documentId: string };
    const csv = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/payroll-payments/${documentId}/csv`, as: s.human,
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("employee_number,employee_name,bank_account,amount,currency,reference");
  });
});
```

`apps/api/test/routes/hr/employee-advances.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import {
  moneyOutFixture, postEmployeeAdvance, type MoneyOutFixture,
} from "../../../../../tests/invariants/support/payroll-money";
import { grantAdmin } from "../../../../../tests/support/api";
import type { Problem } from "@dulja/contracts";

let api: StartedApi; let s: Seed; let f: MoneyOutFixture;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "ADV routes");
  f = await moneyOutFixture(api.db, s);
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => { await api.stop(); });

const body = (over: Record<string, unknown> = {}) => ({
  employeeId: f.employeeAId, effectiveDate: "2026-01-10", branchId: s.hq,
  amount: { amount: "250.0000", currency: "MYR" }, reason: "Advance against February", ...over,
});

describe("POST /v1/companies/{companyId}/employee-advances", () => {
  it("403s a principal without hr.advance.create", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/employee-advances`, as: f.payer, body: body(),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s without an Idempotency-Key", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/employee-advances`, as: f.payer,
      idempotencyKey: null, body: body(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("201s for the payroll officer and returns the amount as MoneySchema's shape", async () => {
    await grantAdmin(api, s);                     // the officer in this suite holds hr.advance.create via admin
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/employee-advances`, as: s.human, body: body(),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      documentId: string; status: string; number: string | null;
      amount: { amount: string; currency: string }; reason: string; employeeId: string;
    };
    expect(created.status).toBe("draft");
    expect(created.number).toBeNull();            // numbering is at issue (§4.3.6)
    expect(created.amount).toEqual({ amount: "250.0000", currency: "MYR" });
    expect(created.reason).toBe("Advance against February");
    expect(created.employeeId).toBe(f.employeeAId);
  });

  it("422s an amount in a currency that is not the company's base currency", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/employee-advances`, as: s.human,
      body: body({ amount: { amount: "250.0000", currency: "USD" } }),
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/base currency MYR, not USD/);
  });

  it("422s a non-positive amount, with the service's own sentence", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/employee-advances`, as: s.human,
      body: body({ amount: { amount: "0.0000", currency: "MYR" } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).detail).toMatch(/an advance must be greater than zero/);
  });
});

describe("GET /v1/companies/{companyId}/employee-advances", () => {
  it("lists the drafts for one employee and pages with a cursor", async () => {
    const res = await api.request({
      method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/employee-advances?filter[employeeId][eq]=${f.employeeAId}&limit=1`,
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: { employeeId: string }[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.employeeId).toBe(f.employeeAId);
    // The page is FULL at `limit=1`, so the handler cannot know there is nothing after it and issues a
    // cursor. A null here would mean the route decided "no more" from a full page, which is the classic
    // keyset off-by-one.
    expect(page.next_cursor).not.toBeNull();
  });

  it("404s an id that does not resolve — never a 200 with an empty body", async () => {
    // The CROSS-TENANT case is the `PROBES` entry (Step 9), which the isolation harness runs for every
    // module; asking it here as a second tenant would only prove that a principal with no role assignment
    // gets 403 from `requirePermission`, which is a different fact.
    const res = await api.request({
      method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/employee-advances/00000000-0000-7000-8000-000000000000`,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
  });
});

describe("GET /v1/companies/{companyId}/employee-advances/balances/{employeeId}", () => {
  it("returns the LEDGER figure for a posted advance, as of a named date", async () => {
    const posted = await postEmployeeAdvance(api.db, s, f, {
      employeeId: f.employeeBId, amount: "100.0000", reason: "balance case",
    });
    expect(posted).toBeTruthy();
    const res = await api.request({
      method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/employee-advances/balances/${f.employeeBId}?asOf=2026-01-31`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      employeeId: f.employeeBId, asOf: "2026-01-31",
      balance: { amount: "100.0000", currency: "MYR" },
    });
  });

  it("400s without asOf — a balance never defaults to the clock (spec:2039)", async () => {
    const res = await api.request({
      method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/employee-advances/balances/${f.employeeBId}`,
    });
    expect(res.status).toBe(400);
  });
});
```

**`postEmployeeAdvance` is imported from `tests/invariants/support/payroll-money` beside `moneyOutFixture`** — the balance case needs a *posted* advance and the route only drafts, so it goes through the fixture's submit → approve → post rather than a second copy of that sequence here.

- [ ] **Step 11: Regenerate OpenAPI, run everything, commit**

```bash
bun run --cwd packages/contracts openapi:generate
bun run --cwd packages/db test hr/money-out.test.ts
bun run --cwd apps/api test routes/hr
bun run --cwd tests test invariants/tenant-isolation.test.ts
bun run lint && bun run lint:rules && bun run typecheck && bun run format:check
```

**Expected: PASS.** The isolation harness is the one to watch: it fails the build when a `ROUTES` entry has no `PROBES` entry, so a module mounted in Step 9 without its probe fails here rather than silently.

```bash
git add packages/db/src/hr/money-out.ts packages/db/src/hr/batch-csv.ts packages/db/src/index.ts \
        packages/contracts/src/hr/payroll-payment.ts packages/contracts/src/hr/employee-advance.ts \
        packages/contracts/openapi.json \
        apps/api/src/routes/hr/payroll-payments.ts apps/api/src/routes/hr/employee-advances.ts \
        apps/api/src/routes/index.ts \
        tests/invariants/support/payroll-money.ts tests/invariants/probes.ts \
        packages/db/test/hr/money-out.test.ts \
        apps/api/test/routes/hr/payroll-payments.test.ts apps/api/test/routes/hr/employee-advances.test.ts
git commit -m "feat(api): PAYROLL_PAYMENT and EMPLOYEE_ADVANCE services and routes [8C T6]

Release under hr.payroll.pay / hr.advance.create; approval and posting stay
accounting.payment.* on the shared state machine. Every line carries the
EMPLOYEE'S branch, not the batch's. The advance balance is a ledger projection,
never a loan ledger (spec:2082). The CSV is bank-neutral (spec:2083).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Statutory schedules — generated from posted lines, with the generic CSV as an attachment

**Files:**
- Create: `packages/db/src/hr/schedule.ts`, `packages/contracts/src/hr/statutory-schedule.ts`, `apps/api/src/routes/hr/statutory-schedules.ts`
- Modify: `packages/db/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/contracts/openapi.json`
- Test: `packages/db/test/hr/schedule.test.ts`, `apps/api/test/routes/hr/statutory-schedules.test.ts`

**Interfaces:**
- Consumes: `withTenant` / `TenantContext` (§4.2.2), `Money` / `currency` (§4.2.1), `ObjectStore` / `objectKeyFor` (2C, `packages/db/src/attachment/object-store.ts`), `app.attachment` (2C), `app.statutory_schedule` (T1), `app.payroll_run` / `app.payroll_line` / `app.statutory_scheme` (8A/8B), `requirePermission` / `PERMISSION` (§4.2.5), `RouteModule` / `IdempotencyHeader` / `PROBES` (§4.2.7), `ListEnvelope` / `ListQuery` / `UuidSchema` / `DateSchema` / `MoneySchema` (§4.2.8), `startApi` (§4.2.12), `moneyOutFixture` / `MoneyOutFixture` (T6).
- Produces:

```ts
// packages/db/src/hr/schedule.ts
import type { Sql } from "postgres";
import type { Money } from "@dulja/domain";
import type { ObjectStore } from "../attachment/object-store";
import type { TenantContext } from "../with-tenant";

export interface ScheduleRow {
  employeeNumber: string; employeeName: string; employeeShare: string; employerShare: string;
  /** The scheme reference from the employee's statutory profile, blank when the profile has none. */
  schemeReference: string;
}
export interface StatutoryScheduleResult {
  scheduleId: string; schemeId: string; schemeCode: string;
  periodStart: string; periodEnd: string; payrollDocumentId: string;
  totalEmployee: Money; totalEmployer: Money; currency: string;
  attachmentId: string | null; remittanceDocumentId: string | null;
  rows: ScheduleRow[];
}
export interface GenerateScheduleInput {
  companyId: string;
  /** The POSTED PAYROLL run. Generation from anything else is refused (spec:2083). */
  payrollDocumentId: string;
  /** Omit to generate one schedule per scheme the run touched. */
  schemeIds?: readonly string[];
  /** Writes the generic CSV as an `app.attachment` and links it. Default true. */
  attachCsv?: boolean;
}
export async function generateStatutorySchedule(
  tx: Sql, ctx: TenantContext, store: ObjectStore, input: GenerateScheduleInput,
): Promise<StatutoryScheduleResult[]>;

export async function readSchedule(tx: Sql, scheduleId: string): Promise<StatutoryScheduleResult>;
export interface ListScheduleFilter {
  companyId: string; schemeId?: string; from?: string; to?: string;
  settled?: boolean; limit: number; cursor?: { periodStart: string; id: string } | null;
}
export async function listSchedules(tx: Sql, filter: ListScheduleFilter): Promise<StatutoryScheduleResult[]>;

/** The generic layout of OD-28's default. Task 13 is where a verified authority layout replaces it. */
export const SCHEDULE_CSV_HEADER: readonly string[];
export function scheduleCsv(result: StatutoryScheduleResult): string;

export class ScheduleError extends Error {
  constructor(readonly code: "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED" | "ERR_DOC_STATUS_ILLEGAL", readonly detail: string);
}
```

- [ ] **Step 1: Write the failing test `packages/db/test/hr/schedule.test.ts`**

```ts
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../../src/attachment/object-store";
import {
  generateStatutorySchedule, listSchedules, readSchedule, SCHEDULE_CSV_HEADER, ScheduleError, scheduleCsv,
} from "../../src/hr/schedule";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { moneyOutFixture, type MoneyOutFixture } from "../../../../tests/invariants/support/payroll-money";

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let s: Seed; let f: MoneyOutFixture; let store: MemoryObjectStore;
let schemeCode: string;
const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Schedules");
  f = await moneyOutFixture(db, s);
  store = new MemoryObjectStore();
  // **Read the scheme's code; never write `"SYNTH"` into an assertion.** 8B's `payrollFixture` seeds its
  // scheme with `code: "EPF"` (8b:4155) — only the *rate table* is `SYNTH`, which is what keeps hazard 1
  // satisfied — so a literal here fails on the first run and would keep failing for a reason that has
  // nothing to do with this task. The FK is the question the assertion actually asks.
  const [scheme] = await db.admin<{ code: string }[]>`
    select code from app.statutory_scheme where id = ${f.schemeId}`;
  schemeCode = scheme!.code;
}, 240_000);
afterAll(async () => { await db.stop(); });

describe("generateStatutorySchedule (spec:2083 — a record, from POSTED lines only)", () => {
  it("writes one row per scheme the run touched, with the employee and employer totals", async () => {
    const results = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(), store, {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
      }));
    expect(results).toHaveLength(1);                    // payrollFixture seeds exactly one scheme
    const r = results[0]!;
    expect(r.schemeCode).toBe(schemeCode);
    expect(r.periodStart).toBe("2026-01-01");
    expect(r.periodEnd).toBe("2026-01-31");
    expect(r.rows).toHaveLength(2);                     // two employees
    expect(r.totalEmployee.toString()).toBe(
      r.rows.reduce((a, row) => a + Number(row.employeeShare), 0).toFixed(4));
    expect(r.totalEmployer.toString()).toBe(
      r.rows.reduce((a, row) => a + Number(row.employerShare), 0).toFixed(4));
  });

  it("is idempotent on (scheme, period, run) — a second call updates rather than duplicating", async () => {
    const again = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(), store, {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
      }));
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.statutory_schedule
       where payroll_document_id = ${f.payrollDocumentId}`;
    expect(rows[0]!.n).toBe(1);
    expect(again[0]!.scheduleId).toBe(
      (await db.admin<{ id: string }[]>`
        select id from app.statutory_schedule where payroll_document_id = ${f.payrollDocumentId}`)[0]!.id);
  });

  it("refuses a run that is not posted (spec:2083 'generated from posted lines only')", async () => {
    const draftRun = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.document (tenant_id, company_id, document_type_id, series, branch_id, status,
                                  effective_date, currency, exchange_rate, created_by)
        select ${s.tenant}, ${s.company}, document_type_id, series, ${s.hq}, 'draft',
               '2026-03-31', 'MYR', 1, ${s.human}
          from app.document where id = ${f.payrollDocumentId}
        returning id`;
      await tx`
        insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end,
                                     pay_date, pinned_tables)
        values (${row!.id}, ${s.tenant}, ${s.company}, 'regular', '2026-03-01', '2026-03-31',
                '2026-04-05', '[]'::jsonb)`;
      return row!.id;
    });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(), store, { companyId: s.company, payrollDocumentId: draftRun })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: payroll run .* is not posted/);
  });

  it("attaches the CSV and records its sha256 on app.attachment", async () => {
    const [result] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(), store, {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId, attachCsv: true,
      }));
    expect(result!.attachmentId).not.toBeNull();
    const [att] = await db.admin<{ mime_type: string; sha256: Buffer; object_key: string; byte_size: string }[]>`
      select mime_type, sha256, object_key, byte_size::text from app.attachment where id = ${result!.attachmentId}`;
    expect(att!.mime_type).toBe("text/csv");
    const bytes = await store.get(att!.object_key);
    expect(createHash("sha256").update(bytes).digest().equals(att!.sha256)).toBe(true);
    expect(Number(att!.byte_size)).toBe(bytes.byteLength);
    expect(new TextDecoder().decode(bytes)).toBe(scheduleCsv(result!));
  });
});

describe("scheduleCsv (OD-28's default — a GENERIC layout)", () => {
  it("has the five documented columns and names no authority, form or box", () => {
    expect(SCHEDULE_CSV_HEADER).toEqual([
      "employee_number", "employee_name", "scheme_reference", "employee_share", "employer_share",
    ]);
    const [result] = await0(withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, { companyId: s.company, limit: 1 })));
    const csv = scheduleCsv(result!);
    expect(csv.split("\r\n")[0]).toBe(SCHEDULE_CSV_HEADER.join(","));
    expect(csv).not.toMatch(/LHDN|EPF|KWSP|SOCSO|PERKESO|EIS|PCB|CP\d|borang/i);
  });
});

describe("listSchedules and readSchedule", () => {
  it("readSchedule raises ERR_NOT_FOUND for an invisible id", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      readSchedule(tx, "00000000-0000-7000-8000-000000000000")))
      .rejects.toThrow(ScheduleError);
  });

  it("filters by settled state", async () => {
    const unsettled = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, { companyId: s.company, settled: false, limit: 100 }));
    expect(unsettled.length).toBeGreaterThan(0);
    for (const r of unsettled) expect(r.remittanceDocumentId).toBeNull();
  });
});
```

⚠️ **`await0` in the CSV block is a typo you must not copy.** The block's `it` callback must be `async` and the call is a plain `await`; the shape is:

```ts
  it("has the five documented columns and names no authority, form or box", async () => {
    expect(SCHEDULE_CSV_HEADER).toEqual([
      "employee_number", "employee_name", "scheme_reference", "employee_share", "employer_share",
    ]);
    const [result] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, { companyId: s.company, limit: 1 }));
    const csv = scheduleCsv(result!);
    expect(csv.split("\r\n")[0]).toBe(SCHEDULE_CSV_HEADER.join(","));
    expect(csv).not.toMatch(/LHDN|EPF|KWSP|SOCSO|PERKESO|EIS|PCB|CP\d|borang/i);
  });
```

It is called out rather than silently fixed because an implementer reading only this task must see the corrected form; **write the block immediately above, not the one in the suite listing.** The two differences are the whole point: the callback is `async`, and `await0(...)` — which is not a function and never was — is a plain `await` on the `withTenant` call.

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/db test hr/schedule.test.ts
```

**Expected: FAIL** with `Cannot find module '../../src/hr/schedule'`.

- [ ] **Step 3: Write `packages/db/src/hr/schedule.ts`**

```ts
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import type { ObjectStore } from "../attachment/object-store";
import { objectKeyFor } from "../attachment/object-store";
import type { TenantContext } from "../with-tenant";

export class ScheduleError extends Error {
  constructor(
    readonly code: "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED" | "ERR_DOC_STATUS_ILLEGAL",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ScheduleError";
  }
}

export interface ScheduleRow {
  employeeNumber: string; employeeName: string;
  employeeShare: string; employerShare: string; schemeReference: string;
}
export interface StatutoryScheduleResult {
  scheduleId: string; schemeId: string; schemeCode: string;
  periodStart: string; periodEnd: string; payrollDocumentId: string;
  totalEmployee: Money; totalEmployer: Money; currency: string;
  attachmentId: string | null; remittanceDocumentId: string | null;
  rows: ScheduleRow[];
}

/**
 * OD-28's DEFAULT layout. Five columns, every one of them a field the data already carries, and **no
 * authority, form, box or file-version is named** (hazard 2). Task 13 is the isolated gate where a
 * verified authority layout is added as a second writer beside this one.
 */
export const SCHEDULE_CSV_HEADER: readonly string[] = [
  "employee_number", "employee_name", "scheme_reference", "employee_share", "employer_share",
];

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function scheduleCsv(result: StatutoryScheduleResult): string {
  const lines = [SCHEDULE_CSV_HEADER.join(",")];
  for (const r of result.rows) {
    lines.push([
      r.employeeNumber, r.employeeName, r.schemeReference, r.employeeShare, r.employerShare,
    ].map(field).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export interface GenerateScheduleInput {
  companyId: string; payrollDocumentId: string;
  schemeIds?: readonly string[]; attachCsv?: boolean;
}

export async function generateStatutorySchedule(
  tx: Sql, ctx: TenantContext, store: ObjectStore, input: GenerateScheduleInput,
): Promise<StatutoryScheduleResult[]> {
  const [run] = await tx<{
    status: string; period_start: string; period_end: string; base_currency: string;
  }[]>`
    select d.status::text as status,
           to_char(r.period_start, 'YYYY-MM-DD') as period_start,
           to_char(r.period_end,   'YYYY-MM-DD') as period_end,
           c.base_currency
      from app.payroll_run r
      join app.document d on d.id = r.document_id
      join app.company  c on c.id = r.company_id
     where r.document_id = ${input.payrollDocumentId} and r.company_id = ${input.companyId}`;
  if (!run) {
    throw new ScheduleError("ERR_NOT_FOUND", `payroll run ${input.payrollDocumentId} is not visible`);
  }
  if (run.status !== "posted") {
    // spec:2083, verbatim: "generated from posted lines only".
    throw new ScheduleError("ERR_DOC_STATUS_ILLEGAL",
      `payroll run ${input.payrollDocumentId} is not posted (status ${run.status})`);
  }
  const ccy = currency(run.base_currency);

  const schemes = await tx<{ scheme_id: string; scheme_code: string }[]>`
    select distinct pl.scheme_id, ss.code as scheme_code
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.statutory_scheme ss on ss.id = pl.scheme_id
     where dl.document_id = ${input.payrollDocumentId}
       and pl.scheme_id is not null
       and (${input.schemeIds ?? null}::uuid[] is null
            or pl.scheme_id = any(${input.schemeIds ?? null}::uuid[]))
     order by ss.code`;

  const out: StatutoryScheduleResult[] = [];
  for (const scheme of schemes) {
    const rows = await tx<ScheduleRow>`
      select e.employee_number as "employeeNumber",
             p.name_en as "employeeName",
             coalesce(sp.extra ->> 'scheme_reference', '') as "schemeReference",
             to_char(coalesce(sum(pl.amount) filter (where pl.share = 'employee'), 0), 'FM999999999999990.0000') as "employeeShare",
             to_char(coalesce(sum(pl.amount) filter (where pl.share = 'employer'), 0), 'FM999999999999990.0000') as "employerShare"
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.employee e on e.id = pl.employee_id
        join app.party    p on p.id = e.party_id
        left join app.employee_statutory_profile sp
               on sp.employee_id = e.id
              and sp.effective_from <= ${run.period_end}::date
              and (sp.effective_to is null or sp.effective_to >= ${run.period_end}::date)
       where dl.document_id = ${input.payrollDocumentId} and pl.scheme_id = ${scheme.scheme_id}
       group by e.employee_number, p.name_en, sp.extra
       order by e.employee_number`;

    const totalEmployee = rows.reduce((a, r) => a.add(Money.of(r.employeeShare, ccy)), Money.zero(ccy));
    const totalEmployer = rows.reduce((a, r) => a.add(Money.of(r.employerShare, ccy)), Money.zero(ccy));

    // Idempotent on the natural key §4.6.1 fixes: `(scheme_id, period_start, payroll_document_id)`.
    //
    // `do update` and not `do nothing` so that a **second generation of the same run** returns the current
    // row rather than raising `ERR_CONFLICT_UNIQUE` — the officer regenerating a schedule after an
    // attachment was lost is the ordinary case. It is worth being precise about what that path can and
    // cannot do: `scheduleRowsFor` reads only `dl.document_id = ${payrollDocumentId}` and a posted run's
    // `payroll_line` rows are immutable (8B), so for one posted run the totals this computes are the same
    // totals every time and the `do update` is a no-op arithmetically. **A supplementary run is a different
    // document and therefore a different row**, never a conflict on this key — it does not move these
    // totals and was never meant to.
    //
    // The one path that could move a settled row's totals is a writer outside this function, and 0091's
    // guard is scoped to `remittance_document_id, total_employee, total_employer` for exactly that reason
    // (Task 1 Step 4): a move on a settled row is refused by the database, whichever code attempts it.
    const [row] = await tx<{ id: string; attachment_id: string | null; remittance_document_id: string | null }[]>`
      insert into app.statutory_schedule
        (tenant_id, company_id, scheme_id, period_start, period_end, payroll_document_id,
         total_employee, total_employer, currency)
      values (${ctx.tenantId}, ${input.companyId}, ${scheme.scheme_id},
              ${run.period_start}::date, ${run.period_end}::date, ${input.payrollDocumentId},
              ${totalEmployee.toString()}, ${totalEmployer.toString()}, ${ccy})
      on conflict (scheme_id, period_start, payroll_document_id) do update
         set total_employee = excluded.total_employee,
             total_employer = excluded.total_employer,
             currency       = excluded.currency
      returning id, attachment_id, remittance_document_id`;

    const result: StatutoryScheduleResult = {
      scheduleId: row!.id, schemeId: scheme.scheme_id, schemeCode: scheme.scheme_code,
      periodStart: run.period_start, periodEnd: run.period_end,
      payrollDocumentId: input.payrollDocumentId,
      totalEmployee, totalEmployer, currency: ccy,
      attachmentId: row!.attachment_id, remittanceDocumentId: row!.remittance_document_id,
      rows,
    };

    if (input.attachCsv !== false) {
      result.attachmentId = await attachCsv(tx, ctx, store, input.companyId, result);
    }
    out.push(result);
  }
  return out;
}

/**
 * Writes the CSV as an `app.attachment` with its sha256 (spec:2083 "attachment hash"), following 2C's
 * order exactly: the OBJECT first, then the row, so a row can never point at nothing. `objectKeyFor`
 * derives the key from the ids alone — a client path never reaches the store (LEGACY-038).
 */
async function attachCsv(
  tx: Sql, ctx: TenantContext, store: ObjectStore, companyId: string, result: StatutoryScheduleResult,
): Promise<string> {
  const bytes = new TextEncoder().encode(scheduleCsv(result));
  const sha256 = createHash("sha256").update(bytes).digest();
  const [existing] = await tx<{ attachment_id: string | null }[]>`
    select attachment_id from app.statutory_schedule where id = ${result.scheduleId}`;

  const attachmentId = existing?.attachment_id
    ?? (await tx<{ id: string }[]>`select uuidv7() as id`)[0]!.id;
  const objectKey = objectKeyFor(ctx.tenantId, attachmentId);
  await store.put(objectKey, bytes, "text/csv");

  // **`document_id` is not optional here, and it is the PAYROLL run, not the schedule.**
  // §4.5.8 gates an attachment download by the *owning module*: `requireAttachmentRead` resolves
  // `document_type.module` through `attachment.document_id` (or `inventory.item.read` through a `lot_id`),
  // and an attachment with neither has no module to map — 2C's map ends in a default deny, so a schedule CSV
  // written without this column would upload cleanly and then be undownloadable by anyone, forever, with an
  // `ERR_RBAC_FORBIDDEN` that names no missing permission. `app.statutory_schedule` is not a document and
  // never becomes one (Task 1: "a record, not a lodgement state machine"), so the natural owner is the run
  // the figures were generated from — whose type is `PAYROLL`, whose module is `hr`, and whose read code is
  // therefore `hr.payroll.read`. That is also the right answer on the merits: this file lists per-employee
  // statutory shares, which is exactly the payroll-confidential class test 32 asks about.
  await tx`
    insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type,
                                byte_size, sha256)
    values (${attachmentId}, ${ctx.tenantId}, ${companyId}, ${result.payrollDocumentId}, ${objectKey},
            ${`${result.schemeCode}-${result.periodStart}.csv`}, 'text/csv', ${bytes.byteLength}, ${sha256})
    on conflict (id) do update
       set byte_size = excluded.byte_size, sha256 = excluded.sha256`;
  await tx`
    update app.statutory_schedule set attachment_id = ${attachmentId} where id = ${result.scheduleId}`;
  return attachmentId;
}
```

**`readSchedule` and `listSchedules`, in the same file, below `attachCsv`.** Both re-derive `rows` through **`scheduleRowsFor`** — the one grouped query `generateStatutorySchedule` already used, lifted out of it so a list and a regeneration can never disagree about a per-employee share (hazard 9: one arithmetic, one place).

```ts
/**
 * The per-employee rows of one schedule. Lifted out of `generateStatutorySchedule` so that the generator,
 * `readSchedule` and `listSchedules` all answer with the same numbers; the generator's own loop calls it
 * with the run and scheme it is generating for.
 */
async function scheduleRowsFor(
  tx: Sql, payrollDocumentId: string, schemeId: string, periodEnd: string,
): Promise<ScheduleRow[]> {
  return tx<ScheduleRow[]>`
    select e.employee_number as "employeeNumber",
           p.name_en as "employeeName",
           coalesce(sp.extra ->> 'scheme_reference', '') as "schemeReference",
           to_char(coalesce(sum(pl.amount) filter (where pl.share = 'employee'), 0), 'FM999999999999990.0000') as "employeeShare",
           to_char(coalesce(sum(pl.amount) filter (where pl.share = 'employer'), 0), 'FM999999999999990.0000') as "employerShare"
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.employee e on e.id = pl.employee_id
      join app.party    p on p.id = e.party_id
      left join app.employee_statutory_profile sp
             on sp.employee_id = e.id
            and sp.effective_from <= ${periodEnd}::date
            and (sp.effective_to is null or sp.effective_to >= ${periodEnd}::date)
     where dl.document_id = ${payrollDocumentId} and pl.scheme_id = ${schemeId}
     group by e.employee_number, p.name_en, sp.extra
     order by e.employee_number`;
}

interface ScheduleHeaderRow {
  id: string; scheme_id: string; scheme_code: string;
  period_start: string; period_end: string; payroll_document_id: string;
  total_employee: string; total_employer: string; currency: string;
  attachment_id: string | null; remittance_document_id: string | null;
}

/** The one header column list; `readSchedule` takes one row of it and `listSchedules` a page.
 *  It is a **postgres.js fragment** — a tagged template that is interpolated into another template rather
 *  than executed — which is the library's own composition mechanism and builds no SQL text (Global
 *  Constraint 3; there is no concatenation and no `sql.unsafe` here). */
const HEADER_COLUMNS = (tx: Sql) => tx`
  ss2.id, ss2.scheme_id, sc.code as scheme_code,
  to_char(ss2.period_start, 'YYYY-MM-DD') as period_start,
  to_char(ss2.period_end,   'YYYY-MM-DD') as period_end,
  ss2.payroll_document_id,
  to_char(ss2.total_employee, 'FM999999999999990.0000') as total_employee,
  to_char(ss2.total_employer, 'FM999999999999990.0000') as total_employer,
  ss2.currency, ss2.attachment_id, ss2.remittance_document_id`;

async function hydrate(tx: Sql, row: ScheduleHeaderRow): Promise<StatutoryScheduleResult> {
  const ccy = currency(row.currency);
  return {
    scheduleId: row.id, schemeId: row.scheme_id, schemeCode: row.scheme_code,
    periodStart: row.period_start, periodEnd: row.period_end,
    payrollDocumentId: row.payroll_document_id,
    totalEmployee: Money.of(row.total_employee, ccy),
    totalEmployer: Money.of(row.total_employer, ccy),
    currency: ccy,
    attachmentId: row.attachment_id,
    remittanceDocumentId: row.remittance_document_id,
    rows: await scheduleRowsFor(tx, row.payroll_document_id, row.scheme_id, row.period_end),
  };
}

export async function readSchedule(tx: Sql, scheduleId: string): Promise<StatutoryScheduleResult> {
  const [row] = await tx<ScheduleHeaderRow[]>`
    select ${HEADER_COLUMNS(tx)}
      from app.statutory_schedule ss2
      join app.statutory_scheme sc on sc.id = ss2.scheme_id
     where ss2.id = ${scheduleId}`;
  if (!row) throw new ScheduleError("ERR_NOT_FOUND", `statutory schedule ${scheduleId} is not visible`);
  return hydrate(tx, row);
}

export interface ListScheduleFilter {
  companyId: string; schemeId?: string; from?: string; to?: string;
  settled?: boolean; limit: number; cursor?: { periodStart: string; id: string } | null;
}

/**
 * Keyset on `(period_start, id)` — the pair the §4.2.8 cursor carries — because `period_start` repeats
 * across schemes and an OFFSET page shifts under a concurrent generation. `settled` is the presence of
 * `remittance_document_id` and nothing else: a schedule is a record, not a lodgement state machine
 * (spec:2083), so there is no status column for it to read.
 */
export async function listSchedules(
  tx: Sql, filter: ListScheduleFilter,
): Promise<StatutoryScheduleResult[]> {
  const cursorDate = filter.cursor?.periodStart ?? null;
  const cursorId = filter.cursor?.id ?? null;
  const rows = await tx<ScheduleHeaderRow[]>`
    select ${HEADER_COLUMNS(tx)}
      from app.statutory_schedule ss2
      join app.statutory_scheme sc on sc.id = ss2.scheme_id
     where ss2.company_id = ${filter.companyId}
       and (${filter.schemeId ?? null}::uuid is null or ss2.scheme_id = ${filter.schemeId ?? null}::uuid)
       and (${filter.from ?? null}::date is null or ss2.period_start >= ${filter.from ?? null}::date)
       and (${filter.to ?? null}::date is null   or ss2.period_start <= ${filter.to ?? null}::date)
       and (${filter.settled ?? null}::boolean is null
            or (ss2.remittance_document_id is not null) = ${filter.settled ?? null}::boolean)
       and (${cursorDate}::date is null
            or (ss2.period_start, ss2.id) > (${cursorDate}::date, ${cursorId}::uuid))
     order by ss2.period_start, ss2.id
     limit ${filter.limit}`;

  const out: StatutoryScheduleResult[] = [];
  for (const row of rows) out.push(await hydrate(tx, row));
  return out;
}
```

**`generateStatutorySchedule` calls `scheduleRowsFor` too.** Replace its inline `const rows = await tx<ScheduleRow>\`…\`` block with

```ts
    const rows = await scheduleRowsFor(tx, input.payrollDocumentId, scheme.scheme_id, run.period_end);
```

— the same statement, in one place. The alias `ss2` in the header select is deliberate: `ss` is already the `statutory_scheme` alias inside `scheduleRowsFor`'s neighbourhood in this file, and two meanings for one alias in one module is how a copied predicate ends up querying the wrong table.

⚠️ **`employee_statutory_profile.extra ->> 'scheme_reference'`.** 8A ships `extra jsonb not null default '{}'` on that table as the ⚠️ OD-28 slot for verified additions; this reads it and **falls back to an empty string** rather than assuming the key exists. It is not an invented field name: the column is 8A's and the key is a **local convention of the generic layout**, which Task 13 replaces wholesale if the owner's verified layout names the reference differently.

- [ ] **Step 4: Write `packages/contracts/src/hr/statutory-schedule.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, DateSchema, ListEnvelope, MoneySchema, UuidSchema } from "../common";

export const ScheduleRowSchema = z.object({
  employeeNumber: z.string(),
  employeeName: z.string(),
  schemeReference: z.string(),
  employeeShare: z.string().regex(/^-?\d+\.\d{4}$/),
  employerShare: z.string().regex(/^-?\d+\.\d{4}$/),
}).openapi("StatutoryScheduleRow");

export const StatutoryScheduleSchema = z.object({
  scheduleId: UuidSchema,
  schemeId: UuidSchema,
  schemeCode: z.string(),
  periodStart: DateSchema,
  periodEnd: DateSchema,
  payrollDocumentId: UuidSchema,
  totalEmployee: MoneySchema,
  totalEmployer: MoneySchema,
  attachmentId: UuidSchema.nullable(),
  remittanceDocumentId: UuidSchema.nullable(),
  rows: z.array(ScheduleRowSchema),
}).openapi("StatutorySchedule");

export const GenerateStatutoryScheduleBody = z.object({
  payrollDocumentId: UuidSchema,
  schemeIds: z.array(UuidSchema).min(1).optional(),
}).openapi("GenerateStatutoryScheduleBody");

export const SettleStatutoryScheduleBody = z.object({
  remittanceDocumentId: UuidSchema,
}).openapi("SettleStatutoryScheduleBody");

export const StatutoryScheduleQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  "filter[schemeId][eq]": UuidSchema.optional(),
  "filter[periodStart][gte]": DateSchema.optional(),
  "filter[periodStart][lte]": DateSchema.optional(),
  "filter[settled][eq]": z.enum(["true", "false"]).optional(),
});

export const StatutoryScheduleList = ListEnvelope(StatutoryScheduleSchema).openapi("StatutoryScheduleList");
```

- [ ] **Step 5: Write `apps/api/src/routes/hr/statutory-schedules.ts` and mount it**

Five routes. Gates, and the reason for each:

| Route | Gate | Why |
|---|---|---|
| `POST /` (generate) | `hr.payroll.pay` | generating the record is part of paying the authority; it is a write, so the code must be `mutating` (R7) |
| `GET /` (list) | `hr.payroll.read` | the figures are per-employee pay, gated like every other payroll read |
| `GET /{scheduleId}` | `hr.payroll.read` | |
| `GET /{scheduleId}/csv` | `hr.payroll.read` | `text/csv`, `Content-Disposition: attachment; filename="<scheme>-<period>.csv"` |
| `POST /{scheduleId}/settle` | `hr.payroll.pay` | Task 8's `settleStatutorySchedule`; the trigger remains the control |

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { DateSchema, UuidSchema, decodeCursor, encodeCursor } from "@dulja/contracts/common";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  GenerateStatutoryScheduleBody, SettleStatutoryScheduleBody, StatutoryScheduleList,
  StatutoryScheduleQuery, StatutoryScheduleSchema,
} from "@dulja/contracts/hr/statutory-schedule";
import {
  ScheduleError, generateStatutorySchedule, listSchedules, readSchedule, scheduleCsv,
  settleStatutorySchedule, type ObjectStore, type StatutoryScheduleResult,
} from "@dulja/db";
import { RemittanceError } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader, type RouteModule } from "../index";
import { requirePermission } from "../../middleware/require-permission";

/**
 * **A FACTORY over the store, exactly as 2C's `createAttachmentRoutes(store)` is** (2c:1633, registered at
 * 2c:1706 as `router: createAttachmentRoutes(deps.objectStore)`). `AppDeps.objectStore` is `createApp`'s
 * sixth member and reaches a router by being *passed to it*, not by hanging off `c.var`; §4.2.3's `AppEnv`
 * is frozen and carries no `deps`. Amendment **B10** names this module's exports and this is their shape.
 */
export function createStatutoryScheduleRoutes(store: ObjectStore): OpenAPIHono<AppEnv> {
  const statutoryScheduleRoutes = new OpenAPIHono<AppEnv>();

// `RemittanceError.code` is already an `ERRORS` key — `ERR_PAYROLL_REMITTANCE_MISMATCH` included — so the
// translation is one map, not a switch. `packages/db` may not import `AppError` (§3.1), which is why both
// error classes carry a literal `code` for this line to use.
const asAppError = (e: unknown): never => {
  if (e instanceof ScheduleError || e instanceof RemittanceError) throw new AppError(e.code, e.detail);
  throw e;
};

const present = (r: StatutoryScheduleResult): z.infer<typeof StatutoryScheduleSchema> => ({
  scheduleId: r.scheduleId,
  schemeId: r.schemeId,
  schemeCode: r.schemeCode,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  payrollDocumentId: r.payrollDocumentId,
  totalEmployee: r.totalEmployee.toJSON(),
  totalEmployer: r.totalEmployer.toJSON(),
  attachmentId: r.attachmentId,
  remittanceDocumentId: r.remittanceDocumentId,
  rows: r.rows,
});

statutoryScheduleRoutes.openapi(
  createRoute({
    method: "post", path: "/",
    request: { headers: IdempotencyHeader, body: { content: { "application/json": { schema: GenerateStatutoryScheduleBody } } } },
    responses: {
      201: { description: "Generated", content: { "application/json": { schema: StatutoryScheduleList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      422: { description: "Unprocessable", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.pay"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const body = c.req.valid("json");
    const companyId = c.req.param("companyId")!;
    // `store` is the factory's parameter — the one `createApp` was built with. The handler never
    // constructs an `ObjectStore`; only the isolation probe, which runs outside the app, does.
    const results = await c.var.withTenant((tx) =>
      generateStatutorySchedule(tx, c.var.ctx, store, {
        companyId, payrollDocumentId: body.payrollDocumentId, schemeIds: body.schemeIds,
      })).catch(asAppError);
    return c.json({ items: results.map(present), next_cursor: null }, 201);
  },
);

statutoryScheduleRoutes.openapi(
  createRoute({
    method: "get", path: "/",
    request: { query: StatutoryScheduleQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: StatutoryScheduleList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const q = c.req.valid("query");
    const companyId = c.req.param("companyId")!;
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    const settled = q["filter[settled][eq]"];
    const items = await c.var.withTenant((tx) =>
      listSchedules(tx, {
        companyId,
        schemeId: q["filter[schemeId][eq]"],
        from: q["filter[periodStart][gte]"],
        to: q["filter[periodStart][lte]"],
        settled: settled === undefined ? undefined : settled === "true",
        limit: q.limit,
        cursor: cursor === null ? null : { periodStart: String(cursor.k[0]), id: cursor.id },
      })).catch(asAppError);
    const last = items.at(-1);
    return c.json({
      items: items.map(present),
      next_cursor: items.length < q.limit || last === undefined
        ? null
        : encodeCursor({ k: [last.periodStart], id: last.scheduleId }),
    }, 200);
  },
);

statutoryScheduleRoutes.openapi(
  createRoute({
    method: "get", path: "/{scheduleId}",
    request: { params: z.object({ companyId: UuidSchema, scheduleId: UuidSchema }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: StatutoryScheduleSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { scheduleId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) => readSchedule(tx, scheduleId)).catch(asAppError);
    return c.json(present(result), 200);
  },
);

statutoryScheduleRoutes.openapi(
  createRoute({
    method: "get", path: "/{scheduleId}/csv",
    request: { params: z.object({ companyId: UuidSchema, scheduleId: UuidSchema }) },
    responses: {
      200: { description: "The generic schedule file", content: { "text/csv": { schema: z.string() } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { scheduleId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) => readSchedule(tx, scheduleId)).catch(asAppError);
    // Rendered from the row, not fetched from the object store: the attachment is the ARCHIVED copy with
    // its hash (spec:2083) and this is the live view of the same record. Task 7 Step 1's fourth case
    // asserts the two are byte-identical, which is what makes serving either one honest.
    return c.body(scheduleCsv(result), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.schemeCode}-${result.periodStart}.csv"`,
    });
  },
);

statutoryScheduleRoutes.openapi(
  createRoute({
    method: "post", path: "/{scheduleId}/settle",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, scheduleId: UuidSchema }),
      body: { content: { "application/json": { schema: SettleStatutoryScheduleBody } } },
    },
    responses: {
      200: { description: "Settled", content: { "application/json": { schema: StatutoryScheduleSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      422: { description: "Unprocessable", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.pay"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { scheduleId } = c.req.valid("param");
    const body = c.req.valid("json");
    // The 0091 trigger is the control. `settleStatutorySchedule` raises the same token the database does,
    // so a mismatch is 422 `ERR_PAYROLL_REMITTANCE_MISMATCH` whether it came from the service's own read
    // or from the `update` being refused — `fromDatabaseError` maps the DB token to the same row.
    const result = await c.var.withTenant((tx) =>
      settleStatutorySchedule(tx, c.var.ctx, {
        scheduleId, remittanceDocumentId: body.remittanceDocumentId,
      })).catch(asAppError);
    return c.json(present(result), 200);
  },
);

  return statutoryScheduleRoutes;
}

export const STATUTORY_SCHEDULES_PATH = "/v1/companies/:companyId/statutory-schedules";

/** Built inside `buildRoutes`, which is the only place the store is in scope (2c:1706's shape). */
export function statutoryScheduleRouteModule(store: ObjectStore): RouteModule {
  return {
    path: STATUTORY_SCHEDULES_PATH,
    router: createStatutoryScheduleRoutes(store),
    permissions: [PERMISSION["hr.payroll.pay"], PERMISSION["hr.payroll.read"]],
    auth: "human",
  };
}
```

`apps/api/src/routes/index.ts` mounts it inside `buildRoutes(deps)` beside T6's two, passing the store the same way 2C's attachments module is passed it:

```ts
    statutoryScheduleRouteModule(deps.objectStore),
```

⚠️ **`settleStatutorySchedule` is Task 8's function and this route is written in Task 7.** Write the module now with the `settle` route commented out or omitted **only if** you are executing Task 7 alone; PR 6 is `T7 + T8` (§ PR boundaries), so in the ordinary path both land together and the import resolves. `DateSchema` is imported for the query schema's date filters, which `StatutoryScheduleQuery` declares.

Add the third `PROBES` entry:

```ts
  "/v1/companies/:companyId/statutory-schedules": {
    async seed(db, owner) {
      const s = await moneyOutFixture(db, owner);
      const [schedule] = await withTenant(db.rw, owner.tenant, owner.human, (tx) =>
        generateStatutorySchedule(tx,
          { tenantId: owner.tenant, actorId: owner.human, requestId: "00000000-0000-0000-0000-000000000000" },
          new MemoryObjectStore(),
          { companyId: owner.company, payrollDocumentId: s.payrollDocumentId }));
      return { path: `/v1/companies/${owner.company}/statutory-schedules/${schedule!.scheduleId}`, method: "GET" };
    },
    expect: 404,
  },
```

**The route handler builds its own `MemoryObjectStore`? No — it is handed `AppDeps.objectStore`.** `createApp` carries the store as its sixth member (§4.2.7) and `buildRoutes(deps)` passes it into the module factory, which is exactly how 2C's `createAttachmentRoutes(deps.objectStore)` is registered (2c:1706). Only the **probe**, which runs outside the app, constructs one.

**Amendment B10 already carries the factory pair for this module** — its row in the header table reads *"**`createStatutoryScheduleRoutes(store)`** and **`statutoryScheduleRouteModule(store)`** — a factory pair"*, so T1 Step 1 files it as written and nothing here needs correcting. The reason it is a factory and not the module-level `export const <resource>Routes` of §4.2.7: a router that needs a dependency cannot be a constant, and §4.2.3's `AppEnv` is frozen with no `deps` member for a handler to read one from. It is 2C's `createAttachmentRoutes(deps.objectStore)` shape (2c:1633/1706).

- [ ] **Step 6: Write the route test and run everything**

`apps/api/test/routes/hr/statutory-schedules.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { moneyOutFixture, type MoneyOutFixture } from "../../../../../tests/invariants/support/payroll-money";
import { grantAdmin } from "../../../../../tests/support/api";
import type { Problem } from "@dulja/contracts";

let api: StartedApi; let s: Seed; let f: MoneyOutFixture;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "Schedule routes");
  f = await moneyOutFixture(api.db, s);
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => { await api.stop(); });

describe("POST /v1/companies/{companyId}/statutory-schedules", () => {
  it("403s a principal without hr.payroll.pay", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/statutory-schedules`, as: f.payer,
      body: { payrollDocumentId: f.payrollDocumentId },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s without an Idempotency-Key", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/statutory-schedules`, as: f.payer,
      idempotencyKey: null, body: { payrollDocumentId: f.payrollDocumentId },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("201s and returns both totals as MoneySchema's shape, never a bare string", async () => {
    await grantAdmin(api, s);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/statutory-schedules`, as: s.human,
      body: { payrollDocumentId: f.payrollDocumentId },
    });
    expect(res.status).toBe(201);
    const page = (await res.json()) as {
      items: { scheduleId: string; totalEmployee: { amount: string; currency: string };
               totalEmployer: { amount: string; currency: string };
               attachmentId: string | null; remittanceDocumentId: string | null }[];
    };
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.totalEmployee.currency).toBe("MYR");
    expect(item.totalEmployee.amount).toMatch(/^-?\d+\.\d{4}$/);
    expect(item.totalEmployer.amount).toMatch(/^-?\d+\.\d{4}$/);
    expect(item.attachmentId).not.toBeNull();          // the CSV was attached with its sha256
    expect(item.remittanceDocumentId).toBeNull();      // nothing has settled it yet
  });

  it("409s a run that is not posted — ERR_DOC_STATUS_ILLEGAL is a state conflict (§4.2.4)", async () => {
    const [draft] = await api.db.admin<{ id: string }[]>`
      insert into app.document (tenant_id, company_id, document_type_id, series, branch_id, status,
                                effective_date, currency, exchange_rate, created_by)
      select tenant_id, company_id, document_type_id, series, branch_id, 'draft',
             '2026-05-31', 'MYR', 1, created_by
        from app.document where id = ${f.payrollDocumentId}
      returning id`;
    await api.db.admin`
      insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end,
                                   pay_date, pinned_tables)
      select ${draft!.id}, tenant_id, company_id, 'regular', '2026-05-01', '2026-05-31', '2026-06-05', '[]'::jsonb
        from app.document where id = ${draft!.id}`;
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/statutory-schedules`, as: s.human,
      body: { payrollDocumentId: draft!.id },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_DOC_STATUS_ILLEGAL");
  });
});

describe("GET /v1/companies/{companyId}/statutory-schedules", () => {
  it("lists the unsettled schedules and pages with a cursor", async () => {
    const res = await api.request({
      method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/statutory-schedules?filter[settled][eq]=false&limit=10`,
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: { remittanceDocumentId: string | null }[]; next_cursor: string | null;
    };
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) expect(item.remittanceDocumentId).toBeNull();
    expect(page.next_cursor).toBeNull();               // fewer items than the limit
  });

  it("the CSV is text/csv, has the five documented columns, and names no authority, form or box", async () => {
    const list = await api.request({
      method: "GET", as: s.human, path: `/v1/companies/${s.company}/statutory-schedules?limit=1`,
    });
    const { items } = (await list.json()) as { items: { scheduleId: string }[] };
    const res = await api.request({
      method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/statutory-schedules/${items[0]!.scheduleId}/csv`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\r\n")[0])
      .toBe("employee_number,employee_name,scheme_reference,employee_share,employer_share");
    // **Hazard 2 at the WIRE, not only at the function.** What ships is what a reviewer sees, and a
    // header, a file name or a Content-Disposition naming an authority would ship exactly the same way.
    expect(text).not.toMatch(/LHDN|EPF|KWSP|SOCSO|PERKESO|EIS|PCB|CP\d|borang/i);
    expect(res.headers.get("content-disposition"))
      .not.toMatch(/LHDN|KWSP|PERKESO|borang/i);
  });

  it("403s a read without hr.payroll.read", async () => {
    const res = await api.request({
      method: "GET", as: f.payer, path: `/v1/companies/${s.company}/statutory-schedules?limit=1`,
    });
    expect(res.status).toBe(403);
  });
});
```

⚠️ **The CSV case's `Content-Disposition` assertion is deliberately loose about `EPF`.** `payrollFixture` seeds its scheme with `code: "EPF"` and the file name is `<schemeCode>-<periodStart>.csv`, so an authority-name regex over the *header* would fail on the fixture's own data. The body regex is the one that matters — no scheme code appears inside the generic layout — and the header is checked only against the authority names no code of ours ever produces. When Task 13's verified layouts land, the file name becomes the layout's and this assertion moves with it.

```bash
bun run --cwd packages/contracts openapi:generate
bun run --cwd packages/db test hr/schedule.test.ts
bun run --cwd apps/api test routes/hr/statutory-schedules.test.ts
bun run --cwd tests test invariants/tenant-isolation.test.ts
bun run lint && bun run lint:rules && bun run typecheck
```

**Expected: PASS.**

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/hr/schedule.ts packages/db/src/index.ts \
        packages/contracts/src/hr/statutory-schedule.ts packages/contracts/openapi.json \
        apps/api/src/routes/hr/statutory-schedules.ts apps/api/src/routes/index.ts \
        tests/invariants/probes.ts \
        packages/db/test/hr/schedule.test.ts apps/api/test/routes/hr/statutory-schedules.test.ts
git commit -m "feat(api): generate statutory schedules from posted lines [8C T7]

One row per scheme per period per run, idempotent on the natural key, with the
generic CSV attached and its sha256 recorded (spec:2083). No authority, form or
box is named anywhere — the verified layout is OD-28's isolated task.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Remittance settlement and acceptance test 30 — the payslip ties to the ledger

**Files:**
- Create: `packages/db/src/hr/remittance.ts`, `tests/invariants/payslip-ties-to-ledger.test.ts`
- Modify: `packages/db/src/index.ts`, `tests/invariants/support/payroll-money.ts` (`postRemittance`), `tests/regression/legacy-011.test.ts`, `tests/regression/legacy-019.test.ts`
- Test: `packages/db/test/hr/remittance.test.ts`

**Interfaces:**
- Consumes: `withTenant` / `TenantContext` (§4.2.2), `postDocument` / `transitionDocument` (§4.3.1), `Money` / `currency` (§4.2.1), `readSchedule` (T7), `readPayrollRun` / `PayrollRunDetail` (8B), `moneyOutFixture` / `postPayrollPayment` / `MoneyOutFixture` (T6), `fullRegression` / `sharedApi` / `problemOf` (§4.17.1, 0B), `thinRegression` / `sharedDb` (§4.17.1, 0B), `app.assert_remittance_matches_schedule` (T1).
- Produces:

```ts
// packages/db/src/hr/remittance.ts
export interface SettleScheduleInput { scheduleId: string; remittanceDocumentId: string }
/** Links the settling PAYMENT. The 0091 TRIGGER is the control; this is the better error message. */
export async function settleStatutorySchedule(
  tx: Sql, ctx: TenantContext, input: SettleScheduleInput,
): Promise<StatutoryScheduleResult>;
/** Clears the link — a mis-linked payment is unlinked, never edited (spec:2049). */
export async function unsettleStatutorySchedule(
  tx: Sql, ctx: TenantContext, input: { scheduleId: string; reason: string },
): Promise<StatutoryScheduleResult>;
export class RemittanceError extends Error {
  constructor(readonly code: "ERR_NOT_FOUND" | "ERR_PAYROLL_REMITTANCE_MISMATCH" | "ERR_VALIDATION_FAILED", readonly detail: string);
}
```

- [ ] **Step 1: Write the failing acceptance test `tests/invariants/payslip-ties-to-ledger.test.ts` — test 30 in full**

spec:2448, verbatim: *"For every employee in a run: payslip net = credit to salaries payable tagged EMPLOYEE; Σ(employee + employer share) per scheme = credit to that scheme's payable; the monthly schedule per scheme equals that payable to the cent; a remittance for a different amount is refused."* Four clauses, four `it`s.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "@dulja/db";
import { generateStatutorySchedule, readPayrollRun, settleStatutorySchedule } from "@dulja/db";
import { withTenant, type Db, type Seed } from "@dulja/db/test";
import { startDb, seedTenantV2 } from "@dulja/db/test";
import {
  moneyOutFixture, postPayrollPayment, postRemittance, type MoneyOutFixture,
} from "./support/payroll-money";

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let s: Seed; let f: MoneyOutFixture; let store: MemoryObjectStore;
let payableAccountId: string;
const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test 30");
  f = await moneyOutFixture(db, s);
  store = new MemoryObjectStore();

  // **Clauses 2 and 3 measure "that scheme's payable", so they read the account off the SCHEME, not off a
  // code literal.** Today the answer is `2411`: 8B's `payrollFixture` seeds its scheme with `code: "EPF"`
  // (8b:4077 — only the *rate table* is `SYNTH`, which is what keeps hazard 1 satisfied), and
  // `linkPayrollAccounts` assigns `2411`–`2414` in the fixed order EPF, SOCSO, EIS, PCB. Writing `'2411'`
  // into the assertion would silently bind this acceptance test to that ordering; if §4.15's four codes were
  // ever re-ordered, or the fixture's scheme renamed, the clause would compare a real total against an empty
  // sum and pass as `0 ≈ 0`. Reading the FK asks the question the spec clause actually asks.
  const [payable] = await db.admin<{ payable_account_id: string | null }[]>`
    select payable_account_id from app.statutory_scheme where id = ${f.schemeId}`;
  if (!payable?.payable_account_id) {
    throw new Error(
      "statutory_scheme.payable_account_id is null — 8B's linkPayrollAccounts has not run for this company. " +
      "moneyOutFixture should already have failed on this; if it did not, re-read Task 6 Step 2.");
  }
  payableAccountId = payable.payable_account_id;
}, 240_000);
afterAll(async () => { await db.stop(); });

/** The base credit on `code` for one employee, read through the EMPLOYEE dimension tag. */
async function creditFor(code: string, employeeId: string): Promise<string> {
  const [row] = await db.admin<{ amount: string }[]>`
    select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
      from app.ledger_entry le
      join app.account a on a.id = le.account_id
      -- `entry_id` is the column Plan 0A shipped (plan0A:2041–2050) and it is frozen (hazard 8).
      join app.ledger_entry_dimension led on led.entry_id = le.id
      join app.dimension_value dv on dv.id = led.dimension_value_id
      join app.dimension_type  dt on dt.id = dv.dimension_type_id
      join app.employee e on e.company_id = le.company_id and e.employee_number = dv.code
     where le.company_id = ${s.company} and a.code = ${code}
       and dt.code = 'EMPLOYEE' and e.id = ${employeeId}
       and le.document_id = ${f.payrollDocumentId}`;
  return row!.amount;
}

describe("acceptance test 30 — payslip ties to the ledger (spec:2448)", () => {
  it("clause 1: payslip net = the credit to salaries payable tagged EMPLOYEE, per employee", async () => {
    const run = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readPayrollRun(tx, f.payrollDocumentId));
    // **`PayrollRunDetail.lines[].amount` is `MoneySchema`'s OBJECT — `{ amount, currency }` — and not a
    // bare string.** 8B freezes it that way and says so in as many words (8b:3857–3862), because the route
    // returns this very object against `PayrollRunSchema`. Reading `line.amount` here would compare an
    // object to the `to_char`'d string `creditFor` returns: a `tsc` error and, if it compiled, a failure
    // with no useful message. `.amount.amount` is the fixed-scale figure, in the same 4-dp text form.
    const nets = new Map<string, string>();
    for (const line of run.lines) {
      if (line.componentId === null && line.schemeId === null) nets.set(line.employeeId, line.amount.amount);
    }
    expect(nets.size).toBe(2);
    for (const [employeeId, net] of nets) {
      expect(await creditFor("2400", employeeId)).toBe(net);
    }
  });

  it("clause 2: Σ(employee + employer share) per scheme = the credit to that scheme's payable", async () => {
    const run = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readPayrollRun(tx, f.payrollDocumentId));
    const shares = run.lines
      .filter((l) => l.schemeId !== null)
      .reduce((a, l) => a + Number(l.amount.amount), 0);   // 8b:3857 — `amount` is `{ amount, currency }`
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le
       where le.document_id = ${f.payrollDocumentId} and le.account_id = ${payableAccountId}`;
    expect(Number(row!.amount)).toBeCloseTo(shares, 4);
  });

  it("clause 3: the monthly schedule per scheme equals that payable TO THE CENT", async () => {
    const [schedule] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(s.human), store, {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
      }));
    const total = schedule!.totalEmployee.add(schedule!.totalEmployer);
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le
       where le.document_id = ${f.payrollDocumentId} and le.account_id = ${payableAccountId}`;
    expect(total.toString()).toBe(row!.amount);          // string equality: TO THE CENT, not toBeCloseTo
  });

  it("clause 4: a remittance for a different amount is refused, by the service AND by direct app_rw SQL", async () => {
    const [schedule] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(s.human), store, {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
      }));
    const total = schedule!.totalEmployee.add(schedule!.totalEmployer);
    const wrongAmount = total.add(schedule!.totalEmployee.isZero()
      ? total : schedule!.totalEmployee).toString();     // any amount that is not `total`

    const wrong = await postRemittance(db, s, f, { amount: wrongAmount });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      settleStatutorySchedule(tx, ctx(s.human), {
        scheduleId: schedule!.scheduleId, remittanceDocumentId: wrong,
      })))
      .rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH/);

    // …and through the door a service cannot guard.
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.statutory_schedule set remittance_document_id = ${wrong}
       where id = ${schedule!.scheduleId}`))
      .rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH/);

    const right = await postRemittance(db, s, f, { amount: total.toString() });
    const settled = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      settleStatutorySchedule(tx, ctx(s.human), {
        scheduleId: schedule!.scheduleId, remittanceDocumentId: right,
      }));
    expect(settled.remittanceDocumentId).toBe(right);
  });
});

describe("the DoD clause: Σ payslip net = the salaries-payable credit for the whole run", () => {
  it("Σ over every employee equals the account's movement on this document", async () => {
    const run = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readPayrollRun(tx, f.payrollDocumentId));
    const sumNet = run.lines
      .filter((l) => l.componentId === null && l.schemeId === null)
      .reduce((a, l) => a + Number(l.amount.amount), 0);   // 8b:3857 — `amount` is `{ amount, currency }`
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${f.payrollDocumentId} and a.code = '2400'`;
    expect(Number(row!.amount)).toBeCloseTo(sumNet, 4);
  });

  it("and a posted PAYROLL_PAYMENT clears it back to zero for the employees it names", async () => {
    await postPayrollPayment(db, s, f, { effectiveDate: "2026-02-05" });
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.company_id = ${s.company} and a.code = '2400'`;
    expect(row!.amount).toBe("0.0000");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd tests test invariants/payslip-ties-to-ledger.test.ts
```

**Expected: FAIL** with `The requested module './support/payroll-money' does not provide an export named 'postRemittance'` and, once that is added, `Cannot find module` for `settleStatutorySchedule`.

- [ ] **Step 3: Add `postRemittance` to `tests/invariants/support/payroll-money.ts`**

**Signature and body together, and this is the first appearance of either.** Task 6 creates the file with three helpers and deliberately does *not* declare this fourth one, because T6 is PR 5 and this is PR 6: a declared `async` function with a deferred body is TS2355 and would leave PR 5 un-typecheckable. Amendment **B3** registers all four names against §4.17.1; the file simply reaches its fourth here. Append it below `postEmployeeAdvance`; nothing else in the file changes.

```ts
/**
 * A posted `PAYMENT` (4A's type) to the authority vendor party for `amount`, which is what a statutory
 * remittance IS — spec:2082: "statutory remittances as ORDINARY PAYMENT documents to each authority
 * modelled as a vendor party". This slice introduces no remittance document type of its own.
 */
export async function postRemittance(
  db: Db, s: Seed, f: MoneyOutFixture, input: { amount: string; effectiveDate?: string },
): Promise<string> {
  const effectiveDate = input.effectiveDate ?? "2026-02-15";
  const documentId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [type] = await tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'PAYMENT'`;
    if (!type) throw new Error("4A's PAYMENT document type is not seeded — check the phase gate");
    const [doc] = await tx<{ id: string }[]>`
      insert into app.document (tenant_id, company_id, document_type_id, series, branch_id, party_id, status,
                                effective_date, currency, exchange_rate, created_by)
      values (${s.tenant}, ${s.company}, ${type.id}, 'PAY-OUT', ${s.hq}, ${f.authorityPartyId}, 'draft',
              ${effectiveDate}::date, 'MYR', 1, app.current_actor())
      returning id`;
    // The line names **`1100`, the bank**, and not `2411`.
    //
    // 4A's `PAYMENT` policy credits `line.account` and debits `party.payable_account` (4a:5211), so naming
    // the bank here produces exactly the two legs a remittance needs — **credit 1100** (the money leaving,
    // which is what 0091's guard measures) and **debit 2411** (the scheme's payable being cleared, which is
    // what `moneyOutFixture` made the authority party's payable account). Naming `2411` here would invert
    // both legs: the payment would credit the payable and debit the party's account, no money would leave
    // the bank, the guard would read `0.0000`, and every remittance in this slice would be refused.
    //
    // `total_incl_tax` carries the figure as well as `amount` because 4A's policy addresses
    // `line.total_incl_tax` on both of its legs (4a:5211's second stated choice); `debit` is set for the
    // draft-editing UI and is not what the policy reads.
    await tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id,
                                     debit, amount, total_incl_tax, description)
      select ${s.tenant}, ${s.company}, ${doc!.id}, 1, 'account', a.id,
             ${input.amount}, ${input.amount}, ${input.amount}, 'Statutory remittance'
        from app.account a where a.company_id = ${s.company} and a.code = '1100'`;
    return doc!.id;
  });

  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    transitionDocument(tx, ctxOf(s, s.human), { documentId, to: "submitted" }));
  await withTenant(db.rw, s.tenant, f.payer, (tx) =>
    transitionDocument(tx, ctxOf(s, f.payer), { documentId, to: "approved" }));
  await withTenant(db.rw, s.tenant, f.payer, (tx) =>
    postDocument(tx, ctxOf(s, f.payer), { documentId }));
  return documentId;
}
```

⚠️ **Both legs come from 4A's policy, and the helper controls them only through the line's account and the party's.** 4A's `PAYMENT` policy is fixed (4a:5211): **debit `party.payable_account`, credit `line.account`**, both at `line.total_incl_tax`. The helper therefore names `1100` on the line (→ the bank credit the guard measures) and `moneyOutFixture` gives the authority party `payable_account_id = statutory_scheme.payable_account_id` (→ the `2411` debit that clears what payroll credited). Neither half works alone.

**Run this helper once and read the resulting `ledger_entry` rows before relying on the amount.** Expected, for a remittance of `X`: exactly two rows — `credit 1100 = X` and `debit 2411 = X`. If you see anything else, 4A's merged policy differs from the prose this plan was written against; **change this helper and the fixture, never 4A's policy and never the 0091 guard**, so that the bank credit still lands on `1100`, and record what 4A actually shipped in the Execution handoff table. Task 8 Step 6's checklist runs exactly this probe.

- [ ] **Step 4: Write `packages/db/src/hr/remittance.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { readSchedule, type StatutoryScheduleResult } from "./schedule";

export class RemittanceError extends Error {
  constructor(
    readonly code: "ERR_NOT_FOUND" | "ERR_PAYROLL_REMITTANCE_MISMATCH" | "ERR_VALIDATION_FAILED",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RemittanceError";
  }
}

export interface SettleScheduleInput { scheduleId: string; remittanceDocumentId: string }

/**
 * Links the settling PAYMENT to the schedule. **The 0091 trigger is the control** (spec:2173's shape,
 * applied here): this function's own checks exist to name the entity in the message, and the `update`
 * below would be refused by the database even if every line of this function were deleted.
 *
 * It deliberately does NOT check the amount itself. Two implementations of one arithmetic is exactly the
 * drift hazard 9 forbids, and a service that pre-computed the comparison would eventually disagree with
 * the trigger about, say, a reversed leg — at which point the service would allow what the database
 * refuses and the operator would see `ERR_INTERNAL` instead of a sentence naming the difference.
 */
export async function settleStatutorySchedule(
  tx: Sql, ctx: TenantContext, input: SettleScheduleInput,
): Promise<StatutoryScheduleResult> {
  const [schedule] = await tx<{ id: string; remittance_document_id: string | null }[]>`
    select id, remittance_document_id from app.statutory_schedule where id = ${input.scheduleId}`;
  if (!schedule) {
    throw new RemittanceError("ERR_NOT_FOUND", `statutory schedule ${input.scheduleId} is not visible`);
  }
  if (schedule.remittance_document_id !== null) {
    throw new RemittanceError("ERR_VALIDATION_FAILED",
      `statutory schedule ${input.scheduleId} is already settled by payment ${schedule.remittance_document_id}; unsettle it first`);
  }

  await tx`
    update app.statutory_schedule
       set remittance_document_id = ${input.remittanceDocumentId}
     where id = ${input.scheduleId}`;

  return readSchedule(tx, input.scheduleId);
}

/**
 * Clears the link. A mis-linked payment is UNLINKED, never edited and never deleted (spec:2049); the
 * payment itself stays posted and, if it was wrong, is reversed as its own document. `app.audit_log`
 * carries the before/after image with the acting principal, which is where the reason lives — the column
 * would be a second place to look.
 */
export async function unsettleStatutorySchedule(
  tx: Sql, ctx: TenantContext, input: { scheduleId: string; reason: string },
): Promise<StatutoryScheduleResult> {
  if (input.reason.trim().length === 0) {
    throw new RemittanceError("ERR_VALIDATION_FAILED", "unsettling a schedule needs a reason");
  }
  const rows = await tx<{ id: string }[]>`
    update app.statutory_schedule set remittance_document_id = null
     where id = ${input.scheduleId} and remittance_document_id is not null
     returning id`;
  if (rows.length === 0) {
    throw new RemittanceError("ERR_NOT_FOUND",
      `statutory schedule ${input.scheduleId} is not visible or is not settled`);
  }
  return readSchedule(tx, input.scheduleId);
}
```

- [ ] **Step 5: Write `packages/db/test/hr/remittance.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../../src/attachment/object-store";
import { generateStatutorySchedule, readSchedule } from "../../src/hr/schedule";
import { RemittanceError, settleStatutorySchedule, unsettleStatutorySchedule } from "../../src/hr/remittance";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import {
  moneyOutFixture, postRemittance, type MoneyOutFixture,
} from "../../../../tests/invariants/support/payroll-money";

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let s: Seed; let f: MoneyOutFixture; let store: MemoryObjectStore;
let scheduleId: string;
let total: string;
const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Remittance");
  f = await moneyOutFixture(db, s);
  store = new MemoryObjectStore();
  const [schedule] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    generateStatutorySchedule(tx, ctx(), store, {
      companyId: s.company, payrollDocumentId: f.payrollDocumentId,
    }));
  scheduleId = schedule!.scheduleId;
  total = schedule!.totalEmployee.add(schedule!.totalEmployer).toString();
}, 240_000);
afterAll(async () => { await db.stop(); });

describe("settleStatutorySchedule (spec:2082; the 0091 trigger is the control)", () => {
  it("links a payment for exactly the schedule total, and readSchedule reports it", async () => {
    const payment = await postRemittance(db, s, f, { amount: total });
    const settled = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      settleStatutorySchedule(tx, ctx(), { scheduleId, remittanceDocumentId: payment }));
    expect(settled.remittanceDocumentId).toBe(payment);
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) => readSchedule(tx, scheduleId));
    expect(read.remittanceDocumentId).toBe(payment);
  });

  it("refuses to settle an already-settled schedule, naming the payment that holds it", async () => {
    const second = await postRemittance(db, s, f, { amount: total, effectiveDate: "2026-02-16" });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      settleStatutorySchedule(tx, ctx(), { scheduleId, remittanceDocumentId: second })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: statutory schedule .* is already settled by payment /);
  });

  it("raises ERR_NOT_FOUND for a schedule that is not visible", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      settleStatutorySchedule(tx, ctx(), {
        scheduleId: "00000000-0000-7000-8000-000000000000",
        remittanceDocumentId: f.payrollDocumentId,
      })))
      .rejects.toThrow(RemittanceError);
  });
});

describe("unsettleStatutorySchedule (spec:2049 — unlinked, never edited)", () => {
  it("refuses an empty reason", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "   " })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: unsettling a schedule needs a reason/);
  });

  it("unsettle → settle with a DIFFERENT, correct payment succeeds — the guard is on the VALUE", async () => {
    // This is the point of the pair. The trigger compares the payment's own `1100` leg to
    // total_employee + total_employer; it knows nothing about which payment came first, so a second
    // payment for the same amount is as acceptable as the first once the link is cleared.
    const cleared = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "paid from the wrong account" }));
    expect(cleared.remittanceDocumentId).toBeNull();

    const replacement = await postRemittance(db, s, f, { amount: total, effectiveDate: "2026-02-17" });
    const settled = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      settleStatutorySchedule(tx, ctx(), { scheduleId, remittanceDocumentId: replacement }));
    expect(settled.remittanceDocumentId).toBe(replacement);
  });

  it("unsettling an unsettled schedule is ERR_NOT_FOUND, not a silent no-op", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "clearing for the next case" }));
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "again" })))
      .rejects.toThrow(/ERR_NOT_FOUND: statutory schedule .* is not visible or is not settled/);
  });

  it("nothing was DELETED: both payments are still posted (spec:2049)", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d
        join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${s.company} and t.code = 'PAYMENT' and d.status = 'posted'`;
    expect(row!.n).toBeGreaterThanOrEqual(3);
  });
});

describe("the 0091 guard covers the TOTALS, not only the link", () => {
  // The hole a one-column `update of remittance_document_id` trigger would leave, closed by Task 1 Step 4's
  // three-column list. The sequence is: settle for exactly the total, then move a total. Nothing in this
  // slice's services performs that second write — `generateStatutorySchedule`'s upsert cannot reach it,
  // because a posted run's `payroll_line` rows are immutable and a supplementary run is a different row —
  // so the case is written as the direct `app_rw` statement test 30's "through any path" clause means, which
  // is also the only way an executor can see the guard fire on this column.
  it("refuses a move of total_employee on a SETTLED schedule, as app_rw", async () => {
    const payment = await postRemittance(db, s, f, { amount: total, effectiveDate: "2026-02-18" });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      settleStatutorySchedule(tx, ctx(), { scheduleId, remittanceDocumentId: payment }));

    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.statutory_schedule
         set total_employee = total_employee + 1
       where id = ${scheduleId}`))
      .rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles .*, payment .* moves /);

    // And the row is unchanged — a BEFORE trigger that raises aborts the statement.
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) => readSchedule(tx, scheduleId));
    expect(read.totalEmployee.add(read.totalEmployer).toString()).toBe(total);
  });

  it("allows the same move once the schedule is UNSETTLED — the guard is about a claim, not the column", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "correcting the totals" }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.statutory_schedule
         set total_employee = total_employee + 1
       where id = ${scheduleId}`);
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) => readSchedule(tx, scheduleId));
    expect(read.totalEmployee.add(read.totalEmployer).toString()).not.toBe(total);
    // The early return in `app.assert_remittance_matches_schedule` — `remittance_document_id is null` —
    // is what makes every ordinary generation free of this check.
  });
});
```

**The file's order is load-bearing** and the cases say so where it matters: the first `describe` leaves the schedule settled, the second unsettles it, re-settles it and unsettles it again, and the third settles it once more so the guard has something to protect. Splitting them into independent `it`s would need a fresh schedule per case, and a schedule is unique on `(scheme_id, period_start, payroll_document_id)` — there is exactly one per run per scheme, by design. **The third `describe` is the last in the file** because it leaves the totals deliberately wrong; nothing may read them afterwards.

- [ ] **Step 6: Run the ledger-shape probe, then everything**

```bash
bun run --cwd tests test invariants/payslip-ties-to-ledger.test.ts -t "clause 4"
```

If it fails with `schedule … settles X, payment … moves 0.0000`, run the probe the ⚠️ in Step 3 describes:

```bash
bun run --cwd packages/db test hr/remittance.test.ts -t "links a payment for exactly the schedule total"
```

and read the `ledger_entry` rows of the remittance in the failure output. **The bank leg must be on account `1100`.** If 4A's `PAYMENT` policy put it elsewhere, do **not** change 4A: change `postRemittance` to write its debit against whatever 4A's policy pairs with `1100`, and record the finding in the Execution handoff table.

```bash
bun run --cwd packages/db test hr/remittance.test.ts hr/schedule.test.ts
bun run --cwd tests test invariants/payslip-ties-to-ledger.test.ts
bun run lint:rules && bun run typecheck
```

**Expected: PASS**, six cases in the acceptance file.

- [ ] **Step 7: Append the two regression blocks**

**One binding fact for all six `— 8C` regression blocks in this plan** (this task's two, Task 9's two, Task 10's and Task 11's). Each takes **only the `Db`** from its file's shared context and seeds its own tenant on it, so no earlier block's `Seed` is disturbed and no second Testcontainer is started: `const db = (await sharedDb()).db;` inside the block's own `beforeAll`. The `await` is deliberate and costs nothing if 0B's `sharedDb()` is synchronous — `await` on a non-promise returns it unchanged — so the line is correct either way and no block needs to know which.

`tests/regression/legacy-011.test.ts` (1A's file — *NULL arithmetic irreversibly nulls balances and tax boxes*) gains a `— 8C` block and no earlier block is edited:

```ts
// tests/regression/legacy-011.test.ts — APPEND
import { MemoryObjectStore, generateStatutorySchedule } from "@dulja/db";
import { seedTenantV2, withTenant, type Db, type Seed } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";

describe("LEGACY-011 NULL arithmetic irreversibly nulls balances and tax boxes — 8C", () => {
  const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
  let db: Db; let s: Seed; let f: MoneyOutFixture; let scheduleId: string; let total: string;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-011 8C");
    f = await moneyOutFixture(db, s);
    const [schedule] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx,
        { tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID },
        new MemoryObjectStore(),
        { companyId: s.company, payrollDocumentId: f.payrollDocumentId }));
    scheduleId = schedule!.scheduleId;
    total = schedule!.totalEmployee.add(schedule!.totalEmployer).toString();
  }, 240_000);

  it("a scheme with no employer share reads 0.0000 on the schedule, never NULL", async () => {
    // The old system accumulated without coalesce and one NULL nulled a whole period's box.
    // app.employee_ytd_delta and generateStatutorySchedule both coalesce at every accumulation
    // boundary, and the columns are NOT NULL DEFAULT 0 — the spec's own prescription (spec:311).
    const [row] = await db.admin<{ total_employer: string; total_employee: string }[]>`
      select total_employer::text as total_employer, total_employee::text as total_employee
        from app.statutory_schedule where id = ${scheduleId}`;
    expect(row!.total_employer).not.toBeNull();
    expect(row!.total_employer).toMatch(/^-?\d+\.\d{4}$/);
    expect(row!.total_employee).not.toBeNull();
    expect(row!.total_employee).toMatch(/^-?\d+\.\d{4}$/);
  });

  it("the remittance guard reads a payment with NO bank leg as 0.0000 and refuses it, never as NULL", async () => {
    // `coalesce(sum(le.credit) - sum(le.debit), 0)` in app.assert_remittance_matches_schedule: without the
    // coalesce, `sum` over an empty set is NULL, `paid <> total` evaluates to UNKNOWN, the `if` does not
    // fire and the guard SILENTLY PASSES — a wrong remittance linked to a schedule for ever. LEGACY-011 in
    // one line of PL/pgSQL.
    //
    // The subject is the PAYROLL run itself: it is `posted`, it has ledger rows, and NOT ONE of them
    // touches `1100` — payroll debits 5300/5311 and credits 2400/241n (§4.12.2). It is therefore exactly
    // "a payment with no bank leg", without a second document having to be built to be one.
    const [bank] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${f.payrollDocumentId} and a.code = '1100'`;
    expect(bank!.n).toBe(0);                       // the premise, asserted rather than assumed

    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.statutory_schedule set remittance_document_id = ${f.payrollDocumentId}
       where id = ${scheduleId}`))
      .rejects.toThrow(
        new RegExp(`ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles ${total}, payment .* moves 0\\.0000`));

    const [after] = await db.admin<{ remittance_document_id: string | null }[]>`
      select remittance_document_id from app.statutory_schedule where id = ${scheduleId}`;
    expect(after!.remittance_document_id).toBeNull();   // refused, not recorded
  });
});
```

`tests/regression/legacy-019.test.ts` (0D's file — *Rounding is configured everywhere, applied nowhere*) gains a `— 8C` block:

```ts
// tests/regression/legacy-019.test.ts — APPEND
import { MemoryObjectStore, generateStatutorySchedule, scheduleCsv } from "@dulja/db";
import { seedTenantV2, withTenant, type Db, type Seed } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";

describe("LEGACY-019 Rounding is configured everywhere, applied nowhere — 8C", () => {
  const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
  let db: Db; let s: Seed; let f: MoneyOutFixture;
  let schedule: Awaited<ReturnType<typeof generateStatutorySchedule>>[number];
  let payableAccountId: string;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-019 8C");
    f = await moneyOutFixture(db, s);
    const [generated] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx,
        { tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID },
        new MemoryObjectStore(),
        { companyId: s.company, payrollDocumentId: f.payrollDocumentId }));
    schedule = generated!;
    const [scheme] = await db.admin<{ payable_account_id: string }[]>`
      select payable_account_id from app.statutory_scheme where id = ${f.schemeId}`;
    payableAccountId = scheme!.payable_account_id;
  }, 240_000);

  it("every figure on a schedule is a fixed-scale 4-dp string, never a float rendered late", () => {
    // The legacy defect was a rounding setting per screen and a rounding function that was wrong. The
    // structural fix is that a figure is produced ONCE, at 4 dp, by Money.toString()/to_char, and is
    // never re-formatted downstream.
    expect(schedule.totalEmployee.toString()).toMatch(/^-?\d+\.\d{4}$/);
    expect(schedule.totalEmployer.toString()).toMatch(/^-?\d+\.\d{4}$/);
    for (const row of schedule.rows) {
      expect(row.employeeShare).toMatch(/^-?\d+\.\d{4}$/);
      expect(row.employerShare).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it("the CSV carries those same strings — no Number, toFixed or locale formatting reaches it", () => {
    const csv = scheduleCsv(schedule);
    const body = csv.split("\r\n").slice(1).filter((l) => l.length > 0);
    expect(body).toHaveLength(schedule.rows.length);
    for (const [i, line] of body.entries()) {
      const cells = line.split(",");
      expect(cells.at(-2)).toBe(schedule.rows[i]!.employeeShare);
      expect(cells.at(-1)).toBe(schedule.rows[i]!.employerShare);
    }
    expect(csv).not.toMatch(/\d,\d{3}\./);          // no thousands separator ever reaches a file
    expect(csv).not.toMatch(/\d+\.\d{1,3}(,|\r|$)/); // and no figure at fewer than four decimals
  });

  it("the schedule total equals the ledger movement as a STRING — which is what 'applied' means", async () => {
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le
       where le.document_id = ${f.payrollDocumentId} and le.account_id = ${payableAccountId}`;
    // Not toBeCloseTo. Two figures that round differently are two figures, and the whole of LEGACY-019 is
    // that the system used to be satisfied by "close enough".
    expect(schedule.totalEmployee.add(schedule.totalEmployer).toString()).toBe(row!.amount);
  });
});
```

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/hr/remittance.ts packages/db/src/index.ts \
        tests/invariants/support/payroll-money.ts tests/invariants/payslip-ties-to-ledger.test.ts \
        packages/db/test/hr/remittance.test.ts \
        tests/regression/legacy-011.test.ts tests/regression/legacy-019.test.ts
git commit -m "feat(db): settle a statutory schedule with its remittance PAYMENT [8C T8]

Acceptance test 30, all four clauses. The service names the entity; the 0091
trigger is the control, so direct app_rw SQL is refused identically. A statutory
remittance is an ORDINARY PAYMENT to the authority vendor party (spec:2082) and
no remittance document type is invented.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The `employee_ytd` rebuild, the nightly job, the openings, and acceptance test 35

**Files:**
- Create: `packages/db/src/integrity/employee-ytd.ts`, `packages/db/src/hr/opening.ts`, `apps/worker/src/handlers/employee-ytd-rebuild.ts`, `apps/worker/test/handlers/employee-ytd-rebuild.test.ts`, `packages/db/test/hr/employee-ytd-opening.test.ts`, `tests/invariants/employee-ytd-rebuild.test.ts`
- Modify: `packages/db/src/integrity/index.ts`, `packages/db/src/index.ts`, `packages/db/src/jobs/payloads.ts`, `apps/worker/src/index.ts`, `tests/invariants/probes.ts`, `tests/invariants/audit-chain.test.ts`, `tests/invariants/projection-rebuild.test.ts`, `apps/worker/test/handlers/integrity-check.test.ts`, `tests/regression/legacy-004.test.ts`, `tests/regression/legacy-016.test.ts`

**Interfaces:**
- Consumes: `ProjectionCheck` / `ProjectionMismatch` / `registerProjectionCheck` / `projectionChecks` / `runIntegrityCheck` / `IntegrityReport` (1B, §4.16.3), `app.employee_ytd_delta` (T2), `JobEnvelope` / `JobPayload` / `JobHandler` / `registerHandler` / `runJob` / `eachTenant` / `systemContext` / `JOB_PROBES` / `JobIsolationProbe` (§4.2.6), `startWorker` (§4.17.1, 0D), `moneyOutFixture` / `MoneyOutFixture` (T6), `postPayrollRun` (8B), `Money` / `currency` (§4.2.1).
- Produces:

```ts
// packages/db/src/integrity/employee-ytd.ts
export async function checkEmployeeYtdProjection(tx: Sql): Promise<ProjectionMismatch[]>;
export const EMPLOYEE_YTD_CHECK: ProjectionCheck;         // { name: "employee_ytd", run: checkEmployeeYtdProjection }

// packages/db/src/hr/opening.ts
export interface EmployeeYtdOpeningInput {
  companyId: string; employeeId: string; taxYear: number;
  gross: Money; net: Money;
  byComponent: Readonly<Record<string, string>>;
  byScheme: Readonly<Record<string, { employee: string; employer: string }>>;
  source: string;
}
export async function upsertEmployeeYtdOpening(tx: Sql, ctx: TenantContext, input: EmployeeYtdOpeningInput): Promise<string>;
export async function listEmployeeYtdOpening(tx: Sql, input: { companyId: string; taxYear: number }): Promise<EmployeeYtdOpeningRow[]>;
export interface EmployeeYtdOpeningRow {
  id: string; employeeId: string; employeeNumber: string; taxYear: number;
  gross: string; net: string; source: string; loadedBy: string;
}
/** `packages/db` may not import `AppError` (§3.1), so this carries a literal `code` for 9B's importer —
 *  the only caller — to translate. There is no route (amendment B10). */
export class OpeningError extends Error {
  constructor(readonly code: "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND", readonly detail: string);
}

// apps/worker/src/handlers/employee-ytd-rebuild.ts
export const employeeYtdRebuildHandler: JobHandler<"hr.employee_ytd.rebuild">;
/** The audit sentinel this job writes on drift — amendment B2, registered in §4.2.6. */
export const EMPLOYEE_YTD_DRIFT_SENTINEL = "employee_ytd_drift";
```

- [ ] **Step 1: Write the failing acceptance test `tests/invariants/employee-ytd-rebuild.test.ts` — test 35 and the test-2 re-run**

spec:2453, verbatim: *"`employee_ytd` rebuilt from opening rows plus posted lines matches the maintained projection row for row; recalculating a submitted run returns it to draft and voids the pending approval; a rate table can be verified only by a principal other than the one who loaded it."* Three clauses; the second is **8B's Task 11** and the third is **8A's**, and both are **re-run here** against the shipped system rather than re-implemented.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { checkEmployeeYtdProjection, upsertEmployeeYtdOpening, ytdFromEmployeeYtd } from "@dulja/db";
import { recalculatePayrollRun, transitionDocument } from "@dulja/db";
import { seedTenantV2, startDb, withTenant, type Db, type Seed } from "@dulja/db/test";
import { moneyOutFixture, type MoneyOutFixture } from "./support/payroll-money";
import { postPayrollRun } from "./support/payroll";

const MYR = currency("MYR");
const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let s: Seed; let f: MoneyOutFixture;
let schemeCode: string;
const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test 35");
  f = await moneyOutFixture(db, s);
  // The scheme's code is read, never written as a literal: 8B's `payrollFixture` seeds it as `EPF`
  // (8b:4155) and only the *rate table* is `SYNTH`. A hard-coded `"SYNTH"` in the opening's `byScheme`
  // would seed a key no delta ever produces.
  const [scheme] = await db.admin<{ code: string }[]>`
    select code from app.statutory_scheme where id = ${f.schemeId}`;
  schemeCode = scheme!.code;
}, 240_000);
afterAll(async () => { await db.stop(); });

describe("acceptance test 35 — YTD rebuild (spec:2453) and the test-2 re-run (spec:2420)", () => {
  it("clause 1: the rebuild matches the maintained projection ROW FOR ROW, and an opening disturbs neither side", async () => {
    // **Amendment B14, asserted in both directions.** `app.employee_ytd` is Σ posted deltas and nothing
    // else — only `packages/db/src/posting/**` may write it (spec:98, §3.7.5), so an opening physically
    // cannot reach it, and the rebuild therefore must not add openings either or every cut-over employee
    // would report permanent `amount_differs` drift. spec:2453's "opening rows plus posted lines" is a
    // statement about the READ, which `ytdFromEmployeeYtd` performs and the second half of this case pins.
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2026, [f.employeeAId]));

    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(s.human), {
        companyId: s.company, employeeId: f.employeeAId, taxYear: 2026,
        gross: Money.of("500.0000", MYR), net: Money.of("450.0000", MYR),
        byComponent: { BASIC: "500.0000" },
        byScheme: { [schemeCode]: { employee: "25.0000", employer: "50.0000" } },
        source: "manual:test-35",
      }));

    // (a) the compare is untouched by the opening — deltas against deltas, on both sides
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) => checkEmployeeYtdProjection(tx));
    expect(mismatches).toEqual([]);

    // (b) …and the READ is opening + projection, which is the sum spec:2453 describes
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2026, [f.employeeAId]));
    expect(after[f.employeeAId]!.gross.toString())
      .toBe(before[f.employeeAId]!.gross.add(Money.of("500.0000", MYR)).toString());
    expect(after[f.employeeAId]!.net.toString())
      .toBe(before[f.employeeAId]!.net.add(Money.of("450.0000", MYR)).toString());
  });

  it("a hand-corrupted projection row IS reported, with the column and both values", async () => {
    await db.admin`
      update app.employee_ytd set gross = gross + 1 where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) => checkEmployeeYtdProjection(tx));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.projection).toBe("employee_ytd");
    expect(mismatches[0]!.side).toBe("amount_differs");
    expect(mismatches[0]!.detail).toMatch(/^gross \d+\.\d{4} <> \d+\.\d{4}$/);
    expect(mismatches[0]!.key).toEqual({
      company_id: s.company, employee_id: f.employeeAId, tax_year: "2026",
    });
    await db.admin`
      update app.employee_ytd set gross = gross - 1 where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
  });

  it("a row present in the rebuild but MISSING from the projection is reported as missing_in_projection", async () => {
    const [gone] = await db.admin<{ employee_id: string }[]>`
      delete from app.employee_ytd where company_id = ${s.company} and employee_id = ${f.employeeBId}
      returning employee_id`;
    expect(gone).toBeDefined();
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) => checkEmployeeYtdProjection(tx));
    expect(mismatches.map((m) => m.side)).toContain("missing_in_projection");
  });

  it("clause 2 (8B's, re-run): recalculating a SUBMITTED run returns it to draft and voids the approval", async () => {
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-04-01", periodEnd: "2026-04-30", payDate: "2026-05-05", effectiveDate: "2026-04-30",
    }).catch(() => null);
    // postPayrollRun posts; for this clause a run must stop at `submitted`, so draft one directly.
    const draft = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      recalculatePayrollRun(tx, ctx(s.human), documentId ?? f.payrollDocumentId)).catch((e: Error) => e);
    expect(draft).toBeInstanceOf(Error);                 // a POSTED run refuses recalculation: ERR_DOC_NOT_DRAFT
    expect((draft as Error).message).toMatch(/ERR_DOC_NOT_DRAFT/);
  });

  it("clause 3 (8A's, re-run): the rate table this fixture pinned was verified by a DIFFERENT principal", async () => {
    const [row] = await db.admin<{ loaded_by: string; verified_by: string | null }[]>`
      select loaded_by, verified_by from app.statutory_rate_table where id = ${f.rateTableId}`;
    expect(row!.verified_by).not.toBeNull();
    expect(row!.verified_by).not.toBe(row!.loaded_by);   // 8A's ERR_HR_SELF_VERIFY trigger, proven by data
  });
});
```

⚠️ **Clause 2 as written asserts the *refusal*, not the return-to-draft.** The return-to-draft path is exercised in full by **8B's Task 11** (`packages/db/test/payroll/recalculation.test.ts`); this file re-runs the clause at the boundary this slice can reach without duplicating 8B's suite. **Do not** copy 8B's cases here — hazard 9's reasoning applies to tests as much as to helpers.

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd tests test invariants/employee-ytd-rebuild.test.ts
```

**Expected: FAIL** with `The requested module '@dulja/db' does not provide an export named 'checkEmployeeYtdProjection'`.

- [ ] **Step 3: Write `packages/db/src/integrity/employee-ytd.ts`**

```ts
import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

const AMOUNT_COLUMNS = ["gross", "net"] as const;
const JSON_COLUMNS = ["by_component", "by_scheme"] as const;

/**
 * spec:2084's "rebuilt from posted lines nightly and compared (D14)", and acceptance test 2's clause for
 * this projection: rebuild into a scratch temp table, `full outer join` on the full natural key, report
 * every row missing on either side or differing in any measure.
 *
 * The rebuild consumes **`app.employee_ytd_delta`** and nothing else — the same function
 * `mergeEmployeeYtd` consumes (amendment B6). That is what makes "rebuilds bit-identically" true by
 * construction: the two sides cannot disagree about how a total was derived, only about whether the
 * maintained row was ever written.
 *
 * **`app.employee_ytd_opening` is on NEITHER side, and that is amendment B14 rather than an omission.**
 * The maintained projection is written only by the step-12 MERGE, which runs on a posted document and
 * never on an opening load — and could not, because `upsertEmployeeYtdOpening` lives outside
 * `packages/db/src/posting/**` and `posting-only-tables` forbids it to write `app.employee_ytd` at all
 * (spec:98, §3.7.5). Adding openings to this rebuild alone would therefore report every cut-over employee
 * as `amount_differs` on every nightly run, for ever. The opening is added where the two figures can
 * legally meet: at READ time, in `ytdFromEmployeeYtd`.
 *
 * The shape follows 1B's `checkAccountBalanceProjection` exactly, including the temp table and the
 * per-column detail string, so the nightly report reads the same whichever projection drifted.
 */
export async function checkEmployeeYtdProjection(tx: Sql): Promise<ProjectionMismatch[]> {
  await tx`
    create temp table employee_ytd_rebuild on commit drop as
    with posted as (
      select d.id as document_id
        from app.document d
        join app.payroll_run r on r.document_id = d.id
       where d.status = 'posted'
    ),
    parts as (
      select x.company_id, x.employee_id, x.tax_year, x.gross, x.net, x.by_component, x.by_scheme
        from posted p, lateral app.employee_ytd_delta(p.document_id) x
    )
    select company_id, employee_id, tax_year,
           sum(gross)::numeric(19,4) as gross,
           sum(net)::numeric(19,4)   as net,
           app.jsonb_add_money_agg(by_component)  as by_component,
           app.jsonb_add_scheme_agg(by_scheme)    as by_scheme
      from parts
     group by company_id, employee_id, tax_year`;

  const rows = await tx<{
    company_id: string; employee_id: string; tax_year: number;
    missing_in_projection: boolean; missing_in_rebuild: boolean;
    p_gross: string | null; p_net: string | null; p_by_component: unknown; p_by_scheme: unknown;
    r_gross: string | null; r_net: string | null; r_by_component: unknown; r_by_scheme: unknown;
  }[]>`
    select coalesce(p.company_id, r.company_id)   as company_id,
           coalesce(p.employee_id, r.employee_id) as employee_id,
           coalesce(p.tax_year, r.tax_year)       as tax_year,
           (p.company_id is null) as missing_in_projection,
           (r.company_id is null) as missing_in_rebuild,
           to_char(p.gross, 'FM999999999999990.0000') as p_gross, to_char(p.net, 'FM999999999999990.0000') as p_net,
           p.by_component as p_by_component, p.by_scheme as p_by_scheme,
           to_char(r.gross, 'FM999999999999990.0000') as r_gross, to_char(r.net, 'FM999999999999990.0000') as r_net,
           r.by_component as r_by_component, r.by_scheme as r_by_scheme
      from app.employee_ytd p
      full outer join employee_ytd_rebuild r
        on r.company_id = p.company_id and r.employee_id = p.employee_id and r.tax_year = p.tax_year
     where p.company_id is null or r.company_id is null
        or p.gross <> r.gross or p.net <> r.net
        or p.by_component <> r.by_component or p.by_scheme <> r.by_scheme
     order by 1, 2, 3`;

  const mismatches: ProjectionMismatch[] = [];
  for (const row of rows) {
    const key = {
      company_id: row.company_id, employee_id: row.employee_id, tax_year: String(row.tax_year),
    };
    if (row.missing_in_projection) {
      mismatches.push({ projection: "employee_ytd", key, side: "missing_in_projection",
        detail: `rebuild has gross ${row.r_gross} net ${row.r_net}, the projection has no row` });
      continue;
    }
    if (row.missing_in_rebuild) {
      mismatches.push({ projection: "employee_ytd", key, side: "missing_in_rebuild",
        detail: `the projection has gross ${row.p_gross} net ${row.p_net}, the rebuild has no row` });
      continue;
    }
    for (const col of AMOUNT_COLUMNS) {
      const p = col === "gross" ? row.p_gross : row.p_net;
      const r = col === "gross" ? row.r_gross : row.r_net;
      if (p !== r) {
        mismatches.push({ projection: "employee_ytd", key, side: "amount_differs", detail: `${col} ${p} <> ${r}` });
      }
    }
    for (const col of JSON_COLUMNS) {
      const p = JSON.stringify(col === "by_component" ? row.p_by_component : row.p_by_scheme);
      const r = JSON.stringify(col === "by_component" ? row.r_by_component : row.r_by_scheme);
      if (p !== r) {
        mismatches.push({ projection: "employee_ytd", key, side: "amount_differs", detail: `${col} ${p} <> ${r}` });
      }
    }
  }
  return mismatches;
}

export const EMPLOYEE_YTD_CHECK: ProjectionCheck = {
  name: "employee_ytd",
  run: checkEmployeeYtdProjection,
};
```

**`app.jsonb_add_money_agg` and `app.jsonb_add_scheme_agg` already exist** — section 5 of `0092_create_employee_ytd.sql`, written and applied in Task 2, with their `grant execute … to app_rw` beside them because this rebuild runs as `app_rw` inside `withTenant`. **This task adds no DDL and does not reopen 0092** (§3.4.7; Plan 0A's runner skips an applied version, plan0A:736–748). If the rebuild fails with `function app.jsonb_add_money_agg(jsonb) does not exist`, the test container is on a 0092 from a checkout predating Task 2's final form — roll it down to 0091 and up again rather than appending anything.

**This is the whole reason the two binary functions exist as functions rather than inline SQL:** an aggregate needs a named state transition function, and reusing the very function the MERGE uses is what keeps the maintained and rebuilt objects byte-identical.

- [ ] **Step 4: Register the check, and move the three pinned arrays**

`packages/db/src/integrity/index.ts`:

```ts
import { EMPLOYEE_YTD_CHECK } from "./employee-ytd";
registerProjectionCheck(EMPLOYEE_YTD_CHECK);
export { checkEmployeeYtdProjection, EMPLOYEE_YTD_CHECK } from "./employee-ytd";
```

`projectionChecks()` sorts by name, so `IntegrityReport.projections.checked` gains `employee_ytd` in alphabetical position. **Three files pin that array and all three move in this PR** — the same discipline 2B, 3A, 3B and 4B each applied:

```bash
grep -rn "projections.checked" tests/ apps/worker/test/
```

**Expected:** three hits — `tests/invariants/audit-chain.test.ts`, `tests/invariants/projection-rebuild.test.ts`, `apps/worker/test/handlers/integrity-check.test.ts`. Read what each currently asserts and add `"employee_ytd"` in alphabetical position. **After 4B the array is** `["account_balance", "cost_layer", "document_series", "item_profitability", "stock_on_hand"]`; **after this PR it is**:

```ts
expect(report.projections.checked).toEqual([
  "account_balance", "cost_layer", "document_series", "employee_ytd", "item_profitability", "stock_on_hand",
]);
```

If the grep finds a **fourth** file, a slice between 4B and 8C added one — update it too and record the fact in the Execution handoff table.

- [ ] **Step 5: Write `packages/db/src/hr/opening.ts`**

```ts
import type { Sql } from "postgres";
import type { Money } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";

/** The same fixed-scale form `app.employee_ytd_delta` produces (`to_char(…, 'FM999999999999990.0000')`).
 *  A jsonb comparison is byte-for-byte, so `"500.00"` and `"500.0000"` are two different openings. */
const FIXED_SCALE = /^-?\d+\.\d{4}$/;

export class OpeningError extends Error {
  constructor(readonly code: "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND", readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "OpeningError";
  }
}

export interface EmployeeYtdOpeningInput {
  companyId: string; employeeId: string; taxYear: number;
  gross: Money; net: Money;
  byComponent: Readonly<Record<string, string>>;
  byScheme: Readonly<Record<string, { employee: string; employer: string }>>;
  source: string;
}

export interface EmployeeYtdOpeningRow {
  id: string; employeeId: string; employeeNumber: string; taxYear: number;
  gross: string; net: string; source: string; loadedBy: string;
}

function assertFixedScale(where: string, value: string): void {
  if (!FIXED_SCALE.test(value)) {
    throw new OpeningError("ERR_VALIDATION_FAILED",
      `${where} is "${value}"; an opening figure is a fixed-scale 4-decimal string, because the nightly rebuild compares these jsonb objects byte for byte`);
  }
}

/**
 * spec:2084 — the cut-over figures a mid-year switch starts from, loaded by **9B's importer** through this
 * function under `systemContext`. There is no route (amendment B10) and there never will be one in v1.
 *
 * It writes `app.employee_ytd_opening` and **never `app.employee_ytd`** (amendment B14): the projection is
 * posting-service-only (spec:98, §3.7.5) and this module could not write it even if the design wanted it
 * to. `ytdFromEmployeeYtd` is where the two figures are summed.
 */
export async function upsertEmployeeYtdOpening(
  tx: Sql, ctx: TenantContext, input: EmployeeYtdOpeningInput,
): Promise<string> {
  if (input.source.trim().length === 0) {
    throw new OpeningError("ERR_VALIDATION_FAILED",
      "an opening carries its provenance: 'legacy:<run>' from the importer, or 'manual:<reason>'");
  }
  for (const [code, amount] of Object.entries(input.byComponent)) {
    assertFixedScale(`byComponent.${code}`, amount);
  }
  for (const [code, share] of Object.entries(input.byScheme)) {
    assertFixedScale(`byScheme.${code}.employee`, share.employee);
    assertFixedScale(`byScheme.${code}.employer`, share.employer);
  }

  const [employee] = await tx<{ id: string }[]>`
    select id from app.employee
     where id = ${input.employeeId} and company_id = ${input.companyId}`;
  if (!employee) {
    throw new OpeningError("ERR_NOT_FOUND",
      `employee ${input.employeeId} is not an employee of company ${input.companyId}`);
  }

  // `loaded_by` is deliberately absent from the update list. `app.stamp_actor` refuses a change to a
  // non-null `*_by` value with `ERR_ACTOR_IMMUTABLE` (plan0A), and it is right to: the FIRST loader is the
  // provenance the column records, and `app.audit_log` carries every later correction with its own actor.
  const [row] = await tx<{ id: string }[]>`
    insert into app.employee_ytd_opening
      (tenant_id, company_id, employee_id, tax_year, gross, net, by_component, by_scheme, source)
    values (${ctx.tenantId}, ${input.companyId}, ${input.employeeId}, ${input.taxYear},
            ${input.gross.toString()}, ${input.net.toString()},
            ${JSON.stringify(input.byComponent)}::jsonb, ${JSON.stringify(input.byScheme)}::jsonb,
            ${input.source})
    on conflict (company_id, employee_id, tax_year) do update
       set gross        = excluded.gross,
           net          = excluded.net,
           by_component = excluded.by_component,
           by_scheme    = excluded.by_scheme,
           source       = excluded.source
    returning id`;
  return row!.id;
}

/** The openings of one company and tax year, with the employee number a report prints. */
export async function listEmployeeYtdOpening(
  tx: Sql, input: { companyId: string; taxYear: number },
): Promise<EmployeeYtdOpeningRow[]> {
  return tx<EmployeeYtdOpeningRow[]>`
    select o.id, o.employee_id as "employeeId", e.employee_number as "employeeNumber",
           o.tax_year as "taxYear",
           to_char(o.gross, 'FM999999999999990.0000') as gross,
           to_char(o.net,   'FM999999999999990.0000') as net,
           o.source, o.loaded_by as "loadedBy"
      from app.employee_ytd_opening o
      join app.employee e on e.id = o.employee_id
     where o.company_id = ${input.companyId} and o.tax_year = ${input.taxYear}
     order by e.employee_number`;
}
```

`packages/db/test/hr/employee-ytd-opening.test.ts` covers the four properties that file owns:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { OpeningError, listEmployeeYtdOpening, upsertEmployeeYtdOpening } from "../../src/hr/opening";
import { startDb, withTenant, type Db } from "../harness";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";

const MYR = currency("MYR");
const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let s: Seed; let employeeId: string;
const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Openings");
  // `app.employee` carries Form A′ `branch_isolation`, `AS RESTRICTIVE` (§4.5.6), and `seedTenant` grants
  // `s.human` nothing — Global Constraint 21(a).
  await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
  employeeId = await seedEmployee(db, s, { employeeNumber: "E-OPEN-1" });
}, 180_000);
afterAll(async () => { await db.stop(); });

const opening = (over: Partial<Parameters<typeof upsertEmployeeYtdOpening>[2]> = {}) => ({
  companyId: s.company, employeeId, taxYear: 2026,
  gross: Money.of("500.0000", MYR), net: Money.of("450.0000", MYR),
  byComponent: { BASIC: "500.0000" },
  byScheme: { SCHEME_A: { employee: "25.0000", employer: "50.0000" } },
  source: "legacy:run-7",
  ...over,
});

describe("upsertEmployeeYtdOpening (spec:2084; amendment B14)", () => {
  it("inserts on the natural key and returns the row id", async () => {
    const id = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(), opening()));
    const [row] = await db.admin<{ gross: string; source: string; loaded_by: string }[]>`
      select gross::text as gross, source, loaded_by from app.employee_ytd_opening where id = ${id}`;
    expect(row!.gross).toBe("500.0000");
    expect(row!.source).toBe("legacy:run-7");
    expect(row!.loaded_by).toBe(s.human);            // stamped from the session (LEGACY-044)
  });

  it("a second load for the same (company, employee, year) UPDATES rather than duplicating", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(), opening({
        gross: Money.of("600.0000", MYR), source: "manual:corrected",
      })));
    const rows = await db.admin<{ gross: string; source: string }[]>`
      select gross::text as gross, source from app.employee_ytd_opening
       where company_id = ${s.company} and employee_id = ${employeeId} and tax_year = 2026`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.gross).toBe("600.0000");
    expect(rows[0]!.source).toBe("manual:corrected");
  });

  it("refuses a figure that is not fixed-scale, naming the key", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(), opening({ byComponent: { BASIC: "500.00" } }))))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: byComponent\.BASIC is "500\.00"/);
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(), opening({
        byScheme: { SCHEME_A: { employee: "25", employer: "50.0000" } },
      }))))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: byScheme\.SCHEME_A\.employee/);
  });

  it("refuses an empty source and an employee of another company", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(), opening({ source: "  " }))))
      .rejects.toThrow(OpeningError);
    const other = await seedTenantV2(db, "Openings other");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(), opening({ companyId: other.company }))))
      .rejects.toThrow(/ERR_NOT_FOUND: employee .* is not an employee of company /);
  });

  it("writes NO row into app.employee_ytd — the projection is posting-service-only (B14)", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.employee_ytd where company_id = ${s.company}`;
    expect(row!.n).toBe(0);
  });

  it("listEmployeeYtdOpening returns the employee number, ordered by it", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listEmployeeYtdOpening(tx, { companyId: s.company, taxYear: 2026 }));
    expect(rows.map((r) => r.employeeNumber)).toEqual(["E-OPEN-1"]);
    expect(rows[0]!.gross).toBe("600.0000");
  });
});
```

- [ ] **Step 6: Write the job handler and its payload key**

`packages/db/src/jobs/payloads.ts` — **one key, and no other line of the file is touched** (amendment B4):

```ts
  /** Slice 8C. Omit both for the nightly whole-tenant compare. */
  "hr.employee_ytd.rebuild": { companyId?: string; taxYear?: number };
```

`apps/worker/src/handlers/employee-ytd-rebuild.ts`:

```ts
import { checkEmployeeYtdProjection, withTenant } from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";

/** Amendment B2 — the third registered audit `table_name` sentinel (§4.2.6). */
export const EMPLOYEE_YTD_DRIFT_SENTINEL = "employee_ytd_drift";

/**
 * spec:2084 / D14: rebuild and COMPARE, nightly. It **reports drift and does not repair it** — 6C's
 * `pos.cashier.compare` set that precedent for exactly this reason: a silent repair hides the bug that
 * caused the drift, and the whole point of the compare is to find it.
 *
 * It calls the SAME `checkEmployeeYtdProjection` that `EMPLOYEE_YTD_CHECK` registers with 1B's nightly
 * integrity job. Two compares, one implementation; the two jobs differ only in what they do with the
 * result — 1B's rolls it into `IntegrityReport`, this one writes the sentinel row so an `employee_ytd`
 * drift is visible even in a tenant whose ledger check is otherwise green.
 */
export const employeeYtdRebuildHandler: JobHandler<"hr.employee_ytd.rebuild"> = async (sql, job, ctx) => {
  const mismatches = await withTenant(sql, ctx, (tx) => checkEmployeeYtdProjection(tx));
  const filtered = mismatches.filter((m) =>
    (job.payload.companyId === undefined || m.key["company_id"] === job.payload.companyId)
    && (job.payload.taxYear === undefined || m.key["tax_year"] === String(job.payload.taxYear)));

  if (filtered.length === 0) {
    log().info({ tenant_id: ctx.tenantId, request_id: ctx.requestId, mismatches: 0 },
      "employee_ytd rebuild matched the projection");
    return;
  }

  await withTenant(sql, ctx, (tx) => tx`
    insert into app.audit_log (tenant_id, table_name, row_id, action, after)
    values (${ctx.tenantId}, ${EMPLOYEE_YTD_DRIFT_SENTINEL}, ${ctx.requestId}, 'insert',
            ${JSON.stringify({ checkedAt: new Date().toISOString(), mismatches: filtered })}::jsonb)`);
  log().error({ tenant_id: ctx.tenantId, request_id: ctx.requestId, mismatches: filtered.length },
    "employee_ytd drifted from its rebuild");
};
```

`apps/worker/src/index.ts` gains `registerHandler("hr.employee_ytd.rebuild", employeeYtdRebuildHandler);`. **No `JOBS` name is added** — `hr.employee_ytd.rebuild` is already in the closed sixteen with `owner: "8C"` and schedule `"0 4 * * *"` (§4.2.6).

- [ ] **Step 7: Add the `JOB_PROBES` entry and write the worker test**

```ts
  "hr.employee_ytd.rebuild": {
    async seed(db, attacker, victim) {
      const f = await moneyOutFixture(db, victim);
      void f;                     // the victim has YTD rows; the attacker has none
      void attacker;
    },
    async survivors(db, victim) {
      const [row] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.employee_ytd where company_id = ${victim.company}`;
      return row!.n;
    },
  },
```

```ts
// apps/worker/test/handlers/employee-ytd-rebuild.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type StartedWorker } from "../support/worker";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { moneyOutFixture, type MoneyOutFixture } from "../../../../tests/invariants/support/payroll-money";
import { EMPLOYEE_YTD_DRIFT_SENTINEL } from "../../src/handlers/employee-ytd-rebuild";

let w: StartedWorker; let s: Seed; let f: MoneyOutFixture;

beforeAll(async () => {
  w = await startWorker();
  s = await seedTenantV2(w.db, "YTD rebuild job");
  f = await moneyOutFixture(w.db, s);
}, 240_000);
afterAll(async () => { await w.stop(); });

// `order by seq`, not `created_at`: plan0A's `app.audit_log` is
// `(seq, tenant_id, actor_id, occurred_at, table_name, row_id, action, before, after, prev_hash, hash)`
// (plan0A:2260–2274) — there is **no** `created_at`, and `seq` is the identity primary key, so it is both
// strictly monotonic and the column 0A's own audit reads order by (plan0A:2173).
const sentinels = async () => w.db.admin<{ actor_id: string; after: { mismatches: unknown[] } }[]>`
  select actor_id, after from app.audit_log
   where tenant_id = ${s.tenant} and table_name = ${EMPLOYEE_YTD_DRIFT_SENTINEL}
   order by seq`;

describe("hr.employee_ytd.rebuild (spec:2084 / D14 — report, never repair)", () => {
  it("a clean tenant writes NO drift sentinel", async () => {
    await w.run("hr.employee_ytd.rebuild", { });
    expect(await sentinels()).toEqual([]);
  });

  it("a hand-corrupted row writes exactly one sentinel naming the column and both values", async () => {
    await w.db.admin`
      update app.employee_ytd set gross = gross + 1
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    await w.run("hr.employee_ytd.rebuild", { });
    const rows = await sentinels();
    expect(rows).toHaveLength(1);
    const mismatches = rows[0]!.after.mismatches as {
      projection: string; side: string; detail: string; key: Record<string, string>;
    }[];
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.projection).toBe("employee_ytd");
    expect(mismatches[0]!.side).toBe("amount_differs");
    expect(mismatches[0]!.detail).toMatch(/^gross \d+\.\d{4} <> \d+\.\d{4}$/);
    expect(mismatches[0]!.key["employee_id"]).toBe(f.employeeAId);
  });

  it("it REPAIRS nothing — the corrupted value is still there afterwards (6C's compare precedent)", async () => {
    const [row] = await w.db.admin<{ gross: string }[]>`
      select gross::text as gross from app.employee_ytd
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    const before = row!.gross;
    await w.run("hr.employee_ytd.rebuild", { });
    const [after] = await w.db.admin<{ gross: string }[]>`
      select gross::text as gross from app.employee_ytd
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    expect(after!.gross).toBe(before);
    // A silent repair would hide the bug that caused the drift, which is the whole point of the compare.
  });

  it("the sentinel is written by the tenant's SYSTEM principal (R8, spec:2179; hazard 20)", async () => {
    const rows = await sentinels();
    for (const row of rows) expect(row.actor_id).toBe(s.system);
  });

  it("the payload's companyId narrows the report and an unrelated company reports clean", async () => {
    const other = await seedTenantV2(w.db, "YTD rebuild other company");
    await w.run("hr.employee_ytd.rebuild", { companyId: other.company });
    // The corrupted row belongs to `s.company`, so filtering to another company's id leaves nothing to
    // report and no new sentinel is written.
    const rows = await sentinels();
    expect(rows).toHaveLength(2);        // the two from the corrupted runs above, and no third
  });

  it("the projection rebuild restores a clean compare once the value is put back", async () => {
    await w.db.admin`
      update app.employee_ytd set gross = gross - 1
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    const before = (await sentinels()).length;
    await w.run("hr.employee_ytd.rebuild", { });
    expect(await sentinels()).toHaveLength(before);   // no new sentinel
  });
});
```

⚠️ **`w.run(name, payload)` is 0D's `StartedWorker` member** (§4.17.1: `{ db, boss, jobs, logs, run, stop }`); it runs the registered handler for one tenant under `systemContext`, which is what makes the fourth case's assertion about `actor_id` meaningful rather than a restatement of the fixture. If your merged harness names it differently, use what 0D shipped — that helper is 0D's and is frozen (hazard 9).

- [ ] **Step 8: Append the two regression blocks**

`tests/regression/legacy-004.test.ts` (3B's file — *cost advanced on INSERT only; no rebuild path exists*) gains a `— 8C` block. The defect's shape is "a derived figure that only ever moves forward and has no rebuild", and `employee_ytd` is the Phase 8 instance of it:

```ts
// tests/regression/legacy-004.test.ts — APPEND
import { checkEmployeeYtdProjection, projectionChecks } from "@dulja/db";
import { seedTenantV2, withTenant, type Db, type Seed } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";

describe("LEGACY-004 A derived figure advanced on INSERT only, with no rebuild path — 8C", () => {
  let db: Db; let s: Seed; let f: MoneyOutFixture;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-004 8C");
    f = await moneyOutFixture(db, s);
  }, 240_000);

  it("employee_ytd HAS a rebuild path, and it is registered in the one registry", () => {
    // The legacy system had no way to recompute a figure it had accumulated wrongly. Registration is what
    // makes the rebuild reachable from the nightly integrity job rather than from one hand-run script.
    expect(projectionChecks().map((c) => c.name)).toContain("employee_ytd");
  });

  it("the rebuild REPORTS a hand-corrupted row instead of carrying it forward", async () => {
    await db.admin`
      update app.employee_ytd set net = net + 7
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      checkEmployeeYtdProjection(tx));
    expect(mismatches.map((m) => m.detail)).toContainEqual(expect.stringMatching(/^net /));
    await db.admin`
      update app.employee_ytd set net = net - 7
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    expect(await withTenant(db.rw, s.tenant, s.human, (tx) => checkEmployeeYtdProjection(tx)))
      .toEqual([]);
  });
});
```

`tests/regression/legacy-016.test.ts` (3B's file — *`MatStatus` min/max ratchet; INSERT-only maintenance*) gains a `— 8C` block. The legacy defect is a figure that **refuses to go back**; the fix is a signed delta that the MERGE adds:

```ts
// tests/regression/legacy-016.test.ts — APPEND
import { checkEmployeeYtdProjection, postDocument, transitionDocument } from "@dulja/db";
import { seedTenantV2, uuidv7, withTenant, type Db, type Seed } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";

describe("LEGACY-016 A maintained figure that only ratchets upward — 8C", () => {
  const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
  let db: Db; let s: Seed; let f: MoneyOutFixture;
  const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-016 8C");
    f = await moneyOutFixture(db, s);
  }, 240_000);

  /**
   * A `supplementary` run that RECOVERS 100.0000 of over-paid net, hand-drafted because 8B's calculator
   * produces a run from compensation and has no "recover this much" input — the shape is what is being
   * regressed, not the calculator.
   *
   * **Two lines, and both are needed for the document to balance.** 8B's rule 7 posts a DEBIT on a
   * `kind: 'account'` line (8b:1526–1528) — that is the negative net — and its deduction-component rule
   * posts the matching CREDIT on `pay_component.expense_account_id`, which for `payrollFixture`'s
   * ADV_RECOVERY component is `1400`. Both lines carry a `payroll_line` row, because that is what makes
   * `line.employee` resolve and `dimensions.required: ["BRANCH", "EMPLOYEE"]` satisfiable (§4.12.2).
   */
  async function postRecovery(amount: string): Promise<string> {
    const documentId = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, branch_id, status,
                                  effective_date, currency, exchange_rate, created_by)
        values (${documentId}, ${s.tenant}, ${s.company}, ${f.documentTypeId}, 'PAY', ${s.hq}, 'draft',
                '2026-03-31', 'MYR', 1, app.current_actor())`;
      await tx`
        insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end,
                                     pay_date, pinned_tables)
        values (${documentId}, ${s.tenant}, ${s.company}, 'supplementary',
                '2026-03-01', '2026-03-31', '2026-04-05', '[]'::jsonb)`;

      const [employee] = await tx<{ home_branch_id: string; employee_number: string }[]>`
        select home_branch_id, employee_number from app.employee where id = ${f.employeeAId}`;
      const [dimension] = await tx<{ id: string }[]>`
        select dv.id from app.dimension_value dv
          join app.dimension_type dt on dt.id = dv.dimension_type_id
         where dt.company_id = ${s.company} and dt.code = 'EMPLOYEE'
           and dv.code = ${employee!.employee_number}`;
      const dimensions = JSON.stringify({
        BRANCH: employee!.home_branch_id, EMPLOYEE: dimension!.id,
      });

      // 1 — the deduction component: CREDIT 1400, the advance-recovery account.
      const recoveryLineId = await uuidv7(db.admin);
      await tx`
        insert into app.document_line
          (id, tenant_id, company_id, document_id, line_no, kind, amount, dimensions)
        values (${recoveryLineId}, ${s.tenant}, ${s.company}, ${documentId}, 1, 'payroll',
                ${amount}, ${dimensions}::jsonb)`;
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id,
                                      component_id, scheme_id, share, amount)
        values (${recoveryLineId}, ${s.tenant}, ${s.company}, ${f.employeeAId},
                ${f.componentAdvanceId}, null, null, ${amount})`;

      // 2 — the negative net: DEBIT 2400, through rule 7.
      const netLineId = await uuidv7(db.admin);
      await tx`
        insert into app.document_line
          (id, tenant_id, company_id, document_id, line_no, kind, account_id, debit, amount, dimensions)
        values (${netLineId}, ${s.tenant}, ${s.company}, ${documentId}, 2, 'account',
                ${f.salariesPayableAccountId}, ${amount}, ${amount}, ${dimensions}::jsonb)`;
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id,
                                      component_id, scheme_id, share, amount)
        values (${netLineId}, ${s.tenant}, ${s.company}, ${f.employeeAId}, null, null, null, ${amount})`;
    });

    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      transitionDocument(tx, ctx(f.approver), { documentId, to: "approved" }));
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      postDocument(tx, ctx(f.approver), { documentId }));
    return documentId;
  }

  it("a supplementary run carrying a NEGATIVE net moves employee_ytd.net DOWN", async () => {
    const [before] = await db.admin<{ net: string }[]>`
      select net::text as net from app.employee_ytd
       where company_id = ${s.company} and employee_id = ${f.employeeAId} and tax_year = 2026`;

    await postRecovery("100.0000");

    const [after] = await db.admin<{ net: string }[]>`
      select net::text as net from app.employee_ytd
       where company_id = ${s.company} and employee_id = ${f.employeeAId} and tax_year = 2026`;
    expect(Number(after!.net)).toBe(Number(before!.net) - 100);
    // The legacy figure could only ratchet up. The sign here comes from `document_line.debit`, which is
    // where the POLICY put the direction — never from the magnitude in `payroll_line.amount`, which 8B
    // constrains `>= 0` (§4.4.2 A9).
  });

  it("and the rebuild still matches, because both sides read the same signed delta", async () => {
    expect(await withTenant(db.rw, s.tenant, s.human, (tx) => checkEmployeeYtdProjection(tx)))
      .toEqual([]);
  });
});
```

⚠️ **The recovery run's pay date is `2026-04-05`, deliberately.** `employee_ytd.tax_year` is the calendar year of `payroll_run.pay_date` (amendment B7), so a pay date in 2027 would open a **new** row and the first case would compare a fresh 2027 row against January's 2026 row and read `NaN`. The dates above put the correction in the same tax year as the run it corrects.

- [ ] **Step 9: Run everything and commit**

```bash
bun run --cwd packages/db test hr/employee-ytd-opening.test.ts hr/ytd-merge.test.ts
bun run --cwd tests test invariants/employee-ytd-rebuild.test.ts invariants/projection-rebuild.test.ts invariants/audit-chain.test.ts
bun run --cwd tests test regression/legacy-004.test.ts regression/legacy-016.test.ts
bun run --cwd apps/worker test
bun run lint && bun run lint:rules && bun run typecheck
```

**Expected: PASS.** `apps/worker`'s integrity-check suite is the one that fails if Step 4's third pinned array was missed.

```bash
git add packages/db/src/integrity/employee-ytd.ts packages/db/src/integrity/index.ts \
        packages/db/src/hr/opening.ts packages/db/src/index.ts packages/db/src/jobs/payloads.ts \
        apps/worker/src/handlers/employee-ytd-rebuild.ts apps/worker/src/index.ts \
        apps/worker/test/handlers/employee-ytd-rebuild.test.ts apps/worker/test/handlers/integrity-check.test.ts \
        tests/invariants/employee-ytd-rebuild.test.ts tests/invariants/probes.ts \
        tests/invariants/audit-chain.test.ts tests/invariants/projection-rebuild.test.ts \
        packages/db/test/hr/employee-ytd-opening.test.ts \
        tests/regression/legacy-004.test.ts tests/regression/legacy-016.test.ts
git commit -m "feat(worker): rebuild and compare employee_ytd nightly [8C T9]

Acceptance test 35's rebuild clause and test 2's re-run over this projection.
One compare, two callers: EMPLOYEE_YTD_CHECK joins 1B's registry and the
hr.employee_ytd.rebuild handler calls the same function. Drift is REPORTED as
the employee_ytd_drift sentinel, never silently repaired.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Migration 0093 — the termination trigger

**Files:**
- Create: `packages/db/migrations/0093_create_termination_trigger.sql`, `packages/db/migrations/0093.down.sql`, `docs/adr/0078-termination-is-a-trigger-and-cashiers-are-employees.md`
- Modify: `tests/regression/legacy-044.test.ts`
- Test: `packages/db/test/hr/termination.test.ts`

**Interfaces:**
- Consumes: `app.employee` (6C's 0064 + 8A's 0080, including 8A's `employee_no_self_pay` BEFORE trigger), `app.pos_cashier` and 6C's `pos_cashier_tombstone` AFTER trigger, `app.refresh_pos_cashier(p_principal_id uuid)` (6C — *"and by 8C's termination trigger"*, 6c:3067), `app.role_assignment` and Plan 0A's `forbid_self_grant` / `keep_last_admin_assignment`, `app.catalogue_tombstone` (6A), `seedEmployee` / `seedCashier` (6C), `grantCodes` (2B), `startDb`, `withTenant` (test helper).
- Produces: `app.terminate_employee()` and the AFTER UPDATE OF `terminated_on` trigger on `app.employee`.

- [ ] **Step 1: Write the failing test `packages/db/test/hr/termination.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { grantCodes, seedCashier, seedEmployee, seedTenantV2, type Seed } from "../fixtures";

let db: Db; let s: Seed;
beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Termination");
  // **`s.human` is the terminating actor and it needs a `role_assignment`, or every test here passes
  // vacuously.** `app.employee` carries Form A′ `branch_isolation` and `app.pos_cashier` Form A, both
  // `AS RESTRICTIVE` (§4.5.6), and `seedTenant` grants `s.human` nothing (§4.1, pinned). Without this line
  // the `update app.employee set terminated_on = …` below **matches zero rows and raises nothing** — the
  // UPDATE is legal, the row is simply invisible — so `revoked_at` stays null and the assertion fails as
  // *"expected null not to be null"*, pointing at 0093's trigger, which is innocent. This is the one RLS
  // failure mode in the slice that is silent rather than loud; the `staffMember` grants below are for the
  // *employee's* principal and do nothing for the actor.
  await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

/** A human principal with a membership row and nothing else — the login half of a staff member. */
async function principal(number: string): Promise<string> {
  const principalId = await uuidv7(db.admin);
  await db.admin`
    insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
    values (${principalId}, ${s.tenant}, 'human', ${`test:${principalId}`}, ${number})`;
  await db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
  return principalId;
}

/** An employee with a login principal, a cashier credential and a role assignment — all three doors. */
async function staffMember(number: string): Promise<{ employeeId: string; principalId: string }> {
  const principalId = await principal(number);
  const employeeId = await seedEmployee(db, s, { employeeNumber: number, principalId });
  await seedCashier(db, s, { employeeId, branchId: s.hq, pin: "123456" });
  await grantCodes(db, s, { codes: ["hr.employee.read"], principalId, roleCode: `r-${number}` });
  return { employeeId, principalId };
}

describe("app.terminate_employee (spec:2090, spec:1324; acceptance test 34)", () => {
  it("revokes the cashier, expires every role assignment, and refreshes the snapshot — in ONE transaction", async () => {
    const { employeeId, principalId } = await staffMember("T-1");
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`);

    const [cashier] = await db.admin<{ revoked_at: string | null; snapshot: { codes?: string[] } }[]>`
      select revoked_at, snapshot from app.pos_cashier where principal_id = ${principalId}`;
    expect(cashier!.revoked_at).not.toBeNull();
    expect(cashier!.snapshot.codes ?? []).toEqual([]);          // refresh_pos_cashier ran after the expiry

    const assignments = await db.admin<{ expires_at: string | null }[]>`
      select expires_at from app.role_assignment where principal_id = ${principalId}`;
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) expect(a.expires_at).not.toBeNull();
  });

  it("writes the catalogue tombstone at the bumped revision (6C's own trigger, not a second one)", async () => {
    const { principalId } = await staffMember("T-2");
    const before = await db.admin<{ n: number }[]>`select count(*)::int as n from app.catalogue_tombstone`;
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20'
       where principal_id is not distinct from ${principalId}`);
    const [tomb] = await db.admin<{ stream: string; revision: string }[]>`
      select stream, revision::text as revision from app.catalogue_tombstone where row_id = ${principalId}`;
    expect(tomb!.stream).toBe("cashier");
    const [cashier] = await db.admin<{ revision: string }[]>`
      select revision::text as revision from app.pos_cashier where principal_id = ${principalId}`;
    expect(tomb!.revision).toBe(cashier!.revision);
    const after = await db.admin<{ n: number }[]>`select count(*)::int as n from app.catalogue_tombstone`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });

  it("drops the row out of app.pos_cashier_sync, so the till stops receiving it", async () => {
    const { principalId } = await staffMember("T-3");
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where principal_id = ${principalId}`);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ id: string }[]>`select id from app.pos_cashier_sync(${s.company}, ${s.hq}, 0)`);
    expect(rows.map((r) => r.id)).not.toContain(principalId);
  });

  it("is idempotent: setting terminated_on twice writes no second tombstone and no second expiry", async () => {
    const { employeeId, principalId } = await staffMember("T-4");
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`);
    const [first] = await db.admin<{ revoked_at: string }[]>`
      select revoked_at::text from app.pos_cashier where principal_id = ${principalId}`;
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-25' where id = ${employeeId}`);
    const [second] = await db.admin<{ revoked_at: string }[]>`
      select revoked_at::text from app.pos_cashier where principal_id = ${principalId}`;
    expect(second!.revoked_at).toBe(first!.revoked_at);         // the FIRST revocation stands
  });

  it("does nothing when terminated_on is CLEARED (a reinstatement is not a termination)", async () => {
    const { employeeId, principalId } = await staffMember("T-5");
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`);
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = null where id = ${employeeId}`);
    const [cashier] = await db.admin<{ revoked_at: string | null }[]>`
      select revoked_at from app.pos_cashier where principal_id = ${principalId}`;
    expect(cashier!.revoked_at).not.toBeNull();                  // reinstatement is an explicit act, not a side effect
  });

  it("an employee with NO principal terminates cleanly (most staff never log in — spec:2097)", async () => {
    const employeeId = await seedEmployee(db, s, { employeeNumber: "T-6" });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`)).resolves.toBeTruthy();
  });

  it("R4 still holds: a principal cannot terminate THEMSELVES (8A's guard, unchanged)", async () => {
    const { employeeId, principalId } = await staffMember("T-7");
    await expect(withTenant(db.rw, s.tenant, principalId, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`))
      .rejects.toThrow(/ERR_HR_SELF_PAY/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/db test hr/termination.test.ts
```

**Expected: FAIL** — the first case fails with `expected null not to be null` on `revoked_at`; the R4 case **passes already** (8A's `employee_no_self_pay` shipped in 0080) and is here as a guard against 0093 accidentally displacing it.

- [ ] **Step 3: Write `packages/db/migrations/0093_create_termination_trigger.sql`**

```sql
-- 0093_create_termination_trigger.sql
-- spec:2090, verbatim: "setting `terminated_on` excludes the employee from later regular runs and, **by
-- trigger** (an AFTER UPDATE OF `terminated_on` trigger on `employee`, so a direct `app_rw` update or the
-- Phase 9 importer cannot bypass it), sets `pos_cashier.revoked_at`, expires every `role_assignment` of
-- `employee.principal_id` and bumps the catalogue revision (tombstone); **it runs under the terminating
-- actor**, so R4 and `forbid_self_grant` still hold and `hr_payroll` needs no `admin.role.assign`."
--
-- Three things this file deliberately does NOT do, each because a slice that already shipped does it:
--   * it writes no catalogue tombstone — 6C's `pos_cashier_tombstone` fires on the null -> value
--     transition of `revoked_at`, which is exactly the write below (6C's 0065 section 3);
--   * it does not recompute the snapshot for a role change — 6C's `refresh_pos_cashier_for_assignment`
--     fires on `role_assignment` (6C's 0067 section 4). It DOES call `app.refresh_pos_cashier` once at
--     the end, because the `revoked_at` write itself is on a table that trigger does not watch, and 6C's
--     own text names "8C's termination trigger" as a caller (6c:3067);
--   * it does not check R4 — 8A's `employee_no_self_pay` BEFORE trigger on the same column already
--     raises `ERR_HR_SELF_PAY`, and a BEFORE trigger runs first, so this AFTER trigger is only ever
--     reached for a termination R4 admitted.
--
-- SECURITY INVOKER (the default) is the whole point: it runs as the terminating actor, so RLS, R4,
-- forbid_self_grant and keep_last_admin_assignment all apply. Terminating the last administrator raises
-- ERR_RBAC_LAST_ADMIN and the whole transaction rolls back — which is correct: a tenant cannot be left
-- without one, and the answer is to appoint a successor first.
create function app.terminate_employee() returns trigger language plpgsql as $$
begin
  -- The credential. `where revoked_at is null` makes a second termination a no-op and keeps the FIRST
  -- revocation instant, so 6C's tombstone trigger fires exactly once and the till's cursor advances once.
  update app.pos_cashier
     set revoked_at = now()
   where employee_id = new.id
     and revoked_at is null;

  -- Every assignment of the person's login identity. `expires_at` and not DELETE: spec:2049 keeps the
  -- history, and 6C's refresh trigger fires on this update and rewrites the snapshot's codes to empty.
  if new.principal_id is not null then
    update app.role_assignment
       set expires_at = now()
     where principal_id = new.principal_id
       and (expires_at is null or expires_at > now());

    -- The snapshot for the revoked credential itself. The role_assignment update above covers the codes;
    -- this covers the row whose `revoked_at` just changed, which no 6C trigger watches.
    perform app.refresh_pos_cashier(new.principal_id);
  end if;

  return null;   -- AFTER trigger: the return value is ignored
end $$;

create trigger employee_terminated after update of terminated_on on app.employee
  for each row when (old.terminated_on is null and new.terminated_on is not null)
  execute function app.terminate_employee();

comment on function app.terminate_employee() is
  'spec:2090 — the termination trigger. Runs under the terminating actor so R4, forbid_self_grant and keep_last_admin_* all still apply.';
```

`packages/db/migrations/0093.down.sql`:

```sql
drop trigger if exists employee_terminated on app.employee;
drop function if exists app.terminate_employee() cascade;
```

**Why `when (old.terminated_on is null and new.terminated_on is not null)` and not `is distinct from`.** `is distinct from` would fire on a *correction* of the date (2026-01-20 → 2026-01-25) and on a **reinstatement** (a value → null). The first would write a second tombstone at a new revision for a person already tombstoned — harmless but noise the till pulls. The second is worse: it would run the revocation on the transition that is supposed to undo it. Step 1's fourth and fifth cases pin both.

- [ ] **Step 4: Write ADR 0078 and append the regression block**

`docs/adr/0078-termination-is-a-trigger-and-cashiers-are-employees.md`, in Plan 0A's format (plan0A:189–203):

```markdown
# ADR 0078 — Termination is a trigger, and cashiers are employees

- **Status:** PROPOSED (spec:95 — this touches security, so it is asked before it is relied on)
- **Date:** 2026-09-05
- **Slice:** 8C

## Context

spec:2090 requires that setting `employee.terminated_on` — **including by direct `app_rw` SQL** — revokes
the till credential, expires every role assignment and tombstones the catalogue, in one transaction. The
same sentence adds a second, independent requirement: an unrevoked `pos_cashier` must reference an employee
with `terminated_on IS NULL` ("cashiers are employees", spec:1324).

Two mechanisms were available for the first half. A **service function** would be bypassed by the Phase 9
importer, by a support engineer's `psql` session and by any later slice that writes the column — and
spec:2090 names the direct-SQL path explicitly, so a bypassable mechanism does not satisfy it. A **trigger**
cannot be bypassed by anything that writes the row.

## Decision

1. **`app.terminate_employee()` is an `AFTER UPDATE OF terminated_on` trigger on `app.employee`**, fired only
   on the `null → value` transition. It revokes `pos_cashier` (`where revoked_at is null`, so a second
   termination is a no-op and the FIRST revocation instant stands), expires every live `role_assignment` of
   `employee.principal_id`, and calls `app.refresh_pos_cashier` once for that principal.
2. **It writes no catalogue tombstone.** 6C's `pos_cashier_tombstone` already fires on the `revoked_at`
   `null → value` transition this trigger causes (6C's 0065 section 3), and 6C's own text names "8C's
   termination trigger" as a caller of `refresh_pos_cashier` (6c:3067). A second tombstone writer would be
   two mechanisms for one fact — hazard 9.
3. **It is `SECURITY INVOKER` (the default), so it runs as the terminating actor.** RLS, 8A's
   `employee_no_self_pay` (R4), Plan 0A's `forbid_self_grant` and `keep_last_admin_assignment` therefore all
   still apply, and `hr_payroll` needs no `admin.role.assign` to terminate somebody. R4 is a BEFORE trigger
   on the same column, so it runs first and this AFTER trigger is only ever reached for a termination R4
   admitted.
4. **A reinstatement is an explicit act, not a side effect.** The `WHEN` clause is
   `old.terminated_on is null and new.terminated_on is not null`, never `is distinct from`: a correction of
   the date would otherwise write a second tombstone at a new revision for a person already tombstoned, and
   clearing the column would run the revocation on the transition meant to undo it.
5. **"Cashiers are employees" is a DEFERRABLE INITIALLY DEFERRED constraint trigger on both tables**
   (migration 0094, Task 11), raising `ERR_HR_CASHIER_NOT_EMPLOYEE` (amendment B13). Deferral is not a
   nicety: decision 1 writes `terminated_on` before `revoked_at` inside one transaction, and an immediate
   constraint would see that intermediate state and abort the very path spec:2090 mandates.

## Consequences

- **Terminating the last administrator raises `ERR_RBAC_LAST_ADMIN` and the whole transaction rolls back.**
  That is correct rather than unfortunate — a tenant cannot be left without one — and the answer is to
  appoint a successor first. It follows directly from decision 3 and is not a special case anywhere in the
  code.
- **The two mechanisms close the door from both sides.** The trigger revokes when the employee leaves; the
  constraint refuses a credential that would outlive one. Neither can be satisfied by disabling the other,
  and the post-termination state — a revoked cashier pointing at a terminated employee — is admitted by
  both.
- **Nothing is deleted.** `pos_cashier.revoked_at` and `role_assignment.expires_at` are set; the rows, the
  payroll lines and the payslips remain for the statutory retention period (spec:2049).
- A termination is auditable end to end without a second table: `app.audit_log` carries the `employee`,
  `pos_cashier` and `role_assignment` images with the **terminating** principal as `actor_id`, because the
  trigger takes no actor parameter and could not accept a supplied one (LEGACY-044).
```

`tests/regression/legacy-044.test.ts` (0B's file — *Session records are caller-controlled and attributable to the wrong user*) gains a `— 8C` block:

```ts
// tests/regression/legacy-044.test.ts — APPEND
import { seedTenantV2, uuidv7, withTenant, type Db, type Seed } from "@dulja/db/test";
import { grantCodes, seedCashier, seedEmployee } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("LEGACY-044 Session records are caller-controlled and attributable to the wrong user — 8C", () => {
  let db: Db; let s: Seed; let employeeId: string; let principalId: string;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-044 8C");
    // The TERMINATING actor needs a role assignment or the UPDATE below matches zero rows and this whole
    // block passes vacuously — Global Constraint 21(b), the silent shape.
    await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });

    principalId = await uuidv7(db.admin);
    await db.admin`
      insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
      values (${principalId}, ${s.tenant}, 'human', ${`test:${principalId}`}, 'LEGACY-044 staff')`;
    await db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
    employeeId = await seedEmployee(db, s, { employeeNumber: "S44-1", principalId });
    await seedCashier(db, s, { employeeId, branchId: s.hq, pin: "123456" });
    await grantCodes(db, s, { codes: ["hr.employee.read"], principalId, roleCode: "r-s44" });

    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`);
  }, 180_000);

  it("every row the termination wrote is attributed to the TERMINATING principal, not the terminated one", async () => {
    // `occurred_at`, not `created_at` — plan0A:2260–2274 gives `app.audit_log` the columns
    // `(seq, tenant_id, actor_id, occurred_at, table_name, row_id, action, before, after, prev_hash, hash)`
    // and nothing else; `created_at` would raise `column "created_at" does not exist` before any assertion.
    //
    // `pos_cashier` is **not** in the list: §3.5.3 marks it AUDIT_EXEMPT ("Audit-exempt projection", the
    // §4.6.3 note), so no `pos_cashier` audit row ever exists and naming it would make that third of the
    // claim vacuous. The cashier's own revocation is asserted by `termination.test.ts` case 1, which reads
    // `app.pos_cashier.revoked_at` directly.
    const rows = await db.admin<{ table_name: string; actor_id: string }[]>`
      select table_name, actor_id from app.audit_log
       where tenant_id = ${s.tenant}
         and table_name in ('employee', 'role_assignment')
         and occurred_at >= now() - interval '10 minutes'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actor_id).toBe(s.human);            // the actor of the session that ran the UPDATE
      expect(row.actor_id).not.toBe(principalId);    // never the person being terminated
    }
  });

  it("app.terminate_employee takes NO actor argument — a caller cannot supply one", async () => {
    // The legacy defect was a session record whose user came from the CALLER. A trigger function with no
    // parameters has nowhere to put one, and `app.current_actor()` reads the session GUC. The shape is the
    // guarantee, so the shape is what is asserted.
    const [fn] = await db.admin<{ nargs: number; security_definer: boolean }[]>`
      select pronargs as nargs, prosecdef as security_definer
        from pg_proc where oid = 'app.terminate_employee'::regproc`;
    expect(fn!.nargs).toBe(0);
    expect(fn!.security_definer).toBe(false);        // SECURITY INVOKER: it runs as the terminating actor
  });

  it("the audit rows are UPDATEs, not deletes — nothing was removed (spec:2049)", async () => {
    // `role_assignment` alone, for the same two reasons as the case above: `pos_cashier` is AUDIT_EXEMPT
    // (§3.5.3) so it contributes no row, and the timestamp column is `occurred_at`.
    const rows = await db.admin<{ action: string }[]>`
      select action from app.audit_log
       where tenant_id = ${s.tenant} and table_name = 'role_assignment'
         and occurred_at >= now() - interval '10 minutes'`;
    // Without this line the assertion below passes on an EMPTY result, which is the failure mode this whole
    // case exists to rule out — a termination that removed rows would leave nothing to read either.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.action)).not.toContain("delete");
  });
});
```

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd packages/db src/cli.ts up
bun run --cwd packages/db test hr/termination.test.ts
bun run --cwd tests test regression/legacy-044.test.ts
bun run --cwd packages/db test schema-lint.test.ts privileges.test.ts
bun run --cwd packages/db test privileges.test.ts -t "up → down → up"
```

**Expected: PASS.**

```bash
git add packages/db/migrations/0093_create_termination_trigger.sql packages/db/migrations/0093.down.sql \
        docs/adr/0078-termination-is-a-trigger-and-cashiers-are-employees.md \
        packages/db/test/hr/termination.test.ts tests/regression/legacy-044.test.ts
git commit -m "feat(db): terminate an employee by trigger [8C T10]

Revokes the cashier, expires every role assignment and refreshes the snapshot,
under the TERMINATING actor so R4 and forbid_self_grant still hold (spec:2090).
The catalogue tombstone is 6C's own trigger firing on revoked_at — not a second
one. ADR 0078, a proposal.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Migration 0094 — "cashiers are employees", and acceptance test 34

**Files:**
- Create: `packages/db/migrations/0094_create_cashier_is_employee_constraint.sql`, `packages/db/migrations/0094.down.sql`, `packages/db/test/hr/cashier-is-employee.test.ts`, `tests/invariants/termination-closes-everything.test.ts`
- Modify: `tests/regression/legacy-021.test.ts`

**Interfaces:**
- Consumes: `app.pos_cashier` (6C), `app.employee` (6C/8A), `app.terminate_employee` (T10), `app.pos_cashier_sync` / `app.catalogue_tombstone` / `readCatalogue` / `currentCatalogueRevision` (6A/6C), `loadPayrollInputs` (8B), `seedEmployee` / `seedCashier` (6C), `moneyOutFixture` (T6), `postPayrollRun` (8B).
- Produces: `app.assert_cashier_is_employee()` and its two **deferrable** constraint triggers.

- [ ] **Step 1: Write the failing test `packages/db/test/hr/cashier-is-employee.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { grantCodes, seedCashier, seedEmployee, seedTenantV2, type Seed } from "../fixtures";

let db: Db; let s: Seed;
beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Cashier is employee");
  await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });   // see Task 10 Step 1
}, 180_000);
afterAll(async () => { await db.stop(); });

/** A human principal with a membership row and nothing else — Task 10 Step 1's helper, repeated. */
async function principal(number: string): Promise<string> {
  const principalId = await uuidv7(db.admin);
  await db.admin`
    insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
    values (${principalId}, ${s.tenant}, 'human', ${`test:${principalId}`}, ${number})`;
  await db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
  return principalId;
}

/** An employee with a login principal, a cashier credential and a role assignment — Task 10 Step 1's. */
async function staffMember(number: string): Promise<{ employeeId: string; principalId: string }> {
  const principalId = await principal(number);
  const employeeId = await seedEmployee(db, s, { employeeNumber: number, principalId });
  await seedCashier(db, s, { employeeId, branchId: s.hq, pin: "123456" });
  await grantCodes(db, s, { codes: ["hr.employee.read"], principalId, roleCode: `r-${number}` });
  return { employeeId, principalId };
}

describe("app.assert_cashier_is_employee (spec:2090, deferrable — both sides)", () => {
  it("refuses a NEW cashier for an already-terminated employee, at COMMIT", async () => {
    // `principal("C-1")` and not `staffMember("C-1")`: this case needs an employee with **no** cashier row
    // yet, because the `seedCashier` below is what the constraint must refuse.
    const employeeId = await seedEmployee(db, s, { employeeNumber: "C-1", principalId: await principal("C-1") });
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`);
    await expect(seedCashier(db, s, { employeeId, branchId: s.hq, pin: "123456" }))
      .rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE: cashier .* references terminated employee/);
  });

  it("refuses UN-revoking a cashier whose employee is terminated", async () => {
    const { employeeId, principalId } = await staffMember("C-2");
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`);
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.pos_cashier set revoked_at = null where principal_id = ${principalId}`))
      .rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
  });

  it("ADMITS the termination path itself, because the constraint is DEFERRED to COMMIT", async () => {
    // Inside one transaction the employee is terminated BEFORE the trigger revokes the cashier; a
    // non-deferred constraint would see the intermediate state and abort the very path spec:2090 mandates.
    const { employeeId } = await staffMember("C-3");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`)).resolves.toBeTruthy();
  });

  it("admits a REVOKED cashier pointing at a terminated employee — that is the post-termination state", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.pos_cashier c join app.employee e on e.id = c.employee_id
       where c.revoked_at is not null and e.terminated_on is not null`;
    expect(row!.n).toBeGreaterThan(0);
  });
});
```

`staffMember` and `principal` are the two file-local helpers Task 10 Step 1 defines, repeated verbatim in the block above rather than imported across suites (each `packages/db/test` file owns its own `startDb()`, §3.7.1). **The `beforeAll` is Task 10 Step 1's as well, grant included** — and the grant is the line to write first, because without it `s.human` sees no `app.employee` row through Form A′ and no `app.pos_cashier` row through Form A (§4.5.6, both `AS RESTRICTIVE`), so the two `update … set terminated_on` statements match zero rows, no trigger fires, and cases 1 and 2 fail as *"resolved instead of rejecting"* — which is precisely the failure Step 2 tells you to expect **before** the migration exists. A green Step 2 that looks like a red one is the worst outcome available here, so make the grant the first thing you write.

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/db test hr/cashier-is-employee.test.ts
```

**Expected: FAIL** — the first two cases resolve instead of rejecting; the third and fourth pass already.

- [ ] **Step 3: Write `packages/db/migrations/0094_create_cashier_is_employee_constraint.sql`**

```sql
-- 0094_create_cashier_is_employee_constraint.sql
-- spec:2090, verbatim: "A **deferrable constraint trigger** on both `pos_cashier` and `employee` enforces
-- **cashiers are employees**: an unrevoked `pos_cashier` must reference an employee with
-- `terminated_on IS NULL`."
--
-- DEFERRABLE INITIALLY DEFERRED is not a nicety. 0093's own trigger sets `employee.terminated_on` first
-- and `pos_cashier.revoked_at` second, inside ONE transaction; an immediate constraint would see the
-- intermediate state — a live cashier pointing at a terminated employee — and abort the very path
-- spec:2090 mandates. Deferring to COMMIT is what lets the two writes be one act.
--
-- The token follows the §4.1 form (errcode check_violation, message 'TOKEN: text'). It is a DB-raised
-- token with no HTTP surface of its own: `fromDatabaseError` maps an unmatched 23514 to ERR_INTERNAL, so
-- Task 11 Step 5 adds the row to ERRORS in this same commit, exactly as 0091 did.
create function app.assert_cashier_is_employee() returns trigger language plpgsql as $$
declare
  bad   record;
  moved jsonb := to_jsonb(new);   -- see the note below: NOT new.id / new.principal_id
begin
  -- One query serves both attachments: whichever table moved, the question is the same.
  --
  -- **The moved row is addressed through `to_jsonb(new)`, never through `new.<column>` directly, and that is
  -- not a style choice.** `app.pos_cashier` has **no `id` column** — its primary key is `principal_id`
  -- (§4.6.3, and it is one of `NO_ID_TABLES`) — so a literal `new.id` in this body raises
  -- `record "new" has no field "id"` the first time the trigger fires on that table. The `tg_table_name`
  -- guard does not save it: SQL `or` does not short-circuit, and plpgsql resolves every `new.<field>`
  -- reference while it is *building the query's parameter list*, before any row is examined. `to_jsonb`
  -- turns the record into a document in which an absent key is simply `null`, which is the semantics this
  -- query wants on both sides. (`app.employee` does carry `principal_id`, so only one of the two would have
  -- failed — which is exactly the sort of half-working trigger that ships green and fires in production.)
  select c.principal_id, c.employee_id, e.employee_number, e.terminated_on
    into bad
    from app.pos_cashier c
    join app.employee e on e.id = c.employee_id
   where c.revoked_at is null
     and e.terminated_on is not null
     and (tg_table_name <> 'pos_cashier' or c.principal_id = (moved ->> 'principal_id')::uuid)
     and (tg_table_name <> 'employee'    or c.employee_id  = (moved ->> 'id')::uuid)
   limit 1;

  if bad.principal_id is not null then
    raise exception
      'ERR_HR_CASHIER_NOT_EMPLOYEE: cashier % references terminated employee % (terminated %)',
      bad.principal_id, bad.employee_number, bad.terminated_on
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger pos_cashier_is_employee
  after insert or update on app.pos_cashier
  deferrable initially deferred
  for each row execute function app.assert_cashier_is_employee();

create constraint trigger employee_cashier_still_employed
  after update of terminated_on on app.employee
  deferrable initially deferred
  for each row execute function app.assert_cashier_is_employee();
```

`packages/db/migrations/0094.down.sql`:

```sql
drop trigger if exists employee_cashier_still_employed on app.employee;
drop trigger if exists pos_cashier_is_employee on app.pos_cashier;
drop function if exists app.assert_cashier_is_employee() cascade;
```

⚠️ **`ERR_HR_CASHIER_NOT_EMPLOYEE` is not in §4.2.4's allocated table.** Global Constraint 10 closes this slice's code list, and this is the one code that list does not contain — so **it is a thirteenth contract amendment, B13**, and Task 1 Step 1's amendment PR must carry it: *§4.2.4 gains `ERR_HR_CASHIER_NOT_EMPLOYEE` (409, raised by the 0094 constraint trigger, 8C)*. **Add row B13 to the amendments table before executing Task 1**, and add the `ERRORS` row here, in the same commit as 0094, for the `error-codes` reason Task 1 Step 6 explains. If you reach this task and B13 was not filed, stop and file it — inventing an unregistered code is hazard 32.

- [ ] **Step 4: Write the acceptance test `tests/invariants/termination-closes-everything.test.ts` — test 34 in full**

spec:2452, verbatim: *"Setting `terminated_on` — including by direct `app_rw` SQL — revokes `pos_cashier` and expires every `role_assignment` in the same transaction (trigger); the next catalogue down-sync tombstones the cashier; a till that has applied the cursor rejects the PIN; the employee is excluded from the next regular run."*

The file's `beforeAll` builds `db`, `s` and `f = await moneyOutFixture(db, s)`, then reads the principal that clause 1 terminates so the later clauses can name it:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentCatalogueRevision, loadPayrollInputs, readCatalogue } from "@dulja/db";
import { seedTenantV2, startDb, withTenant, type Db, type Seed } from "@dulja/db/test";
import { moneyOutFixture, type MoneyOutFixture } from "./support/payroll-money";

let db: Db; let s: Seed; let f: MoneyOutFixture;
let terminatedPrincipalId: string;
/** The revision a till that had already synced would be holding when the termination happens. */
let revisionBeforeTermination: bigint;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test 34");
  f = await moneyOutFixture(db, s);
  const [row] = await db.admin<{ principal_id: string }[]>`
    select principal_id from app.employee where id = ${f.employeeBId}`;
  if (!row?.principal_id) throw new Error("payrollFixture's employee B has no principal — clause 2 needs one");
  terminatedPrincipalId = row.principal_id;
  // Captured BEFORE clause 1 terminates anybody. Clause 2 resumes from it, which is the only way to
  // assert §6.1 row 20's property — a tombstone applied at a bumped revision, reached from a cursor —
  // rather than merely asserting that a full pull contains one.
  revisionBeforeTermination = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    currentCatalogueRevision(tx, { companyId: s.company }));
}, 240_000);
afterAll(async () => { await db.stop(); });
```

⚠️ **If `payrollFixture`'s employee B has no `principal_id`**, 8B seeded it without one (its own cases do not need a login). Give employee B a principal and a `pos_cashier` row in this file's `beforeAll`, using the `staffMember` helper of Task 10 Step 1 — **do not edit `payrollFixture`**, which is 8B's (hazard 9).

```ts
describe("acceptance test 34 — termination closes everything (spec:2452)", () => {
  it("clause 1: by DIRECT app_rw SQL, the cashier is revoked and every assignment expires in ONE transaction", async () => {
    // No route, no service, no handler: the raw statement the Phase 9 importer would issue.
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${f.employeeBId}`);
    const [cashier] = await db.admin<{ revoked_at: string | null }[]>`
      select revoked_at from app.pos_cashier where employee_id = ${f.employeeBId}`;
    expect(cashier!.revoked_at).not.toBeNull();
    const live = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment ra
        join app.employee e on e.principal_id = ra.principal_id
       where e.id = ${f.employeeBId} and (ra.expires_at is null or ra.expires_at > now())`;
    expect(live[0]!.n).toBe(0);
  });

  it("clause 2: the next catalogue down-sync carries the tombstone at the bumped revision", async () => {
    const changes = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readCatalogue(tx, { companyId: s.company, branchId: s.hq, since: 0n }));
    const cashierStream = changes.filter((c) => c.stream === "cashier");
    const tombstoned = cashierStream.filter((c) => c.deleted === true).map((c) => c.id);
    expect(tombstoned).toContain(terminatedPrincipalId);
  });

  it("clause 2b (test 20's re-run): a till RESUMING from its own cursor gets the tombstone, not just a full pull", async () => {
    // §6.1 row 20 ("Catalogue resume", 6A's test) lists **8C (termination tombstone)** in its re-run
    // column, and this is that re-run. The property is not "a full pull from 0 contains a tombstone" —
    // clause 1 already implies that — it is that a till which had *already synced* before the termination
    // learns about it by resuming from the revision it holds. A tombstone written at a revision at or
    // below the cursor would be invisible for ever to exactly the tills that need it.
    const resumed = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readCatalogue(tx, { companyId: s.company, branchId: s.hq, since: revisionBeforeTermination }));
    const tombstoned = resumed.filter((c) => c.stream === "cashier" && c.deleted === true).map((c) => c.id);
    expect(tombstoned).toContain(terminatedPrincipalId);

    // …and the revision it carries is strictly ABOVE the cursor, which is what makes the resume terminate:
    // a second pull from the new high-water mark returns the tombstone no more.
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      currentCatalogueRevision(tx, { companyId: s.company }));
    expect(after > revisionBeforeTermination).toBe(true);
    const settled = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readCatalogue(tx, { companyId: s.company, branchId: s.hq, since: after }));
    expect(settled.filter((c) => c.stream === "cashier" && c.id === terminatedPrincipalId)).toEqual([]);
  });

  it("clause 3 (SERVER side): the revoked row is gone from app.pos_cashier_sync, so no till can re-learn the PIN", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ id: string }[]>`select id from app.pos_cashier_sync(${s.company}, ${s.hq}, 0)`);
    expect(rows.map((r) => r.id)).not.toContain(terminatedPrincipalId);
  });

  it("clause 4: the employee is excluded from the NEXT REGULAR run", async () => {
    // 8B's loadPayrollInputs admits an employee when `terminated_on is null or terminated_on >= period_start`
    // (8b:4086), so a January leaver is ON January's run — a mid-month leaver must be paid — and OFF
    // February's. Both halves are asserted, because only the pair proves the rule rather than the bound.
    const january = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      loadPayrollInputs(tx, { companyId: s.company, periodStart: "2026-01-01", periodEnd: "2026-01-31",
                              payDate: "2026-02-05", kind: "regular" }));
    expect(january.employees.map((e) => e.employeeId)).toContain(f.employeeBId);

    const february = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      loadPayrollInputs(tx, { companyId: s.company, periodStart: "2026-02-01", periodEnd: "2026-02-28",
                              payDate: "2026-03-05", kind: "regular" }));
    expect(february.employees.map((e) => e.employeeId)).not.toContain(f.employeeBId);
  });

  it("clause 4b: a `final` run still reaches them — the last pay is a final PAYROLL (spec:2090)", async () => {
    const final = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      loadPayrollInputs(tx, { companyId: s.company, periodStart: "2026-01-01", periodEnd: "2026-01-31",
                              payDate: "2026-02-05", kind: "final", employeeIds: [f.employeeBId] }));
    expect(final.employees.map((e) => e.employeeId)).toEqual([f.employeeBId]);
  });
});
```

**Clause 3's till half is 6B's, and this file says so rather than pretending to run it.** *"A till that has applied the cursor rejects the PIN"* is behaviour of the Electron client's local `catalogue_cashier` mirror (§4.10.6) and is asserted in **6B's** suite. What 8C owns and proves is the **server** side: the row leaves `app.pos_cashier_sync` and a tombstone arrives on the `cashier` stream, which is precisely what a till applies. A test in this slice that claimed to drive a till would be asserting something it did not run.

⚠️ **`readCatalogue`'s `Change` shape is 6A's.** The `stream` / `id` / `deleted` members above are read from 6A's `packages/sync/src/messages.ts`; **grep it before writing clause 2** and use the member names 6A shipped:

```bash
grep -n -A 10 "export interface Change" packages/sync/src/messages.ts
```

- [ ] **Step 5: Add the `ERRORS` row, append `legacy-021`, run, commit**

`packages/contracts/src/errors.ts` gains, in this commit:

```ts
  ERR_HR_CASHIER_NOT_EMPLOYEE: {
    status: 409,
    title: "Cashier is not an active employee",
    remedy: "Reinstate the employee before restoring the till credential, or leave the credential revoked.",
  },
```

`tests/regression/legacy-021.test.ts` (0B's file — *Accounts can be deleted with posted entries; the ID generator then rewinds and reuses their IDs*) gains a `— 8C` block. The defect's shape is a **dangling reference that outlives its parent**, and the Phase 8 instance is a till credential outliving its employee:

```ts
// tests/regression/legacy-021.test.ts — APPEND
import { seedTenantV2, uuidv7, withTenant, type Db, type Seed } from "@dulja/db/test";
import { grantCodes, seedCashier, seedEmployee } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";

describe("LEGACY-021 A reference that outlives its parent — 8C", () => {
  let db: Db; let s: Seed; let f: MoneyOutFixture;
  let employeeId: string; let principalId: string;
  let cashiersBefore: number; let assignmentsBefore: number; let payrollLinesBefore: number;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-021 8C");
    await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
    f = await moneyOutFixture(db, s);            // a posted run, so the employee has payroll_line rows

    employeeId = f.employeeAId;
    const [emp] = await db.admin<{ principal_id: string | null }[]>`
      select principal_id from app.employee where id = ${employeeId}`;
    if (emp?.principal_id) {
      principalId = emp.principal_id;
    } else {
      // 8B's fixture does not give its employees a login (its own cases do not need one), and this block
      // does. `payrollFixture` is 8B's and is not edited (hazard 9) — the principal is added here.
      principalId = await uuidv7(db.admin);
      await db.admin`
        insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
        values (${principalId}, ${s.tenant}, 'human', ${`test:${principalId}`}, 'LEGACY-021 staff')`;
      await db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
      await db.admin`update app.employee set principal_id = ${principalId} where id = ${employeeId}`;
    }
    await seedCashier(db, s, { employeeId, branchId: s.hq, pin: "123456" });
    await grantCodes(db, s, { codes: ["hr.employee.read"], principalId, roleCode: "r-s21" });

    const counts = async (table: "pos_cashier" | "role_assignment") =>
      (await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.${db.admin(table)} where tenant_id = ${s.tenant}`)[0]!.n;
    cashiersBefore = await counts("pos_cashier");
    assignmentsBefore = await counts("role_assignment");
    payrollLinesBefore = (await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line where employee_id = ${employeeId}`)[0]!.n;
    expect(payrollLinesBefore).toBeGreaterThan(0);

    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`);
  }, 240_000);

  it("a NEW cashier cannot be created against a terminated employee", async () => {
    await expect(seedCashier(db, s, { employeeId, branchId: s.hq, pin: "654321" }))
      .rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
  });

  it("an existing credential cannot be UN-revoked while the employee is terminated", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.pos_cashier set revoked_at = null where principal_id = ${principalId}`))
      .rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
  });

  it("termination DELETED nothing — the rows are still there, only stamped", async () => {
    // The legacy defect deleted the parent and left the children dangling; the fix keeps both and marks
    // the state. Row counts are unchanged and the stamps are set.
    const [cashiers] = await db.admin<{ n: number; revoked: number }[]>`
      select count(*)::int as n, count(revoked_at)::int as revoked
        from app.pos_cashier where tenant_id = ${s.tenant}`;
    expect(cashiers!.n).toBe(cashiersBefore);
    expect(cashiers!.revoked).toBeGreaterThan(0);

    const [assignments] = await db.admin<{ n: number; expired: number }[]>`
      select count(*)::int as n, count(expires_at)::int as expired
        from app.role_assignment where tenant_id = ${s.tenant}`;
    expect(assignments!.n).toBe(assignmentsBefore);
    expect(assignments!.expired).toBeGreaterThan(0);
  });

  it("the terminated employee keeps every payroll line (spec:2049's retention)", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line where employee_id = ${employeeId}`;
    expect(row!.n).toBe(payrollLinesBefore);
  });

  it("app_rw holds no DELETE on either table, so the defect is unreachable by privilege too (§3.5.4)", async () => {
    const grants = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and table_name in ('pos_cashier', 'employee', 'payroll_line')`;
    expect(grants.filter((g) => g.privilege_type === "DELETE")).toEqual([]);
  });
});
```

⚠️ **`db.admin(table)` in the `counts` helper is postgres.js's identifier helper, not string interpolation** — it quotes an identifier and builds no SQL text (Global Constraint 3). If your merged harness types `db.admin` in a way that refuses it, write the two counts as two literal statements; do not concatenate.

```bash
bun run --cwd packages/db src/cli.ts up
bun run --cwd packages/db test hr/cashier-is-employee.test.ts hr/termination.test.ts
bun run --cwd tests test invariants/termination-closes-everything.test.ts regression/legacy-021.test.ts
bun run lint:rules && bun run --cwd packages/db test privileges.test.ts -t "up → down → up"
git add packages/db/migrations/0094_create_cashier_is_employee_constraint.sql \
        packages/db/migrations/0094.down.sql packages/contracts/src/errors.ts \
        packages/db/test/hr/cashier-is-employee.test.ts \
        tests/invariants/termination-closes-everything.test.ts tests/regression/legacy-021.test.ts
git commit -m "feat(db): cashiers are employees, deferred to COMMIT [8C T11]

Acceptance test 34, every clause the server owns. The constraint is DEFERRABLE
INITIALLY DEFERRED because 0093 writes terminated_on before revoked_at inside
one transaction; an immediate constraint would abort the path spec:2090
mandates. The till half of clause 3 is 6B's and is cited, not simulated.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The `payroll_batch` reconcilable source, and the re-runs of tests 31 and 39

**Files:**
- Create: `packages/db/src/hr/reconcilable.ts`, `packages/db/test/hr/reconcilable.test.ts`, `tests/invariants/money-out-sod.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `Reconcilable` / `ReconcilableSource` / `registerReconcilableSource` / `reconcilableSources` / `RECONCILABLE_DIRECTION` / `importStatement` / `match` / `reconciledBalance` (4B, §4.8.3), `Money` / `currency` (§4.2.1), `moneyOutFixture` / `postPayrollPayment` / `postEmployeeAdvance` (T6), `transitionDocument` / `postDocument` (§4.3.1), `problemOf` / `sharedApi` (§4.17.1).
- Produces:

```ts
// packages/db/src/hr/reconcilable.ts
export const PAYROLL_BATCH_SOURCE: ReconcilableSource;   // kind "payroll_batch" — registered at module level
```

- [ ] **Step 1: Write the failing test `packages/db/test/hr/reconcilable.test.ts`**

The file's `beforeAll` builds `db`, `s`, `f = await moneyOutFixture(db, s)` and resolves the one account every case names:

```ts
let bankAccountId: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Reconcilable");
  f = await moneyOutFixture(db, s);
  const [row] = await db.admin<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = '1100'`;
  if (!row) throw new Error("account 1100 is not seeded — 0C's base chart has not been applied");
  bankAccountId = row.id;
}, 240_000);
afterAll(async () => { await db.stop(); });
```

```ts
describe("PAYROLL_BATCH_SOURCE (§4.8.3, amendment B12; test 39's payroll-batch clause)", () => {
  it("is registered under kind payroll_batch and moves money OUT", async () => {
    const kinds = reconcilableSources().map((x) => x.kind);
    expect(kinds).toContain("payroll_batch");
    expect(RECONCILABLE_DIRECTION.payroll_batch).toBe("out");
  });

  it("lists a posted PAYROLL_PAYMENT's bank leg, with its series-and-number reference", async () => {
    // **One employee per batch in this file, deliberately.** `createPayrollPayment` excludes an employee
    // already carried by any non-void batch against the run (T6 Step 6), so a batch for *everyone* here
    // would make the fourth case's second batch impossible. A is this case's; B is the fourth case's.
    const documentId = await postPayrollPayment(db, s, f, {
      effectiveDate: "2026-02-05", employeeIds: [f.employeeAId],
    });
    const source = reconcilableSources().find((x) => x.kind === "payroll_batch")!;
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      source.list(tx, { companyId: s.company, bankAccountId: bankAccountId,
                        from: "2026-02-01", to: "2026-02-28", unmatchedOnly: true }));
    const row = rows.find((r) => r.documentId === documentId)!;
    expect(row.kind).toBe("payroll_batch");
    expect(row.valueDate).toBe("2026-02-05");
    expect(row.amount.isPositive()).toBe(true);        // a MAGNITUDE — the direction is the kind's, not the sign's
    expect(row.reference).toMatch(/^PAYB-\d+$/);
  });

  it("does NOT list an EMPLOYEE_ADVANCE — that is not a payroll batch", async () => {
    const advanceId = await postEmployeeAdvance(db, s, f, {
      employeeId: f.employeeAId, amount: "100.0000", reason: "not a batch",
    });
    const source = reconcilableSources().find((x) => x.kind === "payroll_batch")!;
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      source.list(tx, { companyId: s.company, bankAccountId, from: "2026-01-01", to: "2026-12-31",
                        unmatchedOnly: false }));
    expect(rows.map((r) => r.documentId)).not.toContain(advanceId);
  });

  it("drops out of the unmatched list once a bank_match covers it (test 39)", async () => {
    // importStatement + match are 4B's; this proves the SEAM, not 4B's matcher.
    const documentId = await postPayrollPayment(db, s, f, {
      effectiveDate: "2026-02-06", employeeIds: [f.employeeBId],
    });
    const source = reconcilableSources().find((x) => x.kind === "payroll_batch")!;
    const [batch] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      source.list(tx, { companyId: s.company, bankAccountId, from: "2026-02-06", to: "2026-02-06",
                        unmatchedOnly: true }));
    expect(batch!.documentId).toBe(documentId);

    // A one-line statement for exactly the batch's amount. `Debit` is money OUT in 4B's two-column form
    // (4b:4599), which is what a payroll batch is; the header figures are the ones `CsvMapping.statement`
    // supplies, because a CSV does not carry them (4b:4580).
    const amount = batch!.amount.toString();
    const csv = ["Date,Narrative,Ref,Debit,Credit",
                 `06/02/2026,SALARY BATCH,${batch!.reference ?? "PAYB"},${amount},0.00`].join("\n");
    const statementId = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      importStatement(tx, ctx(s.human), {
        companyId: s.company, bankAccountId, csv,
        mapping: {
          statement: { statementDate: "2026-02-06", openingBalance: "0.0000",
                       closingBalance: `-${amount}` },
          columns: { valueDate: "Date", description: "Narrative", reference: "Ref",
                     debit: "Debit", credit: "Credit" },
          dateFormat: "DD/MM/YYYY", hasHeader: true,
        },
      })).then((r) => r.statementId);

    const [statementLine] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { statementId, limit: 10 }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      match(tx, ctx(s.human), {
        statementLineId: statementLine!.id,
        reconcilable: { kind: "payroll_batch", documentId },
        amount: batch!.amount,
      }));

    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      source.list(tx, { companyId: s.company, bankAccountId, from: "2026-02-01", to: "2026-02-28",
                        unmatchedOnly: true }));
    expect(after.map((r) => r.documentId)).not.toContain(documentId);
  });

  it.skipIf(!hasOrigin())("edits no 4B file: reconciliation.ts is byte-identical to what 4B shipped", () => {
    const changed = execSync("git diff --name-only origin/main -- packages/db/src/ar-ap/", { encoding: "utf8" });
    expect(changed.trim()).toBe("");
  });
});
```

**The two helpers the file needs, at the top of it, beside the imports:**

```ts
import { execSync } from "node:child_process";

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

/**
 * Whether this checkout has an `origin/main` to diff against. A worktree cut from a bare clone, or a CI
 * job with a shallow fetch, has none — and `git diff origin/main` there THROWS rather than reporting no
 * change, which would turn a structural claim into a red test for an unrelated reason.
 *
 * The case is kept rather than deleted because "8C edits no file of 4B's" is a claim of amendment B12 and
 * a reviewer should not have to take it on trust; it simply does not run where it cannot be evaluated.
 */
function hasOrigin(): boolean {
  try {
    execSync("git rev-parse --verify --quiet origin/main", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

The file's imports gain `importStatement`, `listStatementLines` and `match` from `@dulja/db` beside `reconcilableSources`, `RECONCILABLE_DIRECTION` and `reconciledBalance`.

- [ ] **Step 2: Write `packages/db/src/hr/reconcilable.ts`**

```ts
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { registerReconcilableSource, type Reconcilable, type ReconcilableSource } from "../ar-ap/reconciliation";

/**
 * §4.8.3's seam, used exactly as 4B built it: 6D adds `till_banking`, 8C adds `payroll_batch`, and
 * **neither edits a file of 4B's** (4b:8430). 4B's own `ledgerLegSource` is module-private, so this is
 * its shape rather than its code — deliberately, because "one private helper, two importers" would be a
 * cross-slice coupling the registry exists to avoid.
 *
 * It lists the LEDGER's bank leg rather than a document total, which is 4B's ADR 0048 reasoning applied
 * here: a batch has no `total` column, the ledger is the record, and the leg is what a statement line
 * will be matched against. `credit - debit` because a batch moves money OUT; the result is reported as a
 * MAGNITUDE and `RECONCILABLE_DIRECTION.payroll_batch` carries the direction (§4.4.2 A9's discipline,
 * applied outside the posting service).
 */
export const PAYROLL_BATCH_SOURCE: ReconcilableSource = {
  kind: "payroll_batch",
  async list(tx: Sql, input): Promise<Reconcilable[]> {
    const rows = await tx<{
      document_id: string; value_date: string; leg: string; reference: string | null; currency: string;
    }[]>`
      select d.id as document_id, d.effective_date::text as value_date,
             -- **`abs` in SQL, and no `Decimal` in TypeScript.** The figure is already a `numeric(19,4)`
             -- here; taking its magnitude is one word, `numeric::text` keeps the four decimals, and
             -- `Money.of` takes it directly. An earlier draft wrote `new Decimal(r.leg).abs().toFixed(4)`,
             -- which put a second arithmetic surface inside `packages/db` beside `Money` for an operation
             -- SQL had already done — the thing 3B declined to do for the same reason (3b:1124) — and did
             -- it with a named import (`import { Decimal }`) where every other plan in this series uses
             -- the default form. The direction is not lost: `RECONCILABLE_DIRECTION.payroll_batch` carries
             -- it, which is §4.4.2 A9's discipline applied outside the posting service.
             abs(sum(le.credit) - sum(le.debit))::text as leg,
             nullif(concat_ws('-', d.series, d.number::text), '') as reference,
             -- **`le.currency`, not `a.currency`.** `app.account.currency` is `char(3)` NULLABLE — Plan 0A
             -- comments it "null = any currency" (plan0A:1495) — so a `1100` seeded without one would
             -- yield a `Money` in `XXX`, and 4B's `reconciledBalance` would then compare it against the
             -- ledger's base-currency figure and raise `ERR_MONEY_CURRENCY_MISMATCH` (§4.2.1).
             -- `app.ledger_entry.currency` is `char(3) NOT NULL` (plan0A:2014) and is this very leg's own
             -- currency, which is the figure a statement line will be matched against.
             le.currency
        from app.ledger_entry le
        join app.document      d on d.id = le.document_id
        join app.document_type t on t.id = d.document_type_id
       where le.company_id = ${input.companyId}
         and le.account_id = ${input.bankAccountId}
         and t.code = 'PAYROLL_PAYMENT'
         and d.status in ('posted', 'reversed')
         and d.effective_date between ${input.from}::date and ${input.to}::date
       group by d.id, d.effective_date, d.series, d.number, le.currency
      having sum(le.credit) - sum(le.debit) <> 0
         and (${input.unmatchedOnly} = false
              or abs(sum(le.credit) - sum(le.debit)) >
                 coalesce((select sum(bm.amount) from app.bank_match bm
                            where bm.reconcilable_document_id = d.id and bm.unmatched_at is null), 0))
       order by d.effective_date, d.id`;

    return rows.map((r) => ({
      kind: "payroll_batch" as const,
      documentId: r.document_id,
      bankAccountId: input.bankAccountId,
      valueDate: r.value_date,
      amount: Money.of(r.leg, currency(r.currency)),
      reference: r.reference,
    }));
  },
};

registerReconcilableSource(PAYROLL_BATCH_SOURCE);
```

`packages/db/src/index.ts` gains `export { PAYROLL_BATCH_SOURCE } from "./hr/reconcilable";` — **the export is what runs the module-level registration**, so importing anything from `@dulja/db` populates the registry, exactly as 1B's `integrity/index.ts` does for `ACCOUNT_BALANCE_CHECK`.

- [ ] **Step 3: Write `tests/invariants/money-out-sod.test.ts` — the test-31 re-run**

spec:2449 names `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` explicitly: *"The submitter of a PAYROLL, PAYMENT, PAYROLL_PAYMENT, EMPLOYEE_ADVANCE or STOCK_COUNT cannot approve or post it through any path — API, job, or direct SQL as `app_rw`."* Three paths, two types, and **not one line of segregation logic is written in this slice** — the policies' `approval: { required: true, … }` is the whole mechanism and 2B's triggers are the control.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  createEmployeeAdvance, createPayrollPayment, importStatement, listStatementLines, match,
  postDocument, reconciledBalance, transitionDocument,
} from "@dulja/db";
import { grantCodes, seedTenantV2, withTenant, type Db, type Seed } from "@dulja/db/test";
import { problemOf, sharedApi } from "../support/api";
import {
  moneyOutFixture, postPayrollPayment, type MoneyOutFixture,
} from "./support/payroll-money";
import { postPayrollRun } from "./support/payroll";

const MYR = currency("MYR");
const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let api: Awaited<ReturnType<typeof sharedApi>>; let s: Seed;
let f: MoneyOutFixture; let bankAccountId: string;
const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

beforeAll(async () => {
  // **`sharedApi()`, not `startApi()`.** This file lives in `tests/`, and §4.17.1's dependency-rule
  // allowances run `apps/*/test/**` → `tests/invariants/support/**`, never the reverse: a root test may
  // not reach into `apps/api/test/support/app.ts`. `sharedApi()` is 0B's row for exactly this, and its
  // `db` is the API's own — so the direct-SQL cases and the API cases below act on one database.
  api = await sharedApi();
  db = api.db;
  s = await seedTenantV2(db, "Test 31/39");
  f = await moneyOutFixture(db, s);

  // **`accounting.payment.approve` on `s.human`, and NOT `.post`.** Every segregation case below asserts
  // `ERR_SOD_MAKER_IS_CHECKER` (409) — R1 refusing the SUBMITTER as approver. R2 and
  // `requireDocumentPermission("approve")` are checked FIRST, so an actor who does not *hold* the approval
  // code is refused with `ERR_RBAC_FORBIDDEN` (403) before R1 is ever consulted, and all four cases would
  // fail on the wrong code. `.post` is deliberately withheld: the last case of this `describe` asserts
  // that `hr.payroll.pay` without `accounting.payment.post` cannot post, and granting it here would make
  // that case pass vacuously — or rather, fail, which is the honest failure mode.
  await grantCodes(db, s, { codes: ["accounting.payment.approve"] });

  await api.loadPrincipals();
  const [bank] = await db.admin<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = '1100'`;
  bankAccountId = bank!.id;
}, 300_000);

/**
 * A fresh DRAFT of `code`, owned by `s.human`, for the segregation cases to push through a transition.
 *
 * **A `PAYROLL_PAYMENT` needs a run nobody has been paid from yet.** `createPayrollPayment` excludes an
 * employee already carried by any non-void batch against the run — a draft included (T6 Step 6) — so four
 * batches against one run would raise `ERR_VALIDATION_FAILED: … already paid` from the second call on.
 * Each call therefore posts its own regular run, one month later than the last, starting in FEBRUARY:
 * January is left free for test 39's batch below, and `payrollFixture` opened all twelve 2026 periods
 * (8b:4136), so a month counter needs no other preparation.
 */
let monthCounter = 1;                                   // 1 → February, and upward
async function draftOf(code: string): Promise<string> {
  if (code === "EMPLOYEE_ADVANCE") {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      createEmployeeAdvance(tx, ctx(s.human), {
        companyId: s.company, employeeId: f.employeeAId, effectiveDate: "2026-01-10",
        branchId: s.hq, amount: Money.of("50.0000", MYR), reason: "segregation case",
      }));
    return r.documentId;
  }
  monthCounter += 1;
  const mm = String(monthCounter).padStart(2, "0");
  const nextMm = String(monthCounter + 1).padStart(2, "0");
  const lastDay = ["01", "03", "05", "07", "08", "10", "12"].includes(mm) ? "31"
    : mm === "02" ? "28" : "30";
  const runId = await postPayrollRun(db, s, f, {
    periodStart: `2026-${mm}-01`, periodEnd: `2026-${mm}-${lastDay}`,
    payDate: `2026-${nextMm}-05`, effectiveDate: `2026-${mm}-${lastDay}`,
  });
  const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    createPayrollPayment(tx, ctx(s.human), {
      companyId: s.company, payrollDocumentId: runId,
      effectiveDate: `2026-${nextMm}-05`, branchId: s.hq,
    }));
  return r.documentId;
}

describe("acceptance test 31 — segregation of duties on the money-out types (spec:2449)", () => {
  it.each(["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"])(
    "%s: the submitter cannot approve it — through the API", async (code) => {
      const documentId = await draftOf(code);
      await api.request({ method: "POST", as: s.human,
        path: `/v1/companies/${s.company}/documents/${documentId}/transitions`, body: { to: "submitted" } });
      const res = await api.request({ method: "POST", as: s.human,
        path: `/v1/companies/${s.company}/documents/${documentId}/transitions`, body: { to: "approved" } });
      expect(res.status).toBe(409);
      expect((await problemOf(res)).code).toBe("ERR_SOD_MAKER_IS_CHECKER");
    });

  it.each(["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"])(
    "%s: the submitter cannot approve it — through direct app_rw SQL", async (code) => {
      const documentId = await draftOf(code);
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        transitionDocument(tx, ctx(s.human), { documentId, to: "submitted" }));
      await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
        update app.document set status = 'approved' where id = ${documentId}`))
        .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    });

  it.each(["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"])(
    "%s: approving with NO submitted event is ERR_SOD_NO_SUBMISSION", async (code) => {
      const documentId = await draftOf(code);
      await expect(withTenant(db.rw, s.tenant, f.payer, (tx) => tx`
        update app.document set status = 'approved' where id = ${documentId}`))
        .rejects.toThrow(/ERR_SOD_NO_SUBMISSION/);
    });

  it("a principal holding hr.payroll.pay but NOT accounting.payment.post cannot post a batch", async () => {
    const documentId = await draftOf("PAYROLL_PAYMENT");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, f.payer, (tx) =>
      transitionDocument(tx, ctx(f.payer), { documentId, to: "approved" }));
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s.human), { documentId })))
      .rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
  });
});

describe("acceptance test 39 — the payroll-batch clause (spec:2457)", () => {
  it("a month's statement matches the payroll batch, and the reconciled balance equals the ledger", async () => {
    // The JANUARY run's batch — `draftOf` deliberately leaves that run alone (its month counter starts at
    // February), so this is the one batch nobody has drafted against.
    const documentId = await postPayrollPayment(db, s, f, { effectiveDate: "2026-02-05" });

    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.credit) - sum(le.debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le
       where le.document_id = ${documentId} and le.account_id = ${bankAccountId}`;
    const amount = row!.amount;                      // the magnitude the statement line must carry
    expect(Number(amount)).toBeGreaterThan(0);       // a batch moves money OUT of the bank

    // One line, in 4B's two-column bank form where DEBIT is money out (4b:4599). The three header figures
    // come from `CsvMapping.statement` because a CSV does not carry them (4b:4580); the closing balance is
    // the opening minus the payment, and `importStatement` refuses a statement that does not add up.
    const csv = ["Date,Narrative,Ref,Debit,Credit",
                 `05/02/2026,SALARIES,PAYB,${amount},0.00`].join("\n");
    const { statementId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      importStatement(tx, ctx(s.human), {
        companyId: s.company, bankAccountId, csv,
        mapping: {
          statement: { statementDate: "2026-02-28", openingBalance: "0.0000",
                       closingBalance: `-${amount}` },
          columns: { valueDate: "Date", description: "Narrative", reference: "Ref",
                     debit: "Debit", credit: "Credit" },
          dateFormat: "DD/MM/YYYY", hasHeader: true,
        },
      }));

    const [line] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { statementId, limit: 10 }));
    expect(line!.amount).toBe(`-${amount}`);         // signed OUT by the debit column
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      match(tx, ctx(s.human), {
        statementLineId: line!.id,
        reconcilable: { kind: "payroll_batch", documentId },
        amount: Money.of(amount, MYR),               // a MAGNITUDE; the direction is the kind's (§4.8.3)
      }));

    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reconciledBalance(tx, { bankAccountId, asOf: "2026-02-28" }));
    expect(r.statement.toString()).toBe(r.ledger.toString());
    expect(r.unreconciled.filter((u) => u.kind === "payroll_batch")).toEqual([]);
  });

  it("matching altered no ledger entry (spec:2457, LEGACY-031/041)", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where table_name = 'ledger_entry' and action <> 'insert'`;
    expect(row!.n).toBe(0);
  });
});
```

- [ ] **Step 4: Run and commit**

```bash
bun run --cwd packages/db test hr/reconcilable.test.ts
bun run --cwd tests test invariants/money-out-sod.test.ts
bun run --cwd tests test invariants/tenant-isolation.test.ts
bun run lint && bun run lint:rules && bun run typecheck && bun run test
git add packages/db/src/hr/reconcilable.ts packages/db/src/index.ts \
        packages/db/test/hr/reconcilable.test.ts tests/invariants/money-out-sod.test.ts
git commit -m "feat(db): register the payroll_batch reconcilable source [8C T12]

One registerReconcilableSource call, no 4B file edited (amendment B12) —
the seam 4B's Task 7 built for exactly this. Re-runs test 31's PAYROLL_PAYMENT
and EMPLOYEE_ADVANCE clauses through the API, direct app_rw SQL and the
authority gate, and test 39's payroll-batch clause.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: ⚠️ OD-28 — the statutory-schedule layouts, verified against the authorities (isolated owner gate)

**This task is droppable and nothing else in the slice depends on it.** Tasks 7 and 8 ship the generic CSV; this task is where a **verified** layout replaces it, one scheme at a time.

**Files:**
- Create: `packages/db/src/hr/schedule-layouts/index.ts`, `packages/db/test/hr/schedule-layouts.test.ts`, `docs/owner/statutory-layouts/README.md`
- Modify: nothing. `packages/db/src/hr/schedule.ts`, `packages/db/src/index.ts` and `app.statutory_schedule` are all untouched until a *verified* layout arrives, which is why this PR is droppable.
- Test: `packages/db/test/hr/schedule-layouts.test.ts`

**Interfaces:**
- Consumes: `StatutoryScheduleResult` and its `ScheduleRow` (T7), `Money` / `currency` (§4.2.1), `REPO_ROOT` (0B, `tests/support/source`).
- Produces: `ScheduleLayout`, `EmployerIdentifiers` and `layoutFor(schemeCode): ScheduleLayout | null` in `packages/db/src/hr/schedule-layouts/index.ts` — **the registry ships empty**, so `layoutFor` returns `null` for every scheme and `scheduleCsv` (T7) remains the layout every schedule is rendered with. All three names are internal to this slice: `packages/db/src/index.ts` re-exports none of them, no register in §4 gains a row, and no amendment is filed.

**Owner decision:** **OD-28** (§2.12; spec:2083, spec:2077) — *"§3.10.1 ⚠️ items: statutory-profile field list vs LHDN; **schedule layouts**; form names; proration rule."* §2.12's Gates column reads *"8C → schedule task"* and this is that task.

**Owner provides:** for each of `EPF`, `SOCSO`, `EIS` and `PCB` (and any confirmed levy), the **current published upload specification** — the exact column order, the header row if any, the field widths, the delimiter, the encoding, the line terminator, the file-name pattern, and the employer identifiers each file must carry — together with **one worked example file the authority has accepted**, and the accountant's written confirmation that the example is current.

**Verify with:** for each scheme, place the owner's accepted example at `docs/owner/statutory-layouts/<SCHEME>/accepted-example.csv` and its written specification at `docs/owner/statutory-layouts/<SCHEME>/spec.md`, then

```bash
bun run --cwd packages/db test hr/schedule-layouts.test.ts -t "<SCHEME>"
```

**Expected:** the test renders this slice's own synthetic schedule through the `<SCHEME>` writer and asserts the output is byte-identical in **shape** to the accepted example — same header, same column count, same delimiter, same terminator, same encoding — with only the figures differing. A layout with no accepted example in that directory is `it.skip`ped with the reason, which is what keeps the suite green before the owner answers.

**Until provided — the default that ships, and it is complete:** `scheduleCsv` (Task 7), the **generic** five-column layout `employee_number, employee_name, scheme_reference, employee_share, employer_share`, attached to every `statutory_schedule` row with its sha256. It carries no authority name, no form name, no box name and no file-version, and Task 7's own test asserts that by regex. **The record is complete and the tie-out of test 30 is unaffected** — what is missing is only the shape the authority's portal accepts.

**Exactly what changes if the owner answers:**

1. **One `packages/db/src/hr/schedule-layouts/<scheme>.ts` per verified scheme, and one row for it in `LAYOUTS`.** The registry file itself — `schedule-layouts/index.ts`, with `ScheduleLayout`, `EmployerIdentifiers` and `layoutFor(schemeCode): ScheduleLayout | null` — **ships in Step 3 of this task with an empty `LAYOUTS`**, so `layoutFor` returns `null` for every scheme today and the generic `scheduleCsv` stays the layout in force. It ships now rather than "if the owner answers" because Step 2's test imports `EmployerIdentifiers` statically and `layoutFor` dynamically; a module that does not exist is **TS2307** at `bun run typecheck`, which Global Constraint 17 forbids after every task and which would make this PR un-mergeable on its own. An empty registry is the honest shape of "no layout is verified yet", and **null falls back to `scheduleCsv`**, so a company with two verified schemes and two unverified ones works throughout.
2. `generateStatutorySchedule` calls `layoutFor(scheme.code) ?? { render: scheduleCsv }`; **nothing else in Task 7 changes**, and the attachment's `mime_type` and `file_name` come from the layout. This wiring is deliberately **not** done in Step 3: with an empty registry it would be a branch nothing can take, and Task 7's own test asserts by regex that the shipped CSV carries no authority name — a test that would then be pinning an unexercised path.
3. `EmployerIdentifiers` is read from **`app.statutory_scheme.employer_registration` alone** (8A's column, amendment A3, already shipped) — **no new column and no new table**. It is deliberately *not* read from `company_hr_setting.employer_registrations`: **8A's amendment A4 dropped that jsonb**, because spec:2088 says these identifiers are "relational company settings … **never a blob**" and a display copy with no rebuild path is LEGACY-078 in miniature. Task 15 is what surfaces the column and names the schemes still missing one.
4. `docs/adr/0079-verified-statutory-schedule-layouts.md` records, per scheme, the publication, its URL and the date retrieved — the same three facts §4.12.3's `source` block demands of a rate table. **ADR 0079 is 8D's number.** If this task runs before 8D, it files the record in **ADR 0078's** consequences section instead and says so; it never borrows a number from another slice's range (hazard 14).
5. **Nothing about `app.statutory_schedule` changes** — the row, its totals, its unique key and the remittance guard are all layout-independent. That separation is why this task is droppable.

**What does NOT change, whatever the owner says:** no rate, threshold, ceiling or formula enters the repository through this task (hazard 1) — a *layout* is a column order, not a calculation. And no submission endpoint, credential or deadline enters either (hazard 2): v1 exports a file the officer uploads (spec:2093's out-of-v1 list, "direct e-filing to the authorities").

- [ ] **Step 1: Record the request**

```markdown
<!-- docs/owner/statutory-layouts/README.md -->
# ⚠️ OD-28 — the statutory-schedule upload layouts

Dulja generates a statutory schedule per scheme per payroll run, and attaches a CSV to it. The **figures**
are correct today and test 30 ties them to the ledger to the cent. What is **not** known is the **shape**
each authority's portal accepts, so the attached file is a generic five-column CSV
(`employee_number, employee_name, scheme_reference, employee_share, employer_share`) that an officer
re-keys or re-shapes before upload. This directory is where the verified shapes arrive.

Nothing here is a rate, a threshold, a ceiling, a formula or a deadline. A layout is a column order.
Rates live in the signed-off rate tables (OD-23, 8A/8B); submission and e-filing are out of v1 entirely.

## The schemes

`EPF`, `SOCSO`, `EIS`, `PCB` — and any levy confirmed under OD-14.

## The seven facts wanted per scheme

1. **Column order** — the exact fields, in order, with the authority's own name for each.
2. **Header row** — present or absent, and if present its exact text.
3. **Field widths** — fixed-width positions if the format is fixed-width; "not applicable" if delimited.
4. **Delimiter** — comma, tab, pipe, or none (fixed-width).
5. **Encoding** — UTF-8, UTF-8 with BOM, or a code page, named exactly.
6. **Line terminator** — CRLF or LF.
7. **File-name pattern** — with the employer identifiers it must carry, and where each comes from.

## The two files expected per scheme directory

Put both in `docs/owner/statutory-layouts/<SCHEME>/`, using the scheme code in capitals:

| File | What it is |
|---|---|
| `spec.md` | The authority's published upload specification covering the seven facts above, with the publication's name, its URL and the date it was retrieved. |
| `accepted-example.csv` | **One worked example file the authority has actually accepted**, plus the accountant's written confirmation — in `spec.md` — that it is current. |

A scheme directory that holds only one of the two is treated as absent: `packages/db/test/hr/schedule-layouts.test.ts`
skips that scheme and records it as unverified, and the generic CSV keeps shipping for it.

## What happens when a directory is filled

`packages/db/test/hr/schedule-layouts.test.ts` stops skipping that scheme and asserts the writer's output
matches the accepted example in **shape** — same header, same column count, same delimiter, same
terminator. Only then does a scheme gain a `packages/db/src/hr/schedule-layouts/<scheme>.ts` and a row in
that directory's `LAYOUTS` registry.
```

Commit it alone:

```bash
git add docs/owner/statutory-layouts/README.md
git commit -m "docs(owner): request the verified statutory schedule layouts (OD-28) [8C T13]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write `packages/db/test/hr/schedule-layouts.test.ts`, skipped until the examples arrive**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import type { StatutoryScheduleResult } from "../../src/hr/schedule";
import type { EmployerIdentifiers } from "../../src/hr/schedule-layouts";
import { REPO_ROOT } from "../../../../tests/support/source";

const SCHEMES = ["EPF", "SOCSO", "EIS", "PCB"] as const;

const MYR = currency("MYR");

/**
 * The fixture every layout is rendered against. **Every figure and every identifier here is INVENTED**
 * (hazard 1, hazard 2): no real rate, no real registration number, no real employee. The test compares the
 * SHAPE of the output — header, column count, delimiter, terminator — against the authority's accepted
 * example, and a shape needs no real numbers to be checked.
 */
const SYNTHETIC_SCHEDULE: StatutoryScheduleResult = {
  scheduleId: "00000000-0000-7000-8000-000000000001",
  schemeId: "00000000-0000-7000-8000-000000000002",
  schemeCode: "SYNTH",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  payrollDocumentId: "00000000-0000-7000-8000-000000000003",
  totalEmployee: Money.of("30.0000", MYR),
  totalEmployer: Money.of("60.0000", MYR),
  currency: MYR,
  attachmentId: null,
  remittanceDocumentId: null,
  rows: [
    { employeeNumber: "E-1", employeeName: "Synthetic, Employee One",
      schemeReference: "SYNTH-REF-0001", employeeShare: "10.0000", employerShare: "20.0000" },
    { employeeNumber: "E-2", employeeName: "Synthetic Employee Two",
      schemeReference: "SYNTH-REF-0002", employeeShare: "20.0000", employerShare: "40.0000" },
  ],
};

const SYNTHETIC_EMPLOYER: EmployerIdentifiers = { employerRegistration: "SYNTH-EMPLOYER-0001" };

for (const scheme of SCHEMES) {
  const dir = join(REPO_ROOT, "docs/owner/statutory-layouts", scheme);
  const example = join(dir, "accepted-example.csv");
  const spec = join(dir, "spec.md");
  const have = existsSync(example) && existsSync(spec);

  describe(scheme, () => {
    it.skipIf(!have)("renders a schedule in the shape of the authority's accepted example", async () => {
      const { layoutFor } = await import("../../src/hr/schedule-layouts");
      const layout = layoutFor(scheme);
      expect(layout, `no layout module for ${scheme} though its example is present`).not.toBeNull();
      const accepted = readFileSync(example, "utf8");
      const rendered = layout!.render(SYNTHETIC_SCHEDULE, SYNTHETIC_EMPLOYER);
      expect(rendered.split(/\r?\n/)[0]).toBe(accepted.split(/\r?\n/)[0]);          // same header
      expect(rendered.split(/\r?\n/)[1]?.split(layout!.delimiter).length)
        .toBe(accepted.split(/\r?\n/)[1]?.split(layout!.delimiter).length);          // same column count
      expect(rendered.endsWith("\r\n")).toBe(accepted.endsWith("\r\n"));             // same terminator
    });

    it("is documented as unverified until the owner supplies the specification (OD-28)", () => {
      if (have) return;
      expect(existsSync(dir)).toBe(false);
      // The generic layout ships and the record is complete; only the upload shape is pending.
    });
  });
}
```

`SYNTHETIC_SCHEDULE` and `SYNTHETIC_EMPLOYER` are the file-local literals written out above the `for` loop — **invented** figures and an invented registration string, because hazard 1 binds this file exactly as it binds every other, and a *shape* comparison needs no real number to be meaningful.

- [ ] **Step 3: Watch it fail, write the empty registry, then commit**

```bash
bun run --cwd packages/db test hr/schedule-layouts.test.ts
```

**Expected: FAIL** — **TS2307**, *"Cannot find module '../../src/hr/schedule-layouts' or its corresponding type declarations"*. Step 2's file imports `EmployerIdentifiers` from it statically and `layoutFor` from it dynamically, and neither resolves yet. Then write the module — **the registry ships empty, and that is the whole point**: it makes the suite compile and run, and it commits the shape the owner's answer will be poured into, without asserting one verified fact about any authority.

```ts
// packages/db/src/hr/schedule-layouts/index.ts
import type { StatutoryScheduleResult } from "../schedule";

/** ⚠️ OD-23's half of the answer: the identifiers a filing carries and a ledger never does. */
export interface EmployerIdentifiers {
  /** 8A's `statutory_scheme.employer_registration`; null until the owner supplies it (Task 15). */
  readonly employerRegistration: string | null;
}

export interface ScheduleLayout {
  readonly code: string;                 // the scheme code this layout is for
  readonly header: readonly string[];
  /** The field separator the authority's specification names — comma, tab or pipe. */
  readonly delimiter: string;
  /** The name the portal expects, built from the schedule; the attachment takes it verbatim. */
  fileName(result: StatutoryScheduleResult): string;
  render(result: StatutoryScheduleResult, employer: EmployerIdentifiers): string;
}

/**
 * **Deliberately empty, and it stays empty until OD-28 answers.** A row is added here only when
 * `docs/owner/statutory-layouts/<SCHEME>/` holds both the authority's published specification and one
 * example file the authority has accepted — the two files this task's README asks for. An entry written
 * from memory, from a blog post or from a sample found online would be hazard 1's shape wearing a layout's
 * clothes: an unverified authority fact committed to the repository.
 */
const LAYOUTS: ReadonlyMap<string, ScheduleLayout> = new Map();

/**
 * The layout for a scheme, or `null` when none is verified — and **`null` is the normal answer today**.
 * `generateStatutorySchedule`'s fallback is Task 7's generic `scheduleCsv`, so a company with two verified
 * schemes and two unverified ones renders both kinds without a branch anywhere else.
 */
export function layoutFor(schemeCode: string): ScheduleLayout | null {
  return LAYOUTS.get(schemeCode) ?? null;
}
```

Run it again:

```bash
bun run --cwd packages/db test hr/schedule-layouts.test.ts
bun run lint:rules && bun run typecheck
```

**Expected: PASS**, with four `skipped` and four passing "documented as unverified" cases — the four skips are the four schemes with no accepted example on disk, which is every scheme until the owner answers. Commit; the task ends here until OD-28 lands.

```bash
git add packages/db/src/hr/schedule-layouts/index.ts packages/db/test/hr/schedule-layouts.test.ts
git commit -m "test(hr): pin the statutory-layout shape behind OD-28, with an empty registry [8C T13]

layoutFor() returns null for every scheme, so scheduleCsv stays the layout in
force. A row is added only when docs/owner/statutory-layouts/<SCHEME>/ holds
both the published specification and an accepted example.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: ⚠️ OD-14 — staff purchases at the till on salary deduction (isolated owner gate)

**This task is droppable and nothing else in the slice depends on it.**

**Files:**
- Create: `docs/owner/od-14-staff-purchases.md`
- Modify: nothing.
- Test: none — **this task writes no code, so it adds no test.** That is not an exemption from the TDD rule: there is no behaviour to drive. The shipped path (`EMPLOYEE_ADVANCE` plus 8B's advance-recovery `pay_component`) is already covered by Task 6's `createEmployeeAdvance` cases and Task 6's `advanceBalance` case, and the *hypothetical* path's test (`packages/db/test/hr/staff-purchase.test.ts`) is named in the Verify block below so that whoever builds it writes it first.

**Interfaces:**
- Consumes: nothing at the type level. The named surfaces it reasons about are `LineSnapshot.tenderMethod` (§4.4.2, frozen), `posting-policy.schema.json`'s `when["line.tender_method"]` enum (§4.4.1), `app.branch_pos_policy` (6C), `app.company_hr_setting` (8A), the `1400` chart row (8B, §4.15), `POS_TICKET` (6A, §4.14) and `advanceBalance` (T6).
- Produces: one markdown document. **No code, no table, no column, no tender method, no permission code, no account, no document type, no `ERRORS` row, no amendment.**

**Owner decision:** **OD-14** (§2.12; spec:2093) — *"⚠️ Owner to confirm: HRD Corp levy applicability; foreign workers; anyone hourly-paid or part-time; **staff purchases at the till on salary deduction**."* §2.12 gates OD-14 at *"8A/8B → one task each if yes"*, and **8B's Task 8 already owns the first three clauses.** This task owns **only the fourth**, because it is money-out machinery: a staff purchase on salary deduction is a till transaction settled against pay, and every mechanism it would need — `EMPLOYEE_ADVANCE`, the advance-recovery `pay_component`, `1400` staff advances, `advanceBalance` — is in this slice. **Do not re-open the other three clauses here** (hazard 6: one task per item, and duplicating 8B's would be two tasks for one decision).

**Owner provides:** whether staff may buy at the till and have it deducted from pay; and if yes — the approval required at the till, whether a limit applies per employee or per month, whether the deduction is recovered in one pay period or spread, and who authorises it.

**Verify with:**

```bash
bun run --cwd packages/db test hr/staff-purchase.test.ts
```

**Expected**, if built: a `POS_TICKET` tendered to a new `store_credit`-shaped method resolves to a debit on `1400` tagged EMPLOYEE, `advanceBalance` reports it, and the next PAYROLL run's advance-recovery component credits it back to zero.

**Until provided — the default:** **not built.** No table, no column, no tender method, no permission code and no account. `advanceBalance` (Task 6) already answers "what does this employee owe", and an ad-hoc `EMPLOYEE_ADVANCE` is how a staff purchase is recorded today: the officer raises one for the amount, and the advance-recovery `pay_component` (8B's, `expense_account_id = 1400` per 8B's Task 4) clears it on the next run. **That path works with nothing added and is what the slice ships.**

**Exactly what changes if the owner answers yes:**

1. **A new tender method on `POS_TICKET`.** `LineSnapshot.tenderMethod` is a **frozen four-value union** `cash | card | transfer | store_credit` (§4.4.2) and `posting-policy.schema.json`'s `when["line.tender_method"]` enum matches it, so a fifth value is **a schema change: a new `version` const and a new `$id`** (§4.4.1's own rule), which is an amendment to the contracts document and an ADR **proposal** before any code (spec:95). It is not a one-line addition and this task says so rather than implying otherwise.
2. **A per-employee limit** would be a column on `app.branch_pos_policy` (6C's table) or a new `staff_purchase_limit` on `company_hr_setting` (8A's) — either is a migration in **a later slice's** range, since 0091–0095 is spent. This task allocates none.
3. **One permission code**, `pos.ticket.staff_purchase` — which §3.6.1's closed vocabulary does **not** contain, so it is an amendment to §3.6.2 first (hazard 26).
4. **No new account.** `1400` staff advances (8B's §4.15 row) is the debit, exactly as an `EMPLOYEE_ADVANCE` uses it; a staff purchase is an advance in kind.
5. **No new document type.** The till ticket is a `POS_TICKET` (6A's) with a different tender leg; inventing a `STAFF_PURCHASE` type would be a §4.14 row for a thing that is a tender method.

- [ ] **Step 1: Record the question and the default, and stop**

````markdown
<!-- docs/owner/od-14-staff-purchases.md -->
# ⚠️ OD-14 (fourth clause) — staff purchases at the till on salary deduction

**Status: not built.** This document records the question, the path that ships without it, and exactly what
a "yes" would cost. Nothing here is a commitment to build it.

OD-14's first three clauses — HRD Corp levy applicability, foreign workers, hourly-paid and part-time staff
— belong to **8B's Task 8** and are not re-opened here. This document owns the fourth clause only.

## The question, in four parts

1. **May staff buy at the till and have it deducted from pay at all?** Yes or no.
2. **What approval is required at the till?** A supervisor override, a manager PIN, or nothing.
3. **Does a limit apply, and is it per employee or per month?** Give the figure and the unit.
4. **Is the deduction recovered in one pay period or spread over several, and who authorises it?**

## The default that ships, and it works with nothing added

An officer raises an ordinary **`EMPLOYEE_ADVANCE`** for the amount. It debits `1400` staff advances,
tagged with the employee's `EMPLOYEE` dimension value. 8B's advance-recovery `pay_component`
(`expense_account_id = 1400`, 8B's Task 4) clears it on the next payroll run, and `advanceBalance` (8C
Task 6) answers "what does this employee owe" at any date. No table, no column, no tender method, no
permission code and no account is needed for this path — it is already shipped and already tested.

The one thing the default does **not** give you is capture *at the till*: the purchase is recorded by the
officer afterwards rather than by the cashier at the point of sale.

## Exactly what a "yes" costs

1. **A new tender method on `POS_TICKET`.** `LineSnapshot.tenderMethod` is a frozen four-value union
   `cash | card | transfer | store_credit` (§4.4.2), and `posting-policy.schema.json`'s
   `when["line.tender_method"]` enum matches it. A fifth value is a **schema change** — a new `version`
   const and a new `$id` (§4.4.1's own rule) — which is an amendment to the contracts document and an
   **ADR proposal** before any code (spec:95). It is not a one-line addition.
2. **A per-employee limit** is a column on `app.branch_pos_policy` (6C's table) or a new
   `staff_purchase_limit` on `app.company_hr_setting` (8A's). Either is a **migration in a later slice's
   range** — 8C's 0091–0095 is spent — so 8C allocates none.
3. **One permission code**, `pos.ticket.staff_purchase`, which §3.6.1's closed vocabulary does not
   contain. It is an amendment to §3.6.2 **first** (hazard 26), before it is written anywhere.
4. **No new account.** `1400` staff advances (8B's §4.15 row) is the debit, exactly as an
   `EMPLOYEE_ADVANCE` uses it. A staff purchase is an advance in kind.
5. **No new document type.** The till ticket is a `POS_TICKET` (6A's) with a different tender leg.
   Inventing a `STAFF_PURCHASE` type would be a §4.14 row for a thing that is a tender method.

**Two amendments are prerequisites, not consequences**: the posting-policy schema version (item 1) and the
permission-catalogue row (item 3). Both land before the first line of implementation.

## How it would be verified

```bash
bun run --cwd packages/db test hr/staff-purchase.test.ts
```

A `POS_TICKET` tendered to the new method resolves to a debit on `1400` tagged `EMPLOYEE`,
`advanceBalance` reports it, and the next payroll run's advance-recovery component clears it to zero.

## Answer here

- (1) May staff buy on salary deduction?
- (2) Approval required at the till?
- (3) Limit, and its unit?
- (4) Recovery period, and who authorises?
- Confirmed by / date:
````

Commit it alone; **write no code**:

```bash
git add docs/owner/od-14-staff-purchases.md
git commit -m "docs(owner): record OD-14's staff-purchase clause and its default (8C) [8C T14]

Not built. EMPLOYEE_ADVANCE plus the advance-recovery component is the shipped
path. A yes needs a posting-policy schema version and a permission-catalogue
amendment first, both ADR proposals (spec:95).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: ⚠️ OD-23 — the employer registration numbers and the pay-date convention (isolated owner gate)

**This task is droppable and nothing else in the slice depends on it.** It closes the two clauses of OD-23 that **this slice is the first consumer of**, and touches neither the rate tables (8B's Task 12) nor the schedule *layout* (Task 13).

**Owner decision:** **OD-23** (§2.12; spec:2407) — *"Employer registration numbers; current EPF/SOCSO/EIS/PCB tables + worked examples signed off by the accountant; staff list; **pay-period/pay-date conventions**."* §2.12's Gates column names 8A, 8B and 8D for the rate-table half. The two clauses below are 8C's because **8A's own OD-23 task says so in as many words**: *"Nothing in 8A, 8B or 8C reads a registration number — the first consumer is **8C's statutory schedule** and 8D's annual employer return, both of which state a missing registration by name rather than printing an empty box."*

**Owner provides:**
- **(a)** the employer's registration number with **each** scheme (`EPF`, `SOCSO`, `EIS`, `PCB`, and any levy confirmed under OD-14), as a plain string per scheme;
- **(b)** the **pay-period and pay-date convention** in writing, confirmed by the accountant: is a pay period a calendar month, and is the pay date inside it or in the following month? The one thing this slice needs from the answer is which **calendar year** a period's figures accumulate into.

**Verify with:**

```bash
psql "$DATABASE_URL_MIGRATOR" -c \
  "select code, employer_registration is not null as registered from app.statutory_scheme order by code"
bun run --cwd packages/db test hr/tax-year-convention.test.ts
```

**Expected:** the first prints `registered = t` for every scheme — the same command 8A's own OD-23 task names, so the two slices check one fact one way — and the second is green with **no** `it.skip`.

**Until provided — the default written into this plan, and it is complete:**
- `app.statutory_scheme.employer_registration` (8A's column, amendment A3) stays **null**. A schedule is still generated, its totals are still correct, and test 30's tie-out is unaffected: a registration number is a *filing* fact, never a *ledger* fact. What this task adds is that the null is **visible** — `StatutoryScheduleResult.employerRegistration` carries it, the API detail returns it, and `missingEmployerRegistrations` names the schemes, so 8D's employer return can print the scheme's name beside the gap instead of an empty box.
- **`employee_ytd.tax_year` is the calendar year of `payroll_run.pay_date`** (amendment B7). It is a *convention this slice fixes*, **not a statutory claim**: no rate, threshold, relief or deadline follows from it anywhere in this repository, and hazard 1 is untouched by it either way.

**Exactly what changes if the owner answers otherwise — and it is one expression and one job run:**

| If the accountant says | Change |
|---|---|
| the year is `period_end`'s, not `pay_date`'s | **one expression** in `0092_create_employee_ytd.sql`: `extract(year from r.pay_date)` becomes `extract(year from r.period_end)` inside `app.employee_ytd_delta`. Because §3.4.7 forbids editing an applied migration, the *function* change lands as a **new migration in 8D's range** that `create or replace`s it. **Moving the existing rows is a separate problem and this table must not pretend otherwise.** A migration cannot do it: `FORCE ROW LEVEL SECURITY` binds `app_migrator` and a migration file sees no tenants (Global Constraint 9, hazard 10). Nor can this slice's job: `hr.employee_ytd.rebuild` **reads and compares and has no write path**, by ADR 0077 decision 1, and `packages/db/src/integrity/**` is not on §3.7.5's allow-list for `app.employee_ytd`. So a re-key of the existing rows needs a **new function under `packages/db/src/posting/**`** — the only directory that may write the table — invoked per tenant under `systemContext`, registered by an amendment before it is written, and owned by whichever slice does the change. Until then the correction applies to runs posted **after** the new migration, and the older rows are re-keyed by that separate, named piece of work. Amendment B7 and ADR 0077's decision paragraph are amended in the same PR |
| a pay period is not a calendar month | **nothing in this slice.** `payroll_run.period_start` / `period_end` are already free dates (8B, §4.12.6) and every figure here is keyed off the run, never off a month |
| the registration numbers arrive | one statement per scheme, run by the seed CLI as the system principal and **never as a migration** (hazard 10 — a migration file has no `set_config` and sees no tenants): `update app.statutory_scheme set employer_registration = $2 where company_id = $1 and code = $3`, with `$2` the owner's number and `$3` one of `EPF`, `SOCSO`, `EIS`, `PCB`. Then Step 1's last case loses its `.skip` and the Verify block's `psql` prints `registered = t` for every row |

**Files:**
- Modify: `packages/db/src/hr/schedule.ts` (one column on two reads, one field on the type), `packages/contracts/src/hr/statutory-schedule.ts` (one nullable field), **`apps/api/src/routes/hr/statutory-schedules.ts`** (one line in `present` — the contract field is required on the wire, so the route's object literal must carry it or `tsc` fails), `packages/db/src/index.ts`, `packages/contracts/openapi.json`
- Create: `packages/db/test/hr/tax-year-convention.test.ts`
- Test: `packages/db/test/hr/tax-year-convention.test.ts`, `packages/db/test/hr/schedule.test.ts` (re-run), `apps/api/test/routes/hr/statutory-schedules.test.ts` (re-run), and **`packages/db/test/hr/schedule-layouts.test.ts` (re-run, if Task 13 has landed)** — it declares a `StatutoryScheduleResult` literal, which is why the new member is optional

**Interfaces:**
- Consumes: `generateStatutorySchedule` / `readSchedule` / `listSchedules` / `StatutoryScheduleResult` (T7), `app.employee_ytd` and `app.employee_ytd_delta` (T2), `postPayrollRun` (8B), `moneyOutFixture` / `MoneyOutFixture` (T6), `startDb` / `withTenant` (test helper, §4.1), `seedTenantV2` (1A).
- Produces: `StatutoryScheduleResult.employerRegistration: string | null` (**additive** — no existing member changes shape) and `missingEmployerRegistrations`. Both are internal to `packages/db/src/hr/schedule.ts`; **no register in §4 gains a row and no amendment is filed**, because neither name crosses a slice boundary.

```ts
// packages/db/src/hr/schedule.ts — the additive field and the one new read
export interface StatutoryScheduleResult {
  // Task 7's eleven members, none of which changes shape, name or nullability:
  scheduleId: string; schemeId: string; schemeCode: string;
  periodStart: string; periodEnd: string; payrollDocumentId: string;
  totalEmployee: Money; totalEmployer: Money; currency: string;
  attachmentId: string | null; remittanceDocumentId: string | null;
  rows: ScheduleRow[];
  // and the ONE field this task adds:
  /**
   * ⚠️ OD-23. 8A's `statutory_scheme.employer_registration`; null until the owner supplies it.
   *
   * **`?:`, and the question mark is load-bearing.** Task 13 is a *different droppable PR* (PR 11) and it
   * declares `const SYNTHETIC_SCHEDULE: StatutoryScheduleResult = { …eleven members… }`. A **required**
   * member here would make that literal fail `tsc` — "Property 'employerRegistration' is missing in type
   * … but required in type 'StatutoryScheduleResult'" — the moment PR 13 landed, and the two gates can
   * land in either order or not at all. Optional costs nothing that matters: the three readers below all
   * set it, and the **wire** contract stays `z.string().nullable()` — non-optional — with `present`
   * writing `?? null`. Step 4 explains why the wire field is nullable rather than optional; that argument
   * is about the client, and it is unaffected by the shape of the internal type.
   */
  employerRegistration?: string | null;
}
/** The scheme codes whose employer registration is still null, so a caller NAMES the gap (8A's rule). */
export async function missingEmployerRegistrations(tx: Sql, companyId: string): Promise<string[]>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/hr/tax-year-convention.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../../src/attachment/object-store";
import { generateStatutorySchedule, missingEmployerRegistrations, readSchedule } from "../../src/hr/schedule";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { moneyOutFixture, type MoneyOutFixture } from "../../../../tests/invariants/support/payroll-money";
import { postPayrollRun } from "../../../../tests/invariants/support/payroll";

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db; let s: Seed; let f: MoneyOutFixture;
const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Od23");
  f = await moneyOutFixture(db, s);          // posts the January 2026 run, pay date 2026-02-05
}, 240_000);   // Testcontainers boot + a posted payroll run; vitest's default hook timeout is far below it

afterAll(async () => { await db.stop(); });

describe("⚠️ OD-23 (a) — the pay-date convention, amendment B7", () => {
  it("a December period paid in January accumulates into the PAY DATE's year, not the period's", async () => {
    // The one case the convention is visible in, and the reason it had to be written down: this run's
    // period ends in 2026 and its money reaches the employee in 2027.
    const crossing = await postPayrollRun(db, s, f, {
      periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2027-01-05", effectiveDate: "2026-12-31",
    });

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ tax_year: number; gross: string }[]>`
      select tax_year, gross::text as gross from app.employee_ytd
       where company_id = ${s.company} and employee_id = ${f.employeeAId}
       order by tax_year`);

    // Two rows: January 2026's (from moneyOutFixture) and December's, which landed in 2027.
    expect(rows.map((r) => r.tax_year)).toEqual([2026, 2027]);

    // And the crossing run contributed to 2027 ALONE — the 2026 row must not have moved.
    const [delta] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ tax_year: number }[]>`
      select tax_year from app.employee_ytd_delta(${crossing}) where employee_id = ${f.employeeAId}`);
    expect(delta!.tax_year).toBe(2027);
  });

  it("the convention is recorded as a convention, never as a statutory claim (hazard 1)", async () => {
    const [c] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ description: string | null }[]>`
      select col_description('app.employee_ytd'::regclass, attnum) as description
        from pg_attribute where attrelid = 'app.employee_ytd'::regclass and attname = 'tax_year'`);
    expect(c!.description).toMatch(/amendment B7/);
    expect(c!.description).toMatch(/NOT a statutory claim/);
  });
});

describe("⚠️ OD-23 (b) — the employer registration numbers", () => {
  it("a schedule generates with a NULL registration, and the null is visible rather than blank", async () => {
    const store = new MemoryObjectStore();
    const [result] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(), store, {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
      }));

    // The RECORD is complete — this is the point. A missing registration is a filing fact, not a
    // ledger fact, and test 30's tie-out is unaffected by it.
    expect(result!.totalEmployee.toString()).toMatch(/^\d+\.\d{4}$/);
    expect(result!.employerRegistration).toBeNull();
    expect(await withTenant(db.rw, s.tenant, s.human, (tx) => readSchedule(tx, result!.scheduleId)))
      .toMatchObject({ employerRegistration: null });

    // And the gap is NAMED, which is what 8A's own OD-23 task requires of this slice. The expected code is
    // READ from the fixture's scheme, never written as a literal: 8B's `payrollFixture` seeds it as `EPF`
    // (8b:4155) and only the *rate table* is `SYNTH`, so `["SYNTH"]` here would fail on every run.
    const [scheme] = await db.admin<{ code: string }[]>`
      select code from app.statutory_scheme where id = ${f.schemeId}`;
    const missing = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      missingEmployerRegistrations(tx, s.company));
    expect(missing).toEqual([scheme!.code]);
  });

  it("once the owner supplies a number it round-trips onto the schedule", async () => {
    // An INVENTED string. Hazard 1 binds this file like every other: no real registration number,
    // from any authority, ever reaches the repository.
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.statutory_scheme set employer_registration = 'SYNTH-EMPLOYER-0001'
       where id = ${f.schemeId}`);

    const store = new MemoryObjectStore();
    const [result] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      generateStatutorySchedule(tx, ctx(), store, {
        companyId: s.company, payrollDocumentId: f.payrollDocumentId,
      }));
    expect(result!.employerRegistration).toBe("SYNTH-EMPLOYER-0001");
    expect(await withTenant(db.rw, s.tenant, s.human, (tx) =>
      missingEmployerRegistrations(tx, s.company))).toEqual([]);
  });

  it.skip("⚠️ OD-23: every scheme in the owner's company carries its registration", async () => {
    // Un-skip when the owner answers. It runs against the seeded company, not the fixture, and is the
    // executable form of the psql command in this task's Verify block.
    const missing = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      missingEmployerRegistrations(tx, s.company));
    expect(missing, `schemes without an employer registration: ${missing.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/db test hr/tax-year-convention.test.ts
```

**Expected: FAIL** with `does not provide an export named 'missingEmployerRegistrations'` on the import. If instead the **first** case fails with `expected [ 2026 ] to deeply equal [ 2026, 2027 ]`, the crossing run did not post — check that `payrollFixture`'s `ensureOpenPeriods(db, s, 2026)` really opened December, since `app.document.fiscal_period_id` is NOT NULL and a December run in a missing period dies at draft with `ERR_PERIOD_NOT_FOUND`, not here.

- [ ] **Step 3: Add the field and the one function to `packages/db/src/hr/schedule.ts`, and the one line to the route**

Three edits, all additive; Task 7's own suite must stay green unchanged. **The aliases below are Task 7's actual ones and are not interchangeable** — Task 7 aliases `app.statutory_schedule` as `ss2` precisely *because* `ss` already means `statutory_scheme` in `generateStatutorySchedule`'s neighbourhood, and it says so at the end of its Step 3. Read the alias off the query you are editing.

**(a) The two readers, through `HEADER_COLUMNS`.** `readSchedule` and `listSchedules` both select `HEADER_COLUMNS(tx)` from `app.statutory_schedule ss2 join app.statutory_scheme **sc** on sc.id = ss2.scheme_id`, so the column goes into that fragment, on **`sc`**, in the file's snake_case row convention (`ScheduleHeaderRow`'s other ten members are snake_case; a lone camelCase alias here would be the drift the interface exists to prevent):

```ts
const HEADER_COLUMNS = (tx: Sql) => tx`
  ss2.id, ss2.scheme_id, sc.code as scheme_code,
  to_char(ss2.period_start, 'YYYY-MM-DD') as period_start,
  to_char(ss2.period_end,   'YYYY-MM-DD') as period_end,
  ss2.payroll_document_id,
  to_char(ss2.total_employee, 'FM999999999999990.0000') as total_employee,
  to_char(ss2.total_employer, 'FM999999999999990.0000') as total_employer,
  ss2.currency, ss2.attachment_id, ss2.remittance_document_id,
  sc.employer_registration`;
```

`ScheduleHeaderRow` gains `employer_registration: string | null;` and `hydrate` gains one line beside `remittanceDocumentId`:

```ts
    employerRegistration: row.employer_registration,
```

**(b) The generator, which builds its result by hand.** `generateStatutorySchedule` does **not** go through `hydrate` — it assembles `result` from its own `schemes` query, and that query is the one aliased **`ss`**. Add the column there:

```ts
  const schemes = await tx<{
    scheme_id: string; scheme_code: string; employer_registration: string | null;
  }[]>`
    select distinct pl.scheme_id, ss.code as scheme_code, ss.employer_registration
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.statutory_scheme ss on ss.id = pl.scheme_id
     where dl.document_id = ${input.payrollDocumentId}
       and pl.scheme_id is not null
       and (${input.schemeIds ?? null}::uuid[] is null
            or pl.scheme_id = any(${input.schemeIds ?? null}::uuid[]))
     order by ss.code`;
```

and one line in the `result` literal, beside `remittanceDocumentId`:

```ts
      employerRegistration: scheme.employer_registration,
```

**(c) The route's `present`.** `packages/contracts/src/hr/statutory-schedule.ts` makes the field **required and nullable** on the wire (Step 4), and `apps/api/src/routes/hr/statutory-schedules.ts`'s `present` is an object literal typed `z.infer<typeof StatutoryScheduleSchema>` — so it must carry the key or `tsc` reports *"Property 'employerRegistration' is missing"*. One line, beside `remittanceDocumentId`, and the `?? null` is where the optional internal member becomes a required nullable wire field:

```ts
  employerRegistration: r.employerRegistration ?? null,
```

**(d)** Append the one new function:

```ts
/**
 * ⚠️ OD-23. The scheme codes whose employer registration is still null.
 *
 * It exists so a caller can **name the gap**: 8A's own OD-23 task requires that this slice's schedule and
 * 8D's employer return "state a missing registration by name rather than printing an empty box", and a
 * caller cannot do that from a null field alone — it needs the list. Sorted, so a message built from it
 * is stable and two runs of the same report read alike.
 */
export async function missingEmployerRegistrations(tx: Sql, companyId: string): Promise<string[]> {
  const rows = await tx<{ code: string }[]>`
    select code from app.statutory_scheme
     where company_id = ${companyId} and employer_registration is null
     order by code`;
  return rows.map((r) => r.code);
}
```

- [ ] **Step 4: Add the nullable field to the contract and regenerate OpenAPI**

`packages/contracts/src/hr/statutory-schedule.ts` — one line inside `StatutoryScheduleSchema`:

```ts
  /** ⚠️ OD-23. Null until the owner supplies the number; the client names the scheme, never a blank box. */
  employerRegistration: z.string().nullable(),
```

**It is `nullable`, not `optional`.** An absent key and a null value are different claims: absent would let a client render nothing and never know it had a gap, which is the empty box 8A's rule forbids. `nullable` makes the gap part of the payload.

```bash
bun run --cwd packages/contracts openapi:generate
```

- [ ] **Step 5: Run everything and commit**

```bash
bun run --cwd packages/db test hr/tax-year-convention.test.ts
bun run --cwd packages/db test hr/schedule.test.ts
bun run --cwd apps/api test routes/hr/statutory-schedules.test.ts
# Only if Task 13 landed — it is a droppable PR and the file may not exist:
test -f packages/db/test/hr/schedule-layouts.test.ts && bun run --cwd packages/db test hr/schedule-layouts.test.ts
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

**Expected:** green, with exactly **one** `skipped` — the `⚠️ OD-23` case that waits for the owner — plus Task 13's four skips if that PR landed. Task 7's suite is unchanged and still green: the field is additive and `SCHEDULE_CSV_HEADER` is untouched, which is what keeps Task 13's pin on the generic layout honest. **If `bun run typecheck` reports *"Property 'employerRegistration' is missing"* in `schedule-layouts.test.ts`, the member was declared required rather than optional** — restore the `?:` from Step 3's interface block; that file's `SYNTHETIC_SCHEDULE` literal is exactly what the optional marker is there for, and adding the key to it instead would break Task 13 for anyone who ships that PR without this one.

```bash
git add packages/db/src/hr/schedule.ts packages/db/src/index.ts \
        packages/contracts/src/hr/statutory-schedule.ts packages/contracts/openapi.json \
        apps/api/src/routes/hr/statutory-schedules.ts \
        packages/db/test/hr/tax-year-convention.test.ts
git commit -m "$(cat <<'EOF'
feat(db): surface the employer registration and pin the pay-date convention [8C T15]

OD-23's two 8C clauses. employer_registration reaches StatutoryScheduleResult and the
API detail as a NULLABLE field, and missingEmployerRegistrations names the schemes that
lack one, so a caller states the gap instead of printing a blank box (8A's rule).
employee_ytd.tax_year is pinned to the calendar year of payroll_run.pay_date with the
test that makes a December period paid in January visible (amendment B7). A convention,
never a statutory claim.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Run against the spec, the 8C card and the writing-plans skill with fresh eyes. Issues found are fixed **inline above**; each row below says where.

### 1. Spec coverage — every clause of §2.9's 8C *Delivers* list has a task

| Card clause | Task |
|---|---|
| `PAYROLL_PAYMENT` — one bank batch, one line per employee, clears salaries payable **per employee** | T5 (type and policy), T6 (service, routes), T8 (the per-employee tie-out) |
| R1 on it; `accounting.payment.approve` / `.post` | T5 (`approval.required = true` with both codes), T12 (the three-path re-run of test 31) |
| released under `hr.payroll.pay` | T4 (the code), T5 (`approval.create`), T6 (the route gate) |
| bank-neutral CSV | T6 (`payrollBatchCsv`, six columns, the `GET …/csv` route) |
| statutory remittances as `PAYMENT` documents to authority **vendor parties** | T6 (`moneyOutFixture` seeds the vendor party onto `statutory_scheme.authority_party_id`), T8 (`postRemittance`, `settleStatutorySchedule`) |
| refused if the amount differs from the schedule (`ERR_PAYROLL_REMITTANCE_MISMATCH`) | T1 (the trigger — the control), T8 (the service and test 30 clause 4) |
| `EMPLOYEE_ADVANCE` — debit staff advances per employee, credit bank | T5, T6 |
| recovered by the advance-recovery component; **outstanding balance is a ledger projection** | T6 (`advanceBalance` reads `1400` tagged EMPLOYEE; no loan table exists anywhere in the slice) |
| under `hr.advance.create` with `accounting.payment.approve` / `.post` | T4, T5, T6 |
| `app.statutory_schedule` — one row per scheme per period, **from posted lines only**, attachment hash, the settling PAYMENT | T1 (DDL), T7 (generation, CSV, attachment + sha256), T8 (settlement) |
| "a record, not a lodgement state machine" | T1 — the table has **no** status column and the file says why |
| `app.employee_ytd` projection per employee per tax year | T2 (DDL + the delta function), T3 (the step-12 MERGE) |
| nightly `hr.employee_ytd.rebuild` compare (D14) | T9 (the handler, the sentinel, `EMPLOYEE_YTD_CHECK`) |
| `app.employee_ytd_opening` (loaded by 9B) | T2 (DDL), T9 (`upsertEmployeeYtdOpening` and its suite); the opening reaches a YTD *reading* through T3's `ytdFromEmployeeYtd` and is on **neither** side of the rebuild — amendment **B14**, asserted in both directions by T9's test 35 clause 1 |
| **extends `postDocument` step 12**; adds `employee_ytd` to §4.3.2's closed write list and to `posting-only-tables` | T2 (the lint rule), T3 (the step and the header comment) |
| Termination: AFTER UPDATE OF `terminated_on` → `pos_cashier.revoked_at`, expire every `role_assignment`, bump the catalogue revision; **under the terminating actor** | T10 |
| deferrable constraint trigger "cashiers are employees" | T11 |
| `final` PAYROLL kind | T11 clause 4b — 8B owns the `kind` column; this slice proves the behaviour and adds no guard 8B did not |
| PAYROLL_PAYMENT batch joins the 4B matching (test 39's payroll-batch clause) | T12 |
| codes `hr.payroll.pay`, `hr.advance.create` | T4 |
| **DoD:** Σ payslip net = salaries-payable credit | T8 |
| **DoD:** each scheme's schedule = its payable to the cent | T7 (generation), T8 clause 3 |
| **DoD:** `employee_ytd` rebuilds bit-identically | T2 (one delta function), T3 (the MERGE consumes it), T9 (the rebuild consumes the same one) |
| Part VI **30**, **34**, **35** owned | T8, T11, T9 |
| Re-runs **2**, **20**, **31**, **39** | T9; **T11 clause 2b** (§6.1 row 20's *termination tombstone* re-run — a pull resumed from the revision a synced till holds, not a full pull from `0n`); T12; T12 |
| §3.0.4 rows **owned**: spec:1058 (PAYROLL_PAYMENT / remittances / EMPLOYEE_ADVANCE) and spec:1061 (Termination) | T5–T8 and T10–T11 |
| §3.0.4 row **contributed to**: spec:1043 (Bank reconciliation — 4B's row) | **T12** — `PAYROLL_BATCH_SOURCE` registered against 4B's seam, and the payroll-batch clause of test 39 |
| §3.0.4 row **contributed to**: spec:1059 (`employee_ytd` — 8D's row) | **T2** (the table, the opening table and the one delta function), **T3** (the step-12 MERGE and `ytdFromEmployeeYtd`), **T9** (the rebuild, the nightly job and the openings) |
| Regression appends legacy-004, 011, 016, 019, 021, 044 | T9, T8, T9, T8, T11, T10 |
| Owner gate **OD-28** (schedule layouts) | T13, isolated |
| Owner gate **OD-14** (the money-out clause) | T14, isolated |
| Owner gate **OD-23** (employer registrations; the pay-date convention) | T15, isolated — the two clauses 8A's own OD-23 task assigns to this slice as *"the first consumer"*; the rate-table half stays 8B's Task 12 |

**Three gaps found and closed.** (a) The card's *"`final` PAYROLL kind"* had no task until T11 clause 4b was added — it is 8B's column and this slice's *behaviour*, and asserting the pair (a January leaver is on January's regular run and off February's, and a `final` run reaches them) is what makes it a rule rather than a boundary. (b) `employee_ytd_opening` was created in T2 with no writer; T9's `upsertEmployeeYtdOpening` closes that, and the route that exposes it is deliberately **9B's** — this slice ships the table and the function, and 9B's importer is the loader spec:2084 names. (c) **§6.1 row 20 lists `8C (termination tombstone)` in its re-run column and no task named it.** The Assumptions block and this table now both carry test 20, and T11 clause 2b is where it passes: a full pull from `0n` (clause 2) shows the tombstone exists, but only a pull resumed from the revision a till already holds shows it is *reachable* — which is the property row 20 is about.

### 2. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `similar to Task`, `and so on`, `etc.`, `add appropriate`, `handle edge cases`, `…` standing in for content, `/* … */`, and every "written out in full in the repository file" / "mirrors it" / "asserts:" formulation that stands where code belongs.

**Zero remain.** An earlier draft of this plan argued that a summary naming every varying value was an acceptable substitute for a repetitive route module. It is not: the writing-plans skill says every code step carries the real code, and each of those summaries turned out to be hiding a decision — the CSV route's masked bank field, the balance route's path shape, `present`'s derivation of `payrollDocumentId` from `document.notes`, the fact that a route may not write SQL and therefore needs `listMoneyOut` in the service. The elisions were removed and, in every case, writing the body exposed something the summary had not said.

| Was elided | Now |
|---|---|
| T6 Step 8 — three of four `payroll-payments` routes; the whole `employee-advances` module | Both files in full, with `present`, `payrollRunOf`, `reasonOf`, the cursor round-trip and the constant bank mask |
| T6 Step 10 — the `employee-advances` route test | Nine cases in full, including the base-currency refusal and the `asOf`-less balance call |
| T7 Step 3 — `readSchedule`, `listSchedules` | In full, plus `scheduleRowsFor` and `hydrate` lifted out so the generator and the readers share one arithmetic |
| T7 Step 5 — five routes behind a gate table | The whole module in full |
| T7 Step 6 — the schedule route test | Seven cases in full, including hazard 2's regex at the wire |
| T8 Step 5 — `remittance.test.ts` | Nine cases in full (3 + 4 + 2 across its three `describe`s) |
| T8 Step 7 — the `legacy-011` case with an empty body, and `legacy-019` prose | Both blocks in full; the `legacy-011` case now actually exercises the `coalesce` |
| T9 Step 5 — `opening.ts` and its suite | Both in full |
| T9 Step 7 — the worker test | Six cases in full |
| T9 Step 8 — `legacy-004`, `legacy-016` | Both in full, `legacy-016` including the hand-drafted supplementary run that makes a negative net reachable |
| T10 Step 4 — ADR 0078 and `legacy-044` | Both in full |
| T11 Step 5 — `legacy-021` | In full |
| T12 Steps 1 and 3 — two `/* … */` markers, `draftOf`, `hasOrigin` | The `importStatement` + `match` sequences in full; `draftOf` and `hasOrigin` defined in the files that use them |
| T13 Step 1 — *"Create `docs/owner/statutory-layouts/README.md` naming the four schemes, the seven facts…"* | The README written out in full: the four schemes, the seven facts as a numbered list, the two files expected per scheme directory as a table, and what happens when one is filled |
| T14 Step 1 — *"Create `docs/owner/od-14-staff-purchases.md` carrying the four sub-questions above…"* | The document written out in full: the four questions, the shipped default and what it does **not** give, the five-item change list with its two amendment prerequisites, the verification command, and an "Answer here" block the owner fills in |
| T13 — `schedule-layouts/index.ts` described under *"if the owner answers"* while Step 2's suite imported it | Step 3 now writes the module in full with an **empty** `LAYOUTS`, so the suite compiles and `layoutFor` returns `null` for every scheme |
| T13 Step 2 — `SYNTHETIC_SCHEDULE`, `SYNTHETIC_EMPLOYER`, `ScheduleLayout.delimiter` | All three written out; `EmployerIdentifiers` defined |

**The `⚠️ await0` in T7 Step 1 stays, and it is not an elision.** It is a deliberate planted typo whose corrected block is printed immediately below it, in full, because an implementer reading only that task must see the correction rather than infer it.

**Two `/* … */` shapes survive the grep and neither stands where code belongs; both are named here so a reviewer running the same grep knows they were looked at.**

- **T6 Step 1's three signatures** — `moneyOutFixture`, `postPayrollPayment`, `postEmployeeAdvance` — carry `{ /* … Step 2 … */ }` in the *declaration* block and their bodies in **Step 2 of the same task, and therefore the same commit**. That is the Produces-block convention every plan in this series uses, 8B's own `payrollFixture` included (8b:4113–4120): the block is the interface, the step is the implementation, and the marker is a cross-reference rather than a gap. **A fourth signature, `postRemittance`, used to sit beside them with its body deferred to T8 Step 3 — and that one was a real defect, now removed**, because T6 is PR 5 and T8 is PR 6: an `async` function declared `Promise<string>` with an empty body is TS2355 and PR 5 would not have typechecked on its own. The convention is safe within a commit and unsafe across one, and T6 Step 1 now says so where the fourth signature was. Every body exists, in the PR that declares it.
- **T2 Step 4's `/* … existing members, unchanged … */`** inside `NO_ID_TABLES` is an instruction *not* to rewrite a set whose membership belongs to five earlier slices. Spelling those members out here would be the merge conflict hazard 13 is about, and would go stale the moment another slice added one. The step names exactly what this slice adds — **one entry, to one set** — and nothing else. (An earlier draft added the same entry to `AUDIT_EXEMPT` too; Plan 0A already ships it there, §3.5.3's column says **already** rather than **add**, and the duplicate is now removed with the reasoning written into the step.)

### 3. Type consistency

- `MoneyOutResult` / `MoneyOutLine` are defined once (T6) and used unchanged by T6's routes and T12's tests. `MoneyOutResult` carries the four header fields the two `…Schema`s need — `number`, `status`, `effectiveDate`, `notes` — **because a route may not write SQL** (test 27's `no-bare-db`): every field on the wire comes from the service or from nowhere.
- **`PayrollRunDetail.lines[].amount` is `{ amount, currency }`, not a string** (8b:3857–3862), and every one of the three places test 30 touches it reads `.amount.amount`. This is the type mismatch a reviewer found in the first draft; it is called out here rather than quietly fixed, because "the shape 8B froze" is exactly the class of fact a consuming slice gets wrong.
- `StatutoryScheduleResult` is defined once (T7) and is the return of `generateStatutorySchedule`, `readSchedule`, `listSchedules`, `settleStatutorySchedule` and `unsettleStatutorySchedule` — T8's two functions return T7's type, not a copy.
- `ProjectionMismatch` / `ProjectionCheck` are **1B's** and are imported, never redeclared (T9).
- `Reconcilable` / `ReconcilableSource` are **4B's** and are imported (T12).
- `PayrollFixture` (8B) is **extended** by `MoneyOutFixture` (`extends PayrollFixture`, T6), never shadowed — so `f.employeeAId`, `f.schemeId`, `f.approver` keep 8B's meaning everywhere in this slice.
- `EMPLOYEE_YTD_CHECK.name` is `"employee_ytd"` in T9 and the pinned array in three files uses that exact string.
- `EMPLOYEE_YTD_DRIFT_SENTINEL` is `"employee_ytd_drift"` in T9 and in amendment B2; there is one spelling.
- `app.employee_ytd_delta`'s seven return columns are declared once (T2) and consumed by name in T3's MERGE and T9's rebuild.
- `app.jsonb_add_money` / `app.jsonb_add_scheme` are the state functions of `app.jsonb_add_money_agg` / `app.jsonb_add_scheme_agg` — **the same functions, which is the point** — and all four are created in **T2**, in `0092_create_employee_ytd.sql`, with their four drops at the head of `0092.down.sql`. T3 and T9 consume them and **neither reopens the migration**: an earlier draft appended sections to 0092 in two later PRs, which any database that had already applied 0092 would never have received (plan0A:736–748, §3.4.7, spec:2057).
- **One inconsistency found and fixed:** T2's expected-columns map for `statutory_schedule` originally listed `currency` as `char` where `information_schema` reports `bpchar` for `char(3)`; the test now asserts `bpchar`, which is what Postgres actually returns.

### 3a. Eight defects found by reading the drafted code against the frozen schema, and fixed

Each of these was written, then caught by checking a named line of Plan 0A or the contracts rather than by re-reading the prose around it. They are listed because the *class* matters more than the instance: every one of them would have compiled, passed review by eye, and failed at runtime.

| # | What was written | Why it fails | Where the answer was | Fixed in |
|---|---|---|---|---|
| 1 | `insert into app.document (…)` omitting `series`, in **seven** places | `document.series` is `text not null` (plan0A:1780). Numbering is at issue, but the *series* is not part of numbering — it exists from the draft. Every one of the seven inserts is a NOT NULL violation on the first row | plan0A:1773–1804 | T1 (×2), T2, T6 (test + `draftMoneyOut`), T7, T8 — and Global Constraint 21(c) |
| 2 | `draftMoneyOut` returning `doc.series` and T6 asserting `"PAYB"` | Consequence of #1: with the column unset the assertion could never have been reached. The fix reads the series from `resolvePolicy(...).definition.numbering.series` rather than repeating the literal — the envelope declares it once (T5) | §4.3.6, 8b:4375 | T6 Step 6 |
| 3 | `postedRemittance` inserting **one** `ledger_entry` row | `ledger_entry_balanced` is `DEFERRABLE INITIALLY DEFERRED` and fires at COMMIT (§4.3.2 step 15, spec:1865). The one-sided insert succeeds and then `withTenant` throws `ERR_LEDGER_UNBALANCED` several frames away | contracts §4.3.2 step 15 | T1 Step 2 |
| 4 | `seedMinimalEmployee` / `draftPayrollShell` / the termination UPDATEs running as `s.human` with no grant | `employee`, `document` and `pos_cashier` carry `AS RESTRICTIVE` `branch_isolation` (§4.5.6) and `seedTenant` grants `s.human` **nothing** (§4.1, pinned). The INSERTs are refused; the UPDATEs match zero rows and raise nothing, so T10's and T11's assertions fail pointing at innocent triggers | §4.1's pinned paragraph, §4.5.6, 6c:33 fact 2 | T1, T2, T10, T11 `beforeAll` — and Global Constraint 21(a)/(b) |
| 5 | `assert_cashier_is_employee` reading `new.id` | `app.pos_cashier` has **no `id` column** — its PK is `principal_id` and it is in `NO_ID_TABLES` (§4.6.3). plpgsql resolves every `new.<field>` while building the query's parameter list, and SQL `or` does not short-circuit, so the `tg_table_name` guard does not protect it: the trigger raises `record "new" has no field "id"` the first time it fires on that table. Now `to_jsonb(new) ->> …` on both sides | §4.6.3's DDL, contracts:1089 | T11 Step 3 |
| 6 | T6's `createPayrollPayment` `describe` drafting a fresh batch in each of three cases | The service excludes an employee already on a non-void batch — **a draft included**, deliberately. Cases 2, 3 and 5 would all have hit `ERR_VALIDATION_FAILED: … already paid` instead of asserting what they claim to. One draft is now shared by cases 1–3 and case 5 posts *it* before asking for a second | the service's own exclusion query, T6 Step 6 | T6 Step 3 |
| 7 | The schedule CSV attachment written with `document_id` null | §4.5.8 resolves the download gate from `document_type.module` through `attachment.document_id` (or `inventory.item.read` through `lot_id`). With neither, 2C's map falls through to a default deny and the file is undownloadable by anyone, forever, with an `ERR_RBAC_FORBIDDEN` naming no missing permission. It now carries the PAYROLL run — module `hr`, so the gate is `hr.payroll.read`, which is the right answer on the merits too | §4.5.8 | T7 Step 3 |
| 8 | The `reversal.allowed: true` justification claiming "Task 6 Step 8 pins that behaviour with a test" | Step 8 writes the two route modules; no such test existed. A flag nothing exercises is a policy that lies, so the test was **written** rather than the claim softened — it reverses the posted batch, asserts `ERR_DOC_STATUS_ILLEGAL` (8B's mechanic 1, which applies here while mechanic 2 does not — amendment B9), and asserts no half-built mirror was left | 8b:1500 | T5's prose, T6 Step 3's last case |

### 3b. Nine further defects, found by a review pass against the frozen schema and the frozen 8B surface

The class is the same as §3a's and so is the lesson: every one of these compiled, read correctly, and would have failed at run time against a name or a shape another plan had already frozen.

| # | What was written | Why it fails | Where the answer was | Fixed in |
|---|---|---|---|---|
| 9 | `jsonb_object_agg(l.component_code, to_char(sum(l.amount), …))` | `sum` inside `jsonb_object_agg` at the same query level is a **nested aggregate**: Postgres rejects it with `42803`, the `create function` fails, migration 0092 aborts and every task from T2 on is blocked. The prose beside it described the two-stage fold the SQL did not do | the SQL standard; the plan's own paragraph | T2 Step 3 — `per_component` sums, `components_rolled` folds |
| 10 | The rebuild's `parts as (select * from deltas union all select * from openings)` | Nothing writes an opening into `app.employee_ytd` — nothing **may**, since only `packages/db/src/posting/**` writes it — so every company with a cut-over opening would report permanent `amount_differs` drift and test 35 clause 1 could never pass. The read-time addition in `ytdFromEmployeeYtd` proves the projection was meant to be deltas-only | spec:98, §3.7.5, and this slice's own Global Constraint 1 | T9 Step 3, ADR 0077 decision 4, amendment **B14**, and test 35 clause 1 rewritten to assert both halves |
| 11 | `left join app.dimension_value dv on dv.company_id = …` | `app.dimension_value` has **no `company_id`** (plan0A:1820–1832) — the company is on `app.dimension_type` — so `createPayrollPayment`, the slice's headline service, would fail at run time. The query also had no `dimension_type.code = 'EMPLOYEE'` filter | plan0A:1808–1832; `advanceBalance`'s own two-hop join | T6 Step 6 |
| 12 | `join app.ledger_entry_dimension led on led.ledger_entry_id = le.id`, twice | The frozen column is **`entry_id`** (plan0A:2041–2050). The plan flagged the risk and told the implementer to grep for it, which is worse than either fixing it or leaving it: the answer was a §4.1 name available while the plan was being written | plan0A:2043 | T6 Step 6, T8 Step 1 — and the ⚠️ grep instruction and its handoff row deleted |
| 13 | `nets.set(line.employeeId, line.amount)` and `Number(l.amount)` | `PayrollRunDetail.lines[].amount` is `{ amount, currency }` and 8B says so in a comment (8b:3857–3862). A `string` compared to an object fails `tsc`; `Number({…})` is `NaN` | 8b:3857 | T8 Step 1, three places |
| 14 | `expect(r.schemeCode).toBe("SYNTH")`, `byScheme: { SYNTH: … }`, `expect(missing).toEqual(["SYNTH"])` | `payrollFixture` seeds its scheme as **`EPF`** (8b:4155); only the *rate table* is `SYNTH`. This plan states that fact correctly in two other places and then contradicted it in three assertions | 8b:4155, and T8's own `beforeAll` comment | T7 Step 1, T9 Step 1, T15 Step 1 — all three now read the code from the fixture |
| 15 | `sum(l.amount) filter (where l.line_kind = 'account')` as `net` | `payroll_line.amount` is constrained `>= 0` (8b:506), so the delta could never be negative — contradicting ADR 0077 decision 5, `mergeEmployeeYtd`'s own doc comment and the `legacy-016` block, and turning an over-payment **recovery** into an increase in YTD net | 8b:1526–1528 (rule 7 exists for exactly this) | T2 Step 3 — `sum(l.credit - l.debit)`, with the convention stated in the migration, the MERGE, ADR 0077 and Global Constraint 6 |
| 16 | `select id, account_type::text as type from app.account` | `account_type` is the **enum type's** name; the column is `type` (plan0A:1492, and 1A's own inserts) | plan0A:1485–1502 | T5 Step 1 |
| 17 | `create aggregate` without `grant execute`; `tx<Candidate>` and `tx<{…}>` without the array parameter | `postgres.js` types `sql<T extends readonly any[]>`, so a non-array `T` fails `bun run typecheck` (Global Constraint 17); and every other function this slice creates carries an explicit grant, so the two aggregates lacking one would fail as `app_rw` if Plan 0A revoked PUBLIC EXECUTE | the file's own neighbours | T2 Step 3 (section 5's two grants), T6 Step 6 (two generics) |

Two further notes recorded rather than changed. **`2411` is correct but no longer written down:** 8B's `payrollFixture` seeds its scheme with `code: "EPF"` (8b:4077 — only the *rate table* is `SYNTH`), and `linkPayrollAccounts` assigns `2411`–`2414` in the fixed order EPF, SOCSO, EIS, PCB, so the literal did resolve; T8's clauses 2 and 3 now read `statutory_scheme.payable_account_id` instead, because binding an acceptance test to §4.15's ordering would let a re-ordering turn it into `0 ≈ 0`. And **`ytdFromEmployeeYtd` is not a drop-in for 8B's `ytdBefore`** — it returns `gross` and `net`, while the calculator is keyed by `ytdKey` / `schemeYtdKey`; the Consequences block of ADR 0077 now says so in as many words, because substituting one for the other yields a wrong number rather than an error.

### 3c. Twelve defects found by an independent audit against the contracts document, plan 0A and the spec, and fixed

The class this time is **the import line and the column name**, not the query plan: five of the twelve would have stopped a PR at `bun run typecheck` or at the first statement of a suite, before any assertion in it ran.

| # | What was written | Why it fails | Where the answer was | Fixed in |
|---|---|---|---|---|
| 18 | `"../../../../tests/invariants/support/payroll-money"` and `"../../../../tests/support/api"` in the three `apps/api/test/routes/hr/*.test.ts` suites | Those files sit **five** directories below the repository root, so four `../` resolve to `apps/tests/…` and the module does not load. The same import block's `"../../support/app"` — two levels to `apps/api/test` — is what makes the count checkable on the page. The four-level form is right only from `packages/db/test/<sub>/` and `apps/worker/test/handlers/`, and this plan's ten `packages/db/test/hr/**` suites and its worker suite were already correct | 1B's and 2A's frozen precedent, restated by 3A's own self-review finding 13 (3a:8883) | T6 Step 10 (four imports), T7 Step 6 (two imports) |
| 19 | `import { seedTenantV2, startDb, uuidv7, withTenant, type Db, type Seed } from "../harness";` | §4.1 puts `startDb`, `withTenant`, `uuidv7` and `Db` in `packages/db/test/harness.ts` and `Seed` / `seedTenant` / `seedTenantV2` in `packages/db/test/fixtures.ts`; only `packages/db/test/index.ts` re-exports both. Every other suite in this plan splits the two statements correctly, so this one file would have failed `tsc` alone | §4.1, §4.17's `seedTenantV2` row | T10 Step 1 |
| 20 | `import { generateStatutorySchedule, settleStatutorySchedule } from "@dulja/db";` at the head of `tests/invariants/support/payroll-money.ts` | Both are created in **PR 6** and the file is created in **PR 5**, so PR 5 ends on **TS2305** and cannot merge on its own (Global Constraint 17). Neither name is used by any helper in the file, then or after T8 appends the fourth — the import was dead as well as early. The step immediately below it makes exactly this argument about `postRemittance`'s signature | the step's own `postRemittance` note | T6 Step 1 — one `@dulja/db` statement naming only what a body calls |
| 21 | `order by created_at` and `created_at >= now() - interval '10 minutes'` against `app.audit_log`, in three queries | Plan 0A's `app.audit_log` is `(seq, tenant_id, actor_id, occurred_at, table_name, row_id, action, before, after, prev_hash, hash)` — there is no `created_at`, so all three raise `column "created_at" does not exist`. The worker suite's `sentinels()` helper is called by every case in it | plan0A:2260–2274; 0A's own reads at plan0A:2173, 2226 | T9 Step 7 (`order by seq` — the identity PK 0A orders by), T10 Step 4 (`occurred_at` in both filters) |
| 22 | `table_name in ('employee', 'pos_cashier', 'role_assignment')` in the two `legacy-044` cases | §3.5.3 marks `pos_cashier` **AUDIT_EXEMPT** ("Audit-exempt projection", §4.6.3), so no `pos_cashier` audit row ever exists and that third of each claim was vacuous. The second case, filtering on `('pos_cashier', 'role_assignment')`, would have passed its `not.toContain("delete")` on an **empty** result — the exact outcome it exists to rule out | §3.5.3's register row, §4.6.3's note | T10 Step 4 — `pos_cashier` dropped from both lists, the reason stated in the file, and a `rows.length > 0` guard added to the second |
| 23 | `import type { AppEnv } from "../../env";` in all three new route modules | §4.2.3 declares `RequestContext` and `AppEnv` in `apps/api/src/context.ts`, and sixteen other plans — 8A, 8B and 8D among them — import it from `"../../context"`. There is no `apps/api/src/env.ts` | §4.2.3 | T6 Step 8 (two modules), T7 Step 5 |
| 24 | `principalId: await principal("C-1")` in T11 case 1 | Task 10 Step 1 defined only `staffMember`, which created the principal inline; no `principal(number)` function existed anywhere, so an executor copying T10's helpers verbatim got `Cannot find name 'principal'`. §5's helper inventory listed `principal`, which is how the gap survived | §5's own list | T10 Step 1 — `principal` extracted, `staffMember` calls it — and T11 Step 1, which also gained the import/declaration preamble it had been missing entirely |
| 25 | Task 13's suite imported `EmployerIdentifiers` and `layoutFor` from `../../src/hr/schedule-layouts`, a module no step created | The module was described under "*if* the owner answers", so PR 11 would have ended on **TS2307**, *"Cannot find module"* — blocker 20's class, one PR later | the task's own Step 2 code block | T13 Step 3, which now watches the TS2307, then writes `schedule-layouts/index.ts` **with an empty `LAYOUTS` registry** so `layoutFor` returns `null` for every scheme and `scheduleCsv` stays the layout in force |
| 26 | Tasks 13 and 14 opened with owner-decision prose and no `**Files:**` / `**Interfaces:**` blocks | Every other task in the slice, T15 included, carries both; T13 creates three real files and T14 one | the plan's own shape | Both tasks now carry them, T14's stating in as many words why a task that writes no code adds no test |
| 27 | T13 Step 1 and T14 Step 1 *described* their documents instead of carrying them | "Create `…README.md` naming the four schemes, the seven facts…" is a description standing where content belongs, and both surrounding prose blocks already held the material | Global Constraint on placeholders | Both markdown documents written out in full in their steps |
| 28 | `-t "settling with the right amount"`, a case title `remittance.test.ts` does not contain | The filter matches nothing and the diagnostic step passes with **zero tests run** — the opposite of what a probe step is for | the suite's own titles | T8 Step 6 — `-t "links a payment for exactly the schedule total"` |
| 29 | T15's `beforeAll` closed with no timeout while building `moneyOutFixture`; T5 Step 5 claimed "four cases" for a six-case suite; §2 claimed "Seven cases" for a nine-case `remittance.test.ts`; T7 Step 5's ⚠️ told the executor to correct a B10 row that already reads correctly; and one prose occurrence spelled `hr.employee.read_sensitive` with an underscore | Eight other suites in this slice pass `240_000` to the same `beforeAll`; vitest's default hook timeout is far below a Testcontainers boot plus a posted run, so T15 would fail as a hook timeout rather than the failure Step 2 predicts. The rest are counts and prose that send an executor the wrong way — the permission code especially, since §3.6.2 is a closed vocabulary (hazard 26) | the plan's own neighbours; §3.6.2 | T15 Step 1, T5 Step 5, §2's table, T7 Step 5, T6 Step 5 |

### 4. Hazards, re-read one by one

| Hazard | Where this plan satisfies it |
|---|---|
| 1 no real statutory figure | Global Constraint 7; every figure comes from 8B's `SYNTH` through `payrollFixture`; T7's CSV test and T7's route test both assert **by regex** that no authority, scheme or form name appears; T13 keeps it true when the layouts arrive |
| 2 no invented authority detail | T7's generic layout; T13's isolated gate; T14 states that direct e-filing is out of v1 |
| 5 owner-account tasks | T13 and T14 both follow the "owner provides X; verify with `<exact command>`; until provided `<local equivalent>`" pattern |
| 6 one isolated task per OD item | T13 (OD-28), T14 (OD-14's money-out clause only — 8B owns the other three, and T14 says so) and T15 (OD-23's employer-registration and pay-date clauses only — 8B's Task 12 owns the rate tables). **Three gates, three tasks, three droppable PRs**; no gate is spread across two tasks and no task carries two gates |
| 7 never re-open D1–D27 | none re-opened |
| 8 Plan 0A names | `startDb`, `Db`, `Seed`, the 4-argument test `withTenant`, `uuidv7`, `seedTenantV2`, `lintSchema`, `up`/`down`/`listApplied`, `app_meta.*`, `app.current_actor` used verbatim; nothing renamed |
| 9 `fixtures.ts` additive, and the test tier's own register | **`fixtures.ts` is not edited at all** (Global Constraint 20); the one shared helper file is registered by amendment B3 |
| 10 per-tenant rows are seed-pack data | 0091–0095 create objects and seed `app.permission` only; the two document types are pack files |
| 13 `lint-schema.ts` hotspot | T1 (`statutory_schedule` joins nothing) and T2 (`employee_ytd` joins **`NO_ID_TABLES` only** — §3.5.3 marks its `AUDIT_EXEMPT` column **already**, and Plan 0A shipped that member at plan0A:2706–2709, so re-adding it would be a duplicate literal in the merge hotspot; T2 Step 1 pins the membership instead of re-making it). `employee_ytd_opening` joins nothing. Exactly §3.5.3's declared state, and one edit to the file in the whole slice |
| 14 never renumber, never assert `max(version)` | 0091–0095 only; T1 Step 1's gate asserts **membership**, never a maximum |
| 18 test 22/28's projection set | not exercised here — 8B owns test 28 |
| 20 jobs run as the system principal | T9's handler test asserts `audit_log.actor_id` is the system principal |
| 22 nothing writes a protected table outside posting/costing | T2 adds `app.employee_ytd` to the rule; **T3's last `describe` scans the repository for DML naming it** and asserts zero offenders outside `posting/` and tests. `integrity/**` is deliberately **not** excluded from that scan: the nightly rebuild reads and compares and never writes (ADR 0077 decision 1), and §3.7.5's allow-list does not carry it |
| 26 the permission vocabulary is closed | T4 seeds exactly the two §3.6.2 codes; T14 states that a third would be an amendment first |
| 31 every route has a probe | T6 adds two, T7 the third, T9 the one `JOB_PROBES` entry |
| 32 no invented literal in a shared namespace | every document-type code, account code, `ERR_*` code and helper name in this plan is in the Assumptions block's namespace list; the one genuinely new code is **B13**, filed as an amendment before it is used |
| 33 the seeder of a policy seeds its accounts | this slice **seeds none** and **T5 Step 1 asserts `2400`, `1400` and `1100` resolve before either policy is loaded** — hazard 33's requirement of a consuming slice, verbatim |
| 34 a seed file is an envelope; `module` is not `approval.post`'s module | T5's two envelopes carry `module: "hr"` with `accounting.payment.*` approval, and the task states why in full |
| 35 real code, no elision | §2 above |

### 5. Contract additions — the complete list, and where each is registered

Fifteen amendments, **B1–B15**, all in the "Contract amendments this plan discovered" table and all filed by T1 Step 1 before any code. **B15 is the only one that also changes a file**: it registers `packages/db/test/**` on §4.17.1's cross-workspace allowance, and Step 1's second commit puts the line on `scripts/lint/rules/dependency-rule.ts` and the two `include` entries in `packages/db/tsconfig.json`, because an amendment row does not make `lint:rules` green. Beyond them, every name this plan introduces is **internal to one file of this slice** and is therefore not a contract addition: `MoneyOutError`, `MoneyOutStatus`, `MoneyOutListFilter`, `listMoneyOut`, `ScheduleError`, `RemittanceError`, `OpeningError`, `Candidate`, `draftMoneyOut`, `attachCsv`, `scheduleRowsFor`, `hydrate`, `HEADER_COLUMNS`, `field`, `typeIdFor`, `baseCurrencyOf`, `present`, `payrollRunOf`, `reasonOf`, `asAppError`, `staffMember`, `principal`, `seedMinimalEmployee`, `postedRunWithTwoLines`, `draftPayrollShell`, `insertSchedule`, `postedRemittance`, `creditFor`, `draftOf`, `hasOrigin`, `postRecovery`, `SYNTHETIC_SCHEDULE`, `SYNTHETIC_EMPLOYER`, `layoutFor`, `ScheduleLayout`, `EmployerIdentifiers` (the last three ship in T13's droppable PR, with `LAYOUTS` empty, and exist only if that PR lands; `packages/db/src/index.ts` re-exports none of them), and T15's `missingEmployerRegistrations` with the additive `StatutoryScheduleResult.employerRegistration` field — additive to a type **this slice itself declares** in T7, so no §4 register gains a row and no amendment is filed for either.

**Four of those are exported from `packages/db` and are worth naming separately**: `listMoneyOut` (T6), `OpeningError` (T9), and the type aliases `MoneyOutStatus` / `MoneyOutListFilter` (T6). They are members of files this slice creates, not additions to a frozen register, and `MoneyOutResult`'s four new header fields are additive to a type this slice declares — but a reviewer who expects the Produces block to be the whole export surface should find them there, and does.

### 6. Two things a reviewer should push back on, stated rather than hidden

- **`readMoneyOut` resolves the employee by joining `dimension_value.code` to `employee.employee_number`.** That is the join 8B's `EMPLOYEE` dimension trigger makes true (`code = employee_number`, §4.12.7) and it is the only path available, because the money-out lines carry no `payroll_line` row (amendment B9) and `document_line` has no `employee_id` column. It is a **string join on a business key**, which is exactly the shape LEGACY-021 warns about — but the value is unique per company (`employee.unique (company_id, employee_number)`) and neither side is ever reused or rewound. If a reviewer prefers a column, the change is `document_line.employee_id` with a composite FK, which is a **migration in a later slice's range and an amendment to §4.3.4**, not a change to make silently.
- **The 0091 guard reads account code `1100` as a literal.** §4.15 registers it and 0C seeds it, so it resolves — but a tenant that renamed its bank account's *code* would make the guard read 0 and refuse every remittance. The alternative is a `company.bank_account_id` column, which does not exist and would be a §4.6 addition. The literal is deliberate, is the same literal the policies use, and is asserted to resolve by T5 Step 1.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-8c-payroll-money-out-ytd-termination.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**

**If Subagent-Driven:** REQUIRED SUB-SKILL `superpowers:subagent-driven-development`, a fresh subagent per task plus the two-stage review. **If Inline:** REQUIRED SUB-SKILL `superpowers:executing-plans`, batch execution with checkpoints.

### Order, PRs and what each depends on

Execute **in numerical order**. T1 Step 1 (the amendment PR) precedes everything. PR boundaries: PR 1 = T1 · PR 2 = T2 · PR 3 = T3 · PR 4 = T4 · PR 5 = T5 + T6 · PR 6 = T7 + T8 · PR 7 = T9 · PR 8 = T10 · PR 9 = T11 · PR 10 = T12 · PR 11 = T13 ⚠️ · PR 12 = T14 ⚠️ · PR 13 = T15 ⚠️. **The three ⚠️ PRs carry no migration and each is droppable on its own**, so a slice that ships without any owner answer is PRs 1–10 and is complete against every clause of the DoD. One migration per PR (spec:2057) holds, and **each migration is written once and never reopened**: 0091 in PR 1, 0092 in PR 2 — **all five of its sections, including both jsonb functions and both aggregates** — 0095 in PR 4, 0093 in PR 8, 0094 in PR 9. T3 and T9 *consume* 0092's functions and add no DDL of their own; if either fails with `function … does not exist`, the test container is on a 0092 from a stale checkout and the fix is to roll it to 0091 and up again, never to append to the file.

### If a step fails differently from what it says

| Symptom | Cause and what to do |
|---|---|
| **Any suite**: `null value in column "series" of relation "document" violates not-null constraint` | A direct `insert into app.document` lost its `series`. `document.series` is `not null` from the draft (plan0A:1780); numbering is at issue, the series is not. Name it — `'JV'` for a shell, `'PAY'` for a run, `'PAY-OUT'` for a PAYMENT, or `select … series` when copying an existing document. In `draftMoneyOut` it comes from `resolvePolicy(...).definition.numbering.series`; do **not** re-introduce the `PAYB` / `ADV` literals there. Global Constraint 21(c). |
| **Any suite**: `new row violates row-level security policy for table "document"` / `"employee"` | `s.human` has no `role_assignment`, so `app.actor_in_branch` is false and the `AS RESTRICTIVE` `branch_isolation` policy (§4.5.6) rejects the insert — its `USING` doubles as the insert check. Add `grantCodes(db, s, { codes: [...] })` to that file's `beforeAll`; do **not** switch the write to `db.admin`, which would also disable the tenant test the suite exists for. Global Constraint 21(a). |
| **T10 / T11**: an assertion fails as *"expected null not to be null"* and the trigger looks correct | The same cause with the **silent** shape: a forbidden UPDATE matches zero rows and raises nothing, so `terminated_on` was never set and no trigger ever fired. Check `beforeAll` for the `grantCodes` call before touching 0093 or 0094. Global Constraint 21(b). |
| **T11**: `record "new" has no field "id"` | `app.pos_cashier` has no `id` column (§4.6.3). Address the moved row through `to_jsonb(new) ->> 'principal_id'` / `->> 'id'`, never `new.<field>` — plpgsql resolves the field before any row is examined, so a `tg_table_name` guard does not help. |
| **T1 Step 2**: `ERR_LEDGER_UNBALANCED` thrown by `withTenant` with no obviously bad insert | `ledger_entry_balanced` is deferred to COMMIT (spec:1865), so the throw is nowhere near the cause. A hand-written ledger pair is missing its second leg — check `postedRemittance`. Global Constraint 21(d). |
| **T6**: cases 2, 3 or 5 fail with `ERR_VALIDATION_FAILED: every employee … already paid` | The `describe`'s shared draft was replaced by per-case drafts. Drafts count toward "already paid" **by design** (an unposted batch is money about to leave). Restore the single `beforeAll` draft; case 5 posts it and then asks for a second. |
| **T7**: the schedule CSV uploads but `GET …/attachments/{id}/content` returns 403 for everyone | The attachment row has no `document_id`, so §4.5.8 cannot resolve a module and 2C's map denies by default. Set `document_id = result.payrollDocumentId` — module `hr`, gate `hr.payroll.read`. |
| **T6**: the reversal case rejects with a code other than `ERR_DOC_STATUS_ILLEGAL` | 2A/2B shipped a different refusal for reversing an `approval.required` type than 8B's amendment A4 predicted (8b:1500, mechanic 1). **Record what they actually shipped here and widen the assertion to that code — do not weaken it to a bare `.rejects`**, and do not "fix" it by flipping `reversal.allowed` to `false`: T5's prose argues at length that the policy's answer is yes and the state machine is the control, and a silent flip would make that prose a lie. If reversal *succeeds*, that is the interesting case: stop, because a second batch has just been posted with no second approver, and file it against §4.5.1 before going further. |
| **T1 Step 1's gate**: 87–90 missing | 8B has not merged. **Stop.** Every task from T3 onward consumes `payroll_run`, `payroll_line` or `payrollFixture`. |
| **T1 Step 1's gate**: 64–69 missing | 6C has not merged. T10 and T11 are unimplementable (`pos_cashier`, `refresh_pos_cashier`, `pos_cashier_tombstone`). **Stop.** |
| **T1 Step 1's gate**: 48–52 missing | 4B has not merged. T12 is unimplementable (`registerReconcilableSource`). T1–T11 are fine; execute them and hold T12. |
| **T1 Step 2** first case passes | 0091 exists from an interrupted run. Read it against Step 4 line by line before writing; do **not** re-create it. |
| **T2 Step 2**: `does not provide an export named 'NO_ID_TABLES'` | The set is private in your merged `lint-schema.ts`. Export it in Step 4 — §4.1 already exports two of the six and §3.5.3 treats all six as one surface. Additive. |
| **T3 or T9**: `function app.jsonb_add_money(jsonb, jsonb) does not exist`, or `app.jsonb_add_money_agg` | The container applied a **0092 from a checkout that predates Task 2's final form**. All five sections of 0092 land in PR 2; nothing in T3 or T9 adds DDL. Roll the test container down and up (`bun run --cwd packages/db src/cli.ts down 91 && … up`) so it re-applies the committed file. **Do not append to 0092 and do not create a sixth migration** — 0091–0095 is this slice's whole range and an applied migration is never edited (§3.4.7, spec:2057, plan0A:736–748). |
| **T3**: a JOURNAL post got slower | `app.employee_ytd_delta` is scanning `payroll_line` for a non-payroll document. Its `exists (select 1 from run)` guard is what short-circuits; check it survived. |
| **T5 Step 2**: the hazard-33 block fails | 8B's `8b-payroll.json` has not been applied by `payrollFixture`. That is a phase-gate failure, not a bug here. |
| **T6 / T8**: `column led.ledger_entry_id does not exist` | You are on an older draft of this plan. Plan 0A's join column is **`entry_id`** (plan0A:2041–2050) and both queries in this plan already say so. |
| **T12**: `ERR_MONEY_CURRENCY_MISMATCH` out of `reconciledBalance` | `PAYROLL_BATCH_SOURCE` selected `account.currency`, which is nullable ("null = any currency", plan0A:1495) and defaults to `XXX`. It reads **`le.currency`** — `char(3) NOT NULL`, plan0A:2014 — and there is no `?? "XXX"` anywhere. |
| **T6 / T12**: `Type 'Candidate' does not satisfy the constraint 'readonly any[]'` | A `postgres.js` tagged template is typed `sql<T extends readonly any[]>`; the generic is the ROW ARRAY. Write `tx<Candidate[]>`. |
| **T6**: `seedAccount` throws on a duplicate `1100` | 1A's helper is contractually idempotent on `(company_id, code)`. If yours is not, wrap the call and re-read the id; **never edit `seedAccount`** (hazard 9). Record it in this table. |
| **T8 clause 4**: `payment … moves 0.0000` | The remittance produced no **credit on `1100`**. Two causes, and the message does not distinguish them: (a) `postRemittance` named an account other than `1100` on its line — 4A's policy credits `line.account`, so the bank must be the line's account; (b) `moneyOutFixture` left the authority party's `payable_account_id` null or on `2100`, so the debit leg went to the wrong control account and the document balanced without touching the bank. Read the remittance's `ledger_entry` rows: the expected pair is **`credit 1100 = X`, `debit 2411 = X`**. Change **`postRemittance` and the fixture**, never 4A's policy (frozen) and never the 0091 guard; record what 4A actually shipped here. |
| **T9 Step 4**: the grep finds a **fourth** file pinning `projections.checked` | A slice between 4B and 8C registered a check. Update that file too and record it here. |
| **T9**: every employee of a company with openings reports `amount_differs`, for ever | The rebuild is adding `app.employee_ytd_opening` into its scratch table. It must not: the projection is Σ **posted deltas** on both sides and the opening is a read-time addend in `ytdFromEmployeeYtd` (amendment **B14**, ADR 0077 decision 4). The alternative — seeding the opening into `app.employee_ytd` — is forbidden by `posting-only-tables`, and T3's own source scan would fail on it. |
| **T12**: `ERR_VALIDATION_FAILED: every employee … is already paid` from `draftOf` or from the reconcilable suite | Two batches were drafted against one run. `createPayrollPayment` excludes an employee already on a non-void batch **including a draft** (T6 Step 6, by design). `draftOf` posts a fresh regular run per call from **February** onward, and the reconcilable suite pays employee A in one case and employee B in another; keep both arrangements. |
| **T9**: the rebuild reports a mismatch on `by_component` only | A formatting difference, not an arithmetic one. Both sides must go through `to_char(…, 'FM999999999999990.0000')`; check that `app.jsonb_add_money_agg`'s `initcond` is `'{}'` and that no path builds a jsonb numeric directly. |
| **T10**: the R4 case fails (`ERR_HR_SELF_PAY` not raised) | 8A's `employee_no_self_pay` is missing from `app.employee`. That is 8A's trigger and 0093 must not add a second; check `listApplied()` includes 80 and read 8A's Task 1. |
| **T10**: terminating raises `ERR_RBAC_LAST_ADMIN` | **Correct behaviour, not a bug.** The trigger runs under the terminating actor and Plan 0A's guard holds. The test must appoint a successor administrator first. |
| **T11**: clause 2's `Change` members do not exist | `readCatalogue`'s row shape is 6A's. Grep `packages/sync/src/messages.ts` and use the members 6A shipped. |
| **T11**: `ERR_HR_CASHIER_NOT_EMPLOYEE` fails the `error-codes` lint | The `ERRORS` row and 0094 must land in **one commit** — the lint scans migrations. And amendment **B13** must already be filed against §4.2.4 (T1 Step 1). |
| **T12**: the "edits no 4B file" case throws | No `origin/main` in this worktree. Make it `it.skipIf(!hasOrigin)`; keep the case in some form — it is a structural claim of B12. |
| Any task: `lint:rules` reports `posting-only-tables` in a **test** file | The rule's allow-list has drifted from §3.7.5, which names `packages/db/test/**`. Fix the allow-list, not the test. |
| **T2 onward**: `lint:rules` reports `dependency-rule` on `packages/db/test/**` importing `tests/…` | T1 Step 1's **second** commit was skipped. Amendment **B15** registers the allowance and that commit is what writes it — the line on `scripts/lint/rules/dependency-rule.ts` and the two `include` entries in `packages/db/tsconfig.json`. Add them there and re-run; do **not** move a helper into `fixtures.ts` to dodge it (hazard 9, and §4.17 assigns 8C no row) and do **not** add a `package.json` dependency from `packages/db` to `tests` (it closes a cycle in turbo's graph). |
| **T2 onward**: `tsc` cannot resolve `../../../../tests/support/source` from `packages/db/test/**` | The same commit's `packages/db/tsconfig.json` `include` entries are missing. The lint allowance and the `include` are two halves of one thing (1b:1696–1700); a repository with one and not the other fails one command and passes the other. |
| **T6 / T7**: a route test cannot resolve `tests/support/api` or `tests/invariants/support/payroll-money` | **The depth differs by directory and both forms are correct somewhere in this plan.** From `apps/api/test/routes/hr/**` the root is **five** levels up (`../../../../../tests/…`) — the same block's `"../../support/app"` is two levels to `apps/api/test`, which is how the count is checked on the page. From `packages/db/test/hr/**` and `apps/worker/test/handlers/**` it is **four**. Do not normalise the two to one number; 1B, 2A, 2C and 3A all carry both. |
| **T13 Step 3**: `Cannot find module '../../src/hr/schedule-layouts'` after writing the file | The module is `schedule-layouts/**index.ts**`, a directory with an index, not `schedule-layouts.ts` — Step 2's suite imports the directory. And keep `LAYOUTS` **empty**: a row added from anything but an authority's own published specification plus an accepted example is hazard 1 wearing a layout's clothes. |

### What this slice deliberately leaves to another

Payslip PDFs, annual statements, the five HR reports, the ⚠️ leave register, `hr.encryption_key.rotate` and the one-month parallel run are **8D's**. The `employee_ytd_opening` **load at cut-over** is **9B's** — this slice ships the table and `upsertEmployeeYtdOpening`, and 9B's importer is the loader spec:2084 names. The `employee`, `attendance_event`, `payroll_line`, `employee_ytd`, `statutory_schedule` and ⚠️ `leave_record` **`DatasetId` members and the eight `hr.*` report codes are 8D's rows** in frozen registers (§4.16.1, §4.16.2) and this slice adds none. **No screen** is built here and OD-24 is not gated: the three route modules are the API surface a later screen consumes, and hazard 29's rule binds the slice that draws one.

### The one thing to check before calling this slice done

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
bun run --cwd packages/db test privileges.test.ts -t "up → down → up"
bun run --cwd packages/db src/cli.ts lint
```

**Expected:** all green, `lintSchema` reports zero violations, the reversibility test rebuilds a byte-identical fingerprint, and the pinned DELETE list is still `["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]` — 8C grants no DELETE (§3.5.4). Then write the short phase report §0.2 asks for (spec:110) against **this slice's three DoD clauses**, naming what passes, what does not, what was decided under ADR 0077 and ADR 0078 (both **proposals**, both awaiting the owner), and the three owner gates still open — **OD-28** (schedule layouts), **OD-14** (staff purchases on salary deduction) and **OD-23**'s two 8C clauses (the employer registration numbers and the pay-date convention behind amendment B7).

