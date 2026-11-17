# Dulja Phase 8D — Payslips, annual statements, HR reports, leave register ⚠️, key rotation, parallel run

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the outputs of Phase 8 — a payslip PDF per employee per run stored as a hashed attachment, the eight `hr.*` report definitions of §4.16.1 over six new `DatasetId` members, the annual per-employee statement and employer return from `employee_ytd`, the ⚠️ leave register, the HR field-encryption key-rotation job, and the one-month parallel run whose written reconciliation the owner accepts — and with it close the Phase 8 definition of done.

**Architecture:** Four seams, none of which invents a mechanism a predecessor already owns. **Reporting** adds one file, `packages/db/src/reports/datasets/hr.ts`, holding the last six members of 7A's closed `DatasetId` registry, plus eight `ReportDefinition` JSON files under `packages/db/seed/my/reports/8d/` — a directory no other slice touches — each with an executable `tieOut` run by 7B's `assertTieOut`, whose `projection` switch this slice extends additively with two cases (`employee_ytd`, `statutory_schedule`) and never edits. **Payslips** are rendered *synchronously in `apps/api`*, through 7A's pure `renderReport` → `reportToHtmlSource` / `reportToTypstSource` and 2C's `engineFor` adapter, and stored one attachment per employee on the PAYROLL document — no new pg-boss name, because `JOBS` is closed and this slice owns exactly one member of it. **Annual statements** go the other way, through 7A's existing `reporting.render` job and `POST …/reports/{code}/runs`, because a year-end batch is a queued render and not a request-scoped one. **Key rotation** is `hr.encryption_key.rotate`, the one job name §4.2.6 assigns 8D: it re-opens every `employee_sensitive` column with 8A's `openField` under the version stamped in the envelope's first byte and re-seals it with `sealField` under the ring's current key, in bounded batches, as the tenant's system principal.

**Tech Stack:** TypeScript 5 (strict), Bun for everything but tests, Node 24 + Vitest for tests, PostgreSQL 18 through `postgres.js` tagged templates and Drizzle read mirrors, Hono + `@hono/zod-openapi`, Zod, `decimal.js` behind `Money`, pg-boss, Testcontainers. No package version is written into a source file — the lockfile owns versions (spec:104).

**Spec:** `C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` — §3.10.1 (Outputs, Year-to-date, Leave ⚠️, Attendance, Reports, the Out-of-v1 list — spec:2083, 2084, 2085, 2089, 2091, 2093), §3.10.4 (spec:2105), §3.10.5 (spec:2109), §4.2.2 R4 (spec:2175), §4.6 HR data and the HR key (spec:2211), §4.11 secrets (spec:2273), §0.2 the report-per-phase rule (spec:110), Part V Phase 8, Part VI tests 23, 31, 32, 33, Part VII #13 and #14. Contracts: `C:/Users/Edres101/Desktop/dulja/docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 8D — Payslips, annual statements, HR reports, leave register ⚠️, key rotation, parallel run. **Phase:** 8. **Phase gate:** this plan starts only when **8C**, **7A** and **2C** are merged and the Phase 7 definition of done is green in CI (spec:87). §6.3 places 8D after "8A → 8B → 8C" *and* after 7A; hazard 28 states it in one line — "Phase 8 may run alongside Phases 5–7 but 8D needs 7A and 2C (F-9b: annual statements use the report engine; payslips are attachments). 8A–8C do not."
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.stamp_actor`, `app.forbid_change`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, `readConfig`, `ApiConfig`, `ConfigError`, `PERMISSION`, `PERMISSIONS`, `PermissionDef`, `PermissionCode`, `SliceId`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `StartedApi`, `ApiRequest`, `PROBES`, `IsolationProbe`, `TENANT_FREE`, `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `JOBS`, `JobName`, `JobPayload`, `JobClient`, `JobEnvelope`, `eachTenant`, `registerHandler`, `runJob`, `JOB_PROBES`, `JobIsolationProbe`, `startWorker`, `ROLES`, `seedBranch`. **0C** — the seed CLI, `SubPack`, `SUB_PACKS`, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES`, `OWNED_ELSEWHERE`, `containerSecrets`. **0E** — `packages/ui`, `packages/i18n`, `bootLocalStack`, `grantAdminRole`, **ADR 0016** (the PDF engine). **1A** — `seedTenantV2`, `seedAccount`, `postDocument`, `resolvePolicy`. **1B** — `postJournal`, `registerProjectionCheck`, `projectionChecks`, `reportsRouteModule`, `ReportCodeSchema`. **2A** — `seedDocumentType`, `seedParty`, `DocumentTypeModuleSchema`. **2B** — `grantCodes`, `app.principal_has`, `app.document_event`. **2C** — `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, `requireDocumentModuleRead` (all four in `apps/api/src/middleware/require-attachment-read.ts` — the path 2C shipped; 4A's Task 0 already filed the §4.5.8 prose correction), `ObjectStore`, `MemoryObjectStore`, `objectKeyFor`, `engineFor`, `PdfEngine`, `PrintEngineCode`, `PDF_ENGINES`, `pdfText`, `app.attachment`. **6C** — `app.employee`, `app.attendance_event`, `employeeRoutes`, `employeeRouteModule`, `packages/contracts/src/hr/employee.ts`, `app.actor_in_branch`, `seedEmployee`. **7A** — `defineDataset`, `Dataset`, `DatasetSpec`, `DatasetColumn`, `DatasetParams`, `DatasetRow`, `DatasetFilter`, `DatasetSortKey`, `datasetWhere`, `datasetOrderBy`, `SqlFragment`, `MAX_DATASET_ROWS`, `DATASETS`, `DATASET_IDS`, `DatasetId`, `datasetFor`, `isDatasetId`, `ReportError`, `ReportErrorCode`, `ReportDefinition`, `validateReportDefinition`, `parseReportDefinition`, `ReportDefinitionSets`, `ReportDefinitionError`, `REPORT_CODE_PATTERN`, `isReportCode`, `reportCode`, `moduleOfReportCode`, `REPORT_FILTER_OPS`, `ReportFormat`, `ReportLang`, `ReportPaper`, `renderReport`, `RenderedReport`, `RenderOptions`, `ReportFormatters`, `renderCsv`, `interpolate`, `reportToHtmlSource`, `reportToTypstSource`, `loadReportDefinitions`, `reportsLoader`, `ReportSeedEnvelope`, `reportDefinitionSets`, `assertDefinitionFields`, `reportObjectKeyFor`, `seedReportDefinition`, `app.report_definition`, `app.report_run`, the `reporting.render` job and `POST …/reports/{code}/runs`. **7B** — `tests/invariants/support/reports.ts` in full: `readEnvelope`, `readDefinition`, `runDefinition`, `assertFieldCoverage`, `LedgerWindow`, `TieOutWitness`, `TieOutOptions`, `assertTieOut`, `reportFixture`, `cachedReportFixture`. **7C** — `datasets/pos.ts` and the three Phase 6 `DatasetId` members it appended, `app.export_job`, `EXPORT_TABLES`, `NEVER_EXPORTED`. **8A** — `app.employee` as extended by 0080, `app.employee_sensitive`, `app.employee_statutory_profile`, `app.pay_component`, `app.pay_component_scheme`, `app.compensation_line`, `app.statutory_scheme`, `app.statutory_rate_table`, `app.company_hr_setting`, `HrKey`, `HrKeyRing`, `HrKeyError`, `createHrKeyRing`, `HR_KEY_BYTES`, `DEV_HR_KEY`, `SENSITIVE_FIELDS`, `SensitiveField`, `sealField`, `openField`, `SensitiveValues`, `SensitiveRow`, `readSensitive`, `writeSensitive`, `composeEmployeeRouter`, `hrFixture`, `hrActor`, `HrFixture`, `app.forbid_self_pay()`, `ERR_HR_SELF_PAY`, the `sensitive_gate` linter rule, `seedPayComponent`, `seedStatutoryScheme`, `seedRateTable`, the `statutory` sub-pack loader, `ApiConfig.hrFieldEncryptionKey` / `.hrFieldEncryptionKeyPrevious`, `AppDeps.hrKeys`. **8B** — `app.payroll_run`, `app.payroll_line`, `app.employee_dimension()`, `ensureEmployeeDimensionValue`, `linkPayrollAccounts`, `payrollRunRouteModule`, `packages/contracts/src/hr/payroll-run.ts`, `packages/db/seed/my/chart-of-accounts/8b-payroll.json`, `packages/db/seed/my/document-types/PAYROLL.json`, `packages/db/seed/test/statutory/SYNTH/v1.json`, `seedPayrollRun`, and `tests/invariants/support/payroll.ts` in full (`PAYROLL_PACK_ROOT`, `SYNTH_TABLE`, `PayrollFixture`, `payrollFixture`, `postPayrollRun`, `secondApprover`). **8C** — `app.statutory_schedule` (with amendment B11's `currency` and `generated_by`), `app.employee_ytd`, `app.employee_ytd_opening`, `generateStatutorySchedule`, `readSchedule`, `listSchedules`, `StatutoryScheduleResult`, `ScheduleRow`, `missingEmployerRegistrations` (all in `packages/db/src/hr/schedule.ts`), the `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` document types, the `terminated_on` trigger, the `employee_ytd` MERGE at `postDocument` step 12 and its `posting-only-tables` entry, and the `hr.employee_ytd.rebuild` job with its `ProjectionCheck`.
- **8C's plan file is written** (`docs/superpowers/plans/2026-09-05-dulja-phase-8c-payroll-money-out-ytd-termination.md`) and is the authority for what 8C ships, with §4 as the frozen contract underneath it. This plan consumes **8C's migration 0091 `statutory_schedule` (which carries §4.6.1's columns *plus* 8C amendment **B11**'s `currency char(3) not null` and `generated_by uuid not null default app.current_actor()`)**, 8C's migration 0092 `employee_ytd` (§4.12.8, verbatim) and `employee_ytd_opening`, 8C's `generateStatutorySchedule` / `readSchedule` / `listSchedules` in `packages/db/src/hr/schedule.ts`, and §4.14's `PAYROLL_PAYMENT` / `EMPLOYEE_ADVANCE` rows. Task 0 Step 2 asserts the shipped DDL against **that** column list before any dataset is written, and any divergence is an 8C-side correction filed in the PR description, never a silent adaptation here.
- **Migration numbers:** 0096–0099 — `0096_create_leave_register.sql` (**Task 8, ⚠️ OD-13, dropped whole if the owner says no**), `0097_seed_permission_phase8d.sql` (Task 1), `0098_add_employee_contract_end.sql` (Task 2), **0099 unused and left unused** (§3.4.1: gaps are fine). **ADR numbers:** 0079–0080 — `0079-payslips-are-attachments-rendered-synchronously.md` (a **proposal**, spec:95 — it touches the data model) and `0080-hr-key-rotation-procedure.md` (a **proposal** — it touches security).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `MONEY_SCALE`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, `ApiConfig`, the fixed middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError` — **this slice adds no `ERRORS` row**), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `requirePermission`, `assertRouteGates`, `ROLES`), §4.2.6 (`JOBS`, `JobPayload`, `registerHandler`, `runJob`, `eachTenant`, `JOB_PROBES` — **this slice registers exactly one handler, `hr.encryption_key.rotate`**), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IdempotencyHeader`, `createApp`, `AppDeps`), §4.2.8 (the common schemas, the list envelope, and **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`, `REPLAY_BY_RERUN`), §4.2.12 (`startApi`, `StartedApi`), §4.2.13 (`PackLoader`, `SUB_PACKS`, `readPackFile`), §4.3.4 (`document_line`), §4.5.8 (`app.attachment`, `MODULE_READ_CODE` — consumed, **the `hr` row is 8B's and is not re-added**), §4.5.9 (`app.print_template`'s `paper` vocabulary, and the rendered-text determinism rule), §4.6.1 (the register rows for `attendance_event`, `statutory_schedule`, `employee_ytd`, `employee_ytd_opening`, and the four ⚠️ leave tables), §4.6.2 (the minimal `employee`), §4.11.1–§4.11.2 (`ReportDefinition`, `report_definition`, `report_run`, the render job), **§4.12 in full**, §4.14, §4.15, **§4.16.1 (the eight `hr.*` codes) and §4.16.2 (the six HR `DatasetId` members)**, §4.16.3 (`registerProjectionCheck`), §4.17, §4.17.1, §4.18 (all three rounds), §5 (all thirty-five hazards), §6.1 rows 23, 31, 32, 33, §6.2 rows spec:1059 and spec:1060.
- **Interfaces produced:** §4.16.1's **eight 8D report codes** as `packages/db/seed/my/reports/8d/*.json`; §4.16.2's **six HR `DatasetId` members** in `packages/db/src/reports/datasets/hr.ts`; §4.2.6's `hr.encryption_key.rotate` payload, handler and probe; §3.6.2's `hr.filing.generate` and (⚠️ OD-13) `hr.leave.record` / `hr.leave.approve`; §4.6.1's four ⚠️ leave tables as migration 0096; the payslip surface (`payslipRows`, `renderPayslip`, `PAYSLIP_ENGINE`, `createPayslipRoutes` composed onto 8B's `payroll-runs` module); the permit-expiry sub-path composed onto 6C's `employees` module; the two shared test helpers of amendment **A7**; `PAYSLIP_ENGINE` (**A11**); and `apps/worker/src/hr-keys.ts` (**A12**). Everything else is listed under **Contract additions** in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-13** (leave register — spec:1060, 2085, 2478; Part VII #14) → **Task 8**, isolated and dropped whole; default **not built**. **OD-23** (staff list, accountant sign-off for the parallel run — spec:2407) → **Task 9**, isolated; default the run executes against the `SYNTH` fixture corpus and produces the same report. **OD-28** (form names verified against LHDN at build time — spec:2083) → **Task 6**, isolated; default a generic statement whose form identifiers are configuration, not literals. **OD-24** (screenshots and a two-minute operator description before any screen — spec:79, 108, 2408) → **Task 10**, isolated; default **the screen task is blocked, not the slice**. **OD-05** (confirmation of every ⚠️ row in §3.0.4) touches 8D through exactly one row — spec:1060 "Attendance events; leave ⚠️" — which is the same ⚠️ as OD-13; **Task 8 discharges both** and no second task is created for it.
- **The orchestrator's slice JSON lists `OD-14` among this slice's gates; the §2.9 card does not, and §2.12 assigns OD-14 to "8A/8B → one task each if yes".** The card and the ledger agree with each other and outnumber the JSON, so **this plan writes no OD-14 task**; the discrepancy is carried in `spec_questions` for the architect to reconcile in one line.
- **Part VI tests owned / re-run:** owns **none exclusively** (§2.9). Re-runs **33** (payslips and schedules byte-identical across runs — Task 5), **23** (the payslip PDF in both text directions — Task 5), **32** (report side channels: no HR report or dataset exposes a sensitive or compensation field — Task 3), **31** (the leave-approval clause ⚠️ — Task 8), and **30**'s schedule clause through `hr.payable_reconciliation` (Task 4). **§3.0.4 rows owned:** spec:1059 (Payslips, schedules, annual statements, `employee_ytd`, cut-over import — 8C contributes `employee_ytd`, 9B the import) and spec:1060 (Attendance events; leave ⚠️ — 6C contributes the events). **Regression files created / appended:** creates **none**; **appends** to `tests/regression/legacy-011.test.ts`, `legacy-020.test.ts`, `legacy-033.test.ts` and `legacy-085.test.ts` — all four are 0B's under §3.7.3's Plan 0A-proven and structural lists, so every 8D block is an append and no earlier block is edited.
- **Shared namespaces this slice writes into:** **Report codes (§4.16.1) — the eight this slice owns**: `hr.employee_list`, `hr.payroll_register`, `hr.statutory_summary`, `hr.payable_reconciliation`, `hr.contract_expiry`, `hr.attendance`, `hr.payslip`, `hr.annual_statement`. **`DatasetId` members (§4.16.2) — the six this slice owns**: `employee`, `attendance_event`, `payroll_line`, `employee_ytd`, `statutory_schedule`, and ⚠️ `leave_record` (dropped with the table if OD-13 = no). **Document-type codes (§4.14) — none seeded, none invented**; `PAYROLL` (8B), `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` (8C) are consumed by code and asserted to exist in Task 0. **Account codes (§4.15) — seeds none.** Six are consumed as literals in a definition's `tieOut.account` or a test assertion, each with its seeding slice: **`2400`** Salaries payable, **`2411`–`2414`** Statutory payable per scheme, **`5300`** Salaries expense (all **8B**); Task 0 Step 4 asserts each resolves for the seeded company and re-seeds none — hazard 33 in the consuming direction. **`fixtures.ts` helpers (§4.17) — none added**; `seedReportDefinition` (7A), `seedEmployee` (6C/8A), `seedPayComponent` / `seedStatutoryScheme` / `seedRateTable` (8A) and `seedPayrollRun` (8B) are consumed unchanged. **Shared test helpers (§4.17.1) — one new file**, `tests/invariants/support/hr-reports.ts` (amendment **A7**), plus the two `assertTieOut` `projection` cases amendment **A6** registers.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-08 (§4.18 already carries Round 3; this slice's twelve amendments land as an **8D** sub-heading under it).

## Contract amendments this plan discovered

§4.18 carries Round 1, Round 2 and Round 3, and **Round 3's own preamble says in terms that a slice's Task-0 amendment set stays that slice's to land, in that slice's own PR** — pre-applying it centrally would make the gate pass before the plan started. None of the twelve below is in Round 3's table. They are stated here and **Task 0 files them as one amendment PR against the contracts document, under an `8D` sub-heading of Round 3, before any code in this slice is written.**

| # | § | Name or decision | Source |
|---|---|---|---|
| **A1** | 3.11, 4.12.5 | **`HR_FIELD_ENCRYPTION_KEY_VERSION` joins §3.11** — holder api + worker, set by 8D, meaning "the integer `key_version` the current `HR_FIELD_ENCRYPTION_KEY` seals under; default `1`". 8A's Self-Review left this open in terms ("8D's rotation task adds one … in the amendment PR that introduces the rotation job"), because `createHrKeyRing` requires a `currentVersion` and nothing in §3.11 supplied it. It is **optional everywhere and defaults to `1`**, so no existing environment changes; `HR_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION` is **not** added — `createHrKeyRing` already derives it as `currentVersion − 1`, which is what a rotation produces. Both names join `containerSecrets(env, entrypoint)` for **`api` and `worker`** in the same PR | plan |
| **A2** | 4.6.1 (`employee` row) | **`app.employee` gains `contract_ends_on date`** (migration **0098**, 8D, expand-only). spec:2091 requires a "contract and permit expiry list" and neither §4.6.2's minimal DDL nor 8A's 0080 extension carries a contract end date, so `hr.contract_expiry` would have had nothing to report. It is a plain column beside `hired_on` and `terminated_on`, **not** an `employee_sensitive` field: an employment end date is an operational fact of the same class as a hire date, and putting it in the encrypted table would make the report impossible without making it more private | plan |
| **A3** | 4.16.1 (`hr.contract_expiry` row) | **The permit half of `hr.contract_expiry` is a route, not a report column.** `work_permit_expiry` lives in `employee_sensitive` as ciphertext (§4.12.5), so no `DatasetId` can serve it — a dataset returns `string \| number \| boolean \| null` from SQL and cannot decrypt. §4.16.1 already gates the report on **`hr.employee.read`**, which test 32 forbids from seeing a sensitive field, so the register had in fact already decided this. The permit list ships as **`GET /v1/companies/{companyId}/employees/permit-expiry`**, gated `hr.employee.read_sensitive`, composed onto 6C's `employees` module through 8A's `composeEmployeeRouter` (amendment A16) and therefore adding **no** `PROBES` key | correction |
| **A4** | 4.11.2, 4.5.9 | **A payslip is rendered synchronously in `apps/api`, not by `reporting.render`.** 7A's three renderers and its two PDF engines live in `apps/worker` and `apps/api` may not import an app (§3.1); 2C's `engineFor` / `PDF_ENGINES` already live in `apps/api/src/print/engines/` and already turn rendered template text into a PDF. A payslip is therefore `renderReport` (pure, `@dulja/domain`) → `reportToHtmlSource` / `reportToTypstSource` (pure, 7A) → `engineFor(code)` (2C, `apps/api`) → `ObjectStore.put` → one `app.attachment` row. **The annual statement stays on `reporting.render`**, because a year-end batch over every employee is a queued render. This adds **no** `JOBS` member and the registry stays closed | plan |
| **A5** | 4.2.9 | **`POST …/payroll-runs/{documentId}/payslips` is a normal idempotent write and is NOT a `REPLAY_BY_RERUN` member.** It returns JSON (the list of attachment ids), not bytes, so the middleware's `JSON.parse` of the stored body is correct; and §4.2.9's rule is explicit — "a route that writes may never join this list". The **download** is 2C's existing `GET …/attachments/{attachmentId}/content`, a `GET`, which the middleware never touches | plan |
| **A6** | 4.17.1 (7B's row) | **`assertTieOut`'s `projection` switch gains two cases, `"employee_ytd"` and `"statutory_schedule"`**, additively. 7B's row already says the switch "is extended additively by 7C and 8D for their own sources and never edits a case"; this row names 8D's two so a reviewer can see the whole set. No other export of `tests/invariants/support/reports.ts` changes | plan |
| **A7** | 4.17.1 | **`tests/invariants/support/hr-reports.ts` (8D)** — `HR_CATALOGUE`, `HrReportCode`, `HR_CATALOGUE_DIR`, `readHrEnvelope`, `readHrDefinition`, `HrReportFixture`, `hrReportFixture`. Registered on §4.17.1's terms: it is the one place an 8D definition is read off disk and executed against the payroll corpus, and six test files call it. **`HrReportFixture` carries `schedules` (8C's `generateStatutorySchedule` output for the posted run) and `draftRunDocumentId`** — the schedule rows because nothing but 8C's service writes `app.statutory_schedule`, so a corpus without the call leaves the `statutory_schedule` dataset, the `hr.statutory_summary` tie-out and Task 4's projection arm with nothing to compare; the draft id so every "posted figures only" assertion has a real negative instead of a conditional that passes vacuously | plan |
| **A8** | 4.6.1 (leave rows) | **`app.public_holiday` carries §4.5.6 Form B (`branch_id is null or app.actor_in_branch(company_id, branch_id)`)**, not Form A: §4.6.1 gives it a nullable `branch_id` and a company-wide holiday is exactly the NULL case. Appendix A item 2 already proposes this form for the spec; the row is stated here because `branch_isolation_policy` (6C's linter rule) fires on any `branch_id` column and would otherwise report a violation on a table §3.5.3 gives no exemption. **`leave_type`, `leave_entitlement` and `leave_record` have no branch key and receive no policy** — they are isolated through `employee`, exactly as `document_line` is through `document` | plan |
| **A9** | 3.6.3, 3.4.2 | **The two ⚠️ `hr.leave.*` permission rows are inserted by `0096_create_leave_register.sql`, not by `0097_seed_permission_phase8d.sql`.** §3.6.3 says each introducing slice ships its codes in its `NNNN_seed_permission_phase<slice>.sql`, and for the *unconditional* code (`hr.filing.generate`) that is exactly what 0097 does. But `permission-catalogue.test.ts` compares `app.permission` against `permissions.ts` **in both directions**, so a leave code seeded by 0097 while OD-13 is unanswered would fail the build with no table to gate; and dropping Task 8 must leave 0097 untouched. Putting the two rows in 0096 makes the whole gate exactly one file, one `permissions.ts` hunk and one task — which is §2.0's one-task-per-owner-item rule applied to a migration. §3.4.2's naming rule is satisfied: the file creates the leave register *and* seeds the two codes that gate it, and `0096_create_leave_register.sql` is the name the card fixes | settlement |
| **A10** | 4.17.1 (7B's row), 4.16.2 | **The `payroll_line` dataset carries two SIGNED measures, `net_contribution` and `payable_contribution`, and 7B's `LEDGER_MEASURE` map gains those two keys — both `"credit"`.** Discovered while reviewing: 7B's `firstMoneyTotal` requires a definition's first money `sum` total to be a **key of `LEDGER_MEASURE`** (`base_debit`, `base_credit`, `base_balance`, `base_total`) and throws otherwise, so a definition summing `amount` cannot tie to the ledger at all. And it should not: a run's lines are earnings, deductions and both scheme shares, whose naive sum equals nothing the ledger holds. The two measures are computed **in SQL** by the dataset (never in JavaScript, spec:2041) as each line's signed contribution to one §4.15 account — `net_contribution` to `2400`, `payable_contribution` to the scheme's own `241n`. **`net_contribution` BUILDS net from the component and scheme lines and scores the net-pay leg itself ZERO**: 8B writes an all-null `payroll_line` beside the net-pay `account` line carrying `amount = e.net` (8b:4730–4734), so a measure without that explicit first arm would count net twice and the tie-out would fail by a factor of two. Building net from its parts is also what keeps the two sides independent — taking the net-pay leg as the sole contributor would compare the posting against itself. The map gains **two keys and changes none**, on exactly A6's additive terms. **`hr.payslip` takes `tieOut: { kind: "none" }` instead**: it is scoped to one employee and 7B's `ledger_sum` query has no dimension filter, so it would compare one payslip against the whole run's `2400` credit; Task 5's `payslipRows` test carries that clause in SQL, per employee and in total | correction |
| **A11** | 4.5.9 | **`PAYSLIP_ENGINE: PrintEngineCode` in `apps/api/src/print/payslip.ts` (8D)** — the ADR-0016 code a payslip renders through. 2C's print route reads its engine off `print_template.engine` and a payslip has no template row; 2C exports no engine-choice function of any name; and hazard 30 forbids an environment read. So the choice is a named constant in one place, `"chromium"` by default on 2C's own terms (2c:3444 — "the default this plan writes, not a choice it makes"), changed in one line if ADR 0016's Decision row names `typst` | plan |
| **A12** | 3.11, 4.2.6 | **`apps/worker/src/hr-keys.ts` (8D)** — `hrKeyRing()`, `setHrKeyRing(ring)`, `hrKeyRingFromEnv(env)`. `apps/worker` has no config module (0D's entrypoint reads `process.env` directly) and 8A put the HR key names on `ApiConfig`, which `worker` may not import (§3.1). This is 7A's `objectStore()` / `setObjectStore()` / `objectStoreFromEnv()` trio in shape and for the same reason: the entrypoint composes once, a test injects. **`apps/api/src/index.ts`'s `createHrKeyRing({ …, currentVersion: 1 })` becomes `config.hrFieldEncryptionKeyVersion` in the same PR**, closing 8A's open question (8a:6951) — without it the API would seal new writes under v1 while the worker re-sealed under v2 | plan |

## Global Constraints

Every task inherits these. They are the spec's and the contracts document's project-wide rules, copied verbatim where they are verbatim.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation; issue DDL from application code; disable an invariant, constraint or trigger "temporarily"; gate an audit write on any flag; hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.
3. **Hazard 1 — no real statutory rate, threshold, ceiling or formula anywhere**: not in a plan, a test, a fixture, a seed file or a comment (spec:2080). Every payroll figure this slice's tests assert is produced by `SYNTH` / `SYNTHETIC-TEST-v1` (§4.12.4). **A number that looks like a contribution rate in this plan is a defect.**
4. **Hazard 32 — no plan invents a literal in a shared namespace.** Document-type codes (§4.14), account codes (§4.15), report codes and `DatasetId` members (§4.16), `fixtures.ts` helper names (§4.17) and the `ERR_*` space (§4.2.4) are registers; a literal outside them is a review-blocking finding.
5. **Hazard 33 — the slice that seeds a policy seeds the accounts that policy names by code.** This slice seeds **no** account: `2400`, `2411`–`2414` and `5300` are 8B's, and Task 0 asserts they resolve rather than re-seeding them.
6. **Hazard 22 — nothing outside `packages/db/src/posting/` and `packages/db/src/costing/` writes ledger, movement, layer, projection or tax-transaction tables.** `app.employee_ytd` joined that list with 8C. **This slice reads it and never writes it.**
7. **Hazard 30 — the PDF engine is decided once, in 0E (ADR 0016)**; 2C, 7A and 8D consume that ADR and never re-evaluate engines. Determinism is asserted at the **rendered-text layer** through `pdfText`, never at the byte layer (§4.5.9).
8. **Hazard 6 — pending owner decisions are isolated tasks.** One task per OD item, droppable without renumbering neighbours' interfaces.
9. **Hazard 13 — `lint-schema.ts` is a merge hotspot.** §3.5.3 gives `leave_type`, `leave_entitlement`, `leave_record` and `public_holiday` **no** set membership: all four carry `id`, `created_at` and an `audit_row` trigger, and the six sets are edited by this slice **not at all**. A task that finds itself editing `packages/db/src/lint-schema.ts` has gone wrong.
10. **Hazard 20 — jobs run as the tenant's system principal** (`systemContext`, spec:2179), never under a human's id, and every job write is audited under the system principal.
11. **Hazard 31 — every route module needs a `PROBES` entry keyed by its `RouteModule.path`.** This slice mounts **one** new module (⚠️ leave, Task 8) and therefore adds **one** `PROBES` entry, dropped with the task; its payslip and permit-expiry sub-paths hang on 8B's and 6C's existing modules and add none.
12. **§3.2 money and time**: `numeric(19,4)`, `Money` from `@dulja/domain`, no `number` ever holding money; all timestamps `timestamptz` in UTC; `effective_date` is a `date` and is the accounting date, never derived from `posted_at`.
13. **§3.8 commits**: conventional commits scoped by workspace, subject `<type>(<scope>): <summary> [8D T<n>]`, and **every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`**. One migration per PR (spec:2057).
14. **§3.1 dependency rule**: `domain` imports nothing internal; `db` and `contracts` import `domain`; `api`, `worker`, `pos`, `backoffice` import from packages, never from each other. And the intra-package rule (spec:2366): `packages/domain/src/**` may not import `packages/domain/payroll/**`.
15. **Definition of done for any pull request** (spec:2275): tests added or updated · migration is reversible · OpenAPI updated if the API changed · both text directions checked if the UI changed · no new ⚠️ left unresolved in the code without a linked issue.

## Definition of done for this slice

Phase 8's definition of done, verbatim (spec, Part V): *"The business's real monthly payroll runs in Dulja **in parallel with the legacy system for one month**: every gross, statutory and net figure matches the legacy run and the authorities' calculators to the cent, or every difference is explained in writing and accepted by the owner; the run posts through the posting service under pinned policy and rate-table versions; Σ payslip net = salaries-payable credit; each scheme's schedule = its payable to the cent; preparer ≠ approver is enforced by the data layer; `employee_ytd` rebuilds bit-identically."*

**This slice's share** (§2.9): the first clause — the parallel run and the written reconciliation the owner accepts. The other five clauses are 8B's and 8C's and are re-run here, not re-proved.

| Clause | Where it is discharged |
|---|---|
| One month in parallel; every difference explained in writing and accepted by the owner | **Task 9** — `payroll:reconcile` produces `docs/runbooks/payroll-parallel-run.md`'s difference report; the owner's acceptance is the OD-23 gate |
| Σ payslip net = salaries-payable credit | **Task 5**'s `payslipRows` test, in SQL, per employee and in total; and **Task 4**'s `hr.payroll_register` `ledger_sum` tie-out on `2400` over `net_contribution` (amendment A10). `hr.payslip` itself declares `tieOut: none` — it is scoped to one employee and 7B's helper has no dimension filter |
| Each scheme's schedule = its payable to the cent | **Task 4** — `hr.payable_reconciliation`, once per scheme against that scheme's own `241n` ledger balance. That `ledger_sum` is the whole of the proof; the `statutory_schedule` `projection` tie-out beside it proves the definition and dataset agree with the stored projection (both sides read `app.statutory_schedule`) and is not a second ledger path |
| `employee_ytd` rebuilds bit-identically | 8C's; **Task 4** re-reads the projection through the `employee_ytd` dataset and its tie-out compares the two paths |
| Payslips and schedules byte-identical across runs (test 33) | **Task 5** — at the rendered-text layer through `pdfText` (§4.5.9), never at the byte layer |
| Sensitive fields have no side channel through a report (test 32) | **Task 3** — over the OpenAPI document, the definition corpus and a direct `app_rw` query |
| The Phase 8 report against the definition of done (spec:110) | **Task 12** |

---

## File Structure

Every path is repository-relative. `NEW` files are created by this slice; `EDIT` files are modified additively. The right-hand column is the task number. Files marked ⚠️ exist only if **OD-13** is answered *yes*, and Task 8 creates all of them or none.

```
packages/db/migrations/
├─ 0096_create_leave_register.sql             NEW ⚠️ four tables + the two hr.leave.* rows   T8
├─ 0096.down.sql                              NEW ⚠️                                        T8
├─ 0097_seed_permission_phase8d.sql           NEW  hr.filing.generate                        T1
├─ 0097.down.sql                              NEW                                           T1
├─ 0098_add_employee_contract_end.sql         NEW  employee.contract_ends_on (A2)            T2
└─ 0098.down.sql                              NEW                                           T2
                                                  (0099 is allocated and left unused — §3.4.1)

packages/db/src/reports/
├─ datasets/hr.ts                             NEW  the six HR datasets                   T2, T8
├─ datasets.ts                                EDIT the union and DATASETS gain six       T2, T8
└─ index.ts                                   EDIT export * from "./datasets/hr"             T2

packages/db/src/hr/
├─ payslip.ts                                 NEW  payslipRows, PayslipRow, PayslipParams    T5
├─ permit-expiry.ts                           NEW  permitExpiry, PermitExpiryRow (A3)        T3
├─ rotate.ts                                  NEW  rotateSensitiveKeys, RotationResult       T7
├─ reconcile.ts                               NEW  reconcileParallelRun + its two types      T9
├─ leave.ts                                   NEW ⚠️ leave CRUD under RLS                   T8
└─ index.ts                                   EDIT re-exports each of the above        T3,T5,T7,T8,T9

packages/db/src/schema/
├─ leave-type.ts                              NEW ⚠️ Drizzle mirror (§3.4.9)                T8
├─ leave-entitlement.ts                       NEW ⚠️                                        T8
├─ leave-record.ts                            NEW ⚠️                                        T8
├─ public-holiday.ts                          NEW ⚠️                                        T8
└─ employee.ts                                EDIT + contractEndsOn                          T2

packages/db/seed/my/reports/8d/
├─ hr.employee_list.json                      NEW                                            T3
├─ hr.contract_expiry.json                    NEW                                            T3
├─ hr.attendance.json                         NEW                                            T3
├─ hr.payroll_register.json                   NEW                                            T4
├─ hr.statutory_summary.json                  NEW                                            T4
├─ hr.payable_reconciliation.json             NEW                                            T4
├─ hr.payslip.json                            NEW                                            T5
└─ hr.annual_statement.json                   NEW ⚠️ OD-28 — the only file Task 6 creates    T6

packages/db/test/
├─ hr/predecessors.test.ts                    NEW  the 8C/7A/7C/2C repository gate            T0
├─ reports/hr-datasets.test.ts                NEW  the six datasets, filters, no SQL text T2, T8
├─ reports/hr-definitions.test.ts             NEW  the eight definitions and their tie-outs
│                                                                              T3, T4, T5, T6, T11
├─ reports/datasets.test.ts                   EDIT 7A's pinned array 29 → 34 → 35 (§3.7.3) T2, T8
├─ reports/7c-datasets.test.ts                EDIT 7C's toHaveLength 29 → 34 → 35          T2, T8
├─ hr/payslip.test.ts                         NEW  payslipRows under RLS and the gate         T5
├─ hr/permit-expiry.test.ts                   NEW  the sensitive gate, decrypted dates        T3
├─ hr/rotate.test.ts                          NEW  round-trip, batching, idempotence          T7
├─ hr/reconcile.test.ts                       NEW  the difference report                      T9
├─ hr/leave.test.ts                           NEW ⚠️ DDL, RLS, R4, two-tenant                T8
├─ permission-catalogue.test.ts               EDIT + hr.filing.generate                   T1, T8
└─ seed/reports.test.ts                       EDIT + the 8d/ directory case                  T11

packages/domain/src/payroll/                  (nothing — the calculator is 8B's and is untouched)

packages/contracts/src/hr/
├─ payslip.ts                                 NEW  PayslipSchema, GeneratePayslipsBody, …     T5
├─ permit-expiry.ts                           NEW  PermitExpirySchema, PermitExpiryQuery, …   T3
├─ leave.ts                                   NEW ⚠️ the four leave modules' schemas         T8
└─ ../index.ts                                EDIT re-exports the new modules          T3, T5, T8

packages/contracts/
└─ permissions.ts                             EDIT + hr.filing.generate; ⚠️ + two leave  T1, T8

packages/db/seed/roles.ts                     EDIT hr_payroll gains the new codes        T1, T8

apps/api/src/
├─ hr/authorise.ts                            NEW  requireFilingGenerate (§3.6.3's reference) T1
├─ routes/hr/payslips.ts                      NEW  payslipRoutes (composed onto 8B's module) T5
├─ routes/hr/permit-expiry.ts                 NEW  permitExpiryRoutes (composed onto 6C's)   T3
├─ routes/hr/leave.ts                          NEW ⚠️ leaveRoutes + leaveRouteModule         T8
├─ routes/hr/employees-composed.ts            EDIT + the permit-expiry sub-router (A3)       T3
├─ routes/index.ts                            EDIT payroll-runs gains payslips; ⚠️ leave T5, T8
├─ index.ts                                   EDIT the ring's currentVersion (A1)            T7
└─ print/payslip.ts                           NEW  renderPayslip + PAYSLIP_ENGINE            T5

apps/api/test/
├─ hr/authorise.test.ts                       NEW  200 / 403 through the real chain          T1
├─ routes/hr/payslips.test.ts                 NEW  generate, hash, replay, both directions   T5
├─ routes/hr/permit-expiry.test.ts            NEW  403 without read_sensitive                T3
├─ routes/hr/leave.test.ts                    NEW ⚠️ request → approve; R4 through the API  T8
└─ routes/accounting/report-runs.test.ts      EDIT + the hr.annual_statement queued case     T6

apps/worker/src/
├─ hr-keys.ts                                 NEW  hrKeyRing/setHrKeyRing/hrKeyRingFromEnv   T7
├─ jobs/hr-key-rotate.ts                      NEW  the hr.encryption_key.rotate handler      T7
└─ index.ts                                   EDIT registerHandler("hr.encryption_key.rotate")T7

apps/worker/test/
├─ hr/key-rotate.test.ts                      NEW  the handler through startWorker           T7
└─ support/worker.ts                          EDIT registers the rotation handler            T7

packages/db/src/jobs/payloads.ts              EDIT + the hr.encryption_key.rotate key        T7

infra/
├─ secrets.ts                                 EDIT + HR_FIELD_ENCRYPTION_KEY_VERSION (A1)    T7
└─ test/secrets.test.ts                       EDIT the api and worker expectations           T7

apps/api/src/config.ts                        EDIT + hrFieldEncryptionKeyVersion (A1)        T7

scripts/
└─ payroll-reconcile.ts                       NEW  the CLI Task 9's verify line names        T9

tests/
├─ invariants/support/hr-reports.ts           NEW  the A7 helper set                     T2, T3
├─ invariants/support/reports.ts              EDIT + the two projection cases (A6)           T4
├─ invariants/probes.ts                       EDIT ⚠️ one PROBES key; one JOB_PROBES key T7, T8
└─ regression/
   ├─ legacy-011.test.ts                         EDIT + the 8D block (no NULL statutory input)  T11
   ├─ legacy-020.test.ts                         EDIT + the 8D block (no rate in a definition)  T11
   ├─ legacy-033.test.ts                         EDIT + the 8D block (report side channels)     T11
   └─ legacy-085.test.ts                         EDIT + the 8D block (payslip in both scripts)  T11

apps/backoffice/src/                          (Task 10 — BLOCKED on OD-24; no file until then)

docs/
├─ adr/0079-payslips-are-attachments-rendered-synchronously.md  NEW  a proposal              T5
├─ adr/0080-hr-key-rotation-procedure.md                        NEW  a proposal              T7
├─ runbooks/hr-key-rotation.md                                  NEW                          T7
├─ runbooks/payroll-parallel-run.md                             NEW                          T9
└─ reports/phase-8-definition-of-done.md                        NEW  spec:110               T12

AGENTS.md                                     EDIT "Current phase" → Phase 8 complete       T12
```

**Three structural notes an implementer needs before Task 0.**

**`packages/db/src/reports/datasets.ts` is edited by exactly two tasks and in exactly two hunks.** Task 2 appends five members (`employee`, `attendance_event`, `payroll_line`, `employee_ytd`, `statutory_schedule`) and Task 8 appends the sixth (`leave_record`). 7A's twenty-six entries and 7C's three keep their order — `DATASET_IDS` publishes that order and **two files pin it**: 7A's `packages/db/test/reports/datasets.test.ts` as a literal array and 7C's `packages/db/test/reports/7c-datasets.test.ts` as a length. §3.7.3 puts both edits in the **same commit** as the registry change, so Task 2 takes them from twenty-nine to thirty-four and Task 8 from thirty-four to thirty-five; 7C did the identical thing to 7A's file when it added three (7c:700–726) and says so in its own comment (7c:456–457). **No 8D task edits `datasets/accounting.ts`, `datasets/ar-ap.ts`, `datasets/inventory.ts` or `datasets/pos.ts`.** A field an 8D definition needs that another slice's dataset does not serve is a raise against that slice, carried in the Self-Review — never a silent edit (7C states the same rule for the same reason).

**`packages/db/src/hr/` already exists** — 8A created it with `keys.ts`, `sensitive.ts`, `employee-sensitive.ts`, `config-error.ts` and `index.ts`. This slice adds files beside them and **never edits the first four**: `sealField`, `openField`, `readSensitive`, `writeSensitive`, `createHrKeyRing` and `SENSITIVE_FIELDS` keep their signatures, because the rotation job's whole correctness argument is that it re-uses the same envelope the writer used.

**`app.employee_ytd` is a posting-service-only table** (§4.12.8, hazard 22, and `posting-only-tables` since 8C). Every read in this slice is a `select`; the string `insert into app.employee_ytd` must not appear in any file this plan creates, and the lint rule enforces it in `packages/db/src/reports/**`, which is outside the allow-list.

---

### Task 0: Contracts amendments A1–A12 and the 8C / 7A / 7C / 2C repository gate

This task writes no product code. It files the twelve amendments above as one PR against the contracts document, and then proves — by executing assertions, not by reading — that the four predecessor surfaces this slice consumes are actually in the repository in the shape §4 and 8C's plan promise. A divergence found here is an 8C-, 7A-, 7C- or 2C-side correction filed in this PR's description, never a silent adaptation in Task 2.

**One import this file may not have, and what it does instead.** §3.1's dependency rule is `db` imports `domain`; **apps import packages, never the reverse**, and `scripts/lint/rules/dependency-rule.ts` runs over every import in `apps/**` and `packages/**` (§3.7.5's `ROOTS = ["apps", "packages", "scripts"]` — `tests/` is outside them, `packages/db/test/**` is not). So `packages/db/test/hr/predecessors.test.ts` may **not** `import("../../../../apps/api/src/print/engines")`, not even dynamically: 7A hit the same wall and fixed it the same way (7a:10335). The one allowance that exists in this direction is 3B's `packages/db/test/**` → **`tests/invariants/support/**`** (amendment A21(c)) — `tests/support/**` is *not* in it, so `REPO_ROOT` is not importable here either and every repository path in this file is built from `__dirname`. 2C's engine surface is therefore asserted over its **source text**, which is exactly what a gate needs: the four names 8D consumes and the two-member `render` options object Task 5 must call.

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`
- Create: `packages/db/test/hr/predecessors.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant` (test), `listApplied`, `MIGRATIONS_DIR`, `lintSchema` (§4.1); `seedTenantV2`, `seedAccount` (1A, §4.17); `payrollFixture`, `PAYROLL_PACK_ROOT` (8B, §4.17.1 — the 3B-registered `packages/db/test/**` → `tests/invariants/support/**` allowance); `DATASET_IDS` (7A); `PERMISSION`, `PERMISSIONS` (§4.2.5); 2C's `apps/api/src/print/engines/index.ts` **as source text only, never as an import**.
- Produces: nothing importable. Its output is the amended contracts document and a test file every later task's failure message can point at.

- [ ] **Step 1: Amend the contracts document**

Apply amendments **A1–A12** exactly as the table above states them, each in its own section:

- **§3.11** gains one row: `| HR_FIELD_ENCRYPTION_KEY_VERSION | api, worker | 8D | the integer key_version the current HR_FIELD_ENCRYPTION_KEY seals under; optional, default 1. Joins containerSecrets(env, entrypoint) for both entrypoints. |`
- **§4.6.1**'s `employee` row gains `; 8D adds contract_ends_on date (0098)` at the end of its Columns cell.
- **§4.16.1**'s `hr.contract_expiry` row gains the note `the permit half is GET …/employees/permit-expiry, gated hr.employee.read_sensitive — a dataset cannot decrypt (A3)`.
- **§4.11.2** gains the paragraph of A4 (a payslip is rendered synchronously in `apps/api`; the annual statement stays on `reporting.render`).
- **§4.2.9**'s `REPLAY_BY_RERUN` paragraph gains one sentence: `POST …/payroll-runs/{documentId}/payslips returns JSON and writes, so it is not a member (8D, A5).`
- **§4.17.1**'s 7B row gains `8D's two projection cases are "employee_ytd" and "statutory_schedule", and its two LEDGER_MEASURE keys are "net_contribution" and "payable_contribution" — both additive, neither replacing a case or a key`, and the table gains one row for `tests/invariants/support/hr-reports.ts` with the nine names of A7 (its seven exports plus `HrReportFixture`'s `schedules` and `draftRunDocumentId` members).
- **§4.16.2** gains, after the 8D line of the `DatasetId` union, the sentence `the payroll_line dataset also serves two signed measures, net_contribution and payable_contribution, so a definition over it can declare a ledger_sum tie-out (8D, A10); summing "amount" ties to nothing.`
- **§4.6.1**'s ⚠️ leave row gains `public_holiday carries §4.5.6 Form B; the other three carry none (A8)` and `the two hr.leave.* permission rows are inserted by 0096, not 0097 (A9)`.
- **§3.6.3** gains one sentence after its first bullet: `The one exception is 8D's two ⚠️ hr.leave.* rows, which 0096 inserts so the whole OD-13 gate is one file and one task (A9).`
- **§4.5.9** gains A11's paragraph (`PAYSLIP_ENGINE`), and **§3.11** gains A12's sentence: `apps/worker/src/hr-keys.ts` holds the worker's `hrKeyRing()` / `setHrKeyRing()` / `hrKeyRingFromEnv()`, on 7A's `objectStore()` terms, and `apps/api/src/index.ts` passes `config.hrFieldEncryptionKeyVersion` where 8A left the literal `1`.
- **§4.18** gains a **`#### 8D — payslips, HR reports, leave register, key rotation (2026-09-08)`** sub-heading **under the existing `### Round 3` heading**, carrying the twelve rows of the table above in order, each with its Source value. **Do not add a second `### Round 3`** — the contracts document already carries one (`### Round 3 — from plans 3A–9B (2026-09-08)`), and its preamble is what assigns these rows to this PR rather than to the architect's table.

- [ ] **Step 2: Write the failing predecessor gate**

`packages/db/test/hr/predecessors.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATASET_IDS } from "../../src/reports/datasets";
import { lintSchema, listApplied } from "../../src";
import { PERMISSION, PERMISSIONS } from "@dulja/contracts/permissions";
import { payrollFixture, type PayrollFixture } from "../../../../tests/invariants/support/payroll";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

/** Every repository path in this file is built from `__dirname` — `tests/support/source`'s `REPO_ROOT`
 *  is outside 3B's `packages/db/test/**` → `tests/invariants/support/**` allowance (§4.17.1). */
const PACKAGES_DB = join(__dirname, "../..");
const REPO = join(PACKAGES_DB, "../..");

/** ⚠️ OD-09 ripple, in ONE place for the whole slice. `pdc` is 7A's fourteenth `DatasetId` member and is
 *  itself OD-09-gated, whose §2.12 default is **not built**. 7A carries the ripple (7a:3198) and 7C repeats
 *  it (7c:728). If the owner answered **no** and 7A shipped twenty-five, this constant is **28**, Task 2's
 *  two pinned counts are **33**, and Task 8's are **34** — four numbers and no other change anywhere. */
const EXPECTED_BASE = 29;

describe("8D's predecessors are in the repository in the shape §4 promises", () => {
  let db: Db;
  let s: Seed;
  let f: PayrollFixture;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "8d-gate");
    f = await payrollFixture(db, s);
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("every migration 8D consumes has been applied, and 0096–0099 have not", async () => {
    const applied = await listApplied(db.migrator);
    // 8A 0080–0086, 8B 0087–0090, 8C 0091–0095, 7A 0074–0076, 2C 0025–0027, 6C 0064–0069.
    for (const n of [25, 26, 27, 64, 67, 74, 75, 76, 80, 81, 83, 84, 87, 88, 89, 91, 92, 93]) {
      expect(applied, `migration ${n} is missing — 8D's phase gate is not met`).toContain(n);
    }
    for (const n of [96, 97, 98, 99]) expect(applied).not.toContain(n);
  });

  it("8C's three tables carry the columns §4.6.1 and §4.12.8 fix", async () => {
    const columns = async (table: string) => {
      const rows = await db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table} order by column_name`;
      return rows.map((r) => r.column_name);
    };
    expect(await columns("employee_ytd")).toEqual([
      "by_component", "by_scheme", "company_id", "created_at", "employee_id",
      "gross", "net", "tax_year", "tenant_id", "updated_at",
    ]);
    // 8C's migration 0091 ships §4.6.1's columns PLUS amendment B11's `currency` and `generated_by`
    // (8c:458–480). Fourteen names, not twelve — a twelve-name expectation would fail against a
    // correctly merged 8C and send the engineer to "fix" a ratified amendment.
    expect(await columns("statutory_schedule")).toEqual([
      "attachment_id", "company_id", "created_at", "currency", "generated_by", "id",
      "period_end", "period_start", "payroll_document_id", "remittance_document_id",
      "scheme_id", "tenant_id", "total_employee", "total_employer",
    ].sort());
    expect(await columns("employee_ytd_opening")).toContain("loaded_by");
  });

  it("7A's registry holds exactly the twenty-nine members 7A and 7C shipped, and none of 8D's six", () => {
    expect(DATASET_IDS).toHaveLength(EXPECTED_BASE);
    for (const id of ["employee", "attendance_event", "payroll_line", "employee_ytd", "statutory_schedule", "leave_record"]) {
      expect(DATASET_IDS as readonly string[]).not.toContain(id);
    }
  });

  it("2C's engine surface is the one Task 5 calls: four names, and render takes { paper, dir }", () => {
    // Source text, NEVER an import: `packages/db/test/**` may not import `apps/**` (§3.1, and the
    // preamble above). What Task 5 depends on is asserted literally, so a 2C rename fails HERE.
    const src = readFileSync(join(REPO, "apps/api/src/print/engines/index.ts"), "utf8");
    for (const name of ["export type PrintEngineCode", "export interface PdfEngine",
                        "export const PDF_ENGINES", "export function engineFor"]) {
      expect(src, `${name} is 2C's and 8D Task 5 consumes it`).toContain(name);
    }
    // The options object has exactly two members. Task 5's renderPayslip must NOT pass `orientation`:
    // 2C's engine has no orientation input, and an excess property on an object literal is a type error.
    // A REGEX, not an exact string: prettier owns the whitespace in 2C's file and an exact match would
    // fail on a reformat that changed nothing. What is pinned is the two member NAMES and their order.
    expect(src).toMatch(/render\(\s*source:\s*string,\s*opts:\s*\{\s*paper:\s*string;\s*dir:\s*"ltr"\s*\|\s*"rtl"\s*\}\s*\)/);
    expect(src).not.toMatch(/opts:\s*\{[^}]*orientation/);   // Task 5 must not pass one; there is nowhere to put it
    expect(src).not.toContain("engineCodeFromAdr");     // there is no such reader; Task 5 uses PAYSLIP_ENGINE
  });

  it("the catalogue does not yet hold 8D's codes, and holds every code 8D gates on", () => {
    const codes = new Set(PERMISSIONS.map((p) => p.code as string));
    for (const c of ["hr.filing.generate", "hr.leave.record", "hr.leave.approve"]) expect(codes).not.toContain(c);
    for (const c of ["hr.employee.read", "hr.employee.read_sensitive", "hr.payroll.read", "hr.compensation.read"]) {
      expect(codes, `${c} is 6C's or 8A's and must be merged before 8D`).toContain(c);
    }
    expect(PERMISSION["hr.payroll.read"]).toBe("hr.payroll.read");
  });

  it("the schema linter reports zero violations before 8D adds a table", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `bun run --cwd packages/db test test/hr/predecessors.test.ts`
Expected: FAIL — `Cannot find module '../../../../tests/invariants/support/payroll'` if 8B is not merged, or the first `expect(applied).toContain(n)` naming the missing migration. **A failure here is the phase gate speaking: stop and merge the predecessor, do not weaken the assertion.**

- [ ] **Step 4: Add the hazard-33 account assertion to the same file**

The six §4.15 codes this slice reads in a `tieOut` or an assertion are all **8B's**. Hazard 33's consuming direction says a slice that consumes a code it did not seed asserts, in its first task in that area, that the account resolves — and never re-seeds it:

```ts
  it("every §4.15 account 8D's definitions name is already seeded by 8B, and 8D seeds none", async () => {
    const codes = ["2400", "2411", "2412", "2413", "2414", "5300"];
    const found = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ code: string; type: string }[]>`
        select code, type::text as type from app.account
         where company_id = ${s.company} and code = any(${codes}::text[]) order by code`);
    expect(found.map((r) => r.code)).toEqual(codes);
    expect(found.find((r) => r.code === "2400")?.type).toBe("liability");
    expect(found.find((r) => r.code === "5300")?.type).toBe("expense");
    // 8B's fixture resolved 2400 to the SAME row this query found — one account, not two spellings.
    const salariesPayable = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = '2400'`);
    expect(f.salariesPayableAccountId).toBe(salariesPayable[0]!.id);
    // The chart file is 8B's and this slice adds no file beside it (§4.15's one-file-per-slice rule).
    // `PACKAGES_DB` and not `REPO_ROOT`: see the preamble's allowance note.
    const dir = readdirSync(join(PACKAGES_DB, "seed/my/chart-of-accounts"));
    expect(dir).toContain("8b-payroll.json");
    expect(dir.filter((n) => n.startsWith("8d"))).toEqual([]);
  });
```

`readdirSync`, `readFileSync` and `join` are already in Step 2's import block, and `PACKAGES_DB` / `REPO` are already declared there — this step adds an `it`, not an import.

- [ ] **Step 5: Run the whole gate green**

Run: `bun run --cwd packages/db test test/hr/predecessors.test.ts`
Expected: PASS — **7 passing** (six from Step 2, one from Step 4).

**Reading the third case's failure, which has three distinct causes and one wrong answer.**

| `DATASET_IDS.length` | What it means | What to do |
|---|---|---|
| **26** | 7C is not merged | Merge 7C. Task 2 would otherwise append onto the wrong base and both pinned arrays would be wrong |
| **28** | 7C **is** merged and **OD-09 = no**, so 7A shipped twenty-five without `pdc` (7c:728) | Set `EXPECTED_BASE = 28` here, and Task 2's two pinned counts to 33 and Task 8's to 34. Nothing else changes |
| **29** | 7C is merged and `pdc` was built | Proceed |
| **34** | Task 2 has already run | You are re-running Task 0; nothing is wrong with the tree |

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md packages/db/test/hr/predecessors.test.ts
git commit -m "docs(contracts): file 8D amendments A1-A12 and add the predecessor gate [8D T0]

A1 HR_FIELD_ENCRYPTION_KEY_VERSION; A2 employee.contract_ends_on; A3 the permit
list is a gated route, not a report column; A4 payslips render synchronously in
apps/api; A5 the payslip POST is not REPLAY_BY_RERUN; A6 two assertTieOut
projection cases; A7 tests/invariants/support/hr-reports.ts; A8 public_holiday
carries Form B; A9 the two hr.leave.* rows are inserted by 0096; A10 the two signed measures
and their LEDGER_MEASURE keys; A11 PAYSLIP_ENGINE; A12 the worker's HR key ring and the
api composition root's currentVersion.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Migration 0097 — `hr.filing.generate`, the catalogue row and the `hr_payroll` grant

§3.6.2 assigns 8D the code **`hr.filing.generate`** (`mutating: true`), and ⚠️ `hr.leave.record` / `hr.leave.approve` **only if OD-13**. This task ships the unconditional one; amendment **A9** puts the two conditional ones inside Task 8's migration so the whole gate is one file. `hr.filing.generate` gates **payslip generation** (Task 5) — a *filing* is a document produced for an employee or an authority from posted figures. It does **not** gate the annual statement: that runs through 7A's `POST …/reports/{code}/runs`, which gates on the definition's own `permission` (`hr.payroll.read`), and adding a second gate to 7A's route is not this slice's to do.

**The gate helper ships in this task, not in Task 5.** `scripts/lint/rules/permission-catalogue.ts` fails the build when a catalogue code has **no** `PERMISSION[…]` / `requirePermission('…')` reference anywhere in `apps/**`, `packages/**/src` — in both directions (§3.6.3) — and §3.1 requires `bun run lint:rules` green after **every** task. So the code and its one reference land together, exactly as 7A's Task 3 shipped `requireReportExport` with `accounting.report.export`.

**Files:**
- Create: `packages/db/migrations/0097_seed_permission_phase8d.sql`, `packages/db/migrations/0097.down.sql`, `apps/api/src/hr/authorise.ts`, `apps/api/test/hr/authorise.test.ts`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`, `packages/db/test/permission-catalogue.test.ts`

**Interfaces:**
- Consumes: `PermissionDef`, `PERMISSIONS`, `PERMISSION`, `SliceId` (§4.2.5); `ROLES`, `RoleSeed` (§3.6.4); `up`, `down`, `listApplied`, `MIGRATIONS_DIR` (§4.1); `startDb` (§4.1).
- Produces:

```ts
// packages/contracts/permissions.ts — one entry appended to PERMISSIONS
{ code: "hr.filing.generate", module: "hr", mutating: true, phase: "8D",
  description: "Generate a payslip, a statutory schedule document or an annual statement from posted payroll figures" }
// `PERMISSION["hr.filing.generate"]` becomes available to every later task and to apps/api.
```

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/permission-catalogue.test.ts` — the file 0B created, whose existing `it` compares `app.permission` with `permissions.ts` in both directions. Add one focused case beside it:

```ts
  it("8D introduces hr.filing.generate, mutating, and no other code before OD-13 is answered", async () => {
    const eightD = PERMISSIONS.filter((p) => p.phase === "8D");
    expect(eightD.map((p) => p.code)).toEqual(["hr.filing.generate"]);
    expect(eightD[0]!.mutating).toBe(true);
    expect(eightD[0]!.module).toBe("hr");
    const [row] = await db.admin<{ module: string; mutating: boolean; description: string }[]>`
      select module, mutating, description from app.permission where code = 'hr.filing.generate'`;
    expect(row).toBeDefined();
    expect(row!.module).toBe("hr");
    expect(row!.mutating).toBe(true);
    expect(row!.description).toBe(eightD[0]!.description);
  });

  it("hr_payroll holds hr.filing.generate and auditor holds nothing mutating", () => {
    const hrPayroll = ROLES.find((r) => r.code === "hr_payroll")!;
    expect(hrPayroll.permissions).toContain("hr.filing.generate");
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    const mutating = new Set(PERMISSIONS.filter((p) => p.mutating).map((p) => p.code as string));
    expect(auditor.permissions.filter((c) => mutating.has(c))).toEqual([]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test test/permission-catalogue.test.ts`
Expected: FAIL — `expected [] to equal [ 'hr.filing.generate' ]`.

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0097_seed_permission_phase8d.sql`:

```sql
-- 0097_seed_permission_phase8d.sql — §3.6.2's 8D row; §3.6.3's per-slice permission seed.
-- app.permission is GLOBAL (no RLS, plan0A:1254), so it is migration data and not seed-pack data (§3.4.8).
-- The two ⚠️ hr.leave.* codes are NOT here: 0096 inserts them with the tables they gate, so the whole
-- OD-13 gate is one file and one task (8D amendment A9). Seeding them here would fail
-- permission-catalogue.test.ts's reverse direction for as long as OD-13 stays unanswered.

-- ── 1. the one unconditional 8D code ───────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('hr.filing.generate', 'hr', true,
   'Generate a payslip, a statutory schedule document or an annual statement from posted payroll figures')
on conflict (code) do update
   set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

`packages/db/migrations/0097.down.sql`:

```sql
-- Deletes exactly the codes 0097 inserted (§3.6.3). role_permission rows referencing them are
-- per-tenant seed data and are removed by re-running `bun run seed --only roles`, not by this file.
delete from app.role_permission where permission_code = 'hr.filing.generate';
delete from app.permission       where code = 'hr.filing.generate';
```

- [ ] **Step 4: Add the catalogue entry and the role grant**

In `packages/contracts/permissions.ts`, append to the `PERMISSIONS` array, after 8C's two rows:

```ts
  { code: "hr.filing.generate", module: "hr", mutating: true, phase: "8D",
    description: "Generate a payslip, a statutory schedule document or an annual statement from posted payroll figures" },
```

In `packages/db/seed/roles.ts`, add `"hr.filing.generate"` to the `hr_payroll` role's `permissions` array. **No other role receives it**: spec:2162 gives the HR/payroll officer the payroll module; `admin`'s array is computed from `PERMISSIONS` and is never edited (§3.6.4); and `auditor` may hold no mutating code (R7, spec:2178). Record the grant in §3.6.4's running sentence in the same PR: `hr.filing.generate → hr_payroll (8D)`.

- [ ] **Step 5: Ship the gate helper the catalogue check needs**

`apps/api/src/hr/authorise.ts`:

```ts
// The ONE reference that satisfies §3.6.3's bidirectional catalogue check for hr.filing.generate.
// 7A's apps/api/src/reports/authorise.ts is the precedent: the code and its middleware land together,
// so `bun run lint:rules` is green at every commit and not only at the end of the slice.
import { PERMISSION } from "@dulja/contracts/permissions";
import { requirePermission } from "../middleware/require-permission";
import type { AppEnv } from "../context";
import type { MiddlewareHandler } from "hono";

/** Company-scoped: a filing is produced for one company's employees, and `path:companyId` is the scope
 *  every route that generates one carries. Task 5's payslip route is its first and only consumer. */
export function requireFilingGenerate(): MiddlewareHandler<AppEnv> {
  return requirePermission(PERMISSION["hr.filing.generate"], { company: "path:companyId" });
}
```

`apps/api/test/hr/authorise.test.ts` — 7A's `apps/api/test/reports/authorise.test.ts` in purpose, but a **route** test rather than a function test, because `requireFilingGenerate()` is middleware and `hr.filing.generate` is `mutating: true`, so `assertRouteGates` admits it on a `POST`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { UuidSchema } from "@dulja/contracts";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { requireFilingGenerate } from "../../src/hr/authorise";
import { problemOf } from "../../../../tests/support/api";
import { startApi, type StartedApi } from "../support/app";

let api: StartedApi;
let s: Seed;
let holder: string;      // holds hr.filing.generate at s.company
let bare: string;        // holds nothing

/** A one-route probe app mounted onto the STARTED app, so the request runs the real middleware chain
 *  (auth → tenant context → withTenant) and `requirePermission` resolves `path:companyId` for real.
 *  Mounting after `createApp` is deliberate: `assertRouteGates` has already run over the shipped routes
 *  and this probe is not one of them. */
beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "filing-gate");
  holder = s.human;
  bare = await uuidv7(api.db.admin);
  await grantCodes(api.db, s, { codes: ["hr.filing.generate"] });
  await api.db.admin`
    insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
    values (${bare}, ${s.tenant}, 'human', ${`stub:bare-${bare}`}, 'Bare')`;
  await api.db.admin`
    insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${bare})
    on conflict do nothing`;

  const probe = new OpenAPIHono<AppEnv>();
  probe.openapi(
    createRoute({
      method: "post",
      path: "/v1/companies/{companyId}/filing-gate-probe",
      tags: ["hr"],
      request: { params: z.object({ companyId: UuidSchema }) },
      middleware: [requireFilingGenerate()],
      responses: { 200: { description: "allowed", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
    }),
    (c) => c.json({ ok: true }, 200),
  );
  api.app.route("/", probe);
  await api.loadPrincipals();          // `bare` was inserted after startApi(); tokenFor needs it loaded
}, 180_000);
afterAll(async () => { await api.stop(); });

describe("requireFilingGenerate — §3.6.3's PERMISSION[…] reference and the gate it evaluates", () => {
  const path = () => `/v1/companies/${s.company}/filing-gate-probe`;

  it("allows a principal holding hr.filing.generate at that company", async () => {
    const res = await api.request({ method: "POST", path: path(), as: holder });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses a principal without it with 403 ERR_RBAC_FORBIDDEN", async () => {
    const res = await api.request({ method: "POST", path: path(), as: bare });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
```

Import `AppEnv` from `../../src/context` at the top of that file. The `apps/api/test/**` → `tests/support/**` crossing `problemOf` needs is the one §4.17.1's closing paragraph already grants `apps/api/test/**`, and every other `apps/api` route test in the repository uses it.

- [ ] **Step 6: Apply and run**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test test/permission-catalogue.test.ts && bun run --cwd apps/api test test/hr/authorise.test.ts`
Expected: PASS. Then `bun run --cwd packages/db db:lint` → `0 violations` (0097 creates no table).

- [ ] **Step 7: Prove the catalogue check is green in BOTH directions**

Run: `bun run lint:rules`
Expected: PASS. This is the step Step 5 exists for: without `requireFilingGenerate`, `permission-catalogue` reports `hr.filing.generate has no reference` and CI is red from this task until Task 5 — which §3.1's "green after every task" forbids.

- [ ] **Step 8: Prove the migration is reversible**

Run: `bun run --cwd packages/db test test/privileges.test.ts`
Expected: PASS — 0B's generalised up → down → up test (§3.4.6) walks 0097 in both directions and its `schemaFingerprint` now includes the `role_table_grants` query, so a down that forgot the `role_permission` delete would surface as a residual row rather than as a silent pass.

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0097_seed_permission_phase8d.sql packages/db/migrations/0097.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        packages/db/test/permission-catalogue.test.ts \
        apps/api/src/hr/authorise.ts apps/api/test/hr/authorise.test.ts
git commit -m "feat(db): seed hr.filing.generate, grant it to hr_payroll, ship its gate [8D T1]

The two conditional hr.leave.* codes stay out of 0097 and are inserted by
0096 with the tables they gate (amendment A9), so the OD-13 gate is one file.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0098 and `datasets/hr.ts` — five of the six HR members close 7A's registry

§4.16.2 gives 8D six `DatasetId` members and states the rule that put two 6C tables in this slice: *"`employee` and `attendance_event` are 6C's tables but their only reports are this slice's, so they are 8D's rows — the rule is **first report that reads it**."* This task ships five; ⚠️ `leave_record` is Task 8's and is appended by the same two hunks so the OD-13 gate stays droppable.

**The mechanism that makes "never SQL text" a fact, restated because a task's implementer sees only their own task.** A `DatasetColumn` carries no column *name*: it carries `ref: (tx: Sql) => SqlFragment`, a closure whose body is a literal tagged template authored in this file. A `ReportDefinition` contributes a `field` string, which is looked up in the dataset's own `columns` array; a `field` matching nothing is `ERR_VALIDATION_FAILED`, and a matching one yields the pre-authored fragment. No identifier, table name, operator or clause originates outside these files, and every value arrives as a bound parameter (test 27, §3.3).

**Every date and timestamp leaves SQL as a string** — 7A's rule, and it binds here: `postgres.js` parses `date` and `timestamptz` into JS `Date` objects, and a `Date` in a rendered report is a locale- and machine-dependent value. Every select list emits `to_char(…)`, with an explicit `at time zone 'UTC'` for timestamps. `numeric` columns come back as strings already, which is what keeps money out of a JS `number` (spec:2041).

**Four shape decisions this file makes, each load-bearing.**

1. **`payroll_line` shows only what a posting produced.** Its `from` clause restricts to `d.status in ('posted','reversed')`. A draft or submitted run's lines are working figures that R3 may return to draft (spec:2174); a report over them would show numbers that never reached the ledger, and `hr.payroll_register`'s `ledger_sum` tie-out could not hold. §2.9's 8B card says the same in one line — "this slice's payslip and YTD figures come from **posted** `payroll_line` rows".
2. **`employee_ytd` is at `(employee, tax_year, scheme_code)` grain**, produced by `left join lateral jsonb_each(coalesce(y.by_scheme, '{}'::jsonb))`. The stored row is one per employee per year with a `by_scheme` bag; a report needs a row per scheme to lay out a statement, and a `jsonb` column cannot be a `DatasetRow` value (`string | number | boolean | null`). `gross` and `net` repeat on every scheme row of one employee, which is why the `employee_ytd` tie-out case (Task 4) compares **distinct** `(employee, tax_year)` pairs against the projection and never sums the column.
3. **No HR dataset joins `app.employee_sensitive`, `app.compensation_line` or `app.employee_statutory_profile`.** Test 32 forbids a side channel through a report; and even if it did not, every sensitive column is ciphertext and would render as bytes. Step 1's last case asserts the prohibition mechanically over the whole `datasets/hr.ts` source text, so a later edit cannot reintroduce it quietly.
4. **`payroll_line` carries two signed measures, `net_contribution` and `payable_contribution`** (amendment **A10**), computed in SQL. A report cannot tie to the ledger by summing `amount` — a run's lines are earnings, deductions and both scheme shares, and their naive sum equals nothing the ledger holds. Task 4's two `ledger_sum` tie-outs read these two columns and 7B's `LEDGER_MEASURE` map gains their keys there. **`net_contribution`'s first arm scores the net-pay leg zero and is not optional**: 8B writes an all-null `payroll_line` beside the net-pay `account` line with `amount = e.net` (8b:4730–4734), so without that arm the row falls to `else pl.amount`, net is counted twice and the register's tie-out fails by exactly a factor of two. The measure re-derives net from the component and scheme lines, which is also what makes it an independent second path rather than a re-read of the posting's own figure.

**Migration 0098 is in this task, not Task 3** (amendment **A2**): `employeeDataset` selects `e.contract_ends_on` and this task's own fixture writes it, so the column has to exist before the first test in this plan that touches an employee row. §3.4.3's one-migration-per-PR rule is satisfied — this task ships exactly one migration.

**Files:**
- Create: `packages/db/migrations/0098_add_employee_contract_end.sql`, `packages/db/migrations/0098.down.sql`, `packages/db/src/reports/datasets/hr.ts`, `packages/db/test/reports/hr-datasets.test.ts`, `tests/invariants/support/hr-reports.ts`
- Modify: `packages/db/src/schema/employee.ts`, `packages/db/src/reports/datasets.ts`, `packages/db/src/reports/index.ts`, **`packages/db/test/reports/datasets.test.ts` (7A's — its registry case pins the ids as a literal array; 7C took it to twenty-nine and this task takes it to thirty-four, in this same commit)**, **`packages/db/test/reports/7c-datasets.test.ts` (7C's — its own `expect(DATASET_IDS).toHaveLength(29)` becomes 34; 7c:456–460 says in terms that "8D's six move the number in 8D's own PR")**

**Interfaces:**
- Consumes: `Sql` from `postgres`; `defineDataset`, `Dataset`, `DatasetColumn`, `DatasetParams`, `DatasetRow`, `MAX_DATASET_ROWS` from `packages/db/src/reports/query.ts` (7A); `DatasetId`, `DATASETS`, `DATASET_IDS`, `datasetFor`, `isDatasetId` from `packages/db/src/reports/datasets.ts` (7A, 7C); `ReportError` (7A); `startDb`, `Db`, `withTenant` (test), `Seed` (§4.1); `seedTenantV2`, `seedAccount`, `seedEmployee`, `seedPayComponent`, `seedStatutoryScheme`, `seedRateTable`, `seedBranch`, `seedPayrollRun` (§4.17); `payrollFixture`, `postPayrollRun`, `PayrollFixture` (8B, §4.17.1); **`generateStatutorySchedule`, `StatutoryScheduleResult` (8C, `packages/db/src/hr/schedule.ts`) and `MemoryObjectStore` (2C, re-exported from `@dulja/db`)** — the schedule rows are written by 8C's service and by nothing else, so the corpus has to call it.
- Produces:

```ts
// packages/db/src/reports/datasets/hr.ts
export const employeeDataset: Dataset;            // id "employee"
export const attendanceEventDataset: Dataset;     // id "attendance_event"
export const payrollLineDataset: Dataset;         // id "payroll_line"     — posted and reversed rows only
export const employeeYtdDataset: Dataset;         // id "employee_ytd"     — one row per (employee, year, scheme)
export const statutoryScheduleDataset: Dataset;   // id "statutory_schedule"
// Task 8 appends: export const leaveRecordDataset: Dataset;   // id "leave_record" ⚠️ OD-13

// packages/db/src/reports/datasets.ts — the union grows by five here and by one in Task 8
export type DatasetId = /* 7A's twenty-six and 7C's three, unchanged */
  | "employee" | "attendance_event" | "payroll_line" | "employee_ytd" | "statutory_schedule";

// tests/invariants/support/hr-reports.ts — amendment A7
export const HR_CATALOGUE: readonly ["hr.employee_list", "hr.contract_expiry", "hr.attendance",
  "hr.payroll_register", "hr.statutory_summary", "hr.payable_reconciliation", "hr.payslip", "hr.annual_statement"];
export type HrReportCode = (typeof HR_CATALOGUE)[number];
export const HR_CATALOGUE_DIR: string;                                   // packages/db/seed/my/reports/8d
export function readHrEnvelope(code: HrReportCode): ReportSeedEnvelope;
export function readHrDefinition(code: HrReportCode): ReportDefinition;
export interface HrReportFixture {
  db: Db; s: Seed; payroll: PayrollFixture;
  /** The posted regular run every money report reads. */
  runDocumentId: string;
  /** A DRAFT run over the same two employees, so "posted figures only" is asserted against something
   *  that exists rather than skipped when the corpus happens to hold no draft. */
  draftRunDocumentId: string;
  /** 8C's schedules for `runDocumentId`, one per scheme the run touched — the rows the
   *  `statutory_schedule` dataset and the `statutory_schedule` tie-out case read. */
  schedules: StatutoryScheduleResult[];
  /** The two employees of `payrollFixture`, by number, plus their branch codes. */
  employees: { id: string; number: string; branchCode: string }[];
  taxYear: number;
  periodStart: string; periodEnd: string; payDate: string;
}
export function hrReportFixture(db: Db, s: Seed): Promise<HrReportFixture>;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/reports/hr-datasets.test.ts` — this file grows by one `describe` in Task 8:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATASETS, DATASET_IDS, datasetFor, isDatasetId } from "../../src/reports/datasets";
import { MAX_DATASET_ROWS, type DatasetParams } from "../../src/reports/query";
import { ReportError } from "../../src/reports/errors";
import { hrReportFixture, type HrReportFixture } from "../../../../tests/invariants/support/hr-reports";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const params = (companyId: string, over: Partial<DatasetParams> = {}): DatasetParams => ({
  companyId, filters: [], sort: [], limit: 500, offset: 0, ...over,
});

describe("the HR datasets — contracts §4.16.2", () => {   // five here; Task 8 appends ⚠️ leave_record
  let db: Db;
  let s: Seed;
  let f: HrReportFixture;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "hr-datasets");
    f = await hrReportFixture(db, s);
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  it("the registry closes at thirty-four members, 8D's five appended after 7C's three", () => {
    expect(DATASET_IDS.slice(-5)).toEqual([
      "employee", "attendance_event", "payroll_line", "employee_ytd", "statutory_schedule",
    ]);
    // 7A's 26 + 7C's 3 + 8D's 5 = 34 (Task 8 makes it 35 with leave_record).
    expect(DATASET_IDS).toHaveLength(34);
    expect(Object.keys(DATASETS)).toEqual([...DATASET_IDS]);
    for (const id of DATASET_IDS) expect(DATASETS[id]!.id, id).toBe(id);
  });

  it("an id outside the union is ERR_REPORT_DATASET_UNKNOWN, not a query", () => {
    expect(isDatasetId("employee_salary")).toBe(false);
    expect(() => datasetFor("employee_salary")).toThrow(ReportError);
    try { datasetFor("employee_salary"); } catch (e) {
      expect((e as ReportError).code).toBe("ERR_REPORT_DATASET_UNKNOWN");
    }
  });

  it("employee returns one row per employee with its branch, dates and employment type", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.employee.run(tx, params(s.company, { sort: [{ field: "employee_number", dir: "asc" }] })));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const first = rows[0]!;
    expect(Object.keys(first)).toEqual(expect.arrayContaining([
      "employee_id", "employee_number", "employee_name_en", "employee_name_ar", "branch_id",
      "branch_code", "position", "employment_type", "hired_on", "terminated_on",
      "contract_ends_on", "active", "has_login",
    ]));
    expect(typeof first.hired_on).toBe("string");         // never a Date (7A's rule)
    expect(first.hired_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.active).toBe(true);
  });

  it("attendance_event carries the employee number and both a timestamp and its date companion", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.attendance_event.run(tx, params(s.company)));
    for (const r of rows) {
      expect(r.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(r.occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["clock_in", "clock_out", "manual_correction"]).toContain(r.kind);
    }
  });

  it("payroll_line shows posted lines only, with the run's period and each line's pinned table version", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.payroll_line.run(tx, params(s.company)));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(["posted", "reversed"]).toContain(r.document_status);
      expect(r.period_start).toBe(f.periodStart);
      expect(String(r.amount)).toMatch(/^-?\d+\.\d{4}$/);
    }
    // A draft run's lines are invisible: R3 may still return the run to draft (spec:2174).
    const draft = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.payroll_line.run(tx, params(s.company, {
        filters: [{ field: "document_status", op: "eq", value: "draft" }] })));
    expect(draft).toEqual([]);
  });

  it("employee_ytd yields one row per scheme with gross and net repeated, and one row when there is no scheme", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.employee_ytd.run(tx, params(s.company, { sort: [{ field: "employee_number", dir: "asc" }] })));
    expect(rows.length).toBeGreaterThan(0);
    const byEmployee = new Map<string, Set<string>>();
    for (const r of rows) {
      expect(r.tax_year).toBe(f.taxYear);
      expect(String(r.gross)).toMatch(/^-?\d+\.\d{4}$/);
      const set = byEmployee.get(String(r.employee_number)) ?? new Set<string>();
      set.add(String(r.gross));                       // repeated, therefore always one distinct value
      byEmployee.set(String(r.employee_number), set);
    }
    for (const [number, grosses] of byEmployee) expect(grosses.size, number).toBe(1);
  });

  it("statutory_schedule carries each scheme's two totals and whether a remittance settled it", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.statutory_schedule.run(tx, params(s.company)));
    // NOT `for (const r of rows)` over a possibly empty array: the corpus generated one schedule per
    // scheme the run touched (Step 4), and a zero-row pass here would be a dataset that never ran.
    expect(rows).toHaveLength(f.schedules.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => String(r.scheme_code)).sort())
      .toEqual(f.schedules.map((x) => x.schemeCode).sort());
    for (const r of rows) {
      expect(String(r.total_employee)).toMatch(/^-?\d+\.\d{4}$/);
      expect(String(r.total_employer)).toMatch(/^-?\d+\.\d{4}$/);
      expect(typeof r.remitted).toBe("boolean");
      expect(r.scheme_code).toMatch(/^[A-Z][A-Z0-9_]{1,15}$/);
    }
  });

  it("an undeclared filter field is refused before any SQL is built", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.employee.run(tx, params(s.company, {
        filters: [{ field: "national_id", op: "eq", value: "x" }] })))).rejects.toThrow(ReportError);
  });

  it("no HR dataset names a sensitive or compensation table anywhere in its source", () => {
    const source = readFileSync(join(__dirname, "../../src/reports/datasets/hr.ts"), "utf8");
    for (const forbidden of ["employee_sensitive", "compensation_line", "employee_statutory_profile"]) {
      expect(source, `${forbidden} must never reach a dataset — test 32`).not.toContain(forbidden);
    }
  });

  it("every dataset clamps to MAX_DATASET_ROWS", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      DATASETS.employee.run(tx, params(s.company, { limit: MAX_DATASET_ROWS + 1_000 })));
    expect(rows.length).toBeLessThanOrEqual(MAX_DATASET_ROWS);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test test/reports/hr-datasets.test.ts`
Expected: FAIL — `Cannot find module '../../../../tests/invariants/support/hr-reports'`.

- [ ] **Step 3: Write migration 0098 and the Drizzle mirror column (amendment A2)**

`packages/db/migrations/0098_add_employee_contract_end.sql`:

```sql
-- 0098_add_employee_contract_end.sql — 8D amendment A2. spec:2091 requires a "contract and permit expiry
-- list"; §4.6.2's minimal employee and 8A's 0080 extension carry hired_on and terminated_on but no
-- contract end date, so hr.contract_expiry (Task 3) would have had nothing to report.
--
-- This is the EXPAND half of §3.4.7 and is complete in itself: one nullable column on a live table, no
-- backfill, no default, no rewrite. There is no contract half — nothing is dropped.
--
-- It is NOT an employee_sensitive field. An employment end date is an operational fact of the same class
-- as hired_on and terminated_on, both of which are plain columns; encrypting it would make the report
-- impossible without making anything more private. The PERMIT expiry stays in employee_sensitive
-- (§4.12.5) and reaches its reader through GET …/employees/permit-expiry (Task 3, amendment A3).

alter table app.employee add column contract_ends_on date;

comment on column app.employee.contract_ends_on is
  'End of a fixed-term engagement (spec:2091). NULL for open-ended employment. Not sensitive: see 8D amendment A2.';
```

`packages/db/migrations/0098.down.sql`:

```sql
-- §3.4.5: a later migration that adds a column to an earlier table drops ONLY that column, never the table.
alter table app.employee drop column if exists contract_ends_on;
```

In `packages/db/src/schema/employee.ts` add the mirror column beside `terminatedOn` — reads only, ADR-0002:

```ts
  contractEndsOn: date("contract_ends_on"),
```

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db db:lint`
Expected: `0 violations` — 0098 adds a column and no table, so no linter set changes (§3.5.3, and hazard 13: `lint-schema.ts` is not edited by this slice).

- [ ] **Step 4: Write `tests/invariants/support/hr-reports.ts`**

```ts
// tests/invariants/support/hr-reports.ts — 8D, registered by amendment A7 against §4.17.1.
// The ONE place an 8D report definition is read off disk and the ONE payroll corpus its reports run over.
// Six test files import it, which is why it is shared rather than file-local — the same reasoning 7B's
// tests/invariants/support/reports.ts carries.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportDefinition } from "@dulja/domain";
import type { ReportSeedEnvelope } from "@dulja/db/seed";
import { generateStatutorySchedule, MemoryObjectStore, type StatutoryScheduleResult } from "@dulja/db";
import { seedBranch, seedEmployee, seedPayrollRun, type Db, type Seed } from "@dulja/db/test";
import { withTenant } from "@dulja/db/test";
import { REPO_ROOT } from "../../support/source";
import { payrollFixture, postPayrollRun, type PayrollFixture } from "./payroll";

/** §4.16.1's eight 8D codes, in register order. A ninth is an amendment, not an edit here. */
export const HR_CATALOGUE = [
  "hr.employee_list", "hr.contract_expiry", "hr.attendance",
  "hr.payroll_register", "hr.statutory_summary", "hr.payable_reconciliation",
  "hr.payslip", "hr.annual_statement",
] as const;
export type HrReportCode = (typeof HR_CATALOGUE)[number];

export const HR_CATALOGUE_DIR = join(REPO_ROOT, "packages/db/seed/my/reports/8d");

/** The envelope on disk: `{ definitionVersion, definition }` (§4.16.1, 7A Task 14). */
export function readHrEnvelope(code: HrReportCode): ReportSeedEnvelope {
  return JSON.parse(readFileSync(join(HR_CATALOGUE_DIR, `${code}.json`), "utf8")) as ReportSeedEnvelope;
}
export function readHrDefinition(code: HrReportCode): ReportDefinition {
  return readHrEnvelope(code).definition as ReportDefinition;
}

export interface HrReportFixture {
  db: Db; s: Seed; payroll: PayrollFixture;
  runDocumentId: string;
  draftRunDocumentId: string;
  schedules: StatutoryScheduleResult[];
  employees: { id: string; number: string; branchCode: string }[];
  taxYear: number;
  periodStart: string; periodEnd: string; payDate: string;
}

const PERIOD_START = "2026-01-01";
const PERIOD_END = "2026-01-31";
const PAY_DATE = "2026-01-28";
const DRAFT_START = "2026-02-01";
const DRAFT_END = "2026-02-28";
const REQUEST_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The corpus every 8D report runs over: 8B's payroll fixture (two employees in two branches, one scheme
 * on the SYNTH table, two components, the eleven §4.15 accounts and the PAYROLL type), one POSTED regular
 * run in the January period Plan 0A's `seedTenant` leaves open, 8C's statutory schedules for that run, a
 * February DRAFT run, four attendance events, and a third employee who is on a fixed-term contract so
 * `hr.contract_expiry` has a row to find.
 *
 * It seeds from 8B's fixture rather than restating it, so a report and the payroll it reports on can never
 * disagree — the same reason `postJournal` posts through the real `postDocument` (§4.17.1).
 */
export async function hrReportFixture(db: Db, s: Seed): Promise<HrReportFixture> {
  const payroll = await payrollFixture(db, s);
  const runDocumentId = await postPayrollRun(db, s, payroll, {
    periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
    effectiveDate: PERIOD_END, kind: "regular",
  });

  // 8C's schedules. NOTHING else writes app.statutory_schedule — not `postPayrollRun`, not `postDocument`
  // (8c:3051–3053) — so without this call the `statutory_schedule` dataset iterates zero rows and its
  // dataset case, the `hr.statutory_summary` tie-out and Task 4's projection arm all pass vacuously or
  // throw "has no row in this window". The store is in-memory because the CSV attachment is 8C's concern
  // and no 8D assertion reads its bytes.
  const scheduleStore = new MemoryObjectStore();
  const schedules = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    generateStatutorySchedule(
      tx, { tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID }, scheduleStore,
      { companyId: s.company, payrollDocumentId: runDocumentId },
    ));

  // A DRAFT run over the same two employees. `seedPayrollRun` deliberately does not calculate or post
  // (8b:675–681), which is exactly what is wanted: lines exist, the document stays `draft`, and every
  // "posted figures only" assertion in this slice has a real negative to run against.
  //
  // `effectiveDate` is PINNED to the JANUARY period end and is not left to default. `seedPayrollRun`
  // defaults it to `periodEnd` (8b:699) while hard-coding `fiscal_period_id = s.period`, which is Plan
  // 0A's open JANUARY period — so a February default would put a February effective date on a January
  // period's document. Nothing fails today (the draft never posts and no check ties the two at draft),
  // but Task 5's route test pins it for exactly this reason and the two sites must not disagree about
  // a rule this plan states. The run's own period stays February; only the document date is January.
  const draftRunDocumentId = await seedPayrollRun(db, s, {
    periodStart: DRAFT_START, periodEnd: DRAFT_END, payDate: DRAFT_END,
    effectiveDate: PERIOD_END,
    employeeIds: [payroll.employeeAId, payroll.employeeBId], kind: "regular",
  });

  const contractorBranch = await seedBranch(db, s, { code: "BR-C", nameEn: "Contract branch" });
  const contractorId = await seedEmployee(db, s, { employeeNumber: "E-1099", homeBranchId: contractorBranch });

  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    // The contractor's fixed-term dates: `contract_ends_on` is 8D's own column (amendment A2, migration 0098).
    await tx`update app.employee
                set employment_type = 'contract', position = 'Storekeeper', contract_ends_on = '2026-03-31'
              where id = ${contractorId}`;
    // Four attendance events for employee A — 6C's table, read here for the first time (§4.16.2's rule).
    for (const [kind, at] of [
      ["clock_in", "2026-01-05T01:02:03Z"], ["clock_out", "2026-01-05T10:04:05Z"],
      ["clock_in", "2026-01-06T01:01:01Z"], ["manual_correction", "2026-01-06T11:00:00Z"],
    ] as const) {
      await tx`insert into app.attendance_event
                 (tenant_id, company_id, employee_id, branch_id, kind, occurred_at, note)
               values (${s.tenant}, ${s.company}, ${payroll.employeeAId}, ${s.hq}, ${kind}, ${at}::timestamptz,
                       ${kind === "manual_correction" ? "corrected by the branch manager" : null})`;
    }
  });

  const employees = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    tx<{ id: string; number: string; branchCode: string }[]>`
      select e.id, e.employee_number as "number", bv.code as "branchCode"
        from app.employee e join app.dimension_value bv on bv.id = e.home_branch_id
       where e.company_id = ${s.company} order by e.employee_number`);

  return {
    db, s, payroll, runDocumentId, draftRunDocumentId, schedules, employees,
    taxYear: Number(PERIOD_END.slice(0, 4)),
    periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
  };
}
```

**Why the schedule generation lives here and not in each test file.** Six files consume this corpus, and a schedule generated in one of them would leave the other five iterating an empty table — which is the shape of a tie-out that reads as coverage and proves nothing. `generateStatutorySchedule` is idempotent on `(scheme, period, run)` (8c:3121–3130), so a caller that runs the fixture twice against one database gets one row per scheme either way. A **null** employer registration does not block it: 8C's own OD-23 case generates a complete schedule with `employerRegistration: null` (8c:5313–5330), so this fixture seeds no `company_hr_setting` row and needs none.

- [ ] **Step 5: Write `packages/db/src/reports/datasets/hr.ts`**

```ts
// The six Phase 8 datasets (§4.16.2). 7A could not ship them: app.employee and app.attendance_event
// arrive with 6C's migrations 0064 and 0067, app.payroll_line with 8B's 0087, app.employee_ytd and
// app.statutory_schedule with 8C's 0091–0092 — all past the ≤ 0058 bound its registry was cut at.
// §4.16.2's rule puts the two 6C tables here anyway: the FIRST report that reads a table owns its row.
//
// Nothing in this file names app.employee_sensitive, app.compensation_line or
// app.employee_statutory_profile. A report is a side channel test 32 exists to close, and every
// sensitive column is ciphertext that a dataset could not render even if the gate let it through.
import type { Sql } from "postgres";
import { defineDataset, type Dataset, type DatasetColumn } from "../query";

// ── employee ────────────────────────────────────────────────────────────────────
const EMPLOYEE_COLUMNS: readonly DatasetColumn[] = [
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`e.id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "employee_name_ar", kind: "text", ref: (tx) => tx`p.name_ar` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`e.home_branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "branch_name_en", kind: "text", ref: (tx) => tx`bv.name_en` },
  { field: "position", kind: "text", ref: (tx) => tx`e.position` },
  { field: "employment_type", kind: "text", ref: (tx) => tx`e.employment_type` },
  { field: "hired_on", kind: "date", ref: (tx) => tx`e.hired_on` },
  { field: "terminated_on", kind: "date", ref: (tx) => tx`e.terminated_on` },
  // 8D's own column, migration 0098 (amendment A2). The PERMIT half of spec:2091's "contract and permit
  // expiry" is NOT here: work_permit_expiry is ciphertext in employee_sensitive, so it is served by
  // GET …/employees/permit-expiry under hr.employee.read_sensitive (amendment A3).
  { field: "contract_ends_on", kind: "date", ref: (tx) => tx`e.contract_ends_on` },
  { field: "active", kind: "boolean", ref: (tx) => tx`(e.terminated_on is null and e.archived_at is null)` },
  { field: "has_login", kind: "boolean", ref: (tx) => tx`(e.principal_id is not null)` },
];

export const employeeDataset: Dataset = defineDataset({
  id: "employee",
  columns: EMPLOYEE_COLUMNS,
  company: (tx, companyId) => tx`e.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.employee e
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id`,
  select: (tx) => tx`e.id as employee_id, e.employee_number as employee_number,
         p.name_en as employee_name_en, p.name_ar as employee_name_ar,
         e.home_branch_id as branch_id, bv.code as branch_code, bv.name_en as branch_name_en,
         e.position as position, e.employment_type as employment_type,
         to_char(e.hired_on, 'YYYY-MM-DD') as hired_on,
         to_char(e.terminated_on, 'YYYY-MM-DD') as terminated_on,
         to_char(e.contract_ends_on, 'YYYY-MM-DD') as contract_ends_on,
         (e.terminated_on is null and e.archived_at is null) as active,
         (e.principal_id is not null) as has_login`,
  defaultOrder: (tx) => tx`e.employee_number asc, e.id asc`,
});

// ── attendance_event ────────────────────────────────────────────────────────────
// spec:2089: readable by HR as a report, NEVER an automatic pay input. Nothing in packages/domain/payroll
// reads this dataset, and the hr.attendance definition's tieOut.kind is "none" for the same reason.
const ATTENDANCE_COLUMNS: readonly DatasetColumn[] = [
  { field: "attendance_event_id", kind: "uuid", ref: (tx) => tx`ae.id` },
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`ae.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`ae.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "kind", kind: "text", ref: (tx) => tx`ae.kind` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`ae.occurred_at` },
  // The DATE companion. §4.11.1 has no `timestamp` parameter kind, so every date-range filter over an
  // attendance report names this field and never `occurred_at` — 7C's `opened_on` for the same reason.
  { field: "occurred_on", kind: "date", ref: (tx) => tx`(ae.occurred_at at time zone 'UTC')::date` },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`ae.terminal_id` },
  { field: "corrects_event_id", kind: "uuid", ref: (tx) => tx`ae.corrects_event_id` },
  { field: "note", kind: "text", ref: (tx) => tx`ae.note` },
];

export const attendanceEventDataset: Dataset = defineDataset({
  id: "attendance_event",
  columns: ATTENDANCE_COLUMNS,
  company: (tx, companyId) => tx`ae.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.attendance_event ae
        join app.employee        e  on e.id  = ae.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = ae.branch_id`,
  select: (tx) => tx`ae.id as attendance_event_id, ae.employee_id as employee_id,
         e.employee_number as employee_number, p.name_en as employee_name_en,
         ae.branch_id as branch_id, bv.code as branch_code, ae.kind as kind,
         to_char(ae.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
         to_char((ae.occurred_at at time zone 'UTC')::date, 'YYYY-MM-DD') as occurred_on,
         ae.terminal_id as terminal_id, ae.corrects_event_id as corrects_event_id, ae.note as note`,
  defaultOrder: (tx) => tx`ae.occurred_at desc, ae.id desc`,
});

// ── payroll_line ────────────────────────────────────────────────────────────────
const PAYROLL_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "payroll_line_id", kind: "uuid", ref: (tx) => tx`pl.document_line_id` },
  { field: "payroll_document_id", kind: "uuid", ref: (tx) => tx`d.id` },
  { field: "document_number", kind: "text", ref: (tx) => tx`d.number::text` },
  { field: "document_status", kind: "text", ref: (tx) => tx`d.status::text` },
  { field: "run_kind", kind: "text", ref: (tx) => tx`pr.kind` },
  { field: "period_start", kind: "date", ref: (tx) => tx`pr.period_start` },
  { field: "period_end", kind: "date", ref: (tx) => tx`pr.period_end` },
  { field: "pay_date", kind: "date", ref: (tx) => tx`pr.pay_date` },
  { field: "tax_year", kind: "integer", ref: (tx) => tx`extract(year from pr.period_end)::int` },
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`pl.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`e.home_branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "component_id", kind: "uuid", ref: (tx) => tx`pl.component_id` },
  { field: "component_code", kind: "text", ref: (tx) => tx`pc.code` },
  { field: "component_kind", kind: "text", ref: (tx) => tx`pc.kind` },
  { field: "scheme_id", kind: "uuid", ref: (tx) => tx`pl.scheme_id` },
  { field: "scheme_code", kind: "text", ref: (tx) => tx`sc.code` },
  { field: "share", kind: "text", ref: (tx) => tx`pl.share` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`pl.quantity` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`pl.amount` },
  { field: "rate_table_version", kind: "integer", ref: (tx) => tx`pl.rate_table_version` },
  { field: "override_reason", kind: "text", ref: (tx) => tx`pl.override_reason` },
  // ── the two SIGNED measures (amendment A10) ─────────────────────────────────
  // A report cannot tie to the ledger by summing `amount`: a run's lines are earnings, deductions and
  // BOTH scheme shares, and their naive sum equals nothing the ledger holds. Each measure below is the
  // signed contribution of a line to ONE §4.15 account, computed in SQL, so `assertTieOut`'s ledger_sum
  // branch compares two genuinely independent aggregations of the same posting.
  //
  //   net_contribution     → the credit to 2400 salaries payable: earning + , employee-borne − ,
  //                          employer share 0 (it is the company's cost, never the employee's net),
  //                          and the NET-PAY LEG ITSELF 0 (first arm — see below).
  //   payable_contribution → the credit to the scheme's own 241n payable: BOTH shares + , non-scheme 0.
  //
  // THE FIRST ARM IS THE ONE AN IMPLEMENTER WILL DROP, AND DROPPING IT DOUBLES THE TOTAL.
  // 8B writes a `payroll_line` row for the net-pay `account` leg too, with `component_id`, `scheme_id`
  // and `share` ALL NULL and `amount = e.net` (8b:4730–4734; the third arm of `payroll_line_shape_check`,
  // 8b:510–513). For that row `pc.kind` is NULL, so `pc.kind = 'deduction'` is NULL — not true — and
  // without an explicit arm the row falls through to `else pl.amount` and contributes +net. The measure
  // would then sum to (Σearnings − Σdeductions − Σemployee shares) + Σnet = 2 × Σnet, and
  // `hr.payroll_register`'s ledger_sum tie-out against the 2400 credit (= Σnet exactly, policy rules
  // 6/7, 8b:1545) would fail by a factor of two.
  //
  // The measure therefore BUILDS net from the component and scheme lines and treats the net-pay leg as
  // zero, rather than the reverse. That is what keeps the two sides of the tie-out independent: the
  // report side re-derives net from its parts, the ledger side reads what the posting service wrote.
  // Taking the net-pay leg as the sole contributor would compare the posting against itself.
  // Nothing else lands in the first arm: an advance recovery is a `deduction` pay_component and reaches
  // the deduction arm (8c:6084–6095), and the dataset's `from` admits only documents that have a
  // `payroll_run` row, so 8C's EMPLOYEE_ADVANCE and PAYROLL_PAYMENT lines are outside it entirely.
  { field: "net_contribution", kind: "numeric", ref: (tx) => tx`
      (case when pl.component_id is null and pl.scheme_id is null   then 0
            when pl.scheme_id is not null and pl.share = 'employer' then 0
            when pl.scheme_id is not null and pl.share = 'employee' then -pl.amount
            when pc.kind = 'deduction'                              then -pl.amount
            else pl.amount end)::numeric(19,4)` },
  { field: "payable_contribution", kind: "numeric", ref: (tx) => tx`
      (case when pl.scheme_id is not null then pl.amount else 0 end)::numeric(19,4)` },
];

export const payrollLineDataset: Dataset = defineDataset({
  id: "payroll_line",
  columns: PAYROLL_LINE_COLUMNS,
  company: (tx, companyId) => tx`pl.company_id = ${companyId}::uuid`,
  // POSTED and REVERSED only. A draft or submitted run's lines are working figures R3 may return to
  // draft (spec:2174); a report over them would show numbers that never reached the ledger and
  // hr.payroll_register's ledger_sum tie-out could not hold.
  from: (tx) => tx`app.payroll_line pl
        join app.document_line   dl on dl.id = pl.document_line_id
        join app.document        d  on d.id  = dl.document_id and d.status in ('posted', 'reversed')
        join app.payroll_run     pr on pr.document_id = d.id
        join app.employee        e  on e.id  = pl.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id
        left join app.pay_component     pc on pc.id = pl.component_id
        left join app.statutory_scheme  sc on sc.id = pl.scheme_id`,
  select: (tx) => tx`pl.document_line_id as payroll_line_id, d.id as payroll_document_id,
         d.number::text as document_number, d.status::text as document_status, pr.kind as run_kind,
         to_char(pr.period_start, 'YYYY-MM-DD') as period_start,
         to_char(pr.period_end, 'YYYY-MM-DD') as period_end,
         to_char(pr.pay_date, 'YYYY-MM-DD') as pay_date,
         extract(year from pr.period_end)::int as tax_year,
         pl.employee_id as employee_id, e.employee_number as employee_number,
         p.name_en as employee_name_en, e.home_branch_id as branch_id, bv.code as branch_code,
         pl.component_id as component_id, pc.code as component_code, pc.kind as component_kind,
         pl.scheme_id as scheme_id, sc.code as scheme_code, pl.share as share,
         pl.quantity as quantity, pl.amount as amount,
         pl.rate_table_version as rate_table_version, pl.override_reason as override_reason,
         (case when pl.component_id is null and pl.scheme_id is null   then 0
               when pl.scheme_id is not null and pl.share = 'employer' then 0
               when pl.scheme_id is not null and pl.share = 'employee' then -pl.amount
               when pc.kind = 'deduction'                              then -pl.amount
               else pl.amount end)::numeric(19,4)                   as net_contribution,
         (case when pl.scheme_id is not null then pl.amount else 0 end)::numeric(19,4)
                                                                     as payable_contribution`,
  defaultOrder: (tx) => tx`pr.period_end desc, e.employee_number asc, pl.document_line_id asc`,
});

// ── employee_ytd ────────────────────────────────────────────────────────────────
// Grain: (employee, tax_year, scheme_code). app.employee_ytd stores ONE row per employee per year with a
// by_scheme jsonb bag; a DatasetRow value is string | number | boolean | null, so the bag is unnested.
// `gross` and `net` REPEAT across an employee's scheme rows — the employee_ytd tie-out case (Task 4)
// therefore compares DISTINCT (employee, tax_year) pairs and never sums the column.
// This table is written only by the posting service (§4.12.8, hazard 22); this file only reads it.
const EMPLOYEE_YTD_COLUMNS: readonly DatasetColumn[] = [
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`y.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`e.home_branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "tax_year", kind: "integer", ref: (tx) => tx`y.tax_year::int` },
  { field: "gross", kind: "numeric", ref: (tx) => tx`y.gross` },
  { field: "net", kind: "numeric", ref: (tx) => tx`y.net` },
  { field: "scheme_code", kind: "text", ref: (tx) => tx`sh.key` },
  { field: "scheme_employee", kind: "numeric", ref: (tx) => tx`coalesce((sh.value ->> 'employee')::numeric(19,4), 0)` },
  { field: "scheme_employer", kind: "numeric", ref: (tx) => tx`coalesce((sh.value ->> 'employer')::numeric(19,4), 0)` },
];

export const employeeYtdDataset: Dataset = defineDataset({
  id: "employee_ytd",
  columns: EMPLOYEE_YTD_COLUMNS,
  company: (tx, companyId) => tx`y.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.employee_ytd y
        join app.employee        e  on e.id  = y.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id
        left join lateral jsonb_each(coalesce(y.by_scheme, '{}'::jsonb)) sh on true`,
  select: (tx) => tx`y.employee_id as employee_id, e.employee_number as employee_number,
         p.name_en as employee_name_en, e.home_branch_id as branch_id, bv.code as branch_code,
         y.tax_year::int as tax_year, y.gross as gross, y.net as net,
         sh.key as scheme_code,
         coalesce((sh.value ->> 'employee')::numeric(19,4), 0) as scheme_employee,
         coalesce((sh.value ->> 'employer')::numeric(19,4), 0) as scheme_employer`,
  defaultOrder: (tx) => tx`y.tax_year desc, e.employee_number asc, sh.key asc nulls first`,
});

// ── statutory_schedule ──────────────────────────────────────────────────────────
const STATUTORY_SCHEDULE_COLUMNS: readonly DatasetColumn[] = [
  { field: "statutory_schedule_id", kind: "uuid", ref: (tx) => tx`ss.id` },
  { field: "scheme_id", kind: "uuid", ref: (tx) => tx`ss.scheme_id` },
  { field: "scheme_code", kind: "text", ref: (tx) => tx`sc.code` },
  { field: "scheme_name_en", kind: "text", ref: (tx) => tx`sc.name_en` },
  { field: "period_start", kind: "date", ref: (tx) => tx`ss.period_start` },
  { field: "period_end", kind: "date", ref: (tx) => tx`ss.period_end` },
  { field: "payroll_document_id", kind: "uuid", ref: (tx) => tx`ss.payroll_document_id` },
  { field: "payroll_number", kind: "text", ref: (tx) => tx`pd.number::text` },
  { field: "total_employee", kind: "numeric", ref: (tx) => tx`ss.total_employee` },
  { field: "total_employer", kind: "numeric", ref: (tx) => tx`ss.total_employer` },
  { field: "total", kind: "numeric", ref: (tx) => tx`(ss.total_employee + ss.total_employer)` },
  { field: "payable_account_code", kind: "text", ref: (tx) => tx`pa.code` },
  { field: "attachment_id", kind: "uuid", ref: (tx) => tx`ss.attachment_id` },
  { field: "remittance_document_id", kind: "uuid", ref: (tx) => tx`ss.remittance_document_id` },
  { field: "remittance_number", kind: "text", ref: (tx) => tx`rd.number::text` },
  { field: "remitted", kind: "boolean", ref: (tx) => tx`(ss.remittance_document_id is not null)` },
];

export const statutoryScheduleDataset: Dataset = defineDataset({
  id: "statutory_schedule",
  columns: STATUTORY_SCHEDULE_COLUMNS,
  company: (tx, companyId) => tx`ss.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.statutory_schedule ss
        join app.statutory_scheme sc on sc.id = ss.scheme_id
        join app.document         pd on pd.id = ss.payroll_document_id
        left join app.account     pa on pa.id = sc.payable_account_id
        left join app.document    rd on rd.id = ss.remittance_document_id`,
  select: (tx) => tx`ss.id as statutory_schedule_id, ss.scheme_id as scheme_id,
         sc.code as scheme_code, sc.name_en as scheme_name_en,
         to_char(ss.period_start, 'YYYY-MM-DD') as period_start,
         to_char(ss.period_end, 'YYYY-MM-DD') as period_end,
         ss.payroll_document_id as payroll_document_id, pd.number::text as payroll_number,
         ss.total_employee as total_employee, ss.total_employer as total_employer,
         (ss.total_employee + ss.total_employer) as total, pa.code as payable_account_code,
         ss.attachment_id as attachment_id, ss.remittance_document_id as remittance_document_id,
         rd.number::text as remittance_number, (ss.remittance_document_id is not null) as remitted`,
  defaultOrder: (tx) => tx`ss.period_end desc, sc.code asc, ss.id asc`,
});
```

**There is no `.unsafe(` call anywhere in this file, and there must not be.** §3.3 gives `sql.unsafe` exactly three homes — the migration runner, the pg-boss enqueue adapter and the importer's Firebird reader — and a dataset is none of them (hazard 21). Every timestamp is formatted by a `to_char(… at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` expression written out inline in each `select`, twice rather than once through a string helper: a helper would have to be interpolated, and a two-line duplication is cheaper than an exception nobody has to spend.

- [ ] **Step 6: Extend the registry**

In `packages/db/src/reports/datasets.ts`, add the import and extend the union and the object — two hunks, nothing else moves:

```ts
import {
  attendanceEventDataset, employeeDataset, employeeYtdDataset,
  payrollLineDataset, statutoryScheduleDataset,
} from "./datasets/hr";

export type DatasetId =
  // …7A's twenty-six and 7C's three, unchanged…
  // 8D — Phase 8, plus the two 6C tables whose FIRST report is 8D's (§4.16.2)
  | "employee" | "attendance_event" | "payroll_line" | "employee_ytd" | "statutory_schedule";
  // Task 8 appends `| "leave_record"` ⚠️ OD-13.

export const DATASETS: Readonly<Record<DatasetId, Dataset>> = {
  // …7A's twenty-six and 7C's three, in their existing order…
  employee: employeeDataset,
  attendance_event: attendanceEventDataset,
  payroll_line: payrollLineDataset,
  employee_ytd: employeeYtdDataset,
  statutory_schedule: statutoryScheduleDataset,
};
```

And in `packages/db/src/reports/index.ts` add `export * from "./datasets/hr";` beside 7C's `./datasets/pos` line.

- [ ] **Step 6b: Move the two PINNED counts in the same commit — §3.7.3's rule, and the whole reason this step exists**

**Two files outside this slice pin the registry, and appending five members turns both red the moment `datasets.ts` is saved.** §3.7.3's rule is that *the slice which changes a shared registry updates the pin in the same commit* — 7C did exactly this to 7A's file when it added three (7c:700–726), and 7C's own comment says in terms that "8D's six move the number in 8D's own PR" (7c:456–457). Step 8 runs `test test/reports`, which selects **both** of these files; without this step Step 9 commits a red tree, which §3.1's "green after every task" forbids.

**(a) `packages/db/test/reports/datasets.test.ts` — 7A's file, whose registry case pins the ids as a literal array.** Replace the case's title and its array, appending 8D's five at the end so 7A's twenty-six and 7C's three keep their order:

```ts
  it("holds exactly the thirty-four members (7A's twenty-six + 7C's three + 8D's five), in registry order", () => {
    expect([...DATASET_IDS]).toEqual([
      // …7A's twenty-six, verbatim and in their existing order, then 7C's three:
      "shift", "till_event", "needs_attention",
      // …and 8D's five, appended:
      "employee", "attendance_event", "payroll_line", "employee_ytd", "statutory_schedule",
    ]);
  });
```

**Nothing else in that file changes** — its other cases iterate `DATASET_IDS` and are order- and length-agnostic, which is what let 7C leave them alone too.

**(b) `packages/db/test/reports/7c-datasets.test.ts` — 7C's file.** One number: `expect(DATASET_IDS).toHaveLength(29)` becomes `expect(DATASET_IDS).toHaveLength(34)`. The `it` title says "closes at twenty-nine"; change it to "…and 8D's five make thirty-four". The three `shift` / `till_event` / `needs_attention` membership assertions above it are unchanged.

⚠️ **OD-09 again**: if Task 0's `EXPECTED_BASE` had to become 28, both numbers here are **33** and `datasets.test.ts`'s literal array drops `"pdc"`. That is the whole ripple; Task 0's table is the one place it is decided.

⚠️ **A third pin may or may not exist.** 7B's Task 14 has a case (7b:5288–5296) asserting the `DatasetId` union holds 25–26 members and none of 7C's three. **That case is already red the moment 7C merges** — it is a 7C-side omission, not 8D's — so if `bun run test --filter @dulja/tests` reports it, file the correction in this PR's description and let 7C fix it. Do **not** widen it here: editing another slice's assertion to accommodate your own is how a pin stops catching anything.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test test/reports/hr-datasets.test.ts`
Expected: PASS — **10 passing**. If the `employee` case reports `column "contract_ends_on" of relation "employee" does not exist`, **Step 3 was skipped** — apply 0098 and re-run; the fixture's `update … set contract_ends_on` is what surfaces it. If the `statutory_schedule` case reports `expected [] to have length 1`, **Step 4's `generateStatutorySchedule` call was skipped** — nothing else in the repository writes that table.

- [ ] **Step 8: Run the whole reports suite and the lints**

Run: `bun run --cwd packages/db test test/reports && bun run lint:rules`
Expected: PASS across **all** of `test/reports` — `hr-datasets.test.ts`, 7A's `datasets.test.ts` (now pinned at thirty-four by Step 6b) and 7C's `7c-datasets.test.ts` (now `toHaveLength(34)`). A `expected [ …29 ids ] to equal [ …34 ids ]` here means Step 6b(a) was skipped; a bare `expected 34 to be 29` means Step 6b(b) was. And `no-bare-db` / `no-sql-concat` / `posting-only-tables` all silent — `datasets/hr.ts` contains no `insert`, `update`, `delete` or `merge` naming `app.employee_ytd` (which keeps it legal outside `packages/db/src/posting/**`), and **no `.unsafe(` call at all**: every fragment is a literal tagged template, which is the only form §3.3's three-homes rule leaves open to a dataset (hazard 21).

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0098_add_employee_contract_end.sql packages/db/migrations/0098.down.sql \
        packages/db/src/schema/employee.ts packages/db/src/reports/datasets/hr.ts \
        packages/db/src/reports/datasets.ts packages/db/src/reports/index.ts \
        packages/db/test/reports/hr-datasets.test.ts packages/db/test/reports/datasets.test.ts \
        packages/db/test/reports/7c-datasets.test.ts tests/invariants/support/hr-reports.ts
git commit -m "feat(db): add employee.contract_ends_on and the five HR datasets [8D T2]

payroll_line is restricted to posted and reversed documents and carries the two
signed measures of amendment A10; employee_ytd is unnested to (employee,
tax_year, scheme) grain; no dataset names employee_sensitive, compensation_line
or employee_statutory_profile (test 32). 7A's pinned literal array and 7C's
pinned length move from twenty-nine to thirty-four in THIS commit (section
3.7.3): the slice that widens a shared registry updates its pins with it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The three establishment reports, the permit-expiry route, and test 32's report clause

Three of spec:2091's five reports need no ledger: `hr.employee_list` ("employee list by branch"), `hr.contract_expiry` ("contract and permit expiry list") and `hr.attendance` (spec:2089, "readable by HR and payroll as a report; **never an automatic pay input**"). This task ships all three, the gated route that carries the permit half of the second (amendment **A3**), and the report-side half of acceptance test 32. **The column `hr.contract_expiry` reports on, `employee.contract_ends_on`, arrives with Task 2's migration 0098** — this task consumes it.

**Files:**
- Create: `packages/db/seed/my/reports/8d/hr.employee_list.json`, `…/hr.contract_expiry.json`, `…/hr.attendance.json`, `packages/db/src/hr/permit-expiry.ts`, `packages/db/test/hr/permit-expiry.test.ts`, `packages/contracts/src/hr/permit-expiry.ts`, `apps/api/src/routes/hr/permit-expiry.ts`, `apps/api/test/routes/hr/permit-expiry.test.ts`, `packages/db/test/reports/hr-definitions.test.ts`
- Modify: `packages/db/src/hr/index.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/hr/employees-composed.ts`

**Interfaces:**
- Consumes: `readHrDefinition`, `hrReportFixture`, `HrReportFixture` (Task 2); `runDefinition`, `assertFieldCoverage`, `assertTieOut` (7B, §4.17.1); `validateReportDefinition`, `parseReportDefinition`, `ReportDefinitionSets` (7A); `DATASETS` (Task 2); `readSensitive`, `SensitiveField`, `HrKeyRing` (8A); `composeEmployeeRouter` (8A, A16); `requirePermission`, `PERMISSION` (§4.2.5); `startApi`, `StartedApi`, `problemOf` (§4.2.12, §4.17.1); `hrFixture`, `hrActor` (8A, A6); `ListEnvelope`, `ListQuery`, `DateSchema`, `UuidSchema` (§4.2.8).
- Produces:

```ts
// packages/db/src/hr/permit-expiry.ts — amendment A3. The permit half of spec:2091, which cannot be a
// dataset because work_permit_expiry is ciphertext (§4.12.5) and a dataset returns only SQL scalars.
export interface PermitExpiryParams { companyId: string; withinDays: number; includeTerminated?: boolean }
export interface PermitExpiryRow {
  employeeId: string; employeeNumber: string; employeeNameEn: string;
  branchCode: string; position: string | null;
  /** YYYY-MM-DD, decrypted from employee_sensitive.work_permit_expiry_enc. Never null in a returned row. */
  workPermitExpiry: string;
  /** Whole days from today (UTC) to the expiry; negative when it has already lapsed. */
  daysRemaining: number;
}
/** RLS does the gating: `sensitive_gate` is RESTRICTIVE, so a caller without hr.employee.read_sensitive
 *  reads ZERO employee_sensitive rows and receives an empty list — never a partial one and never an error
 *  that would reveal how many rows exist (spec:2076, test 32). */
export function permitExpiry(tx: Sql, ring: HrKeyRing, params: PermitExpiryParams): Promise<PermitExpiryRow[]>;

// packages/contracts/src/hr/permit-expiry.ts
export const PermitExpirySchema: z.ZodObject<{ employeeId; employeeNumber; employeeNameEn; branchCode; position; workPermitExpiry; daysRemaining }>;
export const PermitExpiryQuery: z.ZodObject<{ withinDays; includeTerminated }>;   // no cursor: the list is bounded by withinDays
export const PermitExpiryList: z.ZodObject<{ items; next_cursor }>;               // ListEnvelope(PermitExpirySchema)

// apps/api/src/routes/hr/permit-expiry.ts
export function createPermitExpiryRoutes(hrKeys: HrKeyRing): OpenAPIHono<AppEnv>;   // a factory: it needs the ring
```

- [ ] **Step 1: Write the failing definition test**

`packages/db/test/reports/hr-definitions.test.ts` — this file grows in Tasks 4, 5 and 6:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS } from "../../src/reports/datasets";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import {
  HR_CATALOGUE, HR_CATALOGUE_DIR, hrReportFixture, readHrDefinition, readHrEnvelope,
  type HrReportCode, type HrReportFixture,
} from "../../../../tests/invariants/support/hr-reports";
import { assertFieldCoverage, runDefinition } from "../../../../tests/invariants/support/reports";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

/** The three this task ships. Tasks 4, 5 and 6 add their own describe blocks over the same fixture. */
const ESTABLISHMENT = ["hr.employee_list", "hr.contract_expiry", "hr.attendance"] as const;

/**
 * Every 8D code whose JSON file is ON DISK right now — the three above at Task 3, six after Task 5,
 * all eight after Task 6. The validation case below iterates THIS and not `ESTABLISHMENT`, so a
 * definition written in a later task is schema-, registry- and catalogue-checked the moment its file
 * lands, by the case built to name the offending code and the offending JSON Pointer. Validating them
 * only through Task 11's `loadReportDefinitions` case would report "the loader failed" at the last
 * task before slice exit, which is the same information a day later and without the pointer.
 * Tasks 4, 5 and 6 therefore add NO validation case of their own — this one already covers them.
 */
function shippedCodes(): HrReportCode[] {
  const onDisk = new Set(
    readdirSync(HR_CATALOGUE_DIR).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, "")),
  );
  return HR_CATALOGUE.filter((c) => onDisk.has(c));
}

describe("the 8D report catalogue — contracts §4.16.1", () => {
  let db: Db;
  let s: Seed;
  let f: HrReportFixture;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "hr-definitions");
    f = await hrReportFixture(db, s);
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  it("the directory holds only 8D's registered codes, named <code>.json", () => {
    const files = readdirSync(HR_CATALOGUE_DIR).filter((n) => n.endsWith(".json")).sort();
    const shipped = files.map((n) => n.replace(/\.json$/, ""));
    for (const code of shipped) {
      expect(HR_CATALOGUE as readonly string[], `${code} is not an §4.16.1 8D code`).toContain(code);
    }
    for (const code of ESTABLISHMENT) expect(shipped).toContain(code);
  });

  it("every shipped definition validates against the schema, the dataset registry and the catalogue", async () => {
    const sets = await withTenant(db.rw, s.tenant, s.human, (tx) => reportDefinitionSets(tx));
    const codes = shippedCodes();
    // Never vacuous: at Task 3 this is the three of ESTABLISHMENT, and it only grows.
    expect(codes).toEqual(expect.arrayContaining([...ESTABLISHMENT]));
    for (const code of codes) {
      const envelope = readHrEnvelope(code);
      expect(envelope.definitionVersion, code).toBe(1);   // no 8D code is a re-expression (§4.16.1)
      const result = validateReportDefinition(envelope.definition, sets);
      // `errors` first: it names the JSON Pointer and the rule, and `ok` alone names neither.
      expect(result.errors, code).toEqual([]);
      expect(result.ok, code).toBe(true);
    }
  });

  it("every definition's module is the first segment of its code, and its permission is the register's", () => {
    const expected: Record<string, string> = {
      "hr.employee_list": "hr.employee.read",
      "hr.contract_expiry": "hr.employee.read",
      "hr.attendance": "hr.employee.read",
    };
    for (const code of ESTABLISHMENT) {
      const d = readHrDefinition(code);
      expect(d.code).toBe(code);
      expect(d.module).toBe(code.split(".")[0]);
      expect(d.permission).toBe(expected[code]);
      expect(d.layout.paper).toBe("A4");                  // §4.5.9's three tokens; no fourth
      expect(DATASET_IDS as readonly string[]).toContain(d.dataset.source);
    }
  });

  it("each report returns rows over the fixture, and every field it names exists in its dataset", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      for (const code of ESTABLISHMENT) {
        const d = readHrDefinition(code);
        const rows = await runDefinition(tx, d, { companyId: s.company, fromDate: f.periodStart, toDate: f.periodEnd });
        expect(rows.length, code).toBeGreaterThan(0);
        assertFieldCoverage(d, rows);
      }
    });
  });

  it("hr.contract_expiry finds the fixed-term contractor and no permit column", async () => {
    const d = readHrDefinition("hr.contract_expiry");
    expect(d.columns.map((c) => c.field)).not.toContain("work_permit_expiry");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      runDefinition(tx, d, { companyId: s.company, asOf: "2026-12-31" }));
    expect(rows.map((r) => String(r.employee_number))).toContain("E-1099");
    expect(rows.find((r) => r.employee_number === "E-1099")!.contract_ends_on).toBe("2026-03-31");
  });

  it("hr.attendance declares tieOut none — an attendance figure is NEVER a pay input (spec:2089)", () => {
    expect(readHrDefinition("hr.attendance").tieOut).toEqual({ kind: "none" });
  });

  it("no 8D definition names a sensitive, compensation or statutory-profile field — test 32", () => {
    for (const code of ESTABLISHMENT) {
      const text = JSON.stringify(readHrDefinition(code));
      for (const forbidden of [
        "national_id", "passport", "date_of_birth", "bank_account", "residency_category",
        "epf_number", "socso_number", "tax_number", "work_permit_expiry",
        "compensation", "statutory_profile", "marital_status", "child_relief",
      ]) {
        expect(text, `${code} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test test/reports/hr-definitions.test.ts`
Expected: FAIL — `ENOENT: no such file or directory, scandir '…/packages/db/seed/my/reports/8d'`.

- [ ] **Step 3: Write the three definitions**

`packages/db/seed/my/reports/8d/hr.employee_list.json` — spec:2091 "employee list by branch":

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.employee_list",
    "nameEn": "Employee list by branch",
    "nameAr": "قائمة الموظفين حسب الفرع",
    "module": "hr",
    "permission": "hr.employee.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "branchId", "kind": "branch", "required": false },
      { "name": "employmentType", "kind": "enum", "required": false,
        "options": ["full_time", "part_time", "contract", "hourly"] },
      { "name": "activeOnly", "kind": "enum", "required": false, "options": ["true", "false"] }
    ],
    "dataset": {
      "source": "employee",
      "filters": [
        { "field": "branch_id", "op": "eq", "param": "branchId" },
        { "field": "employment_type", "op": "eq", "param": "employmentType" },
        { "field": "active", "op": "eq", "param": "activeOnly" }
      ]
    },
    "columns": [
      { "field": "employee_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 12 },
      { "field": "employee_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start", "width": 30 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 10 },
      { "field": "position", "labelEn": "Position", "labelAr": "الوظيفة", "format": "text", "align": "start", "width": 20 },
      { "field": "employment_type", "labelEn": "Type", "labelAr": "نوع التوظيف", "format": "text", "align": "start", "width": 12 },
      { "field": "hired_on", "labelEn": "Hired", "labelAr": "تاريخ التعيين", "format": "date", "align": "start", "width": 12 },
      { "field": "terminated_on", "labelEn": "Left", "labelAr": "تاريخ الترك", "format": "date", "align": "start", "width": 12 },
      { "field": "has_login", "labelEn": "Login", "labelAr": "حساب دخول", "format": "text", "align": "start", "width": 8 }
    ],
    "groups": [{ "field": "branch_code", "subtotal": false }],
    "totals": [{ "field": "employee_number", "fn": "count" }],
    "sort": [{ "field": "branch_code", "dir": "asc" }, { "field": "employee_number", "dir": "asc" }],
    "layout": {
      "orientation": "portrait", "paper": "A4",
      "header": "{title} — {generatedAt}", "footer": "{rowCount} employees"
    },
    "tieOut": { "kind": "none" }
  }
}
```

`packages/db/seed/my/reports/8d/hr.contract_expiry.json` — spec:2091 "contract and permit expiry list". **The permit half is amendment A3's route**, and the footer says so in both languages so an operator is never left wondering where it went:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.contract_expiry",
    "nameEn": "Contract expiry",
    "nameAr": "انتهاء العقود",
    "module": "hr",
    "permission": "hr.employee.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "asOf", "kind": "date", "required": true },
      { "name": "branchId", "kind": "branch", "required": false }
    ],
    "dataset": {
      "source": "employee",
      "filters": [
        { "field": "contract_ends_on", "op": "lte", "param": "asOf" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "columns": [
      { "field": "employee_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 12 },
      { "field": "employee_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start", "width": 30 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 10 },
      { "field": "employment_type", "labelEn": "Type", "labelAr": "نوع التوظيف", "format": "text", "align": "start", "width": 12 },
      { "field": "contract_ends_on", "labelEn": "Contract ends", "labelAr": "نهاية العقد", "format": "date", "align": "start", "width": 14 },
      { "field": "active", "labelEn": "Active", "labelAr": "على رأس العمل", "format": "text", "align": "start", "width": 10 }
    ],
    "groups": [{ "field": "branch_code", "subtotal": false }],
    "totals": [{ "field": "employee_number", "fn": "count" }],
    "sort": [{ "field": "contract_ends_on", "dir": "asc" }, { "field": "employee_number", "dir": "asc" }],
    "layout": {
      "orientation": "portrait", "paper": "A4",
      "header": "{title} — as of {asOf}",
      "footer": "Work-permit expiry is gated by hr.employee.read_sensitive and is listed at GET /v1/companies/{companyId}/employees/permit-expiry — انتهاء تصاريح العمل متاح لمن يملك صلاحية البيانات الحساسة"
    },
    "tieOut": { "kind": "none" }
  }
}
```

`packages/db/seed/my/reports/8d/hr.attendance.json` — spec:2089, and its `tieOut` is `none` **by design**, because an attendance figure has no ledger counterpart and must never acquire one:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.attendance",
    "nameEn": "Attendance",
    "nameAr": "الحضور والانصراف",
    "module": "hr",
    "permission": "hr.employee.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "branchId", "kind": "branch", "required": false },
      { "name": "kind", "kind": "enum", "required": false,
        "options": ["clock_in", "clock_out", "manual_correction"] }
    ],
    "dataset": {
      "source": "attendance_event",
      "filters": [
        { "field": "occurred_on", "op": "gte", "param": "fromDate" },
        { "field": "occurred_on", "op": "lte", "param": "toDate" },
        { "field": "branch_id", "op": "eq", "param": "branchId" },
        { "field": "kind", "op": "eq", "param": "kind" }
      ]
    },
    "columns": [
      { "field": "occurred_on", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 12 },
      { "field": "occurred_at", "labelEn": "Time", "labelAr": "الوقت", "format": "text", "align": "start", "width": 22 },
      { "field": "employee_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 12 },
      { "field": "employee_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start", "width": 28 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 10 },
      { "field": "kind", "labelEn": "Event", "labelAr": "الحدث", "format": "text", "align": "start", "width": 16 },
      { "field": "note", "labelEn": "Note", "labelAr": "ملاحظة", "format": "text", "align": "start", "width": 30 }
    ],
    "groups": [{ "field": "employee_number", "subtotal": false }],
    "totals": [{ "field": "employee_number", "fn": "count" }],
    "sort": [{ "field": "occurred_on", "dir": "asc" }, { "field": "employee_number", "dir": "asc" }],
    "layout": {
      "orientation": "landscape", "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "Attendance is a record, never a pay input (spec:2089) — الحضور سجل ولا يدخل في احتساب الأجر"
    },
    "tieOut": { "kind": "none" }
  }
}
```

- [ ] **Step 4: Run the definition test to verify it passes**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test test/reports/hr-definitions.test.ts`
Expected: PASS — 7 passing.

- [ ] **Step 5: Write the permit-expiry reader and its failing test**

`packages/db/test/hr/permit-expiry.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHrKeyRing, DEV_HR_KEY } from "../../src/hr/keys";
import { writeSensitive } from "../../src/hr/employee-sensitive";
import { permitExpiry } from "../../src/hr/permit-expiry";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const RING = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });

describe("permitExpiry — the permit half of spec:2091 (8D amendment A3)", () => {
  let db: Db;
  let s: Seed;
  let holder: string;      // holds hr.employee.read_sensitive
  let outsider: string;    // holds hr.employee.read only

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "permit-expiry");
    await grantCodes(db, s, { codes: ["hr.employee.read", "hr.employee.read_sensitive"] });
    holder = s.human;
    outsider = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
               values (${outsider}, ${s.tenant}, 'human', ${`stub:outsider-${outsider}`}, 'Outsider')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${outsider})
               on conflict do nothing`;
    });
    await grantCodes(db, s, { codes: ["hr.employee.read"], principalId: outsider, roleCode: "clerk-8d" });

    const withPermit = await seedEmployee(db, s, { employeeNumber: "E-2001" });
    const withoutPermit = await seedEmployee(db, s, { employeeNumber: "E-2002" });
    await withTenant(db.rw, s.tenant, holder, async (tx) => {
      await writeSensitive(tx, RING, withPermit, { work_permit_expiry: "2026-02-15" });
      await writeSensitive(tx, RING, withoutPermit, { national_id: "SYNTH-0001" });
    });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("lists only employees whose decrypted permit expires inside the window, with the day count", async () => {
    const rows = await withTenant(db.rw, s.tenant, holder, (tx) =>
      permitExpiry(tx, RING, { companyId: s.company, withinDays: 100_000 }));
    expect(rows.map((r) => r.employeeNumber)).toEqual(["E-2001"]);
    expect(rows[0]!.workPermitExpiry).toBe("2026-02-15");
    expect(Number.isInteger(rows[0]!.daysRemaining)).toBe(true);
  });

  it("returns an EMPTY list — not an error, not a partial row — without hr.employee.read_sensitive", async () => {
    const rows = await withTenant(db.rw, s.tenant, outsider, (tx) =>
      permitExpiry(tx, RING, { companyId: s.company, withinDays: 100_000 }));
    expect(rows).toEqual([]);
  });

  it("a second tenant sees nothing (spec:106)", async () => {
    const other = await seedTenantV2(db, "permit-expiry-b");
    const rows = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      permitExpiry(tx, RING, { companyId: s.company, withinDays: 100_000 }));
    expect(rows).toEqual([]);
  });
});
```

Run: `bun run --cwd packages/db test test/hr/permit-expiry.test.ts` → FAIL, `Cannot find module '../../src/hr/permit-expiry'`.

- [ ] **Step 6: Write `packages/db/src/hr/permit-expiry.ts`**

```ts
// 8D amendment A3. spec:2091's "contract and permit expiry list" has two halves and they live in two
// places: the CONTRACT half is a column on app.employee and is served by the hr.contract_expiry report;
// the PERMIT half is employee_sensitive.work_permit_expiry_enc — ciphertext — so no DatasetId can serve
// it (a dataset returns string | number | boolean | null straight out of SQL).
//
// The gate is RLS, not a branch in this file: `sensitive_gate` is RESTRICTIVE (spec:2076), so a caller
// without hr.employee.read_sensitive reads zero employee_sensitive rows and receives an empty list. That
// is the behaviour test 32 wants — never a partial row, never an error that reveals how many rows exist.
import type { Sql } from "postgres";
import { openField } from "./sensitive";
import type { HrKeyRing } from "./keys";

export interface PermitExpiryParams { companyId: string; withinDays: number; includeTerminated?: boolean }
export interface PermitExpiryRow {
  employeeId: string; employeeNumber: string; employeeNameEn: string;
  branchCode: string; position: string | null;
  workPermitExpiry: string; daysRemaining: number;
}

interface Raw {
  employee_id: string; employee_number: string; employee_name_en: string;
  branch_code: string; position: string | null; work_permit_expiry_enc: Buffer | null;
}

const DAY_MS = 86_400_000;

export async function permitExpiry(
  tx: Sql, ring: HrKeyRing, params: PermitExpiryParams,
): Promise<PermitExpiryRow[]> {
  const includeTerminated = params.includeTerminated ?? false;
  const rows = await tx<Raw[]>`
    select e.id                        as employee_id,
           e.employee_number           as employee_number,
           p.name_en                   as employee_name_en,
           bv.code                     as branch_code,
           e.position                  as position,
           es.work_permit_expiry_enc   as work_permit_expiry_enc
      from app.employee_sensitive es
      join app.employee        e  on e.id  = es.employee_id
      join app.party           p  on p.id  = e.party_id
      join app.dimension_value bv on bv.id = e.home_branch_id
     where e.company_id = ${params.companyId}
       and es.work_permit_expiry_enc is not null
       and (${includeTerminated} or e.terminated_on is null)
     order by e.employee_number`;

  // The date is decrypted here, so the WINDOW is applied here too — a SQL `where` cannot compare against
  // a ciphertext column, and pushing a plaintext copy into the table to make it sortable is exactly the
  // side channel §4.12.5 exists to prevent.
  const today = Date.UTC(
    new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const out: PermitExpiryRow[] = [];
  for (const r of rows) {
    if (r.work_permit_expiry_enc === null) continue;
    const expiry = openField(ring, r.employee_id, "work_permit_expiry", r.work_permit_expiry_enc);
    const [y, m, d] = expiry.split("-").map(Number);
    const daysRemaining = Math.round((Date.UTC(y!, m! - 1, d!) - today) / DAY_MS);
    if (daysRemaining > params.withinDays) continue;
    out.push({
      employeeId: r.employee_id, employeeNumber: r.employee_number,
      employeeNameEn: r.employee_name_en, branchCode: r.branch_code, position: r.position,
      workPermitExpiry: expiry, daysRemaining,
    });
  }
  return out.sort((a, b) => a.workPermitExpiry.localeCompare(b.workPermitExpiry)
    || a.employeeNumber.localeCompare(b.employeeNumber));
}
```

Add `export * from "./permit-expiry";` to `packages/db/src/hr/index.ts`.

Run: `bun run --cwd packages/db test test/hr/permit-expiry.test.ts` → PASS, 3 passing.

- [ ] **Step 7: Write the contracts module and the route**

`packages/contracts/src/hr/permit-expiry.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, UuidSchema } from "../common";

export const PermitExpirySchema = z.object({
  employeeId: UuidSchema,
  employeeNumber: z.string(),
  employeeNameEn: z.string(),
  branchCode: z.string(),
  position: z.string().nullable(),
  workPermitExpiry: DateSchema,
  daysRemaining: z.number().int(),
}).openapi("PermitExpiry");

/** No cursor: the list is bounded by `withinDays`, and a permit window that needs paging is a data
 *  problem, not a paging problem. §4.2.8 Layer 1 admits this because the route declares no `filter[…]`
 *  grammar at all — these two are parameters of the computation, not filters over a dataset. */
export const PermitExpiryQuery = z.object({
  withinDays: z.coerce.number().int().min(0).max(3650).default(90),
  // NOT `z.coerce.boolean()`. A query parameter arrives as a string and `Boolean("false")` is `true`,
  // so `?includeTerminated=false` would include terminated employees — the opposite of the request,
  // and on this route that means listing people who have left. Task 8's `LeaveTypeQuery` takes the
  // same shape for the same reason; a boolean query flag in this slice is always an explicit enum.
  includeTerminated: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export const PermitExpiryList = ListEnvelope(PermitExpirySchema).openapi("PermitExpiryList");
```

`apps/api/src/routes/hr/permit-expiry.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PermitExpiryList, PermitExpiryQuery, ProblemSchema, UuidSchema } from "@dulja/contracts";
import { permitExpiry, type HrKeyRing } from "@dulja/db";
import { PERMISSION } from "@dulja/contracts/permissions";
import { requirePermission } from "../../middleware/require-permission";
import type { AppEnv } from "../../context";

/** A FACTORY, like 0B's users module and 2C's attachments module: it needs the key ring, which
 *  `AppDeps` carries (8A amendment A8) and which a route must never read from `process.env`. */
export function createPermitExpiryRoutes(hrKeys: HrKeyRing): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();
  routes.openapi(
    createRoute({
      method: "get",
      path: "/permit-expiry",
      tags: ["hr"],
      request: { params: z.object({ companyId: UuidSchema }), query: PermitExpiryQuery },
      middleware: [requirePermission(PERMISSION["hr.employee.read_sensitive"], { company: "path:companyId" })],
      responses: {
        200: { description: "Employees whose work permit expires inside the window",
               content: { "application/json": { schema: PermitExpiryList } } },
        403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const { withinDays, includeTerminated } = c.req.valid("query");
      const items = await c.var.withTenant((tx) =>
        permitExpiry(tx, hrKeys, { companyId, withinDays, includeTerminated }));
      // `next_cursor` is a constant null and the schema says so — the list is bounded by `withinDays`,
      // and advertising a cursor the handler ignores would let a caller mistake a page for a list
      // (2B's GET …/events carries the same note for the same reason).
      return c.json({ items, next_cursor: null }, 200);
    },
  );
  return routes;
}
```

- [ ] **Step 8: Compose it onto 6C's `employees` module**

In `apps/api/src/routes/hr/employees-composed.ts` — 8A's file, amendment A16 — add one import and one `.route(…)` line inside `composeEmployeeRouter`, beside 8A's three sub-routers:

```ts
import { createPermitExpiryRoutes } from "./permit-expiry";
// …inside composeEmployeeRouter(hrKeys):
  routes.route("/", createPermitExpiryRoutes(hrKeys));
```

and add `PERMISSION["hr.employee.read_sensitive"]` to the `permissions` array of the `employees` `RouteModule` in `buildRoutes` **only if it is not already there** — 8A's sensitive sub-resource already gates on it, so in the expected order this is a no-op and the array is unchanged. **No `PROBES` entry is added**: `PROBES` is keyed by `RouteModule.path` and this is a sub-path of `/v1/companies/:companyId/employees`, whose entry 6C already wrote (hazard 31, §4.2.7).

- [ ] **Step 9: Write the route test and run it**

`apps/api/test/routes/hr/permit-expiry.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hrActor, hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("GET …/employees/permit-expiry — 8D amendment A3, acceptance test 32", () => {
  let api: StartedApi;
  let f: HrFixture;
  beforeAll(async () => { api = await startApi(); f = await hrFixture(api, "permit-route"); }, 180_000);
  afterAll(async () => { await api.stop(); });

  const path = (q = "") => `/v1/companies/${f.companyId}/employees/permit-expiry${q}`;

  it("the officer receives the list", async () => {
    const res = await api.request({ method: "GET", path: path("?withinDays=3650"), as: hrActor(f, "officer") });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; next_cursor: null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.next_cursor).toBeNull();
  });

  it("a principal without hr.employee.read_sensitive is refused at the gate, not by an empty list", async () => {
    const res = await api.request({ method: "GET", path: path(), as: hrActor(f, "outsider") });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the OpenAPI document exposes no sensitive field name through this route", async () => {
    const doc = api.app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "t", version: "1" } });
    const text = JSON.stringify(doc.components?.schemas?.PermitExpiry ?? {});
    for (const forbidden of ["national_id", "passport", "bank_account", "date_of_birth", "tax_number"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("workPermitExpiry");     // the ONE sensitive value this gated route returns
  });
});
```

Run: `bun run --cwd apps/api test test/routes/hr/permit-expiry.test.ts` → PASS, 3 passing. Then regenerate and commit the OpenAPI document, which the route changed (spec:2055):

Run: `bun run --cwd packages/contracts openapi:generate`
Expected: a non-empty diff on `packages/contracts/openapi.json` carrying the `PermitExpiry` schema and the new path.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/hr/permit-expiry.ts packages/db/src/hr/index.ts \
        packages/db/seed/my/reports/8d packages/db/test/reports/hr-definitions.test.ts \
        packages/db/test/hr/permit-expiry.test.ts packages/contracts/src/hr/permit-expiry.ts \
        packages/contracts/src/index.ts packages/contracts/openapi.json \
        apps/api/src/routes/hr/permit-expiry.ts apps/api/src/routes/hr/employees-composed.ts \
        apps/api/test/routes/hr/permit-expiry.test.ts
git commit -m "feat(api): ship the three establishment HR reports and the gated permit list [8D T3]

hr.contract_expiry reports on employee.contract_ends_on (Task 2's 0098); the
permit half cannot be a dataset because work_permit_expiry is ciphertext, so it
is a route gated by hr.employee.read_sensitive (amendment A3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The three money reports and the two new `assertTieOut` projection cases

spec:2091's remaining three reports all carry a number that must equal a ledger figure: `hr.payroll_register` (per run), `hr.statutory_summary` (per scheme per month) and `hr.payable_reconciliation`, which §4.16.1 describes as the one that "ties `2400` and `241n` (§4.15) to the ledger". Each declares an executable `tieOut`, and 7B's `assertTieOut` runs it — so a broken report is a failing test, not a wrong PDF.

**Two of the three tie to a projection 7B's switch does not know**, so this task adds the two cases amendment **A6** registers. It **adds cases; it edits none** — 7B's own row says the switch "is extended additively by 7C and 8D for their own sources and never edits a case", and a `default:` that threw for an unknown projection is what makes an omission loud.

**The third ties to the ledger, and cannot do it by summing `amount`** (amendment **A10**). 7B's `firstMoneyTotal` takes a definition's first money `sum` total and requires its field to be a **key of `LEDGER_MEASURE`** — `base_debit`, `base_credit`, `base_balance`, `base_total` — throwing `"is not in the closed measure map"` otherwise. That guard is right: a payroll run's lines are earnings, deductions and *both* scheme shares, and Σ`amount` over them equals nothing the ledger holds. So this task adds **two keys** to that map, `net_contribution` and `payable_contribution`, whose values Task 2's dataset computes in SQL as each line's signed contribution to one §4.15 account. Two keys added, none changed — the same additive terms as A6.

**Files:**
- Create: `packages/db/seed/my/reports/8d/hr.payroll_register.json`, `…/hr.statutory_summary.json`, `…/hr.payable_reconciliation.json`
- Modify: `tests/invariants/support/reports.ts`, `packages/db/test/reports/hr-definitions.test.ts`

**Interfaces:**
- Consumes: `assertTieOut`, `TieOutOptions`, `runDefinition`, `assertFieldCoverage` (7B, §4.17.1); `readHrDefinition`, `hrReportFixture` (Task 2); `Money`, `currency`, `CurrencyCode` (§4.2.1); `DatasetRow` (7A).
- Produces: the two new `case` arms of `assertTieOut`'s `projection` switch, `"employee_ytd"` and `"statutory_schedule"`. No new export.

- [ ] **Step 1: Write the failing test**

Append one `describe` to `packages/db/test/reports/hr-definitions.test.ts`, over the same `hrReportFixture`:

```ts
describe("the three 8D money reports tie to the ledger — spec:2091, test 30's re-run", () => {
  const MONEY = ["hr.payroll_register", "hr.statutory_summary", "hr.payable_reconciliation"] as const;

  it("each declares an executable tieOut whose first money sum total is a LEDGER_MEASURE key", () => {
    expect(readHrDefinition("hr.payroll_register").tieOut).toEqual({ kind: "ledger_sum", account: "2400" });
    expect(readHrDefinition("hr.payroll_register").totals[0]).toEqual({ field: "net_contribution", fn: "sum" });
    expect(readHrDefinition("hr.statutory_summary").tieOut)
      .toEqual({ kind: "projection", projection: "statutory_schedule" });
    expect(readHrDefinition("hr.payable_reconciliation").tieOut).toEqual({ kind: "ledger_sum" });
    expect(readHrDefinition("hr.payable_reconciliation").totals[0])
      .toEqual({ field: "payable_contribution", fn: "sum" });
    // Neither sums `amount`: 7B's firstMoneyTotal would throw "not in the closed measure map" (A10),
    // and even past the throw a run's earnings + deductions + both shares equal nothing the ledger holds.
    for (const code of MONEY) {
      expect(readHrDefinition(code).totals.map((t) => t.field), code).not.toContain("amount");
    }
  });

  it("hr.payroll_register's net_contribution total equals the credit to salaries payable (2400)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await assertTieOut(tx, readHrDefinition("hr.payroll_register"), {
        params: { companyId: s.company, payrollDocumentId: f.runDocumentId },
        baseCurrency: MYR,
        window: { documentTypeCodes: ["PAYROLL"], accountCode: "2400" },
      });
    });
  });

  it("hr.statutory_summary equals every statutory_schedule row for the period", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await assertTieOut(tx, readHrDefinition("hr.statutory_summary"), {
        params: { companyId: s.company, fromDate: f.periodStart, toDate: f.periodEnd },
        baseCurrency: MYR,
        // The window is REQUIRED, not decoration: the report side is filtered to January by its two
        // parameters, and without the same restriction the stored side would cover every period the
        // corpus ever holds. It passes today only because the fixture posts one run; a second period
        // would fail it for a reason that has nothing to do with the report. 7B's `account_balance`
        // case carries the identical warning for `accountCode` (7b:829–845).
        window: { fromDate: f.periodStart, toDate: f.periodEnd },
      });
    });
  });

  it("hr.payable_reconciliation ties, once per scheme, to that scheme's own 241n payable", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // One assertion per (scheme, payable account) pair the fixture actually posted. Both sides are
      // narrowed to the SAME scheme — the report by `schemeCode`, the ledger by `accountCode` — because
      // comparing every scheme's rows against one scheme's account would fail on the first one.
      const pairs = await tx<{ code: string; account: string }[]>`
        select sc.code, a.code as account
          from app.statutory_scheme sc join app.account a on a.id = sc.payable_account_id
         where sc.company_id = ${s.company} order by sc.code`;
      expect(pairs.length).toBeGreaterThan(0);
      for (const p of pairs) {
        await assertTieOut(tx, readHrDefinition("hr.payable_reconciliation"), {
          params: { companyId: s.company, fromDate: f.periodStart, toDate: f.periodEnd, schemeCode: p.code },
          baseCurrency: MYR,
          window: { fromDate: f.periodStart, toDate: f.periodEnd,
                    documentTypeCodes: ["PAYROLL"], accountCode: p.account },
        });
      }
    });
  });

  it("the employee_ytd projection case compares distinct (employee, year) pairs, never a sum", async () => {
    // Registered by amendment A6. It is EXERCISED here, over a definition declared in this file rather
    // than over Task 6's `hr.annual_statement` — Task 6 is the isolated OD-28 task and may be dropped,
    // and an arm whose only consumer is a droppable task has no failing test of its own. This definition
    // is the minimum shape the arm reads: the unnested employee_ytd dataset, the three fields the arm
    // keys on, and the projection tie-out. Before Step 6 is applied it fails with
    // `unknown projection "employee_ytd"` from the switch's `default:`; after it, it passes.
    // `code` is a REGISTERED §4.16.1 literal and not an invented one (hazard 32): `assertTieOut` reads
    // the field only to name itself in an error message, and this object is never seeded, never written
    // to disk and never reaches `app.report_definition`.
    const YTD_PROBE: ReportDefinition = parseReportDefinition({
      version: 1, code: "hr.payroll_register",
      nameEn: "employee_ytd tie-out probe", nameAr: "اختبار المطابقة السنوية",
      module: "hr", permission: "hr.payroll.read",
      parameters: [
        { name: "companyId", kind: "text", required: true },
        { name: "taxYear", kind: "text", required: true },
      ],
      dataset: { source: "employee_ytd", filters: [{ field: "tax_year", op: "eq", param: "taxYear" }] },
      columns: [
        { field: "employee_number", labelEn: "Number", labelAr: "الرقم", format: "text", align: "start", width: 12 },
        { field: "tax_year", labelEn: "Year", labelAr: "السنة", format: "integer", align: "end", width: 8 },
        { field: "gross", labelEn: "Gross", labelAr: "الإجمالي", format: "money", align: "end", width: 16 },
        { field: "net", labelEn: "Net", labelAr: "الصافي", format: "money", align: "end", width: 16 },
        { field: "scheme_employee", labelEn: "Employee share", labelAr: "حصة الموظف", format: "money", align: "end", width: 14 },
      ],
      groups: [{ field: "employee_number", subtotal: true }],
      totals: [{ field: "scheme_employee", fn: "sum" }],
      sort: [{ field: "employee_number", dir: "asc" }],
      layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "{rowCount}" },
      tieOut: { kind: "projection", projection: "employee_ytd" },
    });

    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // The corpus has rows to compare: 8C's step-12 MERGE ran when `hrReportFixture` posted the run.
      const stored = await tx<{ n: number }[]>`
        select count(*)::int as n from app.employee_ytd where company_id = ${s.company}`;
      expect(stored[0]!.n).toBeGreaterThan(0);
      await assertTieOut(tx, YTD_PROBE, {
        params: { companyId: s.company, taxYear: String(f.taxYear) },
        baseCurrency: MYR,
        asOf: `${f.taxYear}-12-31`,
      });
    });
  });


  it("no money definition names a rate, a threshold or a ceiling — hazard 1", () => {
    for (const code of MONEY) {
      const text = JSON.stringify(readHrDefinition(code));
      for (const forbidden of ["rate_percent", "threshold", "ceiling", "bracket", "relief"]) {
        expect(text, `${code} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
```

Add the imports this block needs at the top of the file, beside Task 3's:

```ts
import { assertTieOut, runDefinition } from "../../../../tests/invariants/support/reports";
import { currency, parseReportDefinition, type ReportDefinition } from "@dulja/domain";

const MYR = currency("MYR");
```

(`runDefinition` is already imported by Task 3's block; add only what is missing.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test test/reports/hr-definitions.test.ts`
Expected: FAIL — `ENOENT … hr.payroll_register.json`.

- [ ] **Step 3: Write `hr.payroll_register.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.payroll_register",
    "nameEn": "Payroll register",
    "nameAr": "سجل الرواتب",
    "module": "hr",
    "permission": "hr.payroll.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "payrollDocumentId", "kind": "text", "required": true },
      { "name": "branchId", "kind": "branch", "required": false }
    ],
    "dataset": {
      "source": "payroll_line",
      "filters": [
        { "field": "payroll_document_id", "op": "eq", "param": "payrollDocumentId" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "columns": [
      { "field": "employee_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 12 },
      { "field": "employee_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start", "width": 26 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 10 },
      { "field": "component_code", "labelEn": "Component", "labelAr": "البند", "format": "text", "align": "start", "width": 16 },
      { "field": "component_kind", "labelEn": "Kind", "labelAr": "النوع", "format": "text", "align": "start", "width": 10 },
      { "field": "scheme_code", "labelEn": "Scheme", "labelAr": "النظام", "format": "text", "align": "start", "width": 10 },
      { "field": "share", "labelEn": "Share", "labelAr": "الحصة", "format": "text", "align": "start", "width": 10 },
      { "field": "rate_table_version", "labelEn": "Table v", "labelAr": "إصدار الجدول", "format": "integer", "align": "end", "width": 8 },
      { "field": "override_reason", "labelEn": "Override reason", "labelAr": "سبب التعديل", "format": "text", "align": "start", "width": 24 },
      { "field": "amount", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 14 },
      { "field": "net_contribution", "labelEn": "To net pay", "labelAr": "أثره في الصافي", "format": "money", "align": "end", "width": 14 }
    ],
    "groups": [{ "field": "employee_number", "subtotal": true }],
    "totals": [{ "field": "net_contribution", "fn": "sum" }],
    "sort": [{ "field": "employee_number", "dir": "asc" }, { "field": "component_code", "dir": "asc" }],
    "layout": {
      "orientation": "landscape", "paper": "A4",
      "header": "{title} — {generatedAt}",
      "footer": "Every line names the rate-table version it pinned (LEGACY-013) — كل سطر يحمل إصدار الجدول المثبت"
    },
    "tieOut": { "kind": "ledger_sum", "account": "2400" }
  }
}
```

**Why the register's total is `net_contribution` and not `amount`.** The register lists every `payroll_line` of one run — earnings, deductions and both scheme shares — and Σ`amount` over them is a number with no counterpart anywhere. `net_contribution` is each line's **signed contribution to `2400`**: an earning adds, an employee-borne deduction or scheme share subtracts, an employer share contributes nothing because it is the company's cost and never the employee's net, and **the net-pay leg itself contributes nothing** — it is the figure being re-derived, not a part of it. (The net-pay leg is a real `payroll_line` with `amount = net`, so it still appears as a row of the register with a zero in this column; the officer reads the employee's net off the subtotal, which is where it is proved.) Summed over the run it is exactly the credit the PAYROLL posting made to salaries payable, which is the Phase 8 definition-of-done clause *"Σ payslip net = salaries-payable credit"*, proved over the register rather than over a PDF. `assertTieOut`'s `ledger_sum` branch takes the definition's **first money column with a `sum` total** — `net_contribution` — looks it up in `LEDGER_MEASURE` (the two keys this task adds) and compares it against one SQL sum over `ledger_entry` restricted by the caller's `window`. The two paths are genuinely independent: one aggregates `app.payroll_line` through the dataset, the other aggregates `app.ledger_entry`, and only a correct posting makes them agree. The per-employee subtotal is that employee's net pay, which is what an officer reads a register for.

- [ ] **Step 4: Write `hr.statutory_summary.json` and `hr.payable_reconciliation.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.statutory_summary",
    "nameEn": "Statutory summary per scheme",
    "nameAr": "ملخص الاستقطاعات النظامية لكل نظام",
    "module": "hr",
    "permission": "hr.payroll.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "schemeCode", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "statutory_schedule",
      "filters": [
        { "field": "period_start", "op": "gte", "param": "fromDate" },
        { "field": "period_end", "op": "lte", "param": "toDate" },
        { "field": "scheme_code", "op": "eq", "param": "schemeCode" }
      ]
    },
    "columns": [
      { "field": "scheme_code", "labelEn": "Scheme", "labelAr": "النظام", "format": "text", "align": "start", "width": 10 },
      { "field": "scheme_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start", "width": 26 },
      { "field": "period_start", "labelEn": "From", "labelAr": "من", "format": "date", "align": "start", "width": 12 },
      { "field": "period_end", "labelEn": "To", "labelAr": "إلى", "format": "date", "align": "start", "width": 12 },
      { "field": "payroll_number", "labelEn": "Run", "labelAr": "المسير", "format": "text", "align": "start", "width": 12 },
      { "field": "payable_account_code", "labelEn": "Payable", "labelAr": "حساب الاستحقاق", "format": "text", "align": "start", "width": 10 },
      { "field": "total_employee", "labelEn": "Employee", "labelAr": "حصة الموظف", "format": "money", "align": "end", "width": 14 },
      { "field": "total_employer", "labelEn": "Employer", "labelAr": "حصة صاحب العمل", "format": "money", "align": "end", "width": 14 },
      { "field": "total", "labelEn": "Total", "labelAr": "الإجمالي", "format": "money", "align": "end", "width": 14 },
      { "field": "remitted", "labelEn": "Remitted", "labelAr": "تم السداد", "format": "text", "align": "start", "width": 10 }
    ],
    "groups": [{ "field": "scheme_code", "subtotal": true }],
    "totals": [{ "field": "total", "fn": "sum" }],
    "sort": [{ "field": "period_end", "dir": "asc" }, { "field": "scheme_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait", "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "Generated from POSTED lines only (spec:2083) — من السطور المرحّلة فقط"
    },
    "tieOut": { "kind": "projection", "projection": "statutory_schedule" }
  }
}
```

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.payable_reconciliation",
    "nameEn": "Salaries- and scheme-payable reconciliation",
    "nameAr": "مطابقة استحقاقات الرواتب والأنظمة",
    "module": "hr",
    "permission": "hr.payroll.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "schemeCode", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "payroll_line",
      "filters": [
        { "field": "period_start", "op": "gte", "param": "fromDate" },
        { "field": "period_end", "op": "lte", "param": "toDate" },
        { "field": "scheme_code", "op": "eq", "param": "schemeCode" }
      ]
    },
    "columns": [
      { "field": "scheme_code", "labelEn": "Scheme", "labelAr": "النظام", "format": "text", "align": "start", "width": 10 },
      { "field": "share", "labelEn": "Share", "labelAr": "الحصة", "format": "text", "align": "start", "width": 10 },
      { "field": "component_kind", "labelEn": "Component kind", "labelAr": "نوع البند", "format": "text", "align": "start", "width": 14 },
      { "field": "employee_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 12 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 10 },
      { "field": "document_number", "labelEn": "Run", "labelAr": "المسير", "format": "text", "align": "start", "width": 12 },
      { "field": "payable_contribution", "labelEn": "To scheme payable", "labelAr": "أثره في استحقاق النظام", "format": "money", "align": "end", "width": 16 },
      { "field": "amount", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 14 }
    ],
    "groups": [{ "field": "scheme_code", "subtotal": true }, { "field": "share", "subtotal": true }],
    "totals": [{ "field": "payable_contribution", "fn": "sum" }],
    "sort": [{ "field": "scheme_code", "dir": "asc" }, { "field": "share", "dir": "asc" }, { "field": "employee_number", "dir": "asc" }],
    "layout": {
      "orientation": "portrait", "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "2400 salaries payable and 2411-2414 statutory payable, §4.15 — الحسابات وفق سجل الحسابات"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

**`hr.payable_reconciliation` declares `tieOut.kind: "ledger_sum"` with no `account`**, deliberately: the caller supplies the account through `window.accountCode`, once per account the reconciliation covers, so the same definition proves each `241n` in turn without four definitions or four `tieOut` blocks. `assertTieOut` already reads `window.accountCode ?? definition.tieOut.account ?? null`, so this is the shape 7B's helper was written for. Each run passes **both** an `accountCode` in the window and a `filter[scheme_code][eq]` in the parameters, so the report side is narrowed to the same scheme the ledger side is narrowed to; comparing every scheme's rows against one scheme's account would fail on the first one and rightly.

- [ ] **Step 5: Register the two measures in `LEDGER_MEASURE` — two keys, none changed**

In `tests/invariants/support/reports.ts`, extend 7B's map (amendment **A10**). This is the only line of that map any slice edits, and it is an addition:

```ts
const LEDGER_MEASURE: Readonly<Record<string, "debit" | "credit" | "net">> = {
  base_debit: "debit", base_credit: "credit", base_balance: "net", base_total: "debit",
  // 8D (A10). Both are credits: net pay credits 2400, and both scheme shares credit the scheme's 241n.
  // The SIGN lives in the dataset's SQL, not here — `net_contribution` is already negative for a
  // deduction, so summing it and comparing against sum(base_credit) is one subtraction, done once.
  // It is also already ZERO on the net-pay leg's own all-null payroll_line, so the sum re-derives net
  // from its parts rather than double-counting the figure it is being compared against.
  net_contribution: "credit", payable_contribution: "credit",
};
```

- [ ] **Step 6: Extend `assertTieOut`'s projection switch — two cases, no edits**

In `tests/invariants/support/reports.ts`, inside `assertTieOut`'s `if (definition.tieOut.kind === "projection")` switch, **after** 7C's last case and **before** the `default:`:

```ts
      case "statutory_schedule": {
        // WHAT THIS ARM PROVES, STATED EXACTLY. Both sides read app.statutory_schedule — the report
        // side through the `statutory_schedule` dataset, this side directly — so it is NOT a proof
        // against the ledger and must not be described as one. What it proves is that the definition's
        // filters, the dataset's `select` and the stored projection agree: a wrong filter, a dropped
        // scheme, a mis-scaled numeric or a period boundary off by a day all fail here.
        // The DoD clause "each scheme's schedule = its payable to the cent" is discharged by
        // `hr.payable_reconciliation`'s per-scheme `241n` ledger_sum in this same task (Step 1's third
        // case), and by 8C's test 30 — not by this arm. (8D, A6.)
        const stored = await tx<{ scheme: string; employee: string; employer: string }[]>`
          select sc.code                                as scheme,
                 sum(ss.total_employee)::numeric(19,4)::text as employee,
                 sum(ss.total_employer)::numeric(19,4)::text as employer
            from app.statutory_schedule ss join app.statutory_scheme sc on sc.id = ss.scheme_id
           where ss.company_id = ${companyId}
             and (${opts.window?.fromDate ?? null}::date is null or ss.period_start >= ${opts.window?.fromDate ?? null}::date)
             and (${opts.window?.toDate ?? null}::date is null or ss.period_end <= ${opts.window?.toDate ?? null}::date)
           group by sc.code order by sc.code`;
        if (stored.length === 0) {
          throw new Error(`${definition.code}: statutory_schedule has no row in this window, so the tie-out would compare nothing`);
        }
        const byScheme = new Map<string, Money>();
        for (const r of rows) {
          const key = String(r.scheme_code);
          const total = Money.of(String(r.total_employee ?? "0.0000"), base)
            .add(Money.of(String(r.total_employer ?? "0.0000"), base));
          byScheme.set(key, (byScheme.get(key) ?? Money.zero(base)).add(total));
        }
        for (const s of stored) {
          const expected = Money.of(s.employee, base).add(Money.of(s.employer, base));
          const got = byScheme.get(s.scheme) ?? Money.zero(base);
          if (got.toString() !== expected.toString()) {
            throw new Error(`${definition.code}: statutory_schedule says ${expected.toString()} for scheme ${s.scheme}, the report says ${got.toString()}`);
          }
        }
        return;
      }

      case "employee_ytd": {
        // The employee_ytd DATASET is unnested to (employee, tax_year, scheme) grain, so `gross` and
        // `net` REPEAT across an employee's scheme rows. Summing them would multiply by the scheme count.
        // This case therefore compares DISTINCT pairs against the stored projection, and sums only the
        // per-scheme shares — which is exactly why it could not reuse the account_balance case. (8D, A6.)
        const stored = await tx<{ employee: string; year: number; gross: string; net: string }[]>`
          select e.employee_number as employee, y.tax_year::int as year,
                 y.gross::text as gross, y.net::text as net
            from app.employee_ytd y join app.employee e on e.id = y.employee_id
           where y.company_id = ${companyId}
             and (${opts.asOf ?? null}::text is null or y.tax_year = extract(year from ${opts.asOf ?? null}::date))
           order by e.employee_number, y.tax_year`;
        if (stored.length === 0) {
          throw new Error(`${definition.code}: employee_ytd has no row in this window, so the tie-out would compare nothing`);
        }
        const seen = new Map<string, { gross: string; net: string }>();
        for (const r of rows) {
          const key = `${String(r.employee_number)}|${String(r.tax_year)}`;
          const pair = { gross: String(r.gross ?? "0.0000"), net: String(r.net ?? "0.0000") };
          const prior = seen.get(key);
          if (prior && (prior.gross !== pair.gross || prior.net !== pair.net)) {
            throw new Error(`${definition.code}: employee_ytd rows for ${key} disagree — ${prior.gross}/${prior.net} vs ${pair.gross}/${pair.net}`);
          }
          seen.set(key, pair);
        }
        for (const s of stored) {
          const key = `${s.employee}|${s.year}`;
          const got = seen.get(key);
          if (!got) throw new Error(`${definition.code}: employee_ytd has ${key} and the report does not`);
          if (Money.of(got.gross, base).toString() !== Money.of(s.gross, base).toString()
            || Money.of(got.net, base).toString() !== Money.of(s.net, base).toString()) {
            throw new Error(`${definition.code}: employee_ytd says ${s.gross}/${s.net} for ${key}, the report says ${got.gross}/${got.net}`);
          }
        }
        return;
      }
```

**Nothing else in that file changes.** 7B's `LEDGER_MEASURE` map (beyond Step 5's two added keys), `firstMoneyTotal`, `sumRows`, `assertFieldCoverage` and every existing case keep their bodies; **`TieOutOptions` keeps every member it has, `projectionKeys` included** — 7B's own later task adds that sixth member (7b:3087–3091), so a count here would be stale the day it was written. `asOf` and `window` are the two the new cases read and 7B already declared both.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test test/reports/hr-definitions.test.ts`
Expected: PASS — 13 passing (7 from Task 3, 6 here).

A failure reading `statutory_schedule has no row in this window` means **Task 2 Step 4's `generateStatutorySchedule` call is missing from `hrReportFixture`**. That is the correct failure and its fix is in Task 2, not here: nothing in `postPayrollRun` or `postDocument` writes `app.statutory_schedule` — 8C's service is the only writer (8c:3051–3053) — so the fixture calls it explicitly. **Never weaken the tie-out to pass without one.**

- [ ] **Step 8: Run the whole reports suite**

Run: `bun run --cwd packages/db test test/reports && bun run test --filter @dulja/tests`
Expected: PASS. 7B's and 7C's own tie-out suites must still be green — the switch gained two arms and lost none.

- [ ] **Step 9: Commit**

```bash
git add packages/db/seed/my/reports/8d tests/invariants/support/reports.ts \
        packages/db/test/reports/hr-definitions.test.ts
git commit -m "feat(db): ship the three money HR reports with executable tie-outs [8D T4]

hr.payroll_register ties its net total to the 2400 credit; hr.statutory_summary
and hr.payable_reconciliation add the two assertTieOut projection cases
amendment A6 registers. No existing case is edited.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `hr.payslip` — the definition, the synchronous render, the attachment, and tests 33 and 23 re-run

spec:2083: *"a payslip PDF per employee per run (stored as an attachment with its hash)"*. Amendment **A4** fixes how: `renderReport` (pure, `@dulja/domain`) → `reportToHtmlSource` / `reportToTypstSource` (pure, 7A) → `engineFor(code)` (2C, `apps/api`) → `ObjectStore.put` → one `app.attachment` row per employee on the PAYROLL document. **No new pg-boss name**: `JOBS` is closed and 8D owns exactly one member of it, `hr.encryption_key.rotate`.

**Why not `reporting.render`.** 7A's three renderers and its two PDF engines live in `apps/worker`, and `apps/api` may not import an app (§3.1). 2C's `engineFor` already lives in `apps/api/src/print/engines/` and already turns rendered template text into a PDF for a single document, synchronously, under `POST …/documents/{documentId}/print`. A payslip run is the same shape at a different cardinality — one request, N employees of one posted run — so it reuses 2C's engine and 7A's pure layout, and adds neither a job nor a second engine registry (hazard 30: the PDF engine is decided once, in ADR 0016).

**Files:**
- Create: `packages/db/seed/my/reports/8d/hr.payslip.json`, `packages/db/src/hr/payslip.ts`, `packages/db/test/hr/payslip.test.ts`, `apps/api/src/print/payslip.ts`, `apps/api/src/routes/hr/payslips.ts`, `apps/api/test/routes/hr/payslips.test.ts`, `packages/contracts/src/hr/payslip.ts`, `docs/adr/0079-payslips-are-attachments-rendered-synchronously.md`
- Modify: `packages/db/src/hr/index.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `packages/db/test/reports/hr-definitions.test.ts`

**Interfaces:**
- Consumes: `renderReport`, `RenderedReport`, `RenderOptions`, `ReportFormatters`, `ReportLang`, `reportToHtmlSource`, `reportToTypstSource`, `parseReportDefinition`, **`intlFormatters`** (7A, all from `@dulja/domain`); `engineFor`, `PDF_ENGINES`, `PrintEngineCode`, `PdfEngine` (2C); `ObjectStore`, **`createAttachment`, `AttachmentRow`** (2C); `pdfText` (2C, §4.17.1); `MODULE_READ_CODE`, `requireAttachmentRead` (2C — consumed, not edited); `payrollRunRouteModule` (8B); `payrollFixture`, `postPayrollRun`, `secondApprover`, `PayrollFixture` (8B, §4.17.1); `seedTenantV2`, `seedPayrollRun`, `grantCodes` (§4.17); `Money`, `currency` (§4.2.1); `datasetFor` (7A); `readHrDefinition`, `hrReportFixture` (Task 2); `requireFilingGenerate` (Task 1); `PERMISSION["hr.filing.generate"]`, `PERMISSION["hr.payroll.read"]` (Task 1, 8B).

**Two names this task must NOT reach for, and what it uses instead.** (1) **`i18nFormatters` is `apps/worker`'s** (`apps/worker/src/reports/formatters.ts`, 7a:186, 7a:5666) — `apps/api` may not import an app (§3.1), and there is no `apps/api/src/print/formatters`. The pure equivalent that *is* reachable is **`intlFormatters(lang, { currency })` from `@dulja/domain`** (7a:4156), and the currency is the company's `base_currency`, read in the same transaction. (2) **There is no `engineCodeFromAdr`**: 2C's `apps/api/src/print/engines/index.ts` exports exactly `PrintEngineCode`, `PdfEngine`, `PDF_ENGINES`, `engineFor`, `PDF_MAGIC`, `closeChromium` and `TYPST_BIN` (2c:4429–4470), and its own print route picks the engine off `print_template.engine` (2c:5059) — a row a payslip does not have. `PAYSLIP_ENGINE` is the named constant that replaces it; Task 0's fourth case asserts both facts before this task starts.
- Produces:

```ts
// packages/db/src/hr/payslip.ts
export interface PayslipParams { companyId: string; payrollDocumentId: string; employeeIds?: readonly string[] }
export interface PayslipHeader {
  employeeId: string; employeeNumber: string; employeeNameEn: string; employeeNameAr: string | null;
  branchCode: string; periodStart: string; periodEnd: string; payDate: string;
  runKind: "regular" | "supplementary" | "final"; documentNumber: string;
  /** Fixed 4 dp strings, straight from numeric(19,4) — never a JS number (spec:2041). */
  gross: string; totalDeductions: string; net: string;
}
export interface PayslipBundle { header: PayslipHeader; rows: readonly DatasetRow[] }
/** One bundle per employee of one POSTED run, in employee-number order. Reads the `payroll_line` dataset
 *  (Task 2) so the payslip and `hr.payroll_register` can never disagree about a figure. */
export function payslipRows(tx: Sql, params: PayslipParams): Promise<PayslipBundle[]>;

// apps/api/src/print/payslip.ts
/** The ADR-0016 engine code a payslip renders through. It is a NAMED CONSTANT and not a config read
 *  (hazard 30: the engine is an ADR decision, not configuration) and not a `print_template` lookup
 *  (a payslip has no template row — it is a ReportDefinition). `"chromium"` is **the default this plan
 *  writes, not a choice it makes**: 2C's `JOURNAL.standard.v1` manifest carries the identical sentence
 *  (2c:3444), and ADR 0016's Verdict table is deliberately empty until 0E's spike is run (0e:5730).
 *  If the Decision row names `typst`, this ONE line changes and nothing else does. */
export const PAYSLIP_ENGINE: PrintEngineCode;
/** No `sha256`: 2C's `createAttachment` computes and stores it, and a second implementation of "the hash
 *  of these bytes" is hazard 9. The caller reads it off the returned `AttachmentRow`. */
export interface RenderedPayslip { employeeId: string; fileName: string; bytes: Uint8Array }
/** Pure layout + 2C's engine. `generatedAt` is a parameter, not a clock read, so two runs of the same
 *  posted data produce the same rendered TEXT — which is the layer test 33 compares at (§4.5.9). */
export function renderPayslip(
  definition: ReportDefinition, bundle: PayslipBundle,
  opts: { lang: ReportLang; engine: PrintEngineCode; formatters: ReportFormatters; generatedAt: string },
): Promise<RenderedPayslip>;

// apps/api/src/routes/hr/payslips.ts
export function createPayslipRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv>;

// packages/contracts/src/hr/payslip.ts
export const GeneratePayslipsBody: z.ZodObject<{ lang; employeeIds }>;
export const PayslipSchema: z.ZodObject<{ attachmentId; employeeId; employeeNumber; fileName; byteSize; sha256 }>;
export const GeneratePayslipsResult: z.ZodObject<{ items; next_cursor }>;
```

- [ ] **Step 1: Write the failing data-layer test**

`packages/db/test/hr/payslip.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { payslipRows } from "../../src/hr/payslip";
import { hrReportFixture, type HrReportFixture } from "../../../../tests/invariants/support/hr-reports";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const MYR = currency("MYR");

describe("payslipRows — spec:2083, one bundle per employee of one posted run", () => {
  let db: Db; let s: Seed; let f: HrReportFixture;
  beforeAll(async () => {
    db = await startDb(); s = await seedTenantV2(db, "payslip-rows"); f = await hrReportFixture(db, s);
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  const bundles = () => withTenant(db.rw, s.tenant, s.human, (tx) =>
    payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId }));

  it("returns one bundle per employee in the run, in employee-number order", async () => {
    const out = await bundles();
    expect(out.length).toBe(2);
    expect(out.map((b) => b.header.employeeNumber))
      .toEqual([...out.map((b) => b.header.employeeNumber)].sort());
    for (const b of out) {
      expect(b.header.periodStart).toBe(f.periodStart);
      expect(b.header.runKind).toBe("regular");
      expect(b.rows.length).toBeGreaterThan(0);
    }
  });

  it("gross − deductions = net on every bundle, at 4 dp, as strings", async () => {
    for (const b of await bundles()) {
      expect(b.header.gross).toMatch(/^-?\d+\.\d{4}$/);
      const computed = Money.of(b.header.gross, MYR).subtract(Money.of(b.header.totalDeductions, MYR));
      expect(computed.toString()).toBe(Money.of(b.header.net, MYR).toString());
    }
  });

  it("Σ net over the bundles equals the run's credit to salaries payable (2400)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const out = await payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId });
      const reported = out.reduce((a, b) => a.add(Money.of(b.header.net, MYR)), Money.zero(MYR));
      const [row] = await tx<{ credit: string }[]>`
        select coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)::text as credit
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.company_id = ${s.company} and le.document_id = ${f.runDocumentId} and a.code = '2400'`;
      expect(reported.toString()).toBe(Money.of(row!.credit, MYR).toString());
    });
  });

  it("a draft run yields no bundle — a payslip is made from posted figures only (spec:2083)", async () => {
    // UNCONDITIONAL. `hrReportFixture` seeds a February DRAFT run over the same two employees precisely
    // so this case has a real negative; a `if (draftId) { … }` guard over a corpus that happens to hold
    // no draft reports as passing while asserting nothing, which is the failure mode this whole plan
    // calls out elsewhere.
    const [status] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document where id = ${f.draftRunDocumentId}`);
    expect(status!.status).toBe("draft");
    const out = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRows(tx, { companyId: s.company, payrollDocumentId: f.draftRunDocumentId }));
    expect(out).toEqual([]);
  });

  it("employeeIds narrows the result and an unknown id yields nothing", async () => {
    const [first] = await bundles();
    const only = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId,
                        employeeIds: [first!.header.employeeId] }));
    expect(only.map((b) => b.header.employeeId)).toEqual([first!.header.employeeId]);
  });

  it("a second tenant sees nothing", async () => {
    const other = await seedTenantV2(db, "payslip-rows-b");
    const out = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId }));
    expect(out).toEqual([]);
  });
});
```

Run: `bun run --cwd packages/db test test/hr/payslip.test.ts` → FAIL, `Cannot find module '../../src/hr/payslip'`.

- [ ] **Step 2: Write `packages/db/src/hr/payslip.ts`**

```ts
// spec:2083 — "a payslip PDF per employee per run (stored as an attachment with its hash)".
// The FIGURES come from the payroll_line dataset (§4.16.2, 8D Task 2), not from a second query, so a
// payslip and hr.payroll_register can never disagree about a number. The dataset already restricts to
// posted and reversed documents, which is what makes "posted figures only" true here without a second
// status clause.
import type { Sql } from "postgres";
import { datasetFor } from "../reports/datasets";
import { MAX_DATASET_ROWS, type DatasetRow } from "../reports/query";

export interface PayslipParams { companyId: string; payrollDocumentId: string; employeeIds?: readonly string[] }
export interface PayslipHeader {
  employeeId: string; employeeNumber: string; employeeNameEn: string; employeeNameAr: string | null;
  branchCode: string; periodStart: string; periodEnd: string; payDate: string;
  runKind: "regular" | "supplementary" | "final"; documentNumber: string;
  gross: string; totalDeductions: string; net: string;
}
export interface PayslipBundle { header: PayslipHeader; rows: readonly DatasetRow[] }

/** numeric(19,4) arithmetic done in SQL, never in JavaScript — spec:2041 forbids a `number` here and
 *  `Money` lives in `@dulja/domain`, which this file could import but which would then have to agree
 *  with the database's own rounding on every read. Postgres sums it once and returns a 4 dp string. */
interface Totals {
  employee_id: string; employee_number: string; employee_name_en: string; employee_name_ar: string | null;
  branch_code: string; period_start: string; period_end: string; pay_date: string;
  run_kind: "regular" | "supplementary" | "final"; document_number: string;
  gross: string; total_deductions: string; net: string;
}

export async function payslipRows(tx: Sql, params: PayslipParams): Promise<PayslipBundle[]> {
  const ids = params.employeeIds && params.employeeIds.length > 0 ? [...params.employeeIds] : null;
  const totals = await tx<Totals[]>`
    select e.id                                                        as employee_id,
           e.employee_number                                           as employee_number,
           p.name_en                                                   as employee_name_en,
           p.name_ar                                                   as employee_name_ar,
           bv.code                                                     as branch_code,
           to_char(pr.period_start, 'YYYY-MM-DD')                      as period_start,
           to_char(pr.period_end,   'YYYY-MM-DD')                      as period_end,
           to_char(pr.pay_date,     'YYYY-MM-DD')                      as pay_date,
           pr.kind                                                     as run_kind,
           d.number::text                                              as document_number,
           -- The employee's own earnings; an employer share is the company's cost and is never on a payslip.
           coalesce(sum(pl.amount) filter (where pc.kind = 'earning'), 0)::numeric(19,4)::text as gross,
           coalesce(sum(pl.amount) filter (
             where pc.kind = 'deduction' or (pl.scheme_id is not null and pl.share = 'employee')
           ), 0)::numeric(19,4)::text                                  as total_deductions,
           (coalesce(sum(pl.amount) filter (where pc.kind = 'earning'), 0)
            - coalesce(sum(pl.amount) filter (
                where pc.kind = 'deduction' or (pl.scheme_id is not null and pl.share = 'employee')
              ), 0))::numeric(19,4)::text                              as net
      from app.payroll_line pl
      join app.document_line   dl on dl.id = pl.document_line_id
      join app.document        d  on d.id  = dl.document_id and d.status in ('posted', 'reversed')
      join app.payroll_run     pr on pr.document_id = d.id
      join app.employee        e  on e.id  = pl.employee_id
      join app.party           p  on p.id  = e.party_id
      join app.dimension_value bv on bv.id = e.home_branch_id
      left join app.pay_component pc on pc.id = pl.component_id
     where pl.company_id = ${params.companyId}
       and d.id = ${params.payrollDocumentId}
       and (${ids}::uuid[] is null or e.id = any(${ids}::uuid[]))
     group by e.id, e.employee_number, p.name_en, p.name_ar, bv.code,
              pr.period_start, pr.period_end, pr.pay_date, pr.kind, d.number
     order by e.employee_number`;
  if (totals.length === 0) return [];

  // ONE dataset read for the whole run, partitioned in memory: N+1 reads would make a fifty-employee run
  // fifty round trips and would let one employee's page see a different snapshot from the next's.
  const all = await datasetFor("payroll_line").run(tx, {
    companyId: params.companyId,
    filters: [{ field: "payroll_document_id", op: "eq", value: params.payrollDocumentId }],
    sort: [{ field: "employee_number", dir: "asc" }],
    limit: MAX_DATASET_ROWS, offset: 0,
  });
  const byEmployee = new Map<string, DatasetRow[]>();
  for (const r of all) {
    const key = String(r.employee_id);
    (byEmployee.get(key) ?? byEmployee.set(key, []).get(key)!).push(r);
  }

  return totals.map((t) => ({
    header: {
      employeeId: t.employee_id, employeeNumber: t.employee_number,
      employeeNameEn: t.employee_name_en, employeeNameAr: t.employee_name_ar,
      branchCode: t.branch_code, periodStart: t.period_start, periodEnd: t.period_end,
      payDate: t.pay_date, runKind: t.run_kind, documentNumber: t.document_number,
      gross: t.gross, totalDeductions: t.total_deductions, net: t.net,
    },
    rows: byEmployee.get(t.employee_id) ?? [],
  }));
}
```

Add `export * from "./payslip";` to `packages/db/src/hr/index.ts`, and run `bun run --cwd packages/db test test/hr/payslip.test.ts` → PASS, 6 passing.

- [ ] **Step 3: Write `hr.payslip.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.payslip",
    "nameEn": "Payslip",
    "nameAr": "قسيمة الراتب",
    "module": "hr",
    "permission": "hr.payroll.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "payrollDocumentId", "kind": "text", "required": true },
      { "name": "employeeId", "kind": "text", "required": true }
    ],
    "dataset": {
      "source": "payroll_line",
      "filters": [
        { "field": "payroll_document_id", "op": "eq", "param": "payrollDocumentId" },
        { "field": "employee_id", "op": "eq", "param": "employeeId" }
      ]
    },
    "columns": [
      { "field": "component_code", "labelEn": "Item", "labelAr": "البند", "format": "text", "align": "start", "width": 22 },
      { "field": "component_kind", "labelEn": "Kind", "labelAr": "النوع", "format": "text", "align": "start", "width": 12 },
      { "field": "scheme_code", "labelEn": "Scheme", "labelAr": "النظام", "format": "text", "align": "start", "width": 10 },
      { "field": "share", "labelEn": "Share", "labelAr": "الحصة", "format": "text", "align": "start", "width": 10 },
      { "field": "quantity", "labelEn": "Quantity", "labelAr": "الكمية", "format": "quantity", "align": "end", "width": 12 },
      { "field": "amount", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 14 }
    ],
    "groups": [{ "field": "component_kind", "subtotal": true }],
    "totals": [{ "field": "amount", "fn": "sum" }],
    "sort": [{ "field": "component_kind", "dir": "asc" }, { "field": "component_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait", "paper": "A5",
      "header": "{title} — {employeeNumber} {employeeNameEn} — {periodStart} … {periodEnd}",
      "footer": "Net {net} — pay date {payDate} — صافي الراتب"
    },
    "tieOut": { "kind": "none" }
  }
}
```

**Why `tieOut: none` on the one report whose numbers matter most** (amendment **A10**). A payslip is scoped to **one employee**, and 7B's `ledger_sum` query filters by company, period, account and document type — it has **no dimension filter**, so it would compare one employee's payslip against the whole run's credit to `2400` and fail on the second employee. The clause the payslip owes the definition of done — *Σ payslip net = salaries-payable credit* — is carried by **Step 1's third case**, which does the comparison in SQL over `payslipRows`, both per employee (each header's `gross − totalDeductions = net`) and in total (Σ net = the `2400` credit for that document). Declaring a tie-out the helper cannot execute would have been worse than declaring none: it would have thrown at run time and read as coverage.

Add one case to `hr-definitions.test.ts`'s money block recording exactly that. **No change to the validation loop is needed**: Task 3's `shippedCodes()` reads the catalogue directory at run time and filters `HR_CATALOGUE` by what is on disk, so `hr.payslip.json` is schema-, registry- and catalogue-validated by that case the moment Step 3 writes the file — with the offending JSON Pointer named, which is what makes it worth having.

```ts
  it("hr.payslip declares tieOut none because 7B's ledger_sum has no dimension filter (A10)", () => {
    expect(readHrDefinition("hr.payslip").tieOut).toEqual({ kind: "none" });
    // The clause is proved instead by packages/db/test/hr/payslip.test.ts's third case, in SQL, per
    // employee and in total. This assertion exists so a later slice does not "fix" the missing tie-out.
    expect(readHrDefinition("hr.payslip").parameters.map((p) => p.name)).toContain("employeeId");
  });
```

- [ ] **Step 4: Write `apps/api/src/print/payslip.ts`**

```ts
// 8D amendment A4. Pure layout (7A) + 2C's engine (apps/api). No worker, no job, no second engine
// registry — hazard 30: the PDF engine is decided once, in ADR 0016, and 2C, 7A and 8D consume it.
import {
  renderReport, reportToHtmlSource, reportToTypstSource,
  type RenderedReport, type ReportDefinition, type ReportFormatters, type ReportLang,
} from "@dulja/domain";
import type { PayslipBundle } from "@dulja/db";
import { engineFor, type PrintEngineCode } from "./engines";

/**
 * The ADR-0016 engine a payslip renders through.
 *
 * 2C's print route reads its engine off `print_template.engine` (2c:5059); a payslip has no template row
 * — it is a `ReportDefinition` — so there is no row to read, and hazard 30 forbids reading an environment
 * variable because the engine is an ADR decision and not configuration. It is therefore a named constant,
 * in one place, referenced once.
 *
 * `"chromium"` is THE DEFAULT THIS PLAN WRITES, NOT A CHOICE IT MAKES — the same sentence 2C's
 * JOURNAL.standard.v1 manifest carries (2c:3444). ADR 0016's Verdict table is deliberately empty until
 * 0E's spike is run (0e:5730), and writing a verdict here would be inventing a measurement. If the
 * Decision row names `typst`, change this ONE line: `sourceFor` already branches on it and every test in
 * this task reads the constant rather than the literal.
 */
export const PAYSLIP_ENGINE: PrintEngineCode = "chromium";

/** No `sha256` member: 2C's `createAttachment` computes and stores the hash, and a second "hash of these
 *  bytes" in this file would be hazard 9 — two slices, two ways to do one thing. */
export interface RenderedPayslip { employeeId: string; fileName: string; bytes: Uint8Array }

/** `typst` takes typst source and everything else takes HTML — 2C's two adapters for three ADR-0016
 *  codes, reused rather than re-decided. `engineFor` raises ERR_PRINT_ENGINE_UNSUPPORTED for a code with
 *  no adapter, and that is the error the caller surfaces (§4.5.9, ADR 0032). */
function sourceFor(engine: PrintEngineCode, rendered: RenderedReport): string {
  return engine === "typst" ? reportToTypstSource(rendered) : reportToHtmlSource(rendered);
}

export async function renderPayslip(
  definition: ReportDefinition, bundle: PayslipBundle,
  opts: { lang: ReportLang; engine: PrintEngineCode; formatters: ReportFormatters; generatedAt: string },
): Promise<RenderedPayslip> {
  const h = bundle.header;
  const rendered = renderReport(definition, bundle.rows, {
    format: "pdf", lang: opts.lang, formatters: opts.formatters, generatedAt: opts.generatedAt,
    // Every `{name}` the definition's header and footer use. `interpolate` renders an unknown name as the
    // empty string, so a missing one is a blank in a heading, never a failed render (7A's rule).
    parameters: {
      employeeNumber: h.employeeNumber, employeeNameEn: h.employeeNameEn,
      employeeNameAr: h.employeeNameAr ?? h.employeeNameEn,
      branchCode: h.branchCode, periodStart: h.periodStart, periodEnd: h.periodEnd,
      payDate: h.payDate, runKind: h.runKind, documentNumber: h.documentNumber,
      gross: h.gross, totalDeductions: h.totalDeductions, net: h.net,
    },
  });
  // EXACTLY `{ paper, dir }`. 2C freezes `PdfEngine.render(source, opts: { paper: string; dir: "ltr" |
  // "rtl" })` (2c:4440–4443) and TypeScript rejects an excess `orientation` on an object literal, so
  // passing one does not compile. There is no loss: `hr.payslip` declares `"orientation": "portrait"` and
  // `"paper": "A5"`, and a portrait A5 is what both adapters produce from `paper` alone. The two 8D
  // definitions that DO declare `"orientation": "landscape"` — `hr.payroll_register` and `hr.attendance` —
  // never reach this function: they render through 7A's `POST …/reports/{code}/runs` and the
  // `reporting.render` job, whose `ReportPdfEngine.render` takes `{ paper, orientation, dir }`
  // (7a:5670–5673). One output renders here; the rest render there; neither loses its orientation.
  const bytes = await engineFor(opts.engine).render(sourceFor(opts.engine, rendered), {
    paper: rendered.paper, dir: rendered.dir,
  });
  return {
    employeeId: h.employeeId,
    fileName: `payslip-${h.employeeNumber}-${h.periodEnd}-${opts.lang}.pdf`,
    bytes,
  };
}
```

- [ ] **Step 5: Write the route and mount it**

`packages/contracts/src/hr/payslip.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { ListEnvelope, UuidSchema } from "../common";

export const GeneratePayslipsBody = z.object({
  lang: z.enum(["en", "ar"]).default("en"),
  /** Omit for every employee of the run. An id not in the run is silently absent from the result —
   *  a payslip for an employee the run did not pay is not an error, it is nothing to print. */
  employeeIds: z.array(UuidSchema).optional(),
});

export const PayslipSchema = z.object({
  attachmentId: UuidSchema, employeeId: UuidSchema, employeeNumber: z.string(),
  fileName: z.string(), byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).openapi("Payslip");

export const GeneratePayslipsResult = ListEnvelope(PayslipSchema).openapi("GeneratePayslipsResult");
```

`apps/api/src/routes/hr/payslips.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AppError, GeneratePayslipsBody, GeneratePayslipsResult, ProblemSchema, UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { intlFormatters, parseReportDefinition } from "@dulja/domain";
import { createAttachment, payslipRows, type ObjectStore } from "@dulja/db";
import { requireFilingGenerate } from "../../hr/authorise";
import { IdempotencyHeader } from "../index";
import { PAYSLIP_ENGINE, renderPayslip } from "../../print/payslip";
import type { AppEnv } from "../../context";

/** A FACTORY — it needs `AppDeps.objectStore`, exactly as 2C's attachments module does, because the
 *  object is written BEFORE its row and the store must be swappable (MemoryObjectStore in tests). */
export function createPayslipRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();
  routes.openapi(
    createRoute({
      method: "post",
      path: "/{documentId}/payslips",
      tags: ["hr"],
      request: {
        params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: GeneratePayslipsBody } } },
      },
      middleware: [requireFilingGenerate()],           // Task 1's helper — the ONE gate on this code
      // Every status this handler can actually produce, and no status it cannot. §3.9's definition of
      // done requires the OpenAPI document to be correct when the API changes, and the generated
      // document is read by clients: a declared 422 for "the run is not posted" would describe a
      // response the route never returns, while the 409 it DOES return would be undocumented.
      responses: {
        201: { description: "One attachment per employee, with its hash",
               content: { "application/json": { schema: GeneratePayslipsResult } } },
        403: { description: "The caller does not hold hr.filing.generate (ERR_RBAC_FORBIDDEN)",
               content: { "application/problem+json": { schema: ProblemSchema } } },
        404: { description: "The hr.payslip report definition is not seeded for this company (ERR_NOT_FOUND)",
               content: { "application/problem+json": { schema: ProblemSchema } } },
        409: { description: "The run is not posted, so it has no payroll lines to print (ERR_DOC_STATUS_ILLEGAL)",
               content: { "application/problem+json": { schema: ProblemSchema } } },
        422: { description: "The ADR-0016 engine has no text adapter (ERR_PRINT_ENGINE_UNSUPPORTED, 2C)",
               content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const { companyId, documentId } = c.req.valid("param");
      const { lang, employeeIds } = c.req.valid("json");
      const generatedAt = new Date().toISOString();

      const items = await c.var.withTenant(async (tx) => {
        const bundles = await payslipRows(tx, { companyId, payrollDocumentId: documentId, employeeIds });
        if (bundles.length === 0) {
          throw new AppError("ERR_DOC_STATUS_ILLEGAL",
            `payroll run ${documentId} has no posted payroll lines, so no payslip can be produced`);
        }
        const [row] = await tx<{ definition: unknown }[]>`
          select definition from app.report_definition
           where company_id = ${companyId} and code = 'hr.payslip' and archived_at is null
           order by version desc limit 1`;
        if (!row) {
          throw new AppError("ERR_NOT_FOUND",
            "report definition hr.payslip is not seeded for this company — run `bun run seed --only reports`");
        }
        const definition = parseReportDefinition(row.definition);

        // The company's own base currency, for `intlFormatters`' money formatting. It is read here and
        // not injected, because it is a per-company fact and the route is already inside the tenant
        // transaction that can see it.
        const [company] = await tx<{ base_currency: string }[]>`
          select base_currency from app.company where id = ${companyId}`;
        if (!company) throw new AppError("ERR_NOT_FOUND", `company ${companyId} is not visible`);
        // `intlFormatters` from @dulja/domain, NOT the worker's `i18nFormatters`: that one lives in
        // apps/worker/src/reports/formatters.ts (7a:5666) and apps/api may not import an app (§3.1).
        const formatters = intlFormatters(lang, { currency: company.base_currency });

        const out: { attachmentId: string; employeeId: string; employeeNumber: string;
                     fileName: string; byteSize: number; sha256: string }[] = [];
        for (const bundle of bundles) {
          const pdf = await renderPayslip(definition, bundle,
            { lang, engine: PAYSLIP_ENGINE, formatters, generatedAt });
          // 2C's `createAttachment` is THE ONE place an attachment object and row are written
          // (2c:1239–1258): it mints the id, derives the key with `objectKeyFor` from the ids alone
          // (LEGACY-038 — never from anything the client sends), writes the object BEFORE the row, computes
          // the sha256 and returns the row. Re-implementing those four steps here would be a second
          // insert site to maintain — 3A already adds `lot_id` to that table — which is hazard 9 exactly.
          const attachment = await createAttachment(tx, c.var.ctx, objectStore, {
            companyId, documentId, fileName: pdf.fileName,
            mimeType: "application/pdf", bytes: pdf.bytes,
          });
          out.push({
            attachmentId: attachment.id, employeeId: bundle.header.employeeId,
            employeeNumber: bundle.header.employeeNumber, fileName: attachment.fileName,
            byteSize: attachment.byteSize, sha256: attachment.sha256,
          });
        }
        return out;
      });
      return c.json({ items, next_cursor: null }, 201);
    },
  );
  return routes;
}
```

In `apps/api/src/routes/index.ts`, inside `buildRoutes`, compose the sub-router onto **8B's** module and widen its `permissions` array by one code — `payroll-runs` keeps its single `PROBES` key (hazard 31):

```ts
  const payrollRuns = new OpenAPIHono<AppEnv>();
  payrollRuns.route("/", payrollRunRoutes);                       // 8B's, untouched
  payrollRuns.route("/", createPayslipRoutes(deps.objectStore));  // 8D
  // …and in the RouteModule for "/v1/companies/:companyId/payroll-runs":
  //   router: payrollRuns,
  //   permissions: [...payrollRunRouteModule.permissions, PERMISSION["hr.filing.generate"]],
```

**The engine is `PAYSLIP_ENGINE`, Step 4's named constant, and there is no reader to look for.** 2C exports `PrintEngineCode`, `PdfEngine`, `PDF_ENGINES`, `engineFor`, `PDF_MAGIC`, `closeChromium` and `TYPST_BIN` — no engine-choice function of any name (2c:4429–4470) — and its own print route takes the code off `print_template.engine` (2c:5059), a row a payslip has not got. Do **not** add a second reader, do **not** invent a `print_template` row for a `ReportDefinition`, and do **not** read an environment variable: the engine is an ADR decision, not configuration (hazard 30). **Contract addition:** `PAYSLIP_ENGINE` joins §4.5.9's paragraph in Task 0's amendment PR, beside A4.

- [ ] **Step 6: Write the route test — tests 33 and 23 re-run**

`apps/api/test/routes/hr/payslips.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { grantCodes, seedPayrollRun, seedTenantV2, type Seed } from "@dulja/db/test";
import { pdfText } from "../../../../../tests/support/pdf";
import { problemOf } from "../../../../../tests/support/api";
import {
  payrollFixture, postPayrollRun, secondApprover, type PayrollFixture,
} from "../../../../../tests/invariants/support/payroll";
import { startApi, type StartedApi } from "../../support/app";

const PERIOD = { start: "2026-01-01", end: "2026-01-31", pay: "2026-01-28" };
const DRAFT = { start: "2026-02-01", end: "2026-02-28" };

describe("POST …/payroll-runs/{documentId}/payslips — spec:2083; tests 33 and 23 re-run", () => {
  let api: StartedApi; let s: Seed; let f: PayrollFixture;
  let officer: string; let outsider: string;
  let runId: string; let draftId: string;

  beforeAll(async () => {
    api = await startApi();
    // `seedTenantV2` + `payrollFixture`, NOT 8A's `hrFixture`. BOTH fixtures seed a statutory scheme
    // whose code is `SYNTH` (8a:228, 8b:4092) and `app.statutory_scheme` is `unique (company_id, code)`
    // (8a:4248), so layering one on the other dies in `beforeAll` with a duplicate key. 8B's own route
    // test builds its corpus exactly this way (8b:5112–5118) and this file follows it.
    s = await seedTenantV2(api.db, "payslips");
    f = await payrollFixture(api.db, s);
    // `s.human` prepares and posts through `postPayrollRun`; the two codes 8D's route gates on are
    // granted explicitly because `hr.filing.generate` is Task 1's and `hr.payroll.read` is 8B's.
    await grantCodes(api.db, s, { codes: ["hr.filing.generate", "hr.payroll.read"] });
    officer = s.human;
    // An ordinary principal holding one harmless read code and NOT hr.filing.generate — the 403 case.
    outsider = await secondApprover(api.db, s, ["hr.payroll.read"]);

    // The POSTED run, through 8B's REAL path: `postPayrollRun` calculates, submits, approves as
    // `PayrollFixture.approver` — a DIFFERENT principal, which R1 requires — and posts through
    // `postDocument` (8b:4215–4230). Calling 8B's helper rather than inserting rows is what keeps this
    // test honest about what the API actually prints.
    runId = await postPayrollRun(api.db, s, f, {
      periodStart: PERIOD.start, periodEnd: PERIOD.end, payDate: PERIOD.pay,
      effectiveDate: PERIOD.end, kind: "regular",
    });
    // The draft: `seedPayrollRun` deliberately does NOT calculate or post (8b:675–681), so the document
    // stays `draft` with lines on it — the exact shape the 409 case needs. `effectiveDate` is pinned to
    // the JANUARY period end because `seedPayrollRun` hard-codes `fiscal_period_id = s.period`
    // (8b:700–705), and an accounting date outside its own period would be wrong even on a row that
    // never posts.
    draftId = await seedPayrollRun(api.db, s, {
      periodStart: DRAFT.start, periodEnd: DRAFT.end, payDate: DRAFT.end,
      effectiveDate: PERIOD.end,
      employeeIds: [f.employeeAId, f.employeeBId], kind: "regular",
    });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  const path = () => `/v1/companies/${s.company}/payroll-runs/${runId}/payslips`;

  it("produces one attachment per employee, each with its own sha256", async () => {
    const res = await api.request({ method: "POST", path: path(), as: officer,
                                    body: { lang: "en" } });
    expect(res.status).toBe(201);
    const body = await res.json() as { items: { attachmentId: string; sha256: string; byteSize: number }[] };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(new Set(body.items.map((i) => i.sha256)).size).toBe(body.items.length);
    for (const i of body.items) {
      expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(i.byteSize).toBeGreaterThan(0);
      // The stored bytes are THERE and are the bytes the hash names — not merely a truthy handle.
      const res2 = await api.request({ method: "GET", as: officer,
        path: `/v1/companies/${s.company}/attachments/${i.attachmentId}/content` });
      expect(res2.status).toBe(200);
      const bytes = new Uint8Array(await res2.arrayBuffer());
      expect(bytes.byteLength).toBe(i.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(i.sha256);
    }
  });

  it("test 33 — the rendered TEXT is identical across two generations of the same posted run", async () => {
    const a = await (await api.request({ method: "POST", path: path(), as: officer,
                                          body: { lang: "en" } })).json() as { items: { attachmentId: string }[] };
    const b = await (await api.request({ method: "POST", path: path(), as: officer,
                                          body: { lang: "en" } })).json() as { items: { attachmentId: string }[] };
    const textOf = async (id: string) => {
      const res = await api.request({ method: "GET", as: officer,
        path: `/v1/companies/${s.company}/attachments/${id}/content` });
      return (await pdfText(new Uint8Array(await res.arrayBuffer()))).join("");
    };
    // Byte-identity is NOT asserted: Chromium embeds a CreationDate (§4.5.9). The rendered-text layer is
    // where determinism is pinned, and it is where a formula change would show.
    expect(await textOf(b.items[0]!.attachmentId)).toBe(await textOf(a.items[0]!.attachmentId));
  });

  it("test 23 — the Arabic payslip renders its own labels and the same figures", async () => {
    const en = await (await api.request({ method: "POST", path: path(), as: officer,
                                          body: { lang: "en" } })).json() as { items: { attachmentId: string }[] };
    const ar = await (await api.request({ method: "POST", path: path(), as: officer,
                                          body: { lang: "ar" } })).json() as { items: { attachmentId: string }[] };
    const text = async (id: string) => {
      const res = await api.request({ method: "GET", as: officer,
        path: `/v1/companies/${s.company}/attachments/${id}/content` });
      return (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");
    };
    const [e, a] = [await text(en.items[0]!.attachmentId), await text(ar.items[0]!.attachmentId)];
    expect(e).toContain("Amount");
    expect(a).toContain("المبلغ");
    expect(a).not.toContain("Amount");
    // Digits are the same glyphs in both: §3.2 stores one figure and the renderer localises the LABELS.
    const amounts = (s: string) => (s.match(/\d+\.\d{2,4}/g) ?? []).sort();
    expect(amounts(a)).toEqual(amounts(e));
  });

  it("a principal without hr.filing.generate is refused", async () => {
    const res = await api.request({ method: "POST", path: path(), as: outsider,
                                    body: { lang: "en" } });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a draft run is refused with 409 ERR_DOC_STATUS_ILLEGAL naming the document", async () => {
    const res = await api.request({ method: "POST", as: officer, body: { lang: "en" },
      path: `/v1/companies/${s.company}/payroll-runs/${draftId}/payslips` });
    // 409 and not 422: §4.2.4 maps ERR_DOC_STATUS_ILLEGAL to 409, and the route's declared response set
    // says the same. 422 belongs to ERR_PRINT_ENGINE_UNSUPPORTED alone.
    expect(res.status).toBe(409);
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_DOC_STATUS_ILLEGAL");
    expect(p.detail).toContain(draftId);
  });

  it("the generated OpenAPI document declares exactly the statuses this route can return", () => {
    const doc = api.app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "t", version: "1" } });
    const op = (doc.paths?.["/v1/companies/{companyId}/payroll-runs/{documentId}/payslips"] as
      { post?: { responses?: Record<string, unknown> } } | undefined)?.post;
    expect(Object.keys(op?.responses ?? {}).sort()).toEqual(["201", "403", "404", "409", "422"]);
  });

  it("replaying the SAME Idempotency-Key returns the stored body, not a second set of attachments", async () => {
    const key = crypto.randomUUID();
    const first = await api.request({ method: "POST", path: path(), as: officer,
                                      body: { lang: "en" }, idempotencyKey: key });
    const second = await api.request({ method: "POST", path: path(), as: officer,
                                       body: { lang: "en" }, idempotencyKey: key });
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });
});
```

**There is no `postedRunFor` / `draftRunFor` helper pair**, and there should not be: both ids come from one `payrollFixture` and are built inline in the one `beforeAll` that owns them, which is the shape 8B's own route test uses (8b:5112–5118). A helper that re-seeded the fixture would collide with itself on `statutory_scheme (company_id, code)`.

Run: `bun run --cwd apps/api test test/routes/hr/payslips.test.ts` → PASS, 7 passing.

- [ ] **Step 7: Write ADR 0079 as a proposal**

`docs/adr/0079-payslips-are-attachments-rendered-synchronously.md` — Plan 0A's format, **Status: Proposed** (spec:95: anything touching the data model is written as a proposal and asked before implementing). Context: spec:2083 wants a payslip PDF per employee per run stored as an attachment with its hash; `JOBS` is closed at sixteen names and 8D owns one of them; 7A's renderers live in `apps/worker` and `apps/api` may not import an app. Decision: render synchronously in `apps/api` through 7A's pure layout and 2C's engine; one `app.attachment` row per employee on the PAYROLL document, `sha256` computed by the server, `object_key` derived from the ids alone; the annual statement stays on `reporting.render` because it is a year-end batch. Consequences: a fifty-employee run is one request that renders fifty small PDFs, which is bounded and observable; a regenerate produces new attachment rows rather than mutating old ones, so the historical hash of what an employee received is never overwritten (spec:2049 — HR records are archived, never deleted); if a tenant ever needs a thousand-employee run, the same code moves behind a `reporting.render` payload without changing the data model. Alternatives rejected: a new `hr.payslip.generate` job name (would reopen the closed `JOBS` registry for a request-scoped operation); rendering in `apps/worker` through `reporting.render` (the run must return the attachment ids to the officer who pressed the button, and a queued render cannot).

- [ ] **Step 8: Regenerate OpenAPI, run everything, commit**

Run: `bun run --cwd packages/contracts openapi:generate && bun run typecheck && bun run test`
Expected: PASS; the OpenAPI diff carries `Payslip`, `GeneratePayslipsResult` and the new path.

```bash
git add packages/db/seed/my/reports/8d/hr.payslip.json packages/db/src/hr/payslip.ts packages/db/src/hr/index.ts \
        packages/db/test/hr/payslip.test.ts packages/db/test/reports/hr-definitions.test.ts \
        packages/contracts/src/hr/payslip.ts packages/contracts/src/index.ts packages/contracts/openapi.json \
        apps/api/src/print/payslip.ts apps/api/src/routes/hr/payslips.ts apps/api/src/routes/index.ts \
        apps/api/test/routes/hr/payslips.test.ts docs/adr/0079-payslips-are-attachments-rendered-synchronously.md
git commit -m "feat(api): render payslips synchronously and store them as hashed attachments [8D T5]

7A's pure renderReport + 2C's engineFor; one attachment per employee on the
PAYROLL document. Test 33 is re-run at the rendered-text layer through pdfText
and test 23 in both directions. JOBS stays closed (amendment A4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: ⚠️ OD-28 — `hr.annual_statement`, the employer return, and the form names verified at build time (ISOLATED)

**Owner decision OD-28** (§2.12; spec:2077, 2083, 2086): *"§3.10.1 ⚠️ items: statutory-profile field list vs LHDN; schedule layouts; form names; proration rule."* 8A took the profile field list, 8B the proration rule, 8C the schedule layouts. **8D's share is exactly one: the form names on the annual per-employee statement and the employer return** (spec:2083 — "form names verified against LHDN at build time").

**The assumption written into this plan, and exactly what changes if the owner decides otherwise.** The statement ships with its form identifiers as **configuration, not literals**: `app.company_hr_setting.employer_registrations` (8A's jsonb map, scheme code → registration number) supplies the registration numbers, and the definition's `layout.header` and `layout.footer` interpolate two parameters, `formName` and `formYear`, that the caller supplies. **Default:** `formName` is the empty string and the header renders the statement's own `nameEn`/`nameAr` alone. **If the owner supplies verified form names**, the change is one line per name in `packages/db/seed/my/reports/8d/hr.annual_statement.json`'s `parameters[].options` array plus a value in the company's HR settings — **no migration, no code, no second definition**. **If the owner reports that a form requires a field this statement does not carry**, that is a new column on the definition and a raise against 8A's `employee_statutory_profile.extra` jsonb, not a new report code. **Hazard 2 applies in spirit**: no LHDN form identifier, submission channel, deadline or schema version appears in this plan, this definition or any test — the same rule 5B follows for MyInvois.

**Files:**
- Create: `packages/db/seed/my/reports/8d/hr.annual_statement.json`
- Modify: `packages/db/test/reports/hr-definitions.test.ts`, `apps/api/test/routes/accounting/report-runs.test.ts` (7A's — one appended case), `apps/worker/test/reports/render.test.ts` (7A's — one appended case), `docs/runbooks/payroll-parallel-run.md` (created in Task 9; if Task 9 has not run, create it with only the "Annual statements" section and Task 9 appends the rest)

**Interfaces:**
- Consumes: `readHrDefinition`, `hrReportFixture` (Task 2); `assertTieOut` and its new `employee_ytd` case (Task 4); `POST …/reports/{code}/runs`, `createReportRun`, `getReportRun`, `reportObjectKeyFor`, `seedReportDefinition` and the `reporting.render` job (7A); `startWorker` (0D); `REPO_ROOT` (§4.17.1 — from `apps/api/test/**` and `apps/worker/test/**`, the two importers that closing paragraph names); `app.company_hr_setting` (8A).
- Produces: the `hr.annual_statement` definition. No TypeScript.

- [ ] **Step 1: Owner gate — what to ask, and how to verify the answer**

**Owner provides:** the LHDN form identifiers (and the year they apply to) for (a) the annual per-employee statement of remuneration and (b) the annual employer return, together with the employer registration numbers per scheme if 8A's OD-23 task did not already receive them.

**Verify:**

```bash
bun run --cwd packages/db test test/reports/hr-definitions.test.ts -t "annual statement"
```

prints `hr.annual_statement: formName options = [<the owner's identifiers>]` from the case in Step 3, and

```bash
bun run seed --tenant "$TENANT_ID" --only reports && \
  psql "$DATABASE_URL" -c "select code, version from app.report_definition where code = 'hr.annual_statement'"
```

returns one row.

**Until provided:** the same two commands run with `formName` absent, the header renders the statement's own name, and every test in this task passes — the slice is not blocked. The one thing that cannot happen without the owner is *filing*: the statement is an internal document until its form identifier is verified, and `docs/runbooks/payroll-parallel-run.md` says so.

- [ ] **Step 2: Write the failing test**

Append to `packages/db/test/reports/hr-definitions.test.ts`:

```ts
describe("hr.annual_statement — ⚠️ OD-28, form names are configuration", () => {
  it("is a definition over employee_ytd, gated hr.payroll.read, tying to the projection", () => {
    const d = readHrDefinition("hr.annual_statement");
    expect(d.dataset.source).toBe("employee_ytd");
    expect(d.permission).toBe("hr.payroll.read");
    expect(d.tieOut).toEqual({ kind: "projection", projection: "employee_ytd" });
  });

  it("names NO form identifier, deadline, channel or schema version anywhere — hazard 2 in spirit", () => {
    const text = JSON.stringify(readHrDefinition("hr.annual_statement")).toLowerCase();
    for (const forbidden of ["lhdn", "myinvois", "e-filing", "efiling", "borang", "cp8", "ea form", "deadline"]) {
      expect(text, `the definition names ${forbidden} — OD-28 has not been answered`).not.toContain(forbidden);
    }
  });

  it("carries formName and formYear as PARAMETERS, so a verified name is a seed edit and not a code change", () => {
    const d = readHrDefinition("hr.annual_statement");
    const names = d.parameters.map((p) => p.name);
    expect(names).toContain("formName");
    expect(names).toContain("formYear");
    expect(d.parameters.find((p) => p.name === "formName")!.required).toBe(false);
    // The default: no options are enumerated until the owner supplies them (OD-28).
    // eslint-disable-next-line no-console -- the verify line of this task's owner gate reads this
    console.log(`hr.annual_statement: formName options = ${JSON.stringify(
      d.parameters.find((p) => p.name === "formName")!.options ?? [])}`);
  });

  it("its per-employee gross and net tie to app.employee_ytd row for row", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await assertTieOut(tx, readHrDefinition("hr.annual_statement"), {
        params: { companyId: s.company, taxYear: String(f.taxYear) },
        baseCurrency: MYR,
        asOf: `${f.taxYear}-12-31`,
      });
    });
  });

  it("the employer return is the SAME code with no employeeId filter — one definition, two uses", () => {
    const d = readHrDefinition("hr.annual_statement");
    // spec:2083 asks for "the annual per-employee statement AND employer return". They differ only by
    // whether an employee is named: the per-employee statement passes `employeeId`, the employer return
    // omits it and the report groups by employee. A second report CODE for the same numbers would be a
    // second thing to keep tied to the same projection (§4.16.1 keeps the register closed for exactly this).
    expect(d.dataset.filters.map((x) => x.param)).toContain("employeeId");
    expect(d.parameters.find((p) => p.name === "employeeId")!.required).toBe(false);
    expect(d.groups.map((g) => g.field)).toContain("employee_number");
  });
});
```

Run it: FAIL — `ENOENT … hr.annual_statement.json`.

- [ ] **Step 3: Write `hr.annual_statement.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "hr.annual_statement",
    "nameEn": "Annual statement of remuneration",
    "nameAr": "البيان السنوي للأجور",
    "module": "hr",
    "permission": "hr.payroll.read",
    "parameters": [
      { "name": "companyId", "kind": "text", "required": true },
      { "name": "taxYear", "kind": "text", "required": true },
      { "name": "employeeId", "kind": "text", "required": false },
      { "name": "branchId", "kind": "branch", "required": false },
      { "name": "formName", "kind": "enum", "required": false, "options": [] },
      { "name": "formYear", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "employee_ytd",
      "filters": [
        { "field": "tax_year", "op": "eq", "param": "taxYear" },
        { "field": "employee_id", "op": "eq", "param": "employeeId" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "columns": [
      { "field": "employee_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 12 },
      { "field": "employee_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start", "width": 28 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 10 },
      { "field": "gross", "labelEn": "Gross for the year", "labelAr": "إجمالي السنة", "format": "money", "align": "end", "width": 16 },
      { "field": "net", "labelEn": "Net for the year", "labelAr": "صافي السنة", "format": "money", "align": "end", "width": 16 },
      { "field": "scheme_code", "labelEn": "Scheme", "labelAr": "النظام", "format": "text", "align": "start", "width": 10 },
      { "field": "scheme_employee", "labelEn": "Employee share", "labelAr": "حصة الموظف", "format": "money", "align": "end", "width": 14 },
      { "field": "scheme_employer", "labelEn": "Employer share", "labelAr": "حصة صاحب العمل", "format": "money", "align": "end", "width": 14 }
    ],
    "groups": [{ "field": "employee_number", "subtotal": true }],
    "totals": [
      { "field": "scheme_employee", "fn": "sum" },
      { "field": "scheme_employer", "fn": "sum" }
    ],
    "sort": [{ "field": "employee_number", "dir": "asc" }, { "field": "scheme_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait", "paper": "A4",
      "header": "{title} {formName} {formYear} — {taxYear}",
      "footer": "Rebuilt nightly from posted lines and opening rows (spec:2084) — يُعاد بناؤه ليلياً من السطور المرحّلة"
    },
    "tieOut": { "kind": "projection", "projection": "employee_ytd" }
  }
}
```

**Note the two `totals` and the absence of a `gross` total.** The `employee_ytd` dataset repeats `gross` and `net` across an employee's scheme rows (Task 2), so summing either would multiply by the scheme count. The scheme shares are per-row and sum correctly; the per-employee gross and net are read from the group header, and the `employee_ytd` tie-out case (Task 4) is what proves them against the projection.

- [ ] **Step 4: Run the tests and generate one statement through the real engine**

Run: `bun run --cwd packages/db test test/reports/hr-definitions.test.ts` → PASS, **19 passing** (7 from Task 3, 6 from Task 4, 1 from Task 5 Step 3, 5 here).

Then prove the queued path end to end, because that is the mechanism spec:2083's "using the Phase 7 report engine" names. **It takes two files, not one, and the reason is §3.1**: the request side lives in `apps/api/test` and the render side in `apps/worker/test`, and neither app may import the other — 7A split its own coverage across exactly these two files for exactly this reason (7a:78).

**(a) `apps/api/test/routes/accounting/report-runs.test.ts` — one appended case.** 7A's `describe("POST /v1/companies/{companyId}/reports/{code}/runs")` already has `api`, `s` and the `post(body, as, code)` helper in scope (7a:7454–7474); this case adds its own definition and its own grant and edits nothing above it:

```ts
  it("accepts hr.annual_statement — an 8D code on 7A's unchanged route (spec:2083)", async () => {
    // The definition is read from the SHIPPED file, not restated: a copy here could drift from the seed
    // pack and the test would still pass, which is the thing §4.16.1's one-file-per-code rule prevents.
    const envelope = JSON.parse(readFileSync(
      join(REPO_ROOT, "packages/db/seed/my/reports/8d/hr.annual_statement.json"), "utf8"));
    await grantCodes(api.db, s, { codes: ["hr.payroll.read"], roleCode: "annual-8d" });
    await seedReportDefinition(api.db, s, { code: "hr.annual_statement", definition: envelope.definition });
    await api.loadPrincipals();

    const res = await post({ parameters: { taxYear: "2026" }, format: "pdf", lang: "en" },
                           s.human, "hr.annual_statement");
    expect(res.status).toBe(202);
    const body = await res.json() as { runId: string; jobId: string; statusUrl: string };
    expect(body.statusUrl).toContain(body.runId);

    // The run resource exists and is queued. Driving it to `done` is (b)'s job, in apps/worker.
    const status = await api.request({ method: "GET", path: body.statusUrl, as: s.human });
    expect(status.status).toBe(200);
    expect((await status.json() as { status: string }).status).toBe("queued");
  });
```

Add `readFileSync` (`node:fs`), `join` (`node:path`) and `REPO_ROOT` (`tests/support/source`) to that file's import block if 7A's does not already carry them — `apps/api/test/**` is one of the two importers §4.17.1's closing paragraph names.

**(b) `apps/worker/test/reports/render.test.ts` — one appended case.** 7A's file already holds `w`, `store` and `s` (7a:6890–6910); this case adds the 8D definition and drives the **real** `reporting.render` handler:

```ts
  it("renders an 8D code through the unchanged job — hr.annual_statement reaches done (spec:2083)", async () => {
    const envelope = JSON.parse(readFileSync(
      join(REPO_ROOT, "packages/db/seed/my/reports/8d/hr.annual_statement.json"), "utf8"));
    const annualId = await seedReportDefinition(w.db, s, {
      code: "hr.annual_statement", definition: envelope.definition,
    });
    const run = await withTenant(w.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() },
      (tx) => createReportRun(tx, {
        companyId: s.company, reportDefinitionId: annualId,
        parameters: { taxYear: "2026" }, format: "csv", lang: "en",
      }));
    await w.run("reporting.render",
      { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } });

    const done = await withTenant(w.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() },
      (tx) => getReportRun(tx, run.id));
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(reportObjectKeyFor(s.tenant, run.id, "csv"));
    expect(done!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // A statement over an EMPTY employee_ytd is a legitimate zero-row report, not a failure: this file's
    // seed has no payroll. What is proved here is that 7A's job accepts an 8D definition unchanged —
    // the figures are proved in packages/db, against a corpus that has them.
    expect(store.objects.get(done!.objectKey!)!.contentType).toBe("text/csv; charset=utf-8");
  });
```

Add `readFileSync`, `join` and `REPO_ROOT` to that file's imports too. **No new job, no new route, no new handler** — this is 7A's surface, exercised for an 8D code.

```bash
bun run --cwd apps/api    test test/routes/accounting/report-runs.test.ts -t "hr.annual_statement"
bun run --cwd apps/worker test test/reports/render.test.ts               -t "hr.annual_statement"
```

Expected: PASS, one case each.

- [ ] **Step 5: Write the runbook section**

`docs/runbooks/payroll-parallel-run.md`, section **"Annual statements and the employer return"** (Task 9 appends the rest of the file):

> The annual per-employee statement and the employer return are the same report code, `hr.annual_statement`, run through `POST /v1/companies/{companyId}/reports/hr.annual_statement/runs`: pass `employeeId` for one employee's statement, omit it for the employer return over every employee.
>
> **⚠️ OD-28 is not answered.** `formName` and `formYear` are parameters with no enumerated options, so the rendered header carries the statement's own name and no form identifier. Until the owner supplies the verified identifiers, **the statement is an internal document**: it reconciles to `employee_ytd` and to the ledger, and it is not a filing. When the identifiers arrive, add them to `parameters[].options` in `packages/db/seed/my/reports/8d/hr.annual_statement.json`, re-run `bun run seed --tenant <id> --only reports`, and record the source and retrieval date in the pull request exactly as a statutory rate table records its `source` (§4.12.3).
>
> Nothing in the repository states an LHDN form name, deadline, channel or schema version. That is deliberate (spec:2226, hazard 2), and a pull request that adds one without citing the authority's current publication is refused.

- [ ] **Step 6: Commit**

```bash
git add packages/db/seed/my/reports/8d/hr.annual_statement.json \
        packages/db/test/reports/hr-definitions.test.ts docs/runbooks/payroll-parallel-run.md \
        apps/api/test/routes/accounting/report-runs.test.ts \
        apps/worker/test/reports/render.test.ts
git commit -m "feat(db): add hr.annual_statement over employee_ytd; form names stay configuration [8D T6]

OD-28: formName and formYear are unenumerated parameters, so a verified
identifier is a seed edit. No LHDN form name, deadline or channel appears
anywhere (hazard 2 in spirit).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `hr.encryption_key.rotate` — the one job 8D owns, plus `HR_FIELD_ENCRYPTION_KEY_VERSION`

spec:2273 lists "the **HR field-encryption key** (§4.6, **rotated with re-encryption as a pg-boss job**)" in the v1 secret inventory, and §4.2.6's closed `JOBS` registry gives 8D exactly one name: `"hr.encryption_key.rotate": { schedule: null, owner: "8D" }`. This task registers its handler and closes 8A's one open question — where `createHrKeyRing`'s `currentVersion` comes from (amendment **A1**).

**The procedure, stated once.** Every `*_enc` value is `version(1 byte) || nonce(12) || ciphertext || tag(16)` and 8A's `openField` reads the version out of byte 0 and asks the ring for that key. Rotation is therefore: open each column under **its own** version, re-seal under `ring.current()`, and write the row back. It is **idempotent** — a row already at the current version is skipped by a `where key_version < $current` predicate — and **bounded**, because a tenant with ten thousand employees must not be one transaction (spec:1368: a handler does its work as many short `withTenant` transactions, never one long one).

**Files:**
- Create: `packages/db/src/hr/rotate.ts`, `packages/db/test/hr/rotate.test.ts`, **`apps/worker/src/hr-keys.ts`**, `apps/worker/src/jobs/hr-key-rotate.ts`, `apps/worker/test/hr/key-rotate.test.ts`, `docs/adr/0080-hr-key-rotation-procedure.md`, `docs/runbooks/hr-key-rotation.md`
- Modify: `packages/db/src/hr/index.ts`, `packages/db/src/jobs/payloads.ts`, `apps/api/src/config.ts`, **`apps/api/src/index.ts`**, `apps/worker/src/index.ts`, `apps/worker/test/support/worker.ts`, `infra/secrets.ts`, `infra/test/secrets.test.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: `HrKeyRing`, `HrKey`, `HrKeyError`, `createHrKeyRing`, `DEV_HR_KEY`, `HR_KEY_BYTES` (8A); `SENSITIVE_FIELDS`, `SensitiveField`, `sealField`, `openField`, `readSensitive`, `writeSensitive` (8A); **`ConfigError` from `@dulja/db`** (8A's `packages/db/src/hr/config-error.ts`, 8a:1241 — `packages/db`'s own class, because `apps/api/src/config.ts`'s `ConfigError` is an app's and `apps/worker` may not import an app); `JobHandler`, `JobEnvelope`, `registerHandler`, `runJob`, `systemContext`, `eachTenant` (§4.2.6, §4.2.2); `JobIsolationProbe`, `JOB_PROBES` (§4.2.6); `startWorker` (0D, §4.17.1); `containerSecrets` (0C); `readConfig`, `ApiConfig` (§4.2.3 — **`apps/api` only**).

**There is no `apps/worker` config reader, and this task builds the one the handler needs.** 0D gave the worker `apps/worker/src/index.ts` reading `process.env["DATABASE_URL"]` at the entrypoint (0d:2620) and no config module of any kind; 8A put the two HR key names on **`ApiConfig`** and on `AppDeps.hrKeys` (8a:230), and `apps/worker` may not import `apps/api` (§3.1). So this task ships `apps/worker/src/hr-keys.ts` in **exactly 7A's shape for the same problem** — 7A needed an `ObjectStore` in the worker and shipped `objectStore()` / `setObjectStore(store)` / `objectStoreFromEnv(env)` (7a:5660–5663) so `startWorker()` could inject a test instance. A memoised getter with a test setter is also what makes Step 5's test *writable*: rotating v1 → v2 requires a known previous key, which is impossible to arrange if the handler reads `process.env` itself.
- Produces:

```ts
// packages/db/src/hr/rotate.ts
export interface RotationBatch { scanned: number; rotated: number; lastEmployeeId: string | null }
export interface RotationResult { batches: number; scanned: number; rotated: number }
/** Re-seals ONE batch of employee_sensitive rows whose key_version is below the ring's current version.
 *  Opens each column under the version in its own envelope byte, so a row half-written by an earlier
 *  partial rotation is repaired rather than refused. Returns the cursor for the next batch. */
export function rotateSensitiveBatch(
  tx: Sql, ring: HrKeyRing, opts: { batchSize: number; afterEmployeeId: string | null },
): Promise<RotationBatch>;

// packages/db/src/jobs/payloads.ts — ONE key added; no other line is touched
export interface JobPayload extends Record<JobName, unknown> {
  /** Slice 8D. `batchSize` defaults to 200. Omit `companyId` to rotate every employee of the tenant. */
  "hr.encryption_key.rotate": { batchSize?: number; companyId?: string };
}

// apps/worker/src/hr-keys.ts — the worker's twin of 7A's objectStore()/setObjectStore()/objectStoreFromEnv()
export function hrKeyRing(): HrKeyRing;                        // memoised; throws ConfigError if unset
export function setHrKeyRing(ring: HrKeyRing): void;           // startWorker() and Step 5's test inject here
export function hrKeyRingFromEnv(env: NodeJS.ProcessEnv): HrKeyRing;

// apps/worker/src/jobs/hr-key-rotate.ts
export const hrKeyRotateHandler: JobHandler<"hr.encryption_key.rotate">;

// apps/api/src/config.ts — ApiConfig gains one member (amendment A1)
readonly hrFieldEncryptionKeyVersion: number;      // HR_FIELD_ENCRYPTION_KEY_VERSION, default 1
```

- [ ] **Step 1: Write the failing data-layer test**

`packages/db/test/hr/rotate.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createHrKeyRing, DEV_HR_KEY, HrKeyError, HR_KEY_BYTES } from "../../src/hr/keys";
import { readSensitive, writeSensitive } from "../../src/hr/employee-sensitive";
import { rotateSensitiveBatch } from "../../src/hr/rotate";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const KEY_V2 = randomBytes(HR_KEY_BYTES).toString("base64");
const RING_V1 = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
const RING_V2 = createHrKeyRing({ current: KEY_V2, currentVersion: 2, previous: DEV_HR_KEY, previousVersion: 1 });
const RING_V2_ONLY = createHrKeyRing({ current: KEY_V2, currentVersion: 2 });

describe("rotateSensitiveBatch — spec:2273, ADR 0080", () => {
  let db: Db; let s: Seed; let ids: string[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "hr-rotate");
    await grantCodes(db, s, { codes: ["hr.employee.read", "hr.employee.read_sensitive", "hr.employee.manage"] });
    ids = [];
    for (let i = 1; i <= 5; i += 1) ids.push(await seedEmployee(db, s, { employeeNumber: `E-30${i}` }));
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      for (const [n, id] of ids.entries()) {
        await writeSensitive(tx, RING_V1, id, {
          national_id: `SYNTH-ID-${n}`, bank_account: `SYNTH-ACC-${n}`,
          work_permit_expiry: n === 0 ? "2026-06-30" : null,
        });
      }
    });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("rotates in bounded batches and reports a cursor", async () => {
    const first = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, { batchSize: 2, afterEmployeeId: null }));
    expect(first.scanned).toBe(2);
    expect(first.rotated).toBe(2);
    expect(first.lastEmployeeId).not.toBeNull();

    let cursor = first.lastEmployeeId;
    let rotated = first.rotated;
    for (let i = 0; i < 5 && cursor !== null; i += 1) {
      const b = await withTenant(db.rw, s.tenant, s.human, (tx) =>
        rotateSensitiveBatch(tx, RING_V2, { batchSize: 2, afterEmployeeId: cursor }));
      rotated += b.rotated;
      cursor = b.lastEmployeeId;
    }
    expect(rotated).toBe(5);
  });

  it("every value round-trips under the NEW key alone, and key_version is 2", async () => {
    for (const [n, id] of ids.entries()) {
      const row = await withTenant(db.rw, s.tenant, s.human, (tx) => readSensitive(tx, RING_V2_ONLY, id));
      expect(row?.keyVersion, `employee ${n}`).toBe(2);
      expect(row?.values.national_id).toBe(`SYNTH-ID-${n}`);
      expect(row?.values.bank_account).toBe(`SYNTH-ACC-${n}`);
    }
  });

  it("a second pass is a no-op — rotation is idempotent", async () => {
    const again = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, { batchSize: 100, afterEmployeeId: null }));
    expect(again.scanned).toBe(0);
    expect(again.rotated).toBe(0);
    expect(again.lastEmployeeId).toBeNull();
  });

  it("without the PREVIOUS key the rotation refuses loudly rather than writing garbage", async () => {
    const other = await seedTenantV2(db, "hr-rotate-b");
    const id = await seedEmployee(db, other, { employeeNumber: "E-9001" });
    await grantCodes(db, other, { codes: ["hr.employee.read_sensitive", "hr.employee.manage"] });
    await withTenant(db.rw, other.tenant, other.human, (tx) =>
      writeSensitive(tx, RING_V1, id, { national_id: "SYNTH-ID-X" }));
    await expect(withTenant(db.rw, other.tenant, other.human, (tx) =>
      rotateSensitiveBatch(tx, RING_V2_ONLY, { batchSize: 10, afterEmployeeId: null })))
      .rejects.toThrow(HrKeyError);
  });

  it("a NULL column stays NULL and does not become an envelope over the empty string", async () => {
    const row = await withTenant(db.rw, s.tenant, s.human, (tx) => readSensitive(tx, RING_V2_ONLY, ids[1]!));
    expect(row?.values.work_permit_expiry ?? null).toBeNull();
  });
});
```

Run: FAIL — `Cannot find module '../../src/hr/rotate'`.

- [ ] **Step 2: Write `packages/db/src/hr/rotate.ts`**

```ts
// spec:2273 — "the HR field-encryption key (§4.6, rotated with re-encryption as a pg-boss job)".
// ADR 0080. The whole correctness argument is that this file re-uses 8A's envelope unchanged: openField
// reads the version out of byte 0 and asks the ring for THAT key, sealField writes the ring's current
// one. Nothing here parses an envelope itself, and nothing here touches node:crypto.
import type { Sql } from "postgres";
import type { HrKeyRing } from "./keys";
import { openField, sealField, SENSITIVE_FIELDS, type SensitiveField } from "./sensitive";

export interface RotationBatch { scanned: number; rotated: number; lastEmployeeId: string | null }
export interface RotationResult { batches: number; scanned: number; rotated: number }

/** `<field>_enc` — the column names are derived from the frozen SENSITIVE_FIELDS tuple, never typed
 *  twice, so a tenth field added by an amendment is rotated without editing this file. */
const COLUMN = (f: SensitiveField) => `${f}_enc`;

interface Raw { employee_id: string; key_version: number; [column: string]: unknown }

export async function rotateSensitiveBatch(
  tx: Sql, ring: HrKeyRing, opts: { batchSize: number; afterEmployeeId: string | null },
): Promise<RotationBatch> {
  const current = ring.current().version;
  // Keyset on employee_id, so a batch never re-reads a row a previous batch already advanced, and a row
  // inserted mid-rotation with the current version is simply not selected.
  const rows = await tx<Raw[]>`
    select employee_id, key_version,
           national_id_enc, passport_enc, date_of_birth_enc, residency_category_enc, bank_account_enc,
           epf_number_enc, socso_number_enc, tax_number_enc, work_permit_expiry_enc
      from app.employee_sensitive
     where key_version < ${current}
       and (${opts.afterEmployeeId}::uuid is null or employee_id > ${opts.afterEmployeeId}::uuid)
     order by employee_id
     limit ${opts.batchSize}`;
  if (rows.length === 0) return { scanned: 0, rotated: 0, lastEmployeeId: null };

  let rotated = 0;
  for (const row of rows) {
    const resealed: Partial<Record<string, Buffer | null>> = {};
    for (const field of SENSITIVE_FIELDS) {
      const sealed = row[COLUMN(field)] as Buffer | null | undefined;
      // A NULL column stays NULL. Sealing the empty string would turn "this employee has no passport"
      // into "this employee's passport is blank", which reads the same and means something else.
      if (sealed === null || sealed === undefined) { resealed[COLUMN(field)] = null; continue; }
      // The version comes from THIS value's own first byte, not from row.key_version: a partial write
      // (writeSensitive touches only the fields it is given) can leave columns at different versions,
      // and key_version records the OLDEST (ADR 0071). Opening per column repairs that; opening by the
      // row's version would throw on every column already at the current one.
      resealed[COLUMN(field)] = sealField(ring, row.employee_id, field, openField(ring, row.employee_id, field, sealed));
    }
    await tx`
      update app.employee_sensitive
         set national_id_enc            = ${resealed.national_id_enc ?? null},
             passport_enc               = ${resealed.passport_enc ?? null},
             date_of_birth_enc          = ${resealed.date_of_birth_enc ?? null},
             residency_category_enc     = ${resealed.residency_category_enc ?? null},
             bank_account_enc           = ${resealed.bank_account_enc ?? null},
             epf_number_enc             = ${resealed.epf_number_enc ?? null},
             socso_number_enc           = ${resealed.socso_number_enc ?? null},
             tax_number_enc             = ${resealed.tax_number_enc ?? null},
             work_permit_expiry_enc     = ${resealed.work_permit_expiry_enc ?? null},
             key_version                = ${current},
             updated_at                 = now()
       where employee_id = ${row.employee_id}`;
    rotated += 1;
  }
  return { scanned: rows.length, rotated, lastEmployeeId: rows[rows.length - 1]!.employee_id };
}
```

Add `export * from "./rotate";` to `packages/db/src/hr/index.ts`. Run the data-layer test → PASS, 5 passing.

**Two notes an implementer needs.** (1) `updated_by` is **not** in the `set` list: `app.stamp_actor` raises `ERR_ACTOR_IMMUTABLE` on any change to a non-null `*_by` value (plan0A), and the rotation is a mechanical re-seal by the system principal, not a new authorship of the data. The `audit_row` trigger records the system principal as the actor of the update, which is the record that is wanted. (2) The `where key_version < current` predicate is what makes the job idempotent and re-runnable after a crash; it is not an optimisation and must not be removed.

- [ ] **Step 3: Write the worker's key ring and the job handler**

`apps/worker/src/hr-keys.ts` — **new**, and modelled line for line on 7A's `apps/worker/src/object-store.ts` (7a:5660–5663), which solved the identical problem for the object store:

```ts
// apps/worker has no config module: 0D's entrypoint reads DATABASE_URL from process.env directly
// (0d:2620) and nothing else. 8A put the two HR key names on ApiConfig and on AppDeps.hrKeys (8a:230),
// and §3.1 forbids `worker` importing `api`, so the worker needs its own reader — this one.
//
// The getter/setter pair is 7A's objectStore()/setObjectStore() shape, and it exists for the same two
// reasons: the entrypoint composes the ring ONCE at boot, and a test injects a deterministic one instead
// of arranging environment variables around a running worker.
import { createHrKeyRing, ConfigError, DEV_HR_KEY, type HrKeyRing } from "@dulja/db";

let ring: HrKeyRing | null = null;

/** The composed ring. Throws rather than returning a silent default: a rotation under the wrong key
 *  writes ciphertext nobody can open, which is the one failure mode ADR 0080 refuses to risk. */
export function hrKeyRing(): HrKeyRing {
  if (ring === null) {
    throw new ConfigError("the HR key ring is not set — apps/worker/src/index.ts composes it at boot from hrKeyRingFromEnv(process.env)");
  }
  return ring;
}

export function setHrKeyRing(next: HrKeyRing): void { ring = next; }

/**
 * §3.11's three names. `HR_FIELD_ENCRYPTION_KEY_VERSION` is amendment **A1** and is **optional, default
 * 1**, so no existing environment changes; `HR_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION` is deliberately NOT
 * a name — `createHrKeyRing` derives it as `currentVersion − 1`, which is exactly what a rotation
 * produces. The key ENCODING (base64 of 32 bytes) and the dev default are 8A's and are not re-decided
 * here: `createHrKeyRing` validates both and raises `HrKeyError` on a bad length.
 */
export function hrKeyRingFromEnv(env: NodeJS.ProcessEnv): HrKeyRing {
  // Optional when APP_ENV=dev, required otherwise — 8A amendment A8's rule for this exact name
  // (8a:230), copied rather than re-decided, so the API and the worker boot on the same terms.
  const current = env["HR_FIELD_ENCRYPTION_KEY"]
    ?? (env["APP_ENV"] === "dev" ? DEV_HR_KEY : undefined);
  if (!current) {
    throw new ConfigError("HR_FIELD_ENCRYPTION_KEY is not set and APP_ENV is not dev — see the contracts document §3.11");
  }
  const raw = env["HR_FIELD_ENCRYPTION_KEY_VERSION"] ?? "1";
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new ConfigError(
      `HR_FIELD_ENCRYPTION_KEY_VERSION must be a positive integer; received "${raw}" (§3.11, 8D amendment A1)`);
  }
  const previous = env["HR_FIELD_ENCRYPTION_KEY_PREVIOUS"] ?? null;
  return createHrKeyRing({ current, currentVersion: version, previous });
}
```

In `apps/worker/src/index.ts`, beside 0D's existing `process.env` reads at the entrypoint, add `setHrKeyRing(hrKeyRingFromEnv(process.env));` — one line, in the composition root, exactly where 7A's `setObjectStore(objectStoreFromEnv(process.env))` already sits.

`apps/worker/src/jobs/hr-key-rotate.ts`:

```ts
import { rotateSensitiveBatch, withTenant, type RotationResult } from "@dulja/db";
import { systemContext } from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";
import { hrKeyRing } from "../hr-keys";

const DEFAULT_BATCH = 200;
const MAX_BATCHES = 10_000;   // 2 000 000 rows at the default size — a bound, not a business limit

/** Runs as the tenant's SYSTEM principal (spec:2179, hazard 20). `sensitive_gate` admits the system
 *  principal by construction — `app.actor_has` returns true for it (§4.1) — so the job reads and writes
 *  the rows a human without hr.employee.read_sensitive cannot see, and every write is audited under the
 *  system principal like any other job write. */
export const hrKeyRotateHandler: JobHandler<"hr.encryption_key.rotate"> = async (sql, job) => {
  // The ring is COMPOSED AT BOOT and read here, never assembled per job: a handler that built its own
  // ring from the environment could not be given a deterministic one by a test, and Step 5's whole point
  // is to rotate v1 → v2 with a known previous key.
  const ring = hrKeyRing();
  const batchSize = job.payload.batchSize ?? DEFAULT_BATCH;
  const result: RotationResult = { batches: 0, scanned: 0, rotated: 0 };
  let cursor: string | null = null;

  // MANY SHORT transactions, never one long one (spec:1368). A ten-thousand-employee tenant must not
  // hold one transaction open for the whole rotation, and a crash halfway leaves every completed batch
  // committed — which is exactly why the predicate makes a re-run a no-op over them.
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const ctx = await systemContext(sql, job.tenantId, job.requestId);
    const batch = await withTenant(sql, ctx, (tx) =>
      rotateSensitiveBatch(tx, ring, { batchSize, afterEmployeeId: cursor }));
    result.batches += 1;
    result.scanned += batch.scanned;
    result.rotated += batch.rotated;
    if (batch.lastEmployeeId === null) break;
    cursor = batch.lastEmployeeId;
  }
  // No key material and no employee identifier reaches the log — `forbidden-log-fields` would drop a
  // field named `secret` or `key`, and a plain count tells the operator what they need.
  log().info({ tenant_id: job.tenantId, request_id: job.requestId, ...result,
               key_version: ring.current().version }, "hr_key_rotation_complete");
};
```

In `apps/worker/src/index.ts` add `registerHandler("hr.encryption_key.rotate", hrKeyRotateHandler);` beside the existing registrations, and the same line to `apps/worker/test/support/worker.ts` so `startWorker()` can drive it. **`startWorker()` also composes a dev ring** — one line beside 0D's existing setup, `setHrKeyRing(createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }))`, so every worker test that does not care about keys still boots; Step 5's test replaces it with `setHrKeyRing` before it enqueues.

**Do not reach for `readConfig()` from `apps/api`** (§3.1 forbids an app importing an app), and **do not read `process.env` inside the handler** — the composition root reads it once, which is what makes the handler testable and what 7A's object store already establishes as the pattern.

- [ ] **Step 4: Add the payload key, the config member and the probe**

`packages/db/src/jobs/payloads.ts` — **one key, no other line touched** (§4.2.6's rule):

```ts
  /** Slice 8D. `batchSize` defaults to 200; `companyId` is accepted and reserved for a future
   *  per-company rotation and is not read by the current handler, which rotates the whole tenant. */
  "hr.encryption_key.rotate": { batchSize?: number; companyId?: string };
```

`apps/api/src/config.ts` — amendment **A1**, beside 8A's two HR members:

```ts
  readonly hrFieldEncryptionKeyVersion: number;      // HR_FIELD_ENCRYPTION_KEY_VERSION; optional, default 1
```

```ts
// inside readConfig(), after 8A's hrKey branch:
const rawVersion = env.HR_FIELD_ENCRYPTION_KEY_VERSION ?? "1";
const hrKeyVersion = Number(rawVersion);
if (!Number.isInteger(hrKeyVersion) || hrKeyVersion < 1) {
  throw new ConfigError(
    `HR_FIELD_ENCRYPTION_KEY_VERSION must be a positive integer; received "${rawVersion}" (§3.11, 8D amendment A1)`);
}
// …and on the object `readConfig` returns, beside 8A's two HR members:
  hrFieldEncryptionKeyVersion: hrKeyVersion,
```

**`apps/api/src/index.ts` — the one line that closes 8A's open question, and the one this task must not forget.** 8A's Self-Review (8a:6951) says the composition root passes a hard-coded `1` to `createHrKeyRing`, "until 8D". If the worker starts re-sealing under v2 while the API keeps sealing new writes under v1, the two halves of the system disagree about the current key and every row written after the rotation is immediately stale. So in `apps/api/src/index.ts`, where `createHrKeyRing({ current: config.hrFieldEncryptionKey, currentVersion: 1, previous: config.hrFieldEncryptionKeyPrevious })` stands, replace the literal:

```ts
  hrKeys: createHrKeyRing({
    current: config.hrFieldEncryptionKey,
    currentVersion: config.hrFieldEncryptionKeyVersion,   // was the literal 1 (8a:6951) — amendment A1
    previous: config.hrFieldEncryptionKeyPrevious,
  }),
```

Nothing else in that file changes, and no environment changes either: `HR_FIELD_ENCRYPTION_KEY_VERSION` is optional and defaults to `1`, which is the value the literal held.

`infra/secrets.ts` — add `HR_FIELD_ENCRYPTION_KEY_VERSION` to the environment `containerSecrets(env, entrypoint)` assembles for **both** `api` and `worker`, optional like `HR_FIELD_ENCRYPTION_KEY_PREVIOUS`, and update the two expectations in `infra/test/secrets.test.ts`.

`tests/invariants/probes.ts` — one `JOB_PROBES` entry, in the shape §4.2.6 fixes:

```ts
  "hr.encryption_key.rotate": {
    async seed(db, attacker, victim) {
      // The victim's sensitive row is what must survive the attacker's rotation untouched.
      const employeeId = await seedEmployee(db, victim, { employeeNumber: "E-PROBE" });
      await withTenant(db.rw, victim.tenant, victim.human, (tx) =>
        writeSensitive(tx, PROBE_RING_V1, employeeId, { national_id: "SYNTH-PROBE" }));
      void attacker;
    },
    async survivors(db, victim) {
      const [row] = await withTenant(db.rw, victim.tenant, victim.human, (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.employee_sensitive where key_version = 1`);
      return row!.n;                     // still 1: the attacker's tenant rotation never reached it
    },
  },
```

- [ ] **Step 5: Write the worker test**

`apps/worker/test/hr/key-rotate.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createHrKeyRing, DEV_HR_KEY, HR_KEY_BYTES, readSensitive, withTenant, writeSensitive } from "@dulja/db";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "@dulja/db/test";
import { setHrKeyRing } from "../../src/hr-keys";
import { startWorker, type StartedWorker } from "../support/worker";

const KEY_V2 = randomBytes(HR_KEY_BYTES).toString("base64");
const RING_V1 = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
const RING_V2 = createHrKeyRing({ current: KEY_V2, currentVersion: 2, previous: DEV_HR_KEY });
const RING_V2_ONLY = createHrKeyRing({ current: KEY_V2, currentVersion: 2 });

const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() });

describe("the hr.encryption_key.rotate job — spec:2273, ADR 0080, hazard 20", () => {
  let w: StartedWorker;
  let a: Seed; let b: Seed;
  let aIds: string[]; let bId: string;

  beforeAll(async () => {
    w = await startWorker();
    // The ring the HANDLER will read. Injected, not environment-set: this is the whole reason
    // apps/worker/src/hr-keys.ts is a getter/setter pair rather than a process.env read (Step 3).
    setHrKeyRing(RING_V2);

    a = await seedTenantV2(w.db, "rotate-a");
    b = await seedTenantV2(w.db, "rotate-b");
    for (const s of [a, b]) {
      await grantCodes(w.db, s, { codes: ["hr.employee.read", "hr.employee.read_sensitive", "hr.employee.manage"] });
    }
    aIds = [
      await seedEmployee(w.db, a, { employeeNumber: "E-5001" }),
      await seedEmployee(w.db, a, { employeeNumber: "E-5002" }),
    ];
    bId = await seedEmployee(w.db, b, { employeeNumber: "E-5003" });

    // Everything is sealed under v1 first, so the rotation has something to move.
    await withTenant(w.db.rw, ctx(a), async (tx) => {
      for (const [n, id] of aIds.entries()) {
        await writeSensitive(tx, RING_V1, id, { national_id: `SYNTH-A-${n}`, bank_account: `SYNTH-ACC-${n}` });
      }
    });
    await withTenant(w.db.rw, ctx(b), (tx) => writeSensitive(tx, RING_V1, bId, { national_id: "SYNTH-B-0" }));
  }, 300_000);
  afterAll(async () => { await w.stop(); });

  it("rotates every row of the enqueued tenant to key_version 2, in batches of one", async () => {
    await w.run("hr.encryption_key.rotate",
      { tenantId: a.tenant, requestId: crypto.randomUUID(), payload: { batchSize: 1 } });

    for (const [n, id] of aIds.entries()) {
      // Read back under the NEW key ALONE: if any column were still sealed under v1, `openField` would
      // ask the ring for a key it does not carry and throw. Passing is the round trip.
      const row = await withTenant(w.db.rw, ctx(a), (tx) => readSensitive(tx, RING_V2_ONLY, id));
      expect(row?.keyVersion, `employee ${n}`).toBe(2);
      expect(row?.values.national_id).toBe(`SYNTH-A-${n}`);
      expect(row?.values.bank_account).toBe(`SYNTH-ACC-${n}`);
    }
  });

  it("leaves the OTHER tenant's row at key_version 1 — the job is tenant-scoped (test 12's shape)", async () => {
    const row = await withTenant(w.db.rw, ctx(b), (tx) => readSensitive(tx, RING_V1, bId));
    expect(row?.keyVersion).toBe(1);
    expect(row?.values.national_id).toBe("SYNTH-B-0");
  });

  it("logs one hr_key_rotation_complete line with the counts and the new version", () => {
    const line = w.logs.find((l) => l.msg === "hr_key_rotation_complete");
    expect(line, "the handler logs exactly one completion line").toBeDefined();
    expect(line).toMatchObject({ tenant_id: a.tenant, rotated: 2, scanned: 2, key_version: 2 });
    expect(Number(line!["batches"])).toBeGreaterThanOrEqual(2);   // batchSize 1 over two rows
  });

  it("puts no key material and no secret-shaped field name in the log (forbidden-log-fields' runtime twin)", () => {
    for (const line of w.logs) {
      for (const key of Object.keys(line)) {
        expect(key, `${key} is a forbidden log field (§4.2.3)`).not.toMatch(/token|password|authorization|card|pin|secret/i);
      }
      // And no VALUE is a 32-byte base64 blob, which is what a leaked key would look like.
      for (const value of Object.values(line)) {
        if (typeof value === "string") expect(value).not.toBe(KEY_V2);
      }
    }
  });

  it("a second run is a no-op — the key_version < current predicate makes it idempotent", async () => {
    const before = w.logs.length;
    await w.run("hr.encryption_key.rotate",
      { tenantId: a.tenant, requestId: crypto.randomUUID(), payload: {} });
    const line = w.logs.slice(before).find((l) => l.msg === "hr_key_rotation_complete");
    expect(line).toMatchObject({ rotated: 0, scanned: 0 });
  });
});
```

`StartedWorker.logs` is 0D's captured-log array (§4.17.1's `startWorker()` row: `{ db, boss, jobs, logs, run, stop }`); if the merged shape names it differently, use that name and record the divergence in the Self-Review — do **not** add a second log capture.

Run: `bun run --cwd apps/worker test test/hr/key-rotate.test.ts` → PASS, 5 passing.

- [ ] **Step 6: Write ADR 0080 (a proposal) and the runbook**

`docs/adr/0080-hr-key-rotation-procedure.md` — **Status: Proposed** (spec:95: security). Context: spec:2273 requires the HR field-encryption key to be rotated with re-encryption as a pg-boss job; 8A's envelope stamps a version in byte 0 and `key_version` records the oldest version any column of a row still carries. Decision: rotation opens **per column** under that column's own byte-0 version and re-seals under the ring's current key; it runs as the tenant's system principal in bounded keyset batches with a `key_version < current` predicate that makes it idempotent; the operator supplies the new key as `HR_FIELD_ENCRYPTION_KEY`, the old as `HR_FIELD_ENCRYPTION_KEY_PREVIOUS`, and the new version as `HR_FIELD_ENCRYPTION_KEY_VERSION`; the previous key may be retired only after the job reports `rotated` equal to `scanned` and a subsequent run reports `scanned: 0`. Consequences: a crash mid-rotation is safe and a re-run is a no-op over completed rows; retiring `…_PREVIOUS` too early makes un-rotated rows unreadable, which is why the runbook's last step is a verification query and not a calendar reminder. Alternatives rejected: rotating inside one transaction (unbounded lock on a tenant's whole HR table); rotating on read (a read path that writes is a surprise, and a row never read is never rotated).

`docs/runbooks/hr-key-rotation.md`: (1) generate 32 random bytes and base64 them; (2) set `HR_FIELD_ENCRYPTION_KEY` to the new value, `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` to the current one, and `HR_FIELD_ENCRYPTION_KEY_VERSION` to the current version **plus one**, as Cloudflare secret bindings; (3) deploy — the API and worker now write new values under the new key and read old ones under the previous; (4) enqueue `hr.encryption_key.rotate` per tenant; (5) verify with `select key_version, count(*) from app.employee_sensitive group by 1` under a tenant session — one row, the new version; (6) only then remove `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` and redeploy. Each step carries its exact command, and step 5 is the gate on step 6.

- [ ] **Step 7: Run everything and commit**

Run: `bun run typecheck && bun run test && bun run lint:rules`
Expected: PASS; the tenant-isolation harness now finds a `JOB_PROBES` entry for the newly registered handler and stops skipping it.

```bash
git add packages/db/src/hr/rotate.ts packages/db/src/hr/index.ts packages/db/test/hr/rotate.test.ts \
        packages/db/src/jobs/payloads.ts apps/api/src/config.ts apps/api/src/index.ts \
        apps/worker/src/hr-keys.ts apps/worker/src/jobs/hr-key-rotate.ts \
        apps/worker/src/index.ts apps/worker/test/support/worker.ts apps/worker/test/hr/key-rotate.test.ts \
        infra/secrets.ts infra/test/secrets.test.ts tests/invariants/probes.ts \
        docs/adr/0080-hr-key-rotation-procedure.md docs/runbooks/hr-key-rotation.md
git commit -m "feat(worker): rotate the HR field-encryption key as a bounded, idempotent job [8D T7]

Opens each column under its own envelope version and re-seals under the ring's
current key, in keyset batches, as the tenant's system principal.
HR_FIELD_ENCRYPTION_KEY_VERSION joins §3.11 (amendment A1), closing 8A's one
open question about where currentVersion comes from.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: ⚠️ OD-13 — the leave register (ISOLATED; dropped whole if the owner says no)

**Owner decision OD-13** (§2.12; spec:1060, 2085, 2478; Part VII #14): *"Leave — ⚠️ **only if the owner confirms.** … If the owner wants leave in Dulja, the minimal register is `leave_type` (annual, sick, unpaid, other), a yearly `leave_entitlement` per employee entered by HR (no accrual engine), `leave_record` approved by a different principal, and public holidays per company and branch. (The judge panel scored this as scope a 30-person distributor may not need; it is a §5.3 owner question, not a default.)"*

**This task discharges OD-05's 8D row too.** §2.12's OD-05 ("confirmation of every ⚠️ row in §3.0.3 and §3.0.4") reaches 8D through exactly one row — spec:1060 "Attendance events; leave ⚠️" — and that ⚠️ is this one. There is no second task for it.

**The assumption written into this plan: not built.** Nothing in Tasks 0–7 or 9–12 imports a leave name, and dropping this task leaves the slice green with `DATASET_IDS` at 34, `PERMISSIONS` holding one 8D code and migrations 0096 and 0099 unused. **If the owner says yes**, this task creates all of it or none: one migration, one `permissions.ts` hunk, one dataset member, one route module, one `PROBES` key, one contracts module and five test files. **If the owner says no**, delete this task and change nothing else — that is what amendment **A9** (the two `hr.leave.*` rows live in 0096, not 0097) buys.

**Unpaid leave does not depend on this decision.** spec:2085's first sentence — "Unpaid leave enters payroll as a **quantity** on the unpaid-leave deduction component" — is 8B's, already shipped, and works whether or not a register exists. This task adds a *record*, never a pay input, exactly as `attendance_event` is a record (spec:2089).

**Files:**
- Create: `packages/db/migrations/0096_create_leave_register.sql`, `packages/db/migrations/0096.down.sql`, `packages/db/src/schema/leave-type.ts`, `…/leave-entitlement.ts`, `…/leave-record.ts`, `…/public-holiday.ts`, `packages/db/src/hr/leave.ts`, `packages/db/test/hr/leave.test.ts`, `packages/contracts/src/hr/leave.ts`, `apps/api/src/routes/hr/leave.ts`, `apps/api/test/routes/hr/leave.test.ts`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`, `packages/db/src/reports/datasets/hr.ts`, `packages/db/src/reports/datasets.ts`, `packages/db/src/hr/index.ts`, `packages/db/test/reports/hr-datasets.test.ts`, **`packages/db/test/reports/datasets.test.ts` (7A's pin, 34 → 35)**, **`packages/db/test/reports/7c-datasets.test.ts` (7C's pin, 34 → 35)**, `packages/db/test/permission-catalogue.test.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_in_branch` (6C), `app.forbid_self_pay()` (8A, Task 1 of that slice), `app.current_actor`, `uuidv7` (§4.1); `defineDataset`, `Dataset`, `DatasetColumn` (7A); `requirePermission`, `PERMISSION` (§4.2.5); `RouteModule`, `IdempotencyHeader`, `buildRoutes` (§4.2.7); `IsolationProbe`, `PROBES` (§4.2.7); `grantCodes`, `seedEmployee` (§4.17); `hrFixture`, `hrActor` (8A).
- Produces: `app.leave_type`, `app.leave_entitlement`, `app.leave_record`, `app.public_holiday`; `hr.leave.record` and `hr.leave.approve`; `leaveRecordDataset` (the sixth `DatasetId`); the four Drizzle mirrors `leaveType` / `leaveEntitlement` / `leaveRecord` / `publicHoliday`; `packages/db/src/hr/leave.ts`'s ten functions — `requestLeave`, `approveLeave`, `rejectLeave`, `listLeaveRecords`, `setEntitlement`, `listEntitlements`, `createLeaveType`, `listLeaveTypes`, `createPublicHoliday`, `listPublicHolidays` — with `RequestLeaveInput`, `SetEntitlementInput`, `LeaveRecordFilter`, `LeaveRecordRow`, `CreateLeaveTypeInput`, `LeaveTypeRow`, `LeaveTypeFilter`, `LeaveEntitlementRow`, `LeaveEntitlementFilter`, `CreatePublicHolidayInput`, `PublicHolidayRow`, `PublicHolidayFilter`; `leaveRoutes` / `leaveRouteModule` at `/v1/companies/:companyId/leave-records`, carrying **seven** routes (`POST /`, `GET /`, `POST /{leaveRecordId}/decision`, `GET|POST /types`, `GET|PUT /entitlements`, `GET|POST /holidays`); `packages/contracts/src/hr/leave.ts`.

- [ ] **Step 1: Owner gate — what to ask, and how to verify the answer**

**Owner provides:** a yes or no to *"do you want leave requests, entitlements and public holidays recorded in Dulja, or do leave records stay where they are kept today?"* (Part VII #14), and, if yes, the four leave-type labels their business uses beyond the spec's `annual | sick | unpaid | other`.

**Verify:**

```bash
bun run --cwd packages/db db:migrate && \
bun run --cwd packages/db test test/hr/leave.test.ts && \
bun run --cwd packages/db test test/reports/hr-datasets.test.ts -t "thirty-five"
```

prints `35` for `DATASET_IDS.length` and 8 passing leave cases.

**Until provided:** this task does not run. Every other task in this plan is green without it, and the verification for "no" is the same three commands **absent**: `listApplied()` does not contain 96, `DATASET_IDS` has 34 members, and `PERMISSIONS.filter(p => p.phase === "8D")` is exactly `["hr.filing.generate"]` — which Task 1's test already asserts, so the "no" branch is already tested.

- [ ] **Step 2: Write the failing data-layer test**

`packages/db/test/hr/leave.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src";
import { approveLeave, requestLeave } from "../../src/hr/leave";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("the leave register — ⚠️ OD-13, spec:2085", () => {
  let db: Db; let s: Seed; let employeeId: string; let selfEmployeeId: string;
  let annualTypeId: string; let approver: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "leave");
    await grantCodes(db, s, { codes: ["hr.employee.read", "hr.employee.manage", "hr.leave.record", "hr.leave.approve"] });
    employeeId = await seedEmployee(db, s, { employeeNumber: "E-4001" });
    // The requester IS this employee, which is what makes the R4 case non-vacuous (spec:2175).
    selfEmployeeId = await seedEmployee(db, s, { employeeNumber: "E-4002", principalId: s.human });
    approver = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
               values (${approver}, ${s.tenant}, 'human', ${`stub:approver-${approver}`}, 'Approver')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${approver})
               on conflict do nothing`;
      const [t] = await tx<{ id: string }[]>`
        insert into app.leave_type (tenant_id, company_id, code, name_en, name_ar, paid)
        values (${s.tenant}, ${s.company}, 'annual', 'Annual leave', 'إجازة سنوية', true) returning id`;
      annualTypeId = t!.id;
      await tx`insert into app.leave_entitlement (tenant_id, company_id, employee_id, year, leave_type_id, days)
               values (${s.tenant}, ${s.company}, ${employeeId}, 2026, ${annualTypeId}, 14.00)`;
    });
    await grantCodes(db, s, { codes: ["hr.leave.approve"], principalId: approver, roleCode: "leave-approver" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the four tables carry the standard set and the linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a record starts `requested` with approved_by NULL, and the entitlement is not consumed by it", async () => {
    const id = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      requestLeave(tx, { companyId: s.company, employeeId, leaveTypeId: annualTypeId,
                         startsOn: "2026-04-01", endsOn: "2026-04-03", days: "3.00", reason: "family" }));
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ status: string; approved_by: string | null }[]>`
        select status, approved_by from app.leave_record where id = ${id}`);
    expect(row!.status).toBe("requested");
    expect(row!.approved_by).toBeNull();
  });

  it("R4 — a principal cannot approve their OWN leave (ERR_HR_SELF_PAY, spec:2175, test 31)", async () => {
    const id = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      requestLeave(tx, { companyId: s.company, employeeId: selfEmployeeId, leaveTypeId: annualTypeId,
                         startsOn: "2026-05-01", endsOn: "2026-05-02", days: "2.00", reason: "personal" }));
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => approveLeave(tx, id)))
      .rejects.toThrow(/ERR_HR_SELF_PAY/);
    // …and a DIFFERENT principal succeeds, which is what makes the refusal about the actor and not the row.
    await withTenant(db.rw, s.tenant, approver, (tx) => approveLeave(tx, id));
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ status: string; approved_by: string }[]>`select status, approved_by from app.leave_record where id = ${id}`);
    expect(row!.status).toBe("approved");
    expect(row!.approved_by).toBe(approver);          // stamped on the NULL → value transition
  });

  it("approved_by is stamped by the server and cannot be supplied or changed (LEGACY-044)", async () => {
    const id = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      requestLeave(tx, { companyId: s.company, employeeId, leaveTypeId: annualTypeId,
                         startsOn: "2026-06-01", endsOn: "2026-06-01", days: "1.00", reason: null }));
    // A supplied value on the approving UPDATE is overwritten with the session actor, never trusted.
    await withTenant(db.rw, s.tenant, approver, (tx) =>
      tx`update app.leave_record set status = 'approved', approved_by = ${s.human} where id = ${id}`);
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ approved_by: string }[]>`select approved_by from app.leave_record where id = ${id}`);
    expect(row!.approved_by).toBe(approver);
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.leave_record set approved_by = ${s.human} where id = ${id}`))
      .rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);
  });

  it("a company-wide public holiday has a NULL branch and both forms are visible to their branch", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.public_holiday (tenant_id, company_id, branch_id, holiday_on, name_en, name_ar)
      values (${s.tenant}, ${s.company}, null, '2026-08-31', 'National day', 'اليوم الوطني'),
             (${s.tenant}, ${s.company}, ${s.hq}, '2026-09-16', 'Branch holiday', 'عطلة الفرع')`);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.public_holiday where company_id = ${s.company}`);
    expect(rows[0]!.n).toBe(2);
  });

  it("a SECOND company-wide holiday on the same date is refused — `nulls not distinct`", async () => {
    // Without the clause Postgres reads the two NULL branch_ids as distinct and accepts the duplicate,
    // which is the one thing this constraint is for.
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.public_holiday (tenant_id, company_id, branch_id, holiday_on, name_en, name_ar)
      values (${s.tenant}, ${s.company}, null, '2026-08-31', 'National day again', 'اليوم الوطني مكرر')`))
      .rejects.toThrow(/ERR_CONFLICT_UNIQUE|duplicate key/);
  });

  it("a second tenant sees none of the four tables' rows (spec:106)", async () => {
    const other = await seedTenantV2(db, "leave-b");
    for (const table of ["leave_type", "leave_entitlement", "leave_record", "public_holiday"] as const) {
      const rows = await withTenant(db.rw, other.tenant, other.human, (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.${tx(table)}`);
      expect(rows[0]!.n, table).toBe(0);
    }
  });

  it("every write is audited under the acting principal (test 13's re-run)", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ table_name: string; n: number }[]>`
        select table_name, count(*)::int as n from app.audit_log
         where table_name in ('leave_type','leave_entitlement','leave_record','public_holiday')
         group by table_name order by table_name`);
    expect(rows.map((r) => r.table_name)).toEqual(
      ["leave_entitlement", "leave_record", "leave_type", "public_holiday"]);
  });
});
```

Run: FAIL — `relation "app.leave_type" does not exist`.

- [ ] **Step 3: Write migration 0096**

`packages/db/migrations/0096_create_leave_register.sql`:

```sql
-- 0096_create_leave_register.sql — ⚠️ OD-13. spec:2085's minimal register: leave_type, a yearly
-- leave_entitlement entered by HR (NO accrual engine), leave_record approved by a DIFFERENT principal
-- (R4, spec:2175), and public holidays per company and branch. It is a record, never a pay input:
-- unpaid leave reaches payroll as a QUANTITY on 8B's unpaid-leave deduction component (spec:2085).
--
-- This file also inserts the two hr.leave.* permission rows (8D amendment A9). §3.6.3 normally puts a
-- slice's codes in its NNNN_seed_permission_phase<slice>.sql, and 0097 does exactly that for
-- hr.filing.generate. These two are different: permission-catalogue.test.ts compares app.permission
-- with permissions.ts in BOTH directions, so a leave code seeded while OD-13 is unanswered would fail
-- the build with no table to gate. One file, one task, dropped whole.

-- ── 1. leave_type — the vocabulary, per company (spec:2085) ────────────────────
create table app.leave_type (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  code          text not null check (code in ('annual', 'sick', 'unpaid', 'other')),
  name_en       text not null,
  name_ar       text,
  paid          boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.leave_type');
call app_meta.attach_audit('app.leave_type');

-- ── 2. leave_entitlement — a yearly figure ENTERED by HR; there is no accrual engine ──
create table app.leave_entitlement (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  employee_id    uuid not null,
  year           smallint not null check (year between 2000 and 2200),
  leave_type_id  uuid not null,
  days           numeric(6,2) not null check (days >= 0),
  entered_by     uuid not null default app.current_actor() references app.principal(id),
  created_at     timestamptz not null default now(),
  unique (employee_id, year, leave_type_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)    references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id)   references app.employee(tenant_id, id),
  foreign key (tenant_id, leave_type_id) references app.leave_type(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.leave_entitlement');
call app_meta.attach_audit('app.leave_entitlement');
call app_meta.attach_stamp('app.leave_entitlement', 'entered_by');

-- ── 3. leave_record — approved by a DIFFERENT principal (R4, spec:2175; test 31) ──
create table app.leave_record (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  employee_id    uuid not null,
  leave_type_id  uuid not null,
  starts_on      date not null,
  ends_on        date not null,
  days           numeric(6,2) not null check (days > 0),
  status         text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  -- NULL while `requested`; app.stamp_actor stamps the NULL → value transition with the session actor
  -- and raises ERR_ACTOR_IMMUTABLE on any later change (plan0A). A supplied value is never trusted.
  approved_by    uuid references app.principal(id),
  reason         text,
  created_at     timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (status = 'requested' or approved_by is not null),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)    references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id)   references app.employee(tenant_id, id),
  foreign key (tenant_id, leave_type_id) references app.leave_type(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.leave_record');
call app_meta.attach_audit('app.leave_record');
call app_meta.attach_stamp('app.leave_record', 'approved_by');

-- R4 (spec:2175): "a principal cannot alter their own compensation, sensitive data or LEAVE APPROVAL".
-- 8A's app.forbid_self_pay() is the shared implementation; it raises ERR_HR_SELF_PAY when the acting
-- principal is the employee the row belongs to. Attaching it here rather than writing a fourth copy is
-- what keeps one rule in one place (8A Task 1 created the function for exactly this).
create trigger leave_record_no_self_approve
  before insert or update of status, approved_by on app.leave_record
  for each row when (new.status = 'approved')
  execute function app.forbid_self_pay('employee_id');

create index leave_record_employee_period_idx on app.leave_record (company_id, employee_id, starts_on);

-- ── 4. public_holiday — per company AND branch; a NULL branch means every branch ──
create table app.public_holiday (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  branch_id    uuid,                                   -- NULL = company-wide (spec:2085)
  holiday_on   date not null,
  name_en      text not null,
  name_ar      text,
  created_at   timestamptz not null default now(),
  -- `nulls not distinct` is load-bearing and not decoration. Postgres treats NULLs as DISTINCT in a
  -- unique constraint by default, so a plain `unique (company_id, branch_id, holiday_on)` accepts TWO
  -- company-wide holidays on the same date — exactly the duplicate this constraint exists to refuse, and
  -- exactly the row this task's own test seeds. The clause is PostgreSQL 15+ and Plan 0A is on 18.
  unique nulls not distinct (company_id, branch_id, holiday_on),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.public_holiday');
call app_meta.attach_audit('app.public_holiday');

-- §4.5.6 Form B for a NULLABLE branch key (8D amendment A8): NULL means every branch, so the policy
-- must admit it or a company-wide holiday would be invisible to everyone. 6C's branch_isolation_policy
-- linter rule fires on any branch_id column, and §3.5.3 grants this table no exemption.
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname = 'actor_in_branch') then
    execute 'create policy branch_isolation on app.public_holiday as restrictive
               using (branch_id is null or app.actor_in_branch(company_id, branch_id))';
  end if;
end $$;

-- ── 5. the two ⚠️ permission codes (amendment A9) ──────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('hr.leave.record',  'hr', true, 'Record a leave request, an entitlement, a leave type or a public holiday'),
  ('hr.leave.approve', 'hr', true, 'Approve or reject a leave record for someone other than oneself')
on conflict (code) do update
   set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

`packages/db/migrations/0096.down.sql`:

```sql
-- Reverse dependency order (§3.4.5). `drop table` removes the table's own triggers and policies; the
-- permission rows are deleted explicitly because app.permission is global and outlives this file.
delete from app.role_permission where permission_code in ('hr.leave.record', 'hr.leave.approve');
delete from app.permission       where code            in ('hr.leave.record', 'hr.leave.approve');
drop table if exists app.public_holiday;
drop table if exists app.leave_record;
drop table if exists app.leave_entitlement;
drop table if exists app.leave_type;
```

**`app.forbid_self_pay('employee_id')` takes the column name as a trigger argument.** 8A's Task 1 created it that way precisely so `compensation_line`, `employee_sensitive`, `employee_statutory_profile`, `employee.terminated_on` and this table could all attach the one function. If 8A's shipped signature differs — a per-table function rather than an argument — attach whatever 8A shipped and raise the divergence in the Self-Review; **do not write a fifth self-approval check.**

- [ ] **Step 4: Write the service, the mirrors, the catalogue rows and the dataset**

`packages/db/src/hr/leave.ts` — each function is a single `postgres.js` tagged template inside the caller's `tx`. **No business rule is implemented in TypeScript**: R4 is the trigger, the status vocabulary is the CHECK, the approver is `app.stamp_actor`, and the tenant is RLS.

```ts
// ⚠️ OD-13. spec:2085's minimal register, as SQL and nothing else. Every rule this file appears to
// enforce is enforced one layer down — that is the point, and it is why there is no `if` in it:
//   · a principal may not approve their own leave     → the leave_record_no_self_approve trigger (0096)
//   · status ∈ requested | approved | rejected         → the CHECK constraint (0096)
//   · a decided record names its decider               → the CHECK + app.stamp_actor (0096)
//   · another tenant sees nothing                      → RLS (app_meta.enable_tenant_rls)
import type { Sql } from "postgres";

export interface RequestLeaveInput {
  companyId: string; employeeId: string; leaveTypeId: string;
  startsOn: string; endsOn: string; days: string; reason: string | null;
}
export interface SetEntitlementInput {
  companyId: string; employeeId: string; year: number; leaveTypeId: string; days: string;
}
export interface LeaveRecordFilter {
  companyId: string;
  /** One record by id. It is what BOTH write routes read back with, so a handler returns the row it
   *  just wrote and never "whatever sorted first". Absent = every record the other filters admit. */
  id?: string;
  employeeId?: string; status?: "requested" | "approved" | "rejected";
  fromDate?: string; toDate?: string; limit: number;
}
export interface LeaveRecordRow {
  id: string; employeeId: string; employeeNumber: string; leaveTypeCode: string;
  startsOn: string; endsOn: string; days: string;
  status: "requested" | "approved" | "rejected"; approvedBy: string | null; reason: string | null;
}
export interface CreateLeaveTypeInput {
  companyId: string; code: "annual" | "sick" | "unpaid" | "other";
  nameEn: string; nameAr: string | null; paid: boolean;
}
export interface LeaveTypeRow {
  id: string; code: "annual" | "sick" | "unpaid" | "other";
  nameEn: string; nameAr: string | null; paid: boolean;
}
export interface LeaveTypeFilter { companyId: string; includeArchived?: boolean; limit: number }
export interface LeaveEntitlementRow {
  employeeId: string; employeeNumber: string; year: number;
  leaveTypeId: string; leaveTypeCode: string; days: string;
}
export interface LeaveEntitlementFilter {
  companyId: string; employeeId?: string; year?: number; leaveTypeId?: string; limit: number;
}
export interface CreatePublicHolidayInput {
  companyId: string; branchId: string | null; holidayOn: string;
  nameEn: string; nameAr: string | null;
}
export interface PublicHolidayRow {
  id: string; branchId: string | null; holidayOn: string; nameEn: string; nameAr: string | null;
}
export interface PublicHolidayFilter {
  companyId: string; fromDate?: string; toDate?: string; limit: number;
}

/** One `leave_record` at `status = 'requested'`, `approved_by` NULL. Returns its id. */
export async function requestLeave(tx: Sql, input: RequestLeaveInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.leave_record
      (tenant_id, company_id, employee_id, leave_type_id, starts_on, ends_on, days, reason)
    values (app.current_tenant(), ${input.companyId}, ${input.employeeId}, ${input.leaveTypeId},
            ${input.startsOn}::date, ${input.endsOn}::date, ${input.days}::numeric(6,2), ${input.reason})
    returning id`;
  return row!.id;
}

/**
 * BOTH decision functions write `approved_by`, and this is the one thing an implementer gets wrong.
 * The table's `check (status = 'requested' or approved_by is not null)` binds a REJECTION as much as an
 * approval — a decided record names the principal who decided it either way. A `rejectLeave` that set
 * only `status` fails the CHECK with SQLSTATE 23514 and surfaces as a bare ERR_INTERNAL, which is a
 * confusing way to learn this. `app.stamp_actor` then overwrites the written value with the same session
 * actor on the NULL → value transition: a no-op that keeps the column honest if the SQL is ever changed.
 */
export async function approveLeave(tx: Sql, leaveRecordId: string): Promise<void> {
  await tx`
    update app.leave_record
       set status = 'approved', approved_by = app.current_actor()
     where id = ${leaveRecordId} and status = 'requested'`;
}

/** The R4 trigger fires only `when (new.status = 'approved')`, so rejecting one's OWN request is
 *  allowed — deliberately: spec:2175 forbids approving one's own leave, and a rule that also refused a
 *  self-withdrawal would leave a self-requested record with no way to close it. */
export async function rejectLeave(tx: Sql, leaveRecordId: string, reason: string): Promise<void> {
  await tx`
    update app.leave_record
       set status = 'rejected', approved_by = app.current_actor(), reason = ${reason}
     where id = ${leaveRecordId} and status = 'requested'`;
}

export async function setEntitlement(tx: Sql, input: SetEntitlementInput): Promise<void> {
  // The yearly figure is ENTERED by HR — spec:2085 says in terms that there is no accrual engine, so
  // this is an upsert on the natural key and never an accumulation.
  await tx`
    insert into app.leave_entitlement
      (tenant_id, company_id, employee_id, year, leave_type_id, days)
    values (app.current_tenant(), ${input.companyId}, ${input.employeeId}, ${input.year},
            ${input.leaveTypeId}, ${input.days}::numeric(6,2))
    on conflict (employee_id, year, leave_type_id) do update set days = excluded.days`;
}

/** One `leave_type` for the company. A duplicate `code` raises SQLSTATE 23505, which 0B's
 *  `fromDatabaseError` maps to `ERR_CONFLICT_UNIQUE` (409) — there is no pre-read and no `if`. */
export async function createLeaveType(tx: Sql, input: CreateLeaveTypeInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.leave_type (tenant_id, company_id, code, name_en, name_ar, paid)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn},
            ${input.nameAr}, ${input.paid})
    returning id`;
  return row!.id;
}

export async function listLeaveTypes(tx: Sql, f: LeaveTypeFilter): Promise<LeaveTypeRow[]> {
  return tx<LeaveTypeRow[]>`
    select lt.id                as "id",
           lt.code              as "code",
           lt.name_en           as "nameEn",
           lt.name_ar           as "nameAr",
           lt.paid              as "paid"
      from app.leave_type lt
     where lt.company_id = ${f.companyId}
       and (${f.includeArchived ?? false}::boolean or lt.archived_at is null)
     order by lt.code asc
     limit ${f.limit}`;
}

export async function listEntitlements(
  tx: Sql, f: LeaveEntitlementFilter,
): Promise<LeaveEntitlementRow[]> {
  // The same bound-parameter-compared-against-NULL shape as `listLeaveRecords` (§3.3, test 27). The
  // three optional filters together are the table's natural key, so a PUT reads back exactly its row.
  return tx<LeaveEntitlementRow[]>`
    select le.employee_id                as "employeeId",
           e.employee_number             as "employeeNumber",
           le.year::int                  as "year",
           le.leave_type_id              as "leaveTypeId",
           lt.code                       as "leaveTypeCode",
           le.days::text                 as "days"
      from app.leave_entitlement le
      join app.employee   e  on e.id  = le.employee_id
      join app.leave_type lt on lt.id = le.leave_type_id
     where le.company_id = ${f.companyId}
       and (${f.employeeId ?? null}::uuid  is null or le.employee_id   = ${f.employeeId ?? null}::uuid)
       and (${f.year ?? null}::int         is null or le.year          = ${f.year ?? null}::int)
       and (${f.leaveTypeId ?? null}::uuid is null or le.leave_type_id = ${f.leaveTypeId ?? null}::uuid)
     order by le.year desc, e.employee_number asc, lt.code asc
     limit ${f.limit}`;
}

/** A NULL `branchId` is a company-wide holiday, which is why 0096's unique constraint is
 *  `nulls not distinct`: a second company-wide row on the same date raises 23505 → 409. */
export async function createPublicHoliday(tx: Sql, input: CreatePublicHolidayInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.public_holiday (tenant_id, company_id, branch_id, holiday_on, name_en, name_ar)
    values (app.current_tenant(), ${input.companyId}, ${input.branchId},
            ${input.holidayOn}::date, ${input.nameEn}, ${input.nameAr})
    returning id`;
  return row!.id;
}

export async function listPublicHolidays(
  tx: Sql, f: PublicHolidayFilter,
): Promise<PublicHolidayRow[]> {
  // No branch filter is offered and none is needed: `public_holiday` carries §4.5.6 Form B
  // (amendment A8), so RLS has already removed every row for a branch the actor is not in, and a
  // company-wide (NULL branch) row is visible to everyone. A filter here would be a second gate.
  return tx<PublicHolidayRow[]>`
    select ph.id                                  as "id",
           ph.branch_id                           as "branchId",
           to_char(ph.holiday_on, 'YYYY-MM-DD')   as "holidayOn",
           ph.name_en                             as "nameEn",
           ph.name_ar                             as "nameAr"
      from app.public_holiday ph
     where ph.company_id = ${f.companyId}
       and (${f.fromDate ?? null}::date is null or ph.holiday_on >= ${f.fromDate ?? null}::date)
       and (${f.toDate ?? null}::date   is null or ph.holiday_on <= ${f.toDate ?? null}::date)
     order by ph.holiday_on asc, ph.id asc
     limit ${f.limit}`;
}

export async function listLeaveRecords(tx: Sql, f: LeaveRecordFilter): Promise<LeaveRecordRow[]> {
  // Every optional filter is a bound parameter compared against NULL, never a concatenated clause
  // (§3.3, test 27). Dates leave SQL as strings for the same reason every dataset does.
  return tx<LeaveRecordRow[]>`
    select lr.id                                     as "id",
           lr.employee_id                            as "employeeId",
           e.employee_number                         as "employeeNumber",
           lt.code                                   as "leaveTypeCode",
           to_char(lr.starts_on, 'YYYY-MM-DD')       as "startsOn",
           to_char(lr.ends_on,   'YYYY-MM-DD')       as "endsOn",
           lr.days::text                             as "days",
           lr.status                                 as "status",
           lr.approved_by                            as "approvedBy",
           lr.reason                                 as "reason"
      from app.leave_record lr
      join app.leave_type lt on lt.id = lr.leave_type_id
      join app.employee   e  on e.id  = lr.employee_id
     where lr.company_id = ${f.companyId}
       and (${f.id ?? null}::uuid         is null or lr.id          = ${f.id ?? null}::uuid)
       and (${f.employeeId ?? null}::uuid is null or lr.employee_id = ${f.employeeId ?? null}::uuid)
       and (${f.status ?? null}::text   is null or lr.status     = ${f.status ?? null}::text)
       and (${f.fromDate ?? null}::date is null or lr.starts_on >= ${f.fromDate ?? null}::date)
       and (${f.toDate ?? null}::date   is null or lr.starts_on <= ${f.toDate ?? null}::date)
     order by lr.starts_on desc, e.employee_number asc, lr.id asc
     limit ${f.limit}`;
}
```

Add `export * from "./leave";` to `packages/db/src/hr/index.ts`.

**Write the four Drizzle mirrors (§3.4.9)** — reads only, one file per table, columns exactly as Step 3's DDL and nothing more. Each declares its own file-local `const app = pgSchema("app")` and exports **only** the table, which is the shape 8B's `payroll-run.ts` and `payroll-line.ts` mirrors already establish (8b:605–623, 8b:625–629) and 8C's repeat: the schema object is not exported and not shared, so no file imports another mirror.

```ts
// packages/db/src/schema/leave-type.ts — READS ONLY (ADR-0002). Every write in this slice goes through
// packages/db/src/hr/leave.ts's tagged templates; a Drizzle insert would bypass the triggers.
import { boolean, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const leaveType = app.table("leave_type", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").$type<"annual" | "sick" | "unpaid" | "other">().notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  paid: boolean("paid").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

```ts
// packages/db/src/schema/leave-entitlement.ts — READS ONLY (ADR-0002).
import { numeric, pgSchema, smallint, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const leaveEntitlement = app.table("leave_entitlement", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  year: smallint("year").notNull(),
  leaveTypeId: uuid("leave_type_id").notNull(),
  days: numeric("days", { precision: 6, scale: 2 }).notNull(),
  enteredBy: uuid("entered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

```ts
// packages/db/src/schema/leave-record.ts — READS ONLY (ADR-0002). `approvedBy` is nullable here
// because it is NULL while the record is `requested`; the CHECK in 0096 is what makes it non-null
// once decided, and `app.stamp_actor` is what fills it. A mirror states the column, never the rule.
import { date, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const leaveRecord = app.table("leave_record", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  leaveTypeId: uuid("leave_type_id").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  days: numeric("days", { precision: 6, scale: 2 }).notNull(),
  status: text("status").$type<"requested" | "approved" | "rejected">().notNull(),
  approvedBy: uuid("approved_by"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

```ts
// packages/db/src/schema/public-holiday.ts — READS ONLY (ADR-0002). A NULL branchId is a company-wide
// holiday (spec:2085), which is why 0096's unique constraint is `nulls not distinct`.
import { date, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const publicHoliday = app.table("public_holiday", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id"),
  holidayOn: date("holiday_on").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

In `packages/contracts/permissions.ts` append the two entries with `phase: "8D"`, `module: "hr"`, `mutating: true` and the descriptions the migration uses **verbatim** (the catalogue test compares them). In `packages/db/seed/roles.ts` grant both to `hr_payroll`, and record `hr.leave.record → hr_payroll (8D)` and `hr.leave.approve → hr_payroll (8D)` in §3.6.4's running sentence. **`INCOMPATIBLE_PAIRS` is not extended**: spec:2177's list is closed at four pairs and a leave requester who is also an approver is caught by the R4 trigger per row, not by a role-level prohibition — a one-person HR department must be able to hold both and still be refused on their *own* leave.

In `packages/db/src/reports/datasets/hr.ts` append the sixth dataset:

```ts
// ⚠️ OD-13. leave_record's only report is the leave register itself; there is no ledger tie-out
// because leave is a record, not a posting (spec:2085).
const LEAVE_RECORD_COLUMNS: readonly DatasetColumn[] = [
  { field: "leave_record_id", kind: "uuid", ref: (tx) => tx`lr.id` },
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`lr.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "leave_type_code", kind: "text", ref: (tx) => tx`lt.code` },
  { field: "paid", kind: "boolean", ref: (tx) => tx`lt.paid` },
  { field: "starts_on", kind: "date", ref: (tx) => tx`lr.starts_on` },
  { field: "ends_on", kind: "date", ref: (tx) => tx`lr.ends_on` },
  { field: "days", kind: "numeric", ref: (tx) => tx`lr.days` },
  { field: "status", kind: "text", ref: (tx) => tx`lr.status` },
  { field: "approved_by", kind: "uuid", ref: (tx) => tx`lr.approved_by` },
  { field: "reason", kind: "text", ref: (tx) => tx`lr.reason` },
];

export const leaveRecordDataset: Dataset = defineDataset({
  id: "leave_record",
  columns: LEAVE_RECORD_COLUMNS,
  company: (tx, companyId) => tx`lr.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.leave_record lr
        join app.leave_type      lt on lt.id = lr.leave_type_id
        join app.employee        e  on e.id  = lr.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id`,
  select: (tx) => tx`lr.id as leave_record_id, lr.employee_id as employee_id,
         e.employee_number as employee_number, p.name_en as employee_name_en, bv.code as branch_code,
         lt.code as leave_type_code, lt.paid as paid,
         to_char(lr.starts_on, 'YYYY-MM-DD') as starts_on,
         to_char(lr.ends_on, 'YYYY-MM-DD') as ends_on,
         lr.days as days, lr.status as status, lr.approved_by as approved_by, lr.reason as reason`,
  defaultOrder: (tx) => tx`lr.starts_on desc, e.employee_number asc, lr.id asc`,
});
```

and in `packages/db/src/reports/datasets.ts` extend the union by `| "leave_record"` and add the one entry after `statutory_schedule`.

**Then move all THREE pins in this same commit, exactly as Task 2 Step 6b did (§3.7.3):**

1. `packages/db/test/reports/hr-datasets.test.ts` — both counts 34 → **35**, and the `slice(-5)` assertion widens to `slice(-6)` with `"leave_record"` appended.
2. `packages/db/test/reports/datasets.test.ts` — 7A's literal array gains `"leave_record"` at the end and the title becomes "thirty-five".
3. `packages/db/test/reports/7c-datasets.test.ts` — `toHaveLength(34)` becomes `toHaveLength(35)`.

⚠️ **OD-09**: if `pdc` was not built, those three numbers are 34 and the array is one shorter — Task 0's `EXPECTED_BASE` table is where that is decided once.

- [ ] **Step 5: Write the route module, its probe, and the API test**

`packages/contracts/src/hr/leave.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, UuidSchema } from "../common";

export const LeaveTypeSchema = z.object({
  id: UuidSchema, code: z.enum(["annual", "sick", "unpaid", "other"]),
  nameEn: z.string(), nameAr: z.string().nullable(), paid: z.boolean(),
}).openapi("LeaveType");
export const CreateLeaveTypeBody = LeaveTypeSchema.omit({ id: true }).extend({ paid: z.boolean().default(true) });

export const LeaveEntitlementSchema = z.object({
  employeeId: UuidSchema, employeeNumber: z.string(),
  year: z.number().int().min(2000).max(2200),
  leaveTypeId: UuidSchema, leaveTypeCode: z.string(), days: z.string().regex(/^\d+\.\d{2}$/),
}).openapi("LeaveEntitlement");
/** The write body carries the natural key and the figure — never `employeeNumber` or `leaveTypeCode`,
 *  which are joined-in labels the read returns and a client must not be able to disagree about. */
export const SetLeaveEntitlementBody = LeaveEntitlementSchema.omit({
  employeeNumber: true, leaveTypeCode: true,
});

export const LeaveRecordSchema = z.object({
  id: UuidSchema, employeeId: UuidSchema, employeeNumber: z.string(), leaveTypeCode: z.string(),
  startsOn: DateSchema, endsOn: DateSchema, days: z.string().regex(/^\d+\.\d{2}$/),
  status: z.enum(["requested", "approved", "rejected"]),
  approvedBy: UuidSchema.nullable(), reason: z.string().nullable(),
}).openapi("LeaveRecord");

export const CreateLeaveRecordBody = z.object({
  employeeId: UuidSchema, leaveTypeId: UuidSchema,
  startsOn: DateSchema, endsOn: DateSchema,
  days: z.string().regex(/^\d+\.\d{2}$/), reason: z.string().max(500).nullish(),
});

/** `approvedBy` is NOT a member and never will be: it is stamped from the session actor by
 *  `app.stamp_actor`, and a body that could name a decider would be LEGACY-044 by another name. */
export const LeaveDecisionBody = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(500).optional(),
});

/** §4.2.8's Layer 2 default: LITERAL `filter[…]` keys, one per supported (field, op) pair. */
export const LeaveRecordQuery = z.object({
  "filter[status][eq]": z.enum(["requested", "approved", "rejected"]).optional(),
  "filter[employee_id][eq]": UuidSchema.optional(),
  "filter[starts_on][gte]": DateSchema.optional(),
  "filter[starts_on][lte]": DateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PublicHolidaySchema = z.object({
  id: UuidSchema, branchId: UuidSchema.nullable(), holidayOn: DateSchema,
  nameEn: z.string(), nameAr: z.string().nullable(),
}).openapi("PublicHoliday");
export const CreatePublicHolidayBody = PublicHolidaySchema.omit({ id: true });

/** The three remaining query schemas, on §4.2.8's Layer 2 default — LITERAL `filter[…]` keys, one per
 *  supported (field, op) pair, and a `limit`. None takes a cursor: each list is bounded by its own
 *  filters and every route answers `next_cursor: null`. */
export const LeaveTypeQuery = z.object({
  // NOT `z.coerce.boolean()`. A query parameter arrives as a string and `Boolean("false")` is `true`,
  // so `?includeArchived=false` would return the archived types — the opposite of what was asked.
  includeArchived: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const LeaveEntitlementQuery = z.object({
  "filter[employee_id][eq]": UuidSchema.optional(),
  "filter[year][eq]": z.coerce.number().int().min(2000).max(2200).optional(),
  "filter[leave_type_id][eq]": UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const PublicHolidayQuery = z.object({
  "filter[holiday_on][gte]": DateSchema.optional(),
  "filter[holiday_on][lte]": DateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const LeaveRecordList = ListEnvelope(LeaveRecordSchema).openapi("LeaveRecordList");
export const LeaveTypeList = ListEnvelope(LeaveTypeSchema).openapi("LeaveTypeList");
export const LeaveEntitlementList = ListEnvelope(LeaveEntitlementSchema).openapi("LeaveEntitlementList");
export const PublicHolidayList = ListEnvelope(PublicHolidaySchema).openapi("PublicHolidayList");
```

Re-export the module from `packages/contracts/src/index.ts`.

`apps/api/src/routes/hr/leave.ts` — the module, all seven routes:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AppError, CreateLeaveRecordBody, CreateLeaveTypeBody, CreatePublicHolidayBody, LeaveDecisionBody,
  LeaveEntitlementList, LeaveEntitlementQuery, LeaveEntitlementSchema, LeaveRecordList,
  LeaveRecordQuery, LeaveRecordSchema, LeaveTypeList, LeaveTypeQuery, LeaveTypeSchema,
  ProblemSchema, PublicHolidayList, PublicHolidayQuery, PublicHolidaySchema,
  SetLeaveEntitlementBody, UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  approveLeave, createLeaveType, createPublicHoliday, listEntitlements, listLeaveRecords,
  listLeaveTypes, listPublicHolidays, rejectLeave, requestLeave, setEntitlement,
} from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader, type RouteModule } from "../index";
import type { AppEnv } from "../../context";

export const leaveRoutes = new OpenAPIHono<AppEnv>();

leaveRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["hr"],
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateLeaveRecordBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], { company: "path:companyId" })],
    responses: {
      201: { description: "The request, at status `requested`", content: { "application/json": { schema: LeaveRecordSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "The employee or leave type does not exist for this company (ERR_CONFLICT_REFERENCE)",
             content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const id = await requestLeave(tx, {
        companyId, employeeId: body.employeeId, leaveTypeId: body.leaveTypeId,
        startsOn: body.startsOn, endsOn: body.endsOn, days: body.days, reason: body.reason ?? null,
      });
      // Read back BY ID. A filter on employeeId alone returns the employee's newest record by
      // `starts_on desc`, which is the created one only by luck; the `id` filter makes it the created
      // one by construction, so the response body is the row this request wrote.
      const [created] = await listLeaveRecords(tx, { companyId, id, limit: 1 });
      return created!;
    });
    return c.json(row, 201);
  },
);

leaveRoutes.openapi(
  createRoute({
    method: "post", path: "/{leaveRecordId}/decision", tags: ["hr"],
    request: {
      params: z.object({ companyId: UuidSchema, leaveRecordId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: LeaveDecisionBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.approve"], { company: "path:companyId" })],
    responses: {
      200: { description: "The decided record", content: { "application/json": { schema: LeaveRecordSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      404: { description: "No such record for this company (ERR_NOT_FOUND — never reveals another tenant's row)",
             content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "R4 — the actor is the employee whose leave this is (ERR_HR_SELF_PAY, spec:2175)",
             content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, leaveRecordId } = c.req.valid("param");
    const { decision, reason } = c.req.valid("json");
    // No `if` decides anything here: `approveLeave` fires 8A's forbid_self_pay trigger, which raises
    // ERR_HR_SELF_PAY, and 0B's `fromDatabaseError` turns the token into the 409 the response set
    // declares. A TypeScript self-check would be a second implementation of R4 (hazard 9).
    const row = await c.var.withTenant(async (tx) => {
      if (decision === "approved") await approveLeave(tx, leaveRecordId);
      else await rejectLeave(tx, leaveRecordId, reason ?? "");
      // Read back BY ID, so the response is THIS record and the 404 branch is reachable. A filter
      // without `id` would return the company's newest record by `starts_on desc`, which makes an
      // unknown id answer 200 with someone else's row the moment the company holds one record.
      // Both writes are `where … and status = 'requested'`, so a second decision on an already-decided
      // record updates nothing and returns the decided row — idempotent, not an error. An id RLS hides
      // (another tenant's, or one that does not exist) reads back nothing, which is the 404 below and
      // the answer the PROBES entry expects.
      const [only] = await listLeaveRecords(tx, { companyId, id: leaveRecordId, limit: 1 });
      return only ?? null;
    });
    if (row === null) throw new AppError("ERR_NOT_FOUND", `leave record ${leaveRecordId} is not visible`);
    return c.json(row, 200);
  },
);

// ── GET / — the register itself (§4.2.8's Layer 2 literal filter keys) ──────────────────────────────
// Gated `hr.employee.read`, not `hr.leave.record`: reading who is on leave is an establishment read,
// and an HR clerk who may not file a request may still need the list. `next_cursor` is always null —
// the list is bounded by `limit` and the four filters, and no route in this module paginates.
leaveRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["hr"],
    request: { params: z.object({ companyId: UuidSchema }), query: LeaveRecordQuery },
    middleware: [requirePermission(PERMISSION["hr.employee.read"], { company: "path:companyId" })],
    responses: {
      200: { description: "Leave records", content: { "application/json": { schema: LeaveRecordList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) => listLeaveRecords(tx, {
      companyId,
      status: q["filter[status][eq]"],
      employeeId: q["filter[employee_id][eq]"],
      fromDate: q["filter[starts_on][gte]"],
      toDate: q["filter[starts_on][lte]"],
      limit: q.limit,
    }));
    return c.json({ items, next_cursor: null }, 200);
  },
);

// ── GET /types ─────────────────────────────────────────────────────────────────────────────────────
leaveRoutes.openapi(
  createRoute({
    method: "get", path: "/types", tags: ["hr"],
    request: { params: z.object({ companyId: UuidSchema }), query: LeaveTypeQuery },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], { company: "path:companyId" })],
    responses: {
      200: { description: "Leave types", content: { "application/json": { schema: LeaveTypeList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) =>
      listLeaveTypes(tx, { companyId, includeArchived: q.includeArchived, limit: q.limit }));
    return c.json({ items, next_cursor: null }, 200);
  },
);

// ── POST /types ────────────────────────────────────────────────────────────────────────────────────
// A duplicate `code` is `unique (company_id, code)` → SQLSTATE 23505 → `ERR_CONFLICT_UNIQUE` (409)
// through 0B's `fromDatabaseError`. No pre-read: a check-then-insert is a race, and the constraint is
// the rule (hazard 9). The read-back is BY ID for the same reason the two record routes are.
leaveRoutes.openapi(
  createRoute({
    method: "post", path: "/types", tags: ["hr"],
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateLeaveTypeBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], { company: "path:companyId" })],
    responses: {
      201: { description: "The created type", content: { "application/json": { schema: LeaveTypeSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "This company already has a type with that code (ERR_CONFLICT_UNIQUE)",
             content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const id = await createLeaveType(tx, {
        companyId, code: body.code, nameEn: body.nameEn,
        nameAr: body.nameAr ?? null, paid: body.paid,
      });
      // No read-back list: every member of `LeaveTypeSchema` is either the returned id or a field of
      // the validated body, so the response is built from those and never from "whatever sorted
      // first". A list call with no id filter would be the bug the two record routes above avoid.
      return { id, code: body.code, nameEn: body.nameEn, nameAr: body.nameAr ?? null, paid: body.paid };
    });
    return c.json(row, 201);
  },
);

// ── GET /entitlements ──────────────────────────────────────────────────────────────────────────────
leaveRoutes.openapi(
  createRoute({
    method: "get", path: "/entitlements", tags: ["hr"],
    request: { params: z.object({ companyId: UuidSchema }), query: LeaveEntitlementQuery },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], { company: "path:companyId" })],
    responses: {
      200: { description: "Yearly entitlements", content: { "application/json": { schema: LeaveEntitlementList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) => listEntitlements(tx, {
      companyId,
      employeeId: q["filter[employee_id][eq]"],
      year: q["filter[year][eq]"],
      leaveTypeId: q["filter[leave_type_id][eq]"],
      limit: q.limit,
    }));
    return c.json({ items, next_cursor: null }, 200);
  },
);

// ── PUT /entitlements ──────────────────────────────────────────────────────────────────────────────
// PUT, not POST: `setEntitlement` is an upsert on the natural key (employee, year, type) and there is
// no accrual engine (spec:2085), so the same request twice leaves the same figure. The read-back
// filters on all three key parts, so the response is this row and never another year's.
leaveRoutes.openapi(
  createRoute({
    method: "put", path: "/entitlements", tags: ["hr"],
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: SetLeaveEntitlementBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], { company: "path:companyId" })],
    responses: {
      200: { description: "The stored entitlement", content: { "application/json": { schema: LeaveEntitlementSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "The employee or leave type does not exist for this company (ERR_CONFLICT_REFERENCE)",
             content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await setEntitlement(tx, {
        companyId, employeeId: body.employeeId, year: body.year,
        leaveTypeId: body.leaveTypeId, days: body.days,
      });
      // `only!` and not a null branch: the upsert and this read are the SAME transaction and the
      // filter is the table's own natural key, so an empty result would mean the row this statement
      // just wrote is invisible to the statement after it — an invariant break, not a client outcome.
      // That is why the response set below declares no 404, unlike the decision route's.
      const [only] = await listEntitlements(tx, {
        companyId, employeeId: body.employeeId, year: body.year,
        leaveTypeId: body.leaveTypeId, limit: 1,
      });
      return only!;
    });
    return c.json(row, 200);
  },
);

// ── GET /holidays ──────────────────────────────────────────────────────────────────────────────────
leaveRoutes.openapi(
  createRoute({
    method: "get", path: "/holidays", tags: ["hr"],
    request: { params: z.object({ companyId: UuidSchema }), query: PublicHolidayQuery },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], { company: "path:companyId" })],
    responses: {
      200: { description: "Public holidays", content: { "application/json": { schema: PublicHolidayList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) => listPublicHolidays(tx, {
      companyId,
      fromDate: q["filter[holiday_on][gte]"],
      toDate: q["filter[holiday_on][lte]"],
      limit: q.limit,
    }));
    return c.json({ items, next_cursor: null }, 200);
  },
);

// ── POST /holidays ─────────────────────────────────────────────────────────────────────────────────
// The duplicate this refuses is the one `unique nulls not distinct` exists for: two company-wide
// holidays on the same date. 23505 → ERR_CONFLICT_UNIQUE, same as POST /types.
leaveRoutes.openapi(
  createRoute({
    method: "post", path: "/holidays", tags: ["hr"],
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePublicHolidayBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], { company: "path:companyId" })],
    responses: {
      201: { description: "The created holiday", content: { "application/json": { schema: PublicHolidaySchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "That date already carries a holiday for this branch, or company-wide (ERR_CONFLICT_UNIQUE)",
             content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const id = await createPublicHoliday(tx, {
        companyId, branchId: body.branchId, holidayOn: body.holidayOn,
        nameEn: body.nameEn, nameAr: body.nameAr,
      });
      // Built from the id and the validated body, for the reason `POST /types` states.
      return { id, branchId: body.branchId, holidayOn: body.holidayOn,
               nameEn: body.nameEn, nameAr: body.nameAr };
    });
    return c.json(row, 201);
  },
);

export const leaveRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/leave-records",
  router: leaveRoutes,
  permissions: [
    PERMISSION["hr.leave.record"], PERMISSION["hr.leave.approve"], PERMISSION["hr.employee.read"],
  ],
};
```

**Route-order note.** `/types`, `/entitlements` and `/holidays` are static segments that sit where `/{leaveRecordId}` would; no `GET /{leaveRecordId}` route exists, and `POST /{leaveRecordId}/decision` is one segment deeper, so nothing shadows anything. `UuidSchema` on `leaveRecordId` would refuse the three words in any case. Register `leaveRouteModule` in `buildRoutes`.

`tests/invariants/probes.ts` — **one** `PROBES` entry, keyed by the module's path (hazard 31, §4.2.7):

```ts
  "/v1/companies/:companyId/leave-records": {
    async seed(db, owner) {
      const employeeId = await seedEmployee(db, owner, { employeeNumber: "E-PROBE-LV" });
      const [type] = await withTenant(db.rw, owner.tenant, owner.human, (tx) => tx<{ id: string }[]>`
        insert into app.leave_type (tenant_id, company_id, code, name_en, paid)
        values (${owner.tenant}, ${owner.company}, 'annual', 'Annual leave', true) returning id`);
      const recordId = await withTenant(db.rw, owner.tenant, owner.human, (tx) =>
        requestLeave(tx, { companyId: owner.company, employeeId, leaveTypeId: type!.id,
                           startsOn: "2026-07-01", endsOn: "2026-07-02", days: "2.00", reason: null }));
      // The attacker names the VICTIM's company and record. RLS hides the row, so the handler finds
      // nothing and answers 404 — never 403, which would confirm the row exists.
      return {
        method: "POST",
        path: `/v1/companies/${owner.company}/leave-records/${recordId}/decision`,
        body: { decision: "approved" },
      };
    },
    expect: 404,
  },
```

`apps/api/test/routes/hr/leave.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedEmployee, uuidv7 } from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { problemOf } from "../../../../../tests/support/api";
import { hrActor, hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";
import { startApi, type StartedApi } from "../../support/app";

describe("the leave register through the API — ⚠️ OD-13; test 31's leave clause", () => {
  let api: StartedApi; let f: HrFixture;
  let typeId: string; let otherEmployeeId: string; let selfEmployeeId: string; let approver: string;

  beforeAll(async () => {
    api = await startApi();
    f = await hrFixture(api, "leave-api");
    await grantCodes(f.db, f.seed, {
      codes: ["hr.leave.record", "hr.employee.read"], principalId: f.officer, roleCode: "leave-officer",
    });
    approver = await uuidv7(f.db.admin);
    await f.db.admin`
      insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
      values (${approver}, ${f.seed.tenant}, 'human', ${`stub:lv-${approver}`}, 'Leave approver')`;
    await f.db.admin`
      insert into app.membership (tenant_id, principal_id) values (${f.seed.tenant}, ${approver})
      on conflict do nothing`;
    await grantCodes(f.db, f.seed, {
      codes: ["hr.leave.approve", "hr.employee.read"], principalId: approver, roleCode: "leave-approver",
    });
    // The officer holds hr.leave.record and, deliberately, NOT hr.leave.approve.
    otherEmployeeId = await seedEmployee(f.db, f.seed, { employeeNumber: "E-6001" });
    // …and an employee whose principal IS the officer, which is what makes the R4 case non-vacuous.
    selfEmployeeId = await seedEmployee(f.db, f.seed, { employeeNumber: "E-6002", principalId: f.officer });
    const [t] = await withTenant(f.db.rw, f.seed.tenant, f.seed.human, (tx) => tx<{ id: string }[]>`
      insert into app.leave_type (tenant_id, company_id, code, name_en, name_ar, paid)
      values (${f.seed.tenant}, ${f.companyId}, 'annual', 'Annual leave', 'إجازة سنوية', true) returning id`);
    typeId = t!.id;
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  const base = () => `/v1/companies/${f.companyId}/leave-records`;
  const request = (employeeId: string, startsOn: string, endsOn: string, as = hrActor(f, "officer")) =>
    api.request({ method: "POST", path: base(), as,
      body: { employeeId, leaveTypeId: typeId, startsOn, endsOn, days: "2.00", reason: "family" } });

  it("an officer requests leave and receives 201 at status requested, approvedBy null", async () => {
    const res = await request(otherEmployeeId, "2026-04-01", "2026-04-02");
    expect(res.status).toBe(201);
    const body = await res.json() as { status: string; approvedBy: string | null };
    expect(body.status).toBe("requested");
    expect(body.approvedBy).toBeNull();
  });

  it("test 31 — approving one's OWN leave is 409 ERR_HR_SELF_PAY (R4, spec:2175)", async () => {
    const created = await (await request(selfEmployeeId, "2026-05-01", "2026-05-02")).json() as { id: string };
    // The officer is granted the approve code for this one assertion, so the refusal is about the ACTOR
    // being the employee and not about a missing permission — which is the distinction test 31 draws.
    await grantCodes(f.db, f.seed, {
      codes: ["hr.leave.approve"], principalId: f.officer, roleCode: "leave-officer-approve",
    });
    await api.loadPrincipals();
    const res = await api.request({ method: "POST", as: hrActor(f, "officer"),
      path: `${base()}/${created.id}/decision`, body: { decision: "approved" } });
    expect(res.status).toBe(409);
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_HR_SELF_PAY");
  });

  it("a DIFFERENT principal's approval succeeds, and approvedBy is that principal", async () => {
    const created = await (await request(selfEmployeeId, "2026-06-01", "2026-06-02")).json() as { id: string };
    const res = await api.request({ method: "POST", as: approver,
      path: `${base()}/${created.id}/decision`, body: { decision: "approved" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; approvedBy: string };
    expect(body.status).toBe("approved");
    expect(body.approvedBy).toBe(approver);      // stamped from the session, never from the body
  });

  it("a principal without hr.leave.approve is refused at the gate with 403", async () => {
    const created = await (await request(otherEmployeeId, "2026-08-01", "2026-08-02")).json() as { id: string };
    const res = await api.request({ method: "POST", as: hrActor(f, "outsider"),
      path: `${base()}/${created.id}/decision`, body: { decision: "approved" } });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("filter[status][eq]=approved returns only approved rows", async () => {
    const res = await api.request({ method: "GET", as: hrActor(f, "officer"),
      path: `${base()}?filter%5Bstatus%5D%5Beq%5D=approved` });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { status: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const i of body.items) expect(i.status).toBe("approved");
  });

  it("a decision on an id this company does not hold is 404, not someone else's row", async () => {
    // The regression the `id` filter closes: before it, `listLeaveRecords` had no id predicate and the
    // handler returned the company's newest record, so an unknown id answered 200 with another
    // employee's leave the moment the company held one row — which it does by now, several times over.
    const res = await api.request({ method: "POST", as: approver,
      path: `${base()}/${await uuidv7(f.db.admin)}/decision`, body: { decision: "approved" } });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("POST /types creates a type, GET /types lists it, and a duplicate code is 409", async () => {
    const created = await api.request({ method: "POST", as: hrActor(f, "officer"),
      path: `${base()}/types`,
      body: { code: "sick", nameEn: "Sick leave", nameAr: "إجازة مرضية", paid: true } });
    expect(created.status).toBe(201);
    const type = await created.json() as { id: string; code: string; paid: boolean };
    expect(type.code).toBe("sick");
    expect(type.paid).toBe(true);

    const listed = await api.request({ method: "GET", as: hrActor(f, "officer"), path: `${base()}/types` });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { items: { code: string }[]; next_cursor: null };
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((i) => i.code).sort()).toEqual(["annual", "sick"]);

    // `unique (company_id, code)` → SQLSTATE 23505 → ERR_CONFLICT_UNIQUE, through fromDatabaseError.
    const dup = await api.request({ method: "POST", as: hrActor(f, "officer"),
      path: `${base()}/types`,
      body: { code: "sick", nameEn: "Sick leave again", nameAr: null, paid: true } });
    expect(dup.status).toBe(409);
    expect((await problemOf(dup)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("PUT /entitlements is an upsert on the natural key and returns THAT row", async () => {
    const put = (days: string) => api.request({ method: "PUT", as: hrActor(f, "officer"),
      path: `${base()}/entitlements`,
      body: { employeeId: otherEmployeeId, year: 2026, leaveTypeId: typeId, days } });

    const first = await put("14.00");
    expect(first.status).toBe(200);
    expect((await first.json() as { days: string }).days).toBe("14.00");

    // The same key again REPLACES the figure — there is no accrual engine (spec:2085), so 14 + 2 is
    // never 16 here. The read-back filters on all three key parts, so this is the row just written.
    const second = await put("16.00");
    expect(second.status).toBe(200);
    const row = await second.json() as { days: string; year: number; employeeNumber: string };
    expect(row.days).toBe("16.00");
    expect(row.year).toBe(2026);
    expect(row.employeeNumber).toBe("E-6001");

    const listed = await api.request({ method: "GET", as: hrActor(f, "officer"),
      path: `${base()}/entitlements?filter%5Bemployee_id%5D%5Beq%5D=${otherEmployeeId}` });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { items: { days: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.days).toBe("16.00");
  });

  it("POST /holidays refuses a second COMPANY-WIDE holiday on the same date (nulls not distinct)", async () => {
    const created = await api.request({ method: "POST", as: hrActor(f, "officer"),
      path: `${base()}/holidays`,
      body: { branchId: null, holidayOn: "2026-08-31", nameEn: "National Day", nameAr: "اليوم الوطني" } });
    expect(created.status).toBe(201);
    expect((await created.json() as { branchId: string | null }).branchId).toBeNull();

    // Two NULL branch_ids are DISTINCT under a plain unique constraint, which is exactly why 0096
    // writes `unique nulls not distinct` — without it this second insert would succeed.
    const dup = await api.request({ method: "POST", as: hrActor(f, "officer"),
      path: `${base()}/holidays`,
      body: { branchId: null, holidayOn: "2026-08-31", nameEn: "National Day (again)", nameAr: null } });
    expect(dup.status).toBe(409);
    expect((await problemOf(dup)).code).toBe("ERR_CONFLICT_UNIQUE");

    const listed = await api.request({ method: "GET", as: hrActor(f, "officer"),
      path: `${base()}/holidays?filter%5Bholiday_on%5D%5Bgte%5D=2026-08-01&filter%5Bholiday_on%5D%5Blte%5D=2026-08-31` });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { items: { holidayOn: string }[]; next_cursor: null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.holidayOn).toBe("2026-08-31");
    expect(body.next_cursor).toBeNull();
  });
});
```

- [ ] **Step 6: Run everything and commit**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db db:lint && bun run typecheck && bun run test && bun run --cwd packages/contracts openapi:generate`
Expected: PASS; `db:lint` reports `0 violations` — if it reports `branch_isolation_policy` on `public_holiday`, the Form B `do $$` block did not run because 6C's `app.actor_in_branch` is absent, which means 6C is not merged and the phase gate was not met.

```bash
git add packages/db/migrations/0096_create_leave_register.sql packages/db/migrations/0096.down.sql \
        packages/db/src/schema/leave-*.ts packages/db/src/schema/public-holiday.ts \
        packages/db/src/hr/leave.ts packages/db/src/hr/index.ts packages/db/test/hr/leave.test.ts \
        packages/db/src/reports/datasets/hr.ts packages/db/src/reports/datasets.ts \
        packages/db/test/reports/hr-datasets.test.ts packages/db/test/reports/datasets.test.ts \
        packages/db/test/reports/7c-datasets.test.ts packages/db/test/permission-catalogue.test.ts \
        packages/contracts/permissions.ts packages/contracts/src/hr/leave.ts packages/contracts/src/index.ts \
        packages/contracts/openapi.json packages/db/seed/roles.ts \
        apps/api/src/routes/hr/leave.ts apps/api/src/routes/index.ts \
        apps/api/test/routes/hr/leave.test.ts tests/invariants/probes.ts
git commit -m "feat(db): add the leave register behind OD-13 [8D T8]

leave_type, leave_entitlement, leave_record and public_holiday, with 8A's
forbid_self_pay attached for R4 and Form B branch isolation on the nullable
branch key. The two hr.leave.* rows ship inside 0096 so the gate drops whole
(amendment A9). Leave is a record, never a pay input (spec:2085).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: ⚠️ OD-23 — the one-month parallel run and the written reconciliation (ISOLATED)

This is the slice's share of the Phase 8 definition of done, and the whole of it: *"The business's real monthly payroll runs in Dulja **in parallel with the legacy system for one month**: every gross, statutory and net figure matches the legacy run and the authorities' calculators to the cent, **or every difference is explained in writing and accepted by the owner**."*

**Owner decision OD-23** (§2.12; spec:2407): employer registration numbers; the current EPF/SOCSO/EIS/PCB tables **with worked examples signed off by the accountant**; the staff list; pay-period and pay-date conventions. 8A took the registration numbers, 8B the golden fixture. **8D's share is the run itself and the owner's written acceptance.**

**Hazard 5's pattern, applied.** *Owner provides X; verify with `<exact command>`; until provided, the local equivalent runs and must print the same lines.* The tool this task builds is what makes the "or explained in writing" half mechanical: a reconciliation the officer can hand to the accountant, not a spreadsheet.

**Files:**
- Create: `packages/db/src/hr/reconcile.ts`, `packages/db/test/hr/reconcile.test.ts`, `scripts/payroll-reconcile.ts`
- Modify: `packages/db/src/hr/index.ts`, `docs/runbooks/payroll-parallel-run.md` (Task 6 created it; this task appends every section but "Annual statements"), `package.json` (the `payroll:reconcile` script)

**Interfaces:**
- Consumes: `payslipRows`, `PayslipBundle` (Task 5); `Money`, `CurrencyCode`, `currency` (§4.2.1); `createDb`, `withTenant`, `systemContext` (§4.2.2); `hrReportFixture` (Task 2 — from the **test**, never from the script: `scripts/**` has no `tests/**` allowance on `dependency-rule`).
- Produces:

```ts
// packages/db/src/hr/reconcile.ts
export interface LegacyPayslip {
  employeeNumber: string; gross: string; totalDeductions: string; net: string;
  /** scheme code → the employee share the legacy system computed. An absent scheme is a difference. */
  schemes: Readonly<Record<string, string>>;
}
export type DifferenceKind =
  | "missing_in_dulja" | "missing_in_legacy" | "gross" | "deductions" | "net" | "scheme" | "scheme_absent";
export interface Difference {
  employeeNumber: string; kind: DifferenceKind; field: string;
  legacy: string | null; dulja: string | null; delta: string | null;
}
export interface ReconciliationReport {
  payrollDocumentId: string; periodStart: string; periodEnd: string;
  employeesInDulja: number; employeesInLegacy: number; matched: number;
  differences: readonly Difference[];
  /** True only when `differences` is empty — the DoD's first branch. */
  cleanToTheCent: boolean;
}
/** Compares the POSTED run against the legacy figures the owner supplied. Pure comparison over `Money`,
 *  so a cent is a cent and no `number` ever holds one (spec:2041). */
export function reconcileParallelRun(
  tx: Sql, params: { companyId: string; payrollDocumentId: string; baseCurrency: CurrencyCode },
  legacy: readonly LegacyPayslip[],
): Promise<ReconciliationReport>;
/** Deterministic Markdown — the document the owner signs. Same input, same bytes. */
export function renderReconciliation(report: ReconciliationReport): string;
```

- [ ] **Step 1: Owner gate**

**Owner provides:** (a) the staff list for the parallel month; (b) the legacy system's payslip figures for that month, exported as a CSV with the columns `employee_number,gross,total_deductions,net,<scheme code>_employee…`; (c) the accountant's sign-off on the statutory tables that month uses (OD-23's other half, loaded by 8A's `statutory` sub-pack); (d) a written acceptance of the difference report.

**Verify:**

```bash
bun run payroll:reconcile --tenant "$TENANT_ID" --company "$COMPANY_ID" \
  --run "$PAYROLL_DOCUMENT_ID" --legacy ./legacy-2026-01.csv --out ./docs/reports/parallel-run-2026-01.md
```

prints `differences: 0 — clean to the cent` or `differences: N — see ./docs/reports/parallel-run-2026-01.md`, and exits **0** in both cases (a difference is a finding, not a failure) and **2** on a configuration error, matching the seed CLI's exit-code convention (§4.2.13).

**Until provided:** the same command runs against the fixture corpus with a CSV generated from the **`SYNTH`** table:

```bash
bun run payroll:reconcile --self-test
```

must print `differences: 0 — clean to the cent`. It **delegates** to Step 2's vitest case (`spawnSync("bun", ["run", "--cwd", "packages/db", "test", "test/hr/reconcile.test.ts", "-t", "clean to the cent"])`) rather than booting Testcontainers inside the script, for two reasons: `scripts/` is inside the lint runner's `ROOTS` (§3.7.5) and there is no `scripts/**` → `tests/**` allowance on `dependency-rule`, so the script may not import `hrReportFixture`; and the one Testcontainers corpus stays in the one place that owns it. **No real Malaysian figure enters the repository at any point** (hazard 1): the case's legacy list is *derived from the posted run*, which is computed from `SYNTH` (§4.12.4), and nothing is written to disk.

- [ ] **Step 2: Write the failing test**

`packages/db/test/hr/reconcile.test.ts` builds the legacy list from the posted run's own bundles and then perturbs it, one case per `DifferenceKind`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { currency, Money } from "@dulja/domain";
import { payslipRows } from "../../src/hr/payslip";
import { reconcileParallelRun, renderReconciliation, type LegacyPayslip, type ReconciliationReport }
  from "../../src/hr/reconcile";
import { hrReportFixture, type HrReportFixture } from "../../../../tests/invariants/support/hr-reports";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const MYR = currency("MYR");

describe("reconcileParallelRun — the Phase 8 DoD's first clause, made mechanical", () => {
  let db: Db; let s: Seed; let f: HrReportFixture;
  /** Built ONCE from the posted run, then copied per case — the identity baseline every case perturbs. */
  let baseline: LegacyPayslip[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "reconcile");
    f = await hrReportFixture(db, s);
    baseline = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const bundles = await payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId });
      return bundles.map((b) => {
        const schemes: Record<string, string> = {};
        for (const r of b.rows) {
          if (r.scheme_code === null || r.share !== "employee") continue;
          const code = String(r.scheme_code);
          schemes[code] = Money.of(schemes[code] ?? "0.0000", MYR)
            .add(Money.of(String(r.amount ?? "0.0000"), MYR)).toString();
        }
        return { employeeNumber: b.header.employeeNumber, gross: b.header.gross,
                 totalDeductions: b.header.totalDeductions, net: b.header.net, schemes };
      });
    });
    expect(baseline.length).toBeGreaterThan(0);
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  /** A deep copy, so a case's perturbation never leaks into the next one. */
  const legacyFromDulja = (): LegacyPayslip[] =>
    baseline.map((l) => ({ ...l, schemes: { ...l.schemes } }));

  const run = (legacy: readonly LegacyPayslip[]): Promise<ReconciliationReport> =>
    withTenant(db.rw, s.tenant, s.human, (tx) => reconcileParallelRun(tx,
      { companyId: s.company, payrollDocumentId: f.runDocumentId, baseCurrency: MYR }, legacy));

it("reports nothing when the legacy figures match to the cent", async () => {
  const report = await run(legacyFromDulja());
  expect(report.differences).toEqual([]);
  expect(report.cleanToTheCent).toBe(true);
  expect(report.matched).toBe(report.employeesInDulja);
});

it("names the employee, the field and the signed delta on a net difference", async () => {
  const legacy = legacyFromDulja();
  legacy[0]!.net = Money.of(legacy[0]!.net, MYR).add(Money.of("0.0100", MYR)).toString();
  const report = await run(legacy);
  const d = report.differences.find((x) => x.kind === "net")!;
  expect(d.employeeNumber).toBe(legacy[0]!.employeeNumber);
  expect(d.delta).toBe("-0.0100");                  // dulja − legacy, signed, at 4 dp
  expect(report.cleanToTheCent).toBe(false);
});

it("reports an employee present on one side only, in both directions", async () => {
  const extra = [...legacyFromDulja(), { employeeNumber: "E-9999", gross: "1.0000",
    totalDeductions: "0.0000", net: "1.0000", schemes: {} }];
  expect((await run(extra)).differences.map((d) => d.kind)).toContain("missing_in_dulja");
  expect((await run(legacyFromDulja().slice(1))).differences.map((d) => d.kind)).toContain("missing_in_legacy");
});

it("reports a scheme the legacy system computed differently and one it did not compute at all", async () => {
  const a = legacyFromDulja(); const code = Object.keys(a[0]!.schemes)[0]!;
  a[0]!.schemes = { ...a[0]!.schemes, [code]: "0.0000" };
  expect((await run(a)).differences.some((d) => d.kind === "scheme" && d.field === code)).toBe(true);
  const b = legacyFromDulja(); b[0]!.schemes = {};
  expect((await run(b)).differences.some((d) => d.kind === "scheme_absent")).toBe(true);
});

it("renderReconciliation is deterministic — the same report renders the same bytes", async () => {
  const report = await run(legacyFromDulja());
  expect(renderReconciliation(report)).toBe(renderReconciliation(report));
  expect(renderReconciliation(report)).toContain("| Employee | Field | Legacy | Dulja | Delta |");
});

it("no assertion in this file states a rate, a threshold or a ceiling — hazard 1", () => {
  // Every figure this file compares came out of the posted run, which came out of the SYNTH table:
  // `baseline` is DERIVED, never typed. The two literals it does carry — "0.0100" above and "1.0000"
  // for the phantom employee — are deltas and placeholders, not statutory values.
  const source = readFileSync(__filename, "utf8");
  expect(source).not.toMatch(/\b(EPF|SOCSO|EIS|PCB)\s*[:=]\s*\d/);
  expect(source).not.toContain("rate");
});
});
```

**Where `SYNTH` is in this picture.** The fixture chain is `hrReportFixture` → 8B's `payrollFixture` → `packages/db/seed/test/statutory/SYNTH/v1.json` (§4.12.4), so the corpus is synthetic by construction and this file never names a table at all. The hazard-1 assertion above scans for the shape of a hard-coded rate rather than for the *word* `SYNTH`, because a file that merely mentions the fixture's name proves nothing about what it asserts.

- [ ] **Step 3: Write `packages/db/src/hr/reconcile.ts`**

```ts
// The Phase 8 definition of done's FIRST clause, made mechanical: "every gross, statutory and net figure
// matches the legacy run … or every difference is explained in writing and accepted by the owner". This
// file produces the difference list; `renderReconciliation` produces the document the owner signs.
//
// Every comparison is `Money.compare`, never `Number`: a cent is a cent (spec:2041), and a `!==` over
// two 4-dp strings would report "1.5" and "1.5000" as different while reporting 1.50000001 as equal.
import type { Sql } from "postgres";
import { Money, type CurrencyCode } from "@dulja/domain";
import { payslipRows } from "./payslip";

export interface LegacyPayslip {
  employeeNumber: string; gross: string; totalDeductions: string; net: string;
  /** scheme code → the employee share the legacy system computed. An absent scheme is a difference. */
  schemes: Readonly<Record<string, string>>;
}
export type DifferenceKind =
  | "missing_in_dulja" | "missing_in_legacy" | "gross" | "deductions" | "net" | "scheme" | "scheme_absent";
export interface Difference {
  employeeNumber: string; kind: DifferenceKind; field: string;
  legacy: string | null; dulja: string | null; delta: string | null;
}
export interface ReconciliationReport {
  payrollDocumentId: string; periodStart: string; periodEnd: string;
  employeesInDulja: number; employeesInLegacy: number; matched: number;
  differences: readonly Difference[];
  /** True only when `differences` is empty — the DoD's first branch. */
  cleanToTheCent: boolean;
}

/** `dulja − legacy`, signed, at 4 dp. The sign is the whole diagnostic value of the column: a reviewer
 *  reads "Dulja paid less" off it without re-doing the subtraction. */
function delta(dulja: string, legacy: string, base: CurrencyCode): string {
  return Money.of(dulja, base).subtract(Money.of(legacy, base)).toString();
}

export async function reconcileParallelRun(
  tx: Sql,
  params: { companyId: string; payrollDocumentId: string; baseCurrency: CurrencyCode },
  legacy: readonly LegacyPayslip[],
): Promise<ReconciliationReport> {
  const base = params.baseCurrency;
  // The Dulja side comes from `payslipRows` and NOT from a second query: the report must reconcile the
  // figures the employee actually received on paper, and a second aggregation here would be a third
  // source of truth for one number (LEGACY-009).
  const bundles = await payslipRows(tx, {
    companyId: params.companyId, payrollDocumentId: params.payrollDocumentId,
  });

  const byNumber = new Map(bundles.map((b) => [b.header.employeeNumber, b] as const));
  const legacyByNumber = new Map(legacy.map((l) => [l.employeeNumber, l] as const));
  const differences: Difference[] = [];
  let matched = 0;

  for (const l of [...legacyByNumber.values()].sort((x, y) => x.employeeNumber.localeCompare(y.employeeNumber))) {
    const b = byNumber.get(l.employeeNumber);
    if (b === undefined) {
      // The legacy system paid someone Dulja did not. REPORTED, never silently dropped — LEGACY-011's shape.
      differences.push({ employeeNumber: l.employeeNumber, kind: "missing_in_dulja", field: "employee",
                         legacy: l.net, dulja: null, delta: null });
      continue;
    }
    matched += 1;
    const h = b.header;
    const pairs: readonly [DifferenceKind, string, string, string][] = [
      ["gross", "gross", l.gross, h.gross],
      ["deductions", "totalDeductions", l.totalDeductions, h.totalDeductions],
      ["net", "net", l.net, h.net],
    ];
    for (const [kind, field, left, right] of pairs) {
      if (Money.of(right, base).compare(Money.of(left, base)) !== 0) {
        differences.push({ employeeNumber: l.employeeNumber, kind, field,
                           legacy: left, dulja: right, delta: delta(right, left, base) });
      }
    }

    // Each scheme's EMPLOYEE share, per scheme code. Dulja's side is the sum of that employee's
    // employee-share lines for the scheme — computed here from the bundle's own rows, so the payslip and
    // the reconciliation cannot disagree about what was deducted.
    const duljaShares = new Map<string, Money<CurrencyCode>>();
    for (const r of b.rows) {
      if (r.scheme_code === null || r.share !== "employee") continue;
      const code = String(r.scheme_code);
      duljaShares.set(code, (duljaShares.get(code) ?? Money.zero(base))
        .add(Money.of(String(r.amount ?? "0.0000"), base)));
    }
    for (const code of [...new Set([...Object.keys(l.schemes), ...duljaShares.keys()])].sort()) {
      const legacyShare = l.schemes[code];
      const duljaShare = duljaShares.get(code) ?? null;
      if (legacyShare === undefined) {
        // Dulja computed a scheme the legacy run did not carry at all.
        differences.push({ employeeNumber: l.employeeNumber, kind: "scheme_absent", field: code,
                           legacy: null, dulja: duljaShare!.toString(), delta: null });
        continue;
      }
      if (duljaShare === null) {
        differences.push({ employeeNumber: l.employeeNumber, kind: "scheme_absent", field: code,
                           legacy: legacyShare, dulja: null, delta: null });
        continue;
      }
      if (duljaShare.compare(Money.of(legacyShare, base)) !== 0) {
        differences.push({ employeeNumber: l.employeeNumber, kind: "scheme", field: code,
                           legacy: legacyShare, dulja: duljaShare.toString(),
                           delta: delta(duljaShare.toString(), legacyShare, base) });
      }
    }
  }

  for (const b of bundles) {
    if (legacyByNumber.has(b.header.employeeNumber)) continue;
    differences.push({ employeeNumber: b.header.employeeNumber, kind: "missing_in_legacy",
                       field: "employee", legacy: null, dulja: b.header.net, delta: null });
  }

  // SORTED, and this is not cosmetic: `renderReconciliation` must produce the same bytes for the same
  // data so a reviewer diffs the report instead of re-reading it.
  differences.sort((a, b2) => a.employeeNumber.localeCompare(b2.employeeNumber)
    || a.field.localeCompare(b2.field) || a.kind.localeCompare(b2.kind));

  const first = bundles[0]?.header;
  return {
    payrollDocumentId: params.payrollDocumentId,
    periodStart: first?.periodStart ?? "", periodEnd: first?.periodEnd ?? "",
    employeesInDulja: bundles.length, employeesInLegacy: legacy.length, matched,
    differences, cleanToTheCent: differences.length === 0,
  };
}

/** Deterministic Markdown — the document the owner signs. Same input, same bytes: no clock read, no
 *  locale-dependent formatting, and the rows are already sorted by the function above. */
export function renderReconciliation(report: ReconciliationReport): string {
  const lines: string[] = [
    `# Payroll parallel run — reconciliation`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Payroll document | \`${report.payrollDocumentId}\` |`,
    `| Period | ${report.periodStart} … ${report.periodEnd} |`,
    `| Employees in Dulja | ${report.employeesInDulja} |`,
    `| Employees in the legacy run | ${report.employeesInLegacy} |`,
    `| Matched by employee number | ${report.matched} |`,
    `| Differences | ${report.differences.length} |`,
    ``,
    report.cleanToTheCent
      ? `**Clean to the cent.** Every gross, statutory and net figure matches the legacy run.`
      : `**${report.differences.length} difference(s).** Each row below is either a Dulja defect, a legacy defect, or a rule difference the accountant explains. The owner's written acceptance of this list is what closes the Phase 8 definition of done — a zero is not required.`,
    ``,
  ];
  if (report.differences.length > 0) {
    lines.push(`| Employee | Field | Legacy | Dulja | Delta |`, `|---|---|---|---|---|`);
    for (const d of report.differences) {
      lines.push(`| ${d.employeeNumber} | ${d.field} (${d.kind}) | ${d.legacy ?? "—"} | ${d.dulja ?? "—"} | ${d.delta ?? "—"} |`);
    }
    lines.push(``);
  }
  lines.push(
    `## Accepted differences`,
    ``,
    `_One line per row above: the reason, and the owner's initials. A row with no reason is not accepted._`,
    ``,
  );
  return lines.join("\n");
}
```

Add `export * from "./reconcile";` to `packages/db/src/hr/index.ts`.

- [ ] **Step 3b: Write `scripts/payroll-reconcile.ts` and wire the script**

```ts
#!/usr/bin/env bun
// `bun run payroll:reconcile` — the command Task 9's owner gate names. It imports @dulja/db and
// @dulja/domain and NOTHING from `tests/`: `scripts/` is inside the lint runner's ROOTS (§3.7.5) and
// there is no `scripts/**` → `tests/**` allowance on `dependency-rule`. `--self-test` therefore SPAWNS
// the vitest case rather than booting Testcontainers here, which also keeps the one Testcontainers
// fixture in the one place that owns it.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createDb, systemContext, withTenant } from "@dulja/db";
import { reconcileParallelRun, renderReconciliation, type LegacyPayslip } from "@dulja/db";
import { currency } from "@dulja/domain";

const USAGE = `usage:
  payroll:reconcile --tenant <uuid> --company <uuid> --run <uuid> --legacy <csv> --out <md> [--currency MYR]
  payroll:reconcile --self-test`;

function flag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

/**
 * `employee_number,gross,total_deductions,net,<SCHEME>_employee,…` — a header row, then one row per
 * employee. Any column ending `_employee` that is not one of the four fixed names is a scheme code, so a
 * new scheme needs no code change here. No statutory NAME is written into this file (hazard 1): the
 * codes come from the owner's export.
 */
function parseLegacyCsv(text: string): LegacyPayslip[] {
  const rows = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (rows.length < 2) throw new Error("the legacy CSV has a header row and no data rows");
  const header = rows[0]!.split(",").map((h) => h.trim());
  const index = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`the legacy CSV has no ${name} column; it needs employee_number, gross, total_deductions and net`);
    return i;
  };
  const iNumber = index("employee_number");
  const iGross = index("gross");
  const iDed = index("total_deductions");
  const iNet = index("net");
  const schemeColumns = header
    .map((h, i) => ({ code: h.endsWith("_employee") ? h.slice(0, -"_employee".length) : null, i }))
    .filter((c): c is { code: string; i: number } => c.code !== null && c.code.length > 0);

  return rows.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const schemes: Record<string, string> = {};
    for (const c of schemeColumns) if (cells[c.i]) schemes[c.code] = cells[c.i]!;
    return {
      employeeNumber: cells[iNumber]!, gross: cells[iGross]!,
      totalDeductions: cells[iDed]!, net: cells[iNet]!, schemes,
    };
  });
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--self-test")) {
    // The local equivalent hazard 5 requires, run where the corpus lives. It seeds a Testcontainers
    // tenant through `hrReportFixture`, builds the legacy list from the posted run itself and must
    // report zero differences — over SYNTH, so no real Malaysian figure enters the repository.
    const r = spawnSync("bun", ["run", "--cwd", "packages/db", "test", "test/hr/reconcile.test.ts",
                                "-t", "clean to the cent"], { stdio: "inherit" });
    if (r.status === 0) { process.stdout.write("differences: 0 — clean to the cent\n"); return 0; }
    return r.status ?? 2;
  }

  const tenant = flag(argv, "tenant");
  const company = flag(argv, "company");
  const run = flag(argv, "run");
  const legacyPath = flag(argv, "legacy");
  const out = flag(argv, "out");
  if (!tenant || !company || !run || !legacyPath || !out) { process.stderr.write(`${USAGE}\n`); return 2; }

  let legacy: LegacyPayslip[];
  try { legacy = parseLegacyCsv(readFileSync(legacyPath, "utf8")); }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 2; }

  // `createDb(url, opts?)` takes the URL (§4.2.2) — the CLI reads it exactly where 0D's worker
  // entrypoint does, and refuses with exit 2 rather than a stack trace when it is unset.
  const url = process.env["DATABASE_URL"];
  if (!url) { process.stderr.write("DATABASE_URL is not set (§3.11)\n"); return 2; }
  const db = createDb(url);
  try {
    // The tenant's SYSTEM principal, never the tenant id in the actor slot: `app.current_actor()` and
    // the audit trigger both reference `app.principal(id)`, and a tenant id is not one (hazard 20).
    const ctx = await systemContext(db, tenant, crypto.randomUUID());
    const report = await withTenant(db, ctx,
      (tx) => reconcileParallelRun(tx,
        { companyId: company, payrollDocumentId: run, baseCurrency: currency(flag(argv, "currency") ?? "MYR") },
        legacy));
    writeFileSync(out, renderReconciliation(report), "utf8");
    process.stdout.write(report.cleanToTheCent
      ? "differences: 0 — clean to the cent\n"
      : `differences: ${report.differences.length} — see ${out}\n`);
    // Exit 0 EITHER WAY. A difference is a finding, not a failure: the definition of done is met by the
    // owner's signature on the explanations, never by a zero (spec, Part V). Exit 2 is reserved for a
    // configuration error, matching the seed CLI's convention (§4.2.13).
    return 0;
  } finally {
    await db.end();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
```

Add `"payroll:reconcile": "bun run scripts/payroll-reconcile.ts"` to the root `package.json` scripts.

- [ ] **Step 3c: Write the runbook**

`docs/runbooks/payroll-parallel-run.md` gains, above Task 6's section, these four sections, each carrying its exact command: **Before the month** — load the accountant-signed tables through `bun run seed --tenant <id> --only statutory`, verify each with `hr.statutory_table.verify` **as a different principal** from the one that loaded it (`ERR_HR_SELF_VERIFY` otherwise, spec:2080), and confirm the pay-period and pay-date convention with the owner. **During the month** — run payroll in Dulja on the same inputs as the legacy system; prepare and approve as two different principals (R1); post. **After the run** — export the legacy payslips, run `payroll:reconcile`, and attach the Markdown report to the pull request. **The acceptance** — the owner signs the report; a difference the owner accepts is recorded in the report with the accepted reason beside it, and the phase's definition of done is met by the signature, not by a zero. **What is not allowed** — changing a Dulja figure to match the legacy one. A difference is either a Dulja defect (fix it and re-run), a legacy defect (record it), or a rule difference the accountant explains (record it, and if it is a rate-table fact, correct the table through the seed and re-run). Never edit a posted line: correction after posting is a reversal plus a supplementary run (spec:2081, ADR 0076).

- [ ] **Step 4: Run and commit**

Run: `bun run --cwd packages/db test test/hr/reconcile.test.ts && bun run payroll:reconcile --self-test`
Expected: PASS, 6 passing; the self-test prints `differences: 0 — clean to the cent`.

```bash
git add packages/db/src/hr/reconcile.ts packages/db/src/hr/index.ts packages/db/test/hr/reconcile.test.ts \
        scripts/payroll-reconcile.ts package.json docs/runbooks/payroll-parallel-run.md
git commit -m "feat(db): reconcile a Dulja payroll run against the legacy figures [8D T9]

The Phase 8 DoD's first clause made mechanical: one command produces the written
difference report the owner signs. Self-test runs on SYNTH; no real statutory
figure enters the repository (hazard 1).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: ⚠️ OD-24 — the payslip and HR-report screens (ISOLATED; BLOCKED until the owner answers)

**Owner decision OD-24** (§2.12; spec:79, 108, 2408): *"Screenshots + operator description before any screen."* spec:108 is the binding sentence: *"The UI is not specified here. Before beginning any screen, request from the owner: screenshots of the equivalent legacy screen, and a two-minute description of how a fast operator uses it. Design the new screen to be at least as fast by keyboard. **Do not invent workflows from this document.**"*

**This task is blocked, and the slice is not.** Tasks 0–9, 11 and 12 ship and are green with no screen. Hazard 29 is explicit — *"every screen task begins with OD-24 … no plan invents a workflow"* — so this task creates **no file** until the owner answers, and nothing in this plan imports from `apps/backoffice`.

**Files:**
- Create: **none until OD-24 is answered.** If it is answered yes, Step 2 names the three screens and the files follow from the owner's screenshots — which is the whole point of the gate, and the reason no path is pre-declared here.
- Modify: none.

**Interfaces:**
- Consumes: nothing until OD-24 is answered. If yes: `packages/ui`, `packages/i18n`, `bootLocalStack` (0E, §4.17.1), and the three HTTP surfaces Step 1 lists, over the wire and never as imports.
- Produces: **nothing.** No module, no export, no `PROBES` key, no `ROUTES` row. No other task in this plan consumes anything from this one, which is what makes it droppable without touching a neighbour.

- [ ] **Step 1: Owner gate**

**Owner provides:** screenshots of the legacy Salaries module's payslip-printing screen and of whichever list the payroll officer uses to check a run before approving it, plus a two-minute description of how a fast operator uses each — where the keyboard focus starts, which keys advance, what is typed and what is chosen.

**Verify:** the screenshots and the transcript are attached to this task's issue, and the pull request that opens the screen work quotes the transcript's first sentence in its description.

**Until provided:** no file under `apps/backoffice/src/` is created by this slice. The three capabilities a screen would carry are all reachable without one, and the runbooks say how: payslips by `POST …/payroll-runs/{documentId}/payslips` (Task 5) and the attachment download; every report by `POST …/reports/{code}/runs` (7A) or its `GET` route; the permit list by `GET …/employees/permit-expiry` (Task 3).

- [ ] **Step 2: When the answer arrives, the screens are these three and no others**

A **run review** screen listing `hr.payroll_register` for one run with the manual-override lines flagged (spec:2087 requires them "listed on the approval screen" — 8B's approval screen is where that lives; this one shows them read-only after posting); a **payslip** screen that generates and downloads for one run, showing each employee's file name and hash; and an **HR reports** entry adding this slice's eight codes to 7A's report-viewer list. Each is built with `packages/ui` and `packages/i18n`, and each re-runs **test 23** in both text directions through `bootLocalStack` (0E, §4.17.1) before merge — the same gate every UI slice passes.

- [ ] **Step 3: Commit — only when Step 1 is satisfied**

```bash
git commit -m "feat(backoffice): payroll run review, payslip generation and the HR report list [8D T10]

Built from the owner's screenshots and operator transcript (OD-24); verified in
both text directions (test 23).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `ReportCodeSchema` + 8, the seed application, and the four regression appends

The eight definitions exist as files; this task makes them reachable — the wire enum widens, the pack is applied, and the four Part I defects this slice touches gain their 8D blocks.

**Files:**
- Modify: `packages/contracts/src/accounting/reports.ts`, `packages/db/test/seed/reports.test.ts`, `tests/regression/legacy-011.test.ts`, `tests/regression/legacy-020.test.ts`, `tests/regression/legacy-033.test.ts`, `tests/regression/legacy-085.test.ts`

**Interfaces:**
- Consumes: `ReportCodeSchema` (1B, widened by each report-shipping slice — §4.16.3); `loadReportDefinitions`, `reportsLoader` (7A); `HR_CATALOGUE`, `readHrDefinition`, `hrReportFixture` (Task 2); `repoFile`, `REPO_ROOT` (§4.17.1); `pdfText` (2C); `payslipRows`, `reconcileParallelRun`, `permitExpiry`, `writeSensitive`, `createHrKeyRing` (Tasks 3, 5, 9 and 8A); `payrollFixture`, `postPayrollRun` (8B); `seedTenantV2`, `grantCodes`, `seedEmployee`, `uuidv7`, `startDb` (§4.17, §4.1); `startApi` (§4.2.12). **`hrFixture` is NOT consumed by any of the four blocks** — it seeds a `SYNTH` `statutory_scheme` and so does `payrollFixture`, and `app.statutory_scheme` is `unique (company_id, code)` (8a:4248), so legacy-011 and legacy-085 seed their own tenants. **`thinRegression` / `fullRegression` are NOT consumed** — Step 3 records why.
- Produces: nothing importable. `ReportCodeSchema` gains eight members.

- [ ] **Step 1: Widen `ReportCodeSchema` and prove the two registers agree**

`ReportCodeSchema` is *"a `z.enum` of the codes whose route exists … a wire-validation convenience, never a second register"* (§4.16.3). Append this slice's eight, in §4.16.1's register order, and add one case to `packages/db/test/reports/hr-definitions.test.ts`:

```ts
  it("ReportCodeSchema holds every 8D code and nothing 8D did not ship", () => {
    const wire = new Set(ReportCodeSchema.options as readonly string[]);
    for (const code of HR_CATALOGUE) expect(wire, code).toContain(code);
    // The other direction: a wire member starting `hr.` that is not in §4.16.1's 8D register is a
    // literal invented outside the register (hazard 32).
    for (const code of [...wire].filter((c) => c.startsWith("hr."))) {
      expect(HR_CATALOGUE as readonly string[], code).toContain(code);
    }
  });
```

- [ ] **Step 2: Apply the pack and prove the loader takes the directory**

Add one case to 7A's `packages/db/test/seed/reports.test.ts` — the file that already exercises `loadReportDefinitions` over a temporary pack — reading the **real** `8d/` directory instead of a fixture:

```ts
  it("loads the eight shipped 8d/ definitions from the real pack, idempotently", async () => {
    const first = await loadReportDefinitions(db.rw, ctx(), join(REPO_ROOT, "packages/db/seed/my"), s.company);
    expect(first.codes.filter((c) => c.startsWith("hr."))).toHaveLength(8);
    const second = await loadReportDefinitions(db.rw, ctx(), join(REPO_ROOT, "packages/db/seed/my"), s.company);
    expect(second.codes).toEqual(first.codes);
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.report_definition
                           where company_id = ${s.company} and code like 'hr.%'`);
    expect(row!.n).toBe(8);         // upsert on (company_id, code, version), never a second row
  });
```

Then apply it for real against a seeded tenant, which is this slice's §3.4.8 sub-pack task:

```bash
bun run seed --tenant "$TENANT_ID" --only reports
```

- [ ] **Step 3: Append the four regression blocks**

Each is a `describe("LEGACY-NNN <Part I heading> — 8D", …)` **appended** to a file 0B created; no earlier block is edited (§3.7.3). This is the shape 8B, 8C and 7C all use for their own appends (8b:3091, 8c:3896, 7c:5878) — **not** `thinRegression(...)`, whose `describe` title hard-codes `— 0B` (0b:5317–5322) and which therefore cannot title an 8D block. Each block below carries its own imports and its own `beforeAll`, so it is self-contained and an earlier block's bindings are never borrowed.

Two blocks are pure source scans and need no database; two need the payroll corpus and seed a **fresh** tenant of their own through `seedTenantV2` rather than reaching for `sharedDb()`'s `a` or `b` — 8B and 8C already run payroll fixtures against those seeds, and `payrollFixture` makes no idempotency promise.

`tests/regression/legacy-011.test.ts` — *NULL statutory inputs and silent zeroes.* 8B proved the **refusal** and 8C the **schedule**; this block proves the **output** half. Add these imports at the top of the file, beside the ones already there:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency } from "@dulja/domain";
import { payslipRows, reconcileParallelRun } from "@dulja/db";
import { seedTenantV2, startDb, withTenant, type Db, type Seed } from "@dulja/db/test";
import { hrReportFixture, type HrReportFixture } from "../invariants/support/hr-reports";
```

```ts
describe("LEGACY-011 Statutory figures computed from NULL inputs — 8D", () => {
  const MYR = currency("MYR");
  let db: Db; let s: Seed; let f: HrReportFixture;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "legacy-011-8d");
    f = await hrReportFixture(db, s);
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  it("every payslip bundle carries a complete set of 4 dp figures, never a null or an empty string", async () => {
    const bundles = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId }));
    expect(bundles.length).toBeGreaterThan(0);
    for (const b of bundles) {
      for (const field of ["gross", "totalDeductions", "net"] as const) {
        expect(b.header[field], `${b.header.employeeNumber}.${field}`).toMatch(/^-?\d+\.\d{4}$/);
      }
    }
  });

  it("an employee the legacy run paid and Dulja did not is REPORTED, never silently dropped", async () => {
    const report = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reconcileParallelRun(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId, baseCurrency: MYR },
        [{ employeeNumber: "E-NOT-IN-DULJA", gross: "1.0000", totalDeductions: "0.0000", net: "1.0000", schemes: {} }]));
    expect(report.differences.some((d) => d.kind === "missing_in_dulja")).toBe(true);
    expect(report.cleanToTheCent).toBe(false);
  });
});
```

`tests/regression/legacy-020.test.ts` — *no rate in code.* A pure source scan: no database, no fixture, and therefore no `beforeAll`. Add these imports at the top of the file:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoFile } from "../support/regression";
import { REPO_ROOT } from "../support/source";
```

```ts
describe("LEGACY-020 Statutory rates hard-coded in application logic — 8D", () => {
  const FILES = [
    "packages/db/src/reports/datasets/hr.ts", "packages/db/src/hr/payslip.ts",
    "packages/db/src/hr/reconcile.ts", "packages/db/src/hr/rotate.ts",
  ];

  it("no 8D source file contains a percentage or contribution literal", () => {
    for (const path of FILES) {
      const text = repoFile(path);
      // A bare decimal between 0 and 1, or a `* 0.xx` / `/ 100` shape, is what a rate looks like in code.
      expect(text, path).not.toMatch(/[*/]\s*0?\.\d/);
      expect(text, path).not.toMatch(/\/\s*100\b/);
    }
  });

  it("no 8D report definition contains a numeric value at all — every figure comes from the data", () => {
    const dir = join(REPO_ROOT, "packages/db/seed/my/reports/8d");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const def = JSON.parse(readFileSync(join(dir, name), "utf8")).definition as Record<string, unknown>;
      // `version` and each column's `width` are the only numbers a definition may carry.
      const numbers: string[] = [];
      JSON.stringify(def, (key, value) => {
        if (typeof value === "number" && key !== "version" && key !== "width") numbers.push(`${key}=${value}`);
        return value;
      });
      expect(numbers, name).toEqual([]);
    }
  });

  it("the only statutory identifiers 8D names are COLUMNS, never values", () => {
    const text = repoFile("packages/db/src/reports/datasets/hr.ts");
    expect(text).toContain("scheme_code");
    expect(text).toContain("rate_table_version");
    for (const scheme of ["EPF", "SOCSO", "EIS", "PCB"]) expect(text, scheme).not.toContain(scheme);
  });
});
```

`tests/regression/legacy-033.test.ts` — *sensitive reads gated by an RLS predicate on the actor's permission, never by a parameter.* The report-side clause of **test 32**. Its first two cases are source scans; its third needs two principals with different codes, so the block seeds its own. Add these imports at the top of the file:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHrKeyRing, DEV_HR_KEY, permitExpiry, writeSensitive } from "@dulja/db";
import { grantCodes, seedEmployee, seedTenantV2, startDb, uuidv7, withTenant, type Db, type Seed }
  from "@dulja/db/test";
import { repoFile } from "../support/regression";
import { REPO_ROOT } from "../support/source";
```

```ts
describe("LEGACY-033 Sensitive employee data readable through a side channel — 8D", () => {
  const SENSITIVE = ["national_id", "passport", "date_of_birth", "bank_account", "residency_category",
    "epf_number", "socso_number", "tax_number", "work_permit_expiry"];
  const RING = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
  let db: Db; let s: Seed;
  let holder: string;      // holds hr.employee.read_sensitive
  let outsider: string;    // holds hr.employee.read only

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "legacy-033-8d");
    await grantCodes(db, s, { codes: ["hr.employee.read", "hr.employee.read_sensitive"] });
    holder = s.human;
    outsider = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.principal (id, tenant_id, kind, auth_subject, display_name)
               values (${outsider}, ${s.tenant}, 'human', ${`stub:legacy033-${outsider}`}, 'Outsider')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${outsider})
               on conflict do nothing`;
    });
    await grantCodes(db, s, { codes: ["hr.employee.read"], principalId: outsider, roleCode: "legacy033-clerk" });
    const withPermit = await seedEmployee(db, s, { employeeNumber: "E-7001" });
    await withTenant(db.rw, s.tenant, holder, (tx) =>
      writeSensitive(tx, RING, withPermit, { work_permit_expiry: "2026-02-15" }));
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  it("no 8D report definition names a sensitive, compensation or statutory-profile field", () => {
    const dir = join(REPO_ROOT, "packages/db/seed/my/reports/8d");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(join(dir, name), "utf8");
      for (const field of [...SENSITIVE, "compensation", "statutory_profile", "marital_status"]) {
        expect(text, `${name} names ${field}`).not.toContain(field);
      }
    }
  });

  it("no HR dataset joins a gated table — a dataset cannot decrypt and must not try", () => {
    const text = repoFile("packages/db/src/reports/datasets/hr.ts");
    for (const table of ["employee_sensitive", "compensation_line", "employee_statutory_profile"]) {
      expect(text, table).not.toContain(table);
    }
  });

  it("the permit list is empty for a principal without the code and non-empty for one with it — the gate is the POLICY", async () => {
    const without = await withTenant(db.rw, s.tenant, outsider, (tx) =>
      permitExpiry(tx, RING, { companyId: s.company, withinDays: 100_000 }));
    const with_ = await withTenant(db.rw, s.tenant, holder, (tx) =>
      permitExpiry(tx, RING, { companyId: s.company, withinDays: 100_000 }));
    expect(without).toEqual([]);
    expect(with_.length).toBeGreaterThan(0);
    // Same code path, same parameters, two actors: nothing in TypeScript branched on a permission.
  });
});
```

`tests/regression/legacy-085.test.ts` — *RTL/LTR parity.* The payslip half, recorded against the defect. It needs a running API and a posted run, so it seeds its own through `startApi` rather than borrowing `sharedApi()`'s seeds — which 7C's own LEGACY-085 block already shares. Add these imports at the top of the file:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
import { REPO_ROOT } from "../support/source";
import { pdfText } from "../support/pdf";
import { payrollFixture, postPayrollRun } from "../invariants/support/payroll";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
```

```ts
describe("LEGACY-085 Arabic and English layouts diverge — 8D", () => {
  let api: StartedApi; let s: Seed; let runId: string;

  beforeAll(async () => {
    api = await startApi();
    // `seedTenantV2` + `payrollFixture`, not 8A's `hrFixture`: both seed a `SYNTH` statutory_scheme and
    // the table is `unique (company_id, code)` (8a:4248), so the two cannot share a company. Task 5's
    // route test carries the same note for the same reason.
    s = await seedTenantV2(api.db, "legacy-085-8d");
    const payroll = await payrollFixture(api.db, s);
    await grantCodes(api.db, s, { codes: ["hr.filing.generate", "hr.payroll.read"] });
    runId = await postPayrollRun(api.db, s, payroll, {
      periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-01-28",
      effectiveDate: "2026-01-31", kind: "regular",
    });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  /** Generate for one language, download the first attachment, return its rendered text. The same three
   *  lines Task 5's route test uses, kept FILE-LOCAL because §4.17.1 assigns this slice no third shared
   *  helper and hazard 9 forbids inventing one beside the register. */
  const payslipText = async (lang: "en" | "ar"): Promise<string> => {
    const gen = await api.request({ method: "POST", as: s.human, body: { lang },
      path: `/v1/companies/${s.company}/payroll-runs/${runId}/payslips` });
    expect(gen.status).toBe(201);
    const { items } = await gen.json() as { items: { attachmentId: string }[] };
    const res = await api.request({ method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/attachments/${items[0]!.attachmentId}/content` });
    return (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");
  };

  it("the payslip renders each language's own labels and identical figures", async () => {
    const en = await payslipText("en");
    const ar = await payslipText("ar");
    expect(en).toContain("Amount");
    expect(ar).toContain("المبلغ");
    expect(ar).not.toContain("Amount");
    const amounts = (t: string) => (t.match(/\d+\.\d{2,4}/g) ?? []).sort();
    expect(amounts(ar)).toEqual(amounts(en));
  });

  it("both directions come from ONE definition — there is no second Arabic file", () => {
    const dir = join(REPO_ROOT, "packages/db/seed/my/reports/8d");
    expect(readdirSync(dir).filter((n) => n.includes("-ar") || n.includes("_ar"))).toEqual([]);
    const d = JSON.parse(readFileSync(join(dir, "hr.payslip.json"), "utf8")).definition;
    for (const c of d.columns) { expect(c.labelEn).toBeTruthy(); expect(c.labelAr).toBeTruthy(); }
  });
});
```

**Why none of the four uses `thinRegression` / `fullRegression`, recorded so a reviewer does not read it as an omission.** 0B's `thinRegression(legacyDefect, heading, cites, body)` builds `describe(\`${legacyDefect} ${heading} — 0B\`)` (0b:5317–5322): the slice suffix is a literal, so an 8D block routed through it would announce itself as 0B's. `fullRegression` has the same shape. 8B, 8C and 7C therefore all append a bare `describe(… — <slice>)` with their own context, and these four follow them. What the wrappers exist to enforce — one `describe` per defect per slice, naming the defect and citing it — is satisfied by the titles above.

- [ ] **Step 4: Run the re-run matrix**

| Test | What is re-run here | Command |
|---|---|---|
| **23** RTL/LTR parity | the payslip PDF in both directions | `bun run --cwd apps/api test test/routes/hr/payslips.test.ts` |
| **31** SoD | the ⚠️ leave-approval clause (Task 8) | `bun run --cwd apps/api test test/routes/hr/leave.test.ts` |
| **32** no sensitive side channel | the report and dataset clauses | `bun run test --filter @dulja/tests -t "LEGACY-033"` |
| **33** golden payroll | payslips byte-identical **at the text layer** across generations | `bun run --cwd apps/api test test/routes/hr/payslips.test.ts -t "test 33"` |
| **30** payslip ties to the ledger | Σ net = the `2400` credit, through `hr.payroll_register` | `bun run --cwd packages/db test test/reports/hr-definitions.test.ts -t "salaries payable"` |
| **12/13** isolation and audit | the four ⚠️ leave tables and the new job | `bun run test --filter @dulja/tests` |

Run all six. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/accounting/reports.ts packages/contracts/openapi.json \
        packages/db/test/seed/reports.test.ts packages/db/test/reports/hr-definitions.test.ts \
        tests/regression/legacy-011.test.ts tests/regression/legacy-020.test.ts \
        tests/regression/legacy-033.test.ts tests/regression/legacy-085.test.ts
git commit -m "test(regression): widen ReportCodeSchema by eight and append the 8D blocks [8D T11]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Slice exit — the Phase 8 report against the definition of done, and `AGENTS.md`

spec:110: *"**Report per phase**, in writing, against the definition of done — what passes, what does not, what you decided under ADR, what you are asking. Short."* §3.8: *"the last task of every slice that completes a phase (0E, 1B, 2C, 3D, 4B, 5B, 6D, **8D**, 9B) rewrites the 'Current phase' section."* 8D is the last slice of Phase 8, so both land here.

**Files:**
- Create: `docs/reports/phase-8-definition-of-done.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: no importable name. Its inputs are **commands and documents**: the six of Step 1 (`bun run lint`, `format:check`, `lint:rules`, `typecheck`, `test`, and `bun run --cwd packages/db db:lint`), this plan's *Definition of done for this slice* table, 8A's, 8B's and 8C's own exit reports, ADRs 0079 and 0080 (Tasks 5 and 7), and the four owner-gate answers.
- Produces: **nothing importable.** Its outputs are `docs/reports/phase-8-definition-of-done.md` and the rewritten "Current phase" section of `AGENTS.md` (§3.8).

- [ ] **Step 1: Run the whole suite from a clean database**

```bash
bun run lint && bun run format:check && bun run lint:rules && bun run typecheck && bun run test
bun run --cwd packages/db db:lint
```

Expected: green throughout, `0 violations`. **Record the exact output in the report** — spec:110 asks what passes, and an assertion without evidence is not an answer (§verification-before-completion).

- [ ] **Step 2: Write `docs/reports/phase-8-definition-of-done.md`**

Four sections, short.

**What passes.** One row per DoD clause with the command that proves it, taken from this plan's *Definition of done for this slice* table plus 8A's, 8B's and 8C's own exit reports: the run posts through the posting service under pinned policy and rate-table versions (8B, tests 28/29); Σ payslip net = the salaries-payable credit (Task 5's `payslipRows` case and Task 4's `hr.payroll_register` tie-out); each scheme's schedule = its payable to the cent (Task 4's `hr.payable_reconciliation` per-scheme `241n` ledger_sum — **not** its `statutory_schedule` projection arm, both of whose sides read the same stored rows — and 8C's test 30); preparer ≠ approver is enforced by the data layer (8B/8C, test 31, and Task 8's leave clause if OD-13 landed); `employee_ytd` rebuilds bit-identically (8C, test 35, re-read here through the `employee_ytd` tie-out).

**What does not pass, and why.** The first clause — the one-month parallel run — **cannot be closed by CI**: it needs the owner's real staff list, the accountant-signed tables and a signature (OD-23). Task 9 ships the tool and the runbook; the clause closes when the signed report is in `docs/reports/`. State plainly that Phase 8 is **not** done until it is, and that everything else is.

**What was decided under ADR.** 0079 (payslips are attachments rendered synchronously — a **proposal**) and 0080 (the HR key-rotation procedure — a **proposal**), plus the twelve contract amendments A1–A12 of Task 0. Both ADRs are proposals under spec:95 and are listed as awaiting the owner's word.

**What is being asked.** OD-13 (leave — built or dropped, and which), OD-23 (the parallel run's four inputs), OD-28 (the two form names), OD-24 (screenshots), and the one discrepancy this plan could not resolve: the orchestrator's slice JSON lists **OD-14** among 8D's gates while §2.9's card and §2.12 both assign it to 8A/8B. One line, for the architect.

- [ ] **Step 3: Rewrite `AGENTS.md`'s "Current phase" section**

Replace it with: Phase 8 (HR & Payroll) is **feature-complete**; 8A, 8B, 8C and 8D are merged; the definition of done is met except the one-month parallel run, which awaits OD-23 and the owner's signature on `docs/reports/`'s reconciliation. Name the two new commands an engineer will reach for — `bun run payroll:reconcile` and `bun run seed --tenant <id> --only reports` — the two runbooks, and the next slice: **9B**, which needs 9A, 3D, 4B and 8D (§6.3). Keep the section the same shape 7C left it; this is a rewrite of one section, not of the file.

- [ ] **Step 4: Commit**

```bash
git add docs/reports/phase-8-definition-of-done.md AGENTS.md
git commit -m "docs: report Phase 8 against its definition of done and hand over to 9B [8D T12]

Everything but the one-month parallel run is green in CI; that clause closes on
the owner's signature (OD-23). ADRs 0079 and 0080 are proposals.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

Run against the spec and the contracts document with fresh eyes, per the writing-plans skill. Issues found were fixed inline; what follows is the record.

**1. Spec coverage.** Every clause of §2.9's 8D card and every spec section the card lists maps to a task.

| Requirement | Where |
|---|---|
| Payslip PDF per employee per run, stored as an attachment with its hash (spec:2083) | T5 |
| Annual per-employee statement and employer return from `employee_ytd` through the 7A engine, form names verified at build time (spec:2083) | T6 (⚠️ OD-28) |
| The eight `hr.*` report codes of §4.16.1, seeded into `packages/db/seed/my/reports/8d/` | T3 (3), T4 (3), T5 (1), T6 (1) |
| `employee.contract_ends_on`, migration 0098 (amendment A2) | T2 — with the datasets that read it, not with the report that renders it |
| The five spec:2091 reports specifically | `hr.employee_list` T3, `hr.payroll_register` T4, `hr.statutory_summary` T4, `hr.payable_reconciliation` T4, `hr.contract_expiry` T3 |
| `hr.attendance` from `attendance_event`, **never a pay input** (spec:2089) | T3 — `tieOut: none`, and the definition test asserts it |
| The six HR `DatasetId` members (§4.16.2) | T2 (five), T8 (⚠️ `leave_record`) |
| ⚠️ Leave register: `leave_type`, `leave_entitlement`, `leave_record` approved by a different principal, `public_holiday` (spec:2085) | T8 |
| `hr.encryption_key.rotate` re-encrypting `employee_sensitive` (spec:2273) | T7 |
| `hr.filing.generate` (§3.6.2) | T1 |
| The one-month parallel run with the written reconciliation accepted by the owner (DoD) | T9 |
| The Phase 8 report against the DoD (spec:110) and the `AGENTS.md` rewrite (§3.8) | T12 |
| Migrations 0096–0099 | 0096 T8, 0097 T1, **0098 T2** (moved there with the dataset that reads the column — gap (d) below), 0099 deliberately unused |
| ADRs 0079–0080 | T5, T7 — both proposals (spec:95) |
| Re-runs 33, 23, 31 ⚠️, 32 | T5, T5, T8, T3 + T11 |
| §3.0.4 rows spec:1059 and spec:1060 | T5/T6 and T3/T8 |
| Regression appends legacy-011, 020, 033, 085 | T11 |
| Owner gates OD-13, OD-23, OD-28, OD-24 — one isolated task each | T8, T9, T6, T10 |

**Five gaps found and closed while reviewing.** (a) spec:2091's "contract and permit expiry" had **no data source for either half** — `employee` carries no contract end date and the permit expiry is ciphertext. Closed by amendment A2 (migration 0098) and amendment A3 (the gated route), rather than by narrowing the report and hoping nobody noticed. (b) §4.16.1's `hr.annual_statement` reads `employee_ytd`, whose stored `by_scheme` is jsonb and cannot be a `DatasetRow` value; closed by unnesting the dataset in T2 and by the `employee_ytd` tie-out case in T4, which compares distinct pairs rather than summing a repeated column. (c) **Three `ledger_sum` tie-outs would have thrown before comparing anything**: 7B's `firstMoneyTotal` requires the first money `sum` total to be a key of `LEDGER_MEASURE`, and all three definitions originally summed `amount` — which is in any case a number the ledger does not hold. Closed by amendment A10: two signed measures computed in the dataset's SQL, two keys added to the map, and `hr.payslip` moved to `tieOut: none` because 7B's query has no dimension filter and would compare one employee against the whole run. (d) **Task 2 could not have gone green before Task 3**: `employeeDataset` reads `contract_ends_on`. Migration 0098 moved into Task 2, with the mirror. (e) **`hr.filing.generate` would have failed `permission-catalogue` from Task 1 until Task 5**, breaking §3.1's "green after every task"; closed by shipping `requireFilingGenerate` in Task 1, 7A's precedent. (f) **`net_contribution` counted net twice.** Its `case` had no arm for the net-pay leg's own all-null `payroll_line` (8b:4730–4734), so that row fell to `else pl.amount` and Σ came to 2 × Σnet against a `2400` credit of exactly Σnet — `hr.payroll_register`'s tie-out could not have passed. Closed by a first arm scoring the leg zero, so the measure re-derives net from the component and scheme lines; that is also what makes it an independent second path rather than a re-read of the posting's own figure. (g) **`hr.attendance` totalled `attendance_event_id`, which is a dataset column but not one of the definition's**, so 7A's validator rule 4 (7a:1988–1992) rejected it and Task 3's own Step 1 could not have gone green. The total is `employee_number`, matching `hr.employee_list` and `hr.contract_expiry`. (h) **Both leave write routes read back through a filter with no id**, so the decision handler returned the company's newest record instead of the one named in the path and its 404 branch was unreachable; closed by `LeaveRecordFilter.id` and a read-back by it on both.

**2. Placeholder scan.** A grep for `TBD|TODO|implement later|fill in|add appropriate|handle edge cases|similar to Task|and so on|etc\.` returns nothing in a code position. Every migration is complete SQL with every column, constraint, composite FK, `app_meta` call and comment. **Every code step now carries its code**, including the five that previously described it in prose: T9's `reconcile.ts`, `renderReconciliation` and `scripts/payroll-reconcile.ts` (this slice's own definition-of-done deliverable, so the least acceptable place for a description); T8's `leave.ts`, `packages/contracts/src/hr/leave.ts`, `apps/api/src/routes/hr/leave.ts` with its `PROBES` entry and `apps/api/test/routes/hr/leave.test.ts`; T7's `apps/worker/src/hr-keys.ts` and `apps/worker/test/hr/key-rotate.test.ts`; T6's two appended report-run cases; T1's `apps/api/test/hr/authorise.test.ts`. Task 11's four regression blocks carry their imports, their `beforeAll` and their `it` bodies.

**One place deliberately describes rather than transcribes:** T10, which creates **no file at all** until OD-24 lands and would be a workflow invention if it did (hazard 29, spec:108). **T8 no longer does.** It previously compressed four of its seven routes and three of its four Drizzle mirrors into two sentences; all seven `createRoute` blocks, all four mirrors, and the five service functions the `types` / `entitlements` / `holidays` routes call (`createLeaveType`, `listLeaveTypes`, `listEntitlements`, `createPublicHoliday`, `listPublicHolidays`) are now written out, with the three contracts query schemas and `LeaveEntitlementList` beside them and four new API cases so no route family is shipped untested. A task conditional on an owner decision is still a task that has to be executable when the answer is yes.

**Four ellipses remain, all standing for UNCHANGED predecessor code at a named insertion point** — 7A's twenty-six and 7C's three inside `datasets.ts`'s union and object, the body of `composeEmployeeRouter`, the `RouteModule` for `payroll-runs`, and the returned literal of `readConfig`. That is the convention every sibling plan uses; none stands for content the implementer must invent.

**3. Type consistency.** `net_contribution` and `payable_contribution` are spelled identically in T2's `DatasetColumn` list, T2's `select` clause, T4's two definitions, T4's `LEDGER_MEASURE` entry and T4's assertions — a mismatch there would make a tie-out pass vacuously against `undefined → "0.0000"`, which is the failure mode 7B's own `account_balance` case carries a comment about. `payslipRows` / `PayslipBundle` / `PayslipHeader` are spelled identically in T5's produces block, its implementation, `renderPayslip`'s parameter and T9's consumes list. `rotateSensitiveBatch` returns `RotationBatch` and the handler accumulates a `RotationResult` — two types, two names, both declared. `permitExpiry` / `PermitExpiryRow` match across `packages/db`, `packages/contracts` and `apps/api`. The six dataset consts are named `<thing>Dataset` and their `id` strings are the `DatasetId` members exactly. `HR_CATALOGUE`'s eight entries are §4.16.1's eight codes in register order, and T11 asserts that against `ReportCodeSchema` in both directions.

**4. Hazards re-checked, one by one.** Hazard 1: no rate, threshold, ceiling or formula appears anywhere — the only statutory table named is `SYNTH`, and T11's legacy-020 block scans for one mechanically. Hazard 2 (in spirit): no LHDN form name, deadline, channel or schema version, and T6's test asserts their absence. Hazard 5: T6, T9 and T10 each carry "owner provides X; verify with `<exact command>`" and a local equivalent that must print the same lines. Hazard 6: four owner decisions, four isolated tasks, each droppable. Hazard 7: no D1–D27 decision and no §2.12 item is re-opened. Hazard 8: every Plan 0A helper is cited by its exact name. Hazard 9: `fixtures.ts` gains nothing, and the two shared test helpers are registered by A6 and A7. Hazard 13: `lint-schema.ts` is not edited. Hazard 14: migrations 0096–0098 are inside the range, 0099 is left unused, and no plan asserts `max(version)`. Hazard 20: the rotation job runs as the system principal in many short transactions. Hazard 22: `app.employee_ytd` is read and never written. Hazard 28: 7A and 2C are in the phase gate and T0 asserts both. Hazard 29: T10 is blocked. Hazard 30: the PDF engine is 2C's `engineFor`, never re-evaluated. Hazard 31: one new module, one `PROBES` key, one `JOB_PROBES` key; the two sub-paths add none. Hazard 32: no literal is invented in any of the five registers. Hazard 33: `2400`, `2411`–`2414` and `5300` are 8B's and T0 asserts they resolve.

**5. Contract additions** (also reported in the structured result): `HR_FIELD_ENCRYPTION_KEY_VERSION`; `app.employee.contract_ends_on`; the six dataset consts and the six `DatasetId` members; the two signed measure columns `net_contribution` / `payable_contribution` and their two `LEDGER_MEASURE` keys; `requireFilingGenerate`; `payslipRows` / `PayslipParams` / `PayslipHeader` / `PayslipBundle`; **`PAYSLIP_ENGINE`** (§4.5.9, beside A4) and `renderPayslip` / `RenderedPayslip` (**which carries no `sha256`** — 2C's `createAttachment` owns the hash); `createPayslipRoutes`; `permitExpiry` / `PermitExpiryParams` / `PermitExpiryRow` / `createPermitExpiryRoutes`; `rotateSensitiveBatch` / `RotationBatch` / `RotationResult` / `hrKeyRotateHandler`; **`apps/worker/src/hr-keys.ts`'s `hrKeyRing` / `setHrKeyRing` / `hrKeyRingFromEnv`** — 7A's `objectStore()` trio in shape, registered as the worker's second injected singleton; the `JobPayload["hr.encryption_key.rotate"]` shape; `reconcileParallelRun` / `renderReconciliation` / `LegacyPayslip` / `Difference` / `DifferenceKind` / `ReconciliationReport`; `requestLeave` / `approveLeave` / `rejectLeave` / `listLeaveRecords` / `setEntitlement` / `listEntitlements` / `createLeaveType` / `listLeaveTypes` / `createPublicHoliday` / `listPublicHolidays` / `RequestLeaveInput` / `SetEntitlementInput` / `LeaveRecordFilter` (**with its `id` member — both write routes read back by it**) / `LeaveRecordRow` / `CreateLeaveTypeInput` / `LeaveTypeRow` / `LeaveTypeFilter` / `LeaveEntitlementRow` / `LeaveEntitlementFilter` / `CreatePublicHolidayInput` / `PublicHolidayRow` / `PublicHolidayFilter`, the four Drizzle mirrors `leaveType` / `leaveEntitlement` / `leaveRecord` / `publicHoliday`, and `leaveRoutes` / `leaveRouteModule` with its seven routes (contracts side: `LeaveTypeQuery`, `LeaveEntitlementQuery`, `PublicHolidayQuery`, `LeaveEntitlementList`); `ApiConfig.hrFieldEncryptionKeyVersion`; the two `assertTieOut` projection cases; and `tests/invariants/support/hr-reports.ts`'s exports — **nine**, not seven: `HrReportFixture` gains `schedules` and `draftRunDocumentId`, both consumed by four test files.

**6. Open questions this plan could not resolve, carried to the architect.** (a) The orchestrator's slice JSON lists **OD-14** among 8D's gates; §2.9's card lists OD-28 instead and §2.12 assigns OD-14 to 8A/8B. The card and the ledger agree and this plan follows them — one line settles it. (b) **7B's Task 14 asserts the `DatasetId` union holds 25–26 members and none of 7C's three** (7b:5288–5296). That case is red the moment **7C** merges, before 8D touches anything — a 7C-side omission this slice cannot fix without editing another slice's pin to accommodate its own. Task 2 Step 6b tells the executor to file it in the PR description and leave it to 7C. 8D's own three pins (7A's literal array, 7C's length, its own `hr-datasets.test.ts`) are all moved in the same commits as the registry change, per §3.7.3. (c) 8A's `app.forbid_self_pay()` is assumed to take the employee-key column name as a trigger argument (T8 Step 3); if it shipped as a per-table function, T8 attaches whatever 8A shipped and this note is the record. (d) **Amendment A10 edits 7B's `LEDGER_MEASURE` map**, which §4.17.1 registers to 7B. It adds two keys and changes none, on exactly A6's terms — but A6 was foreseen by 7B's own row ("extended additively by 7C and 8D") and this one was not, so the architect should confirm the map is extensible on the same footing as the `projection` switch, or say where a per-slice measure should live instead. (e) **Should `net_contribution` map to `"net"` rather than `"credit"`?** A *negative-net* supplementary run posts the net leg as a **DEBIT** to `2400` (8c:6097–6107 seeds exactly that shape), so Σ`net_contribution` over such a run is negative while `sum(base_credit)` for it is zero and `sum(base_debit)` carries the figure. Under `"credit"` the two sides would disagree by the whole amount. **Nothing in 8D fails**: `hrReportFixture` posts one ordinary regular run and `hr.payroll_register` is scoped to one `payrollDocumentId`, so the case never arises here — but it will arise in the parallel run the moment a recovery exceeds a month's earnings. The mapping is left as `"credit"` because 7B owns `LEDGER_MEASURE`'s sign convention and this plan cannot verify from here what its `"net"` arm subtracts from what; the question is filed rather than answered. (f) **`hr.payroll_register`'s ledger window carries no `fromDate` / `toDate`** (Task 4 Step 1's second case passes only `documentTypeCodes` and `accountCode`), so the ledger side sums **every** PAYROLL credit to `2400` in the company while the report side is scoped to one run by `payrollDocumentId`. It holds today because the corpus posts exactly one run — the identical fragility the `hr.statutory_summary` case already carries a warning about, and the identical fix if a second posted run ever joins the fixture.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-8d-payroll-outputs-reports-parallel-run.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task with review between tasks. It suits this slice: Tasks 0–5 are strictly ordered (T2 ships migration 0098 *and* the datasets that read it, T3's definitions need those datasets, and T4's tie-outs need both), while **T6, T7, T8, T9 and T10 are independent of each other** and each is a single owner gate that can be dispatched, skipped or deferred without touching its neighbours. T11 and T12 run last, in that order.

**2. Inline Execution** — batch execution with checkpoints, using `superpowers:executing-plans`. Sensible checkpoints: after T1 (the catalogue and the gate), after T5 (payslips — the largest deliverable), after T9 (the DoD tool), and at T12.

**Before either:** confirm the phase gate — `bun run --cwd packages/db test test/hr/predecessors.test.ts` must pass, which means 8C, 7A, 2C, 8B, 8A and 6C are all merged. **Which approach?**

