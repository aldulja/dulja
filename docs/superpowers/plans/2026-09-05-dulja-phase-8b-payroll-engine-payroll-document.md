# Dulja Phase 8B — Payroll engine, `PAYROLL` document, pinning, golden payroll, period lock

**For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` and implement this plan task by task, in order. Each task is self-contained: it names every file it creates or modifies, gives the exact signatures it consumes and produces, carries the real code, and ends with a commit. Do not skip the failing-test step — the expected failure text is written out so you can compare it against what you actually see. If what you see differs, stop and read that task's row in the **Execution handoff** section rather than adjusting the test until it passes.

## Goal

Make a month's payroll a **document**. This slice ships the pure statutory calculator (`packages/domain/payroll/`, in which **no rate, threshold, ceiling or formula of any authority appears**), the `PAYROLL` document type and its posting policy, the two 1:1 extension tables `app.payroll_run` and `app.payroll_line`, the `EMPLOYEE` dimension, and the run service that turns employees, compensation lines, statutory profiles and **verified, effective-dated, version-pinned rate tables** into `document_line` rows that `postDocument` posts through the one posting service. Every posted payroll line pins the rate-table version it used (SAH-013); an unverified or out-of-range table is refused (`ERR_PAYROLL_RATE_TABLE_UNVERIFIED`, acceptance test 29); a NULL statutory input fails the run **naming the employee** and never posts a silent zero (`ERR_PAYROLL_INPUT_MISSING`, acceptance test 33, SAH-011); a PAYROLL run and a hand-keyed JOURNAL with the same lines produce identical `ledger_entry` and `ledger_entry_dimension` rows (acceptance test 28); and a run whose period is closed or locked cannot post by any path until a principal holding `accounting.period.reopen` reopens it with a reason (acceptance test 38).

## Architecture

- **The calculator is pure and the rates are data.** `packages/domain/payroll/` uses **`decimal.js` directly for intermediate arithmetic** — a proration factor, a band walk — and `Money` for every figure that is persisted or returned, which is what ADR 0022 records D11's "`decimal.js` only" to mean ("it scopes the money module, not the whole package", contracts:2396). It touches no database, clock, network or random number, and holds **three** `SchemeCalculator`s — one per `RateTable["kind"]` the §4.12.3 schema admits (`banded_contribution`, `percentage_with_ceiling`, `progressive_schedule`). Every number a calculator uses comes out of the `RateTable` handed to it. That is what makes `tests/golden/payroll/` byte-comparable (spec:2264) and what makes SAH-020 unrepeatable. **`packages/domain/src/**` never imports `packages/domain/payroll/**`** (spec:2366) — the shapes core needs (`PayComponentRef`, `SchemeRef`, `PayrollLineRef`) are declared in core by 2A and this package's richer types satisfy them **structurally**; nothing is imported back.
- **The run is a document and the state machine is 2B's.** `app.payroll_run` is a 1:1 extension of `app.document` keyed on `document_id`; `app.payroll_line` is a 1:1 extension of `app.document_line` keyed on `document_line_id`. calculate → submit → approve → post runs on the **shared** transitions of §4.5.1 through `POST …/documents/{documentId}/transitions` — this slice mounts **no** type-specific transition route. R1 (maker ≠ checker) and R2 (authority at transition time) are 2B's triggers reading this slice's policy; no line of segregation logic is written here.
- **The ledger is `postDocument`'s and nobody else's.** The run service writes `document`, `document_line`, `payroll_run` and `payroll_line`, and stops. `postDocument` evaluates the PAYROLL policy, and 2A's evaluator resolves `line.component.expense_account`, `line.scheme.payable_account`, `line.scheme.expense_account`, the `line.component.kind` / `line.share` filters and the `line.employee` dimension **already** — this slice fills the three snapshot slots those resolvers read (`refs.components`, `refs.schemes`, `LineSnapshot.payroll`) and writes no evaluator branch.
- **Two dimensions per ledger line, and the BRANCH is the employee's, not the document's.** 2A's `dimensionsFor` gives `document.branch` the last word over anything in the line's own bag, so a PAYROLL rule that named `document.branch` would tag every employee's line with the *run's* branch. Every PAYROLL rule therefore declares `dimensions: { "from": ["line.dimensions", "line.employee"] }`: BRANCH arrives from the line's bag (the employee's `home_branch_id`) and EMPLOYEE from `line.employee`, and `dimensions.required: ["BRANCH", "EMPLOYEE"]` refuses any planned line missing either (spec:1066, spec:2101).
- **Correction after posting is a supplementary run, not a `reverseDocument`** (ADR 0076, a proposal). Two independent mechanics forbid the reversal path for this type and both are stated in Task 4.

## Tech Stack

TypeScript 5 on Bun; PostgreSQL 18 via `postgres.js` tagged templates (Drizzle mirrors for reads only); Hono + `@hono/zod-openapi`; Zod contracts; Vitest on Node 24 with Testcontainers; `decimal.js` behind `Money` / `Quantity`; `ajv` (already in `packages/domain` from 1A) for the rate-table schema; pg-boss for jobs — **this slice registers none**. No new dependency is added and no version is hard-coded in a source file (§3.3, spec:104).

## Spec

`C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` v1.2 — **§3.10.1 in full** (spec:2071–2094, especially *Statutory schemes as data* spec:2080, *Payroll run* spec:2081, *Proration* spec:2086 and *Manual statutory override* spec:2087), §3.10.2 (spec:2097), **§3.10.3 Posting (spec:2099–2101)**, §3.10.4 (spec:2105), §3.10.5 (spec:2109), §3.9 (spec:2037–2063), §0.2 (spec:97–106), §4.2.1 the `hr_payroll`, `accountant` and `auditor` rows (spec:2157–2163), **§4.2.2 R1, R2, R3** (spec:2172–2174) and R6/R7/R8 (spec:2177–2179), §4.7 the payroll statutory pack bullet (spec:2229), §4.11 golden-file tests (spec:2262–2267), §5.2 `packages/domain/payroll/` and `tests/golden/` (spec:2352–2389), Part V Phase 8 (spec:2294, 2301), Part VI tests **9** (spec:2427), **10** (spec:2428), **28** (spec:2446), **29** (spec:2447), **31** (spec:2449), **33** (spec:2451), **35** (spec:2453), **38** (spec:2456), §5.3 the Phase 8 owner rows (spec:2407, 2478), Part I **SAH-003** (spec:223), **SAH-009** (spec:286), **SAH-011** (spec:311), **SAH-013** (spec:333), **SAH-019** (spec:381), **SAH-020** (spec:388), **SAH-031** (spec:490), **SAH-032** (spec:503), **SAH-042** (spec:576).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 8B — Payroll engine, `PAYROLL` document, pinning, golden payroll, period lock. **Phase:** 8. **Phase gate:** this plan starts only when **8A** and **2A** are merged and Phase 4's definition of done is green in CI (spec:87, spec:2301 — Phase 8 depends on Phases 1, 2 and 4 and "may start as soon as Phase 4 is green and run alongside Phases 5–7").
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.forbid_change`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.assert_period_open`, `app.posting_seq`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `PermissionDef`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `encodeCursor`, `decodeCursor`, `Cursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `QuantitySchema`, `CurrencySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`, `Rational`, `rational`, `toBase`, `ExchangeRate`, `UNIT_RATE`, `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS`, `seedBranch`, `seedCurrency`, `JOBS`, `JobName`. **0C** — the seed CLI, **`chartOfAccountsLoader` (`packages/db/src/seed/chart-of-accounts.ts`, which applies every `.json` in the sub-pack in name order)**, `PackLoader`, `LoaderContext`, `SeedConfig`, `readPackFile`, `assertPackShape`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, and the `0c-base.json` chart rows `1000`, `1100`, `1200`, `1300`, `4000`, `5000`, `5900`, `5920`. **0E** — `packages/ui`, `packages/i18n`, `bootLocalStack`, `grantAdminRole`. **1A** — `postDocument`, `issueDocument`, `reverseDocument`, `voidDocument`, `loadSnapshot`, `resolvePolicy`, `PostResult`, `IssueResult`, `PostingError`, `PostingErrorCode`, `insertLedger`, `documentRoutes`, `JOURNAL_POLICY_V1`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `documentTypesLoader`, `loadDocumentTypes`, `app.posting_seq`, `document.posting_seq`, `fiscal_period.reopen_reason`. **1B** — `postJournal`, `JournalLine`, `PostJournalOptions`, `trialBalance`, `accountLedger`, `registerProjectionCheck`, `projectionChecks`, `ProjectionCheck`, `reportsRouteModule`, `ReportCodeSchema`. **2A** — `evaluatePolicy`, `balanceInBase`, `parsePolicy`, `validatePolicy`, `validateRequires`, `validateDocumentTypeSeed`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PlannedTaxLine`, `PostingPlan`, `PolicyEvaluationError`, `PayComponentRef`, `SchemeRef`, `PayrollLineRef`, `ItemRef`, `TaxCodeRef`, `requireDocumentPermission`, `DocumentStage`, `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`, `seedDocumentType`, `seedParty`, `DocumentLineInput`, `DocumentLineSchema`, `DocumentTypeModuleSchema`, `app.party`, `document_line.kind`. **2B** — `transitionDocument`, `TransitionResult`, `recordOverride`, `setEventContext`, `listDocumentEvents`, `DocumentEventRow`, `stageCode`, `grantCodes`, `app.principal_has`, `app.effective_policy`, `app.document_event`, `app.document_status_before`, `app.forbid_line_delete_unless_draft`, `ERR_DOC_NOT_DRAFT`, `app.series_gaps`. **2C** — `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, `requireDocumentModuleRead` (all four in `apps/api/src/middleware/require-attachment-read.ts` — the path 2C actually shipped; §4.5.8's prose names a different one and 4A's Task 0 already filed the correction), `pdfText`, `app.attachment`. **3B** — `ensureOpenPeriods(db: Db, s: Seed, year: number): Promise<void>` in `tests/invariants/support/post-inventory.ts` (3b:2245, 3b:2416; registered by **3B's** amendment A11 against §4.17.1, which §4.18's round-2 table does not yet carry — 3C imports it the same way at 3c:3868). It reopens Plan 0A's three fixed periods and inserts months 4–12 open, which is the only reason a payroll test may name a month other than January. **3C** — `draftTypedDocument(db, s, opts) → { documentId, lineIds }` and its `DraftLine` / `DraftTypedDocumentOptions` shapes (widened to the six-label `kind` union by 6A). **8A** — `app.employee` as extended by migration 0080, `app.employee_sensitive`, `app.employee_statutory_profile`, `app.pay_component`, `app.pay_component_scheme`, `app.compensation_line`, `app.statutory_scheme`, `app.statutory_rate_table`, `app.company_hr_setting`, `packages/domain/payroll/rate-table.schema.json` and the committed `RateTable` type generated from it, the `statutory` sub-pack loader, `ERR_HR_SELF_PAY`, `ERR_HR_SELF_VERIFY`, the `sensitive_gate` linter rule, and the fixtures `seedEmployee`, `seedPayComponent`, `seedStatutoryScheme`, `seedRateTable`.
- **Migration numbers:** 0087–0090, **all four used, four PRs** — `0087_create_payroll_run_line.sql` (T1), `0088_create_employee_dimension.sql` (T2), `0089_seed_permission_phase8b.sql` (T3), `0090_create_compensation_change_returns_run.sql` (T11). **§2.9's 8B row calls 0090 "spare" and names 0088 `…_trigger.sql`; amendments A1 and A2 below correct both.** **ADR numbers:** 0074–0076 — `0074-payroll-calculator-seam-and-rate-table-pinning`, `0075-employee-dimension-is-created-by-trigger`, `0076-payroll-correction-is-a-supplementary-run` (a **proposal**, spec:95 — it touches money semantics).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `RoundingMode`, `MONEY_SCALE`, `toBase`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, the fixed middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError` — **this slice adds two `ERRORS` rows**, both already allocated), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `PermissionDef`, `requirePermission`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.6 (`JOBS`, consulted only — **no job is registered**), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IsolationProbe`, `IdempotencyHeader`, `createApp`), §4.2.8 (the common schemas, the list envelope, the cursor codec, and **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`), §4.2.11 (`app.dimension_type` / `app.dimension_value` and the dimension API), §4.2.12 (`startApi`, `StartedApi`, `ApiRequest`), §4.2.13 (**`chartOfAccountsLoader` — 0C's, consumed and never replaced; `LoaderContext`, `SeedConfig`, `SUB_PACKS`. This slice ships no `PackLoader`: `LOADERS` is keyed by `SubPack` and `chart-of-accounts` is 0C's**), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `transitionDocument`, `setEventContext`), §4.3.2 (the fixed algorithm — steps 2, 4, 5, 6, 10, 12, 13), **§4.3.4 (`document_line`, and the 0087 row that rewrites `document_line_kind_check`)**, §4.3.5 (`posting_seq`), §4.3.6 (numbering at issue), §4.3.7 (the document-type seed envelope), §4.4.1 (`posting-policy.schema.json` — consumed **unchanged**, same `$id`, same `"version": 1`), **§4.4.2 in full** (`DocumentSnapshot`, `LineSnapshot`, `PayComponentRef`, `SchemeRef`, `PayrollLineRef`, and **sign normalisation A9, which names 8B**), §4.5.1 (legal transitions), §4.5.2 (`document_event`, `app.effective_policy`), §4.5.4 (`requireDocumentPermission`, `stageCode`, `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`), §4.5.6 (Form A′ on `employee`, consumed), §4.5.8 (`MODULE_READ_CODE` — **this slice adds the `hr` row**), §4.6.1 (the register rows for `pay_component`, `pay_component_scheme`, `compensation_line`, `statutory_scheme`, `statutory_rate_table`, `company_hr_setting`, `payroll_run`, `payroll_line`), §4.6.2 (the minimal `employee`), **§4.12 in full**, §4.14 (document-type codes), §4.15 (account codes), §4.16.1–§4.16.2 (consulted: **this slice ships no report and no `DatasetId` member** — the five HR reports are 8D's), §4.17 (`seedPayrollRun` — this slice's one row), §4.17.1, §4.18 (both rounds), §5 (all thirty-five hazards), §6.1 rows 9, 10, 28, 29, 31, 33, 35, 38, **§6.2 rows spec:1057 (owned), spec:1058 (owner 8C — 8B is a re-run: T4 seeds and wires the `2400`, `1400` and `2411`–`2414` accounts `PAYROLL_PAYMENT`, the remittances and `EMPLOYEE_ADVANCE` resolve) and spec:1066 (owner 2A — 8B is a re-run: T4's policy declares `dimensions.required: ["BRANCH", "EMPLOYEE"]` and T9/T10 put BRANCH on every payroll line, so 2A's "BRANCH mandatory" clause is exercised on a type whose BRANCH is per line rather than per document)**.
- **Interfaces produced:** §4.12.1 (`packages/domain/payroll/calculator.ts` verbatim — `EmployeePeriodInput`, `PayPeriod`, `RateTableRef`, `SchemeResult`, `EmployeeResult`, `PayrollCalculator`, `SchemeCalculator`, `calculators`), §4.12.2 (the `PAYROLL` policy and its §4.15 accounts), §4.12.6 (`app.payroll_run`, `app.payroll_line`), §4.12.7 (the `EMPLOYEE` dimension trigger `app.employee_dimension()`), §4.14's `PAYROLL` row, §4.15's rows `1400`, `2400`, `2411`–`2414`, `5300`, `5311`–`5314`, §4.5.8's `hr` map row, §3.6.2's four `hr.payroll.*` codes, §4.2.7's `payrollRunRouteModule` at `/v1/companies/:companyId/payroll-runs` with its one `PROBES` key, one new §4.2.8 contracts module (`packages/contracts/src/hr/payroll-run.ts`), §4.17's `seedPayrollRun`, and — in the **seed barrel only** (`@dulja/db/seed`, never the main barrel; §3.1, sah-039) — `linkPayrollAccountsForTenant`, the account-wiring entry point behind the `seed:payroll-accounts` script. **It is deliberately not a `PackLoader`:** `LOADERS` is keyed by `SubPack` and 0C owns `chart-of-accounts`, so 8B adds a *file* to that sub-pack and nothing else (§3.4.8).
- **Owner decisions:** **OD-23** (employer registration numbers; accountant-signed EPF/SOCSO/EIS/PCB tables and worked examples; staff list; pay-period conventions) → **Task 12**, isolated; default **`SYNTH` / `SYNTHETIC-TEST-v1`**, the clearly synthetic table of §4.12.4, and **no file under `packages/db/seed/my/statutory/` is created by this plan**. **OD-28** (the proration rule, spec:2086) → **Task 7**, isolated; default **`calendar_days`**, with `working_days` implemented and selectable and public holidays deliberately not subtracted. **OD-14** (HRD Corp or other levy, foreign workers, hourly/part-time staff, staff purchases on salary deduction — spec:2093) → **Task 8**, isolated; default **not built**, and the task states exactly what each answer adds. **OD-24** (screenshots and a two-minute operator description before any screen — spec:79, 108, 2408) → **Task 15**, isolated; default **the screen task is blocked, not the slice**, and Tasks 1–14 do not depend on it.
- **Part VI tests owned / re-run:** owns **28** (T13), **29** (T14), **33** (T13), **38** (T14). Re-runs **10** (PAYROLL approval authority — T14), **31** (the PAYROLL clause of segregation of duties — T14), **9** (period lock reaching the payroll *lines* — T14), and **35's recalculation clause** (recalculating a submitted run returns it to draft and voids the pending approval — T11). **§3.0.4 rows owned:** spec:1057 (Statutory schemes as verified rate tables; pinning and refusal). **Regression files created / appended:** creates **none**; **appends** to `tests/regression/sah-003.test.ts`, `sah-009.test.ts`, `sah-011.test.ts`, `sah-013.test.ts`, `sah-019.test.ts`, `sah-020.test.ts`, `sah-031.test.ts`, `sah-032.test.ts` and `sah-042.test.ts` — all nine are 0B's under §3.7.3's Plan 0A-proven and structural lists, so every 8B block is an append and no earlier block is edited.
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14)** — **two rows, and only one of them is ever packaged**: **`PAYROLL`**, `module: "hr"`, series `PAY`, seeded as `packages/db/seed/my/document-types/PAYROLL.json`; and **`PAYROLL_DDL_TEST`**, series `PDT`, `module: "hr"`, **test only** — configured through `seedDocumentType` inside a Testcontainers database by T1's `tables.test.ts` alone, never a file under `packages/db/seed/`, registered by **amendment A15** on the terms §4.14's own test-only paragraph sets (a test-only code is registered *because* hazard 32 makes an unregistered one a review-blocking finding — 3A did the same for its four). Consumed and never seeded here: `JOURNAL` (1A — test 28's hand-keyed side). Registered but **8C's, not seeded here**: `PAYROLL_PAYMENT`, `EMPLOYEE_ADVANCE`. **Account codes (§4.15)** — **eleven leaf rows, all this slice's own**, in `packages/db/seed/my/chart-of-accounts/8b-payroll.json`: `1400` Staff advances (asset), `2400` Salaries payable (liability), `2411`/`2412`/`2413`/`2414` Statutory payable per scheme in `statutory_scheme.code` order **EPF, SOCSO, EIS, PCB** (liability), `5300` Salaries expense (expense), `5311`/`5312`/`5313`/`5314` Employer contribution expense per scheme in the **same order and last digit** (expense). Consumed and asserted-not-re-seeded, with their seeding slice: `1100` Bank, `1000` Cash on hand, `5920` FX rounding (**0C**). **Report codes (§4.16.1) — none**, and **`DatasetId` members (§4.16.2) — none**: `payroll_line` is 8D's row in the frozen union and 7A creates `datasets.ts`. **`fixtures.ts` helpers (§4.17) — exactly one, the row §4.17 assigns 8B: `seedPayrollRun(db, s, opts: { periodStart; periodEnd; employeeIds; kind? }) → string`**, extended additively by amendment A6 with `payDate?`, `branchId?` and `effectiveDate?`. **Shared test helpers (§4.17.1) — one new file**, `tests/invariants/support/payroll.ts` (amendment A7), plus `tests/golden/payroll.test.ts`'s own file-local types.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Contract amendments this plan discovered

§4.18 carries Round 1 and Round 2 only; there is no round-3 table to have carried these, so they are stated here and Task 1 Step 1 files them as one amendment PR against the contracts document **before** any code in this slice is written.

| # | § | Name or decision | Source |
|---|---|---|---|
| **A1** | 2.9 (8B card), 3.4.1 | **Migration 0090 is not spare.** R3 (spec:2174) is a data-layer rule — "a compensation change effective in the period of a run in `submitted` or `approved` status returns that run to `draft`" — and a data-layer rule on 8A's `compensation_line` is a trigger, which is a migration. 0090 is `0090_create_compensation_change_returns_run.sql`. The range 0087–0090 is unchanged and nothing is borrowed | correction |
| **A2** | 2.9 (8B card) | The card's expected name `0088_create_employee_dimension_trigger.sql` understates the file, which also creates the `app.ensure_employee_dimension_type` and `app.ensure_employee_dimension_value` helpers; §3.4.2's rule ("a file whose name understates what it does is renamed") gives **`0088_create_employee_dimension.sql`**, the name §4.12.7's own heading uses | correction |
| **A3** | 4.12.2, 4.4.2, **4.4.1**, **4.3.4** | **Every `PAYROLL` policy rule declares `dimensions: { "from": ["line.dimensions", "line.employee"] }` and omits `document.branch`.** 2A's `dimensionsFor` (2a:1754–1768) gives `document.branch` the **last word** — `if (from.includes("document.branch")) out["BRANCH"] = snapshot.header.branchId;` after the loop — so a rule naming it would stamp every employee's line with the *run's* branch and spec:2101's "the employee's home branch" would be false for every employee outside it. 2A's own note (2a:1321) already states this mechanism as 8B's. `dimensions.required: ["BRANCH", "EMPLOYEE"]` is what makes the omission safe rather than silent. **The other half of the same decision, and it corrects §4.3.4:** that section's `document_line` DDL comment reads `dimensions jsonb … BRANCH is never here — it is document.branch_id`, and Task 10's `writeLines` deliberately writes `{"BRANCH": <the employee's home branch>}` into exactly that column. The comment now reads **"`{"<dimension_type.code>": "<dimension_value.id>"}`; BRANCH is never here **except on `PAYROLL` lines**, where the employee's home branch is per line and the policy omits `document.branch` — every other document type takes BRANCH from `document.branch_id`"**. The two halves are one mechanism: the line bag carries BRANCH *only* because no `PAYROLL` rule names `document.branch`, and 2A's header-wins rule (SAH-042, SAH-050) still governs every other type. spec:2101 is the authority for the per-employee branch. **A third section says the opposite and is corrected in the same PR:** §4.4.1's semantics paragraph reads "the evaluator adds `document.branch` as `BRANCH` to **every line** and `line.employee` as `EMPLOYEE` on payroll lines, then checks `required`", which is not what 2A shipped (`dimensionsFor` adds BRANCH from `document.branch` **only when a rule's `dimensions.from` names it**, 2a:1754–1768) and which, left standing, makes this policy read as wrong. It becomes **"the evaluator adds `document.branch` as `BRANCH` and `line.employee` as `EMPLOYEE` to a line exactly when that rule's `dimensions.from` names them — the default `from` is `["line.dimensions", "document.branch"]`, so BRANCH reaches every line of every type that does not override it, and a rule that omits `document.branch` (the `PAYROLL` rules, A3) takes BRANCH from the line's own bag — then checks `required`"** | correction |
| **A4** | 4.12.2, 4.14 | **`PAYROLL` declares `reversal: { "allowed": false, "producesType": null }`** and correction after posting is a `supplementary` run (ADR 0076, a proposal). Two independent mechanics forbid the reversal path and both are load-bearing — Task 4 Step 2 states them in full | settlement |
| **A5** | 4.12.6 | `app.payroll_line` carries **two** guards beyond §4.12.6's column list: a CHECK making the policy's three `when` filters mutually exclusive, and `payroll_line_change_draft_only` (BEFORE UPDATE OR DELETE, `ERR_DOC_NOT_DRAFT`) — the same shape as 2B's `forbid_line_delete_unless_draft`. That trigger **is** spec:2105's "period lock on the lines" and is what makes test 9's re-run non-vacuous | plan |
| **A6** | 4.17 | `seedPayrollRun` gains `payDate?`, `branchId?` and `effectiveDate?`, additively; §4.17's own rule ("a slice needing an option a listed one lacks adds the option additively and records it here in the same PR") is discharged by this row | plan |
| **A7** | 4.17.1 | **`tests/invariants/support/payroll.ts`** (8B) — `PAYROLL_PACK_ROOT`, `PayrollFixture`, `payrollFixture`, `SYNTH_TABLE`, `postPayrollRun`, `secondApprover`. Registered on §4.17.1's terms | plan |
| **A8** | 4.2.1 (package table), 3.1 | **`@dulja/domain`'s export subpath `"./payroll"` → `./payroll/index.ts` is verified, not re-added.** `packages/domain/payroll/` sits **outside** `src/`, which is what makes spec:2366's "core never imports HR" mechanically checkable by `dependency-rule`; without the subpath entry there is no import path for `packages/db` to reach the calculator. **8A's own amendment A11 files this exact row and 8A Task 9 makes the `package.json` edit** (`8a:233`, `8a:4851` — `"exports": { ".": "./src/index.ts", "./payroll": "./payroll/index.ts" }`). This slice therefore **asserts** it and adds it only if 8A merged without it; the row stays here because 8B is the first consumer that breaks if it is missing, and two plans filing one row is a duplicate the contracts editor collapses, not a conflict | verification of 8A's A11 |
| **A9** | 4.12.1 | `packages/domain/payroll/errors.ts` declares **`PayrollCalculationError`** with the two-code union `"ERR_PAYROLL_RATE_TABLE_UNVERIFIED" \| "ERR_PAYROLL_INPUT_MISSING"` — the `PolicyEvaluationError` precedent (§4.4.2), because `packages/domain` may not import `AppError` from `@dulja/contracts` (§3.1). `apps/api/src/problem.ts` gains **one** `asAppError` branch | plan |
| **A10** | 3.7.4 | For the **payroll** area only, `expected.json` is a **`PayrollGoldenExpectation`** — `{ lines: GoldenPayrollLine[]; ledger: GoldenLedgerRow[]; payslips: GoldenPayslip[] }` — declared in `tests/golden/payroll.test.ts`. §3.7.4's sentence ("`expected.json` is the `PostingPlan`") still holds for the ledger half; a `PostingPlan` cannot express *which rate-table version each line pinned*, and pinning is the whole of test 29. The 3B (A7) and 5A (A10) precedents are identical in shape | plan |
| **A11** | 4.3.1, 4.4.2 | **`loadSnapshot` fills `refs.components`, `refs.schemes` and `LineSnapshot.payroll` in this slice.** §4.3.1's stubbed list says the first two "stay `{}` until … 8A fill[s] their own"; 8A's card does not list `loadSnapshot` among its deliverables and 2A's resolvers are unreachable without all three. Task 9 Step 1 **asserts the current state** rather than assuming it: if 8A's merged plan already fills `components` and `schemes`, Task 9 reduces to `payroll` alone and says so | settlement |
| **A12** | 4.12.6, 4.12.2 | **`readPayrollRun` returns `compensationChangedBy: { principalId, displayName, employeeNumber, effectiveFrom }[]`** and `PayrollRunSchema` carries the field. spec:2174's last sentence — "the approval screen lists everyone who changed compensation in the period" — is a **read**, not a screen: `compensation_line.entered_by` is 8A's stamped column and the list is one overlap query. It ships in Task 10 with the rest of the run API, so the requirement is met whether or not OD-24 ever unblocks Task 15's rendering of it | plan |
| **A13** | 4.17.1 (the `postJournal` row) | **`JournalLine` gains `dimensions?: Record<string, string>`** — dimension-type **code** → `dimension_value.id`, the exact shape of `document_line.dimensions` (§4.3.4) — and `postJournal` writes it into that column on every line it drafts (`tests/invariants/support/post-journal.ts`, 1B). It is **additive**: the member is optional, the column already defaults to `'{}'::jsonb`, and every existing caller is unaffected. This is *reachable* rather than decorative because `JOURNAL_POLICY_V1`'s two rules declare **no** `dimensions` block (1a:2371–2374), so 2A's `dimensionsFor` falls back to its documented default `["line.dimensions", "document.branch"]` (2a:1754–1759) and the line's own bag is read. Without it, test 28's second comparison — the `ledger_entry_dimension` multiset, the half that proves BRANCH and EMPLOYEE reach the ledger — is vacuous on the hand-keyed side. Task 13 Step 5 makes the edit and the same PR records this row | plan |
| **A14** | 3.7.5 (`no-number-money`'s `ALLOWED`), 4.12.1 | **`"rateTableVersion"` joins `ALLOWED` in `scripts/lint/rules/no-number-money.ts`.** §4.12.1 freezes `SchemeResult.rateTableVersion: number`; the rule's `MONEYISH` regex contains `rate`, its `IN_SCOPE` contains `/(^|\/)packages\/domain\//`, and `packages/domain/payroll/types.ts` is neither a test file nor excluded (0d:1327–1332) — so the frozen name is a violation the moment Task 5 writes it. 0D shipped `ALLOWED` empty and documented it as the escape hatch for exactly this case ("an entry is added only when renaming is genuinely impossible, in the same PR that needs it, and every entry is a review conversation", 0d:1334–1337). Renaming is impossible here: the name is a frozen contract consumed by 8C and 8D. **This is the ONLY occurrence in scope** — `packages/db`, `tests/**` and `*.test.tsx` are outside `IN_SCOPE`/inside `EXCLUDED`, and `packages/contracts/src/hr/payroll-run.ts` spells it `z.number().int()`, a call and not a type annotation | settlement |
| **A15** | 4.14 | **`PAYROLL_DDL_TEST` (series `PDT`, module `hr`, **test only**) joins the document-type register.** T1's `tables.test.ts` needs a posted document whose lines carry `payroll_line` rows *before* T4 exists to seed the real `PAYROLL` type and *before* T3 seeds the `hr.payroll.*` codes its `approval` block would name, so it configures a JOURNAL-shaped policy over `account` lines through `seedDocumentType` inside a Testcontainers database. §4.14's own paragraph is explicit that such a code is registered **because** hazard 32 makes an unregistered one a review-blocking finding, and 3A registered four the same way (3a:24, 3a:84). Row: `approval: { required: false, approve: null, post: "accounting.journal.post" }`, direction `none`, `inventory.effect: "none"`, and **never a file under `packages/db/seed/my/document-types/`**. `POLICY_TEST` was the alternative and is rejected on one ground: it is 2A's `accounting` code, and this case's whole point is a `payroll`-kind `document_line` with an `hr` extension row hanging off it | correction |
| **A16** | 4.2.4 (the `error-codes` scan roots), 3.7.5 | **`error-codes` scans `packages/domain/payroll/**` as well.** §4.2.4 fixes the roots at `apps/**`, `packages/**/src/**` and `packages/db/migrations/**`. `packages/domain/payroll/` is deliberately **outside `src/`** — that is what makes spec:2366's "core never imports HR" mechanically checkable by `dependency-rule` (amendment A8) — and it is the only place `ERR_PAYROLL_RATE_TABLE_UNVERIFIED` and `ERR_PAYROLL_INPUT_MISSING` are raised. `apps/api/src/problem.ts` names `e.code`, never a literal. The one textual occurrence inside a current root is a **comment** in `packages/db/src/hr/run.ts`, and spec:2051's rule is that a code *no code raises* fails the build — a sentence is not a raise, and a check satisfied by a sentence dies the first time someone tidies it. T6 Step 7 makes the edit **unconditionally**, in the commit that adds the two `ERRORS` rows | correction |

## Global Constraints

1. **Never write to a ledger or movement table outside the posting service** (spec:97, hazard 22). Every figure this slice puts in the ledger is a `document` posted by `postDocument`. `packages/db/src/hr/**` writes `document`, `document_line`, `payroll_run` and `payroll_line` and nothing else; `posting-only-tables` (§3.7.5) fails the build if it ever names `app.ledger_entry`, `app.account_balance` or `app.employee_ytd`.
2. **`app.employee_ytd` is not written here.** The table is 8C's (migration 0092) and 8C owns the one-line extension of `postDocument` step 12 (§4.12.8). Between 8B and 8C every YTD figure is read from **posted `payroll_line` rows**, and `packages/db/src/hr/ytd.ts` is the one place that reads them.
3. **Never money as a float.** `numeric(19,4)` in Postgres, `Money` in TypeScript, `string` on the wire. `no-number-money` (§3.7.5) fires on any property, parameter or variable whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` typed `number`. `gross`, `net`, `employeeShare`, `employerShare`, `base` and every `rate` in a `RateTable` carry `Money` or `string`, never `number`. **One name in this slice matches the regex and is not money: `rateTableVersion`**, frozen as `number` by §4.12.1 and unrenameable because 8C and 8D consume it. It is added to the rule's own `ALLOWED` set in Task 5 — 0D's documented escape hatch, filed as amendment **A14** — and it is the only entry this slice adds. A *second* one would be a defect: the rule stays the control.
4. **Never SQL by string concatenation.** Every statement is a `tx`-tagged `postgres.js` template or a Drizzle read; `sql.unsafe` has exactly three homes and none of them is in this slice (§3.3, hazard 21).
5. **Never DDL from application code.** DDL lives only in `packages/db/migrations/NNNN_<verb>_<noun>.sql` with a hand-written `NNNN.down.sql` (§3.4.2, §3.4.5). **This includes the `EMPLOYEE` dimension:** `dimension_type` and `dimension_value` are *rows*, not DDL, so Task 2's trigger inserts rows and creates no object.
6. **Every new table** carries `tenant_id`, RLS via `app_meta.enable_tenant_rls`, FORCE RLS, `created_at`, the audit trigger via `app_meta.attach_audit` unless the table is in `AUDIT_EXEMPT`, `stamp_<col>` for every `*_by` column, composite `(tenant_id, x)` FKs, `unique (tenant_id, id)` (or the natural-key equivalent for a `NO_ID_TABLES` member), `snake_case` singular names, and a test that a second tenant cannot see it (§3.3, §3.5.1).
7. **`side` carries direction; a planned ledger amount is never negative** (§4.4.2 amendment A9, whose warning names **8B** by slice id). A payroll deduction's natural expression is negative and the answer to "which way does this move?" is `side`, never `amount.isNegative()`. Nothing in `packages/db/src/hr/**` or in any assertion of this slice reads the sign of a `PlannedLedgerLine.amount`. `payroll_line.amount` is a **non-negative magnitude** with a CHECK saying so.
8. **No real statutory rate, threshold, ceiling or formula appears anywhere** — not in a plan, a test, a fixture, a seed file or a comment (hazard 1; spec:2080 "This document states no rate, threshold, ceiling or formula"; spec:2229). Every figure in every test of this slice comes from the clearly synthetic `SYNTH` table of §4.12.4 or from an in-memory `RateTable` object built in the test file. **No file is created under `packages/db/seed/my/statutory/`** by this plan. A number that looks like an EPF, SOCSO, EIS or PCB rate in this slice is a defect.
9. **No invented LHDN or MyInvois detail** (hazard 2). PCB/MTD is a statutory *scheme* here, never the sales-tax engine (spec:2099), and no endpoint, form name, box name, schema version or deadline appears. Form names and schedule layouts are 8D's under OD-28.
10. **Per-tenant rows cannot be written by a migration** (hazard 10). `FORCE ROW LEVEL SECURITY` binds `app_migrator`, so 0087–0090 create objects and seed `app.permission` (global) only. Document types, policies, chart rows and rate tables are seed-pack data applied by `bun run seed --tenant <id> --only <sub-pack>`. **This is why migration 0088 cannot backfill the `EMPLOYEE` dimension** and why Task 2 ships `ensureEmployeeDimensionValue` beside the trigger.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly two `ERRORS` rows, both already allocated in §4.2.4: `ERR_PAYROLL_RATE_TABLE_UNVERIFIED` (422) and `ERR_PAYROLL_INPUT_MISSING` (422)**, each landing in the same commit as its raiser (Task 6). Everything else it raises is already shipped: `ERR_NOT_FOUND`, `ERR_VALIDATION_FAILED`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_DOC_NOT_DRAFT`, `ERR_DOC_NO_LINES`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_SOD_NO_SUBMISSION`, `ERR_SOD_MAKER_IS_CHECKER`, `ERR_PERIOD_NOT_OPEN`, `ERR_PERIOD_NOT_FOUND`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_INVALID`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_LEDGER_UNBALANCED`, `ERR_HR_SELF_PAY`, `ERR_HR_SELF_VERIFY`, `ERR_INTERNAL`. **This list is closed:** a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the four codes §3.6.2 assigns it — `hr.payroll.read`, `hr.payroll.prepare`, `hr.payroll.approve`, `hr.payroll.post` — and invents none. `hr.employee.read`, `hr.employee.manage`, `hr.attendance.record` are 6C's; the six `hr.*` codes of 8A are 8A's; `hr.payroll.pay` and `hr.advance.create` are 8C's. All are consumed, never re-seeded.
13. **No plan invents a literal in a shared namespace** (hazard 32). Every document-type code, account code, report code, `DatasetId` member, `fixtures.ts` helper name and `ERR_*` code this slice writes appears in the Assumptions block's namespace list; a literal not there is a review-blocking finding.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (hazard 33). The `PAYROLL` policy resolves its expense and payable accounts through `line.component.expense_account`, `line.scheme.payable_account` and `line.scheme.expense_account` — **not** by `account: { code }` — and its one `account: { code }` literal is `"2400"`. Task 4 seeds all eleven §4.15 rows and, in the same task, sets `pay_component.expense_account_id`, `statutory_scheme.payable_account_id` and `statutory_scheme.employer_expense_account_id` from them, so 8C's `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` resolve `2400` and `1400` without seeding anything of their own.
15. **Jobs run as the tenant's system principal** (hazard 20). This slice registers **no** job and adds **no** `JOBS` name — the registry stays closed at sixteen. `hr.rate_table.lapse_warning` is 8A's and `hr.employee_ytd.rebuild` is 8C's.
16. **Every route needs a probe entry in `tests/invariants/probes.ts`**, keyed by its `RouteModule.path` (hazard 31). This slice mounts **one** new module and therefore adds **one** `PROBES` entry. Submit, approve and post go through 2B's existing `…/documents/{documentId}/transitions` sub-path, which inherits `documents`' key.
17. **`lint-schema.ts` is a merge hotspot** (hazard 13). Task 1 edits the sets to exactly §3.5.3's declared state for this slice — `payroll_run` and `payroll_line` join **`NO_ID_TABLES`** and nothing else — and adds nothing else.
18. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [8B T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root are **green after every task, with no exception**. Two tasks would be red if their steps were split, and each says so where it matters: Task 3's Steps 1–2 (the catalogue rows and migration 0089) must land in one commit, and Task 3's Steps 4–5 (`MODULE_READ_CODE` and `POLICY_RESOLVED_CODES`) must land in the same task as Steps 1–2. Those are ordering constraints, not declared reds.
19. **This slice does not rewrite `AGENTS.md`'s "Current phase" section.** §3.8 names **8D** as Phase 8's closing slice.
20. **One migration per PR** (spec:2057). Four migrations, four PRs.

## This slice's share of the Phase 8 definition of done

Phase 8's DoD is one long sentence (spec:2294). This slice owns two of its clauses verbatim: *"the run posts through the posting service under pinned policy and rate-table versions"* and *"preparer ≠ approver is enforced by the data layer"*.

| Clause | Where it becomes true |
|---|---|
| **"the run posts through the posting service"** | **Task 13**, acceptance test 28, in `tests/invariants/payroll-one-posting-path.test.ts`: a posted `PAYROLL` and a hand-keyed `JOURNAL` carrying the same lines produce identical `ledger_entry` multisets on `(account_id, debit, credit, currency, exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id)` and identical `ledger_entry_dimension` multisets on `(dimension_type code, dimension_value_id)`, projecting out `id`, `document_id`, `line_no`, `posted_at`, `posted_by` and `posting_policy_id` — hazard 18's fixed projection set. |
| **"under pinned policy … versions"** | `document.posting_policy_id` is written by **`postDocument`** through §4.3.2 step 13 — **Task 10's run service never sets it**, and its posting path is `transitionDocument` → `postDocument` and nothing else. **Task 14 Step 1**, in `tests/invariants/payroll-pinning.test.ts`, is where the clause becomes true: it posts a run, records `document.posting_policy_id`, seeds a version 9 `posting_policy` for the `PAYROLL` type effective **inside the run's own month** — so `app.effective_policy` now resolves that month to the newer row — and asserts the posted run's `posting_policy_id`, and the `posting_policy_id` on every `ledger_entry` it wrote, are non-null and unchanged. |
| **"… and rate-table versions"** | **Task 6** returns `pinnedTables` from the pure calculator and **Task 10's `writeLines`** writes `payroll_line.rate_table_id` / `rate_table_version` and `payroll_run.pinned_tables`; **Task 14 Step 1**, acceptance test 29, inserts a later verified version and asserts run M's posted lines, its `pinned_tables` and its ledger rows are byte-identical, while a run in M+1 pins the new version. |
| **"preparer ≠ approver is enforced by the data layer"** | **Task 14 Step 1**, the re-runs of tests 10 and 31: `approval: { required: true, approve: "hr.payroll.approve", post: "hr.payroll.post" }` makes 2B's `app.document_status_before` refuse an approver who submitted (`ERR_SOD_MAKER_IS_CHECKER`) and refuse `→ posted` without `hr.payroll.post` (`ERR_RBAC_FORBIDDEN`) — **through the API (Task 10 Step 10), through a job's `systemContext` and through direct `app_rw` SQL**. R1 is asserted by **its own token and message, never as an alternation with `ERR_RBAC_FORBIDDEN`**: 2B's trigger evaluates R1 (its §2b) before R2 (§2c) and `transitionDocument` performs no permission check of its own, so an alternation would stay green if R1 were deleted and the case fell through to R2. Two shapes are covered — a human maker (the service, raw SQL, and Task 10 Step 10's wire case with a principal holding *both* `hr.payroll.prepare` and `hr.payroll.approve`, which is the only shape that clears §4.5.4's middleware and reaches the trigger) and a job that submitted its own run. Not one line of segregation logic is written in this slice; the policy's `approval` block is the whole mechanism. |

**What is deliberately *not* in this slice's DoD share:** the employee master, sensitive data, compensation, pay components, statutory schemes and rate tables (**8A**); `PAYROLL_PAYMENT`, statutory remittances, `EMPLOYEE_ADVANCE`, `employee_ytd` and its `postDocument` step-12 MERGE, the statutory schedules and the termination flow (**8C**); payslip PDFs, annual statements, the five HR reports, the leave register ⚠️, key rotation and the one-month parallel run (**8D**).

## File Structure

```
docs/adr/
  0074-payroll-calculator-seam-and-rate-table-pinning.md   NEW  T5
  0075-employee-dimension-is-created-by-trigger.md         NEW  T2
  0076-payroll-correction-is-a-supplementary-run.md        NEW  T4  (a PROPOSAL — spec:95)

packages/domain/
  package.json                                  EDIT T5  — "./payroll" ASSERTED (8A's A11 adds it); the
                                                          rate-table:types script only if 8A omitted it
  payroll/
    rate-table.schema.json                      —    8A T9 — consumed, never edited (§4.12.3)
    rate-table.ts                               —    8A T9 — the generated RateTable, consumed
    validate.ts                                 —    8A T9 — validateRateTable / parseRateTable, untouched
    index.ts                                    EDIT T5  — the barrel 8A T9 CREATED; 8B APPENDS to it
    errors.ts                                   NEW  T5  — PayrollCalculationError (amendment A9)
    types.ts                                    NEW  T5  — RateTable re-export + the §4.12.1 interfaces
    schemes/banded-contribution.ts              NEW  T5
    schemes/percentage-with-ceiling.ts          NEW  T5
    schemes/progressive-schedule.ts             NEW  T5
    schemes/index.ts                            NEW  T5  — `calculators`
    calculator.ts                               NEW  T6  — PayrollCalculator, the refusals, proration
                                                EDIT T7  — working_days (OD-28)
                                                EDIT T8  — hourly components (OD-14) ⚠️
  test/payroll/
    schemes.test.ts                             NEW  T5
    calculator.test.ts                          NEW  T6
    proration.test.ts                           NEW  T7
    hourly.test.ts                              NEW  T8  ⚠️ OD-14 only

packages/db/
  package.json                                  EDIT T4  — one script, seed:payroll-accounts
  migrations/
    0087_create_payroll_run_line.sql            NEW  T1
    0087.down.sql                               NEW  T1
    0088_create_employee_dimension.sql          NEW  T2  (amendment A2)
    0088.down.sql                               NEW  T2
    0089_seed_permission_phase8b.sql            NEW  T3
    0089.down.sql                               NEW  T3
    0090_create_compensation_change_returns_run.sql  NEW T11 (amendment A1)
    0090.down.sql                               NEW  T11
  src/
    schema/payroll-run.ts                       NEW  T1  — Drizzle mirror (reads only)
    schema/payroll-line.ts                      NEW  T1
    lint-schema.ts                              EDIT T1  — payroll_run, payroll_line join NO_ID_TABLES
    hr/employee-dimension.ts                    NEW  T2  — ensureEmployeeDimensionValue
    hr/accounts.ts                              NEW  T4  — linkPayrollAccounts
    hr/inputs.ts                                NEW  T10 — loadPayrollInputs
    hr/run.ts                                   NEW  T10 — calculatePayrollRun, recalculatePayrollRun
    hr/override.ts                              NEW  T11 — setStatutoryOverride, listOverrides
    hr/ytd.ts                                   NEW  T10 — ytdFromPostedLines
    posting/load.ts                             EDIT T9  — refs.components, refs.schemes, LineSnapshot.payroll
    seed/payroll-accounts.ts                    NEW  T4  — linkPayrollAccountsForTenant + main; NOT a PackLoader
    seed/index.ts                               EDIT T4  — re-exports it from the SEED barrel (§3.1, sah-039)
    seed/chart-of-accounts.ts                   —    0C — consumed unchanged; it applies 8b-payroll.json
    index.ts                                    EDIT T1, T2, T4, T10, T11 — re-exports
  seed/my/
    chart-of-accounts/8b-payroll.json           NEW  T4  — the eleven §4.15 rows
    document-types/PAYROLL.json                 NEW  T4  — the envelope of §4.3.7
  seed/test/statutory/SYNTH/v1.json             NEW  T12 — §4.12.4, the ONE synthetic table
  test/
    fixtures.ts                                 EDIT T1  — seedPayrollRun (§4.17's one 8B row)
    payroll/tables.test.ts                      NEW  T1  — DDL, RLS, isolation, immutability-while-posted
    payroll/employee-dimension.test.ts          NEW  T2
    payroll/accounts.test.ts                    NEW  T4
    payroll/snapshot.test.ts                    NEW  T9
    payroll/run.test.ts                         NEW  T10
    payroll/recalculation.test.ts               NEW  T11
    permission-catalogue.test.ts                (unchanged — T3 re-runs it)
    schema-lint.test.ts                         (unchanged — its "zero violations" case is the gate)
    privileges.test.ts                          (unchanged — T1 re-runs it; 8B grants no DELETE, §3.5.4)

packages/contracts/
  permissions.ts                                EDIT T3  — the four hr.payroll.* rows
  src/errors.ts                                 EDIT T6  — the two allocated ERRORS rows
  src/hr/payroll-run.ts                         NEW  T10 — the Zod module (§4.2.8)
  openapi.json                                  EDIT T10 — regenerated

packages/db/seed/roles.ts                       EDIT T3  — hr_payroll, accountant, auditor grants

apps/api/src/
  problem.ts                                    EDIT T6  — the ONE asAppError branch (amendment A9)
  middleware/require-attachment-read.ts         EDIT T3  — MODULE_READ_CODE gains the hr row (§4.5.8)
  middleware/require-document-permission.ts     EDIT T3  — POLICY_RESOLVED_CODES gains three codes
  routes/hr/payroll-runs.ts                     NEW  T10 — payrollRunRoutes, payrollRunRouteModule
  routes/index.ts                               EDIT T10 — buildRoutes mounts it
apps/api/test/routes/hr/payroll-runs.test.ts    NEW  T10
apps/api/test/middleware/require-attachment-read.test.ts
                                                EDIT T3  — 2C's two map cases become three (the hr row)
apps/backoffice/src/screens/PayrollApproval.tsx NEW  T15 ⚠️ OD-24 only
apps/backoffice/src/screens/PayrollApproval.test.tsx NEW T15 ⚠️ OD-24 only

scripts/lint/rules/
  no-number-money.ts                            EDIT T5  — "rateTableVersion" joins ALLOWED (amendment A14)
  error-codes.ts                                EDIT T6  — the scan roots gain packages/domain/payroll/**
                                                           (amendment A16; unconditional, see T6 Step 7)

tests/
  invariants/support/post-journal.ts            EDIT T13 — JournalLine.dimensions (amendment A13, 1B's file)
  invariants/probes.ts                          EDIT T10 — one PROBES entry
  invariants/support/payroll.ts                 NEW  T10 (amendment A7)
  invariants/payroll-one-posting-path.test.ts   NEW  T13 — acceptance test 28
  invariants/payroll-pinning.test.ts            NEW  T14 — acceptance tests 29 and 38, re-runs 9, 10, 31
  golden/payroll.test.ts                        NEW  T13 — the byte-compare harness (amendment A10)
  golden/payroll/synth-regular/{input,expected}.json      NEW T13
  golden/payroll/synth-proration/{input,expected}.json    NEW T13
  golden/payroll/synth-missing-input/{input,expected}.json NEW T13
  regression/sah-003.test.ts                    EDIT T13 — append the 8B block
  regression/sah-009.test.ts                    EDIT T13
  regression/sah-011.test.ts                    EDIT T6
  regression/sah-013.test.ts                    EDIT T14
  regression/sah-019.test.ts                    EDIT T5
  regression/sah-020.test.ts                    EDIT T6
  regression/sah-031.test.ts                    EDIT T14
  regression/sah-032.test.ts                    EDIT T14
  regression/sah-042.test.ts                    EDIT T14
```

**PR boundaries.** PR 1 = T1 (migration 0087). PR 2 = T2 (0088). PR 3 = T3 (0089) + T4. PR 4 = T5–T9. PR 5 = T10. PR 6 = T11 (0090). PR 7 = T12–T14. PR 8 = T15 ⚠️.

---

### Task 1: Migration 0087 — `app.payroll_run`, `app.payroll_line`, and the six-label `document_line_kind_check`

**Files:**
- Create: `packages/db/migrations/0087_create_payroll_run_line.sql`, `packages/db/migrations/0087.down.sql`
- Create: `packages/db/src/schema/payroll-run.ts`, `packages/db/src/schema/payroll-line.ts`
- Create: `packages/db/test/payroll/tables.test.ts`
- Modify: `packages/db/src/lint-schema.ts`, `packages/db/test/fixtures.ts`, `packages/db/src/index.ts`
- Test: `packages/db/test/payroll/tables.test.ts`, `packages/db/test/schema-lint.test.ts` (re-run), `packages/db/test/privileges.test.ts` (re-run)

**Interfaces:**
- Consumes: `startDb(opts?): Promise<Db>`, `Db`, `withTenant(sql, tenantId, actorId, fn)` (the 4-argument **test** helper), `uuidv7(sql): Promise<string>`, `seedTenantV2(db, name): Promise<Seed>`, `Seed`, `seedAccount(db, s, { code, nameEn, type })`, `lintSchema(sql): Promise<Violation[]>`, `NO_ID_TABLES` / `AUDIT_EXEMPT` / `IMMUTABLE` (§3.5.3), `up`/`down`/`listApplied`/`MIGRATIONS_DIR` (§4.1), `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.forbid_change`, `seedEmployee(db, s, opts?): Promise<string>` (8A), `app.employee` (§4.6.2 + 8A's 0080), `app.pay_component` / `app.statutory_scheme` / `app.statutory_rate_table` (8A, §4.6.1), `draftTypedDocument` and `DraftLine` (3C, widened by 6A).
- Produces: `app.payroll_run` and `app.payroll_line` exactly as §4.12.6 plus amendment A5's two guards; the six-label `document_line_kind_check`; `app.forbid_payroll_line_change_unless_draft()`; the Drizzle mirrors `payrollRun` and `payrollLine`; and `seedPayrollRun(db, s, opts: { periodStart: string; periodEnd: string; employeeIds: readonly string[]; kind?: "regular" | "supplementary" | "final"; payDate?: string; branchId?: string; effectiveDate?: string }): Promise<string>` returning the **document id** (§4.17, amendment A6).

- [ ] **Step 1: File the sixteen contract amendments and assert the phase gate**

This step writes no code. Open `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` and add a **Round 3** table under §4.18 carrying rows A1–A16 exactly as the "Contract amendments this plan discovered" table above states them, then apply each row to its own section (§2.9's 8B row for A1 and A2, §4.12.2 **plus §4.4.1's semantics paragraph plus §4.3.4's `document_line.dimensions` comment** for A3, §4.12.2 for A4, §4.12.6 for A5 and A12, §4.17 for A6, §4.17.1 for A7 and A13, §3.1's package table for A8, §4.12.1 for A9, §3.7.4 for A10, §4.3.1's stubbed-field list for A11, §3.7.5's `no-number-money` row for A14, **§4.14's register table and its test-only paragraph for A15**, **§4.2.4's `error-codes` scan-root sentence and §3.7.5's `error-codes` entry for A16**). Commit that as its own PR before anything else — a plan whose names disagree with the register is the one failure hazard 32 exists to prevent.

**A15 is the one to file before Step 2 specifically**, because Step 2's test configures `PAYROLL_DDL_TEST` and a document-type code that is not in §4.14 is exactly the review-blocking finding hazard 32 describes.

Then assert the gate. Run:

```bash
bun run --cwd packages/db src/cli.ts status
```

**Expected:** the applied list contains **80, 81, 82, 83, 84, 85 and 86** (8A's range) and **17, 18, 19, 20** (2A's). If any of 80–86 is missing, 8A has not merged and this plan does not start; stop and say so. The list may or may not contain 59–73 (Phase 6) — Phase 8 may execute before or after Phase 6 (spec:2301) and **no step in this plan asserts `max(version)`** (hazard 14).

- [ ] **Step 2: Write the failing test `packages/db/test/payroll/tables.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { postDocument } from "../../src/posting";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedEmployee,
  seedTenantV2, type Seed,
} from "../fixtures";

/** A JOURNAL-shaped policy over `account` lines. Task 4 seeds the real PAYROLL policy; this file only needs a
 *  posted document whose lines carry payroll_line rows, so it uses the simplest policy that posts.
 *
 *  `PAYROLL_DDL_TEST` / `PDT` is a REGISTERED test-only document-type code — §4.14, added by this plan's
 *  amendment A15 in Task 1 Step 1's contracts PR, on the same terms as 3A's four (3a:84). It is configured
 *  here through `seedDocumentType` and is never a file under `packages/db/seed/`. It cannot be the real
 *  `PAYROLL` type: that type's `approval` block names the three `hr.payroll.*` codes, which Task 3 seeds,
 *  and `validatePolicy` refuses a policy naming a code absent from the catalogue (ERR_POLICY_INVALID, F-21). */
const ACCOUNT_POLICY = {
  version: 1, documentType: "PAYROLL_DDL_TEST", direction: "none", requires: [],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
    { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
  ],
  inventory: { effect: "none" }, tax: { applies: false },
  numbering: { series: "PDT", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" }, dimensions: { required: [] },
};

let db: Db; let a: Seed; let b: Seed;
let typeId: string; let cashId: string; let salesId: string; let employeeId: string;
const ctxOf = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-0000-0000-000000000000" });

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "Alpha");
  b = await seedTenantV2(db, "Beta");
  cashId = await seedAccount(db, a, { code: "1000", nameEn: "Cash on hand", type: "asset" });
  salesId = await seedAccount(db, a, { code: "4000", nameEn: "Sales", type: "income" });
  typeId = await seedDocumentType(db, a, { code: "PAYROLL_DDL_TEST", module: "hr", policy: ACCOUNT_POLICY });
  employeeId = await seedEmployee(db, a, { employeeNumber: "E-0001" });
  await grantCodes(db, a, { codes: ["accounting.journal.post"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("migration 0087 — payroll_run and payroll_line (§4.12.6, amendment A5)", () => {
  it("document_line.kind admits all six labels — the SAME union 6A's 0061 writes (§4.3.4)", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'document_line_kind_check'`;
    for (const label of ["account", "item", "tax", "text", "tender", "payroll"]) {
      expect(c!.def).toContain(`'${label}'`);
    }
  });

  it("payroll_run is keyed on document_id and carries no id column (NO_ID_TABLES, §3.5.3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'payroll_run' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "calculated_at", "calculated_by", "company_id", "created_at", "document_id",
      "kind", "pay_date", "period_end", "period_start", "pinned_tables", "tenant_id",
    ]);
  });

  it("payroll_line's three shapes are mutually exclusive — the policy's `when` filters cannot both match", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId, series: "PDT", effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "100.0000" }],
    });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, scheme_id, share, amount)
      values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${null}, ${null}, ${"employee"}, ${"100.0000"})`))
      .rejects.toThrow(/payroll_line_shape_check/);
  });

  it("payroll_line.amount is a non-negative MAGNITUDE — side carries direction (§4.4.2 A9)", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId, series: "PDT", effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "100.0000" }],
    });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
      values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${"-1.0000"})`))
      .rejects.toThrow(/payroll_line_amount_check/);
  });

  it("a POSTED run's payroll_line cannot be updated, and its parent line cannot be deleted — ERR_DOC_NOT_DRAFT (spec:2105, SAH-031/041)", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId, series: "PDT", effectiveDate: "2026-01-15",
      lines: [
        { kind: "account", lineNo: 1, accountId: cashId,  debit: "100.0000" },
        { kind: "account", lineNo: 2, accountId: salesId, credit: "100.0000" },
      ],
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
        values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${"100.0000"})`;
      await postDocument(tx, ctxOf(a), { documentId: d.documentId });
    });
    // UPDATE is app_rw's through default privileges, so this reaches 8B's own draft-only trigger.
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.payroll_line set amount = '5.0000' where document_line_id = ${d.lineIds[0]!}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    // DELETE is NOT app_rw's on app.payroll_line — §3.5.4's list is closed at document, document_line,
    // idempotency_key, role_permission and role_assignment_branch, and 8B grants nothing. The only way a
    // payroll_line is ever removed is the CASCADE from its parent, so the parent is what the test deletes:
    // 2B's document_line_delete_draft_only refuses it on a posted document with the same token.
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      delete from app.document_line where id = ${d.lineIds[0]!}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("a DRAFT run's payroll_line is removed by the CASCADE from its parent (spec:2081 — 'only while draft or submitted')", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId, series: "PDT", effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "100.0000" }],
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
        values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${"100.0000"})`;
      await tx`update app.payroll_line set amount = '120.0000' where document_line_id = ${d.lineIds[0]!}`;
      // The recalculation path: the run service replaces `document_line` rows and the composite FK's
      // ON DELETE CASCADE takes the payroll_line with it. During that cascade the parent row is already
      // gone, which is exactly the state `app.forbid_payroll_line_change_unless_draft()` admits (its
      // predicate is `s is not null and s <> 'draft'`, 2B's shape at 2b:1879).
      await tx`delete from app.document_line where id = ${d.lineIds[0]!}`;
    });
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line where document_line_id = ${d.lineIds[0]!}`;
    expect(n!.n).toBe(0);
  });

  it("tenant B sees neither table's rows (test 12, spec:106)", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId, series: "PDT", effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "7.0000" }],
    });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
      values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${"7.0000"})`);
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.payroll_line`);
    expect(seen[0]!.n).toBe(0);
    const runs = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.payroll_run`);
    expect(runs[0]!.n).toBe(0);
  });

  it("the schema linter reports zero violations after 0087 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a run's pinned_tables survives a round trip as jsonb (SAH-013 — what was originally applied)", async () => {
    const docId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                  effective_date, currency, exchange_rate, branch_id)
        values (${docId}, ${a.tenant}, ${a.company}, ${typeId}, 'PDT', ${a.period},
                '2026-01-31', 'MYR', '1.00000000', ${a.hq})`;
      await tx`
        insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date, pinned_tables)
        values (${docId}, ${a.tenant}, ${a.company}, 'regular', '2026-01-01', '2026-01-31', '2026-02-05',
                ${JSON.stringify([{ schemeId: "s1", version: 3 }])}::jsonb)`;
    });
    const [row] = await db.admin<{ pinned_tables: { schemeId: string; version: number }[]; calculated_by: string | null }[]>`
      select pinned_tables, calculated_by::text as calculated_by from app.payroll_run where document_id = ${docId}`;
    expect(row!.pinned_tables).toEqual([{ schemeId: "s1", version: 3 }]);
    expect(row!.calculated_by).toBe(a.human);   // stamped by app.stamp_actor, never from a payload (SAH-044)
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- payroll/tables`
**Expected:** every case fails, the first with

```
error: relation "app.payroll_line" does not exist
```

and the `document_line_kind_check` case failing on `expect(c!.def).toContain("'payroll'")` unless 6A's 0061 has already merged — in which case that one case passes early, which is exactly the idempotence §4.3.4 requires and is not a problem.

- [ ] **Step 4: Write `packages/db/migrations/0087_create_payroll_run_line.sql`**

```sql
-- 0087_create_payroll_run_line.sql
-- §3.10.1 "Payroll run" (spec:2081): a run is a Document of type PAYROLL using the document state machine, not
-- its own. These two tables are 1:1 EXTENSIONS — the header lives in app.document and the amounts live in
-- app.document_line; nothing here duplicates a column those tables already own.
-- Contracts §4.12.6 (columns), §3.5.3 (both tables join NO_ID_TABLES), amendment A5 (the two guards).

-- ── 1. document_line.kind — the FULL union, both phases' labels (§4.3.4) ──────────────────────────────
-- 6A's 0061 writes the identical list. Phase 8 may execute before or after Phase 6 (spec:2301), so a file
-- listing only "the labels admitted so far" would drop the other phase's label when it ran second. Both
-- files are therefore idempotent in either order, and the constraint is dropped BY NAME because 2A named it
-- explicitly for exactly this reason.
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text','tender','payroll'));

-- ── 2. app.payroll_run — the 1:1 header extension ────────────────────────────────────────────────────
create table app.payroll_run (
  -- The PK and NOTHING else. A plain `references app.document(id)` would be a `composite_fk` violation
  -- (plan0A:2613, pinned by schema-lint.test.ts at plan0A:2648-2657): an FK check bypasses RLS, so a
  -- single-column reference to a tenant-scoped parent lets tenant A's row point at tenant B's document.
  -- The tenant-safe reference and the cascade are the composite FK further down.
  document_id     uuid primary key,
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  kind            text not null check (kind in ('regular','supplementary','final')),   -- spec:2081
  period_start    date not null,
  period_end      date not null,
  pay_date        date not null,
  -- SAH-013: what was ORIGINALLY applied. [{ "schemeId": uuid, "version": int }], written by the run service
  -- from the pure calculator's `pinnedTables` and never re-read from statutory_rate_table afterwards.
  pinned_tables   jsonb not null default '[]'::jsonb,
  calculated_at   timestamptz not null default now(),
  calculated_by   uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at      timestamptz not null default now(),
  check (period_end >= period_start),
  check (pay_date >= period_start),
  check (jsonb_typeof(pinned_tables) = 'array'),
  unique (tenant_id, document_id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id) on delete cascade
);
comment on table app.payroll_run is
  'spec:2081 — a payroll run is a PAYROLL document; this row carries the pay period, the run kind and the pinned rate-table versions (SAH-013).';
call app_meta.enable_tenant_rls('app.payroll_run');
call app_meta.attach_audit('app.payroll_run');
call app_meta.attach_stamp('app.payroll_run', 'calculated_by');

create index payroll_run_period_idx on app.payroll_run (company_id, period_start, period_end);

-- ── 3. app.payroll_line — the 1:1 line extension ─────────────────────────────────────────────────────
create table app.payroll_line (
  -- The PK and nothing else, for the `composite_fk` reason stated on payroll_run above (plan0A:2613).
  document_line_id  uuid primary key,
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  employee_id       uuid not null,
  component_id      uuid,                        -- a pay_component line (earning or deduction)
  scheme_id         uuid,                        -- a statutory line
  share             text check (share in ('employee','employer')),
  quantity          numeric(19,6),               -- days for a quantity-based component (unpaid leave)
  -- A MAGNITUDE. §4.4.2 amendment A9 makes `side` the sole carrier of direction for a planned ledger line,
  -- and the policy's rules choose the side; a negative amount here would post a deduction as an earning.
  amount            numeric(19,4) not null,
  rate_table_id     uuid,                        -- SAH-013: the version this line pinned
  rate_table_version int,
  override_reason   text,                        -- spec:2087 — a manual statutory override, never silent
  entered_by        uuid references app.principal(id),   -- stamped; null unless override_reason is set
  created_at        timestamptz not null default now(),
  constraint payroll_line_amount_check check (amount >= 0),
  -- The three shapes the PAYROLL policy's `when` filters select, made mutually exclusive so no line can match
  -- two rules (amendment A5). Component line: component_id only. Statutory line: scheme_id + share. Net-pay
  -- or advance line: neither, and the policy reaches it through `when: { "line.kind": "account" }`.
  constraint payroll_line_shape_check check (
       (component_id is not null and scheme_id is null and share is null)
    or (component_id is null and scheme_id is not null and share is not null)
    or (component_id is null and scheme_id is null and share is null)),
  -- spec:2087 — an override carries a reason AND the principal who entered it, or neither.
  constraint payroll_line_override_check check (
    (override_reason is null and entered_by is null) or (override_reason is not null and entered_by is not null)),
  unique (tenant_id, document_line_id),
  foreign key (tenant_id, company_id)        references app.company(tenant_id, id),
  foreign key (tenant_id, document_line_id)  references app.document_line(tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id)       references app.employee(tenant_id, id),
  foreign key (tenant_id, component_id)      references app.pay_component(tenant_id, id),
  foreign key (tenant_id, scheme_id)         references app.statutory_scheme(tenant_id, id),
  foreign key (tenant_id, rate_table_id)     references app.statutory_rate_table(tenant_id, id)
);
comment on table app.payroll_line is
  'spec:2081 — one row per employee per component or scheme share, pinning the rate-table version it used (SAH-013).';
call app_meta.enable_tenant_rls('app.payroll_line');
call app_meta.attach_audit('app.payroll_line');
call app_meta.attach_stamp('app.payroll_line', 'entered_by');

create index payroll_line_employee_idx on app.payroll_line (company_id, employee_id);
create index payroll_line_scheme_idx   on app.payroll_line (company_id, scheme_id);

-- ── 4. Period lock reaches the LINES (spec:2105, SAH-031) ────────────────────────────────────────────
-- SAH-031 is verbatim "Period locks … do not reach the line items". `assert_period_open` guards ledger_entry
-- and `document_line_delete_draft_only` (2B) guards document_line, but app.payroll_line is a table those two
-- have never heard of — and it carries every figure a payslip and a statutory schedule are generated from.
-- The guard is the same shape as 2B's app.forbid_line_delete_unless_draft and raises the same token.
-- The predicate is 2B's, verbatim in shape (2b:1879): `s is not null and s <> 'draft'`, NOT
-- `s is distinct from 'draft'`. During the ON DELETE CASCADE from document_line the parent row is
-- ALREADY GONE — the RI cascade runs as an AFTER trigger on the parent and issues its child DELETE with
-- the parent's removal visible — so the SELECT below finds nothing and `s` is NULL. `is distinct from`
-- would treat that NULL as "not draft" and refuse every legitimate recalculation of a draft run
-- (recalculatePayrollRun's `delete from app.document_line where document_id = …`, and through it
-- setStatutoryOverride and the whole R3 return-to-draft path). The guard refuses only when a NON-DRAFT
-- parent is still visible, which is the direct `update`/`delete` case it exists for.
create function app.forbid_payroll_line_change_unless_draft() returns trigger language plpgsql as $$
declare
  s app.document_status;
begin
  select d.status into s
    from app.document d join app.document_line l on l.document_id = d.id
   where l.id = coalesce(new.document_line_id, old.document_line_id);
  if s is not null and s <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: payroll line % belongs to a document that is %; a posted run is corrected by a supplementary run, never edited in place (spec:2081, SAH-041)',
      coalesce(new.document_line_id, old.document_line_id), s
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

create trigger payroll_line_change_draft_only
  before update or delete on app.payroll_line
  for each row execute function app.forbid_payroll_line_change_unless_draft();

-- ── 5. Privileges ────────────────────────────────────────────────────────────────────────────────────
-- app_rw receives select, insert, update through default privileges (plan0A:2564) — §3.5.1 item 6 says NO
-- GRANT STATEMENT, and this file issues none. DELETE is granted only per §3.5.4, whose list is closed and
-- which 2B is the only slice to extend — so payroll_line rows are removed ONLY by the CASCADE from
-- document_line when a draft's lines are replaced, which the draft-only trigger above admits because the
-- parent row is already gone by the time it runs.
```

```sql
-- 0087.down.sql
drop trigger if exists payroll_line_change_draft_only on app.payroll_line;
drop function if exists app.forbid_payroll_line_change_unless_draft() cascade;
drop index if exists app.payroll_line_scheme_idx;
drop index if exists app.payroll_line_employee_idx;
drop table if exists app.payroll_line;
drop index if exists app.payroll_run_period_idx;
drop table if exists app.payroll_run;
-- The kind CHECK returns to 2A's four labels only when no row uses a dropped one; `down` runs only in CI on
-- empty tenants (§3.4.5), so the guard is a hard failure and not a silent skip. It is byte-identical to
-- 0061.down.sql's guard, which is what makes the two files reversible in either order.
do $$ begin
  if exists (select 1 from app.document_line where kind in ('tender','payroll')) then
    raise exception 'cannot narrow document_line_kind_check: rows still use tender/payroll';
  end if;
end $$;
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text'));
```

**Three choices worth stating, because each is the difference between a table that works and one that lies.**

- **`payroll_line.amount` has a `>= 0` CHECK and no sign.** §4.4.2's A9 warning names 8B among the five slices whose documents have a naturally negative expression, and its instruction is absolute: the magnitude is absolute and `side` answers "which way". A deduction is a *credit* rule in the policy, not a negative amount. A signed column here would let one line post as an earning and the balance would still be zero, which is SAH-003 with the constraint satisfied.
- **`entered_by` is nullable and is the ONE `*_by` column on either table besides `calculated_by`.** §3.3's rule is that a `*_by` name means "the acting principal, stamped by the server". `entered_by` is exactly that — spec:2087 requires the operator who entered a manual override to be accountable — and it is stamped. The employee the line is *about* is `employee_id`, never `*_by`; naming it `entered_by` would replace the accountable operator with whoever last touched the row, which is SAH-044 in the opposite direction.
- **`on delete cascade` on the composite FK to the parent, and the PK carries no FK of its own.** A draft run is recalculated by replacing its `document_line` rows (2B's DELETE grant plus its draft-only guard), and a `payroll_line` orphaned by that replacement would be a figure with no line. During that cascade **the parent row is already gone** — the RI cascade is an AFTER trigger on the parent and its child DELETE sees the parent removed — which is why the draft-only trigger's predicate is `s is not null and s <> 'draft'` and not `s is distinct from 'draft'`; 2B wrote the identical predicate for the identical situation and says so in its own comment (2b:1870–1873, 2b:1879). Getting this backwards refuses every draft recalculation. The single-column `references app.document_line(id)` that a PK column invites is **deliberately absent**: it would be a `composite_fk` violation (plan0A:2613) and it is redundant — the composite FK already supplies both the reference and the cascade.

- [ ] **Step 5: Write the Drizzle mirrors**

```ts
// packages/db/src/schema/payroll-run.ts — reads only (§3.4.9). Writes are postgres.js tagged templates.
import { date, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const payrollRun = app.table("payroll_run", {
  documentId: uuid("document_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  kind: text("kind").$type<"regular" | "supplementary" | "final">().notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payDate: date("pay_date").notNull(),
  pinnedTables: jsonb("pinned_tables").$type<{ schemeId: string; version: number }[]>().notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull(),
  calculatedBy: uuid("calculated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

```ts
// packages/db/src/schema/payroll-line.ts — reads only (§3.4.9).
import { integer, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const payrollLine = app.table("payroll_line", {
  documentLineId: uuid("document_line_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  componentId: uuid("component_id"),
  schemeId: uuid("scheme_id"),
  share: text("share").$type<"employee" | "employer">(),
  // numeric columns are read as STRINGS and become Money at the boundary — never `number` (§3.7.5).
  quantity: numeric("quantity"),
  amount: numeric("amount").notNull(),
  rateTableId: uuid("rate_table_id"),
  rateTableVersion: integer("rate_table_version"),
  overrideReason: text("override_reason"),
  enteredBy: uuid("entered_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 6: Edit `packages/db/src/lint-schema.ts` to exactly §3.5.3's declared state**

**The complete edit is two lines.** Two names join `NO_ID_TABLES` and nothing else changes. `NO_CREATED_AT_TABLES` is **derived** — `new Set([...NO_ID_TABLES, "ledger_entry"])`, plan0A:2702 — and is **not touched**: the derived exemption means only that the `created_at` rule does not *require* the column of these two tables, which is harmless because the DDL supplies it and Step 2's column assertion pins it.

```ts
// packages/db/src/lint-schema.ts — APPEND these two entries to the existing NO_ID_TABLES set.
// Do not remove, reorder or rewrite any member already in it; other slices own those.
export const NO_ID_TABLES: Set<string> = new Set([
  // (existing members stay exactly as found)
  "payroll_run",    // 8B — 1:1 extension of document; the PK is document_id (§3.5.3)
  "payroll_line",   // 8B — 1:1 extension of document_line; the PK is document_line_id (§3.5.3)
]);
```

`AUDIT_EXEMPT` and `IMMUTABLE` are **not** edited: §3.5.3's row for these two tables leaves both columns blank, and both tables are audited (`attach_audit` in the migration) and mutable while their document is a draft.

- [ ] **Step 7: Append `seedPayrollRun` to `packages/db/test/fixtures.ts`**

Additively, at the end of the file. Nothing existing is edited — `seedTenant`, `draftDocument` and every constant stay exactly as Plan 0A wrote them (§4.1, hazard 9).

```ts
/**
 * A DRAFT payroll run: the `document`, its `payroll_run` extension, and one zero-amount `payroll` line per
 * employee so a test has line ids to attach `payroll_line` rows to. §4.17's 8B row, with `payDate`,
 * `branchId` and `effectiveDate` added additively by amendment A6.
 *
 * It deliberately does NOT calculate: approval and posting go through the real state machine and the real
 * `calculatePayrollRun` (Task 10). A fixture that computed figures would give the golden tests a second
 * source of truth, which is SAH-009 in a test suite.
 *
 * Returns the DOCUMENT id — `payroll_run` is keyed on it and every later call takes a document id.
 */
export async function seedPayrollRun(
  db: Db,
  s: Seed,
  opts: {
    periodStart: string;
    periodEnd: string;
    employeeIds: readonly string[];
    kind?: "regular" | "supplementary" | "final";
    payDate?: string;
    branchId?: string;
    effectiveDate?: string;
  },
): Promise<string> {
  const documentId = await uuidv7(db.admin);
  const [type] = await db.admin<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = 'PAYROLL'`;
  if (!type) throw new Error("seedPayrollRun: document type PAYROLL is not configured for this company — seed it first (8B Task 4)");
  const effectiveDate = opts.effectiveDate ?? opts.periodEnd;
  const payDate = opts.payDate ?? opts.periodEnd;

  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                effective_date, currency, exchange_rate, branch_id)
      values (${documentId}, ${s.tenant}, ${s.company}, ${type.id}, 'PAY', ${s.period},
              ${effectiveDate}, 'MYR', '1.00000000', ${opts.branchId ?? s.hq})`;
    await tx`
      insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date)
      values (${documentId}, ${s.tenant}, ${s.company}, ${opts.kind ?? "regular"},
              ${opts.periodStart}, ${opts.periodEnd}, ${payDate})`;
    for (let i = 0; i < opts.employeeIds.length; i += 1) {
      const lineId = await uuidv7(db.admin);
      await tx`
        insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount, dimensions)
        values (${lineId}, ${s.tenant}, ${s.company}, ${documentId}, ${i + 1}, 'payroll', '0', '{}'::jsonb)`;
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
        values (${lineId}, ${s.tenant}, ${s.company}, ${opts.employeeIds[i]!}, '0.0000')`;
    }
  });
  return documentId;
}
```

- [ ] **Step 8: Re-export from `packages/db/src/index.ts`**

```ts
export { payrollRun } from "./schema/payroll-run";
export { payrollLine } from "./schema/payroll-line";
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `bun run --cwd packages/db test -- payroll/tables`
**Expected:** PASS (9 tests).

Then the three suites this migration can reach:

- `bun run --cwd packages/db test -- schema-lint` — **expected:** unchanged and green; the "zero violations" case is the gate for Step 6's set edit.
- `bun run --cwd packages/db test -- privileges` — **expected:** unchanged and green. It covers §3.4.6's up → down → up fingerprint and §3.5.4's pinned DELETE list; **8B grants no DELETE**, so the pinned list is untouched. If the fingerprint case fails, the down file is missing a drop — read the diff it prints and add it.
- `bun run --cwd packages/db test -- documents` and `bun run --cwd packages/db test -- ledger` — **expected:** unchanged and green. No pre-8B document carries a `payroll` line, so the widened CHECK is invisible to them.

Then `bun run typecheck` at the root for the two mirrors.

- [ ] **Step 10: Commit**

```bash
git add packages/db/migrations/0087_create_payroll_run_line.sql packages/db/migrations/0087.down.sql \
        packages/db/src/schema/payroll-run.ts packages/db/src/schema/payroll-line.ts \
        packages/db/src/lint-schema.ts packages/db/src/index.ts \
        packages/db/test/fixtures.ts packages/db/test/payroll/tables.test.ts
git commit -m "$(cat <<'EOF'
feat(db): payroll_run and payroll_line as 1:1 document extensions [8B T1]

Migration 0087. Both tables are extensions, not copies: the header lives in
app.document and the amounts in app.document_line, so the payroll run uses the
document state machine and the one posting service (spec:2081).

payroll_line.amount is a non-negative magnitude — §4.4.2 A9 makes `side` the
sole carrier of direction and names 8B among the slices that must never infer
one from a sign. payroll_line_shape_check makes the policy's three `when`
filters mutually exclusive. payroll_line_change_draft_only is SAH-031's fix
reaching the line items, which is the half the legacy period lock never did.

The document_line kind CHECK takes the full six-label union, byte-identical to
6A's 0061, because Phase 8 may execute before or after Phase 6 (spec:2301).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0088 — the `EMPLOYEE` dimension, created by trigger and repaired by a helper

**Files:**
- Create: `packages/db/migrations/0088_create_employee_dimension.sql`, `packages/db/migrations/0088.down.sql`
- Create: `packages/db/src/hr/employee-dimension.ts`
- Create: `docs/adr/0075-employee-dimension-is-created-by-trigger.md`
- Create: `packages/db/test/payroll/employee-dimension.test.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/payroll/employee-dimension.test.ts`, `packages/db/test/schema-lint.test.ts` (re-run)

**Interfaces:**
- Consumes: `app.dimension_type (id, tenant_id, company_id, code, name_en, name_ar, created_at)` and `app.dimension_value (id, tenant_id, dimension_type_id, code, name_en, name_ar, parent_id, archived_at, created_at)` (plan0A migration 0001 + 0D's 0007 `name_ar`), `app.employee` (§4.6.2), `withTenant` (production, §4.2.2), `TenantContext`, `seedEmployee` (8A), `startDb`, `seedTenantV2`, `lintSchema`.
- Produces: the trigger function `app.employee_dimension()` and the trigger `employee_dimension_value` AFTER INSERT ON `app.employee` (§4.12.7); and

```ts
// packages/db/src/hr/employee-dimension.ts
/** The company's EMPLOYEE dimension type id, creating the row on first use. Idempotent. */
export async function ensureEmployeeDimensionType(tx: Sql, companyId: string): Promise<string>;
/** The employee's EMPLOYEE dimension_value id, creating the type and the value if either is missing.
 *  Idempotent, and the ONE repair path for an employee inserted before migration 0088 (hazard 10). */
export async function ensureEmployeeDimensionValue(tx: Sql, companyId: string, employeeId: string): Promise<string>;
export const EMPLOYEE_DIMENSION_CODE = "EMPLOYEE";
```

- [ ] **Step 1: Write the failing test `packages/db/test/payroll/employee-dimension.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { EMPLOYEE_DIMENSION_CODE, ensureEmployeeDimensionValue } from "../../src/hr/employee-dimension";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedEmployee, seedTenantV2, type Seed } from "../fixtures";

let db: Db; let a: Seed; let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "Alpha");
  b = await seedTenantV2(db, "Beta");
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("migration 0088 — the EMPLOYEE dimension (§4.12.7, spec:2101)", () => {
  it("inserting an employee creates the company's EMPLOYEE dimension type on FIRST use", async () => {
    const before = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_type where company_id = ${a.company} and code = ${EMPLOYEE_DIMENSION_CODE}`;
    expect(before[0]!.n).toBe(0);
    await seedEmployee(db, a, { employeeNumber: "E-1001" });
    const after = await db.admin<{ n: number; name_en: string }[]>`
      select count(*)::int as n, min(name_en) as name_en from app.dimension_type
       where company_id = ${a.company} and code = ${EMPLOYEE_DIMENSION_CODE}`;
    expect(after[0]!.n).toBe(1);
    expect(after[0]!.name_en).toBe("Employee");
  });

  it("a SECOND employee reuses the type and adds one value coded by employee_number", async () => {
    await seedEmployee(db, a, { employeeNumber: "E-1002" });
    const types = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_type where company_id = ${a.company} and code = ${EMPLOYEE_DIMENSION_CODE}`;
    expect(types[0]!.n).toBe(1);
    const values = await db.admin<{ code: string }[]>`
      select v.code from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${a.company} and t.code = ${EMPLOYEE_DIMENSION_CODE}
       order by v.code`;
    expect(values.map((v) => v.code)).toEqual(["E-1001", "E-1002"]);
  });

  it("the value's name_en is the employee's party name, not the number (a dimension is read by humans)", async () => {
    const [row] = await db.admin<{ name_en: string }[]>`
      select v.name_en from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${a.company} and t.code = ${EMPLOYEE_DIMENSION_CODE} and v.code = 'E-1001'`;
    const [party] = await db.admin<{ name_en: string }[]>`
      select p.name_en from app.party p join app.employee e on e.party_id = p.id
       where e.company_id = ${a.company} and e.employee_number = 'E-1001'`;
    expect(row!.name_en).toBe(party!.name_en);
  });

  it("tenant B's employees do not appear in tenant A's dimension (test 12)", async () => {
    await seedEmployee(db, b, { employeeNumber: "E-1001" });   // the SAME number, a different tenant
    const seen = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.code = ${EMPLOYEE_DIMENSION_CODE}`);
    expect(seen[0]!.n).toBe(2);   // A's two, never B's
  });

  it("ensureEmployeeDimensionValue REPAIRS an employee inserted before 0088 (hazard 10 — no migration backfill)", async () => {
    // Simulate the pre-0088 state: an employee whose value the trigger never wrote.
    const legacyId = await seedEmployee(db, a, { employeeNumber: "E-0900" });
    await db.admin`
      delete from app.dimension_value v
       using app.dimension_type t
       where v.dimension_type_id = t.id and t.company_id = ${a.company}
         and t.code = ${EMPLOYEE_DIMENSION_CODE} and v.code = 'E-0900'`;

    const first = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      ensureEmployeeDimensionValue(tx, a.company, legacyId));
    const second = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      ensureEmployeeDimensionValue(tx, a.company, legacyId));
    expect(second).toBe(first);   // idempotent: the second call creates nothing

    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${a.company} and t.code = ${EMPLOYEE_DIMENSION_CODE} and v.code = 'E-0900'`;
    expect(n!.n).toBe(1);
  });

  it("ensureEmployeeDimensionValue names the employee when there is none to repair", async () => {
    const ghost = await uuidv7(db.admin);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      ensureEmployeeDimensionValue(tx, a.company, ghost)))
      .rejects.toThrow(new RegExp(`no employee ${ghost} in company ${a.company}`));
  });

  it("the schema linter reports zero violations after 0088 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- payroll/employee-dimension`
**Expected:** the first case fails on `expect(after[0]!.n).toBe(1)` receiving `0` (no trigger yet), and the repair case fails at import with

```
Error: Failed to load url ../../src/hr/employee-dimension (resolved id: .../packages/db/src/hr/employee-dimension) 
```

- [ ] **Step 3: Write `packages/db/migrations/0088_create_employee_dimension.sql`**

```sql
-- 0088_create_employee_dimension.sql
-- §4.12.7 and spec:2101: "Every line carries BRANCH … and EMPLOYEE (one dimension value per employee), so
-- branch staff cost and per-employee payables are ledger projections."
--
-- WHY A TRIGGER AND NOT A SERVICE CALL (ADR 0075): the employee master has three writers — 6C's cashier
-- onboarding, 8A's HR screens and 9B's importer — and spec:2101 wants the dimension value to exist for EVERY
-- employee, not for the ones a particular path remembered. A trigger is the only place all three meet.
--
-- WHY NO BACKFILL: FORCE ROW LEVEL SECURITY binds app_migrator (spec:1366), so this file sees zero tenants
-- and cannot write a per-tenant row (hazard 10). Employees inserted before this migration are repaired by
-- app.ensure_employee_dimension_value / ensureEmployeeDimensionValue, which the run service calls per
-- employee. That is a completeness gap closed at first use, never a silent missing dimension: the PAYROLL
-- policy declares `dimensions.required: ["BRANCH","EMPLOYEE"]`, so a line without one refuses at post with
-- ERR_POLICY_REQUIRES_MISSING rather than posting untagged.

-- ── 1. the resolver, shared by the trigger and by the repair path ─────────────────────────────────────
create function app.ensure_employee_dimension_type(p_company_id uuid) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from app.dimension_type where company_id = p_company_id and code = 'EMPLOYEE';
  if v_id is null then
    insert into app.dimension_type (tenant_id, company_id, code, name_en, name_ar)
    select c.tenant_id, c.id, 'EMPLOYEE', 'Employee', 'الموظف'
      from app.company c where c.id = p_company_id
    on conflict (company_id, code) do nothing;
    select id into v_id from app.dimension_type where company_id = p_company_id and code = 'EMPLOYEE';
  end if;
  return v_id;
end $$;

create function app.ensure_employee_dimension_value(p_company_id uuid, p_employee_id uuid) returns uuid
language plpgsql as $$
declare
  v_type uuid;
  v_id   uuid;
  v_code text;
  v_name text;
  v_tenant uuid;
begin
  select e.employee_number, p.name_en, e.tenant_id
    into v_code, v_name, v_tenant
    from app.employee e join app.party p on p.id = e.party_id
   where e.id = p_employee_id and e.company_id = p_company_id;
  if v_code is null then
    raise exception 'ERR_NOT_FOUND: no employee % in company %', p_employee_id, p_company_id
      using errcode = 'check_violation';
  end if;

  v_type := app.ensure_employee_dimension_type(p_company_id);
  select id into v_id from app.dimension_value where dimension_type_id = v_type and code = v_code;
  if v_id is null then
    insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en)
    values (v_tenant, v_type, v_code, v_name)
    on conflict (dimension_type_id, code) do nothing;
    select id into v_id from app.dimension_value where dimension_type_id = v_type and code = v_code;
  end if;
  return v_id;
end $$;

-- ── 2. the trigger (§4.12.7) ─────────────────────────────────────────────────────────────────────────
create function app.employee_dimension() returns trigger language plpgsql as $$
begin
  perform app.ensure_employee_dimension_value(new.company_id, new.id);
  return new;
end $$;

create trigger employee_dimension_value
  after insert on app.employee
  for each row execute function app.employee_dimension();

comment on function app.employee_dimension() is
  'spec:2101 — one EMPLOYEE dimension value per employee, created on insert so every writer of app.employee produces one.';

-- ── 3. no index is created here, and that is a decision, not an omission ─────────────────────────────
-- The run service's two lookups are `dimension_type (company_id, code)` and
-- `dimension_value (dimension_type_id, code)`. Plan 0A already declares `unique (company_id, code)` on
-- app.dimension_type (plan0A:1815) and `unique (dimension_type_id, code)` on app.dimension_value
-- (plan0A:1829), and Postgres backs every unique constraint with a unique index on exactly those columns
-- in exactly that order — so both lookups are already index scans. A second index on the identical column
-- list would cost a write on every insert and be chosen by the planner never.
```

```sql
-- 0088.down.sql
drop trigger if exists employee_dimension_value on app.employee;
drop function if exists app.employee_dimension() cascade;
drop function if exists app.ensure_employee_dimension_value(uuid, uuid) cascade;
drop function if exists app.ensure_employee_dimension_type(uuid) cascade;
-- The dimension_type and dimension_value ROWS are per-tenant data, not objects: `down` runs as app_migrator,
-- which FORCE RLS reduces to zero rows (spec:1366), so there is nothing here to delete and nothing is tried.
-- §3.4.5's "zero tables in schema app after down to 0" is unaffected — 0088 creates no table.
```

- [ ] **Step 4: Write `packages/db/src/hr/employee-dimension.ts`**

```ts
import type { Sql } from "postgres";

/** The dimension type code, as one literal. §4.1 fixes `BRANCH`; this is its payroll twin (spec:2101). */
export const EMPLOYEE_DIMENSION_CODE = "EMPLOYEE";

/**
 * The company's EMPLOYEE dimension type id, creating the row on first use. Idempotent.
 *
 * It calls the SQL function rather than re-implementing it, so the trigger path and the repair path can
 * never disagree about what an EMPLOYEE dimension type is — the SAH-009 failure mode applied to reference
 * data instead of to cost.
 */
export async function ensureEmployeeDimensionType(tx: Sql, companyId: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`select app.ensure_employee_dimension_type(${companyId}::uuid) as id`;
  return rows[0]!.id;
}

/**
 * The employee's EMPLOYEE dimension_value id, creating the type and the value if either is missing.
 *
 * The ONE repair path for an employee inserted before migration 0088 (hazard 10 — a migration cannot write a
 * per-tenant row). `calculatePayrollRun` calls it once per employee, so a run over a pre-0088 master is
 * correct on its first attempt rather than refusing with ERR_POLICY_REQUIRES_MISSING.
 *
 * Raises the DB token `ERR_NOT_FOUND` naming the employee and the company when there is no such employee —
 * `fromDatabaseError` maps SQLSTATE 23514 with an `ERR_*:` prefix to that AppError (§4.2.4).
 */
export async function ensureEmployeeDimensionValue(
  tx: Sql, companyId: string, employeeId: string,
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    select app.ensure_employee_dimension_value(${companyId}::uuid, ${employeeId}::uuid) as id`;
  return rows[0]!.id;
}
```

Add to `packages/db/src/index.ts`:

```ts
export { EMPLOYEE_DIMENSION_CODE, ensureEmployeeDimensionType, ensureEmployeeDimensionValue } from "./hr/employee-dimension";
```

- [ ] **Step 5: Write `docs/adr/0075-employee-dimension-is-created-by-trigger.md`**

```markdown
# ADR 0075 — The EMPLOYEE dimension value is created by a trigger on `app.employee`

**Status:** Accepted
**Date:** 2026-09-05
**Slice:** 8B

## Context

spec:2101 requires every PAYROLL ledger line to carry an `EMPLOYEE` dimension so that per-employee payables
are a ledger projection rather than a report that re-reads HR tables. A dimension value must therefore exist
for every employee, not for the ones a particular code path remembered to create one for.

`app.employee` has three writers by the end of v1: 6C's cashier onboarding, 8A's HR screens and 9B's
importer. None of them is downstream of the other two.

## Decision

An `AFTER INSERT … FOR EACH ROW` trigger on `app.employee` calls `app.ensure_employee_dimension_value`,
which creates the company's `EMPLOYEE` dimension type on first use and one `dimension_value` per employee
keyed `code = employee_number`, `name_en` = the employee's party name.

Migration 0088 does **not** backfill. `FORCE ROW LEVEL SECURITY` binds `app_migrator` (spec:1366), so a
migration file sees zero tenants and cannot write a per-tenant row. Employees that predate 0088 are repaired
at first use by `ensureEmployeeDimensionValue`, which `calculatePayrollRun` calls once per employee.

## Consequences

- A missing value is never silent: the `PAYROLL` policy declares `dimensions.required: ["BRANCH","EMPLOYEE"]`,
  so a planned line without one refuses at post with `ERR_POLICY_REQUIRES_MISSING` naming the dimension.
- `employee_number` is the value's `code`, so renumbering an employee would orphan its historical ledger
  tags. `app.employee` has `unique (company_id, employee_number)` and no rename path; if one is ever added,
  it must add a `dimension_value` row rather than update the existing one, exactly as §3.4.7 forbids renames.
- Archiving an employee does **not** archive the dimension value: posted ledger rows reference it forever
  (spec:2049 — "a terminated employee keeps every payroll line and payslip for the statutory retention
  period"). 8C's termination flow archives the employee and leaves this row alone.
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run --cwd packages/db test -- payroll/employee-dimension`
**Expected:** PASS (7 tests).

Then `bun run --cwd packages/db test -- schema-lint` — **expected:** unchanged and green. Then `bun run --cwd packages/db test` — **expected:** the whole `packages/db` suite green, 0A's and 8A's included. **One failure worth naming in advance:** if 6C's or 8A's employee suites now report an extra `dimension_type` row, they were counting `dimension_type` rows per company rather than filtering on `code = 'BRANCH'`. That is a real fix in those files, not a reason to weaken the trigger — the assertion should name the code it means.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0088_create_employee_dimension.sql packages/db/migrations/0088.down.sql \
        packages/db/src/hr/employee-dimension.ts packages/db/src/index.ts \
        docs/adr/0075-employee-dimension-is-created-by-trigger.md \
        packages/db/test/payroll/employee-dimension.test.ts
git commit -m "$(cat <<'EOF'
feat(db): the EMPLOYEE dimension, created by trigger on app.employee [8B T2]

Migration 0088 and ADR 0075. spec:2101 wants an EMPLOYEE dimension value for
EVERY employee; app.employee has three writers (6C, 8A, 9B) and a trigger is
the only place all three meet.

The migration deliberately does not backfill — FORCE RLS binds app_migrator, so
a migration file sees zero tenants (spec:1366). ensureEmployeeDimensionValue is
the repair path the run service calls per employee, and a value that is still
missing refuses at post through dimensions.required, never posts untagged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 0089 — the four `hr.payroll.*` codes, the role grants, and the two maps they unblock

**Files:**
- Create: `packages/db/migrations/0089_seed_permission_phase8b.sql`, `packages/db/migrations/0089.down.sql`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`
- Modify: `apps/api/src/middleware/require-attachment-read.ts`, `apps/api/src/middleware/require-document-permission.ts`
- Test: `packages/db/test/permission-catalogue.test.ts` (re-run), `apps/api/test/middleware/require-attachment-read.test.ts` (edit + append — **that is the file name 2C shipped**, 2c:1799, matching the middleware's own path), `packages/db/test/roles.test.ts` (re-run)

**Interfaces:**
- Consumes: `PERMISSIONS`, `PermissionDef`, `PermissionCode`, `PERMISSION`, `SliceId` (§4.2.5), `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5, 0D), `MODULE_READ_CODE`, `readableModules`, `requireAttachmentRead` (2C, in `apps/api/src/middleware/require-attachment-read.ts`), `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`, `stageCode` (2A/2B), `app.permission` (global; plan0A).
- Produces: the four catalogue rows `hr.payroll.read` (`mutating: false`), `hr.payroll.prepare`, `hr.payroll.approve`, `hr.payroll.post` (all `mutating: true`), each `phase: "8B"`; the `hr → hr.payroll.read` row of `MODULE_READ_CODE` (§4.5.8); and three additions to `POLICY_RESOLVED_CODES`.

- [ ] **Step 1: Write the migration `packages/db/migrations/0089_seed_permission_phase8b.sql`**

`app.permission` is one of §0.2's three global tables — no `tenant_id`, no RLS — so it is the one kind of row a migration may write (hazard 10, §3.4.8).

```sql
-- 0089_seed_permission_phase8b.sql
-- §3.6.2's hr / 8B row: the four codes acceptance tests 10, 29, 31, 33 and 38 are gated by. The vocabulary is
-- closed (§3.6.1) and this slice invents none — `read` and `post` are in the spec's action list (spec:2142)
-- and `prepare` and `approve` are too.
insert into app.permission (code, module, mutating, description) values
  ('hr.payroll.read',    'hr', false, 'Read payroll runs and posted payroll lines (spec:2163 — the auditor sees posted lines only, never compensation or sensitive rows)'),
  ('hr.payroll.prepare', 'hr', true,  'Calculate, recalculate and submit a payroll run (spec:2162 — the HR officer prepares; R6 forbids the same seeded role also approving)'),
  ('hr.payroll.approve', 'hr', true,  'Approve a submitted payroll run (spec:2172 R1/R2 — the checker, who must not be the submitter)'),
  ('hr.payroll.post',    'hr', true,  'Post an approved payroll run through the posting service (spec:2173 R2)')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

```sql
-- 0089.down.sql
delete from app.permission where code in
  ('hr.payroll.read', 'hr.payroll.prepare', 'hr.payroll.approve', 'hr.payroll.post');
```

- [ ] **Step 2: Add the four rows to `packages/contracts/permissions.ts`**

Appended to the `PERMISSIONS` array, in the `hr` block, after 8A's six. The array is `as const satisfies readonly PermissionDef[]`, so the four codes become members of `PermissionCode` and `PERMISSION["hr.payroll.read"]` starts type-checking in this commit.

```ts
  // ── hr / 8B (§3.6.2) ───────────────────────────────────────────────────────────────────────────────
  { code: "hr.payroll.read",    module: "hr", mutating: false, phase: "8B",
    description: "Read payroll runs and posted payroll lines (spec:2163 — posted lines only)" },
  { code: "hr.payroll.prepare", module: "hr", mutating: true,  phase: "8B",
    description: "Calculate, recalculate and submit a payroll run (spec:2162)" },
  { code: "hr.payroll.approve", module: "hr", mutating: true,  phase: "8B",
    description: "Approve a submitted payroll run (spec:2172 R1/R2)" },
  { code: "hr.payroll.post",    module: "hr", mutating: true,  phase: "8B",
    description: "Post an approved payroll run through the posting service (spec:2173 R2)" },
```

- [ ] **Step 3: Add the role grants to `packages/db/seed/roles.ts`**

Three roles gain codes; `admin.permissions` is computed from `PERMISSIONS` and is **never edited** (§3.6.4).

Which role gains what, and why, before the edit itself:

| `ROLES` entry | Codes appended | Spec |
|---|---|---|
| `hr_payroll` | `hr.payroll.read`, `hr.payroll.prepare` | spec:2162 — "payroll prepare and submit. **May not:** approve or post payroll" |
| `accountant` | `hr.payroll.read`, `hr.payroll.approve`, `hr.payroll.post` | spec:2157 — approve and post payroll as HR's checker |
| `auditor` | `hr.payroll.read` | spec:2163 — the payroll register, posted lines only. R7 holds: `hr.payroll.read` is the only non-mutating one of the four |

Write the edit as three literal array additions. In each of the three `permissions` arrays, **APPEND the lines below to the end of the array; do not remove, reorder or rewrite any member already there** — those members belong to earlier slices and this task owns none of them. Locate the three entries by their `code` (`hr_payroll`, `accountant`, `auditor`) and change nothing outside their `permissions` arrays:

```ts
// packages/db/seed/roles.ts — ROLES, entry code: "hr_payroll" (spec:2162) — APPEND to `permissions`:
      "hr.payroll.read",
      "hr.payroll.prepare",

// ROLES, entry code: "accountant" (spec:2157) — APPEND to `permissions`:
      "hr.payroll.read",
      "hr.payroll.approve",
      "hr.payroll.post",

// ROLES, entry code: "auditor" (spec:2163) — APPEND to `permissions`:
      "hr.payroll.read",
```

**Why `hr_payroll` does not hold `approve` or `post`, and why that is checked rather than remembered.** `INCOMPATIBLE_PAIRS` already contains `["hr.payroll.prepare", "hr.payroll.approve"]` (§4.2.5, seeded by 0D as a string pair precisely so a not-yet-present code is legal — F-21). Until this commit that pair was **skipped** by `scripts/lint/rules/role-seed.ts`, because the rule skips a pair whose codes are not both in the catalogue. This commit makes both present, so the pair becomes live in the same PR that could violate it. That is deliberate: R6 (spec:2177) becomes enforceable exactly when it becomes violable.

- [ ] **Step 4: Add the `hr` row to `MODULE_READ_CODE`**

The file is `apps/api/src/middleware/require-attachment-read.ts` — the path 2C actually shipped, not §4.5.8's prose (4A's Task 0 already filed that correction). One row, and no other change:

```ts
// apps/api/src/middleware/require-attachment-read.ts
export const MODULE_READ_CODE: Readonly<Record<DocumentTypeModule, PermissionCode>> = {
  accounting: PERMISSION["accounting.ledger.read"],   // 2C
  inventory:  PERMISSION["inventory.stock.read"],     // 3A
  pos:        PERMISSION["pos.report.read"],          // 6D
  // 8B. §4.14: PAYROLL is `hr` and so are 8C's PAYROLL_PAYMENT and EMPLOYEE_ADVANCE — their attachments are
  // the bank batch and the advance authorisation, both carrying per-employee pay, and `accounting` there
  // would open exactly the side channel test 32 exists to close.
  hr:         PERMISSION["hr.payroll.read"],
};
```

**If the `pos` row is absent, 6D has not merged** and Phase 8 is running ahead of Phase 6 (spec:2301 allows it). Add only the `hr` row and leave the object otherwise exactly as found; `DocumentTypeModule` is a closed four-member union, and 2C's default-deny branch covers whichever rows are still missing.

**The test goes in the same commit, and it is written before the row.** `apps/api/test/middleware/require-attachment-read.test.ts` is 2C's file (2c:1799) and it currently pins the map at **2C's** state — `expect(Object.keys(MODULE_READ_CODE)).toEqual(["accounting"])` and a loop asserting `MODULE_READ_CODE.hr` is `undefined`. Adding the `hr` row makes both false, so this task must edit them; leaving them as found would fail `bun run --cwd apps/api test` at Step 6 and hide the new row behind a red suite. Replace 2C's two cases with the three below — **the same file, the same `describe`; nothing else in it changes**:

```ts
// apps/api/test/middleware/require-attachment-read.test.ts — replaces 2C's two cases inside the existing
// `describe("the §4.5.8 download map — one row per slice, default deny", …)`. The import block already
// carries `PERMISSION` and `MODULE_READ_CODE`; nothing new is imported.
  it("every row present maps to that module's own read code", () => {
    // Written slice-agnostically on purpose: 2C's original asserted `Object.keys(...)` equals
    // `["accounting"]`, which every later slice that adds its row must then edit. Phases 3, 6 and 8 land in
    // any order (spec:2301), so the map is checked row by row and a row a slice has not shipped is skipped.
    const expected: Partial<Record<string, string>> = {
      accounting: PERMISSION["accounting.ledger.read"],   // 2C
      inventory:  PERMISSION["inventory.stock.read"],     // 3A
      pos:        PERMISSION["pos.report.read"],          // 6D
      hr:         PERMISSION["hr.payroll.read"],          // 8B — this task
    };
    for (const [module, code] of Object.entries(MODULE_READ_CODE)) {
      expect(expected[module]).toBe(code);
    }
  });

  it("the hr row is present and is hr.payroll.read (§4.5.8, §4.14 — PAYROLL's module is `hr`)", () => {
    // The row this task adds, asserted on its own so a regression that dropped it fails HERE and not in
    // some later slice's attachment suite. `hr` must not resolve to accounting.ledger.read: 8C's
    // PAYROLL_PAYMENT and EMPLOYEE_ADVANCE attachments are the bank batch and the advance authorisation,
    // both carrying per-employee pay, and that is exactly the side channel test 32 exists to close.
    expect(MODULE_READ_CODE.hr).toBe(PERMISSION["hr.payroll.read"]);
    expect(MODULE_READ_CODE.hr).not.toBe(PERMISSION["accounting.ledger.read"]);
  });

  it("denies a module by ABSENCE from the map, never by a fall-through default", () => {
    // 2C's second case said the same thing about `inventory`/`hr`/`pos`; with `hr` now present it is stated
    // as the property rather than as a list of module names that changes every phase.
    const absent = (["accounting", "inventory", "pos", "hr"] as const)
      .filter((m) => !(m in MODULE_READ_CODE));
    for (const module of absent) expect(MODULE_READ_CODE[module]).toBeUndefined();
    expect(Object.values(MODULE_READ_CODE).every((c) => typeof c === "string" && c.length > 0)).toBe(true);
  });
```

Run it **before** the map edit above and it fails on the second case with `expected undefined to be "hr.payroll.read"`; run it after and all three pass. That is this task's failing-test-first step — the other three steps are catalogue rows, which `permission-catalogue.test.ts` already checks in both directions.

- [ ] **Step 5: Add the three codes to `POLICY_RESOLVED_CODES`**

`apps/api/src/middleware/require-document-permission.ts`. The `PAYROLL` policy names `hr.payroll.prepare` (as `approval.create`), `hr.payroll.approve` and `hr.payroll.post`, and a gate resolved from **data** is invisible to `scripts/lint/rules/permission-catalogue.ts`; the constant is what gives those three codes a `PERMISSION[…]` reference (§4.5.4).

**APPEND these three lines to the end of the existing `POLICY_RESOLVED_CODES` array; do not remove, reorder or rewrite any member already there.**

```ts
// apps/api/src/middleware/require-document-permission.ts — inside POLICY_RESOLVED_CODES:
  PERMISSION["hr.payroll.prepare"],   // 8B — PAYROLL.approval.create
  PERMISSION["hr.payroll.approve"],   // 8B — PAYROLL.approval.approve
  PERMISSION["hr.payroll.post"],      // 8B — PAYROLL.approval.post
```

`DOCUMENT_STAGE_CODES` is **initialised from** `POLICY_RESOLVED_CODES` (§4.5.4) and is therefore not edited separately. If the file initialises it from a literal array instead, that is the finding 2A's constant exists to prevent — fix it to `export const DOCUMENT_STAGE_CODES: readonly PermissionCode[] = POLICY_RESOLVED_CODES;` and say so in the commit body.

- [ ] **Step 6: Run the checks — all green, and the reason Steps 4 and 5 cannot be deferred**

Run: `bun run --cwd packages/db test -- permission-catalogue`
**Expected:** PASS. The suite asserts, after all migrations, that the set of `(code, module, mutating)` in `app.permission` equals the set `permissions.ts` exports — **both directions**, which is why Steps 1 and 2 must be in one commit.

Run: `bun run --cwd packages/db test -- roles`
**Expected:** PASS, including R7's "the `auditor` role holds no mutating code".

Run: `bun run --cwd apps/api test -- test/middleware/require-attachment-read`
**Expected:** PASS (3 cases) — Step 4's three cases against Step 4's `hr` row. Run this one *before* the map edit too, as Step 4 says: the `hr` case must fail first.

Run: `bun run lint:rules`
**Expected: zero violations**, and the tree is green at this commit exactly as Global Constraint 18 requires. Steps 4 and 5 are what make that true — Step 4's `MODULE_READ_CODE` row is `hr.payroll.read`'s reference, and Step 5's `POLICY_RESOLVED_CODES` additions are the other three's. **This paragraph describes what deferring them would cause; it is not a state this plan ever enters.** Deferring either to a later task would end this task with `permission-catalogue` reporting its codes unreferenced, in this shape:

```
packages/contracts/permissions.ts:<n> permission-catalogue catalogue code hr.payroll.read has no PERMISSION[…] or requirePermission(…) reference
```

**So do not split Steps 4 and 5 out of this task.** PR 3 carries Tasks 3 and 4 together and every check is green at each of its two commits.

Run: `bun run typecheck` at the root — **expected:** green; the four codes are now members of `PermissionCode`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0089_seed_permission_phase8b.sql packages/db/migrations/0089.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        apps/api/src/middleware/require-attachment-read.ts \
        apps/api/src/middleware/require-document-permission.ts \
        apps/api/test/middleware/require-attachment-read.test.ts
git commit -m "$(cat <<'EOF'
feat(db): the four hr.payroll.* codes and the role grants R6 needs [8B T3]

Migration 0089 plus the catalogue rows, in one commit because
permission-catalogue.test.ts compares app.permission against permissions.ts in
both directions.

hr_payroll gets read+prepare, accountant gets read+approve+post, auditor gets
read (spec:2157, 2162, 2163). INCOMPATIBLE_PAIRS already held
[prepare, approve] as a string pair; both codes now exist, so role-seed.ts
stops skipping it and R6 becomes enforceable in the same PR that could break it.

MODULE_READ_CODE gains its hr row (§4.5.8) and POLICY_RESOLVED_CODES the three
codes the PAYROLL policy resolves from data — without them a data-resolved gate
has no PERMISSION[…] reference and the catalogue lint fails.

2C's require-attachment-read.test.ts pinned the map at "exactly the accounting
row" and asserted MODULE_READ_CODE.hr was undefined, both of which the new row
falsifies. Its two cases are replaced by three written row-by-row instead of by
whole-object equality, so 3A's and 6D's rows do not have to edit them again;
one of the three asserts hr resolves to hr.payroll.read and not to
accounting.ledger.read, which is the side channel test 32 exists to close.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The payroll chart, the account wiring, and the `PAYROLL` document type

**Files:**
- Create: `packages/db/seed/my/chart-of-accounts/8b-payroll.json`
- Create: `packages/db/seed/my/document-types/PAYROLL.json`
- Create: `packages/db/src/seed/payroll-accounts.ts` (the **wiring entry point**, not a loader), `packages/db/src/hr/accounts.ts`
- Create: `docs/adr/0076-payroll-correction-is-a-supplementary-run.md`
- Create: `packages/db/test/payroll/accounts.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/src/seed/index.ts`, `packages/db/package.json` (one script)
- Test: `packages/db/test/payroll/accounts.test.ts`

**Interfaces:**
- Consumes: `chartOfAccountsLoader` (0C, `packages/db/src/seed/chart-of-accounts.ts` — **consumed, never replaced**), `LoaderContext`, `SeedConfig` (§4.2.13, 0C), `createDb` (§4.2.2), `systemContext(sql, tenantId, requestId)` and the production `withTenant(sql, ctx, fn)` (§4.2.2), `loadDocumentTypes(sql, ctx, packDir, catalogue)` / `documentTypesLoader` (1A), `validatePolicy(definition, catalogue)` and `validateDocumentTypeSeed(envelope)` (2A), `PERMISSIONS` (for the catalogue argument), `app.account` (plan0A), `app.pay_component` / `app.statutory_scheme` (8A), `seedAccount`, `seedPayComponent`, `seedStatutoryScheme`, `seedTenantV2`, `startDb`.
- Produces: the eleven §4.15 rows of `8b-payroll.json` (**a file only — no `PackLoader`**); `packages/db/seed/my/document-types/PAYROLL.json` in the §4.3.7 envelope; and

```ts
// packages/db/src/seed/payroll-accounts.ts — the wiring entry point, exported from the SEED barrel only
export async function linkPayrollAccountsForTenant(sql: Sql, tenantId: string, companyId: string): Promise<PayrollAccountLinkage>;
export async function main(argv: readonly string[]): Promise<number>;   // bun run --cwd packages/db seed:payroll-accounts

// packages/db/src/hr/accounts.ts
export interface PayrollAccountLinkage { componentsLinked: number; schemesLinked: number; missingCodes: string[] }
/** Sets pay_component.expense_account_id, statutory_scheme.payable_account_id and
 *  statutory_scheme.employer_expense_account_id from the §4.15 codes this slice seeds.
 *  Idempotent; never overwrites a value a tenant already chose. */
export async function linkPayrollAccounts(tx: Sql, companyId: string): Promise<PayrollAccountLinkage>;
/** The eleven codes, as one exported literal so a test and the linker cannot disagree. */
export const PAYROLL_ACCOUNT_CODES: {
  readonly staffAdvances: "1400"; readonly salariesPayable: "2400"; readonly salariesExpense: "5300";
  readonly schemePayable: Readonly<Record<"EPF" | "SOCSO" | "EIS" | "PCB", string>>;
  readonly schemeEmployerExpense: Readonly<Record<"EPF" | "SOCSO" | "EIS" | "PCB", string>>;
};
```

- [ ] **Step 1: Write the failing test `packages/db/test/payroll/accounts.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAYROLL_ACCOUNT_CODES, linkPayrollAccounts } from "../../src/hr/accounts";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { linkPayrollAccountsForTenant } from "../../src/seed/payroll-accounts";
import type { LoaderContext } from "../../src/seed/packs";
import { startDb, withTenant, type Db } from "../harness";
import { seedPayComponent, seedStatutoryScheme, seedTenantV2, type Seed } from "../fixtures";

const PACK_ROOT = join(import.meta.dirname, "../../seed/my");
const CATALOGUE = PERMISSIONS.map((p) => p.code) as string[];

let db: Db; let s: Seed;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Payroll");
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("8b-payroll.json and PAYROLL.json (§4.15, §4.14, §4.3.7)", () => {
  it("the chart file holds exactly the eleven §4.15 leaves this slice owns plus one presentation parent", () => {
    const rows = JSON.parse(readFileSync(join(PACK_ROOT, "chart-of-accounts/8b-payroll.json"), "utf8")) as
      { code: string; nameEn: string; nameAr?: string; type: string; isGroup?: boolean; parentCode?: string }[];
    expect(rows.filter((r) => r.isGroup !== true).map((r) => r.code).sort()).toEqual(
      ["1400", "2400", "2411", "2412", "2413", "2414", "5300", "5311", "5312", "5313", "5314"]);
    expect(rows.filter((r) => r.isGroup === true).map((r) => r.code)).toEqual(["2410"]);
    for (const r of rows) if (r.parentCode !== undefined) expect(r.parentCode).toBe("2410");
    // The same eleven, read out of the ONE exported literal: the seed file, the linker and 8C's consumers
    // cannot drift apart into three copies of eleven strings (hazard 32).
    expect([
      PAYROLL_ACCOUNT_CODES.staffAdvances, PAYROLL_ACCOUNT_CODES.salariesPayable,
      PAYROLL_ACCOUNT_CODES.salariesExpense,
      ...Object.values(PAYROLL_ACCOUNT_CODES.schemePayable),
      ...Object.values(PAYROLL_ACCOUNT_CODES.schemeEmployerExpense),
    ].sort()).toEqual(rows.filter((r) => r.isGroup !== true).map((r) => r.code).sort());
    const firstDigitType: Record<string, string> = { "1": "asset", "2": "liability", "3": "equity", "4": "income", "5": "expense" };
    for (const r of rows) {
      expect(r.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(r.type).toBe(firstDigitType[r.code[0]!]);
    }
  });

  it("the PAYROLL envelope validates, and its policy validates against the frozen schema and the catalogue", () => {
    const envelope = JSON.parse(readFileSync(join(PACK_ROOT, "document-types/PAYROLL.json"), "utf8")) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope["module"]).toBe("hr");
    expect(validatePolicy(envelope["policy"], CATALOGUE)).toEqual({ ok: true, errors: [] });
  });

  it("every PAYROLL rule declares dimensions.from WITHOUT document.branch (amendment A3, spec:2101)", () => {
    const envelope = JSON.parse(readFileSync(join(PACK_ROOT, "document-types/PAYROLL.json"), "utf8")) as
      { policy: { lines: { dimensions?: { from?: string[] } }[]; dimensions: { required: string[] } } };
    expect(envelope.policy.dimensions.required).toEqual(["BRANCH", "EMPLOYEE"]);
    for (const rule of envelope.policy.lines) {
      expect(rule.dimensions?.from).toEqual(["line.dimensions", "line.employee"]);
    }
  });

  it("PAYROLL refuses reversal — correction is a supplementary run (amendment A4, ADR 0076)", () => {
    const envelope = JSON.parse(readFileSync(join(PACK_ROOT, "document-types/PAYROLL.json"), "utf8")) as
      { policy: { reversal: { allowed: boolean; producesType: string | null };
                  approval: { required: boolean; approve: string; post: string; create: string };
                  numbering: { series: string }; direction: string; inventory: { effect: string }; tax: { applies: boolean } } };
    expect(envelope.policy.reversal).toEqual({ allowed: false, producesType: null });
    expect(envelope.policy.approval).toEqual({
      required: true, approve: "hr.payroll.approve", post: "hr.payroll.post", create: "hr.payroll.prepare",
    });
    expect(envelope.policy.numbering.series).toBe("PAY");
    expect(envelope.policy.direction).toBe("none");
    expect(envelope.policy.inventory).toEqual({ effect: "none" });
    expect(envelope.policy.tax).toEqual({ applies: false });
  });

  it("0C's chart loader picks the file up and seeds all twelve rows idempotently — a second run changes nothing", async () => {
    // 8B ships a FILE, not a loader: `chartOfAccountsLoader` reads every `.json` in the sub-pack in name
    // order (0c:4045–4060), which is why `SubPack`, `SUB_PACKS` and `LOADERS` are untouched by this slice.
    // The same call 3C makes for `3c-purchasing.json` (3c:1313), against this slice's file.
    const ctx: LoaderContext = {
      config: {
        tenantId: s.tenant, only: ["chart-of-accounts"], packRoot: PACK_ROOT,
        tenantName: "payroll", ownerEmail: "owner@example.invalid",
        companyCode: "HQ", companyName: "payroll HQ",
        baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur",
        fiscalYearStartMonth: 1, fiscalYear: 2026,
      },
      tenantId: s.tenant, companyId: s.company, systemPrincipalId: s.system, packRoot: PACK_ROOT,
    };
    await withTenant(db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, ctx));
    await withTenant(db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, ctx));
    const rows = await db.admin<{ code: string }[]>`
      select code from app.account
       where company_id = ${s.company}
         and code in ('1400','2400','2410','2411','2412','2413','2414','5300','5311','5312','5313','5314')
       order by code`;
    expect(rows.map((r) => r.code)).toEqual(
      ["1400", "2400", "2410", "2411", "2412", "2413", "2414", "5300", "5311", "5312", "5313", "5314"]);
  });

  it("linkPayrollAccounts wires components and schemes from the codes, and never overwrites a chosen value", async () => {
    const epf = await seedStatutoryScheme(db, s, { code: "EPF" });
    const socso = await seedStatutoryScheme(db, s, { code: "SOCSO" });
    const basic = await seedPayComponent(db, s, { code: "BASIC", kind: "earning" });
    const chosen = await seedPayComponent(db, s, { code: "OT", kind: "earning" });
    const [other] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`;
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.pay_component set expense_account_id = ${other!.id} where id = ${chosen}`);

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) => linkPayrollAccounts(tx, s.company));
    expect(result.missingCodes).toEqual([]);
    expect(result.componentsLinked).toBe(1);   // BASIC only — OT already had one
    expect(result.schemesLinked).toBe(2);

    const rows = await db.admin<{ code: string; expense: string | null }[]>`
      select c.code, a.code as expense from app.pay_component c
        left join app.account a on a.id = c.expense_account_id
       where c.company_id = ${s.company} order by c.code`;
    expect(rows).toEqual([{ code: "BASIC", expense: "5300" }, { code: "OT", expense: "5900" }]);

    const schemes = await db.admin<{ code: string; payable: string; employer: string | null }[]>`
      select sc.code, p.code as payable, e.code as employer from app.statutory_scheme sc
        join app.account p on p.id = sc.payable_account_id
        left join app.account e on e.id = sc.employer_expense_account_id
       where sc.company_id = ${s.company} order by sc.code`;
    expect(schemes).toEqual([
      { code: "EPF",   payable: "2411", employer: "5311" },
      { code: "SOCSO", payable: "2412", employer: "5312" },
    ]);
    expect([epf, socso, basic]).toHaveLength(3);
  });

  it("the wiring entry point runs as the tenant's SYSTEM principal and is idempotent", async () => {
    // This is the function the release runbook calls after `bun run seed --only chart-of-accounts`, and the
    // one `payrollFixture` calls after it seeds the chart. It opens its own tenant transaction, so it is the
    // one place the wiring's actor is decided — the system principal, never a human (hazard 20's shape).
    const first = await linkPayrollAccountsForTenant(db.rw, s.tenant, s.company);
    const second = await linkPayrollAccountsForTenant(db.rw, s.tenant, s.company);
    expect(first.missingCodes).toEqual([]);
    expect(second.componentsLinked).toBe(0);   // nothing left to link on a second run
    expect(second.schemesLinked).toBe(0);
  });

  it("linkPayrollAccounts NAMES a code it cannot resolve rather than leaving a null account (hazard 33)", async () => {
    await db.admin`delete from app.account where company_id = ${s.company} and code = '2413'`;
    await seedStatutoryScheme(db, s, { code: "EIS" });
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) => linkPayrollAccounts(tx, s.company));
    // The payable is the gate: `if (payableId === null) { missing.push(payableCode); continue; }`, so when
    // `2413` is absent the WHOLE EIS scheme is skipped — `5313` still resolves but is never linked, and it
    // is not named either, because it is not missing. That is deliberate: a scheme whose statutory payable
    // has no account must not be half-wired, and hazard 33's requirement is that the unresolvable code be
    // NAMED rather than silently replaced by a null.
    expect(result.missingCodes).toEqual(["2413"]);
    expect(result.schemesLinked).toBe(0);
    const [eis] = await db.admin<{ employer: string | null }[]>`
      select e.code as employer from app.statutory_scheme sc
        left join app.account e on e.id = sc.employer_expense_account_id
       where sc.company_id = ${s.company} and sc.code = 'EIS'`;
    expect(eis!.employer).toBeNull();   // skipped whole, not linked halfway
  });
});
```

- [ ] **Step 2: Write `packages/db/seed/my/document-types/PAYROLL.json`**

```json
{
  "code": "PAYROLL",
  "nameEn": "Payroll Run",
  "nameAr": "مسير الرواتب",
  "module": "hr",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "PAYROLL",
    "direction": "none",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.component.expense_account" }, "amount": "line.amount",
        "when": { "line.kind": "payroll", "line.component.kind": "earning" },
        "dimensions": { "from": ["line.dimensions", "line.employee"] } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.component.expense_account" }, "amount": "line.amount",
        "when": { "line.kind": "payroll", "line.component.kind": "deduction" },
        "dimensions": { "from": ["line.dimensions", "line.employee"] } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.scheme.payable_account" },    "amount": "line.amount",
        "when": { "line.kind": "payroll", "line.share": "employee" },
        "dimensions": { "from": ["line.dimensions", "line.employee"] } },
      { "for": "each_line", "side": "debit",  "account": { "from": "line.scheme.expense_account" },    "amount": "line.amount",
        "when": { "line.kind": "payroll", "line.share": "employer" },
        "dimensions": { "from": ["line.dimensions", "line.employee"] } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.scheme.payable_account" },    "amount": "line.amount",
        "when": { "line.kind": "payroll", "line.share": "employer" },
        "dimensions": { "from": ["line.dimensions", "line.employee"] } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" },                   "amount": "line.credit",
        "when": { "line.kind": "account" },
        "dimensions": { "from": ["line.dimensions", "line.employee"] } },
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" },                   "amount": "line.debit",
        "when": { "line.kind": "account" },
        "dimensions": { "from": ["line.dimensions", "line.employee"] } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "PAY", "assignAt": "issue" },
    "reversal": { "allowed": false, "producesType": null },
    "approval": { "required": true, "approve": "hr.payroll.approve", "post": "hr.payroll.post", "create": "hr.payroll.prepare" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH", "EMPLOYEE"] }
  }
}
```

**Seven choices, and every one of them is the difference between a policy that posts spec:2101 and one that posts something else.**

- **Seven rules for five shapes, because the employer share needs two legs.** spec:2101 reads: "for each earning component, DEBIT its expense account; for each employer contribution, DEBIT its expense account; CREDIT each scheme's payable account for the employee and employer shares; CREDIT the advance receivable for recoveries; CREDIT salaries payable per employee for net pay." Rules 4 and 5 are the employer contribution's two halves over **one** `document_line` — `each_line` iterates every line for every rule, so two rules with the same `when` emit two ledger lines from one source line. That is how one line becomes `debit 5311 / credit 2411` and balances on its own.
- **A deduction credits `line.component.expense_account`, and that is not a misnomer.** `pay_component` has both `expense_account_id` and `payable_account_id` (§4.6.1), but §4.4.1's `accountRef` enum offers only `line.component.expense_account` and the schema is frozen at one `$id` from 2A onward. The account a deduction component names is therefore its `expense_account_id`: `5300` for an unpaid-leave deduction (it *reduces* salaries expense) and `1400` for the advance-recovery component (it relieves the staff-advance receivable — §4.15's own note, "recovered by the advance-recovery `pay_component`"). **`linkPayrollAccounts` (Step 5) does not choose that `1400` and must not:** it sets `5300` as the blanket default on components that have **no** account yet, and it never overwrites one that has. Which component is the advance-recovery one is an **operator/seed decision** — 8A's `pay-components.json` and the tenant's accountant name it, and no code in this slice matches on a component code, because a component code is not a registered namespace and a hard-coded `ADV_RECOVERY` here would have to match 8A's seed file byte for byte or wire the wrong account silently. `PAYROLL_ACCOUNT_CODES.staffAdvances` is exported for **8C's** `EMPLOYEE_ADVANCE` (§4.12.2) and for the two fixtures that set the account by hand (`payrollFixture`, T10 Step 3; the golden `seedCase`, T13 Step 2), and for nothing else in this slice.
- **Net pay is an `account` line, not a `payroll` line, and it still carries both dimensions.** Rules 6 and 7 are the JOURNAL-shaped pair. The run service writes one `kind: "account"` `document_line` per employee with `account_id` = the `2400` account and `credit` = net pay, **and a `payroll_line` row beside it** with `employee_id` set and `component_id`/`scheme_id`/`share` all null — the third arm of `payroll_line_shape_check`. That `payroll_line` is what makes `line.employee` resolve on an `account` line, so the net-pay credit is tagged EMPLOYEE like every other line. Without it `dimensions.required` would refuse the whole document.
- **Both `account` twins ship, and rule 7 is not dead weight.** `reverseDocument` **swaps** `debit`/`credit` on a copied line (2a:2512 — `l.credit, l.debit`) while negating the signed magnitudes, and `document_line.debit`/`credit` carry `>= 0` CHECKs (plan0A:2012). A lone credit rule would emit nothing from a mirrored line. PAYROLL refuses reversal (below), but a **supplementary** run legitimately carries a debit on an `account` line — a negative net pay for an over-payment being recovered — and rule 7 is what posts it.
- **`dimensions.from` omits `document.branch` on every rule (amendment A3).** 2A's `dimensionsFor` ends with `if (from.includes("document.branch")) out["BRANCH"] = snapshot.header.branchId;` — the header's BRANCH always wins over the line's bag (2a:1766, SAH-042/050). Naming it here would stamp every employee's line with the *run's* branch, and spec:2101's "the employee's home branch" would be false for everyone outside it. The run service writes `document_line.dimensions = {"BRANCH": "<the employee's home_branch_id>"}`, `line.dimensions` carries it through, and `dimensions.required: ["BRANCH", "EMPLOYEE"]` refuses any line that lost it. This is the mechanism 2A's own note already assigned to 8B (2a:1321).
- **`approval.create: "hr.payroll.prepare"` — three distinct codes, which is what makes R6's pair meaningful.** §4.4.1 makes `create` the code that may create, edit and submit a draft; `requireDocumentPermission("create"/"submit")` resolves `approval.create ?? approval.post`, so without it a preparer would need `hr.payroll.post` to draft a run and R6's `[prepare, approve]` pair would guard nothing.
- **`reversal: { "allowed": false, "producesType": null }` (amendment A4, ADR 0076).** Two independent mechanics forbid it and either alone is decisive. **(1) The state machine.** `reverseDocument` creates a fresh **draft** mirror and calls `postDocument` on it in the same transaction; §4.3.2 step 2 admits a draft only when `draft → issued` is legal, and §4.5.1 makes that legal **only when `approval.required = false`**. PAYROLL's is `true`, so the inner post raises `ERR_DOC_STATUS_ILLEGAL` — and the only ways round it are to set `approval.required = false` (which deletes R1 for the highest-risk document in the system, SAH-032) or to let the reversal skip the trigger (which is SAH-027, "disable an invariant temporarily"). **(2) The extension rows.** `reverseDocument` copies `document_line` columns; it copies no `payroll_line`, so every mirrored line would resolve `line.component.kind` and `line.share` to `null`, match no rule, plan zero ledger lines and raise `ERR_DOC_NO_LINES` at §4.3.2 step 6. Correction is therefore a **`supplementary` run** — a first-class `payroll_run.kind` (§4.12.6) that carries the delta, goes through submit → approve → post like any run, and leaves the original's posted lines and pins untouched, which is exactly what SAH-041 asks for.

- [ ] **Step 3: Write `packages/db/seed/my/chart-of-accounts/8b-payroll.json`**

Twelve rows: the eleven §4.15 leaves this slice owns, plus one `isGroup` parent so the payroll block presents as a block. Group codes are unregistered by §4.15 and no policy resolves them.

```json
[
  { "code": "1400", "nameEn": "Staff advances", "nameAr": "سلف الموظفين", "type": "asset" },
  { "code": "2400", "nameEn": "Salaries payable", "nameAr": "رواتب مستحقة", "type": "liability" },
  { "code": "2410", "nameEn": "Statutory payable", "nameAr": "مستحقات نظامية", "type": "liability", "isGroup": true },
  { "code": "2411", "nameEn": "Statutory payable — EPF", "nameAr": "مستحق — صندوق الادخار", "type": "liability", "parentCode": "2410" },
  { "code": "2412", "nameEn": "Statutory payable — SOCSO", "nameAr": "مستحق — الضمان الاجتماعي", "type": "liability", "parentCode": "2410" },
  { "code": "2413", "nameEn": "Statutory payable — EIS", "nameAr": "مستحق — تأمين التوظيف", "type": "liability", "parentCode": "2410" },
  { "code": "2414", "nameEn": "Statutory payable — PCB", "nameAr": "مستحق — الاستقطاع الشهري", "type": "liability", "parentCode": "2410" },
  { "code": "5300", "nameEn": "Salaries expense", "nameAr": "مصروف الرواتب", "type": "expense" },
  { "code": "5311", "nameEn": "Employer contribution — EPF", "nameAr": "مساهمة صاحب العمل — صندوق الادخار", "type": "expense" },
  { "code": "5312", "nameEn": "Employer contribution — SOCSO", "nameAr": "مساهمة صاحب العمل — الضمان الاجتماعي", "type": "expense" },
  { "code": "5313", "nameEn": "Employer contribution — EIS", "nameAr": "مساهمة صاحب العمل — تأمين التوظيف", "type": "expense" },
  { "code": "5314", "nameEn": "Employer contribution — PCB", "nameAr": "مساهمة صاحب العمل — الاستقطاع الشهري", "type": "expense" }
]
```

**The scheme order is `EPF, SOCSO, EIS, PCB` and the last digit is shared between the two families**, exactly as §4.15 pins it: `2411`↔`5311`, `2412`↔`5312`, `2413`↔`5313`, `2414`↔`5314`. **A confirmed levy takes the next free `24nn` and the matching `53nn` in the order the scheme is added, allocated in §4.15 by the slice that adds it** — `241n` is exhausted at four schemes, so `2415`/`5315` follow. No code chooses a number at run time. **`5314` carries no balance in practice** — PCB is a deduction from the employee with no employer share — and that is fine: §4.15 says so in as many words ("A scheme with no employer share leaves the column null and its account simply carries no balance"). The row exists so the four schemes are symmetric and a future levy's allocation rule is unambiguous. **No rate, threshold or ceiling appears here and none ever will** (hazard 1): these are account *names*, and whether a scheme has an employer share is a rate-table fact.

- [ ] **Step 4: Write `packages/db/src/seed/payroll-accounts.ts` — the wiring entry point, and NOT a second loader**

`chart-of-accounts` and `document-types` are existing sub-packs (§3.4.8); this slice adds **files**, never a loader, so `SubPack`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES` and `LOADERS` are not edited. **That rule is mechanical here, not stylistic:** `LOADERS` is `Partial<Record<SubPack, PackLoader>>` (0c:3196, 0c:3816), so it holds **exactly one** loader per sub-pack name, and 0C's `chartOfAccountsLoader` (0c:4045) already reads *every* `.json` in the directory in name order. A second `PackLoader` called `chart-of-accounts` could never be reached — `bun run seed --only chart-of-accounts` would dispatch to 0C's, the accounts would appear, and the wiring bundled inside the unreachable loader would silently never run, leaving `pay_component.expense_account_id` and both `statutory_scheme` account columns NULL until the first `PAYROLL` post failed with `ERR_POLICY_REQUIRES_MISSING`. 3C (`3c-purchasing.json`) and 5A (`5a-tax.json`) ship a file and drive 0C's loader in their own tests for exactly this reason (3c:1313, 3c:3067).

So the file is applied by 0C's loader and the **wiring** — hazard 33's other half — is a separate, explicitly invoked entry point: one module, one package script, called by Step 7's runbook immediately after the seed command, and by `payrollFixture` (T10 Step 3) immediately after it seeds the chart.

```ts
// packages/db/src/seed/payroll-accounts.ts
import type { Sql } from "postgres";
import { createDb } from "../client";
import { systemContext, withTenant } from "../with-tenant";
import { linkPayrollAccounts, type PayrollAccountLinkage } from "../hr/accounts";

/**
 * Wires one tenant's pay components and statutory schemes to the §4.15 codes `8b-payroll.json` seeds.
 *
 * It is NOT a `PackLoader`: `LOADERS` is keyed by `SubPack` and 0C already owns `chart-of-accounts`, so this
 * runs as its own step after `bun run seed --tenant <id> --only chart-of-accounts`. It opens its own tenant
 * transaction as **the tenant's system principal** — the wiring is reference data nobody signs for, and a
 * human actor stamped on it would be a lie the audit trail then carries for ever (SAH-044).
 */
export async function linkPayrollAccountsForTenant(
  sql: Sql, tenantId: string, companyId: string,
): Promise<PayrollAccountLinkage> {
  // `systemContext` resolves `system:<tenantId>` through `app.resolve_principal`, which plan0A:835 makes
  // "callable by app_rw with NO tenant set" and plan0A:887 proves with a test — so this works on a bare
  // pool, before any `withTenant` has set `app.tenant_id`. That is the whole reason it can be the first
  // statement of a CLI entry point.
  const ctx = await systemContext(sql, tenantId, crypto.randomUUID());
  const result = await withTenant(sql, ctx, (tx) => linkPayrollAccounts(tx, companyId));
  if (result.missingCodes.length > 0) {
    // Hazard 33: an unresolvable account code is NAMED and the step fails. A silent skip would leave a NULL
    // account that only surfaces at the first post, in 8C, in the slice that did not write it.
    throw new Error(
      `ERR_POLICY_REQUIRES_MISSING: company ${companyId} cannot resolve the payroll account code(s) ` +
        `${result.missingCodes.join(", ")}; apply packages/db/seed/my/chart-of-accounts/8b-payroll.json first`,
    );
  }
  return result;
}

/** `bun run --cwd packages/db seed:payroll-accounts --tenant <uuid> --company <uuid>`. */
export async function main(argv: readonly string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tenantId = flag("tenant");
  const companyId = flag("company");
  const url = process.env["DATABASE_URL"];
  if (tenantId === undefined || companyId === undefined || url === undefined) {
    process.stderr.write("usage: seed:payroll-accounts --tenant <uuid> --company <uuid> (DATABASE_URL required)\n");
    return 2;                                    // §4.2.13's frozen exit code for a configuration error
  }
  const pool = createDb(url);
  try {
    const result = await linkPayrollAccountsForTenant(pool, tenantId, companyId);
    process.stdout.write(`linked ${result.componentsLinked} pay component(s) and ${result.schemesLinked} scheme(s)\n`);
    return 0;
  } catch (e) {
    // §4.2.13's exit codes are frozen and the release runbook reads them: 1 is "a loader failed / the
    // database refused", which is what an unresolvable account code is. Letting the rejection escape would
    // exit on an unhandled promise instead, with a code nothing has agreed on.
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
```

Add the script to `packages/db/package.json` (no version is pinned and no dependency is added — §3.3):

```json
    "seed:payroll-accounts": "bun src/seed/payroll-accounts.ts"
```

- [ ] **Step 5: Write `packages/db/src/hr/accounts.ts`**

```ts
import type { Sql } from "postgres";

/**
 * The eleven §4.15 codes 8B seeds, as ONE exported literal. Hazard 32: an account code has no build check behind
 * it and a wrong one fails only at post, at run time, in the slice that did not write it — so the linker, the
 * seed file and every test read the same object rather than three copies of eleven strings.
 *
 * The scheme order EPF, SOCSO, EIS, PCB and the shared last digit are §4.15's, not a choice made here.
 */
export const PAYROLL_ACCOUNT_CODES = {
  staffAdvances: "1400",
  salariesPayable: "2400",
  salariesExpense: "5300",
  schemePayable: { EPF: "2411", SOCSO: "2412", EIS: "2413", PCB: "2414" },
  schemeEmployerExpense: { EPF: "5311", SOCSO: "5312", EIS: "5313", PCB: "5314" },
} as const;

export interface PayrollAccountLinkage {
  componentsLinked: number;
  schemesLinked: number;
  /** Codes a scheme or component needed that the company's chart does not have. Never silently skipped. */
  missingCodes: string[];
}

/**
 * Sets `pay_component.expense_account_id`, `statutory_scheme.payable_account_id` and
 * `statutory_scheme.employer_expense_account_id` from the codes above.
 *
 * §4.12.2: "the same seed task sets [them] from those codes, so no plan writes a payroll account literal of
 * its own" — and so 8C's `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` resolve `2400` and `1400` without seeding
 * anything.
 *
 * **It never overwrites a value a tenant already chose.** The `where … is null` clauses are what make the
 * loader idempotent AND make a per-component override (an overtime component pointing at `5900`, an
 * advance-recovery component pointing at `1400`) survive a re-seed. A blind update would silently restate a
 * chart a customer's accountant configured, which is SAH-013's shape applied to reference data.
 */
export async function linkPayrollAccounts(tx: Sql, companyId: string): Promise<PayrollAccountLinkage> {
  const accounts = await tx<{ code: string; id: string }[]>`
    select code, id from app.account where company_id = ${companyId}`;
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  const missing: string[] = [];

  const salaries = byCode.get(PAYROLL_ACCOUNT_CODES.salariesExpense) ?? null;
  if (salaries === null) missing.push(PAYROLL_ACCOUNT_CODES.salariesExpense);

  let componentsLinked = 0;
  if (salaries !== null) {
    const linked = await tx<{ id: string }[]>`
      update app.pay_component set expense_account_id = ${salaries}
       where company_id = ${companyId} and expense_account_id is null
       returning id`;
    componentsLinked = linked.length;
  }

  const schemes = await tx<{ id: string; code: string; payable_account_id: string | null; employer_expense_account_id: string | null }[]>`
    select id, code, payable_account_id, employer_expense_account_id
      from app.statutory_scheme where company_id = ${companyId} order by code`;
  let schemesLinked = 0;
  for (const scheme of schemes) {
    const payableCode = (PAYROLL_ACCOUNT_CODES.schemePayable as Record<string, string | undefined>)[scheme.code];
    const employerCode = (PAYROLL_ACCOUNT_CODES.schemeEmployerExpense as Record<string, string | undefined>)[scheme.code];
    if (payableCode === undefined || employerCode === undefined) {
      // A levy the owner confirmed under OD-14 that §4.15 has not allocated a code to yet. Naming it is the
      // whole point: hazard 33 forbids a fallback to a null account.
      missing.push(`scheme:${scheme.code}`);
      continue;
    }
    const payableId = byCode.get(payableCode) ?? null;
    const employerId = byCode.get(employerCode) ?? null;
    if (payableId === null) { missing.push(payableCode); continue; }
    if (employerId === null) missing.push(employerCode);

    const changed = await tx<{ id: string }[]>`
      update app.statutory_scheme
         set payable_account_id = coalesce(payable_account_id, ${payableId}),
             employer_expense_account_id = coalesce(employer_expense_account_id, ${employerId})
       where id = ${scheme.id}
         and (payable_account_id is null or employer_expense_account_id is null)
       returning id`;
    schemesLinked += changed.length;
  }

  return { componentsLinked, schemesLinked, missingCodes: [...new Set(missing)].sort() };
}
```

Add to `packages/db/src/index.ts`:

```ts
export { PAYROLL_ACCOUNT_CODES, linkPayrollAccounts, type PayrollAccountLinkage } from "./hr/accounts";
```

and to `packages/db/src/seed/index.ts` (the seed barrel, **never** the main barrel — §3.1, sah-039). **`LOADERS` is not touched**: this is an entry point, not a loader.

```ts
export { linkPayrollAccountsForTenant } from "./payroll-accounts";
```

- [ ] **Step 6: Write `docs/adr/0076-payroll-correction-is-a-supplementary-run.md` — a PROPOSAL**

spec:95 makes anything touching money semantics a proposal that is **asked** before implementing. This one is asked; the plan's default is what it proposes.

```markdown
# ADR 0076 — Correction of a posted PAYROLL is a supplementary run, not a `reverseDocument`

**Status:** Proposed — asked, not decided (spec:95: money semantics)
**Date:** 2026-09-05
**Slice:** 8B

## Context

spec:2081 says "Correction after posting is a reversal plus a supplementary run; nothing is edited in place
(SAH-041)". The `PAYROLL` policy must declare a `reversal` block — the schema requires it — and the value
decides which of the two halves of that sentence the system actually offers.

## Decision

`PAYROLL` declares `reversal: { "allowed": false, "producesType": null }`. A posted run is corrected by a
`supplementary` run carrying the delta.

Two independent mechanics forbid the reversal path, and either alone is decisive.

1. **The state machine.** `reverseDocument` creates a fresh **draft** mirror and calls `postDocument` on it in
   the same transaction. Contracts §4.3.2 step 2 admits a draft only when `draft → issued` is legal, and
   §4.5.1 makes that legal only when the effective policy has `approval.required = false`. PAYROLL's is
   `true` (spec:2172 R1 names PAYROLL first in its seeded list), so the inner post raises
   `ERR_DOC_STATUS_ILLEGAL`. Setting `approval.required = false` to make reversal work would delete
   maker ≠ checker for the highest-risk document in the system (SAH-032); letting the reversal skip the
   trigger is SAH-027.
2. **The extension rows.** `reverseDocument` copies `document_line` columns and knows nothing of
   `app.payroll_line`. Every mirrored line would resolve `line.component.kind` and `line.share` to `null`,
   match no policy rule, plan zero ledger lines, and raise `ERR_DOC_NO_LINES` at §4.3.2 step 6.

## Consequences

- `payroll_run.kind = 'supplementary'` is the correction path and is a first-class value in §4.12.6, not a
  workaround. The original run's posted lines, its `pinned_tables` and its ledger rows are never touched,
  which is what SAH-041 asks for and what acceptance test 29 asserts.
- The half of spec:2081 that says "a reversal" is **not** offered for PAYROLL. If the owner wants it, the
  cost is stated rather than hidden: `reverseDocument` gains a payroll-extension copy step, and the state
  machine gains a rule admitting a reversal of an `approval.required` type straight to `issued` under the
  *original* document's already-granted approval. Both are changes to frozen files (1A's `reverse.ts`, 2B's
  `app.document_status_before`) and belong in an amendment to the contracts document, not in this slice.
- A run posted **in error in its entirety** is corrected by a supplementary run that negates every line; the
  `account`-line debit twin (rule 7 of the policy) is what posts the negated net pay.
- Nothing about a *draft* changes: a draft or submitted run is recalculated in place (spec:2081, R3), which
  is Task 11.
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun run --cwd packages/db test -- payroll/accounts`
**Expected:** PASS (8 tests).

**Two failures worth naming in advance.** If `validatePolicy` reports `errors: [{ path: "/lines/0/dimensions/from/1", … }]`, the schema's `dimensions.from` enum does not contain `line.employee` — that means 2A's widening did not merge, and the fix is 2A's, not a narrowing here. If it reports a path under `/approval`, one of the three codes is absent from `PERMISSIONS` — Task 3 has not merged, and the two tasks must land in one PR for exactly that reason.

Then apply the pack against a real tenant, which is the task's own definition of done:

```bash
bun run --cwd packages/db src/cli.ts up
bun run seed --tenant "$DULJA_TEST_TENANT" --only chart-of-accounts --only document-types
bun run --cwd packages/db seed:payroll-accounts --tenant "$DULJA_TEST_TENANT" --company "$DULJA_TEST_COMPANY"
```

**Expected:** exit **0** from both (§4.2.13's frozen exit codes), the seed prints the eleven account rows and the `PAYROLL` type, and the wiring step prints how many components and schemes it linked. Exit **3** from the seed means a pack-shape violation — read `assertPackShape`'s message, which names the offending directory. From the wiring step, exit **2** means a missing flag or `DATABASE_URL` and exit **1** means it could not resolve an account code — the message names the code, and the fix is to run the seed line above first.

**The third line is not optional and is not a convenience.** 0C's `chartOfAccountsLoader` seeds the accounts; nothing in it sets `pay_component.expense_account_id`, `statutory_scheme.payable_account_id` or `employer_expense_account_id`, and a `PAYROLL` post against NULL columns fails at `ERR_POLICY_REQUIRES_MISSING`. **This line belongs in the release runbook beside the seed command** — the same PR that adds it to this plan adds it there.

- [ ] **Step 8: Commit**

```bash
git add packages/db/seed/my/chart-of-accounts/8b-payroll.json \
        packages/db/seed/my/document-types/PAYROLL.json \
        packages/db/src/seed/payroll-accounts.ts packages/db/src/seed/index.ts \
        packages/db/package.json \
        packages/db/src/hr/accounts.ts packages/db/src/index.ts \
        docs/adr/0076-payroll-correction-is-a-supplementary-run.md \
        packages/db/test/payroll/accounts.test.ts
git commit -m "$(cat <<'EOF'
feat(seed): the payroll chart, the account wiring and the PAYROLL type [8B T4]

The eleven §4.15 rows 8B owns, plus one presentation parent, plus the PAYROLL
document-type envelope. The file is applied by 0C's chartOfAccountsLoader —
LOADERS is keyed by SubPack, so a second chart-of-accounts loader could never be
reached (§3.4.8: add a file, never a loader). The wiring is therefore its own
entry point, seed:payroll-accounts, called by the runbook right after the seed:
linkPayrollAccounts sets 8A's pay components and statutory schemes from those
codes and never overwrites a value a tenant chose — so 8C's PAYROLL_PAYMENT and
EMPLOYEE_ADVANCE resolve 2400 and 1400 with no seed of their own (hazard 33).

Every policy rule declares dimensions.from WITHOUT document.branch: 2A's
dimensionsFor gives the header's BRANCH the last word, and spec:2101 wants the
EMPLOYEE's home branch on every line. dimensions.required refuses a line that
lost either tag rather than posting untagged.

ADR 0076 (a proposal): PAYROLL declares reversal.allowed = false. reverseDocument
posts a fresh DRAFT, which §4.5.1 refuses for an approval.required type, and it
copies no payroll_line, so every mirrored line would match no rule. Correction is
a supplementary run.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `packages/domain/payroll/` — the three `SchemeCalculator`s, and not one rate

**Files:**
- Create: `packages/domain/payroll/errors.ts`, `types.ts`
- Create: `packages/domain/payroll/schemes/banded-contribution.ts`, `percentage-with-ceiling.ts`, `progressive-schedule.ts`, `index.ts`
- Create: `docs/adr/0074-payroll-calculator-seam-and-rate-table-pinning.md`
- Create: `packages/domain/test/payroll/schemes.test.ts`
- **Modify (not create): `packages/domain/payroll/index.ts`** — **8A Task 9 creates this barrel** (`8a:4672`) and it already re-exports `RateTable`, `RateTableBands`, `RateTablePercentageWithCeiling`, `RateTableProgressive` from `./rate-table` and `RATE_TABLE_SCHEMA_ID`, `validateRateTable`, `parseRateTable`, `RateTableValidationError` from `./validate`. Every one of those eight names stays; this slice **appends** its own lines. Creating the file instead of appending deletes 8A's validator door and `packages/db/src/seed/statutory.ts` stops compiling.
- Modify: `packages/domain/package.json` (**assert-then-add only** — 8A's amendment A11 already adds `"./payroll"`), `scripts/lint/rules/no-number-money.ts` (one `ALLOWED` entry — amendment A14)
- Consumed and never edited: `packages/domain/payroll/rate-table.schema.json`, `rate-table.ts`, `validate.ts` (all three 8A Task 9)
- Test: `packages/domain/test/payroll/schemes.test.ts`, `tests/regression/sah-019.test.ts` (append)

**Interfaces:**
- Consumes: `Money`, `Money.of`, `Money.zero`, `Money.fromDecimal`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE` (§4.2.1, exported from `@dulja/domain`'s own `src/money/`), `Quantity` (§4.2.1), `Decimal` (`decimal.js`, D11), and **`RateTable`** — the committed type generated from `packages/domain/payroll/rate-table.schema.json` (8A, §4.12.3).
- Produces:

```ts
// packages/domain/payroll/index.ts — the ONE import path packages/db uses (amendment A8).
// 8A Task 9 CREATED this file; the first eight exports are ITS lines and are not rewritten here.
export type { RateTable, RateTableBands, RateTablePercentageWithCeiling, RateTableProgressive } from "./rate-table";   // 8A
export { RATE_TABLE_SCHEMA_ID, validateRateTable, parseRateTable, RateTableValidationError } from "./validate";        // 8A
// ── everything below this line is appended by 8B ────────────────────────────────────────────────
export { PayrollCalculationError, type PayrollErrorCode } from "./errors";
export type { RateTableKind, BandedTable, PercentageTable, ProgressiveTable } from "./types";
export type { EmployeePeriodInput, PayPeriod, RateTableRef, SchemeResult, EmployeeResult, PayrollCalculator } from "./types";
export type { SchemeCalculator } from "./types";
export { calculators } from "./schemes";
export { payrollCalculator } from "./calculator";      // Task 6
```

**`RateTable` is exported once, from `./rate-table`, and 8B does not re-export it from `./types`.** 8A's line is already there; a second `export type { RateTable } from "./types"` in the same barrel is a duplicate-export TypeScript error (TS2308), not a harmless repetition. `payroll/types.ts` still *imports* `RateTable` from `./rate-table` for its own interfaces (Step 4) — that is an import, not a barrel export.

- [ ] **Step 1: Assert what 8A shipped, and generate the type if it did not**

Run:

```bash
ls packages/domain/payroll/
grep -n "export type" packages/domain/payroll/index.ts
node -e "console.log(JSON.stringify(require('./packages/domain/package.json').exports))"
```

**Expected — five things, all of them 8A's Task 9 (`8a:4663`, `8a:4672`, `8a:4851`), none of them written here:**

| What | Where | 8B's relationship to it |
|---|---|---|
| `payroll/rate-table.schema.json` | 8A T9, §4.12.3 verbatim | consumed; never edited |
| `payroll/rate-table.ts` (**generated, committed**) | 8A T9 | the `RateTable` type this slice's calculators take |
| `payroll/validate.ts` | 8A T9 | `validateRateTable`, `parseRateTable`, `RateTableValidationError`, `RATE_TABLE_SCHEMA_ID` — untouched |
| `payroll/index.ts` with **eight** exports | 8A T9 | **this task appends to it; it is a Modify, not a Create** |
| `"exports": { ".": …, "./payroll": "./payroll/index.ts" }` | 8A T9, its amendment A11 | **already present — assert it, do not re-add it** |

**If `ls` shows an empty or absent `packages/domain/payroll/`, stop.** 8A has not merged and this slice's phase gate is unmet; §4.12.3 assigns the schema to 8A and hand-writing a second `RateTable` shape beside it is hazard 32.

**If the directory holds `rate-table.schema.json` but no generated type**, 8A shipped the schema without generating from it. Add the generator the same way 1A did for `PostingPolicy` (§4.4.1), reusing the shared options module so the drift guard and the generator cannot disagree — and write it to **`payroll/rate-table.ts`**, the name 8A's own barrel imports from, never a second one:

```json
// packages/domain/package.json — scripts, beside the existing "policy:types"
"rate-table:types": "bun run scripts/generate-rate-table-type.ts"
```

```ts
// packages/domain/scripts/generate-rate-table-type.ts
import { compileFromFile } from "json-schema-to-typescript";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_TYPE_BANNER, POLICY_TYPE_OPTIONS } from "./policy-type-options";

const root = join(import.meta.dirname, "..");
const ts = await compileFromFile(join(root, "payroll/rate-table.schema.json"), {
  ...POLICY_TYPE_OPTIONS, bannerComment: POLICY_TYPE_BANNER,
});
writeFileSync(join(root, "payroll/rate-table.ts"), ts, "utf8");
```

Record it as a plan-side note in the Self-Review; do **not** hand-write a second `RateTable` shape beside 8A's schema — two spellings of one closed vocabulary is hazard 32.

- [ ] **Step 2: Assert the `"./payroll"` export subpath (A8), and add `"rateTableVersion"` to `no-number-money`'s `ALLOWED` (A14)**

**Assert first; add only if 8A merged without it.** 8A's amendment A11 files this row and 8A Task 9 makes the edit (`8a:233`, `8a:4851`), so on a repository where 8A merged the expected state is already:

```json
// packages/domain/package.json — "exports". THIS IS 8A's LINE. Assert it; keep every existing entry.
{
  "exports": {
    ".": "./src/index.ts",
    "./payroll": "./payroll/index.ts"
  }
}
```

```bash
node -e "const e=require('./packages/domain/package.json').exports; if(e['./payroll']!=='./payroll/index.ts') { console.error('MISSING'); process.exit(1) } console.log('present')"
```

**Expected:** `present`. If it prints `MISSING`, add exactly the one `"./payroll"` line above and say so in the commit body — that is the only circumstance in which 8B writes this key, and amendment A8 exists to make the duplicate claim visible to the contracts editor rather than silent.

Then the one lint entry, in the same commit as the file that needs it:

```ts
// scripts/lint/rules/no-number-money.ts — the ONE entry 8B adds to the set 0D shipped empty.
export const ALLOWED: ReadonlySet<string> = new Set<string>([
  // 8B (amendment A14). Contracts §4.12.1 freezes `SchemeResult.rateTableVersion: number` — it is a rate
  // TABLE's version number, an integer identity, and never a monetary value. MONEYISH matches it on the
  // substring "rate". The name is consumed by 8C and 8D, so renaming is not open to this slice.
  "rateTableVersion",
]);
```

**Read the set before editing it.** 0D shipped it empty (0d:1334–1337) and documented every entry as "a review conversation"; if another slice has already added members, **append** and keep theirs. This is the only entry 8B adds — `packages/db`, `tests/**` and `*.test.tsx` are outside `IN_SCOPE`/inside `EXCLUDED` (0d:1330–1331), and `packages/contracts/src/hr/payroll-run.ts` writes `z.number().int()`, a call expression the rule does not read. Step 5 is the first file that trips it, which is why the entry lands here rather than later.

**Why a second entry point and not a folder under `src/`.** spec:2366 says of `packages/domain`: "`payroll/`: the statutory calculators and the rate-table JSON schema (§3.10); **core never imports HR**." `scripts/lint/rules/dependency-rule.ts` (0B) enforces exactly `packages/domain/src/**` ↛ `packages/domain/payroll/**` (§3.1). Keeping the calculators outside `src/` is what makes that rule a path comparison rather than a judgement, and the subpath is what gives `packages/db` an import path at all.

- [ ] **Step 3: Write the failing test `packages/domain/test/payroll/schemes.test.ts`**

Every figure below is invented for this test and is **not** any authority's. The two non-`SYNTH` tables are in-memory objects and never reach a seed file.

```ts
import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src/index";
import { PayrollCalculationError, calculators, type RateTable } from "../../payroll/index";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);
const PERIOD = { start: "2026-01-01", end: "2026-01-31", payDate: "2026-02-05", prorationRule: "calendar_days" as const };

/** The synthetic table of §4.12.4, as an object. Bands, not rates: nothing here resembles any authority's. */
const BANDED: RateTable = {
  schema_version: 1, scheme: "SYNTH", version: 1, kind: "banded_contribution",
  effective_from: "2026-01-01", effective_to: null,
  source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/synth", retrieved_on: "2026-01-01" },
  verification: { verified_by: "Dulja test fixture", verified_on: "2026-01-01", method: "synthetic_test" },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  table: { bands: [
    { from: "0",    to: "1000", employee: "10.0000",  employer: "20.0000"  },
    { from: "1000", to: "5000", employee: "50.0000",  employer: "100.0000" },
    { from: "5000", to: null,   employee: "250.0000", employer: "500.0000" },
  ] },
};

const PERCENTAGE: RateTable = {
  schema_version: 1, scheme: "SYNTH_PCT", version: 1, kind: "percentage_with_ceiling",
  effective_from: "2026-01-01", effective_to: null,
  source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/pct", retrieved_on: "2026-01-01" },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  table: { employee_rate: "0.1", employer_rate: "0.2", ceiling: "2000.0000", floor: "100.0000" },
};

const PROGRESSIVE: RateTable = {
  schema_version: 1, scheme: "SYNTH_PRG", version: 1, kind: "progressive_schedule",
  effective_from: "2026-01-01", effective_to: null,
  source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/prg", retrieved_on: "2026-01-01" },
  rounding_mode: "HALF_EVEN",
  required_profile_fields: ["child_relief_count"],
  table: {
    brackets: [
      { from: "0",    to: "1000", rate: "0",   cumulative: "0"        },
      { from: "1000", to: "3000", rate: "0.1", cumulative: "0"        },
      { from: "3000", to: null,   rate: "0.2", cumulative: "200.0000" },
    ],
    reliefs: { child_relief_count: "100.0000" },
  },
};

describe("SchemeCalculator — three kinds, and not one rate in code (spec:2080, hazard 1)", () => {
  it("banded_contribution reads the band containing the base, half-open [from, to)", () => {
    const c = calculators.banded_contribution;
    expect(c.compute(BANDED, { base: m("999.9999"), profile: {}, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("10.0000"), employerShare: m("20.0000") });
    expect(c.compute(BANDED, { base: m("1000.0000"), profile: {}, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("50.0000"), employerShare: m("100.0000") });
    expect(c.compute(BANDED, { base: m("999999.0000"), profile: {}, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("250.0000"), employerShare: m("500.0000") });
  });

  it("banded_contribution REFUSES a base no band covers rather than returning zero (SAH-011)", () => {
    const gap: RateTable = { ...BANDED, table: { bands: [{ from: "1000", to: "5000", employee: "1.0000", employer: "2.0000" }] } };
    expect(() => calculators.banded_contribution.compute(gap, { base: m("10.0000"), profile: {}, ytd: {}, period: PERIOD }))
      .toThrow(new PayrollCalculationError("ERR_PAYROLL_INPUT_MISSING",
        "rate table SYNTH v1 has no band covering a base of 10.0000; a contribution base outside every band is a gap in the table, never a zero contribution"));
  });

  it("percentage_with_ceiling caps at the ceiling and floors at the floor, then applies the declared mode", () => {
    const c = calculators.percentage_with_ceiling;
    expect(c.compute(PERCENTAGE, { base: m("1000.0000"), profile: {}, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("100.0000"), employerShare: m("200.0000") });
    // Above the ceiling: the ceiling is the base.
    expect(c.compute(PERCENTAGE, { base: m("9999.0000"), profile: {}, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("200.0000"), employerShare: m("400.0000") });
    // Below the floor: the floor is the base.
    expect(c.compute(PERCENTAGE, { base: m("1.0000"), profile: {}, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("10.0000"), employerShare: m("20.0000") });
  });

  it("percentage_with_ceiling applies the TABLE's declared rounding mode, and the two modes DISAGREE here (SAH-019)", () => {
    // The rate is chosen so the product is exactly `0.33325` — a tie at the fourth decimal whose preceding
    // digit is EVEN. That is the only input shape on which the two modes differ, and a case where they agree
    // (a tie behind an odd digit, say) would pass even if the calculators ignored `rounding_mode` entirely
    // and always rounded HALF_AWAY_FROM_ZERO. SAH-019's fix is "one rounding function, EXPLICIT mode", so
    // the assertion has to be able to see the mode.
    const halfUp: RateTable = { ...PERCENTAGE, rounding_mode: "HALF_AWAY_FROM_ZERO",
      table: { employee_rate: "0.33325", employer_rate: "0", ceiling: null, floor: null } };
    const halfEven: RateTable = { ...halfUp, rounding_mode: "HALF_EVEN" };
    expect(calculators.percentage_with_ceiling.compute(halfUp, { base: m("1.0000"), profile: {}, ytd: {}, period: PERIOD }).employeeShare)
      .toEqual(m("0.3333"));   // 0.33325 → away from zero → .3333
    expect(calculators.percentage_with_ceiling.compute(halfEven, { base: m("1.0000"), profile: {}, ytd: {}, period: PERIOD }).employeeShare)
      .toEqual(m("0.3332"));   // 0.33325 → to even → .3332, because the digit before the tie is 2
  });

  it("progressive_schedule subtracts reliefs by the profile's multiplier, then walks the brackets", () => {
    const c = calculators.progressive_schedule;
    // chargeable 3200 − (2 × 100) = 3000 → bracket 3 → 200 + (3000 − 3000) × 0.2 = 200.
    expect(c.compute(PROGRESSIVE, { base: m("3200.0000"), profile: { child_relief_count: 2 }, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("200.0000"), employerShare: Money.zero(MYR) });
    // chargeable 2000 − 0 = 2000 → bracket 2 → 0 + (2000 − 1000) × 0.1 = 100.
    expect(c.compute(PROGRESSIVE, { base: m("2000.0000"), profile: { child_relief_count: 0 }, ytd: {}, period: PERIOD }))
      .toEqual({ employeeShare: m("100.0000"), employerShare: Money.zero(MYR) });
  });

  it("progressive_schedule NEVER returns a negative charge — relief beyond the chargeable amount floors at zero", () => {
    expect(calculators.progressive_schedule
      .compute(PROGRESSIVE, { base: m("50.0000"), profile: { child_relief_count: 9 }, ytd: {}, period: PERIOD }).employeeShare)
      .toEqual(Money.zero(MYR));
  });

  it("progressive_schedule REFUSES a missing required profile field, naming it (SAH-011, test 33)", () => {
    expect(() => calculators.progressive_schedule
      .compute(PROGRESSIVE, { base: m("3200.0000"), profile: { child_relief_count: null }, ytd: {}, period: PERIOD }))
      .toThrow(new PayrollCalculationError("ERR_PAYROLL_INPUT_MISSING",
        "rate table SYNTH_PRG v1 requires statutory input 'child_relief_count' and the value is null"));
  });

  it("`calculators` covers exactly the three kinds the §4.12.3 schema admits, and no fourth", () => {
    expect(Object.keys(calculators).sort()).toEqual(
      ["banded_contribution", "percentage_with_ceiling", "progressive_schedule"]);
    for (const [kind, c] of Object.entries(calculators)) expect(c.kind).toBe(kind);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun run --cwd packages/domain test -- payroll/schemes`
**Expected:** the whole file fails at import with

```
Error: Failed to resolve import "../../payroll/index" from "test/payroll/schemes.test.ts"
```

- [ ] **Step 5: Write `packages/domain/payroll/errors.ts` and `types.ts`**

```ts
// packages/domain/payroll/errors.ts
/**
 * The payroll package's ONE error class. `packages/domain` may not import `AppError` from `@dulja/contracts`
 * (§3.1's dependency rule), exactly as `PolicyEvaluationError` (§4.4.2) and `PostingError` (§4.2.4) exist for
 * the same reason. `apps/api/src/problem.ts` gains one `asAppError` branch translating it (amendment A9).
 *
 * The union is a literal SUBSET of `ErrCode` and never a new code: both members are allocated in §4.2.4.
 */
export type PayrollErrorCode = "ERR_PAYROLL_RATE_TABLE_UNVERIFIED" | "ERR_PAYROLL_INPUT_MISSING";

export class PayrollCalculationError extends Error {
  constructor(readonly code: PayrollErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "PayrollCalculationError";
  }
}
```

```ts
// packages/domain/payroll/types.ts — §4.12.1 verbatim, plus the RateTable narrowings the calculators need.
import type { Money, Quantity, RoundingMode } from "../src/index";

// The committed type generated from `payroll/rate-table.schema.json` (8A, §4.12.3). Re-exported here so the
// six types below read from one module, and the schema stays the single source of the vocabulary.
// NOTE: this re-export is for callers INSIDE payroll/ only. `index.ts` must NOT forward it — 8A's barrel
// line already exports `RateTable` from "./rate-table", and a second export of the name is TS2308.
export type { RateTable } from "./rate-table";

import type { RateTable } from "./rate-table";
export type RateTableKind = RateTable["kind"];
/** The three `table` shapes the schema's `oneOf` admits, narrowed for the three calculators. */
export type BandedTable = Extract<RateTable["table"], { bands: unknown }>;
export type PercentageTable = Extract<RateTable["table"], { employee_rate: unknown }>;
export type ProgressiveTable = Extract<RateTable["table"], { brackets: unknown }>;

export interface EmployeePeriodInput {
  employeeId: string;
  branchId: string;
  hiredOn: string;
  terminatedOn: string | null;
  /** The §4.12.3 `required_profile_fields` a scheme declares are looked up here. ⚠️ OD-28 fixes the list. */
  statutoryProfile: Record<string, string | number | boolean | null>;
  compensation: {
    componentId: string;
    kind: "earning" | "deduction";
    /** For a quantity-based component this is the PER-UNIT rate; for a fixed one, the period amount. */
    amount: Money | null;
    quantity: Quantity | null;
    /** The schemes this component feeds, from `pay_component_scheme` — never a "subject to X" boolean (RC-3). */
    schemeIds: string[];
  }[];
  manualOverrides: { schemeId: string; share: "employee" | "employer"; amount: Money; reason: string }[];
}

export interface PayPeriod {
  start: string; end: string; payDate: string;
  prorationRule: "calendar_days" | "working_days";
}

export interface RateTableRef {
  schemeId: string; schemeCode: string; version: number;
  effectiveFrom: string; effectiveTo: string | null;
  definition: RateTable;
  verified: boolean;
}

export interface SchemeResult {
  schemeId: string; schemeCode: string; rateTableVersion: number;
  employeeShare: Money; employerShare: Money; base: Money; roundingMode: RoundingMode;
}

export interface EmployeeResult {
  employeeId: string;
  gross: Money;
  earnings: { componentId: string; amount: Money }[];
  deductions: { componentId: string; amount: Money }[];
  schemes: SchemeResult[];
  net: Money;
  /**
   * The running totals AFTER this run. Key space, fixed here so 8C's `employee_ytd` and 8D's statements read
   * one vocabulary: `"gross"`, `"net"`, and `"<schemeCode>.employee"` / `"<schemeCode>.employer"` per scheme.
   */
  ytdAfter: Record<string, Money>;
}

export interface PayrollCalculator {
  /**
   * Pure. Refuses (`ERR_PAYROLL_RATE_TABLE_UNVERIFIED`) any table with `verified = false` or whose
   * `[effectiveFrom, effectiveTo]` does not cover the pay period; refuses (`ERR_PAYROLL_INPUT_MISSING`,
   * naming `employeeId` and the field) any NULL statutory input a scheme's definition declares required;
   * applies each scheme's declared rounding mode; **never contains a rate, threshold or ceiling.**
   */
  calculate(input: {
    period: PayPeriod;
    employees: EmployeePeriodInput[];
    rateTables: RateTableRef[];
    ytdBefore: Record<string, Record<string, Money>>;
  }): { employees: EmployeeResult[]; pinnedTables: { schemeId: string; version: number }[] };
}

export interface SchemeCalculator {
  readonly kind: RateTableKind;
  compute(
    table: RateTable,
    input: {
      base: Money;
      profile: EmployeePeriodInput["statutoryProfile"];
      ytd: Record<string, Money>;
      period: PayPeriod;
    },
  ): { employeeShare: Money; employerShare: Money };
}
```

- [ ] **Step 6: Write the three calculators**

```ts
// packages/domain/payroll/schemes/banded-contribution.ts
import Decimal from "decimal.js";
import { Money } from "../../src/index";
import { PayrollCalculationError } from "../errors";
import type { BandedTable, RateTable, SchemeCalculator } from "../types";

const DEFAULT_MODE = "HALF_AWAY_FROM_ZERO" as const;

/**
 * A table of bands, each carrying the employee and employer amount for a base inside it. The band is
 * half-open `[from, to)`; `to: null` is the open top band. **Every figure comes out of `table`.**
 */
export const bandedContribution: SchemeCalculator = {
  kind: "banded_contribution",
  compute(table: RateTable, { base }) {
    const bands = (table.table as BandedTable).bands;
    const value = base.toDecimal();
    const band = bands.find((b) => {
      const from = new Decimal(b.from);
      const to = b.to === null ? null : new Decimal(b.to);
      return value.greaterThanOrEqualTo(from) && (to === null || value.lessThan(to));
    });
    if (band === undefined) {
      // A gap in the table is a gap, never a zero contribution. SAH-011 is exactly the failure where an
      // absent input becomes 0 and the figure is wrong for ever.
      throw new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `rate table ${table.scheme} v${table.version} has no band covering a base of ${base.toString()}; ` +
          "a contribution base outside every band is a gap in the table, never a zero contribution",
      );
    }
    const mode = table.rounding_mode ?? DEFAULT_MODE;
    return {
      employeeShare: Money.fromDecimal(new Decimal(band.employee), base.currency, mode),
      employerShare: Money.fromDecimal(new Decimal(band.employer), base.currency, mode),
    };
  },
};
```

```ts
// packages/domain/payroll/schemes/percentage-with-ceiling.ts
import Decimal from "decimal.js";
import { Money } from "../../src/index";
import type { PercentageTable, RateTable, SchemeCalculator } from "../types";

const DEFAULT_MODE = "HALF_AWAY_FROM_ZERO" as const;

/**
 * `share = clamp(base, floor, ceiling) × rate`, rounded once with the table's declared mode.
 *
 * The clamp happens BEFORE the multiplication and the rounding happens ONCE, at the end — SAH-019's fix is
 * "one rounding function, explicit mode, applied at persist time", and rounding an intermediate would give
 * two implementations two answers.
 */
export const percentageWithCeiling: SchemeCalculator = {
  kind: "percentage_with_ceiling",
  compute(table: RateTable, { base }) {
    const t = table.table as PercentageTable;
    const mode = table.rounding_mode ?? DEFAULT_MODE;
    let value = base.toDecimal();
    if (t.floor !== null && t.floor !== undefined && value.lessThan(new Decimal(t.floor))) value = new Decimal(t.floor);
    if (t.ceiling !== null && t.ceiling !== undefined && value.greaterThan(new Decimal(t.ceiling))) value = new Decimal(t.ceiling);
    return {
      employeeShare: Money.fromDecimal(value.times(new Decimal(t.employee_rate)), base.currency, mode),
      employerShare: Money.fromDecimal(value.times(new Decimal(t.employer_rate)), base.currency, mode),
    };
  },
};
```

```ts
// packages/domain/payroll/schemes/progressive-schedule.ts
import Decimal from "decimal.js";
import { MONEY_SCALE, Money } from "../../src/index";
import { PayrollCalculationError } from "../errors";
import type { EmployeePeriodInput, ProgressiveTable, RateTable, SchemeCalculator } from "../types";

const DEFAULT_MODE = "HALF_AWAY_FROM_ZERO" as const;

/**
 * The multiplier a profile value contributes to its relief. Total and explicit, so a profile shape nobody
 * anticipated becomes a refusal rather than a silent zero.
 */
function multiplier(
  table: RateTable, key: string, value: EmployeePeriodInput["statutoryProfile"][string] | undefined,
): Decimal {
  if (value === undefined || value === null) {
    throw new PayrollCalculationError(
      "ERR_PAYROLL_INPUT_MISSING",
      `rate table ${table.scheme} v${table.version} requires statutory input '${key}' and the value is ${value === undefined ? "absent" : "null"}`,
    );
  }
  if (typeof value === "number") return new Decimal(value);
  if (typeof value === "boolean") return value ? new Decimal(1) : new Decimal(0);
  // A string profile value is a category, not a count: present and non-empty means the relief applies once.
  return value.length > 0 ? new Decimal(1) : new Decimal(0);
}

/**
 * `chargeable = base − Σ reliefs`, then the bracket containing `chargeable`:
 * `charge = cumulative + (chargeable − from) × rate`, floored at zero, rounded once with the declared mode.
 *
 * **It computes on the PERIOD's chargeable amount as supplied in `base` and makes no annualisation claim.**
 * spec:2080 forbids this document from stating a method; if the accountant's verified method annualises
 * (OD-23, OD-28), the rate table gains a fourth `kind` through §4.12.3 and its own calculator, and this one
 * is untouched. `ytd` is in the frozen `SchemeCalculator` signature and is deliberately unread here for the
 * same reason.
 */
export const progressiveSchedule: SchemeCalculator = {
  kind: "progressive_schedule",
  compute(table: RateTable, { base, profile }) {
    const t = table.table as ProgressiveTable;
    const mode = table.rounding_mode ?? DEFAULT_MODE;

    let relief = new Decimal(0);
    for (const [key, amount] of Object.entries(t.reliefs)) {
      relief = relief.plus(new Decimal(amount).times(multiplier(table, key, profile[key])));
    }
    let chargeable = base.toDecimal().minus(relief);
    if (chargeable.lessThan(0)) chargeable = new Decimal(0);

    const bracket = t.brackets.find((b) => {
      const from = new Decimal(b.from);
      const to = b.to === null ? null : new Decimal(b.to);
      return chargeable.greaterThanOrEqualTo(from) && (to === null || chargeable.lessThan(to));
    });
    if (bracket === undefined) {
      throw new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `rate table ${table.scheme} v${table.version} has no bracket covering a chargeable amount of ${chargeable.toFixed(MONEY_SCALE)}; ` +
          "a chargeable amount outside every bracket is a gap in the table, never a zero charge",
      );
    }
    let charge = new Decimal(bracket.cumulative)
      .plus(chargeable.minus(new Decimal(bracket.from)).times(new Decimal(bracket.rate)));
    if (charge.lessThan(0)) charge = new Decimal(0);

    return {
      employeeShare: Money.fromDecimal(charge, base.currency, mode),
      employerShare: Money.zero(base.currency),
    };
  },
};
```

```ts
// packages/domain/payroll/schemes/index.ts
import { bandedContribution } from "./banded-contribution";
import { percentageWithCeiling } from "./percentage-with-ceiling";
import { progressiveSchedule } from "./progressive-schedule";
import type { RateTableKind, SchemeCalculator } from "../types";

/** Exactly the three kinds §4.12.3's `kind` enum admits. A fourth is a schema change, not a code change. */
export const calculators: Record<RateTableKind, SchemeCalculator> = {
  banded_contribution: bandedContribution,
  percentage_with_ceiling: percentageWithCeiling,
  progressive_schedule: progressiveSchedule,
};
```

```ts
// packages/domain/payroll/index.ts — the barrel (amendment A8).
// APPEND these lines to the file 8A Task 9 created; do not remove, reorder or rewrite the two export
// statements already there (the `./rate-table` types and the `./validate` values, 8a:4672–4674).
// `RateTable` is deliberately ABSENT from the list below: 8A already exports it from "./rate-table",
// and exporting the same name twice from one barrel is TS2308, not a harmless repetition.
export { PayrollCalculationError, type PayrollErrorCode } from "./errors";
export type {
  BandedTable, EmployeePeriodInput, EmployeeResult, PayPeriod, PayrollCalculator, PercentageTable,
  ProgressiveTable, RateTableKind, RateTableRef, SchemeCalculator, SchemeResult,
} from "./types";
export { calculators } from "./schemes";
```

**Verify the append rather than trusting it**, because a barrel that lost 8A's lines still typechecks inside `packages/domain` and only fails later, in `packages/db/src/seed/statutory.ts`:

```bash
grep -c "from \"./validate\"" packages/domain/payroll/index.ts   # expected: 1
grep -c "from \"./rate-table\"" packages/domain/payroll/index.ts # expected: 1
grep -c "RateTable\b" packages/domain/payroll/index.ts           # expected: >= 1, all on 8A's line
bun run typecheck
```

- [ ] **Step 7: Write `docs/adr/0074-payroll-calculator-seam-and-rate-table-pinning.md`**

```markdown
# ADR 0074 — The payroll calculator is pure, the rates are data, and every line pins its version

**Status:** Accepted
**Date:** 2026-09-05
**Slice:** 8B

## Context

spec:2080: "This document states no rate, threshold, ceiling or formula." spec:2229 asks for "EPF, SOCSO, EIS
and PCB/MTD as versioned, effective-dated, **verified** rate tables pinned per payroll line". SAH-020 is a
legacy GST return that hard-coded a rate; SAH-013 is a legacy reversal that re-read *current* flags instead
of what was originally applied. Both failures are the same shape: a figure that lives in code, or a figure
that is re-derived at read time.

## Decision

Three seams, and no fourth.

1. **`packages/domain/payroll/` is pure and outside `src/`.** It imports `decimal.js` through `@dulja/domain`'s
   own money module and nothing else, and `packages/domain/src/**` may not import it (spec:2366, enforced by
   `dependency-rule`). `@dulja/domain/payroll` is its one import path.
2. **Every number comes out of a `RateTable`.** `SchemeCalculator.compute(table, input)` reads bands,
   rates, ceilings, brackets and reliefs from `table` and holds none of its own. There are exactly three
   calculators, one per `kind` the §4.12.3 schema admits; a fourth statutory shape is a schema change with a
   new `kind` label, not an `if` inside an existing calculator.
3. **A run pins what it used.** `PayrollCalculator.calculate` returns `pinnedTables`, and the run service
   writes `payroll_run.pinned_tables` and `payroll_line.rate_table_id` / `rate_table_version`. Nothing
   re-reads `statutory_rate_table` for a posted line, ever. That is SAH-013's fix applied to statutory rates.

Refusals rather than defaults: a table with `verified = false`, or whose effective range does not cover the
pay period, raises `ERR_PAYROLL_RATE_TABLE_UNVERIFIED`; a required statutory input that is `null` raises
`ERR_PAYROLL_INPUT_MISSING` naming the employee and the field; a base outside every band, or a chargeable
amount outside every bracket, raises `ERR_PAYROLL_INPUT_MISSING` naming the table. **No calculator returns
zero for an input it does not understand** — SAH-011 is precisely the failure where a NULL became a figure.

## Consequences

- Golden tests run on the clearly synthetic `SYNTH` table (§4.12.4) and on in-memory tables built in the test
  file. No file exists under `packages/db/seed/my/statutory/` until OD-23 supplies verified tables with
  `source`, `loaded_by` and `verified_by`.
- The `progressive_schedule` calculator computes on the period's chargeable amount and makes no annualisation
  claim. If the accountant's verified method annualises, that is a fourth `kind` in §4.12.3 and a fourth
  calculator, and these three are untouched.
- `SchemeCalculator.compute` receives `ytd` and `period` and the three shipped calculators read neither. The
  parameters are in §4.12.1's frozen signature so a later `kind` that needs them does not change the seam.
- Rounding is the table's declared `rounding_mode`, applied **once**, through `@dulja/domain`'s one `round`
  (SAH-019). The scheme row's own `rounding_mode` (8A, §4.6.1) is what the run service copies into a
  definition that omits the optional member, so the pure calculator stays total.
```

- [ ] **Step 8: Append the 8B block to `tests/regression/sah-019.test.ts`**

The file is 0B's (§3.7.3's structural list). Append a `describe`; edit no earlier block.

```ts
// tests/regression/sah-019.test.ts — APPEND
import { Money, currency } from "@dulja/domain";
import { calculators, type RateTable } from "@dulja/domain/payroll";

describe("SAH-019 Rounding is configured everywhere, applied nowhere, and the one rounding function is wrong — 8B", () => {
  const MYR = currency("MYR");
  const table = (mode: RateTable["rounding_mode"]): RateTable => ({
    schema_version: 1, scheme: "SYNTH_ROUND", version: 1, kind: "percentage_with_ceiling",
    effective_from: "2026-01-01", effective_to: null,
    source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/r", retrieved_on: "2026-01-01" },
    rounding_mode: mode,
    table: { employee_rate: "0.5", employer_rate: "0.5", ceiling: null, floor: null },
  });
  const period = { start: "2026-01-01", end: "2026-01-31", payDate: "2026-02-05", prorationRule: "calendar_days" as const };

  it("the scheme's declared mode is what is applied, and it is symmetric across sign", () => {
    // 0.0001 × 0.5 = 0.00005 → the fourth decimal is decided by the MODE and by nothing else.
    const away = calculators.percentage_with_ceiling
      .compute(table("AWAY_FROM_ZERO"), { base: Money.of("0.0001", MYR), profile: {}, ytd: {}, period });
    const toward = calculators.percentage_with_ceiling
      .compute(table("TOWARD_ZERO"), { base: Money.of("0.0001", MYR), profile: {}, ytd: {}, period });
    expect(away.employeeShare.toString()).toBe("0.0001");
    expect(toward.employeeShare.toString()).toBe("0.0000");
  });

  it("there is exactly ONE rounding implementation reachable from the payroll package", async () => {
    // The legacy system had a rounding setting per screen and a rounding function that was wrong. The fix is
    // structural: every calculator calls Money.fromDecimal, which calls @dulja/domain's one `round`.
    const src = await Promise.all(
      ["banded-contribution", "percentage-with-ceiling", "progressive-schedule"].map((f) =>
        repoFile(`packages/domain/payroll/schemes/${f}.ts`)));
    for (const text of src) {
      expect(text).toContain("Money.fromDecimal");
      expect(text).not.toMatch(/\.toFixed\(4\)|Math\.round|toDecimalPlaces\(/);
    }
  });
});
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test -- payroll/schemes`
**Expected:** PASS (8 tests).

Run: `bun run --cwd tests test -- sah-019`
**Expected:** PASS, with the 8B block's 2 new cases beside whatever earlier slices appended.

Run: `bun run lint:rules`
**Expected:** zero violations. Two rules are load-bearing here. **`no-number-money`** must be silent on `packages/domain/payroll/types.ts`; if it reports `rateTableVersion`, Step 2's `ALLOWED` entry is missing — add it, do not rename the frozen §4.12.1 member. And **no `dependency-rule` violation**, which is the check that proves `packages/domain/src/**` still imports nothing from `packages/domain/payroll/**`. If it reports one on `payroll/types.ts` importing `../src/index`, read the rule: the prohibition is one-directional (spec:2366, §3.1), and a rule that fires on the *allowed* direction is a bug in the rule, not in this file. Say so in the commit body and fix the rule.

Run: `bun run typecheck` at the root.

- [ ] **Step 10: Commit**

```bash
git add packages/domain/payroll packages/domain/package.json \
        scripts/lint/rules/no-number-money.ts \
        packages/domain/test/payroll/schemes.test.ts \
        docs/adr/0074-payroll-calculator-seam-and-rate-table-pinning.md \
        tests/regression/sah-019.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): the three statutory scheme calculators, and not one rate [8B T5]

packages/domain/payroll/ sits OUTSIDE src/ so spec:2366's "core never imports
HR" is a path comparison the dependency-rule lint can make, and @dulja/domain
gains the "./payroll" subpath as its one import path.

Three calculators, one per `kind` the §4.12.3 schema admits. Every band, rate,
ceiling, bracket and relief comes out of the RateTable handed in; a fourth
statutory shape is a schema change, not an `if`. A base outside every band and a
required profile field that is null both REFUSE naming the table — SAH-011 is
exactly the failure where an absent input silently became a figure.

ADR 0074. Rounding is the table's declared mode applied once through the one
`round` (SAH-019), and the regression block proves no calculator rounds twice.

no-number-money's ALLOWED gains exactly one entry, "rateTableVersion" — a rate
table's version NUMBER, frozen as `number` by contracts §4.12.1 and matched by
MONEYISH on the substring "rate" (amendment A14). 0D shipped the set empty as
the escape hatch for this case; renaming is closed to us because 8C and 8D
consume the name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `PayrollCalculator.calculate` — the two refusals, the pinning, and the two `ERRORS` rows

**Files:**
- Create: `packages/domain/payroll/calculator.ts`, `packages/domain/payroll/period.ts`
- Create: `packages/domain/test/payroll/calculator.test.ts`
- Modify: `packages/domain/payroll/index.ts`, `packages/contracts/src/errors.ts`, `apps/api/src/problem.ts`
- Modify: `scripts/lint/rules/error-codes.ts` (one scan root — amendment A16, Step 7)
- Modify: `tests/regression/sah-011.test.ts`, `tests/regression/sah-020.test.ts`
- Test: `packages/domain/test/payroll/calculator.test.ts`

**Interfaces:**
- Consumes: `calculators`, `PayrollCalculationError`, and every type of Task 5; `Money`, `Money.zero`, `Money.of`, `Quantity`, `RoundingMode`, `round` (§4.2.1); `ERRORS` and `AppError` (§4.2.4, in `apps/api` only).
- Produces:

```ts
// packages/domain/payroll/calculator.ts
export const payrollCalculator: PayrollCalculator;
/** Exported for the proration task (T7) and for the run service's day-count reporting. */
export function periodDays(period: PayPeriod): number;
export function eligibleDays(period: PayPeriod, hiredOn: string, terminatedOn: string | null): number;
/** The proration factor, exact — a `Rational`-shaped pair, never a float. */
export function prorationFactor(period: PayPeriod, e: Pick<EmployeePeriodInput, "hiredOn" | "terminatedOn">):
  { numerator: number; denominator: number };
/** The `ytdAfter` / `ytdBefore` key space, as one function so 8C and 8D cannot spell a key two ways. */
export function ytdKey(part: "gross" | "net"): string;
export function schemeYtdKey(schemeCode: string, share: "employee" | "employer"): string;
```

- [ ] **Step 1: Write the failing test `packages/domain/test/payroll/calculator.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "../../src/index";
import {
  PayrollCalculationError, payrollCalculator, prorationFactor, schemeYtdKey, ytdKey,
  type EmployeePeriodInput, type PayPeriod, type RateTable, type RateTableRef,
} from "../../payroll/index";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);
const PERIOD: PayPeriod = { start: "2026-01-01", end: "2026-01-31", payDate: "2026-02-05", prorationRule: "calendar_days" };

const SYNTH: RateTable = {
  schema_version: 1, scheme: "SYNTH", version: 1, kind: "banded_contribution",
  effective_from: "2026-01-01", effective_to: null,
  source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/synth", retrieved_on: "2026-01-01" },
  verification: { verified_by: "Dulja test fixture", verified_on: "2026-01-01", method: "synthetic_test" },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  table: { bands: [
    { from: "0",    to: "1000", employee: "10.0000",  employer: "20.0000"  },
    { from: "1000", to: "5000", employee: "50.0000",  employer: "100.0000" },
    { from: "5000", to: null,   employee: "250.0000", employer: "500.0000" },
  ] },
};

const REF = (over: Partial<RateTableRef> = {}): RateTableRef => ({
  schemeId: "scheme-synth", schemeCode: "SYNTH", version: 1,
  effectiveFrom: "2026-01-01", effectiveTo: null, definition: SYNTH, verified: true, ...over,
});

const EMPLOYEE = (over: Partial<EmployeePeriodInput> = {}): EmployeePeriodInput => ({
  employeeId: "emp-1", branchId: "branch-hq", hiredOn: "2025-01-01", terminatedOn: null,
  statutoryProfile: {},
  compensation: [
    { componentId: "cmp-basic", kind: "earning", amount: m("2000.0000"), quantity: null, schemeIds: ["scheme-synth"] },
  ],
  manualOverrides: [],
  ...over,
});

describe("payrollCalculator.calculate (§4.12.1)", () => {
  it("gross, scheme shares and net are the arithmetic spec:2101 describes, and nothing more", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE()], rateTables: [REF()], ytdBefore: {},
    });
    const e = out.employees[0]!;
    expect(e.gross).toEqual(m("2000.0000"));
    expect(e.schemes).toEqual([{
      schemeId: "scheme-synth", schemeCode: "SYNTH", rateTableVersion: 1,
      employeeShare: m("50.0000"), employerShare: m("100.0000"), base: m("2000.0000"),
      roundingMode: "HALF_AWAY_FROM_ZERO",
    }]);
    // net = gross − deductions − employee shares. The EMPLOYER share never touches net.
    expect(e.net).toEqual(m("1950.0000"));
    expect(out.pinnedTables).toEqual([{ schemeId: "scheme-synth", version: 1 }]);
  });

  it("a deduction reduces net and an employer share does not", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD,
      employees: [EMPLOYEE({ compensation: [
        { componentId: "cmp-basic", kind: "earning",   amount: m("2000.0000"), quantity: null, schemeIds: ["scheme-synth"] },
        { componentId: "cmp-adv",   kind: "deduction", amount: m("300.0000"),  quantity: null, schemeIds: [] },
      ] })],
      rateTables: [REF()], ytdBefore: {},
    });
    const e = out.employees[0]!;
    expect(e.gross).toEqual(m("2000.0000"));            // gross is EARNINGS only
    expect(e.deductions).toEqual([{ componentId: "cmp-adv", amount: m("300.0000") }]);
    expect(e.net).toEqual(m("1650.0000"));              // 2000 − 300 − 50
  });

  it("the contribution BASE is the earnings joined to that scheme, never the whole gross (RC-3, spec:2079)", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD,
      employees: [EMPLOYEE({ compensation: [
        { componentId: "cmp-basic", kind: "earning", amount: m("900.0000"), quantity: null, schemeIds: ["scheme-synth"] },
        { componentId: "cmp-bonus", kind: "earning", amount: m("900.0000"), quantity: null, schemeIds: [] },
      ] })],
      rateTables: [REF()], ytdBefore: {},
    });
    const e = out.employees[0]!;
    expect(e.gross).toEqual(m("1800.0000"));
    expect(e.schemes[0]!.base).toEqual(m("900.0000"));  // the bonus is not joined to the scheme
    expect(e.schemes[0]!.employeeShare).toEqual(m("10.0000"));   // band 1, because 900 < 1000
  });

  it("a quantity-based component is amount × quantity and is NOT prorated", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD,
      employees: [EMPLOYEE({ compensation: [
        { componentId: "cmp-basic",  kind: "earning",   amount: m("3100.0000"), quantity: null, schemeIds: [] },
        { componentId: "cmp-unpaid", kind: "deduction", amount: m("100.0000"),  quantity: Quantity.of("3.000000"), schemeIds: [] },
      ] })],
      rateTables: [], ytdBefore: {},
    });
    expect(out.employees[0]!.deductions).toEqual([{ componentId: "cmp-unpaid", amount: m("300.0000") }]);
    expect(out.employees[0]!.net).toEqual(m("2800.0000"));
  });

  it("a quantity-based component with NO per-unit amount refuses, naming the employee (SAH-011)", () => {
    expect(() => payrollCalculator.calculate({
      period: PERIOD,
      employees: [EMPLOYEE({ compensation: [
        { componentId: "cmp-unpaid", kind: "deduction", amount: null, quantity: Quantity.of("3.000000"), schemeIds: [] },
      ] })],
      rateTables: [], ytdBefore: {},
    })).toThrow(new PayrollCalculationError("ERR_PAYROLL_INPUT_MISSING",
      "employee emp-1 has a quantity of 3.000000 on component cmp-unpaid and no per-unit amount; a quantity without a rate is not a zero line"));
  });

  it("an employee with NO compensation at all refuses too, and with the OTHER message", () => {
    // The two refusals are ordered: `assertComponentInputs` runs before `firstCurrency`, so the case above
    // gets the message naming its component and this one — the only case `firstCurrency` can still reach —
    // gets the currency message. If this case ever reports the component message, or the case above ever
    // reports this one, the two are running in the wrong order and SAH-011's diagnosis is the thing lost.
    expect(() => payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE({ compensation: [] })], rateTables: [], ytdBefore: {},
    })).toThrow(new PayrollCalculationError("ERR_PAYROLL_INPUT_MISSING",
      "employee emp-1 has no compensation line carrying an amount; a run cannot compute a currency from nothing"));
  });

  it("an UNVERIFIED table refuses the whole run, naming the scheme and version (test 29, spec:2080)", () => {
    expect(() => payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE()], rateTables: [REF({ verified: false })], ytdBefore: {},
    })).toThrow(new PayrollCalculationError("ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
      "rate table SYNTH v1 is not verified; a payroll run cannot pin an unverified table (spec:2080)"));
  });

  it("a table whose effective range does not COVER the period refuses (test 29, SAH-020)", () => {
    expect(() => payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE()],
      rateTables: [REF({ effectiveFrom: "2026-01-15", effectiveTo: null })], ytdBefore: {},
    })).toThrow(new PayrollCalculationError("ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
      "rate table SYNTH v1 is effective 2026-01-15..open and does not cover the pay period 2026-01-01..2026-01-31"));
    expect(() => payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE()],
      rateTables: [REF({ effectiveFrom: "2025-01-01", effectiveTo: "2026-01-20" })], ytdBefore: {},
    })).toThrow(new PayrollCalculationError("ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
      "rate table SYNTH v1 is effective 2025-01-01..2026-01-20 and does not cover the pay period 2026-01-01..2026-01-31"));
  });

  it("a scheme a component names with NO table refuses rather than skipping the contribution", () => {
    expect(() => payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE()], rateTables: [], ytdBefore: {},
    })).toThrow(new PayrollCalculationError("ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
      "employee emp-1 contributes to scheme scheme-synth and no rate table was supplied for it covering 2026-01-01..2026-01-31"));
  });

  it("a manual override REPLACES the computed share and the run still balances (spec:2087)", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD,
      employees: [EMPLOYEE({ manualOverrides: [
        { schemeId: "scheme-synth", share: "employee", amount: m("77.0000"), reason: "LHDN letter 2026-01-02" },
      ] })],
      rateTables: [REF()], ytdBefore: {},
    });
    const e = out.employees[0]!;
    expect(e.schemes[0]!.employeeShare).toEqual(m("77.0000"));
    expect(e.schemes[0]!.employerShare).toEqual(m("100.0000"));   // untouched
    expect(e.net).toEqual(m("1923.0000"));                        // 2000 − 77
    // The table is STILL pinned: an override changes a figure, never what the run was computed against.
    expect(out.pinnedTables).toEqual([{ schemeId: "scheme-synth", version: 1 }]);
  });

  it("a mid-month joiner is prorated by calendar days, exactly", () => {
    // Hired on the 17th of a 31-day month → 15 eligible days (17th..31st inclusive).
    expect(prorationFactor(PERIOD, { hiredOn: "2026-01-17", terminatedOn: null })).toEqual({ numerator: 15, denominator: 31 });
    const out = payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE({ hiredOn: "2026-01-17" })], rateTables: [REF()], ytdBefore: {},
    });
    // 2000 × 15/31 = 967.741935… → HALF_AWAY_FROM_ZERO at 4 dp.
    expect(out.employees[0]!.gross).toEqual(m("967.7419"));
  });

  it("a leaver mid-month is prorated on the other side, and someone hired and gone inside the period gets both", () => {
    expect(prorationFactor(PERIOD, { hiredOn: "2025-01-01", terminatedOn: "2026-01-10" })).toEqual({ numerator: 10, denominator: 31 });
    expect(prorationFactor(PERIOD, { hiredOn: "2026-01-06", terminatedOn: "2026-01-10" })).toEqual({ numerator: 5, denominator: 31 });
    expect(prorationFactor(PERIOD, { hiredOn: "2026-02-01", terminatedOn: null })).toEqual({ numerator: 0, denominator: 31 });
  });

  it("ytdAfter adds this run to ytdBefore under one key space (8C and 8D read it)", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD, employees: [EMPLOYEE()], rateTables: [REF()],
      ytdBefore: { "emp-1": { [ytdKey("gross")]: m("4000.0000"), [schemeYtdKey("SYNTH", "employee")]: m("100.0000") } },
    });
    const y = out.employees[0]!.ytdAfter;
    expect(y[ytdKey("gross")]).toEqual(m("6000.0000"));
    expect(y[ytdKey("net")]).toEqual(m("1950.0000"));
    expect(y[schemeYtdKey("SYNTH", "employee")]).toEqual(m("150.0000"));
    expect(y[schemeYtdKey("SYNTH", "employer")]).toEqual(m("100.0000"));
  });

  it("the calculator is PURE — two calls on the same input are byte-identical (test 33's mechanism)", () => {
    const input = { period: PERIOD, employees: [EMPLOYEE()], rateTables: [REF()], ytdBefore: {} };
    expect(JSON.stringify(payrollCalculator.calculate(input)))
      .toBe(JSON.stringify(payrollCalculator.calculate(input)));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/domain test -- payroll/calculator`
**Expected:** the file fails at import with

```
SyntaxError: The requested module '../../payroll/index' does not provide an export named 'payrollCalculator'
```

- [ ] **Step 3: Write `packages/domain/payroll/period.ts`**

```ts
import type { PayPeriod } from "./types";

const MS_PER_DAY = 86_400_000;
const SUNDAY = 0;
const SATURDAY = 6;

/** A `YYYY-MM-DD` date as UTC midnight. ECMA-262 parses the date-only form as UTC, which is what we want:
 *  these are `date` columns and carry no zone (§3.2 Time and dates). */
function day(iso: string): number {
  return Date.parse(iso);
}

/** Every calendar day of the period, inclusive of both ends. */
export function periodDays(period: PayPeriod): number {
  return countDays(period, day(period.start), day(period.end));
}

/**
 * The days of `[start, end]` the employee was employed for, inclusive on both sides.
 * `hiredOn` after the period end, or `terminatedOn` before the period start, is zero — not negative.
 */
export function eligibleDays(period: PayPeriod, hiredOn: string, terminatedOn: string | null): number {
  const from = Math.max(day(period.start), day(hiredOn));
  const to = Math.min(day(period.end), terminatedOn === null ? day(period.end) : day(terminatedOn));
  if (to < from) return 0;
  return countDays(period, from, to);
}

/**
 * `calendar_days` counts every day; `working_days` counts Monday–Friday.
 *
 * **Public holidays are NOT subtracted.** `app.public_holiday` is 8D's table (§4.6.1) and does not exist
 * here; more to the point, whether a holiday reduces a working-day denominator is a question for the
 * accountant, which is OD-28 and Task 7. The rule shipped is configuration, never a statutory claim
 * (spec:2086).
 */
function countDays(period: PayPeriod, from: number, to: number): number {
  if (period.prorationRule === "calendar_days") return Math.round((to - from) / MS_PER_DAY) + 1;
  let n = 0;
  for (let t = from; t <= to; t += MS_PER_DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== SUNDAY && dow !== SATURDAY) n += 1;
  }
  return n;
}
```

- [ ] **Step 4: Write `packages/domain/payroll/calculator.ts`**

```ts
import Decimal from "decimal.js";
import { Money } from "../src/index";
import { PayrollCalculationError } from "./errors";
import { eligibleDays, periodDays } from "./period";
import { calculators } from "./schemes";
import type {
  EmployeePeriodInput, EmployeeResult, PayPeriod, PayrollCalculator, RateTableRef, SchemeResult,
} from "./types";

/** The base-conversion mode of §4.2.1, reused so a prorated amount rounds the way a base amount does. */
const PRORATION_MODE = "HALF_AWAY_FROM_ZERO" as const;

/** The `ytdBefore` / `ytdAfter` key space, as two functions so 8C's projection and 8D's statements agree. */
export function ytdKey(part: "gross" | "net"): string { return part; }
export function schemeYtdKey(schemeCode: string, share: "employee" | "employer"): string {
  return `${schemeCode}.${share}`;
}

export { eligibleDays, periodDays };

/** The exact proration factor as a numerator/denominator pair — never a float (spec:2043's discipline). */
export function prorationFactor(
  period: PayPeriod, e: Pick<EmployeePeriodInput, "hiredOn" | "terminatedOn">,
): { numerator: number; denominator: number } {
  return { numerator: eligibleDays(period, e.hiredOn, e.terminatedOn), denominator: periodDays(period) };
}

function coversPeriod(ref: RateTableRef, period: PayPeriod): boolean {
  const from = ref.effectiveFrom <= period.start;                       // ISO dates compare lexically
  const to = ref.effectiveTo === null || ref.effectiveTo >= period.end;
  return from && to;
}

/**
 * The one payroll calculator. Pure: no clock, no I/O, no randomness, and **not one rate** (spec:2080).
 *
 * Order of operations, fixed here because a golden fixture pins it (test 33):
 *   1. every supplied rate table is checked for `verified` and for covering the period — the WHOLE run
 *      refuses on the first failure, because a run that computed some employees and refused others would
 *      leave a half-payroll (SAH-020's shape);
 *   2. per employee: the proration factor; each earning and deduction resolved to a period amount;
 *   3. per scheme the employee's components name: the base is the sum of the EARNINGS joined to that scheme
 *      (RC-3, spec:2079 — never a "subject to X" boolean and never the whole gross);
 *   4. the scheme's calculator computes the two shares from its table;
 *   5. a manual override replaces the computed share for that (scheme, share) and nothing else (spec:2087);
 *   6. net = gross − deductions − employee shares. The employer share never touches net;
 *   7. `ytdAfter` = `ytdBefore` + this run, under `ytdKey` / `schemeYtdKey`.
 */
export const payrollCalculator: PayrollCalculator = {
  calculate({ period, employees, rateTables, ytdBefore }) {
    // ── 1. the table gate, before a single figure is computed ──────────────────────────────────────
    for (const ref of rateTables) {
      if (!ref.verified) {
        throw new PayrollCalculationError(
          "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
          `rate table ${ref.schemeCode} v${ref.version} is not verified; a payroll run cannot pin an unverified table (spec:2080)`,
        );
      }
      if (!coversPeriod(ref, period)) {
        throw new PayrollCalculationError(
          "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
          `rate table ${ref.schemeCode} v${ref.version} is effective ${ref.effectiveFrom}..${ref.effectiveTo ?? "open"} ` +
            `and does not cover the pay period ${period.start}..${period.end}`,
        );
      }
    }
    const bySchemeId = new Map(rateTables.map((r) => [r.schemeId, r]));

    const results: EmployeeResult[] = [];
    const pinned = new Map<string, number>();

    for (const e of employees) {
      // The per-component input gate runs BEFORE the currency is derived, and the order is load-bearing.
      // `firstCurrency` needs a line that carries an amount; an employee whose only line is a quantity with
      // no per-unit rate has none, so deriving the currency first would raise the generic "no compensation
      // line carrying an amount" and BURY the refusal SAH-011 actually asks for — the one that names the
      // component and the quantity. Both are ERR_PAYROLL_INPUT_MISSING; only one of them is useful.
      assertComponentInputs(e);
      const currency = firstCurrency(e);
      const zero = Money.zero(currency);
      const { numerator, denominator } = prorationFactor(period, e);
      const factor = new Decimal(numerator).dividedBy(new Decimal(denominator));

      // ── 2. earnings and deductions ────────────────────────────────────────────────────────────────
      const earnings: { componentId: string; amount: Money }[] = [];
      const deductions: { componentId: string; amount: Money }[] = [];
      const baseByScheme = new Map<string, Money>();

      for (const c of e.compensation) {
        // Unreachable: `assertComponentInputs` raised on every null-amount line before the loop began. It
        // stays because it is what narrows `c.amount` to `Money` for the two expressions below, and because
        // a future caller that skips the gate must still refuse rather than compute on a null.
        if (c.amount === null) throw missingInput(e, c);
        const amount = c.quantity !== null
          // A quantity-based component: the compensation line's `amount` is the PER-UNIT rate, and the
          // quantity is the input (days of unpaid leave, hours of overtime). It is NOT prorated — the
          // quantity already says how much of the period it covers.
          ? c.amount.multiply(c.quantity.toDecimal(), PRORATION_MODE)
          : c.amount.multiply(factor, PRORATION_MODE);

        if (c.kind === "earning") {
          earnings.push({ componentId: c.componentId, amount });
          for (const schemeId of c.schemeIds) {
            baseByScheme.set(schemeId, (baseByScheme.get(schemeId) ?? zero).add(amount));
          }
        } else {
          deductions.push({ componentId: c.componentId, amount });
        }
      }

      const gross = earnings.reduce((acc, x) => acc.add(x.amount), zero);

      // ── 3–5. schemes, in the order the employee's components named them ───────────────────────────
      const schemes: SchemeResult[] = [];
      for (const [schemeId, base] of baseByScheme) {
        const ref = bySchemeId.get(schemeId);
        if (ref === undefined) {
          throw new PayrollCalculationError(
            "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
            `employee ${e.employeeId} contributes to scheme ${schemeId} and no rate table was supplied for it ` +
              `covering ${period.start}..${period.end}`,
          );
        }
        const mode = ref.definition.rounding_mode ?? PRORATION_MODE;
        let { employeeShare, employerShare } = calculators[ref.definition.kind].compute(ref.definition, {
          base, profile: e.statutoryProfile, ytd: ytdBefore[e.employeeId] ?? {}, period,
        });
        for (const o of e.manualOverrides) {
          if (o.schemeId !== schemeId) continue;
          if (o.share === "employee") employeeShare = o.amount; else employerShare = o.amount;
        }
        schemes.push({
          schemeId, schemeCode: ref.schemeCode, rateTableVersion: ref.version,
          employeeShare, employerShare, base, roundingMode: mode,
        });
        pinned.set(schemeId, ref.version);
      }

      // ── 6. net ────────────────────────────────────────────────────────────────────────────────────
      const deducted = deductions.reduce((acc, x) => acc.add(x.amount), zero);
      const employeeShares = schemes.reduce((acc, s) => acc.add(s.employeeShare), zero);
      const net = gross.subtract(deducted).subtract(employeeShares);

      // ── 7. ytdAfter ───────────────────────────────────────────────────────────────────────────────
      const before = ytdBefore[e.employeeId] ?? {};
      const ytdAfter: Record<string, Money> = { ...before };
      const bump = (key: string, by: Money): void => {
        ytdAfter[key] = (ytdAfter[key] ?? Money.zero(by.currency)).add(by);
      };
      bump(ytdKey("gross"), gross);
      bump(ytdKey("net"), net);
      for (const s of schemes) {
        bump(schemeYtdKey(s.schemeCode, "employee"), s.employeeShare);
        bump(schemeYtdKey(s.schemeCode, "employer"), s.employerShare);
      }

      results.push({ employeeId: e.employeeId, gross, earnings, deductions, schemes, net, ytdAfter });
    }

    return {
      employees: results,
      // Deterministic order: the map preserves insertion, which is the order employees named their schemes,
      // and a golden fixture byte-compares this array (test 29).
      pinnedTables: [...pinned].map(([schemeId, version]) => ({ schemeId, version })),
    };
  },
};

type CompensationLine = EmployeePeriodInput["compensation"][number];

/**
 * The exact `ERR_PAYROLL_INPUT_MISSING` message for a component with no usable amount (SAH-011, test 33).
 * ONE function, so the pre-pass and the narrowing throw inside the loop cannot spell one refusal two ways —
 * which is the SAH-009 failure mode applied to an error message.
 */
function missingInput(e: EmployeePeriodInput, c: CompensationLine): PayrollCalculationError {
  return c.quantity !== null
    ? new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `employee ${e.employeeId} has a quantity of ${c.quantity.toString()} on component ${c.componentId} ` +
          "and no per-unit amount; a quantity without a rate is not a zero line",
      )
    : new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `employee ${e.employeeId} has component ${c.componentId} with neither an amount nor a quantity`,
      );
}

/** Every component of one employee, checked before any figure — including the currency — is derived. */
function assertComponentInputs(e: EmployeePeriodInput): void {
  for (const c of e.compensation) if (c.amount === null) throw missingInput(e, c);
}

/**
 * The currency every figure of one employee is in. v1 payroll is MYR only (spec:2094 "multi-currency payroll"
 * is out of v1), but `Money` is currency-carrying by construction and a zero has to be minted in SOME
 * currency, so it is taken from the first compensation line rather than assumed.
 *
 * It runs AFTER `assertComponentInputs`, so by the time it is called every line carries an amount and its own
 * refusal below is reachable only for an employee with **no compensation at all**.
 */
function firstCurrency(e: EmployeePeriodInput) {
  const withAmount = e.compensation.find((c) => c.amount !== null);
  if (withAmount === undefined || withAmount.amount === null) {
    throw new PayrollCalculationError(
      "ERR_PAYROLL_INPUT_MISSING",
      `employee ${e.employeeId} has no compensation line carrying an amount; a run cannot compute a currency from nothing`,
    );
  }
  return withAmount.amount.currency;
}
```

Add to `packages/domain/payroll/index.ts`:

```ts
export { eligibleDays, payrollCalculator, periodDays, prorationFactor, schemeYtdKey, ytdKey } from "./calculator";
```

- [ ] **Step 5: Add the two `ERRORS` rows and the one `asAppError` branch**

Both codes are allocated in §4.2.4's table; this is the commit that raises them, and §4.2.4's rule is that a row lands in the PR that raises it.

```ts
// packages/contracts/src/errors.ts — inside the ERRORS object, in the payroll block.
  ERR_PAYROLL_RATE_TABLE_UNVERIFIED: {
    status: 422,
    title: "Rate table not usable",
    remedy: "Have a principal other than the one who loaded it verify the table (hr.statutory_table.verify), or load a version whose effective range covers the whole pay period.",
  },
  ERR_PAYROLL_INPUT_MISSING: {
    status: 422,
    title: "Statutory input missing",
    remedy: "Complete the named employee's statutory profile or compensation line and recalculate the run. The run never substitutes a zero.",
  },
```

```ts
// apps/api/src/problem.ts — ONE new branch, beside the existing PolicyEvaluationError and TenantContextError
// branches. `PayrollCalculationError.code` is a literal subset of ErrCode, so no cast is needed.
import { PayrollCalculationError } from "@dulja/domain/payroll";

  if (e instanceof PayrollCalculationError) return new AppError(e.code, e.detail);
```

**Why a branch and not a rethrow at the call site.** `packages/domain` may not import `AppError` (§3.1), so the class has to be its own; `problem.ts` is where every such class is translated once, exactly as `PolicyEvaluationError` and `PostingError` are. A translation at each call site would give two routes two spellings of one 422.

- [ ] **Step 6: Append the 8B blocks to `sah-011` and `sah-020`**

```ts
// tests/regression/sah-011.test.ts — APPEND
import { Money, currency } from "@dulja/domain";
import { PayrollCalculationError, payrollCalculator, type RateTableRef } from "@dulja/domain/payroll";

describe("SAH-011 NULL arithmetic irreversibly nulls balances and tax boxes — 8B", () => {
  const MYR = currency("MYR");
  const period = { start: "2026-01-01", end: "2026-01-31", payDate: "2026-02-05", prorationRule: "calendar_days" as const };

  it("a missing statutory input is a REFUSAL naming the employee, never a zero that propagates", () => {
    // The legacy failure was `"ActAdminDebit" + new."ItmLocalDebit"` with a NULL right-hand side: one line
    // nulled a balance for ever. The payroll analogue is a required profile field nobody filled.
    const ref: RateTableRef = {
      schemeId: "s", schemeCode: "SYNTH_PRG", version: 1, effectiveFrom: "2026-01-01", effectiveTo: null, verified: true,
      definition: {
        schema_version: 1, scheme: "SYNTH_PRG", version: 1, kind: "progressive_schedule",
        effective_from: "2026-01-01", effective_to: null,
        source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/p", retrieved_on: "2026-01-01" },
        rounding_mode: "HALF_EVEN", required_profile_fields: ["child_relief_count"],
        table: { brackets: [{ from: "0", to: null, rate: "0.1", cumulative: "0" }], reliefs: { child_relief_count: "100.0000" } },
      },
    };
    let thrown: unknown;
    try {
      payrollCalculator.calculate({
        period,
        employees: [{
          employeeId: "emp-null", branchId: "b", hiredOn: "2025-01-01", terminatedOn: null,
          statutoryProfile: { child_relief_count: null },
          compensation: [{ componentId: "c", kind: "earning", amount: Money.of("3000.0000", MYR), quantity: null, schemeIds: ["s"] }],
          manualOverrides: [],
        }],
        rateTables: [ref], ytdBefore: {},
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(PayrollCalculationError);
    expect((thrown as PayrollCalculationError).code).toBe("ERR_PAYROLL_INPUT_MISSING");
    expect((thrown as PayrollCalculationError).detail).toContain("child_relief_count");
  });
});
```

```ts
// tests/regression/sah-020.test.ts — APPEND
import { PayrollCalculationError, payrollCalculator } from "@dulja/domain/payroll";

describe("SAH-020 The GST return hardcodes a rate … — 8B (the payroll half)", () => {
  it("no EXECUTABLE line under packages/domain/payroll holds a numeric literal that could be a rate", async () => {
    // SAH-020's root cause is a figure in code. The structural fix is that every figure comes out of a
    // RateTable, so the package's executable source may hold `0` and `1` and nothing else numeric —
    // a scale is `MONEY_SCALE`/`QUANTITY_SCALE`, a day count is a named constant, a rate is a table.
    //
    // TWO strips, and each one earns its place.
    //
    // (a) Comments. Every file here cites spec lines and SAH ids (`spec:2080`, `SAH-011`, `§4.12.3`),
    //     and a scan that read those as rates would cry wolf on every commit until someone widened
    //     the allowlist to shut it up — which is precisely how a real check dies.
    // (b) Citations in what is LEFT. `calculator.ts` and `progressive-schedule.ts` put `spec:2080`
    //     in the text of a THROWN ERROR, which is a template literal, not a comment. Stripping only
    //     the citation forms leaves every other digit inside every other string in scope — so a rate
    //     smuggled in as `"0.11"` is still caught, and that is the SAH-020 shape that matters.
    const CITATION = /(spec:\d+|SAH-\d+|OD-\d+|RC-\d+)/g;
    const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
    const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;   // the `[^:]` spares `https://`
    const strip = (src: string) =>
      src.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, "$1").replace(CITATION, " ");
    // `period.ts` is excluded here and checked structurally below: it counts days, so `86_400_000`,
    // `SUNDAY` and `SATURDAY` are legitimate, and an allowlist wide enough to admit them is wide
    // enough to admit a contribution rate. Excluding it keeps THIS list at exactly `0` and `1`.
    for (const f of ["index", "types", "errors", "calculator",
                     "schemes/index", "schemes/banded-contribution",
                     "schemes/percentage-with-ceiling", "schemes/progressive-schedule"]) {
      const text = strip(await repoFile(`packages/domain/payroll/${f}.ts`));
      const literals = [...text.matchAll(/(?<![\w.])(\d[\d_]*(?:\.\d+)?)(?![\w.])/g)]
        .map((mm) => mm[1]!)
        .filter((v) => !["0", "1"].includes(v));
      expect(literals, `${f}.ts holds numeric literals ${literals.join(", ")}`).toEqual([]);
    }
  });

  it("period.ts cannot express a rate at all — it holds no Money and no Decimal", async () => {
    // The structural half of the rule above. A file that never imports the money types cannot carry a
    // contribution rate whatever its numbers say, and its three constants are calendar facts by name.
    const text = await repoFile("packages/domain/payroll/period.ts");
    expect(text).not.toMatch(/decimal\.js/);
    expect(text).not.toMatch(/Money/);
    expect([...text.matchAll(/^const ([A-Z_]+) =/gm)].map((mm) => mm[1]!).sort())
      .toEqual(["MS_PER_DAY", "SATURDAY", "SUNDAY"]);
  });

  it("an out-of-range table refuses the run rather than computing with the wrong version", () => {
    expect(() => payrollCalculator.calculate({
      period: { start: "2026-01-01", end: "2026-01-31", payDate: "2026-02-05", prorationRule: "calendar_days" },
      employees: [], rateTables: [{
        schemeId: "s", schemeCode: "SYNTH", version: 2, effectiveFrom: "2026-02-01", effectiveTo: null, verified: true,
        definition: {
          schema_version: 1, scheme: "SYNTH", version: 2, kind: "banded_contribution",
          effective_from: "2026-02-01", effective_to: null,
          source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/s", retrieved_on: "2026-01-01" },
          table: { bands: [{ from: "0", to: null, employee: "1.0000", employer: "1.0000" }] },
        },
      }], ytdBefore: {},
    })).toThrow(PayrollCalculationError);
  });
});
```

- [ ] **Step 7: Widen `error-codes`'s scan roots — unconditionally, in this commit (amendment A16)**

§4.2.4 fixes the rule's scan roots at `apps/**`, `packages/**/src/**` and `packages/db/migrations/**`, and fails a code that is present in `ERRORS` with no occurrence in them. **`packages/domain/payroll/` sits outside `src/` by design** — that is what makes spec:2366's "core never imports HR" mechanically checkable by `dependency-rule` (amendment A8) — so the only file that *raises* these two codes is outside every root the rule reads. `apps/api/src/problem.ts` names `e.code`, never a literal, and `packages/db/src/hr/**` re-raises them only through the class. The single textual occurrence inside a scan root today is a **comment** in `packages/db/src/hr/run.ts` (T10 Step 6), and a comment is not a raise: spec:2051's rule is "a code no code raises fails the build", so leaving the check satisfied by a sentence somebody may delete is the check quietly dying.

This is therefore a numbered step, not a contingency:

```ts
// scripts/lint/rules/error-codes.ts (0B) — the ROOTS list gains one entry.
// packages/domain/payroll/** is deliberately outside src/ (spec:2366, amendment A8), and it is where
// PayrollCalculationError raises the two ERR_PAYROLL_* codes. Without this line the rule cannot see the
// only raise there is, and spec:2051's "a code no code raises fails the build" would pass on a comment.
const ROOTS = ["apps/**", "packages/**/src/**", "packages/db/migrations/**", "packages/domain/payroll/**"];
```

Then run it and read the output rather than assuming:

```bash
bun run lint:rules
```

**Expected:** zero violations. If `error-codes` still reports the two codes as unraised, the constant it reads is not the one edited — `grep -n "ERR_PAYROLL" scripts/lint/rules/error-codes.ts` and follow the rule's own glob list.

- [ ] **Step 8: Run everything the change can reach**

Run: `bun run --cwd packages/domain test -- payroll/calculator` — **expected:** PASS (14 tests).
Run: `bun run --cwd packages/domain test` — **expected:** the whole `packages/domain` suite green, including 0D's money property tests and 2A's evaluator suite.
Run: `bun run --cwd tests test -- sah-011` and `bun run --cwd tests test -- sah-020` — **expected:** PASS.
Run: `bun run lint`, `bun run lint:rules`, `bun run typecheck` at the root — **expected:** all green.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/payroll packages/domain/test/payroll/calculator.test.ts \
        packages/contracts/src/errors.ts apps/api/src/problem.ts \
        scripts/lint/rules/error-codes.ts \
        tests/regression/sah-011.test.ts tests/regression/sah-020.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): payrollCalculator — the two refusals, the pinning, the proration [8B T6]

The whole run refuses before a single figure is computed if any supplied table
is unverified or does not cover the period (test 29), and a required statutory
input that is null refuses NAMING THE EMPLOYEE (test 33). SAH-011 is exactly the
failure where an absent input became a zero that propagated for ever, so there
is no default anywhere in this file.

The contribution base is the earnings JOINED to that scheme, never the whole
gross (RC-3, spec:2079). A manual override replaces one share and leaves the
pinned version alone: an override changes a figure, never what the run was
computed against.

ERR_PAYROLL_RATE_TABLE_UNVERIFIED and ERR_PAYROLL_INPUT_MISSING land in
errors.ts in the commit that raises them (§4.2.4), with one asAppError branch,
and error-codes gains packages/domain/payroll/** as a scan root (amendment A16):
the package is outside src/ so that dependency-rule can enforce spec:2366, which
puts the only raise there is outside every root the rule read.

The per-component input gate runs BEFORE the currency is derived. An employee
whose only line is a quantity with no rate has no amount to take a currency
from, so the other order buries the refusal SAH-011 asks for behind a generic
one that names neither the component nor the quantity.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: OD-28 — the proration rule the accountant confirms (isolated owner gate)

> **Owner decision OD-28** (§2.12; spec:2077, 2083, **2086**). *"Proration for mid-month joiners and leavers and for unpaid days follows a company-level configured rule (calendar days or working days) **that the accountant confirms** — configuration, never a statutory claim."*
>
> **Owner provides:** a one-line written confirmation from the accountant of **(a)** which rule applies — `calendar_days` or `working_days`; **(b)** whether `working_days` excludes public holidays as well as weekends; and **(c)** whether a mid-month *joiner* and a mid-month *leaver* are prorated by the same rule.
> **Verify:** `bun run --cwd packages/db src/cli.ts status` is not the verification here — the artefact is a document. Attach the confirmation to this task and record it in `docs/adr/0074-…` as an addendum with the date and the accountant's name. Then run `bun run --cwd packages/domain test -- payroll/proration` and confirm the case named for the confirmed rule is the one that is **not** `it.skip`.
> **Until provided — the default written into this plan:** `calendar_days`, both sides, with `working_days` fully implemented and selectable per company through 8A's `company_hr_setting.proration_rule`, and **public holidays deliberately not subtracted**. Nothing in Tasks 1–6 or 9–15 depends on the answer.

**Files:**
- Create: `packages/domain/test/payroll/proration.test.ts`
- Modify: `packages/domain/payroll/period.ts` (only if the owner answers `working_days` **with** holidays)
- Test: `packages/domain/test/payroll/proration.test.ts`

**Interfaces:**
- Consumes: `periodDays`, `eligibleDays`, `prorationFactor`, `payrollCalculator`, `PayPeriod` (Task 6); `company_hr_setting.proration_rule text check in ('calendar_days','working_days')` (8A, §4.6.1).
- Produces: no production interface. This task adds a test file and, if the owner answers (b) = yes, one parameter to `countDays`.

- [ ] **Step 1: Write `packages/domain/test/payroll/proration.test.ts` — both rules, both live**

```ts
import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src/index";
import { eligibleDays, payrollCalculator, periodDays, prorationFactor, type PayPeriod, type RateTableRef } from "../../payroll/index";

const MYR = currency("MYR");
const CAL: PayPeriod = { start: "2026-01-01", end: "2026-01-31", payDate: "2026-02-05", prorationRule: "calendar_days" };
const WRK: PayPeriod = { ...CAL, prorationRule: "working_days" };

describe("OD-28 — proration is CONFIGURATION, never a statutory claim (spec:2086)", () => {
  it("calendar_days counts every day of the period, inclusive of both ends", () => {
    expect(periodDays(CAL)).toBe(31);
    expect(eligibleDays(CAL, "2026-01-17", null)).toBe(15);
    expect(eligibleDays(CAL, "2025-01-01", "2026-01-10")).toBe(10);
  });

  it("working_days counts Monday–Friday and nothing else", () => {
    // January 2026: the 1st is a Thursday, so the month holds 22 weekdays.
    expect(periodDays(WRK)).toBe(22);
    // Hired Saturday the 17th: the eligible window is the 17th..31st, of which 10 are weekdays.
    expect(eligibleDays(WRK, "2026-01-17", null)).toBe(10);
  });

  it("public holidays are NOT subtracted, and that is the open half of OD-28", () => {
    // app.public_holiday is 8D's table (§4.6.1) and does not exist at 8B; more to the point, whether a
    // holiday reduces a working-day denominator is the accountant's answer, not this plan's.
    expect(periodDays(WRK)).toBe(22);   // unchanged by any holiday in the month
  });

  it("both sides of the window use ONE rule — a joiner and a leaver are prorated identically", () => {
    expect(prorationFactor(CAL, { hiredOn: "2026-01-16", terminatedOn: null })).toEqual({ numerator: 16, denominator: 31 });
    expect(prorationFactor(CAL, { hiredOn: "2025-01-01", terminatedOn: "2026-01-16" })).toEqual({ numerator: 16, denominator: 31 });
  });

  it("the two rules give DIFFERENT figures on the same employee, which is why the answer matters", () => {
    const ref: RateTableRef = {
      schemeId: "s", schemeCode: "SYNTH", version: 1, effectiveFrom: "2026-01-01", effectiveTo: null, verified: true,
      definition: {
        schema_version: 1, scheme: "SYNTH", version: 1, kind: "banded_contribution",
        effective_from: "2026-01-01", effective_to: null,
        source: { authority: "Dulja test fixture", publication: "none", url: "https://example.invalid/s", retrieved_on: "2026-01-01" },
        table: { bands: [{ from: "0", to: null, employee: "1.0000", employer: "1.0000" }] },
      },
    };
    const employee = {
      employeeId: "emp-1", branchId: "b", hiredOn: "2026-01-17", terminatedOn: null,
      statutoryProfile: {},
      compensation: [{ componentId: "c", kind: "earning" as const, amount: Money.of("3100.0000", MYR), quantity: null, schemeIds: ["s"] }],
      manualOverrides: [],
    };
    const cal = payrollCalculator.calculate({ period: CAL, employees: [employee], rateTables: [ref], ytdBefore: {} });
    const wrk = payrollCalculator.calculate({ period: WRK, employees: [employee], rateTables: [ref], ytdBefore: {} });
    expect(cal.employees[0]!.gross).toEqual(Money.of("1500.0000", MYR));   // 3100 × 15/31
    expect(wrk.employees[0]!.gross).toEqual(Money.of("1409.0909", MYR));   // 3100 × 10/22
    expect(cal.employees[0]!.gross.equals(wrk.employees[0]!.gross)).toBe(false);
  });

  // ⚠️ OD-28. Un-skip exactly ONE of the two below when the confirmation arrives, and delete the other.
  it.skip("OD-28 CONFIRMED calendar_days — the seeded company_hr_setting.proration_rule is 'calendar_days'", () => {
    expect(true).toBe(true);
  });
  it.skip("OD-28 CONFIRMED working_days — the seeded company_hr_setting.proration_rule is 'working_days'", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun run --cwd packages/domain test -- payroll/proration`
**Expected:** PASS (5 passed, 2 skipped). The two skipped cases carry the owner gate in the test output, where a reader sees it, rather than in a comment nobody runs.

- [ ] **Step 3: What changes if the owner answers otherwise — written now, so a later reader does not guess**

| Answer | Exact change | Where |
|---|---|---|
| (a) `working_days` | **No code change.** `company_hr_setting.proration_rule` (8A) is read by `loadPayrollInputs` (Task 10) into `PayPeriod.prorationRule`; the seed sets `'working_days'` for the company. Un-skip the second case. | seed only |
| (b) working days exclude public holidays | `countDays` in `packages/domain/payroll/period.ts` gains a third parameter `holidays: readonly string[]` and skips a day whose ISO date is in it; `PayPeriod` gains `holidays: readonly string[]` (defaulting to `[]`); `loadPayrollInputs` reads `app.public_holiday` for the company and branch — **which is 8D's table**, so this answer makes 8B depend on 8D and the two must land together. Record the dependency in §6.3 before implementing. | `period.ts`, `types.ts`, `inputs.ts`, §6.3 |
| (c) joiner and leaver differ | `prorationFactor` splits into `joinerFactor` / `leaverFactor` and `calculate` picks by whether `hiredOn > period.start` or `terminatedOn < period.end`; the golden fixture `synth-proration` gains a third employee. **This is the only answer that changes an exported signature**, so it also amends §4.12.1. | `calculator.ts`, §4.12.1, `tests/golden/payroll/synth-proration/` |

- [ ] **Step 4: Commit**

```bash
git add packages/domain/test/payroll/proration.test.ts
git commit -m "$(cat <<'EOF'
test(domain): the proration rule, both ways, with OD-28 as two skipped cases [8B T7]

spec:2086 makes proration configuration the accountant confirms, never a
statutory claim, so both rules ship and the company setting picks one. The
default is calendar_days; working_days is implemented and selectable; public
holidays are deliberately NOT subtracted, and that is the open half of OD-28.

The gate lives as two it.skip cases so it appears in test output rather than in
a comment. What each answer costs is written in the task, including that (b)
would make 8B depend on 8D's public_holiday table.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: OD-14 — hourly and part-time staff, levies, foreign workers, staff purchases (isolated owner gate)

> **Owner decision OD-14** (§2.12; spec:2093, 2478). *"⚠️ Owner to confirm: HRD Corp levy applicability; foreign workers; anyone hourly-paid or part-time; staff purchases at the till on salary deduction."*
>
> **Owner provides:** a yes/no per item, and for any yes, the operating detail named in the table below.
> **Verify:** for each *yes*, the acceptance is that `bun run --cwd packages/domain test -- payroll/hourly` passes with the case for that item un-skipped, and — for the levy — that `linkPayrollAccounts` reports `missingCodes: []` after §4.15 allocates the levy's `24nn`/`53nn` pair.
> **Until provided — the default written into this plan:** **none of the four is built.** Every one of them is *additive* and none blocks a task: the pay-component catalogue is data (spec:2079), a scheme is a row and never an enum (spec:2080), and the calculator reads its figures from a table. Tasks 1–7 and 9–15 are unaffected.

**Files:**
- Create: `packages/domain/test/payroll/hourly.test.ts` (⚠️ only if item 3 is *yes*)
- Test: `packages/domain/test/payroll/hourly.test.ts`

**Interfaces:**
- Consumes: `payrollCalculator`, `EmployeePeriodInput`, `Quantity` (Task 6); `app.pay_component` and `app.statutory_scheme` (8A).
- Produces: no production interface under the default. Each *yes* adds exactly what the table below states and nothing else.

- [ ] **Step 1: Record the four items and what each *yes* costs**

| Item (spec:2093) | If **no** (the default) | If **yes** — the exact change, and its only change |
|---|---|---|
| **1. HRD Corp or another levy applies** | Not built. `statutory_scheme` holds EPF, SOCSO, EIS, PCB and the four §4.15 code pairs cover them. | **One seed row and one §4.15 amendment, no code.** A scheme is a row, never an enum (spec:2080). §4.15 allocates the next free pair — `2415` / `5315` — by the rule already written there; `8b-payroll.json` gains two rows; `PAYROLL_ACCOUNT_CODES.schemePayable` and `.schemeEmployerExpense` gain the key; the levy's rate table arrives under OD-23 with its own `kind`. **If its shape is not one of the three §4.12.3 admits**, that is a fourth `kind` in the schema plus a fourth `SchemeCalculator` — an amendment to §4.12.3 first (ADR 0074's own consequence clause says so). |
| **2. Foreign workers are employed** | Not built. `employee_statutory_profile` carries `residency_category` (8A, §4.6.1) and no scheme reads it. | **No code in 8B.** A scheme whose contribution depends on residency declares `required_profile_fields: ["residency_category"]` in its rate table; `progressiveSchedule`'s `multiplier` already handles a string profile value, and a missing one already refuses naming the employee. The work is 8A's profile field list (OD-28's other half) and the table itself (OD-23). |
| **3. Anyone is hourly-paid or part-time** | Not built. Every earning is a fixed period amount or a `quantity × per-unit rate` line. | **One seed component and one test, no code.** `quantity_based` is already a `pay_component` column (8A, §4.6.1) and the calculator already computes `amount × quantity` for it (Task 6 Step 4) **without** prorating — which is precisely right for hours worked. The seed adds an `HOURLY` earning component; `compensation_line.amount` is the hourly rate and `.quantity` the hours. Step 2's test file is the proof. |
| **4. Staff purchases at the till are deducted from salary** | Not built. | **Out of 8B entirely.** A till purchase settled by salary deduction is a `POS_TICKET` with a `store_credit` tender (6A, account `2200`) plus a recurring deduction component that relieves it — so the change is a `pay_component` whose `expense_account_id` is **`2200`**, seeded by whichever slice the owner's answer lands in, and 8B's only obligation is that `linkPayrollAccounts` does not overwrite it (it does not — the `is null` clause of Task 4 Step 5 is why). **No 8B code changes.** Record it against 6D/8C rather than reopening this slice. |

- [ ] **Step 2: Write `packages/domain/test/payroll/hourly.test.ts` — the case item 3 turns on**

The file ships with its single case **skipped**, so the gate is visible in test output. Un-skip it if and only if item 3 is *yes*.

```ts
import { describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "../../src/index";
import { payrollCalculator, type PayPeriod } from "../../payroll/index";

const MYR = currency("MYR");
const PERIOD: PayPeriod = { start: "2026-01-01", end: "2026-01-31", payDate: "2026-02-05", prorationRule: "calendar_days" };

describe("OD-14 item 3 — hourly and part-time staff (spec:2093)", () => {
  it.skip("OD-14 CONFIRMED hourly — an HOURLY component is hours × rate and is NOT prorated", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD,
      employees: [{
        employeeId: "emp-hourly", branchId: "b",
        // Joined mid-month: the proration factor is 15/31 and must NOT touch the hourly line, because the
        // hours already say how much of the period was worked. Prorating it would halve a real figure.
        hiredOn: "2026-01-17", terminatedOn: null, statutoryProfile: {},
        compensation: [{
          componentId: "cmp-hourly", kind: "earning",
          amount: Money.of("12.5000", MYR), quantity: Quantity.of("64.000000"), schemeIds: [],
        }],
        manualOverrides: [],
      }],
      rateTables: [], ytdBefore: {},
    });
    expect(out.employees[0]!.gross).toEqual(Money.of("800.0000", MYR));   // 12.50 × 64, unprorated
    expect(out.employees[0]!.net).toEqual(Money.of("800.0000", MYR));
  });
});
```

- [ ] **Step 3: Run it**

Run: `bun run --cwd packages/domain test -- payroll/hourly`
**Expected:** `1 skipped`. The suite is green and the gate is legible.

- [ ] **Step 4: Commit**

```bash
git add packages/domain/test/payroll/hourly.test.ts
git commit -m "$(cat <<'EOF'
test(domain): OD-14's four HR facts, recorded with what each yes costs [8B T8]

None of the four is built. Each is additive by construction: a scheme is a row
never an enum (spec:2080), a pay component is data (spec:2079), and the
calculator reads its figures from a rate table.

Item 3 (hourly/part-time) is a seed component and this one skipped case — the
quantity path already computes amount × quantity WITHOUT prorating, which is
exactly right for hours worked. Item 4 (staff purchases) is 6D/8C work and
changes no 8B code; linkPayrollAccounts already refuses to overwrite a chosen
account, which is what would break it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `loadSnapshot` fills `refs.components`, `refs.schemes` and `LineSnapshot.payroll`

**Files:**
- Modify: `packages/db/src/posting/load.ts`
- Create: `packages/db/test/payroll/snapshot.test.ts`
- Test: `packages/db/test/payroll/snapshot.test.ts`

**Interfaces:**
- Consumes: `loadSnapshot(tx, documentId): Promise<DocumentSnapshot>` (1A/2A, §4.3.1), `DocumentSnapshot`, `LineSnapshot`, `PayComponentRef`, `SchemeRef`, `PayrollLineRef` (§4.4.2 — declared **in core**, `packages/domain/src/posting/evaluate.ts`), `app.payroll_line` (T1), `app.pay_component` / `app.statutory_scheme` (8A), `evaluatePolicy` (2A).
- Produces: no new export. `loadSnapshot` keeps its signature exactly (§4.3.1: "no signature change") and fills three slots the 2A evaluator already reads.

- [ ] **Step 1: Assert what is already filled (amendment A11)**

```bash
grep -n "refs\." packages/db/src/posting/load.ts
grep -n "payroll" packages/db/src/posting/load.ts
```

**Three outcomes, and the task adapts to which one you see.**

- **`components: {}`, `schemes: {}` and no `payroll` — the expected state, and now the *verified* one.** §4.3.1's stubbed list names all three; 8A's card does not list `loadSnapshot` among its deliverables; and **8A's written plan mentions `loadSnapshot` nowhere in its fourteen tasks** (checked against the merged file — zero occurrences), so it does not touch `packages/db/src/posting/load.ts` at all. Do the whole task. The two branches below are kept because a later 8A revision could still claim the two `refs` slots, and a task that silently double-writes them is worse than one that checks.
- **`components` and `schemes` already populated by 8A, `payroll` still `null`.** Do Steps 3–5 only, and delete Step 4's two `refs` queries. Say so in the commit body.
- **All three already filled.** 8A did this slice's work; verify the shapes against Step 4's queries, keep the test file (it is this slice's proof, not 8A's), and commit the test alone.

Whichever you see, the test in Step 2 is written and run.

- [ ] **Step 2: Write the failing test `packages/db/test/payroll/snapshot.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluatePolicy, parsePolicy } from "@dulja/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSnapshot, resolvePolicy } from "../../src/posting";
import { ensureEmployeeDimensionValue } from "../../src/hr/employee-dimension";
import { linkPayrollAccounts } from "../../src/hr/accounts";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, seedAccount, seedDocumentType, seedEmployee, seedPayComponent,
  seedStatutoryScheme, seedTenantV2, type Seed,
} from "../fixtures";

const PAYROLL_ENVELOPE = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../seed/my/document-types/PAYROLL.json"), "utf8"),
) as { policy: unknown };

let db: Db; let s: Seed;
let typeId: string; let employeeId: string; let employeeDimValueId: string;
let basicId: string; let advanceId: string; let schemeId: string; let payableId: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Snapshot");
  for (const [code, nameEn, type] of [
    ["1400", "Staff advances", "asset"], ["2400", "Salaries payable", "liability"],
    ["2411", "Statutory payable — EPF", "liability"], ["5300", "Salaries expense", "expense"],
    ["5311", "Employer contribution — EPF", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });

  typeId = await seedDocumentType(db, s, { code: "PAYROLL", module: "hr", policy: PAYROLL_ENVELOPE.policy });
  employeeId = await seedEmployee(db, s, { employeeNumber: "E-2001" });
  basicId = await seedPayComponent(db, s, { code: "BASIC", kind: "earning" });
  advanceId = await seedPayComponent(db, s, { code: "ADV_RECOVERY", kind: "deduction" });
  schemeId = await seedStatutoryScheme(db, s, { code: "EPF" });
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    // The advance-recovery component points at 1400 BEFORE the linker runs, so the linker's `is null` clause
    // is what leaves it alone (Task 4 Step 5).
    const [adv] = await tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = '1400'`;
    await tx`update app.pay_component set expense_account_id = ${adv!.id} where id = ${advanceId}`;
    await linkPayrollAccounts(tx, s.company);
    employeeDimValueId = await ensureEmployeeDimensionValue(tx, s.company, employeeId);
  });
  const [p] = await db.admin<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = '2411'`;
  payableId = p!.id;
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("loadSnapshot fills the payroll slots 2A's evaluator reads (§4.4.2, amendment A11)", () => {
  it("refs.components carries every pay_component of the company, keyed by id", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId, series: "PAY", effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000" }],
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.refs.components[basicId]).toEqual({
      id: basicId, code: "BASIC", kind: "earning",
      expenseAccountId: expect.any(String), payableAccountId: null,
    });
    expect(snap.refs.components[advanceId]!.kind).toBe("deduction");
  });

  it("refs.schemes carries every statutory_scheme, with its two account ids", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId, series: "PAY", effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000" }],
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.refs.schemes[schemeId]).toEqual({
      id: schemeId, code: "EPF", payableAccountId: payableId, expenseAccountId: expect.any(String),
    });
  });

  it("LineSnapshot.payroll is the payroll_line row, with the EMPLOYEE dimension value id resolved", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId, series: "PAY", effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000", dimensions: { BRANCH: s.hq } }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, amount)
      values (${d.lineIds[0]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${basicId}, '1000.0000')`);
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.lines[0]!.payroll).toEqual({
      employeeId, employeeDimensionValueId: employeeDimValueId,
      componentId: basicId, schemeId: null, share: null,
    });
  });

  it("a line with NO payroll_line row has `payroll: null`, and no rule matches it", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId, series: "PAY", effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000" }],
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.lines[0]!.payroll).toBeNull();
    const { definition } = await withTenant(db.rw, s.tenant, s.human, (tx) => resolvePolicy(tx, typeId, "2026-01-31"));
    expect(evaluatePolicy(parsePolicy(definition), snap).ledgerLines).toEqual([]);
  });

  it("the whole PAYROLL policy evaluates over a filled snapshot — every rule reaches its account", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId, series: "PAY", effectiveDate: "2026-01-31",
      lines: [
        { kind: "payroll", lineNo: 1, amount: "1000.0000", dimensions: { BRANCH: s.hq } },   // earning
        { kind: "payroll", lineNo: 2, amount: "50.0000",   dimensions: { BRANCH: s.hq } },   // employee share
        { kind: "payroll", lineNo: 3, amount: "100.0000",  dimensions: { BRANCH: s.hq } },   // employer share
        { kind: "account", lineNo: 4, credit: "950.0000",  dimensions: { BRANCH: s.hq },
          accountId: (await db.admin<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = '2400'`)[0]!.id },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, amount)
               values (${d.lineIds[0]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${basicId}, '1000.0000')`;
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, scheme_id, share, amount)
               values (${d.lineIds[1]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${schemeId}, 'employee', '50.0000')`;
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, scheme_id, share, amount)
               values (${d.lineIds[2]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${schemeId}, 'employer', '100.0000')`;
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
               values (${d.lineIds[3]!}, ${s.tenant}, ${s.company}, ${employeeId}, '950.0000')`;
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    const { definition } = await withTenant(db.rw, s.tenant, s.human, (tx) => resolvePolicy(tx, typeId, "2026-01-31"));
    const plan = evaluatePolicy(parsePolicy(definition), snap);

    // 5 ledger lines: earning debit, employee-share credit, employer-share debit + credit, net-pay credit.
    expect(plan.ledgerLines).toHaveLength(5);
    // A9: every planned amount is a MAGNITUDE and `side` carries the direction.
    for (const l of plan.ledgerLines) expect(l.amount.isNegative()).toBe(false);
    // Every line carries BOTH dimensions, and BRANCH is the LINE's, not the document's (amendment A3).
    for (const l of plan.ledgerLines) {
      expect(Object.keys(l.dimensions).sort()).toEqual(["BRANCH", "EMPLOYEE"]);
      expect(l.dimensions["EMPLOYEE"]).toBe(employeeDimValueId);
    }
    const debits = plan.ledgerLines.filter((l) => l.side === "debit").reduce((a, l) => a.add(l.amount), plan.ledgerLines[0]!.amount.subtract(plan.ledgerLines[0]!.amount));
    const credits = plan.ledgerLines.filter((l) => l.side === "credit").reduce((a, l) => a.add(l.amount), plan.ledgerLines[0]!.amount.subtract(plan.ledgerLines[0]!.amount));
    expect(debits.equals(credits)).toBe(true);   // 1000 + 100 == 50 + 100 + 950
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- payroll/snapshot`
**Expected:** the first case fails with

```
AssertionError: expected undefined to deeply equal { id: '…', code: 'BASIC', … }
```

because `refs.components` is `{}`.

- [ ] **Step 4: Fill the two `refs` maps in `packages/db/src/posting/load.ts`**

Two queries, added beside the `refs.items` and `refs.taxCodes` queries 3A and 5A wrote. **Company-scoped, not line-scoped**, exactly as `accountsByCode` is: a policy's `line.component.expense_account` is resolved per line, but the map is small (a pay-component catalogue is dozens of rows, not thousands) and a per-line `in (…)` would fetch the same rows once per line.

```ts
// packages/db/src/posting/load.ts — inside loadSnapshot, in the refs block.

// 8B. `PayComponentRef` and `SchemeRef` are declared IN CORE (packages/domain/src/posting/evaluate.ts,
// §4.4.2) precisely so `packages/domain/src/**` never imports `packages/domain/payroll/**` (spec:2366).
// These queries produce those structural shapes; the payroll package's richer types satisfy them and are
// never converted.
const componentRows = await tx<
  { id: string; code: string; kind: "earning" | "deduction"; expense_account_id: string | null; payable_account_id: string | null }[]
>`select id, code, kind, expense_account_id, payable_account_id
    from app.pay_component
   where company_id = ${header.companyId} and archived_at is null`;
const components: Record<string, PayComponentRef> = {};
for (const r of componentRows) {
  components[r.id] = {
    id: r.id, code: r.code, kind: r.kind,
    expenseAccountId: r.expense_account_id, payableAccountId: r.payable_account_id,
  };
}

const schemeRows = await tx<
  { id: string; code: string; payable_account_id: string; employer_expense_account_id: string | null }[]
>`select id, code, payable_account_id, employer_expense_account_id
    from app.statutory_scheme
   where company_id = ${header.companyId}`;
const schemes: Record<string, SchemeRef> = {};
for (const r of schemeRows) {
  schemes[r.id] = {
    id: r.id, code: r.code,
    payableAccountId: r.payable_account_id, expenseAccountId: r.employer_expense_account_id,
  };
}
```

and replace the two `{}` placeholders in the `refs` object literal with `components` and `schemes`.

- [ ] **Step 5: Fill `LineSnapshot.payroll` in the same file**

One query joined to the `EMPLOYEE` dimension value, and one assignment in the line loop.

```ts
// packages/db/src/posting/load.ts — beside the document_line query.

// 8B. One query for the whole document, keyed by document_line_id. `employeeDimensionValueId` is resolved
// here rather than in the evaluator because the evaluator is pure and has no source for it (the identical
// reason `PlannedMovement.lotId` is resolved in `applyMovements` and not in `evaluatePolicy`).
const payrollRows = await tx<{
  document_line_id: string; employee_id: string; dimension_value_id: string | null;
  component_id: string | null; scheme_id: string | null; share: "employee" | "employer" | null;
}[]>`
  select pl.document_line_id, pl.employee_id, dv.id as dimension_value_id,
         pl.component_id, pl.scheme_id, pl.share
    from app.payroll_line pl
    join app.document_line dl on dl.id = pl.document_line_id
    join app.employee e       on e.id = pl.employee_id
    left join app.dimension_type dt on dt.company_id = pl.company_id and dt.code = 'EMPLOYEE'
    left join app.dimension_value dv on dv.dimension_type_id = dt.id and dv.code = e.employee_number
   where dl.document_id = ${documentId}`;
const payrollByLine = new Map<string, PayrollLineRef>();
for (const r of payrollRows) {
  if (r.dimension_value_id === null) {
    // Fail closed and NAME it. A payroll line whose employee has no EMPLOYEE dimension value would post
    // untagged, and spec:2101 makes the per-employee payable a ledger projection — an untagged line silently
    // breaks every downstream schedule. `ensureEmployeeDimensionValue` (8B T2) is the repair, and
    // `calculatePayrollRun` calls it per employee, so reaching here means a line was written by hand.
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `payroll line ${r.document_line_id} names employee ${r.employee_id}, which has no EMPLOYEE dimension value; ` +
        "call ensureEmployeeDimensionValue before drafting the line (contracts §4.12.7)",
    );
  }
  payrollByLine.set(r.document_line_id, {
    employeeId: r.employee_id, employeeDimensionValueId: r.dimension_value_id,
    componentId: r.component_id, schemeId: r.scheme_id, share: r.share,
  });
}
```

and in the line-building loop, replace the `payroll: null` placeholder with:

```ts
    payroll: payrollByLine.get(row.id) ?? null,
```

Add `PayComponentRef`, `SchemeRef` and `PayrollLineRef` to the file's `@dulja/domain` type import — the same import line `ItemRef` and `TaxCodeRef` already sit on, so no dependency edge appears.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- payroll/snapshot` — **expected:** PASS (5 tests).
Run: `bun run --cwd packages/db test -- posting` — **expected:** unchanged and green. 1A's, 2A's, 3A's and 5A's snapshot suites all assert on documents with no `payroll_line` rows, so `payroll` stays `null` for every one of them and the two `refs` maps are empty for a company with no HR rows.
Run: `bun run --cwd packages/db test` — **expected:** the whole `packages/db` suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/posting/load.ts packages/db/test/payroll/snapshot.test.ts
git commit -m "$(cat <<'EOF'
feat(db): loadSnapshot fills refs.components, refs.schemes and line.payroll [8B T9]

2A's evaluator already resolves line.component.expense_account,
line.scheme.payable_account, line.scheme.expense_account, the line.component.kind
and line.share filters and the line.employee dimension. This slice fills the
three snapshot slots those resolvers read and writes no evaluator branch.

The EMPLOYEE dimension value id is resolved HERE, not in the evaluator, for the
same reason PlannedMovement.lotId is resolved in applyMovements: the evaluator
is pure and has no source for an id. A payroll line whose employee has no value
refuses naming the line rather than posting untagged — spec:2101 makes the
per-employee payable a ledger projection, and an untagged line breaks every
schedule downstream in silence.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The run service and the `payroll-runs` route module

**Files:**
- Create: `packages/db/src/hr/inputs.ts`, `packages/db/src/hr/run.ts`, `packages/db/src/hr/ytd.ts`
- Create: `packages/contracts/src/hr/payroll-run.ts`
- Create: `apps/api/src/routes/hr/payroll-runs.ts`
- Create: `tests/invariants/support/payroll.ts` (amendment A7)
- Create: `packages/db/test/payroll/run.test.ts`, `apps/api/test/routes/hr/payroll-runs.test.ts`
- Modify: `packages/db/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/contracts/openapi.json`
- Test: `packages/db/test/payroll/run.test.ts`, `apps/api/test/routes/hr/payroll-runs.test.ts`, `tests/invariants/tenant-isolation.test.ts` (re-run)

**Interfaces:**
- Consumes: `payrollCalculator`, `PayrollCalculationError`, `EmployeePeriodInput`, `PayPeriod`, `RateTableRef`, `EmployeeResult`, `ytdKey`, `schemeYtdKey` (T5/T6); `ensureEmployeeDimensionValue`, `EMPLOYEE_DIMENSION_CODE` (T2); `PAYROLL_ACCOUNT_CODES` (T4); `withTenant`, `TenantContext` (§4.2.2); `postDocument`, `transitionDocument`, `resolvePolicy` (§4.3.1); `requirePermission`, `requireDocumentPermission`, `PERMISSION` (§4.2.5, §4.5.4); `RouteModule`, `buildRoutes`, `IdempotencyHeader`, `PROBES`, `IsolationProbe` (§4.2.7); `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `MoneySchema`, `CursorSchema`, `encodeCursor`, `decodeCursor` (§4.2.8); `startApi`, `StartedApi` (§4.2.12); `Money`, `Quantity`, `currency` (§4.2.1); **`ensureOpenPeriods(db, s, year)` from `tests/invariants/support/post-inventory.ts`** (3B, 3b:2416 — registered by 3B's amendment A11 against §4.17.1; 3C imports it the same way at 3c:3868), consumed by `payrollFixture` only.
- Produces:

```ts
// packages/db/src/hr/inputs.ts
export interface PayrollInputs {
  period: PayPeriod;
  employees: EmployeePeriodInput[];
  rateTables: RateTableRef[];
  ytdBefore: Record<string, Record<string, Money>>;
  /** employeeId → the employee's EMPLOYEE dimension_value id, resolved (and repaired) here. */
  dimensionValues: Record<string, string>;
  /** employeeId → the employee's home BRANCH dimension_value id. */
  homeBranches: Record<string, string>;
  currency: CurrencyCode;
}
export interface LoadInputsOptions {
  companyId: string; periodStart: string; periodEnd: string; payDate: string;
  kind: "regular" | "supplementary" | "final"; employeeIds?: readonly string[];
  /** The run whose OWN manual overrides are inputs. Absent for a first calculation: a run that does not
   *  exist yet has none, and a period key would let another draft's overrides leak into it. */
  documentId?: string;
}
export async function loadPayrollInputs(tx: Sql, opts: LoadInputsOptions): Promise<PayrollInputs>;

// packages/db/src/hr/run.ts
export interface CalculateRunInput {
  companyId: string; kind: "regular" | "supplementary" | "final";
  periodStart: string; periodEnd: string; payDate: string;
  effectiveDate: string; branchId: string; employeeIds?: readonly string[];
}
export interface PayrollRunResult {
  documentId: string;
  employeeCount: number;
  lineCount: number;
  gross: Money; net: Money;
  pinnedTables: { schemeId: string; version: number }[];
  overrides: { documentLineId: string; employeeId: string; schemeCode: string; share: "employee" | "employer"; reason: string }[];
}
export async function calculatePayrollRun(tx: Sql, ctx: TenantContext, input: CalculateRunInput): Promise<PayrollRunResult>;
/** Re-runs the calculation over an existing DRAFT run, replacing its lines. ERR_DOC_NOT_DRAFT otherwise. */
export async function recalculatePayrollRun(tx: Sql, ctx: TenantContext, documentId: string): Promise<PayrollRunResult>;
export async function readPayrollRun(tx: Sql, documentId: string): Promise<PayrollRunDetail>;
/** The document statuses `PayrollRunSchema.status` enumerates — ONE union, so the handler's return type and
 *  the declared response schema cannot describe two different bodies. */
export type PayrollRunStatus = "draft" | "submitted" | "approved" | "issued" | "void" | "posted" | "reversed";
export interface PayrollRunDetail {
  documentId: string; number: string | null; series: string; status: PayrollRunStatus;
  kind: "regular" | "supplementary" | "final";
  periodStart: string; periodEnd: string; payDate: string;
  pinnedTables: { schemeId: string; version: number }[];
  /** `amount` is `MoneySchema`'s shape — `{ amount: "2000.0000", currency: "MYR" }` (§4.2.8), not a bare
   *  string: the route returns this object against `PayrollRunSchema` and the two must agree exactly. */
  lines: { documentLineId: string; employeeId: string; employeeNumber: string; componentId: string | null;
           schemeId: string | null; share: "employee" | "employer" | null; quantity: string | null;
           amount: { amount: string; currency: string };
           rateTableVersion: number | null; overrideReason: string | null }[];
  /** spec:2174 R3 — "the approval screen lists everyone who changed compensation in the period".
   *  A read, not a screen: it ships here so the API surface is complete whether or not OD-24 lands. */
  compensationChangedBy: { principalId: string; displayName: string;
                           employeeNumber: string; effectiveFrom: string }[];
}

// packages/db/src/hr/ytd.ts
/** Between 8B and 8C the YTD figures come from POSTED payroll_line rows; 8C's employee_ytd supersedes it. */
export async function ytdFromPostedLines(
  tx: Sql, companyId: string, taxYear: number, employeeIds: readonly string[],
): Promise<Record<string, Record<string, Money>>>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/payroll/run.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { PayrollCalculationError } from "@dulja/domain/payroll";
import { calculatePayrollRun, readPayrollRun, recalculatePayrollRun } from "../../src/hr/run";
import { postDocument, transitionDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import { grantCodes, seedPayComponent, seedRateTable, seedTenantV2, type Seed } from "../fixtures";
import { payrollFixture, type PayrollFixture } from "../../../../tests/invariants/support/payroll";

const MYR = currency("MYR");
let db: Db; let s: Seed; let f: PayrollFixture;
const ctxOf = (seed: Seed, actor?: string) =>
  ({ tenantId: seed.tenant, actorId: actor ?? seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Run");
  f = await payrollFixture(db, s);          // seeds the chart, the PAYROLL type, SYNTH, two employees
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.payroll.approve", "hr.payroll.post"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

const RUN = {
  companyId: "", kind: "regular" as const,
  periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05",
  effectiveDate: "2026-01-31", branchId: "",
};

describe("calculatePayrollRun (§4.12.6, spec:2081)", () => {
  it("writes ONE document, ONE payroll_run and one line per component, scheme share and net pay", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));

    expect(r.employeeCount).toBe(2);
    // Per employee: 1 earning + 1 employee share + 1 employer share + 1 net-pay account line = 4.
    expect(r.lineCount).toBe(8);
    expect(r.pinnedTables).toEqual([{ schemeId: f.schemeId, version: 1 }]);

    const [run] = await db.admin<{ kind: string; period_start: string; pinned_tables: unknown }[]>`
      select kind, to_char(period_start, 'YYYY-MM-DD') as period_start, pinned_tables
        from app.payroll_run where document_id = ${r.documentId}`;
    expect(run!.kind).toBe("regular");
    expect(run!.period_start).toBe("2026-01-01");
    expect(run!.pinned_tables).toEqual([{ schemeId: f.schemeId, version: 1 }]);

    const [doc] = await db.admin<{ status: string; number: string | null; series: string }[]>`
      select status::text as status, number::text as number, series from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("draft");
    expect(doc!.number).toBeNull();     // numbering happens at issue, in the posting service (§4.3.6)
    expect(doc!.series).toBe("PAY");
  });

  it("every payroll line carries the employee's HOME branch in document_line.dimensions (amendment A3)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    const rows = await db.admin<{ employee_id: string; branch: string }[]>`
      select pl.employee_id, dl.dimensions->>'BRANCH' as branch
        from app.document_line dl join app.payroll_line pl on pl.document_line_id = dl.id
       where dl.document_id = ${r.documentId}`;
    for (const row of rows) {
      expect(row.branch).toBe(row.employee_id === f.employeeAId ? s.hq : f.branchB);
    }
  });

  it("a pinned line records the rate table it used, per line (SAH-013)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    const rows = await db.admin<{ rate_table_id: string | null; rate_table_version: number | null }[]>`
      select pl.rate_table_id, pl.rate_table_version
        from app.document_line dl join app.payroll_line pl on pl.document_line_id = dl.id
       where dl.document_id = ${r.documentId} and pl.scheme_id is not null`;
    expect(rows).toHaveLength(4);        // two employees × two shares
    for (const row of rows) {
      expect(row.rate_table_id).toBe(f.rateTableId);
      expect(row.rate_table_version).toBe(1);
    }
  });

  it("the run POSTS through postDocument and the ledger balances (spec:2081, hazard 22)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      transitionDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId, to: "approved" }));
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      postDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId }));

    const [sums] = await db.admin<{ d: string; c: string }[]>`
      select coalesce(sum(base_debit), 0)::text as d, coalesce(sum(base_credit), 0)::text as c
        from app.ledger_entry where document_id = ${r.documentId}`;
    expect(sums!.d).toBe(sums!.c);
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry_dimension led
        join app.ledger_entry le on le.id = led.entry_id
        join app.dimension_value dv on dv.id = led.dimension_value_id
        join app.dimension_type dt on dt.id = dv.dimension_type_id
       where le.document_id = ${r.documentId} and dt.code = 'EMPLOYEE'`;
    expect(n!.n).toBe(10);              // every one of the 10 ledger lines carries EMPLOYEE
  });

  it("recalculatePayrollRun replaces a DRAFT run's lines and refuses a submitted one", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    const again = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      recalculatePayrollRun(tx, ctxOf(s), r.documentId));
    expect(again.documentId).toBe(r.documentId);
    expect(again.lineCount).toBe(8);
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document_line where document_id = ${r.documentId}`;
    expect(n!.n).toBe(8);               // replaced, not doubled

    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }));
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      recalculatePayrollRun(tx, ctxOf(s), r.documentId)))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("an unverified table refuses the run and writes NOTHING (test 29)", async () => {
    // A verified table CANNOT be un-verified: `verified_by` is stamped and immutable — `app.stamp_actor`
    // raises ERR_ACTOR_IMMUTABLE on any change to a non-null `*_by` (plan0A:2369–2386) — so
    // `set verified_by = null` is not a shortcut, it is an error. The legal way to get an unverified table
    // covering the period is to LOAD one: `seedRateTable` inserts `effective_from '2026-01-01'` with an open
    // end (8a:4586–4589), so version 2 covers January and, being the highest covering version,
    // `loadPayrollInputs` offers it (T10 Step 4) — unverified.
    const unverified = await seedRateTable(db, s, { schemeId: f.schemeId, version: 2, verified: false });
    const before = await db.admin<{ n: number }[]>`select count(*)::int as n from app.payroll_run`;
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq })))
      .rejects.toThrow(PayrollCalculationError);
    const after = await db.admin<{ n: number }[]>`select count(*)::int as n from app.payroll_run`;
    expect(after[0]!.n).toBe(before[0]!.n);
    // Move it out of the period rather than verifying it: the cases after this one assert that a line pins
    // version 1. An UNVERIFIED row is not frozen — 8A's `assert_rate_table_verifier` freezes a row only once
    // `verified_at` is set (8a:4315–4322) — so its effective window may still be moved, and neither stamp
    // fires because no `*_by` column changes.
    await db.admin`update app.statutory_rate_table set effective_from = '2027-01-01' where id = ${unverified}`;
  });

  it("readPayrollRun returns every line with its pin, for the approval screen (spec:2087)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    const detail = await withTenant(db.rw, s.tenant, s.human, (tx) => readPayrollRun(tx, r.documentId));
    expect(detail.status).toBe("draft");
    expect(detail.lines).toHaveLength(8);
    expect(detail.lines.every((l) => l.employeeNumber.startsWith("E-"))).toBe(true);
    expect(detail.lines.filter((l) => l.schemeId !== null).every((l) => l.rateTableVersion === 1)).toBe(true);
  });

  it("readPayrollRun lists everyone who changed compensation in the period (spec:2174 R3)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    const detail = await withTenant(db.rw, s.tenant, s.human, (tx) => readPayrollRun(tx, r.documentId));
    // `payrollFixture` entered every compensation_line as `s.human`, effective inside the period.
    expect(detail.compensationChangedBy.length).toBeGreaterThan(0);
    expect(new Set(detail.compensationChangedBy.map((c) => c.principalId))).toEqual(new Set([s.human]));
    expect(detail.compensationChangedBy.every((c) => c.employeeNumber.startsWith("E-"))).toBe(true);

    // A change effective entirely AFTER the period is not this run’s doing and is not listed.
    await db.admin`
      update app.compensation_line set effective_from = date '2099-01-01'
       where employee_id = ${f.employeeAId} and component_id = ${f.componentBasicId}`;
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) => readPayrollRun(tx, r.documentId));
    expect(after.compensationChangedBy.some((c) => c.effectiveFrom === "2099-01-01")).toBe(false);
    await db.admin`
      update app.compensation_line set effective_from = date '2026-01-01'
       where employee_id = ${f.employeeAId} and component_id = ${f.componentBasicId}`;
  });

  it("a quantity-based component writes its QUANTITY onto the payroll line (§4.12.6, §2.9)", async () => {
    // `EmployeeResult.earnings` and `.deductions` are frozen at `{ componentId; amount }` (§4.12.1), so the
    // quantity is NOT on the calculator's result — `writeLines` reads it back off `inputs.employees`. Without
    // that lookup `payroll_line.quantity` is NULL on every row the system ever writes, `readPayrollRun`
    // returns null for a column it declares, and §2.9's "unpaid-leave deduction quantity" bullet is
    // undelivered while looking delivered.
    const unpaid = await seedPayComponent(db, s, { code: "UNPAID_LEAVE", kind: "deduction", quantityBased: true });
    // Through `withTenant`, not `db.admin`: `compensation_line.entered_by` is `not null default
    // app.current_actor()` (§4.6.1) and `app.current_actor()` is NULL on a session with no actor.
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, quantity)
      values (${s.tenant}, ${f.employeeAId}, ${unpaid}, '2026-01-01', '100.0000', '3.000000')`);

    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    const [line] = await db.admin<{ quantity: string | null; amount: string }[]>`
      select pl.quantity::text as quantity, pl.amount::text as amount
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.component_id = ${unpaid}`;
    expect(line!.quantity).toBe("3.000000");    // the column's own scale, numeric(19,6) — and NOT null
    expect(line!.amount).toBe("300.0000");      // 100.0000 × 3, and NOT prorated (T6 Step 4's quantity path)

    // A FIXED component on the same run keeps a null quantity, so the lookup is reading the input and not
    // writing a default over every line.
    const [basic] = await db.admin<{ quantity: string | null }[]>`
      select pl.quantity::text as quantity from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.component_id = ${f.componentBasicId} limit 1`;
    expect(basic!.quantity).toBeNull();

    // Clean up as the compensation case above does, so the cases after this one still see eight lines.
    await db.admin`delete from app.compensation_line where component_id = ${unpaid}`;
  });

  it("gross and net are Money and never a number (§3.7.5)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    expect(r.gross).toBeInstanceOf(Money);
    expect(r.gross.currency).toBe(MYR);
    expect(r.net.isNegative()).toBe(false);
  });
});
```

- [ ] **Step 2: Write `tests/invariants/support/payroll.ts` (amendment A7)**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import {
  grantCodes, seedAccount, seedDocumentType, seedEmployee, seedPayComponent, seedRateTable,
  seedStatutoryScheme, uuidv7, type Db, type Seed,
} from "@dulja/db/test";
// The PRODUCTION `withTenant(sql, ctx, fn)` from `@dulja/db`. §4.2.2 is explicit: the 4-argument TEST helper
// stays in `packages/db/test/harness.ts` and is used only by `packages/db/test/*`; root `tests/` and every
// app use this one — the shape 1B's and 3B's own tests-tier helpers already use (1b:503, 3b:2416).
import { withTenant } from "@dulja/db";
import { ensureEmployeeDimensionValue, linkPayrollAccounts } from "@dulja/db";
// Step 3's `postPayrollRun` drives the REAL state machine, so the three services it calls are imported here
// with the rest: `calculatePayrollRun` is T10's own (`packages/db/src/hr/run.ts`, re-exported from the
// package root in Step 8) and `transitionDocument` / `postDocument` are §4.3.1's.
import { calculatePayrollRun, postDocument, transitionDocument } from "@dulja/db";
import { seedBranch } from "@dulja/db/test";
// `REPO_ROOT` is used two lines below, at module level, so it is imported HERE and Step 3's block does not
// repeat it — Step 3 adds only `ensureOpenPeriods`, which is 3B's.
import { REPO_ROOT } from "../../support/source";

/** The pack root every payroll test reads its seed files from. */
export const PAYROLL_PACK_ROOT = join(REPO_ROOT, "packages/db/seed/my");

/** The synthetic table of §4.12.4, read from the file so the fixture and the golden case cannot diverge. */
export const SYNTH_TABLE = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/db/seed/test/statutory/SYNTH/v1.json"), "utf8"),
) as Record<string, unknown>;

export interface PayrollFixture {
  documentTypeId: string;
  employeeAId: string; employeeBId: string;
  branchB: string;
  componentBasicId: string; componentAdvanceId: string;
  schemeId: string; rateTableId: string;
  salariesPayableAccountId: string;
  /** A SECOND human principal holding hr.payroll.approve and .post — R1 needs a different actor. */
  approver: string;
  /**
   * A THIRD principal holding `hr.statutory_table.verify`, for a test that verifies a table of its own.
   * It did NOT verify `rateTableId` — 8A's `seedRateTable` verifies as `s.system` (8a:4174–4176), which is
   * already a different principal from the `s.human` that loaded it.
   */
  verifier: string;
}

/**
 * Seeds everything a payroll test needs, once: the eleven §4.15 accounts, the PAYROLL type and policy, one
 * statutory scheme with its SYNTH rate table verified by a different principal, two pay components, two
 * employees in two branches, and the two extra principals R1 and 8A's verify rule require.
 *
 * It seeds from the REAL files (the chart JSON, the PAYROLL envelope, SYNTH/v1.json) rather than restating
 * their contents, so a test and the shipped pack can never disagree — the same reason `postJournal` posts
 * through the real `postDocument` rather than inserting ledger rows (§4.17.1).
 */
export async function payrollFixture(db: Db, s: Seed): Promise<PayrollFixture> { /* … Step 3 … */ }

/** Drafts, submits, approves and posts a run through the REAL state machine. Returns the document id. */
export async function postPayrollRun(
  db: Db, s: Seed, f: PayrollFixture,
  input: { periodStart: string; periodEnd: string; payDate: string; effectiveDate: string;
           kind?: "regular" | "supplementary" | "final"; employeeIds?: readonly string[] },
): Promise<string> { /* … Step 3 … */ }

/** A second human principal with the given codes — R1's "the actor differs from every submitted actor". */
export async function secondApprover(db: Db, s: Seed, codes: readonly string[]): Promise<string> { /* … Step 3 … */ }
```

- [ ] **Step 3: Write the fixture bodies**

```ts
// tests/invariants/support/payroll.ts — the three bodies, in full.
// One import to ADD to Step 2's block; `REPO_ROOT`, `uuidv7`, `calculatePayrollRun`, `transitionDocument`
// and `postDocument` are all already there.
import { ensureOpenPeriods } from "./post-inventory";     // 3B (3b:2416); see the note under this block

export async function payrollFixture(db: Db, s: Seed): Promise<PayrollFixture> {
  // Twelve OPEN monthly periods for 2026, FIRST. Plan 0A's `seedTenant` creates exactly three fiscal
  // periods — 2026-01 open, 2026-02 CLOSED, 2026-03 LOCKED — and nothing after (§4.1, plan0A:1588–1591),
  // and `app.document.fiscal_period_id` is NOT NULL, so without this a run in February dies at post with
  // ERR_PERIOD_NOT_OPEN and one in April dies at draft with ERR_PERIOD_NOT_FOUND. Every suite in T13 and
  // T14 names a month other than January. The helper is idempotent, reopens 0A's three and inserts 4–12.
  await ensureOpenPeriods(db, s, 2026);

  const chart = JSON.parse(
    readFileSync(join(PAYROLL_PACK_ROOT, "chart-of-accounts/8b-payroll.json"), "utf8"),
  ) as { code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense"; isGroup?: boolean }[];
  for (const row of chart) {
    if (row.isGroup === true) continue;      // seedAccount creates leaves; the presentation parent is the pack's
    await seedAccount(db, s, { code: row.code, nameEn: row.nameEn, type: row.type });
  }
  const [payable] = await db.admin<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = '2400'`;

  const envelope = JSON.parse(
    readFileSync(join(PAYROLL_PACK_ROOT, "document-types/PAYROLL.json"), "utf8"),
  ) as { policy: unknown };
  const documentTypeId = await seedDocumentType(db, s, { code: "PAYROLL", module: "hr", policy: envelope.policy });

  const componentBasicId = await seedPayComponent(db, s, { code: "BASIC", kind: "earning" });
  const componentAdvanceId = await seedPayComponent(db, s, { code: "ADV_RECOVERY", kind: "deduction" });
  const schemeId = await seedStatutoryScheme(db, s, { code: "EPF" });

  // 8A's `seedRateTable` LOADS as `s.human` and VERIFIES as `s.system` (8a:4174–4176, 8a:4189–4192), which
  // is two different principals by construction — that is what satisfies `app.assert_rate_table_verifier()`
  // (ERR_HR_SELF_VERIFY, spec:2080), and it is 8A's helper's job, not this fixture's. §4.17's registered
  // options are `{ schemeId; version?; definition?; verified? }` and carry no verifier, so nothing is passed.
  // `verifier` below is a SEPARATE principal this fixture mints for the tests that verify a table of their
  // own through the ordinary route; it is not what verified `rateTableId`.
  const rateTableId = await seedRateTable(db, s, {
    schemeId, version: 1, definition: SYNTH_TABLE, verified: true,
  });
  const verifier = await secondApprover(db, s, ["hr.statutory_table.verify"]);
  const [loaded] = await db.admin<{ loaded_by: string; verified_by: string }[]>`
    select loaded_by::text as loaded_by, verified_by::text as verified_by
      from app.statutory_rate_table where id = ${rateTableId}`;
  // Asserted, not assumed: spec:2080's whole content is that these two differ.
  if (loaded!.loaded_by === loaded!.verified_by) {
    throw new Error("payrollFixture: seedRateTable verified a table with its loader — 8A's ERR_HR_SELF_VERIFY guard would have refused this; check 8a:4174-4192");
  }

  const branchB = await seedBranch(db, s, { code: "BR2", nameEn: "Branch Two" });
  const employeeAId = await seedEmployee(db, s, { employeeNumber: "E-0001" });
  const employeeBId = await seedEmployee(db, s, { employeeNumber: "E-0002", homeBranchId: branchB });

  const approver = await secondApprover(db, s, ["hr.payroll.approve", "hr.payroll.post", "hr.payroll.read"]);

  const asHuman = { tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-0000-0000-000000000000" };
  await withTenant(db.rw, asHuman, async (tx) => {
    // The wiring step of T4 Step 4, inline: the fixture seeds the chart itself rather than running the seed
    // CLI, so it calls the linker for the same reason the runbook's third line does.
    await linkPayrollAccounts(tx, s.company);
    // The advance-recovery component relieves 1400. `linkPayrollAccounts` sets 5300 only where there is no
    // account yet and never overwrites, so setting it HERE — after the linker — is what makes it stick.
    // Which component that is, is an operator decision (T4 Step 2's fifth bullet); the fixture makes it.
    const [adv] = await tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = '1400'`;
    await tx`update app.pay_component set expense_account_id = ${adv!.id} where id = ${componentAdvanceId}`;
    // Two compensation lines, one per employee, effective for the whole of 2026. NO `company_id`: 8A's
    // `app.compensation_line` has none (§4.6.1, 8a:3007–3023) — the company comes through `employee_id`.
    for (const employeeId of [employeeAId, employeeBId]) {
      await tx`
        insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
        values (${s.tenant}, ${employeeId}, ${componentBasicId}, '2026-01-01', '2000.0000')`;
      await tx`
        insert into app.pay_component_scheme (tenant_id, component_id, scheme_id)
        values (${s.tenant}, ${componentBasicId}, ${schemeId})
        on conflict do nothing`;
      await ensureEmployeeDimensionValue(tx, s.company, employeeId);
    }
    await tx`
      insert into app.company_hr_setting (tenant_id, company_id, proration_rule, pay_day)
      values (${s.tenant}, ${s.company}, 'calendar_days', 5)
      on conflict (company_id) do nothing`;
  });

  return {
    documentTypeId, employeeAId, employeeBId, branchB, componentBasicId, componentAdvanceId,
    schemeId, rateTableId, salariesPayableAccountId: payable!.id, approver, verifier,
  };
}

export async function secondApprover(db: Db, s: Seed, codes: readonly string[]): Promise<string> {
  const principalId = await uuidv7(db.admin);
  await db.admin`
    insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
    values (${principalId}, ${s.tenant}, 'human', ${`test:${principalId}`}, ${`Approver ${principalId.slice(0, 8)}`})`;
  await db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
  await grantCodes(db, s, { codes: [...codes], principalId, roleCode: `role-${principalId.slice(0, 8)}` });
  return principalId;
}

export async function postPayrollRun(
  db: Db, s: Seed, f: PayrollFixture,
  input: { periodStart: string; periodEnd: string; payDate: string; effectiveDate: string;
           kind?: "regular" | "supplementary" | "final"; employeeIds?: readonly string[] },
): Promise<string> {
  const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: "00000000-0000-0000-0000-000000000000" });
  const r = await withTenant(db.rw, ctx(s.human), (tx) =>
    calculatePayrollRun(tx, ctx(s.human), {
      companyId: s.company, kind: input.kind ?? "regular",
      periodStart: input.periodStart, periodEnd: input.periodEnd, payDate: input.payDate,
      effectiveDate: input.effectiveDate, branchId: s.hq, employeeIds: input.employeeIds,
    }));
  await withTenant(db.rw, ctx(s.human), (tx) =>
    transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }));
  await withTenant(db.rw, ctx(f.approver), (tx) =>
    transitionDocument(tx, ctx(f.approver), { documentId: r.documentId, to: "approved" }));
  await withTenant(db.rw, ctx(f.approver), (tx) =>
    postDocument(tx, ctx(f.approver), { documentId: r.documentId }));
  return r.documentId;
}
```

**Why the approver is minted with `db.admin` and the codes with `grantCodes`.** `seedTenant` grants `s.human` nothing (§4.1, pinned), and R1 needs an actor that is not the submitter. `grantCodes` is the one way a DB-tier test grants a code (§4.17, 2B's row); the principal itself needs a `membership` row, which `grantCodes` does not create, so the two statements above are the minimum and follow plan0A:837's convention of inserting a principal without `RETURNING` and its membership in the same transaction.

**Why `ensureOpenPeriods` is the first statement, and whose it is.** It is **3B's**, in `tests/invariants/support/post-inventory.ts` (3b:2245 declares it, 3b:2416 implements it), filed as 3B's amendment A11 against §4.17.1 — **§4.18's round-2 table does not yet carry that row, so do not look for it in §4.17.1's printed table**; 3C imports it exactly this way (3c:3868, 3c:5055 "August is not one of 0A's three periods"), and this plan's phase gate (Phase 4 green in CI) puts Phase 3 behind it. Two consequences worth stating so nothing reads as accidental:

- **Test 38 no longer relies on March arriving locked.** After the fixture runs, 2026-03 is *open*; the test-38 case sets `status = 'closed'` itself, asserts `ERR_PERIOD_NOT_OPEN`, then reopens with a reason. That is the sequence spec:2456 describes, and it is now driven by the test rather than by a fixture constant.
- **Nothing in 8B needs `s.closedPeriod` or `s.lockedPeriod`.** Neither name appears anywhere in this plan; every period state a case needs, it sets. Reopening 0A's three is therefore invisible to this slice's own suites — but see the Execution handoff row about `sharedDb()` before calling `payrollFixture` from a regression file that shares its seed with other files.

- [ ] **Step 4: Write `packages/db/src/hr/inputs.ts`**

```ts
import type { Sql } from "postgres";
import { Money, Quantity, currency, type CurrencyCode } from "@dulja/domain";
import type { EmployeePeriodInput, PayPeriod, RateTableRef } from "@dulja/domain/payroll";
import { ensureEmployeeDimensionValue } from "./employee-dimension";
import { ytdFromPostedLines } from "./ytd";

export interface PayrollInputs {
  period: PayPeriod;
  employees: EmployeePeriodInput[];
  rateTables: RateTableRef[];
  ytdBefore: Record<string, Record<string, Money>>;
  dimensionValues: Record<string, string>;
  homeBranches: Record<string, string>;
  currency: CurrencyCode;
}

export interface LoadInputsOptions {
  companyId: string; periodStart: string; periodEnd: string; payDate: string;
  kind: "regular" | "supplementary" | "final"; employeeIds?: readonly string[];
  /** The run whose OWN manual overrides are inputs (see the override read below). */
  documentId?: string;
}

/**
 * Every input the pure calculator needs, read once.
 *
 * Which employees: everyone employed for at least one day of the period — `hired_on <= period_end` and
 * (`terminated_on is null` or `terminated_on >= period_start`) — so a mid-month leaver is on the run they
 * worked and off the next one (spec:2081's `final` run is the explicit exception and takes `employeeIds`).
 * A `supplementary` or `final` run may name its employees; a `regular` run may not, because a regular run
 * that silently skipped someone is exactly the failure a payroll register exists to catch.
 */
export async function loadPayrollInputs(tx: Sql, opts: LoadInputsOptions): Promise<PayrollInputs> {
  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${opts.companyId}`;
  if (!company) throw new Error(`ERR_NOT_FOUND: no company ${opts.companyId} in this tenant`);
  const cur = currency(company.base_currency);

  const [setting] = await tx<{ proration_rule: "calendar_days" | "working_days" }[]>`
    select proration_rule from app.company_hr_setting where company_id = ${opts.companyId}`;
  const period: PayPeriod = {
    start: opts.periodStart, end: opts.periodEnd, payDate: opts.payDate,
    // OD-28's default (Task 7). The column is 8A's and the CHECK admits exactly these two values.
    prorationRule: setting?.proration_rule ?? "calendar_days",
  };

  const named = opts.employeeIds ?? null;
  const rows = await tx<{
    id: string; home_branch_id: string; employee_number: string;
    hired_on: string; terminated_on: string | null;
  }[]>`
    select e.id, e.home_branch_id, e.employee_number,
           to_char(e.hired_on, 'YYYY-MM-DD') as hired_on,
           to_char(e.terminated_on, 'YYYY-MM-DD') as terminated_on
      from app.employee e
     where e.company_id = ${opts.companyId}
       and e.archived_at is null
       and e.hired_on <= ${opts.periodEnd}::date
       and (e.terminated_on is null or e.terminated_on >= ${opts.periodStart}::date)
       and (${named}::uuid[] is null or e.id = any(${named}::uuid[]))
     order by e.employee_number`;

  const employees: EmployeePeriodInput[] = [];
  const dimensionValues: Record<string, string> = {};
  const homeBranches: Record<string, string> = {};
  const schemeIds = new Set<string>();

  for (const e of rows) {
    // The repair path of §4.12.7 — an employee inserted before migration 0088 gets its value here, once,
    // rather than refusing at post (hazard 10: a migration cannot backfill a per-tenant row).
    dimensionValues[e.id] = await ensureEmployeeDimensionValue(tx, opts.companyId, e.id);
    homeBranches[e.id] = e.home_branch_id;

    const comp = await tx<{
      component_id: string; kind: "earning" | "deduction"; amount: string | null; quantity: string | null; scheme_ids: string[];
    }[]>`
      select cl.component_id, pc.kind, cl.amount::text as amount, cl.quantity::text as quantity,
             coalesce(array_agg(pcs.scheme_id) filter (where pcs.scheme_id is not null), '{}') as scheme_ids
        from app.compensation_line cl
        join app.pay_component pc on pc.id = cl.component_id
        left join app.pay_component_scheme pcs on pcs.component_id = cl.component_id
       where cl.employee_id = ${e.id}
         and cl.effective_from <= ${opts.periodEnd}::date
         and (cl.effective_to is null or cl.effective_to >= ${opts.periodStart}::date)
         and pc.archived_at is null
       group by cl.component_id, pc.kind, cl.amount, cl.quantity, pc.code
       order by pc.code`;

    const profileRows = await tx<{ profile: Record<string, string | number | boolean | null> }[]>`
      select to_jsonb(p) - 'id' - 'tenant_id' - 'employee_id' - 'effective_from' - 'effective_to'
             - 'entered_by' - 'created_at' as profile
        from app.employee_statutory_profile p
       where p.employee_id = ${e.id}
         and p.effective_from <= ${opts.periodEnd}::date
         and (p.effective_to is null or p.effective_to >= ${opts.periodStart}::date)
       order by p.effective_from desc limit 1`;
    // `extra` is a jsonb bag (8A, ⚠️ OD-28); its keys are lifted to the top level so a rate table's
    // `required_profile_fields` can name a verified addition without knowing whether it is a column yet.
    const base = profileRows[0]?.profile ?? {};
    const extra = (base["extra"] ?? {}) as Record<string, string | number | boolean | null>;
    const statutoryProfile = { ...extra, ...base };
    delete statutoryProfile["extra"];

    // A manual override is an input a preparer entered on THIS draft run (T11's `setStatutoryOverride`), so
    // the read is keyed on the run's OWN document id and on nothing else. A period key would be wrong twice:
    // §4.12.6 makes a `supplementary` run a first-class kind, so two drafts may legitimately cover one
    // period and each would inherit the other's overrides; and a brand-new `calculatePayrollRun` — which
    // passes no `documentId`, because its document does not exist yet — would start life carrying overrides
    // an approver entered on a different run.
    const overrideRows = opts.documentId === undefined ? [] : await tx<{
      scheme_id: string; share: "employee" | "employer"; amount: string; reason: string;
    }[]>`
      select pl.scheme_id, pl.share, pl.amount::text as amount, pl.override_reason as reason
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.document d on d.id = dl.document_id
       where pl.employee_id = ${e.id} and pl.override_reason is not null
         and d.id = ${opts.documentId} and d.status = 'draft'`;

    employees.push({
      employeeId: e.id, branchId: e.home_branch_id, hiredOn: e.hired_on, terminatedOn: e.terminated_on,
      statutoryProfile,
      compensation: comp.map((c) => ({
        componentId: c.component_id, kind: c.kind,
        // `compensation_line.amount` is numeric(19,4) and `quantity` numeric(19,6) (§4.6.1), so `::text`
        // gives "2000.0000" and "1.000000" — exactly the strings `Money.of` and `Quantity.of` document.
        // They go in whole. Global Constraint 3 / spec:2041: a money figure never touches a float, not
        // even in transit through `parseFloat`; and `Money.of` raises ERR_MONEY_SCALE if a column’s scale
        // ever drifts, where rounding it here would hide the drift. `packages/db` never imports decimal.js
        // — that is `packages/domain`’s dependency (D11, §3.1) and adding it is not this slice’s to do.
        amount: c.amount === null ? null : Money.of(c.amount, cur),
        quantity: c.quantity === null ? null : Quantity.of(c.quantity),
        schemeIds: c.scheme_ids,
      })),
      manualOverrides: overrideRows.map((o) => ({
        schemeId: o.scheme_id, share: o.share,
        amount: Money.of(o.amount, cur), reason: o.reason,
      })),
    });
    for (const c of comp) for (const id of c.scheme_ids) schemeIds.add(id);
  }

  // The rate tables covering the period, for exactly the schemes this run's components name. `verified` is
  // `verified_by is not null` — 8A's trigger already guarantees it differs from `loaded_by`.
  const tableRows = schemeIds.size === 0 ? [] : await tx<{
    scheme_id: string; scheme_code: string; version: number; effective_from: string; effective_to: string | null;
    definition: Record<string, unknown>; verified: boolean; rounding_mode: string | null;
  }[]>`
    select rt.scheme_id, sc.code as scheme_code, rt.version,
           to_char(rt.effective_from, 'YYYY-MM-DD') as effective_from,
           to_char(rt.effective_to, 'YYYY-MM-DD') as effective_to,
           rt.definition, (rt.verified_by is not null) as verified, sc.rounding_mode
      from app.statutory_rate_table rt
      join app.statutory_scheme sc on sc.id = rt.scheme_id
     where rt.scheme_id = any(${[...schemeIds]}::uuid[])
       and rt.effective_from <= ${opts.periodStart}::date
       and (rt.effective_to is null or rt.effective_to >= ${opts.periodEnd}::date)
     order by rt.scheme_id, rt.version desc`;

  // The HIGHEST version whose range covers the period, one per scheme. spec:2081: run M pins the table
  // effective at M, and a later version inserted afterwards leaves M alone (test 29).
  const rateTables: RateTableRef[] = [];
  const seen = new Set<string>();
  for (const r of tableRows) {
    if (seen.has(r.scheme_id)) continue;
    seen.add(r.scheme_id);
    rateTables.push({
      schemeId: r.scheme_id, schemeCode: r.scheme_code, version: r.version,
      effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
      // The scheme's own rounding_mode is the fallback when the FILE omits the optional member, so the pure
      // calculator stays total and never has to reach for a default of its own (ADR 0074).
      definition: { rounding_mode: r.rounding_mode ?? undefined, ...r.definition } as RateTableRef["definition"],
      verified: r.verified,
    });
  }

  const taxYear = Number.parseInt(opts.periodEnd.slice(0, 4), 10);
  const ytdBefore = await ytdFromPostedLines(tx, opts.companyId, taxYear, rows.map((r) => r.id));

  return { period, employees, rateTables, ytdBefore, dimensionValues, homeBranches, currency: cur };
}
```

Add `import { Quantity } from "@dulja/domain";` to the file's domain import line.

- [ ] **Step 5: Write `packages/db/src/hr/ytd.ts`**

```ts
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { schemeYtdKey, ytdKey } from "@dulja/domain/payroll";

/**
 * Year-to-date figures from POSTED `payroll_line` rows.
 *
 * **`app.employee_ytd` is 8C's table** (migration 0092, §4.12.8) and 8C owns the `postDocument` step-12
 * MERGE that maintains it. Between 8B and 8C the figures a payslip and a next run need come from posted
 * lines, and this is the one place that reads them — so when 8C lands, exactly one call site changes.
 *
 * Only `status = 'posted'` rows count. A draft or submitted run is not year-to-date anything.
 */
export async function ytdFromPostedLines(
  tx: Sql, companyId: string, taxYear: number, employeeIds: readonly string[],
): Promise<Record<string, Record<string, Money>>> {
  if (employeeIds.length === 0) return {};
  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${companyId}`;
  const cur = currency(company!.base_currency);

  const rows = await tx<{
    employee_id: string; scheme_code: string | null; share: "employee" | "employer" | null;
    component_kind: "earning" | "deduction" | null; is_net: boolean; total: string;
  }[]>`
    select pl.employee_id, sc.code as scheme_code, pl.share, pc.kind as component_kind,
           (pl.component_id is null and pl.scheme_id is null) as is_net,
           sum(pl.amount)::text as total
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.document d on d.id = dl.document_id
      left join app.statutory_scheme sc on sc.id = pl.scheme_id
      left join app.pay_component pc on pc.id = pl.component_id
     where pl.company_id = ${companyId}
       and d.status = 'posted'
       and extract(year from d.effective_date) = ${taxYear}
       and pl.employee_id = any(${[...employeeIds]}::uuid[])
     group by pl.employee_id, sc.code, pl.share, pc.kind, is_net`;

  const out: Record<string, Record<string, Money>> = {};
  for (const r of rows) {
    const bucket = (out[r.employee_id] ??= {});
    // `sum()` over numeric(19,4) is numeric(19,4); the text form is already at MONEY_SCALE.
    const amount = Money.of(r.total, cur);
    const key =
      r.scheme_code !== null && r.share !== null ? schemeYtdKey(r.scheme_code, r.share)
      : r.is_net ? ytdKey("net")
      : r.component_kind === "earning" ? ytdKey("gross")
      : null;                                   // a non-statutory deduction is in neither gross nor net
    if (key === null) continue;
    bucket[key] = (bucket[key] ?? Money.zero(cur)).add(amount);
  }
  return out;
}
```

- [ ] **Step 6: Write `packages/db/src/hr/run.ts`**

```ts
import type { Sql } from "postgres";
import { Money } from "@dulja/domain";
import { payrollCalculator, type EmployeeResult } from "@dulja/domain/payroll";
import type { TenantContext } from "../with-tenant";
import { PAYROLL_ACCOUNT_CODES } from "./accounts";
import { loadPayrollInputs, type PayrollInputs } from "./inputs";

export interface CalculateRunInput {
  companyId: string; kind: "regular" | "supplementary" | "final";
  periodStart: string; periodEnd: string; payDate: string;
  effectiveDate: string; branchId: string; employeeIds?: readonly string[];
}

export interface PayrollRunResult {
  documentId: string; employeeCount: number; lineCount: number;
  gross: Money; net: Money;
  pinnedTables: { schemeId: string; version: number }[];
  overrides: { documentLineId: string; employeeId: string; schemeCode: string; share: "employee" | "employer"; reason: string }[];
}

/**
 * Calculates a payroll run and writes it as a DRAFT document.
 *
 * The four tables it writes are `document`, `document_line`, `payroll_run` and `payroll_line`, and it writes
 * nothing else — no ledger row, no projection, no movement (hazard 22). `postDocument` is what posts it, and
 * the caller reaches that through the shared `…/documents/{id}/transitions` route (§4.5.4).
 *
 * Line order is FIXED, because a golden fixture byte-compares it (test 33): per employee, in the order
 * `loadPayrollInputs` returned (employee_number ascending) — earnings in component-code order, deductions in
 * component-code order, then each scheme's employee share and employer share in the order the employee's
 * components named the scheme, then the net-pay `account` line.
 */
export async function calculatePayrollRun(
  tx: Sql, ctx: TenantContext, input: CalculateRunInput,
): Promise<PayrollRunResult> {
  const inputs = await loadPayrollInputs(tx, {
    companyId: input.companyId, periodStart: input.periodStart, periodEnd: input.periodEnd,
    payDate: input.payDate, kind: input.kind, employeeIds: input.employeeIds,
  });

  // PURE. Any refusal here (ERR_PAYROLL_RATE_TABLE_UNVERIFIED, ERR_PAYROLL_INPUT_MISSING) happens BEFORE the
  // first insert, so a refused run leaves no document behind — which is the property the "writes NOTHING"
  // test asserts and the reason the calculator is called before, not during, the write loop.
  const { employees: results, pinnedTables } = payrollCalculator.calculate({
    period: inputs.period, employees: inputs.employees,
    rateTables: inputs.rateTables, ytdBefore: inputs.ytdBefore,
  });

  const [type] = await tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${input.companyId} and code = 'PAYROLL' and archived_at is null`;
  if (!type) {
    throw new Error("ERR_POLICY_REQUIRES_MISSING: document type PAYROLL is not configured for this company; apply the seed pack (bun run seed --only document-types)");
  }
  const [period] = await tx<{ id: string }[]>`
    select id from app.fiscal_period
     where company_id = ${input.companyId} and ${input.effectiveDate}::date between starts_on and ends_on`;
  if (!period) {
    throw new Error(`ERR_PERIOD_NOT_FOUND: no fiscal period of company ${input.companyId} contains ${input.effectiveDate}`);
  }

  const [created] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id,
                              effective_date, currency, exchange_rate, branch_id)
    values (${ctx.tenantId}, ${input.companyId}, ${type.id}, 'PAY', ${period.id},
            ${input.effectiveDate}::date, ${inputs.currency}, '1.00000000', ${input.branchId})
    returning id`;
  const documentId = created!.id;

  await tx`
    insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date, pinned_tables)
    values (${documentId}, ${ctx.tenantId}, ${input.companyId}, ${input.kind},
            ${input.periodStart}::date, ${input.periodEnd}::date, ${input.payDate}::date,
            ${JSON.stringify(pinnedTables)}::jsonb)`;

  const written = await writeLines(tx, ctx, {
    documentId, companyId: input.companyId, results, inputs,
  });

  return {
    documentId, employeeCount: results.length, lineCount: written.lineCount,
    gross: written.gross, net: written.net, pinnedTables, overrides: written.overrides,
  };
}

/**
 * Re-runs the calculation over an existing DRAFT run, replacing its lines.
 *
 * spec:2081: "A run may be recalculated only while draft or submitted; any recalculation after submit returns
 * it to draft and voids the pending approval." The submitted case is Task 11's transition — the caller moves
 * the run back to `draft` first, and THIS function refuses anything that is not already a draft, so a
 * submitted run cannot be recalculated behind an approver's back.
 */
export async function recalculatePayrollRun(
  tx: Sql, ctx: TenantContext, documentId: string,
): Promise<PayrollRunResult> {
  const [row] = await tx<{
    status: string; company_id: string; branch_id: string; effective_date: string;
    kind: "regular" | "supplementary" | "final"; period_start: string; period_end: string; pay_date: string;
  }[]>`
    select d.status::text as status, d.company_id, d.branch_id,
           to_char(d.effective_date, 'YYYY-MM-DD') as effective_date,
           r.kind, to_char(r.period_start, 'YYYY-MM-DD') as period_start,
           to_char(r.period_end, 'YYYY-MM-DD') as period_end, to_char(r.pay_date, 'YYYY-MM-DD') as pay_date
      from app.document d join app.payroll_run r on r.document_id = d.id
     where d.id = ${documentId} for update`;
  if (!row) throw new Error(`ERR_NOT_FOUND: no payroll run ${documentId} in this tenant`);
  if (row.status !== "draft") {
    throw new Error(`ERR_DOC_NOT_DRAFT: payroll run ${documentId} is ${row.status}; return it to draft before recalculating (spec:2081)`);
  }

  const employeeIds = (await tx<{ employee_id: string }[]>`
    select distinct pl.employee_id from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
     where dl.document_id = ${documentId}`).map((r) => r.employee_id);

  const inputs = await loadPayrollInputs(tx, {
    companyId: row.company_id, periodStart: row.period_start, periodEnd: row.period_end,
    payDate: row.pay_date, kind: row.kind,
    // THIS run's own overrides, read before the delete below removes the rows that carry them. That order
    // is why an override survives a recalculation (T11's third case) rather than being erased by it.
    documentId,
    // A `final` run keeps its named employees; a regular one re-reads the whole master, so a hire made since
    // the last calculation is picked up rather than silently missed.
    employeeIds: row.kind === "final" ? employeeIds : undefined,
  });
  const { employees: results, pinnedTables } = payrollCalculator.calculate({
    period: inputs.period, employees: inputs.employees,
    rateTables: inputs.rateTables, ytdBefore: inputs.ytdBefore,
  });

  // The CASCADE from document_line removes the payroll_line rows; the draft-only trigger admits it because
  // the parent it reads is a draft (§3.5.4's reasoning, applied to this slice's child).
  await tx`delete from app.document_line where document_id = ${documentId}`;
  await tx`update app.payroll_run set pinned_tables = ${JSON.stringify(pinnedTables)}::jsonb, calculated_at = now()
            where document_id = ${documentId}`;

  const written = await writeLines(tx, ctx, { documentId, companyId: row.company_id, results, inputs });
  return {
    documentId, employeeCount: results.length, lineCount: written.lineCount,
    gross: written.gross, net: written.net, pinnedTables, overrides: written.overrides,
  };
}

/** The ONE writer of a run's lines, shared by calculate and recalculate so the two can never disagree. */
async function writeLines(
  tx: Sql, ctx: TenantContext,
  args: { documentId: string; companyId: string; results: EmployeeResult[]; inputs: PayrollInputs },
): Promise<{ lineCount: number; gross: Money; net: Money; overrides: PayrollRunResult["overrides"] }> {
  const { documentId, companyId, results, inputs } = args;
  const [payable] = await tx<{ id: string }[]>`
    select id from app.account where company_id = ${companyId} and code = ${PAYROLL_ACCOUNT_CODES.salariesPayable}`;
  if (!payable) {
    throw new Error(`ERR_POLICY_REQUIRES_MISSING: account ${PAYROLL_ACCOUNT_CODES.salariesPayable} (salaries payable) is not in this company's chart; apply packages/db/seed/my/chart-of-accounts/8b-payroll.json`);
  }
  const schemeCodeById = new Map(inputs.rateTables.map((r) => [r.schemeId, r.schemeCode]));

  let lineNo = 0;
  let gross = Money.zero(inputs.currency);
  let net = Money.zero(inputs.currency);
  const overrides: PayrollRunResult["overrides"] = [];

  const insertLine = async (
    kind: "payroll" | "account",
    amount: Money,
    ext: { employeeId: string; componentId?: string | null; schemeId?: string | null;
           share?: "employee" | "employer" | null; quantity?: string | null;
           rateTableId?: string | null; rateTableVersion?: number | null;
           overrideReason?: string | null; accountId?: string | null; side?: "debit" | "credit" },
  ): Promise<string> => {
    lineNo += 1;
    const [line] = await tx<{ id: string }[]>`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id,
                                     debit, credit, amount, dimensions)
      values (${ctx.tenantId}, ${companyId}, ${documentId}, ${lineNo}, ${kind}, ${ext.accountId ?? null},
              ${ext.side === "debit" ? amount.toString() : "0"},
              ${ext.side === "credit" ? amount.toString() : "0"},
              ${amount.toString()},
              ${JSON.stringify({ BRANCH: inputs.homeBranches[ext.employeeId]! })}::jsonb)
      returning id`;
    // `entered_by` is supplied NON-NULL whenever `override_reason` is, and NULL otherwise. Both halves are
    // required. `payroll_line_override_check` (migration 0087) is `(override_reason is null and entered_by
    // is null) or (both not null)`, and `app.stamp_actor` on INSERT replaces a supplied value with the
    // session actor but LEAVES A NULL NULL (plan0A:2372–2375) — so an insert that omitted the column would
    // fail the CHECK on every override line, which `recalculatePayrollRun` re-creates from the overrides
    // `loadPayrollInputs` read back out of the draft. The value written is `app.current_actor()`, which is
    // what the stamp would write anyway: the column is the session's actor and never a payload's (SAH-044).
    await tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id,
                                    scheme_id, share, quantity, amount, rate_table_id, rate_table_version,
                                    override_reason, entered_by)
      values (${line!.id}, ${ctx.tenantId}, ${companyId}, ${ext.employeeId}, ${ext.componentId ?? null},
              ${ext.schemeId ?? null}, ${ext.share ?? null}, ${ext.quantity ?? null}, ${amount.toString()},
              ${ext.rateTableId ?? null}, ${ext.rateTableVersion ?? null}, ${ext.overrideReason ?? null},
              case when ${ext.overrideReason ?? null}::text is null then null else app.current_actor() end)`;
    return line!.id;
  };

  // `EmployeeResult.earnings` and `.deductions` are frozen at `{ componentId; amount }` (§4.12.1), so the
  // component's QUANTITY is not on the result — it is on the input the calculator was given. `payroll_line
  // .quantity` is `numeric(19,6)` (§4.12.6) and §2.9's card lists the unpaid-leave deduction quantity as a
  // delivery, so it is read back off `inputs.employees` here rather than left NULL on every row the system
  // ever writes. `Quantity.toString()` yields `"3.000000"` — six decimals, exactly the column's scale — and
  // a fixed-amount component has `quantity: null`, which is what the column then stores.
  const quantityOf = (employeeId: string, componentId: string): string | null =>
    inputs.employees
      .find((x) => x.employeeId === employeeId)
      ?.compensation.find((c) => c.componentId === componentId)
      ?.quantity?.toString() ?? null;

  for (const e of results) {
    for (const earning of e.earnings) {
      await insertLine("payroll", earning.amount, {
        employeeId: e.employeeId, componentId: earning.componentId,
        quantity: quantityOf(e.employeeId, earning.componentId),
      });
    }
    for (const deduction of e.deductions) {
      await insertLine("payroll", deduction.amount, {
        employeeId: e.employeeId, componentId: deduction.componentId,
        quantity: quantityOf(e.employeeId, deduction.componentId),
      });
    }
    for (const scheme of e.schemes) {
      const ref = inputs.rateTables.find((r) => r.schemeId === scheme.schemeId)!;
      const [table] = await tx<{ id: string }[]>`
        select id from app.statutory_rate_table where scheme_id = ${scheme.schemeId} and version = ${scheme.rateTableVersion}`;
      for (const share of ["employee", "employer"] as const) {
        const amount = share === "employee" ? scheme.employeeShare : scheme.employerShare;
        if (amount.isZero()) continue;     // a scheme with no employer share writes no employer line
        const override = inputs.employees.find((x) => x.employeeId === e.employeeId)!.manualOverrides
          .find((o) => o.schemeId === scheme.schemeId && o.share === share);
        const lineId = await insertLine("payroll", amount, {
          employeeId: e.employeeId, schemeId: scheme.schemeId, share,
          rateTableId: table?.id ?? null, rateTableVersion: ref.version,
          overrideReason: override?.reason ?? null,
        });
        if (override !== undefined) {
          overrides.push({
            documentLineId: lineId, employeeId: e.employeeId,
            schemeCode: schemeCodeById.get(scheme.schemeId) ?? scheme.schemeCode, share, reason: override.reason,
          });
        }
      }
    }
    // The net-pay leg: an `account` line the JOURNAL-shaped rules 6 and 7 of the policy post, with its own
    // payroll_line so `line.employee` resolves and the credit carries the EMPLOYEE dimension (spec:2101).
    await insertLine("account", e.net, {
      employeeId: e.employeeId, accountId: payable!.id, side: "credit",
    });
    gross = gross.add(e.gross);
    net = net.add(e.net);
  }

  return { lineCount: lineNo, gross, net, overrides };
}

/** The document statuses `PayrollRunSchema.status` enumerates (§4.2.8's contracts module, Step 7). */
export type PayrollRunStatus = "draft" | "submitted" | "approved" | "issued" | "void" | "posted" | "reversed";

export interface PayrollRunDetail {
  documentId: string; number: string | null; series: string; status: PayrollRunStatus;
  kind: "regular" | "supplementary" | "final";
  periodStart: string; periodEnd: string; payDate: string;
  pinnedTables: { schemeId: string; version: number }[];
  lines: { documentLineId: string; employeeId: string; employeeNumber: string; componentId: string | null;
           schemeId: string | null; share: "employee" | "employer" | null; quantity: string | null;
           amount: { amount: string; currency: string };
           rateTableVersion: number | null; overrideReason: string | null }[];
  /** spec:2174 R3 — "the approval screen lists everyone who changed compensation in the period".
   *  A read, not a screen: it ships here so the API surface is complete whether or not OD-24 lands. */
  compensationChangedBy: { principalId: string; displayName: string;
                           employeeNumber: string; effectiveFrom: string }[];
}

/** The read the approval screen and the API detail route both use (spec:2087 — overrides are LISTED). */
export async function readPayrollRun(tx: Sql, documentId: string): Promise<PayrollRunDetail> {
  const [head] = await tx<{
    number: string | null; series: string; status: PayrollRunStatus; currency: string;
    kind: "regular" | "supplementary" | "final";
    period_start: string; period_end: string; pay_date: string; pinned_tables: { schemeId: string; version: number }[];
  }[]>`
    select d.number::text as number, d.series, d.status::text as status, d.currency, r.kind,
           to_char(r.period_start, 'YYYY-MM-DD') as period_start,
           to_char(r.period_end, 'YYYY-MM-DD') as period_end,
           to_char(r.pay_date, 'YYYY-MM-DD') as pay_date, r.pinned_tables
      from app.document d join app.payroll_run r on r.document_id = d.id
     where d.id = ${documentId}`;
  if (!head) throw new Error(`ERR_NOT_FOUND: no payroll run ${documentId} in this tenant`);

  // The row shape the query returns; `amount` becomes MoneySchema's object below. A run is single-currency
  // by construction (`calculatePayrollRun` writes one `document.currency` from `PayrollInputs.currency`), so
  // the currency comes off the header once rather than being carried on every line in the database.
  type LineRow = Omit<PayrollRunDetail["lines"][number], "amount"> & { amount: string };
  const lineRows = await tx<LineRow[]>`
    select pl.document_line_id as "documentLineId", pl.employee_id as "employeeId",
           e.employee_number as "employeeNumber", pl.component_id as "componentId",
           pl.scheme_id as "schemeId", pl.share, pl.quantity::text as quantity,
           pl.amount::text as amount, pl.rate_table_version as "rateTableVersion",
           pl.override_reason as "overrideReason"
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.employee e on e.id = pl.employee_id
     where dl.document_id = ${documentId}
     order by dl.line_no`;
  // `numeric(19,4)::text` is already `"2000.0000"` — MoneySchema's `/^-?\d+\.\d{4}$/` exactly (§4.2.8). No
  // conversion, no `Number`, no re-rounding: the string goes on the wire as the column wrote it.
  const lines = lineRows.map((l) => ({ ...l, amount: { amount: l.amount, currency: head.currency } }));

  // spec:2174 R3’s list. `compensation_line.entered_by` is 8A’s stamped column (§4.6.1:
  // `entered_by uuid not null default app.current_actor()`), so the row already records who did it.
  //
  // The predicate is `effective_from BETWEEN period_start AND period_end` — a change LOCATED in the
  // period — and deliberately NOT the overlap test T11’s R3 trigger uses. The trigger fires on a change
  // event and asks "does this change reach that run?"; this read has no event, so an overlap test would
  // list every base salary entered in 2020 with a null end date on every run for ever, and a self-dealing
  // list that names everybody names nobody. Someone who changed pay in the period is in it exactly once.
  const compensationChangedBy = await tx<PayrollRunDetail["compensationChangedBy"][number][]>`
    select distinct cl.entered_by as "principalId", p.display_name as "displayName",
           e.employee_number as "employeeNumber", to_char(cl.effective_from, 'YYYY-MM-DD') as "effectiveFrom"
      from app.compensation_line cl
      join app.employee e on e.id = cl.employee_id
      join app.principal p on p.id = cl.entered_by
     where cl.employee_id in (select pl.employee_id from app.payroll_line pl
                                join app.document_line dl on dl.id = pl.document_line_id
                               where dl.document_id = ${documentId})
       and cl.effective_from between ${head.period_start}::date and ${head.period_end}::date
     order by "employeeNumber", "effectiveFrom"`;

  return {
    documentId, number: head.number, series: head.series, status: head.status, kind: head.kind,
    periodStart: head.period_start, periodEnd: head.period_end, payDate: head.pay_date,
    pinnedTables: head.pinned_tables, lines, compensationChangedBy,
  };
}
```

Add to `packages/db/src/index.ts`:

```ts
export { loadPayrollInputs, type LoadInputsOptions, type PayrollInputs } from "./hr/inputs";
export {
  calculatePayrollRun, readPayrollRun, recalculatePayrollRun,
  type CalculateRunInput, type PayrollRunDetail, type PayrollRunResult, type PayrollRunStatus,
} from "./hr/run";
export { ytdFromPostedLines } from "./hr/ytd";
```

- [ ] **Step 7: Write `packages/contracts/src/hr/payroll-run.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, DateSchema, ListEnvelope, ListQuery, MoneySchema, QuantitySchema, UuidSchema } from "../common";

export const PayrollRunKindSchema = z.enum(["regular", "supplementary", "final"]).openapi("PayrollRunKind");

export const PayrollLineSchema = z.object({
  documentLineId: UuidSchema,
  employeeId: UuidSchema,
  employeeNumber: z.string(),
  componentId: UuidSchema.nullable(),
  schemeId: UuidSchema.nullable(),
  share: z.enum(["employee", "employer"]).nullable(),
  quantity: QuantitySchema.nullable(),
  // §4.2.8's MoneySchema is an OBJECT — `{ amount: "2000.0000", currency: "MYR" }`. `readPayrollRun` builds
  // exactly that from `pl.amount::text` and the run's `document.currency` (T10 Step 6); a bare 4-dp string
  // here would typecheck against nothing the handler returns.
  amount: MoneySchema,
  rateTableVersion: z.number().int().nullable(),
  overrideReason: z.string().nullable(),
}).openapi("PayrollLine");

/** The one status union. `PayrollRunDetail.status` (T10 Step 6) is the TypeScript twin of this list, and the
 *  two are edited together or the handler's return type stops matching its declared response schema. */
export const PayrollRunStatusSchema =
  z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]).openapi("PayrollRunStatus");

export const PayrollRunSchema = z.object({
  documentId: UuidSchema,
  number: z.string().nullable(),
  series: z.string(),
  status: PayrollRunStatusSchema,
  kind: PayrollRunKindSchema,
  periodStart: DateSchema, periodEnd: DateSchema, payDate: DateSchema,
  pinnedTables: z.array(z.object({ schemeId: UuidSchema, version: z.number().int() })),
  lines: z.array(PayrollLineSchema),
  /** spec:2174 R3. Empty for a run whose employees nobody re-compensated inside the period. */
  compensationChangedBy: z.array(z.object({
    principalId: UuidSchema, displayName: z.string(),
    employeeNumber: z.string(), effectiveFrom: DateSchema,
  })),
}).openapi("PayrollRun");

export const CreatePayrollRunBody = z.object({
  kind: PayrollRunKindSchema.default("regular"),
  periodStart: DateSchema, periodEnd: DateSchema, payDate: DateSchema,
  effectiveDate: DateSchema,
  branchId: UuidSchema,
  /** Permitted only for `supplementary` and `final`; a regular run reads the whole active master. */
  employeeIds: z.array(UuidSchema).min(1).optional(),
}).openapi("CreatePayrollRunBody");

export const SetPayrollOverrideBody = z.object({
  /** spec:2087 is a **per-employee** override line. Without this the body cannot express the operation the
   *  spec names, and the UPDATE behind it would replace one line PER EMPLOYEE on the run. */
  employeeId: UuidSchema,
  schemeId: UuidSchema,
  share: z.enum(["employee", "employer"]),
  amount: MoneySchema,
  reason: z.string().min(1).max(500),
}).openapi("SetPayrollOverrideBody");

/** §4.2.8 Layer 2: literal `filter[…]` keys, four field × operator pairs, never `parseFilters`. */
export const PayrollRunQuery = ListQuery.extend({
  "filter[kind][eq]": PayrollRunKindSchema.optional(),
  "filter[status][eq]": z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]).optional(),
  "filter[periodStart][gte]": DateSchema.optional(),
  "filter[periodEnd][lte]": DateSchema.optional(),
  cursor: CursorSchema.optional(),
}).openapi("PayrollRunQuery");

// `lines` and `compensationChangedBy` are BOTH detail-only — the list handler's single head query
// returns neither, and a list item that declared them would make `openapi.json` describe a body the
// route never sends. §4.2.8's list convention is a projection of the head row, nothing more.
export const PayrollRunListItem =
  PayrollRunSchema.omit({ lines: true, compensationChangedBy: true }).openapi("PayrollRunListItem");
export const PayrollRunList = ListEnvelope(PayrollRunListItem).openapi("PayrollRunList");
```

- [ ] **Step 8: Write `apps/api/src/routes/hr/payroll-runs.ts`**

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  CreatePayrollRunBody, PayrollRunList, PayrollRunQuery, PayrollRunSchema, SetPayrollOverrideBody,
} from "@dulja/contracts/hr/payroll-run";
import { ProblemSchema, UuidSchema, encodeCursor, decodeCursor } from "@dulja/contracts";
import { calculatePayrollRun, readPayrollRun, recalculatePayrollRun, type PayrollRunStatus } from "@dulja/db";
import { setStatutoryOverride } from "@dulja/db";                       // Task 11
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../index";
import type { AppEnv } from "../../context";

export const payrollRunRoutes = new OpenAPIHono<AppEnv>();

const CompanyParam = z.object({ companyId: UuidSchema });
const RunParam = CompanyParam.extend({ documentId: UuidSchema });

/**
 * There is NO transition route here. Submit, approve and post go through 2B's generic
 * `POST /v1/companies/{companyId}/documents/{documentId}/transitions`, which resolves the effective policy
 * and applies `requireDocumentPermission` — a type-specific transition route would be a §4.2.7 violation and
 * would give PAYROLL a second authority path beside the one R1 and R2 are enforced on.
 */
payrollRunRoutes.openapi(
  createRoute({
    method: "post", path: "/",
    request: { params: CompanyParam, headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreatePayrollRunBody } } } },
    responses: {
      201: { description: "The draft run", content: { "application/json": { schema: PayrollRunSchema } } },
      422: { description: "A refusal", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.prepare"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const detail = await c.var.withTenant(async (tx) => {
      const r = await calculatePayrollRun(tx, c.var.ctx, { companyId, ...body });
      return readPayrollRun(tx, r.documentId);
    });
    return c.json(detail, 201);
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "post", path: "/{documentId}/recalculate",
    request: { params: RunParam, headers: IdempotencyHeader },
    responses: {
      200: { description: "The recalculated draft", content: { "application/json": { schema: PayrollRunSchema } } },
      409: { description: "Not a draft", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.prepare"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const detail = await c.var.withTenant(async (tx) => {
      await recalculatePayrollRun(tx, c.var.ctx, documentId);
      return readPayrollRun(tx, documentId);
    });
    return c.json(detail, 200);
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "post", path: "/{documentId}/overrides",
    request: { params: RunParam, headers: IdempotencyHeader, body: { content: { "application/json": { schema: SetPayrollOverrideBody } } } },
    responses: {
      200: { description: "The run with the override applied", content: { "application/json": { schema: PayrollRunSchema } } },
      409: { description: "Not a draft", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.prepare"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const detail = await c.var.withTenant(async (tx) => {
      await setStatutoryOverride(tx, c.var.ctx, { documentId, ...body });
      return readPayrollRun(tx, documentId);
    });
    return c.json(detail, 200);
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "get", path: "/{documentId}",
    request: { params: RunParam },
    responses: {
      200: { description: "The run", content: { "application/json": { schema: PayrollRunSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    return c.json(await c.var.withTenant((tx) => readPayrollRun(tx, documentId)), 200);
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "get", path: "/",
    request: { params: CompanyParam, query: PayrollRunQuery },
    responses: { 200: { description: "Runs", content: { "application/json": { schema: PayrollRunList } } } },
    middleware: [requirePermission(PERMISSION["hr.payroll.read"], { company: "path:companyId" })],
    tags: ["hr"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
    // `status` is the same union `PayrollRunListItem` declares, not a bare `string`: the handler returns
    // these rows straight against that schema, and a widened type here would make `openapi.json` describe a
    // body the route cannot actually produce.
    const rows = await c.var.withTenant((tx) => tx<{
      documentId: string; number: string | null; series: string; status: PayrollRunStatus;
      kind: "regular" | "supplementary" | "final"; periodStart: string; periodEnd: string; payDate: string;
      pinnedTables: { schemeId: string; version: number }[];
    }[]>`
      select d.id as "documentId", d.number::text as number, d.series, d.status::text as status, r.kind,
             to_char(r.period_start, 'YYYY-MM-DD') as "periodStart",
             to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd",
             to_char(r.pay_date, 'YYYY-MM-DD') as "payDate", r.pinned_tables as "pinnedTables"
        from app.payroll_run r join app.document d on d.id = r.document_id
       where r.company_id = ${companyId}
         and (${q["filter[kind][eq]"] ?? null}::text is null or r.kind = ${q["filter[kind][eq]"] ?? null})
         and (${q["filter[status][eq]"] ?? null}::text is null or d.status::text = ${q["filter[status][eq]"] ?? null})
         and (${q["filter[periodStart][gte]"] ?? null}::date is null or r.period_start >= ${q["filter[periodStart][gte]"] ?? null}::date)
         and (${q["filter[periodEnd][lte]"] ?? null}::date is null or r.period_end <= ${q["filter[periodEnd][lte]"] ?? null}::date)
         and (${after === null} or (r.period_start, d.id) < (${after?.k[0] ?? null}::date, ${after?.id ?? null}::uuid))
       order by r.period_start desc, d.id desc
       limit ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const next = rows.length > q.limit && page.length > 0
      ? encodeCursor({ k: [page[page.length - 1]!.periodStart], id: page[page.length - 1]!.documentId })
      : null;
    return c.json({ items: page, next_cursor: next }, 200);
  },
);

export const payrollRunRouteModule = {
  path: "/v1/companies/:companyId/payroll-runs",
  router: payrollRunRoutes,
  permissions: [PERMISSION["hr.payroll.prepare"], PERMISSION["hr.payroll.read"]] as const,
  auth: "human",
} as const;
```

Register it **inside `buildRoutes`** (§4.2.7 — never by pushing onto `ROUTES`):

```ts
// apps/api/src/routes/index.ts, inside buildRoutes(deps)
    payrollRunRouteModule,
```

- [ ] **Step 9: Add the one `PROBES` entry**

Three names to ADD to `tests/invariants/probes.ts`'s existing import block at the top of the file, beside
whatever the entries already there import — the entry below uses all three and the file carries none of them
yet: `import { payrollFixture } from "./support/payroll";` and, from the package root, `import {
calculatePayrollRun, withTenant } from "@dulja/db";` (the production 3-argument `withTenant` of §4.2.2, which
is what the tests tier uses). Add nothing else; every other name in the block belongs to another slice's
entry.

```ts
// tests/invariants/probes.ts — keyed by the exact RouteModule.path string (hazard 31).
  "/v1/companies/:companyId/payroll-runs": {
    async seed(db, owner) {
      const f = await payrollFixture(db, owner);
      // `tests/invariants/probes.ts` is the tests tier, so this is the PRODUCTION `withTenant(sql, ctx, fn)`
      // from `@dulja/db` (§4.2.2, §4.2.12) — one context, passed to both the helper and the service.
      const ctx = { tenantId: owner.tenant, actorId: owner.human, requestId: crypto.randomUUID() };
      const documentId = await withTenant(db.rw, ctx, (tx) =>
        calculatePayrollRun(tx, ctx, {
          companyId: owner.company, kind: "regular", periodStart: "2026-01-01", periodEnd: "2026-01-31",
          payDate: "2026-02-05", effectiveDate: "2026-01-31", branchId: owner.hq,
        }).then((r) => r.documentId));
      return { path: `/v1/companies/${owner.company}/payroll-runs/${documentId}`, method: "GET" };
    },
    expect: 404,
  },
```

**Why `404` and not `403`.** The attacker is a member of a different tenant, so `requirePermission`'s company scope resolves against *their* tenant and RLS reduces `app.payroll_run` to zero rows — the handler finds nothing. `ERR_NOT_FOUND` never reveals cross-tenant existence (§4.2.4).

- [ ] **Step 10: Write the route test `apps/api/test/routes/hr/payroll-runs.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { grantCodes, seedRateTable, seedTenantV2, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import { payrollFixture, secondApprover, type PayrollFixture } from "../../../../../tests/invariants/support/payroll";

let api: StartedApi; let s: Seed; let f: PayrollFixture; let preparer: string;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "Api");
  f = await payrollFixture(api.db, s);
  preparer = await secondApprover(api.db, s, ["hr.payroll.prepare", "hr.payroll.read"]);
  await api.loadPrincipals();
}, 180_000);
afterAll(async () => { await api.stop(); });

const body = {
  kind: "regular" as const, periodStart: "2026-01-01", periodEnd: "2026-01-31",
  payDate: "2026-02-05", effectiveDate: "2026-01-31", branchId: "",
};

describe("POST /v1/companies/{companyId}/payroll-runs", () => {
  it("a preparer creates a DRAFT run and gets every line back", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-runs`, as: preparer,
      body: { ...body, branchId: s.hq },
    });
    expect(res.status).toBe(201);
    const run = await res.json() as { status: string; series: string; lines: unknown[]; pinnedTables: unknown[] };
    expect(run.status).toBe("draft");
    expect(run.series).toBe("PAY");
    expect(run.lines).toHaveLength(8);
    expect(run.pinnedTables).toHaveLength(1);
  });

  it("a principal with only hr.payroll.read is refused with ERR_RBAC_FORBIDDEN (R2's pre-flight)", async () => {
    const reader = await secondApprover(api.db, s, ["hr.payroll.read"]);
    await api.loadPrincipals();
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-runs`, as: reader, body: { ...body, branchId: s.hq },
    });
    expect(res.status).toBe(403);
    expect((await res.json() as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the unsafe methods require Idempotency-Key (spec:2055)", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-runs`, as: preparer,
      body: { ...body, branchId: s.hq }, idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("an unverified rate table answers 422 ERR_PAYROLL_RATE_TABLE_UNVERIFIED through the wire (test 29)", async () => {
    // LOADED, not un-verified: `verified_by` is stamped and immutable (plan0A:2369–2386), so a table that
    // has been verified stays verified. `seedRateTable` inserts effective_from '2026-01-01' with an open
    // end, so version 2 covers the run's period and is the highest covering version.
    const unverified = await seedRateTable(api.db, s, { schemeId: f.schemeId, version: 2, verified: false });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-runs`, as: preparer, body: { ...body, branchId: s.hq },
    });
    expect(res.status).toBe(422);
    const problem = await res.json() as Problem;
    expect(problem.code).toBe("ERR_PAYROLL_RATE_TABLE_UNVERIFIED");
    expect(problem.detail).toContain("is not verified");
    expect(problem.remedy).toContain("hr.statutory_table.verify");
    // An unverified row is not frozen (8a:4315–4322), so move it clear of the period for the case below,
    // which needs a run that succeeds.
    await api.db.admin`update app.statutory_rate_table set effective_from = '2027-01-01' where id = ${unverified}`;
  });

  it("submit / approve / post go through the GENERIC transitions route, never a payroll one", async () => {
    const created = await (await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-runs`, as: preparer, body: { ...body, branchId: s.hq },
    })).json() as { documentId: string };
    const t = (to: string, as: string) => api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${created.documentId}/transitions`, as, body: { to },
    });
    expect((await t("submitted", preparer)).status).toBe(200);
    // R2, at the middleware: `preparer` holds only prepare and read, and §4.5.4's
    // `requireDocumentPermission("approve")` resolves the PAYROLL policy's `approval.approve`
    // (`hr.payroll.approve`) per request, so the request never reaches 2B's trigger. This is the AUTHORITY
    // rule, not R1 — see the maker case below for R1.
    const selfApprove = await t("approved", preparer);
    expect(selfApprove.status).toBe(403);
    expect((await selfApprove.json() as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((await t("approved", f.approver)).status).toBe(200);
    expect((await t("posted", f.approver)).status).toBe(200);

    // R1 THROUGH THE WIRE (spec:2172). A principal that holds prepare AND approve passes §4.5.4's middleware,
    // so the refusal can only come from 2B's `app.document_status_before`, which checks R1 before R2. This is
    // the case that would go green if R1 were deleted and the one above would not.
    const maker = await secondApprover(api.db, s, ["hr.payroll.prepare", "hr.payroll.approve", "hr.payroll.read"]);
    await api.loadPrincipals();
    const own = await (await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payroll-runs`, as: maker, body: { ...body, branchId: s.hq },
    })).json() as { documentId: string };
    const own_t = (to: string, as: string) => api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${own.documentId}/transitions`, as, body: { to },
    });
    expect((await own_t("submitted", maker)).status).toBe(200);
    const makerApproves = await own_t("approved", maker);
    expect(makerApproves.status).toBe(409);
    const problem = await makerApproves.json() as Problem;
    expect(problem.code).toBe("ERR_SOD_MAKER_IS_CHECKER");   // exactly this, and never an alternation
    expect(problem.detail).toContain("cannot approve it");
  });

  it("the list route pages on (period_start, id) and never accepts a flat filter parameter (§4.2.8)", async () => {
    const res = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/payroll-runs?limit=1&filter[kind][eq]=regular`, as: preparer,
    });
    expect(res.status).toBe(200);
    const page = await res.json() as { items: unknown[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    const bad = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/payroll-runs?kind=regular`, as: preparer,
    });
    expect(bad.status).toBe(200);      // an unknown parameter is IGNORED, never used — it reaches no SQL
  });
});
```

- [ ] **Step 11: Run everything**

Run: `bun run --cwd packages/db test -- payroll/run` — **expected:** PASS (10 tests).
Run: `bun run --cwd apps/api test -- routes/hr/payroll-runs` — **expected:** PASS (6 tests).
Run: `bun run --cwd tests test -- tenant-isolation` — **expected:** PASS; the harness fails the build if a `ROUTES` entry has no `PROBES` entry, and Step 9 is that entry.
Run: `bun run --cwd packages/contracts openapi:generate && git diff --stat packages/contracts/openapi.json` — **expected:** the file changes; commit it (CI fails on a diff, §4.2.7).
Run: `bun run lint`, `bun run lint:rules`, `bun run typecheck`, `bun run test` at the root — **expected:** all green.

- [ ] **Step 12: Commit**

```bash
git add packages/db/src/hr packages/db/src/index.ts \
        packages/contracts/src/hr/payroll-run.ts packages/contracts/openapi.json \
        apps/api/src/routes/hr/payroll-runs.ts apps/api/src/routes/index.ts \
        tests/invariants/probes.ts tests/invariants/support/payroll.ts \
        packages/db/test/payroll/run.test.ts apps/api/test/routes/hr/payroll-runs.test.ts
git commit -m "$(cat <<'EOF'
feat(db): calculatePayrollRun and the payroll-runs route module [8B T10]

The service writes four tables — document, document_line, payroll_run,
payroll_line — and stops. postDocument posts it, reached through 2B's GENERIC
transitions route: a type-specific transition route would give PAYROLL a second
authority path beside the one R1 and R2 are enforced on.

The pure calculator runs BEFORE the first insert, so a refused run leaves no
document behind. Line order is fixed because a golden fixture byte-compares it.
Every line carries the EMPLOYEE's home branch in document_line.dimensions, which
is why the policy's rules omit document.branch (amendment A3).

Between 8B and 8C the YTD figures come from posted payroll_line rows and
ytdFromPostedLines is the one place that reads them, so exactly one call site
changes when 8C's employee_ytd lands.

The EMPLOYEE-dimension count in run.test.ts joins app.ledger_entry_dimension on
`led.entry_id`, which is the column plan 0A's migration 0001 actually declares
(plan0A:2041-2049: `primary key (entry_id, dimension_type_id)`, `foreign key
(tenant_id, entry_id) references app.ledger_entry(tenant_id, id)`). There is no
`ledger_entry_id` column; 2A's Self-Review item 16 records the same misspelling
being found and fixed in its branch-required and zero-code suites.

writeLines carries `payroll_line.quantity` from the compensation line that
produced the component, so a quantity-based component (unpaid leave, hours) is
non-null in the column readPayrollRun and the golden fixture both read.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Migration 0090 — R3, and the manual statutory override

**Files:**
- Create: `packages/db/migrations/0090_create_compensation_change_returns_run.sql`, `packages/db/migrations/0090.down.sql`
- Create: `packages/db/src/hr/override.ts`
- Create: `packages/db/test/payroll/recalculation.test.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/payroll/recalculation.test.ts`

**Interfaces:**
- Consumes: `app.compensation_line` (8A, §4.6.1 — `employee_id`, `component_id`, `effective_from`, `effective_to`, `amount`, `quantity`, `entered_by`), `app.payroll_run`, `app.document_status_before` / `app.document_status_after` (2B, migration 0022), `app.current_actor` (§4.1), `setEventContext` (§4.3.1), `recalculatePayrollRun` (T10), `PAYROLL_ACCOUNT_CODES` (T4).
- Produces: the trigger function `app.compensation_change_returns_run()` and the trigger `compensation_line_returns_run` on `app.compensation_line`; and

```ts
// packages/db/src/hr/override.ts
export interface SetOverrideInput {
  documentId: string;
  /** spec:2087: the override is a **per-employee** line. Without it the UPDATE matches one line per employee
   *  on the run and a correction meant for one person silently restates everybody's. */
  employeeId: string;
  schemeId: string; share: "employee" | "employer";
  amount: { amount: string; currency: string }; reason: string;
}
/** Records a manual statutory override on ONE employee's line of a DRAFT run and recalculates it, so the run
 *  the approver sees is the one the override produced. `ERR_DOC_NOT_DRAFT` on anything else. */
export async function setStatutoryOverride(tx: Sql, ctx: TenantContext, input: SetOverrideInput): Promise<void>;
/** The overrides on one run, for the approval screen (spec:2087 — "flagged, listed on the approval screen"). */
export async function listOverrides(tx: Sql, documentId: string): Promise<OverrideRow[]>;
export interface OverrideRow {
  documentLineId: string; employeeId: string; employeeNumber: string; schemeCode: string;
  share: "employee" | "employer"; amount: string; reason: string; enteredBy: string; enteredAt: string;
}
```

- [ ] **Step 1: Write the failing test `packages/db/test/payroll/recalculation.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculatePayrollRun, recalculatePayrollRun } from "../../src/hr/run";
import { listOverrides, setStatutoryOverride } from "../../src/hr/override";
import { listDocumentEvents, transitionDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import { grantCodes, seedTenantV2, type Seed } from "../fixtures";
import { payrollFixture, type PayrollFixture } from "../../../../tests/invariants/support/payroll";

let db: Db; let s: Seed; let f: PayrollFixture;
const ctxOf = (seed: Seed, actor?: string) =>
  ({ tenantId: seed.tenant, actorId: actor ?? seed.human, requestId: "00000000-0000-0000-0000-000000000000" });
const RUN = {
  kind: "regular" as const, periodStart: "2026-01-01", periodEnd: "2026-01-31",
  payDate: "2026-02-05", effectiveDate: "2026-01-31",
};

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Recalc");
  f = await payrollFixture(db, s);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.compensation.manage"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("R3 — a compensation change returns a submitted run to draft (spec:2174, test 35)", () => {
  it("a change effective IN the period returns a SUBMITTED run to draft with reason compensation_changed", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }));

    // No `company_id` on `app.compensation_line` — 8A's DDL is (id, tenant_id, employee_id, component_id,
    // effective_from, effective_to, amount, quantity, entered_by, created_at); §4.6.1 and 8a:3007–3023.
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
      values (${s.tenant}, ${f.employeeAId}, ${f.componentBasicId}, '2026-01-15', '2500.0000')`);

    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("draft");

    const events = await withTenant(db.rw, s.tenant, s.human, (tx) => listDocumentEvents(tx, r.documentId));
    const back = events.filter((e) => e.fromStatus === "submitted" && e.toStatus === "draft");
    expect(back).toHaveLength(1);
    expect(back[0]!.reason).toBe("compensation_changed");
  });

  it("an APPROVED run is returned too, and the pending approval is voided (spec:2081)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      transitionDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId, to: "approved" }));

    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      update app.compensation_line set amount = '2600.0000'
       where employee_id = ${f.employeeAId} and effective_from = '2026-01-15'`);

    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("draft");
    // The pending approval is voided by construction: R1 reads `document_event` for a `submitted` event that
    // is LATER than the last `draft` one, so re-approving requires a new submission.
    const events = await withTenant(db.rw, s.tenant, s.human, (tx) => listDocumentEvents(tx, r.documentId));
    expect(events[events.length - 1]!.toStatus).toBe("draft");
  });

  it("a change effective OUTSIDE the period leaves the run alone", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
      values (${s.tenant}, ${f.employeeBId}, ${f.componentBasicId}, '2026-06-01', '9999.0000')`);
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("submitted");
  });

  it("a POSTED run is NEVER touched — the change is picked up by the next supplementary run (spec:2174)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      transitionDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId, to: "approved" }));
    await db.admin`update app.document set status = 'posted' where id = ${r.documentId}`;   // shortcut: this case is about the TRIGGER

    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
      values (${s.tenant}, ${f.employeeBId}, ${f.componentBasicId}, '2026-01-20', '3000.0000')`);
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("posted");
  });
});

describe("Manual statutory override (spec:2087)", () => {
  it("an override replaces the share, records reason + entered_by, and is LISTED for approval", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      setStatutoryOverride(tx, ctxOf(s), {
        documentId: r.documentId, employeeId: f.employeeAId, schemeId: f.schemeId, share: "employee",
        amount: { amount: "77.0000", currency: "MYR" }, reason: "authority letter 2026-01-02",
      }));

    // ONE row, not two: `payrollFixture` puts both employees on the scheme, so a run carries an `employee`
    // line for each. spec:2087's override is per-employee, and employee B's line must be untouched.
    const overrides = await withTenant(db.rw, s.tenant, s.human, (tx) => listOverrides(tx, r.documentId));
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      employeeId: f.employeeAId, schemeCode: "EPF", share: "employee", amount: "77.0000",
      reason: "authority letter 2026-01-02", enteredBy: s.human,
    });

    const [line] = await db.admin<{ amount: string; override_reason: string; entered_by: string }[]>`
      select pl.amount::text as amount, pl.override_reason, pl.entered_by::text as entered_by
        from app.payroll_line pl join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.employee_id = ${f.employeeAId} and pl.share = 'employee'`;
    expect(line!.amount).toBe("77.0000");
    expect(line!.entered_by).toBe(s.human);     // stamped from the session, never from a payload (SAH-044)

    // Employee B's share is the computed one and carries no reason.
    const [untouched] = await db.admin<{ override_reason: string | null }[]>`
      select pl.override_reason from app.payroll_line pl join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.employee_id = ${f.employeeBId} and pl.share = 'employee'`;
    expect(untouched!.override_reason).toBeNull();
  });

  it("an override on a SUBMITTED run is refused — the approver approves what will post", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }));
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      setStatutoryOverride(tx, ctxOf(s), {
        documentId: r.documentId, employeeId: f.employeeAId, schemeId: f.schemeId, share: "employee",
        amount: { amount: "1.0000", currency: "MYR" }, reason: "too late",
      }))).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("an override SURVIVES a recalculation — it is an input, not an output", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      setStatutoryOverride(tx, ctxOf(s), {
        documentId: r.documentId, employeeId: f.employeeAId, schemeId: f.schemeId, share: "employee",
        amount: { amount: "88.0000", currency: "MYR" }, reason: "authority letter",
      }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => recalculatePayrollRun(tx, ctxOf(s), r.documentId));
    const overrides = await withTenant(db.rw, s.tenant, s.human, (tx) => listOverrides(tx, r.documentId));
    expect(overrides.map((o) => o.amount)).toEqual(["88.0000"]);
    expect(overrides.map((o) => o.employeeId)).toEqual([f.employeeAId]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- payroll/recalculation`
**Expected:** the first case fails on `expect(doc!.status).toBe("draft")` receiving `"submitted"` (no trigger yet), and the override cases fail at import on `../../src/hr/override`.

- [ ] **Step 3: Write `packages/db/migrations/0090_create_compensation_change_returns_run.sql`**

```sql
-- 0090_create_compensation_change_returns_run.sql
-- R3, spec:2174, verbatim: "a compensation change effective in the period of a run in `submitted` or
-- `approved` status returns that run to `draft` (the one backward transition the state machine allows,
-- recorded in document_event with reason `compensation_changed`) and requires re-submission and
-- re-approval; a change effective in a period whose run is already `posted` never touches that run — it is
-- picked up by the next `supplementary` run."
--
-- WHY A TRIGGER (and why migration 0090 is not spare — amendment A1): R3 is a data-layer rule. Putting it in
-- the compensation handler would leave the seed CLI, the Phase 9 importer and any direct `app_rw` update
-- outside it, which is SAH-032's shape — an authority rule the data layer does not hold.

create function app.compensation_change_returns_run() returns trigger language plpgsql as $$
declare
  v_employee uuid := coalesce(new.employee_id, old.employee_id);
  v_from date := coalesce(new.effective_from, old.effective_from);
  v_to   date := coalesce(new.effective_to, old.effective_to);
  r record;
begin
  -- Only the two statuses R3 names. `draft` needs nothing (it is already there) and `posted`, `issued`,
  -- `void` and `reversed` are never touched: a posted run's figures are history (SAH-041).
  for r in
    select d.id
      from app.payroll_run pr
      join app.document d on d.id = pr.document_id
      join app.payroll_line pl on pl.employee_id = v_employee
      join app.document_line dl on dl.id = pl.document_line_id and dl.document_id = d.id
     where d.status in ('submitted', 'approved')
       and pr.period_start <= coalesce(v_to, pr.period_end)
       and pr.period_end   >= v_from
     group by d.id
  loop
    -- §4.5.2's transaction settings, which the AFTER UPDATE OF status trigger reads to write the event's
    -- reason. Without this the backward transition would be recorded with a null reason and §4.5.1's
    -- "reason required" would be a rule nothing enforces.
    perform set_config('app.event_reason', 'compensation_changed', true);
    perform set_config('app.event_attributed_to', '', true);
    update app.document set status = 'draft' where id = r.id;
  end loop;
  return coalesce(new, old);
end $$;

comment on function app.compensation_change_returns_run() is
  'spec:2174 R3 — a compensation change inside a submitted or approved run''s period returns the run to draft so the approver always approves the figures that will post.';

create trigger compensation_line_returns_run
  after insert or update or delete on app.compensation_line
  for each row execute function app.compensation_change_returns_run();
```

```sql
-- 0090.down.sql
drop trigger if exists compensation_line_returns_run on app.compensation_line;
drop function if exists app.compensation_change_returns_run() cascade;
```

**Two mechanics the implementer must not simplify.**

- **The `set_config` calls are inside the loop, not before it.** §4.5.2 fixes the settings as transaction-scoped (`true` as the third argument), and 2B's AFTER trigger reads them with `nullif(current_setting('app.event_reason', true), '')`. Setting them once before a loop that updates three runs would still work today, and would silently stop working the moment another statement in the same transaction set a different reason between two iterations. Setting them per iteration costs nothing and cannot drift.
- **The join through `payroll_line` is what scopes the rule to *this employee's* runs.** A join on `payroll_run` alone would return every run whose period overlaps, including runs the employee is not on — a `final` run for someone else, for instance — and would bounce them back to draft for no reason. The `group by d.id` is what makes one run appear once however many lines the employee has on it.

- [ ] **Step 4: Write `packages/db/src/hr/override.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { recalculatePayrollRun } from "./run";

export interface SetOverrideInput {
  documentId: string; employeeId: string; schemeId: string; share: "employee" | "employer";
  amount: { amount: string; currency: string }; reason: string;
}

export interface OverrideRow {
  documentLineId: string; employeeId: string; employeeNumber: string; schemeCode: string;
  share: "employee" | "employer"; amount: string; reason: string; enteredBy: string; enteredAt: string;
}

/**
 * spec:2087: "a per-employee override line (PCB in particular) is allowed only with a reason and
 * `entered_by`, is flagged, is listed on the approval screen and stays in the audit trail; the engine never
 * guesses, the operator is accountable."
 *
 * The override is written onto the DRAFT run's existing statutory line and the run is then recalculated, so
 * the figures the approver sees are the ones the override produced — an override that only took effect at
 * the *next* calculation would be approved unseen. `loadPayrollInputs` reads it back out of the draft's own
 * `payroll_line` rows as `manualOverrides`, which is why it survives the recalculation that follows.
 *
 * `entered_by` is stamped by `app.stamp_actor` from the session and is never a parameter (SAH-044).
 */
export async function setStatutoryOverride(
  tx: Sql, ctx: TenantContext, input: SetOverrideInput,
): Promise<void> {
  const [doc] = await tx<{ status: string }[]>`
    select d.status::text as status from app.document d
      join app.payroll_run r on r.document_id = d.id
     where d.id = ${input.documentId} for update`;
  if (!doc) throw new Error(`ERR_NOT_FOUND: no payroll run ${input.documentId} in this tenant`);
  if (doc.status !== "draft") {
    throw new Error(`ERR_DOC_NOT_DRAFT: payroll run ${input.documentId} is ${doc.status}; a statutory override is entered before submission so the approver approves what will post (spec:2081)`);
  }

  // `pl.employee_id` is part of the predicate, not an afterthought: spec:2087's override is a per-employee
  // line, and a run carries one (scheme, share) line for EVERY employee. Without it this UPDATE replaces
  // one line per employee — an authority letter about one person restating the whole run's contributions,
  // each with that person's reason attached, and every one of them "flagged" for the approver.
  const updated = await tx<{ document_line_id: string }[]>`
    update app.payroll_line pl
       set amount = ${input.amount.amount}::numeric,
           override_reason = ${input.reason},
           entered_by = app.current_actor()
      from app.document_line dl
     where dl.id = pl.document_line_id
       and dl.document_id = ${input.documentId}
       and pl.employee_id = ${input.employeeId}
       and pl.scheme_id = ${input.schemeId}
       and pl.share = ${input.share}
     returning pl.document_line_id`;
  if (updated.length === 0) {
    throw new Error(`ERR_VALIDATION_FAILED: payroll run ${input.documentId} has no ${input.share} line for employee ${input.employeeId} and scheme ${input.schemeId}; an override replaces a computed share and never invents one`);
  }
  if (updated.length > 1) {
    // One (run, employee, scheme, share) is one payroll_line by construction — `payroll_line_shape_check`
    // and the run service's own writer both say so. More than one row means the invariant has moved, and
    // guessing which line the operator meant is exactly what SAH-011 punishes.
    throw new Error(`ERR_INTERNAL: payroll run ${input.documentId} has ${updated.length} ${input.share} lines for employee ${input.employeeId} and scheme ${input.schemeId}; one was expected`);
  }

  await recalculatePayrollRun(tx, ctx, input.documentId);
}

/** The overrides on one run, oldest first, for the approval screen and for the audit trail. */
export async function listOverrides(tx: Sql, documentId: string): Promise<OverrideRow[]> {
  return tx<OverrideRow[]>`
    select pl.document_line_id as "documentLineId", pl.employee_id as "employeeId",
           e.employee_number as "employeeNumber", sc.code as "schemeCode", pl.share,
           pl.amount::text as amount, pl.override_reason as reason,
           pl.entered_by::text as "enteredBy",
           to_char(pl.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') as "enteredAt"
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.employee e on e.id = pl.employee_id
      join app.statutory_scheme sc on sc.id = pl.scheme_id
     where dl.document_id = ${documentId} and pl.override_reason is not null
     order by dl.line_no`;
}
```

Add to `packages/db/src/index.ts`:

```ts
export { listOverrides, setStatutoryOverride, type OverrideRow, type SetOverrideInput } from "./hr/override";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- payroll/recalculation` — **expected:** PASS (7 tests).

**One failure worth naming in advance.** If the R3 cases fail with `ERR_SOD_NO_SUBMISSION` or `ERR_DOC_STATUS_ILLEGAL`, 2B's `document_status_before` is refusing the trigger's own `submitted → draft` or `approved → draft` update. Both edges are legal in §4.5.1 with "reason required" as their only condition, and the `set_config` in Step 3 supplies it — so a refusal means the trigger is checking `app.actor_has` on a backward transition, which §4.5.1's own table does not ask for. Raise it as a finding against 2B rather than dropping R3.

Run: `bun run --cwd packages/db test -- payroll` — **expected:** the whole payroll folder green, including Task 10's run suite (the trigger now fires during its `compensation_line` seeding, and the fixture writes those rows **before** any run exists, so nothing bounces).
Run: `bun run --cwd packages/db test -- privileges` — **expected:** green; the §3.4.6 fingerprint now includes 0090's function.
Run: `bun run --cwd packages/db test` and `bun run typecheck` at the root.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0090_create_compensation_change_returns_run.sql \
        packages/db/migrations/0090.down.sql \
        packages/db/src/hr/override.ts packages/db/src/index.ts \
        packages/db/test/payroll/recalculation.test.ts
git commit -m "$(cat <<'EOF'
feat(db): R3 as a trigger, and the manual statutory override [8B T11]

Migration 0090 (amendment A1 — the number was listed as spare; R3 is a
data-layer rule and a data-layer rule on compensation_line is a trigger).

A compensation change effective inside a submitted or approved run's period
returns that run to draft with reason compensation_changed, so the approver
always approves the figures that will post. A posted run is never touched — the
change is picked up by the next supplementary run (spec:2174).

The override is written on the draft and the run is recalculated immediately, so
what the approver sees is what the override produced; loadPayrollInputs reads it
back as manualOverrides, which is why it survives every later recalculation.
entered_by is stamped from the session and is never a parameter (SAH-044).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: OD-23 — accountant-signed rate tables, and the synthetic table that stands in (isolated owner gate)

> **Owner decision OD-23** (§2.12; spec:2407). *"Employer registration numbers; current EPF/SOCSO/EIS/PCB tables + worked examples signed off by the accountant; staff list; pay-period/pay-date conventions."*
>
> **Owner provides:** for each scheme — **(a)** the current rate table as published by the authority, with the publication's name, URL and retrieval date; **(b)** at least two **worked examples** per scheme (an input and the authority's own answer), signed off by the accountant; **(c)** the employer registration number; **(d)** the pay-period convention (calendar month?) and the pay date.
> **Verify:** each table lands as `packages/db/seed/my/statutory/<SCHEME>/v1.json` conforming to `packages/domain/payroll/rate-table.schema.json`, and the acceptance is three commands:
> ```bash
> bun run seed --tenant "$DULJA_TENANT" --only statutory        # exit 0; 8A's loader; loaded_by = the seed principal
> # then, as a DIFFERENT principal holding hr.statutory_table.verify:
> # 8A owns the verify route and this plan does not know its path. Read it from 8A's plan, or from
> # `packages/contracts/openapi.json` once 8A has merged, and substitute it here. Whatever the path,
> # the behaviour asserted is 8A's: ERR_HR_SELF_VERIFY when the verifier is the principal who loaded it.
> curl -X POST "<8A's verify route for $TABLE_ID>" -H "Authorization: Bearer $VERIFIER_TOKEN"
> bun run --cwd tests test -- golden/payroll                     # the worked examples pass as golden cases
> ```
> **Until provided — the default written into this plan:** **`SYNTH`**, the clearly synthetic scheme of §4.12.4, loaded **only in tests** from `packages/db/seed/test/statutory/SYNTH/v1.json`. **No file exists under `packages/db/seed/my/statutory/` and this plan creates none.** Every figure in every test of this slice comes from `SYNTH` or from an in-memory table built in the test file (hazard 1, Global Constraint 8).

**Files:**
- Create: `packages/db/seed/test/statutory/SYNTH/v1.json`
- Create: `packages/db/test/payroll/synth-guard.test.ts`
- Test: `packages/db/test/payroll/synth-guard.test.ts`

**Interfaces:**
- Consumes: `packages/domain/payroll/rate-table.schema.json` and the `RateTable` type (8A, §4.12.3), 8A's `statutory` sub-pack loader, `sourceFiles` / `REPO_ROOT` / `repoFile` (§4.17.1).
- Produces: `packages/db/seed/test/statutory/SYNTH/v1.json` — the §4.12.4 file, verbatim.

- [ ] **Step 1: Write `packages/db/seed/test/statutory/SYNTH/v1.json` — §4.12.4, exactly**

```json
{
  "schema_version": 1,
  "scheme": "SYNTH",
  "version": 1,
  "kind": "banded_contribution",
  "effective_from": "2020-01-01",
  "effective_to": null,
  "source": {
    "authority": "Dulja test fixture",
    "publication": "SYNTHETIC-TEST-v1 — invented figures, no authority, never for production",
    "url": "https://example.invalid/dulja/synthetic-test-v1",
    "retrieved_on": "2026-01-01",
    "notes": "Contracts §4.12.4. Three bands with round numbers chosen so a golden fixture's arithmetic is checkable by hand. NOT a Malaysian, or any other jurisdiction's, contribution table."
  },
  "verification": {
    "verified_by": "Dulja test fixture",
    "verified_on": "2026-01-01",
    "method": "synthetic_test"
  },
  "rounding_mode": "HALF_AWAY_FROM_ZERO",
  "table": {
    "bands": [
      { "from": "0",    "to": "1000", "employee": "10.0000",  "employer": "20.0000"  },
      { "from": "1000", "to": "5000", "employee": "50.0000",  "employer": "100.0000" },
      { "from": "5000", "to": null,   "employee": "250.0000", "employer": "500.0000" }
    ]
  }
}
```

**`SYNTH` is the `scheme` and `SYNTHETIC-TEST-v1` is the display name, and they are different strings.** §2.9's Phase 8 preamble names the *table* `SYNTHETIC-TEST-v1`; §4.12.4 names the *scheme* `SYNTH` and puts the file at `SYNTH/v1.json`, because `statutory_scheme.code` matches `^[A-Z][A-Z0-9_]{1,15}$` (§4.12.3) and `SYNTHETIC-TEST-v1` does not — it holds a hyphen and lower-case characters. The file's `source.publication` carries the display name so a reader of the seeded row sees it. A plan that used `SYNTHETIC-TEST-v1` as the scheme code would fail the schema.

- [ ] **Step 2: Write the guard `packages/db/test/payroll/synth-guard.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { REPO_ROOT } from "../../../../tests/support/source";

const SCHEMA = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/domain/payroll/rate-table.schema.json"), "utf8"),
) as object;

describe("OD-23 — no real statutory table exists until the owner supplies one (hazard 1, spec:2080)", () => {
  it("packages/db/seed/my/statutory/ is ABSENT or EMPTY", () => {
    const dir = join(REPO_ROOT, "packages/db/seed/my/statutory");
    if (!existsSync(dir)) return;              // the expected state
    expect(readdirSync(dir)).toEqual([]);      // present but empty is also fine (an owner PR in flight)
  });

  it("the SYNTH table validates against the §4.12.3 schema", () => {
    const ajv = addFormats(new Ajv({ strict: false }));
    const validate = ajv.compile(SCHEMA);
    const table = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/db/seed/test/statutory/SYNTH/v1.json"), "utf8"),
    ) as unknown;
    expect(validate(table), JSON.stringify(validate.errors)).toBe(true);
  });

  it("the SYNTH table declares itself synthetic in BOTH the source and the verification", () => {
    const table = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/db/seed/test/statutory/SYNTH/v1.json"), "utf8"),
    ) as { source: { authority: string; url: string }; verification: { method: string } };
    expect(table.source.authority).toBe("Dulja test fixture");
    expect(table.source.url).toContain(".invalid");        // RFC 2606 — a domain that can never resolve
    expect(table.verification.method).toBe("synthetic_test");
  });

  it("no scheme code in the repository names a real Malaysian authority's scheme in a SEEDED file", () => {
    // The scheme CODES EPF, SOCSO, EIS and PCB are §4.15's and appear in the chart, the fixture and this
    // slice's tests — that is the model, not a rate. What must not exist is a seeded rate TABLE for one.
    const dir = join(REPO_ROOT, "packages/db/seed/my/statutory");
    if (!existsSync(dir)) return;
    for (const scheme of readdirSync(dir)) {
      expect(["EPF", "SOCSO", "EIS", "PCB"]).not.toContain(scheme);
    }
  });
});
```

- [ ] **Step 3: Run it**

Run: `bun run --cwd packages/db test -- payroll/synth-guard`
**Expected:** PASS (4 tests). The first and fourth pass because the directory does not exist; when the owner's PR lands they become the check that its files are the only ones there and that they went through 8A's loader.

- [ ] **Step 4: What changes when OD-23 lands — written now**

| Arrives | Exact change | Owner |
|---|---|---|
| A verified rate table per scheme | `packages/db/seed/my/statutory/<SCHEME>/v1.json`, applied by **8A's** `statutory` loader with `loaded_by` = the seed principal, then verified through 8A's `hr.statutory_table.verify` route by a **different** principal (`ERR_HR_SELF_VERIFY` otherwise). **No 8B code changes** — `loadPayrollInputs` already reads whatever `statutory_rate_table` holds. | 8A applies; 8B consumes |
| A scheme whose shape is none of the three `kind`s | A fourth `kind` label in `packages/domain/payroll/rate-table.schema.json` **plus** a fourth `SchemeCalculator` in `packages/domain/payroll/schemes/`. §4.12.3 is amended first; ADR 0074's consequence clause already says so. | contracts, then 8B |
| The worked examples | A golden case per example under `tests/golden/payroll/<scheme>-worked-<n>/`, byte-compared by Task 13's harness. **The examples are the acceptance**, not a supplement to it: spec:2109 names them as the PCB mitigation. | 8D's parallel run consumes them too |
| Employer registration numbers | `statutory_scheme.employer_registration` and `company_hr_setting.employer_registrations` — **8A's** columns (§4.6.1), set by 8A's company-HR-settings task. **No 8B change.** | 8A |
| The pay-period and pay-date convention | `company_hr_setting.pay_day` (8A) and the `periodStart` / `periodEnd` / `payDate` a run is created with. **No code change** — they are inputs. | operator |

- [ ] **Step 5: Commit**

```bash
git add packages/db/seed/test/statutory/SYNTH/v1.json packages/db/test/payroll/synth-guard.test.ts
git commit -m "$(cat <<'EOF'
test(db): the SYNTH table, and the guard that no real one exists yet [8B T12]

§4.12.4's synthetic table, at packages/db/seed/test/statutory/SYNTH/v1.json. The
scheme code is SYNTH and the display name SYNTHETIC-TEST-v1 — two different
strings, because statutory_scheme.code matches ^[A-Z][A-Z0-9_]{1,15}$ and the
display name does not.

The guard asserts packages/db/seed/my/statutory/ is absent or empty and that no
directory there is named for a real authority's scheme. It stays in the suite
after OD-23 lands, where it becomes the check that the owner's files are the only
ones and that they came through 8A's loader.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `tests/golden/payroll/` — acceptance tests 33 and 28

**Files:**
- Create: `tests/golden/payroll.test.ts`
- Create: `tests/golden/payroll/synth-regular/{input,expected}.json`
- Create: `tests/golden/payroll/synth-proration/{input,expected}.json`
- Create: `tests/golden/payroll/synth-missing-input/{input,expected}.json`
- Create: `tests/invariants/payroll-one-posting-path.test.ts`
- Modify: `tests/regression/sah-003.test.ts`, `tests/regression/sah-009.test.ts`
- Test: `tests/golden/payroll.test.ts`, `tests/invariants/payroll-one-posting-path.test.ts`

**Interfaces:**
- Consumes: `payrollFixture`, `postPayrollRun`, `secondApprover`, `SYNTH_TABLE` (T10, §4.17.1); `calculatePayrollRun`, `readPayrollRun` (T10); `postJournal` and `JournalLine` (1B, §4.17.1); `draftTypedDocument` (3C); `startDb`, `seedTenantV2`, `grantCodes`, `seedAccount`, `withTenant`, `uuidv7` (§4.1, §4.17); `ensureEmployeeDimensionValue` (T2).
- Produces: no production interface. Inside `tests/golden/payroll.test.ts` only (amendment A10):

```ts
export interface GoldenPayrollLine {
  employeeNumber: string; kind: "payroll" | "account";
  componentCode: string | null; schemeCode: string | null; share: "employee" | "employer" | null;
  quantity: string | null; amount: string; rateTableVersion: number | null; overrideReason: string | null;
  branchCode: string; employeeDimensionCode: string;
}
export interface GoldenLedgerRow { accountCode: string; debit: string; credit: string; dimensions: Record<string, string> }
export interface GoldenPayslip { employeeNumber: string; gross: string; net: string; schemes: { schemeCode: string; employee: string; employer: string }[] }
export interface PayrollGoldenExpectation {
  lines: GoldenPayrollLine[]; ledger: GoldenLedgerRow[]; payslips: GoldenPayslip[];
  refusal?: { code: string; detailContains: string };
}
export interface PayrollGoldenInput {
  period: { start: string; end: string; payDate: string; prorationRule: "calendar_days" | "working_days" };
  kind: "regular" | "supplementary" | "final";
  effectiveDate: string;
  employees: { employeeNumber: string; branchCode: string; hiredOn: string; terminatedOn: string | null;
               statutoryProfile: Record<string, string | number | boolean | null>;
               compensation: { componentCode: string; amount: string | null; quantity: string | null }[] }[];
  components: { code: string; kind: "earning" | "deduction"; accountCode: string; schemeCodes: string[] }[];
  schemes: { code: string; table: "SYNTH" }[];
}
```

- [ ] **Step 1: Write `tests/golden/payroll.test.ts` — the byte-compare harness (amendment A10)**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { calculatePayrollRun, ensureEmployeeDimensionValue, linkPayrollAccounts, readPayrollRun } from "@dulja/db";
import { postDocument, transitionDocument } from "@dulja/db";
// The PRODUCTION `withTenant(sql, ctx, fn)` — §4.2.2 and §4.2.12 keep the 4-argument test helper for
// `packages/db/test/*`, and root `tests/` uses this one.
import { withTenant } from "@dulja/db";
import { startDb, uuidv7, type Db } from "@dulja/db/test";
import {
  grantCodes, seedAccount, seedDocumentType, seedEmployee, seedPayComponent, seedRateTable,
  seedStatutoryScheme, seedBranch, seedTenantV2, type Seed,
} from "@dulja/db/test";
import { REPO_ROOT } from "../support/source";
import { SYNTH_TABLE, secondApprover } from "../invariants/support/payroll";

export interface GoldenPayrollLine {
  employeeNumber: string; kind: "payroll" | "account";
  componentCode: string | null; schemeCode: string | null; share: "employee" | "employer" | null;
  quantity: string | null; amount: string; rateTableVersion: number | null; overrideReason: string | null;
  branchCode: string; employeeDimensionCode: string;
}
export interface GoldenLedgerRow { accountCode: string; debit: string; credit: string; dimensions: Record<string, string> }
export interface GoldenPayslip { employeeNumber: string; gross: string; net: string; schemes: { schemeCode: string; employee: string; employer: string }[] }
export interface PayrollGoldenExpectation {
  lines: GoldenPayrollLine[]; ledger: GoldenLedgerRow[]; payslips: GoldenPayslip[];
  refusal?: { code: string; detailContains: string };
}
export interface PayrollGoldenInput {
  period: { start: string; end: string; payDate: string; prorationRule: "calendar_days" | "working_days" };
  kind: "regular" | "supplementary" | "final";
  effectiveDate: string;
  employees: { employeeNumber: string; branchCode: string; hiredOn: string; terminatedOn: string | null;
               statutoryProfile: Record<string, string | number | boolean | null>;
               compensation: { componentCode: string; amount: string | null; quantity: string | null }[] }[];
  components: { code: string; kind: "earning" | "deduction"; accountCode: string; schemeCodes: string[] }[];
  schemes: { code: string; table: "SYNTH" }[];
}

const GOLDEN_DIR = join(REPO_ROOT, "tests/golden/payroll");
const CASES = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

const CHART = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/db/seed/my/chart-of-accounts/8b-payroll.json"), "utf8"),
) as { code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense"; isGroup?: boolean }[];
const PAYROLL_ENVELOPE = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/db/seed/my/document-types/PAYROLL.json"), "utf8"),
) as { policy: unknown };

let db: Db;
beforeAll(async () => { db = await startDb(); }, 180_000);
afterAll(async () => { await db.stop(); });

/** One seeded tenant PER CASE — two cases posting into one company would sum into each other's ledger. */
async function seedCase(name: string, input: PayrollGoldenInput) { /* … Step 2 … */ }

describe.each(CASES)("golden payroll — %s (test 33, spec:2264)", (name) => {
  it("produces byte-identical lines, ledger and payslips", async () => {
    const input = JSON.parse(readFileSync(join(GOLDEN_DIR, name, "input.json"), "utf8")) as PayrollGoldenInput;
    const expected = JSON.parse(readFileSync(join(GOLDEN_DIR, name, "expected.json"), "utf8")) as PayrollGoldenExpectation;
    const actual = await runGoldenCase(name, input, expected.refusal !== undefined);
    expect(actual).toEqual(expected);
    // Byte-identity, not merely deep equality: spec:2264 wants "any formula change visible in a diff".
    expect(`${JSON.stringify(actual, null, 2)}\n`).toBe(readFileSync(join(GOLDEN_DIR, name, "expected.json"), "utf8"));
  }, 180_000);
});
```

- [ ] **Step 2: Write `seedCase` and `runGoldenCase`, in the same file**

```ts
async function seedCase(name: string, input: PayrollGoldenInput) {
  const s = await seedTenantV2(db, `golden-${name}`);
  for (const row of CHART) {
    if (row.isGroup === true) continue;
    await seedAccount(db, s, { code: row.code, nameEn: row.nameEn, type: row.type });
  }
  const documentTypeId = await seedDocumentType(db, s, { code: "PAYROLL", module: "hr", policy: PAYROLL_ENVELOPE.policy });

  const verifier = await secondApprover(db, s, ["hr.statutory_table.verify"]);
  const approver = await secondApprover(db, s, ["hr.payroll.approve", "hr.payroll.post"]);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.payroll.read"] });

  const schemeIdByCode = new Map<string, string>();
  for (const scheme of input.schemes) {
    const id = await seedStatutoryScheme(db, s, { code: scheme.code });
    schemeIdByCode.set(scheme.code, id);
    await seedRateTable(db, s, { schemeId: id, version: 1, definition: SYNTH_TABLE, verified: true });
  }

  const componentIdByCode = new Map<string, string>();
  for (const c of input.components) {
    const id = await seedPayComponent(db, s, { code: c.code, kind: c.kind });
    componentIdByCode.set(c.code, id);
  }

  const branchIdByCode = new Map<string, string>([["HQ", s.hq]]);
  const employeeIdByNumber = new Map<string, string>();
  const asHuman = { tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-0000-0000-000000000000" };

  await withTenant(db.rw, asHuman, async (tx) => {
    await linkPayrollAccounts(tx, s.company);
    for (const c of input.components) {
      const [account] = await tx<{ id: string }[]>`
        select id from app.account where company_id = ${s.company} and code = ${c.accountCode}`;
      await tx`update app.pay_component set expense_account_id = ${account!.id} where id = ${componentIdByCode.get(c.code)!}`;
      for (const schemeCode of c.schemeCodes) {
        await tx`insert into app.pay_component_scheme (tenant_id, component_id, scheme_id)
                 values (${s.tenant}, ${componentIdByCode.get(c.code)!}, ${schemeIdByCode.get(schemeCode)!})
                 on conflict do nothing`;
      }
    }
    await tx`insert into app.company_hr_setting (tenant_id, company_id, proration_rule, pay_day)
             values (${s.tenant}, ${s.company}, ${input.period.prorationRule}, 5)
             on conflict (company_id) do nothing`;
  });

  for (const e of input.employees) {
    if (!branchIdByCode.has(e.branchCode)) {
      branchIdByCode.set(e.branchCode, await seedBranch(db, s, { code: e.branchCode, nameEn: e.branchCode }));
    }
    const employeeId = await seedEmployee(db, s, {
      employeeNumber: e.employeeNumber, homeBranchId: branchIdByCode.get(e.branchCode)!,
    });
    employeeIdByNumber.set(e.employeeNumber, employeeId);
    await withTenant(db.rw, asHuman, async (tx) => {
      await tx`update app.employee set hired_on = ${e.hiredOn}::date,
                                       terminated_on = ${e.terminatedOn}::date where id = ${employeeId}`;
      await tx`insert into app.employee_statutory_profile (tenant_id, employee_id, effective_from, extra)
               values (${s.tenant}, ${employeeId}, '2020-01-01', ${JSON.stringify(e.statutoryProfile)}::jsonb)`;
      for (const c of e.compensation) {
        // No `company_id`: 8A's `app.compensation_line` is (id, tenant_id, employee_id, component_id,
        // effective_from, effective_to, amount, quantity, entered_by, created_at) — §4.6.1 and 8a:3007–3023.
        // The company comes through `employee_id` → `app.employee(tenant_id, id)`.
        await tx`insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, quantity)
                 values (${s.tenant}, ${employeeId}, ${componentIdByCode.get(c.componentCode)!},
                         '2020-01-01', ${c.amount}::numeric, ${c.quantity}::numeric)`;
      }
      await ensureEmployeeDimensionValue(tx, s.company, employeeId);
    });
  }
  return { s, documentTypeId, approver, verifier, employeeIdByNumber, branchIdByCode, schemeIdByCode, componentIdByCode };
}

async function runGoldenCase(
  name: string, input: PayrollGoldenInput, expectRefusal: boolean,
): Promise<PayrollGoldenExpectation> {
  const seeded = await seedCase(name, input);
  const { s, approver, employeeIdByNumber, componentIdByCode, schemeIdByCode } = seeded;
  const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: "00000000-0000-0000-0000-000000000000" });

  /**
   * Every id this case minted, replaced by the CODE it stands for.
   *
   * The refusal message names an employee and a component **by id** — the calculator is pure and has never
   * seen a code — and every one of those ids is a fresh uuidv7 on every run. Writing the raw message into
   * `expected.json` would make the byte-comparison fail on the second run for a reason that has nothing to
   * do with payroll. This is the same projection the three queries below apply, applied to prose: ids out,
   * codes in. `sort` by length descending so no id is a prefix of the substitution of another.
   */
  const toCodes = (text: string): string => {
    const pairs: [string, string][] = [
      ...[...employeeIdByNumber].map(([code, id]) => [id, code] as [string, string]),
      ...[...componentIdByCode].map(([code, id]) => [id, code] as [string, string]),
      ...[...schemeIdByCode].map(([code, id]) => [id, code] as [string, string]),
    ].sort((a, b) => b[0].length - a[0].length);
    return pairs.reduce((acc, [id, code]) => acc.split(id).join(code), text);
  };

  if (expectRefusal) {
    let code = ""; let detail = "";
    try {
      await withTenant(db.rw, ctx(s.human), (tx) =>
        calculatePayrollRun(tx, ctx(s.human), {
          companyId: s.company, kind: input.kind, periodStart: input.period.start, periodEnd: input.period.end,
          payDate: input.period.payDate, effectiveDate: input.effectiveDate, branchId: s.hq,
        }));
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      detail = toCodes((e as { detail?: string; message?: string }).detail ?? (e as Error).message);
    }
    // A refused case posts nothing: the expectation's three arrays are empty and the refusal is the content.
    return { lines: [], ledger: [], payslips: [], refusal: { code, detailContains: detail } };
  }

  const r = await withTenant(db.rw, ctx(s.human), (tx) =>
    calculatePayrollRun(tx, ctx(s.human), {
      companyId: s.company, kind: input.kind, periodStart: input.period.start, periodEnd: input.period.end,
      payDate: input.period.payDate, effectiveDate: input.effectiveDate, branchId: s.hq,
    }));
  await withTenant(db.rw, ctx(s.human), (tx) =>
    transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }));
  await withTenant(db.rw, ctx(approver), (tx) =>
    transitionDocument(tx, ctx(approver), { documentId: r.documentId, to: "approved" }));
  await withTenant(db.rw, ctx(approver), (tx) =>
    postDocument(tx, ctx(approver), { documentId: r.documentId }));

  const lines = await db.admin<GoldenPayrollLine[]>`
    select e.employee_number as "employeeNumber", dl.kind, pc.code as "componentCode",
           sc.code as "schemeCode", pl.share, pl.quantity::text as quantity, pl.amount::text as amount,
           pl.rate_table_version as "rateTableVersion", pl.override_reason as "overrideReason",
           bv.code as "branchCode", ev.code as "employeeDimensionCode"
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.employee e on e.id = pl.employee_id
      left join app.pay_component pc on pc.id = pl.component_id
      left join app.statutory_scheme sc on sc.id = pl.scheme_id
      join app.dimension_value bv on bv.id = (dl.dimensions->>'BRANCH')::uuid
      join app.dimension_type et on et.company_id = pl.company_id and et.code = 'EMPLOYEE'
      join app.dimension_value ev on ev.dimension_type_id = et.id and ev.code = e.employee_number
     where dl.document_id = ${r.documentId}
     order by dl.line_no`;

  const ledger = await db.admin<GoldenLedgerRow[]>`
    select a.code as "accountCode", le.debit::text as debit, le.credit::text as credit,
           coalesce(jsonb_object_agg(dt.code, dv.code) filter (where dt.code is not null), '{}'::jsonb) as dimensions
      from app.ledger_entry le
      join app.account a on a.id = le.account_id
      left join app.ledger_entry_dimension led on led.entry_id = le.id
      left join app.dimension_value dv on dv.id = led.dimension_value_id
      left join app.dimension_type dt on dt.id = dv.dimension_type_id
     where le.document_id = ${r.documentId}
     group by le.id, a.code, le.debit, le.credit, le.line_no
     order by le.line_no`;

  const payslips = await db.admin<GoldenPayslip[]>`
    with per_employee as (
      select e.employee_number,
             sum(pl.amount) filter (where pc.kind = 'earning') as gross,
             sum(pl.amount) filter (where pl.component_id is null and pl.scheme_id is null) as net
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.employee e on e.id = pl.employee_id
        left join app.pay_component pc on pc.id = pl.component_id
       where dl.document_id = ${r.documentId}
       group by e.employee_number),
    per_scheme as (
      select e.employee_number, sc.code as scheme_code,
             coalesce(sum(pl.amount) filter (where pl.share = 'employee'), 0) as employee,
             coalesce(sum(pl.amount) filter (where pl.share = 'employer'), 0) as employer
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.employee e on e.id = pl.employee_id
        join app.statutory_scheme sc on sc.id = pl.scheme_id
       where dl.document_id = ${r.documentId}
       group by e.employee_number, sc.code)
    select pe.employee_number as "employeeNumber", pe.gross::text as gross, pe.net::text as net,
           coalesce(jsonb_agg(jsonb_build_object('schemeCode', ps.scheme_code,
                                                 'employee', ps.employee::text,
                                                 'employer', ps.employer::text)
                              order by ps.scheme_code) filter (where ps.scheme_code is not null), '[]'::jsonb) as schemes
      from per_employee pe left join per_scheme ps on ps.employee_number = pe.employee_number
     group by pe.employee_number, pe.gross, pe.net
     order by pe.employee_number`;

  return { lines, ledger, payslips };
}
```

**Why the projections drop every id.** A golden fixture that carried uuids would differ on every run (uuidv7 is time-ordered and the container is fresh each time), so the expectation compares **codes** — `employeeNumber`, `componentCode`, `schemeCode`, `accountCode`, `branchCode`, `employeeDimensionCode`. That is hazard 18's fixed-projection discipline applied to a golden file, and it is what makes "any formula change shows as a diff" (spec:2264) true rather than aspirational.

**And why `toCodes` exists.** The rule has one place it is easy to miss: the **refusal message**. `PayrollCalculationError`'s detail names the employee and the component by **id**, because the calculator is pure and never sees a code — so `refusal.detailContains` would carry two fresh uuids into `expected.json` and the byte-comparison would fail on the very next run, for a reason with nothing to do with payroll. `toCodes` applies the same ids-out/codes-in projection to the message, so `synth-missing-input`'s expectation reads `employee E-0201 has a quantity of 8.000000 on component OT and no per-unit amount; …` — stable, and legible in a diff, which is the whole point of a golden file.

- [ ] **Step 3: Write the three cases**

`tests/golden/payroll/synth-regular/input.json` — two employees, one earning joined to `SYNTH`, one advance-recovery deduction on the second:

```json
{
  "period": { "start": "2026-01-01", "end": "2026-01-31", "payDate": "2026-02-05", "prorationRule": "calendar_days" },
  "kind": "regular",
  "effectiveDate": "2026-01-31",
  "schemes": [{ "code": "EPF", "table": "SYNTH" }],
  "components": [
    { "code": "BASIC",        "kind": "earning",   "accountCode": "5300", "schemeCodes": ["EPF"] },
    { "code": "ADV_RECOVERY", "kind": "deduction", "accountCode": "1400", "schemeCodes": [] }
  ],
  "employees": [
    { "employeeNumber": "E-0001", "branchCode": "HQ",  "hiredOn": "2020-01-01", "terminatedOn": null,
      "statutoryProfile": {},
      "compensation": [{ "componentCode": "BASIC", "amount": "2000.0000", "quantity": null }] },
    { "employeeNumber": "E-0002", "branchCode": "BR2", "hiredOn": "2020-01-01", "terminatedOn": null,
      "statutoryProfile": {},
      "compensation": [
        { "componentCode": "BASIC",        "amount": "6000.0000", "quantity": null },
        { "componentCode": "ADV_RECOVERY", "amount": "500.0000",  "quantity": null }
      ] }
  ]
}
```

`tests/golden/payroll/synth-proration/input.json` — the same shape with one mid-month joiner and one mid-month leaver, so the proration arithmetic is pinned:

```json
{
  "period": { "start": "2026-01-01", "end": "2026-01-31", "payDate": "2026-02-05", "prorationRule": "calendar_days" },
  "kind": "regular",
  "effectiveDate": "2026-01-31",
  "schemes": [{ "code": "EPF", "table": "SYNTH" }],
  "components": [{ "code": "BASIC", "kind": "earning", "accountCode": "5300", "schemeCodes": ["EPF"] }],
  "employees": [
    { "employeeNumber": "E-0101", "branchCode": "HQ", "hiredOn": "2026-01-17", "terminatedOn": null,
      "statutoryProfile": {},
      "compensation": [{ "componentCode": "BASIC", "amount": "3100.0000", "quantity": null }] },
    { "employeeNumber": "E-0102", "branchCode": "HQ", "hiredOn": "2020-01-01", "terminatedOn": "2026-01-10",
      "statutoryProfile": {},
      "compensation": [{ "componentCode": "BASIC", "amount": "3100.0000", "quantity": null }] }
  ]
}
```

`tests/golden/payroll/synth-missing-input/input.json` — the refusal case that is test 33's second clause:

```json
{
  "period": { "start": "2026-01-01", "end": "2026-01-31", "payDate": "2026-02-05", "prorationRule": "calendar_days" },
  "kind": "regular",
  "effectiveDate": "2026-01-31",
  "schemes": [{ "code": "EPF", "table": "SYNTH" }],
  "components": [{ "code": "OT", "kind": "earning", "accountCode": "5300", "schemeCodes": ["EPF"] }],
  "employees": [
    { "employeeNumber": "E-0201", "branchCode": "HQ", "hiredOn": "2020-01-01", "terminatedOn": null,
      "statutoryProfile": {},
      "compensation": [{ "componentCode": "OT", "amount": null, "quantity": "8.000000" }] }
  ]
}
```

- [ ] **Step 4: Generate the three `expected.json` files — then READ them**

```bash
cd tests
UPDATE_GOLDEN=1 node ../node_modules/vitest/vitest.mjs run golden/payroll.test.ts
```

Add the write path to the harness for exactly this purpose, guarded so CI can never take it:

```ts
    if (process.env["UPDATE_GOLDEN"] === "1") {
      writeFileSync(join(GOLDEN_DIR, name, "expected.json"), `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }
```

Then **read all three generated files and check every figure by hand against the table below.** A generated expected file nobody read is not a golden fixture; it is a snapshot of whatever the code did.

| Case | Employee | Check |
|---|---|---|
| `synth-regular` | E-0001 | gross `2000.0000`; base 2000 falls in `SYNTH` band 2 `[1000, 5000)` → employee `50.0000`, employer `100.0000`; net `1950.0000`; ledger `5300` debit 2000, `2411` credit 50, `5311` debit 100, `2411` credit 100, `2400` credit 1950 — and Σdebit (2100) = Σcredit (2100). |
| `synth-regular` | E-0002 | gross `6000.0000` (the advance recovery is a **deduction**, not an earning); base 6000 falls in band 3 `[5000, ∞)` → employee `250.0000`, employer `500.0000`; net `6000 − 500 − 250 = 5250.0000`; ledger adds `1400` credit 500 for the recovery; BRANCH is `BR2` on every one of E-0002's lines and `HQ` on every one of E-0001's. |
| `synth-proration` | E-0101 | joiner: 15 eligible days of 31 → gross `3100 × 15/31 = 1500.0000` exactly; base 1500 falls in band 2 → employee `50.0000`, employer `100.0000`; net `1500 − 50 = 1450.0000`. |
| `synth-proration` | E-0102 | leaver: 10 eligible days of 31 → gross `3100 × 10/31 = 1000.0000` exactly; **band 2**, because 1000 is the *inclusive lower bound* of `[1000, 5000)` — the boundary is the point of this case; employee `50.0000`, employer `100.0000`; net `1000 − 50 = 950.0000`. |
| `synth-proration` | both | **The shares are NOT prorated.** Proration applies to the earning, and the contribution is then read from the table at the prorated base — which is why E-0101 and E-0102 land on the same band and pay the same `50.0000` from different gross figures. If an expected file shows `50 × 15/31`, `calculate` is prorating in the wrong place; fix the calculator, never the fixture. Whether a **real** scheme prorates its own bands is a rate-table fact and is OD-23's to answer, not this plan's. |
| `synth-missing-input` | E-0201 | `lines`, `ledger` and `payslips` are all `[]`; `refusal.code` is `ERR_PAYROLL_INPUT_MISSING` and `refusal.detailContains` — after `toCodes` has put codes back where the calculator wrote ids — reads exactly `employee E-0201 has a quantity of 8.000000 on component OT and no per-unit amount; a quantity without a rate is not a zero line`. **Both halves matter:** it names the **employee** (test 33's clause, "fails the run naming the employee, never a silent zero") and the **component**, which is what makes the refusal actionable. If the message names neither and says "has no compensation line carrying an amount" instead, `assertComponentInputs` is running *after* `firstCurrency` in T6 Step 4 — fix the order, not the fixture. |

Run `git diff --stat tests/golden/payroll` — **expected:** three new `expected.json` files.

- [ ] **Step 5: Write `tests/invariants/payroll-one-posting-path.test.ts` — acceptance test 28**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, type Db } from "@dulja/db/test";
import { grantCodes, seedAccount, seedTenantV2, type Seed } from "@dulja/db/test";
import { calculatePayrollRun } from "@dulja/db";
// The PRODUCTION withTenant (§4.2.2, §4.2.12): root `tests/` never uses the 4-argument test helper.
import { withTenant } from "@dulja/db";
import { postDocument, transitionDocument } from "@dulja/db";
import { postJournal } from "./support/post-journal";
import { payrollFixture, type PayrollFixture } from "./support/payroll";

let db: Db; let s: Seed; let f: PayrollFixture;
const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: "00000000-0000-0000-0000-000000000000" });

/** Hazard 18's fixed projection: ids, document_id, line_no, posted_at, posted_by and posting_policy_id out. */
async function ledgerMultiset(documentId: string) {
  const rows = await db.admin<{
    account_code: string; debit: string; credit: string; currency: string; exchange_rate: string;
    base_debit: string; base_credit: string; effective_date: string; fiscal_period_id: string;
  }[]>`
    select a.code as account_code, le.debit::text as debit, le.credit::text as credit, le.currency,
           le.exchange_rate::text as exchange_rate, le.base_debit::text as base_debit,
           le.base_credit::text as base_credit, to_char(le.effective_date, 'YYYY-MM-DD') as effective_date,
           le.fiscal_period_id::text as fiscal_period_id
      from app.ledger_entry le join app.account a on a.id = le.account_id
     where le.document_id = ${documentId}`;
  return rows.map((r) => JSON.stringify(r)).sort();
}

async function dimensionMultiset(documentId: string) {
  const rows = await db.admin<{ type_code: string; value_id: string }[]>`
    select dt.code as type_code, led.dimension_value_id::text as value_id
      from app.ledger_entry_dimension led
      join app.ledger_entry le on le.id = led.entry_id
      join app.dimension_value dv on dv.id = led.dimension_value_id
      join app.dimension_type dt on dt.id = dv.dimension_type_id
     where le.document_id = ${documentId}`;
  return rows.map((r) => `${r.type_code}:${r.value_id}`).sort();
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test28");
  f = await payrollFixture(db, s);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "accounting.journal.post", "accounting.journal.create"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("acceptance test 28 — one payroll posting path (spec:2446, SAH-003, SAH-009)", () => {
  it("a PAYROLL run and a hand-keyed JOURNAL with the same lines produce IDENTICAL ledger rows", async () => {
    // ── the PAYROLL side ────────────────────────────────────────────────────────────────────────────
    const run = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company, kind: "regular", periodStart: "2026-01-01", periodEnd: "2026-01-31",
        payDate: "2026-02-05", effectiveDate: "2026-01-15", branchId: s.hq,
        employeeIds: [f.employeeAId],
      }));
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: run.documentId, to: "submitted" }));
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      transitionDocument(tx, ctx(f.approver), { documentId: run.documentId, to: "approved" }));
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      postDocument(tx, ctx(f.approver), { documentId: run.documentId }));

    // ── the hand-keyed JOURNAL side, built FROM the payroll ledger so the figures cannot drift ──────
    const payrollRows = await db.admin<{ code: string; debit: string; credit: string; dims: Record<string, string> }[]>`
      select a.code, le.debit::text as debit, le.credit::text as credit,
             coalesce(jsonb_object_agg(dt.code, led.dimension_value_id) filter (where dt.code is not null), '{}'::jsonb) as dims
        from app.ledger_entry le
        join app.account a on a.id = le.account_id
        left join app.ledger_entry_dimension led on led.entry_id = le.id
        left join app.dimension_value dv on dv.id = led.dimension_value_id
        left join app.dimension_type dt on dt.id = dv.dimension_type_id
       where le.document_id = ${run.documentId}
       group by le.id, a.code, le.debit, le.credit, le.line_no order by le.line_no`;

    const accountIdByCode = new Map((await db.admin<{ code: string; id: string }[]>`
      select code, id from app.account where company_id = ${s.company}`).map((a) => [a.code, a.id]));

    // `account`, not `accountId` — 1B's frozen JournalLine is `{ account; debit?; credit? }` (1b:592–598,
    // contracts §4.17.1). `dimensions` is the one member amendment A13 adds, in the edit below.
    const journal = await postJournal(db, s, payrollRows.map((r) => ({
      account: accountIdByCode.get(r.code)!,
      debit: r.debit, credit: r.credit,
      dimensions: r.dims,
    })), { effectiveDate: "2026-01-15" });

    // ── the comparison, on hazard 18's fixed projection ─────────────────────────────────────────────
    expect(await ledgerMultiset(journal.documentId)).toEqual(await ledgerMultiset(run.documentId));
    expect(await dimensionMultiset(journal.documentId)).toEqual(await dimensionMultiset(run.documentId));
  }, 180_000);

  it("the two documents pin DIFFERENT policies, which is why posting_policy_id is projected out", async () => {
    const rows = await db.admin<{ n: number }[]>`
      select count(distinct posting_policy_id)::int as n from app.document
       where company_id = ${s.company} and posting_policy_id is not null`;
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});
```

**Edit `tests/invariants/support/post-journal.ts` in this commit — amendment A13, and it is not conditional.** 1B shipped `JournalLine` as exactly `{ account: string; debit?: string; credit?: string }` (1b:592–598), registered frozen at §4.17.1, and `postJournal`'s `document_line` insert names `(tenant_id, company_id, document_id, line_no, account_id, debit, credit)` (1b:638–641) — **no `dimensions`**. Without the member the hand-keyed side carries no EMPLOYEE and test 28's second multiset comparison is vacuous, which is the half that proves spec:2101 reached `ledger_entry_dimension`. Two additive changes, nothing removed and no existing caller affected:

```ts
// tests/invariants/support/post-journal.ts (1B's file) — the interface gains ONE optional member.
export interface JournalLine {
  /** app.account id. */
  account: string;
  /** Fixed 4 dp, document currency. Exactly one of debit/credit is non-zero. */
  debit?: string;
  credit?: string;
  /**
   * 8B, amendment A13. dimension-type CODE → `dimension_value.id`, the exact shape of
   * `document_line.dimensions` (§4.3.4). Omitted, the column takes its `'{}'::jsonb` default and every
   * pre-8B caller behaves exactly as before.
   */
  dimensions?: Record<string, string>;
}
```

```ts
// …and the insert inside postJournal gains the column, keeping every other value as 1B wrote it:
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id,
                                              debit, credit, dimensions)
               values (${s.tenant}, ${s.company}, ${documentId}, ${lineNo}, ${l.account},
                       ${l.debit ?? "0"}, ${l.credit ?? "0"},
                       ${JSON.stringify(l.dimensions ?? {})}::jsonb)`;
```

**Why that is enough to make the comparison real.** `JOURNAL_POLICY_V1`'s two rules declare **no** `dimensions` block (1a:2371–2374), so 2A's `dimensionsFor` falls back to its documented default `["line.dimensions", "document.branch"]` (2a:1754–1759): the line's own bag is read, and the header's BRANCH then wins over whatever the bag held (2a:1766, SAH-042/SAH-050). So EMPLOYEE arrives from the bag and BRANCH from the JOURNAL document's own header — which is `s.hq`, the same branch employee A's PAYROLL line carries, because test 28 runs on `f.employeeAId` alone. `postLines` is deliberately not used: §4.17.1 makes `postJournal` "the only way a test creates ledger rows" from 1A onward, and test 28's whole claim is *two documents, one posting service*.

- [ ] **Step 6: Append the 8B blocks to `sah-003` and `sah-009`**

**Every appended block below mints its OWN tenant, and that is load-bearing rather than tidy.**
`payrollFixture` is **not idempotent**: it calls `seedAccount` for eleven fixed codes, `seedDocumentType('PAYROLL')`, `seedStatutoryScheme('EPF')`, `seedRateTable(scheme, version 1)`, `seedBranch('BR2')` and `seedEmployee('E-0001'/'E-0002')`, and every one of those is unique per company. Two blocks calling it against `sharedDb()`'s shared `seedA` would make the second die on a duplicate key — the symptom the Execution handoff's `T10 / T13 / T14` row names. The remedy is the first of the two that row gives: **one `seedTenantV2` tenant per block, on `sharedDb()`'s shared container**, which is 3B's `costingContext(sah)` precedent (3b:6106) applied without a new shared module. The second remedy — `on conflict do nothing` inside the fixture — is the one the handoff rules out, because it hides which suite owns the row.

The five blocks' tenant names are `"SAH-003"`, `"SAH-009"`, `"SAH-013"`, `"SAH-031"` and `"SAH-042"`; `seedTenantV2(db, name)` takes the name as its only argument (§4.17, 1A) and each is distinct, so no two blocks can collide however the files are ordered.

**Imports for each block go into the file's existing import block at the top**, beside whatever 0B put there — the same placement 2A used (2a:4664) and 3B restates (3b:6384). Each block below names the ones it needs on the line above its `describe`; append only those, and leave every existing import alone.

```ts
// tests/regression/sah-003.test.ts — APPEND
// Add to the file's existing import block: `seedTenantV2` from "@dulja/db/test", and
// `payrollFixture`, `postPayrollRun` from "../invariants/support/payroll".
describe("SAH-003 Nothing enforces that debits equal credits — 8B", () => {
  it("a posted PAYROLL run balances in base currency, and the constraint is what says so", async () => {
    const { db } = await sharedDb();
    // This block's OWN tenant on the shared container — payrollFixture is not idempotent (see the box above).
    const s = await seedTenantV2(db, "SAH-003");
    const f = await payrollFixture(db, s);
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05", effectiveDate: "2026-01-31",
    });
    const [sums] = await db.admin<{ d: string; c: string }[]>`
      select coalesce(sum(base_debit), 0)::text as d, coalesce(sum(base_credit), 0)::text as c
        from app.ledger_entry where document_id = ${documentId}`;
    expect(sums!.d).toBe(sums!.c);
    // And the DEFERRED constraint is the control, not this assertion: a hand-built unbalanced payroll
    // document dies at COMMIT with ERR_LEDGER_UNBALANCED, which 1A's own suite already pins.
  });
});
```

```ts
// tests/regression/sah-009.test.ts — APPEND
// Add to the file's existing import block: `seedTenantV2` from "@dulja/db/test",
// `payrollFixture`, `postPayrollRun` from "../invariants/support/payroll", and `sourceFiles` (§4.17.1).
describe("SAH-009 Three different weighted-average formulas … — 8B (the payroll analogue)", () => {
  it("there is ONE payroll calculator and the run service is its only caller", async () => {
    // SAH-009's root cause was three implementations of one formula. The payroll analogue would be a
    // figure computed once in the calculator and again in a report or a payslip.
    const files = await sourceFiles(["packages/db/src", "apps/api/src", "apps/worker/src"]);
    const callers = files.filter((f) => /payrollCalculator\s*\.\s*calculate/.test(f.text)).map((f) => f.path);
    expect(callers.map((p) => p.replace(/\\/g, "/")).sort())
      .toEqual(["packages/db/src/hr/run.ts"]);
  });

  it("a PAYROLL run and a hand-keyed JOURNAL agree to the cent — test 28's claim, restated as a defect", async () => {
    // The full multiset comparison lives in tests/invariants/payroll-one-posting-path.test.ts; this block
    // asserts the property SAH-009 names: two paths, one arithmetic.
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH-009");     // this block's own tenant; the fixture is not idempotent
    const f = await payrollFixture(db, s);
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-02-01", periodEnd: "2026-02-28", payDate: "2026-03-05", effectiveDate: "2026-02-28",
    });
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${documentId}`;
    expect(n!.n).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd tests test -- golden/payroll` — **expected:** PASS (3 cases).
Run: `bun run --cwd tests test -- payroll-one-posting-path` — **expected:** PASS (2 tests).
Run: `bun run --cwd tests test -- sah-003` and `-- sah-009` — **expected:** PASS.
Run: `bun run --cwd tests test` — **expected:** the whole `tests` workspace green.

**Two failures worth naming in advance.** If test 28's first comparison differs by one row, read which: an extra `5920` FX-rounding line on one side means the two documents' base sums differed by a residue, which cannot happen at rate 1.00000000 and points at `postJournal` writing a different `exchange_rate`. If the *dimension* multisets differ, the hand-keyed side lost EMPLOYEE — Step 5's `JournalLine.dimensions` edit (A13) is what carries it, so check that the `document_line` insert really gained the column.

- [ ] **Step 8: Commit**

```bash
git add tests/golden/payroll.test.ts tests/golden/payroll \
        tests/invariants/payroll-one-posting-path.test.ts \
        tests/invariants/support/post-journal.ts \
        tests/regression/sah-003.test.ts tests/regression/sah-009.test.ts
git commit -m "$(cat <<'EOF'
test(golden): tests/golden/payroll on SYNTH, and acceptance tests 33 and 28 [8B T13]

Three golden cases — a regular run, a proration case with a joiner and a leaver,
and the refusal case that is test 33's second clause. The expectation projects
out every uuid and compares CODES, so a formula change shows as a diff
(spec:2264) instead of as a fresh set of ids.

Test 28 compares a posted PAYROLL and a hand-keyed JOURNAL as multisets on
hazard 18's fixed projection — posting_policy_id included in what is projected
OUT, because the two documents legitimately pin different policies. The journal
side is built FROM the payroll ledger so the two figures cannot drift apart in
the fixture rather than in the code.

1B's JournalLine gains one optional member, `dimensions`, and postJournal writes
it into document_line.dimensions (amendment A13). JOURNAL_POLICY_V1's rules
declare no dimensions block, so 2A's evaluator reads the line's own bag by
default -- without this the hand-keyed side carries no EMPLOYEE and the second
multiset comparison compares nothing.

Every join onto app.ledger_entry_dimension in this file uses `led.entry_id`.
That is the column plan 0A's migration 0001 declares (plan0A:2041-2049:
`primary key (entry_id, dimension_type_id)` and `foreign key (tenant_id,
entry_id) references app.ledger_entry(tenant_id, id)`); there is no
`ledger_entry_id` column, and 2A's Self-Review item 16 records the same
misspelling being found and fixed in its own suites. Do not reintroduce it.

The two appended regression blocks mint their own tenant with seedTenantV2 on
sharedDb()'s shared container rather than sharing seedA: payrollFixture is not
idempotent and a second call against one Seed dies on a duplicate account,
document type, scheme, rate table, branch or employee number.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Acceptance tests 29 and 38, and the re-runs of 9, 10 and 31

**Files:**
- Create: `tests/invariants/payroll-pinning.test.ts`
- Modify: `tests/regression/sah-013.test.ts`, `sah-031.test.ts`, `sah-032.test.ts`, `sah-042.test.ts`
- Test: `tests/invariants/payroll-pinning.test.ts`, all four regression files

**Interfaces:**
- Consumes: `payrollFixture`, `postPayrollRun`, `secondApprover` (§4.17.1, T10); `calculatePayrollRun`, `readPayrollRun` (T10); `transitionDocument`, `postDocument`, `listDocumentEvents` (§4.3.1); `seedRateTable` (8A); `startApi` / `StartedApi` (§4.2.12); `startWorker` (0D, §4.17.1); `sharedDb`, `thinRegression`, `sourceFiles` (§4.17.1).
- Produces: no production interface.

- [ ] **Step 1: Write `tests/invariants/payroll-pinning.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Problem } from "@dulja/contracts";
import { calculatePayrollRun, readPayrollRun } from "@dulja/db";
import { postDocument, transitionDocument } from "@dulja/db";
// The PRODUCTION withTenant, from `@dulja/db`, taking a TenantContext. §4.2.2 and §4.2.12 reserve the
// 4-argument TEST helper in `packages/db/test/harness.ts` for `packages/db/test/*`; root `tests/` and every
// app use this one, as 1B's and 3B's own tests-tier files do (1b:503, 3b:2416).
import { withTenant } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { grantCodes, seedDocumentType, seedRateTable, seedTenantV2, type Seed } from "@dulja/db/test";
import { REPO_ROOT } from "../support/source";
import { startWorker, type StartedWorker } from "../../apps/worker/test/support/worker";
import { payrollFixture, postPayrollRun, secondApprover, SYNTH_TABLE, type PayrollFixture } from "./support/payroll";

let db: Db; let s: Seed; let f: PayrollFixture;
const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: "00000000-0000-0000-0000-000000000000" });

async function ledgerFingerprint(documentId: string) {
  const rows = await db.admin<{ line: string }[]>`
    select a.code || '|' || le.debit::text || '|' || le.credit::text || '|' || le.base_debit::text as line
      from app.ledger_entry le join app.account a on a.id = le.account_id
     where le.document_id = ${documentId} order by le.line_no`;
  return rows.map((r) => r.line).join("\n");
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Pinning");
  f = await payrollFixture(db, s);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.payroll.read"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("acceptance test 29 — rate-table pinning (spec:2447, SAH-013, SAH-020)", () => {
  it("run M pins the version effective at M; a later version leaves M byte-identical", async () => {
    const january = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05", effectiveDate: "2026-01-31",
    });
    const before = await ledgerFingerprint(january);
    const [runBefore] = await db.admin<{ pinned_tables: { schemeId: string; version: number }[] }[]>`
      select pinned_tables from app.payroll_run where document_id = ${january}`;
    expect(runBefore!.pinned_tables).toEqual([{ schemeId: f.schemeId, version: 1 }]);

    // A LATER version arrives, effective from February. Nothing about January may move.
    await db.admin`update app.statutory_rate_table set effective_to = '2026-01-31' where id = ${f.rateTableId}`;
    const v2 = await seedRateTable(db, s, {
      schemeId: f.schemeId, version: 2, verified: true,
      definition: { ...SYNTH_TABLE, version: 2, effective_from: "2026-02-01",
                    table: { bands: [{ from: "0", to: null, employee: "999.0000", employer: "999.0000" }] } },
    });

    expect(await ledgerFingerprint(january)).toBe(before);
    const [runAfter] = await db.admin<{ pinned_tables: { schemeId: string; version: number }[] }[]>`
      select pinned_tables from app.payroll_run where document_id = ${january}`;
    expect(runAfter!.pinned_tables).toEqual([{ schemeId: f.schemeId, version: 1 }]);
    const januaryLines = await withTenant(db.rw, ctx(s.human), (tx) => readPayrollRun(tx, january));
    for (const line of januaryLines.lines.filter((l) => l.schemeId !== null)) {
      expect(line.rateTableVersion).toBe(1);
    }
    expect(v2).toBeTruthy();
  }, 180_000);

  it("a run in M+1 pins the NEW version, and its figures differ", async () => {
    const february = await postPayrollRun(db, s, f, {
      periodStart: "2026-02-01", periodEnd: "2026-02-28", payDate: "2026-03-05", effectiveDate: "2026-02-28",
    });
    const [run] = await db.admin<{ pinned_tables: { schemeId: string; version: number }[] }[]>`
      select pinned_tables from app.payroll_run where document_id = ${february}`;
    expect(run!.pinned_tables).toEqual([{ schemeId: f.schemeId, version: 2 }]);
    const lines = await withTenant(db.rw, ctx(s.human), (tx) => readPayrollRun(tx, february));
    // `PayrollRunDetail.lines[].amount` is MoneySchema's object (T10 Step 6), so the figure is `.amount.amount`.
    const shares = lines.lines.filter((l) => l.share === "employee").map((l) => l.amount.amount);
    expect(new Set(shares)).toEqual(new Set(["999.0000"]));
  }, 180_000);

  it("a posted run's posting_policy_id is PINNED — a later policy version leaves it unchanged", async () => {
    // The other half of §2.9's DoD clause, "the run posts through the posting service under pinned POLICY
    // and rate-table versions". The run service never writes the column: §4.3.2 step 13 makes `postDocument`
    // the writer (`update app.document set status = 'posted', posting_policy_id = $policy …`).
    const august = await postPayrollRun(db, s, f, {
      periodStart: "2026-08-01", periodEnd: "2026-08-31", payDate: "2026-09-05", effectiveDate: "2026-08-31",
    });
    const [before] = await db.admin<{ policy: string | null; type: string }[]>`
      select posting_policy_id::text as policy, document_type_id::text as type
        from app.document where id = ${august}`;
    expect(before!.policy).not.toBeNull();

    // A LATER version of the SAME policy, effective ON the run's own effective month. `app.effective_policy`
    // (2B's migration 0022) orders by `effective_from desc, version desc`, so from here on it resolves an
    // August document to version 9 — which is what makes the assertion below non-vacuous. A version dated
    // after every period this file uses would pass even if the column were resolved fresh on every read.
    const envelope = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/db/seed/my/document-types/PAYROLL.json"), "utf8"),
    ) as { policy: unknown };
    await seedDocumentType(db, s, {
      code: "PAYROLL", module: "hr", policy: envelope.policy, policyVersion: 9, effectiveFrom: "2026-08-01",
    });
    const [v9] = await db.admin<{ id: string }[]>`
      select id::text as id from app.posting_policy
       where document_type_id = ${before!.type} and version = 9`;
    expect(v9!.id).not.toBe(before!.policy);        // there really is a newer row, and it is a different one

    const [after] = await db.admin<{ policy: string | null }[]>`
      select posting_policy_id::text as policy from app.document where id = ${august}`;
    expect(after!.policy).toBe(before!.policy);     // unchanged — the column is a PIN, not a lookup
    expect(after!.policy).not.toBeNull();
    // And the ledger rows the post wrote carry the same pinned policy: `posting_policy_id` is in
    // `insertLedger`'s fixed column list (contracts §4.3.2 step 10, plan0A:1916–1921).
    const pinned = await db.admin<{ policy: string }[]>`
      select distinct posting_policy_id::text as policy from app.ledger_entry where document_id = ${august}`;
    expect(pinned.map((p) => p.policy)).toEqual([before!.policy]);
  }, 180_000);

  it("an UNVERIFIED table refuses through the service and through a job's system principal", async () => {
    // Two legs, and the case name says so: the service and a job's system principal. **The API leg of
    // acceptance test 29 is T10 Step 10's route case** (`apps/api/test/routes/hr/payroll-runs.test.ts`, "an
    // unverified rate table answers 422 … through the wire"), which is a different suite on a different
    // tenant; naming it here and not running it would be a vacuous claim.
    // A verified table cannot be un-verified — `verified_by` is stamped and immutable, and `app.stamp_actor`
    // raises ERR_ACTOR_IMMUTABLE on any change to a non-null `*_by` (plan0A:2369–2386). So the unverified
    // table is LOADED: `seedRateTable` inserts `effective_from '2026-01-01'` with an open end (8a:4586–4589,
    // and it ignores the definition's own `effective_from`), so version 3 covers March and is the highest
    // covering version `loadPayrollInputs` will offer.
    const v3 = await seedRateTable(db, s, {
      schemeId: f.schemeId, version: 3, verified: false,
      definition: { ...SYNTH_TABLE, version: 3 },
    });
    // (1) the service
    await expect(withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company, kind: "regular", periodStart: "2026-03-01", periodEnd: "2026-03-31",
        payDate: "2026-04-05", effectiveDate: "2026-03-31", branchId: s.hq,
      }))).rejects.toThrow(/ERR_PAYROLL_RATE_TABLE_UNVERIFIED/);
    // (2) a job's systemContext — the system principal passes app.actor_has and must still be refused
    const worker: StartedWorker = await startWorker();
    try {
      await expect(worker.run(async (tx, jobCtx) =>
        calculatePayrollRun(tx, jobCtx, {
          companyId: s.company, kind: "regular", periodStart: "2026-03-01", periodEnd: "2026-03-31",
          payDate: "2026-04-05", effectiveDate: "2026-03-31", branchId: s.hq,
        }))).rejects.toThrow(/ERR_PAYROLL_RATE_TABLE_UNVERIFIED/);
    } finally { await worker.stop(); }
    // Verify it the ONE legal way, so the cases after this one have a usable table: a DIFFERENT principal
    // (`f.verifier` never loaded anything) issues exactly the statement 8A's `verifyRateTable` issues
    // (8a:4325). `app.assert_rate_table_verifier` admits it because the actor is not `loaded_by`, and
    // `stamp_verified_by` writes `app.current_actor()` over whatever was supplied — which is why this runs
    // inside `withTenant` and not through `db.admin`, where the actor would be NULL.
    await withTenant(db.rw, ctx(f.verifier), (tx) => tx`
      update app.statutory_rate_table set verified_at = now(), verified_by = app.current_actor()
       where id = ${v3}`);
    const [row] = await db.admin<{ verified_by: string | null }[]>`
      select verified_by::text as verified_by from app.statutory_rate_table where id = ${v3}`;
    expect(row!.verified_by).toBe(f.verifier);
  }, 180_000);
});

describe("acceptance test 38 — payroll period lock (spec:2456, SAH-031)", () => {
  it("a run whose period is CLOSED cannot post, and reopening with a reason is the only remedy", async () => {
    const marchPeriod = await db.admin<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${s.company}
       and '2026-03-31'::date between starts_on and ends_on`;
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company, kind: "regular", periodStart: "2026-03-01", periodEnd: "2026-03-31",
        payDate: "2026-04-05", effectiveDate: "2026-03-31", branchId: s.hq,
      }));
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }));
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      transitionDocument(tx, ctx(f.approver), { documentId: r.documentId, to: "approved" }));

    await db.admin`update app.fiscal_period set status = 'closed' where id = ${marchPeriod[0]!.id}`;
    await expect(withTenant(db.rw, ctx(f.approver), (tx) =>
      postDocument(tx, ctx(f.approver), { documentId: r.documentId })))
      .rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);

    // The remedy is a reopen WITH A REASON, by a principal holding accounting.period.reopen (spec:2179).
    const reopener = await secondApprover(db, s, ["accounting.period.reopen"]);
    await withTenant(db.rw, ctx(reopener), (tx) => tx`
      update app.fiscal_period set status = 'open', reopen_reason = 'March payroll approved after close'
       where id = ${marchPeriod[0]!.id}`);
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      postDocument(tx, ctx(f.approver), { documentId: r.documentId }));
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("posted");

    // "the reopen is audited and reported" — the reason is a COLUMN precisely so 1B's listPeriodReopens can
    // read it out of the audit row's after-image (ADR 0023).
    const [audit] = await db.admin<{ reason: string }[]>`
      select (after->>'reopen_reason') as reason from app.audit_log
       where table_name = 'fiscal_period' and row_id = ${marchPeriod[0]!.id}
       order by seq desc limit 1`;
    expect(audit!.reason).toBe("March payroll approved after close");
  }, 180_000);

  it("test 9 re-run — a LOCKED period reaches the payroll LINES, not only the ledger (SAH-031)", async () => {
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-04-01", periodEnd: "2026-04-30", payDate: "2026-05-05", effectiveDate: "2026-04-30",
    });
    const [period] = await db.admin<{ id: string }[]>`
      select fiscal_period_id as id from app.document where id = ${documentId}`;
    await db.admin`update app.fiscal_period set status = 'locked' where id = ${period!.id}`;

    // The legacy failure was verbatim "Period locks … do not reach the line items". Three paths, one answer.
    const [line] = await db.admin<{ id: string }[]>`
      select pl.document_line_id as id from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id where dl.document_id = ${documentId} limit 1`;
    await expect(withTenant(db.rw, ctx(s.human), (tx) => tx`
      update app.payroll_line set amount = '1.0000' where document_line_id = ${line!.id}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    // Deleting is attempted through the PARENT: §3.5.4's DELETE list is closed and app_rw holds no DELETE
    // on app.payroll_line, so a direct `delete from app.payroll_line` would fail with `permission denied`
    // and prove nothing about the period lock. 2B's document_line_delete_draft_only is what refuses this.
    await expect(withTenant(db.rw, ctx(s.human), (tx) => tx`
      delete from app.document_line where id = ${line!.id}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    await expect(withTenant(db.rw, ctx(s.human), (tx) => tx`
      update app.ledger_entry set base_debit = 0 where document_id = ${documentId}`))
      .rejects.toThrow(/ERR_TABLE_IMMUTABLE|permission denied/);
  }, 180_000);
});

describe("re-runs of tests 10 and 31 on PAYROLL (spec:2428, 2449)", () => {
  it("test 31 — the SUBMITTER cannot approve, through the service and through raw app_rw SQL", async () => {
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company, kind: "regular", periodStart: "2026-05-01", periodEnd: "2026-05-31",
        payDate: "2026-06-05", effectiveDate: "2026-05-31", branchId: s.hq,
      }));
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }));

    // Both legs assert R1's token EXACTLY, and the message shape with it. An alternation with
    // ERR_RBAC_FORBIDDEN would be satisfied by R1 being deleted entirely: `s.human` holds only prepare and
    // read, so it would then fall straight through to R2 and the case would stay green while proving
    // nothing. R1 is reachable here because 2B's `app.document_status_before` evaluates R1 (its §2b) BEFORE
    // R2 (§2c) and `transitionDocument` performs no permission check of its own — 2B's own
    // `bySql(doc, "approved", maker)` case, with an equally unprivileged maker, asserts the same token.
    // (1) the service
    await expect(withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "approved" })))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/);
    // (2) raw app_rw SQL — the trigger, not the handler, is the control (spec:2173)
    await expect(withTenant(db.rw, ctx(s.human), (tx) => tx`
      update app.document set status = 'approved' where id = ${r.documentId}`))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/);
    // (3) a job's system principal. It did NOT submit, so R1 does not bind it here and the refusal is R2's:
    // spec:2179 lets the system principal READ RLS-gated rows, and gives it no authority to approve. R1's
    // binding on the system principal is the next case, which has the job submit its own document.
    const worker = await startWorker();
    try {
      await expect(worker.run((tx, jobCtx) =>
        transitionDocument(tx, jobCtx, { documentId: r.documentId, to: "approved" })))
        .rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
    } finally { await worker.stop(); }
  }, 180_000);

  it("test 31 — R1 binds the system principal too: a job cannot approve what the same job submitted", async () => {
    // 2B's own case for this shape (its `payroll` analogue here). `draft → submitted` evaluates no code at
    // all (2B's §2c sets `v_gate := null` for `submitted`), so the job can submit; the approval is then
    // refused by R1 and not by authority, which is the half the case above cannot reach.
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company, kind: "regular", periodStart: "2026-09-01", periodEnd: "2026-09-30",
        payDate: "2026-10-05", effectiveDate: "2026-09-30", branchId: s.hq,
      }));
    const worker = await startWorker();
    try {
      await worker.run((tx, jobCtx) =>
        transitionDocument(tx, jobCtx, { documentId: r.documentId, to: "submitted" }));
      await expect(worker.run((tx, jobCtx) =>
        transitionDocument(tx, jobCtx, { documentId: r.documentId, to: "approved" })))
        .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/);
    } finally { await worker.stop(); }
    // …and a human second principal still can, because the submitted actor was the system principal.
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      transitionDocument(tx, ctx(f.approver), { documentId: r.documentId, to: "approved" }));
    const [row] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(row!.status).toBe("approved");
  }, 180_000);

  it("test 10 — a principal without hr.payroll.post cannot post, however it asks", async () => {
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company, kind: "regular", periodStart: "2026-06-01", periodEnd: "2026-06-30",
        payDate: "2026-07-05", effectiveDate: "2026-06-30", branchId: s.hq,
      }));
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }));
    const halfAuthorised = await secondApprover(db, s, ["hr.payroll.approve", "hr.payroll.read"]);
    await withTenant(db.rw, ctx(halfAuthorised), (tx) =>
      transitionDocument(tx, ctx(halfAuthorised), { documentId: r.documentId, to: "approved" }));
    await expect(withTenant(db.rw, ctx(halfAuthorised), (tx) =>
      postDocument(tx, ctx(halfAuthorised), { documentId: r.documentId })))
      .rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
  }, 180_000);
});
```

- [ ] **Step 2: Run it**

Run: `bun run --cwd tests test -- payroll-pinning`
**Expected:** PASS (9 tests).

**Two failures worth naming in advance.** If any case fails with `ERR_PERIOD_NOT_FOUND` (April, May, June) or `ERR_PERIOD_NOT_OPEN` where the test did not close a period itself (February), `payrollFixture`'s first statement did not run — it must call `ensureOpenPeriods(db, s, 2026)` from `tests/invariants/support/post-inventory.ts` (3B, 3b:2416), because Plan 0A's `seedTenant` gives a company exactly three periods and two of them are not open (§4.1, plan0A:1588–1591). If test 31's raw-SQL case *succeeds*, 2B's `document_status_before` is not resolving the PAYROLL policy — check that `app.effective_policy` returns a definition for the type, because a policy it cannot resolve makes it raise `ERR_POLICY_INVALID` rather than silently allowing, and a *pass* means something else is wrong.

- [ ] **Step 3: Append the four regression blocks**

```ts
// tests/regression/sah-013.test.ts — APPEND
// Add to the file's existing import block: `seedRateTable`, `seedTenantV2` from "@dulja/db/test",
// `payrollFixture`, `postPayrollRun`, `SYNTH_TABLE` from "../invariants/support/payroll",
// and `repoFile` (§4.17.1).
describe("SAH-013 Reversal reads current document-type flags instead of what was originally applied — 8B", () => {
  it("a posted payroll line keeps the rate-table version it USED, whatever version is current", async () => {
    const { db } = await sharedDb();
    // This block's own tenant on the shared container: `payrollFixture` is not idempotent and five 8B
    // regression blocks call it, so none of them may share `sharedDb()`'s `seedA` (Execution handoff).
    const s = await seedTenantV2(db, "SAH-013");
    const f = await payrollFixture(db, s);
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05", effectiveDate: "2026-01-31",
    });
    const pinned = await db.admin<{ v: number }[]>`
      select distinct pl.rate_table_version as v from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${documentId} and pl.scheme_id is not null`;
    expect(pinned.map((p) => p.v)).toEqual([1]);

    await db.admin`update app.statutory_rate_table set effective_to = '2026-01-31' where id = ${f.rateTableId}`;
    await seedRateTable(db, s, {
      schemeId: f.schemeId, version: 2, verified: true,
      definition: { ...SYNTH_TABLE, version: 2, effective_from: "2026-02-01" },
    });
    const still = await db.admin<{ v: number }[]>`
      select distinct pl.rate_table_version as v from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${documentId} and pl.scheme_id is not null`;
    expect(still.map((p) => p.v)).toEqual([1]);
  });

  it("PAYROLL refuses reversal, so there is no path that could re-read a current rule (ADR 0076)", async () => {
    const envelope = JSON.parse(await repoFile("packages/db/seed/my/document-types/PAYROLL.json")) as
      { policy: { reversal: { allowed: boolean } } };
    expect(envelope.policy.reversal.allowed).toBe(false);
  });
});
```

```ts
// tests/regression/sah-031.test.ts — APPEND
// `withTenant` in every file under `tests/` is the PRODUCTION one from `@dulja/db`, taking a TenantContext
// (§4.2.2, §4.2.12); the 4-argument test helper is `packages/db/test/*`-only. 0B's regression files already
// import it that way. Add to the file's existing import block: `seedTenantV2` from "@dulja/db/test" and
// `payrollFixture`, `postPayrollRun` from "../invariants/support/payroll".
describe("SAH-031 Period locks … do not reach the line items — 8B", () => {
  it("the lock reaches app.payroll_line, which is where every payslip figure lives", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH-031");     // this block's own tenant; the fixture is not idempotent
    const f = await payrollFixture(db, s);
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05", effectiveDate: "2026-01-31",
    });
    const [line] = await db.admin<{ id: string }[]>`
      select pl.document_line_id as id from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id where dl.document_id = ${documentId} limit 1`;
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() };
    await expect(withTenant(db.rw, ctx, (tx) => tx`
      update app.payroll_line set amount = '1.0000' where document_line_id = ${line!.id}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });
});
```

```ts
// tests/regression/sah-032.test.ts — APPEND
describe("SAH-032 A user can raise a document's approval level above their own — 8B", () => {
  it("the PAYROLL policy names three DIFFERENT codes, which is what makes the levels real", async () => {
    const envelope = JSON.parse(await repoFile("packages/db/seed/my/document-types/PAYROLL.json")) as
      { policy: { approval: { required: boolean; create: string; approve: string; post: string } } };
    const a = envelope.policy.approval;
    expect(a.required).toBe(true);
    expect(new Set([a.create, a.approve, a.post]).size).toBe(3);
  });

  it("the seeded hr_payroll role holds prepare and NOT approve or post (R6, spec:2177)", async () => {
    const roles = await repoFile("packages/db/seed/roles.ts");
    const hr = roles.slice(roles.indexOf('code: "hr_payroll"'), roles.indexOf('code: "auditor"'));
    expect(hr).toContain('"hr.payroll.prepare"');
    expect(hr).not.toContain('"hr.payroll.approve"');
    expect(hr).not.toContain('"hr.payroll.post"');
  });
});
```

```ts
// tests/regression/sah-042.test.ts — APPEND
// Add to the file's existing import block: `seedTenantV2` from "@dulja/db/test", `payrollFixture`,
// `secondApprover` from "../invariants/support/payroll", and `calculatePayrollRun`, `transitionDocument`
// from "@dulja/db".
describe("SAH-042 Ownership and paid-record checks fail open when the user row is missing — 8B", () => {
  it("a principal with NO role assignment is refused, never defaulted through", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH-042");     // this block's own tenant; the fixture is not idempotent
    const f = await payrollFixture(db, s);
    // A principal with a membership and nothing else. seedTenant grants s.human nothing either (§4.1), so
    // the failure mode this defect describes — an absent row read as "allowed" — has two ways to appear.
    const stranger = await secondApprover(db, s, []);
    // The production `withTenant(sql, ctx, fn)` — root `tests/` never uses the 4-argument test helper
    // (§4.2.2, §4.2.12). One context per actor, minted once and passed to both the helper and the service,
    // so the session actor and the service's own actor can never disagree.
    const asHuman = { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() };
    const asStranger = { tenantId: s.tenant, actorId: stranger, requestId: crypto.randomUUID() };
    const r = await withTenant(db.rw, asHuman, (tx) =>
      calculatePayrollRun(tx, asHuman, {
        companyId: s.company, kind: "regular", periodStart: "2026-07-01", periodEnd: "2026-07-31",
        payDate: "2026-08-05", effectiveDate: "2026-07-31", branchId: s.hq,
      }));
    await withTenant(db.rw, asHuman, (tx) =>
      transitionDocument(tx, asHuman, { documentId: r.documentId, to: "submitted" }));
    await expect(withTenant(db.rw, asStranger, (tx) =>
      transitionDocument(tx, asStranger, { documentId: r.documentId, to: "approved" })))
      .rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
    expect(f).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the whole suite**

Run: `bun run --cwd tests test -- sah-013 sah-031 sah-032 sah-042` — **expected:** PASS.
Run: `bun run --cwd tests test` — **expected:** the whole `tests` workspace green.
Run: `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck`, `bun run test` at the repository root — **expected:** all green. This is the slice's last full gate before the screen task.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants/payroll-pinning.test.ts \
        tests/regression/sah-013.test.ts tests/regression/sah-031.test.ts \
        tests/regression/sah-032.test.ts tests/regression/sah-042.test.ts
git commit -m "$(cat <<'EOF'
test(invariants): acceptance tests 29 and 38, and the re-runs of 9, 10, 31 [8B T14]

Test 29: a later verified version leaves run M's ledger, its pinned_tables and
every line's rate_table_version byte-identical, while a run in M+1 pins the new
one. An unverified table refuses through the service and through a job's system
principal — spec:2179 lets the system principal READ RLS-gated rows; it does not
let it skip a refusal. The API leg of test 29 is T10's route suite, and this
file points at it rather than claiming it.

The POLICY half of the same DoD clause gets its own case: a posted run's
document.posting_policy_id, and the posting_policy_id on every ledger_entry it
wrote, are unchanged after a version 9 policy effective in the run's own month
is seeded — so app.effective_policy now resolves that month to a different row
and the pin does not move.

R1 is asserted by token and message, never as an alternation with
ERR_RBAC_FORBIDDEN: s.human holds neither approve nor post, so an alternation
would stay green if R1 were deleted and the case fell through to R2. 2B's
trigger evaluates R1 before R2, which is what makes the exact assertion right.
A second case has a job submit its own run and then refuse to approve it, which
is R1 binding the system principal.

Test 38: a closed period refuses the post, and a reopen WITH A REASON by a
holder of accounting.period.reopen is the only remedy; the reason is read back
out of the audit row's after-image, which is why ADR 0023 made it a column.

Test 9's re-run is the half SAH-031 names verbatim: the lock reaches
app.payroll_line, where every payslip figure lives, and not only the ledger.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: OD-24 — the payroll approval screen (isolated owner gate)

> **Owner decision OD-24** (§2.12; spec:79, 108, 2408, hazard 29). *"Screenshots + operator description before any screen."* The UI is not specified anywhere in the spec, and no plan invents a workflow.
>
> **Owner provides:** screenshots of the legacy payroll approval and register screens, plus a **two-minute operator description** of what the payroll officer and the approver each do, in order, on a normal month-end.
> **Verify:** the description is attached to this task; then `bun run --cwd apps/backoffice test -- PayrollApproval` passes and `bun run --cwd tests test:e2e -- payroll` renders the screen in **both text directions** (spec:106's Always list, spec:2377).
> **Until provided — the default written into this plan:** **this task is blocked; the slice is not.** Tasks 1–14 ship a complete, tested payroll engine reachable through the API. The approval screen is the one deliverable spec:2087 names ("listed on the approval screen") that needs a picture nobody has, and `readPayrollRun` + `listOverrides` already return exactly the data it will render — so the screen is a view over a finished surface, not a missing capability.

**Files:**
- Create: `apps/backoffice/src/screens/PayrollApproval.tsx` (⚠️ OD-24 only)
- Create: `apps/backoffice/src/screens/PayrollApproval.test.tsx` (⚠️ OD-24 only)
- Test: `apps/backoffice/src/screens/PayrollApproval.test.tsx`

**Interfaces:**
- Consumes: `packages/ui` and `packages/i18n` (0E), the generated client from `packages/contracts/openapi.json` (§4.2.7), `PayrollRunSchema` / `PayrollLineSchema` (T10), `readPayrollRun` and `listOverrides` through `GET …/payroll-runs/{documentId}` (T10, T11), and `POST …/documents/{documentId}/transitions` (2B).
- Produces: no shared interface. A screen is `apps/backoffice`'s and nothing imports it.

- [ ] **Step 1: Record the gate and stop**

Write the owner request into the task tracker verbatim, in the §5 hazard-5 pattern:

> **Owner provides:** screenshots of the legacy payroll approval screen and the payroll register, and a two-minute operator description of the month-end sequence — who calculates, what they check, who approves, and what the approver looks at before approving.
> **Verify:** the description is attached to this task.
> **Until provided:** the API surface is complete and exercised by `apps/api/test/routes/hr/payroll-runs.test.ts`; no screen is built and no workflow is invented.

**Do not build a screen from this plan's imagination.** Hazard 29 is explicit: "The UI is not specified (spec:79, 108). Every screen task begins with OD-24 … no plan invents a workflow."

- [ ] **Step 2: When the description arrives — the four things the screen must show, from the spec and nowhere else**

These are the requirements the *spec* already fixes; the screenshots decide layout, order and wording, and nothing else.

| Requirement | Source | Data |
|---|---|---|
| The run's period, kind, status and pinned rate-table versions | spec:2081 | `PayrollRunSchema.{periodStart, periodEnd, kind, status, pinnedTables}` |
| Every line, per employee, with its component or scheme and its pinned version | spec:2081 | `PayrollRunSchema.lines` |
| **Every manual statutory override, flagged, with its reason and who entered it** | **spec:2087** — "is flagged, is listed on the approval screen" | `listOverrides` through the same `GET` |
| **Everyone who changed compensation in the period** | **spec:2174 R3** — "The approval screen lists everyone who changed compensation in the period" | ✅ **already exposed — Task 10 ships it.** `compensation_line.entered_by` is 8A's stamped column and the read is one query, so `readPayrollRun` returns `compensationChangedBy: { principalId, displayName, employeeNumber, effectiveFrom }[]` and `PayrollRunSchema` carries it — a §4.12.6 amendment (A12), filed by T1 Step 1’s contracts PR and implemented in T10. **This task renders that list and adds nothing to the API**, which is the whole reason OD-24 blocks a screen and not a capability. |

**Keyboard parity is a requirement, not a nicety** (spec:2254, hazard 29): every action on the screen is reachable without a mouse, and the test asserts it.

- [ ] **Step 3: When the description arrives — write the screen and its test**

```tsx
// apps/backoffice/src/screens/PayrollApproval.test.tsx — written FIRST, from the operator description.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PayrollApproval } from "./PayrollApproval";

const RUN = {
  documentId: "d1", number: null, series: "PAY", status: "submitted", kind: "regular",
  periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-02-05",
  pinnedTables: [{ schemeId: "s1", version: 1 }],
  lines: [
    { documentLineId: "l1", employeeId: "e1", employeeNumber: "E-0001", componentId: "c1", schemeId: null,
      share: null, quantity: null, amount: { amount: "2000.0000", currency: "MYR" },
      rateTableVersion: null, overrideReason: null },
    { documentLineId: "l2", employeeId: "e1", employeeNumber: "E-0001", componentId: null, schemeId: "s1",
      share: "employee", quantity: null, amount: { amount: "77.0000", currency: "MYR" },
      rateTableVersion: 1, overrideReason: "authority letter 2026-01-02" },
  ],
  compensationChangedBy: [
    { principalId: "p1", displayName: "Nadia (HR)", employeeNumber: "E-0001", effectiveFrom: "2026-01-15" },
  ],
};

describe("PayrollApproval", () => {
  it("FLAGS every manual override with its reason (spec:2087)", () => {
    render(<PayrollApproval run={RUN} onTransition={() => {}} />);
    const flagged = screen.getByTestId("override-l2");
    expect(flagged).toHaveTextContent("authority letter 2026-01-02");
  });

  it("LISTS everyone who changed compensation in the period (spec:2174 R3)", () => {
    render(<PayrollApproval run={RUN} onTransition={() => {}} />);
    const list = screen.getByTestId("compensation-changed-by");
    expect(list).toHaveTextContent("Nadia (HR)");
    expect(list).toHaveTextContent("E-0001");
  });

  it("every action is reachable from the keyboard alone (spec:2254)", async () => {
    const seen: string[] = [];
    render(<PayrollApproval run={RUN} onTransition={(to) => seen.push(to)} />);
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(seen).toEqual(["approved"]);
  });

  it("renders in both text directions (spec:106's Always list)", () => {
    for (const dir of ["ltr", "rtl"] as const) {
      const { container } = render(<div dir={dir}><PayrollApproval run={RUN} onTransition={() => {}} /></div>);
      expect(container.querySelector("[data-testid='payroll-approval']")).not.toBeNull();
    }
  });
});
```

The component itself is written from the screenshots. **Its only data source is `GET /v1/companies/{companyId}/payroll-runs/{documentId}` and its only action is `POST …/documents/{documentId}/transitions`** — a screen that computed a figure of its own would be a second payroll implementation, which is SAH-009 in a browser.

- [ ] **Step 4: Commit (⚠️ OD-24 only)**

```bash
git add apps/backoffice/src/screens/PayrollApproval.tsx apps/backoffice/src/screens/PayrollApproval.test.tsx
git commit -m "$(cat <<'EOF'
feat(backoffice): the payroll approval screen [8B T15]

Built from the owner's screenshots and operator description (OD-24), not from
this plan's imagination (hazard 29). Its only data source is the payroll-run GET
and its only action the generic transitions POST — a screen that computed a
figure of its own would be a second payroll implementation.

It flags every manual statutory override with its reason (spec:2087) and lists
everyone who changed compensation in the period (spec:2174 R3). Both text
directions and full keyboard parity are asserted, not assumed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Run against the spec and the contracts card with fresh eyes, per the writing-plans skill. Findings were fixed inline; what follows is the record.

#### 1. Spec coverage — every clause of §3.10 that belongs to 8B has a task

| Spec clause | Task |
|---|---|
| **spec:2080** "no rate, threshold, ceiling or formula"; "a run cannot pin an unverified table or one whose effective range does not cover the pay period (SAH-020)" | T5 (every figure comes from `RateTable`), T6 (both refusals), T12 (the `SYNTH` guard), T14 (test 29 through the service and a job's system principal) and T10 Step 10 (the same refusal through the wire, 422) |
| **spec:2081** a `PAYROLL` Document, kind `regular \| supplementary \| final`, 1:1 with `document`, **the document state machine not its own**, calculate → submit → approve → post, one posting service, pinned policy, every line pins its rate-table versions | T1 (the two extension tables), T4 (the type and policy), T10 (the service and the routes — and **no** type-specific transition route) |
| **spec:2081** "A run may be recalculated only while draft or submitted; any recalculation after submit returns it to draft and voids the pending approval" | T10 (`recalculatePayrollRun` refuses a non-draft), T11 (R3's trigger performs the return) |
| **spec:2081** "Correction after posting is a reversal plus a supplementary run; nothing is edited in place (SAH-041)" | T4 (ADR 0076 — the supplementary half ships; the reversal half is refused with both mechanics stated), T1 (`payroll_line_change_draft_only` is "nothing is edited in place") |
| **spec:2086** proration by a company-configured rule the accountant confirms | T6 (both rules), T7 (OD-28, isolated) |
| **spec:2087** manual statutory override with a reason and `entered_by`, flagged, listed at approval, in the audit trail | T1 (the two columns and their CHECK), T11 (`setStatutoryOverride`, `listOverrides`), T15 (the screen's flag) |
| **spec:2093** ⚠️ levy, foreign workers, hourly/part-time, staff purchases | T8 (OD-14, isolated) |
| **spec:2099–2101** the whole posting paragraph — every account, both dimensions, per-line account resolution | T4 (the seven policy rules and the eleven §4.15 accounts), T2 (the `EMPLOYEE` dimension), T9 (the three snapshot slots), T10 (the home-branch tag on every line) |
| **spec:2105** SAH-011, 013, 019, 020, 029/030, 031/041, 032, 033/045, 044, 078 | T6 (011), T14 (013), T5 (019), T12 (020), T1 (`attach_audit`, no flag → 029/030), T1 + T14 (031/041), T3 + T14 (032), 8A (033/045), T1 + T11 (044 — every actor stamped), T12 (078 — rules as version-controlled data) |
| **spec:2109** golden fixtures from worked examples; the per-employee override surfaced on approval | T13 (the harness the worked examples plug into), T12 (what OD-23 delivers), T11 + T15 (the override) |
| **spec:2172–2174** R1, R2, R3 | T4 (`approval.required = true` with three distinct codes — R1 and R2 are 2B's triggers reading it), T11 (R3's trigger), T14 (all three re-run through service, worker and raw SQL) |
| **spec:2229** the payroll statutory pack | T5, T6, T12 |
| **spec:2263–2264** golden-file tests | T13 |
| **spec:2366** `packages/domain/payroll/`; core never imports HR | T5 (the package sits outside `src/`, the subpath is its only door, `dependency-rule` is the check) |
| **Part VI 28, 29, 33, 38** | T13 (28, 33), T14 (29, 38) |
| **Part VI 9, 10, 31, 35's recalculation clause** | T14 (9, 10, 31), T11 (35's clause) |
| **§3.0.4 row spec:1057** statutory schemes as verified rate tables; pinning and refusal (**owned**) | T6, T10, T12, T14 |
| **§6.2 row spec:1058** PAYROLL / PAYROLL_PAYMENT / remittances / EMPLOYEE_ADVANCE (**owner 8C — 8B re-runs its half**) | T4 seeds and wires `2400`, `1400` and `2411`–`2414`, so 8C's three document types resolve their accounts with no seed of their own; T13's test 28 proves the PAYROLL half of the row posts through the one service |
| **§6.2 row spec:1066** BRANCH mandatory (posting-policy `requires`) (**owner 2A — 8B re-runs it**) | T4's policy declares `dimensions.required: ["BRANCH", "EMPLOYEE"]`; T9 fills `LineSnapshot.payroll` so `line.employee` resolves; T10 writes the employee's home branch into `document_line.dimensions` on every line and T10's own case asserts it. The re-run is not decorative: it is the only type in the system whose BRANCH is per **line**, so it exercises 2A's rule on the shape 2A's own tests cannot reach |

**One gap found and closed inline, then moved.** The first draft had no task for "the approval screen lists everyone who changed compensation in the period" (spec:2174's last sentence); the second put it in T15, which OD-24 blocks. It is neither now: the sentence describes a **read** — `compensation_line.entered_by` is 8A's stamped column and the list is one overlap query — so `readPayrollRun` returns `compensationChangedBy` in **T10**, `PayrollRunSchema` carries it, T10 Step 1 tests it in both directions (a change inside the period is listed; one effective in 2099 is not), and it is filed as amendment A12. T15 renders that list and adds nothing to the API, so spec:2174 is satisfied by an unblocked task and OD-24 genuinely blocks only a picture.

**One clause deliberately not covered, and it is not 8B's.** spec:2081's "Money out on Phase 4 machinery" (`PAYROLL_PAYMENT`, statutory remittances, `EMPLOYEE_ADVANCE`) is **8C's**, and §2.9's 8B card says so; this plan seeds the accounts 8C spends (`2400`, `1400`, `2411`–`2414`) and nothing more.

#### 2. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `add appropriate`, `handle edge cases`, `similar to Task`, `etc.`, `and so on`, and a bare ellipsis standing in for content. **Four hits, all fixed:**

- T13 Step 1 declared `export interface PayrollGoldenInput { /* the shape above, verbatim */ }`. That is the ellipsis-for-content this section's last paragraph calls a plan failure, and it is not the signature-then-body convention: an engineer typing the block as given gets an **empty** interface and every `input.period.start` / `input.employees` reference in Steps 1–2 stops type-checking. The seven-member shape from the task's Produces block is now inlined, exactly as the sibling `GoldenPayrollLine` / `GoldenLedgerRow` / `GoldenPayslip` / `PayrollGoldenExpectation` declarations already were. (Found on review round 3.)

- T10 Step 2's `payrollFixture`, `postPayrollRun` and `secondApprover` were declared with `/* … Step 3 … */` bodies. That is a signature block followed by its implementation in the next step, which is the shape §4 registry blocks use — but a reader who stops at Step 2 sees nothing to type. Step 3 now carries all three bodies in full, and Step 2's comment names the step that has them.
- T3 Step 3's role edits were prose. They are now three literal array additions, each carrying only the new members.
- T6's `lint:rules` expectation originally read "expected: zero violations" and then, in a conditional clause, "if `error-codes` reports the two codes as unraised, widen its scan roots". A conditional is not a step: the widening is **certain** — `packages/domain/payroll/` is outside `src/` by design (amendment A8) and holds the only raise there is — so it is now T6 **Step 7**, a numbered step carrying the edited `ROOTS` line, `scripts/lint/rules/error-codes.ts` is in the File Structure, and the change is filed as amendment **A16**. (The one textual occurrence inside a current root is a *comment* in `run.ts`, which would let the check pass while proving nothing; spec:2051 asks whether a code is **raised**.)

**Five `// … every member the file already has, unchanged …` markers were removed on the review pass.** They appeared in `NO_ID_TABLES` (T1 Step 6), the three `ROLES` entries (T3 Step 3) and `POLICY_RESOLVED_CODES` (T3 Step 5). The intent was sound — the existing members belong to other slices and writing them out would be a guess about what has merged — but an ellipsis standing in for content inside a code block is a plan failure by the skill's own rule, and no other written plan uses the device. Each is now an explicit instruction that contains no ellipsis (**"APPEND these lines to the existing array; do not remove, reorder or rewrite any member already there"**) followed by the new entries alone, which says the same thing without a reader having to interpret a symbol.

#### 3. Type consistency

Checked every name that crosses a task boundary.

- `calculatePayrollRun` / `recalculatePayrollRun` / `readPayrollRun` / `PayrollRunResult` / `PayrollRunDetail` — declared in T10's Interfaces block, used in T11 (`setStatutoryOverride` calls `recalculatePayrollRun`), T13 and T14. **Consistent.**
- `payrollCalculator` / `PayrollCalculator` — the *value* is `payrollCalculator` (T6) and the *interface* is `PayrollCalculator` (§4.12.1, T5). Both spellings appear and each is used correctly; T5's barrel exports the type and T6's adds the value.
- `PayrollCalculationError` with `code` and `detail` — T5 declares it, T6 raises it, T10's tests catch it, `problem.ts` translates it. **Consistent**, and the two codes are the §4.2.4 rows T6 adds.
- `EMPLOYEE_DIMENSION_CODE` / `ensureEmployeeDimensionValue` — T2 produces, T9's `loadSnapshot` and T10's `loadPayrollInputs` consume, T13's golden seeder calls. **Consistent.**
- `PAYROLL_ACCOUNT_CODES` — T4 produces, T10's `writeLines` reads `salariesPayable`, T8 names it for the levy case. **Consistent.**
- `payrollFixture` / `PayrollFixture` / `postPayrollRun` / `secondApprover` / `SYNTH_TABLE` — T10 creates in `tests/invariants/support/payroll.ts`, T13 and T14 consume, the regression blocks consume. **Consistent**, and registered as amendment A7.
- `seedPayrollRun` — T1 adds it to `fixtures.ts` per §4.17. **It is used by no later task in this plan**, and that is correct rather than dead: §4.17 assigns it to 8B for **8C's and 8D's** tests, which need a draft run without going through the whole calculation. The row is honoured; the plan does not manufacture a use for it.
- `ytdKey` / `schemeYtdKey` — T6 declares, T6's `calculate` uses, T10's `ytdFromPostedLines` uses. **Consistent**, and the shared key space is why the two files agree.
- `RateTable` — 8A's generated type, consumed by T5, T6, T12 and every test. T5 Step 1's three-outcome branch is what makes the dependency explicit rather than assumed.
- `document_line_kind_check`'s six labels — T1's migration writes the same list 6A's 0061 writes, and T1's first test case asserts all six regardless of which file ran first.
- `compensationChangedBy` — T10 declares it on `PayrollRunDetail`, fills it in `readPayrollRun`, and `PayrollRunSchema` carries it; T15 renders it and T15's screen fixture includes it, so the `.tsx` type-checks against the contract. **Consistent**, and registered as amendment A12.
- `PayrollRunDetail.lines[].amount` and `.status` — **now** `{ amount, currency }` and the `PayrollRunStatus` union, matching `PayrollLineSchema.amount: MoneySchema` and `PayrollRunStatusSchema`. Worth naming which side was wrong: **T15's screen fixture was already on the object shape** (`amount: { amount: "2000.0000", currency: "MYR" }`), and so was the contracts module; only `readPayrollRun` and its two TypeScript declarations spelled money as a bare string. The route handlers return that object straight against `PayrollRunSchema`, so the mismatch was a `typecheck` failure and an `openapi.json` describing a body no route sent — fixed by making the read match the contract, not the contract match the read.

**Four defects found and fixed inline on the last pass**, before any of this was declared done.

1. **Money through a float.** `loadPayrollInputs` and `ytdFromPostedLines` both read `numeric` columns as text and then wrote `Money.of(Number.parseFloat(x).toFixed(4), cur)`. That is a `double` in the middle of a money path — Global Constraint 3 and spec:2041 forbid exactly that, and `no-number-money` would not have caught it because the local is typed `string`. §4.6.1 makes `compensation_line.amount` `numeric(19,4)` and `quantity` `numeric(19,6)`, so `::text` already yields `"2000.0000"` and `"1.000000"` — precisely the strings `Money.of` and `Quantity.of` are documented to take. They now go in whole, with no conversion at all: fewer moving parts than `Decimal`, no new dependency in `packages/db` (`decimal.js` is `packages/domain`'s, D11), and `ERR_MONEY_SCALE` fires loudly if a column's scale ever drifts, where a rounding conversion would have hidden it. `Quantity` — **used but never imported** in `inputs.ts` — is now imported. The word `parseFloat` survives in this plan in exactly one place: the comment that says never to use it.
2. **The `sah-020` numeric-literal scan cried wolf, and then hid a real one.** It scanned raw file text, so `SAH-011`, `spec:2080` and `§4.12.3` in the *comments* of `banded-contribution.ts`, `progressive-schedule.ts`, `types.ts` and `calculator.ts` all read as rates — and a check that fails on every commit is a check someone deletes. It now strips twice: block and line comments first (sparing `https://`), then the citation forms `spec:NNNN`, `SAH-NNN`, `OD-NN`, `RC-N` in **what is left**, because `calculator.ts` and `progressive-schedule.ts` cite spec:2080 inside a *thrown error's template literal*, which is not a comment. Every other digit in every other string stays in scope, so a rate smuggled in as `"0.11"` is still caught. The allowlist is now exactly `0` and `1` — `4` and `6` are gone, and the one real `toFixed(4)` became `toFixed(MONEY_SCALE)`. `period.ts` is excluded from that list and checked **structurally** instead — it imports neither `Money` nor `decimal.js` and its only constants are `MS_PER_DAY`, `SUNDAY` and `SATURDAY` — because an allowlist wide enough to admit `86_400_000` is wide enough to admit a contribution rate. **The rule was then run by hand over all nine files as this plan writes them, and passes.**
3. **T4's chart-file assertion contradicted T4's chart file.** The file ships **twelve** rows — eleven §4.15 leaves plus the `2410` presentation parent — and the test compared all twelve codes against a list of eleven, behind a `.filter((c) => c !== "5315")` that filtered nothing. The test now partitions on `isGroup`, asserts the eleven leaves and the one parent separately, and checks every `parentCode`. The word "ten" was wrong in nine other places and is now "eleven" in all of them.
4. **spec:2174's last clause was parked behind an owner gate.** “The approval screen lists everyone who changed compensation in the period” had been written as work inside T15, which OD-24 blocks — so a clause of the spec would have shipped only if the owner sent screenshots. It is a **read**, not a screen: `compensationChangedBy` now ships in T10 with the rest of the run API (amendment A12), T10 tests it in both directions, and T15 renders it. OD-24 now blocks a picture and nothing else.

**One inconsistency found and fixed earlier.** An early draft of T4's policy used `dimensions: { from: ["line.dimensions", "document.branch", "line.employee"] }`, matching §4.12.2's prose. Reading 2A's `dimensionsFor` (2a:1754–1768) showed `document.branch` takes the **last word** over the line's own bag, which would have tagged every employee's line with the run's branch and made spec:2101's "the employee's home branch" false. The policy now omits `document.branch` on all seven rules, T10's `writeLines` supplies BRANCH per line from `homeBranches`, `dimensions.required` refuses a line that lost it, and the whole reasoning is amendment **A3** plus T4 Step 2's fifth bullet plus T10's own test case.

#### 4. Contracts-card coverage

Every bullet of §2.9's **Delivers** list has a task: the three calculator types and the "no rate in code / every result names the version" clause (T5, T6); the `PAYROLL` type with `direction: none`, `inventory: none`, `tax: none`, `approval.required` with both codes and series `PAY` (T4); `app.payroll_run` and `app.payroll_line` (T1); the `EMPLOYEE` dimension by trigger, both dimensions on every line, and the eleven §4.15 chart rows **with the same seed task setting the three account columns** (T2, T4); calculate → submit → approve → post on the shared machine (T10); R3 (T11); the unverified refusal (T6, T14); the missing-input refusal naming the employee (T6, T13); the manual override with reason and `entered_by`, flagged and listed at approval (T11, T15); proration (T6, T7); the unpaid-leave deduction quantity (T6's quantity path); test 38 through `accounting.period.reopen` with reason, audited and reported (T14); `tests/golden/payroll/` on the synthetic table and test 28 (T13); the four codes and **the `hr` row of the attachment download map** (T3); and the two explicit non-deliverables — `employee_ytd` is 8C's (Global Constraint 2, T10's `ytdFromPostedLines`), and employer contributions are **not** a `pay_component.kind` (T4's policy uses `line.share`, T1's `payroll_line_shape_check` enforces the shape).

**Review round 2 — the ten defects the reviewer found, and where each is now fixed.** (1) The chart loader inserted into `account_type`; the column is `type` — and the loader itself was unreachable, because `LOADERS` is keyed by `SubPack` and 0C already owns `chart-of-accounts`. **Both are gone:** 8B ships `8b-payroll.json` and nothing else into that sub-pack, 0C's `chartOfAccountsLoader` applies it (the 3C/5A precedent), and the wiring is a separate entry point the runbook and the fixture both call (T4 Steps 4 and 7). (2) Five `compensation_line` inserts named a `company_id` column 8A does not ship (T10's fixture, T11's three cases, T13's `seedCase`) — all five now match 8A's DDL. (3) `calculate` derived the currency before checking the components, so T6's quantity-with-no-rate case could only ever raise the *other* refusal; `assertComponentInputs` now runs first, both messages come from one `missingInput`, and a fourteenth case pins the order from the other side. (4) `setStatutoryOverride` had no `employeeId` and replaced one line **per employee**; the input, the wire body, the UPDATE and the assertions are all per-employee now. (5) `PAYROLL_DDL_TEST` / `PDT` was an unregistered document-type code — amendment **A15** registers it as test-only. (6) `PayrollLineSchema.amount` is `MoneySchema` (an object) while `readPayrollRun` returned a bare string, and `status` was `string` against a Zod enum — `readPayrollRun` now returns `{ amount, currency }` from the run's own `document.currency`, and `PayrollRunStatus` is one union both sides import. (7) Three tests un-verified a rate table by direct UPDATE, which the plan's own handoff row says raises `ERR_ACTOR_IMMUTABLE`; all three now **load** an unverified version and leave it by one of the two legal moves, and the handoff row states both. (8) The `tests/` tier used the 4-argument test `withTenant`; every file under `tests/` now imports the production one and passes a `TenantContext`. (9) `loadPayrollInputs` read manual overrides by **period**, so a second draft over one period inherited the other's; the read is keyed on the run's own `documentId` and a first calculation reads none. (10) The `1400` claim in T4's prose described wiring no step performed — the account is now stated as the operator/seed decision it is, and `staffAdvances` is exported for 8C and the two fixtures. Four smaller ones with them: migration 0088's two indexes duplicated Plan 0A's unique constraints and are deleted; the HALF_EVEN case asserted the same figure as HALF_AWAY_FROM_ZERO and discriminated nothing (the rate is now `0.33325`, where the two modes differ); four "PASS (N tests)" counts disagreed with the `it(` blocks beside them; and the Architecture bullet's `decimal.js` claim contradicted all three calculators, which ADR 0022 permits.

**One defect found while fixing (3), not reported.** `runGoldenCase` wrote the raw refusal message into `refusal.detailContains`, and that message names the employee and component **by uuid** — so `synth-missing-input`'s `expected.json` would have differed on every run and the byte-comparison would have failed for a reason unrelated to payroll, in the one case that is acceptance test 33. `toCodes` now applies the same ids-out/codes-in projection to the message that the three queries already applied to the rows.

**Review round 3 — an independent audit against the contracts document, plan 0A and the spec; eleven findings, ten applied and one applied with a corrected diagnosis.** (1) **The blocker:** four SQL joins named `led.ledger_entry_id` on `app.ledger_entry_dimension`. Plan 0A's migration 0001 declares that column as **`entry_id`** (plan0A:2041–2049 — `primary key (entry_id, dimension_type_id)`, `foreign key (tenant_id, entry_id) references app.ledger_entry(tenant_id, id)`), so all four failed with `column led.ledger_entry_id does not exist` — killing the second multiset comparison of acceptance test 28 and the `ledger` half of every golden `expected.json`. All four now read `led.entry_id`, and both commit bodies cite plan0A:2041–2049 and 2A's Self-Review item 16 (which records the same misspelling in 2A's own suites) so it cannot come back. (2) Five appended regression blocks called the non-idempotent `payrollFixture` against `sharedDb()`'s shared `seedA` — the exact failure this plan's own Execution handoff row describes. Each now mints its own `seedTenantV2` tenant on the shared container (3B's `costingContext` precedent, without a new shared module or a new amendment row), every `seedA` reference in them is rewritten, each block names the imports it adds, and the handoff row now says the five already do it. (3) `payroll_line.quantity` was declared, selected back, byte-compared by the golden fixture and **never written**: `EmployeeResult` is frozen at `{ componentId; amount }` (§4.12.1), so the quantity is on the *input* and `writeLines` was not reading it. A `quantityOf` lookup now carries it onto every component line, and a tenth case in T10's run suite seeds a `quantity_based` component and asserts `3.000000` on its line and `null` on a fixed one. (4) **The one finding whose diagnosis was wrong, and the fix is right anyway.** The audit said no test reaches `ERR_SOD_MAKER_IS_CHECKER` because every self-approver lacks `hr.payroll.approve` and is refused by RBAC first. It is the other way round: 2B's `app.document_status_before` evaluates R1 (§2b) **before** R2 (§2c) and `transitionDocument` performs no permission check of its own, so the service and raw-SQL legs do reach R1 — 2B's own `bySql(doc, "approved", maker)` case, with an equally unprivileged maker, asserts the same token. The **real** defect is the alternation `/ERR_SOD_MAKER_IS_CHECKER|ERR_RBAC_FORBIDDEN/`, which would stay green if R1 were deleted and the case fell through to R2. Both legs now assert R1's token *and* its message shape; the worker leg, whose system principal never submitted and therefore reaches R2, asserts `ERR_RBAC_FORBIDDEN` exactly and says so; a new case has a job submit its own run and be refused approval, which is R1 binding the system principal; and T10 Step 10 gains a wire leg with a principal holding **both** `hr.payroll.prepare` and `hr.payroll.approve` — the only shape that clears §4.5.4's middleware and reaches the trigger — asserting 409 `ERR_SOD_MAKER_IS_CHECKER`. The pre-existing 403 case is kept and relabelled R2, which is what it proves. (5) The DoD row *"under pinned policy … versions"* cited a test that did not exist. T14 Step 1 now carries it: post a run, record `document.posting_policy_id`, seed a version 9 `posting_policy` effective **inside the run's own month** so `app.effective_policy` resolves that month to the newer row, and assert the document's pin and every `ledger_entry.posting_policy_id` are unchanged and non-null. (6) Task 3 declared a test-file append no step wrote and no commit staged — and named the wrong file (`attachment-read.test.ts`; 2C shipped `require-attachment-read.test.ts`, 2c:1799). Step 4 now carries three cases in full, replacing the two of 2C's that the new `hr` row **falsifies** (`Object.keys(MODULE_READ_CODE)` equal to `["accounting"]`, and `MODULE_READ_CODE.hr` undefined) with row-by-row assertions 3A's and 6D's rows will not have to edit again; the suite is run before and after the map edit, and the file is staged in Step 7. (7) `PayrollGoldenInput` — §2 above. (8) `tests/invariants/support/payroll.ts` used `uuidv7`, `calculatePayrollRun`, `transitionDocument` and `postDocument` without importing any of them, `REPO_ROOT` was imported a step after its module-level use, and `probes.ts` named three imports nowhere; all are in the blocks now. (9) The DoD table's four cross-references into Task 14 pointed at Steps 2, 3 and 4, which are *Run it*, the regression appends and the full-suite gate; every one of those tests is written in **Step 1**, and the rows say so. The `posting_policy_id` row's "Task 10 Step 4" is gone too — Step 4 is `inputs.ts`, and the sentence's own point is that the run service never writes the column. (10) The SAH-019 rounding comment read `0.00005 × 0.5 = 0.000025` over inputs of `0.0001 × 0.5`; the code and the assertions were right and only the comment misled, so the comment now reads `0.0001 × 0.5 = 0.00005`. (11) T14's unverified-table case was titled "service, API and worker" with two legs in it; it is now "the service and a job's system principal", and it points at T10 Step 10's route case for the wire leg rather than claiming it.

**Card size:** 13–15 tasks; **this plan has 15.** Four of them are the isolated owner gates hazards 5 and 6 require (T7 OD-28, T8 OD-14, T12 OD-23, T15 OD-24) — OD-24 is in the orchestrator's gate list for this slice and spec:2174 gives it a screen to gate, so it is written rather than dropped.

**Migration range:** 0087–0090, four files, four PRs, none borrowed, none renumbered. §2.9 called 0090 spare; amendment **A1** records why it is not. **ADR range:** 0074–0076, all three used, 0076 written as a proposal per spec:95.

#### 4b. Re-check against 8A **as merged** (a second review pass, after 8A's file changed)

8A's plan file was written after the first draft of this one, so every name this slice consumes was re-read against the merged 8A rather than against §2.9's card. **Four findings, all fixed above; two of them were live defects.**

| Checked | Result |
|---|---|
| `seedEmployee(db, s, { employeeNumber?, homeBranchId?, principalId?, hiredOn? })` | **matches** (`8a:379–392`) — every 8B call site passes only `employeeNumber` and `homeBranchId` |
| `seedPayComponent(db, s, { code?, kind?, expenseAccountId?, quantityBased? })` | **matches** (`8a:3244–3255`) — 8B passes `code` and `kind`, and `linkPayrollAccounts` (T4) fills `expenseAccountId` afterwards, which is why the fixture leaves it null |
| `seedStatutoryScheme(db, s, { code?, payableAccountId?, employerExpenseAccountId? })` | **matches** (`8a:4049`) — same reasoning: T4 wires both accounts |
| `seedRateTable(db, s, { schemeId, version?, definition?, verified? })` | **matches** (`8a:4050`) — every 8B call passes all four |
| `verifyRateTable(tx, rateTableId)`, `app.assert_rate_table_verifier()`, `attach_stamp('app.statutory_rate_table','verified_by')` | **all present** (`8a:4066`, `8a:4304`, `8a:4294–4295`) — the T10/T14 handoff row that leans on the stamp being immutable is sound |
| **`packages/domain/payroll/index.ts`** | **DEFECT, fixed.** 8A Task 9 **creates** this barrel with eight exports (`8a:4672–4674`); this plan listed it as a Create. Corrected to a Modify in the File Structure, in T5's Files block and in T5 Step 6, with four `grep -c` assertions and a stop-and-raise row. Left as it was, T5 would have deleted 8A's `validate.ts` door and broken `packages/db/src/seed/statutory.ts` — 8A's own loader — with an error surfacing two packages away from the edit. |
| **`RateTable` in the barrel** | **DEFECT, fixed.** With 8A's line present, 8B's original `export type { … RateTable … } from "./types"` is a second export of one name — **TS2308**. `RateTable` is now absent from 8B's `./types` list; `payroll/types.ts` keeps its intra-folder re-export and says in a comment why the barrel must not forward it. |
| **`"./payroll"` export subpath** | **duplicate claim, corrected.** 8A's amendment A11 files the identical row and 8A T9 makes the edit (`8a:233`, `8a:4851`). Amendment **A8** is reworded from "gains" to "verified, not re-added", and T5 Step 2 is an assert-then-add with the exact `node -e` check. The row stays in this plan's amendment table because 8B is the first consumer that *breaks* without it, and a silent duplicate is worse for the contracts editor than a labelled one. |
| **`loadSnapshot` (amendment A11's hedge)** | **resolved in the expected direction.** 8A's plan mentions `loadSnapshot` **nowhere** across its fourteen tasks, so it does not touch `packages/db/src/posting/load.ts`; Task 9's first branch is the real one and now says so. The other two branches are kept deliberately — a task that silently double-writes a `refs` slot is worse than one that checks. |
| `packages/db/seed/my/statutory/` | **no conflict.** 8A creates `schemes.json`, `pay-components.json`, `README.md` and four `.gitkeep` files there; Global Constraint 8's "no file is created under `packages/db/seed/my/statutory/` **by this plan**" is about 8B and stays true. |
| Migration ranges | **no overlap.** 8A holds 0080–0086, 8B holds 0087–0090. T1 Step 1 asserts membership of 80–86, never `max(version)` (hazard 14). |

#### 5. Hazard sweep

All thirty-five re-read against the finished plan. The ones that bite here, and where:

**1** (no statutory rate anywhere) — Global Constraint 8, T5's `SYNTH`-only fixtures, T12's guard, and `sah-020`'s numeric-literal scan over every file in `packages/domain/payroll/`. **6** (one isolated task per owner decision) — T7, T8, T12, T15. **8** (Plan 0A names) — every helper cited by its exact name in the Assumptions block. **9** (`fixtures.ts` additive, only the assigned helper) — T1 adds `seedPayrollRun` and nothing else; amendment A6 records the three added options. **10** (no per-tenant rows in a migration) — Global Constraint 10 and T2's `ensureEmployeeDimensionValue`, which exists **because** of it. **13** (`lint-schema.ts`) — T1 Step 6, two names, nothing else. **14** (never assert `max(version)`) — T1 Step 1 asserts *membership* of 80–86 and says Phase 6's range may or may not be present. **18** (test 22/28's fixed projection) — T13's two multiset helpers, with `posting_policy_id` projected out and a second case explaining why. **20** (jobs as the system principal) — T14 exercises the worker path and asserts the system principal is refused just the same. **22** (nothing outside the posting service writes the ledger) — Global Constraint 1; `packages/db/src/hr/**` writes four tables and the `posting-only-tables` lint is the check. **23** (`HALF_AWAY_FROM_ZERO` at scale 4 for base) — T5's `DEFAULT_MODE` and T6's `PRORATION_MODE` are that mode, so a prorated amount rounds the way a base amount does. **26** (closed permission vocabulary) — Global Constraint 12, four codes. **28** (8A–8C need no 7A/2C) — this plan consumes neither the report engine nor the print engine; the payslip PDF is 8D's. **31** (a probe per route module) — T10 Step 9, one module, one entry. **32** (no invented literal in a shared namespace) — the Assumptions block's namespace paragraph names every one **including the test-only `PAYROLL_DDL_TEST` / `PDT`, registered by amendment A15 rather than invented in a test**, and T12 explains why `SYNTH` and `SYNTHETIC-TEST-v1` are two different strings. **33** (the slice that seeds a policy seeds its accounts) — T4, all eleven rows, plus `linkPayrollAccounts` and its `missingCodes` refusal, **and the wiring is a step the runbook runs rather than a side effect of a loader that could not be reached**. **34** (a seed file is an envelope) — T4's `PAYROLL.json` carries `module: "hr"` outside `policy`, and §4.14's own note about `hr` versus `accounting.payment.*` is quoted where it is decided. **35** (real code, failing test first, a commit per task) — every task.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-8b-payroll-engine-payroll-document.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks and fast iteration. **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute the tasks in this session with checkpoints for review. **REQUIRED SUB-SKILL:** `superpowers:executing-plans`.

**Which approach?**

#### Order, PRs and gates

Tasks run **in order**. The PR boundaries are the ones the File Structure section states: PR 1 = T1 · PR 2 = T2 · PR 3 = T3 + T4 (**together** — T3's catalogue rows and T4's policy are checked against each other by `validatePolicy` and by `permission-catalogue.test.ts`) · PR 4 = T5–T9 · PR 5 = T10 · PR 6 = T11 · PR 7 = T12–T14 · PR 8 = T15 ⚠️.

**Before Task 1 Step 2, the amendment PR of Task 1 Step 1 must be merged into the contracts document.** Sixteen rows (A1–A16) are not in that register yet, and hazard 32 makes a literal outside a register a review-blocking finding — **A15 (`PAYROLL_DDL_TEST` / `PDT`) is the row Step 2 itself depends on.** That PR touches no code.

#### Where to stop and raise, per task

| Task | Symptom | What it means, and what to do |
|---|---|---|
| **T1** | `bun run --cwd packages/db src/cli.ts status` does not list 80–86 | **8A has not merged.** This plan's phase gate is unmet. Stop; do not create `app.payroll_line` against an `app.employee` that lacks 8A's columns. |
| **T1** | `document_line_kind_check` already holds `'payroll'` | 6A's 0061 merged first. **Expected and fine** — both files write the identical list for exactly this reason. The `alter … drop … add` pair is idempotent; run it anyway. |
| **T1** | `privileges.test.ts`'s fingerprint case fails | The down file is missing a drop. Read the diff it prints; add the drop. Do **not** relax the test — §3.4.6's byte-for-byte reproduction is the check that 0087 is reversible. |
| **T2** | 6C's or 8A's employee suites now count an extra `dimension_type` | Those suites count rows per company instead of filtering `code = 'BRANCH'`. Fix the assertion to name the code it means; do not weaken the trigger. |
| **T3** | `permission-catalogue.test.ts` fails in one direction only | Steps 1 and 2 are in different commits. They must be one — the suite compares `app.permission` against `permissions.ts` **both** ways. |
| **T3** | `MODULE_READ_CODE` has no `pos` row | 6D has not merged; Phase 8 is ahead of Phase 6 (spec:2301 allows it). Add **only** the `hr` row. |
| **T4** | `validatePolicy` reports a path under `/lines/*/dimensions/from` | 2A's schema widening has not merged — `line.employee` is not in the enum. That is 2A's fix, not a narrowing here. Stop and raise. |
| **T4** | `validatePolicy` reports a path under `/approval` | One of the three `hr.payroll.*` codes is absent from `PERMISSIONS`. T3 has not merged; the two are one PR for this reason. |
| **T5** | `packages/domain/payroll/rate-table.schema.json` is absent | 8A shipped without it. Stop — do **not** hand-write a `RateTable` shape. §4.12.3 assigns the schema to 8A, and two spellings of a closed vocabulary is hazard 32. |
| **T5** | `packages/domain/payroll/index.ts` **already exists** | **Expected — 8A Task 9 creates it** (`8a:4672`) with eight exports: four `RateTable*` types from `./rate-table` and `RATE_TABLE_SCHEMA_ID` / `validateRateTable` / `parseRateTable` / `RateTableValidationError` from `./validate`. Step 6 **appends**; it does not overwrite. A barrel rewritten from scratch still typechecks inside `packages/domain` and breaks later in `packages/db/src/seed/statutory.ts`, which is 8A's own loader — run Step 6's four `grep -c` assertions rather than eyeballing the file. |
| **T5** | `bun run typecheck` reports **TS2308 "Module ./rate-table has already exported a member named RateTable"** | The barrel forwards `RateTable` twice — once on 8A's line, once through `export type { … RateTable … } from "./types"`. `RateTable` is deliberately absent from 8B's `./types` list; `payroll/types.ts` keeps its own re-export for callers *inside* the folder, and the barrel must not forward it. Delete the duplicate from the `./types` list, never 8A's line. |
| **T5** | `packages/domain/package.json` already carries `"./payroll"` | **Expected — 8A's amendment A11 adds it** (`8a:233`, `8a:4851`). Step 2 asserts and moves on; the `MISSING` branch is for a repository where 8A merged without it. Two plans filing one amendment row is a duplicate the contracts editor collapses, not a conflict to resolve in code. |
| **T5** | `dependency-rule` fires on `payroll/types.ts` importing `../src/index` | The rule is firing on the **allowed** direction. spec:2366 forbids `src/**` → `payroll/**` only. Fix the rule; say so in the commit body. |
| **T6** | `error-codes` reports the two new codes as unraised | `packages/domain/payroll/` is outside `src/**` and the rule's scan roots do not reach it — the one consequence of amendment A8. Widen the roots in the same commit. |
| **T9** | `refs.components` and `refs.schemes` are already populated | 8A did part of this slice's work (amendment A11's second outcome). Do Steps 3–5 only; keep the test file; say so in the commit body. |
| **T10** | The isolation harness fails with "a ROUTES entry has no PROBES entry" | Step 9's key does not match `payrollRunRouteModule.path` byte for byte. It is `/v1/companies/:companyId/payroll-runs` — a colon, not a brace. |
| **T10** | `postJournal`'s `JournalLine` has no `dimensions` | **Expected — 1B ships it without one** (1b:592–598). T13 Step 5 makes the additive edit under amendment A13; do it there, not here. The member name for the account is `account`, never `accountId`. |
| **T10 / T13 / T14** | `payrollFixture` throws on `seedAccount('2400')`, on `seedDocumentType('PAYROLL')` or on employee number `E-0001` | The fixture is **not idempotent** and was called twice against one `Seed` — almost always because two regression blocks share `sharedDb()`'s `seedA`. **The five 8B regression blocks already mint their own tenant for exactly this reason** (`seedTenantV2(db, "SAH-003" \| "SAH-009" \| "SAH-013" \| "SAH-031" \| "SAH-042")`, T13 Step 6 and T14 Step 3), so if you see this symptom a block was typed with `seedA` after all — give it its own tenant. A sixth caller does the same, or follows 3B's precedent and adds a per-file regression tenant (`costingContext(sah)`, `tests/regression/support/costing.ts`, 3B's amendment A21) before reusing `payrollFixture` across files. Do **not** make the fixture "safe" with `on conflict do nothing`: that hides which of two suites owns the row. |
| **T10 / T14** | `update app.statutory_rate_table set verified_by = …` raises `ERR_ACTOR_IMMUTABLE`, or a re-verified table comes back with `verified_by` null | `verified_by` is **stamped and immutable** (8a:4183 attaches `stamp_verified_by`; plan0A:2372–2377 raises on any change to a non-null `*_by`, and `app.stamp_actor` overwrites an INSERT/UPDATE value with `app.current_actor()`, which is NULL under `db.admin` with no session actor). A table therefore cannot be un-verified and cannot be re-verified through `db.admin`, and `check ((verified_at is null) = (verified_by is null))` catches the half-write. **Do not fight the trigger, and none of the three tests in this plan does — read them rather than reinventing this.** Get an unverified table the legal way: seed a *new* version with `verified: false`. `seedRateTable` inserts `effective_from '2026-01-01'` with an open end and **ignores the definition's own `effective_from`** (8a:4586–4589), so a new version covers every period from January on and, being the highest covering version, is the one `loadPayrollInputs` offers — which is what makes the refusal fire. Then get out of that state by **one of two legal moves, and pick by what the cases after it need**: (a) verify it — `withTenant(db.rw, ctx(f.verifier), (tx) => tx\`update … set verified_at = now(), verified_by = app.current_actor() …\`)`, the same statement 8A's `verifyRateTable` issues (8a:4325), which the stamp and `app.assert_rate_table_verifier()` both admit because `f.verifier` is not the loader (T14 does this — its later cases need a usable table); or (b) move it out of the period — `update … set effective_from = '2027-01-01'`, which is legal because **8A's freeze applies only once `verified_at` is set** (`if old.verified_at is not null and …`, 8a:4315–4322) and no `*_by` column changes, so neither stamp fires (T10's service and route tests do this — their later cases assert a line pins version **1**). `effective_to` may also be updated on a *verified* row; 8A's freeze deliberately excludes that one column (8a:4205–4207), which is how T14 closes v1's window at 2026-01-31. |
| **T14** | A case fails with `ERR_PERIOD_NOT_FOUND` (April/May/June) or an unexpected `ERR_PERIOD_NOT_OPEN` (February) | `payrollFixture`'s first statement, `ensureOpenPeriods(db, s, 2026)`, did not run. 0A's `seedTenant` creates three periods and only January is open (§4.1). |
| **T11** | R3's cases fail with `ERR_SOD_NO_SUBMISSION` or `ERR_DOC_STATUS_ILLEGAL` | 2B's `document_status_before` is gating a **backward** transition on authority. §4.5.1's table conditions `submitted → draft` and `approved → draft` on a reason and nothing else. Raise it against 2B; do not drop R3. |
| **T13** | Test 28's ledger multisets differ by one `5920` row | The two documents' base sums differed by a rounding residue, which cannot happen at rate `1.00000000` — `postJournal` is writing a different `exchange_rate`. Fix the fixture, not the assertion. |
| **T13** | Test 28's **dimension** multisets differ | The hand-keyed side lost EMPLOYEE. See T10's row above. |
| **T14** | Test 31's raw-SQL case **passes** the update | 2B's trigger is not resolving the PAYROLL policy. A policy it cannot resolve makes it raise `ERR_POLICY_INVALID`; a silent success means the trigger is not firing at all. Stop — this is the SAH-032 hole the trigger exists to close. |
| **T14** | Test 38's close/reopen case finds March already locked | It is not, after `ensureOpenPeriods`. The case sets `status = 'closed'` itself and reopens with a reason; nothing in it depends on 0A's fixed period states. |
| **T15** | No screenshots have arrived | **This task is blocked and the slice is not.** Ship T1–T14; leave T15 open with the owner request attached. |

#### What this slice hands the next ones

**8C** consumes: `app.payroll_run` and `app.payroll_line` and their guards (T1); the `EMPLOYEE` dimension and `ensureEmployeeDimensionValue` (T2); the four `hr.payroll.*` codes and the `hr` row of `MODULE_READ_CODE` (T3); the §4.15 accounts `2400` (salaries payable, which `PAYROLL_PAYMENT` clears), `1400` (staff advances, which `EMPLOYEE_ADVANCE` debits) and `2411`–`2414` (which the statutory schedules tie to) **already seeded and already wired to `statutory_scheme` and `pay_component`** (T4); `ytdFromPostedLines` as the one call site that changes when `employee_ytd` lands (T10); and `payrollFixture` / `postPayrollRun` (T10, §4.17.1). **8C owns** `app.employee_ytd`, the `postDocument` step-12 MERGE, its `posting-only-tables` entry, the statutory schedules, the termination flow, and `hr.payroll.pay` / `hr.advance.create`.

**8D** consumes: posted `payroll_line` rows as its payslip and annual-statement source, `readPayrollRun` and `listOverrides` for the payroll register, the `hr` attachment gate for payslip PDFs, and `tests/golden/payroll/` as the place OD-23's worked examples become cases. **8D owns** the `payroll_line`, `employee_ytd` and `statutory_schedule` `DatasetId` members and every one of the five HR reports.

**Nothing in this slice is consumed by 5A, 6A–6D, 7A–7C or 9A/9B**, which is what lets Phase 8 run alongside Phases 5–7 (spec:2301). The one shared edge is `document_line_kind_check`, and both files that write it write the identical six-label list.

