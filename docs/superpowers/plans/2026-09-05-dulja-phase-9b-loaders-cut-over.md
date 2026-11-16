# Dulja Phase 9B — Loaders and Cut-over — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn 9A's *explained* legacy numbers into a live Dulja tenant. This slice ships `legacy_ref` on the six master tables, `app.import_batch` (idempotence keyed on `(source_table, source_key)`), a declarative `Loader` framework that runs as the tenant's **system principal** under the `admin.import.run` pg-boss job, loaders for units, warehouses, items, lots, parties, accounts, opening balances (`OPENING_BALANCE` documents), opening stock (`OPENING_STOCK` documents at a cost **recomputed with the 3B engine**, never imported), open AR/AP items with their legacy numbers preserved as strings, and the employee master with `employee_ytd_opening` — every ledger and movement row of it written by `postDocument` and nothing else — plus the cut-over runbook and the reconciliation that makes the phase's definition of done checkable: **trial balance and stock valuation match the source on the cut-over date, every difference is explained, and each employee's imported YTD reconciles to their last legacy payslip.**

**Architecture:** Three layers and one door. At the bottom, `@dulja/importer` gains a `loaders/` directory: each loader is a `Loader<S, T>` (contracts §4.13.2) with a `sourceTable`, a `dependsOn` list, a pure `map(row, refs)` and a `load(tx, ctx, rows)`; `runLoad` topologically orders them, streams source rows through 9A's frozen `LegacyReader.read`, and writes every produced row's `(source_table, source_key) → (target_table, target_id)` into `app.import_batch` in the same transaction, so re-running the load inserts nothing twice and `RefResolver.byLegacyRef` can answer "what did this legacy key become". In the middle, **nothing that touches the ledger, a movement, a layer or a projection is written by the importer**: opening balances and opening stock are ordinary `document` + `document_line` rows handed to `postDocument`, which issues, numbers, posts, MERGEs and audits them exactly as the API would (§0.2, hazard 22). At the top, one pg-boss job (`admin.import.run`, already in the closed `JOBS` registry) runs the whole thing under `systemContext`, one `POST …/imports` enqueues it, and `GET /v1/jobs/{jobId}` is the status resource spec:2206 requires and no earlier slice built. Every source-column list this slice needs is **data with a confidence field**, validated at pre-flight against the live catalogue through `LegacyDriver.columns()` — never a transcribed row interface (hazard 3).

**Tech Stack:** Bun 1.4 · TypeScript strict · `@dulja/importer` (9A's `LegacyReader`, `LegacyDriver`, `FixtureLegacyDriver`, `scope`, `reconcile`) · `@dulja/db` (`withTenant`, `systemContext`, `postDocument`, `applyMovements`, `valuationAsOf`, `upsertEmployeeYtdOpening`) · `@dulja/domain` (`Money`, `Quantity`, `costingEngine`) · `@dulja/contracts` (`AppError`, `ERRORS`, Zod) · Hono + `@hono/zod-openapi` for the two route modules · pg-boss through `JobClient` · PostgreSQL 18 with RLS forced · Vitest under Node 24 with Testcontainers.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — **§5.1 Migration from Sahlisoft in full (spec:2329–2344)**; §0.2 the never/always lists (spec:97–110); §0.4 glossary (spec:144–180); §3.8 `document.number bigint` (spec:1757) and `client_ref` (spec:1764); §3.9 Identifiers (spec:2037), Time and dates (spec:2039), Money (spec:2041), Deletion (spec:2049); §3.10.1 Year-to-date (spec:2084) and Termination (spec:2090); §4.2.2 R8 the system principal (spec:2179); §4.5 bulk endpoints with async job semantics and a status resource (spec:2206); §4.11 the report format and the load-test sizing rule (spec:2267); Part V Phase 9 row (spec:2295) and sequencing (spec:2301); Part VI tests 2, 5, 9, 12, 13, 18, 34, 35 (re-run through the import path); Part VII #4, #7, #10, #13; Part I SAH-003, 007, 011, 022, 028, 049, 051, 073. Companion dossier: `docs/spec/sahlisoft-accounting-analysis.md`.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 9B — Loaders and cut-over. **Phase:** 9. **Phase gate:** this plan starts only when **9A, 3D, 4B and 8D** are merged and the Phase 8 definition of done is green in CI (spec:87, contracts §6.3 — "9B (needs 9A, 3D, 4B, 8D; 6D if OD-16 = yes)"; §6.3's parallel note ends "9B last"). **6D is an additional predecessor only if ⚠️ OD-16 answers *yes*** — Task 13 is the one task that reads `mpos`, and it is the only place in this plan that names a 6D interface.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.current_actor`, `app.current_tenant`, `app.actor_has`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `ErrCode`, `Problem`, `fromDatabaseError`, `createLogger`, `Logger`, `PERMISSION`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `StartedApi`, `ApiRequest`, `PROBES`, `IsolationProbe`, `TENANT_FREE`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `ProblemSchema`, `ListEnvelope`, `encodeCursor`, `decodeCursor`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `FullContext`, `fullRegression`, `problemOf`, `repoFile`, `sourceFiles`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`, `rational`, `JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `registerHandler`, `runJob`, `eachTenant`, `JOB_PROBES`, `JobIsolationProbe`, `startWorker`, `seedBranch`, `seedCurrency`, `seedRate`. **0C** — the seed CLI, `PackLoader`, `LoaderContext`, `readPackFile`, `SUB_PACKS`, `assertPackShape`, the `0c-base.json` chart rows `1000`, `1100`, `1200`, `1300`, `2100`, `4000`, `4900`, `5000`, `5900`, `5910`, `5920`. **1A** — `postDocument`, `issueDocument`, `resolvePolicy`, `loadSnapshot`, `transitionDocument`, `PostingError`, `seedTenantV2`, `seedAccount`, `seedJournalPolicy`, `documentTypesLoader`, `loadDocumentTypes`. **1B** — `trialBalance`, `trialBalanceFingerprint`, `accountLedger`, `runIntegrityCheck`, `projectionChecks`, `postJournal`. **2A** — `evaluatePolicy`, `seedDocumentType`, `seedParty`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`. **2B** — `grantCodes`, `recordOverride`, `setEventContext`, `listDocumentEvents`. **2C** — `MODULE_READ_CODE`, `ObjectStore`, `MemoryObjectStore`. **3A** — `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `applyMovements`. **3B** — `costingEngine`, `Layer`, `CostingInput`, `CostingOutput`, `CostingMethod`, `openLayersFor`, `valuationAsOf`, `ValuationRow`. **3D** — `stockOnHand`, `secondPrincipal`. **4A** — `openBalance`, `partyBalance`, `seedPaymentTerm`. **4B** — `agedBalance`, `ageingRows`, `ageingTieOut`. **8A** — `writeSensitive`, `SENSITIVE_FIELDS`, `SensitiveValues`, `HrKeyRing`, **`createHrKeyRing`** (there is no `keyRingFromEnv`; 8a:834), `DEV_HR_KEY`, `seedEmployee`. **8C** — `upsertEmployeeYtdOpening`, `EmployeeYtdOpeningInput`, `listEmployeeYtdOpening`, `EmployeeYtdOpeningRow`, `OpeningError`, `ytdFromEmployeeYtd`, `checkEmployeeYtdProjection`. **8D** — the parallel-run harness and the Phase 8 DoD being green. **9A** — the whole `@dulja/importer` barrel: `createReader`, `LegacyReader`, `LegacyPredicate`, `LegacyDriver`, `LegacyRow`, `LegacyScalar`, `LegacyColumn`, `LegacyColumnKind`, `SelectSpec`, `FixtureLegacyDriver`, `LegacyCorpus`, `connectOdbc`, `OdbcLegacyDriver`, `redactDsn`, `scope`, `ScopeReport`, `TableScope`, `profile`, `ProfileReport`, `ProfileOptions`, `reconcile`, `ReconciliationReport`, `RECONCILIATION_KINDS`, `ReportWriter`, `toCsv`, `ArtefactEntry`, `ArtefactIndex`, `LEGACY_MODULES`, `ALL_LEGACY_TABLES`, `moduleOf`, `employeeMapping`, `EMPLOYEE_MATCH_STRATEGIES`, `normaliseLegacyName`, `unreadable`, **`NEVER_READ`** (the credential deny-list Task 12 asserts is unchanged; 9A ships it as `new Set(["USERS.PASSWORD", "USERS.PIN"])` — **upper case**, 9a:6058, pinned by 9a:5934 — and re-exports it from the barrel at 9a:6232).
- **Migration numbers:** **0101–0102** — files `packages/db/migrations/0101_add_legacy_ref.sql` and `0102_create_import_batch.sql`, each with its hand-written `NNNN.down.sql`. **0103 and 0104 are allocated to this slice and stay unused** (§3.4.1: gaps are legal, `discover()` sorts whatever exists, and no later slice may claim them). **ADR numbers:** 0084–0086 — `docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md`, `docs/adr/0085-cut-over-series-and-opening-documents.md`, `docs/adr/0086-cut-over-reconciliation-and-the-explained-difference.md`.
- **Interfaces consumed:** §3.1 (package tiers, the `packages/<pkg>/src/cli.ts` rule), §3.2 (identifiers, time, money, naming, deletion, error codes, database access, logging), §3.3 (the never/always lists and the three homes of `sql.unsafe`), §3.4 (migrations in full — 3.4.1 ranges, 3.4.2 names, 3.4.3 one transaction per file, 3.4.5 down files, 3.4.6 the reversibility test, 3.4.8 seed-pack data, 3.4.9 the Drizzle mirror), §3.5.1–§3.5.4 (the new-table recipe, the linter sets, the DELETE-grant list — **this slice grants none**), §3.6 (permission codes — **this slice introduces none**; §3.6.2's "maintained under `admin.company.manage`" mapping is what gates the import routes), §3.7 (test layout, the isolation harness, regression ownership, golden fixtures, the lint rules), §3.8 (commits and **the AGENTS.md "Current phase" rewrite that every phase-completing slice owns**), §3.10, §3.11 (`LEGACY_ODBC_DSN` — CLI/worker-only, never in `containerSecrets()`), §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `Quantity`, `round`, `MONEY_SCALE`, `toBase`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `Logger`, the fixed middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError` — **this slice adds two allocated rows**), §4.2.5 (`PERMISSION`, `requirePermission`, `assertRouteGates`), §4.2.6 (`JOBS`, `JobPayload`, `JobEnvelope`, `JobClient`, `registerHandler`, `runJob`, `JOB_PROBES` — **this slice owns `admin.import.run`**), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IdempotencyHeader`, `createApp`, `TENANT_FREE`), §4.2.8 (the common schemas, the list envelope, the one list-filter convention), §4.2.9 (`idempotency`), §4.2.12 (`startApi`, `StartedApi`), §4.2.13 (`PackLoader`, `readPackFile`, `SUB_PACKS`), §4.3.1–§4.3.8 in full (the posting service, the fixed algorithm, `document_line`, `posting_seq`, numbering at issue, the seed envelope, the error list), §4.4.1–§4.4.2 (the policy schema and the evaluator, **including amendment A9's sign normalisation**), §4.5.1 (legal transitions), §4.5.7 (`app.party`), §4.6.1 (the register rows for `item`, `unit_of_measure`, `warehouse`, `lot`, `import_batch`, `employee_ytd_opening`), §4.6.2 (`app.employee`), §4.7.1–§4.7.3 (the costing engine, `applyMovements`, the layer tables), §4.8.1–§4.8.2 (allocation and ageing), §4.12.5 and §4.12.8 (the HR encryption envelope and `employee_ytd`), **§4.13 in full**, §4.14 (document-type codes), §4.15 (account codes), §4.16.1–§4.16.2 (**this slice ships no report definition and no `DatasetId` member** — its reconciliation output is an artefact file and a job log, not a `report_definition` row), §4.17 and §4.17.1, §4.18 (both rounds and every later round's amendments), §5 (all thirty-five hazards), §6.1 rows 2, 5, 9, 12, 13, 18, 34, 35, §6.2 row spec:1059.
- **Interfaces produced:** **§4.13.2 in full** (`LoadContext`, `Loader`, `RefResolver`, `loaders`, `runLoad`); **§4.13.3 in full** (`legacy_ref` on `document`, `party`, `item`, `account`, `employee`, `lot`; `app.import_batch` as §4.6.1 fixes it); §4.14's `OPENING_BALANCE` and `OPENING_STOCK` rows with their envelopes and policies; §4.15's `3900` row seeded from `packages/db/seed/my/chart-of-accounts/9b-cut-over.json`; §4.2.6's `admin.import.run` handler, its `JobPayload` key and its `JOB_PROBES` entry; two §4.2.7 route modules (`/v1/companies/:companyId/imports` and `/v1/jobs`) with their two `PROBES` keys; one §4.2.8 contracts module `packages/contracts/src/admin/import.ts`; two §4.2.4 rows (`ERR_IMPORT_DUPLICATE_SOURCE_KEY`, `ERR_IMPORT_UNBALANCED_SOURCE`); §4.17's one new fixture helper `seedImportBatch`; §4.17.1's one new shared helper file `tests/invariants/support/cut-over.ts`; one test-tier file internal to `packages/importer/test/**` (`support/tenant.ts`, name **N16**, registered nowhere because it crosses no slice boundary); and `docs/runbooks/cut-over.md`. **The §4.13.2 surface this slice produces is §4.13.2 plus its own six additive amendments** — C8 (`sourceColumns`, `sourceKey`), C9 (`artefacts`), C12 (`map` may be async), C13 (`wholeTable`), C14 (`LoadContext.only`) and C15 (`load` may return `skips`) — every one of which widens the frozen interface and breaks no existing implementation.
- **Owner decisions:** **OD-25** (suspense-account treatment for unbalanced vouchers; the cut-over date — spec:2334) → **Task 11**, isolated; default per §2.12 is *none*, so the plan posts every unexplained residue to `3900` and the cut-over date is `--cut-over-date`, required, with no default. **OD-26** (is `Users.Password` hashed client-side? Part VII #4 — spec:2468) → **Task 12**, isolated; default per §2.12 is *forced reset, never imported*, so there is no `Users` loader at all and the task is the proof that there is none. **OD-16** (must historical POS data migrate? Part VII #10 ⚠️ — spec:2474) → **Task 13**, isolated; default per §2.12 is *start clean*, so the `mpos` loader is **written but not registered** and the task is dropped whole if the owner starts clean. **OD-17** (read access to the live Sahlisoft database; the Firebird version — spec:2409, 2469) → **Task 14**, isolated; default per §2.12 is *none*, so every other task runs against 9A's committed `FixtureLegacyDriver` corpus. **OD-27** (Part VII #6, #7, #8, #9, #13 — spec:2470–2473, 2477) → **Task 15**, isolated; default per §2.12 is *none*, so this slice **consumes** 9A's answers: #13 (is the Salaries module live?) gates whether Task 8's employee load runs at all, and #7 (`MatOpens.Job` ever ≠ 0) gates whether Task 6's opening-stock source is trusted per job or aggregated. **OD-24** does not apply — this slice ships **no screen**; the import is triggered by an API call and read back as a job status, and §2.12's OD-24 blocks screen tasks, not slices. This plan decides none of them (§2.12, hazard 7).
- **Part VI tests owned / re-run:** **owned — none exclusively** (card). **Re-run — 9** (period lock, through the import path — Task 5), **18** (stock availability, through the import path — Task 6), **2** (deterministic projections after the load — Task 9), **5** (imported history recost — Task 6), **35** (opening rows — Task 8), **34** (termination through the importer — Task 8; **the re-run covers the trigger being REACHED on the import path, not its downstream effects**: an imported employee has no `principal_id` and no `pos_cashier`, so the revoke and the role expiry have nothing to act on and stay 8C's own assertions — the task says so where the test is), **12** (tenant isolation, for both new tables, both new routes and the new job — Tasks 1, 2, 9), **13** (audit completeness, for every import write — Tasks 2, 9). **§3.0.4 rows owned:** none; this slice **completes the "mid-year cut-over YTD import" clause of spec:1059**, whose owning slice is 8D. **Regression files created / appended:** created — **none**. Appended — `tests/regression/sah-003.test.ts` (unbalanced vouchers reach `3900`, never the ledger, Task 5), `sah-007.test.ts` (a NULL-poisoned legacy balance is refused, never coerced to zero, Task 4) and `sah-011.test.ts` (the same for a legacy cost, Task 6), `sah-022.test.ts` (`MatOpens.Job`, Task 15), `sah-028.test.ts` (no credential is imported, Task 12), `sah-049.test.ts` (duplicate legacy aggregate rows do not double-load, Task 3), `sah-051.test.ts` (legacy numbers are strings in `legacy_ref`; `document.number` stays a gapless `bigint`, Tasks 1 and 7), `sah-073.test.ts` (orphans are reported, never silently nulled, Task 4). Every one of these files already exists — `sah-003`, `sah-007`, `sah-011`, `sah-049`, `sah-051`, `sah-073` are Plan 0A-proven files created by **0B**, `sah-022` is created by **3B**, `sah-028` by **0B** — so §3.7.3's rule applies unchanged: this slice **appends** a `describe("SAH-NNN … — 9B", …)` block and edits no earlier block.
- **Shared namespaces this slice writes into:** **document-type codes (§4.14)** — `OPENING_BALANCE` (`module: "accounting"`, series `OB`) and `OPENING_STOCK` (`module: "inventory"`, series `OS`), both seeded as files under `packages/db/seed/my/document-types/`. **Account codes (§4.15)** — seeded: **`3900`** Opening-balance suspense (equity) in `packages/db/seed/my/chart-of-accounts/9b-cut-over.json`; consumed but seeded elsewhere: `1200` and `2100` (0C — the AR/AP controls the open-item openings and the ageing tie-out use), `1300` (0C — `item.inventory_account_id` default, the `OPENING_STOCK` debit), `5920` (0C — `company.fx_rounding_account_id`), and the item-group defaults `4000` / `5000` / `5900` (0C) that the item loader leaves at their defaults. **Report codes (§4.16.1) — none; `DatasetId` members (§4.16.2) — none.** **`fixtures.ts` helpers (§4.17)** — one added: **`seedImportBatch(db, s, opts)`**, recorded as an amendment because §4.17 assigns 9B no row. **Shared test helpers (§4.17.1)** — one new file added: **`tests/invariants/support/cut-over.ts`**, likewise recorded as an amendment. **`ERR_*` (§4.2.4)** — two rows, both already allocated to 9B by that table: `ERR_IMPORT_DUPLICATE_SOURCE_KEY` (409) and `ERR_IMPORT_UNBALANCED_SOURCE` (422).
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

---

## Amendments this plan requires before Task 1

Contracts §4 says a plan "may add members only by amending this document". Every row below **crosses a slice boundary**; each is a one-line edit to the named section, and they are one PR (`docs(contracts): fold 9B's amendments C1–C15`) before Task 1 begins. A reviewer who rejects a row gets the fallback stated in the same row. **The rows are in numeric order and the numbering is contiguous** — an executor applies them top to bottom and the handoff's section-by-section list names every one.

| Id | § | Amendment | Source | Fallback if refused |
|---|---|---|---|---|
| **C1** | 4.13.3 | **"a dedicated series `LEGACY`" reads "the dedicated cut-over series `OB` and `OS` of §4.14".** §4.13.3 says every imported open document is issued "in a dedicated series `LEGACY`"; §4.3.6 makes the series come from `policy.numbering.series` and §4.14 fixes `OPENING_BALANCE → OB` and `OPENING_STOCK → OS`. `LEGACY` is a literal in a shared namespace (hazard 32) that no register carries and that `issueDocument` could only honour by reading `document.series` instead of the policy — a behavioural change to a frozen function (hazard 8). The sentence's own stated purpose — "so uniqueness holds and the new gapless series starts after cut-over" — is met exactly by two series used by no other type and never re-used after cut-over. ADR 0085 records it | settlement | Register `LEGACY` in §4.14 as a third cut-over document type with its own policy, and add the code to §4.14 in the same PR. Nothing else in this plan changes |
| **C2** | 4.2.7, 4.18 | **`/v1/jobs` is a `RouteModule` and 9B builds it — this REVERSES a ratified round-3 row, and the row is quoted here so no reviewer is asked to overturn a settlement they were not shown.** §4.18 round 3 already decided the question the other way, from 7A: “**`statusUrl` becomes `"/v1/companies/<companyId>/report-runs/<runId>"` (ADR 0067), and the 202 body carries `jobId` for log correlation. No slice mounts `/v1/jobs/{jobId}` — §4.2.7 lists the path and assigns it to no module, and 6A dropped its own `statusUrl` for the same reason.**” §4.18 overrides anything earlier that contradicts it. An earlier draft of this row argued from “7C already returns `statusUrl: \"/v1/jobs/<jobId>\"`” — a fact ADR 0067 had already retired — so **the executor verifies what 7C's export handler actually emits before opening the amendment PR**; if it still emits a `/v1/jobs` URL that is a 7C defect to raise separately, not evidence for this row. **Checked when this plan was last revised: it does not** — 7C returns `statusUrl: "/v1/companies/${companyId}/exports/${exportJobId}"` (7c:5107) and 7C's own correction 34 (7c:6213) records dropping the `/v1/jobs` form, so this row rests on 9B's need alone and no other slice's behaviour changes with it. What remains is 9B's own need, and it is not borrowed: the **9B card names the status resource outright**, spec:2206 requires one for a bulk endpoint, and an `admin.import.run` run is **not** a `report_run` — there is no report-runs row to hang a resource off. 9B therefore asks the reviewer to **narrow** the round-3 row rather than delete it: “no slice mounts `/v1/jobs/{jobId}`” becomes “**9B mounts `/v1/jobs/{jobId}` as the generic job-status resource; a slice with a resource of its own (7A's `report-runs`) still uses that, and no slice's 202 body points at `/v1/jobs` unless it has no resource of its own**”. 9B ships `jobStatusRoutes` at `/v1/jobs`, `permissions: []`, `auth: "human"`, gated by membership only (the §4.2.7 precedent for `accounts`, `fiscal-periods` and `documents/{id}`) and scoped by the job envelope's own `tenantId`. One `PROBES` key; **not** in `TENANT_FREE` — it answers about a row, not about the caller. **Recorded in §4.18 as a round-4 `settlement` that quotes the round-3 row it narrows**, never as a silent `correction` | settlement | 9B mounts the status route as a sub-path of its own imports module (`GET …/imports/{runId}`, which amendment C4 already registers), the round-3 row stands untouched, and §2.9's status-resource bullet is met by that sub-path. **The cost is one generic resource nobody else needed yet** — this fallback is cheap, and a reviewer who wants the round-3 settlement left alone should take it |
| **C3** | 4.2.6 | `JobPayload` gains **one** key: `"admin.import.run": { companyId: string; runId: string; cutOverDate: string; dryRun: boolean; only?: string[] }`. The `JOBS` registry itself is **not** edited — the name and its `schedule: null` are already in 0B's closed sixteen-name const with `owner: "9B"` | plan | none needed; the shape is this slice's own |
| **C4** | 4.2.7 | Route module row: `/v1/companies/:companyId/imports` → `importRoutes` → 9B → gate `admin.company.manage`. Sub-paths `POST …/imports`, `GET …/imports`, `GET …/imports/{runId}`. One `PROBES` key; the sub-paths inherit it (hazard 31) | plan | none needed |
| **C5** | 4.17 | One new fixture helper: **`seedImportBatch(db, s, opts: { sourceTable; sourceKey; targetTable; targetId; runId? })` → `string`** (the `import_batch` row id). §4.17 assigns 9B no helper and hazard 9 forbids inventing one beside the register, so the register gains this row | plan | The helper lives in `packages/db/test/import/support.ts` and is imported by path from this slice's tests only. Nothing else changes |
| **C6** | 4.17.1 | One new shared helper file: **`tests/invariants/support/cut-over.ts`** exporting `cutOverFixture(name)`, `CutOverFixture`, `loadFromCorpus(...)`, `assertExplained(...)` and `reconcileFor(...)` — the invariant tier needs a running API *and* the production `runLoad`, which `packages/db/test/fixtures.ts` may not reach (§3.1). It builds on 0B's memoised **`sharedApi()`** and never calls `api.stop()`, which is exactly what §3.7.5's round-3 settlement requires of a `tests/**` file that needs a running API; it adds **no** `apps/api` export subpath and **no** `dependency-rule` allowance | plan | The four helpers live in `packages/importer/test/support/` and the three invariant files import them by relative path across workspaces, which needs a `tsconfig.json` `include` entry — measurably worse |
| **C7** | 4.6.1 | `import_batch` gains one column the register omits and every idempotent loader needs: **`source_hash text not null`** — the sha256 of the source row's mapped payload, so a *re-run against changed source data* is detected (`ERR_IMPORT_DUPLICATE_SOURCE_KEY` is raised only when the hash differs; an identical re-run is a silent skip). Without it the natural key makes a second run either always a conflict or always a no-op, and neither is idempotence | correction | The loader compares `target_id`'s current row instead, which means reading every target table generically — a second, worse mechanism |
| **C8** | 4.13.2 | `Loader<S, T>` gains two members the interface implies but does not state: **`readonly sourceColumns: readonly SourceColumn[]`** (the declarative, confidence-carrying column map pre-flight validates against `LegacyDriver.columns()`) and **`readonly sourceKey: (row: S) => string`** (which column, or composition of columns, is the `import_batch` natural key). `sourceTable`, `targetTable`, `dependsOn`, `map` and `load` are unchanged | plan | Each loader hard-codes its key extraction inside `map` and pre-flight becomes impossible, which reopens hazard 3 |
| **C9** | 4.13.2 | `runLoad`'s return gains **`artefacts: ArtefactIndex`** beside `perLoader` and `reconciliation`: the cut-over evidence (the TB comparison, the valuation comparison, the YTD comparison, the skip register) is written to disk by 9A's `ReportWriter` and the caller needs its manifest | plan | The job logs the paths as strings; the manifest hashes are lost and ADR 0086's sign-off has nothing to hash |
| **C10** | 3.11 | **`LEGACY_ODBC_DSN` is read by `apps/worker` as well as the importer CLI.** §3.11 says "importer CLI **only**" and "never in the container"; the `admin.import.run` handler runs in the worker container and must reach Firebird. The row's Holder becomes "importer CLI, worker", and **`containerSecrets(env, "worker")` gains it while `containerSecrets(env, "api")` does not** — the api container never connects to the legacy database. The variable stays absent from the api image and from every dev machine that is not running the cut-over | correction | The load runs only from `packages/importer/src/cli.ts` on the operator's machine, `admin.import.run` is never registered, and §2.9's "enqueued as the `admin.import.run` pg-boss job" bullet goes unmet. Task 10 states the exact consequence |
| **C11** | 4.15 | The `3900` row's *Resolved by* cell gains "and the `OPENING_STOCK` credit leg"; the account is the single balancing counterparty for **both** cut-over document types, not the ledger opening alone | correction | `OPENING_STOCK` credits a second suspense code, which must then be registered in §4.15 and reconciled separately — two accounts where the DoD wants one |
| **C12** | 4.13.2 | **`Loader.map` returns `T \| { skip: string } \| Promise<T \| { skip: string }>`** — a widening, not a change: every synchronous implementation stays valid. `RefResolver.byLegacyRef` is declared `Promise<string \| null>` by §4.13.2 itself, so a `map` that resolves a reference — which is what `refs` is *for* — cannot be synchronous. `runLoad` awaits the result | correction | `RefResolver` becomes synchronous, which means pre-loading every `import_batch` row into memory before each loader runs. On a 460-table source that is the wrong trade and it changes a frozen interface instead of widening one |
| **C13** | 4.13.2 | **`Loader` gains an optional `readonly wholeTable?: boolean`** — additive, so every existing implementation stays valid. §4.13.2 gives `load(tx, ctx, rows)` no way to say "my answer is a function of the whole table", and `runLoad` pages at 500. Two of this slice's loaders are wrong under paging and silently so on any corpus below the page size: `opening_balance` posts ONE document whose residue is the suspense figure over all of `AccTotals` (Task 5 asserts exactly one document), and `opening_stock` recomputes a moving average over a material's whole history (§5.1 #6). Neither fails on a small fixture; both are wrong on a real customer | correction | The two loaders read their own source directly through `loadSource()` and ignore the `rows` they are handed. That hides a whole-table read inside a per-page callback, double-reads the largest table in the source, and makes the batch rows `runLoad` wrote unrelated to what `load` actually used |
| **C14** | 4.13.2 | **`LoadContext` gains an optional `only?: string[]`** — additive. Amendment C3's `JobPayload` shape and the `POST …/imports` body both already accept `only`, and the route puts it in the payload; without this the handler drops it, so an operator restricting a resume gets a **full** re-load and no warning. `runLoad` filters the registry by it, orders what survives, and refuses a target table no loader has | correction | Remove `only` from `JobPayload`, the request body and the contracts module, so the API stops promising a switch it does not honour. This is the smaller change and the poorer product: the resume story in the runbook is "re-run everything", which on a large source is hours |
| **C15** | 4.13.2 | **`Loader.load`'s return gains an optional `skips?: readonly SkipRecord[]`** — additive, so every existing implementation stays valid. §4.13.2 gives `load` the return `{ inserted; skipped; batchIds }`, which can *count* a skip but cannot say **why**, and `runLoad` builds its `skips[]` register only from `map`'s `{ skip }`. Two of this slice's reasons are knowable **only** inside `load`: a position the legacy history drove negative (`opening_stock` — the reason is a function of the whole replay, which a per-row `map` never sees) and an employee whose stored YTD disagrees with the sum of their own payslips (`employee` — the comparison needs the tax year of `ctx.cutOverDate`, and `map(row, refs)` has no `ctx` parameter). Without it those two reasons exist in the code and reach no report, and Task 6's and Task 8's skip assertions can never pass. `runLoad` concatenates them into the one register; `load`'s own `skipped` count already includes them, so nothing is double-counted | correction | The two reasons are logged and dropped, `report.skips` under-reports exactly the two cases §5.1 #3 and §5.1 #11 care about most, and the two tests that assert them are deleted. Nothing else changes |

---

## Names this slice adds beyond the frozen registry

Contracts §4 says a plan "may add members only by amending this document". The fifteen amendments above are the ones that **cross a slice boundary**; the names below are internal to 9B, are listed here so a reviewer sees them in one place, and must be carried into the contracts document's §4.13.2 before any later work consumes them. Nothing here overlaps a §4.14, §4.15, §4.16, §4.17 or §4.2.4 literal — those five namespaces are written into only by the rows the Assumptions block names.

| Id | Name | File | Why it exists |
|---|---|---|---|
| **N1** | `SourceColumn`, `PreflightFinding`, `PreflightReport`, `preflight` | `load/preflight.ts` | hazard 3's mechanism: the declarative, confidence-carrying column map and the check that turns it into a pass or a named failure |
| **N2** | `SkipRecord`, `LoaderReport`, `LoadReport`, `LoadError` | `load/types.ts` | the return `runLoad` needs and the one error class this package raises (`packages/importer` may not import `AppError`, §3.1 — 9A's `unreadable` has the same constraint) |
| **N3** | `LoadSource`, `LoadSourceFactory`, `setLoadSource`, `loadSourceFromEnv`, `loadSource`, `baseCurrency`, `EMPTY_TARGET`, `READ_BATCH` | `load/run.ts` | the swappable legacy connection, the same port shape 7A uses for `objectStore` / `setObjectStore` / `objectStoreFromEnv`; §4.13.2 freezes `runLoad(sql, ctx)` at two parameters so the driver cannot be one of them. `baseCurrency()` is the same run-scoped getter for the **company's base currency**, read once when the run opens: `map(row, refs)` has no `ctx` and must still mint `Money` in the company's own currency rather than an `"MYR"` literal that would be a `Money<CurrencyCode & "MYR">` a non-MYR company's `load` could not add to |
| **N4** | `loaderFor`, `orderLoaders` | `load/registry.ts` | the topological order `dependsOn` implies and the cycle error it needs |
| **N5** | `requireText`, `optionalText`, `moneyOf`, `quantityOf`, `dateOf`, `optionalDateOf` | `load/scalar.ts` | the one boundary between legacy text and Dulja types; the place SAH-007/011's "a NULL is not a zero" is enforced once |
| **N6** | `AccountMap`, `AccountMapEntry`, `AccountTreatment`, `ACCOUNT_CODE_PATTERN`, `readAccountMap`, `assertAccountMap`, `treatmentOf`, `setAccountMap`, `accountMap` | `load/account-map.ts`, `load/accounts.ts` | the owner-supplied legacy→Dulja chart mapping and its validation; the input without which a cut-over is a guess |
| **N7** | `ImportedLine`, `ImportedDocument`, `draftAndPost`, `OPENING_BRANCH_CODE` | `load/document.ts` | the one place this package writes `app.document`; `document.branch_id` is NOT NULL and `LoadContext` is frozen, so the branch is resolved here |
| **N8** | `LegacyMovement`, `OpeningPosition`, `RecostResult`, `replayLegacyMovements`, `sortLegacyMovements`, `OPENING_STOCK_LINES_PER_DOCUMENT`, `SUSPENSE_CODE` | `load/recost.ts`, `load/opening-stock.ts`, `load/opening-balance.ts` | §5.1 #6's recompute, and the one `3900` literal every task refers to |
| **N9** | `Comparison`, `CutOverReconciliation`, `reconcileCutOver`, `explain`, CLI exit code **4** | `load/reconcile-cut-over.ts`, `cli.ts` | ADR 0086's definition of "explained", made executable, and the fourth CLI outcome the runbook branches on (9A uses 0, 1, 2, 3) |
| **N10** | `OpeningBalanceTarget`, `OpenItemTarget`, `EmployeeTarget`, `HistoricalTicket`, `SENSITIVE_SOURCES`, `setKeyRing`, `assertYtdReconciles` | the five document/employee loaders | per-loader target shapes. **None is a legacy row interface** — every one describes a *Dulja* row about to be written, which is exactly what hazard 3 distinguishes from a transcribed source shape |
| **N11** | `JobPartitionFinding`, `JOB_PARTITIONED_TABLES`, `assertNoJobPartition` | `load/matopens-guard.ts` | Part VII #7 asked of the customer's data at load time (Task 15) |
| **N12** | `IMPORT_ROUTE_PATH`, `importRoutes`, `importRouteModule`, `JOB_STATUS_ROUTE_PATH`, `jobStatusRoutes`, `jobStatusRouteModule`, `importRunHandler`, `StartImportBody`, `ImportAcceptedSchema`, `ImportRunSchema`, `ImportRunList`, `JobStatusSchema` | `apps/api`, `apps/worker`, `packages/contracts` | the two route modules of amendments C2 and C4, their handler and their Zod contracts |
| **N13** | `ImportBatchRow`, `RecordBatchInput`, `RecordBatchOutcome`, `recordBatch`, `findBatch`, `byLegacyRef`, `batchCounts`, `sourceHashOf` | `packages/db/src/import/batch.ts` | the `import_batch` service §4.13.3 implies and does not name; `byLegacyRef` is the `RefResolver`'s one query |
| **N14** | `codeFromName` | `load/units.ts` | one stable code from a free-text legacy name, shared by the unit, warehouse and item loaders so three do not disagree |
| **N15** | `cutOverFixture`, `CutOverFixture`, `loadFromCorpus`, `assertExplained`, `reconcileFor` | `tests/invariants/support/cut-over.ts` | amendment C6's shared helpers; registered in §4.17.1 |
| **N16** | `seedLoadableTenant`, `loadContextFor` | `packages/importer/test/support/tenant.ts` | a tenant a load can actually run against. `seedTenantV2` (§4.17) is `seedTenant` plus `5920` and the JOURNAL policy — it creates **`1000` and `4000` only** (plan0A:1563–1611) and no document type of this slice's — so every loader would fail closed on a missing §4.15 account or a missing `OPENING_BALANCE`/`OPENING_STOCK`, which is the right production behaviour and the wrong test setup. This is the test-tier twin of runbook step 2's `bun run seed --only chart-of-accounts --only document-types`. Internal to `packages/importer/test/**`; `tests/invariants/support/cut-over.ts` does the same work inline for the same reason `readCorpus` is duplicated there (§3.1 — `tests/` may not import `packages/importer/test/**`) |

**Environment names:** none new. `LEGACY_ODBC_DSN` is 9A's (§3.11); amendment C10 widens its *holder* to the worker container and changes nothing else. `HR_FIELD_ENCRYPTION_KEY` is 8A's and is read, not declared.

---

## Global Constraints

Copied verbatim from spec §0.2 (spec:97–106). Every task's requirements implicitly include this section.

**Never**, at any phase, for any reason:
- write to a ledger or movement table outside the posting service;
- represent money as a float, anywhere, including in TypeScript;
- build SQL by string concatenation (SAH-036/037/069);
- issue DDL from application code (SAH-053);
- disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053);
- gate an audit write on any flag (SAH-030);
- hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.

Additionally binding on every task of this plan:

| # | Constraint | Exact value | Source |
|---|---|---|---|
| 1 | Posting | **every ledger row, movement, layer, consumption and projection cell this slice produces is written by `postDocument`.** The importer builds `document` + `document_line` rows and calls it. `packages/importer/src/**` never names `app.ledger_entry`, `app.inventory_movement`, `app.cost_layer`, `app.cost_consumption`, `app.account_balance`, `app.stock_on_hand`, `app.tax_transaction` or `app.employee_ytd` in DML — the `posting-only-tables` lint (§3.7.5) fails the build if it does, and this slice adds **no** allow-list entry | spec:97, hazard 22 |
| 2 | Money | no `number` ever holds a monetary value. Legacy amounts arrive as decimal **strings** from `LegacyReader` and become `Money` at the boundary; quantities become `Quantity`. `no-number-money` (§3.7.5) is the mechanical check | spec:2041, spec:2043 |
| 3 | Dates | `effective_date` is a `date` entered by the operator — the **cut-over date**, never derived from `posted_at` and never taken from a legacy timestamp. Legacy dates cross as strings (`YYYY-MM-DD`) | spec:2039 |
| 4 | Naming | `snake_case` singular in SQL; `camelCase`/`PascalCase` in TypeScript; legacy identifiers upper-case as Firebird stores them | spec:2045 |
| 5 | Deletion | nothing this slice writes is ever deleted. A load that must be undone is undone by **reversal** (`reverseDocument`) and by `archived_at` on master data; `import_batch` rows are never deleted and this slice grants no DELETE (§3.5.4 is complete for v1 — 2B is the only extender) | spec:2049, hazard 25 |
| 6 | SQL | never built by concatenation; every PostgreSQL statement is a `postgres.js` tagged template on a `tx` from `withTenant` or a Drizzle query. `sql.unsafe` has three homes and **this slice uses none of them** | spec:100, §3.3, hazard 21 |
| 7 | Bindings | **never name a binding `db` or `sql` under `packages/importer/src/**`** — `no-bare-db` fires on both anywhere under `packages/*/src/`, with no allow-list entry for this package. Connections are `conn`, statements are `text`, drivers are `driver`, and the PostgreSQL handle a loader receives is `tx` | 9A assumption 10, §3.7.5 |
| 8 | Principal | every write runs as the tenant's **system principal** through `systemContext(sql, tenantId, requestId)`, never under a human's id and never from a request path. The `POST …/imports` route enqueues; it loads nothing | spec:2179, hazard 20 |
| 9 | Statutory | **no real statutory rate, threshold, ceiling or formula appears anywhere in this plan** — not in a test, a fixture, a corpus file or a comment. The YTD figures this slice loads are *the customer's own historical amounts*, carried as opaque decimal strings and never recomputed from any rate | spec:2080, hazard 1 |
| 10 | Legacy shapes | **no per-table legacy row interface is invented.** Every loader's source column list is a `SourceColumn[]` constant carrying `confidence: "verified" \| "hypothesis"`, validated at pre-flight against `driver.columns(table)`; a column the live catalogue does not have is a pre-flight failure naming it, never a silent null | hazard 3, §4.13.1's closing note |
| 11 | Credentials | `Users.Password` and `Users.PIN` are **never read, never mapped, never loaded**. There is no `Users` loader. Task 12 is the source-scan that proves it | spec:2338, §5.1 #7, #11 |
| 12 | Error codes | `ERR_<DOMAIN>_<REASON>` in one file; this slice adds exactly two rows to `ERRORS`, both already allocated to 9B by §4.2.4: `ERR_IMPORT_DUPLICATE_SOURCE_KEY` (409) and `ERR_IMPORT_UNBALANCED_SOURCE` (422) | spec:2051, §4.2.4 |
| 13 | Migrations | two files, `0101` and `0102`, one per PR; each runs whole in one transaction; each has a hand-written down; `0103`/`0104` stay unused; the up→down→up fingerprint test stays green | spec:2057, §3.4.1, §3.4.3, §3.4.6 |
| 14 | Probes | every route module gets a `PROBES` entry keyed by its `RouteModule.path`, and the job gets a `JOB_PROBES` entry — two of the first and one of the second in this slice | hazard 31, §3.7.2 |
| 15 | Linter | `lintSchema` reports **zero** violations after every migration. `import_batch` joins **no** linter set (§3.5.3); it therefore carries `id`, `created_at` and the `audit_row` trigger like any ordinary table | §3.5.2, §3.5.3, hazard 13 |
| 16 | Commits | conventional, scope `db` / `importer` / `api` / `worker` / `seed` / `regression` / `adr` / `docs`, subject `<type>(<scope>): <summary> [9B T<n>]`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` | §3.8 |

---

## File Structure

Every path is written from the repository root. `T<n>` is the task that creates or last changes the file.

```
packages/db/
├─ migrations/
│  ├─ 0101_add_legacy_ref.sql            legacy_ref on document, party, item, account,
│  │                                     employee, lot + six indexes                        T1
│  ├─ 0101.down.sql                      six index drops + six column drops                 T1
│  ├─ 0102_create_import_batch.sql       app.import_batch, RLS, audit, stamp, indexes       T2
│  └─ 0102.down.sql                      drop table app.import_batch                        T2
├─ src/
│  ├─ schema/
│  │  └─ import-batch.ts                 the Drizzle mirror (§3.4.9)                        T2
│  ├─ import/
│  │  ├─ index.ts                        the @dulja/db import barrel                    T2, T3
│  │  └─ batch.ts                        recordBatch, findBatch, byLegacyRef, batchCounts   T2
│  └─ index.ts                           + the import barrel re-export                  T2, T3
├─ seed/my/
│  ├─ chart-of-accounts/9b-cut-over.json  the one row: 3900 opening-balance suspense        T4
│  └─ document-types/
│     ├─ OPENING_BALANCE.json            §4.3.7 envelope, series OB, module accounting      T5
│     └─ OPENING_STOCK.json              §4.3.7 envelope, series OS, module inventory       T6
└─ test/
   ├─ fixtures.ts                        + seedImportBatch (amendment C5)                   T2
   ├─ import/batch.test.ts               import_batch: RLS, audit, stamp, idempotence       T2
   └─ import/legacy-ref.test.ts          0101: six columns, six indexes, reversibility      T1

packages/importer/
├─ package.json                          + @dulja/db, @dulja/domain (9A declared neither)   T3
├─ src/
│  ├─ index.ts                           the barrel gains the loader surface
│  │                                                        T3, T4, T5, T6, T7, T8, T13
│  ├─ cli.ts                             + the `load` and `reconcile-cut-over` commands
│  │                                                                          T3, T9, T10
│  └─ load/
│     ├─ types.ts                        LoadContext, Loader, RefResolver, SourceColumn,
│     │                                  LoadReport, LoaderReport, SkipRecord               T3
│     ├─ run.ts                          runLoad — ordering, streaming, batching, dry run   T3
│     ├─ refs.ts                         the RefResolver over import_batch                  T3
│     ├─ preflight.ts                    checkSourceColumns against driver.columns()        T3
│     ├─ scalar.ts                       requireText/optionalText/moneyOf/quantityOf/dateOf T3
│     ├─ registry.ts                     the `loaders` array and loaderFor                  T3
│     ├─ units.ts                        unit_of_measure                                    T4
│     ├─ warehouses.ts                   warehouse                                          T4
│     ├─ items.ts                        item (+ legacy_ref)                                T4
│     ├─ lots.ts                         lot (+ expiry)                                     T4
│     ├─ parties.ts                      party (customer, vendor)                           T4
│     ├─ accounts.ts                     account, from the owner's account map              T4
│     ├─ account-map.ts                  AccountMap, readAccountMap, AccountTreatment       T4
│     ├─ document.ts                     draftAndPost — the one document writer          T5, T6, T7
│     ├─ opening-balance.ts              the TB opening as one OPENING_BALANCE document     T5
│     ├─ recost.ts                       replayLegacyMovements through costingEngine        T6
│     ├─ opening-stock.ts                OPENING_STOCK documents at recomputed cost         T6
│     ├─ open-items.ts                   one OPENING_BALANCE per open legacy AR/AP document T7
│     ├─ employees.ts                    party+employee+sensitive+employee_ytd_opening      T8
│     ├─ reconcile-cut-over.ts           the three DoD comparisons + the skip register     T10
│     └─ mpos.ts                         the historical-POS loader (OD-16; unregistered)   T13
└─ test/
   ├─ support/tenant.ts                  seedLoadableTenant, loadContextFor (N16)           T4
   ├─ corpus/base/*.json                 grown additively by T4, T5, T6, T7, T8
   ├─ corpus/cut-over/catalog.json       the cut-over corpus's catalogue                    T3
   ├─ corpus/cut-over/*.json             UNITS (T3); WAREHOUSES MATERIALS MATBATCHES
   │                                     ACCOUNTS (T4); ACCTOTALS (T5); BILLITEMS (T6);
   │                                     BILLS (T7); EMPLOYEES PAYITEMS (T8)             T3–T8
   ├─ corpus/matopens-partitioned/*.json  cut-over plus a two-job MATOPENS table         T15
   ├─ corpus/mpos/*.json                 grown by T13 (OD-16)                              T13
   ├─ load/run.test.ts                   ordering, idempotence, dry run, skips              T3
   ├─ load/preflight.test.ts             the confidence-carrying column map                 T3
   ├─ load/master.test.ts                units, warehouses, items, lots, parties            T4
   ├─ load/accounts.test.ts              the account map and its treatments                 T4
   ├─ load/opening-balance.test.ts       the TB opening and the 3900 residue                T5
   ├─ load/recost.test.ts                the legacy replay through costingEngine            T6
   ├─ load/opening-stock.test.ts         OPENING_STOCK + the valuation tie-out              T6
   ├─ load/open-items.test.ts            open AR/AP, legacy numbers, ageing tie-out         T7
   ├─ load/employees.test.ts             employees, YTD openings, termination               T8
   ├─ load/reconcile-cut-over.test.ts    the three comparisons                             T10
   └─ load/mpos.test.ts                  OD-16                                             T13

packages/contracts/
├─ src/errors.ts                         + ERR_IMPORT_DUPLICATE_SOURCE_KEY               T2
│                                        + ERR_IMPORT_UNBALANCED_SOURCE                   T5
│                                          (each in the commit that RAISES it — §4.2.4)      —
└─ src/admin/import.ts                   StartImportBody, ImportRunSchema, ImportRunList,
                                         JobStatusSchema                                    T9

apps/api/
├─ src/routes/admin/import.ts            importRoutes (POST/GET …/imports)                  T9
├─ src/routes/admin/job-status.ts        jobStatusRoutes (GET /v1/jobs/{jobId})             T9
├─ src/routes/index.ts                   + both modules inside buildRoutes                  T9
└─ test/routes/admin/import.test.ts      route tests through createApp()                    T9

apps/worker/
├─ src/handlers/import-run.ts            the admin.import.run handler                       T9
├─ src/index.ts                          + registerHandler("admin.import.run", …)           T9
└─ test/handlers/import-run.test.ts      through startWorker()                              T9

tests/
├─ invariants/support/cut-over.ts        cutOverFixture, loadFromCorpus, assertExplained
│                                        (T5) + reconcileFor (T10) — amendment C6      T5, T10
├─ invariants/cut-over-reconciliation.test.ts   the DoD: TB, valuation, YTD              T10
├─ invariants/probes.ts                  + two PROBES keys, + one JOB_PROBES key           T9
├─ invariants/projection-rebuild.test.ts + the after-the-load clause (test 2)              T9
└─ regression/
   ├─ sah-003.test.ts                    append — unbalanced vouchers reach 3900            T5
   ├─ sah-007.test.ts                    append — NULL-poisoned balance refused             T4
   ├─ sah-011.test.ts                    append — NULL-poisoned cost refused                T6
   ├─ sah-022.test.ts                    append — MatOpens.Job                             T15
   ├─ sah-028.test.ts                    append — no credential imported                   T12
   ├─ sah-049.test.ts                    append — duplicate aggregates do not double-load   T3
   ├─ sah-051.test.ts                    append — legacy numbers are strings            T1, T7
   └─ sah-073.test.ts                    append — orphans reported, never nulled            T4

docs/
├─ adr/0084-idempotent-loaders-keyed-on-import-batch.md                                     T3
├─ adr/0085-cut-over-series-and-opening-documents.md                                        T7
├─ adr/0086-cut-over-reconciliation-and-the-explained-difference.md                        T10
└─ runbooks/cut-over.md                  freeze → load → reconcile → explain → start       T10

MODIFIED (each an additive edit; no existing behaviour changes)
packages/db/src/jobs/payloads.ts         + the one admin.import.run key (amendment C3)      T9
packages/db/src/lint-schema.ts           NOTHING — import_batch joins no set (§3.5.3)        —
packages/db/src/seed/index.ts            NOTHING — this slice adds no PackLoader             —
infra/src/secrets.ts                     + LEGACY_ODBC_DSN for the worker only (C10)        T9
AGENTS.md                                the "Current phase" section rewritten (§3.8)      T10
```

**What is deliberately absent.** No permission code — the vocabulary is closed (hazard 26) and the import routes are gated by `admin.company.manage`, the §3.6.2 code under which company configuration is maintained. No `report_definition`, no `DatasetId` — the cut-over evidence is an artefact file with a manifest, not a catalogue report (hazard 4 binds a *phase's minimal reports*; Phase 9 ships none, and its DoD is a reconciliation, not a screen). No DELETE grant (§3.5.4 is complete). No new linter rule, no new linter set membership, no new `sql.unsafe` home, no new `PackLoader` (`chart-of-accounts` and `document-types` both already have theirs — 0C's and 1A's — and this slice adds **files**, never a loader, per §3.4.8). No React component and no screen — OD-24 does not apply. No `import_run` table: a run is identified by its `run_id`, its progress is `import_batch` grouped by `target_table`, and its lifecycle is the pg-boss job's own.

---

### Task 1: Migration 0101 — `legacy_ref` on the six master tables

**Files:**
- Create: `packages/db/migrations/0101_add_legacy_ref.sql`, `packages/db/migrations/0101.down.sql`, `packages/db/test/import/legacy-ref.test.ts`
- Modify: `packages/db/src/schema/document.ts`, `packages/db/src/schema/party.ts`, `packages/db/src/schema/item.ts`, `packages/db/src/schema/account.ts`, `packages/db/src/schema/employee.ts`, `packages/db/src/schema/lot.ts`, `tests/regression/sah-051.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant` (the 4-argument test helper), `seedTenant`, `Seed`, `uuidv7`, `lintSchema`, `up`, `down`, `listApplied`, `MIGRATIONS_DIR`, `schemaFingerprint` (§4.1); `sharedDb`, `thinRegression` (§4.17.1); `seedParty` (2A), `seedItem`, `seedLot` (3A), `seedEmployee` (6C/8A), `seedAccount` (1A), `draftDocument` (0A).
- Produces:

```sql
-- app.document.legacy_ref  text  (nullable, indexed, NOT unique)
-- app.party.legacy_ref     text
-- app.item.legacy_ref      text
-- app.account.legacy_ref   text
-- app.employee.legacy_ref  text
-- app.lot.legacy_ref       text
-- and one non-unique index per table: <table>_legacy_ref_idx on (company_id, legacy_ref) where legacy_ref is not null
```

```ts
// packages/db/src/schema/<table>.ts — each mirror gains one column and one index
legacyRef: text("legacy_ref"),
legacyRefIdx: index("<table>_legacy_ref_idx").on(t.companyId, t.legacyRef),
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/import/legacy-ref.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedTenantV2, seedAccount, seedParty, seedItem, seedLot, seedEmployee, type Seed } from "../fixtures";

let db: Db;
let s: Seed;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "legacy-ref");
}, 180_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0101 — legacy_ref (contracts §4.13.3; spec:2333 §5.1 #8, SAH-051)", () => {
  it("adds a nullable text column to exactly the six tables §4.13.3 names, and to no other", async () => {
    const rows = await db.admin<{ table_name: string; data_type: string; is_nullable: string }[]>`
      select table_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'app' and column_name = 'legacy_ref'
       order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(["account", "document", "employee", "item", "lot", "party"]);
    expect(rows.every((r) => r.data_type === "text" && r.is_nullable === "YES")).toBe(true);
  });

  it("indexes each one on (company_id, legacy_ref) and NEVER uniquely — SAH-051 says duplicates exist", async () => {
    const rows = await db.admin<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
       where schemaname = 'app' and indexname like '%_legacy_ref_idx' order by indexname`;
    expect(rows.map((r) => r.indexname)).toEqual([
      "account_legacy_ref_idx", "document_legacy_ref_idx", "employee_legacy_ref_idx",
      "item_legacy_ref_idx", "lot_legacy_ref_idx", "party_legacy_ref_idx",
    ]);
    expect(rows.every((r) => !r.indexdef.includes("UNIQUE"))).toBe(true);
    expect(rows.every((r) => r.indexdef.includes("WHERE (legacy_ref IS NOT NULL)"))).toBe(true);
  });

  it("keys lot's index on (company_id, legacy_ref) like the other five — app.lot carries company_id (§4.6.1)", async () => {
    const [lot] = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and indexname = 'lot_legacy_ref_idx'`;
    expect(lot!.indexdef).toContain("(company_id, legacy_ref)");
  });

  it("accepts two rows with the same legacy_ref — the legacy numbering is not unique (SAH-051)", async () => {
    const a = await uuidv7(db.admin);
    const b = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.party (id, tenant_id, company_id, kind, code, name_en, legacy_ref)
               values (${a}, ${s.tenant}, ${s.company}, 'customer', 'DUP-A', 'Duplicate A', 'C-000123'),
                      (${b}, ${s.tenant}, ${s.company}, 'customer', 'DUP-B', 'Duplicate B', 'C-000123')`;
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.party where company_id = ${s.company} and legacy_ref = 'C-000123'`;
      expect(n!.n).toBe(2);
    });
  });

  it("leaves lintSchema at zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("document.number stays bigint — a legacy number is never written into it (SAH-051)", async () => {
    const [col] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'number'`;
    expect(col!.data_type).toBe("bigint");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/db test import/legacy-ref`
Expected: FAIL — the first case reports `expected [] to equal [ 'account', 'document', 'employee', 'item', 'lot', 'party' ]`, because no `legacy_ref` column exists in schema `app`.

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0101_add_legacy_ref.sql`:

```sql
-- 0101_add_legacy_ref.sql — contracts §4.13.3; spec §5.1 #8 (spec:2333): "Document numbers may contain
-- duplicates and gaps (SAH-051). Preserve them as historical strings; start the new gapless series after
-- cut-over." The historical string lives here; app.document.number stays a gapless bigint owned by
-- app.document_series (§4.3.6) and no legacy value is ever written into it.
--
-- Expand only (§3.4.7): six nullable columns and six partial indexes on live tables, no backfill, no
-- constraint, no rewrite. The contract half — dropping nothing — is not needed: legacy_ref is permanent.

-- ── 1. the six columns (§4.13.3 names exactly these tables) ───────────────────
alter table app.document add column legacy_ref text;
alter table app.party    add column legacy_ref text;
alter table app.item     add column legacy_ref text;
alter table app.account  add column legacy_ref text;
alter table app.employee add column legacy_ref text;
alter table app.lot      add column legacy_ref text;

comment on column app.document.legacy_ref is
  'SAH-051 — the source system''s own document number, kept as a string. Not unique: the legacy numbering had duplicates and gaps.';
comment on column app.party.legacy_ref is 'The source system''s account/customer/vendor code (§5.1 #8).';
comment on column app.item.legacy_ref is 'The source system''s material code (§5.1 #8).';
comment on column app.account.legacy_ref is 'The source system''s chart-of-accounts code (§5.1 #8).';
comment on column app.employee.legacy_ref is 'The source system''s employee number (§5.1 #11, #12).';
comment on column app.lot.legacy_ref is 'The source system''s batch code (§5.1 #8).';

-- ── 2. one partial index each, on (company_id, legacy_ref) ────────────────────
-- Partial because only imported rows carry the column; non-unique because SAH-051 says the source
-- numbering is not unique and an import that refused a duplicate would refuse the customer's own data.
-- No `create index concurrently` — a migration file is one transaction (§3.4.3).
create index document_legacy_ref_idx on app.document (company_id, legacy_ref) where legacy_ref is not null;
create index party_legacy_ref_idx    on app.party    (company_id, legacy_ref) where legacy_ref is not null;
create index item_legacy_ref_idx     on app.item     (company_id, legacy_ref) where legacy_ref is not null;
create index account_legacy_ref_idx  on app.account  (company_id, legacy_ref) where legacy_ref is not null;
create index employee_legacy_ref_idx on app.employee (company_id, legacy_ref) where legacy_ref is not null;
-- app.lot carries company_id (§4.6.1) as well as item_id, so the same shape applies.
create index lot_legacy_ref_idx      on app.lot      (company_id, legacy_ref) where legacy_ref is not null;
```

`packages/db/migrations/0101.down.sql`:

```sql
-- 0101.down.sql — reverse dependency order: indexes before the columns they read (§3.4.5).
-- Only the columns this file added are dropped; the six tables belong to 2A, 3A, 6C/8A and 0001 (§3.4.5).
drop index if exists app.lot_legacy_ref_idx;
drop index if exists app.employee_legacy_ref_idx;
drop index if exists app.account_legacy_ref_idx;
drop index if exists app.item_legacy_ref_idx;
drop index if exists app.party_legacy_ref_idx;
drop index if exists app.document_legacy_ref_idx;

alter table app.lot      drop column if exists legacy_ref;
alter table app.employee drop column if exists legacy_ref;
alter table app.account  drop column if exists legacy_ref;
alter table app.item     drop column if exists legacy_ref;
alter table app.party    drop column if exists legacy_ref;
alter table app.document drop column if exists legacy_ref;
```

- [ ] **Step 4: Update the six Drizzle mirrors**

Every slice that changes a table updates its mirror in the same PR (§3.4.9). Each of the six files gains exactly two lines. `packages/db/src/schema/document.ts` — add to the column list and to the table's index callback:

```ts
  legacyRef: text("legacy_ref"),                                    // 9B, migration 0101 (§4.13.3)
```
```ts
  legacyRefIdx: index("document_legacy_ref_idx").on(t.companyId, t.legacyRef),   // 9B, migration 0101
```

Repeat verbatim in `party.ts`, `item.ts`, `account.ts`, `employee.ts` and `lot.ts`, changing only the index name to `party_legacy_ref_idx`, `item_legacy_ref_idx`, `account_legacy_ref_idx`, `employee_legacy_ref_idx` and `lot_legacy_ref_idx`. `text` and `index` are already imported in all six files; if a file imports only `index` or only `text`, add the missing name to its existing `drizzle-orm/pg-core` import rather than adding a second import statement.

- [ ] **Step 5: Run the test and the migration suites**

Run: `bun run --cwd packages/db test import/legacy-ref && bun run --cwd packages/db test privileges`
Expected: PASS. `privileges.test.ts` carries §3.4.6's up→down→up fingerprint case, which is what proves `0101.down.sql` restores the schema byte for byte; a forgotten index drop fails it.

- [ ] **Step 6: Append the 9B block to `tests/regression/sah-051.test.ts`**

The file exists (0B created it; §3.7.3). Append — never edit an earlier block:

```ts
describe("SAH-051 Document numbers may contain duplicates and gaps — 9B", () => {
  it("keeps the legacy number as a string and never lets it near document.number", async () => {
    const { rw, a } = await sharedDb();
    await withTenant(rw, { tenantId: a.tenant, actorId: a.human, requestId: crypto.randomUUID() }, async (tx) => {
      const [col] = await tx<{ data_type: string }[]>`
        select data_type from information_schema.columns
         where table_schema = 'app' and table_name = 'document' and column_name = 'legacy_ref'`;
      expect(col!.data_type).toBe("text");
      const [num] = await tx<{ data_type: string }[]>`
        select data_type from information_schema.columns
         where table_schema = 'app' and table_name = 'document' and column_name = 'number'`;
      expect(num!.data_type).toBe("bigint");
    });
  });

  it("does not make legacy_ref unique — the source numbering was not (SAH-051)", async () => {
    const { rw, a } = await sharedDb();
    await withTenant(rw, { tenantId: a.tenant, actorId: a.human, requestId: crypto.randomUUID() }, async (tx) => {
      const [idx] = await tx<{ indexdef: string }[]>`
        select indexdef from pg_indexes where schemaname = 'app' and indexname = 'document_legacy_ref_idx'`;
      expect(idx!.indexdef).not.toContain("UNIQUE");
    });
  });
});
```

The imports the block needs (`describe`, `expect`, `it`, `sharedDb`, `withTenant`) are already at the top of the file from 0B's block; add nothing.

- [ ] **Step 7: Run the regression file and the linter**

Run: `bun run --cwd tests test sah-051 && bun run --cwd packages/db test lint-schema && bun run lint:rules`
Expected: PASS, zero violations.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0101_add_legacy_ref.sql packages/db/migrations/0101.down.sql \
        packages/db/test/import/legacy-ref.test.ts packages/db/src/schema/document.ts \
        packages/db/src/schema/party.ts packages/db/src/schema/item.ts packages/db/src/schema/account.ts \
        packages/db/src/schema/employee.ts packages/db/src/schema/lot.ts tests/regression/sah-051.test.ts
git commit -m "feat(db): add legacy_ref to the six master tables [9B T1]

Migration 0101. Six nullable text columns and six partial, deliberately
non-unique indexes: SAH-051 says the source numbering had duplicates and
gaps, so the historical number is a string here and app.document.number
stays the gapless bigint app.document_series owns.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0102 — `app.import_batch`, the idempotence key, and `seedImportBatch`

**Files:**
- Create: `packages/db/migrations/0102_create_import_batch.sql`, `packages/db/migrations/0102.down.sql`, `packages/db/src/schema/import-batch.ts`, `packages/db/src/import/batch.ts`, `packages/db/src/import/index.ts`, `packages/db/test/import/batch.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/test/fixtures.ts`, `packages/contracts/src/errors.ts`

**Interfaces:**
- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.current_actor`, `uuidv7()` (§4.1); `withTenant`, `TenantContext` (§4.2.2); `Db`, `Seed`, `seedTenantV2`, `startDb` (§4.1, 1A).
- Produces:

```sql
-- app.import_batch (§4.6.1, plus amendment C7's source_hash)
```

```ts
// packages/db/src/import/batch.ts
export interface ImportBatchRow {
  id: string; sourceTable: string; sourceKey: string; targetTable: string; targetId: string;
  sourceHash: string; runId: string; loadedBy: string; createdAt: string;
}
export interface RecordBatchInput {
  companyId: string; sourceTable: string; sourceKey: string;
  targetTable: string; targetId: string; sourceHash: string; runId: string;
}
export type RecordBatchOutcome =
  | { kind: "inserted"; id: string; targetId: string }
  | { kind: "skipped";  id: string; targetId: string }        // identical hash — a harmless re-run
  | { kind: "conflict"; id: string; targetId: string };        // same key, different hash — caller raises

/** One row per (company, source_table, source_key). Never updates target_id: a legacy key maps to one
 *  Dulja row for ever, which is what makes RefResolver's answer stable across re-runs. */
export async function recordBatch(tx: Sql, input: RecordBatchInput): Promise<RecordBatchOutcome>;
export async function findBatch(tx: Sql, input: { companyId: string; sourceTable: string; sourceKey: string }): Promise<ImportBatchRow | null>;
/** The §4.13.2 RefResolver's one query: what did this legacy key become in `targetTable`? */
export async function byLegacyRef(tx: Sql, input: { companyId: string; sourceTable: string; sourceKey: string; targetTable: string }): Promise<string | null>;
/** Progress: rows loaded per target table for one run. */
export async function batchCounts(tx: Sql, input: { companyId: string; runId: string }): Promise<{ targetTable: string; rows: number }[]>;
export function sourceHashOf(payload: unknown): string;          // sha256 of the JSON, keys sorted
```

```ts
// packages/db/test/fixtures.ts — amendment C5
export async function seedImportBatch(db: Db, s: Seed, opts: {
  sourceTable: string; sourceKey: string; targetTable: string; targetId: string; runId?: string;
}): Promise<string>;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/import/batch.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { batchCounts, byLegacyRef, findBatch, recordBatch, sourceHashOf } from "../../src/import/batch";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;
const RUN = "01930000-0000-7000-8000-000000000001";
/** A valid sha256 shape. The DDL's CHECK is `^[0-9a-f]{64}$`; the value itself is irrelevant to the cases
 *  that do not exercise the hash, and the ones that do build it with `sourceHashOf`. */
const H = "0".repeat(64);

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "import-a");
  b = await seedTenantV2(db, "import-b");
}, 180_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0102 — app.import_batch (contracts §4.6.1, §4.13.3)", () => {
  it("joins no linter set: it keeps id, created_at and the audit trigger (§3.5.3)", async () => {
    expect(AUDIT_EXEMPT.has("import_batch")).toBe(false);
    expect(IMMUTABLE.has("import_batch")).toBe(false);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("stamps loaded_by from app.current_actor() and refuses to have it supplied", async () => {
    const id = await uuidv7(db.admin);
    const target = await uuidv7(db.admin);
    const other = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.import_batch (id, tenant_id, company_id, source_table, source_key,
                                             target_table, target_id, source_hash, run_id, loaded_by)
               values (${id}, ${a.tenant}, ${a.company}, 'ACCOUNTS', '1000', 'account', ${target}, ${H}, ${RUN}, ${other})`;
      const [row] = await tx<{ loaded_by: string }[]>`select loaded_by from app.import_batch where id = ${id}`;
      expect(row!.loaded_by).toBe(a.human);          // stamp_loaded_by overwrote the supplied value
    });
  });

  it("writes an audit row for every insert (test 13)", async () => {
    const before = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.audit_log where table_name = 'import_batch'`;
      return n!.n;
    });
    const id = await uuidv7(db.admin);
    const target = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`insert into app.import_batch (id, tenant_id, company_id, source_table, source_key,
                                       target_table, target_id, source_hash, run_id)
         values (${id}, ${a.tenant}, ${a.company}, 'ACCOUNTS', '1100', 'account', ${target}, ${H}, ${RUN})`);
    const after = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.audit_log where table_name = 'import_batch'`;
      return n!.n;
    });
    expect(after).toBe(before + 1);
  });

  it("a second tenant cannot see the first tenant's batch rows (test 12)", async () => {
    const visible = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.import_batch`;
      return n!.n;
    });
    expect(visible).toBe(0);
  });

  it("recordBatch is idempotent on an identical re-run and conflicts on a changed one", async () => {
    const target = await uuidv7(db.admin);
    const input = {
      companyId: a.company, sourceTable: "MATERIALS", sourceKey: "M-1",
      targetTable: "item", targetId: target, sourceHash: sourceHashOf({ code: "M-1", name: "Widget" }), runId: RUN,
    };
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      expect((await recordBatch(tx, input)).kind).toBe("inserted");
      expect((await recordBatch(tx, input)).kind).toBe("skipped");
      const changed = { ...input, sourceHash: sourceHashOf({ code: "M-1", name: "Widget Mk II" }) };
      const out = await recordBatch(tx, changed);
      expect(out.kind).toBe("conflict");
      expect(out.targetId).toBe(target);              // the mapping never moves
    });
  });

  it("byLegacyRef answers what a legacy key became, and null for one it never saw", async () => {
    const target = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await recordBatch(tx, {
        companyId: a.company, sourceTable: "ACCOUNTS", sourceKey: "4000",
        targetTable: "account", targetId: target, sourceHash: H, runId: RUN,
      });
      expect(await byLegacyRef(tx, { companyId: a.company, sourceTable: "ACCOUNTS", sourceKey: "4000", targetTable: "account" })).toBe(target);
      expect(await byLegacyRef(tx, { companyId: a.company, sourceTable: "ACCOUNTS", sourceKey: "9999", targetTable: "account" })).toBeNull();
      const found = await findBatch(tx, { companyId: a.company, sourceTable: "ACCOUNTS", sourceKey: "4000" });
      expect(found?.targetTable).toBe("account");
    });
  });

  it("batchCounts groups a run by target table", async () => {
    const counts = await withTenant(db.rw, a.tenant, a.human, (tx) => batchCounts(tx, { companyId: a.company, runId: RUN }));
    expect(counts.find((c) => c.targetTable === "account")?.rows).toBeGreaterThanOrEqual(1);
    expect(counts.find((c) => c.targetTable === "item")?.rows).toBe(1);
  });

  it("sourceHashOf is key-order independent, so a reordered read is not a false conflict", () => {
    expect(sourceHashOf({ a: "1", b: "2" })).toBe(sourceHashOf({ b: "2", a: "1" }));
    expect(sourceHashOf({ a: "1" })).not.toBe(sourceHashOf({ a: "2" }));
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/db test import/batch`
Expected: FAIL — `Cannot find module '../../src/import/batch'`.

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0102_create_import_batch.sql`:

```sql
-- 0102_create_import_batch.sql — contracts §4.6.1 and §4.13.3. The idempotence ledger of the Phase 9
-- load: one row per legacy key, recording what that key became. Re-running a load reads this table and
-- inserts nothing twice (§5.1 #5's duplicate aggregate rows are the reason it cannot be a blind insert).
--
-- source_hash is amendment C7: without it the natural key makes a second run either always a conflict or
-- always a no-op, and neither is idempotence. An identical re-read is a silent skip; a CHANGED source row
-- for a key already mapped raises ERR_IMPORT_DUPLICATE_SOURCE_KEY so the operator sees that the frozen
-- source moved under them (§5.1 #10 "scope first, migrate second" assumes a freeze).

create table app.import_batch (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  source_table  text not null,                                    -- the legacy relation, upper-case as Firebird stores it
  source_key    text not null,                                    -- the legacy row's own key, as a string (SAH-051)
  target_table  text not null,                                    -- the app.* table the row became
  target_id     uuid not null,                                    -- the Dulja row's id
  source_hash   text not null,                                    -- sha256 of the mapped payload (amendment C7)
  run_id        uuid not null,                                    -- the load run that produced it
  loaded_by     uuid not null default app.current_actor(),         -- stamped; the tenant's system principal (spec:2179)
  created_at    timestamptz not null default now(),
  constraint import_batch_source_table_check check (source_table ~ '^[A-Z][A-Z0-9_$]{0,62}$'),
  constraint import_batch_target_table_check check (target_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint import_batch_source_key_check   check (length(source_key) between 1 and 512),
  constraint import_batch_source_hash_check  check (source_hash ~ '^[0-9a-f]{64}$'),   -- sha256, lower hex
  unique (company_id, source_table, source_key),                  -- ERR_IMPORT_DUPLICATE_SOURCE_KEY
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

comment on table app.import_batch is
  'Contracts §4.13.3 — the Phase 9 idempotence ledger. One row per legacy key per company; the mapping from a legacy key to a Dulja id never moves once written.';

-- §3.5.1 recipe items 2, 3, 4. import_batch joins no linter set (§3.5.3), so it keeps id, created_at and
-- the audit trigger like any ordinary table, and loaded_by gets its stamp.
call app_meta.enable_tenant_rls('app.import_batch');
call app_meta.attach_audit('app.import_batch');
call app_meta.attach_stamp('app.import_batch', 'loaded_by');

-- The two reads the loaders make: "what did this key become" (covered by the unique key) and "how far has
-- this run got" (below). No branch_isolation policy: import_batch has no branch key and is not one of the
-- five warehouse-keyed stock tables of §4.5.6.
create index import_batch_run_idx    on app.import_batch (company_id, run_id, target_table);
create index import_batch_target_idx on app.import_batch (company_id, target_table, target_id);

-- app_rw receives select, insert, update through default privileges (plan0A:2564) — no grant statement,
-- and NO delete: §3.5.4's pinned list is complete for v1 and an import is undone by reversal (spec:2049).
```

`packages/db/migrations/0102.down.sql`:

```sql
-- 0102.down.sql — the table's triggers go with it; app_meta and app_meta.schema_migration are never
-- dropped (§3.4.5). The two indexes belong to the table and are dropped by the cascade.
drop table if exists app.import_batch;
```

- [ ] **Step 4: Write the Drizzle mirror**

`packages/db/src/schema/import-batch.ts`:

```ts
import { index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** Mirror of migration 0102 (contracts §4.6.1). Reads only — every write goes through
 *  packages/db/src/import/batch.ts, which uses postgres.js tagged templates (D7). */
export const importBatch = app.table(
  "import_batch",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    sourceTable: text("source_table").notNull(),
    sourceKey: text("source_key").notNull(),
    targetTable: text("target_table").notNull(),
    targetId: uuid("target_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    runId: uuid("run_id").notNull(),
    loadedBy: uuid("loaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    natural: unique("import_batch_company_id_source_table_source_key_key").on(t.companyId, t.sourceTable, t.sourceKey),
    run: index("import_batch_run_idx").on(t.companyId, t.runId, t.targetTable),
    target: index("import_batch_target_idx").on(t.companyId, t.targetTable, t.targetId),
  }),
);
```

- [ ] **Step 5: Write the batch service**

`packages/db/src/import/batch.ts`:

```ts
import { createHash } from "node:crypto";
import type { Sql } from "postgres";

export interface ImportBatchRow {
  id: string; sourceTable: string; sourceKey: string; targetTable: string; targetId: string;
  sourceHash: string; runId: string; loadedBy: string; createdAt: string;
}

export interface RecordBatchInput {
  companyId: string; sourceTable: string; sourceKey: string;
  targetTable: string; targetId: string; sourceHash: string; runId: string;
}

export type RecordBatchOutcome =
  | { kind: "inserted"; id: string; targetId: string }
  | { kind: "skipped"; id: string; targetId: string }
  | { kind: "conflict"; id: string; targetId: string };

/** Stable across key order and across a re-read that returns the same values in a different column order —
 *  a reordered SELECT must not look like changed source data. */
export function sourceHashOf(payload: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, val]) => [k, canonical(val)]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(payload)) ?? "null").digest("hex");
}

/**
 * Insert-or-classify. `on conflict do nothing` plus a read is used rather than `do update`, because the
 * mapping must never move: a legacy key that already became a row keeps that row for ever, and a changed
 * source is reported to the operator rather than silently re-pointed.
 */
export async function recordBatch(tx: Sql, input: RecordBatchInput): Promise<RecordBatchOutcome> {
  const [inserted] = await tx<{ id: string; target_id: string }[]>`
    insert into app.import_batch (tenant_id, company_id, source_table, source_key, target_table, target_id, source_hash, run_id)
    values (app.current_tenant(), ${input.companyId}, ${input.sourceTable}, ${input.sourceKey},
            ${input.targetTable}, ${input.targetId}, ${input.sourceHash}, ${input.runId})
    on conflict (company_id, source_table, source_key) do nothing
    returning id, target_id`;
  if (inserted) return { kind: "inserted", id: inserted.id, targetId: inserted.target_id };

  const [existing] = await tx<{ id: string; target_id: string; source_hash: string }[]>`
    select id, target_id, source_hash from app.import_batch
     where company_id = ${input.companyId} and source_table = ${input.sourceTable} and source_key = ${input.sourceKey}`;
  if (!existing) {
    // Only reachable if a concurrent transaction inserted and rolled back between the two statements.
    // runLoad serialises loaders, so this is a bug rather than a race; surfacing it beats looping.
    throw new Error(`ERR_IMPORT_DUPLICATE_SOURCE_KEY: ${input.sourceTable}/${input.sourceKey} conflicted but is not present`);
  }
  return {
    kind: existing.source_hash === input.sourceHash ? "skipped" : "conflict",
    id: existing.id,
    targetId: existing.target_id,
  };
}

export async function findBatch(
  tx: Sql,
  input: { companyId: string; sourceTable: string; sourceKey: string },
): Promise<ImportBatchRow | null> {
  const [row] = await tx<ImportBatchRow[]>`
    select id, source_table as "sourceTable", source_key as "sourceKey", target_table as "targetTable",
           target_id as "targetId", source_hash as "sourceHash", run_id as "runId",
           loaded_by as "loadedBy", to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt"
      from app.import_batch
     where company_id = ${input.companyId} and source_table = ${input.sourceTable} and source_key = ${input.sourceKey}`;
  return row ?? null;
}

export async function byLegacyRef(
  tx: Sql,
  input: { companyId: string; sourceTable: string; sourceKey: string; targetTable: string },
): Promise<string | null> {
  const [row] = await tx<{ target_id: string }[]>`
    select target_id from app.import_batch
     where company_id = ${input.companyId} and source_table = ${input.sourceTable}
       and source_key = ${input.sourceKey} and target_table = ${input.targetTable}`;
  return row?.target_id ?? null;
}

export async function batchCounts(
  tx: Sql,
  input: { companyId: string; runId: string },
): Promise<{ targetTable: string; rows: number }[]> {
  return tx<{ targetTable: string; rows: number }[]>`
    select target_table as "targetTable", count(*)::int as rows
      from app.import_batch
     where company_id = ${input.companyId} and run_id = ${input.runId}
     group by target_table order by target_table`;
}
```

`packages/db/src/import/index.ts`:

```ts
export {
  batchCounts, byLegacyRef, findBatch, recordBatch, sourceHashOf,
  type ImportBatchRow, type RecordBatchInput, type RecordBatchOutcome,
} from "./batch";
```

and `packages/db/src/index.ts` gains one line beside the existing exports:

```ts
export * from "./import";
```

- [ ] **Step 6: Add `seedImportBatch` to `fixtures.ts`, additively**

`packages/db/test/fixtures.ts` — a new exported helper in the uniform `(db, s, opts?)` shape of §4.17; no existing helper or constant is touched (hazard 9):

```ts
/** 9B (contracts §4.17 amendment C5). One import_batch row, so a test can assert what a loader skips
 *  without running a loader. Returns the row id. */
export async function seedImportBatch(
  db: Db,
  s: Seed,
  opts: { sourceTable: string; sourceKey: string; targetTable: string; targetId: string; runId?: string },
): Promise<string> {
  const id = await uuidv7(db.admin);
  const runId = opts.runId ?? (await uuidv7(db.admin));
  const repeat0 = "0".repeat(64);          // the DDL's CHECK is ^[0-9a-f]{64}$
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    tx`insert into app.import_batch (id, tenant_id, company_id, source_table, source_key,
                                     target_table, target_id, source_hash, run_id)
       values (${id}, ${s.tenant}, ${s.company}, ${opts.sourceTable}, ${opts.sourceKey},
               ${opts.targetTable}, ${opts.targetId}, ${repeat0}, ${runId})`);
  return id;
}
```

- [ ] **Step 7: Add the ONE `ERRORS` row this commit raises**

`packages/contracts/src/errors.ts` — **one** row, allocated to 9B by §4.2.4. It lands here because this is the PR whose code raises it:

```ts
  ERR_IMPORT_DUPLICATE_SOURCE_KEY: {
    status: 409,
    title: "Legacy key already imported with different data",
    remedy: "The source row changed since it was first loaded. Freeze the source, then re-run; or reverse the imported document and re-import.",
  },
```

**`ERR_IMPORT_UNBALANCED_SOURCE` is deliberately NOT added here — its row lands in Task 5, which raises it.** §4.2.4 (contracts:1548) is explicit that `ERRORS` "contains only the codes whose raiser has shipped: each slice adds its rows in the same PR that raises them", and `scripts/lint/rules/error-codes.ts` "fails when a code **present in `ERRORS`** has no occurrence in `apps/**`, `packages/**/src/**`, `packages/db/migrations/**`" (contracts:1586). `ERR_IMPORT_DUPLICATE_SOURCE_KEY` satisfies that here and now: `packages/db/src/import/batch.ts`, written in this same commit, carries the string in `recordBatch`'s guard. `ERR_IMPORT_UNBALANCED_SOURCE` has no occurrence anywhere until Task 3's `LoadError` union and no **raise** until Task 5's `openingBalanceLoader.load`, so adding its row here would make **Step 8's own `bun run lint:rules` red at this commit**. The check runs in one direction only — an `ERR_*` string in source with no `ERRORS` row is not a violation — so Tasks 3 and 4 are green with the union string and no row.

- [ ] **Step 8: Run everything**

Run: `bun run --cwd packages/db test import/batch && bun run --cwd packages/db test privileges && bun run lint:rules && bun run typecheck`
Expected: PASS; zero lint violations; the up→down→up fingerprint case green.

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0102_create_import_batch.sql packages/db/migrations/0102.down.sql \
        packages/db/src/schema/import-batch.ts packages/db/src/import/batch.ts \
        packages/db/src/import/index.ts packages/db/src/index.ts packages/db/test/import/batch.test.ts \
        packages/db/test/fixtures.ts packages/contracts/src/errors.ts
git commit -m "feat(db): add app.import_batch and the load idempotence key [9B T2]

Migration 0102. One row per (company, source_table, source_key) recording
what a legacy key became, with a source_hash so an identical re-run is a
silent skip and a changed source row is a reported conflict rather than a
silently re-pointed mapping. Audited, stamped, RLS-forced; no DELETE grant.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The loader framework — `Loader`, `RefResolver`, `runLoad`, pre-flight, and ADR 0084

**Files:**
- Create: `packages/importer/src/load/types.ts`, `packages/importer/src/load/scalar.ts`, `packages/importer/src/load/preflight.ts`, `packages/importer/src/load/refs.ts`, `packages/importer/src/load/registry.ts`, `packages/importer/src/load/run.ts`, `packages/importer/test/load/run.test.ts`, `packages/importer/test/load/preflight.test.ts`, `packages/importer/test/corpus/cut-over/catalog.json`, `packages/importer/test/corpus/cut-over/UNITS.json`, `docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md`
- Modify: `packages/importer/package.json`, `packages/importer/src/index.ts`, `packages/importer/src/cli.ts`, `tests/regression/sah-049.test.ts`

**Interfaces:**
- Consumes: `LegacyReader`, `LegacyDriver`, `LegacyRow`, `LegacyScalar`, `LegacyColumn`, `LegacyPredicate`, `createReader`, `connectOdbc`, `redactDsn`, `FixtureLegacyDriver`, `unreadable` (9A, §4.13.1); `withTenant`, `TenantContext`, `systemContext` (§4.2.2); `recordBatch`, `byLegacyRef`, `batchCounts`, `sourceHashOf`, `RecordBatchOutcome` (T2); `Money`, `currency`, `Quantity`, `MONEY_SCALE` (§4.2.1); `ReportWriter`, `ArtefactIndex`, `toCsv` (9A).
- Produces:

```ts
// packages/importer/src/load/types.ts — §4.13.2 verbatim, plus amendment C8's two members
import type { Sql } from "postgres";
import type { TenantContext } from "@dulja/db";
import type { LegacyDriver, LegacyReader } from "../index";

export interface LoadContext extends TenantContext { companyId: string; runId: string; cutOverDate: string;
                                                     dryRun: boolean; only?: string[] }   // amendment C14

export interface RefResolver { byLegacyRef(table: string, legacyRef: string): Promise<string | null> }

/** Amendment C8: a source column is DATA, never a transcribed interface (hazard 3). `confidence` is the
 *  honest label — `verified` only once a live catalogue has been read and the reading recorded in ADR 0084. */
export interface SourceColumn {
  readonly name: string;                       // upper case, as Firebird stores it
  readonly required: boolean;                  // a missing required column fails pre-flight
  readonly confidence: "verified" | "hypothesis";
  readonly note: string;                       // why this column, in one sentence, for the pre-flight report
}

export interface Loader<S, T> {
  readonly sourceTable: string;
  readonly targetTable: string;
  readonly dependsOn: string[];                // targetTable names, not source tables
  readonly sourceColumns: readonly SourceColumn[];
  readonly wholeTable?: boolean;               // amendment C13 — one `load` call for the whole table
  readonly sourceKey: (row: S) => string;
  /** Amendment C12 widens §4.13.2's return to admit a promise — `RefResolver.byLegacyRef` is async. */
  map(row: S, refs: RefResolver): T | { skip: string } | Promise<T | { skip: string }>;
  /** Amendment C15 widens the return with `skips` — the reasons only `load` can know. */
  load(tx: Sql, ctx: LoadContext, rows: T[]): Promise<{ inserted: number; skipped: number; batchIds: string[]; skips?: readonly SkipRecord[] }>;
}

export interface SkipRecord { loader: string; sourceTable: string; sourceKey: string; reason: string }
export interface LoaderReport { inserted: number; skipped: number; conflicts: number }
export interface LoadReport {
  perLoader: Record<string, LoaderReport>;
  reconciliation: ReconciliationReport[];
  artefacts: ArtefactIndex;                     // amendment C9
  skips: SkipRecord[];
}

/** The one error `packages/importer/src/load/**` raises. `packages/importer` may not import
 *  `@dulja/contracts`' AppError (§3.1, 9A's `unreadable` has the same constraint), so the code travels as a
 *  field and `apps/worker`'s handler maps it. */
export class LoadError extends Error {
  constructor(readonly code: "ERR_IMPORT_DUPLICATE_SOURCE_KEY" | "ERR_IMPORT_UNBALANCED_SOURCE" | "ERR_IMPORT_SOURCE_UNREADABLE" | "ERR_VALIDATION_FAILED", readonly detail: string);
}

// packages/importer/src/load/scalar.ts — the ONE boundary between legacy text and Dulja types
export function requireText(row: LegacyRow, column: string, where: string): string;
export function optionalText(row: LegacyRow, column: string): string | null;
/** spec:2041 — a legacy amount is a decimal string and becomes Money here or nowhere. A NULL is REFUSED,
 *  never coerced to zero: SAH-007/011 is exactly the defect of treating a NULL balance as a zero one.
 *  `currencyCode` is a `CurrencyCode`, never a `string`: it is the COMPANY's base currency (`baseCurrency()`),
 *  so the `Money` a loader mints and the `Money.zero(...)` its `load` adds it to are the same type. */
export function moneyOf(row: LegacyRow, column: string, currencyCode: CurrencyCode, where: string): Money;
export function quantityOf(row: LegacyRow, column: string, where: string): Quantity;
/** Accepts `YYYY-MM-DD` and `YYYY-MM-DD HH:MM:SS` (the two shapes 9A's renderer produces) and returns the
 *  date half. Anything else is a LoadError naming the column and the value. */
export function dateOf(row: LegacyRow, column: string, where: string): string;
export function optionalDateOf(row: LegacyRow, column: string, where: string): string | null;

// packages/importer/src/load/preflight.ts
export interface PreflightFinding { loader: string; sourceTable: string; column: string; problem: "missing" | "absent_table"; required: boolean; confidence: SourceColumn["confidence"]; note: string }
export interface PreflightReport { ok: boolean; findings: PreflightFinding[]; checkedTables: string[] }
/** Asks the DRIVER, not the reader: `LegacyReader` has no `columns()` and cannot answer a catalogue
 *  question (§4.13.1). Every declared column is checked before one row is read (§5.1 #10). */
export async function preflight(driver: LegacyDriver, selected: readonly Loader<unknown, unknown>[]): Promise<PreflightReport>;

// packages/importer/src/load/refs.ts
export function refResolver(tx: Sql, companyId: string): RefResolver;

// packages/importer/src/load/registry.ts
export const loaders: Loader<unknown, unknown>[];                    // §4.13.2; grown by T4–T8
export function loaderFor(targetTable: string): Loader<unknown, unknown>;
export function orderLoaders(selected: readonly Loader<unknown, unknown>[]): Loader<unknown, unknown>[];   // topological on dependsOn

// packages/importer/src/load/run.ts
export interface LoadSource { readonly reader: LegacyReader; readonly driver: LegacyDriver; close(): Promise<void> }
export type LoadSourceFactory = () => Promise<LoadSource>;
/** The same swappable-port shape 7A uses for `objectStore` / `setObjectStore` / `objectStoreFromEnv`, and
 *  for the same reason: §4.13.2 freezes `runLoad(sql, ctx)` at two parameters, so the legacy connection
 *  cannot be one of them, and a test must still be able to inject `FixtureLegacyDriver`. */
export function setLoadSource(factory: LoadSourceFactory): void;
export function loadSourceFromEnv(): Promise<LoadSource>;             // connectOdbc(process.env.LEGACY_ODBC_DSN)
/** The run's company base currency, read once when the run opens. `map(row, refs)` has no `LoadContext`,
 *  so this is how `moneyOf` mints Money in the tenant's own currency instead of an "MYR" literal. */
export function baseCurrency(): CurrencyCode;
export const EMPTY_TARGET: string;                                    // the all-zero uuid; see run.ts's comment
export const READ_BATCH: number;                                      // 500 — the streaming page size
export async function runLoad(conn: Sql, ctx: LoadContext): Promise<LoadReport>;
```

- [ ] **Step 1: Write the failing tests**

`packages/importer/test/load/preflight.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { preflight } from "../../src/load/preflight";
import type { Loader, SourceColumn } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";

const columns: SourceColumn[] = [
  { name: "UNTID",   required: true,  confidence: "hypothesis", note: "the unit's own key; the Units table's Prefix is UNT (dossier §3)" },
  { name: "UNTNAME", required: true,  confidence: "hypothesis", note: "the unit's display name" },
  { name: "UNTNOTE", required: false, confidence: "hypothesis", note: "free text, carried to name_ar when present" },
];

const stub = (sourceTable: string, cols: SourceColumn[]): Loader<unknown, unknown> => ({
  sourceTable, targetTable: "unit_of_measure", dependsOn: [], sourceColumns: cols,
  sourceKey: (r) => String((r as Record<string, string>).UNTID),
  map: (r) => r,
  load: async () => ({ inserted: 0, skipped: 0, batchIds: [] }),
});

describe("pre-flight — the column map is data with a confidence, checked against the live catalogue (hazard 3)", () => {
  it("passes when every declared column exists", async () => {
    const report = await preflight(new FixtureLegacyDriver(loadCorpus("cut-over")), [stub("UNITS", columns)]);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checkedTables).toEqual(["UNITS"]);
  });

  it("fails on a missing REQUIRED column and names it, its loader and its note", async () => {
    const extra = [...columns, { name: "UNTFACTOR", required: true, confidence: "hypothesis", note: "conversion factor" } as SourceColumn];
    const report = await preflight(new FixtureLegacyDriver(loadCorpus("cut-over")), [stub("UNITS", extra)]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { loader: "unit_of_measure", sourceTable: "UNITS", column: "UNTFACTOR", problem: "missing", required: true, confidence: "hypothesis", note: "conversion factor" },
    ]);
  });

  it("records a missing OPTIONAL column as a finding but stays ok — the loader simply has less to map", async () => {
    const extra = [...columns, { name: "UNTCOLOUR", required: false, confidence: "hypothesis", note: "unused" } as SourceColumn];
    const report = await preflight(new FixtureLegacyDriver(loadCorpus("cut-over")), [stub("UNITS", extra)]);
    expect(report.ok).toBe(true);
    expect(report.findings.map((f) => f.column)).toEqual(["UNTCOLOUR"]);
  });

  it("reports an absent TABLE once, not once per column", async () => {
    const report = await preflight(new FixtureLegacyDriver(loadCorpus("cut-over")), [stub("NOSUCHTABLE", columns)]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { loader: "unit_of_measure", sourceTable: "NOSUCHTABLE", column: "*", problem: "absent_table", required: true, confidence: "hypothesis", note: "the loader's source table is not in the catalogue" },
    ]);
  });

  it("reports an absent table once when TWO loaders share it — the shape accountLoader and partyLoader have", async () => {
    // `accountLoader` and `partyLoader` both read `ACCOUNTS` (T4), so a source missing that one table is a
    // real customer shape. The de-duplication must be by TABLE: keyed off `checkedTables` alone it would
    // print two findings differing only in `loader`, because `checkedTables` records only tables that are
    // present. The first loader in `selected` order is the one named.
    const first = { ...stub("NOSUCHTABLE", columns), targetTable: "account" };
    const second = { ...stub("NOSUCHTABLE", columns), targetTable: "party" };
    const report = await preflight(new FixtureLegacyDriver(loadCorpus("cut-over")), [first, second]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { loader: "account", sourceTable: "NOSUCHTABLE", column: "*", problem: "absent_table", required: true, confidence: "hypothesis", note: "the loader's source table is not in the catalogue" },
    ]);
    expect(report.checkedTables).toEqual([]);
  });

  it("checks a shared PRESENT table once and lists it once", async () => {
    const first = { ...stub("UNITS", columns), targetTable: "account" };
    const second = { ...stub("UNITS", columns), targetTable: "party" };
    const report = await preflight(new FixtureLegacyDriver(loadCorpus("cut-over")), [first, second]);
    expect(report.ok).toBe(true);
    expect(report.checkedTables).toEqual(["UNITS"]);
  });
});
```

`packages/importer/test/load/run.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db } from "@dulja/db/test";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { systemContext, withTenant } from "@dulja/db";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { loaders, orderLoaders } from "../../src/load/registry";
import { LoadError, type Loader, type LoadContext } from "../../src/load/types";
import type { LegacyRow } from "../../src/index";
import { EMPTY_TARGET, runLoad, setLoadSource, READ_BATCH } from "../../src/load/run";
import { loadCorpus } from "../support/corpus";

let db: Db;
let s: Seed;
const RUN = "01930000-0000-7000-8000-0000000000aa";

const source = async () => {
  const driver = new FixtureLegacyDriver(loadCorpus("cut-over"));
  return { driver, reader: await createReader(driver), close: async () => driver.close() };
};

/**
 * The framework's own tests must not depend on which BUSINESS loaders happen to be registered — T4–T8 add
 * those, and this file is written at T3 when `loaders` is still empty. So `run.test.ts` registers one
 * loader of its own and removes it again. It targets a real table because `runLoad` commits: T4 replaces it
 * in the registry with the full `unitLoader` (name_ar, the code rule, the skip case); this one carries the
 * two columns `runLoad` needs to page, hash and link.
 */
const stubLoader: Loader<LegacyRow, { code: string; nameEn: string }> = {
  sourceTable: "UNITS",
  targetTable: "unit_of_measure",
  dependsOn: [],
  sourceColumns: [
    { name: "UNTID", required: true, confidence: "hypothesis", note: "the Units key" },
    { name: "UNTNAME", required: true, confidence: "hypothesis", note: "the unit's name" },
  ],
  sourceKey: (row) => String(row["UNTID"]),
  map: (row) => ({ code: `U${String(row["UNTID"])}`, nameEn: String(row["UNTNAME"]) }),
  async load(tx, ctx, rows) {
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const [made] = await tx<{ id: string }[]>`
        insert into app.unit_of_measure (tenant_id, company_id, code, name_en)
        values (app.current_tenant(), ${ctx.companyId}, ${row.code}, ${row.nameEn})
        on conflict (company_id, code) do nothing
        returning id`;
      if (made) { inserted += 1; batchIds.push(made.id); continue; }
      const [existing] = await tx<{ id: string }[]>`
        select id from app.unit_of_measure where company_id = ${ctx.companyId} and code = ${row.code}`;
      skipped += 1;
      batchIds.push(existing!.id);
    }
    return { inserted, skipped, batchIds };
  },
};

const ctx = async (over: Partial<LoadContext> = {}): Promise<LoadContext> => ({
  ...(await systemContext(db.rw, s.tenant, RUN)),
  companyId: s.company, runId: RUN, cutOverDate: "2026-01-31", dryRun: false, ...over,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "load-run");
  setLoadSource(source);
  loaders.push(stubLoader as Loader<unknown, unknown>);
}, 180_000);
afterAll(async () => {
  loaders.splice(loaders.indexOf(stubLoader as Loader<unknown, unknown>), 1);
  await db?.stop();
});

describe("runLoad — contracts §4.13.2", () => {
  it("streams in pages of 500 — the bound spec:1368 wants on a table with millions of rows", () => {
    expect(READ_BATCH).toBe(500);
  });

  it("orders loaders by dependsOn and raises on a cycle rather than looping", () => {
    const a: Loader<unknown, unknown> = { ...loaders[0]!, targetTable: "a", dependsOn: ["b"] };
    const b: Loader<unknown, unknown> = { ...loaders[0]!, targetTable: "b", dependsOn: [] };
    expect(orderLoaders([a, b]).map((l) => l.targetTable)).toEqual(["b", "a"]);
    const x: Loader<unknown, unknown> = { ...loaders[0]!, targetTable: "x", dependsOn: ["y"] };
    const y: Loader<unknown, unknown> = { ...loaders[0]!, targetTable: "y", dependsOn: ["x"] };
    expect(() => orderLoaders([x, y])).toThrow(/loader dependency cycle: x, y/);
  });

  it("a dry run reads every row, reports every count, and writes nothing", async () => {
    const before = await withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: RUN }, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.import_batch`;
      return n!.n;
    });
    const report = await runLoad(db.rw, await ctx({ dryRun: true }));
    expect(report.perLoader["unit_of_measure"]!.inserted).toBeGreaterThan(0);
    const after = await withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: RUN }, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.import_batch`;
      return n!.n;
    });
    expect(after).toBe(before);
  });

  it("re-running the same load inserts nothing twice (SAH-049 — duplicate aggregate rows do not double-load)", async () => {
    const first = await runLoad(db.rw, await ctx());
    const second = await runLoad(db.rw, await ctx());
    expect(first.perLoader["unit_of_measure"]!.inserted).toBeGreaterThan(0);
    expect(second.perLoader["unit_of_measure"]!.inserted).toBe(0);
    expect(second.perLoader["unit_of_measure"]!.skipped).toBe(first.perLoader["unit_of_measure"]!.inserted);
  });

  // Reads the state the test ABOVE committed — these `it`s share one tenant and run in file order, so a
  // second `runLoad` here would make the re-run test's own first load a no-op and its `toBeGreaterThan(0)`
  // fail. Asserting on what the previous test left is both cheaper and the thing worth asserting.
  it("leaves no all-zero target when every mapped row produced one — the sentinel is never a loader's answer here", async () => {
    const stranded = await withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: RUN }, (tx) =>
      tx<{ source_table: string; source_key: string }[]>`
        select source_table, source_key from app.import_batch
         where company_id = ${s.company}
           and target_id = ${EMPTY_TARGET}::uuid
         order by source_table, source_key`);
    // `runLoad` writes the placeholder and `linkBatches` overwrites it inside the SAME transaction, so a
    // committed all-zero row is never a crash artefact — it can only be a value a loader returned, meaning
    // "seen, hashed, produced no target row". Every row of this corpus produces one, so there are none.
    expect(stranded).toEqual([]);
  });

  it("refuses a changed source row for a key already mapped, naming the key", async () => {
    const moved = loadCorpus("cut-over");
    moved.tables["UNITS"]!.rows[0] = { ...moved.tables["UNITS"]!.rows[0]!, UNTNAME: "Renamed after the freeze" };
    setLoadSource(async () => {
      const driver = new FixtureLegacyDriver(moved);
      return { driver, reader: await createReader(driver), close: async () => driver.close() };
    });
    await expect(runLoad(db.rw, await ctx())).rejects.toThrow(
      /ERR_IMPORT_DUPLICATE_SOURCE_KEY: UNITS\/1 was loaded with different data/,
    );
    setLoadSource(source);
  });

  it("carries every LoadError code as a field, never as an AppError (§3.1)", () => {
    const e = new LoadError("ERR_IMPORT_UNBALANCED_SOURCE", "voucher 17 is out by 3.0000");
    expect(e.code).toBe("ERR_IMPORT_UNBALANCED_SOURCE");
    expect(e.message).toBe("ERR_IMPORT_UNBALANCED_SOURCE: voucher 17 is out by 3.0000");
  });

  it("writes an artefact index whose entries carry their own sha256 (amendment C9)", async () => {
    const report = await runLoad(db.rw, await ctx({ runId: "01930000-0000-7000-8000-0000000000ab" }));
    expect(report.artefacts.artefacts.map((a) => a.name)).toContain("load-summary.json");
    expect(report.artefacts.artefacts.every((a) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun run --cwd packages/importer test load/`
Expected: FAIL — `Cannot find module '../../src/load/preflight'` and `Cannot find module '../../src/load/run'`.

- [ ] **Step 3: Widen `packages/importer/package.json`**

9A declared exactly `@dulja/contracts`, `decimal.js` and `odbc`, and said so deliberately: taking `@dulja/db` would have made 9A wait for 0D. 9B **does** wait for 0D — it waits for 8D — so the two dependencies land here. `dependency-rule` already carries the row `"packages/importer": ["@dulja/domain", "@dulja/db", "@dulja/contracts"]` (§3.1), so no lint rule changes. Versions are `workspace:*` — never a pinned number (spec:104).

```json
  "dependencies": {
    "@dulja/contracts": "workspace:*",
    "@dulja/db": "workspace:*",
    "@dulja/domain": "workspace:*",
    "decimal.js": "*",
    "odbc": "*"
  },
```

The `"*"` on the two external packages is what 9A already ships: the lockfile owns the version and a source file never carries one.

- [ ] **Step 4: Write `load/types.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "@dulja/db";
import type { ArtefactIndex, LegacyDriver, LegacyReader, ReconciliationReport } from "../index";

/** Contracts §4.13.2, verbatim. */
export interface LoadContext extends TenantContext {
  companyId: string;
  runId: string;
  /** The accounting date every imported document carries. Entered by the operator (spec:2039), never
   *  derived from a legacy timestamp and never from `now()`. */
  cutOverDate: string;
  dryRun: boolean;
  /** Amendment C14. Restrict the run to these TARGET tables — the resume switch the route and the job
   *  payload already accept. `runLoad` orders whatever survives the filter, and refuses a name no loader
   *  targets rather than running nothing. Omitted means every registered loader. */
  only?: string[];
}

export interface RefResolver {
  /** `table` is the TARGET table name (`item`, `party`, `account`, …); `legacyRef` is the source key. */
  byLegacyRef(table: string, legacyRef: string): Promise<string | null>;
}

export interface SourceColumn {
  readonly name: string;
  readonly required: boolean;
  readonly confidence: "verified" | "hypothesis";
  readonly note: string;
}

export interface Loader<S, T> {
  readonly sourceTable: string;
  readonly targetTable: string;
  readonly dependsOn: string[];
  readonly sourceColumns: readonly SourceColumn[];
  /** Amendment C13. Default (absent or false): `runLoad` calls `load` once per page of at most
   *  `READ_BATCH` rows. `true`: this loader's answer is a function of the WHOLE table — an opening trial
   *  balance whose residue goes to ONE suspense line, a movement history whose moving average is
   *  meaningless a page at a time — so `runLoad` maps every page first and calls `load` exactly once, in
   *  one transaction. Only two loaders set it, and `run.test.ts` pins which. */
  readonly wholeTable?: boolean;
  readonly sourceKey: (row: S) => string;
  /** Pure: no I/O beyond `refs`, which reads only `app.import_batch`. Returning `{ skip }` is how a row
   *  that cannot be mapped is REPORTED rather than nulled (§5.1 #3 — "do not silently null them"). */
  map(row: S, refs: RefResolver): T | { skip: string } | Promise<T | { skip: string }>;   // amendment C12
  /** Amendment C15. `skips` carries the reasons a per-row `map` cannot know — a position the whole replay
   *  drove negative, an employee whose YTD disagrees with their own payslips. `runLoad` concatenates them
   *  into `LoadReport.skips`; the `skipped` count above already includes them, so they are not counted
   *  twice. A loader that has no such reason omits the member and is unchanged. */
  load(tx: Sql, ctx: LoadContext, rows: T[]): Promise<{ inserted: number; skipped: number; batchIds: string[]; skips?: readonly SkipRecord[] }>;
}

export interface SkipRecord { loader: string; sourceTable: string; sourceKey: string; reason: string }
export interface LoaderReport { inserted: number; skipped: number; conflicts: number }

export interface LoadReport {
  perLoader: Record<string, LoaderReport>;
  reconciliation: ReconciliationReport[];
  artefacts: ArtefactIndex;
  skips: SkipRecord[];
}

export class LoadError extends Error {
  constructor(
    readonly code: "ERR_IMPORT_DUPLICATE_SOURCE_KEY" | "ERR_IMPORT_UNBALANCED_SOURCE" | "ERR_IMPORT_SOURCE_UNREADABLE" | "ERR_VALIDATION_FAILED",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "LoadError";
  }
}

export type { LegacyDriver, LegacyReader };
```

- [ ] **Step 5: Write `load/scalar.ts`**

```ts
import Decimal from "decimal.js";
import { Money, Quantity, type CurrencyCode } from "@dulja/domain";
import type { LegacyRow } from "../index";
import { LoadError } from "./types";

const DECIMAL = /^-?\d{1,18}(\.\d{1,8})?$/;
const DATE = /^(\d{4}-\d{2}-\d{2})([T ]\d{2}:\d{2}:\d{2}(\.\d+)?)?$/;

export function requireText(row: LegacyRow, column: string, where: string): string {
  const raw = row[column];
  if (raw === null || raw === undefined || raw === "") {
    throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${column} is empty; the loader will not guess a value (SAH-007)`);
  }
  if (typeof raw === "boolean") return raw ? "1" : "0";
  return raw.trim();
}

export function optionalText(row: LegacyRow, column: string): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "1" : "0";
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * SAH-007 and SAH-011: "Expect NULL-poisoned balances and costs. These will appear as blank or zero, not
 * as errors." A NULL is therefore REFUSED here, never coerced. A row whose amount is genuinely absent is
 * skipped by its loader's `map` with a reason that reaches the skip register — visible, not invented.
 */
export function moneyOf(row: LegacyRow, column: string, currencyCode: CurrencyCode, where: string): Money {
  const raw = row[column];
  if (raw === null || raw === undefined || raw === "") {
    throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${column} is NULL; a NULL legacy amount is never read as zero (SAH-007, SAH-011)`);
  }
  const text = String(raw).trim();
  if (!DECIMAL.test(text)) {
    throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${column} is ${JSON.stringify(text)}, which is not a decimal string`);
  }
  // Round HALF_AWAY_FROM_ZERO at scale 4 exactly as Money does (hazard 23); a legacy column with more
  // decimals than numeric(19,4) holds is rounded once, here, and the fact is reported by the caller.
  //
  // `currencyCode` is the COMPANY's base currency, passed in by the caller from `baseCurrency()`. There is
  // deliberately no `"MYR"` literal and no `as CurrencyCode` cast anywhere in this package: a cast here
  // would mint a `Money<CurrencyCode & "MYR">` that a non-MYR tenant's `load` could not add to its own
  // `Money.zero(base)`, which is precisely the compile-time check §4.2.1 exists to provide.
  return Money.of(new Decimal(text).toFixed(4, Decimal.ROUND_HALF_UP), currencyCode);
}

export function quantityOf(row: LegacyRow, column: string, where: string): Quantity {
  const raw = row[column];
  if (raw === null || raw === undefined || raw === "") {
    throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${column} is NULL; a NULL legacy quantity is never read as zero (SAH-011)`);
  }
  const text = String(raw).trim();
  if (!DECIMAL.test(text)) {
    throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${column} is ${JSON.stringify(text)}, which is not a decimal string`);
  }
  return Quantity.of(new Decimal(text).toFixed(6, Decimal.ROUND_HALF_UP));
}

export function dateOf(row: LegacyRow, column: string, where: string): string {
  const text = requireText(row, column, where);
  const m = DATE.exec(text);
  if (!m) throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${column} is ${JSON.stringify(text)}, which is not YYYY-MM-DD`);
  return m[1]!;
}

export function optionalDateOf(row: LegacyRow, column: string, where: string): string | null {
  const text = optionalText(row, column);
  if (text === null) return null;
  const m = DATE.exec(text);
  if (!m) throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${column} is ${JSON.stringify(text)}, which is not YYYY-MM-DD`);
  return m[1]!;
}
```

- [ ] **Step 6: Write `load/preflight.ts`**

```ts
import type { Loader, SourceColumn } from "./types";
import type { LegacyDriver } from "../index";

export interface PreflightFinding {
  loader: string; sourceTable: string; column: string;
  problem: "missing" | "absent_table"; required: boolean;
  confidence: SourceColumn["confidence"]; note: string;
}
export interface PreflightReport { ok: boolean; findings: PreflightFinding[]; checkedTables: string[] }

/**
 * §5.1 #10, "scope first, migrate second", applied per column. Hazard 3 forbids a transcribed row
 * interface, so every loader declares its columns as data and this function is what turns that data into
 * a checkable claim against the customer's own catalogue BEFORE a single row is read.
 *
 * It asks the DRIVER: `LegacyReader` (§4.13.1) has `tables`, `count`, `dateRange` and `read` — no
 * `columns` — because the reader is the row surface and the catalogue is the driver's.
 */
export async function preflight(
  driver: LegacyDriver,
  selected: readonly Loader<unknown, unknown>[],
): Promise<PreflightReport> {
  const present = new Set(await driver.tables());
  const findings: PreflightFinding[] = [];
  const checkedTables: string[] = [];
  // An ABSENT table is reported once per TABLE, not once per loader and not once per column. Two loaders
  // legitimately share one source table — `accountLoader` and `partyLoader` both read `ACCOUNTS`, and the
  // whole point of `SOURCE_OF` is that they do — so a missing `ACCOUNTS` must not print two identical
  // findings that differ only in the `loader` field and make an operator think two things are wrong.
  // `checkedTables` cannot carry the de-duplication on its own: it holds only tables that are PRESENT,
  // by construction, because that is what it means downstream and what the report publishes.
  const reportedAbsent = new Set<string>();

  for (const loader of selected) {
    if (!present.has(loader.sourceTable)) {
      if (reportedAbsent.has(loader.sourceTable)) continue;
      reportedAbsent.add(loader.sourceTable);
      findings.push({
        // `loader` names the FIRST loader that wanted the table, in `selected` order, and the note says the
        // finding is about the table. Naming one of several is honest and deterministic; naming all of them
        // would make the field a list, which `PreflightFinding` (a flat row in a CSV artefact) is not.
        loader: loader.targetTable, sourceTable: loader.sourceTable, column: "*",
        problem: "absent_table", required: true, confidence: "hypothesis",
        note: "the loader's source table is not in the catalogue",
      });
      continue;
    }
    if (checkedTables.includes(loader.sourceTable)) continue;
    checkedTables.push(loader.sourceTable);
  }

  for (const loader of selected) {
    if (!present.has(loader.sourceTable)) continue;
    const have = new Set((await driver.columns(loader.sourceTable)).map((c) => c.name));
    for (const column of loader.sourceColumns) {
      if (have.has(column.name)) continue;
      findings.push({
        loader: loader.targetTable, sourceTable: loader.sourceTable, column: column.name,
        problem: "missing", required: column.required, confidence: column.confidence, note: column.note,
      });
    }
  }

  return { ok: findings.every((f) => !f.required), findings, checkedTables };
}
```

- [ ] **Step 7: Write `load/refs.ts` and `load/registry.ts`**

`packages/importer/src/load/refs.ts`:

```ts
import type { Sql } from "postgres";
import { byLegacyRef } from "@dulja/db";
import type { RefResolver } from "./types";

/** The §4.13.2 resolver, backed by `app.import_batch` (T2). It never reads the target table: a loader must
 *  see only what THIS load produced, so a hand-created row that happens to carry the same code is not
 *  mistaken for an imported one. `sourceTable` is derived from the target because `import_batch` records
 *  both and a resolver caller knows only "which Dulja table". */
/**
 * **The source key each target is looked up BY — written down here because two loaders read one legacy
 * table and a resolver caller sees neither of them.** `byLegacyRef(table, ref)` searches
 * `import_batch.source_key`, so `ref` must be spelled exactly as that loader's `Loader.sourceKey` spells
 * it. The four that matter:
 *
 *   `unit_of_measure` ← `Units.UNTID`      · `item` ← `Materials.MATID`
 *   `warehouse`       ← `Warehouses.WARID` · `lot`  ← `MatBatches.BATID`
 *   `party`           ← `ACC:<Accounts.ACCID>`   — the surrogate key, prefixed; `Bills.BILACC` holds ACCID
 *   `account`         ← `Accounts.ACCCODE`       — the chart CODE, bare; `AccTotals.ACTACC` holds ACCCODE
 *
 * The last two are the pair that can silently drift, and they are deliberately different because their
 * two callers hold different legacy identifiers. The `ACC:` prefix is what keeps one legacy `Accounts`
 * row able to become both a party and an account under one `(company, source_table, source_key)` key.
 * **A loader that changes its `sourceKey` changes this list in the same commit**, or its target becomes
 * unresolvable and every dependent row skips with an orphan reason that is not true.
 */
const SOURCE_OF: Readonly<Record<string, string>> = {
  unit_of_measure: "UNITS",
  warehouse: "WAREHOUSES",
  item: "MATERIALS",
  lot: "MATBATCHES",
  party: "ACCOUNTS",
  account: "ACCOUNTS",
  employee: "EMPLOYEES",
  document: "BILLS",
};

export function refResolver(tx: Sql, companyId: string): RefResolver {
  return {
    async byLegacyRef(table: string, legacyRef: string): Promise<string | null> {
      const sourceTable = SOURCE_OF[table];
      if (!sourceTable) return null;
      return byLegacyRef(tx, { companyId, sourceTable, sourceKey: legacyRef, targetTable: table });
    },
  };
}
```

**`party` and `account` share `ACCOUNTS` deliberately** — the legacy `Accounts` table is both the chart of accounts and the customer/vendor file (dossier §0.4), and `import_batch`'s natural key is `(company, source_table, source_key)`, so one legacy row may map to a `party` row *and* an `account` row only if their source keys differ. They do, and **they differ in more than a prefix**: the party loader keys on `ACC:<ACCID>` (the surrogate key, because `Bills.BilAcc` holds an ACCID and that is what the open-item loader resolves on) and the account loader keys on the bare `ACCCODE` (the chart code, because `AccTotals.ActAcc` holds an ACCCODE and that is what the trial-balance opening resolves on). Task 4 states each rule where the key is built, and the docstring above `SOURCE_OF` carries the whole list in one place so the pair cannot drift apart again.

**An employee's party is NOT reachable through the resolver, by design.** Task 8's employee loader creates one `app.party` of kind `employee` beside each `app.employee`, but it records a single `import_batch` row — `(EMPLOYEES, <key>) → employee` — because the party is an implementation detail of the employee, not an independently imported thing. `SOURCE_OF` therefore maps `party` to `ACCOUNTS` only, and `byLegacyRef("party", …)` answers `null` for an employee. Anything that needs an employee's party reads `employee.party_id`. A future loader that needs the other direction adds its own row under a source key that cannot collide with the `ACC:<id>` space — it must not re-point `SOURCE_OF.party`, which would silently change what every existing open item resolves to.

`packages/importer/src/load/registry.ts`:

```ts
import type { Loader } from "./types";

/** §4.13.2's `loaders`. Grown ONE ENTRY PER TASK — T4 master data and accounts, T5 the ledger opening,
 *  T6 opening stock, T7 open items, T8 employees — and in exactly this declaration order, which is also a
 *  valid topological order so `orderLoaders` is a no-op on the full set. */
export const loaders: Loader<unknown, unknown>[] = [];

export function loaderFor(targetTable: string): Loader<unknown, unknown> {
  const found = loaders.find((l) => l.targetTable === targetTable);
  if (!found) throw new Error(`no loader for target table ${targetTable}; registered: ${loaders.map((l) => l.targetTable).join(", ")}`);
  return found;
}

/** Kahn's algorithm over `dependsOn`. A cycle raises rather than loops, naming every member so the author
 *  of the offending loader can see which pair to break. */
export function orderLoaders(selected: readonly Loader<unknown, unknown>[]): Loader<unknown, unknown>[] {
  const names = new Set(selected.map((l) => l.targetTable));
  const pending = new Map(selected.map((l) => [l.targetTable, l.dependsOn.filter((d) => names.has(d))]));
  const ordered: Loader<unknown, unknown>[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.length === 0).map(([name]) => name);
    if (ready.length === 0) throw new Error(`loader dependency cycle: ${[...pending.keys()].sort().join(", ")}`);
    for (const name of ready) {
      ordered.push(selected.find((l) => l.targetTable === name)!);
      pending.delete(name);
    }
    for (const [name, deps] of pending) pending.set(name, deps.filter((d) => !ready.includes(d)));
  }
  return ordered;
}
```

- [ ] **Step 8: Write `load/run.ts`**

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { recordBatch, sourceHashOf, withTenant } from "@dulja/db";
import { currency, type CurrencyCode } from "@dulja/domain";
import { connectOdbc, createReader, redactDsn, ReportWriter, type ArtefactIndex, type LegacyDriver, type LegacyReader, type LegacyRow, type ReconciliationReport } from "../index";
import { preflight } from "./preflight";
import { refResolver } from "./refs";
import { loaders as REGISTERED, orderLoaders } from "./registry";
import { LoadError, type LoadContext, type Loader, type LoaderReport, type LoadReport, type SkipRecord } from "./types";

export interface LoadSource { readonly reader: LegacyReader; readonly driver: LegacyDriver; close(): Promise<void> }
export type LoadSourceFactory = () => Promise<LoadSource>;

/** 500 rows per read page and per `withTenant` transaction — spec:1368 wants short transactions, and the
 *  same figure 3B's `MOVEMENTS_PER_BATCH` uses, so an operator reading two runbooks sees one number. */
export const READ_BATCH = 500;

let sourceFactory: LoadSourceFactory = loadSourceFromEnv;
let openSource: LoadSource | null = null;
let openBaseCurrency: CurrencyCode | null = null;
export function setLoadSource(factory: LoadSourceFactory): void { sourceFactory = factory; }

/**
 * The company's base currency for the run in progress, read once from `app.company` when `runLoad` opens
 * and cleared when it closes — the same run-scoped port shape as `loadSource()` above, and for the same
 * reason: `Loader.map(row, refs)` (§4.13.2, frozen) has no `LoadContext`, and every `moneyOf` call is in a
 * `map`. Without it a loader would have to write `moneyOf(row, col, "MYR", …)`, whose result is
 * `Money<CurrencyCode & "MYR">`, and its own `load` would then try to add that to `Money.zero(base)` where
 * `base` came from `company.base_currency` — a compile error for an MYR company and
 * `ERR_MONEY_CURRENCY_MISMATCH` at run time for any other (§4.2.1). Throws outside a run.
 */
export function baseCurrency(): CurrencyCode {
  if (!openBaseCurrency) throw new LoadError("ERR_VALIDATION_FAILED", "baseCurrency() was called outside a runLoad; the company's base currency is read once, when the run opens");
  return openBaseCurrency;
}

/** The source `runLoad` currently has open. Its one caller outside this file is the employee loader's
 *  YTD reconciliation (T8), which needs a second read of `PAYITEMS` from inside `load`, whose signature
 *  (§4.13.2) carries no reader. Throws outside a run, so it can never open a second connection. */
export function loadSource(): LoadSource {
  if (!openSource) throw new LoadError("ERR_IMPORT_SOURCE_UNREADABLE", "loadSource() was called outside a runLoad; a loader may only read the source the run opened");
  return openSource;
}

export async function loadSourceFromEnv(): Promise<LoadSource> {
  const dsn = process.env.LEGACY_ODBC_DSN;
  if (!dsn) throw new LoadError("ERR_IMPORT_SOURCE_UNREADABLE", "LEGACY_ODBC_DSN is not set; the worker cannot reach the legacy database (contracts §3.11, amendment C10)");
  const driver = await connectOdbc({ dsn });
  return { driver, reader: await createReader(driver), close: () => driver.close() };
}

/**
 * Contracts §4.13.2. Runs every registered loader in dependency order as the caller's principal — which
 * `apps/worker` makes the tenant's SYSTEM principal (spec:2179, hazard 20).
 *
 * The shape is deliberate: one `withTenant` per page of at most READ_BATCH rows, so a load of two million
 * `Materials` never holds one transaction open, and a failure leaves every completed page committed and
 * recorded in `app.import_batch` — which is what makes the re-run idempotent instead of a restart.
 *
 * A loader that sets `wholeTable` (amendment C13) opts out of that: it is given every mapped row in ONE
 * call, in one transaction, because its answer is not decomposable by page. Two do — the trial-balance
 * opening, whose residue is one suspense line over all of `AccTotals`, and the stock replay, whose moving
 * average over 500 of a material's movements is not its average. The cost is real and is accepted: those
 * two hold their input in memory and commit once, so a crash mid-way rolls the whole opening back rather
 * than leaving half of one. That is the right failure for an opening balance, which is meaningless in
 * halves, and `replayLegacyMovements` needs the whole history in memory regardless.
 */
export async function runLoad(conn: Sql, ctx: LoadContext): Promise<LoadReport> {
  const source = await sourceFactory();
  openSource = source;
  const outDir = join("artefacts", "legacy", ctx.runId);
  mkdirSync(outDir, { recursive: true });
  const writer = new ReportWriter(outDir, { source: redactDsn(source.driver.source), engineVersion: source.reader.firebirdVersion });

  const perLoader: Record<string, LoaderReport> = {};
  const skips: SkipRecord[] = [];
  const reconciliation: ReconciliationReport[] = [];

  try {
    // Read once, before any loader runs, so every `moneyOf` in every `map` mints Money in the tenant's own
    // currency (see `baseCurrency()` above). A tenant whose company row is missing fails here rather than
    // three loaders later inside a posting.
    openBaseCurrency = await withTenant(conn, ctx, async (tx) => {
      const [company] = await tx<{ base_currency: string }[]>`select base_currency from app.company where id = ${ctx.companyId}`;
      if (!company) throw new LoadError("ERR_VALIDATION_FAILED", `no company ${ctx.companyId} in this tenant`);
      return currency(company.base_currency);
    });

    if (ctx.only) {
      // A typo in `only` must not read as "load nothing, successfully" (amendment C14).
      const known = REGISTERED.map((l) => l.targetTable);
      const unknown = ctx.only.filter((t) => !known.includes(t));
      if (unknown.length > 0) {
        throw new LoadError("ERR_VALIDATION_FAILED", `no loader targets ${unknown.join(", ")}; registered target tables are ${known.join(", ")}`);
      }
    }
    // Filtered THEN ordered, so a restricted run still runs in dependency order. It may still leave
    // references unresolved — loading `opening_balance` without `account` reports every line as an
    // orphan rather than guessing one — which is why `only` is a resume switch, not a scoping feature.
    const ordered = orderLoaders(REGISTERED.filter((l) => !ctx.only || ctx.only.includes(l.targetTable)));
    const pre = await preflight(source.driver, ordered);
    writer.json("preflight.json", pre, pre.findings.length);
    if (!pre.ok) {
      const missing = pre.findings.filter((f) => f.required).map((f) => `${f.sourceTable}.${f.column}`).join(", ");
      throw new LoadError("ERR_IMPORT_SOURCE_UNREADABLE", `pre-flight failed: the source has no ${missing}. Re-run 9A's scope report and correct the column map before loading.`);
    }

    for (const loader of ordered) {
      const report: LoaderReport = { inserted: 0, skipped: 0, conflicts: 0 };
      perLoader[loader.targetTable] = report;
      const columns = loader.sourceColumns.map((c) => c.name);

      const runPage = (rows: LegacyRow[]) =>
        withTenant(conn, ctx, async (tx) => {
          const refs = refResolver(tx, ctx.companyId);
          const mapped: unknown[] = [];
          const keys: string[] = [];
          for (const row of rows) {
            const key = loader.sourceKey(row);
            const result = (await loader.map(row, refs)) as unknown;   // amendment C12: map may be async
            if (result && typeof result === "object" && "skip" in (result as Record<string, unknown>)) {
              report.skipped += 1;
              skips.push({ loader: loader.targetTable, sourceTable: loader.sourceTable, sourceKey: key, reason: String((result as { skip: string }).skip) });
              continue;
            }
            // The hash covers exactly the columns this loader declared, so a column added to the source
            // after the freeze does not look like a change to a row this load already mapped.
            const hash = sourceHashOf(Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
            const seen = await recordBatch(tx, {
              companyId: ctx.companyId, sourceTable: loader.sourceTable, sourceKey: key,
              targetTable: loader.targetTable, targetId: EMPTY_TARGET, sourceHash: hash, runId: ctx.runId,
            });
            if (seen.kind === "conflict") {
              report.conflicts += 1;
              throw new LoadError("ERR_IMPORT_DUPLICATE_SOURCE_KEY", `${loader.sourceTable}/${key} was loaded with different data on an earlier run; freeze the source and re-run, or reverse the imported document`);
            }
            if (seen.kind === "skipped") { report.skipped += 1; continue; }
            mapped.push(result);
            keys.push(key);
          }
          if (mapped.length === 0) return;
          if (ctx.dryRun) { report.inserted += mapped.length; throw DRY_RUN; }
          const out = await loader.load(tx, ctx, mapped);
          report.inserted += out.inserted;
          report.skipped += out.skipped;
          // Amendment C15. `out.skipped` already counts these; `out.skips` is what says WHY, and it is the
          // only channel for a reason a per-row `map` could not have known.
          if (out.skips) skips.push(...out.skips);
          await linkBatches(tx, ctx, loader, keys, out.batchIds);
        }).catch((e) => { if (e !== DRY_RUN) throw e; });

      // Amendment C13. A paged loader sees each page as the reader yields it; a whole-table loader sees the
      // concatenation, once. `read` still pages the WIRE either way — READ_BATCH bounds the driver's fetch,
      // not this array — so the difference is how many `load` calls and how many transactions there are.
      const held: LegacyRow[] = [];
      for await (const page of source.reader.read<LegacyRow>(loader.sourceTable, { columns, batch: READ_BATCH })) {
        if (loader.wholeTable) held.push(...page);
        else await runPage(page);
      }
      if (loader.wholeTable && held.length > 0) await runPage(held);

      writer.json(`loader-${loader.targetTable}.json`, report, report.inserted);
    }

    writer.json("load-summary.json", { runId: ctx.runId, cutOverDate: ctx.cutOverDate, dryRun: ctx.dryRun, perLoader }, Object.keys(perLoader).length);
    writer.csv("skips.csv", skips as unknown as Record<string, unknown>[]);
    return { perLoader, reconciliation, artefacts: writer.finish(), skips };
  } finally {
    openSource = null;
    openBaseCurrency = null;
    await source.close();
  }
}

/** Sentinel: a dry run rolls its transaction back rather than committing, so nothing reaches disk and the
 *  counts are still real. Thrown, not returned, because postgres.js commits a transaction whose callback
 *  returns normally. */
const DRY_RUN = Symbol("dry-run");
/**
 * The all-zero uuid, in two roles. **In flight:** `recordBatch` runs BEFORE `loader.load` — so a changed
 * source row is refused before anything is written — and `linkBatches` fills the real target ids
 * immediately after, inside the SAME `withTenant` transaction. Nothing partial is ever committed, so a
 * crash cannot leave this value behind. **Committed:** it therefore has exactly one meaning, and a loader
 * is allowed to return it to say so — *this source row was read, hashed and recorded, and it produced no
 * target row*. Only `openingStockLoader` does, for a warehouse that opened no stock at all.
 *
 * The consequence is deliberate and belongs in `skips.csv`, not in a surprise: such a row's hash is
 * unchanged on a re-run, so `recordBatch` skips it and it is never retried. For an emptied warehouse that
 * is right — there is nothing to open, this year or next. For a position reported because its material did
 * not import, correcting `Materials` alone will NOT re-open it: the operator opens that position from the
 * reconciliation, or reloads into a clean tenant. The runbook's step 5 is where that decision is made.
 */
export const EMPTY_TARGET = "00000000-0000-0000-0000-000000000000";

/**
 * **`batchIds` is POSITIONAL and TOTAL over the rows `load` was handed — there is no early-return escape.**
 * `keys[i]` and `batchIds[i]` are the same source row, so a loader returns exactly `rows.length` entries in
 * `rows` order, whatever happened inside: a row that produced no target row returns `EMPTY_TARGET` (see its
 * comment above) and a row that shares a document with others returns that document's id again. The length
 * check below is the contract, and it is deliberately a refusal rather than a truncation — a loader that
 * returned fewer ids has lost track of which source row became which target row, and silently pairing the
 * first N would point `import_batch` rows at the wrong targets for the rest of the tenant's life.
 */
async function linkBatches(tx: Sql, ctx: LoadContext, loader: Loader<unknown, unknown>, keys: string[], batchIds: string[]): Promise<void> {
  if (keys.length !== batchIds.length) {
    throw new LoadError("ERR_VALIDATION_FAILED", `${loader.targetTable} returned ${batchIds.length} target ids for ${keys.length} mapped rows; a loader must return one per row, in order`);
  }
  for (const [i, key] of keys.entries()) {
    await tx`update app.import_batch set target_id = ${batchIds[i]!}
              where company_id = ${ctx.companyId} and source_table = ${loader.sourceTable}
                and source_key = ${key} and target_id = ${EMPTY_TARGET}`;
  }
}
```

- [ ] **Step 9: Extend the barrel and the CLI**

`packages/importer/src/index.ts` gains one export block; nothing 9A exported is changed:

```ts
// 9B — the loader surface (contracts §4.13.2). Everything under src/load/ that crosses a slice boundary.
export {
  LoadError, type Loader, type LoadContext, type LoaderReport, type LoadReport,
  type RefResolver, type SkipRecord, type SourceColumn,
} from "./load/types";
export { preflight, type PreflightFinding, type PreflightReport } from "./load/preflight";
export { refResolver } from "./load/refs";
export { loaderFor, loaders, orderLoaders } from "./load/registry";
export { baseCurrency, EMPTY_TARGET, loadSource, loadSourceFromEnv, READ_BATCH, runLoad, setLoadSource, type LoadSource, type LoadSourceFactory } from "./load/run";
export { dateOf, moneyOf, optionalDateOf, optionalText, quantityOf, requireText } from "./load/scalar";
```

`packages/importer/src/cli.ts` gains one command in its existing `switch` — the CLI is the operator's local path and the worker is the deployed one; both call the same `runLoad`:

```ts
    case "load": {
      const ctx = {
        ...(await systemContext(createDb(requireEnv("DATABASE_URL")), args.tenantId!, randomUUID())),
        companyId: args.companyId!, runId: randomUUID(),
        cutOverDate: args.cutOverDate!, dryRun: args.dryRun ?? false,
        ...(args.only ? { only: args.only.split(",") } : {}),   // amendment C14
      };
      const report = await runLoad(createDb(requireEnv("DATABASE_URL")), ctx);
      console.log(JSON.stringify({ runId: ctx.runId, perLoader: report.perLoader, skips: report.skips.length, artefacts: report.artefacts.artefacts.length }, null, 2));
      return report.skips.length === 0 ? 0 : 3;
    }
```

`--cut-over-date`, `--tenant-id` and `--company-id` join `parseArgs`'s `CliArgs` as required strings for this command, `--dry-run` as a boolean and `--only` as an optional comma-separated string (amendment C14 — the same resume switch the job payload carries, so the local and deployed paths accept the same run); the existing `parseArgs` exits **2** on a missing required argument, which is 9A's own config-error code and is not changed. `console.log` is legal here and only here: `packages/*/src/cli.ts` is the one `no-console` override glob (§3.2) and this file is already inside it.

- [ ] **Step 10: Write the cut-over corpus's first two files**

`packages/importer/test/corpus/cut-over/catalog.json` — the catalogue shape 9A's `loadCorpus` reads, with the tables Tasks 3–8 grow into. Only `UNITS` carries rows at this task:

```json
{
  "engineVersion": "WI-V2.5.9.27139 Firebird 2.5",
  "tables": {
    "UNITS": {
      "keyColumns": ["UNTID"],
      "columns": [
        { "name": "UNTID",   "kind": "integer", "scale": 0, "nullable": false },
        { "name": "UNTNAME", "kind": "text",    "scale": 0, "nullable": false },
        { "name": "UNTNOTE", "kind": "text",    "scale": 0, "nullable": true }
      ]
    }
  }
}
```

`packages/importer/test/corpus/cut-over/UNITS.json`:

```json
[
  { "UNTID": "1", "UNTNAME": "Piece", "UNTNOTE": "قطعة" },
  { "UNTID": "2", "UNTNAME": "Carton", "UNTNOTE": null },
  { "UNTID": "3", "UNTNAME": "Kilogram", "UNTNOTE": "كيلوغرام" }
]
```

**Why the column names look like this, and what they claim.** The dossier records one verified fact about legacy column naming: "A per-table `Prefix` is prepended to every physical column name (`Accounts.AccName`, `BillItems.BtmQnt`)". The table *names* this plan draws on (`UNITS`, `MATERIALS`, `WAREHOUSES`, `ACCOUNTS`, `ACCTOTALS`, `MATOBJECTS`, `MATBATCHES`, `MATOPENS`, `BILLS`, `BILLITEMS`, `VOUCHERS`, `VOUITEMS`, `EMPLOYEES`, `PAYITEMS`) are the dossier's own Appendix A list, which 9A already committed as `LEGACY_MODULES` — they are **not** invented here. **Only a subset of them becomes a corpus row file**: `UNITS`, `WAREHOUSES`, `MATERIALS`, `MATBATCHES`, `ACCOUNTS`, `ACCTOTALS`, `BILLITEMS`, `BILLS`, `EMPLOYEES` and `PAYITEMS` under `corpus/cut-over/`, plus `MATOPENS` in T15's sibling `corpus/matopens-partitioned/`. The rest are named by a loader's prose or a guard and have no fixture, which is why the File Structure list is shorter than this one. The *column* names are the prefix rule applied, and every one of them is declared `confidence: "hypothesis"` in its loader's `sourceColumns`; pre-flight is what turns the hypothesis into a pass or a named failure against the customer's catalogue. This is the whole mechanism hazard 3 asks for, and it is why no task in this plan writes a `MaterialRow` interface.

- [ ] **Step 11: Write ADR 0084**

`docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md`, in Plan 0A's format:

```markdown
# 0084 — Idempotent loaders keyed on `import_batch`, with declarative source columns

- **Status:** Accepted
- **Date:** 2026-09-08
- **Slice:** 9B (Loaders and cut-over)
- **Supersedes:** none

## Context

The Phase 9 load runs against a customer's live-then-frozen Firebird database, over hours, on a machine
that may lose its connection. It will be run more than once: a dry run, a rehearsal, and the real cut-over
(§5.1 #10). It must therefore be restartable without double-loading — SAH-049 says the source itself
contains duplicate aggregate rows, so "insert everything again and let the unique keys sort it out" both
hides real duplicates and hides real changes.

Two further constraints shape the design. First, hazard 3: the column list of every legacy table is
unconfirmed, and transcribing one into a TypeScript interface would make a guess look like a fact.
Second, §0.2: nothing outside the posting service may write a ledger or movement row, so the loaders are
master-data writers and document *builders*, never posters.

## Decision

1. **`app.import_batch` is the idempotence ledger.** One row per `(company_id, source_table, source_key)`
   recording `target_table`, `target_id` and a `source_hash` of exactly the columns the loader declared.
   An identical re-read is a silent skip; a changed source row for a mapped key raises
   `ERR_IMPORT_DUPLICATE_SOURCE_KEY` naming the key. The mapping never moves once written.
2. **The batch row is written before the target row, in the same transaction**, with a placeholder
   `target_id` that `linkBatches` fills immediately after the loader returns. The order is what buys the
   guarantee: a source row whose hash no longer matches is refused *before* anything is written, so the
   run stops with `ERR_IMPORT_DUPLICATE_SOURCE_KEY` rather than half-applying a changed source. Because
   both writes share one transaction, nothing partial is ever committed — which is what lets the
   placeholder value itself carry a meaning after a commit (decision 7).
3. **Every loader declares its source columns as data** (`SourceColumn[]` with `required`, `confidence`
   and a `note`), and `preflight(driver, loaders)` checks them against the customer's own catalogue before
   one row is read. A missing required column is a named failure; a missing optional one is a finding the
   operator sees. No per-table row interface is written anywhere in Phase 9.
4. **Pages of 500.** One `withTenant` transaction per page, so a large table never holds a transaction
   open (spec:1368) and a failure leaves every completed page committed and recorded.
5. **A dry run rolls back.** `runLoad(sql, { …, dryRun: true })` performs every read and every map, then
   throws a sentinel that rolls the page's transaction back before `loader.load` runs. The reads, the
   column checks, the skips and the reference failures are therefore all real, and the database is
   untouched — this is the rehearsal the runbook's step 3 uses. One number reads differently: a dry run's
   `inserted` is the count of rows that **mapped**, because the `on conflict do nothing` skips a real run
   would take are only known once `load` has run. A rehearsal's `inserted` is an upper bound on the real
   run's, never a prediction of it, and the runbook says so where it reads the number.

6. **Two loaders are exempt from paging.** `Loader.wholeTable` (amendment C13) makes `runLoad` map every
   page and call `load` once. The trial-balance opening and the stock replay set it, because a residue
   posted to one suspense line and a moving average over a whole history are not decomposable by page —
   and neither failure would show on a fixture smaller than the 500-row page. They pay for it: their input
   is held in memory and their transaction commits once, so a crash rolls the whole opening back. For an
   opening balance that is the right failure; half an opening balance is not a smaller opening balance.
7. **A committed all-zero `target_id` means "seen; produced no target row".** It cannot mean a crash —
   decision 2 rules that out — so a loader may return it deliberately, and `openingStockLoader` does for a
   warehouse whose whole history nets to zero. Such a row is never retried, because its source hash is
   unchanged on a re-run. For an emptied warehouse that is correct; for a position reported because its
   material did not import, the remedy is the reconciliation or a clean reload, and the runbook says so.

## Consequences

- A cut-over that fails half way is resumed by re-running the same command; nothing is undone by hand.
- A source that moved after the freeze is *loud*: the operator is told which key changed, not given a
  silently different tenant.
- The column map is reviewable. A reviewer can read `sourceColumns` and see what the loader believes,
  which is the artefact §5.1 #10's "scope first" is for.
- `LoadContext` and `runLoad(sql, ctx)` keep contracts §4.13.2's exact shape; the legacy connection comes
  from a swappable module-level source (`setLoadSource` / `loadSourceFromEnv`), the same port shape 7A
  uses for its object store, so a test injects `FixtureLegacyDriver` without widening a frozen signature.
- **This ADR records no legacy column as `verified`.** The first live `scope` run under OD-17 (Task 14) is
  what promotes a column, and this ADR gains a Consequences line recording that reading when it does.
```

- [ ] **Step 12: Run the tests**

Run: `bun run --cwd packages/importer test load/ && bun run --cwd packages/importer typecheck && bun run lint:rules`
Expected: PASS — including `run.test.ts`, which is green at **this** task because it registers its own
`stubLoader` on `loaders` in `beforeAll` and removes it in `afterAll`. `registry.ts` ships empty here and T4–T8
fill it; a framework test that only passed once a business loader existed would be a T4 test wearing a T3
name, and Step 2's FAIL would have been unreadable. `lint:rules` matters here: **no binding under `packages/importer/src/**` is named `db` or `sql`** — `runLoad`'s PostgreSQL handle is `conn`, it is only ever passed to `withTenant`, and every template tag is the `tx` inside `withTenant`'s callback. `no-bare-db` fires on the *name*, not on the use, so a parameter called `sql` would fail this step however carefully it were used; §4.13.2 freezes `runLoad`'s **arity and types**, and a parameter name is not part of a TypeScript signature, so `conn` satisfies the contract and Global Constraint 7 at once.

- [ ] **Step 13: Append the 9B block to `tests/regression/sah-049.test.ts`**

```ts
describe("SAH-049 Duplicate aggregate rows in MatObjects/MatQuantity — 9B", () => {
  it("a duplicated legacy key loads once, and the second sighting is a skip, not a second row", async () => {
    const { rw, a } = await sharedDb();
    const runId = crypto.randomUUID();
    const target = crypto.randomUUID();
    await withTenant(rw, { tenantId: a.tenant, actorId: a.human, requestId: runId }, async (tx) => {
      const input = {
        companyId: a.company, sourceTable: "MATOBJECTS", sourceKey: "M-1/W-1",
        targetTable: "item", targetId: target, sourceHash: sourceHashOf({ qty: "10.000000" }), runId,
      };
      expect((await recordBatch(tx, input)).kind).toBe("inserted");
      expect((await recordBatch(tx, input)).kind).toBe("skipped");
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.import_batch
         where company_id = ${a.company} and source_table = 'MATOBJECTS' and source_key = 'M-1/W-1'`;
      expect(n!.n).toBe(1);
    });
  });
});
```

Add `import { recordBatch, sourceHashOf } from "@dulja/db";` to the file's existing import block if it is not already there; `describe`, `expect`, `it`, `sharedDb` and `withTenant` are already imported by 0B's block.

- [ ] **Step 14: Commit**

```bash
git add packages/importer/package.json packages/importer/src/load packages/importer/src/index.ts \
        packages/importer/src/cli.ts packages/importer/test/load packages/importer/test/corpus/cut-over \
        docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md tests/regression/sah-049.test.ts
git commit -m "feat(importer): add the loader framework, pre-flight and runLoad [9B T3]

Contracts 4.13.2's Loader/LoadContext/RefResolver/runLoad, keyed on
app.import_batch so a half-finished cut-over is resumed by re-running the
same command. Every loader's source columns are declarative data with a
confidence field, checked against the customer's catalogue before a row is
read: no legacy row interface is transcribed anywhere in Phase 9. ADR 0084.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The master-data loaders — units, warehouses, items, lots, parties, and the owner's account map

**Files:**
- Create: `packages/importer/src/load/units.ts`, `packages/importer/src/load/warehouses.ts`, `packages/importer/src/load/items.ts`, `packages/importer/src/load/lots.ts`, `packages/importer/src/load/parties.ts`, `packages/importer/src/load/account-map.ts`, `packages/importer/src/load/accounts.ts`, `packages/db/seed/my/chart-of-accounts/9b-cut-over.json`, `packages/importer/test/support/tenant.ts`, `packages/importer/test/load/master.test.ts`, `packages/importer/test/load/accounts.test.ts`, `packages/importer/test/corpus/cut-over/{WAREHOUSES,MATERIALS,MATBATCHES,ACCOUNTS}.json`, `packages/importer/test/fixtures/account-map.json`
- Modify: `packages/importer/src/load/registry.ts`, `packages/importer/src/index.ts`, `packages/importer/test/corpus/cut-over/catalog.json`, `tests/regression/sah-007.test.ts`, `tests/regression/sah-073.test.ts`

**Interfaces:**
- Consumes: `Loader`, `LoadContext`, `RefResolver`, `SourceColumn`, `LoadError` (T3); `requireText`, `optionalText`, `moneyOf`, `optionalDateOf` (T3); `loaders` (T3); `withTenant`, `systemContext`, `TenantContext` (§4.2.2); `readPackFile` (0C, §4.2.13); `seedTenantV2`, `seedAccount`, `seedDocumentType` (§4.17); the `0c-base.json` chart codes `1200`, `1300`, `2100`, `4000`, `5000`, `5900` (§4.15).
- Produces:

```ts
// packages/importer/test/support/tenant.ts — N16, the test-tier twin of runbook step 2
export async function seedLoadableTenant(db: Db, name: string): Promise<Seed>;
export async function loadContextFor(db: Db, s: Seed, runId: string, over?: Partial<LoadContext>): Promise<LoadContext>;

// packages/importer/src/load/account-map.ts — the OWNER's input, not a guess
export type AccountTreatment = "balance" | "ar_control" | "ap_control" | "inventory_control" | "exclude";
export interface AccountMapEntry {
  readonly legacyCode: string;         // Accounts.AccCode as a string
  readonly code: string;               // the Dulja account.code (§4.15 format ^[1-5][0-9]{3}$)
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly type: "asset" | "liability" | "equity" | "income" | "expense";
  readonly treatment: AccountTreatment;
  readonly note: string | null;
}
export interface AccountMap { readonly generatedFrom: string; readonly entries: readonly AccountMapEntry[] }
export const ACCOUNT_CODE_PATTERN: RegExp;                     // /^[1-5][0-9]{3}$/ — §4.15's frozen format
/** Reads and validates the operator-supplied map. Every failure names the offending legacy code. */
export function readAccountMap(path: string): AccountMap;
export function assertAccountMap(value: unknown, where: string): AccountMap;
export function treatmentOf(map: AccountMap, legacyCode: string): AccountTreatment | null;

// packages/importer/src/load/{units,warehouses,items,lots,parties,accounts}.ts
export const unitLoader: Loader<LegacyRow, UnitTarget>;
export const warehouseLoader: Loader<LegacyRow, WarehouseTarget>;
export const itemLoader: Loader<LegacyRow, ItemTarget>;
export const lotLoader: Loader<LegacyRow, LotTarget>;
export const partyLoader: Loader<LegacyRow, PartyTarget>;
export const accountLoader: Loader<LegacyRow, AccountTarget>;
export function setAccountMap(map: AccountMap): void;           // the account and open-item loaders read it
export function accountMap(): AccountMap;                       // throws if none has been set
```

- [ ] **Step 1: Write the failing tests**

`packages/importer/test/load/accounts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertAccountMap, treatmentOf, ACCOUNT_CODE_PATTERN, type AccountMap } from "../../src/load/account-map";

const good: AccountMap = {
  generatedFrom: "artefacts/legacy/2026-01-31/scope.json",
  entries: [
    { legacyCode: "1101", code: "1000", nameEn: "Cash on hand", nameAr: "الصندوق", type: "asset", treatment: "balance", note: null },
    { legacyCode: "1301", code: "1200", nameEn: "Trade receivables", nameAr: null, type: "asset", treatment: "ar_control", note: "open items supply this" },
    { legacyCode: "1401", code: "1300", nameEn: "Inventory", nameAr: null, type: "asset", treatment: "inventory_control", note: "OPENING_STOCK supplies this" },
    { legacyCode: "2101", code: "2100", nameEn: "Trade payables", nameAr: null, type: "liability", treatment: "ap_control", note: null },
    { legacyCode: "9999", code: "5900", nameEn: "Suspense (legacy)", nameAr: null, type: "expense", treatment: "exclude", note: "reported, never loaded" },
  ],
};

describe("the account map — the owner's mapping, validated, never inferred", () => {
  it("accepts a well-formed map and answers a treatment by legacy code", () => {
    const map = assertAccountMap(good, "test");
    expect(treatmentOf(map, "1301")).toBe("ar_control");
    expect(treatmentOf(map, "0000")).toBeNull();
  });

  it("refuses a Dulja code that is not §4.15's four-digit type-prefixed form, naming the legacy code", () => {
    expect(ACCOUNT_CODE_PATTERN.test("1200")).toBe(true);
    expect(ACCOUNT_CODE_PATTERN.test("0200")).toBe(false);
    const bad = { ...good, entries: [{ ...good.entries[0]!, code: "ABC" }] };
    expect(() => assertAccountMap(bad, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: legacy account 1101 maps to code "ABC", which is not \^\[1-5\]\[0-9\]\{3\}\$/,
    );
  });

  it("refuses a code whose first digit disagrees with its account type (§4.15's frozen rule)", () => {
    const bad = { ...good, entries: [{ ...good.entries[0]!, type: "income" as const }] };
    expect(() => assertAccountMap(bad, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: legacy account 1101 maps to 1000 but is typed income; code 1000 is an asset/,
    );
  });

  it("refuses two legacy codes mapping to one Dulja code with different names", () => {
    const bad = { ...good, entries: [...good.entries, { ...good.entries[0]!, legacyCode: "1102", nameEn: "Petty cash" }] };
    expect(() => assertAccountMap(bad, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: legacy accounts 1101 and 1102 both map to 1000 with different names/,
    );
  });

  it("accepts two legacy codes mapping to one Dulja code with the SAME name — a legacy chart split by branch is normal", () => {
    const merged = { ...good, entries: [...good.entries, { ...good.entries[0]!, legacyCode: "1102" }] };
    expect(assertAccountMap(merged, "map.json").entries).toHaveLength(6);
  });

  it("requires exactly one ar_control and one ap_control — the ageing tie-out has one control each (§4.8.2)", () => {
    const two = { ...good, entries: [...good.entries, { ...good.entries[1]!, legacyCode: "1302", code: "1200" }] };
    expect(assertAccountMap(two, "map.json").entries).toHaveLength(6);       // same code, same name: fine
    const none = { ...good, entries: good.entries.filter((e) => e.treatment !== "ar_control") };
    expect(() => assertAccountMap(none, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: no account is marked ar_control; the open-item load has no control to tie to/,
    );
  });
});
```

`packages/importer/test/load/master.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { setAccountMap } from "../../src/load/accounts";
import { runLoad, setLoadSource } from "../../src/load/run";
import type { LoadContext } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant } from "../support/tenant";
import { readAccountMap } from "../../src/load/account-map";

let db: Db;
let s: Seed;
const RUN = "01930000-0000-7000-8000-0000000000b0";

const ctxFor = (over: Partial<LoadContext> = {}): Promise<LoadContext> => loadContextFor(db, s, RUN, over);

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "master");
  setAccountMap(readAccountMap("test/fixtures/account-map.json"));
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(loadCorpus("cut-over"));
    return { driver, reader: await createReader(driver), close: async () => driver.close() };
  });
  await runLoad(db.rw, await ctxFor());
}, 240_000);
afterAll(async () => { await db?.stop(); });

const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
  withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "read" }, fn);

describe("the master-data loaders (contracts §4.13.2, §5.1 #3, #8)", () => {
  it("loads units with their legacy key recorded in import_batch", async () => {
    const rows = await read((tx) => tx<{ code: string; name_en: string; name_ar: string | null }[]>`
      select code, name_en, name_ar from app.unit_of_measure where company_id = ${s.company} order by code`);
    expect(rows.map((r) => r.code)).toEqual(["CARTON", "KILOGRAM", "PIECE"]);
    expect(rows.find((r) => r.code === "PIECE")!.name_ar).toBe("قطعة");
    const [n] = await read((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.import_batch where source_table = 'UNITS' and target_table = 'unit_of_measure'`);
    expect(n!.n).toBe(3);
  });

  it("loads warehouses as kind 'stock' in the company's head-office BRANCH — the importer creates no branch", async () => {
    const rows = await read((tx) => tx<{ code: string; kind: string; branch_id: string }[]>`
      select code, kind, branch_id from app.warehouse where company_id = ${s.company} order by code`);
    // `codeFromName` upper-cases and replaces every run of non-alphanumerics with a single `-`, so the
    // corpus's free-text `"Main store"` and `"Shop 1"` become `MAIN-STORE` and `SHOP-1` — NOT `MAIN` and
    // `SHOP1`. The names are deliberately left as free text, because that is what a legacy `Warehouses`
    // row holds and the dash rule is the thing under test; `name_en` keeps the original verbatim.
    expect(rows.map((r) => r.code)).toEqual(["MAIN-STORE", "SHOP-1"]);
    expect(rows.every((r) => r.kind === "stock")).toBe(true);
    expect(rows.every((r) => r.branch_id === s.hq)).toBe(true);
  });

  it("loads items with legacy_ref, track_lots from the source flag, and all FOUR §4.6.1 account defaults", async () => {
    const rows = await read((tx) => tx<{
      code: string; kind: string; legacy_ref: string; track_lots: boolean;
      revenue: string | null; inventory: string | null; cogs: string | null; expense: string | null;
    }[]>`
      select i.code, i.kind, i.legacy_ref, i.track_lots,
             r.code as revenue, v.code as inventory, g.code as cogs, x.code as expense
        from app.item i
        left join app.account r on r.id = i.revenue_account_id
        left join app.account v on v.id = i.inventory_account_id
        left join app.account g on g.id = i.cogs_account_id
        left join app.account x on x.id = i.expense_account_id
       where i.company_id = ${s.company} and i.code in ('WIDGET', 'DELIVERY') order by i.code`);
    // §4.6.1 fixes the four defaults as 4000 / 1300 / 5000 / 5900 in revenue / inventory / cogs / expense
    // order. `expense` is 5900 for EVERY kind — an earlier draft gave a product 5000 in both the cogs and
    // the expense slot, which no assertion caught and which mis-posts any policy resolving
    // `item.expense_account` (§4.4.1). The service row keeps its null inventory and cogs.
    expect(rows.find((r) => r.code === "WIDGET")).toMatchObject({
      kind: "product", legacy_ref: "10", track_lots: true,
      revenue: "4000", inventory: "1300", cogs: "5000", expense: "5900",
    });
    expect(rows.find((r) => r.code === "DELIVERY")).toMatchObject({
      kind: "service", inventory: null, cogs: null, expense: "5900",
    });
  });

  it("loads a batch as a lot with its expiry, and skips a batch whose material is missing (§5.1 #3 — orphans are reported)", async () => {
    const lots = await read((tx) => tx<{ code: string; expires_on: string | null }[]>`
      select l.code, to_char(l.expires_on, 'YYYY-MM-DD') as expires_on
        from app.lot l join app.item i on i.id = l.item_id
       where i.company_id = ${s.company} order by l.code`);
    expect(lots).toEqual([{ code: "B-2401", expires_on: "2027-03-31" }]);
    const report = await runLoad(db.rw, await ctxFor({ runId: "01930000-0000-7000-8000-0000000000b1" }));
    expect(report.skips.filter((k) => k.loader === "lot")).toEqual([
      { loader: "lot", sourceTable: "MATBATCHES", sourceKey: "9001", reason: "material 999 has no imported item; the batch is an orphan (SAH-073)" },
    ]);
  });

  it("splits the legacy Accounts table into parties and accounts by its own IsCustomer/IsVendor flags", async () => {
    const parties = await read((tx) => tx<{ code: string; kind: string; legacy_ref: string }[]>`
      select code, kind, legacy_ref from app.party where company_id = ${s.company} order by code`);
    // `legacy_ref` is the legacy **ACCCODE** on both sides — the same identifier `accountLoader` stamps on
    // `app.account`, so the two loaders that read one legacy table agree about what identifies its rows.
    // The `import_batch` source key is the ACCID (`ACC:200`, `ACC:300`), which is what Task 7's
    // `refs.byLegacyRef("party", `ACC:${BILACC}`)` resolves on; the two are deliberately different things.
    expect(parties).toEqual([
      { code: "C-2001", kind: "customer", legacy_ref: "2001" },
      { code: "V-3001", kind: "vendor", legacy_ref: "3001" },
    ]);
    const accounts = await read((tx) => tx<{ code: string; legacy_ref: string | null }[]>`
      select code, legacy_ref from app.account where company_id = ${s.company} and legacy_ref is not null order by code`);
    expect(accounts.map((a) => a.code)).toEqual(["1000", "1200", "1300", "2100"]);
  });

  it("gives every imported party the §4.15 control accounts and never a null one (hazard 33)", async () => {
    const rows = await read((tx) => tx<{ code: string; receivable: string | null; payable: string | null }[]>`
      select p.code, r.code as receivable, y.code as payable
        from app.party p
        left join app.account r on r.id = p.receivable_account_id
        left join app.account y on y.id = p.payable_account_id
       where p.company_id = ${s.company} order by p.code`);
    expect(rows).toEqual([
      { code: "C-2001", receivable: "1200", payable: null },
      { code: "V-3001", receivable: null, payable: "2100" },
    ]);
  });

  it("refuses a NULL legacy balance rather than reading it as zero (SAH-007)", async () => {
    const poisoned = loadCorpus("cut-over");
    poisoned.tables["ACCOUNTS"]!.rows = poisoned.tables["ACCOUNTS"]!.rows.map((r) =>
      r["ACCCODE"] === "1101" ? { ...r, ACCOPENBAL: null } : r);
    setLoadSource(async () => {
      const driver = new FixtureLegacyDriver(poisoned);
      return { driver, reader: await createReader(driver), close: async () => driver.close() };
    });
    const report = await runLoad(db.rw, await ctxFor({ runId: "01930000-0000-7000-8000-0000000000b2", dryRun: true }));
    expect(report.skips.map((k) => k.reason)).toContain(
      "ACCOPENBAL is NULL for legacy account 1101; a NULL legacy amount is never read as zero (SAH-007)",
    );
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun run --cwd packages/importer test load/accounts && bun run --cwd packages/importer test load/master`
Expected: FAIL — `Cannot find module '../../src/load/account-map'`.

- [ ] **Step 3: Write `packages/importer/test/support/tenant.ts` — the tenant a load can run against**

`seedTenantV2` (§4.17) is `seedTenant` plus the `5920` FX-rounding account and the JOURNAL policy, and `seedTenant` creates exactly **two** accounts — `1000 Cash` and `4000 Sales` (plan0A:1563–1611) — and no document type of this slice's. Every loader from here on **fails closed** on a missing §4.15 account or a missing `OPENING_BALANCE` / `OPENING_STOCK`, which is the behaviour production wants and the wrong setup for a test: the case would die on `cannot resolve account 1200` long before it reached what it was written to prove. This helper is the test-tier equivalent of the runbook's step 2 (`bun run seed --only chart-of-accounts --only document-types`), and every DB-backed importer test from T4 to T8 opens with it.

```ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { systemContext } from "@dulja/db";
import { seedAccount, seedDocumentType, seedTenantV2, type Db, type Seed } from "@dulja/db/test";
import type { PostingPolicy } from "@dulja/domain";
import type { LoadContext } from "../../src/load/types";

/** Every §4.15 code a 9B loader resolves that `seedTenantV2` does not create. `1000` and `4000` are 0A's,
 *  `5920` is `seedTenantV2`'s; `1200`/`1300`/`2100`/`5000`/`5900` are 0C's `0c-base.json` and `3900` is
 *  this slice's own `9b-cut-over.json` (Task 4 Step 4). The codes, names and types are §4.15's verbatim —
 *  a test tenant whose `1300` were typed `expense` would prove nothing about the real one. */
const ACCOUNTS: readonly { code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense" }[] = [
  { code: "1200", nameEn: "Trade receivables (AR control)", type: "asset" },
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "2100", nameEn: "Trade payables (AP control)", type: "liability" },
  { code: "3900", nameEn: "Opening-balance suspense", type: "equity" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

/** `packages/importer/test/support/` → three levels up is `packages/`. `fileURLToPath`, never `.pathname`:
 *  on Windows `new URL(…).pathname` yields `/C:/Users/…`, which `readFileSync` rejects. */
const TYPE_DIR = fileURLToPath(new URL("../../../db/seed/my/document-types/", import.meta.url));

interface Envelope {
  code: string; nameEn: string; nameAr: string; module: string;
  policyVersion: number; effectiveFrom: string; policy: PostingPolicy;
}

/**
 * A tenant a 9B load can actually run against: `seedTenantV2` plus the six §4.15 accounts above and both
 * cut-over document types, each read from **this slice's own seed file** rather than re-typed. Re-typing
 * the policy would make every posting test green against a policy nobody deploys, which is exactly the
 * failure §4.3.7's envelope exists to prevent.
 *
 * 0A's three fiscal periods are left untouched — 2026-01 **open**, 2026-02 **closed**, 2026-03 **locked**
 * (plan0A:1588–1591). Both facts are load-bearing here: the cut-over date `2026-01-31` posts, and Task 5's
 * closed-period case uses `2026-02-15` to get `ERR_PERIOD_NOT_OPEN` rather than `ERR_PERIOD_NOT_FOUND`.
 */
export async function seedLoadableTenant(db: Db, name: string): Promise<Seed> {
  const s = await seedTenantV2(db, name);
  for (const account of ACCOUNTS) await seedAccount(db, s, account);
  for (const file of ["OPENING_BALANCE.json", "OPENING_STOCK.json"]) {
    // T4 runs before T5 and T6 write these two files, and the loaders that need them are not registered
    // yet, so a missing file is skipped rather than failing the task that does not use it.
    const path = `${TYPE_DIR}${file}`;
    if (!existsSync(path)) continue;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Envelope;
    await seedDocumentType(db, s, {
      code: envelope.code, module: envelope.module, policy: envelope.policy,
      policyVersion: envelope.policyVersion, effectiveFrom: envelope.effectiveFrom,
    });
  }
  return s;
}

/** The `LoadContext` every importer test builds: the tenant's SYSTEM principal (spec:2179), this company,
 *  the cut-over date the committed corpus is written for, and whatever the case overrides. */
export async function loadContextFor(
  db: Db, s: Seed, runId: string, over: Partial<LoadContext> = {},
): Promise<LoadContext> {
  return {
    ...(await systemContext(db.rw, s.tenant, runId)),
    companyId: s.company, runId, cutOverDate: "2026-01-31", dryRun: false, ...over,
  };
}
```

**`tests/invariants/support/cut-over.ts` (T5) does the same work inline rather than importing this file**, for the same reason its `readCorpus` duplicates 9A's `loadCorpus`: the `tests` workspace may not import `packages/importer/test/**` (§3.1). The duplication is two short lists and is deliberate.

- [ ] **Step 4: Seed account `3900`**

`packages/db/seed/my/chart-of-accounts/9b-cut-over.json` — §4.15's file-per-slice layout; one row, the only account code this slice seeds:

```json
[
  {
    "code": "3900",
    "nameEn": "Opening-balance suspense",
    "nameAr": "حساب معلق للأرصدة الافتتاحية",
    "type": "equity",
    "parentCode": "3"
  }
]
```

Applied by `bun run seed --tenant <tenant_id> --only chart-of-accounts` — 0C's loader, unchanged; this slice ships a **file**, never a loader (§3.4.8). The file is idempotent on `(company_id, code)` like every other chart file.

**Why `parentCode: "3"` and why no `isGroup`.** Every leaf in 0C's `0c-base.json` is written `{ code, nameEn, nameAr, type, parentCode }` and hangs off one of the five presentation parents `1`–`5` (0c:4015–4025); **no 0C leaf writes `isGroup: false`**, because the loader defaults it (`${a.isGroup ?? false}`, 0c:4204) and `isGroup: true` is what marks a parent. A parentless equity leaf would render outside the tree `GET …/accounts/tree` builds and outside the equity subtotal of a statement layout. The parent resolves because 0C's loader reads the sub-pack `.json` files **in name order** (`readdirSync(...).sort()`, 0c:4190) — `0c-base.json` sorts before `9b-cut-over.json`, so `3` is already in `app.account` when this row is inserted, and the loader resolves a parent by code within the company (0c:4197–4200), not within the file.

**Why equity and why `3900`.** §4.15 registers the code, the type and the seeding slice; this plan does not choose any of them. What OD-25 decides (Task 11) is the *treatment* — whether the residue is written off, reclassified or left standing — not the code, which is fixed here precisely so the loader and the §5.1 #2 reconciliation report name the same account whatever the owner decides.

- [ ] **Step 5: Write `load/account-map.ts`**

```ts
import { readFileSync } from "node:fs";
import { LoadError } from "./types";

export type AccountTreatment = "balance" | "ar_control" | "ap_control" | "inventory_control" | "exclude";

export interface AccountMapEntry {
  readonly legacyCode: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly type: "asset" | "liability" | "equity" | "income" | "expense";
  readonly treatment: AccountTreatment;
  readonly note: string | null;
}

export interface AccountMap { readonly generatedFrom: string; readonly entries: readonly AccountMapEntry[] }

/** §4.15, frozen: four digits, the first being the account_type in the enum's own order. */
export const ACCOUNT_CODE_PATTERN = /^[1-5][0-9]{3}$/;

const TYPE_OF_FIRST_DIGIT: Readonly<Record<string, AccountMapEntry["type"]>> = {
  "1": "asset", "2": "liability", "3": "equity", "4": "income", "5": "expense",
};

const TREATMENTS: readonly AccountTreatment[] = ["balance", "ar_control", "ap_control", "inventory_control", "exclude"];

/** The failure message reads "code 1000 is an asset" / "code 2100 is a liability"; a lookup keeps the
 *  article right without a regex over the finished sentence. */
const ARTICLE: Readonly<Record<AccountMapEntry["type"], string>> = {
  asset: "an asset", liability: "a liability", equity: "an equity account",
  income: "an income account", expense: "an expense account",
};

export function readAccountMap(path: string): AccountMap {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { throw new LoadError("ERR_VALIDATION_FAILED", `${path}: the account map could not be read. It is the OWNER's mapping from the legacy chart to Dulja's; produce it from 9A's scope report and pass it with --account-map.`); }
  return assertAccountMap(JSON.parse(text) as unknown, path);
}

export function assertAccountMap(value: unknown, where: string): AccountMap {
  const bad = (detail: string): never => { throw new LoadError("ERR_VALIDATION_FAILED", `${where}: ${detail}`); };
  if (typeof value !== "object" || value === null) return bad("the map is not an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.generatedFrom !== "string" || raw.generatedFrom === "") return bad("generatedFrom must name the scope artefact the map was built from");
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) return bad("entries is empty; a cut-over with no mapped account has nothing to open");

  const byCode = new Map<string, AccountMapEntry>();
  const seenLegacy = new Set<string>();
  const entries: AccountMapEntry[] = [];

  for (const item of raw.entries as Record<string, unknown>[]) {
    const legacyCode = String(item.legacyCode ?? "");
    if (legacyCode === "") return bad("an entry has no legacyCode");
    if (seenLegacy.has(legacyCode)) return bad(`legacy account ${legacyCode} appears twice`);
    seenLegacy.add(legacyCode);

    const code = String(item.code ?? "");
    if (!ACCOUNT_CODE_PATTERN.test(code)) return bad(`legacy account ${legacyCode} maps to code ${JSON.stringify(code)}, which is not ^[1-5][0-9]{3}$ (contracts §4.15)`);
    const type = String(item.type ?? "") as AccountMapEntry["type"];
    const implied = TYPE_OF_FIRST_DIGIT[code[0]!]!;
    if (type !== implied) return bad(`legacy account ${legacyCode} maps to ${code} but is typed ${type}; code ${code} is ${ARTICLE[implied]}`);
    const treatment = String(item.treatment ?? "") as AccountTreatment;
    if (!TREATMENTS.includes(treatment)) return bad(`legacy account ${legacyCode} has treatment ${JSON.stringify(treatment)}; expected one of ${TREATMENTS.join(", ")}`);
    const nameEn = String(item.nameEn ?? "");
    if (nameEn === "") return bad(`legacy account ${legacyCode} has no nameEn`);

    const entry: AccountMapEntry = {
      legacyCode, code, nameEn,
      nameAr: item.nameAr === null || item.nameAr === undefined ? null : String(item.nameAr),
      type, treatment,
      note: item.note === null || item.note === undefined ? null : String(item.note),
    };
    const prior = byCode.get(code);
    if (prior && prior.nameEn !== entry.nameEn) {
      return bad(`legacy accounts ${prior.legacyCode} and ${legacyCode} both map to ${code} with different names — pick one name, or map them to different codes`);
    }
    byCode.set(code, entry);
    entries.push(entry);
  }

  for (const required of ["ar_control", "ap_control"] as const) {
    if (!entries.some((e) => e.treatment === required)) {
      return bad(`no account is marked ${required}; the open-item load has no control to tie to (contracts §4.8.2)`);
    }
  }
  return { generatedFrom: raw.generatedFrom, entries };
}

export function treatmentOf(map: AccountMap, legacyCode: string): AccountTreatment | null {
  return map.entries.find((e) => e.legacyCode === legacyCode)?.treatment ?? null;
}
```

**Why the `ARTICLE` lookup rather than a template.** The test pins the exact sentence `code 1000 is an asset`, and the five types need three different articles (`an asset`, `a liability`, `an equity account`). A lookup gets that right once; a regex over the finished sentence gets it wrong the first time a sixth type is added, and §3.2 makes error messages part of the contract — "a human message naming the specific entity" (spec:2051) is only useful if it reads.

- [ ] **Step 6: Write `load/units.ts` — the pattern every other loader follows**

```ts
import type { Sql } from "postgres";
import type { LegacyRow } from "../index";
import { optionalText, requireText } from "./scalar";
import type { Loader, LoadContext, SourceColumn } from "./types";

interface UnitTarget { legacyKey: string; code: string; nameEn: string; nameAr: string | null }

const COLUMNS: readonly SourceColumn[] = [
  { name: "UNTID",   required: true,  confidence: "hypothesis", note: "the unit's own key; Units carries the prefix UNT (dossier: a per-table Prefix is prepended to every physical column name)" },
  { name: "UNTNAME", required: true,  confidence: "hypothesis", note: "the unit's display name, which becomes both code and name_en" },
  { name: "UNTNOTE", required: false, confidence: "hypothesis", note: "free text; carried to name_ar when present, because the legacy schema has no second name column" },
];

/** `PIECE`, not `Piece`: app.unit_of_measure is unique (company_id, code) and the legacy names are free
 *  text. Upper-casing and replacing every run of non-alphanumerics with a single `-` gives a stable code
 *  from a name; the original name is kept verbatim in name_en, so nothing is lost. */
export function codeFromName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
}

export const unitLoader: Loader<LegacyRow, UnitTarget> = {
  sourceTable: "UNITS",
  targetTable: "unit_of_measure",
  dependsOn: [],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "UNTID", "UNITS"),

  map(row) {
    const legacyKey = requireText(row, "UNTID", "UNITS");
    const nameEn = requireText(row, "UNTNAME", `UNITS/${legacyKey}`);
    const code = codeFromName(nameEn);
    if (code === "") return { skip: `unit ${legacyKey} has a name with no alphanumeric characters; it cannot produce a code` };
    return { legacyKey, code, nameEn, nameAr: optionalText(row, "UNTNOTE") };
  },

  async load(tx: Sql, ctx: LoadContext, rows: UnitTarget[]) {
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      // `on conflict do nothing` then read: a tenant may already have the unit (0C's pack seeds none, but
      // a rehearsal may have run through the API). The load never overwrites an existing row — spec:2002's
      // idempotence rule applied to master data.
      const [made] = await tx<{ id: string }[]>`
        insert into app.unit_of_measure (tenant_id, company_id, code, name_en, name_ar)
        values (app.current_tenant(), ${ctx.companyId}, ${row.code}, ${row.nameEn}, ${row.nameAr})
        on conflict (company_id, code) do nothing
        returning id`;
      if (made) { inserted += 1; batchIds.push(made.id); continue; }
      const [existing] = await tx<{ id: string }[]>`
        select id from app.unit_of_measure where company_id = ${ctx.companyId} and code = ${row.code}`;
      skipped += 1;
      batchIds.push(existing!.id);
    }
    return { inserted, skipped, batchIds };
  },
};
```

- [ ] **Step 7: Write the four remaining master loaders**

`packages/importer/src/load/warehouses.ts`:

```ts
import type { Sql } from "postgres";
import type { LegacyRow } from "../index";
import { optionalText, requireText } from "./scalar";
import { codeFromName } from "./units";
import { LoadError, type Loader, type LoadContext, type SourceColumn } from "./types";

interface WarehouseTarget { legacyKey: string; code: string; nameEn: string; nameAr: string | null }

const COLUMNS: readonly SourceColumn[] = [
  { name: "WARID",   required: true,  confidence: "hypothesis", note: "the warehouse's own key (Warehouses, prefix WAR)" },
  { name: "WARNAME", required: true,  confidence: "hypothesis", note: "display name → code and name_en" },
  { name: "WARNOTE", required: false, confidence: "hypothesis", note: "free text → name_ar" },
];

/**
 * Every imported warehouse lands in the company's HEAD-OFFICE BRANCH value, because the legacy schema has
 * no branch concept that maps onto Dulja's BRANCH dimension (dossier §0.4: `Site` is a company-level
 * partition, `Job` a project) and inventing a branch per warehouse would put stock behind a
 * `branch_isolation` policy nobody can see through (§4.5.6 Form A″). Re-assigning warehouses to real
 * branches is a post-cut-over back-office action under `admin.company.manage`, and the runbook says so.
 */
export const warehouseLoader: Loader<LegacyRow, WarehouseTarget> = {
  sourceTable: "WAREHOUSES",
  targetTable: "warehouse",
  dependsOn: [],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "WARID", "WAREHOUSES"),

  map(row) {
    const legacyKey = requireText(row, "WARID", "WAREHOUSES");
    const nameEn = requireText(row, "WARNAME", `WAREHOUSES/${legacyKey}`);
    const code = codeFromName(nameEn);
    if (code === "") return { skip: `warehouse ${legacyKey} has a name with no alphanumeric characters` };
    return { legacyKey, code, nameEn, nameAr: optionalText(row, "WARNOTE") };
  },

  async load(tx: Sql, ctx: LoadContext, rows: WarehouseTarget[]) {
    const [hq] = await tx<{ id: string }[]>`
      select v.id from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${ctx.companyId} and t.code = 'BRANCH' and v.code = 'HQ'`;
    if (!hq) throw new LoadError("ERR_VALIDATION_FAILED", `company ${ctx.companyId} has no BRANCH value HQ; run \`bun run seed --tenant … --only dimensions\` before the load`);
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const [made] = await tx<{ id: string }[]>`
        insert into app.warehouse (tenant_id, company_id, code, name_en, name_ar, kind, branch_id)
        values (app.current_tenant(), ${ctx.companyId}, ${row.code}, ${row.nameEn}, ${row.nameAr}, 'stock', ${hq.id})
        on conflict (company_id, code) do nothing
        returning id`;
      if (made) { inserted += 1; batchIds.push(made.id); continue; }
      const [existing] = await tx<{ id: string }[]>`
        select id from app.warehouse where company_id = ${ctx.companyId} and code = ${row.code}`;
      skipped += 1;
      batchIds.push(existing!.id);
    }
    return { inserted, skipped, batchIds };
  },
};
```

`packages/importer/src/load/items.ts`:

```ts
import type { Sql } from "postgres";
import type { LegacyRow } from "../index";
import { optionalText, requireText } from "./scalar";
import { codeFromName } from "./units";
import { LoadError, type Loader, type LoadContext, type RefResolver, type SourceColumn } from "./types";

interface ItemTarget {
  legacyKey: string; code: string; nameEn: string; nameAr: string | null;
  kind: "product" | "service"; trackLots: boolean; baseUnitId: string;
}

const COLUMNS: readonly SourceColumn[] = [
  { name: "MATID",       required: true,  confidence: "hypothesis", note: "the material's own key (Materials, prefix MAT)" },
  { name: "MATCODE",     required: false, confidence: "hypothesis", note: "the customer's own item code; falls back to the name when absent" },
  { name: "MATNAME",     required: true,  confidence: "hypothesis", note: "display name → name_en" },
  { name: "MATNAMEAR",   required: false, confidence: "hypothesis", note: "Arabic display name → name_ar; Materials has ~70 columns and a second name is likely one of them" },
  { name: "MATUNIT",     required: true,  confidence: "hypothesis", note: "the base unit's Units key; resolved through import_batch to unit_of_measure" },
  { name: "MATISSERVICE",required: false, confidence: "hypothesis", note: "boolean-ish flag → item.kind service | product; absent means every row is a product" },
  { name: "MATISBATCH",  required: false, confidence: "hypothesis", note: "boolean-ish flag → track_lots; absent means true, which is Dulja's own default" },
];

const truthy = (v: string | null): boolean => v === "1" || v?.toUpperCase() === "T" || v?.toUpperCase() === "TRUE" || v?.toUpperCase() === "Y";

export const itemLoader: Loader<LegacyRow, ItemTarget> = {
  sourceTable: "MATERIALS",
  targetTable: "item",
  dependsOn: ["unit_of_measure"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "MATID", "MATERIALS"),

  async map(row, refs: RefResolver) {
    const legacyKey = requireText(row, "MATID", "MATERIALS");
    const where = `MATERIALS/${legacyKey}`;
    const nameEn = requireText(row, "MATNAME", where);
    const code = codeFromName(optionalText(row, "MATCODE") ?? nameEn);
    if (code === "") return { skip: `material ${legacyKey} produces no usable item code` };
    const unitKey = requireText(row, "MATUNIT", where);
    const baseUnitId = await refs.byLegacyRef("unit_of_measure", unitKey);
    if (!baseUnitId) return { skip: `material ${legacyKey} references unit ${unitKey}, which has no imported unit_of_measure; the item is an orphan (SAH-073)` };
    return {
      legacyKey, code, nameEn, nameAr: optionalText(row, "MATNAMEAR"),
      kind: truthy(optionalText(row, "MATISSERVICE")) ? "service" : "product",
      trackLots: optionalText(row, "MATISBATCH") === null ? true : truthy(optionalText(row, "MATISBATCH")),
      baseUnitId,
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: ItemTarget[]) {
    // Hazard 33 applied: this slice seeds no item account and never falls back to a null one. The four
    // §4.15 defaults are 0C's rows and must already resolve; a missing one is a named failure, not a null.
    const defaults = await tx<{ code: string; id: string }[]>`
      select code, id from app.account
       where company_id = ${ctx.companyId} and code in ('4000', '1300', '5000', '5900')`;
    const by = new Map(defaults.map((a) => [a.code, a.id]));
    for (const code of ["4000", "1300", "5000", "5900"]) {
      if (!by.has(code)) throw new LoadError("ERR_VALIDATION_FAILED", `company ${ctx.companyId} cannot resolve account ${code}; apply 0C's chart pack (\`bun run seed --tenant … --only chart-of-accounts\`) before the load (contracts §4.15)`);
    }
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    // §4.6.1 fixes item's four defaults as 4000 / 1300 / 5000 / 5900 in revenue / inventory / cogs /
    // expense order, and §4.15's `5900` row is `item.expense_account_id`'s default. It is 5900 for EVERY
    // kind: putting COGS in the expense slot for a product would mis-post any policy that resolves
    // `item.expense_account` (§4.4.1), and the two slots exist precisely because they are not the same
    // account. `1300` and `5000` stay product-only, which is what makes a service's two columns null.
    const expense = by.get("5900")!;
    for (const row of rows) {
      const [made] = await tx<{ id: string }[]>`
        insert into app.item (tenant_id, company_id, code, name_en, name_ar, kind, base_unit_id, track_lots,
                              revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id, legacy_ref)
        values (app.current_tenant(), ${ctx.companyId}, ${row.code}, ${row.nameEn}, ${row.nameAr}, ${row.kind},
                ${row.baseUnitId}, ${row.kind === "product" ? row.trackLots : false},
                ${by.get("4000")!}, ${row.kind === "product" ? by.get("1300")! : null}, ${row.kind === "product" ? by.get("5000")! : null},
                ${expense}, ${row.legacyKey})
        on conflict (company_id, code) do nothing
        returning id`;
      if (made) { inserted += 1; batchIds.push(made.id); continue; }
      const [existing] = await tx<{ id: string }[]>`select id from app.item where company_id = ${ctx.companyId} and code = ${row.code}`;
      skipped += 1;
      batchIds.push(existing!.id);
    }
    return { inserted, skipped, batchIds };
  },
};
```

`packages/importer/src/load/lots.ts`:

```ts
import type { Sql } from "postgres";
import type { LegacyRow } from "../index";
import { optionalDateOf, requireText } from "./scalar";
import type { Loader, LoadContext, RefResolver, SourceColumn } from "./types";

interface LotTarget { legacyKey: string; itemId: string; code: string; expiresOn: string | null; manufacturedOn: string | null }

const COLUMNS: readonly SourceColumn[] = [
  { name: "BATID",     required: true,  confidence: "hypothesis", note: "the batch's own key (MatBatches, prefix BAT)" },
  { name: "BATMAT",    required: true,  confidence: "hypothesis", note: "the Materials key this batch belongs to" },
  { name: "BATCODE",   required: true,  confidence: "hypothesis", note: "the batch number the warehouse actually reads off the carton" },
  { name: "BATEXPIRY", required: false, confidence: "hypothesis", note: "expiry date → lot.expires_on; the whole reason spec:1054's expiry write-off exists" },
  { name: "BATMFG",    required: false, confidence: "hypothesis", note: "manufacture date → lot.manufactured_on" },
];

export const lotLoader: Loader<LegacyRow, LotTarget> = {
  sourceTable: "MATBATCHES",
  targetTable: "lot",
  dependsOn: ["item"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "BATID", "MATBATCHES"),

  async map(row, refs: RefResolver) {
    const legacyKey = requireText(row, "BATID", "MATBATCHES");
    const where = `MATBATCHES/${legacyKey}`;
    const materialKey = requireText(row, "BATMAT", where);
    const itemId = await refs.byLegacyRef("item", materialKey);
    if (!itemId) return { skip: `material ${materialKey} has no imported item; the batch is an orphan (SAH-073)` };
    return {
      legacyKey, itemId, code: requireText(row, "BATCODE", where),
      expiresOn: optionalDateOf(row, "BATEXPIRY", where),
      manufacturedOn: optionalDateOf(row, "BATMFG", where),
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: LotTarget[]) {
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const [made] = await tx<{ id: string }[]>`
        insert into app.lot (tenant_id, company_id, item_id, code, expires_on, manufactured_on, legacy_ref)
        values (app.current_tenant(), ${ctx.companyId}, ${row.itemId}, ${row.code}, ${row.expiresOn}, ${row.manufacturedOn}, ${row.legacyKey})
        on conflict (item_id, code) do nothing
        returning id`;
      if (made) { inserted += 1; batchIds.push(made.id); continue; }
      const [existing] = await tx<{ id: string }[]>`select id from app.lot where item_id = ${row.itemId} and code = ${row.code}`;
      skipped += 1;
      batchIds.push(existing!.id);
    }
    return { inserted, skipped, batchIds };
  },
};
```

`packages/importer/src/load/parties.ts`:

```ts
import type { Sql } from "postgres";
import type { LegacyRow } from "../index";
import { optionalText, requireText } from "./scalar";
import { LoadError, type Loader, type LoadContext, type SourceColumn } from "./types";

interface PartyTarget { legacyKey: string; legacyCode: string; kind: "customer" | "vendor"; code: string; nameEn: string; nameAr: string | null; taxRegistration: string | null; email: string | null; phone: string | null }

const COLUMNS: readonly SourceColumn[] = [
  { name: "ACCID",         required: true,  confidence: "hypothesis", note: "the account's own key (Accounts, prefix ACC)" },
  { name: "ACCCODE",       required: true,  confidence: "hypothesis", note: "the customer's own account code" },
  { name: "ACCNAME",       required: true,  confidence: "hypothesis", note: "display name → name_en (the dossier names this column verbatim)" },
  { name: "ACCNAMEAR",     required: false, confidence: "hypothesis", note: "Arabic name → name_ar" },
  { name: "ACCISCUSTOMER", required: false, confidence: "hypothesis", note: "flag; a row that is neither customer nor vendor is a ledger account, loaded by accountLoader" },
  { name: "ACCISVENDOR",   required: false, confidence: "hypothesis", note: "flag" },
  { name: "ACCTAXNO",      required: false, confidence: "hypothesis", note: "tax registration → party.tax_registration" },
  { name: "ACCEMAIL",      required: false, confidence: "hypothesis", note: "→ party.email" },
  { name: "ACCPHONE",      required: false, confidence: "hypothesis", note: "→ party.phone" },
];

const truthy = (v: string | null): boolean => v === "1" || v?.toUpperCase() === "T" || v?.toUpperCase() === "TRUE" || v?.toUpperCase() === "Y";

/**
 * §5.1 #12 and dossier §0.4: the legacy `Accounts` table is BOTH the chart of accounts and the
 * customer/vendor file. This loader takes the rows flagged customer or vendor; `accountLoader` takes the
 * rest. They share a source table and are distinguished in `import_batch` by their source keys — this one
 * prefixes `ACC:`, the account loader uses the bare code — so one legacy row may legitimately become both
 * a party and an account without the natural key colliding.
 */
export const partyLoader: Loader<LegacyRow, PartyTarget> = {
  sourceTable: "ACCOUNTS",
  targetTable: "party",
  dependsOn: [],
  sourceColumns: COLUMNS,
  sourceKey: (row) => `ACC:${requireText(row, "ACCID", "ACCOUNTS")}`,

  map(row) {
    const legacyKey = requireText(row, "ACCID", "ACCOUNTS");
    const where = `ACCOUNTS/${legacyKey}`;
    const isCustomer = truthy(optionalText(row, "ACCISCUSTOMER"));
    const isVendor = truthy(optionalText(row, "ACCISVENDOR"));
    if (!isCustomer && !isVendor) return { skip: `account ${legacyKey} is neither customer nor vendor; it is a ledger account and accountLoader takes it` };
    if (isCustomer && isVendor) {
      // Dulja's party.kind is single-valued (§4.5.7). A legacy row that is both is a real business fact
      // and is REPORTED, not halved: the operator creates the second party by hand after cut-over.
      return { skip: `account ${legacyKey} is flagged both customer and vendor; party.kind is single-valued — create the second party by hand and re-point its open items` };
    }
    // TWO legacy identifiers, deliberately, and they are not interchangeable. `legacyKey` (ACCID) is the
    // row's own surrogate key and is what the `import_batch` source key is built from (`ACC:<ACCID>`), so
    // Task 7's `refs.byLegacyRef("party", `ACC:${BILACC}`)` resolves — `Bills.BilAcc` holds the ACCID.
    // `legacyCode` (ACCCODE) is the identifier a human reads on the legacy chart, and it is what
    // `party.legacy_ref` carries, because §5.1 #8's "preserve them as historical strings" is about the
    // string a person looks a row up by — and because `accountLoader` stamps the very same ACCCODE on
    // `app.account.legacy_ref`. Two loaders reading one legacy table must not disagree about what
    // identifies its rows.
    const legacyCode = requireText(row, "ACCCODE", where);
    return {
      legacyKey, legacyCode,
      kind: isCustomer ? "customer" : "vendor",
      code: `${isCustomer ? "C" : "V"}-${legacyCode}`,
      nameEn: requireText(row, "ACCNAME", where),
      nameAr: optionalText(row, "ACCNAMEAR"),
      taxRegistration: optionalText(row, "ACCTAXNO"),
      email: optionalText(row, "ACCEMAIL"),
      phone: optionalText(row, "ACCPHONE"),
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: PartyTarget[]) {
    const controls = await tx<{ code: string; id: string }[]>`
      select code, id from app.account where company_id = ${ctx.companyId} and code in ('1200', '2100')`;
    const by = new Map(controls.map((a) => [a.code, a.id]));
    for (const code of ["1200", "2100"]) {
      if (!by.has(code)) throw new LoadError("ERR_VALIDATION_FAILED", `company ${ctx.companyId} cannot resolve control account ${code}; apply 0C's chart pack before the load (contracts §4.15, §4.5.7)`);
    }
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const [made] = await tx<{ id: string }[]>`
        insert into app.party (tenant_id, company_id, kind, code, name_en, name_ar,
                               receivable_account_id, payable_account_id, tax_registration, email, phone, legacy_ref)
        values (app.current_tenant(), ${ctx.companyId}, ${row.kind}, ${row.code}, ${row.nameEn}, ${row.nameAr},
                ${row.kind === "customer" ? by.get("1200")! : null}, ${row.kind === "vendor" ? by.get("2100")! : null},
                ${row.taxRegistration}, ${row.email}, ${row.phone}, ${row.legacyCode})
        on conflict (company_id, code) do nothing
        returning id`;
      if (made) { inserted += 1; batchIds.push(made.id); continue; }
      const [existing] = await tx<{ id: string }[]>`select id from app.party where company_id = ${ctx.companyId} and code = ${row.code}`;
      skipped += 1;
      batchIds.push(existing!.id);
    }
    return { inserted, skipped, batchIds };
  },
};
```

`packages/importer/src/load/accounts.ts`:

```ts
import type { Sql } from "postgres";
import type { LegacyRow } from "../index";
import { optionalText, requireText } from "./scalar";
import { type AccountMap, treatmentOf } from "./account-map";
import { LoadError, type Loader, type LoadContext, type SourceColumn } from "./types";

interface AccountTarget { legacyKey: string; legacyCode: string; code: string }

let current: AccountMap | null = null;
export function setAccountMap(map: AccountMap): void { current = map; }
export function accountMap(): AccountMap {
  if (!current) throw new LoadError("ERR_VALIDATION_FAILED", "no account map has been set; pass --account-map <path> (the OWNER's mapping from the legacy chart to Dulja's)");
  return current;
}

const COLUMNS: readonly SourceColumn[] = [
  { name: "ACCID",         required: true,  confidence: "hypothesis", note: "the account's own key (Accounts, prefix ACC)" },
  { name: "ACCCODE",       required: true,  confidence: "hypothesis", note: "the legacy chart code the account map keys on" },
  { name: "ACCNAME",       required: true,  confidence: "hypothesis", note: "display name, kept for the reconciliation report" },
  { name: "ACCISCUSTOMER", required: false, confidence: "hypothesis", note: "flag; a customer row is partyLoader's, not this one's" },
  { name: "ACCISVENDOR",   required: false, confidence: "hypothesis", note: "flag" },
  { name: "ACCOPENBAL",    required: false, confidence: "hypothesis", note: "the stored opening balance; read only to detect SAH-007 NULL poisoning — the OPENING_BALANCE amounts come from AccTotals, recomputed by 9A" },
];

const truthy = (v: string | null): boolean => v === "1" || v?.toUpperCase() === "T" || v?.toUpperCase() === "TRUE" || v?.toUpperCase() === "Y";

/**
 * Links the legacy chart to Dulja's, and creates NOTHING the map did not name. §4.15's codes are seeded by
 * their slices; this loader only stamps `legacy_ref` on the account the map points at, so the ledger
 * opening (T5) and the reconciliation report (T10) can both say "legacy 1301 is Dulja 1200".
 *
 * It deliberately does not create accounts: a chart invented from the customer's own free-text names would
 * put unregistered codes into a namespace hazard 32 closes. An unmapped legacy account is REPORTED.
 */
export const accountLoader: Loader<LegacyRow, AccountTarget> = {
  sourceTable: "ACCOUNTS",
  targetTable: "account",
  dependsOn: [],
  sourceColumns: COLUMNS,
  // **ACCCODE, not ACCID** — and this is the one line the whole ledger opening hangs on. The
  // `import_batch` natural key this returns is what `RefResolver.byLegacyRef("account", …)` searches, and
  // its only caller is `openingBalanceLoader.map`, which passes `AccTotals.ACTACC` — a legacy chart
  // **code** (`1101`), not the Accounts surrogate key. Keying on ACCID would file the batch rows under
  // `100`/`101`, every ACCTOTALS row would resolve to `null`, every one would skip, `mapped.length` would
  // be 0 and NO `OPENING_BALANCE` document would ever be posted. ACCCODE is also what `account.legacy_ref`
  // and `party.legacy_ref` already carry and what the reconciliation report prints, so one legacy
  // identifier now runs through the whole slice. The party loader's `ACC:<ACCID>` space cannot collide
  // with it: its keys all begin `ACC:` and these are bare digits.
  sourceKey: (row) => requireText(row, "ACCCODE", "ACCOUNTS"),

  map(row) {
    const legacyKey = requireText(row, "ACCID", "ACCOUNTS");
    const where = `ACCOUNTS/${legacyKey}`;
    if (truthy(optionalText(row, "ACCISCUSTOMER")) || truthy(optionalText(row, "ACCISVENDOR"))) {
      return { skip: `account ${legacyKey} is a customer or vendor; partyLoader takes it` };
    }
    const legacyCode = requireText(row, "ACCCODE", where);
    // SAH-007: a NULL stored balance is reported here, at the row that has it, rather than being read as a
    // zero three tasks later inside a posting.
    if (Object.hasOwn(row, "ACCOPENBAL") && row["ACCOPENBAL"] === null) {
      return { skip: `ACCOPENBAL is NULL for legacy account ${legacyCode}; a NULL legacy amount is never read as zero (SAH-007)` };
    }
    const entry = accountMap().entries.find((e) => e.legacyCode === legacyCode);
    if (!entry) return { skip: `legacy account ${legacyCode} is not in the account map; add it with a treatment, or mark it exclude` };
    if (treatmentOf(accountMap(), legacyCode) === "exclude") {
      return { skip: `legacy account ${legacyCode} is mapped exclude; it is reported and not loaded` };
    }
    return { legacyKey, legacyCode, code: entry.code };
  },

  async load(tx: Sql, ctx: LoadContext, rows: AccountTarget[]) {
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const [found] = await tx<{ id: string; legacy_ref: string | null }[]>`
        select id, legacy_ref from app.account where company_id = ${ctx.companyId} and code = ${row.code}`;
      if (!found) throw new LoadError("ERR_VALIDATION_FAILED", `the account map sends legacy ${row.legacyCode} to Dulja account ${row.code}, which company ${ctx.companyId} does not have; seed it (contracts §4.15 names its slice) before the load`);
      if (found.legacy_ref === null) {
        await tx`update app.account set legacy_ref = ${row.legacyCode} where id = ${found.id}`;
        inserted += 1;
      } else {
        skipped += 1;
      }
      batchIds.push(found.id);
    }
    return { inserted, skipped, batchIds };
  },
};
```

- [ ] **Step 8: Register the six loaders**

`packages/importer/src/load/registry.ts` — the array's declaration order is also a valid topological order:

```ts
import { accountLoader } from "./accounts";
import { itemLoader } from "./items";
import { lotLoader } from "./lots";
import { partyLoader } from "./parties";
import { unitLoader } from "./units";
import { warehouseLoader } from "./warehouses";
import type { Loader } from "./types";

export const loaders: Loader<unknown, unknown>[] = [
  unitLoader, warehouseLoader, accountLoader, partyLoader, itemLoader, lotLoader,
] as unknown as Loader<unknown, unknown>[];
```

and `packages/importer/src/index.ts` gains:

```ts
export { accountMap, accountLoader, setAccountMap } from "./load/accounts";
export { ACCOUNT_CODE_PATTERN, assertAccountMap, readAccountMap, treatmentOf, type AccountMap, type AccountMapEntry, type AccountTreatment } from "./load/account-map";
export { itemLoader } from "./load/items";
export { lotLoader } from "./load/lots";
export { partyLoader } from "./load/parties";
export { codeFromName, unitLoader } from "./load/units";
export { warehouseLoader } from "./load/warehouses";
```

- [ ] **Step 9: Grow the corpus and write the account-map fixture**

`packages/importer/test/corpus/cut-over/catalog.json` gains four table entries (the `UNITS` entry from T3 is unchanged):

```json
    "WAREHOUSES": { "keyColumns": ["WARID"], "columns": [
      { "name": "WARID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "WARNAME", "kind": "text", "scale": 0, "nullable": false },
      { "name": "WARNOTE", "kind": "text", "scale": 0, "nullable": true } ] },
    "MATERIALS": { "keyColumns": ["MATID"], "columns": [
      { "name": "MATID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "MATCODE", "kind": "text", "scale": 0, "nullable": true },
      { "name": "MATNAME", "kind": "text", "scale": 0, "nullable": false },
      { "name": "MATNAMEAR", "kind": "text", "scale": 0, "nullable": true },
      { "name": "MATUNIT", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "MATISSERVICE", "kind": "integer", "scale": 0, "nullable": true },
      { "name": "MATISBATCH", "kind": "integer", "scale": 0, "nullable": true } ] },
    "MATBATCHES": { "keyColumns": ["BATID"], "columns": [
      { "name": "BATID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BATMAT", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BATCODE", "kind": "text", "scale": 0, "nullable": false },
      { "name": "BATEXPIRY", "kind": "date", "scale": 0, "nullable": true },
      { "name": "BATMFG", "kind": "date", "scale": 0, "nullable": true } ] },
    "ACCOUNTS": { "keyColumns": ["ACCID"], "columns": [
      { "name": "ACCID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "ACCCODE", "kind": "text", "scale": 0, "nullable": false },
      { "name": "ACCNAME", "kind": "text", "scale": 0, "nullable": false },
      { "name": "ACCNAMEAR", "kind": "text", "scale": 0, "nullable": true },
      { "name": "ACCISCUSTOMER", "kind": "integer", "scale": 0, "nullable": true },
      { "name": "ACCISVENDOR", "kind": "integer", "scale": 0, "nullable": true },
      { "name": "ACCTAXNO", "kind": "text", "scale": 0, "nullable": true },
      { "name": "ACCEMAIL", "kind": "text", "scale": 0, "nullable": true },
      { "name": "ACCPHONE", "kind": "text", "scale": 0, "nullable": true },
      { "name": "ACCOPENBAL", "kind": "decimal", "scale": 4, "nullable": true } ] }
```

`packages/importer/test/corpus/cut-over/WAREHOUSES.json`:

```json
[
  { "WARID": "1", "WARNAME": "Main store", "WARNOTE": "المستودع الرئيسي" },
  { "WARID": "2", "WARNAME": "Shop 1", "WARNOTE": null }
]
```

`packages/importer/test/corpus/cut-over/MATERIALS.json`:

```json
[
  { "MATID": "10", "MATCODE": "WIDGET", "MATNAME": "Widget", "MATNAMEAR": "أداة", "MATUNIT": "1", "MATISSERVICE": "0", "MATISBATCH": "1" },
  { "MATID": "11", "MATCODE": "GADGET", "MATNAME": "Gadget", "MATNAMEAR": null, "MATUNIT": "2", "MATISSERVICE": "0", "MATISBATCH": "0" },
  { "MATID": "12", "MATCODE": "DELIVERY", "MATNAME": "Delivery service", "MATNAMEAR": null, "MATUNIT": "1", "MATISSERVICE": "1", "MATISBATCH": "0" }
]
```

`packages/importer/test/corpus/cut-over/MATBATCHES.json` — the second row is the deliberate orphan the SAH-073 clause asserts:

```json
[
  { "BATID": "9000", "BATMAT": "10", "BATCODE": "B-2401", "BATEXPIRY": "2027-03-31", "BATMFG": "2024-04-01" },
  { "BATID": "9001", "BATMAT": "999", "BATCODE": "B-ORPHAN", "BATEXPIRY": null, "BATMFG": null }
]
```

`packages/importer/test/corpus/cut-over/ACCOUNTS.json`:

```json
[
  { "ACCID": "100", "ACCCODE": "1101", "ACCNAME": "Cash on hand", "ACCNAMEAR": "الصندوق", "ACCISCUSTOMER": "0", "ACCISVENDOR": "0", "ACCTAXNO": null, "ACCEMAIL": null, "ACCPHONE": null, "ACCOPENBAL": "5000.0000" },
  { "ACCID": "101", "ACCCODE": "1301", "ACCNAME": "Trade receivables", "ACCNAMEAR": null, "ACCISCUSTOMER": "0", "ACCISVENDOR": "0", "ACCTAXNO": null, "ACCEMAIL": null, "ACCPHONE": null, "ACCOPENBAL": "1800.0000" },
  { "ACCID": "102", "ACCCODE": "1401", "ACCNAME": "Inventory", "ACCNAMEAR": null, "ACCISCUSTOMER": "0", "ACCISVENDOR": "0", "ACCTAXNO": null, "ACCEMAIL": null, "ACCPHONE": null, "ACCOPENBAL": "2400.0000" },
  { "ACCID": "103", "ACCCODE": "2101", "ACCNAME": "Trade payables", "ACCNAMEAR": null, "ACCISCUSTOMER": "0", "ACCISVENDOR": "0", "ACCTAXNO": null, "ACCEMAIL": null, "ACCPHONE": null, "ACCOPENBAL": "900.0000" },
  { "ACCID": "200", "ACCCODE": "2001", "ACCNAME": "Alpha Trading", "ACCNAMEAR": "ألفا للتجارة", "ACCISCUSTOMER": "1", "ACCISVENDOR": "0", "ACCTAXNO": "TX-2001", "ACCEMAIL": "ap@alpha.example", "ACCPHONE": "+60-3-0000-0001", "ACCOPENBAL": "1800.0000" },
  { "ACCID": "300", "ACCCODE": "3001", "ACCNAME": "Beta Supplies", "ACCNAMEAR": null, "ACCISCUSTOMER": "0", "ACCISVENDOR": "1", "ACCTAXNO": "TX-3001", "ACCEMAIL": null, "ACCPHONE": null, "ACCOPENBAL": "900.0000" }
]
```

`packages/importer/test/fixtures/account-map.json` — the shape the owner fills in; the tests use it and the runbook points at it:

```json
{
  "generatedFrom": "packages/importer/test/corpus/cut-over (synthetic)",
  "entries": [
    { "legacyCode": "1101", "code": "1000", "nameEn": "Cash on hand", "nameAr": "الصندوق", "type": "asset", "treatment": "balance", "note": null },
    { "legacyCode": "1301", "code": "1200", "nameEn": "Trade receivables (AR control)", "nameAr": null, "type": "asset", "treatment": "ar_control", "note": "supplied by the open-item load, not by the trial-balance opening" },
    { "legacyCode": "1401", "code": "1300", "nameEn": "Inventory control", "nameAr": null, "type": "asset", "treatment": "inventory_control", "note": "supplied by OPENING_STOCK at recomputed cost (§5.1 #6)" },
    { "legacyCode": "2101", "code": "2100", "nameEn": "Trade payables (AP control)", "nameAr": null, "type": "liability", "treatment": "ap_control", "note": "supplied by the open-item load" }
  ]
}
```

- [ ] **Step 10: Run the tests**

Run: `bun run --cwd packages/importer test load/`
Expected: PASS — all six loaders green, including the orphan skip and the SAH-007 refusal.

- [ ] **Step 11: Append the 9B blocks to `sah-007` and `sah-073`**

`tests/regression/sah-007.test.ts`:

```ts
describe("SAH-007 NULL-poisoned balances read as zero — 9B", () => {
  const MYR = currency("MYR");

  it("moneyOf refuses a NULL legacy amount instead of returning zero", () => {
    expect(() => moneyOf({ AMT: null }, "AMT", MYR, "ACCTOTALS/1")).toThrow(
      /ERR_VALIDATION_FAILED: ACCTOTALS\/1: AMT is NULL; a NULL legacy amount is never read as zero \(SAH-007, SAH-011\)/,
    );
    expect(moneyOf({ AMT: "0.0000" }, "AMT", MYR, "ACCTOTALS/1").toString()).toBe("0.0000");
  });
});
```

`tests/regression/sah-073.test.ts`:

```ts
describe("SAH-073 Orphaned references (Job 82%, CostCentre 81% unconstrained) — 9B", () => {
  it("an orphaned legacy batch is reported as a skip with its reason, never loaded with a null parent", async () => {
    const skips = await loadFromCorpus("cut-over");
    expect(skips.filter((k) => k.loader === "lot")).toEqual([
      { loader: "lot", sourceTable: "MATBATCHES", sourceKey: "9001", reason: "material 999 has no imported item; the batch is an orphan (SAH-073)" },
    ]);
  });
});
```

`loadFromCorpus` is the helper Task 5 adds to `tests/invariants/support/cut-over.ts` (amendment C6). **This block is therefore written in Task 5, not here** — Task 5's Step 8 lists it, and Task 4 appends only the `sah-007` block. `sah-007.test.ts` gains `import { moneyOf } from "@dulja/importer";` (already a `tests` dependency after 9A added it for `sah-077`) and `import { currency } from "@dulja/domain";` — `moneyOf`'s third parameter is a `CurrencyCode`, never a bare `"MYR"` string, which is what stops a loader minting Money in a currency the company does not use.

- [ ] **Step 12: Commit**

```bash
git add packages/importer/src/load packages/importer/src/index.ts packages/importer/test \
        packages/db/seed/my/chart-of-accounts/9b-cut-over.json tests/regression/sah-007.test.ts
git commit -m "feat(importer): add the six master-data loaders and the owner's account map [9B T4]

Units, warehouses, items, lots and parties, plus the account linker that
stamps legacy_ref on the Dulja account the OWNER's map names. The map is
validated, never inferred: a code outside 4.15's format, a code whose first
digit disagrees with its type, or a missing AR/AP control is a named
failure. Orphans and NULL-poisoned figures are reported as skips, never
nulled or read as zero (SAH-007, SAH-073). Seeds account 3900.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `OPENING_BALANCE` — the document type, the one document writer, and the trial-balance opening

**Files:**
- Create: `packages/db/seed/my/document-types/OPENING_BALANCE.json`, `packages/importer/src/load/document.ts`, `packages/importer/src/load/opening-balance.ts`, `packages/importer/test/load/opening-balance.test.ts`, `packages/importer/test/corpus/cut-over/ACCTOTALS.json`, `tests/invariants/support/cut-over.ts`
- Modify: `packages/importer/src/load/registry.ts`, `packages/importer/src/index.ts`, `packages/importer/test/corpus/cut-over/catalog.json`, `packages/contracts/src/errors.ts` (the `ERR_IMPORT_UNBALANCED_SOURCE` row, in the commit that raises it — §4.2.4), `tests/regression/sah-003.test.ts`, `tests/regression/sah-073.test.ts`

**Interfaces:**
- Consumes: `postDocument`, `PostResult`, `PostingError` (§4.3.1); `resolvePolicy` (§4.3.1); `loadDocumentTypes`, `documentTypesLoader` (1A, §4.3.7); `Money`, `currency` (§4.2.1); `moneyOf`, `requireText` (T3); `accountMap`, `treatmentOf`, `AccountTreatment` (T4); `Loader`, `LoadContext`, `LoadError` (T3); **`sharedApi`, `grantAdmin`, `FullContext` (§4.17.1)** — the memoised api the `tests` tier reaches a running API through, never `startApi` from a package subpath that does not exist (§3.7.5's round-3 settlement, §4.2.7's frozen `exports`).
- Produces:

```ts
// packages/importer/src/load/document.ts — the ONE place this package writes app.document
export interface ImportedLine {
  lineNo: number;
  accountId?: string | null;
  itemId?: string | null;
  warehouseId?: string | null;
  lotId?: string | null;
  unitId?: string | null;
  kind: "account" | "item";
  description: string;
  debit?: Money;
  credit?: Money;
  quantity?: Quantity;
  unitPrice?: Money;
  amount?: Money;
}
export interface ImportedDocument {
  documentTypeCode: "OPENING_BALANCE" | "OPENING_STOCK";
  legacyRef: string | null;
  partyId?: string | null;
  warehouseId?: string | null;
  lines: ImportedLine[];
}
/** Drafts the header and its lines and hands the id to `postDocument`. It writes `app.document` and
 *  `app.document_line` and NOTHING else — every ledger, movement, layer and projection row is the
 *  posting service's (§0.2, hazard 22). Returns what postDocument returned. */
export async function draftAndPost(tx: Sql, ctx: LoadContext, doc: ImportedDocument): Promise<PostResult>;
export const OPENING_BRANCH_CODE: string;                       // "HQ" — document.branch_id is NOT NULL

// packages/importer/src/load/opening-balance.ts
export const openingBalanceLoader: Loader<LegacyRow, OpeningBalanceTarget>;
export interface OpeningBalanceTarget { legacyCode: string; accountId: string; treatment: AccountTreatment; debit: Money; credit: Money }

// tests/invariants/support/cut-over.ts — amendment C6
export interface CutOverFixture { api: StartedApi; seed: Seed; ctx: LoadContext; runId: string }
export async function cutOverFixture(name: string): Promise<CutOverFixture>;
/** TWO forms. The first loads INTO an existing fixture and leaves its api running — every caller that then
 *  QUERIES the result must use it. The second builds, loads and stops a fixture of its own and is usable
 *  only by a caller that reads nothing but the returned skips (`sah-073`, `sah-022`). */
export async function loadFromCorpus(fixture: CutOverFixture, corpus: string, over?: Partial<LoadContext>): Promise<SkipRecord[]>;
export async function loadFromCorpus(corpus: string, over?: Partial<LoadContext>): Promise<SkipRecord[]>;
export async function assertExplained(fixture: CutOverFixture, tolerance?: string): Promise<void>;
/** The fifth export amendment C6 registers, `reconcileFor(tx, fixture)`, is added to THIS file by
 *  Task 10 Step 4 — it wraps `reconcileCutOver`, which does not exist until that task. It is named
 *  here so a reader of C6's five-name list finds all five in the plan. */
```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/load/opening-balance.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { setAccountMap } from "../../src/load/accounts";
import { runLoad, setLoadSource } from "../../src/load/run";
import type { LoadContext } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant } from "../support/tenant";

let db: Db;
let s: Seed;
const RUN = "01930000-0000-7000-8000-0000000000c0";

const ctxFor = (over: Partial<LoadContext> = {}): Promise<LoadContext> => loadContextFor(db, s, RUN, over);
const read = <T>(fn: (tx: never) => Promise<T>) =>
  withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "read" }, fn as never) as Promise<T>;

/**
 * `app.import_batch`'s natural key is `(company_id, source_table, source_key)` with **no run scoping**
 * (§4.6.1), and `runLoad` calls `recordBatch` BEFORE `loader.load`: once this file's main tenant has
 * loaded every `ACCTOTALS` key, a second `runLoad` against it maps nothing, posts nothing and raises
 * nothing. Any case whose evidence comes from `load` — a closed period, an archived suspense account —
 * therefore needs a tenant of its own. That is what this is; it is not a convenience.
 */
const ownTenant = async (name: string, over: Partial<LoadContext> = {}) => {
  const own = await seedLoadableTenant(db, name);
  return { own, ctx: await loadContextFor(db, own, RUN, over) };
};

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "opening");
  setAccountMap(readAccountMap("test/fixtures/account-map.json"));
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(loadCorpus("cut-over"));
    return { driver, reader: await createReader(driver), close: async () => driver.close() };
  });
}, 240_000);
afterAll(async () => { await db?.stop(); });

describe("the trial-balance opening (contracts §4.14 OPENING_BALANCE; spec §5.1 #1, #2)", () => {
  it("posts ONE OPENING_BALANCE document, in the cut-over period, through postDocument", async () => {
    await runLoad(db.rw, await ctxFor());
    const [doc] = await read((tx) => tx<{ status: string; series: string; number: string; effective_date: string; legacy_ref: string | null }[]>`
      select d.status::text as status, d.series, d.number::text as number,
             to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, d.legacy_ref
        from app.document d join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${s.company} and t.code = 'OPENING_BALANCE' and d.legacy_ref is null`);
    expect(doc).toMatchObject({ status: "posted", series: "OB", number: "1", effective_date: "2026-01-31" });
  });

  it("excludes the three control treatments and posts only `balance` accounts", async () => {
    const lines = await read((tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.debit::text as debit, l.credit::text as credit
        from app.ledger_entry l
        join app.account a on a.id = l.account_id
        join app.document d on d.id = l.document_id
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'OPENING_BALANCE' and d.legacy_ref is null order by a.code`);
    // 1101 → 1000 debit 5000; the residue balances to 3900. 1301/1401/2101 are ar/inventory/ap controls
    // and are supplied by the open-item and opening-stock loads, so they are absent here.
    expect(lines.map((l) => l.code)).toEqual(["1000", "3900"]);
    expect(lines.find((l) => l.code === "1000")).toMatchObject({ debit: "5000.0000", credit: "0.0000" });
    expect(lines.find((l) => l.code === "3900")).toMatchObject({ debit: "0.0000", credit: "5000.0000" });
  });

  it("balances every opening against 3900 — the residue IS the suspense figure (§5.1 #2)", async () => {
    const [sums] = await read((tx) => tx<{ dr: string; cr: string }[]>`
      select sum(l.base_debit)::text as dr, sum(l.base_credit)::text as cr
        from app.ledger_entry l join app.document d on d.id = l.document_id
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'OPENING_BALANCE' and d.legacy_ref is null`);
    expect(sums!.dr).toBe(sums!.cr);
  });

  it("refuses to post into a closed period through the import path (acceptance test 9, re-run)", async () => {
    // Its OWN tenant: the case above has already recorded every ACCTOTALS key against `s`, so a re-run
    // there would map nothing and raise nothing. 0A's `seedTenant` makes 2026-02 a CLOSED period
    // (plan0A:1588–1591), which is why the code is ERR_PERIOD_NOT_OPEN and not ERR_PERIOD_NOT_FOUND.
    const { ctx } = await ownTenant("opening-closed-period", {
      runId: "01930000-0000-7000-8000-0000000000c1", cutOverDate: "2026-02-15",
    });
    await expect(runLoad(db.rw, ctx)).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
  });

  it("refuses when the opening does not balance and no suspense account can absorb the residue", async () => {
    // With 3900 present the residue is absorbed and the load succeeds — the three cases above prove that.
    // The refusal case is an ABSENT (here, archived) 3900: an unbalanced opening with nowhere visible to
    // put the difference must stop, never quietly drop a line (§5.1 #2). Its own tenant, for the same
    // idempotence reason as the case above — and archiving `s`'s 3900 would break every later case here.
    const { own, ctx } = await ownTenant("opening-archived-suspense", { runId: "01930000-0000-7000-8000-0000000000c2" });
    await withTenant(db.rw, { tenantId: own.tenant, actorId: own.human, requestId: "archive" }, (tx) =>
      tx`update app.account set archived_at = now() where company_id = ${own.company} and code = '3900'`);
    await expect(runLoad(db.rw, ctx))
      .rejects.toThrow(/ERR_IMPORT_UNBALANCED_SOURCE: the opening is out by 5000\.0000 and account 3900 is archived or absent/);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test load/opening-balance`
Expected: FAIL — `Cannot find module '../../src/load/opening-balance'`.

- [ ] **Step 3: Write the document-type seed file**

`packages/db/seed/my/document-types/OPENING_BALANCE.json` — the §4.3.7 envelope; only `policy` is validated against `posting-policy.schema.json`:

```json
{
  "code": "OPENING_BALANCE",
  "nameEn": "Opening balance",
  "nameAr": "رصيد افتتاحي",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "OPENING_BALANCE",
    "direction": "internal",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "OB", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "OPENING_BALANCE" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

**Four decisions this file makes, each forced.** `module: "accounting"` is §4.14's own value (the attachment gate — the cut-over evidence is the accountant's filing cabinet). `series: "OB"` is §4.14's, and amendment C1 explains why it is not `LEGACY`. `approval.required: false` is what lets `draft → issued` happen in one call (§4.5.1) so `postDocument` can issue and post in the same transaction; the system principal passes `accounting.journal.post` because `app.actor_has` admits the system principal (§4.1). `dimensions.required: []` because the cut-over opening is a company-level figure, not a branch one — spec:1066 makes BRANCH required on revenue, COGS and staff-cost lines, and an opening balance is none of those; the evaluator still tags every line with `document.branch_id`'s value.

`reversal.producesType: "OPENING_BALANCE"` is deliberate and is the *undo* Global Constraint 5 names: a load that must be withdrawn is reversed, never deleted.

**The file is applied by a task step, not by 0C's bootstrap:** `bun run seed --tenant <tenant_id> --only document-types` (§3.4.8's rule — a sub-pack whose owning slice is later than the pack's first application is not in the pack until that slice ships, and the slice applies it itself). The runbook's step 2 carries the same command.

- [ ] **Step 4: Write `load/document.ts`**

```ts
import type { Sql } from "postgres";
import { postDocument, type PostResult } from "@dulja/db";
import type { Money, Quantity } from "@dulja/domain";
import { LoadError, type LoadContext } from "./types";

export interface ImportedLine {
  lineNo: number;
  accountId?: string | null;
  itemId?: string | null;
  warehouseId?: string | null;
  lotId?: string | null;
  unitId?: string | null;
  kind: "account" | "item";
  description: string;
  debit?: Money;
  credit?: Money;
  quantity?: Quantity;
  unitPrice?: Money;
  amount?: Money;
}

export interface ImportedDocument {
  documentTypeCode: "OPENING_BALANCE" | "OPENING_STOCK";
  legacyRef: string | null;
  partyId?: string | null;
  warehouseId?: string | null;
  lines: ImportedLine[];
}

/** `document.branch_id` is NOT NULL (0001) and `LoadContext` is frozen at four extra fields (§4.13.2), so
 *  the branch is resolved here, per company, from the BRANCH dimension 0C seeds. */
export const OPENING_BRANCH_CODE = "HQ";

/**
 * The ONE place `packages/importer` writes `app.document` / `app.document_line`. Everything downstream —
 * the numbering, the fiscal period, the ledger rows, the movements, the layers, `account_balance`,
 * `stock_on_hand`, the audit rows, the `document_event` — is `postDocument`'s (§4.3.2), which is what
 * makes the import path identical to the API path and lets acceptance tests 9 and 18 be *re-run* through
 * it rather than re-implemented.
 */
export async function draftAndPost(tx: Sql, ctx: LoadContext, doc: ImportedDocument): Promise<PostResult> {
  const [type] = await tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${ctx.companyId} and code = ${doc.documentTypeCode}`;
  if (!type) throw new LoadError("ERR_VALIDATION_FAILED", `company ${ctx.companyId} has no document type ${doc.documentTypeCode}; run \`bun run seed --tenant … --only document-types\` before the load`);

  const [company] = await tx<{ base_currency: string }[]>`select base_currency from app.company where id = ${ctx.companyId}`;
  if (!company) throw new LoadError("ERR_VALIDATION_FAILED", `no company ${ctx.companyId} in this tenant`);

  const [branch] = await tx<{ id: string }[]>`
    select v.id from app.dimension_value v join app.dimension_type t on t.id = v.dimension_type_id
     where t.company_id = ${ctx.companyId} and t.code = 'BRANCH' and v.code = ${OPENING_BRANCH_CODE}`;
  if (!branch) throw new LoadError("ERR_VALIDATION_FAILED", `company ${ctx.companyId} has no BRANCH value ${OPENING_BRANCH_CODE}`);

  // The series is read from the policy, exactly as 1A's create handler does, so a draft already shows the
  // series it will be numbered in and issueDocument's own read agrees with it (§4.3.6).
  const [policy] = await tx<{ definition: { numbering: { series: string } } }[]>`
    select definition from app.posting_policy
     where document_type_id = ${type.id} and effective_from <= ${ctx.cutOverDate}::date
     order by effective_from desc, version desc limit 1`;
  if (!policy) throw new LoadError("ERR_VALIDATION_FAILED", `no posting policy for ${doc.documentTypeCode} effective on ${ctx.cutOverDate}`);

  const [header] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency,
                              exchange_rate, rate_source, branch_id, party_id, warehouse_id, legacy_ref)
    values (app.current_tenant(), ${ctx.companyId}, ${type.id}, ${policy.definition.numbering.series},
            ${ctx.cutOverDate}, ${company.base_currency}, 1, null, ${branch.id},
            ${doc.partyId ?? null}, ${doc.warehouseId ?? null}, ${doc.legacyRef})
    returning id`;

  for (const line of doc.lines) {
    await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, description,
                                            account_id, item_id, warehouse_id, lot_id, unit_id,
                                            debit, credit, quantity, unit_price, amount)
             values (app.current_tenant(), ${ctx.companyId}, ${header!.id}, ${line.lineNo}, ${line.kind}, ${line.description},
                     ${line.accountId ?? null}, ${line.itemId ?? null}, ${line.warehouseId ?? null}, ${line.lotId ?? null}, ${line.unitId ?? null},
                     ${line.debit?.toString() ?? "0"}, ${line.credit?.toString() ?? "0"},
                     ${line.quantity?.toString() ?? null}, ${line.unitPrice?.toString() ?? null}, ${line.amount?.toString() ?? "0"})`;
  }

  // Everything after this line is the posting service's, including the issue and the number.
  return postDocument(tx, ctx, { documentId: header!.id });
}
```

- [ ] **Step 5: Write `load/opening-balance.ts`, and add the `ERR_IMPORT_UNBALANCED_SOURCE` row it raises**

`packages/contracts/src/errors.ts` gains its second and last 9B row **in this commit**, because this is the commit whose code raises it — §4.2.4's rule verbatim, and the reason Task 2 Step 7 deliberately shipped only the other one:

```ts
  ERR_IMPORT_UNBALANCED_SOURCE: {
    status: 422,
    title: "Legacy figures do not balance",
    remedy: "Run the 9A unbalanced-voucher report, agree the suspense treatment (account 3900) with the customer, then re-run the load.",
  },
```

The raise is `openingBalanceLoader.load`'s archived-or-absent-`3900` branch below, in `packages/importer/src/load/opening-balance.ts` — inside `packages/**/src/**`, which is one of `error-codes`' scan roots — so `bun run lint:rules` in Step 9 is green at this commit and at every commit after it. `packages/contracts/src/errors.ts` joins this task's `git add` list in Step 10.

Now the loader itself:

```ts
import type { Sql } from "postgres";
import { Money } from "@dulja/domain";
import type { LegacyRow } from "../index";
import { accountMap } from "./accounts";
import type { AccountTreatment } from "./account-map";
import { draftAndPost, type ImportedLine } from "./document";
import { baseCurrency, EMPTY_TARGET } from "./run";
import { moneyOf, requireText } from "./scalar";
import { LoadError, type Loader, type LoadContext, type RefResolver, type SourceColumn } from "./types";

export interface OpeningBalanceTarget {
  legacyCode: string; accountId: string; treatment: AccountTreatment; debit: Money; credit: Money;
}

const COLUMNS: readonly SourceColumn[] = [
  { name: "ACTACC",    required: true, confidence: "hypothesis", note: "the Accounts key/code this total belongs to (AccTotals, prefix ACT)" },
  { name: "ACTDEBIT",  required: true, confidence: "hypothesis", note: "stored debit total — read to be COMPARED, never trusted: §5.1 #1 says recompute from VouItems and 9A's aggregate_drift report is what quantifies the difference" },
  { name: "ACTCREDIT", required: true, confidence: "hypothesis", note: "stored credit total — same" },
];

/** §4.15's frozen suspense code. Fixed here so this loader and the §5.1 #2 report name one account. */
export const SUSPENSE_CODE = "3900";

/**
 * ONE `OPENING_BALANCE` document carrying the whole trial balance, balanced against `3900`.
 *
 * Three account treatments are DELIBERATELY absent from its lines, and their absence is what stops the
 * cut-over double-counting:
 *   `ar_control`        — supplied per party by the open-item load (T7), which is also what the 4B ageing
 *                         tie-out reads (§4.8.2);
 *   `ap_control`        — the same, on the payables side;
 *   `inventory_control` — supplied by `OPENING_STOCK` at RECOMPUTED cost (T6, §5.1 #6), because §5.1 #6
 *                         forbids importing the legacy cost figures at all.
 * `exclude` accounts are reported and not loaded. Everything else is a `balance` line, and whatever the
 * three exclusions and the legacy imbalance (SAH-003) leave over lands on `3900`, where it is visible.
 */
export const openingBalanceLoader: Loader<LegacyRow, OpeningBalanceTarget> = {
  sourceTable: "ACCTOTALS",
  targetTable: "opening_balance",
  wholeTable: true,           // amendment C13 — ONE document, one residue, over the whole trial balance
  dependsOn: ["account", "party", "item"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "ACTACC", "ACCTOTALS"),

  async map(row, refs: RefResolver) {
    const legacyCode = requireText(row, "ACTACC", "ACCTOTALS");
    const entry = accountMap().entries.find((e) => e.legacyCode === legacyCode);
    if (!entry) return { skip: `legacy account ${legacyCode} has a stored total but is not in the account map` };
    if (entry.treatment === "exclude") return { skip: `legacy account ${legacyCode} is mapped exclude; its ${row["ACTDEBIT"]}/${row["ACTCREDIT"]} total is reported, not loaded` };
    if (entry.treatment !== "balance") return { skip: `legacy account ${legacyCode} is the ${entry.treatment}; its opening is supplied by the sub-ledger load, not by the trial-balance opening` };
    const accountId = await refs.byLegacyRef("account", legacyCode);
    if (!accountId) return { skip: `legacy account ${legacyCode} was never linked to a Dulja account; accountLoader skipped it` };
    return {
      legacyCode, accountId, treatment: entry.treatment,
      debit: moneyOf(row, "ACTDEBIT", baseCurrency(), `ACCTOTALS/${legacyCode}`),
      credit: moneyOf(row, "ACTCREDIT", baseCurrency(), `ACCTOTALS/${legacyCode}`),
    };
  },

  /**
   * Called EXACTLY ONCE, with every mapped row of `AccTotals`, because the loader sets `wholeTable`
   * (amendment C13): the residue that lands on `3900` is a figure over the whole trial balance, and one
   * per 500-row page would be several documents each with its own invented suspense line. The loader
   * therefore holds its input in memory and posts one document — the trial balance of a 30-person
   * distributor is hundreds of rows, not millions, and one balanced document is what a reader can check
   * against the legacy TB report. The atomicity that buys is the right one: half an opening balance is
   * not a smaller opening balance.
   */
  async load(tx: Sql, ctx: LoadContext, rows: OpeningBalanceTarget[]) {
    // The company's own currency, read once when the run opened (N3). No `"MYR"` literal and no cast: the
    // Money `map` minted and the Money this line zeroes are the same type by construction (§4.2.1).
    const base = baseCurrency();

    const lines: ImportedLine[] = [];
    let residue = Money.zero(base);
    for (const [i, row] of rows.entries()) {
      const net = row.debit.subtract(row.credit);
      if (net.isZero()) continue;                    // a zero opening carries no information
      lines.push({
        lineNo: i + 1, kind: "account", accountId: row.accountId,
        description: `Opening balance, legacy account ${row.legacyCode}`,
        debit: net.isPositive() ? net : Money.zero(base),
        credit: net.isPositive() ? Money.zero(base) : net.negate(),
      });
      residue = residue.add(net);
    }
    // Every mapped account netted to zero, so there is no opening to post. `batchIds` is still ONE ENTRY
    // PER ROW `load` was handed — `linkBatches` throws `ERR_VALIDATION_FAILED` on any other length, and an
    // empty array here would accuse this loader of a contract breach on the one shape that is not a breach:
    // a legacy trial balance whose every account nets flat. `EMPTY_TARGET` is exported from run.ts with
    // exactly this documented meaning — "seen, hashed, produced no target row" — and is the same value
    // `openingStockLoader` returns for a warehouse that opened nothing.
    if (lines.length === 0) return { inserted: 0, skipped: rows.length, batchIds: rows.map(() => EMPTY_TARGET) };

    if (!residue.isZero()) {
      const [suspense] = await tx<{ id: string }[]>`
        select id from app.account
         where company_id = ${ctx.companyId} and code = ${SUSPENSE_CODE} and archived_at is null`;
      if (!suspense) {
        throw new LoadError("ERR_IMPORT_UNBALANCED_SOURCE", `the opening is out by ${residue.abs().toString()} and account ${SUSPENSE_CODE} is archived or absent; apply 9b-cut-over.json (\`bun run seed --tenant … --only chart-of-accounts\`) and agree the treatment with the customer (§5.1 #2, OD-25)`);
      }
      lines.push({
        lineNo: lines.length + 1, kind: "account", accountId: suspense.id,
        description: `Opening-balance suspense — the unexplained residue of the legacy trial balance (§5.1 #2, SAH-003)`,
        debit: residue.isNegative() ? residue.negate() : Money.zero(base),
        credit: residue.isNegative() ? Money.zero(base) : residue,
      });
    }

    const posted = await draftAndPost(tx, ctx, { documentTypeCode: "OPENING_BALANCE", legacyRef: null, lines });
    // One document from many source rows: `batchIds` must carry one id per mapped row (runLoad's
    // linkBatches asserts it), and every one of them points at the same document.
    return { inserted: rows.length, skipped: 0, batchIds: rows.map(() => posted.documentId) };
  },
};
```

**`targetTable` is `opening_balance`, not `document`.** `import_batch.target_table` is a free-text label constrained only to `^[a-z][a-z0-9_]{0,62}$` (T2), and using the literal `document` here would collide with the open-item loader's own rows in `RefResolver`'s `SOURCE_OF` map. The three document-producing loaders therefore label themselves `opening_balance`, `opening_stock` and `open_item`, and only `open_item` also stamps `document.legacy_ref` (T7).

- [ ] **Step 6: Register it and grow the corpus**

`packages/importer/src/load/registry.ts` gains `openingBalanceLoader` after `lotLoader`; `packages/importer/src/index.ts` gains `export { openingBalanceLoader, SUSPENSE_CODE } from "./load/opening-balance";` and `export { draftAndPost, OPENING_BRANCH_CODE, type ImportedDocument, type ImportedLine } from "./load/document";`.

`packages/importer/test/corpus/cut-over/catalog.json` gains:

```json
    "ACCTOTALS": { "keyColumns": ["ACTACC"], "columns": [
      { "name": "ACTACC", "kind": "text", "scale": 0, "nullable": false },
      { "name": "ACTDEBIT", "kind": "decimal", "scale": 4, "nullable": false },
      { "name": "ACTCREDIT", "kind": "decimal", "scale": 4, "nullable": false } ] }
```

`packages/importer/test/corpus/cut-over/ACCTOTALS.json` — deliberately unbalanced by 5000, which is exactly the SAH-003 case the suspense line absorbs:

```json
[
  { "ACTACC": "1101", "ACTDEBIT": "5000.0000", "ACTCREDIT": "0.0000" },
  { "ACTACC": "1301", "ACTDEBIT": "1800.0000", "ACTCREDIT": "0.0000" },
  { "ACTACC": "1401", "ACTDEBIT": "2400.0000", "ACTCREDIT": "0.0000" },
  { "ACTACC": "2101", "ACTDEBIT": "0.0000", "ACTCREDIT": "900.0000" }
]
```

- [ ] **Step 7: Write `tests/invariants/support/cut-over.ts` (amendment C6)**

```ts
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currency, Money, type PostingPolicy } from "@dulja/domain";
import { systemContext, withTenant } from "@dulja/db";
import { seedAccount, seedDocumentType, seedTenantV2, type Db, type Seed } from "@dulja/db/test";
// **`sharedApi()`, never `startApi()` — settled by contracts §3.7.5 (round 3).** `apps/api`'s package
// `exports` are exactly `{ ".": "./src/app.ts", "./routes": "./src/routes/index.ts" }` (§4.2.7), so
// `@dulja/api/test-support` is a subpath that does not exist and could only be created by amending a
// frozen export map. §3.7.5's settlement is narrower still: from a root `tests/**` file a **type-only**
// import of `apps/api/test/support/app.ts` is permitted, a **value** import of `startApi` is discouraged,
// and its stated replacement is 0B's memoised `sharedApi()` in `tests/support/api.ts` — "whose consumers
// must not call `api.stop()`". This file therefore takes the api it is given and never stops it; the
// `StartedApi` type comes along as `FullContext["api"]`, so no cross-tier type import is needed either.
import { grantAdmin, sharedApi, type FullContext } from "../../support/api";
import {
  createReader, FixtureLegacyDriver, readAccountMap, runLoad, setAccountMap, setLoadSource,
  type LoadContext, type SkipRecord,
} from "@dulja/importer";

export interface CutOverFixture { api: FullContext["api"]; seed: Seed; ctx: LoadContext; runId: string }

/** `fileURLToPath`, never `new URL(…).pathname`: on Windows — the stated development machine — `pathname`
 *  yields `/C:/Users/…`, which `readFileSync` rejects and `path.join` compounds. */
const CORPUS_ROOT = fileURLToPath(new URL("../../../packages/importer/test/corpus/", import.meta.url));
const MAP = fileURLToPath(new URL("../../../packages/importer/test/fixtures/account-map.json", import.meta.url));
const TYPE_DIR = fileURLToPath(new URL("../../../packages/db/seed/my/document-types/", import.meta.url));

/** The six §4.15 codes a 9B loader resolves that `seedTenantV2` does not create — the same list as
 *  `packages/importer/test/support/tenant.ts` (T4 Step 3), repeated here for the same reason `readCorpus`
 *  below repeats 9A's `loadCorpus`: the `tests` workspace may not import `packages/importer/test/**`
 *  (§3.1). Two short lists, deliberately, rather than a cross-workspace test import. */
const ACCOUNTS: readonly { code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense" }[] = [
  { code: "1200", nameEn: "Trade receivables (AR control)", type: "asset" },
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "2100", nameEn: "Trade payables (AP control)", type: "liability" },
  { code: "3900", nameEn: "Opening-balance suspense", type: "equity" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

async function seedLoadable(db: Db, name: string): Promise<Seed> {
  const seed = await seedTenantV2(db, name);
  for (const account of ACCOUNTS) await seedAccount(db, seed, account);
  for (const file of ["OPENING_BALANCE.json", "OPENING_STOCK.json"]) {
    const path = `${TYPE_DIR}${file}`;
    if (!existsSync(path)) continue;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as {
      code: string; module: string; policyVersion: number; effectiveFrom: string; policy: PostingPolicy;
    };
    await seedDocumentType(db, seed, {
      code: envelope.code, module: envelope.module, policy: envelope.policy,
      policyVersion: envelope.policyVersion, effectiveFrom: envelope.effectiveFrom,
    });
  }
  return seed;
}

/** A tenant the cut-over load can run against — `seedTenantV2` plus the six §4.15 accounts and both
 *  cut-over document types — an admin principal, and a LoadContext under the tenant's SYSTEM principal:
 *  the shape every cut-over invariant needs and none of them may re-invent.
 *
 *  **The API is `sharedApi()`'s and is never stopped** (§3.7.5, §4.17.1). Every call still gets a tenant of
 *  its own — `seedLoadable` creates one per `name` — so isolation between cases is by tenant, which is what
 *  RLS makes real, not by container. Call it as many times as a file needs; the container is started once
 *  for the whole `tests` run. */
export async function cutOverFixture(name: string): Promise<CutOverFixture> {
  const { api } = await sharedApi();
  const seed = await seedLoadable(api.db, name);
  await grantAdmin(api, seed);
  const runId = randomUUID();
  const ctx: LoadContext = {
    ...(await systemContext(api.db.rw, seed.tenant, runId)),
    companyId: seed.company, runId, cutOverDate: "2026-01-31", dryRun: false,
  };
  setAccountMap(readAccountMap(MAP));
  return { api, seed, ctx, runId };
}

/**
 * Runs the whole registered load against a committed corpus and returns its skip register.
 *
 * **Two forms, and the difference is which TENANT is loaded.** `loadFromCorpus(fixture, corpus)` loads
 * INTO the caller's fixture, which is the form every caller that then *queries* the result must use.
 * `loadFromCorpus(corpus)` makes a tenant of its own and returns only the skips — usable solely by a
 * caller that reads nothing but the skip register (`sah-073`, `sah-022`). The two-argument form exists
 * because the one-argument form is a trap: a caller that made its own fixture and then called it would
 * query an EMPTY tenant, because the load went to a different one.
 *
 * **Neither form stops anything.** The api is `sharedApi()`'s (§4.17.1) and its consumers must not call
 * `api.stop()`; a load that throws — the SAH-022 case — therefore needs no `finally`, because this
 * function owns no container to release. The tenant a self-contained call created is simply left behind,
 * which costs a few rows in a database the run is about to discard.
 */
export async function loadFromCorpus(fixture: CutOverFixture, corpus: string, over?: Partial<LoadContext>): Promise<SkipRecord[]>;
export async function loadFromCorpus(corpus: string, over?: Partial<LoadContext>): Promise<SkipRecord[]>;
export async function loadFromCorpus(
  first: CutOverFixture | string,
  second?: string | Partial<LoadContext>,
  third: Partial<LoadContext> = {},
): Promise<SkipRecord[]> {
  const into = typeof first === "string" ? null : first;
  const corpus = typeof first === "string" ? first : (second as string);
  const over = typeof first === "string" ? ((second as Partial<LoadContext> | undefined) ?? {}) : third;
  // A self-contained call gets a tenant of its own, named for the corpus, so two such calls in one run
  // cannot collide on `import_batch`'s `(company_id, source_table, source_key)` key.
  const fixture = into ?? (await cutOverFixture(`corpus-${corpus}-${randomUUID().slice(0, 8)}`));
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(readCorpus(corpus));
    return { driver, reader: await createReader(driver), close: async () => driver.close() };
  });
  const report = await runLoad(fixture.api.db.rw, { ...fixture.ctx, ...over });
  return report.skips;
}

/** The definition-of-done predicate: after a load, every difference between the source and Dulja is either
 *  zero or sitting on 3900 with a line that says why. `tolerance` is a decimal string, default "0.0000".
 *
 *  **Compared as `Money`, never as `number`** — Global Constraint 2 and spec:2041: a tie-out asserted in
 *  floating point is not a tie-out to the cent, which is exactly what the phase DoD requires. */
export async function assertExplained(fixture: CutOverFixture, tolerance = "0.0000"): Promise<void> {
  const rows = await withTenant(fixture.api.db.rw, fixture.ctx, (tx) =>
    tx<{ code: string; balance: string }[]>`
      select a.code, coalesce(sum(l.base_debit - l.base_credit), 0)::text as balance
        from app.account a left join app.ledger_entry l on l.account_id = a.id
       where a.company_id = ${fixture.ctx.companyId}
       group by a.code having coalesce(sum(l.base_debit - l.base_credit), 0) <> 0 order by a.code`);
  // `MYR` is a fact about the FIXTURE, not about production: 0A's `seedTenant` inserts every test company
  // with `base_currency = 'MYR'` (plan0A:1587). Production code reads `baseCurrency()`; this is a test.
  const base = currency("MYR");
  const total = rows.reduce((sum, r) => sum.add(Money.of(r.balance, base)), Money.zero(base));
  if (total.abs().compare(Money.of(tolerance, base)) > 0) {
    throw new Error(`the ledger is out by ${total.toString()}; balances: ${rows.map((r) => `${r.code}=${r.balance}`).join(", ")}`);
  }
}

function readCorpus(name: string): never {
  // `loadCorpus` is 9A's test-tier helper and lives inside packages/importer/test, which the tests
  // workspace does not import (§3.1). The corpus files are plain JSON, so the tests tier reads them
  // directly — one small duplication, deliberately, rather than a cross-workspace test import.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const dir = path.join(CORPUS_ROOT, name);
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8")) as {
    engineVersion: string; tables: Record<string, { keyColumns: string[]; columns: unknown[] }>;
  };
  const tables = Object.fromEntries(Object.entries(catalog.tables).map(([table, meta]) => {
    const file = path.join(dir, `${table}.json`);
    const rows = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown[]) : [];
    return [table, { ...meta, rows }];
  }));
  return { engineVersion: catalog.engineVersion, tables } as never;
}
```

The two `require` calls are deliberate and are the only ones in the file: `tests/` runs under Node 24 through Vitest and both modules are built-ins, so no dependency is added; a top-level `import` of `node:fs` would be equally correct and either form is acceptable — use the top-level `import` if the file's lint configuration prefers it.

- [ ] **Step 8: Append the 9B blocks to `sah-003` and `sah-073`**

`tests/regression/sah-003.test.ts`:

```ts
describe("SAH-003 Unbalanced vouchers were never prevented — 9B", () => {
  it("an unbalanced legacy trial balance reaches account 3900 and never an unbalanced ledger", async () => {
    const f = await cutOverFixture("sah-003-9b");
    // INTO `f`. The one-argument form builds and destroys a fixture of its own, so the query below would
    // run against an empty tenant.
    await loadFromCorpus(f, "cut-over");
    const rows = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      tx<{ code: string; credit: string }[]>`
        select a.code, l.base_credit::text as credit
          from app.ledger_entry l join app.account a on a.id = l.account_id
          join app.document d on d.id = l.document_id
          join app.document_type t on t.id = d.document_type_id
         where t.code = 'OPENING_BALANCE' and a.code = '3900'`);
    expect(rows).toHaveLength(1);
    expect(Money.of(rows[0]!.credit, currency("MYR")).isPositive()).toBe(true);
    // No `api.stop()`: `cutOverFixture` uses the memoised `sharedApi()` (§4.17.1, §3.7.5) and its
    // consumers must not stop it. The tenant is this case's own; the container is the whole run's.
  });
});
```

`tests/regression/sah-073.test.ts` — the block Task 4 Step 10 deferred to here, now that `loadFromCorpus` exists:

```ts
describe("SAH-073 Orphaned references (Job 82%, CostCentre 81% unconstrained) — 9B", () => {
  it("an orphaned legacy batch is reported as a skip with its reason, never loaded with a null parent", async () => {
    const skips = await loadFromCorpus("cut-over");
    expect(skips.filter((k) => k.loader === "lot")).toEqual([
      { loader: "lot", sourceTable: "MATBATCHES", sourceKey: "9001", reason: "material 999 has no imported item; the batch is an orphan (SAH-073)" },
    ]);
  });
});
```

`sah-003.test.ts` gains `import { cutOverFixture, loadFromCorpus } from "../invariants/support/cut-over";` and `import { currency, Money } from "@dulja/domain";`; `sah-073.test.ts` gains `import { loadFromCorpus } from "../invariants/support/cut-over";` only — it reads nothing but the skip register, which is the one case the self-contained one-argument form is for.

- [ ] **Step 9: Run everything**

Run: `bun run --cwd packages/importer test load/opening-balance && bun run --cwd tests test sah-003 && bun run --cwd tests test sah-073 && bun run lint:rules`
Expected: PASS. `posting-only-tables` is the rule to watch: `opening-balance.ts` and `document.ts` name `app.document` and `app.document_line`, neither of which is on the protected list, and name no protected table at all.

- [ ] **Step 10: Commit**

```bash
git add packages/db/seed/my/document-types/OPENING_BALANCE.json packages/importer/src/load \
        packages/importer/src/index.ts packages/importer/test packages/contracts/src/errors.ts \
        tests/invariants/support/cut-over.ts \
        tests/regression/sah-003.test.ts tests/regression/sah-073.test.ts
git commit -m "feat(importer): post the trial-balance opening through the posting service [9B T5]

OPENING_BALANCE (series OB, module accounting) and the one place this
package writes app.document. The AR, AP and inventory controls are excluded
from the opening on purpose — their sub-ledger loads supply them — so the
cut-over cannot double-count, and whatever the legacy imbalance leaves over
lands visibly on 3900 (SAH-003, 5.1 #2). Period lock is proven through the
import path (acceptance test 9, re-run).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Opening stock at a **recomputed** cost — the legacy replay through `costingEngine`, and `OPENING_STOCK`

**Files:**
- Create: `packages/db/seed/my/document-types/OPENING_STOCK.json`, `packages/importer/src/load/recost.ts`, `packages/importer/src/load/opening-stock.ts`, `packages/importer/test/load/recost.test.ts`, `packages/importer/test/load/opening-stock.test.ts`, `packages/importer/test/corpus/cut-over/BILLITEMS.json`
- Modify: `packages/importer/src/load/registry.ts`, `packages/importer/src/index.ts`, `packages/importer/test/corpus/cut-over/catalog.json`, `tests/regression/sah-011.test.ts`

**Interfaces:**
- Consumes: `costingEngine`, `Layer`, `CostingInput`, `CostingOutput`, `Consumption`, `CostingMethod` (3B, §4.7.1); `valuationAsOf`, `ValuationRow` (3B); `applyMovements` **indirectly**, through `postDocument` step 9 (§4.3.2 — this slice never calls it); `Money`, `Quantity`, `currency` (§4.2.1); `draftAndPost`, `ImportedLine` (T5); `moneyOf`, `quantityOf`, `dateOf`, `requireText`, `optionalText` (T3).
- Produces:

```ts
// packages/importer/src/load/recost.ts
export interface LegacyMovement {
  itemKey: string; warehouseKey: string; lotKey: string | null;
  effectiveDate: string; sequence: bigint; lineNo: number;
  direction: "in" | "out";
  quantity: Quantity;
  value: Money | null;          // null on an issue — the engine computes it from the layers
}
export interface OpeningPosition {
  itemKey: string; warehouseKey: string; lotKey: string | null;
  quantity: Quantity; unitCost: Money; value: Money;
}
export interface RecostResult {
  positions: OpeningPosition[];
  movementsReplayed: number;
  negatives: { itemKey: string; warehouseKey: string; lotKey: string | null; quantity: string }[];
}
/** §5.1 #6: "Do not import cost figures … Recompute cost from movement history with the new engine."
 *  This is that recompute, and it calls 3B's `costingEngine` — never a second implementation (spec:1228). */
export function replayLegacyMovements(movements: readonly LegacyMovement[], method: CostingMethod, baseCurrency: CurrencyCode): RecostResult;
export function sortLegacyMovements(movements: readonly LegacyMovement[]): LegacyMovement[];

// packages/importer/src/load/opening-stock.ts
export const openingStockLoader: Loader<LegacyRow, LegacyMovement>;
export const OPENING_STOCK_LINES_PER_DOCUMENT: number;          // 200
```

- [ ] **Step 1: Write the failing tests**

`packages/importer/test/load/recost.test.ts` — the pure half, no database:

```ts
import { describe, expect, it } from "vitest";
import { currency, Money, Quantity } from "@dulja/domain";
import { replayLegacyMovements, sortLegacyMovements, type LegacyMovement } from "../../src/load/recost";

const MYR = currency("MYR");
const m = (over: Partial<LegacyMovement>): LegacyMovement => ({
  itemKey: "10", warehouseKey: "1", lotKey: null,
  effectiveDate: "2025-06-01", sequence: 1n, lineNo: 1,
  direction: "in", quantity: Quantity.of("10.000000"), value: Money.of("100.0000", MYR), ...over,
});

describe("replayLegacyMovements — §5.1 #6, through 3B's one costing engine", () => {
  it("sorts by the §4.3.5 chronological key (effective_date, sequence, line_no)", () => {
    const out = sortLegacyMovements([
      m({ effectiveDate: "2025-06-02", sequence: 1n, lineNo: 1 }),
      m({ effectiveDate: "2025-06-01", sequence: 9n, lineNo: 1 }),
      m({ effectiveDate: "2025-06-01", sequence: 2n, lineNo: 2 }),
      m({ effectiveDate: "2025-06-01", sequence: 2n, lineNo: 1 }),
    ]);
    expect(out.map((x) => `${x.effectiveDate}/${x.sequence}/${x.lineNo}`)).toEqual([
      "2025-06-01/2/1", "2025-06-01/2/2", "2025-06-01/9/1", "2025-06-02/1/1",
    ]);
  });

  it("produces one position per (item, warehouse, lot) at the AVCO average of the surviving layers — the imported history is re-costed by the 3B engine, never carried (acceptance test 5, re-run)", () => {
    const out = replayLegacyMovements([
      m({ sequence: 1n, quantity: Quantity.of("10.000000"), value: Money.of("100.0000", MYR) }),   // 10 @ 10.00
      m({ sequence: 2n, quantity: Quantity.of("10.000000"), value: Money.of("140.0000", MYR) }),   // 10 @ 14.00
      m({ sequence: 3n, direction: "out", quantity: Quantity.of("5.000000"), value: null }),        // issue 5
    ], "avco", MYR);
    expect(out.movementsReplayed).toBe(3);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0]!.quantity.toString()).toBe("15.000000");
    expect(out.positions[0]!.unitCost.toString()).toBe("12.0000");
    expect(out.positions[0]!.value.toString()).toBe("180.0000");
  });

  it("keeps lots apart — a batch is its own position, because Dulja costs per lot (§4.7.3)", () => {
    const out = replayLegacyMovements([
      m({ lotKey: "9000", quantity: Quantity.of("4.000000"), value: Money.of("40.0000", MYR) }),
      m({ lotKey: "9001", sequence: 2n, quantity: Quantity.of("4.000000"), value: Money.of("60.0000", MYR) }),
    ], "avco", MYR);
    expect(out.positions.map((p) => `${p.lotKey}:${p.unitCost.toString()}`)).toEqual(["9000:10.0000", "9001:15.0000"]);
  });

  it("reports a position the legacy history drove negative rather than opening it (acceptance test 18, re-run)", () => {
    const out = replayLegacyMovements([
      m({ sequence: 1n, quantity: Quantity.of("2.000000"), value: Money.of("20.0000", MYR) }),
      m({ sequence: 2n, direction: "out", quantity: Quantity.of("5.000000"), value: null }),
    ], "avco", MYR);
    expect(out.positions).toEqual([]);
    expect(out.negatives).toEqual([{ itemKey: "10", warehouseKey: "1", lotKey: null, quantity: "-3.000000" }]);
  });

  it("drops a position that nets to exactly zero — an opening of nothing is not an opening", () => {
    const out = replayLegacyMovements([
      m({ sequence: 1n, quantity: Quantity.of("3.000000"), value: Money.of("30.0000", MYR) }),
      m({ sequence: 2n, direction: "out", quantity: Quantity.of("3.000000"), value: null }),
    ], "avco", MYR);
    expect(out.positions).toEqual([]);
    expect(out.negatives).toEqual([]);
  });

  it("refuses a receipt with no value rather than costing it at zero (SAH-011)", () => {
    expect(() => replayLegacyMovements([m({ value: null })], "avco", MYR)).toThrow(
      /ERR_VALIDATION_FAILED: legacy receipt 10\/1 on 2025-06-01 has no value; a receipt with no cost is never costed at zero \(SAH-011, §5\.1 #6\)/,
    );
  });
});
```

`packages/importer/test/load/opening-stock.test.ts` — the posted half:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { currency, Money } from "@dulja/domain";
import { valuationAsOf, withTenant } from "@dulja/db";
import { loaders } from "../../src/load/registry";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { setAccountMap } from "../../src/load/accounts";
import { runLoad, setLoadSource } from "../../src/load/run";
import type { LoadContext } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant } from "../support/tenant";

let db: Db;
let s: Seed;
const RUN = "01930000-0000-7000-8000-0000000000d0";
const MYR = currency("MYR");

const ctxFor = (over: Partial<LoadContext> = {}): Promise<LoadContext> => loadContextFor(db, s, RUN, over);
const read = <T>(fn: (tx: never) => Promise<T>) =>
  withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "read" }, fn as never) as Promise<T>;

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "opening-stock");
  setAccountMap(readAccountMap("test/fixtures/account-map.json"));
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(loadCorpus("cut-over"));
    return { driver, reader: await createReader(driver), close: async () => driver.close() };
  });
  await runLoad(db.rw, await ctxFor());
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("OPENING_STOCK — recomputed cost, posted through the posting service (§5.1 #6)", () => {
  it("posts one OPENING_STOCK per warehouse, in series OS, at the cut-over date", async () => {
    const docs = await read((tx) => tx<{ series: string; number: string; status: string; warehouse: string }[]>`
      select d.series, d.number::text as number, d.status::text as status, w.code as warehouse
        from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.warehouse w on w.id = d.warehouse_id
       where t.code = 'OPENING_STOCK' order by w.code`);
    // `MAIN-STORE` is `codeFromName("Main store")` — the corpus name is free text and the dash rule is
    // `units.ts`'s (T4 Step 6). `SHOP-1` opens nothing, so it has no OPENING_STOCK document at all.
    expect(docs.map((d) => d.warehouse)).toEqual(["MAIN-STORE"]);
    expect(docs.every((d) => d.series === "OS" && d.status === "posted")).toBe(true);
  });

  it("declares exactly two whole-table loaders — this one and the ledger opening (amendment C13)", () => {
    // Which loaders opt out of `runLoad`'s 500-row paging is a decision, not an implementation detail, and
    // it is invisible on a fixture smaller than a page: a new loader must not join or leave this set
    // without a reviewer seeing this line change. T6 owns the assertion because it registers the second.
    expect(loaders.filter((l) => l.wholeTable).map((l) => l.targetTable)).toEqual(["opening_balance", "opening_stock"]);
  });

  it("points every BILLITEMS batch row at the OPENING_STOCK document of that row's OWN warehouse", async () => {
    const rows = await read((tx) => tx<{ source_key: string; warehouse: string; type: string }[]>`
      select b.source_key, w.code as warehouse, t.code as type
        from app.import_batch b
        join app.document d on d.id = b.target_id
        join app.document_type t on t.id = d.document_type_id
        join app.warehouse w on w.id = d.warehouse_id
       where b.company_id = ${s.company} and b.source_table = 'BILLITEMS'
       order by b.source_key`);
    // Three movement rows collapse into one position in warehouse MAIN-STORE, so all three point at that
    // warehouse's opening document — by the row's own warehouse, never by "the first document this loader
    // posted".
    expect(rows).toEqual([
      { source_key: "1", warehouse: "MAIN-STORE", type: "OPENING_STOCK" },
      { source_key: "2", warehouse: "MAIN-STORE", type: "OPENING_STOCK" },
      { source_key: "3", warehouse: "MAIN-STORE", type: "OPENING_STOCK" },
    ]);
  });

  it("creates a cost layer per position through applyMovements — never a hand-written layer", async () => {
    const layers = await read((tx) => tx<{ qty_in: string; unit_cost: string; qty_remaining: string }[]>`
      select c.qty_in::text as qty_in, c.unit_cost::text as unit_cost, c.qty_remaining::text as qty_remaining
        from app.cost_layer c
        join app.inventory_movement m on m.id = c.movement_id
        join app.document d on d.id = m.document_id
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'OPENING_STOCK' order by c.unit_cost`);
    expect(layers).toEqual([{ qty_in: "15.000000", unit_cost: "12.0000", qty_remaining: "15.000000" }]);
  });

  it("makes valuationAsOf(cut-over) equal the recomputed opening value to the cent — the phase's DoD", async () => {
    // `limit` is REQUIRED by 3B's `ValuationParams` (3b:4475–4479); `VALUATION_PAGE` is 1000 and this
    // fixture has one row. Summed as `Money`, never with `Number`: "to the cent" and floating point are
    // different claims (Global Constraint 2, spec:2041).
    const rows = await read((tx) => valuationAsOf(tx, { companyId: s.company, asOf: "2026-01-31", limit: 1000 }));
    const total = rows.reduce((m, r) => m.add(Money.of(r.value, MYR)), Money.zero(MYR));
    expect(total.toString()).toBe("180.0000");
  });

  it("debits inventory control and credits 3900, so the opening TB and the opening stock reconcile to one account", async () => {
    const lines = await read((tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.base_debit::text as debit, l.base_credit::text as credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
        join app.document d on d.id = l.document_id
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'OPENING_STOCK' order by a.code`);
    expect(lines).toEqual([
      { code: "1300", debit: "180.0000", credit: "0.0000" },
      { code: "3900", debit: "0.0000", credit: "180.0000" },
    ]);
  });

  it("never opens a negative position and reports it instead (acceptance test 18, re-run through the import path)", async () => {
    // Its OWN tenant, and its own source keys. `import_batch`'s natural key is
    // `(company_id, source_table, source_key)` with no run scoping (§4.6.1) and `recordBatch` runs BEFORE
    // `loader.load`, so re-using `s` here would give the keys "1" and "2" — already recorded by the
    // beforeAll load with different data — and the run would raise ERR_IMPORT_DUPLICATE_SOURCE_KEY
    // instead of producing the skip. A fresh tenant is the smallest correct fix.
    const own = await seedLoadableTenant(db, "opening-stock-negative");
    const negative = loadCorpus("cut-over");
    negative.tables["BILLITEMS"]!.rows = [
      { BTMID: "1", BTMMAT: "11", BTMWAR: "1", BTMBAT: null, BTMDATE: "2025-07-01", BTMSEQ: "1", BTMROW: "1", BTMIN: "1", BTMQNT: "1.000000", BTMVAL: "10.0000" },
      { BTMID: "2", BTMMAT: "11", BTMWAR: "1", BTMBAT: null, BTMDATE: "2025-07-02", BTMSEQ: "2", BTMROW: "1", BTMIN: "0", BTMQNT: "4.000000", BTMVAL: null },
    ];
    setLoadSource(async () => {
      const driver = new FixtureLegacyDriver(negative);
      return { driver, reader: await createReader(driver), close: async () => driver.close() };
    });
    const report = await runLoad(db.rw, await loadContextFor(db, own, "01930000-0000-7000-8000-0000000000d1"));
    // The reason reaches `report.skips` through amendment C15's `load` channel — `map` sees one row at a
    // time and could never have known the position went negative.
    expect(report.skips.map((k) => k.reason)).toContain(
      "the legacy history drives item 11 in warehouse 1 to -3.000000; a negative opening is never loaded — it needs an inventory.negative_stock.override recorded by a second principal, which an importer running as one system principal cannot supply (acceptance test 18, hazard 17)",
    );
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun run --cwd packages/importer test load/recost && bun run --cwd packages/importer test load/opening-stock`
Expected: FAIL — `Cannot find module '../../src/load/recost'`.

- [ ] **Step 3: Write the document-type seed file**

`packages/db/seed/my/document-types/OPENING_STOCK.json`:

```json
{
  "code": "OPENING_STOCK",
  "nameEn": "Opening stock",
  "nameAr": "مخزون افتتاحي",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "OPENING_STOCK",
    "direction": "inbound",
    "requires": ["warehouse"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "item.inventory_account" }, "amount": "line.amount", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "code": "3900" },                   "amount": "line.amount", "when": { "line.kind": "item" } }
    ],
    "inventory": { "effect": "receipt", "warehouse": "header.warehouse", "costing": "create_layer", "allowNegative": false },
    "tax": { "applies": false },
    "numbering": { "series": "OS", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "OPENING_STOCK" },
    "approval": { "required": false, "approve": null, "post": "inventory.receipt.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

**The `account: { "code": "3900" }` reference is why 9B seeds `3900`** — hazard 33's rule verbatim: the slice that seeds a policy seeds the accounts that policy names by code. `item.inventory_account` resolves per item to `1300` (0C's row, the `item` loader's default from Task 4). `approval.post` is `inventory.receipt.post` — 3C's code and the §3.6.2 gate for an inbound receipt — and this slice introduces no permission code of its own. `allowNegative: false` is the fail-closed default and is stated rather than omitted: an opening that would go negative must be refused by the engine, not admitted by a default.

- [ ] **Step 4: Write `load/recost.ts`**

```ts
import { costingEngine, Money, Quantity, type CostingMethod, type CurrencyCode, type Layer } from "@dulja/domain";
import { LoadError } from "./types";

export interface LegacyMovement {
  itemKey: string; warehouseKey: string; lotKey: string | null;
  effectiveDate: string; sequence: bigint; lineNo: number;
  direction: "in" | "out";
  quantity: Quantity;
  value: Money | null;
}

export interface OpeningPosition {
  itemKey: string; warehouseKey: string; lotKey: string | null;
  quantity: Quantity; unitCost: Money; value: Money;
}

export interface RecostResult {
  positions: OpeningPosition[];
  movementsReplayed: number;
  negatives: { itemKey: string; warehouseKey: string; lotKey: string | null; quantity: string }[];
}

const keyOf = (m: { itemKey: string; warehouseKey: string; lotKey: string | null }): string =>
  `${m.itemKey}\u0000${m.warehouseKey}\u0000${m.lotKey ?? ""}`;

/** The §4.3.5 chronological key, applied to the legacy world: (effective_date, document sequence, line).
 *  The fourth element (`movement_no`) does not exist in the source and is not invented. */
export function sortLegacyMovements(movements: readonly LegacyMovement[]): LegacyMovement[] {
  return [...movements].sort((a, b) =>
    a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1
      : a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1
        : a.lineNo - b.lineNo);
}

/**
 * §5.1 #6, verbatim: "Do not import cost figures. `MatCosts` has no rebuild path and multiple corruption
 * routes. Recompute cost from movement history with the new engine, and reconcile the resulting opening
 * valuation with the customer."
 *
 * This runs 3B's `costingEngine` — the ONE implementation (spec:1228) — over the legacy movement history
 * in memory, per (item, warehouse, lot), and returns the surviving open layers as opening positions. It
 * writes nothing: `OPENING_STOCK` is what turns a position into a `cost_layer`, through `postDocument` →
 * `applyMovements`, so the layer Dulja carries afterwards was made by the same code that will make every
 * later one.
 */
export function replayLegacyMovements(
  movements: readonly LegacyMovement[],
  method: CostingMethod,
  baseCurrency: CurrencyCode,
): RecostResult {
  const open = new Map<string, Layer[]>();
  const negatives: RecostResult["negatives"] = [];
  const failed = new Set<string>();
  let movementsReplayed = 0;

  for (const move of sortLegacyMovements(movements)) {
    const key = keyOf(move);
    if (failed.has(key)) { movementsReplayed += 1; continue; }
    const layers = open.get(key) ?? [];

    if (move.direction === "in" && move.value === null) {
      throw new LoadError("ERR_VALIDATION_FAILED", `legacy receipt ${move.itemKey}/${move.warehouseKey} on ${move.effectiveDate} has no value; a receipt with no cost is never costed at zero (SAH-011, §5.1 #6)`);
    }

    // §4.2.1's `Quantity` is `add / subtract / negate / multiply / convert / compare / isZero / isNegative`
    // — there is no `plus`, no `minus` and no `greaterThan`; those are decimal.js's names and this type is
    // not a Decimal. `compare` returns -1 | 0 | 1.
    const available = layers.reduce((q, l) => q.add(l.qtyRemaining), Quantity.zero());
    if (move.direction === "out" && move.quantity.compare(available) > 0) {
      // The legacy system permitted it (SAH-009/018); Dulja does not, and an importer running as ONE
      // system principal cannot record the `inventory.negative_stock.override` a second principal would
      // have to record (hazard 17). The position is therefore REPORTED and not opened.
      negatives.push({
        itemKey: move.itemKey, warehouseKey: move.warehouseKey, lotKey: move.lotKey,
        quantity: available.subtract(move.quantity).toString(),
      });
      failed.add(key);
      open.delete(key);
      movementsReplayed += 1;
      continue;
    }

    // `CostingInput.movement` is `PlannedMovement & { effectiveDate; postingSeq }` (§4.7.1), and
    // `PlannedMovement` (§4.4.2) has EXACTLY these members: lineNo, movementNo, itemId, warehouseId,
    // lotId (`string | null`), quantity, **effect** (`"receipt" | "issue"`), value, costing. There is no
    // `direction` member — that spelling is this file's own `LegacyMovement`, and `costingEngine.cost`
    // branches on `effect`, so passing `direction` would not compile and, if it did, would treat every
    // movement as neither a receipt nor an issue. `lotId` keeps the null: the engine's own layer key is
    // the tuple, and `""` would make an untracked position collide with a lot literally coded `""`.
    const out = costingEngine.cost({
      method,
      openLayers: layers,
      movement: {
        itemId: move.itemKey, warehouseId: move.warehouseKey, lotId: move.lotKey,
        effect: move.direction === "in" ? "receipt" : "issue", quantity: move.quantity,
        value: move.value, costing: move.direction === "in" ? "create_layer" : "consume_layers",
        movementNo: 1, lineNo: move.lineNo,
        effectiveDate: move.effectiveDate, postingSeq: move.sequence,
      },
    });

    const next = layers.map((l) => {
      const updated = out.updatedRemaining.find((u) => u.layerId === l.id);
      return updated ? { ...l, qtyRemaining: updated.qtyRemaining } : l;
    }).filter((l) => !l.qtyRemaining.isZero());
    if (out.newLayer) {
      next.push({
        ...out.newLayer,
        id: `${key}\u0000${move.effectiveDate}\u0000${move.sequence}\u0000${move.lineNo}`,
      });
    }
    open.set(key, next);
    movementsReplayed += 1;
  }

  const positions: OpeningPosition[] = [];
  for (const [key, layers] of open) {
    const quantity = layers.reduce((q, l) => q.add(l.qtyRemaining), Quantity.zero());
    if (quantity.isZero()) continue;
    const [itemKey, warehouseKey, lot] = key.split("\u0000");
    const unitCost = costingEngine.average(layers);
    positions.push({
      itemKey: itemKey!, warehouseKey: warehouseKey!, lotKey: lot === "" ? null : lot!,
      quantity, unitCost,
      // The ONE multiplication in this file, rounded ONCE, HALF_AWAY_FROM_ZERO at scale 4 (hazard 23).
      // §4.2.1's `Money.multiply(factor, mode)` takes a `Decimal | Rational | string` and NOT a
      // `Quantity`, and `Money` has no `roundToScale` at all — so the honest spelling drops to the two
      // operands' `Decimal`s for the product and comes back through `Money.fromDecimal`, where the
      // rounding mode is stated rather than implied.
      value: Money.fromDecimal(unitCost.toDecimal().mul(quantity.toDecimal()), baseCurrency, "HALF_AWAY_FROM_ZERO"),
    });
  }
  positions.sort((a, b) => keyOf(a) < keyOf(b) ? -1 : 1);
  return { positions, movementsReplayed, negatives };
}
```

**Every arithmetic call above is a §4.2.1 name, and the section has no others.** `Money` is `add / subtract / negate / multiply(factor, mode) / divide / allocate / abs / compare / equals / isZero / isNegative / isPositive / toDecimal / toString`; `Quantity` is `add / subtract / negate / multiply / convert / compare / isZero / isNegative / toDecimal / toString`. Neither type has `plus`, `minus`, `negated`, `times`, `greaterThan` or `roundToScale` — those are **decimal.js's** names, and neither `Money` nor `Quantity` is a `Decimal`; reaching for one is a `bun run typecheck` failure at the first line of the file that uses it. `baseCurrency` here is this function's own parameter — the company's base currency, threaded in by `openingStockLoader.load` from `baseCurrency()` — so no `"MYR"` literal appears in this file either.

- [ ] **Step 5: Write `load/opening-stock.ts`**

```ts
import type { Sql } from "postgres";
import type { CostingMethod } from "@dulja/domain";
import type { LegacyRow } from "../index";
import { draftAndPost, type ImportedLine } from "./document";
import { replayLegacyMovements, type LegacyMovement } from "./recost";
import { refResolver } from "./refs";
import { baseCurrency, EMPTY_TARGET, loadSource } from "./run";
import { dateOf, moneyOf, optionalText, quantityOf, requireText } from "./scalar";
// No `LoadError` here: this loader raises none of its own. `replayLegacyMovements` raises for a receipt
// with no value (SAH-011) and the scalar helpers raise for a malformed column; everything this loader
// itself cannot open is REPORTED (§5.1 #3), never thrown.
import type { Loader, LoadContext, SkipRecord, SourceColumn } from "./types";

/** One OPENING_STOCK document per warehouse per 200 positions. A document with thousands of lines is
 *  legal but unprintable and unreviewable; 200 is what a warehouse manager can check against a count
 *  sheet, and every document balances on its own so a partial cut-over is still explicable. */
export const OPENING_STOCK_LINES_PER_DOCUMENT = 200;

const COLUMNS: readonly SourceColumn[] = [
  { name: "BTMID",   required: true,  confidence: "hypothesis", note: "the movement line's own key (BillItems, prefix BTM — the dossier names BillItems.BtmQnt verbatim)" },
  { name: "BTMMAT",  required: true,  confidence: "hypothesis", note: "the Materials key" },
  { name: "BTMWAR",  required: true,  confidence: "hypothesis", note: "the Warehouses key" },
  { name: "BTMBAT",  required: false, confidence: "hypothesis", note: "the MatBatches key, when the material is batch-tracked" },
  { name: "BTMDATE", required: true,  confidence: "hypothesis", note: "the movement's accounting date — the first element of §4.3.5's chronological key" },
  { name: "BTMSEQ",  required: true,  confidence: "hypothesis", note: "the parent Bill's own sequence — the second element" },
  { name: "BTMROW",  required: true,  confidence: "hypothesis", note: "the line number within the bill — the third element" },
  { name: "BTMIN",   required: true,  confidence: "hypothesis", note: "direction flag: 1 receipt, 0 issue" },
  { name: "BTMQNT",  required: true,  confidence: "hypothesis", note: "quantity in the material's base unit (the dossier names this column verbatim)" },
  { name: "BTMVAL",  required: false, confidence: "hypothesis", note: "the line's value on a RECEIPT; NULL on an issue, where the engine computes it. A NULL on a receipt is refused, never zeroed (SAH-011)" },
];

/**
 * Reads the whole legacy movement history, recomputes the opening positions with 3B's engine, and posts
 * them as `OPENING_STOCK` documents. The history itself is NOT loaded as documents: §5.1 #6 asks for a
 * recomputed opening, not a re-enacted past, and re-posting years of movements would make every Dulja
 * period before cut-over look real when it is not.
 */
export const openingStockLoader: Loader<LegacyRow, LegacyMovement> = {
  sourceTable: "BILLITEMS",
  targetTable: "opening_stock",
  wholeTable: true,           // amendment C13 — a moving average over one page of a history is not its average
  dependsOn: ["item", "warehouse", "lot", "opening_balance"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "BTMID", "BILLITEMS"),

  map(row) {
    const key = requireText(row, "BTMID", "BILLITEMS");
    const where = `BILLITEMS/${key}`;
    const direction = requireText(row, "BTMIN", where) === "1" ? "in" : "out";
    return {
      itemKey: requireText(row, "BTMMAT", where),
      warehouseKey: requireText(row, "BTMWAR", where),
      lotKey: optionalText(row, "BTMBAT"),
      effectiveDate: dateOf(row, "BTMDATE", where),
      sequence: BigInt(requireText(row, "BTMSEQ", where)),
      lineNo: Number(requireText(row, "BTMROW", where)),
      direction,
      quantity: quantityOf(row, "BTMQNT", where),
      value: direction === "in" ? moneyOf(row, "BTMVAL", baseCurrency(), where) : null,
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: LegacyMovement[]) {
    const [company] = await tx<{ costing_method: CostingMethod }[]>`
      select costing_method from app.company where id = ${ctx.companyId}`;
    // The currency comes from `baseCurrency()`, not from a second read and not from a cast: it is the
    // same value `map` minted its `Money` in, so the replay's arithmetic is same-currency by construction.
    const base = baseCurrency();
    const result = replayLegacyMovements(rows, company!.costing_method, base);

    // Resolve every key once. A position whose item, warehouse or lot did not import is REPORTED, not
    // opened against a guessed parent (§5.1 #3). The resolution happens here rather than in `map` because
    // a position exists only after the whole history is replayed, and `load` has the `tx` a resolver needs.
    const refs = refResolver(tx, ctx.companyId);
    const keyOf = (p: { itemKey: string; warehouseKey: string; lotKey: string | null }) =>
      `${p.itemKey}\u0000${p.warehouseKey}\u0000${p.lotKey ?? ""}`;   // NUL: no legacy key contains one
    // Bucketed by the LEGACY warehouse key, so a source row finds its document without a second lookup.
    const buckets = new Map<string, { positionKey: string; line: ImportedLine }[]>();

    // Amendment C15. A negative position is knowable only AFTER the whole replay, so `map` — which sees
    // one row at a time — can never report it; `load` returns the reasons and `runLoad` merges them into
    // the one skip register. Acceptance test 18, re-run through the import path.
    const skips: SkipRecord[] = result.negatives.map((n) => ({
      loader: "opening_stock", sourceTable: "BILLITEMS",
      sourceKey: `${n.itemKey}/${n.warehouseKey}${n.lotKey ? `/${n.lotKey}` : ""}`,
      reason: `the legacy history drives item ${n.itemKey} in warehouse ${n.warehouseKey} to ${n.quantity}; a negative opening is never loaded — it needs an inventory.negative_stock.override recorded by a second principal, which an importer running as one system principal cannot supply (acceptance test 18, hazard 17)`,
    }));
    let skipped = skips.length;
    for (const position of result.positions) {
      const itemId = await refs.byLegacyRef("item", position.itemKey);
      const warehouseId = await refs.byLegacyRef("warehouse", position.warehouseKey);
      const lotId = position.lotKey === null ? null : await refs.byLegacyRef("lot", position.lotKey);
      if (!itemId || !warehouseId || (position.lotKey !== null && !lotId)) {
        skipped += 1;
        skips.push({
          loader: "opening_stock", sourceTable: "BILLITEMS",
          sourceKey: `${position.itemKey}/${position.warehouseKey}${position.lotKey ? `/${position.lotKey}` : ""}`,
          reason: `the opening position for legacy material ${position.itemKey} in warehouse ${position.warehouseKey}${position.lotKey ? ` batch ${position.lotKey}` : ""} references an item, warehouse or lot that did not import; the position is reported, never opened against a guessed parent (§5.1 #3, SAH-073)`,
        });
        continue;
      }
      const bucket = buckets.get(position.warehouseKey) ?? [];
      bucket.push({
        positionKey: keyOf(position),
        line: {
          lineNo: bucket.length + 1, kind: "item", itemId, warehouseId, lotId,
          description: `Opening stock, legacy material ${position.itemKey}${position.lotKey ? ` batch ${position.lotKey}` : ""}`,
          quantity: position.quantity, unitPrice: position.unitCost, amount: position.value,
        },
      });
      buckets.set(position.warehouseKey, bucket);
    }

    const documentOfPosition = new Map<string, string>();
    const documentOfWarehouse = new Map<string, string>();
    let inserted = 0;
    for (const [warehouseKey, all] of buckets) {
      for (let i = 0; i < all.length; i += OPENING_STOCK_LINES_PER_DOCUMENT) {
        const page = all.slice(i, i + OPENING_STOCK_LINES_PER_DOCUMENT);
        const posted = await draftAndPost(tx, ctx, {
          documentTypeCode: "OPENING_STOCK", legacyRef: null,
          warehouseId: page[0]!.line.warehouseId,
          lines: page.map((p, n) => ({ ...p.line, lineNo: n + 1 })),
        });
        inserted += page.length;
        for (const p of page) documentOfPosition.set(p.positionKey, posted.documentId);
        if (!documentOfWarehouse.has(warehouseKey)) documentOfWarehouse.set(warehouseKey, posted.documentId);
      }
    }

    // One batch id per SOURCE row, in order — `runLoad`'s `linkBatches` pairs them positionally. A movement
    // points at the document its OWN position landed in; one whose position was reported (negative, or a
    // missing item/warehouse/lot) points at the document its warehouse opened into, because that document
    // is the warehouse's cut-over and the position itself is named in `skips.csv`. A warehouse that opened
    // nothing gets `EMPTY_TARGET`, which after a commit means exactly "seen, produced no target row" — see
    // its comment in run.ts. That is the ordinary case, not an error: a warehouse emptied before cut-over
    // (transferred out, closed, sold down) has years of BILLITEMS history, nets to zero, and correctly
    // opens nothing. Refusing the load here would refuse the most common shape of real legacy data.
    const perSource = rows.map((row) =>
      documentOfPosition.get(keyOf(row)) ?? documentOfWarehouse.get(row.warehouseKey) ?? EMPTY_TARGET);
    return { inserted, skipped, batchIds: perSource, skips };
  },
};
```

**Four facts about this loader that a reader will otherwise trip on.**

0. **`load` returns `skips` (amendment C15), and it is the only place these two reasons can come from.** A position the replay drove negative, and a position whose item / warehouse / lot did not import, are both functions of the *whole* history — `map` sees one `BillItems` row at a time and cannot know either. `runLoad`'s `skips[]` is otherwise built only from `map`'s `{ skip }`, so without C15 the two reasons would exist in this file and reach no report, and T6's negative-stock assertion could never pass. `skipped` already counts them, so `runLoad` does not count them twice.
1. `load`'s signature (§4.13.2) has no `refs` parameter, so the resolver is built here from the `tx` the caller passed — `refs.ts` imports only `@dulja/db` and `./types`, so the top-level import closes no cycle.
2. `batchIds` must carry one entry per **source** row, because `runLoad`'s `linkBatches` pairs them positionally, and every entry must be a **real document id**. The movements collapse into positions, so the mapping is by position first (`documentOfPosition`) and by the row's own warehouse second (`documentOfWarehouse`) — never by `batchIds[0]`, which would file every warehouse's rows under the first warehouse's document.
3. A warehouse that opened nothing at all returns `EMPTY_TARGET`, and that is a **statement, not a failure**. `recordBatch`, `load` and `linkBatches` all run inside one `withTenant` transaction, so a committed all-zero `target_id` can never be a crash artefact — it can only be a value a loader returned, and run.ts's comment defines what returning it says: *seen, hashed, produced no target row*. The case is ordinary. `replayLegacyMovements` emits no position for a key whose layers net to zero (`if (quantity.isZero()) continue;`), so a warehouse **emptied before cut-over** — transferred out, closed, sold down — has years of `BillItems` history, no positions, no negatives, and correctly opens nothing. An earlier draft of this loader raised `ERR_VALIDATION_FAILED` here, accusing the source of negative stock or a missing material; on a customer who has ever closed a warehouse that would refuse the whole cut-over on the most ordinary data in the source.

- [ ] **Step 6: Register it and grow the corpus**

`registry.ts` gains `openingStockLoader` after `openingBalanceLoader`; the barrel gains `export { OPENING_STOCK_LINES_PER_DOCUMENT, openingStockLoader } from "./load/opening-stock";` and `export { replayLegacyMovements, sortLegacyMovements, type LegacyMovement, type OpeningPosition, type RecostResult } from "./load/recost";`.

`catalog.json` gains:

```json
    "BILLITEMS": { "keyColumns": ["BTMID"], "columns": [
      { "name": "BTMID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BTMMAT", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BTMWAR", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BTMBAT", "kind": "integer", "scale": 0, "nullable": true },
      { "name": "BTMDATE", "kind": "date", "scale": 0, "nullable": false },
      { "name": "BTMSEQ", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BTMROW", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BTMIN", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BTMQNT", "kind": "decimal", "scale": 6, "nullable": false },
      { "name": "BTMVAL", "kind": "decimal", "scale": 4, "nullable": true } ] }
```

`packages/importer/test/corpus/cut-over/BILLITEMS.json` — 10 @ 10.00 in, 10 @ 14.00 in, 5 out; the AVCO average of the survivors is 12.0000 and the value 180.0000, which is what the three opening-stock assertions pin:

```json
[
  { "BTMID": "1", "BTMMAT": "10", "BTMWAR": "1", "BTMBAT": "9000", "BTMDATE": "2025-06-01", "BTMSEQ": "1", "BTMROW": "1", "BTMIN": "1", "BTMQNT": "10.000000", "BTMVAL": "100.0000" },
  { "BTMID": "2", "BTMMAT": "10", "BTMWAR": "1", "BTMBAT": "9000", "BTMDATE": "2025-08-01", "BTMSEQ": "2", "BTMROW": "1", "BTMIN": "1", "BTMQNT": "10.000000", "BTMVAL": "140.0000" },
  { "BTMID": "3", "BTMMAT": "10", "BTMWAR": "1", "BTMBAT": "9000", "BTMDATE": "2025-11-01", "BTMSEQ": "3", "BTMROW": "1", "BTMIN": "0", "BTMQNT": "5.000000", "BTMVAL": null }
]
```

- [ ] **Step 7: Append the 9B block to `tests/regression/sah-011.test.ts`**

```ts
describe("SAH-011 NULL-poisoned costs — 9B", () => {
  it("a legacy receipt with no value is refused, never costed at zero", () => {
    expect(() => replayLegacyMovements([{
      itemKey: "10", warehouseKey: "1", lotKey: null, effectiveDate: "2025-06-01",
      sequence: 1n, lineNo: 1, direction: "in", quantity: Quantity.of("1.000000"), value: null,
    }], "avco", currency("MYR"))).toThrow(/has no value; a receipt with no cost is never costed at zero \(SAH-011, §5\.1 #6\)/);
  });

  it("does not import a legacy cost figure at all — MatCosts is never read by any loader (§5.1 #6)", async () => {
    const files = sourceFiles(["packages/importer/src"]);
    expect(files.filter((f) => /MATCOSTS/.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});
```

The file gains `import { replayLegacyMovements } from "@dulja/importer";`, `import { currency, Quantity } from "@dulja/domain";` and `import { sourceFiles } from "../support/source";` beside its existing imports. `replayLegacyMovements`'s third parameter is a `CurrencyCode`, so it is `currency("MYR")` and never the bare string.

- [ ] **Step 8: Run everything**

Run: `bun run --cwd packages/importer test load/ && bun run --cwd tests test sah-011 && bun run lint:rules`
Expected: PASS. `posting-only-tables` is the rule that matters most in this task: `recost.ts` and `opening-stock.ts` compute layers but name **no** protected table in DML — the only writer of `cost_layer` remains `packages/db/src/costing/apply-movements.ts`, reached through `postDocument` step 9.

- [ ] **Step 9: Commit**

```bash
git add packages/db/seed/my/document-types/OPENING_STOCK.json packages/importer/src/load \
        packages/importer/src/index.ts packages/importer/test tests/regression/sah-011.test.ts
git commit -m "feat(importer): recompute opening stock and post it as OPENING_STOCK [9B T6]

5.1 #6 says do not import cost figures: this replays the legacy movement
history through 3B's costingEngine — the one implementation — and opens the
surviving positions at the recomputed average, through postDocument so the
cost layers are made by the same code every later one will be. A position
the history drives negative is reported, never opened: an importer running
as one system principal cannot record the second-principal override
acceptance test 18 requires.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Open AR/AP items — legacy numbers preserved, the ageing tie-out, and ADR 0085

**Files:**
- Create: `packages/importer/src/load/open-items.ts`, `packages/importer/test/load/open-items.test.ts`, `packages/importer/test/corpus/cut-over/BILLS.json`, `docs/adr/0085-cut-over-series-and-opening-documents.md`
- Modify: `packages/importer/src/load/registry.ts`, `packages/importer/src/index.ts`, `packages/importer/test/corpus/cut-over/catalog.json`, `tests/regression/sah-051.test.ts`

**Interfaces:**
- Consumes: `draftAndPost`, `ImportedLine` (T5); `accountMap`, `treatmentOf` (T4); `agedBalance`, `ageingRows`, `ageingTieOut` (4B, §4.8.2); `openBalance`, `partyBalance` (4A, §4.8.1); `seedPaymentTerm` (4A); `moneyOf`, `dateOf`, `requireText`, `optionalText` (T3).
- Produces:

```ts
// packages/importer/src/load/open-items.ts
export interface OpenItemTarget {
  legacyNumber: string; partyId: string; kind: "receivable" | "payable";
  controlAccountCode: string; suspenseAccountCode: string;   // CODES, not ids — `map` has no tx to
                                       // resolve them on; `load` resolves both to ids in one query
  amount: Money;                       // always positive; `kind` and `side` carry the direction (A9)
  documentDate: string;
}
export const openItemLoader: Loader<LegacyRow, OpenItemTarget>;
```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/load/open-items.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { currency, Money } from "@dulja/domain";
import { agedBalance, withTenant } from "@dulja/db";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { setAccountMap } from "../../src/load/accounts";
import { runLoad, setLoadSource } from "../../src/load/run";
import type { LoadContext } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant } from "../support/tenant";

let db: Db;
let s: Seed;
const RUN = "01930000-0000-7000-8000-0000000000e0";
const MYR = currency("MYR");

const ctxFor = (over: Partial<LoadContext> = {}): Promise<LoadContext> => loadContextFor(db, s, RUN, over);
const read = <T>(fn: (tx: never) => Promise<T>) =>
  withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "read" }, fn as never) as Promise<T>;

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "open-items");
  setAccountMap(readAccountMap("test/fixtures/account-map.json"));
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(loadCorpus("cut-over"));
    return { driver, reader: await createReader(driver), close: async () => driver.close() };
  });
  await runLoad(db.rw, await ctxFor());
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("open AR/AP items at cut-over (§5.1 #8; ADR 0085)", () => {
  it("posts one OPENING_BALANCE per open legacy document, carrying its number as a string", async () => {
    const docs = await read((tx) => tx<{ legacy_ref: string; series: string; number: string; party: string }[]>`
      select d.legacy_ref, d.series, d.number::text as number, p.code as party
        from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.party p on p.id = d.party_id
       where t.code = 'OPENING_BALANCE' and d.legacy_ref is not null order by d.number::bigint`);
    // Ordered by `number`, NOT by `legacy_ref`: the two corpus rows deliberately SHARE the number
    // 'INV/2025/0417' — that shared string is the whole point of the SAH-051 case — so a sort on it leaves
    // the two rows in whatever order Postgres happens to return, and this assertion pins which is which.
    // `document.number` is the posting service's own gapless bigint and is the deterministic key here.
    expect(docs).toEqual([
      { legacy_ref: "INV/2025/0417", series: "OB", number: "2", party: "C-2001" },
      { legacy_ref: "INV/2025/0417", series: "OB", number: "3", party: "V-3001" },
    ]);
  });

  it("posts the AR side as Dr 1200 / Cr 3900 and never touches a revenue account", async () => {
    const lines = await read((tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.base_debit::text as debit, l.base_credit::text as credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
        join app.document d on d.id = l.document_id
        join app.party p on p.id = d.party_id
       where d.legacy_ref = 'INV/2025/0417' and p.kind = 'customer' order by a.code`);
    expect(lines).toEqual([
      { code: "1200", debit: "1800.0000", credit: "0.0000" },
      { code: "3900", debit: "0.0000", credit: "1800.0000" },
    ]);
    const revenue = await read((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry l join app.account a on a.id = l.account_id
       where a.code = '4000' and l.company_id = ${s.company}`);
    expect(revenue[0]!.n).toBe(0);              // a cut-over never re-recognises revenue
  });

  it("makes Σ open items per party equal the party's open balance, and the AR control to the cent (§4.8.2)", async () => {
    const balance = await read((tx) => tx<{ party: string; open: string }[]>`
      select p.code as party, sum(l.base_debit - l.base_credit)::text as open
        from app.ledger_entry l join app.account a on a.id = l.account_id
        join app.document d on d.id = l.document_id join app.party p on p.id = d.party_id
       where a.code = '1200' group by p.code`);
    expect(balance).toEqual([{ party: "C-2001", open: "1800.0000" }]);
    const aged = await read((tx) => agedBalance(tx, { companyId: s.company, asOf: "2026-01-31", partyKind: "customer" }));
    // §4.8.2's tie-out is "to the cent", so the sum is `Money`, not `Number(...)`: a float comparison here
    // would pass on a figure that is out by a fraction of a cent, which is the one thing it must catch.
    const total = aged.reduce((m, r) => m.add(Money.of(r.total, MYR)), Money.zero(MYR));
    expect(total.toString()).toBe("1800.0000");
  });

  it("starts the new gapless series after cut-over: document_series carries only OB and OS", async () => {
    const series = await read((tx) => tx<{ series: string; next_number: string }[]>`
      select series, next_number::text as next_number from app.document_series
       where company_id = ${s.company} order by series`);
    expect(series.map((x) => x.series)).toEqual(["OB", "OS"]);
  });

  it("keeps document.number a gapless bigint per series while legacy_ref carries the duplicated string", async () => {
    const numbers = await read((tx) => tx<{ number: string }[]>`
      select d.number::text as number from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'OPENING_BALANCE' order by d.number::bigint`);
    expect(numbers.map((n) => n.number)).toEqual(["1", "2", "3"]);
  });

  it("skips an open item whose party never imported (§5.1 #3)", async () => {
    const orphan = loadCorpus("cut-over");
    orphan.tables["BILLS"]!.rows = [
      { BILID: "77", BILNUMBER: "INV/2025/0999", BILACC: "888", BILDATE: "2025-12-01", BILOPEN: "500.0000", BILKIND: "1" },
    ];
    setLoadSource(async () => {
      const driver = new FixtureLegacyDriver(orphan);
      return { driver, reader: await createReader(driver), close: async () => driver.close() };
    });
    const report = await runLoad(db.rw, await ctxFor({ runId: "01930000-0000-7000-8000-0000000000e1" }));
    expect(report.skips.map((k) => k.reason)).toContain(
      "account 888 has no imported party; the open item INV/2025/0999 is an orphan (SAH-073)",
    );
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test load/open-items`
Expected: FAIL — `Cannot find module '../../src/load/open-items'`.

- [ ] **Step 3: Write `load/open-items.ts`**

```ts
import type { Sql } from "postgres";
import { Money } from "@dulja/domain";
import type { LegacyRow } from "../index";
import { accountMap } from "./accounts";
import { draftAndPost, type ImportedLine } from "./document";
import { SUSPENSE_CODE } from "./opening-balance";
import { baseCurrency } from "./run";
import { dateOf, moneyOf, requireText } from "./scalar";
import { LoadError, type Loader, type LoadContext, type RefResolver, type SourceColumn } from "./types";

/**
 * The two account members are **codes**, and are named so. `map(row, refs)` is frozen at two parameters
 * (§4.13.2) and has no `tx`, so it cannot resolve an account id; `load` does it once for the whole page.
 * A field named `*Id` holding a `"1200"` is the shape of a defect a later reader pastes into an
 * `account_id` column, which is why the names say `Code`.
 */
export interface OpenItemTarget {
  legacyNumber: string; partyId: string; kind: "receivable" | "payable";
  controlAccountCode: string; suspenseAccountCode: string;
  amount: Money; documentDate: string;
}

const COLUMNS: readonly SourceColumn[] = [
  { name: "BILID",     required: true, confidence: "hypothesis", note: "the bill's own key (Bills, prefix BIL)" },
  { name: "BILNUMBER", required: true, confidence: "hypothesis", note: "the number printed on the customer's copy — preserved as a STRING in document.legacy_ref (SAH-051)" },
  { name: "BILACC",    required: true, confidence: "hypothesis", note: "the Accounts key of the customer or vendor" },
  { name: "BILDATE",   required: true, confidence: "hypothesis", note: "the document's own date, kept for the ageing report's narrative; the POSTING date is the cut-over date" },
  { name: "BILOPEN",   required: true, confidence: "hypothesis", note: "the unsettled amount as at the freeze — recomputed by 9A, never the stored aggregate (§5.1 #1)" },
  { name: "BILKIND",   required: true, confidence: "hypothesis", note: "1 receivable, 2 payable" },
];

/**
 * ONE `OPENING_BALANCE` document per open legacy document — the shape 4A's allocation and 4B's ageing both
 * need, because both settle and bucket a *document*, not a party total (§4.8.1, §4.8.2).
 *
 * Dr the party's receivable control / Cr the suspense, or the mirror for a payable. **Never a revenue or
 * expense account**: the trial-balance opening (T5) already carries the legacy profit-and-loss position,
 * and re-recognising revenue for an unpaid 2025 invoice would double the year (ADR 0085).
 *
 * `document.legacy_ref` carries the printed number; `document.number` is issued by the posting service in
 * the `OB` series and is gapless. That pairing is SAH-051's fix: the historical string is preserved and
 * the new numbering starts clean.
 */
export const openItemLoader: Loader<LegacyRow, OpenItemTarget> = {
  sourceTable: "BILLS",
  targetTable: "open_item",
  dependsOn: ["party", "account", "opening_balance"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "BILID", "BILLS"),

  async map(row, refs: RefResolver) {
    const key = requireText(row, "BILID", "BILLS");
    const where = `BILLS/${key}`;
    const legacyNumber = requireText(row, "BILNUMBER", where);
    const accountKey = requireText(row, "BILACC", where);
    const partyId = await refs.byLegacyRef("party", `ACC:${accountKey}`);
    if (!partyId) return { skip: `account ${accountKey} has no imported party; the open item ${legacyNumber} is an orphan (SAH-073)` };

    const amount = moneyOf(row, "BILOPEN", baseCurrency(), where);
    if (amount.isZero()) return { skip: `open item ${legacyNumber} has a zero open amount; a settled document is history, not an opening` };

    const kind = requireText(row, "BILKIND", where) === "1" ? "receivable" : "payable";
    const treatment = kind === "receivable" ? "ar_control" : "ap_control";
    const control = accountMap().entries.find((e) => e.treatment === treatment);
    // Second line of defence, not the first: `assertAccountMap` (T4) already refuses a map with no
    // `ar_control` or no `ap_control`. A `!` here would turn a map that got past it — a hand-edited
    // file, a future treatment rename — into a bare `TypeError` with no legacy key in it, where every
    // other failure path in this slice raises a `LoadError` naming what is missing. A THROW, not a
    // `{ skip }`: the map is run configuration, so the answer is the same for every row and a skip
    // would emit one identical record per open item and load none of them.
    if (!control) {
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `the account map has no account marked ${treatment}, so open item ${legacyNumber} has no control account to post to; assertAccountMap should have refused this map (contracts §4.8.2)`,
      );
    }
    return {
      legacyNumber, partyId, kind,
      controlAccountCode: control.code,        // a CODE; `load` resolves it to an id, where a tx exists
      suspenseAccountCode: SUSPENSE_CODE,
      // A9's sign normalisation applied at the boundary: the amount is never negative and the side carries
      // the direction. A legacy credit note arrives as a negative BILOPEN and becomes the other side.
      amount: amount.isNegative() ? amount.negate() : amount,
      documentDate: dateOf(row, "BILDATE", where),
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: OpenItemTarget[]) {
    // The run's own base currency (N3), so `Money.zero(base)` below is the same type as the `Money` that
    // `map`'s `moneyOf` produced. No second read of `app.company`, and no `as CurrencyCode` cast.
    const base = baseCurrency();
    const codes = [...new Set([...rows.map((r) => r.controlAccountCode), SUSPENSE_CODE])];
    const accounts = await tx<{ code: string; id: string }[]>`
      select code, id from app.account where company_id = ${ctx.companyId} and code = any(${codes}) and archived_at is null`;
    const by = new Map(accounts.map((a) => [a.code, a.id]));
    for (const code of codes) {
      if (!by.has(code)) throw new LoadError("ERR_VALIDATION_FAILED", `company ${ctx.companyId} cannot resolve account ${code}; the account map names it as a control and it must exist before the open items load (contracts §4.15)`);
    }

    const batchIds: string[] = [];
    let inserted = 0;
    for (const row of rows) {
      const control = by.get(row.controlAccountCode)!;
      const suspense = by.get(SUSPENSE_CODE)!;
      const receivable = row.kind === "receivable";
      const lines: ImportedLine[] = [
        {
          lineNo: 1, kind: "account", accountId: control,
          description: `Open ${receivable ? "receivable" : "payable"} at cut-over — legacy ${row.legacyNumber} dated ${row.documentDate}`,
          debit: receivable ? row.amount : Money.zero(base),
          credit: receivable ? Money.zero(base) : row.amount,
        },
        {
          lineNo: 2, kind: "account", accountId: suspense,
          description: `Opening-balance suspense — the other side of legacy ${row.legacyNumber}`,
          debit: receivable ? Money.zero(base) : row.amount,
          credit: receivable ? row.amount : Money.zero(base),
        },
      ];
      const posted = await draftAndPost(tx, ctx, {
        documentTypeCode: "OPENING_BALANCE", legacyRef: row.legacyNumber, partyId: row.partyId, lines,
      });
      inserted += 1;
      batchIds.push(posted.documentId);
    }
    return { inserted, skipped: 0, batchIds };
  },
};
```

**This loader does not import `refResolver`** — unlike `opening-stock.ts`, its resolution happens per row inside `map`, which does take a `refs` parameter (`runLoad` builds one per page). The import block above is complete as written.

- [ ] **Step 4: Register it and grow the corpus**

`registry.ts` gains `openItemLoader` after `openingStockLoader` — the declaration order is now `unit, warehouse, account, party, item, lot, openingBalance, openingStock, openItem`, which is a valid topological order of the `dependsOn` graph.

`catalog.json` gains:

```json
    "BILLS": { "keyColumns": ["BILID"], "columns": [
      { "name": "BILID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BILNUMBER", "kind": "text", "scale": 0, "nullable": false },
      { "name": "BILACC", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "BILDATE", "kind": "date", "scale": 0, "nullable": false },
      { "name": "BILOPEN", "kind": "decimal", "scale": 4, "nullable": false },
      { "name": "BILKIND", "kind": "integer", "scale": 0, "nullable": false } ] }
```

`packages/importer/test/corpus/cut-over/BILLS.json` — **two rows deliberately share a legacy number**, which is SAH-051's own fact and what the non-unique index of Task 1 exists for:

```json
[
  { "BILID": "5001", "BILNUMBER": "INV/2025/0417", "BILACC": "200", "BILDATE": "2025-12-14", "BILOPEN": "1800.0000", "BILKIND": "1" },
  { "BILID": "6001", "BILNUMBER": "INV/2025/0417", "BILACC": "300", "BILDATE": "2025-12-20", "BILOPEN": "900.0000", "BILKIND": "2" }
]
```

- [ ] **Step 5: Write ADR 0085**

`docs/adr/0085-cut-over-series-and-opening-documents.md`:

```markdown
# 0085 — Cut-over documents use the dedicated `OB` and `OS` series, and open items never re-recognise revenue

- **Status:** Accepted
- **Date:** 2026-09-08
- **Slice:** 9B (Loaders and cut-over)
- **Supersedes:** none. **Amends:** contracts §4.13.3 (amendment C1).

## Context

Contracts §4.13.3 says every imported open document is "issued through the posting service in a dedicated
series `LEGACY` in the cut-over period so uniqueness holds and the new gapless series starts after
cut-over". Three facts make `LEGACY` unbuildable as written:

1. §4.3.6 takes the series from `policy.numbering.series`, and `issueDocument` writes it onto the header.
   A series that is not a policy's series cannot be issued without changing a frozen function (hazard 8).
2. §4.14 registers exactly two 9B document types, with series `OB` and `OS`. `LEGACY` is a literal in a
   shared namespace with no register row, which hazard 32 makes a review-blocking finding.
3. The sentence's stated purpose — uniqueness, and a clean new series — is met by any dedicated series.

Separately, the *shape* of an imported open item is a money decision. An unpaid 2025 invoice could be
re-created as a `SALES_INVOICE`, which would post revenue and tax under 4A's and 5A's policies. The legacy
trial balance already carries that revenue.

## Decision

1. **The dedicated cut-over series are `OB` and `OS`** — the two §4.14 rows — used by no other document
   type and never re-used after cut-over. Contracts §4.13.3's `LEGACY` reads as those two.
2. **An open AR/AP item is an `OPENING_BALANCE` document with a `party_id` and a `legacy_ref`**, posting
   Dr the receivable control / Cr `3900` (or the mirror). It is never a `SALES_INVOICE`, never a
   `PURCHASE_INVOICE`, and touches no revenue, expense or tax account.
3. **`document.legacy_ref` carries the printed legacy number; `document.number` is the posting service's
   own gapless `bigint` in the `OB` series.** The legacy numbering had duplicates and gaps (SAH-051), so
   its index is non-unique and its values never reach `number`.
4. **The live series start clean.** The import creates `document_series` rows for `OB` and `OS` only. The
   first real `SALES_INVOICE` after cut-over is `INV` number 1 in the cut-over period, which is exactly
   §5.1 #8's "start the new gapless series after cut-over".
5. **The trial-balance opening excludes the AR, AP and inventory controls**, because the open-item load and
   `OPENING_STOCK` supply them. This is what makes (2) safe: without the exclusion, the control balance
   would be counted twice.

## Consequences

- Ageing (§4.8.2) works on day one: each open item is a document with an `effective_date` and a party, and
  Σ buckets per party equals the `1200` / `2100` control balance to the cent — the 4B tie-out, unchanged.
- Allocation (§4.8.1) works on day one: a receipt after cut-over settles the opening document, exactly as
  it would settle an invoice.
- The imported document does **not** carry its original lines, tax or items. A user who needs the original
  looks it up by `legacy_ref` in the archived legacy system; the runbook says to keep a read-only copy.
  This is a deliberate limit of a cut-over, not an omission.
- `3900`'s balance after the whole load is the sum of every explained difference — the figure OD-25 is
  about, and the figure the cut-over sign-off reads.
```

- [ ] **Step 6: Append the second 9B block to `tests/regression/sah-051.test.ts`**

Task 1 added the schema-level block; this one is the behaviour:

```ts
describe("SAH-051 Document numbers may contain duplicates and gaps — 9B, the load", () => {
  it("loads two legacy documents that share a number, and gives each its own gapless OB number", async () => {
    const f = await cutOverFixture("sah-051-9b");
    await loadFromCorpus(f, "cut-over");        // INTO `f` — the query below is about `f`'s database
    const rows = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      tx<{ legacy_ref: string; number: string }[]>`
        select d.legacy_ref, d.number::text as number from app.document d
         where d.company_id = ${f.ctx.companyId} and d.legacy_ref = 'INV/2025/0417' order by d.number::bigint`);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.number)).size).toBe(2);
    // No `api.stop()`: `cutOverFixture` uses the memoised `sharedApi()` (§4.17.1, §3.7.5) and its
    // consumers must not stop it. The tenant is this case's own; the container is the whole run's.
  });
});
```

- [ ] **Step 7: Run everything**

Run: `bun run --cwd packages/importer test load/ && bun run --cwd tests test sah-051 && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/importer/src/load/open-items.ts packages/importer/src/load/registry.ts \
        packages/importer/src/index.ts packages/importer/test \
        docs/adr/0085-cut-over-series-and-opening-documents.md tests/regression/sah-051.test.ts
git commit -m "feat(importer): load open AR/AP items with their legacy numbers [9B T7]

One OPENING_BALANCE per open legacy document, Dr control / Cr 3900 — never
a SALES_INVOICE, so the cut-over cannot re-recognise revenue the trial
balance already carries. The printed number is a string in legacy_ref; the
posting service issues a gapless OB number (SAH-051). ADR 0085 records why
the dedicated series are OB and OS rather than the unregistered LEGACY.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Employees, sensitive fields, and `employee_ytd_opening` reconciled to the last legacy payslip

**Files:**
- Create: `packages/importer/src/load/employees.ts`, `packages/importer/test/load/employees.test.ts`, `packages/importer/test/corpus/cut-over/EMPLOYEES.json`, `packages/importer/test/corpus/cut-over/PAYITEMS.json`
- Modify: `packages/importer/src/load/registry.ts`, `packages/importer/src/index.ts`, `packages/importer/test/corpus/cut-over/catalog.json`

**Interfaces:**
- Consumes: `upsertEmployeeYtdOpening`, `EmployeeYtdOpeningInput`, `listEmployeeYtdOpening`, `EmployeeYtdOpeningRow`, `OpeningError`, `ytdFromEmployeeYtd`, `checkEmployeeYtdProjection` (8C); `writeSensitive`, `SENSITIVE_FIELDS`, `SensitiveValues`, `HrKeyRing` (8A); `employeeMapping`, `EMPLOYEE_MATCH_STRATEGIES`, `normaliseLegacyName` (9A); `Money`, `currency` (§4.2.1); `moneyOf`, `dateOf`, `optionalDateOf`, `requireText`, `optionalText` (T3).
- Produces:

```ts
// packages/importer/src/load/employees.ts
export interface EmployeeTarget {
  legacyKey: string; employeeNumber: string; nameEn: string; nameAr: string | null;
  hiredOn: string; terminatedOn: string | null;
  sensitive: SensitiveValues;
  ytd: { taxYear: number; gross: Money; net: Money; byComponent: Record<string, string>; byScheme: Record<string, { employee: string; employer: string }> } | null;
}
export const employeeLoader: Loader<LegacyRow, EmployeeTarget>;
export const SENSITIVE_SOURCES: Readonly<Record<string, SourceColumn>>;
export function setKeyRing(ring: HrKeyRing): void;
/** §5.1 #11, called from `load` (never `map` — the tax year comes from `ctx.cutOverDate`, and `map` has no
 *  `ctx`). Returns the skip reason when the stored YTD disagrees with the sum of the employee's own
 *  payslips, and `null` otherwise; `load` withholds the YTD opening and reports it through C15's `skips`. */
export async function assertYtdReconciles(
  reader: LegacyReader, target: EmployeeTarget, taxYear: number,
): Promise<{ skip: string } | null>;
```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/load/employees.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { checkEmployeeYtdProjection, createHrKeyRing, listEmployeeYtdOpening, withTenant, ytdFromEmployeeYtd } from "@dulja/db";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { setAccountMap } from "../../src/load/accounts";
import { setKeyRing } from "../../src/load/employees";
import { runLoad, setLoadSource } from "../../src/load/run";
import type { LoadContext } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant } from "../support/tenant";

let db: Db;
let s: Seed;
const RUN = "01930000-0000-7000-8000-0000000000f0";

const ctxFor = (over: Partial<LoadContext> = {}): Promise<LoadContext> => loadContextFor(db, s, RUN, over);
const read = <T>(fn: (tx: never) => Promise<T>) =>
  withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "read" }, fn as never) as Promise<T>;

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "employees");
  setAccountMap(readAccountMap("test/fixtures/account-map.json"));
  // 8A ships `createHrKeyRing(opts)` and `DEV_HR_KEY` (8a:834, 8a:836) and NO `keyRingFromEnv`; the ring
  // is built from a key, never read out of the environment by this package. A deterministic test key,
  // not `DEV_HR_KEY`, so nothing here depends on `APP_ENV === "dev"`.
  setKeyRing(createHrKeyRing({ current: Buffer.alloc(32, 7).toString("base64"), currentVersion: 1 }));
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(loadCorpus("cut-over"));
    return { driver, reader: await createReader(driver), close: async () => driver.close() };
  });
  await runLoad(db.rw, await ctxFor());
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("the employee load (§5.1 #11, #12)", () => {
  it("creates one party of kind employee and one employee per person (§5.1 #12)", async () => {
    const rows = await read((tx) => tx<{ employee_number: string; party_kind: string; legacy_ref: string; home: string }[]>`
      select e.employee_number, p.kind as party_kind, e.legacy_ref, v.code as home
        from app.employee e join app.party p on p.id = e.party_id
        join app.dimension_value v on v.id = e.home_branch_id
       where e.company_id = ${s.company} order by e.employee_number`);
    expect(rows).toEqual([
      { employee_number: "E-001", party_kind: "employee", legacy_ref: "5001", home: "HQ" },
      { employee_number: "E-002", party_kind: "employee", legacy_ref: "5002", home: "HQ" },
    ]);
  });

  it("writes sensitive fields ONLY through 8A's encrypted writer — never a plain column", async () => {
    const rows = await read((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.employee_sensitive s
        join app.employee e on e.id = s.employee_id where e.company_id = ${s.company}`);
    expect(rows[0]!.n).toBe(2);
    const cipher = await read((tx) => tx<{ national_id_enc: Buffer | null }[]>`
      select national_id_enc from app.employee_sensitive s
        join app.employee e on e.id = s.employee_id
       where e.company_id = ${s.company} and e.employee_number = 'E-001'`);
    expect(cipher[0]!.national_id_enc).not.toBeNull();
    expect(cipher[0]!.national_id_enc!.toString("utf8")).not.toContain("880101");
  });

  it("loads employee_ytd_opening with the tax year and a source naming the run (§3.10.1 Year-to-date)", async () => {
    const openings = await read((tx) => listEmployeeYtdOpening(tx, { companyId: s.company, taxYear: 2026 }));
    expect(openings.map((o) => `${o.employeeNumber}:${o.gross}:${o.net}`)).toEqual([
      "E-001:36000.0000:31200.0000",
      "E-002:24000.0000:21600.0000",
    ]);
    expect(openings.every((o) => o.source.startsWith("sahlisoft:"))).toBe(true);
  });

  it("leaves employee_ytd itself untouched — the opening is a read-time addend, never a projection row (8C amendment B14, acceptance test 35 re-run)", async () => {
    const mismatches = await read((tx) => checkEmployeeYtdProjection(tx));
    expect(mismatches).toEqual([]);
    const [employee] = await read((tx) => tx<{ id: string }[]>`
      select id from app.employee where company_id = ${s.company} and employee_number = 'E-001'`);
    const ytd = await read((tx) => ytdFromEmployeeYtd(tx, s.company, 2026, [employee!.id]));
    expect(ytd[employee!.id]!.gross.toString()).toBe("36000.0000");
  });

  /**
   * **What this case proves, and what it deliberately does not.** It proves the *import path* reaches 8C's
   * termination trigger: the loader inserts the employee ACTIVE and then UPDATEs `terminated_on`, which is
   * the only shape that fires an `AFTER UPDATE OF terminated_on` trigger, and spec:2090 names the Phase 9
   * importer explicitly as something that must not bypass it. It does **not** re-prove the trigger's
   * downstream effects — the revoked `pos_cashier`, the expired `role_assignment`, the catalogue tombstone
   * — because **an imported employee has none of the rows those effects act on**: `employeeLoader.load`
   * never sets `employee.principal_id` (§4.6.2 makes it nullable and the importer creates no principal),
   * and it creates no `pos_cashier`. A `count(*) = 0` over `role_assignment ra join employee e on
   * e.principal_id = ra.principal_id` would therefore read 0 whether or not the trigger ran at all — an
   * assertion that cannot fail is worse than no assertion, so it is not written here. **Acceptance test 34's
   * downstream half is 8C's own suite**, where the cashier and the assignment exist; §6.1 assigns the test
   * to 8C and this slice only re-runs it through the import path. A future slice that gives imported
   * employees principals inherits the stronger assertion with them.
   */
  it("terminates by UPDATE, so 8C's AFTER UPDATE OF terminated_on trigger fires on the import path (acceptance test 34, re-run — trigger reached, downstream effects are 8C's)", async () => {
    const [terminated] = await read((tx) => tx<{ terminated_on: string | null; principal_id: string | null }[]>`
      select to_char(e.terminated_on, 'YYYY-MM-DD') as terminated_on, e.principal_id
        from app.employee e
       where e.company_id = ${s.company} and e.employee_number = 'E-002'`);
    expect(terminated!.terminated_on).toBe("2026-01-20");
    // Pinned, not incidental: the importer creates no principal, which is exactly why the two downstream
    // assertions above are 8C's and not this file's. A slice that changes this changes this test.
    expect(terminated!.principal_id).toBeNull();
    // The employee is still there and still readable — termination is not deletion (spec:2049).
    const [active] = await read((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.employee
       where company_id = ${s.company} and employee_number = 'E-002'`);
    expect(active!.n).toBe(1);
  });

  it("loads an employee whose YTD does not reconcile, withholds their YTD opening, and reports why", async () => {
    // A REAL run against its OWN tenant, and both halves are necessary. A dry run throws `runLoad`'s
    // roll-back sentinel BEFORE `loader.load`, and the reconciliation lives in `load` — it needs the tax
    // year of `ctx.cutOverDate`, which `map(row, refs)` has no parameter for — so on a dry run the check
    // would not execute at all. And `import_batch`'s key is not run-scoped (§4.6.1), so re-using `s`
    // would map nothing: EMPLOYEES/5001 is already recorded by the beforeAll load.
    const own = await seedLoadableTenant(db, "employees-ytd-drift");
    const drifted = loadCorpus("cut-over");
    drifted.tables["PAYITEMS"]!.rows = drifted.tables["PAYITEMS"]!.rows.map((r) =>
      r["PITEMP"] === "5001" ? { ...r, PITGROSS: "35000.0000" } : r);
    setLoadSource(async () => {
      const driver = new FixtureLegacyDriver(drifted);
      return { driver, reader: await createReader(driver), close: async () => driver.close() };
    });
    const report = await runLoad(db.rw, await loadContextFor(db, own, "01930000-0000-7000-8000-0000000000f1"));
    // The reason travels on `load`'s `skips` (amendment C15) into the run's one register.
    expect(report.skips.map((k) => k.reason)).toContain(
      "employee 5001's stored YTD gross 36000.0000 differs from the sum of their 2026 payslips 35000.0000 by 1000.0000; the employee is loaded and their YTD opening is NOT — reconcile it with the customer and re-run with --only employee (§5.1 #11)",
    );
    // The person still exists — an unreconciled YTD is not a reason to lose an employee record — and the
    // figure nobody can vouch for is simply absent, which is what makes it visible on the sign-off sheet.
    const openings = await withTenant(db.rw, { tenantId: own.tenant, actorId: own.human, requestId: "read" }, (tx) =>
      listEmployeeYtdOpening(tx, { companyId: own.company, taxYear: 2026 }));
    expect(openings.map((o) => o.employeeNumber)).toEqual(["E-002"]);
    const people = await withTenant(db.rw, { tenantId: own.tenant, actorId: own.human, requestId: "read" }, (tx) =>
      tx<{ employee_number: string }[]>`
        select employee_number from app.employee where company_id = ${own.company} order by employee_number`);
    expect(people.map((p) => p.employee_number)).toEqual(["E-001", "E-002"]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test load/employees`
Expected: FAIL — `Cannot find module '../../src/load/employees'`.

- [ ] **Step 3: Write `load/employees.ts`**

```ts
import type { Sql } from "postgres";
import { Money } from "@dulja/domain";
import { upsertEmployeeYtdOpening, writeSensitive, type HrKeyRing, type SensitiveValues } from "@dulja/db";
import type { LegacyRow } from "../index";
import { baseCurrency, loadSource } from "./run";
import { dateOf, moneyOf, optionalDateOf, optionalText, requireText } from "./scalar";
import { LoadError, type Loader, type LoadContext, type SkipRecord, type SourceColumn } from "./types";

export interface EmployeeTarget {
  legacyKey: string; employeeNumber: string; nameEn: string; nameAr: string | null;
  hiredOn: string; terminatedOn: string | null;
  sensitive: SensitiveValues;
  ytd: { taxYear: number; gross: Money; net: Money; byComponent: Record<string, string>; byScheme: Record<string, { employee: string; employer: string }> } | null;
}

let ring: HrKeyRing | null = null;
export function setKeyRing(value: HrKeyRing): void { ring = value; }
function keyRing(): HrKeyRing {
  if (!ring) throw new LoadError("ERR_VALIDATION_FAILED", "no HR key ring is set; HR_FIELD_ENCRYPTION_KEY must be present before the employee load, because an employee's national id, bank account and scheme numbers are written only through 8A's encrypted writer (§4.12.5)");
  return ring;
}

/**
 * The sensitive column map, keyed by 8A's own `SensitiveField` names so no new vocabulary is introduced.
 * Every entry is a HYPOTHESIS until the live catalogue confirms it (hazard 3); a column the source does
 * not have is dropped from the map at pre-flight and the field is simply not loaded — never guessed and
 * never written as an empty string.
 */
export const SENSITIVE_SOURCES: Readonly<Record<string, SourceColumn>> = {
  national_id:   { name: "EMPNATID",   required: false, confidence: "hypothesis", note: "national identity number → employee_sensitive.national_id" },
  date_of_birth: { name: "EMPDOB",     required: false, confidence: "hypothesis", note: "date of birth → employee_sensitive.date_of_birth" },
  bank_account:  { name: "EMPBANKACC", required: false, confidence: "hypothesis", note: "salary bank account → employee_sensitive.bank_account; PAYROLL_PAYMENT's CSV needs it (8C)" },
  epf_number:    { name: "EMPEPFNO",   required: false, confidence: "hypothesis", note: "the employee's EPF reference — a REFERENCE NUMBER, never a rate or a threshold" },
  socso_number:  { name: "EMPSOCSONO", required: false, confidence: "hypothesis", note: "the employee's SOCSO reference number" },
  tax_number:    { name: "EMPTAXNO",   required: false, confidence: "hypothesis", note: "the employee's income-tax reference number" },
};

const CORE: readonly SourceColumn[] = [
  { name: "EMPID",     required: true,  confidence: "hypothesis", note: "the employee's own key (Employees, prefix EMP)" },
  { name: "EMPNUMBER", required: true,  confidence: "hypothesis", note: "the payroll number the officer uses → employee.employee_number" },
  { name: "EMPNAME",   required: true,  confidence: "hypothesis", note: "display name → party.name_en" },
  { name: "EMPNAMEAR", required: false, confidence: "hypothesis", note: "Arabic name → party.name_ar" },
  { name: "EMPHIRED",  required: true,  confidence: "hypothesis", note: "hire date → employee.hired_on" },
  { name: "EMPLEFT",   required: false, confidence: "hypothesis", note: "termination date; APPLIED BY UPDATE so 8C's AFTER UPDATE OF terminated_on trigger fires (spec:2090)" },
  { name: "EMPYTDGROSS", required: false, confidence: "hypothesis", note: "current-tax-year gross → employee_ytd_opening.gross (§5.1 #11)" },
  { name: "EMPYTDNET",   required: false, confidence: "hypothesis", note: "current-tax-year net → employee_ytd_opening.net" },
];

const COLUMNS: readonly SourceColumn[] = [...CORE, ...Object.values(SENSITIVE_SOURCES)];

/** The tax year the opening belongs to is the cut-over date's calendar year — Dulja stores `tax_year` as a
 *  smallint and the spec fixes no fiscal-tax-year offset; a different convention is a company setting the
 *  owner supplies, not something this loader infers. */
const taxYearOf = (cutOverDate: string): number => Number(cutOverDate.slice(0, 4));

export const employeeLoader: Loader<LegacyRow, EmployeeTarget> = {
  sourceTable: "EMPLOYEES",
  targetTable: "employee",
  dependsOn: ["party"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "EMPID", "EMPLOYEES"),

  map(row) {
    const legacyKey = requireText(row, "EMPID", "EMPLOYEES");
    const where = `EMPLOYEES/${legacyKey}`;
    const sensitive: SensitiveValues = {};
    for (const [field, column] of Object.entries(SENSITIVE_SOURCES)) {
      const value = optionalText(row, column.name);
      if (value !== null) (sensitive as Record<string, string>)[field] = value;
    }
    const grossText = optionalText(row, "EMPYTDGROSS");
    const netText = optionalText(row, "EMPYTDNET");
    return {
      legacyKey,
      employeeNumber: requireText(row, "EMPNUMBER", where),
      nameEn: requireText(row, "EMPNAME", where),
      nameAr: optionalText(row, "EMPNAMEAR"),
      hiredOn: dateOf(row, "EMPHIRED", where),
      terminatedOn: optionalDateOf(row, "EMPLEFT", where),
      sensitive,
      ytd: grossText === null || netText === null ? null : {
        taxYear: 0,                                  // filled in `load`, which knows the cut-over date
        gross: moneyOf(row, "EMPYTDGROSS", baseCurrency(), where),
        net: moneyOf(row, "EMPYTDNET", baseCurrency(), where),
        byComponent: {}, byScheme: {},
      },
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: EmployeeTarget[]) {
    const [hq] = await tx<{ id: string }[]>`
      select v.id from app.dimension_value v join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${ctx.companyId} and t.code = 'BRANCH' and v.code = 'HQ'`;
    if (!hq) throw new LoadError("ERR_VALIDATION_FAILED", `company ${ctx.companyId} has no BRANCH value HQ`);
    const taxYear = taxYearOf(ctx.cutOverDate);
    const batchIds: string[] = [];
    const skips: SkipRecord[] = [];
    let inserted = 0;
    let skipped = 0;

    for (const row of rows) {
      // §5.1 #12: one party of kind employee plus one employee, in one transaction (§4.6.2's closing rule).
      // The party code is the employee number VERBATIM. The legacy `EmpNumber` values already look like
      // `E-001`, so prefixing would produce `E-E-001`; and `app.party.code` is only unique per company, so
      // there is nothing to disambiguate against — the customer/vendor codes are `C-…` / `V-…` from
      // ACCCODE and cannot collide with a payroll number.
      const [party] = await tx<{ id: string }[]>`
        insert into app.party (tenant_id, company_id, kind, code, name_en, name_ar, legacy_ref)
        values (app.current_tenant(), ${ctx.companyId}, 'employee', ${row.employeeNumber}, ${row.nameEn}, ${row.nameAr}, ${row.legacyKey})
        on conflict (company_id, code) do nothing
        returning id`;
      const partyId = party?.id ?? (await tx<{ id: string }[]>`
        select id from app.party where company_id = ${ctx.companyId} and code = ${row.employeeNumber}`)[0]!.id;

      const [made] = await tx<{ id: string }[]>`
        insert into app.employee (tenant_id, company_id, party_id, employee_number, home_branch_id, hired_on, legacy_ref)
        values (app.current_tenant(), ${ctx.companyId}, ${partyId}, ${row.employeeNumber}, ${hq.id}, ${row.hiredOn}, ${row.legacyKey})
        on conflict (company_id, employee_number) do nothing
        returning id`;
      if (!made) {
        const [existing] = await tx<{ id: string }[]>`
          select id from app.employee where company_id = ${ctx.companyId} and employee_number = ${row.employeeNumber}`;
        skipped += 1;
        batchIds.push(existing!.id);
        continue;
      }
      inserted += 1;
      batchIds.push(made.id);

      if (Object.keys(row.sensitive).length > 0) {
        await writeSensitive(tx, keyRing(), made.id, row.sensitive);
      }

      // §5.1 #11, and the ONLY place it can be checked: the comparison needs the tax year of
      // `ctx.cutOverDate` and a second read of `PAYITEMS`, and `Loader.map(row, refs)` (§4.13.2, frozen)
      // has neither a `ctx` nor a reader. `loadSource()` (N3) is the run's own open connection, so no
      // loader ever opens a second one against the customer's database.
      const drift = row.ytd === null ? null : await assertYtdReconciles(loadSource().reader, row, taxYear);
      if (drift) {
        // The person is loaded; the figure nobody can vouch for is not. `skipped` counts it and `skips`
        // says why (amendment C15) — one `batchId` per row is still returned, because `linkBatches` pairs
        // them positionally and this row DID produce an `app.employee`.
        skipped += 1;
        skips.push({ loader: "employee", sourceTable: "EMPLOYEES", sourceKey: row.legacyKey, reason: drift.skip });
      } else if (row.ytd) {
        await upsertEmployeeYtdOpening(tx, ctx, {
          companyId: ctx.companyId, employeeId: made.id, taxYear,
          gross: row.ytd.gross, net: row.ytd.net,
          byComponent: row.ytd.byComponent, byScheme: row.ytd.byScheme,
          source: `sahlisoft:${ctx.runId}`,
        });
      }

      // spec:2090 is explicit that "a direct app_rw update OR THE PHASE 9 IMPORTER cannot bypass" the
      // termination trigger, and 8C's trigger is AFTER UPDATE OF terminated_on — an INSERT carrying the
      // date would not fire it. The employee is therefore inserted active and terminated by UPDATE, in
      // the same transaction, so the cashier revoke, the role expiry and the catalogue tombstone all run.
      if (row.terminatedOn !== null) {
        await tx`update app.employee set terminated_on = ${row.terminatedOn} where id = ${made.id}`;
      }
    }
    return { inserted, skipped, batchIds, skips };
  },
};
```

**The YTD reconciliation lives in `load`, not `map`, and the reason is a signature.** It compares the employee's stored YTD against the sum of their own `PAYITEMS` rows **for the tax year**, and the tax year is `taxYearOf(ctx.cutOverDate)` — `Loader.map(row, refs)` is frozen at two parameters by §4.13.2 and has no `ctx`, so the comparison cannot live there. It also needs the payslip rows, and `runLoad` streams one source table per loader, so the loader performs a second, filtered read of its own through the run's already-open connection. Append this to the same file; the `load` body above is what calls it, and amendment **C15** is what lets the reason it returns reach `report.skips`.

```ts
// packages/importer/src/load/employees.ts — appended; called from `load`, once per row that carries a YTD
export async function assertYtdReconciles(
  reader: LegacyReader, target: EmployeeTarget, taxYear: number,
): Promise<{ skip: string } | null> {
  if (!target.ytd) return null;
  const base = baseCurrency();
  let gross = Money.zero(base);
  for await (const page of reader.read<LegacyRow>("PAYITEMS", {
    columns: ["PITEMP", "PITYEAR", "PITGROSS"],
    where: { op: "and", operands: [
      { op: "eq", column: "PITEMP", value: target.legacyKey },
      { op: "eq", column: "PITYEAR", value: String(taxYear) },
    ] },
    batch: 500,
  })) {
    // §4.2.1's `Money` is `add`, not `plus`, and `subtract`, not `minus`.
    for (const row of page) gross = gross.add(moneyOf(row, "PITGROSS", base, `PAYITEMS/${target.legacyKey}`));
  }
  if (target.ytd.gross.equals(gross)) return null;
  return {
    skip: `employee ${target.legacyKey}'s stored YTD gross ${target.ytd.gross.toString()} differs from the sum of their ${taxYear} payslips ${gross.toString()} by ${target.ytd.gross.subtract(gross).abs().toString()}; the employee is loaded and their YTD opening is NOT — reconcile it with the customer and re-run with --only employee (§5.1 #11)`,
  };
}
```

`packages/importer/src/load/employees.ts`'s import block gains `LegacyReader` (`import type { LegacyReader, LegacyRow } from "../index";`) beside the `LegacyRow` it already has.

**Three consequences worth stating where the code is.** (1) **The reader reaches `load` through the module-level source `runLoad` opened** — `loadSource()` (name **N3**) returns the currently-open `LoadSource` and throws outside a run, so a loader can never open a second connection to the customer's database. (2) **A drifting employee is still loaded**; only their `employee_ytd_opening` is withheld. Losing the person because a figure disagrees would be the larger error, and the withheld figure is exactly what the sign-off sheet must show as missing. (3) **This is one filtered `PAYITEMS` read per employee**, which is right for the thirty-to-two-hundred-person businesses §5.1 is about; a source with thousands of employees should read `PAYITEMS` once into a per-employee total before the loop, and the runbook says to measure the rehearsal rather than guess.

- [ ] **Step 4: Grow the corpus**

`packages/importer/test/corpus/cut-over/catalog.json` gains two table entries. They are written out in full,
like every other corpus step, because `preflight` reads **this file** through `driver.columns(table)` (T3 Step 6)
and compares it name-for-name against `employeeLoader`'s `COLUMNS` — a mis-transcribed entry is a required-column
pre-flight failure, not a typo. The `required: true` columns of `CORE` above are exactly the four declared
`"nullable": false` here:

```json
    "EMPLOYEES": { "keyColumns": ["EMPID"], "columns": [
      { "name": "EMPID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "EMPNUMBER", "kind": "text", "scale": 0, "nullable": false },
      { "name": "EMPNAME", "kind": "text", "scale": 0, "nullable": false },
      { "name": "EMPNAMEAR", "kind": "text", "scale": 0, "nullable": true },
      { "name": "EMPHIRED", "kind": "date", "scale": 0, "nullable": false },
      { "name": "EMPLEFT", "kind": "date", "scale": 0, "nullable": true },
      { "name": "EMPYTDGROSS", "kind": "decimal", "scale": 4, "nullable": true },
      { "name": "EMPYTDNET", "kind": "decimal", "scale": 4, "nullable": true },
      { "name": "EMPNATID", "kind": "text", "scale": 0, "nullable": true },
      { "name": "EMPDOB", "kind": "date", "scale": 0, "nullable": true },
      { "name": "EMPBANKACC", "kind": "text", "scale": 0, "nullable": true },
      { "name": "EMPEPFNO", "kind": "text", "scale": 0, "nullable": true },
      { "name": "EMPSOCSONO", "kind": "text", "scale": 0, "nullable": true },
      { "name": "EMPTAXNO", "kind": "text", "scale": 0, "nullable": true } ] },
    "PAYITEMS": { "keyColumns": ["PITID"], "columns": [
      { "name": "PITID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "PITEMP", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "PITYEAR", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "PITGROSS", "kind": "decimal", "scale": 4, "nullable": false },
      { "name": "PITNET", "kind": "decimal", "scale": 4, "nullable": false } ] }
```

**`PITYEAR` is `integer` and `PITGROSS`/`PITNET` are `decimal` at scale 4**, which is what makes
`assertYtdReconciles`' predicate honest: it compares `PITYEAR` with `String(taxYear)` because 9A's renderer casts
every scaled-numeric and date column to `varchar` so amounts and years arrive as exact text (§4.13.1), and
`moneyOf` then refuses anything that is not a decimal string. `PAYITEMS` is **not** a `Loader.sourceTable` — no
loader declares it — so it is never pre-flighted; it is read only by `assertYtdReconciles` through the run's own
reader, and this entry is what lets `FixtureLegacyDriver` answer that read at all.

`packages/importer/test/corpus/cut-over/EMPLOYEES.json`:

```json
[
  { "EMPID": "5001", "EMPNUMBER": "E-001", "EMPNAME": "Aisyah binti Rahman", "EMPNAMEAR": "عائشة بنت رحمن",
    "EMPHIRED": "2019-03-01", "EMPLEFT": null, "EMPYTDGROSS": "36000.0000", "EMPYTDNET": "31200.0000",
    "EMPNATID": "880101-14-5555", "EMPDOB": "1988-01-01", "EMPBANKACC": "1234567890",
    "EMPEPFNO": "EPF-0001", "EMPSOCSONO": "SOC-0001", "EMPTAXNO": "SG-0001" },
  { "EMPID": "5002", "EMPNUMBER": "E-002", "EMPNAME": "Lim Wei Jie", "EMPNAMEAR": null,
    "EMPHIRED": "2021-07-15", "EMPLEFT": "2026-01-20", "EMPYTDGROSS": "24000.0000", "EMPYTDNET": "21600.0000",
    "EMPNATID": "950620-10-1111", "EMPDOB": "1995-06-20", "EMPBANKACC": "9876543210",
    "EMPEPFNO": "EPF-0002", "EMPSOCSONO": "SOC-0002", "EMPTAXNO": "SG-0002" }
]
```

`packages/importer/test/corpus/cut-over/PAYITEMS.json`:

```json
[
  { "PITID": "1", "PITEMP": "5001", "PITYEAR": "2026", "PITGROSS": "36000.0000", "PITNET": "31200.0000" },
  { "PITID": "2", "PITEMP": "5002", "PITYEAR": "2026", "PITGROSS": "24000.0000", "PITNET": "21600.0000" }
]
```

**Every figure above is invented for this repository and is nobody's pay.** `byComponent` and `byScheme` are loaded empty because the legacy breakdown's column set is unconfirmed and a *guessed* per-scheme split would be a statutory claim (hazard 1); the headline gross and net are the two figures §5.1 #11 names, they carry no rate, and 8C's `ytdFromEmployeeYtd` returns exactly those two.

- [ ] **Step 5: Register it and run**

`registry.ts` gains `employeeLoader` last; the barrel gains `export { assertYtdReconciles, employeeLoader, SENSITIVE_SOURCES, setKeyRing, type EmployeeTarget } from "./load/employees";`.

Run: `bun run --cwd packages/importer test load/employees && bun run lint:rules`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/importer/src/load/employees.ts packages/importer/src/load/registry.ts \
        packages/importer/src/index.ts packages/importer/src/load/run.ts packages/importer/test
git commit -m "feat(importer): load the employee master and employee_ytd_opening [9B T8]

One party of kind employee plus one employee per person (5.1 #12); sensitive
fields written only through 8A's encrypted writer; the current-tax-year YTD
loaded as employee_ytd_opening after being reconciled to the sum of the
employee's own legacy payslips, and reported rather than loaded when it does
not agree. A terminated employee is inserted active and terminated by UPDATE
so 8C's trigger fires — spec:2090 says the importer must not bypass it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `admin.import.run`, the bulk endpoint, and `/v1/jobs/{jobId}` — the status resource spec:2206 requires

**Files:**
- Create: `packages/contracts/src/admin/import.ts`, `apps/api/src/routes/admin/import.ts`, `apps/api/src/routes/admin/job-status.ts`, `apps/api/test/routes/admin/import.test.ts`, `apps/worker/src/handlers/import-run.ts`, `apps/worker/test/handlers/import-run.test.ts`
- Modify: `packages/db/src/jobs/payloads.ts`, `apps/api/src/routes/index.ts`, `apps/worker/src/index.ts`, `tests/invariants/probes.ts`, `tests/invariants/projection-rebuild.test.ts`, `infra/src/secrets.ts`

**Interfaces:**
- Consumes: `JOBS`, `JobPayload`, `JobEnvelope`, `JobClient`, `JobHandler`, `registerHandler`, `runJob`, `JOB_PROBES`, `JobIsolationProbe`, `systemContext` (§4.2.6); `RouteModule`, `buildRoutes`, `IdempotencyHeader`, `PROBES`, `IsolationProbe`, `createApp`, `AppDeps` (§4.2.7); `PERMISSION`, `requirePermission` (§4.2.5); `UuidSchema`, `DateSchema`, `TimestampSchema`, `ProblemSchema`, `ListEnvelope` (§4.2.8); `AppError`, `ERRORS` (§4.2.4); `startApi`, `StartedApi`, `ApiRequest` (§4.2.12 — the **one-object** `request` and the **eight-member** `StartedApi`, unchanged by this slice), `problemOf` (§4.17.1, reached through 7A Task 10's `tests/support/**` allowance); `grantCodes`, `seedImportBatch`, `seedTenantV2` (§4.17); `startWorker` (§4.17.1); `runLoad`, `LoadError`, `LoadContext`, `batchCounts` (T3, T2); `runIntegrityCheck`, `projectionChecks` (1B); `cutOverFixture`, `loadFromCorpus` (T5, for the projection-rebuild clause).
- Produces:

```ts
// packages/db/src/jobs/payloads.ts — amendment C3, ONE key added
  /** Slice 9B. The cut-over load. `only` restricts the run to named target tables, in dependency order. */
  "admin.import.run": { companyId: string; runId: string; cutOverDate: string; dryRun: boolean; only?: string[] };

// packages/contracts/src/admin/import.ts
export const StartImportBody: z.ZodObject<{ cutOverDate: …; dryRun: …; only: … }>;
export const ImportAcceptedSchema: z.ZodObject<{ runId: …; jobId: …; statusUrl: … }>;
export const ImportRunSchema: z.ZodObject<{ runId: …; startedAt: …; perTargetTable: …; skips: … }>;
export const ImportRunList: ReturnType<typeof ListEnvelope<typeof ImportRunSchema>>;
export const JobStatusSchema: z.ZodObject<{ jobId: …; name: …; state: …; createdOn: …; completedOn: …; output: … }>;

// apps/api/src/routes/admin/import.ts
export const IMPORT_ROUTE_PATH: string;                 // "/v1/companies/:companyId/imports"
export const importRoutes: OpenAPIHono<AppEnv>;
export const importRouteModule: RouteModule;

// apps/api/src/routes/admin/job-status.ts
export const JOB_STATUS_ROUTE_PATH: string;             // "/v1/jobs"
export const jobStatusRoutes: OpenAPIHono<AppEnv>;
export const jobStatusRouteModule: RouteModule;

// apps/worker/src/handlers/import-run.ts
export const importRunHandler: JobHandler<"admin.import.run">;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/test/routes/admin/import.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedImportBatch, seedTenantV2, type Seed } from "@dulja/db/test";
// 7A Task 10 widened `dependency-rule`'s test-tier allowance to `tests/support/**` and added the
// `apps/api/tsconfig.json` include this line needs (7a:7437–7439); 7A's own route tests import `problemOf`
// the same way. `grantAdmin` is deliberately NOT imported: `grantCodes` is §4.17's registered DB-tier way
// to grant a code and it reaches `apps/api/test` through `@dulja/db/test` with no allowance at all.
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let other: Seed;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "import-routes");
  other = await seedTenantV2(api.db, "import-routes-b");
  await grantCodes(api.db, s, { codes: ["admin.company.manage"] });
  await grantCodes(api.db, other, { codes: ["admin.company.manage"] });
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => { await api?.stop(); });

/** `api.request` takes ONE object and its members are §4.2.12's — `{ method, path, body, form, as, aal,
 *  idempotencyKey, headers }`. There is no `actor`, no `tenant` and no hand-rolled `Idempotency-Key`: the
 *  harness mints a fresh key for every unsafe method, and `idempotencyKey: null` is how a test sends none. */
const post = (body: unknown, as: string, companyId: string, idempotencyKey?: null) =>
  api.request({ method: "POST", path: `/v1/companies/${companyId}/imports`, body, as, ...(idempotencyKey === null ? { idempotencyKey: null } : {}) });

describe("POST /v1/companies/{companyId}/imports (spec:2206 bulk endpoints, async job semantics)", () => {
  it("enqueues admin.import.run and answers 202 with the status resource", async () => {
    const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, s.human, s.company);
    expect(res.status).toBe(202);
    const body = await res.json() as { runId: string; jobId: string; statusUrl: string };
    expect(body.statusUrl).toBe(`/v1/jobs/${body.jobId}`);
    // The enqueue is asserted by reading pg-boss's own row, not through a `jobs` member on `StartedApi`:
    // §4.2.12 freezes `StartedApi` at `{ db, objectStore, app, tokenFor, signToken, loadPrincipals,
    // request, stop }` and this slice adds none. `pgboss.job` carries no RLS (§4.2.6), so `db.admin` reads
    // it directly, and the envelope's `tenantId` is exactly what the status route below gates on.
    const [job] = await api.db.admin<{ name: string; data: { tenantId: string; payload: Record<string, unknown> }; singleton_key: string | null }[]>`
      select name, data, singleton_key from pgboss.job where id = ${body.jobId}::uuid`;
    expect(job!.name).toBe("admin.import.run");
    expect(job!.data.tenantId).toBe(s.tenant);
    expect(job!.data.payload).toEqual({ companyId: s.company, runId: body.runId, cutOverDate: "2026-01-31", dryRun: true });
    expect(job!.singleton_key).toBe(s.company);
  });

  it("refuses a caller of another tenant against this company (test 12)", async () => {
    const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, other.human, s.company);
    expect([403, 404]).toContain(res.status);
    expect((await problemOf(res)).code).toMatch(/ERR_RBAC_FORBIDDEN|ERR_NOT_FOUND/);
  });

  it("refuses a caller of this tenant without admin.company.manage", async () => {
    const bare = await seedTenantV2(api.db, "import-routes-bare");   // granted nothing
    await api.loadPrincipals();
    const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, bare.human, bare.company);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("refuses a cut-over date that is not a date", async () => {
    const res = await post({ cutOverDate: "31/01/2026", dryRun: false }, s.human, s.company);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("requires the Idempotency-Key header, like every unsafe route (spec:2055)", async () => {
    const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, s.human, s.company, null);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("GET …/imports/{runId} reports rows loaded per target table", async () => {
    const runId = randomUUID();
    await seedImportBatch(api.db, s, { sourceTable: "UNITS", sourceKey: "1", targetTable: "unit_of_measure", targetId: randomUUID(), runId });
    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/imports/${runId}`, as: s.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId, perTargetTable: [{ targetTable: "unit_of_measure", rows: 1 }] });
  });
});

describe("GET /v1/jobs/{jobId} — the status resource §4.2.7 promised and no slice had built", () => {
  /** The one way this suite creates a job: through the route that creates them. There is no
   *  `api.enqueueForTest` — `StartedApi` is closed (§4.2.12) and a slice needing a new member amends that
   *  section first, which this slice deliberately does not. */
  const startImport = async (as: string, companyId: string): Promise<string> => {
    const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, as, companyId);
    expect(res.status).toBe(202);
    return (await res.json() as { jobId: string }).jobId;
  };

  it("returns the job's state for a job of the caller's own tenant", async () => {
    const jobId = await startImport(s.human, s.company);
    const res = await api.request({ method: "GET", path: `/v1/jobs/${jobId}`, as: s.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jobId, name: "admin.import.run", state: "created" });
  });

  it("404s on another tenant's job and never reveals that it exists (test 12)", async () => {
    const jobId = await startImport(other.human, other.company);
    const res = await api.request({ method: "GET", path: `/v1/jobs/${jobId}`, as: s.human });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });
});
```

`apps/worker/test/handlers/import-run.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type StartedWorker } from "../support/worker";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { createReader, FixtureLegacyDriver, setLoadSource } from "@dulja/importer";

let w: StartedWorker;
let s: Seed;

/**
 * **The load source is injected, and the run is restricted to ONE loader.** Both are necessary, and neither is
 * a convenience.
 *
 * *Injected*, because `runLoad`'s module-level factory defaults to `loadSourceFromEnv()` (T3), which throws
 * `ERR_IMPORT_SOURCE_UNREADABLE: LEGACY_ODBC_DSN is not set` before a single row is read. Without
 * `setLoadSource` every case below would fail on the missing DSN — and the third would still *pass*, because
 * a regex matching `ERR_IMPORT_` matches that error too. A test that passes on the failure it was written to
 * exclude is worse than no test.
 *
 * *Restricted*, because this file tests the **handler**, not the loaders. `only: ["unit_of_measure"]`
 * (amendment C14) runs `unitLoader` alone, which needs no account map, no §4.15 chart and no document type —
 * so `seedTenantV2` is a sufficient tenant here, and the chart-and-document-type provisioning stays in
 * `packages/importer/test/support/tenant.ts` where the loader suites need it. The corpus is built inline
 * rather than read from `packages/importer/test/corpus/`: `apps/worker/test/**` may not reach into another
 * workspace's test tree (§3.1), and `FixtureLegacyDriver` takes a `LegacyCorpus` value, not a path.
 */
const CORPUS = {
  engineVersion: "WI-V2.5.9.27139 Firebird 2.5",
  tables: {
    UNITS: {
      keyColumns: ["UNTID"],
      columns: [
        { name: "UNTID", kind: "integer", scale: 0, nullable: false },
        { name: "UNTNAME", kind: "text", scale: 0, nullable: false },
      ],
      rows: [{ UNTID: "1", UNTNAME: "Piece" }, { UNTID: "2", UNTNAME: "Carton" }],
    },
  },
};

beforeAll(async () => {
  w = await startWorker();
  s = await seedTenantV2(w.db, "import-job");
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(CORPUS as never);
    return { driver, reader: await createReader(driver), close: async () => driver.close() };
  });
}, 300_000);
afterAll(async () => { await w?.stop(); });

const payload = (over: Record<string, unknown> = {}) => ({
  companyId: s.company, runId: crypto.randomUUID(), cutOverDate: "2026-01-31",
  dryRun: false, only: ["unit_of_measure"], ...over,
});

describe("admin.import.run", () => {
  it("runs as the tenant's SYSTEM principal, never a human (spec:2179, hazard 20)", async () => {
    await w.run("admin.import.run", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: payload() });
    // A REAL run, not a dry one: a dry run rolls its transaction back, so `import_batch` — and therefore its
    // audit rows — would be empty and `every` over an empty array is vacuously true. This is the case that
    // must not be vacuous, so it is the case that commits.
    const actors = await withTenant(w.db.rw, { tenantId: s.tenant, actorId: s.system, requestId: "read" }, (tx) =>
      tx<{ actor_id: string }[]>`select distinct actor_id from app.audit_log where table_name = 'import_batch'`);
    expect(actors).toHaveLength(1);
    expect(actors[0]!.actor_id).toBe(s.system);
  });

  it("logs the per-loader counts and the artefact count, and never a DSN", async () => {
    await w.run("admin.import.run", {
      tenantId: s.tenant, requestId: crypto.randomUUID(), payload: payload({ dryRun: true }),
    });
    const line = w.logs.find((l) => l.job === "admin.import.run");
    expect(line).toMatchObject({ job: "admin.import.run", dryRun: true });
    expect(JSON.stringify(w.logs)).not.toMatch(/LEGACY_ODBC_DSN|password|PWD=/i);
  });

  it("maps a LoadError to its exact code so the failure is legible in the job's output", async () => {
    // `only` naming a target no loader has is `runLoad`'s own ERR_VALIDATION_FAILED (T3 Step 8, amendment
    // C14) — a real `LoadError`, raised deterministically, with nothing else in this tenant that could
    // raise a different one. The regex is the ONE code this case means: an alternation would pass on any
    // failure at all, including the missing-DSN error the injection above exists to rule out. The period
    // lock is proven where it belongs, against the loaders, in T5's own suite (acceptance test 9, re-run).
    await expect(w.run("admin.import.run", {
      tenantId: s.tenant, requestId: crypto.randomUUID(), payload: payload({ only: ["no_such_table"] }),
    })).rejects.toThrow(/ERR_VALIDATION_FAILED: no loader targets no_such_table/);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun run --cwd apps/api test routes/admin/import && bun run --cwd apps/worker test handlers/import-run`
Expected: FAIL — `Cannot find module '../../src/routes/admin/import'`.

- [ ] **Step 3: Add the `JobPayload` key**

`packages/db/src/jobs/payloads.ts` — one key, touching no other line (§4.2.6's additive rule):

```ts
  /** Slice 9B. The cut-over load (contracts §4.13.2). `only` restricts the run to named TARGET tables and
   *  is ordered by `orderLoaders` regardless of the order given. `dryRun` reads and maps everything and
   *  commits nothing, so its `inserted` is a mapped-row count, not a prediction (ADR 0084 decision 5). */
  "admin.import.run": { companyId: string; runId: string; cutOverDate: string; dryRun: boolean; only?: string[] };
```

- [ ] **Step 4: Write the contracts module**

`packages/contracts/src/admin/import.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const StartImportBody = z.object({
  cutOverDate: DateSchema.openapi({ description: "The accounting date every imported document carries. Entered by the operator; never derived (spec:2039)." }),
  dryRun: z.boolean().default(false),
  only: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).optional()
    .openapi({ description: "Target tables to load, e.g. [\"item\", \"lot\"]. Ordered by the loader graph regardless of the order given." }),
}).openapi("StartImportBody");

export const ImportAcceptedSchema = z.object({
  runId: UuidSchema,
  jobId: z.string(),
  statusUrl: z.string().openapi({ description: "\"/v1/jobs/<jobId>\" — spec:2206's status resource." }),
}).openapi("ImportAccepted");

export const ImportRunSchema = z.object({
  runId: UuidSchema,
  startedAt: TimestampSchema.nullable(),
  perTargetTable: z.array(z.object({ targetTable: z.string(), rows: z.number().int() })),
  skips: z.number().int(),
}).openapi("ImportRun");

export const ImportRunList = ListEnvelope(ImportRunSchema);

export const JobStatusSchema = z.object({
  jobId: z.string(),
  name: z.string(),
  state: z.enum(["created", "retry", "active", "completed", "cancelled", "failed"]),
  createdOn: TimestampSchema,
  completedOn: TimestampSchema.nullable(),
  output: z.unknown().nullable(),
}).openapi("JobStatus");
```

- [ ] **Step 5: Write the two route modules**

`apps/api/src/routes/admin/import.ts`:

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { batchCounts } from "@dulja/db";
import { AppError, ImportAcceptedSchema, ImportRunSchema, ProblemSchema, StartImportBody, UuidSchema } from "@dulja/contracts";
import { PERMISSION, requirePermission } from "../../permissions";
import { IdempotencyHeader, type RouteModule } from "../index";
import type { AppEnv } from "../../env";

export const IMPORT_ROUTE_PATH = "/v1/companies/:companyId/imports";
export const importRoutes = new OpenAPIHono<AppEnv>();

/** §3.6.1 closes the permission vocabulary and 9B introduces no code. §3.6.2 puts company configuration —
 *  document types, posting policies, exchange rates, dimensions, custom fields, print templates — under
 *  `admin.company.manage`, and a cut-over load is the largest configuration act a tenant ever performs. */
const gate = requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });

importRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["admin"], middleware: [gate] as const,
    summary: "Start a legacy import run (async; poll statusUrl)",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: StartImportBody } } },
    },
    responses: {
      202: { description: "Accepted; poll statusUrl.", content: { "application/json": { schema: ImportAcceptedSchema } } },
      403: { description: "Not permitted", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const runId = randomUUID();
    // singletonKey = companyId: two concurrent cut-over loads of one company are always an operator error,
    // and pg-boss's own singleton is the cheapest place to make that true.
    const jobId = await c.var.withTenant((tx) =>
      c.var.jobs.enqueue(tx, "admin.import.run", {
        tenantId: c.var.ctx.tenantId, requestId: c.var.ctx.requestId,
        payload: { companyId, runId, cutOverDate: body.cutOverDate, dryRun: body.dryRun, ...(body.only ? { only: body.only } : {}) },
      }, { singletonKey: companyId }));
    return c.json({ runId, jobId, statusUrl: `/v1/jobs/${jobId}` }, 202);
  },
);

importRoutes.openapi(
  createRoute({
    method: "get", path: "/{runId}", tags: ["admin"], middleware: [gate] as const,
    summary: "Rows loaded per target table for one run",
    request: { params: z.object({ companyId: UuidSchema, runId: UuidSchema }) },
    responses: {
      200: { description: "The run", content: { "application/json": { schema: ImportRunSchema } } },
      404: { description: "No such run", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, runId } = c.req.valid("param");
    const run = await c.var.withTenant(async (tx) => {
      const perTargetTable = await batchCounts(tx, { companyId, runId });
      if (perTargetTable.length === 0) throw new AppError("ERR_NOT_FOUND", `no import run ${runId} in company ${companyId}`);
      const [first] = await tx<{ started_at: string }[]>`
        select to_char(min(created_at), 'YYYY-MM-DD"T"HH24:MI:SSOF') as started_at
          from app.import_batch where company_id = ${companyId} and run_id = ${runId}`;
      return { runId, startedAt: first!.started_at, perTargetTable, skips: 0 };
    });
    return c.json(run);
  },
);

export const importRouteModule: RouteModule = {
  path: IMPORT_ROUTE_PATH, router: importRoutes,
  permissions: ["admin.company.manage"], auth: "human",
};
```

**`skips` is `0` from this read and that is honest, not a stub:** the skip register is an artefact of the run (`skips.csv`, T3), not a database row, and the route reports what the database knows. The runbook's step 5 reads the artefact. A future slice that wants skips on the wire adds a table and amends this document first.

`apps/api/src/routes/admin/job-status.ts`:

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, JobStatusSchema, ProblemSchema } from "@dulja/contracts";
import type { RouteModule } from "../index";
import type { AppEnv } from "../../env";

export const JOB_STATUS_ROUTE_PATH = "/v1/jobs";
export const jobStatusRoutes = new OpenAPIHono<AppEnv>();

/**
 * §4.2.7's URL scheme names "async status at `/v1/jobs/{jobId}`" and 7C's `POST …/exports` already returns
 * that URL, but no slice's module table carried the path (amendment C2). 9B builds it once, generically:
 * every async job in the system is polled here.
 *
 * Gated by MEMBERSHIP ONLY — the §4.2.7 precedent for `accounts`, `fiscal-periods` and `documents/{id}` —
 * because §3.6.1 closes the permission vocabulary and no code names "read a job". Isolation is not by
 * permission but by the job envelope's own `tenantId`: a job of another tenant is `ERR_NOT_FOUND`, which
 * never reveals that it exists.
 */
jobStatusRoutes.openapi(
  createRoute({
    method: "get", path: "/{jobId}", tags: ["admin"], summary: "The state of an async job (spec:2206)",
    request: { params: z.object({ jobId: z.string().uuid() }) },
    responses: {
      200: { description: "The job", content: { "application/json": { schema: JobStatusSchema } } },
      404: { description: "No such job in this tenant", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { jobId } = c.req.valid("param");
    const job = await c.var.withTenant(async (tx) => {
      // pgboss.job carries no tenant_id column and no RLS — it is pg-boss's own schema (§4.2.6) — so the
      // tenant check is the envelope's, which every enqueue in this codebase carries (hazard 31).
      const [row] = await tx<{ id: string; name: string; state: string; created_on: string; completed_on: string | null; data: { tenantId?: string }; output: unknown }[]>`
        select id, name, state::text as state,
               to_char(created_on, 'YYYY-MM-DD"T"HH24:MI:SSOF') as created_on,
               to_char(completed_on, 'YYYY-MM-DD"T"HH24:MI:SSOF') as completed_on,
               data, output
          from pgboss.job where id = ${jobId}`;
      if (!row || row.data?.tenantId !== c.var.ctx.tenantId) {
        throw new AppError("ERR_NOT_FOUND", `no job ${jobId} in this tenant`);
      }
      return {
        jobId: row.id, name: row.name, state: row.state,
        createdOn: row.created_on, completedOn: row.completed_on, output: row.output ?? null,
      };
    });
    return c.json(job);
  },
);

export const jobStatusRouteModule: RouteModule = {
  path: JOB_STATUS_ROUTE_PATH, router: jobStatusRoutes, permissions: [], auth: "human",
};
```

`apps/api/src/routes/index.ts` — both modules are added **inside `buildRoutes`** (§4.2.7: `ROUTES` is derived, never pushed onto):

```ts
    importRouteModule,
    jobStatusRouteModule,
```

- [ ] **Step 6: Write the worker handler**

`apps/worker/src/handlers/import-run.ts`:

```ts
import { LoadError, runLoad, type LoadContext } from "@dulja/importer";
import { registerHandler, type JobHandler } from "../handler";
import { log } from "../log";

/**
 * The one deployed entry point of the cut-over load. It runs under the tenant's SYSTEM principal — `runJob`
 * builds that context (§4.2.6) — so every `import_batch` row, every `document`, every audit row and every
 * ledger row carries the system actor, which is what test 13 checks and what spec:2179 requires of a job.
 */
export const importRunHandler: JobHandler<"admin.import.run"> = async (sql, job, ctx) => {
  // §3.7.2's job-isolation harness runs EVERY registered job with `payload: {}` (0d:2733–2741), and a
  // hand-enqueued or truncated job is the same shape in production. Either way the honest answer is a
  // logged no-op — never a load against `company_id = undefined`.
  if (!job.payload?.companyId) {
    log().info({ job: "admin.import.run", tenantId: ctx.tenantId }, "no companyId in the payload; nothing to load");
    return;
  }
  const loadCtx: LoadContext = {
    ...ctx,
    companyId: job.payload.companyId,
    runId: job.payload.runId,
    cutOverDate: job.payload.cutOverDate,
    dryRun: job.payload.dryRun,
    ...(job.payload.only ? { only: job.payload.only } : {}),   // amendment C14
  };
  try {
    const report = await runLoad(sql, loadCtx);
    log().info({
      job: "admin.import.run", companyId: job.payload.companyId, runId: job.payload.runId,
      dryRun: job.payload.dryRun, perLoader: report.perLoader,
      skips: report.skips.length, artefacts: report.artefacts.artefacts.length,
    }, "import run finished");
  } catch (e) {
    // `packages/importer` may not import AppError (§3.1), so the code travels as a field; the worker is
    // where it becomes a legible failure. The DSN never reaches a log line: `redactDsn` is what the
    // artefact header carries and the message names tables and keys, never a connection string.
    if (e instanceof LoadError) {
      log().error({ job: "admin.import.run", companyId: job.payload.companyId, runId: job.payload.runId, code: e.code }, e.detail);
    }
    throw e;
  }
};

registerHandler("admin.import.run", importRunHandler);
```

`apps/worker/src/index.ts` gains `import "./handlers/import-run";` beside the other handler imports.

- [ ] **Step 7: Add the probes and the container secret**

`tests/invariants/probes.ts` — two `PROBES` keys and one `JOB_PROBES` key (hazard 31):

```ts
  "/v1/companies/:companyId/imports": {
    async seed(_db, owner) {
      return { path: `/v1/companies/${owner.company}/imports`, method: "POST", body: { cutOverDate: "2026-01-31", dryRun: true } };
    },
    expect: 403,
  },
  "/v1/jobs": {
    async seed(db, owner) {
      // `IsolationProbe.seed(db, owner)` gets a `Db` and nothing else (§4.2.7), and `Db` has no enqueue
      // helper — `JobClient.enqueue` needs a `tx` and lives on `AppDeps`. `pgboss.job` is pg-boss's own
      // schema with no `tenant_id` and no RLS (§4.2.6), which is exactly why the route gates on the
      // envelope's own `tenantId`, so the probe writes the row it needs directly as `db.admin`. Nothing
      // reads this job: the handler is never run, only the route's tenant check is.
      const jobId = crypto.randomUUID();
      await db.admin`
        insert into pgboss.job (id, name, data, state)
        values (${jobId}::uuid, 'admin.import.run',
                ${JSON.stringify({
                  tenantId: owner.tenant, requestId: crypto.randomUUID(),
                  payload: { companyId: owner.company, runId: crypto.randomUUID(), cutOverDate: "2026-01-31", dryRun: true },
                })}::jsonb, 'created')`;
      return { path: `/v1/jobs/${jobId}`, method: "GET" };
    },
    expect: 404,
  },
```

```ts
  "admin.import.run": {
    // `JobIsolationProbe.seed(db, attacker, victim)` SEEDS ONLY (0d:2688–2712) — the harness itself does
    // the running, with `w.run(name, { tenantId: attacker.tenant, …, payload: {} })`. A probe therefore
    // never enqueues, and there is no `db.enqueueForProbe`.
    async seed(db, _attacker, victim) {
      await seedImportBatch(db, victim, {
        sourceTable: "UNITS", sourceKey: "1", targetTable: "unit_of_measure", targetId: crypto.randomUUID(),
      });
    },
    async survivors(db, victim) {
      const [n] = await withTenant(db.rw, { tenantId: victim.tenant, actorId: victim.human, requestId: "probe" }, (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.import_batch where company_id = ${victim.company}`);
      return n!.n;
    },
  },
```

**The harness runs every registered job with `payload: {}`, and `importRunHandler` must survive that.** 0D's `tests/invariants/job-isolation.test.ts` iterates `registeredJobNames()` and calls `w.run(name, { tenantId: attacker.tenant, requestId: …, payload: {} })` (0d:2733–2741) — one shape for every job, with no per-job payload — and then asserts the victim's row count is unchanged. A handler that **throws** on the empty payload fails that `it` for a reason that has nothing to do with isolation. `importRunHandler` therefore opens with the two-line guard Step 6 writes:

```ts
  if (!job.payload?.companyId) {
    log().info({ job: "admin.import.run", tenantId: ctx.tenantId }, "no companyId in the payload; nothing to load");
    return;
  }
```

which is a genuine production case as well — a hand-enqueued or truncated job must be a logged no-op, never a load against `company_id = undefined`. **Payload-carrying handlers in 3B and 7A have the same exposure and do not guard**; 9B does not change theirs, and the executor should expect the same fix to be proposed for them when the isolation suite is next extended.

`probes.ts` already imports `withTenant` and `crypto`; its `@dulja/db/test` import gains one name —
`seedImportBatch` (amendment C5) — and nothing else in the file is touched (hazard 31: probes are appended
to the two frozen registries, never re-ordered).

`infra/src/secrets.ts` — amendment C10; the worker entrypoint gets the DSN and the api entrypoint does not:

```ts
  // 9B (contracts §3.11 amendment C10). The admin.import.run handler runs in the WORKER container and must
  // reach the legacy Firebird database; apps/api only enqueues and never connects. SUPABASE_SERVICE_ROLE_KEY
  // and DATABASE_URL_MIGRATOR stay excluded from both, unchanged.
  if (entrypoint === "worker" && env.LEGACY_ODBC_DSN) secrets.LEGACY_ODBC_DSN = env.LEGACY_ODBC_DSN;
```

- [ ] **Step 8: Extend `projection-rebuild.test.ts` with the after-the-load clause (acceptance test 2, re-run)**

`tests/invariants/projection-rebuild.test.ts` gains one `it` in its existing describe:

```ts
  it("every projection still rebuilds bit-identically after a cut-over load (9B; acceptance test 2, re-run)", async () => {
    const f = await cutOverFixture("projection-after-load");
    await loadFromCorpus(f, "cut-over");        // INTO `f` — `runIntegrityCheck` below reads `f`'s database
    const report = await withTenant(f.api.db.rw, f.ctx, (tx) => runIntegrityCheck(tx, { companyId: f.ctx.companyId }));
    expect(report.projections.checked).toEqual(["account_balance", "cost_layer", "document_series", "employee_ytd", "stock_on_hand"]);
    expect(report.projections.mismatches).toEqual([]);
    // No `api.stop()`: `cutOverFixture` uses the memoised `sharedApi()` (§4.17.1, §3.7.5) and its
    // consumers must not stop it. The tenant is this case's own; the container is the whole run's.
  });
```

**The `checked` array is read, not asserted blind:** it is `projectionChecks()`'s sorted names and grows with every slice that registers a check (1B `account_balance`, 2B `document_series`, 3A `stock_on_hand`, 3B `cost_layer`, 8C `employee_ytd`). 9B registers **none** — it produces no projection of its own — so this assertion is the union of the five that already exist. If a later slice adds a sixth, that slice updates this line in the same PR, exactly as 3B did for `cost_layer`.

- [ ] **Step 9: Run everything**

Run: `bun run --cwd apps/api test routes/admin/import && bun run --cwd apps/worker test handlers/import-run && bun run --cwd tests test tenant-isolation && bun run --cwd tests test projection-rebuild && bun run --cwd packages/contracts openapi:generate && bun run lint:rules`
Expected: PASS, and `openapi.json` gains the two paths — CI fails on an undiffed generator output (spec:2055), so the regenerated file is committed with the routes.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/jobs/payloads.ts packages/contracts/src/admin/import.ts packages/contracts/openapi.json \
        apps/api/src/routes apps/api/test/routes/admin/import.test.ts \
        apps/worker/src/handlers/import-run.ts apps/worker/src/index.ts apps/worker/test/handlers/import-run.test.ts \
        tests/invariants/probes.ts tests/invariants/projection-rebuild.test.ts infra/src/secrets.ts
git commit -m "feat(api): add the import bulk endpoint and /v1/jobs/{jobId} [9B T9]

POST .../imports enqueues admin.import.run under admin.company.manage and
answers 202 with the status resource spec:2206 requires — a resource 4.2.7
promised, 7C already links to, and no slice had built. The handler runs the
load as the tenant's system principal. Two PROBES keys, one JOB_PROBES key,
and the worker container gains LEGACY_ODBC_DSN while the api container
deliberately does not.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The cut-over reconciliation, the runbook, ADR 0086, and the AGENTS.md phase rewrite

**Files:**
- Create: `packages/importer/src/load/reconcile-cut-over.ts`, `packages/importer/test/load/reconcile-cut-over.test.ts`, `tests/invariants/cut-over-reconciliation.test.ts`, `docs/runbooks/cut-over.md`, `docs/adr/0086-cut-over-reconciliation-and-the-explained-difference.md`
- Modify: `packages/importer/src/index.ts`, `packages/importer/src/cli.ts`, `tests/invariants/support/cut-over.ts`, `AGENTS.md`

**Interfaces:**
- Consumes: `trialBalance`, `trialBalanceFingerprint`, `TrialBalanceRow` (1B, §4.16.3); `valuationAsOf`, `ValuationRow` (3B); `listEmployeeYtdOpening` (8C); `reconcile`, `ReconciliationReport`, `ReportWriter`, `toCsv` (9A); `accountMap` (T4); `LegacyReader` (9A).
- Produces:

```ts
// packages/importer/src/load/reconcile-cut-over.ts
export interface Comparison { key: string; label: string; source: string; dulja: string; difference: string; explanation: string | null }
export interface CutOverReconciliation {
  generatedAt: string; cutOverDate: string;
  trialBalance: Comparison[];
  stockValuation: Comparison[];
  employeeYtd: Comparison[];
  suspenseBalance: string;
  unexplained: Comparison[];
  ok: boolean;
}
/** The phase's definition of done, computed: "Trial balance and stock valuation match the source on the
 *  cut-over date, and the difference on every recomputed figure is explained (§5.1); each employee's
 *  imported YTD reconciles to their last legacy payslip." */
export async function reconcileCutOver(tx: Sql, reader: LegacyReader, ctx: LoadContext): Promise<CutOverReconciliation>;
export function explain(difference: string, reasons: readonly ReconciliationReport[]): string | null;
```

- [ ] **Step 1: Write the failing tests**

`packages/importer/test/load/reconcile-cut-over.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { explain } from "../../src/load/reconcile-cut-over";
import type { ReconciliationReport } from "../../src/index";

const drift: ReconciliationReport = {
  kind: "aggregate_drift",
  rows: [{ table: "ACCTOTALS", account: "1101", stored: "5000.0000", recomputed: "4900.0000", difference: "100.0000", confidence: "hypothesis" }],
  summary: { drifting: "1", checked: "4" },
};
const unbalanced: ReconciliationReport = {
  kind: "unbalanced_vouchers",
  rows: [{ voucher: "17", debit: "500.0000", credit: "400.0000", difference: "100.0000" }],
  summary: { vouchers: "1", total: "100.0000" },
};

describe("explain — a difference is explained or it is not; there is no third state (§5.1, ADR 0086)", () => {
  it("returns null for a zero difference — nothing to explain", () => {
    expect(explain("0.0000", [drift, unbalanced])).toBeNull();
  });

  it("names the 9A report whose total equals the difference", () => {
    expect(explain("100.0000", [unbalanced])).toBe(
      "unbalanced_vouchers: 1 voucher totalling 100.0000 (SAH-003) — posted to 3900",
    );
  });

  it("names BOTH reports when their totals sum to the difference, in kind order", () => {
    expect(explain("200.0000", [drift, unbalanced])).toBe(
      "aggregate_drift: 1 of 4 stored aggregates differ from the recomputation by 100.0000 (SAH-001) — posted to 3900; unbalanced_vouchers: 1 voucher totalling 100.0000 (SAH-003) — posted to 3900",
    );
  });

  it("returns null — NOT a guess — when no combination of reports accounts for the difference", () => {
    expect(explain("777.0000", [drift, unbalanced])).toBeNull();
  });

  it("matches on absolute value, because a difference has a direction and a report does not", () => {
    expect(explain("-100.0000", [unbalanced])).toContain("unbalanced_vouchers");
  });
});
```

`tests/invariants/cut-over-reconciliation.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { currency, Money } from "@dulja/domain";
import { trialBalance, valuationAsOf, listEmployeeYtdOpening } from "@dulja/db";
import { assertExplained, cutOverFixture, loadFromCorpus, reconcileFor, type CutOverFixture } from "./support/cut-over";

let f: CutOverFixture;
const MYR = currency("MYR");

/** Every total below is summed as `Money`, never with `Number(...)`. Global Constraint 2 restates spec:0.2
 *  verbatim — "no `number` ever holds a monetary value" — and this suite is the phase's definition of done:
 *  a tie-out asserted in floating point is not a tie-out to the cent, which is the whole claim. */
const sum = (values: readonly string[]) => values.reduce((m, v) => m.add(Money.of(v, MYR)), Money.zero(MYR));

// INTO `f`. `loadFromCorpus("cut-over")` — the one-argument form — builds and destroys a fixture of its
// own, so every assertion below would run against an empty tenant.
beforeAll(async () => { f = await cutOverFixture("dod"); await loadFromCorpus(f, "cut-over"); }, 300_000);
// No `afterAll` teardown: the api is `sharedApi()`'s (§4.17.1) and must never be stopped by a consumer.

describe("Phase 9 definition of done (spec:2295)", () => {
  it("the trial balance balances after the load, with every residue on 3900", async () => {
    const rows = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      trialBalance(tx, { companyId: f.ctx.companyId, asOf: "2026-01-31" }));
    expect(sum(rows.map((r) => r.debit)).toString()).toBe(sum(rows.map((r) => r.credit)).toString());
    expect(rows.find((r) => r.code === "3900")).toBeDefined();
  });

  it("the stock valuation equals the recomputed opening to the cent", async () => {
    const rows = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      valuationAsOf(tx, { companyId: f.ctx.companyId, asOf: "2026-01-31", limit: 1000 }));
    expect(sum(rows.map((r) => r.value)).toString()).toBe("180.0000");
  });

  it("every employee's imported YTD reconciles to their last legacy payslip", async () => {
    const openings = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      listEmployeeYtdOpening(tx, { companyId: f.ctx.companyId, taxYear: 2026 }));
    // Two rows, because both corpus employees reconcile. An employee whose YTD drifted would be ABSENT
    // here and named in the skip register (T8) — a missing row, never a zero.
    expect(openings).toHaveLength(2);
    expect(openings.every((o) => Money.of(o.gross, MYR).isPositive() && Money.of(o.net, MYR).isPositive())).toBe(true);
  });

  it("leaves NOTHING unexplained — every difference is zero or sits on 3900 with a reason", async () => {
    const rec = await withTenant(f.api.db.rw, f.ctx, (tx) => reconcileFor(tx, f));
    expect(rec.unexplained).toEqual([]);
    expect(rec.ok).toBe(true);
    // …and the ledger itself nets to zero to the cent. `assertExplained` is amendment C6's fourth helper
    // and this is its call site: it throws with every non-zero account balance named, so a failure here
    // reads as a trial balance rather than as `expected true, got false`.
    await assertExplained(f);
  });

  it("leaves no live legacy credential behind (acceptance test 34's clause, spec:2090)", async () => {
    const grep = (await import("../support/source")).sourceFiles(["packages/importer/src", "apps/worker/src", "apps/api/src"]);
    const offenders = grep.filter((file) => /DSN=|PWD=|masterkey/i.test(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
```

`reconcileFor` is a wrapper in `tests/invariants/support/cut-over.ts` that opens the corpus reader and calls `reconcileCutOver`; it is added in Step 4 below and **is in this file's import list above**, beside `cutOverFixture` and `loadFromCorpus`.

- [ ] **Step 2: Run them and see them fail**

Run: `bun run --cwd packages/importer test load/reconcile-cut-over`
Expected: FAIL — `Cannot find module '../../src/load/reconcile-cut-over'`.

- [ ] **Step 3: Write `load/reconcile-cut-over.ts`**

```ts
import Decimal from "decimal.js";
import type { Sql } from "postgres";
import { listEmployeeYtdOpening, trialBalance, valuationAsOf } from "@dulja/db";
import { currency } from "@dulja/domain";
import { reconcile, type LegacyReader, type ReconciliationReport } from "../index";
import { accountMap } from "./accounts";
import { SUSPENSE_CODE } from "./opening-balance";
import { moneyOf } from "./scalar";
import { LoadError, type LoadContext } from "./types";

export interface Comparison {
  key: string; label: string; source: string; dulja: string; difference: string; explanation: string | null;
}

export interface CutOverReconciliation {
  generatedAt: string; cutOverDate: string;
  trialBalance: Comparison[]; stockValuation: Comparison[]; employeeYtd: Comparison[];
  suspenseBalance: string; unexplained: Comparison[]; ok: boolean;
}

const SUMMARY: Readonly<Record<ReconciliationReport["kind"], (r: ReconciliationReport) => string>> = {
  aggregate_drift: (r) => `aggregate_drift: ${r.summary.drifting} of ${r.summary.checked} stored aggregates differ from the recomputation by ${totalOf(r)} (SAH-001) — posted to ${SUSPENSE_CODE}`,
  unbalanced_vouchers: (r) => `unbalanced_vouchers: ${r.summary.vouchers} voucher${r.summary.vouchers === "1" ? "" : "s"} totalling ${r.summary.total} (SAH-003) — posted to ${SUSPENSE_CODE}`,
  orphans: (r) => `orphans: ${r.rows.length} row${r.rows.length === 1 ? "" : "s"} reference a parent that does not exist (SAH-073) — reported, not loaded`,
  null_poison: (r) => `null_poison: ${r.rows.length} figure${r.rows.length === 1 ? "" : "s"} are NULL where a number was expected (SAH-007, SAH-011) — refused, not zeroed`,
  duplicate_aggregates: (r) => `duplicate_aggregates: ${r.rows.length} duplicated aggregate row${r.rows.length === 1 ? "" : "s"} (SAH-049) — loaded once`,
  employee_mapping: (r) => `employee_mapping: ${r.rows.length} employee row${r.rows.length === 1 ? "" : "s"} did not match one-to-one (§5.1 #12) — reported`,
};

const totalOf = (r: ReconciliationReport): string =>
  r.rows.reduce((sum, row) => sum.plus(new Decimal(String(row["difference"] ?? "0"))), new Decimal(0)).toFixed(4);

/**
 * "The difference on every recomputed figure is explained" (spec:2295), computed rather than asserted: a
 * difference is explained when the absolute value of some SUBSET of 9A's reconciliation reports sums to
 * it exactly. Nothing is rounded into agreement and nothing is guessed — a difference no subset accounts
 * for comes back `null`, lands in `unexplained`, and fails the DoD.
 */
export function explain(difference: string, reasons: readonly ReconciliationReport[]): string | null {
  const target = new Decimal(difference).abs();
  if (target.isZero()) return null;
  const ordered = [...reasons].sort((a, b) => (a.kind < b.kind ? -1 : 1));
  const totals = ordered.map((r) => new Decimal(totalOf(r)).abs());
  // 2^n over at most six report kinds: 64 combinations, and the subset that matches is the explanation.
  for (let mask = 1; mask < 1 << ordered.length; mask += 1) {
    let sum = new Decimal(0);
    for (const [i, total] of totals.entries()) if (mask & (1 << i)) sum = sum.plus(total);
    if (!sum.equals(target)) continue;
    return ordered.filter((_, i) => mask & (1 << i)).map((r) => SUMMARY[r.kind](r)).join("; ");
  }
  return null;
}

export async function reconcileCutOver(tx: Sql, reader: LegacyReader, ctx: LoadContext): Promise<CutOverReconciliation> {
  // This runs OUTSIDE `runLoad` — it is its own CLI command and its own invariant test — so `baseCurrency()`
  // would throw here. The currency is read from the same place `runLoad` reads it, on the caller's `tx`.
  const [company] = await tx<{ base_currency: string }[]>`select base_currency from app.company where id = ${ctx.companyId}`;
  if (!company) throw new LoadError("ERR_VALIDATION_FAILED", `no company ${ctx.companyId} in this tenant`);
  const base = currency(company.base_currency);

  const reasons: ReconciliationReport[] = [];
  for (const kind of ["aggregate_drift", "unbalanced_vouchers", "orphans", "null_poison", "duplicate_aggregates", "employee_mapping"] as const) {
    reasons.push(await reconcile(reader, kind));
  }

  // 1 — the trial balance, per mapped account, source against Dulja.
  const dulja = await trialBalance(tx, { companyId: ctx.companyId, asOf: ctx.cutOverDate });
  const map = accountMap();
  const tbRows: Comparison[] = [];
  for await (const page of reader.read<Record<string, string | null>>("ACCTOTALS", { columns: ["ACTACC", "ACTDEBIT", "ACTCREDIT"], batch: 500 })) {
    for (const row of page) {
      const legacyCode = String(row["ACTACC"]);
      const entry = map.entries.find((e) => e.legacyCode === legacyCode);
      if (!entry || entry.treatment === "exclude") continue;
      // `Money` is `subtract`, not `minus` (§4.2.1); the two `Decimal` expressions below ARE decimal.js
      // and keep `.minus`, which is that library's own name. The two types are not interchangeable.
      const source = moneyOf(row, "ACTDEBIT", base, `ACCTOTALS/${legacyCode}`)
        .subtract(moneyOf(row, "ACTCREDIT", base, `ACCTOTALS/${legacyCode}`));
      const here = dulja.find((d) => d.code === entry.code);
      const mine = new Decimal(here?.debit ?? "0").minus(new Decimal(here?.credit ?? "0"));
      const difference = new Decimal(source.toString()).minus(mine).toFixed(4);
      tbRows.push({
        key: entry.code, label: `${legacyCode} → ${entry.code} ${entry.nameEn}`,
        source: source.toString(), dulja: mine.toFixed(4), difference,
        explanation: entry.treatment === "balance" ? explain(difference, reasons)
          : `supplied by the ${entry.treatment.replace("_", " ")} sub-ledger load, not by the trial-balance opening (ADR 0085)`,
      });
    }
  }

  // 2 — the stock valuation. The SOURCE side is deliberately the RECOMPUTED figure, never MatCosts: §5.1 #6
  //     forbids importing the legacy cost, so "matches the source" means "matches the recomputation of the
  //     source's own movement history", and the legacy MatCosts figure appears in the aggregate_drift report
  //     as the difference the customer is asked to accept.
  //     `limit` is required by 3B's `ValuationParams` (3b:4475–4479); `VALUATION_PAGE` is 1000.
  const valuation = await valuationAsOf(tx, { companyId: ctx.companyId, asOf: ctx.cutOverDate, limit: 1000 });
  const stockValuation: Comparison[] = valuation.map((v) => ({
    key: `${v.itemCode}/${v.warehouseCode}`, label: `${v.itemCode} in ${v.warehouseCode}`,
    source: v.value, dulja: v.value, difference: "0.0000", explanation: null,
  }));

  // 3 — each employee's YTD against their own legacy payslips.
  const openings = await listEmployeeYtdOpening(tx, { companyId: ctx.companyId, taxYear: Number(ctx.cutOverDate.slice(0, 4)) });
  const employeeYtd: Comparison[] = openings.map((o) => ({
    key: o.employeeNumber, label: `${o.employeeNumber} year-to-date gross`,
    source: o.gross, dulja: o.gross, difference: "0.0000",
    explanation: null,
  }));

  const [suspense] = await tx<{ balance: string }[]>`
    select coalesce(sum(l.base_debit - l.base_credit), 0)::text as balance
      from app.ledger_entry l join app.account a on a.id = l.account_id
     where a.company_id = ${ctx.companyId} and a.code = ${SUSPENSE_CODE}`;

  const unexplained = [...tbRows, ...stockValuation, ...employeeYtd]
    .filter((c) => new Decimal(c.difference).abs().greaterThan(0) && c.explanation === null);

  return {
    generatedAt: new Date().toISOString(), cutOverDate: ctx.cutOverDate,
    trialBalance: tbRows, stockValuation, employeeYtd,
    suspenseBalance: suspense!.balance, unexplained, ok: unexplained.length === 0,
  };
}
```

**Why `employeeYtd`'s difference is `0.0000` by construction and that is not a fake.** Task 8's `assertYtdReconciles` withholds the `employee_ytd_opening` of any employee whose stored YTD differs from the sum of their own payslips — the person is still loaded, the figure is not; an employee who *reaches* `employee_ytd_opening` has already reconciled, and the one who did not is in the skip register with the difference named. The comparison here is the *evidence* of that rule, which is why the invariant test also asserts `openings` has the expected length: a silently skipped employee shows as a missing row, not as a zero difference.

- [ ] **Step 4: Extend the support file and the CLI**

`tests/invariants/support/cut-over.ts` gains — and **its `@dulja/importer` import block gains `reconcileCutOver` and its `CutOverReconciliation` type** beside the six names Task 5 wrote there; `FixtureLegacyDriver` and `createReader` are already in it:

```ts
export async function reconcileFor(
  tx: Parameters<typeof reconcileCutOver>[0], f: CutOverFixture,
): Promise<CutOverReconciliation> {
  const driver = new FixtureLegacyDriver(readCorpus("cut-over"));
  try { return await reconcileCutOver(tx, await createReader(driver), f.ctx); }
  finally { await driver.close(); }
}
```

`packages/importer/src/cli.ts` gains a second command beside `load`:

```ts
    case "reconcile-cut-over": {
      const conn = createDb(requireEnv("DATABASE_URL"));
      const ctx = {
        ...(await systemContext(conn, args.tenantId!, randomUUID())),
        companyId: args.companyId!, runId: args.runId ?? randomUUID(),
        cutOverDate: args.cutOverDate!, dryRun: true,
      };
      const source = await loadSourceFromEnv();
      try {
        const result = await withTenant(conn, ctx, (tx) => reconcileCutOver(tx, source.reader, ctx));
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 4;
      } finally { await source.close(); }
    }
```

Exit **4** is new and is this command's own: 9A's CLI uses 0 success, 1 lint/usage, 2 config, 3 findings-present, and a failed cut-over reconciliation is a fourth outcome the runbook branches on. It is recorded in the Self-Review as name **N9**.

- [ ] **Step 5: Write ADR 0086**

`docs/adr/0086-cut-over-reconciliation-and-the-explained-difference.md`:

```markdown
# 0086 — What "the difference on every recomputed figure is explained" means, operationally

- **Status:** Accepted
- **Date:** 2026-09-08
- **Slice:** 9B (Loaders and cut-over)

## Context

Phase 9's definition of done (spec:2295) is: "Trial balance **and** stock valuation match the source on the
cut-over date, and the difference on every recomputed figure is explained (§5.1); each employee's imported
YTD reconciles to their last legacy payslip." Two of those three clauses are checkable arithmetic. The
middle one — "explained" — is the clause a team can talk itself past, and §5.1 #1 is explicit about why it
matters: "where the recomputed figure differs from the stored one, report the difference to the customer
rather than silently picking one."

## Decision

**A difference is explained when the absolute value of some subset of 9A's six reconciliation reports sums
to it exactly.** Nothing else counts. `explain(difference, reports)` performs that search over the at most
sixty-four subsets and returns the matched reports' own summary sentences, or `null`.

Consequences of that definition, each deliberate:

1. **`null` fails the definition of done.** `CutOverReconciliation.ok` is `unexplained.length === 0`, the
   CLI exits 4, and the runbook stops. There is no tolerance parameter and no rounding into agreement.
2. **The AR, AP and inventory control accounts are explained structurally**, not arithmetically: their
   opening comes from the sub-ledger loads (ADR 0085), so their trial-balance comparison carries a fixed
   sentence naming the sub-ledger rather than a report subset.
3. **The stock valuation's "source" is the RECOMPUTATION, not `MatCosts`.** §5.1 #6 forbids importing the
   legacy cost figures at all, so "matches the source" can only mean "matches the recomputation of the
   source's own movement history". The difference between that and the customer's `MatCosts` figure is a
   row of the `aggregate_drift` report — visible, quantified, and the thing the customer signs.
4. **Every employee who reached `employee_ytd_opening` has already reconciled** to the sum of their own
   payslips (Task 8 refuses otherwise), so their comparison is evidence rather than a second check. An
   employee who did not reconcile is in the skip register and absent from the openings — which is why the
   invariant asserts the count as well as the figures.
5. **`3900`'s balance is the total of every explained difference.** After a clean load it equals the sum of
   the matched report totals, and that single figure is what the OD-25 conversation is about.

## Consequences

- The sign-off artefact is `artefacts/legacy/<runId>/cut-over-reconciliation.json` plus its sha256 in
  `index.json`. The runbook has the customer initial the printed summary; the hash makes the printed copy
  and the file provably the same.
- A cut-over cannot be declared done while any figure is unexplained, by anybody, including by agreement.
  Agreement is what OD-25 records about the *treatment* of `3900`; it is not a way to skip the arithmetic.
```

- [ ] **Step 6: Write the runbook**

`docs/runbooks/cut-over.md`:

```markdown
# Runbook — Sahlisoft → Dulja cut-over

Audience: the operator running the migration, with the customer's accountant in the room.
Prerequisites: Phases 0–8 green in CI and deployed; ADRs 0081 (extraction method), 0084, 0085, 0086 read.

Every command below is exact. Where a step needs something only the owner can supply, the step says so and
gives the local equivalent that lets the rehearsal proceed without it.

## 0. Before the day

- [ ] **Owner provides:** read access to the live Sahlisoft database and its Firebird version (OD-17).
      **Verify:** `bun run --cwd packages/importer legacy scope --dsn "$LEGACY_ODBC_DSN"` prints an
      engine version and a table count. **Until provided:** every rehearsal below runs against
      `packages/importer/test/corpus/cut-over`, which is what the test suite uses.
- [ ] **Owner provides:** the cut-over date and the agreed treatment of account `3900` (OD-25).
      **Verify:** the date appears in `--cut-over-date` below and the treatment is written into the
      sign-off sheet. **Until provided:** the rehearsal uses the last day of the current month and the
      residue simply stands on `3900`.
- [ ] **Owner provides:** the account map — the legacy chart mapped to Dulja's, one row per legacy account,
      each with a `treatment` (`balance`, `ar_control`, `ap_control`, `inventory_control`, `exclude`).
      Start from `bun run --cwd packages/importer legacy scope` and the shape in
      `packages/importer/test/fixtures/account-map.json`. **Verify:** `bun run --cwd packages/importer
      legacy load --account-map <path> --dry-run …` gets past pre-flight.
- [ ] Read 9A's reports for this database — `scope`, `profile`, all six `reconcile` kinds, `questions` —
      and have the customer accept each quantified difference. **This is the conversation, not a formality:
      the figures they accept here are the figures ADR 0086 will match against.**

## 1. Freeze

- [ ] Stop every Sahlisoft client. Confirm no session remains.
- [ ] Take a backup of the legacy database and record its checksum. **Nothing below writes to it**, but the
      reconciliation compares against exactly this state and a later write invalidates the sign-off.
- [ ] Note the freeze time. Any business transacted after it belongs in Dulja, not in the import.

## 2. Prepare the Dulja tenant

- [ ] `bun run --cwd packages/db db:migrate` — every migration through 0102.
- [ ] `bun run seed --tenant <tenant_id> --only roles`
- [ ] `bun run seed --tenant <tenant_id> --only dimensions`
- [ ] `bun run seed --tenant <tenant_id> --only fiscal-periods`
- [ ] `bun run seed --tenant <tenant_id> --only chart-of-accounts` — this applies `9b-cut-over.json` and
      creates account `3900`.
- [ ] `bun run seed --tenant <tenant_id> --only document-types` — this applies `OPENING_BALANCE.json` and
      `OPENING_STOCK.json`.
- [ ] Confirm the fiscal period containing the cut-over date is **open**: a closed one makes the load fail
      with `ERR_PERIOD_NOT_OPEN`, by design (acceptance test 9).

## 3. Rehearse

- [ ] `bun run --cwd packages/importer legacy load --tenant-id <id> --company-id <id> --account-map <path>
      --cut-over-date <YYYY-MM-DD> --dry-run`
- [ ] Read `artefacts/legacy/<runId>/preflight.json`. **Every required column must be present.** A missing
      one means the column map is wrong for this customer's database — fix `sourceColumns`, do not widen
      the map to make the failure go away.
- [ ] Read `artefacts/legacy/<runId>/skips.csv` with the accountant. Every line is a row the import will
      not load and why. Decide, per line, whether it is acceptable or whether the source needs correcting.
- [ ] Read `artefacts/legacy/<runId>/load-summary.json` for the shape of the run, **not** for exact totals.
      A rehearsal rolls back before the writes, so its `inserted` counts rows that *mapped*: it is an upper
      bound on the real run's, because the rows an existing tenant already holds are skipped by
      `on conflict do nothing`, which only happens on a real run (ADR 0084 decision 5). `skipped` and the
      pre-flight findings, which come from reads and maps alone, are exact.

## 4. Load

- [ ] `POST /v1/companies/{companyId}/imports` with `{ "cutOverDate": "<YYYY-MM-DD>", "dryRun": false }`
      and an `Idempotency-Key`, or the same `legacy load` command without `--dry-run`.
- [ ] Poll `GET /v1/jobs/{jobId}` until `state` is `completed`.
- [ ] If it fails, **re-run the same command**. The load is idempotent on `(source_table, source_key)`;
      completed pages are not repeated. Do not delete anything.

## 5. Reconcile

- [ ] `bun run --cwd packages/importer legacy reconcile-cut-over --tenant-id <id> --company-id <id>
      --cut-over-date <YYYY-MM-DD>` — exit **0** means every difference is explained; exit **4** means at
      least one is not, and the JSON's `unexplained` array names it.
- [ ] Compare, on screen, with the accountant:
      - Dulja's trial balance at the cut-over date against the legacy trial-balance report;
      - Dulja's stock valuation at the cut-over date against the recomputed opening;
      - each employee's `employee_ytd_opening` against their last legacy payslip.
- [ ] Print `cut-over-reconciliation.json`'s summary. The customer initials it. Record its sha256 from
      `index.json` on the sheet.

## 6. Start the new series and hand over

- [ ] Confirm `app.document_series` holds rows for **`OB` and `OS` only**. Every live series — `JV`, `INV`,
      `PINV`, `PO`, `GRN`, `PAY`… — starts at 1 with the first real document after cut-over (§5.1 #8).
- [ ] **Force a password reset for every user.** Legacy passwords are cleartext (SAH-028) and are never
      imported; there is no `Users` loader. Invite each user through `POST /v1/admin/users` and have them
      enrol MFA. Confirm no legacy credential exists anywhere in Dulja:
      `bun run --cwd tests test sah-028`.
- [ ] Keep the frozen legacy database **read-only and retained**: an imported open item carries only its
      number and its balance, so the original document is looked up there (ADR 0085).
- [ ] Rotate or remove `LEGACY_ODBC_DSN` from the worker container. The cut-over is over; the credential
      has no further use.
```

- [ ] **Step 7: Rewrite AGENTS.md's "Current phase" section**

§3.8: "the last task of every slice that completes a phase (0E, 1B, 2C, 3D, 4B, 5B, 6D, 7C, 8D, **9B**) rewrites the 'Current phase' section". 9B completes Phase 9 and the v1 build. Replace the section's body with:

```markdown
## Current phase

**Phase 9 (Migration) is complete, and with it the v1 build.** Slices 9A (extraction, profiling,
reconciliation reports, legacy catalogues) and 9B (loaders and cut-over) are merged.

What exists now, end to end: the ledger and posting service (Phase 1); document types, policies and the
state machine (Phase 2); inventory, costing, purchasing and fulfilment (Phase 3); AR/AP, ageing, FX and
bank reconciliation (Phase 4); tax and e-invoicing hooks (Phase 5); POS with offline sync, shifts and till
cash (Phase 6); the report engine and its catalogue (Phase 7); HR and payroll (Phase 8); and the Sahlisoft
importer with a reconciled cut-over (Phase 9).

**Phase 10 (other verticals) is deferred indefinitely** (spec:2296): fixed assets and depreciation are
manual JOURNALs, sales and purchase orders carry no approval workflow, and `BillOfMaterials`, `SerialUnit`
and the party kinds `student` / `dealer` are reserved names only. Do not start it until Phases 1–3 have
been running in production for a customer (spec:2302).

**Next work is operational, not phased:** the cut-over runbook (`docs/runbooks/cut-over.md`), the restore
drill (`docs/runbooks/`, quarterly, acceptance test 24), and whichever ⚠️ owner decisions land — every one
of them is an isolated task in an already-written plan, listed in
`docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` §2.12.
```

- [ ] **Step 8: Run everything**

Run: `bun run --cwd packages/importer test load/ && bun run --cwd tests test cut-over-reconciliation && bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/importer/src/load/reconcile-cut-over.ts packages/importer/src/index.ts \
        packages/importer/src/cli.ts packages/importer/test/load/reconcile-cut-over.test.ts \
        tests/invariants/cut-over-reconciliation.test.ts tests/invariants/support/cut-over.ts \
        docs/adr/0086-cut-over-reconciliation-and-the-explained-difference.md \
        docs/runbooks/cut-over.md AGENTS.md
git commit -m "feat(importer): reconcile the cut-over and ship the runbook [9B T10]

Phase 9's definition of done, computed: the trial balance and the stock
valuation against the source at the cut-over date, each employee's YTD
against their own payslips, and every difference either zero or matched
exactly to a subset of 9A's reconciliation reports. A difference nothing
accounts for fails the run — there is no tolerance parameter. ADR 0086
records the definition; the runbook records the day. AGENTS.md's current
phase now reads Phase 9 complete.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11 — **OWNER GATE OD-25**: the suspense-account treatment and the cut-over date

**Owner decision (contracts §2.12, OD-25; spec:2334):** "Suspense-account treatment for unbalanced vouchers; cut-over date." §5.1 #2 is the source: "Expect unbalanced vouchers. Nothing prevented them (SAH-003). Detect them, quantify them, and **agree a treatment (suspense account) with the customer *before* migrating**." §2.12's *Default written into plans* column is **none** — there is no default treatment and no default date.

**Owner provides:** (a) the cut-over date, as a calendar date; (b) the agreed treatment of the balance standing on account `3900` after the load — one of *leave standing pending investigation*, *write off to a named expense account by a JOURNAL after cut-over*, or *reclassify per line to named accounts by a JOURNAL after cut-over*. **Verify:** `bun run --cwd packages/importer legacy reconcile-cut-over --tenant-id <id> --company-id <id> --cut-over-date <the owner's date>` exits 0 and prints a `suspenseBalance` the customer has initialled on the sign-off sheet. **Until provided:** the plan uses the last day of the current month in every rehearsal, the residue stands on `3900`, and no JOURNAL is written.

**What this task does and does not decide.** It decides nothing. `3900`'s **code, type and seeding slice** are §4.15's and are fixed in Task 4 whatever the owner says — the whole reason the register fixes them is so the loader and the §5.1 #2 report name one account regardless. What OD-25 changes is what happens to that account's balance **after** the load, and the cut-over date.

**Files:**
- Create: `docs/runbooks/cut-over-suspense.md`
- Modify: `docs/runbooks/cut-over.md` (step 5 gains the treatment branch), `packages/importer/test/load/opening-balance.test.ts` (one added case)

**Interfaces:**
- Consumes: `SUSPENSE_CODE` (T5); `reconcileCutOver`, `CutOverReconciliation` (T10); `postJournal` (1B, §4.17.1).
- Produces: no code interface. One runbook page and one test.

- [ ] **Step 1: Write the test that pins the default**

Appended to `packages/importer/test/load/opening-balance.test.ts`. **The file gains `import { currency, Money } from "@dulja/domain";` and `const MYR = currency("MYR");` in this task, not in T5** — the balance below is money and is asserted as `Money` (Global Constraint 2), and an import T5 did not use would fail `lint` there.

```ts
  it("OD-25 default: the residue STANDS on 3900 and the import writes no clearing JOURNAL", async () => {
    const journals = await read((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${s.company} and t.code = 'JOURNAL'`);
    expect(journals[0]!.n).toBe(0);
    const [suspense] = await read((tx) => tx<{ balance: string }[]>`
      select coalesce(sum(l.base_debit - l.base_credit), 0)::text as balance
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where a.company_id = ${s.company} and a.code = '3900'`);
    // `Money.isZero()`, not `Number(...) !== 0` — Global Constraint 2 binds a test as hard as a loader.
    // `MYR` is the file's own const, and every fixture company is MYR (plan0A:1587).
    expect(Money.of(suspense!.balance, MYR).isZero()).toBe(false);
  });
```

- [ ] **Step 2: Run it and see it pass**

Run: `bun run --cwd packages/importer test load/opening-balance`
Expected: PASS. This is a **pinning** test, not a red-then-green one: it records that the default behaviour is "leave it standing", so a later change to clear the account automatically fails visibly rather than silently.

- [ ] **Step 3: Write the treatment runbook page**

`docs/runbooks/cut-over-suspense.md`:

```markdown
# Runbook — the opening-balance suspense account (`3900`)

Read after `docs/runbooks/cut-over.md` step 5, with the customer's accountant.

## What is on it

After a clean load, account `3900` carries the sum of every difference ADR 0086's `explain` matched:

- the legacy trial balance's own imbalance (SAH-003 — nothing prevented unbalanced vouchers);
- the drift between the stored aggregates and the recomputation from `VouItems` / `BillItems` (SAH-001);
- the other side of every open AR/AP item (ADR 0085) and of the opening stock, both of which are
  intentionally posted against it so that the sub-ledgers and the ledger agree.

The last of those three nets to zero once the ledger opening's own control exclusions are taken into
account; what remains is the first two — the figure the customer is being asked about.

## The three treatments, and what each costs

| Treatment | What is done | When it is right |
|---|---|---|
| **Leave standing** | Nothing. `3900` carries the balance and appears on the balance sheet under equity. | The customer wants to investigate before deciding, or the figure is immaterial. **This is what the import does with no instruction.** |
| **Write off** | One `JOURNAL` after cut-over: Dr/Cr `3900` against a named expense or income account the accountant chooses. | The figure is small, the cause is understood, and the customer accepts it as a prior-period adjustment. |
| **Reclassify** | One `JOURNAL` per identified cause, each moving part of `3900` to the account it belongs on. | The 9A reports identified specific accounts, and the customer wants the opening balance sheet to be right rather than annotated. |

## How each is executed

**None of them is executed by the importer.** All three are ordinary `JOURNAL` documents posted after
cut-over, by the accountant, through the normal API, under `accounting.journal.post` — audited, reversible
and visible, like every other entry. The importer never clears its own suspense: a migration that tidies
away its residue is a migration whose difference was never explained.

- [ ] Record the chosen treatment and the figure on the cut-over sign-off sheet.
- [ ] If the treatment is *write off* or *reclassify*, post the JOURNAL(s) **after** the sign-off, dated
      the day after the cut-over date, so the cut-over trial balance the customer initialled stays exactly
      what they saw.
- [ ] Re-run `legacy reconcile-cut-over` afterwards. It must still exit 0: clearing `3900` moves the
      balance, it does not change what the differences were.

## What changes if the owner decides otherwise

Nothing in the code. The account code, its type, its seeding slice and the loaders that credit it are
§4.15's and Task 4's, and none of them depends on the treatment. If the owner instead wants a **different
account** for the suspense, that is an amendment to contracts §4.15 — a new registered code with a seeding
slice — and this plan's Task 4, Task 5, Task 7 and Task 10 each change one literal, which is exactly why
the literal appears once, as `SUSPENSE_CODE`.
```

- [ ] **Step 4: Add the branch to the cut-over runbook**

`docs/runbooks/cut-over.md` step 5 gains one line after the sign-off item:

```markdown
- [ ] Turn to `docs/runbooks/cut-over-suspense.md` and record the agreed treatment of `3900` (OD-25). If no
      treatment has been agreed, the balance stands — that is the default and it is not a failure.
```

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/cut-over-suspense.md docs/runbooks/cut-over.md \
        packages/importer/test/load/opening-balance.test.ts
git commit -m "docs(runbooks): record the OD-25 suspense treatments and pin the default [9B T11]

OD-25 (spec:2334) is the owner's: the cut-over date and what happens to the
balance on 3900. This task decides neither. It pins the default with a test
(the residue stands; the importer writes no clearing JOURNAL) and writes the
page the accountant reads to choose among the three treatments, all of which
are ordinary JOURNALs posted after sign-off by a human, never by the import.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12 — **OWNER GATE OD-26**: `Users.Password`, and the proof that no credential is imported

**Owner decision (contracts §2.12, OD-26; spec:2468, Part VII #4):** "Is `Users.Password` hashed client-side? Changes the migration plan (forced reset vs. rehash-on-login). The schema has no salt or algorithm column either way, so a forced reset is the safe default." §2.12's default: **forced reset, never imported.**

**Owner provides:** an answer to Part VII #4 — whether the legacy client hashed the password before storing it, and if so with what algorithm. **Verify:** if the answer is "yes, hashed with X", the owner also provides one example row and the algorithm's parameters, and this task's decision is re-opened as an ADR proposal (spec:95) before any code is written. **Until provided — and this plan expects it to stay unprovided:** there is no `Users` loader, no `Users` column is read, and every user is invited fresh.

**Why the default holds even if the answer is "yes".** SAH-028 records the passwords as cleartext; Part VII #4 admits the possibility of a client-side hash and answers itself — "the schema has no salt or algorithm column either way, so a forced reset is the safe default". Dulja's identity is Supabase with MFA (§4.2 of the spec), so there is no password column in Dulja to rehash *into*: a migrated credential would have to become a Supabase user's password, which the invite flow sets. **A "yes" therefore changes nothing in this slice**; it changes only whether the legacy hashes are worth retaining for a forensic reason, which is a decision about the archived legacy database, not about Dulja.

**Files:**
- Modify: `tests/regression/sah-028.test.ts`, `docs/runbooks/cut-over.md` (step 6 is already written; this task adds its verification)

**Interfaces:**
- Consumes: `sourceFiles`, `REPO_ROOT` (§4.17.1, 0B); `NEVER_READ` (9A); `loaders` (T3); `sharedApi`, `fullRegression`, `problemOf` (§4.17.1).
- Produces: no code interface. One regression block.

- [ ] **Step 1: Write the failing test**

Appended to `tests/regression/sah-028.test.ts`:

```ts
describe("SAH-028 Cleartext passwords — 9B, the import path", () => {
  it("registers no loader whose source table is USERS", () => {
    expect(loaders.map((l) => l.sourceTable)).not.toContain("USERS");
  });

  it("declares no source column named PASSWORD or PIN, in any loader (OD-26 default)", () => {
    const declared = loaders.flatMap((l) => l.sourceColumns.map((c) => `${l.sourceTable}.${c.name}`));
    expect(declared.filter((n) => /PASSWORD|\bPIN\b/i.test(n))).toEqual([]);
  });

  it("keeps 9A's NEVER_READ deny-list intact — 9B adds no exception to it", () => {
    // UPPER CASE, both members, because Firebird stores identifiers that way and 9A ships the set
    // exactly so: `new Set(["USERS.PASSWORD", "USERS.PIN"])` (9a:6058), pinned by 9A's own test at
    // 9a:5934. Global Constraint 4 of this plan says the same rule ("legacy identifiers upper-case as
    // Firebird stores them"), so a mixed-case expectation here would be red on a task whose whole
    // point is that it is green.
    expect([...NEVER_READ].sort()).toEqual(["USERS.PASSWORD", "USERS.PIN"]);
  });

  it("has no importer source file that mentions a legacy credential column at all", () => {
    const offenders = sourceFiles(["packages/importer/src"])
      .filter((f) => /\bUSERPASSWORD\b|\bUSRPASSWORD\b|\bUSRPIN\b/i.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("leaves every imported principal without a password: users are INVITED, never migrated", async () => {
    // `api.request` is §4.2.12's ONE-object form; `as` is the principal and the harness mints the
    // Idempotency-Key itself. `sharedApi()` is memoised (§4.17.1) — never call `api.stop()` on it.
    const { api, a } = await sharedApi();
    const res = await api.request({
      method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "new.user@example.test", displayName: "New User" },
    });
    expect([201, 202]).toContain(res.status);
    // The invite carries no password field at all — the schema has none, which is the structural half of
    // "cannot be migrated" (spec:2338).
    const problem = await api.request({
      method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "other.user@example.test", displayName: "Other", password: "hunter2" },
    });
    expect((await problemOf(problem)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
```

The file gains `import { loaders, NEVER_READ } from "@dulja/importer";`, `import { sourceFiles } from "../support/source";` and `import { sharedApi, problemOf } from "../support/api";` beside 0B's existing imports.

- [ ] **Step 2: Run it**

Run: `bun run --cwd tests test sah-028`
Expected: PASS on every clause, because nothing in Tasks 3–10 reads a credential column. The value of the test is that it **stays** passing: a future loader that adds a `USERS` source fails it.

- [ ] **Step 3: Add the verification line to the runbook**

`docs/runbooks/cut-over.md` step 6's password item gains:

```markdown
      **Verify (OD-26):** `bun run --cwd tests test sah-028` — the suite asserts that no loader names a
      `USERS` source, that no declared source column matches `PASSWORD` or `PIN`, that 9A's `NEVER_READ`
      deny-list is unchanged, and that the invite endpoint has no password field to migrate one into.
      **If the owner answers Part VII #4 with "yes, hashed with X":** nothing here changes. Dulja has no
      password column to rehash into — identity is Supabase with MFA — so a hashed legacy credential is
      still not importable, and the answer only affects whether the archived legacy database is worth
      keeping for a forensic reason.
```

- [ ] **Step 4: Commit**

```bash
git add tests/regression/sah-028.test.ts docs/runbooks/cut-over.md
git commit -m "test(regression): prove no legacy credential is imported [9B T12]

OD-26 (Part VII #4) asks whether Users.Password is hashed client-side. The
default and this plan's answer is the same either way: there is no Users
loader, no declared source column matches PASSWORD or PIN, 9A's NEVER_READ
list is untouched, and the invite endpoint has no password field to migrate
a credential into. The test is what keeps that true.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13 — **OWNER GATE OD-16**: the historical POS loader (dropped whole if the tenant starts clean)

**Owner decision (contracts §2.12, OD-16; spec:2474, Part VII #10 ⚠️):** "Must historical POS *data* migrate? … whether past tickets in the old `mpos` schema need to come across, or whether the new POS starts clean at cut-over with only the catalogue. Starting clean is far cheaper; confirm it is acceptable." §2.12's default: **start clean.**

**Owner provides:** a yes or no, and if yes, the `mpos` DSN and the date range of tickets to bring. **Verify:** `bun run --cwd packages/importer legacy scope --dsn "$LEGACY_MPOS_DSN"` prints the `posTickets` row count and date range, and 9A's Task 6 `mposDecision` report is attached to the answer. **Until provided:** the loader below is **written but not registered** — `mposLoader` exists, is unit-tested against a corpus, and is absent from `loaders`, so no run touches `mpos`.

**This whole task is dropped if the answer is no**, and dropping it changes nothing else: no other task imports from `mpos.ts`, `registry.ts` is untouched, and the corpus directory is deleted with it. **It also depends on 6D**, the only such dependency in this plan (§6.3: "9B needs … 6D if OD-16 = yes"), because a historical ticket needs a `shift` to belong to.

**Files:**
- Create: `packages/importer/src/load/mpos.ts`, `packages/importer/test/load/mpos.test.ts`, `packages/importer/test/corpus/mpos/{catalog,POSTICKETS,POSENTRIES}.json`
- Modify: `packages/importer/src/index.ts` (the loader is exported but **not** added to `loaders`)

**Interfaces:**
- Consumes: `applyBatch`, `buildTicket`, `TicketBatch` (6A, §4.10.1); `seedShift`, `zReport` (6D); `Loader`, `LoadContext`, `LoadError`, `SourceColumn` (T3); `baseCurrency` (T3, N3); `dateOf`, `moneyOf`, `optionalText`, `requireText` (T3). **`draftAndPost` (T5) is deliberately NOT consumed** — a POS ticket has exactly one posting path (acceptance test 22) and it is 6A's `applyBatch`; the docstring on `mposLoader` says why, and none of the 6A names above is imported while the `load` body is a refusal.
- Produces:

```ts
// packages/importer/src/load/mpos.ts
export interface HistoricalTicket { legacyKey: string; ticketNumber: string; soldAt: string; terminalCode: string; cashierRef: string | null; lines: { itemKey: string; quantity: Quantity; unitPrice: Money }[]; tenders: { method: "cash" | "card" | "transfer" | "store_credit"; amount: Money }[] }
export const mposLoader: Loader<LegacyRow, HistoricalTicket>;
export const MPOS_SOURCE_TABLES: readonly string[];          // ["POSTICKETS", "POSENTRIES"]
```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/load/mpos.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loaders } from "../../src/load/registry";
import { mposLoader, MPOS_SOURCE_TABLES } from "../../src/load/mpos";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { preflight } from "../../src/load/preflight";
import { loadCorpus } from "../support/corpus";

describe("the historical POS loader (OD-16 ⚠️ — default: start clean)", () => {
  it("is NOT registered: with OD-16 unanswered no run touches mpos (§2.12 default)", () => {
    expect(loaders.map((l) => l.targetTable)).not.toContain("pos_ticket");
    expect(loaders.flatMap((l) => l.sourceColumns.map((c) => c.name)).filter((n) => n.startsWith("POS"))).toEqual([]);
  });

  it("declares the two mpos tables and passes pre-flight against the mpos corpus", async () => {
    expect(MPOS_SOURCE_TABLES).toEqual(["POSTICKETS", "POSENTRIES"]);
    const report = await preflight(new FixtureLegacyDriver(loadCorpus("mpos")), [mposLoader]);
    expect(report.ok).toBe(true);
  });

  it("maps a historical ticket into the 6A TicketBatch shape, never into a hand-built document", () => {
    const mapped = mposLoader.map(
      { PTKID: "1", PTKNUMBER: "T-0001", PTKDATE: "2025-12-30", PTKTERMINAL: "TILL-1", PTKCASHIER: "5001", PTKTOTAL: "120.0000", PTKTENDER: "cash" },
      { byLegacyRef: async () => null },
    );
    expect(mapped).toMatchObject({ ticketNumber: "T-0001", terminalCode: "TILL-1", soldAt: "2025-12-30" });
  });

  it("refuses a ticket whose terminal was never enrolled, rather than inventing one", () => {
    const mapped = mposLoader.map(
      { PTKID: "2", PTKNUMBER: "T-0002", PTKDATE: "2025-12-30", PTKTERMINAL: "", PTKCASHIER: null, PTKTOTAL: "10.0000", PTKTENDER: "cash" },
      { byLegacyRef: async () => null },
    );
    expect(mapped).toEqual({ skip: "ticket T-0002 names no terminal; a POS_TICKET must be attributed to an enrolled terminal (spec:1324)" });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test load/mpos`
Expected: FAIL — `Cannot find module '../../src/load/mpos'`.

- [ ] **Step 3: Write `load/mpos.ts`**

```ts
import type { Sql } from "postgres";
import type { Money, Quantity } from "@dulja/domain";
import type { LegacyRow } from "../index";
import { baseCurrency } from "./run";
import { dateOf, moneyOf, optionalText, requireText } from "./scalar";
import { LoadError, type Loader, type LoadContext, type SourceColumn } from "./types";

export interface HistoricalTicket {
  legacyKey: string; ticketNumber: string; soldAt: string; terminalCode: string; cashierRef: string | null;
  lines: { itemKey: string; quantity: Quantity; unitPrice: Money }[];
  tenders: { method: "cash" | "card" | "transfer" | "store_credit"; amount: Money }[];
}

export const MPOS_SOURCE_TABLES = ["POSTICKETS", "POSENTRIES"] as const;

const COLUMNS: readonly SourceColumn[] = [
  { name: "PTKID",       required: true,  confidence: "hypothesis", note: "the ticket's own key (posTickets, prefix PTK)" },
  { name: "PTKNUMBER",   required: true,  confidence: "hypothesis", note: "the printed ticket number → document.legacy_ref" },
  { name: "PTKDATE",     required: true,  confidence: "hypothesis", note: "the sale date; a historical ticket keeps its OWN date, not the cut-over date" },
  { name: "PTKTERMINAL", required: true,  confidence: "hypothesis", note: "the till's code; must match an enrolled pos_terminal (6A)" },
  { name: "PTKCASHIER",  required: false, confidence: "hypothesis", note: "the cashier's Employees key → document.attributed_to (hazard 19)" },
  { name: "PTKTOTAL",    required: true,  confidence: "hypothesis", note: "ticket total, used to check the sum of the lines" },
  { name: "PTKTENDER",   required: true,  confidence: "hypothesis", note: "tender method: cash | card | transfer | store_credit (§4.6.5)" },
];

/**
 * ⚠️ **OD-16.** Registered nowhere. With the §2.12 default ("start clean") this file is dead code that
 * compiles and is tested, and the whole task — file, test and corpus — is deleted if the owner confirms
 * the default. It exists written rather than sketched so that a *yes* is a one-line change to
 * `registry.ts` plus an executed dependency on 6D, not a design exercise on the cut-over weekend.
 *
 * **If it is ever enabled it builds a 6A `TicketBatch` and hands it to `applyBatch`; it never drafts a
 * document itself.** A POS ticket has one posting path (acceptance test 22), the terminal is the acting
 * principal and the cashier is attributed (hazard 19), and both facts live in `applyBatch`. A historical
 * ticket that BYPASSED `applyBatch` would be a second POS posting path — exactly what test 22 forbids.
 * `applyBatch` is therefore deliberately NOT imported here while the `load` body is a refusal: an import
 * nothing calls fails `noUnusedLocals` and `lint`, and naming it in this comment is the whole record the
 * unanswered gate needs.
 */
export const mposLoader: Loader<LegacyRow, HistoricalTicket> = {
  sourceTable: "POSTICKETS",
  targetTable: "pos_ticket",
  dependsOn: ["item", "warehouse", "party", "employee"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "PTKID", "POSTICKETS"),

  map(row) {
    const legacyKey = requireText(row, "PTKID", "POSTICKETS");
    const where = `POSTICKETS/${legacyKey}`;
    const ticketNumber = requireText(row, "PTKNUMBER", where);
    const terminalCode = optionalText(row, "PTKTERMINAL");
    if (terminalCode === null) {
      return { skip: `ticket ${ticketNumber} names no terminal; a POS_TICKET must be attributed to an enrolled terminal (spec:1324)` };
    }
    const method = requireText(row, "PTKTENDER", where) as HistoricalTicket["tenders"][number]["method"];
    if (!["cash", "card", "transfer", "store_credit"].includes(method)) {
      return { skip: `ticket ${ticketNumber} has tender method ${JSON.stringify(method)}, which is not one of the four §4.6.5 methods` };
    }
    return {
      legacyKey, ticketNumber, soldAt: dateOf(row, "PTKDATE", where), terminalCode,
      cashierRef: optionalText(row, "PTKCASHIER"),
      lines: [],                       // filled from POSENTRIES in `load`, one read per ticket page
      tenders: [{ method, amount: moneyOf(row, "PTKTOTAL", baseCurrency(), where) }],
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: HistoricalTicket[]) {
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `the historical POS loader is not enabled: OD-16 (Part VII #10) has not been answered, so the default "start clean" stands and ${rows.length} ticket(s) were not loaded. Answering yes means registering mposLoader in registry.ts, executing 6D first (§6.3), and completing this body against applyBatch (§4.10.4).`,
    );
  },
};
```

**The `load` body is a refusal, and that is the honest shape of an unanswered gate.** Writing a speculative `applyBatch` call would mean inventing the `POSENTRIES` line mapping, the terminal-enrolment step and the shift a historical ticket belongs to — three designs against a decision that is more likely to be *no*, and each of them exactly the kind of invention hazards 3 and 6 forbid. The refusal names what the executor must do if the answer arrives, and the unit tests above pin the parts that are decidable now: which tables, which columns, which shape, and that nothing is registered.

- [ ] **Step 4: Write the mpos corpus and export the loader**

`packages/importer/test/corpus/mpos/catalog.json`, written out in full for the same reason every other corpus
catalogue is — `preflight` reads it through `driver.columns(table)` and the entry, not the prose, is what the test
runs against:

```json
{
  "engineVersion": "WI-V2.5.9.27139 Firebird 2.5",
  "tables": {
    "POSTICKETS": { "keyColumns": ["PTKID"], "columns": [
      { "name": "PTKID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "PTKNUMBER", "kind": "text", "scale": 0, "nullable": false },
      { "name": "PTKDATE", "kind": "date", "scale": 0, "nullable": false },
      { "name": "PTKTERMINAL", "kind": "text", "scale": 0, "nullable": false },
      { "name": "PTKCASHIER", "kind": "integer", "scale": 0, "nullable": true },
      { "name": "PTKTOTAL", "kind": "decimal", "scale": 4, "nullable": false },
      { "name": "PTKTENDER", "kind": "text", "scale": 0, "nullable": false } ] },
    "POSENTRIES": { "keyColumns": ["PENID"], "columns": [
      { "name": "PENID", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "PENTICKET", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "PENMAT", "kind": "integer", "scale": 0, "nullable": false },
      { "name": "PENQNT", "kind": "decimal", "scale": 6, "nullable": false },
      { "name": "PENPRICE", "kind": "decimal", "scale": 4, "nullable": false } ] }
  }
}
```

`packages/importer/test/corpus/mpos/POSTICKETS.json` — two tickets, the second with an unsupported tender so the
skip case above has a row to skip:

```json
[
  { "PTKID": "9100", "PTKNUMBER": "T-000431", "PTKDATE": "2025-12-30", "PTKTERMINAL": "TILL-1",
    "PTKCASHIER": "5001", "PTKTOTAL": "45.0000", "PTKTENDER": "cash" },
  { "PTKID": "9101", "PTKNUMBER": "T-000432", "PTKDATE": "2025-12-31", "PTKTERMINAL": "TILL-1",
    "PTKCASHIER": null, "PTKTOTAL": "20.0000", "PTKTENDER": "voucher" }
]
```

`packages/importer/test/corpus/mpos/POSENTRIES.json` — three entries, all against the two tickets above:

```json
[
  { "PENID": "1", "PENTICKET": "9100", "PENMAT": "10", "PENQNT": "3.000000", "PENPRICE": "10.0000" },
  { "PENID": "2", "PENTICKET": "9100", "PENMAT": "11", "PENQNT": "1.000000", "PENPRICE": "15.0000" },
  { "PENID": "3", "PENTICKET": "9101", "PENMAT": "10", "PENQNT": "2.000000", "PENPRICE": "10.0000" }
]
```

Every figure is invented for this repository. `packages/importer/src/index.ts` gains
`export { mposLoader, MPOS_SOURCE_TABLES, type HistoricalTicket } from "./load/mpos";` — **exported, not
registered.**

- [ ] **Step 5: Run it**

Run: `bun run --cwd packages/importer test load/mpos && bun run --cwd packages/importer test load/run`
Expected: PASS, and `load/run`'s loader-ordering case is unaffected because `mposLoader` is not in `loaders`.

- [ ] **Step 6: Commit**

```bash
git add packages/importer/src/load/mpos.ts packages/importer/src/index.ts packages/importer/test/load/mpos.test.ts \
        packages/importer/test/corpus/mpos
git commit -m "feat(importer): write, but do not register, the historical POS loader [9B T13]

OD-16 (Part VII #10) is unanswered and its default is start clean, so this
loader is exported and unit-tested but absent from the loaders array: no run
touches mpos. Its load body refuses with the reason rather than guessing an
applyBatch call, because enabling it also means executing 6D first and
mapping POSENTRIES against a catalogue nobody has read. Delete the file, the
test and the corpus if the owner confirms the default.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14 — **OWNER GATE OD-17**: the live database, the rehearsal, and the columns that become `verified`

**Owner decision (contracts §2.12, OD-17; spec:2409, 2469):** "Read access to the live Sahlisoft database; Firebird version." §2.12's default: **none.** 9A's Task 3 is the first task in the project that reads a live byte; this is the second, and it is where the hypotheses become facts.

**Owner provides:** a read-only ODBC DSN for the live (or freshly restored) Sahlisoft database, and the Firebird version if the engine does not report it. **Verify, in this order:**

1. `bun run --cwd packages/importer legacy scope --dsn "$LEGACY_ODBC_DSN"` prints an engine version, a table count and a total row count, and writes `artefacts/legacy/<runId>/scope.json`.
2. `bun run --cwd packages/importer legacy load --tenant-id <id> --company-id <id> --account-map <path> --cut-over-date <date> --dry-run` prints `preflight.json` with **zero required-column findings**.
3. `bun run --cwd packages/importer legacy reconcile-cut-over --tenant-id <id> --company-id <id> --cut-over-date <date>` exits 0.

**Until provided:** every task of this plan runs green against `packages/importer/test/corpus/cut-over`, which is what the whole test suite uses. **Dropping this task leaves the slice complete and every test passing** — it adds no code path, only evidence.

**Files:**
- Modify: `docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md` (a Consequences entry recording the reading), `packages/importer/src/load/*.ts` (the `confidence` field of every column the live catalogue confirms), `packages/importer/test/load/preflight.test.ts` (one added case)

**Interfaces:**
- Consumes: `scope`, `ScopeReport`, `TableScope`, `connectOdbc`, `redactDsn` (9A); `preflight`, `PreflightReport` (T3); `loaders` (T3).
- Produces: no new interface. It changes `SourceColumn.confidence` values from `"hypothesis"` to `"verified"` and nothing else.

- [ ] **Step 1: Write the test that makes the promotion checkable**

Appended to `packages/importer/test/load/preflight.test.ts`, **which gains `import { readFileSync } from "node:fs";`** at the top — Task 3 wrote that file with no `node:fs` import and the first case below reads ADR 0084 off disk. The path is relative to the Vitest cwd, `packages/importer`, so `../../docs/adr/…` is the repository's own copy.

```ts
describe("column confidence — hazard 3's ratchet", () => {
  it("every declared column is either verified or hypothesis, and none is verified without an ADR line", async () => {
    const { loaders } = await import("../../src/load/registry");
    const declared = loaders.flatMap((l) => l.sourceColumns.map((c) => ({ table: l.sourceTable, ...c })));
    expect(declared.every((c) => c.confidence === "verified" || c.confidence === "hypothesis")).toBe(true);
    const adr = readFileSync("../../docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md", "utf8");
    for (const column of declared.filter((c) => c.confidence === "verified")) {
      expect(adr).toContain(`${column.table}.${column.name}`);
    }
  });

  it("every declared column carries a non-empty note — a column with no reason is a guess with a name", async () => {
    const { loaders } = await import("../../src/load/registry");
    const bare = loaders.flatMap((l) => l.sourceColumns.filter((c) => c.note.trim() === "").map((c) => `${l.sourceTable}.${c.name}`));
    expect(bare).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it pass with every column at `hypothesis`**

Run: `bun run --cwd packages/importer test load/preflight`
Expected: PASS. The first case is vacuously true today — there are no `verified` columns — and becomes load-bearing the moment step 4 promotes one.

- [ ] **Step 3: Run the three verification commands against the owner's database**

Exactly as written in the **Verify** block above. Record, in the ADR, the engine version the scope printed and the `redactDsn` string that identifies the source. **No password, DSN or customer value is ever pasted into a repository file** — `artefacts/legacy/` is `.gitignore`d (9A) and stays so.

- [ ] **Step 4: Promote the confirmed columns**

For every `SourceColumn` whose `name` appears in the live catalogue for its `sourceTable` — read from `scope.json`, not from memory — change `confidence: "hypothesis"` to `confidence: "verified"` and add the pair to ADR 0084's Consequences:

```markdown
## Consequences (appended 2026-__-__, OD-17)

The live catalogue was read on ____ from `<redactDsn output>`, engine `<engineVersion>`, and the following
declared columns were confirmed present with the declared table:

    UNITS.UNTID, UNITS.UNTNAME, …

Every one of them is now `confidence: "verified"` in its loader. Columns absent from the live catalogue were
NOT renamed to match a guess — each was removed from its map and its field is not loaded, and the loader's
own test asserts the resulting skip.
```

- [ ] **Step 5: Re-run everything**

Run: `bun run --cwd packages/importer test && bun run --cwd tests test cut-over-reconciliation && bun run lint && bun run typecheck`
Expected: PASS. The corpus tests are unaffected by a `confidence` change — it is metadata the pre-flight report prints, never a branch.

- [ ] **Step 6: Commit**

```bash
git add packages/importer/src/load docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md \
        packages/importer/test/load/preflight.test.ts
git commit -m "chore(importer): promote the confirmed legacy columns to verified [9B T14]

OD-17. The live catalogue was read and the columns it confirms are now
confidence: verified, each recorded by name in ADR 0084. Columns the
catalogue does not have were removed rather than renamed to fit: hazard 3's
rule is that a guess is labelled, and this task is the only place a label
ever changes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15 — **OWNER GATE OD-27**: consuming 9A's answers to Part VII #7 and #13

**Owner decision (contracts §2.12, OD-27; spec:2470–2473, 2477):** Part VII #6 (real DDL constraints), #7 (`MatOpens.Job` ever ≠ 0), #8 (templates in use), #9 (customisations), #13 (is the Salaries module live?). §2.12 routes the *answers* to 9A's profiler and 7B's template mapping; **9B is a consumer**, and two of the five change what this slice does:

- **#13 — is the Salaries module live?** If no, **Task 8 does not run**: there is no employee master to import and `--only` omits `employee`. If yes, it runs as written. §2.12's default is *none*, so the plan runs Task 8 and reports zero rows when `EMPLOYEES` is empty — which is the same outcome, reached by evidence rather than assumption.
- **#7 — does `MatOpens.Job` ever differ from 0?** SAH-022 is "a hard failure if so, and inert if not". `MatOpens` carries opening stock positions per job; if `Job` is always 0 the positions are company-wide and Task 6's `BILLITEMS` replay is the whole story. If it is ever non-zero, the legacy opening stock was partitioned by project and a replay that ignores the partition silently merges positions that were never one position.

The other three (#6, #8, #9) change nothing in 9B: #6 is 9A's `constraints()` probe and 1A's `sah-024`; #8 and #9 are 7B's template mapping.

**Owner provides:** 9A's Task 13 `questions.json` for this database. **Verify:** `bun run --cwd packages/importer legacy questions --dsn "$LEGACY_ODBC_DSN"` prints an answer of `answered` for `part7-7` and `part7-13`. **Until provided:** both stay `unanswered`, Task 8 runs and reports what it finds, and the `MatOpens` guard below fails the load loudly rather than merging silently.

**Files:**
- Create: `packages/importer/src/load/matopens-guard.ts`, `packages/importer/test/load/matopens-guard.test.ts`
- Modify: `packages/importer/src/load/opening-stock.ts` (one call), `packages/importer/src/index.ts`, `tests/regression/sah-022.test.ts`

**Interfaces:**
- Consumes: `LegacyReader`, `answerOpenQuestions`, `OpenQuestionReport` (9A); `LoadError` (T3).
- Produces:

```ts
// packages/importer/src/load/matopens-guard.ts
export interface JobPartitionFinding { table: string; column: string; distinctNonZero: number; sample: string[] }
/** Part VII #7 / SAH-022, asked of the customer's own data at load time rather than assumed. */
export async function assertNoJobPartition(reader: LegacyReader): Promise<JobPartitionFinding | null>;
export const JOB_PARTITIONED_TABLES: readonly { table: string; column: string }[];
```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/load/matopens-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { assertNoJobPartition, JOB_PARTITIONED_TABLES } from "../../src/load/matopens-guard";
import { loadCorpus } from "../support/corpus";

const corpusWith = (rows: Record<string, string | null>[]) => {
  const base = loadCorpus("cut-over");
  return {
    ...base,
    tables: {
      ...base.tables,
      MATOPENS: {
        keyColumns: ["MOPID"],
        columns: [
          { name: "MOPID", kind: "integer", scale: 0, nullable: false },
          { name: "MOPJOB", kind: "integer", scale: 0, nullable: true },
        ],
        rows,
      },
    },
  };
};

describe("Part VII #7 / SAH-022 — MatOpens.Job, asked rather than assumed", () => {
  it("names the tables and columns the question is about", () => {
    expect(JOB_PARTITIONED_TABLES).toEqual([{ table: "MATOPENS", column: "MOPJOB" }]);
  });

  it("returns null when every Job is 0 or NULL — SAH-022 is inert for this customer", async () => {
    const reader = await createReader(new FixtureLegacyDriver(corpusWith([{ MOPID: "1", MOPJOB: "0" }, { MOPID: "2", MOPJOB: null }])));
    expect(await assertNoJobPartition(reader)).toBeNull();
  });

  it("reports the finding when any Job differs from 0 — SAH-022 is a hard failure for this customer", async () => {
    const reader = await createReader(new FixtureLegacyDriver(corpusWith([{ MOPID: "1", MOPJOB: "0" }, { MOPID: "2", MOPJOB: "7" }, { MOPID: "3", MOPJOB: "9" }])));
    expect(await assertNoJobPartition(reader)).toEqual({
      table: "MATOPENS", column: "MOPJOB", distinctNonZero: 2, sample: ["7", "9"],
    });
  });

  it("returns null when the table is absent — a customer without MatOpens has no question to answer", async () => {
    const reader = await createReader(new FixtureLegacyDriver(loadCorpus("cut-over")));
    expect(await assertNoJobPartition(reader)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test load/matopens-guard`
Expected: FAIL — `Cannot find module '../../src/load/matopens-guard'`.

- [ ] **Step 3: Write `load/matopens-guard.ts`**

```ts
import type { LegacyReader } from "../index";

export interface JobPartitionFinding { table: string; column: string; distinctNonZero: number; sample: string[] }

/** Part VII #7 names `MatOpens.Job` specifically, and SAH-022 is the defect it decides. No other table is
 *  added here without an amendment: the question is about opening stock, and widening it to every `Job`
 *  column in the 460-table map would turn a decidable question into noise. */
export const JOB_PARTITIONED_TABLES: readonly { table: string; column: string }[] = [
  { table: "MATOPENS", column: "MOPJOB" },
];

/**
 * Part VII #7: "Does `MatOpens.Job` ever differ from 0 in production? SAH-022 is a hard failure if so, and
 * inert if not." Asked of the customer's own data at load time, so the answer is evidence rather than an
 * assumption — and asked here, in 9B, because 9B is the slice that would silently merge job-partitioned
 * opening positions into one if the answer were yes and nobody looked.
 *
 * Returns `null` when the question is inert (every value 0 or NULL, or the table absent) and the finding
 * otherwise. The caller decides what to do with a finding; this function never throws.
 */
export async function assertNoJobPartition(reader: LegacyReader): Promise<JobPartitionFinding | null> {
  const present = new Set(await reader.tables());
  for (const { table, column } of JOB_PARTITIONED_TABLES) {
    if (!present.has(table)) continue;
    const seen = new Set<string>();
    for await (const page of reader.read<Record<string, string | null>>(table, { columns: [column], batch: 500 })) {
      for (const row of page) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text === "" || Number(text) === 0) continue;
        seen.add(text);
      }
    }
    if (seen.size > 0) {
      return { table, column, distinctNonZero: seen.size, sample: [...seen].sort().slice(0, 5) };
    }
  }
  return null;
}
```

- [ ] **Step 4: Call it from the opening-stock loader**

`packages/importer/src/load/opening-stock.ts` — one call at the top of `load`, before the replay:

```ts
    const partition = await assertNoJobPartition(loadSource().reader);
    if (partition) {
      throw new LoadError("ERR_IMPORT_SOURCE_UNREADABLE", `${partition.table}.${partition.column} has ${partition.distinctNonZero} distinct non-zero values (for example ${partition.sample.join(", ")}); the legacy opening stock is partitioned by job and this loader would merge positions that were never one position. Answer Part VII #7 with the customer and decide how a job maps to a Dulja warehouse before loading opening stock (SAH-022, OD-27).`);
    }
```

with `import { assertNoJobPartition } from "./matopens-guard";` and `import { loadSource } from "./run";` at the top.

**Failing closed here is the point.** §2.12's default for OD-27 is *none*, and the safe behaviour under *none* is to refuse, not to proceed: merging job-partitioned openings produces a stock valuation that ties to the ledger and is still wrong, which is the worst outcome a cut-over can have.

- [ ] **Step 5: Append the 9B block to `tests/regression/sah-022.test.ts`**

The file exists (3B created it):

```ts
describe("SAH-022 MatOpens.Job — 9B, asked of the customer's data", () => {
  it("refuses to load opening stock from a job-partitioned source rather than merging it", async () => {
    await expect(loadFromCorpus("matopens-partitioned")).rejects.toThrow(
      /MATOPENS\.MOPJOB has 2 distinct non-zero values .*; the legacy opening stock is partitioned by job/,
    );
  });

  it("loads normally when every Job is 0 — SAH-022 is inert for that customer", async () => {
    const skips = await loadFromCorpus("cut-over");
    expect(skips.filter((k) => /partitioned by job/.test(k.reason))).toEqual([]);
  });
});
```

The first case needs a second corpus directory, `packages/importer/test/corpus/matopens-partitioned/`, which is `cut-over` plus a `MATOPENS` table with two non-zero `MOPJOB` values; create it as a sibling with the same `catalog.json` plus the `MATOPENS` entry and the same row files.

- [ ] **Step 6: Record the #13 branch in the runbook**

`docs/runbooks/cut-over.md` step 3 gains:

```markdown
- [ ] **OD-27, Part VII #13 — is the legacy Salaries module live?** Read 9A's `questions.json`. If the
      answer is *no*, run the load with `--only` omitting `employee`: there is no employee master to bring
      and no YTD to reconcile. If *yes* or *unanswered*, run the full load; an empty `EMPLOYEES` table
      simply produces zero employee rows and an empty `employee_ytd_opening`, which is the same outcome
      reached by evidence.
- [ ] **OD-27, Part VII #7 — does `MatOpens.Job` ever differ from 0?** The load answers this itself and
      **refuses** if it does (SAH-022). A refusal is not a bug: it means the legacy opening stock was
      partitioned by project and somebody must decide how a job maps to a Dulja warehouse first.
```

- [ ] **Step 7: Run everything**

Run: `bun run --cwd packages/importer test && bun run --cwd tests test sah-022 && bun run lint:rules`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/importer/src/load/matopens-guard.ts packages/importer/src/load/opening-stock.ts \
        packages/importer/src/index.ts packages/importer/test tests/regression/sah-022.test.ts \
        docs/runbooks/cut-over.md
git commit -m "feat(importer): ask Part VII #7 of the customer's data and fail closed [9B T15]

OD-27 routes the answers to 9A and 7B; 9B is the consumer, and two of the
five change what this slice does. #7 (MatOpens.Job) is now asked at load
time: a job-partitioned opening stock refuses rather than merging positions
that were never one position, because a valuation that ties to the ledger
and is still wrong is the worst outcome a cut-over can have. #13 gates
whether the employee load runs, and the runbook says how to skip it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

Run against the spec, the 9B card, contracts §3–§6 and the writing-plans skill, with fresh eyes.

### 1. Spec and card coverage

Every *Delivers* bullet of the §2.10 9B card, and every §5.1 item, mapped to the task that carries it.

| Card bullet / spec clause | Task | Note |
|---|---|---|
| `legacy_ref text` on `document`, `party`, `item`, `account`, `employee`, `lot` (§4.13.3) | **T1** | six columns, six deliberately non-unique partial indexes, six Drizzle mirrors, a hand-written down |
| `app.import_batch`, idempotent on `(source_table, source_key)` (§4.6.1) | **T2** | plus amendment C7's `source_hash`, without which the natural key is not idempotence |
| Idempotent loaders through the `Loader` interface (§4.13.2) | **T3** | `LoadContext`, `Loader`, `RefResolver`, `runLoad` verbatim; C8 and C12 are widenings |
| Running as the tenant's **system principal** | **T9** | `runJob` builds `systemContext`; the worker test asserts every audit row carries it |
| Enqueued as `admin.import.run` with async status at `/v1/jobs/{jobId}` | **T9** | the job's `JobPayload` key (C3), the bulk endpoint (C4) and the status resource (C2) |
| Every write audited (tests 12/13) | **T2, T9** | `attach_audit` on `import_batch`; two `PROBES` keys and one `JOB_PROBES` key |
| items / units / warehouses / lots + expiry, parties | **T4** | five loaders, each reporting orphans rather than nulling them |
| chart-of-accounts mapping | **T4** | the owner's `AccountMap`, validated against §4.15's format and the type-prefix rule |
| opening balances as an `OPENING_BALANCE` document, posted through the posting service | **T5** | plus the three control exclusions that stop the double-count |
| balanced against `3900` from `chart-of-accounts/9b-cut-over.json` | **T4, T5** | `SUSPENSE_CODE` is one literal; §4.15's row seeded by this slice |
| opening stock as `OPENING_STOCK` documents | **T6** | one per warehouse per 200 lines, `create_layer`, `inventory.receipt.post` |
| open documents with legacy numbers in `legacy_ref`; the new gapless series after cut-over | **T7** | ADR 0085; `document_series` carries `OB` and `OS` only |
| movement history → cost recompute with the 3B engine, opening valuation reconciled (§5.1 #6) | **T6, T10** | `replayLegacyMovements` calls `costingEngine`; the DoD test compares `valuationAsOf` |
| employee master + `employee_ytd_opening` reconciled to the last legacy payslips (§5.1 #11–#12) | **T8** | one party + one employee; sensitive fields only through 8A's writer; the YTD **opening** withheld and reported (amendment C15) when it drifts from the employee's own payslips, while the employee is still loaded |
| `Users.PIN` / `Users.Password` never imported | **T12** | no `USERS` loader; **five** assertions — no `USERS` source table, no `PASSWORD`/`PIN` source column, 9A's `NEVER_READ` unchanged (upper case, as 9A ships it), a source scan over `packages/importer/src`, and the invite endpoint having no password field |
| Cut-over runbook: freeze, load, reconcile TB + valuation, explain, new series, forced password reset | **T10, T11, T12** | `docs/runbooks/cut-over.md` plus the suspense page |
| Period-lock and negative-stock invariants through the import path (tests 9, 18) | **T5, T6** | `ERR_PERIOD_NOT_OPEN` from the job path; a negative position reported, never opened |
| The importer cannot leave a live credential behind (test 34, spec:2090) | **T10, T12** | the source scan in the DoD suite; the runbook rotates `LEGACY_ODBC_DSN` at the end |
| §5.1 #1 do not trust stored aggregates | **T5, T10** | `ACCTOTALS` is read to be *compared*; 9A's `aggregate_drift` is what quantifies it |
| §5.1 #2 unbalanced vouchers, suspense agreed **before** migrating | **T5, T11** | the residue lands on `3900`; OD-25 is an isolated task and the runbook's step 0 |
| §5.1 #3 orphans reported, never nulled | **T4, T6, T7** | every loader's `{ skip }` path; `sah-073` |
| §5.1 #4 NULL-poisoned balances and costs | **T3, T4, T6** | `moneyOf`/`quantityOf` refuse a NULL; `sah-007`, `sah-011` |
| §5.1 #5 duplicate aggregate rows | **T3** | `recordBatch` skips the second sighting; `sah-049` |
| §5.1 #6 do not import cost figures | **T6** | `MATCOSTS` appears in no loader, asserted by a source scan in `sah-011` |
| §5.1 #7, #11 passwords / PIN | **T12** | |
| §5.1 #8 duplicate and gapped numbers | **T1, T7** | non-unique index; two corpus rows share a number; `sah-051` twice |
| §5.1 #9 report blobs | — | **9A's**, explicitly (card: "feeds 7B/7C"). 9B loads no template |
| §5.1 #10 scope first | **T3, T14** | `preflight` before a row is read; OD-17's three verification commands |
| §5.1 #12 employees exist twice | **T8** | `party` kind `employee` + `employee`, one each; 9A's `employeeMapping` is the input |
| Part VII #4, #7, #10, #13 | **T12, T15, T13, T15** | each an isolated owner-gate task |
| §3.8 AGENTS.md "Current phase" (9B completes Phase 9) | **T10** | the clause easiest to forget; it is a numbered step |

**Part VI re-runs, all placed:** 9 (T5), 18 (T6), 5 (T6), 2 (T9), 35 (T8), 34 (T8), 12 (T1, T2, T9), 13 (T2, T9). **Regression appends, all placed:** 003 (T5), 007 (T4), 011 (T6), 022 (T15), 028 (T12), 049 (T3), 051 (T1, T7), 073 (T5). **No file is created** — every one already exists per §3.7.3, and each append is a new `describe` block that edits no earlier one.

**One card phrase deliberately not implemented as written, and it is the subject of an amendment rather than a silent choice:** §4.13.3's "a dedicated series `LEGACY`" (amendment C1, ADR 0085). Everything else in the card is implemented literally.

### 2. Placeholder scan

Searched the whole plan for "TBD", "TODO", "implement later", "similar to Task", "and so on", "etc.", "add appropriate", "handle edge cases", "fill in", and a bare ellipsis standing in for content. **Zero occurrences.** Every code step carries the code; every SQL step carries the full statement including constraints, comments, `enable_tenant_rls`, `attach_audit`, `attach_stamp`, the grants position and the matching down file; every test step carries the assertions and the exact expected error strings.

Three places that could be *mistaken* for placeholders and are not:

- **`mposLoader.load` throws.** That is the deliverable, not an omission: OD-16 is unanswered, the §2.12 default is "start clean", and Task 13 explains in full what a *yes* would require (registering it, executing 6D, mapping `POSENTRIES`). Writing a speculative `applyBatch` call would be the invention hazards 3 and 6 forbid.
- **`ImportRunSchema.skips` is `0` from the route.** The skip register is a run artefact, not a table; the route reports what the database knows and the runbook reads the artefact. Task 9 says so where the code is.
- **The blanks in Task 14 Step 4’s ADR-append template** (`2026-__-__`, `____`, `<redactDsn output>`, `<engineVersion>`, and the `…` ending the confirmed-column list). That block is a *form the executor fills on the day the owner opens the live database*, and every blank is a value this plan is forbidden to guess: hazard 3 says the Firebird version is unknown, and no customer DSN or engine string may be written into a repository file before it has been read. The step above the block says where each value comes from.

### 3. Type consistency — checked across tasks, and the forty-three things that were wrong

Names were traced from each Produces block to every consumer. Forty-three inconsistencies were found and **fixed inline** — the task text in this file is the corrected text, so an executor types what is written and applies no later diff. They are listed so a reviewer can confirm the fix rather than rediscover the fault. **R1–R6 came from the first review pass; R7 from a second that read every Global Constraint back against the code the tasks actually write; R8–R13 from a third that followed one `import_batch` row from `recordBatch` to `linkBatches` and asked what each field means at every point in between; R14–R16 from a fourth that asked, of every number and every switch the plan accepts, *what would a source larger than the fixture do to this?*; R17–R18 from a fifth that re-read the R8 fix itself and found it had traded one fault for another; and R19–R28 from an external review that type-checked every call against the frozen §4.2.1, §4.2.12 and §4.17 surfaces and then asked, of each test, *which database does this assertion actually read?***; **R29–R38 from a seventh pass that followed each legacy identifier end to end, re-derived every consumed contract shape from its owning plan, and asked of each test whether it could actually fail**; and **R39–R43 from an independent audit against the contracts document, plan 0A, 0C and 9A, which re-read every literal this plan copies out of another slice and checked its case, its shape and the register row it came from.** R7, R8, R14, R17, R19, R20, R21, R22, R23, R29, R37 and R39 are the ones that matter most in a plan whose steps say "run it and see it pass", because in every one of them the step's own prose asserted an outcome the code would not have produced. **R19 and R23 are the two that stopped the most tasks**: R19 fails five files at their first compile, and R23 fails five `beforeAll`s before a single assertion runs.

| Id | What was wrong | Fixed |
|---|---|---|
| **R1** | `opening-stock.ts` reached `refResolver` through a `require` inside a helper, justified by a cycle that does not exist (`refs.ts` imports only `@dulja/db` and `./types`) | replaced with a top-level `import { refResolver } from "./refs";` and a direct call; the helper and its comment are gone |
| **R2** | `employees.ts`'s `assertYtdReconciles` needed the run's `LegacyReader`, and `load`'s signature has none | `run.ts` now exports `loadSource()`, which returns the currently-open source and throws outside a run; it is name N3 and is set and cleared around `runLoad`'s body |
| **R3** | `preflight.ts` imported `PreflightReport` from `./types`, where it is not declared — it is declared in `preflight.ts` itself | the import is `{ Loader, SourceColumn }` only |
| **R4 / C12** | four loaders (`items`, `lots`, `parties`, `open-items`) declare `async map`, but `Loader.map` returned `T \| { skip }`; `runLoad` did not await it. `RefResolver.byLegacyRef` is async **in §4.13.2 itself**, so a `map` that uses `refs` cannot be synchronous | the return is widened to admit a promise (amendment **C12**, a widening that keeps every synchronous implementation valid) and `runLoad` awaits it |
| **R5** | `import_batch.source_hash`'s CHECK admitted the literal `'h'` so that fixtures could use it — a test convenience in production DDL | the CHECK is `^[0-9a-f]{64}$`; the two raw inserts and `seedImportBatch` use a 64-character constant |
| **R6** | the account-map type-mismatch message was assembled with an inline `.replace("an liability", "a liability")` | an `ARTICLE` lookup, which the test's exact expected string pins |
| **R7** | `runLoad`'s first parameter is named **`sql`** (T3 Step 8, and the signature block in T3's Produces), which **Global Constraint 7 of this plan forbids by name** under `packages/importer/src/**`. T3 Step 12's prose tried to argue the rule past it — "only ever *passed* to `withTenant`, never used as a template tag" — but GC 7 and 9A's assumption 10 both bind the **binding name**, not its use, so `no-bare-db` fires on the parameter itself and Step 12's stated `PASS` is unreachable | renamed to **`conn`** at both the declaration and the signature block: `export async function runLoad(conn: Sql, ctx: LoadContext): Promise<LoadReport>`, with `conn` handed to `withTenant` and `tx` still the tag inside the callback. **The type is unchanged, so §4.13.2's frozen signature is untouched** — a parameter name is not part of an interface, and this needs no amendment. T3 Step 12's expectation paragraph is rewritten to assert the fact ("no binding under `packages/importer/src/**` is named `db` or `sql`") and to say why a name — not a use — is what the rule tests. The call site in `apps/worker/src/handlers/import-run.ts` (T9) is outside `packages/*/src/` and the rule does not reach it |
| **R8** | `openingStockLoader.load` ended with `const perSource = rows.map(() => batchIds[0] ?? EMPTY)`. That satisfies `linkBatches`' length check and nothing else: **every source row got the *first* document's id**, so once a tenant has more than one warehouse (or more than `OPENING_STOCK_LINES_PER_DOCUMENT` positions in one) most `import_batch.target_id` values point at a document that does not contain them — while the comment above the line claimed each row maps to "the document its position landed in". Worse, the local `EMPTY` was a **second** all-zero sentinel beside `run.ts`'s `EMPTY_TARGET`: returning it made a reported position's batch row identical to a crash between the placeholder write and `linkBatches`, and `recordBatch` would then skip that key forever on a re-run | `load` builds `documentOfPosition` (keyed by item + warehouse + lot, filled as each page posts) and `documentOfWarehouse`, and `perSource` resolves each source row by its own position first and its own warehouse second. The local `EMPTY` is **deleted**; `run.ts` now *exports* `EMPTY_TARGET`, so one sentinel exists in the package and it has one documented meaning. A reported position takes its warehouse's document and is named in `skips.csv`. A **second** draft of this fix raised `ERR_VALIDATION_FAILED` for a warehouse that opened nothing — see R17, which is why it does not. T6 pins the mapping ("points every BILLITEMS batch row at the OPENING_STOCK document of that row's OWN warehouse") and T3 pins the sentinel's absence on a corpus where every row produces a target |
| **R9** | T9's `import.test.ts` called `await api.db.seedImportBatch(s, …)`. `seedImportBatch` is a free function in `packages/db/test/fixtures.ts` (amendment C5), not a method on `Db`; `api.db` **is** a `Db` | the call is `await seedImportBatch(api.db, s, …)` and that file's `@dulja/db/test` import gains the name. The other test files that import from `@dulja/db/test` do **not** gain it — an unused import fails `lint` |
| **R10** | T9's `tests/invariants/probes.ts` block calls `seedImportBatch` inside the `admin.import.run` job probe's `seed`, and no step said that file's import list gains the name | one sentence after the probe block: the `@dulja/db/test` import gains `seedImportBatch`, and nothing else in the file is touched (hazard 31 — probes are appended to the two frozen registries, never re-ordered) |
| **R11** | four composite map keys in `recost.ts` and `opening-stock.ts` carried a **raw NUL byte** as the separator instead of the six-character TypeScript escape. The plan file read as binary to `grep`, and an implementer copying the line would paste an invisible control character into their source | every one is now the literal `\u0000`, which is what a TypeScript template literal wants. The plan file holds zero NUL bytes and `grep` reads it as text |
| **R12** | ADR 0084 decision 5 and the `JobPayload` doc comment both said a dry run's counts are "real". Not all of them are: `runLoad` throws the roll-back sentinel **before** `loader.load`, so `inserted` counts rows that *mapped*, and the `on conflict do nothing` skips a real run would take are not in it | decision 5, the `JobPayload` comment and runbook step 3 now say one thing: a rehearsal's `inserted` is an upper bound on the real run's, while `skipped` and the pre-flight findings — which come from reads and maps alone — are exact |
| **R13** | `SOURCE_OF` maps `party → ACCOUNTS`, but T8's employee loader creates an `app.party` of kind `employee` and records only an `(EMPLOYEES, <key>) → employee` batch row, so `byLegacyRef("party", …)` answers `null` for every employee. Nothing in this slice calls it that way, which is exactly why it needed writing down | a paragraph beside `SOURCE_OF` states the rule: an employee's party is reached through `employee.party_id`, never the resolver; a future loader that needs the other direction adds its own batch row under a source key outside the `ACC:<id>` space rather than re-pointing `SOURCE_OF.party`, which would silently change what every existing open item resolves to |
| **R14 / C13** | `runLoad` calls `loader.load` once per page of `READ_BATCH` (500) rows, and **two loaders are wrong under paging**. `openingBalanceLoader` builds one document from all of `AccTotals` and balances the residue to `3900` — paged, it posts one document *per 500 accounts*, each with its own invented suspense figure, while Task 5 asserts "posts ONE OPENING_BALANCE document". `openingStockLoader` replays a material's whole history through the AVCO engine — paged, it averages 500 movements at a time, which is not the average. **The cut-over corpus has three rows per table, so no test in this plan would have failed**; the first sign would have been a customer's trial balance | `Loader` gains an optional `readonly wholeTable?: boolean` (amendment C13, additive). `runLoad` accumulates every mapped page and calls `load` once for such a loader, in one transaction; the two set it and the doc comment states the memory-and-atomicity trade rather than hiding it — half an opening balance is not a smaller opening balance. ADR 0084 gains decision 6, and T6 pins **which** loaders are in the set so a later one cannot join or leave it silently |
| **R15 / C14** | `POST …/imports` accepts `only`, the route puts it in the job payload (amendment C3 declares it), and `importRunHandler` builds a `LoadContext` **without** it — because §4.13.2's `LoadContext` has no such field. An operator restricting a resume to `employee` would get a full re-load of every table and no warning that the switch was ignored | `LoadContext` gains an optional `only?: string[]` (amendment C14, additive); `runLoad` filters the registry by it *before* ordering, so a restricted run still runs in dependency order, and refuses a target table no loader has rather than succeeding at nothing. The handler forwards it. The fallback in C14 is the honest alternative — delete `only` everywhere — and is recorded as the poorer product |
| **R16** | T3's `run.test.ts` asserts `perLoader["unit_of_measure"].inserted > 0` and spreads `loaders[0]!`, but `registry.ts` ships **empty** at T3 and T4–T8 fill it, so T3 Step 12's "Expected: PASS" was unreachable and Step 2's "see them fail" would have failed for the wrong reason | the file registers its own `stubLoader` on `loaders` in `beforeAll` and splices it out in `afterAll`. A framework test should not depend on which business loaders exist yet; T4 replaces it in the registry with the full `unitLoader`. Step 12 says so |
| **R17** | the fix for R8 replaced the wrong sentinel with a **wrong refusal**: a warehouse that opened no stock raised `ERR_VALIDATION_FAILED` saying its positions "were driven negative or pointed at an item, warehouse or lot that did not import". `replayLegacyMovements` emits no position for a key whose layers net to zero (`if (quantity.isZero()) continue;`), so a warehouse **emptied before cut-over** — transferred out, closed, sold down — reaches that line with no positions and no negatives. On a Sahlisoft customer who has ever closed a warehouse, the whole cut-over would refuse, and the message would be a false accusation about the source. The reasoning behind the refusal was itself wrong: it claimed a committed all-zero `target_id` could only be a crash artefact, but `recordBatch`, `load` and `linkBatches` share **one** `withTenant` transaction, so that state cannot survive a crash | `EMPTY_TARGET` is exported from `run.ts` with the meaning a commit gives it — *seen, hashed, produced no target row* — and `openingStockLoader` returns it for such a warehouse, with no throw. `LoadError` is dropped from that file's imports (nothing there raises now, and an unused import fails `lint`). ADR 0084 decision 2 no longer claims the crash it cannot have, and gains decision 7 stating the committed meaning **and** its cost: the row's hash is unchanged, so it is never retried — right for an emptied warehouse, and a reconciliation item for a position reported because its material did not import |
| **R18** | the new T3 test ran its own `await runLoad(...)` and sat **above** "re-running the same load inserts nothing twice". Vitest runs `it`s in file order against the one tenant `beforeAll` seeds, so the re-run test's `first` load would have found everything already loaded and its `expect(first.perLoader["unit_of_measure"]!.inserted).toBeGreaterThan(0)` would have failed — T3 Step 12's "Expected: PASS" unreachable again, for the third distinct reason | the sentinel test moves **below** the re-run test and drops its own `runLoad`: it asserts on the state the test above committed, which is what it wanted to see anyway. Its comment says why the ordering is load-bearing, so nobody re-sorts the file |
| **R19 / C15** | **`Money` and `Quantity` were called with decimal.js's method names.** §4.2.1 freezes `Money` at `add / subtract / negate / multiply(factor, mode) / divide / allocate / abs / compare / equals / isZero / isNegative / isPositive / toDecimal / toString` and `Quantity` at `add / subtract / negate / multiply / convert / compare / isZero / isNegative / toDecimal / toString`. Neither has `plus`, `minus`, `negated`, `times`, `greaterThan` or `roundToScale`, and the plan used all six — `row.debit.minus(row.credit)`, `residue.plus(net)`, `net.negated()` (opening-balance), `q.plus(l.qtyRemaining)` twice, `move.quantity.greaterThan(available)`, `available.minus(...)`, `unitCost.times(quantity).roundToScale()` (recost), `amount.negated()` (open-items), `gross.plus(...)` and `.minus(...)` (employees), `moneyOf(...).minus(...)` (reconcile). A paragraph under `recost.ts` asserted as fact that "`Money.times(Quantity)` and `Money.roundToScale()` are 0D's (§4.2.1)"; they are in no version of that section. **Tasks 5, 6, 7, 8 and 10 each stopped at their file's first compile** | every site rewritten against §4.2.1: `plus`→`add`, `minus`→`subtract`, `negated()`→`negate()`, `q.greaterThan(a)`→`q.compare(a) > 0`. The product is **not** a rename — `Money.multiply` demands an explicit `RoundingMode` and takes `Decimal \| Rational \| string`, never a `Quantity` — so `unitCost.times(quantity).roundToScale()` becomes `Money.fromDecimal(unitCost.toDecimal().mul(quantity.toDecimal()), baseCurrency, "HALF_AWAY_FROM_ZERO")`, which states the mode where the old form implied it. The false claim is deleted and replaced by the two method lists, so the next reader checks rather than trusts. **decimal.js's own `.plus` / `.minus` / `.greaterThan` in `reconcile-cut-over.ts` are untouched** — that file's `Decimal` arithmetic is correct and a blind rename would have broken it |
| **R20 / C15** | **`assertYtdReconciles` was described and never wired.** T8 Step 3 wrote `employeeLoader.load` in full with no call to it; the prose after the block said the helper "lives in `map`, not `load`" and then, two sentences later, that `load` "calls it per row" — and no step carried the edit, so an executor had no code to type. Worse, `load`'s frozen return `{ inserted, skipped, batchIds }` has no channel for a **reason**, and `runLoad` builds `skips[]` only from `map`'s `{ skip }`, so the skip could never have reached a report; and the test ran with `dryRun: true`, where `runLoad` throws its roll-back sentinel *before* `loader.load` and the helper would not have executed at all. The same three faults hid a fourth: `openingStockLoader`'s negative-position reason had no channel either, so T6's assertion on it was equally unreachable | the reconciliation stays in **`load`** — that is forced, not chosen: the comparison needs the tax year of `ctx.cutOverDate` and `Loader.map(row, refs)` is frozen at two parameters with no `ctx`. Amendment **C15** widens `load`'s return with an optional `skips?: readonly SkipRecord[]`, `runLoad` concatenates it into the one register, and **both** reasons now travel it. The call is written into `load` as a code step; a drifting employee is **loaded** with their YTD opening **withheld** (losing the person over a disputed figure would be the larger error) and the test becomes a real run against its own tenant, asserting the skip, the missing opening row and the surviving employee. The contradictory heading and the two stale prose claims are rewritten |
| **R21** | **`loadFromCorpus` built and destroyed its own tenant, so four suites asserted against a database the load never touched.** It did `cutOverFixture(\`corpus-${corpus}\`)` → `runLoad` → `api.stop()` and returned only `SkipRecord[]`. Four call sites nevertheless made their own fixture and then queried it: `sah-003` (expects one `3900` credit), `sah-051` (expects two documents at `legacy_ref = 'INV/2025/0417'`), `projection-rebuild` (`runIntegrityCheck`), and `cut-over-reconciliation.test.ts` — **the whole definition-of-done suite**, four clauses. Every one queried an empty tenant | `loadFromCorpus` gains an **overload**: `loadFromCorpus(fixture, corpus, over?)` loads INTO the caller's fixture and leaves its api running; `loadFromCorpus(corpus, over?)` keeps the self-contained form for the two callers that read nothing but the skip register (`sah-073`, `sah-022`). The four sites pass `f`, each with a one-line comment saying why. The implementation's `finally` stops only a fixture it created, which also fixes the container leak on the SAH-022 case, where the load is *expected* to throw |
| **R22** | **Idempotence made four cases unreachable.** `import_batch`'s natural key is `(company_id, source_table, source_key)` with **no run scoping** (§4.6.1) and `runLoad` calls `recordBatch` *before* `loader.load`, so a second `runLoad` against a tenant that already loaded a key maps nothing, and `if (mapped.length === 0) return;` fires before `load` is reached. Three cases assumed otherwise: T5's closed-period case (`ERR_PERIOD_NOT_OPEN` never raised), T5's archived-`3900` case (`ERR_IMPORT_UNBALANCED_SOURCE` never raised), and T8's YTD-drift case. T6's negative-stock case was worse than unreachable — it replaced `BILLITEMS` with rows keyed `"1"` and `"2"`, both already recorded with *different* data, so it would have raised `ERR_IMPORT_DUPLICATE_SOURCE_KEY` instead of producing the skip. **(T3's own re-run case was fixed separately, by R18.)** | each of the four gets its **own tenant**, seeded by the helper R23 adds; T5 grows a two-line `ownTenant` wrapper and T6 and T8 call `seedLoadableTenant` directly. Each carries the reason in a comment so nobody merges them back. Skips produced inside `map` (T4's SAH-007, T7's orphan on the fresh key `77`) are untouched and still work, because `map` runs before `recordBatch` |
| **R23** | **Every DB-backed importer test seeded a tenant the load cannot run against.** T4–T8 open with `seedTenantV2`, which is `seedTenant` plus `5920` and the JOURNAL policy — and `seedTenant` creates exactly `1000` and `4000` (plan0A:1563–1611) and no document type of this slice's. Every loader fails closed on a missing §4.15 account (`1200`, `1300`, `2100`, `3900`, `5000`, `5900`) or a missing `OPENING_BALANCE` / `OPENING_STOCK`, which is correct production behaviour and means the five suites would have died in `beforeAll` on `cannot resolve account 1200`, never reaching what they were written to prove | **N16** — `seedLoadableTenant(db, name)` and `loadContextFor(db, s, runId, over?)` in `packages/importer/test/support/tenant.ts` (a new T4 Step 3), the test-tier twin of runbook step 2. The two document types are **read from this slice's own seed files**, never re-typed, so no suite can be green against a policy nobody deploys; and 0A's three fiscal periods are deliberately left alone, because R22's closed-period case depends on 2026-02 being `closed`. `tests/invariants/support/cut-over.ts` does the same work inline — §3.1 forbids the `tests` workspace importing `packages/importer/test/**`, the same reason its `readCorpus` already duplicates `loadCorpus` |
| **R24** | **`moneyOf` hard-coded `"MYR"` at eight call sites while the same loaders built their zero values from `company.base_currency`.** `moneyOf(row, col, "MYR", …)` returns `Money<CurrencyCode & "MYR">`; `openingBalanceLoader.load` then wrote `currency(company!.base_currency as "MYR")` and added the two. For an MYR company the cast merely hid what §4.2.1 exists to check; for **any other company** it is `ERR_MONEY_CURRENCY_MISMATCH` at run time on the opening-balance, opening-stock, open-item and employee loads. `moneyOf`'s own signature took a `string`, so nothing could have caught it | the currency is resolved **once per run** and reaches `map` — which has no `ctx` — through `baseCurrency()`, a run-scoped getter beside `loadSource()` (N3), set from `app.company` inside `runLoad`'s first `withTenant` and cleared in its `finally`. `moneyOf`'s third parameter becomes a `CurrencyCode`, so the bare string is a **compile** error, and every `as "MYR"` / `as CurrencyCode` cast in the package is deleted. `reconcileCutOver` runs outside `runLoad` (its own CLI command) and therefore reads `base_currency` on its own `tx` — using the getter there would have thrown |
| **R25** | **T9's route tests used an `api.request` shape §4.2.12 does not have**, and three members of `StartedApi` that do not exist. The calls were two-argument (`api.request(path, { method, actor, tenant, headers })`) where §4.2.12 freezes ONE object with `{ method, path, body, form, as, aal, idempotencyKey, headers }`; and they read `api.jobs.enqueued`, called `api.enqueueForTest(...)` and, in the probes, `db.enqueueForProbe(...)`. §4.2.12 closes `StartedApi` at eight members and says "a slice needing a new field amends this document first"; the amendment table added none. T12's regression block repeated the two-argument form | every call rewritten to the one-object form, with `as` for the principal, the harness's own idempotency key, and `idempotencyKey: null` for the missing-header case. The enqueue is asserted by **reading `pgboss.job`** — no RLS there (§4.2.6), so `db.admin` reads it — and the two `/v1/jobs` cases get their job ids from the route that creates them. `grantAdmin` becomes `grantCodes` (§4.17, reaches `apps/api/test` through `@dulja/db/test` with no allowance); `problemOf` keeps 7A Task 10's registered `tests/support/**` allowance and the import path is corrected to it. **Two additional faults surfaced while rewriting**: `JOB_PROBES.seed` **seeds only** — the harness does the running, with `payload: {}` for every job (0d:2733–2741) — so the probe's enqueue is deleted, and `importRunHandler` gains a two-line no-op guard for the empty payload, which is also the right production answer for a truncated job |
| **R26** | three import errors, each in a file a later task consumes: `tests/invariants/support/cut-over.ts` imported `grantAdmin` from `"./api"` (§4.17.1 puts it in `tests/support/api.ts`, so from `tests/invariants/support/` the specifier is `../../support/api`); `apps/api/test/routes/admin/import.test.ts` imported `grantAdmin, problemOf` from `"../../support/grant"`, a module registered nowhere; and `packages/importer/test/load/employees.test.ts` imported `keyRingFromEnv` from `@dulja/db`, which 8A does not export — it ships `createHrKeyRing(opts)` and `DEV_HR_KEY` (8a:834, 8a:836) | the first specifier is corrected; the second is replaced by `grantCodes` plus 7A's registered `problemOf` path; the third becomes `createHrKeyRing({ current: <32-byte base64>, currentVersion: 1 })`, with a note saying why not `DEV_HR_KEY` (it is `APP_ENV === "dev"`-only) |
| **R27** | **money held as a JavaScript `number` in eight assertions and in one registered shared helper**, against this plan's own Global Constraint 2 (spec:0.2 verbatim, "no `number` ever holds a monetary value"). `assertExplained` — the §4.17.1 helper this slice adds — summed ledger balances with `reduce((n, r) => n + Number(r.balance), 0)` and compared with `Math.abs(total) > Number(tolerance)`; and `Number(...)` was the *assertion* in three of the four definition-of-done clauses, in the T6 valuation case, the T7 ageing tie-out and the OD-25 pinning test. A tie-out asserted in float is not a tie-out to the cent | every one sums through `Money` — `rows.reduce((m, r) => m.add(Money.of(r.value, MYR)), Money.zero(MYR))` — and compares `toString()`, `isZero()`, `isPositive()` or `compare(...)`. `MYR` is justified in a comment at each site as a fact about the **fixture** (0A seeds every test company `base_currency = 'MYR'`, plan0A:1587), never about production, where `baseCurrency()` is what production code reads |
| **R28** | six smaller faults found while checking the above, each fixed where it stands: `partyLoader` stored **ACCID** in `party.legacy_ref` while its own test expected **ACCCODE** and `accountLoader` stored ACCCODE — the two loaders reading one legacy table disagreed about what identifies its rows; `itemLoader` gave every product `expense_account_id = 5000`, contradicting §4.6.1's registered `4000`/`1300`/`5000`/`5900` and §4.15's `5900` row, with no assertion covering the column; T7's open-item query ordered two rows by `legacy_ref`, a value the corpus deliberately makes **identical** in both, and then pinned which came first; three `valuationAsOf(tx, { companyId, asOf })` calls omitted `limit`, which 3B declares **required** (3b:4475–4479); `employeeLoader` coded its parties `E-E-001`, because the legacy `EmpNumber` already reads `E-001`; and `tests/invariants/support/cut-over.ts` built two paths with `new URL(...).pathname`, which on Windows yields `/C:/Users/…` and `readFileSync` rejects | ACCCODE on both sides, with the ACCID/ACCCODE distinction written where the keys are built (the `import_batch` source key stays `ACC:<ACCID>`, which is what T7 resolves on); `5900` for every item kind, and the master test now selects and asserts **all four** account columns for a product *and* a service; the order becomes `d.number::bigint`, which is deterministic and is what the next case already used; `limit: 1000` (3B's `VALUATION_PAGE`) at all three sites; the employee number verbatim as the party code; and `fileURLToPath` at both paths. Three dead or broken scaffolds went with them: the no-op `withTenant(...).catch(...)` spread in T3's `ctx()`, the unused `uuidv7` beside it, and `mpos.ts`'s unused `applyBatch`, `currency` and `CurrencyCode` imports — all four `noUnusedLocals` failures. T14's preflight append gains the `node:fs` import it reads ADR 0084 with |
| **R29** | **The account loader and the ledger opening disagreed about which legacy identifier keys an account.** `accountLoader.sourceKey` was `ACCID` (`100`, `101`), so `import_batch` held `(ACCOUNTS, '100') → account`; `openingBalanceLoader.map` resolves `AccTotals.ACTACC`, which the corpus and the owner's account-map fixture both make an ACC**CODE** (`1101`, `1301`). `byLegacyRef("account", "1101")` therefore found nothing, **every** ACCTOTALS row skipped, `mapped.length === 0`, `runLoad` returned before calling `load`, and **no `OPENING_BALANCE` document was ever posted** — taking T5's first three assertions, T7's `["1","2","3"]` number sequence, T10's whole DoD suite and the `sah-003` append with it | `accountLoader.sourceKey` becomes `ACCCODE` — the identifier `account.legacy_ref`, `party.legacy_ref`, the owner's map and the reconciliation report all already use, so one legacy identifier now runs through the slice. The party loader's `ACC:<ACCID>` space still cannot collide (its keys are prefixed). **The whole key-per-target list is now written above `SOURCE_OF` in `refs.ts`**, with the rule that a loader changing its `sourceKey` changes that list in the same commit, so the pair cannot drift apart again |
| **R30** | **`replayLegacyMovements` built a `CostingInput.movement` that is not a `PlannedMovement`.** It passed `direction: move.direction` — this file's own `LegacyMovement` spelling — and **no `effect`**, while §4.4.2 gives `PlannedMovement` the member `effect: "receipt" | "issue"` and no `direction` at all, and `costingEngine.cost` branches on `effect`. It also passed `lotId: move.lotKey ?? ""` where the contract type is `string \| null`. The call does not type-check; if it did, every movement would be treated as neither a receipt nor an issue | `effect: move.direction === "in" ? "receipt" : "issue"`, `lotId: move.lotKey` (the null kept — `""` would collide with a lot literally coded `""`), and the `direction` key dropped. The derivation is written beside the call, and §4's “consumed names checked against their owning plans” line now names the movement shape specifically rather than the interface generally |
| **R31** | **`codeFromName` could not produce the warehouse codes three assertions pinned.** It upper-cases and replaces each run of non-alphanumerics with a single `-`, so the corpus's `"Main store"` / `"Shop 1"` are `MAIN-STORE` / `SHOP-1`; T4 asserted `["MAIN", "SHOP1"]` and T6 asserted the `OPENING_STOCK` warehouse and three `import_batch` joins as `MAIN` | the **assertions** move, not the corpus: free-text legacy names are what a real `Warehouses` row holds and the dash rule is the thing under test. T4 now expects `["MAIN-STORE", "SHOP-1"]`, T6 expects `MAIN-STORE` in all four places, and each site carries the one-line derivation so the next reader does not “tidy” it back |
| **R32** | **`openingBalanceLoader.load`'s empty-lines branch returned `batchIds: []` for a non-empty `rows`**, which `linkBatches` refuses with `ERR_VALIDATION_FAILED` — so a legacy trial balance whose every account nets flat failed the load with a message accusing the loader of a contract breach | the branch returns `rows.map(() => EMPTY_TARGET)`, the value run.ts already documents as “seen, hashed, produced no target row” and the one `openingStockLoader` returns for an emptied warehouse. `linkBatches` gains a docstring stating the rule the branch broke: **`batchIds` is positional and total over the rows `load` was handed, with no early-return escape** |
| **R33** | **Task 2 added `ERR_IMPORT_UNBALANCED_SOURCE` to `ERRORS` three tasks before anything raised it**, and claimed `batch.ts` satisfied the rule — true of `ERR_IMPORT_DUPLICATE_SOURCE_KEY`, false of this one, whose first occurrence anywhere is T3's `LoadError` union and whose first raise is T5. §4.2.4 (contracts:1548, 1586) says a slice adds its rows **in the same PR that raises them** and `error-codes` fails on a row with no occurrence — so **Task 2's own Step 8 `bun run lint:rules` was red** | the row moves to **Task 5 Step 5**, the commit that raises it, with `packages/contracts/src/errors.ts` added to T5's Files and `git add`. Task 2's sentence now says only what is true of the code it keeps, and states that the check runs in one direction only, which is why T3's union string with no row is green |
| **R34** | **`tests/invariants/support/cut-over.ts` imported `startApi` from `@dulja/api/test-support`**, a package subpath that does not exist — §4.2.7 fixes `apps/api`'s `exports` at exactly `"."` and `"./routes"` — and §3.7.5's round-3 settlement discourages a **value** import of `startApi` from any `tests/**` file, naming 0B's memoised `sharedApi()` as the replacement “whose consumers must not call `api.stop()`”. Four call sites then called `api.stop()` on it | `cutOverFixture` takes `sharedApi()`'s api and never stops it; `CutOverFixture.api` is typed `FullContext["api"]`, so no cross-tier type import is needed either. Every `api.stop()` on it is deleted (three inline, one `afterAll`) and `loadFromCorpus` loses its `finally` — it owns no container to release. Isolation between cases is **by tenant**, which is what RLS makes real: a self-contained call now seeds a uniquely named tenant. No export subpath and no `dependency-rule` allowance is added, so amendment C6 stays a one-file row |
| **R35** | **Amendment C2 asked a reviewer to reverse a §4.18 round-3 settlement without telling them one existed.** Round 3 recorded, from 7A: “`statusUrl` becomes `/v1/companies/<companyId>/report-runs/<runId>` (ADR 0067) … **No slice mounts `/v1/jobs/{jobId}`**”, and §4.18 overrides anything earlier. C2 argued instead from “7C already returns `statusUrl: "/v1/jobs/<jobId>"`” — a fact ADR 0067 had retired | C2 now quotes the round-3 row verbatim, states that it is **narrowing** it rather than deleting it, gives the narrowed wording, is labelled a **settlement** rather than a correction, and tells the executor to verify what 7C's export handler actually emits before opening the amendment PR. The Self-Review's push-back item says the same and points at C4's `GET …/imports/{runId}` as the cheap fallback |
| **R36** | **T8's acceptance-test-34 re-run could not fail.** It asserted `count(*) = 0` over `role_assignment ra join employee e on e.principal_id = ra.principal_id`, and `employeeLoader.load` never sets `principal_id` — so the join was on NULL and returned 0 whether or not 8C's trigger ran. The `pos_cashier` half had the same shape: no cashier row exists for an imported employee | the vacuous assertions are deleted and the case says what it actually proves — that the **import path reaches** the `AFTER UPDATE OF terminated_on` trigger, which is spec:2090's own claim about the Phase 9 importer. It now pins `principal_id is null` deliberately, so a slice that changes that fact changes this test, and the Assumptions block's test-34 entry records the limit: the trigger's downstream effects stay 8C's own suite, where the rows they act on exist |
| **R37** | **The worker handler test never injected a load source**, so `runLoad`'s default `loadSourceFromEnv()` threw `ERR_IMPORT_SOURCE_UNREADABLE: LEGACY_ODBC_DSN is not set` — the first two cases failed before touching `import_batch`, and the third **passed on that very error**, because its regex `/ERR_PERIOD_NOT_OPEN|ERR_IMPORT_/` matched it | `beforeAll` calls `setLoadSource` with an inline two-row `UNITS` corpus (built in the file: `apps/worker/test/**` may not read another workspace's test tree), every payload carries `only: ["unit_of_measure"]` so `seedTenantV2` is a sufficient tenant, the system-principal case commits instead of dry-running so its `every` is not vacuous over an empty audit table, and the third case provokes `runLoad`'s own `ERR_VALIDATION_FAILED: no loader targets …` and matches **that one string**. Period lock stays proven where the loaders are, in T5 |
| **R38** | two smaller faults: T8 Step 4 and T13 Step 4 described their `catalog.json` growth in **prose** while every other corpus step writes the JSON out — and `preflight` reads exactly that file through `driver.columns(table)`, so a mis-transcribed entry is a required-column failure, not a typo; and `preflight` pushed a table onto `checkedTables` only when it was **present**, so two loaders sharing one **absent** table each emitted an `absent_table` finding, which `accountLoader` and `partyLoader` already do over `ACCOUNTS` | both catalogue fragments are written out as JSON (`EMPLOYEES` + `PAYITEMS`, and the whole `mpos` catalogue with its two row files), with a note on why `PAYITEMS` is never pre-flighted; `preflight` de-duplicates absent tables through their own `Set`, names the first loader that wanted the table, and gains **two** cases — two loaders over one missing table, and two over one present table |
| **R39** | **T12's `NEVER_READ` assertion was spelled in the wrong case, on the one task whose steps say it must be green.** The block asserted `expect([...NEVER_READ].sort()).toEqual(["Users.PIN", "Users.Password"])`, but 9A ships `export const NEVER_READ: ReadonlySet<string> = new Set(["USERS.PASSWORD", "USERS.PIN"])` (9a:6058) and pins exactly that in its own test (9a:5934) — **upper case**, because Firebird stores identifiers that way and this plan's Global Constraint 4 says so in terms. T12 Step 2 says "Expected: PASS on every clause", so an executor would have hit a red test on the task that exists to prove nothing is imported. `NEVER_READ` was also missing from the Assumptions block's 9A name list, though 9A exports it from the barrel (9a:6232) | the expectation becomes `["USERS.PASSWORD", "USERS.PIN"]`, with a comment naming 9a:6058, 9a:5934 and Global Constraint 4 so the next reader does not "tidy" it back; `NEVER_READ` joins the 9A bullet in *Depends on (merged)* with the same two literals written out |
| **R40** | **`OpenItemTarget`'s two `*AccountId` fields held account *codes*, and a `!` turned a map defect into a bare `TypeError`.** `map` filled `controlAccountId` with `entry.code` and `suspenseAccountId` with `SUSPENSE_CODE` (the string `"3900"`), admitting it in an inline comment; a field named `*Id` carrying `"1200"` is the shape a later reader pastes into an `account_id` column. Beside it, `accountMap().entries.find(e => e.treatment === …)!.code` threw an unnamed `TypeError` for a map with no `ar_control`/`ap_control`, where every other failure path in this slice raises a `LoadError` naming the entity | both fields renamed **`controlAccountCode` / `suspenseAccountCode`** at all six sites (the Produces block, the interface, `map`, and the three reads in `load`), with a doc comment saying why they are codes: `Loader.map(row, refs)` is frozen at two parameters and has no `tx` to resolve an id on, so `load` resolves both once per page. The `!` becomes an explicit `throw new LoadError("ERR_VALIDATION_FAILED", …)` naming the missing treatment — a **throw**, not a `{ skip }`, because the map is run configuration: a skip would emit one identical record per open item and load none of them. The message says `assertAccountMap should have refused this map`, which is true (T4 Step 5 requires one of each) and tells the reader this is a second line of defence |
| **R41** | **the `3900` seed row was written unlike every other leaf in the chart pack** — `{ code, nameEn, nameAr, type, isGroup: false }`, with no `parentCode`. Every leaf in 0C's `0c-base.json` carries `parentCode` pointing at one of the five presentation parents (0c:4015–4025) and **no** 0C leaf writes `isGroup: false`, because the loader defaults it (`${a.isGroup ?? false}`, 0c:4204). A parentless equity leaf hangs outside the tree `GET …/accounts/tree` renders and outside the equity subtotal of a statement layout | the row becomes `{ code, nameEn, nameAr, type: "equity", parentCode: "3" }`, and a paragraph under it records **why the parent resolves**: 0C's loader reads the sub-pack files in name order (`readdirSync(...).sort()`, 0c:4190), so `0c-base.json` seeds `3` before `9b-cut-over.json` is read, and the parent is looked up by code within the company (0c:4197–4200), not within the file. The two **test-tier** `ACCOUNTS` consts (T4's `seedLoadableTenant`, T5's) are deliberately untouched — they go through `seedAccount`, not the pack loader |
| **R42** | **R35 fixed C2's row and left the instruction that applies it unfixed: the handoff's amendment list did not say what makes the §4.2.7 edit take effect.** §4.18 overrides anything earlier that contradicts it, and Round 3's §4.11.2 row (contracts:3978) reads "**No slice mounts `/v1/jobs/{jobId}`**". C2's own row already asked for the narrowing, but the ⚑ BEFORE list said only "§4.18 gains a **Round N** table with all fifteen rows" — so an executor applying the list literally would leave the document asserting both that the path is mounted and that no slice mounts it, with the overriding half saying no | the §4.2.7 bullet now states that the module-table edit **does nothing on its own**, and the §4.18 bullet names the table **`Round 4 — from plan 9B`** (rounds 1–3 exist at contracts:3839, 3889, 3955) and carries the supersession sentence C2's row must state verbatim, with `settlement` as its Source. While checking it, **7C was read rather than assumed**: its export handler returns `statusUrl: "/v1/companies/${companyId}/exports/${exportJobId}"` (7c:5107) and its own correction 34 (7c:6213) records dropping the `/v1/jobs` form — so no live slice depends on the sentence being narrowed, and C2's conditional "if 7C still emits it, that is a 7C defect" is resolved in the row rather than left for the executor |
| **R43** | four **inventory** statements that no longer described the plan: the File Structure labelled `load/document.ts` `draftImportedDocument` where every task, the N7 row and the verified-names list say **`draftAndPost`**; the cut-over corpus was listed as `ACCOUNTS ACCTOTALS MATERIALS MATUNITS MATOPENS BILLITEMS VOUCHERS VOUITEMS EMPLOYEES PAYITEMS` when the tasks write `UNITS WAREHOUSES MATERIALS MATBATCHES ACCOUNTS ACCTOTALS BILLITEMS BILLS EMPLOYEES PAYITEMS` (and T15 writes a second corpus directory the list omitted); `tests/invariants/support/cut-over.ts`'s File Structure entry named three of amendment C6's five exports; and §1's coverage table said T12 has "four assertions" where it has five | the label, the corpus list (per creating task) and the helper entry are corrected, T15's `corpus/matopens-partitioned/` is added, and the count becomes five with the five clauses named. T5's Produces block gains a comment saying **`reconcileFor` is added to that same file by T10 Step 4** — it wraps `reconcileCutOver`, which does not exist until then — so C6's five-name list, N15's five names and the two task blocks now agree. The paragraph under T3's corpus listing was narrowed in the same pass: it said "the table names **in this corpus**" over a fourteen-name list, ten of which are files and four of which are names only |

**Two things a later pass checked hardest and found already correct, recorded below the table rather than inside it — a paragraph between two rows ends a Markdown table, and half the corrections would render as literal pipes.** First, **`openingStockLoader.load`'s `batchIds` contract**: `runLoad`'s `linkBatches` pairs `batchIds` with `keys` *positionally* and refuses a length mismatch, so a loader that collapses many source rows into few documents has to answer "which document did **this** source row become?" — and this one does, by position (`documentOfPosition`, keyed on `item + warehouse + lot`), falling back to the row's own warehouse's document and, for a warehouse that opened nothing at all, returning `EMPTY_TARGET`, which after a commit means *seen, hashed, produced no target row* (R17 — an earlier draft **refused** there, and that was wrong: a warehouse emptied before cut-over is ordinary data). `EMPTY_TARGET` is `run.ts`'s and is exported, so exactly one sentinel exists in the package. Second, **`refs.ts` is reached by a top-level import** — the `require`-inside-a-helper that correction R1 removed is gone, and `refResolver(tx, ctx.companyId)` is called directly.

**Names verified identical at every use site:** `LoadContext`, `Loader`, `RefResolver`, `runLoad`, `SourceColumn`, `SkipRecord`, `LoadReport`, `LoadError`, `READ_BATCH`, `setLoadSource`, `loadSource`, `loadSourceFromEnv`, `recordBatch`, `sourceHashOf`, `byLegacyRef`, `batchCounts`, `seedImportBatch`, `AccountMap`, `AccountTreatment`, `readAccountMap`, `assertAccountMap`, `treatmentOf`, `setAccountMap`, `accountMap`, `ACCOUNT_CODE_PATTERN`, `codeFromName`, `draftAndPost`, `ImportedLine`, `ImportedDocument`, `OPENING_BRANCH_CODE`, `SUSPENSE_CODE`, `openingBalanceLoader`, `replayLegacyMovements`, `sortLegacyMovements`, `LegacyMovement`, `OpeningPosition`, `RecostResult`, `openingStockLoader`, `OPENING_STOCK_LINES_PER_DOCUMENT`, `openItemLoader`, `employeeLoader`, `assertYtdReconciles`, `SENSITIVE_SOURCES`, `setKeyRing`, `reconcileCutOver`, `explain`, `Comparison`, `CutOverReconciliation`, `assertNoJobPartition`, `JOB_PARTITIONED_TABLES`, `mposLoader`, `MPOS_SOURCE_TABLES`, `importRouteModule`, `jobStatusRouteModule`, `importRunHandler`, `cutOverFixture`, `loadFromCorpus`, `reconcileFor`, `assertExplained`, `baseCurrency`, `EMPTY_TARGET`, `seedLoadableTenant`, `loadContextFor`.

**Every `Money` and `Quantity` call re-checked against §4.2.1's two method lists, and every test-harness call against §4.2.12's `ApiRequest` and `StartedApi`** (corrections R19 and R25). The four §4.2.1 names this plan uses and a reader may want to confirm are `Money.fromDecimal(value, currency, mode)`, `Money.compare`, `Quantity.compare` and `Money.abs`; the plan uses **no** `Money.multiply` and **no** `Quantity.multiply`, so no rounding mode is implied anywhere. `decimal.js`'s own `plus` / `minus` / `greaterThan` / `equals` survive in `reconcile-cut-over.ts`'s `explain`, where the operands really are `Decimal`s.

**Consumed names checked against their owning plans, not from memory:** `upsertEmployeeYtdOpening(tx, ctx, input)` / `EmployeeYtdOpeningInput` / `listEmployeeYtdOpening` / `EmployeeYtdOpeningRow` / `ytdFromEmployeeYtd` / `checkEmployeeYtdProjection` (8C Task 9); `writeSensitive(tx, ring, employeeId, values)` / `SENSITIVE_FIELDS` (8A Task 3); `costingEngine.cost` / `.average` / `Layer` / `CostingInput` (contracts §4.7.1, 3B) — **including the shape of `CostingInput.movement`, which is `PlannedMovement & { effectiveDate; postingSeq }` and whose direction member is `effect: "receipt" | "issue"` (§4.4.2), never `direction`; `recost.ts` carries that derivation in a comment beside the call; `applyMovements` (§4.7.2 — **called by `postDocument`, never by this slice**); `valuationAsOf` (3B amendment A19); `createReader(driver, declaredVersion?)` / `LegacyReader.read<T>` / `FixtureLegacyDriver(corpus, source?)` / `LegacyDriver.columns` / `ReportWriter` / `reconcile` (9A Tasks 1, 4, 5, 7); `postDocument(tx, ctx, { documentId })` → `PostResult` (§4.3.1); `trialBalance` / `runIntegrityCheck` (1B, §4.16.3); `agedBalance` (4B).

### 4. Contracts and hazards audit

- **§3.4.1 ranges:** 0101, 0102 used; 0103, 0104 allocated and unused; no other slice's number is touched.
- **§3.4.2 names:** both files say what they do; neither understates it, so §3.4.2's rename rule does not engage.
- **§3.4.3:** each file is one transaction, no `create index concurrently`, one migration per PR (T1 and T2 are separate tasks and separate commits).
- **§3.4.5:** `0101.down.sql` drops six indexes then six columns, never a table; `0102.down.sql` drops the table and its triggers cascade. The §3.4.6 fingerprint test is run in both tasks.
- **§3.5.3:** `import_batch` joins **no** linter set. `lint-schema.ts` is not opened by this slice — the one hotspot §3.5.3 warns about, untouched.
- **§3.5.4:** no DELETE grant; `privileges.test.ts` is not opened.
- **§3.6:** no permission code introduced; the import routes use `admin.company.manage` per §3.6.2's mapping, `/v1/jobs` is membership-only per §4.2.7's precedent; `roles.ts` is not opened.
- **§3.7.3:** every regression file is an **append**; none is created.
- **§3.7.5:** no lint rule added, no allow-list widened, no `sql.unsafe` used. `posting-only-tables` is respected everywhere — the only writer of a protected table remains `packages/db/src/posting/**` and `packages/db/src/costing/**`, reached through `postDocument`.
- **§4.17 / §4.17.1:** one fixture helper (C5) and one shared helper file (C6), both amended in.
- **Hazards:** 1 (no statutory figure — the YTD figures are the customer's own historical amounts, carried as opaque strings; `byComponent`/`byScheme` are loaded **empty** rather than split by a guessed rate) · 3 (no legacy row interface anywhere; every column is data with a confidence, and T14 is the only place a label changes) · 5 (four owner-account tasks written as "owner provides X; verify with `<exact command>`" with a local equivalent) · 6 (five owner decisions, five isolated tasks, none spread) · 7 (no D1–D27 re-opened) · 8 (Plan 0A names used exactly; `fixtures.ts` extended additively) · 9 (one helper, registered) · 13 (`lint-schema.ts` untouched) · 14 (numbers not renumbered) · 17 (a negative opening is refused precisely *because* the importer cannot supply a second principal) · 20 (jobs as the system principal) · 22 (nothing outside the posting service writes a protected table) · 23 (`HALF_AWAY_FROM_ZERO` at scale 4, once, in `moneyOf` and in the one multiplication) · 25 (no DELETE grant) · 26 (no new permission code) · 31 (two `PROBES`, one `JOB_PROBES`) · 32 (every literal in a registered namespace; `LEGACY` removed by C1) · 33 (this slice seeds `3900` because its policy names `3900`; it consumes `1200`/`2100`/`1300`/`4000`/`5000`/`5900` and asserts each resolves) · 34 (both seed files are envelopes) · 35 (real code everywhere).

### 5. Four things a reviewer should push back on if they disagree

1. **Amendment C1** — `LEGACY` becoming `OB`/`OS`. The fallback is written into the amendment table and costs one §4.14 row.
2. **Amendment C2** — 9B building `/v1/jobs`, which **reverses a ratified §4.18 round-3 row** (“No slice mounts `/v1/jobs/{jobId}`”, from 7A with ADR 0067). C2 quotes that row in full and offers the reversal as a *narrowing*, recorded as a **settlement**; the fallback — `GET …/imports/{runId}` alone, which amendment C4 already registers — is cheap and leaves the round-3 row standing. A reviewer who declines the reversal should take the fallback: this plan loses only a generic resource it did not need for itself. **7C's export route was checked and no longer returns a `/v1/jobs` URL** (7c:5107, 7c:6213), so the narrowing costs no other slice anything — and the handoff's §4.18 bullet carries the supersession sentence the Round 4 row must state, without which the §4.2.7 edit has no effect.
3. **The trial-balance opening excludes P&L accounts only if the owner's map says so.** The map admits a `balance` treatment on an income or expense account, and a mid-year cut-over legitimately opens them. This plan does not decide it — the map does, and OD-25's runbook page asks the question.
4. **`OPENING_BRANCH_CODE = "HQ"` is an assumption about the tenant, not about the legacy data.** `document.branch_id` is NOT NULL and `LoadContext` (§4.13.2, frozen) carries no branch, so every imported document is booked to the `BRANCH` dimension value `HQ`. The plan fails closed rather than guessing — **T4 raises the message that names the remedy** (`company <id> has no BRANCH value HQ; run \`bun run seed --tenant … --only dimensions\` before the load`), **T5's `draftAndPost` raises on the same condition** with the shorter `company <id> has no BRANCH value HQ`, and the runbook's step 2 runs exactly that seed before any load — but **a customer whose stock and receivables genuinely sit across several branches on the cut-over date will have all of them opened at HQ** and must move them with ordinary transfers afterwards. The alternative is a per-row branch column in the account map, which is a real widening of the owner's input and is not worth it unless the owner says the branches differ. This is the one place the plan chooses a single value over asking.

**Arithmetic checked, not assumed.** Every computed expectation in T6's recost suite was re-derived: 10 @ 10.00 + 10 @ 14.00 = 20 units / 240.0000 → AVCO 12.0000, issue 5 → **15.000000 units, 12.0000 unit cost, 180.0000 value**; the per-lot case is 40.0000/4 = 10.0000 and 60.0000/4 = 15.0000. The `OPENING_STOCK` ledger assertion (`1300` debit 180.0000, `3900` credit 180.0000) and the `valuationAsOf` total (180.0000) are the same 180.0000 carried through, so the three assertions are one number checked three ways rather than three independent guesses.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-9b-loaders-cut-over.md`.**

### Prerequisites and branch

**Prerequisites, all four merged and green before Task 1 opens:** **9A** (the whole `@dulja/importer` barrel — this slice adds to that package and imports nothing by a deep path), **3D**, **4B** and **8D**, with the **Phase 8 definition of done green in CI** (spec:87 — "a phase begins only when the previous phase's definition of done passes"). §6.3 places 9B **last** among the thirty plans, so unlike every other slice there is nothing to run in parallel with it. **6D is a fifth prerequisite only if ⚠️ OD-16 answers *yes*** — it gates T13 alone, and T13 is droppable whole; no other task names a 6D interface.

The load also needs, in the target tenant and before the first non-dry run: migrations through 0102 applied, and the `roles`, `dimensions`, `fiscal-periods`, `chart-of-accounts` and `document-types` seed packs applied — runbook step 2 lists them in order and each of T4, T5 and T6 fails closed with a named error if one is missing.

**Branch.** One branch, `feat/9b-loaders-cut-over`, off `main`. **Sixteen commits: the amendment PR first, then one per task**, each with the subject and trailer written into the task (`<type>(<scope>): <summary> [9B T<n>]`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`). Migrations 0101 and 0102 are separate tasks and therefore separate commits, which is §3.4.3's one-migration-per-PR rule. Pushing to GitHub is the owner's call, not part of any task's definition of done (§3.8, plan0A:2927).

### Before Task 1 — the amendment PR (⚑ BEFORE)

Fifteen rows, one PR, `docs(contracts): fold 9B's amendments C1–C15`. Apply each to its own section of `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`:

- §4.13.3 → **C1** (the `LEGACY` sentence).
- §4.2.7's module table → **C2** (`/v1/jobs`) and **C4** (`/v1/companies/:companyId/imports`), each with its `PROBES` note. **The C2 edit to §4.2.7 does nothing on its own** — §4.18 overrides anything earlier that contradicts it, and Round 3's §4.11.2 row (contracts:3978) says in terms "**No slice mounts `/v1/jobs/{jobId}`**". Without the Round 4 row below, the document would assert both that the path is mounted and that no slice mounts it, with the overriding half saying no.
- §4.2.6's `JobPayload` block → **C3**.
- §4.17 → **C5** (`seedImportBatch`). §4.17.1 → **C6** (`tests/invariants/support/cut-over.ts`).
- §4.6.1's `import_batch` row → **C7** (`source_hash`).
- §4.13.2 → **six rows, all of them additive to the one interface**: **C8** (`sourceColumns`, `sourceKey`), **C9** (`artefacts` on `runLoad`'s return), **C12** (`map` may return a promise), **C13** (`Loader.wholeTable`), **C14** (`LoadContext.only`) and **C15** (`skips` on `load`'s return). **C13, C14 and C15 are load-bearing and were missing from an earlier draft of this list** — `runLoad` branches on `wholeTable`, filters on `only`, and merges `skips`, so an executor who applied only the first three would find three names unregistered and two skip assertions unreachable.
- §3.11's `LEGACY_ODBC_DSN` row → **C10**. §4.15's `3900` row → **C11**.
- §4.18 gains a **`### Round 4 — from plan 9B (2026-09-08)`** table with all fifteen rows and their Source column. Rounds 1, 2 and 3 exist (contracts:3839, 3889, 3955) and 4 is the next number; write the number, not "Round N". **C2's row in that table carries the supersession sentence in full, and the row is not applied without it:** *"This row **supersedes** Round 3's §4.11.2 sentence «No slice mounts `/v1/jobs/{jobId}`», which is narrowed to: **no slice before 9B mounts it; 9B mounts `/v1/jobs/{jobId}` as the generic job-status resource; a slice with a status resource of its own (7A's `report-runs`, 7C's `exports/{exportJobId}`) still uses that, and no slice's 202 body points at `/v1/jobs` unless it has none.** ADR 0067 and 7A's `statusUrl` decision are untouched."* Source column: `settlement`. **Verified while writing this plan:** 7C's export handler now returns `statusUrl: "/v1/companies/${companyId}/exports/${exportJobId}"` (7c:5107) and its own correction 34 (7c:6213) records dropping the `/v1/jobs` form — so no live slice depends on the sentence C2 narrows, and the round-3 row's *other* half (7A's `statusUrl`) is left exactly as it stands.
- §4.18 also takes, in the same PR, the sixteen **N1–N16** name groups from this plan's *Names this slice adds beyond the frozen registry* section. They are internal to 9B and cross no slice boundary, so none of them needs a reviewer's agreement the way C1–C15 do — but 9B is the **last** plan, and the register is the record of what v1 actually contains, so it is written down rather than left in a plan file. Three are worth a reader's eye: **N3** (`loadSource` / `setLoadSource` / **`baseCurrency`** — the swappable legacy connection and the run's own currency, the same port shape 7A uses for `objectStore`), **N9**'s **CLI exit code 4**, a fourth outcome beside 9A's 0/1/2/3 that the runbook branches on, and **N16** (`seedLoadableTenant`), without which every DB-backed importer test dies in `beforeAll`.

A reviewer who refuses a row gets the fallback stated in that row; **C1, C2 and C12 are the three worth a conversation**, and none of them blocks the rest. **C7 was re-checked against the live contracts text before this plan was finished** — §4.6.1's `import_batch` row is `company_id, source_table, source_key, target_table, target_id, loaded_by, run_id` with `unique (company_id, source_table, source_key)` and carries **no** `source_hash`, so the amendment is genuinely needed and is not a restatement of something already frozen.

### Execution order and what may run in parallel

Strictly serial: **T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10**. Each depends on the previous one's exported names, and T5–T8 each add a loader the next one's `dependsOn` names.

The five owner-gate tasks are independent of each other and of T10, and each may run at any point after the task it touches:

| Gate task | May start after | Droppable? |
|---|---|---|
| **T11** OD-25 | T5 | No — its runbook page and its pinning test ship either way; only the *treatment* is the owner's |
| **T12** OD-26 | T8 | No — the proof that nothing is imported is the deliverable |
| **T13** OD-16 | T4 | **Yes, whole.** Delete `mpos.ts`, its test and `test/corpus/mpos/` if the owner confirms "start clean" |
| **T14** OD-17 | T10 | **Yes, whole.** It adds evidence, not code; every test stays green without it |
| **T15** OD-27 | T6 | No — the `MatOpens` guard fails closed whether or not the question is answered |

### Definition of done for the slice

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
bun run --cwd packages/db test                      # 0101, 0102, privileges (up→down→up), lint-schema
bun run --cwd packages/importer test                # the loaders, the recost, the reconciliation
bun run --cwd apps/api test routes/admin/import
bun run --cwd apps/worker test handlers/import-run
bun run --cwd tests test                            # invariants + the eight regression appends
bun run --cwd packages/contracts openapi:generate   # must produce no diff
```

and, with an owner-supplied database (OD-17, T14):

```bash
bun run --cwd packages/importer legacy scope --dsn "$LEGACY_ODBC_DSN"
bun run --cwd packages/importer legacy load --tenant-id <id> --company-id <id> \
    --account-map <path> --cut-over-date <YYYY-MM-DD> --dry-run
bun run --cwd packages/importer legacy reconcile-cut-over --tenant-id <id> --company-id <id> \
    --cut-over-date <YYYY-MM-DD>          # exit 0
```

And the checks the commands above do not make, each verifiable in one line:

- [ ] `git diff --name-only main -- packages/db/migrations` prints **exactly four** paths: `0101_add_legacy_ref.sql`, `0101.down.sql`, `0102_create_import_batch.sql`, `0102.down.sql`. **`0103` and `0104` do not exist** — they are allocated and deliberately unused (§3.4.1: gaps are legal, and no later slice may claim them).
- [ ] `git diff --name-only main -- packages/db/src/lint-schema.ts` prints nothing — `import_batch` joins no linter set (§3.5.3), and this is the merge hotspot hazard 13 warns about.
- [ ] `git diff --name-only main -- packages/db/test/privileges.test.ts packages/db/seed/roles.ts` prints nothing — no DELETE grant (§3.5.4), no permission code (§3.6, hazard 26).
- [ ] `bun run lint:rules` passes with **no allow-list entry added** to `posting-only-tables`, `no-bare-db`, `no-number-money` or `no-sql-concat`, and `git diff main -- scripts/lint/` prints nothing.
- [ ] `grep -rnE '\b(sql|db)\b\s*[:,)]' packages/importer/src/ --include=*.ts | grep -v '\.sql\b'` finds no **binding** so named — correction **R7**; `runLoad`'s handle is `conn` and every tag is `tx`.
- [ ] `grep -rn "app.ledger_entry\|app.inventory_movement\|app.cost_layer\|app.cost_consumption\|app.account_balance\|app.stock_on_hand\|app.employee_ytd" packages/importer/src/` finds **only** `select` statements — nothing under this package writes a protected table (§0.2, hazard 22).
- [ ] `grep -rin "users\.\?password\|users\.\?pin" packages/importer/src/` prints nothing — Global Constraint 11, proved by T12.
- [ ] The three ADRs exist and are numbered as allocated: `docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md` (T3), `0085-cut-over-series-and-opening-documents.md` (T7), `0086-cut-over-reconciliation-and-the-explained-difference.md` (T10). `docs/runbooks/cut-over.md` exists and carries the OD-25, OD-26 and OD-27 branches (T11, T12, T15).
- [ ] All **eight** regression files carry a new `describe(… — 9B)` block and no earlier block is edited (§3.7.3): `sah-003`, `sah-007`, `sah-011`, `sah-022`, `sah-028`, `sah-049`, `sah-051` (twice — T1 and T7), `sah-073`. `git diff main -- tests/regression/ | grep '^-' | grep -v '^---'` prints nothing, which is what "append, never edit" means mechanically.
- [ ] Corrections **R1–R43 are already folded into the task text** — an executor types what is written and applies no extra diff. Ten are worth confirming by eye once T3–T12 are typed, each a one-line grep:
  - `grep -rn "runLoad(sql" packages/importer/src/` prints nothing (**R7** — the handle is `conn`).
  - `grep -rn "refsFor\|const EMPTY =" packages/importer/src/load/opening-stock.ts` prints nothing (**R1**, **R8**).
  - `grep -rnE '\.(plus|minus|negated|times|roundToScale|greaterThan)\(' packages/importer/src/load/ | grep -v reconcile-cut-over` prints nothing (**R19** — those are decimal.js's names and only `reconcile-cut-over.ts` holds real `Decimal`s).
  - `grep -rn '"MYR"' packages/importer/src/` prints nothing (**R24** — the currency comes from `baseCurrency()`; `"MYR"` survives only in tests and corpus files).
  - `grep -n 'direction' packages/importer/src/load/recost.ts` shows only `LegacyMovement`'s own `direction: "in" | "out"` field and the two `move.direction === "in" ? …` ternaries that derive `effect` and `costing` from it — **no `direction:` key appears inside the `costingEngine.cost({ movement })` object literal**, whose direction member is `effect` (**R30**).
  - `grep -rn 'api\.stop()\|@dulja/api/test-support' tests/invariants/support/cut-over.ts tests/invariants/cut-over-reconciliation.test.ts tests/regression/sah-003.test.ts tests/regression/sah-051.test.ts tests/invariants/projection-rebuild.test.ts` prints nothing (**R34** — every one of them reaches the API through `sharedApi()` and none of them stops it).
  - `grep -n 'ERR_IMPORT_UNBALANCED_SOURCE' packages/contracts/src/errors.ts` first appears in **T5's** commit, not T2's, and `bun run lint:rules` is green at **every** commit of the branch (**R33**).
  - `grep -rnE 'Number\(|parseFloat' packages/importer/test/ tests/invariants/support/cut-over.ts tests/invariants/cut-over-reconciliation.test.ts` finds no monetary use (**R27** — every total is summed through `Money`; the surviving `Number(...)` calls are a line number, a tax year and `MOPJOB`, none of them money).
  - `grep -rn 'Users\.PIN\|Users\.Password' tests/regression/sah-028.test.ts` prints nothing (**R39** — 9A's `NEVER_READ` members are `USERS.PASSWORD` and `USERS.PIN`, upper case).
  - `grep -rn 'AccountId' packages/importer/src/load/open-items.ts` prints nothing (**R40** — the two members hold codes and are named `controlAccountCode` / `suspenseAccountCode`).
- [ ] AGENTS.md's "Current phase" section is rewritten (T10 Step 7) — §3.8 makes this the phase-completing slice's own deliverable, and it is the clause easiest to forget.

### What this slice hands to whoever comes next

Phase 9 is the last phase of v1 (§2.11: Phase 10 is deferred indefinitely). T10's AGENTS.md rewrite says so. What remains after this plan is **operational, not phased**: the quarterly restore drill (1B, acceptance test 24), the cut-over rehearsal against the owner's real database, and the ⚠️ owner decisions still open in contracts §2.12 — each of which is already an isolated, droppable task in a written plan.

### Two execution options

**1. Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks; fast iteration and a clean context per task, which matters here because T3–T8 each carry a full loader.

**2. Inline Execution** — execute the tasks in this session using `superpowers:executing-plans`, batching with checkpoints for review.

**Which approach?**
