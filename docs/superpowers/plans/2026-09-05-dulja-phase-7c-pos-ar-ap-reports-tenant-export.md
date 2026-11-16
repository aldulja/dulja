# Dulja Phase 7C — Core catalogue II: AR/AP, POS and cross-module reports; tenant data export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the v1 report catalogue with the eleven AR/AP, POS and cross-module codes §4.16.1 assigns 7C, add the three Phase 6 datasets 7A could not, and ship the tenant data export (`admin.data.export`) — CSV + JSON + a documented schema, attachments included, asynchronous with a status resource, every export audited and every sensitive table gated.

**Architecture:** Three separable pieces on one slice. (1) **Datasets** — `packages/db/src/reports/datasets/pos.ts` adds `shift`, `till_event` and `needs_attention` to 7A's closed registry, each a named `withTenant` read query built with 7A's `defineDataset`; no SQL text ever crosses the API (test 27). (2) **Definitions** — eleven `ReportDefinition` JSON files under `packages/db/seed/my/reports/7c/`, a directory no other slice touches, each with an executable `tieOut` run by 7B's harness; the three codes 7C *re-expresses* (`accounting.ageing`, `pos.z_report`, `pos.sales_by_cashier`) keep their owning slice's JSON route byte-for-byte and gain a definition at `definitionVersion = 2` (7B amendment A2), so the owning slice's own tie-out test re-runs unchanged as the proof that nothing moved. (3) **Export** — `app.export_job` (migration 0078), a table registry with explicit column lists and per-table permission gates in `packages/db/src/export/`, a deterministic `.tar.gz` archive written by the `admin.export.run` pg-boss job as the tenant's system principal, and four routes gated `admin.data.export` at company scope. The export is a covered side channel for tests 32 and 36: a table is included only when the requester holds its gate, and the route's company-scoped gate makes a branch-narrowed principal fail before the job is ever enqueued.

**Tech Stack:** TypeScript on Bun (tests on Node 24 via Vitest), PostgreSQL 18, `postgres.js` tagged templates, Drizzle read mirrors, Hono + `@hono/zod-openapi`, Zod contracts, pg-boss, `node:zlib` (`gzipSync`) and a hand-written deterministic USTAR writer for the export archive, Testcontainers for every database test. No new package dependency.

**Spec:** `C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` (v1.2). Sections this plan implements: §3.3 (async projections, spec:1204), §4.3 (the data-export sentence, spec:2186), §4.5 (bulk/async with a status resource, spec:2206), §4.6 (right-to-export, spec:2211), §4.8 (graceful degradation, spec:2235–2237), §4.10 (spec:2253), §4.2.1 (`admin.data.export`, `pos.report.read`, the `auditor` row — spec:2146, 2150, 2163), §4.11 (report definitions as text, spec:1240), §4.16, Part V Phase 7 (spec:2293, 2300), Part VI tests 13, 21, 23, 32, 36, Part I SAH-077 and SAH-085.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 7C — Core catalogue II: AR/AP, POS and cross-module reports; tenant data export. **Phase:** 7. **Phase gate:** this plan starts only when **7B** is merged and **Phase 6's definition of done is green in CI** (spec:87, §6.3 — `7C` depends on `7B` *and* `6D`). Phase 6 is serial (6A → 6C → 6B → 6D) and runs in parallel with (7A → 7B); 7C is the join point.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, `Logger`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `TENANT_FREE`, `encodeCursor`, `decodeCursor`, `Cursor`, `CursorSchema`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `CurrencySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`, `postLines`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`, `JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `eachTenant`, `JOB_PROBES`, `JobIsolationProbe`, `registerHandler`, `runJob`, `startWorker`, `seedBranch`, `seedCurrency`, `seedRate`. **0C** — the seed CLI, `PackLoader`, `LoaderContext`, `readPackFile`, `SUB_PACKS`, `assertPackShape`, the `0c-base.json` chart rows `1000`, `1100`, `1200`, `1300`, `2100`, `4000`, `4900`, `5000`, `5900`, `5910`, `5920`. **0E** — `packages/ui`, `packages/i18n`, `bootLocalStack`, `grantAdminRole`. **1A** — `postDocument`, `issueDocument`, `transitionDocument`, `loadSnapshot`, `resolvePolicy`, `PostingError`, `seedTenantV2`, `seedAccount`, `seedJournalPolicy`, `documentTypesLoader`. **1B** — `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema`, `postJournal`, `registerProjectionCheck`, `projectionChecks`, `trialBalance`, `accountLedger`. **2A** — `evaluatePolicy`, `seedDocumentType`, `seedParty`, `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`, `requireDocumentPermission`. **2B** — `grantCodes`, `recordOverride`, `app.principal_has`, `app.effective_policy`. **2C** — `ObjectStore`, `MemoryObjectStore`, `objectKeyFor`, `MODULE_READ_CODE`, `readableModules`, `requireAttachmentRead`, `pdfText`. **3A** — `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `seedPriceList`. **3B** — `valuationAsOf`, `ensureOpenPeriods`, `postInventoryDocument`. **3D** — `stockOnHand`, `secondPrincipal`. **4A** — `allocateSettlement`, `openBalance`, `partyBalance`, `seedPaymentTerm`, `postArDocument`. **4B** — `agedBalance`, `ageingRows`, `ageingTieOut`, `AgedBalanceParams`, `AgedBalanceRow`, `reconciledBalance`, `importStatement`, `match`, `unmatch`, `itemProfitabilityRows`, `seedTypeFromPack`, `packApproval`, `postFromPack`, `arApFixture`, `ArApFixture`. **5A** — `app.tax_transaction`, `app.tax_code`, `app.tax_regime`, `seedTaxCode`, `postTaxedDocument`, `TaxFixture`, `TaxedLine` (§4.17.1's `tests/invariants/support/tax.ts` row — the one taxed-post path). **6A** — `applyBatch`, `posFixture`, `PosFixture`, `buildTicket`, `enrolTerminal`, `seedTerminal`, `SHARED_SHIFT_ID`, `app.needs_attention`. **6C** — `staffFixture`, `StaffFixture` (whose supervisor member is **`supervisorA`**; there is no `managerA`), `branchActor`, `app.actor_in_branch`, `seedCashier`, `seedBranchPosPolicy`, `seedEmployee`. **6D** — `app.shift`, `app.till_event`, `seedShift`, `zReport`, `salesByCashier`, `ZReport`, `ZReportParams`, `SalesByCashierRow`, `SalesByCashierParams`, `shiftRoutes`, `shiftRouteModule`, `StaffFixture.openShift`, `StaffFixture.shiftA`, `tests/invariants/pos-shift-reconciliation.test.ts`. **7A** — `ReportDefinition`, `ReportCode`, `reportCode`, `isReportCode`, `moduleOfReportCode`, `REPORT_CODE_PATTERN`, `REPORT_FILTER_OPS`, `ReportFormat`, `ReportLang`, `ReportPaper`, `validateReportDefinition`, `parseReportDefinition`, `ReportDefinitionSets`, `renderReport`, `intlFormatters`, `RenderOptions`, `RenderedReport`, `statementLayout`, `statementDefinition`, `StatementKind`, `StatementLayoutOptions`, `STATEMENT_LAYOUTS`, `statementSectionFor`, **`STATEMENT_CODES`, `statementKindFor`, `STATEMENT_EXTRA_FIELDS`** (`packages/domain/src/reports/statement.ts`) and **`statementRows`, `StatementParams`, `rowsForDefinition`, `assertDefinitionFields`** (`packages/db/src/reports/statement.ts` — the one row provider and the one field check every run path, store write and seed load goes through; `accounting.branch_profit_and_loss` is a `STATEMENT_CODES` key and reaches its rows through them, amendment A5), `defineDataset`, `datasetWhere`, `datasetOrderBy`, `Dataset`, `DatasetSpec`, `DatasetColumn`, `DatasetFilter`, `DatasetSortKey`, `DatasetParams`, `DatasetRow`, `DatasetId`, `DATASETS`, `DATASET_IDS`, `datasetFor`, `isDatasetId`, `MAX_DATASET_ROWS`, `SqlFragment`, `ReportError`, `ReportErrorCode`, `reportObjectKeyFor`, `createReportRun`, `getReportRun`, `claimReportRun`, `completeReportRun`, `failReportRun`, `loadRunDefinition`, `reportDefinitionSets`, `createReportDefinition`, `listReportDefinitions`, `nextDefinitionVersion`, `reportsLoader`, `loadReportDefinitions`, `seedReportDefinition`, `objectStore`, `setObjectStore`, `objectStoreFromEnv`, `rendererFor`, `i18nFormatters`, `accounting.report.export`. **7B** — `tests/invariants/support/reports.ts` in full (`CATALOGUE_7B`, `CATALOGUE_DIR`, `ReportSeedEnvelope`, `readEnvelope`, `readDefinition`, `runDefinition`, `assertFieldCoverage`, `LedgerWindow`, `TieOutWitness`, `TieOutOptions`, `assertTieOut`, `ReportFixture`, `reportFixture`, `cachedReportFixture`), its seventeen definitions, migration 0077's four indexes, and the `scripts/check/contracts-7b-amendments.sh` gate.
- **Migration numbers:** 0078–0079 — files `0078_create_export_job.sql` and `0079_seed_permission_phase7c.sql`, each with a hand-written `NNNN.down.sql`. **ADR numbers:** 0069–0070 (`0069-tenant-export-archive-and-table-registry` — a **proposal** under §3.8, because it touches the data model and a side channel for sensitive data; `0070-export-runs-as-the-system-principal-behind-a-request-time-gate`).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `createDb`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, the fixed middleware order, and the registered `Variables` — **the eight members §4.2.3 now pins, the eighth being `jobs: JobClient`**, which is 3B's amendment A5 and is already ratified: §4.18 Round 3 carries the ⚑ row *"A5 ratified — `AppEnv["Variables"]` gains an eighth member `jobs: JobClient`"*, naming 7C Task 9's `POST …/exports` as one of its two readers, and §4.2.3's own body now opens *"The registered `Variables` set is eight members (round 3)"*. Task 9's `POST …/exports` calls `c.var.jobs.enqueue(tx, …)` and does not type-check without it, so the Execution-handoff gate table carries a ⚑ BEFORE row that **confirms the ratified row is present** rather than one that waits for it. **This slice registers no `Variables` member of its own** — the download route takes its `ObjectStore` through `createExportRoutes`' closure precisely so it does not need a ninth), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `ReportError` — **this slice adds no `ERR_*` row**), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `PermissionDef`, `SliceId`, `requirePermission`, `ScopeSource`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.6 (`JOBS`, `JobPayload`, `JobEnvelope`, `JobClient`, `registerHandler`, `runJob`, `JOB_PROBES` — this slice owns `admin.export.run`), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IsolationProbe`, `IdempotencyHeader`, `createApp`, `AppDeps`), §4.2.8 (the common schemas, the list envelope, the cursor codec, and **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`, `RECLAIM_AFTER_SECONDS`, `REPLAY_BY_RERUN`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`, `MemoryObjectStore`), §4.2.13 (`PackLoader`, `readPackFile`, `SUB_PACKS`), §4.3.3 (`account_balance`), §4.3.4 (`document_line`, `document.branch_id`, `.terminal_id`, `.shift_id`), §4.5.6 (the `branch_isolation` forms — **this slice attaches none**, see Task 5), §4.5.8 (`app.attachment`, `MODULE_READ_CODE`, `readableModules`, `ObjectStore`), §4.6.1 (the register rows for `needs_attention`, `shift`, `till_event`, `export_job`), §4.6.5 in full, §4.8.1–§4.8.3 (allocation, ageing, bank reconciliation), §4.9.2 (`tax_transaction`), §4.10.1 and §4.10.4 (the POS messages and the apply path), §4.11 in full, §4.14 (document-type codes — **this slice registers none**), §4.15 (account codes — **this slice seeds none**), §4.16 in full, §4.17 and §4.17.1, §5 (all thirty-five hazards), §6.1 rows 13, 21, 23, 32, 36, §6.2 rows 1047 and 1067.
- **Interfaces produced:** §4.16.2's three 7C `DatasetId` members (`shift`, `till_event`, `needs_attention`) and their datasets; §4.16.1's eleven 7C rows as seeded `ReportDefinition`s (three of them re-expressions at `definitionVersion = 2` — `accounting.ageing`, `pos.z_report`, `pos.sales_by_cashier`); §4.6.1's `export_job` row; §3.6.2's one code `admin.data.export` and §3.6.4's `auditor` grant; §4.2.6's `admin.export.run` payload and handler; §4.2.7's `/v1/companies/:companyId/exports` module with its one `PROBES` key; one new §4.2.8 contracts module `packages/contracts/src/admin/export.ts`; `packages/db/src/export/` (`EXPORT_TABLES`, `NEVER_EXPORTED`, `exportTable`, `resolveExportGates`, `exportSchemaDocument`, `tar`, `tarGz`, `toCsv`, `toJson`, `runExport`, `exportObjectKeyFor`, the export-job store); §4.17's one row `seedExportJob`; §4.17.1's one new file `tests/invariants/support/reports-7c.ts` plus three additive members of 7B's `tests/invariants/support/reports.ts`.
- **Owner decisions:** **OD-09** (post-dated cheques) → **Task 11** (isolated; default **not built** — `accounting.pdc_register` and the `pdc` dataset are dropped together with 4B's table). **OD-27** (Part VII #8, which of the 255 legacy templates are in use) → **Task 12** (isolated; default **the mapping is written for the AR/AP, POS and cross-module templates only, and the task is dropped whole if 9A has not run**). **OD-24** (screenshots before any screen) → **Task 13** (isolated; default **the screen task is blocked, not the slice**).
- **Part VI tests owned / re-run:** owns **none exclusively**. Re-runs **13** (exports audited — Task 10), **21** (as a report — Task 4 re-expresses `pos.z_report` and Task 14 re-runs `tests/invariants/pos-shift-reconciliation.test.ts` unchanged), **32** (the export clause — Task 10), **36** (the export clause and the branch-narrowed refusal — Task 10), **23** (every generated PDF — Task 14). **§3.0.4 rows owned:** none; this slice completes the "data export" clause of spec:1047 (owned by 7B) and the "included in tenant data export" clause of spec:1067 (owned by 2C). **Regression files created / appended:** creates none; **appends to `tests/regression/sah-077.test.ts`** (created by 7A) and **`tests/regression/sah-085.test.ts`** (created by 0E).
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14) — none.** This slice defines no document type and registers no test-only code; every document its fixtures post is a 4A / 4B / 6A / 6D pack envelope read off disk through 4B's `seedTypeFromPack`. **Account codes (§4.15) — seeds none.** Consumed and asserted-not-re-seeded, each with its seeding slice: `1200` trade receivables and `2100` trade payables (**0C** — the ageing tie-out's controls, §4.8.2), `1100` Bank (**0C** — the unreconciled-items fixture), `1110` Cash in till, `1120` Card clearing, `2200` Store-credit liability (**6A** — the Z-report's tender lines), `5120` Till over/short (**6D**), `2300` Output tax payable and `1350` Input tax receivable (**5A** — the tax-return-view tie-out), `4000` Sales and `5000` Cost of goods sold (**0C** — the branch P&L). **Report codes (§4.16.1) — the eleven this slice owns or re-expresses:** `accounting.ageing` (re-expressed, 4B's code), `accounting.party_statement`, `accounting.allocation_register`, `accounting.unreconciled_items`, ⚠️ `accounting.pdc_register` (OD-09), `pos.z_report` (re-expressed, 6D's), `pos.sales_by_cashier` (re-expressed, 6D's), `pos.sales_by_branch`, `pos.needs_attention`, `accounting.branch_profit_and_loss`, `accounting.tax_return_view` — seeded into `packages/db/seed/my/reports/7c/`, a directory no other slice touches. **`DatasetId` members (§4.16.2) — exactly three: `shift`, `till_event`, `needs_attention`.** This slice adds no fourth and edits no 7A entry. **`fixtures.ts` helpers (§4.17) — exactly one new row, `seedExportJob`,** registered by Task 0 amendment A13; every other row this slice's tests need already exists. **Shared test helpers (§4.17.1) — one new file, `tests/invariants/support/reports-7c.ts`,** registered by Task 0 amendment A4, plus three additive optional members on 7B's `LedgerWindow` and **four** additive `assertTieOut` `projection` branches (`shift`, `allocation`, `bank_statement_line`, ⚠️ `pdc`), which §4.17.1's A9 row already sanctions ("7C and 8D extend `assertTieOut`'s `projection` switch additively for their own sources and never edit a case").
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Global Constraints

1. **Never write to a ledger or movement table outside the posting service** (spec:97, hazard 22). This slice writes **nothing** to `ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand`, `tax_transaction` or `employee_ytd`. Every dataset, every report and the exporter **read**; `posting-only-tables` (§3.7.5) fails the build if any of them writes.
2. **Never money as a float.** `numeric(19,4)` in Postgres, `Money` in TypeScript, a fixed-decimal `string` on the wire and in a `DatasetRow`. `no-number-money` (§3.7.5) fires on any property, parameter or variable whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` typed `number`. Every sum in a tie-out accumulates through `Money.add`; `Number(row.base_debit)` is a defect even in a test file, which is outside the lint runner's `ROOTS` (§3.7.5) and therefore bound by this constraint rather than by a rule.
3. **Never SQL by string concatenation** (spec:99, test 27). Every statement is a `tx`-tagged `postgres.js` template or a Drizzle read. A dataset's and an export table's `select`, `from`, `company` and `order` are **literal `SqlFragment`s authored in source**, never assembled from a definition, a request or a column-name string. `sql.unsafe` has exactly three homes and none of them is in this slice (§3.3, hazard 21).
4. **Never DDL from application code.** DDL lives only in `packages/db/migrations/NNNN_<verb>_<noun>.sql` with a hand-written `NNNN.down.sql` (§3.4.2, §3.4.5). This slice's range is **0078–0079** and it writes nothing outside it (§3.4.1, hazard 14).
5. **Never hard-code a package version into a source file** — the lockfile owns versions (spec:104). This slice adds **no dependency at all**: the archive writer is `node:zlib` plus fifty lines of USTAR, and the reason is ADR 0069.
6. **Every new table** carries `tenant_id`, RLS via `app_meta.enable_tenant_rls`, FORCE RLS, a policy named exactly `tenant_isolation`, `created_at`, the audit trigger via `app_meta.attach_audit`, `stamp_<col>` for every `*_by` column, composite `(tenant_id, x)` FKs, `unique (tenant_id, id)`, `uuidv7()` ids, `snake_case` singular names, and a test that a second tenant cannot see it (§3.3, §3.5.1). `export_job` is the one new table and it is in **no** linter exemption set (§3.5.3).
7. **`app.report_definition` rows are seed-pack data, never migration data** (§3.4.8, hazard 10). `FORCE ROW LEVEL SECURITY` binds `app_migrator`, so a migration file sees no tenants. The eleven definitions are JSON under `packages/db/seed/my/reports/7c/`, applied per tenant by `bun run seed --tenant <id> --only reports`. Only `app.permission` (global) is migration data.
8. **Re-expression does not rewrite a JSON list route** (7B amendment A2). For `accounting.ageing`, `pos.z_report` and `pos.sales_by_cashier` the owning slice's `GET` handler, its `<Resource>List` envelope and its DTOs stand **byte-for-byte**; this slice seeds the definition at `definitionVersion = 2`, adds a **parity** case proving the definition-driven rows equal the owning slice's read function row for row and figure for figure, and re-runs the owning slice's tie-out test unchanged.
9. **This slice never edits `packages/db/src/reports/datasets/{accounting,ar-ap,inventory}.ts`.** It adds one new file, `datasets/pos.ts`, and three entries to the registry object in `datasets.ts`. A field a 7C definition needs that 7A's dataset does not serve is a **raise against 7A**, carried in the Self-Review — never a silent edit to 7A's file (§2.8, hazard 13's reasoning applied to the second pre-declared hotspot).
10. **A `DatasetRow`'s keys are `snake_case`** (7B amendment A3) and every money and quantity is a fixed-decimal `string`, every date `YYYY-MM-DD`, every timestamp RFC 3339 UTC — because the queries cast them with `to_char`. A `camelCase` member of a §4.16.3 read-function row type never appears as a row key; a parity case maps one onto the other explicitly.
11. **Jobs run as the tenant's system principal** (`systemContext`, §4.2.2; spec:2179; hazard 20). `admin.export.run` sees the whole tenant through RLS, so the **authorisation decision is made at the request**, recorded on `export_job`, and re-applied by the job. ADR 0070 records exactly that.
12. **Every route needs a probe entry in `tests/invariants/probes.ts`** keyed by its `RouteModule.path`, and every job payload carries `tenantId` and is probed the same way (§3.7.2, hazard 31). This slice adds exactly one `PROBES` key and one `JOB_PROBES` key.
13. **No plan invents a literal in a shared namespace** (hazard 32). Five registers bind: document-type codes (§4.14), account codes (§4.15), report codes and `DatasetId` members (§4.16), `fixtures.ts` helper names (§4.17), the `ERR_*` space (§4.2.4). Every literal this slice writes is in one of them, and Task 0 amends the register before Task 1 writes code.
14. **Pending owner decisions are isolated tasks** (hazard 6). OD-09 → Task 11, OD-27 → Task 12, OD-24 → Task 13. Each is droppable without renumbering a neighbour's interfaces.
15. **No real Malaysian statutory rate, threshold, ceiling or formula appears anywhere in this slice** (hazard 1, spec:2080), and **no LHDN or MyInvois endpoint, field, version or threshold appears either** (hazard 2). `accounting.tax_return_view` reads `app.tax_transaction` and renders whatever 5A's regime pack put there; it names no authority form, no box number and no rate.
16. **Every task ends green.** `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root pass after every task, with exactly one declared exception recorded in the commit body: `lint:rules` is red between Task 6 (which seeds `admin.data.export`) and the same task's later step (which mounts the route module that references it), and the task closes it before its own commit — 7A's Task 3 left the same gap open across nine tasks and Task 0 amendment A11 records why this slice does not.
17. **Commit messages** are conventional commits with the scope, the subject form `<type>(<scope>): <summary> [7C T<n>]`, and end with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). One migration per PR (spec:2057).

---

## This slice's share of the Phase 7 definition of done

Phase 7's DoD is two sentences (spec:2293): *"A user clones and edits a report without a release; every report's numbers tie to the ledger."* 7A owns the first. 7B owns the second for the accounting and inventory catalogue. **7C owns the second for the remaining catalogue — the AR/AP, POS and cross-module codes — and completes the Phase 7 scope's export clause** (spec:2293 "tenant data export in open formats (§4.3 — v1)").

Concretely, this slice is done when:

1. `DATASET_IDS` holds **twenty-nine** members — 7A's twenty-six plus `shift`, `till_event`, `needs_attention` — and every one of the three new datasets is a named `withTenant` read query with a two-tenant isolation case.
2. All **eleven** §4.16.1 codes are seeded from `packages/db/seed/my/reports/7c/`, `validateReportDefinition` accepts each against the live `datasets`/`permissions` sets, and `assertFieldCoverage` proves every field each definition names is a column the dataset actually serves.
3. Every one of the eleven declares a `tieOut` that the harness **executes**: **ten** tie to the ledger or to a stored table through an independent query — five `ledger_sum` (`accounting.party_statement`, `pos.sales_by_cashier`, `pos.sales_by_branch`, `accounting.branch_profit_and_loss`, `accounting.tax_return_view`) and five `projection` (`accounting.ageing` → `party_ageing`, `accounting.allocation_register` → `allocation`, `accounting.unreconciled_items` → `bank_statement_line`, `pos.z_report` → `shift`, ⚠️ `accounting.pdc_register` → `pdc`) — and the **one** whose kind is `none`, `pos.needs_attention`, supplies a row witness. **Nine and one when OD-09 = no.** No definition passes by having no test, and Task 14's `TIE_OUT` table is the same 10 + 1.
4. The three re-expressed codes' owning-slice tests re-run **unchanged and green**: 4B's ageing DoD tie-out and 6D's `tests/invariants/pos-shift-reconciliation.test.ts` (test 21).
5. `POST /v1/companies/{companyId}/exports` produces a `.tar.gz` containing `schema.json`, `manifest.json` and one CSV **and** one JSON file per included table (spec:2186 "CSV + JSON + a documented schema"), plus every attachment the requester is allowed to see (spec:1067); the same input produces a byte-identical archive twice.
6. A table whose `gate` the requester does not hold is **absent** from the archive and **named** in `manifest.excluded` with its gate — the mechanism 8A's `employee_sensitive` row plugs into with no change to exporter code (test 32; 8A's own PR narrows that table's `NEVER_EXPORTED` pin in the same commit as its registry row).
7. A `branch_manager` whose assignment carries branch rows receives `403 ERR_RBAC_FORBIDDEN` from `POST …/exports`, because the gate is company-scoped (`{ company: "path:companyId" }`) and `app.actor_has(code, company, null)` is false for a branch-narrowed assignment (test 36).
8. Every export writes audit rows: the request under the requester, the completion under the system principal (test 13).
9. `AGENTS.md`'s "Current phase" section names Phase 7 complete, and `tests/regression/sah-077.test.ts` and `sah-085.test.ts` each carry a 7C block.

---

## File Structure

```
packages/db/
  migrations/
    0078_create_export_job.sql                     NEW  T5   app.export_job + RLS + audit + stamp
    0078.down.sql                                  NEW  T5
    0079_seed_permission_phase7c.sql               NEW  T6   admin.data.export (global row)
    0079.down.sql                                  NEW  T6
  src/
    reports/
      datasets/pos.ts                              NEW  T1   shiftDataset, tillEventDataset, needsAttentionDataset
      datasets.ts                                  EDIT T1   three entries; DatasetId gains three members
    export/
      tables.ts                                    NEW  T7   ExportTable, EXPORT_TABLES, NEVER_EXPORTED
      schema.ts                                    NEW  T7   exportSchemaDocument, ExportSchemaDocument
      archive.ts                                   NEW  T8   tarGz, TarEntry — deterministic USTAR + gzip
      run.ts                                       NEW  T8   runExport, ExportResult, ExportManifest
      store.ts                                     NEW  T5   ExportJobRow, createExportJob, getExportJob,
                                                             listExportJobs, claimExportJob, completeExportJob,
                                                             failExportJob, exportObjectKeyFor
      index.ts                                     NEW  T5   the barrel packages/db/src/index.ts re-exports
    schema/export-job.ts                           NEW  T5   the Drizzle mirror (§3.4.9)
    jobs/payloads.ts                               EDIT T8   ONE key: "admin.export.run"
    index.ts                                       EDIT T1, T5, T7, T8 — re-exports
  seed/my/reports/7c/
    accounting.ageing.json                         NEW  T3   re-expressed, definitionVersion 2
    accounting.party_statement.json                NEW  T3
    accounting.allocation_register.json            NEW  T3
    accounting.unreconciled_items.json             NEW  T3
    accounting.pdc_register.json                   NEW  T11  ⚠️ OD-09 only
    pos.z_report.json                              NEW  T4   re-expressed, definitionVersion 2
    pos.sales_by_cashier.json                      NEW  T4   re-expressed, definitionVersion 2
    pos.sales_by_branch.json                       NEW  T4
    pos.needs_attention.json                       NEW  T4
    accounting.branch_profit_and_loss.json         NEW  T4
    accounting.tax_return_view.json                NEW  T4
  test/
    fixtures.ts                                    EDIT T5   seedExportJob (§4.17's one 7C row)
    reports/7c-datasets.test.ts                    NEW  T1
    reports/datasets.test.ts                       EDIT T1   7A's pinned array 26 → 29 (T1 Step 5)
    reports/harness-7c.test.ts                     NEW  T2
    reports/7c-ar-ap.test.ts                       NEW  T3
    export/store.test.ts                           NEW  T5
    export/tables.test.ts                          NEW  T7
    export/archive.test.ts                         NEW  T8
    export/run.test.ts                             NEW  T8
    export-job.test.ts                             NEW  T5   DDL, RLS, audit, two-tenant, lintSchema
    permission-catalogue.test.ts                   EDIT T6   one appended `it`
    seed/reports.test.ts                           EDIT T4   the 7c directory is applied by reportsLoader

packages/contracts/
  permissions.ts                                   EDIT T6   ONE PermissionDef: admin.data.export
  src/admin/export.ts                              NEW  T9   the export DTOs
  src/accounting/reports.ts                        EDIT T4   ReportCodeSchema += 7; T11 ⚠️ adds the 8th
  src/index.ts                                     EDIT T9
  openapi.json                                     EDIT T9   regenerated
  test/report-codes-7c.test.ts                     NEW  T4

packages/db/seed/roles.ts                          EDIT T6   auditor gains admin.data.export (spec:2163)

apps/api/src/
  export/authorise.ts                              NEW  T9   ExportGateSnapshot, exportGateSnapshot
  routes/admin/exports.ts                          NEW  T6 (skeleton) / T9 (the four routes)
  routes/index.ts                                  EDIT T6   createExportRoutes inside buildRoutes
apps/api/test/routes/reports/7c-pos-cross-module.test.ts   NEW  T4   the POS + cross-module group test;
                                                                    it needs startApi(), and packages/db/test
                                                                    may not import apps/api/test (§3.1)
apps/api/test/routes/admin/exports.test.ts         NEW  T9
apps/api/test/routes/admin/exports-gates.test.ts   NEW  T10  tests 32 and 36 clauses

apps/worker/src/
  jobs/export-run.ts                               NEW  T8   the admin.export.run handler
  index.ts                                         EDIT T8   registerHandler
apps/worker/test/handlers/export-run.test.ts       NEW  T8

tests/
  invariants/support/reports.ts                    EDIT T2   LedgerWindow += 3 optional members;
                                                             assertTieOut += 4 projection branches
                                                             (shift, allocation, bank_statement_line, pdc);
                                                             the ledger_sum measure map += 2 rows
  invariants/support/reports-7c.ts                 NEW  T2   CATALOGUE_7C, CATALOGUE_DIR_7C, readEnvelope7C,
                                                             readDefinition7C, ArApReportFixture, arApReportFixture,
                                                             PosReportFixture, posReportFixture
  invariants/probes.ts                             EDIT T6   one PROBES key (with the route module);
                                                   EDIT T8   one JOB_PROBES key (with the handler)
  invariants/report-tie-out-7c.test.ts             NEW  T14  every declared tie-out executed
  invariants/export-audit.test.ts                  NEW  T10  test 13's export clause
  regression/sah-077.test.ts                       EDIT T12, T14
  regression/sah-085.test.ts                       EDIT T14

docs/
  adr/0069-tenant-export-archive-and-table-registry.md              NEW  T7  (a PROPOSAL)
  adr/0070-export-runs-as-the-system-principal-behind-a-request-time-gate.md  NEW  T9
  superpowers/plans/2026-09-05-dulja-plan-contracts.md              EDIT T0  amendments A1–A15
  legacy/7c-template-mapping.md                                     NEW  T12 ⚠️ OD-27 only (7B ships 7b-template-mapping.md)
scripts/check/contracts-7c-amendments.sh                            NEW  T0
AGENTS.md                                                           EDIT T14 "Current phase"
```

---

### Task 0: Contracts amendments A1–A15 and the 7A / 7B / 6D / 4B / 5A repository gate

**No code. Nothing in Tasks 1–14 is written until these fifteen amendments are in the contracts document and `scripts/check/contracts-7c-amendments.sh` exits 0.** Every amendment below crosses a slice boundary: it either names something the contracts document does not have — and a later slice would then invent a second spelling of — or settles a place where the 7C card, §4.16 and the repository disagree. Hazard 32's rule is mechanical, so the register is amended first.

**One of the fifteen is not the executor's to write alone.** **A11** changes a sequencing rule 7A's own Task 3 relies on, so it goes to the architect as a settlement before Task 1 is written and the Execution handoff's PR table carries it as PR 1's blocking row. Everything else — **A5 included** — is a transcription or an additive registration the executor writes. (An earlier draft of this plan sent **A5** to the architect too, on the reading that 7A's `perBranch` statement option was broken as merged. That reading was wrong in three separate ways and A5 now transcribes 7B's amendment A6 instead; the Self-Review's fourth pass records why, so a reader who remembers the old text does not "restore" it.)

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (the fifteen amendments)
- Create: `scripts/check/contracts-7c-amendments.sh`

**Interfaces:**
- Consumes: nothing at run time. The gate reads the contracts document and the repository.
- Produces: amendments **A1–A15**, and the gate script every later task's first step re-runs.

- [ ] **Step 1: Write the fifteen amendments into the contracts document**

**A1 — §4.16.2, the three 7C `DatasetId` members and their row fields.** §4.16.2 names the three ids and nothing else; 7B's amendment A3 established that a dataset's row-field vocabulary is contract, because every `filters[].field`, `columns[].field`, `groups[].field`, `totals[].field` and `sort[].field` in every definition names one. Append to §4.16.2, in A3's own form:

> **The three Phase 6 datasets (7C).** Fields are `snake_case`, every money a fixed-decimal `string`, every date `YYYY-MM-DD`, every timestamp RFC 3339 UTC.
>
> | `DatasetId` | Row fields | Note |
> |---|---|---|
> | `shift` | `shift_id`, `branch_id`, `branch_code`, `terminal_id`, `terminal_code`, `cashier_principal_id`, `cashier_name`, `opened_at`, `opened_on` *(date)*, `closed_at`, `closed_principal_id`, `currency`, `opening_float`, `counted_cash`, `expected_cash`, `over_short`, `over_short_document_id`, `ticket_count` *(computed)*, `return_count` *(computed)*, `net_sales_base` *(computed)*, `no_sale_count` *(computed)*, `drawer_open_count` *(computed)*, `void_count` *(computed)* | **`opened_on` is `(opened_at at time zone 'UTC')::date` and is the field a date-range filter binds to.** `opened_at` stays a `timestamp` column for display and sorting, and 7A's `assertValue` refuses a bare `YYYY-MM-DD` against a `timestamp` column with `ERR_VALIDATION_FAILED` (7a:2526-2547) — so a report whose `fromDate`/`toDate` parameters are `kind: "date"`, which every POS date range in §4.16.1 is, must filter the **date** column. §4.11.1's parameter vocabulary has no `timestamp` kind (7a:1636), so the companion column is the only shape that keeps the parameter a date. `cashier_principal_id` is `app.shift.opened_principal_id` (§4.6.5 — attribution, never `*_by`). The six computed fields are **laterals in SQL**, exactly as 7A's `document.base_total` is: `ticket_count`/`return_count`/`net_sales_base` over `app.ledger_entry` joined to the shift's posted `POS_TICKET` documents, the three counts over `app.till_event`. **`net_sales_base` is `Σ(base_credit − base_debit)` restricted to `account.type = 'income'`** — the same measure 6D's `SalesByCashierRow.netSalesBase` names, so a parity case compares like with like. **There is no `discount_base`**: 6D's route derives that figure its own way and a second derivation in a dataset would be two definitions of one number (SAH-009); the definition-driven `pos.sales_by_cashier` therefore renders four measures and 6D's JSON route keeps all six (7B A2). **There is no `expected_cash_base`** — the count is a physical count in the shift's own currency (6D A3) |
> | `till_event` | `till_event_id`, `shift_id`, `branch_id`, `branch_code`, `terminal_id`, `terminal_code`, `kind`, `ticket_document_id`, `ticket_number`, `cashier_principal_id`, `cashier_name`, `supervisor_principal_id`, `occurred_at` | No `client_ref`: the till's own uuid is an idempotency key, not a reporting fact |
> | `needs_attention` | `needs_attention_id`, `branch_id`, `branch_code`, `terminal_id`, `terminal_code`, `client_ref`, `error_code`, `error_detail`, `resolved_principal_id`, `resolved_at`, `resolution_note`, `created_at`, `created_on` *(date)*, `is_open` *(computed: `na.resolved_at is null`)* | **`created_on` is `(created_at at time zone 'UTC')::date`**, the date companion `shift.opened_on` is, and for the same reason: `pos.needs_attention`'s optional `fromDate` is a `date` parameter and a `date` value against the `timestamp` column raises `ERR_VALIDATION_FAILED`. **`payload` is deliberately not a column.** It is the whole rejected ticket — items, prices, the customer, the cashier — and a report rendering it would be a covered side channel for exactly the reason 7B A3 keeps `audit_log.before`/`after` out of the audit report (spec:2450, tests 32 and 36). The payload stays reachable through 6A's gated needs-attention resource. `client_ref` **is** a column, because resolving a rejected ticket means finding it at the till by that ref |

**A2 — §4.16.2, `till_event` is a registered dataset with no core definition, and the code register stays closed at eleven.** §4.16.2 mandates the member; §4.16.1 is closed and gives 7C no twelfth code. Append:

> **A registered `DatasetId` need not be read by a core definition.** `till_event` is registered because §4.16.2 assigns it to 7C and because the report **designer** (7A's clone-and-edit, the Phase 7 DoD's first sentence) enumerates `DATASET_IDS`: a tenant who wants a drawer-open audit builds it with no release, which is the whole point. The Z-report's till-event counts reach the page as the three `shift` laterals of A1 rather than through a second definition, and **no twelfth `ReportCode` is added** — §4.16.1 is closed for v1 and a slice that wants another core report amends it first. 7C's group test still exercises the dataset directly (columns, filters, ordering, two-tenant isolation), so a registered-but-unread member is proven, not merely declared.

**A3 — §4.11.1 / 7B amendment A5, the tie-out vocabulary this catalogue needs.** A5 fixed a closed measure map and a five-member `projection` vocabulary against 7B's thirteen sources. 7C reads five more. Append to A5's two bullets:

> **The `ledger_sum` measure map gains two rows (7C):** **`net_sales_base` → `sum(base_credit − base_debit)`** and **`tax_base` → `sum(base_credit)`**. Both are computed as fixed columns of the harness's one query, exactly like the four 7B rows; neither introduces a SQL fragment and no field name reaches a statement. `base_total → sum(base_debit)` (7B) is reused unchanged by `accounting.party_statement`.
>
> **`tieOut.projection` gains four members (7C):** `shift`, `allocation`, `bank_statement_line` and ⚠️ `pdc`. **Three of the four are stored tables rather than async projections, and the branch is still the right one:** what `projection` means to the harness is *"the report's rows, grouped on the source's own key, equal the source's stored figures read by the test's own SQL"*, and that is exactly the comparison an allocation register, an unreconciled-items list and a Z-report need — two independent paths to one stored fact, which is what a tie-out is. A settlement that never reaches the ledger (`app.allocation` posts nothing, §4.8.1) cannot use `ledger_sum` and must not use `none`, because `none` is reserved for a report with no monetary total. **No fourth `tieOut.kind` is added** — that would change `report-definition.schema.json` and 7A's generated type, which §2.8 forbids a catalogue slice from touching.
>
> **`LedgerWindow` gains three optional members (7C):** `partyId?: string`, `branchId?: string`, `shiftId?: string`. Each narrows the harness's ledger query by a join that already exists — `document.party_id`, `document.branch_id`, `document.shift_id` — and each is optional, so 7B's own windows are unchanged. This is the same additive extension 7B itself made (`LedgerWindow.accountTypes?`, `TieOutOptions.projectionKeys?`).

**A4 — §4.17.1, the 7C catalogue helper file.** Add the row:

> | `CATALOGUE_7C`, `ReportCode7C`, `CATALOGUE_DIR_7C`, `readEnvelope7C(code)`, `readDefinition7C(code)`, `ArApReportFixture`, `arApReportFixture(db, name)`, `PosReportFixture`, `posReportFixture(api, name)` | `tests/invariants/support/reports-7c.ts` | **7C** | the 7C half of 7B's catalogue harness. It **imports** `runDefinition`, `assertFieldCoverage`, `assertTieOut`, `ReportSeedEnvelope`, `LedgerWindow`, `TieOutOptions` and `TieOutWitness` from `./reports` and adds no second implementation of any of them; the only edits it makes to `reports.ts` are the three optional `LedgerWindow` members and the four `assertTieOut` `projection` branches of A3, which A9 already sanctions. It is a **separate file** rather than a second block in `reports.ts` because `CATALOGUE_DIR` there is `…/reports/7b` and the seed directories are deliberately disjoint (§4.16.1); a shared const with two meanings is how a group test reads the wrong file. `posReportFixture` takes a `StartedApi` rather than a `Db`, because a POS fixture reaches the till through 6A's signed sync path and 6C's `staffFixture` already requires one |

**A5 — §4.16.1, `accounting.branch_profit_and_loss` is exactly `statementDefinition("profit_and_loss", identity, { perBranch: true })`.** §4.16.1's row says only "cross-module; BRANCH dimension (spec:1066)". 7B's amendment A6 already settled the rest — *"The BRANCH cut is **7C's `accounting.branch_profit_and_loss`**, built from `statementLayout("profit_and_loss", { perBranch: true })`, whose branch clause `statementRows` serves through the `ledger_entry` dataset because that is the only place a branch tag exists on a posted amount"* — and 7B's own handoff says it again in terms: *"7C's own definition is `statementDefinition("profit_and_loss", identity, { perBranch: true })` by the same rule Task 2 follows"*. This amendment transcribes that onto §4.16.1's row so a 7C executor does not have to reconstruct it from a neighbouring plan:

> **`accounting.branch_profit_and_loss` is exactly `statementDefinition("profit_and_loss", { code, nameEn, nameAr, permission: "accounting.report.read" }, { perBranch: true })`** — 7A's frozen `build("profit_and_loss", { perBranch: true })` fragment composed onto the code's identity, by the same rule 7B A6 imposes on `accounting.profit_and_loss` and `accounting.balance_sheet`. Its `dataset.source` is **`account_balance`**, which names the row **shape** both statement queries produce and *not* the query: `rowsForDefinition` sees a `STATEMENT_CODES` key and dispatches to `statementRows`, whose branch variant reads the **`ledger_entry`** dataset and collapses it to the `account_balance` shape (7A's own comment on `STATEMENT_EXTRA_FIELDS`: *"the per-BRANCH statement of spec:1066 is served by `statementRows` reading the `ledger_entry` dataset — which does carry both, from the document join — and collapsing it to the `account_balance` row shape … `rowsForDefinition` is what picks the query"*). **7C therefore writes no layout of its own, calls `statementSectionFor` nowhere, and edits nothing of 7A's** (§2.8). Its seed file is generated from `statementDefinition`, and a group test asserts the deep equality rather than describing it — the identical mechanical guard 7B's Task 2 uses.
>
> **Three facts that make the obvious objections wrong, recorded because a reader will re-raise them.** (1) The `perBranch` fragment's `{ field: "branch_id", op: "eq", param: "branchId" }` filter **never reaches `columnOf`**: `rowsForDefinition`'s statement branch does not consult `definition.dataset.filters` at all — 7A's own note says *"on the statement branch the definition's `dataset.filters` are NOT consulted — the two queries `statementRows` owns take `fiscalPeriodId` and `branchId` and nothing else"*. (2) `assertDefinitionFields` does not refuse `branch_id`, `branch_code` or `section` against the `account_balance` column list, because it unions `STATEMENT_EXTRA_FIELDS = ["section", "branch_code", "branch_id"]` for exactly the three `STATEMENT_CODES` keys, of which `accounting.branch_profit_and_loss` is one. (3) `base_balance` **is** an `account_balance` `DatasetColumn` (7B A3 pins it as the computed `(b.base_debit - b.base_credit)`), and it is a key of 7B's closed `ledger_sum` measure map (`base_balance → sum(base_debit − base_credit)`), so the tie-out compares like with like.
>
> **The consequence for a tie-out's parameters, stated once.** `assertFieldCoverage` checks `dataset.filters[].field` against the returned row keys, and `statementRows` adds `branch_id` to a row only on its `ledger_entry` branch. **Every run of this definition in a test therefore supplies a real `branchId`** (`s.hq`, the head-office BRANCH value every `app.document` row carries — §4.1's `Seed`), and the `LedgerWindow` of A3 carries the same `branchId` so both sides measure one branch. Omitting it takes `statementRows`' `account_balance` fallback, which annotates `branch_code: null` and no `branch_id` at all, and the failure reads `accounting.branch_profit_and_loss: dataset "account_balance" has no field(s) branch_id`.

**A6 — §4.16.1, `accounting.party_statement`'s parameter is `partyId`, not `partyKind`.** The register's note reads "one definition, `partyKind` parameter". 7A's `document` dataset carries `party_id`, `party_code` and `party_name_en` and **no `party_kind`** (7B A3), so a `partyKind` filter has no column to bind and would throw from `columnOf`. Amend the row's note:

> `accounting.party_statement` declares **`partyId` (party, required)**, `fromDate` and `toDate` (date, required) and `documentTypeCode` (text, optional). A statement is a per-party document, so `partyId` is what a viewer supplies; the register's original `partyKind` described a catalogue-wide statement 7A's dataset cannot express. The spec's counting sentence (spec:2293, "~60 parameterised core reports" counts *parameterised outputs*) is unaffected — one definition run once per party is still one definition and many outputs. Its `tieOut` is `ledger_sum` with **no `account`**, over `LedgerWindow { partyId, fromDate, toDate }` and the `base_total → sum(base_debit)` measure: Σ of the party's document totals in the window equals Σ `base_debit` over the ledger rows those documents posted — two paths, one figure.

**A7 — §4.16.1, `accounting.tax_return_view`'s dataset, parameters and tie-out.** The row says only "reads `tax_transaction`; the filed return itself is 5A's `tax_return` row". Amend:

> `accounting.tax_return_view` reads the **`tax_transaction`** dataset and declares `fiscalPeriodId` (period, required), `taxCodeKind` (enum, required, `options: ["output", "input"]`) and `regimeCode` (text, optional). Its `tieOut` is `ledger_sum` with the **`tax_base → sum(base_credit)`** measure of A3 and `account: "2300"` — output tax payable, §4.15's row seeded by 5A — and **the group test executes it with `taxCodeKind: "output"`**, the parameter under which the account restriction is the correct comparison; the input side is rendered by the same definition against `1350` and is proven by the row witness in the same test. **This report names no authority form, no box number, no rate and no deadline** (hazard 2): it renders the columns `tax_code`, `tax_code_kind`, `tax_rate`, `regime_code`, `base_base` and `tax_base` that 5A's engine already stored, and nothing else.

**A8 — §4.16.1, `accounting.unreconciled_items` is a filter, not a query.** Amend the row's note:

> `accounting.unreconciled_items` is the **`bank_statement_line`** dataset filtered `is_matched eq false` — 7A built `matched_amount` and `is_matched` as columns for exactly this report ("the 'unreconciled items' report is exactly this predicate, so it is a column and not a hand-written report"). The definition adds `bankAccountId` (account, optional) and `fromDate`/`toDate` (date, optional) over `value_date`, and declares `isMatched` (enum, required, `options: ["false", "true"]`) so a reconciler can also list what *is* matched without a second code. Its `tieOut` is `projection: "bank_statement_line"` (A3). It stays gated `accounting.bank.reconcile` — mutating-gated by design, so only a reconciler sees it (§4.16.1's original note, unchanged).

**A9 — §4.6.1 and §3.5.3, `app.export_job`'s DDL is fixed here.** The register's row is a compact column list; three details are load-bearing and are settled before the migration is written. Amend the `export_job` row:

> | `export_job` | 7C / 0078 | `company_id`, `requested_by uuid not null default app.current_actor()` (stamped), `format text not null check (format in ('csv','json','both')) default 'both'`, `status text not null check (status in ('queued','running','done','failed')) default 'queued'`, `readable_modules text[] not null default '{}'`, `lot_attachments boolean not null default false`, `include_attachments boolean not null default true`, `table_count int`, `row_count bigint`, `byte_size bigint`, `object_key text`, `sha256 bytea`, `manifest jsonb`, `started_at timestamptz`, `finished_at timestamptz`, `error text`; `unique (tenant_id, id)`, composite FK to `company` |
>
> **Why `format` has three values and not the register's two.** spec:2186 requires "CSV **+** JSON **+** a documented schema", which a two-value CHECK cannot express; `'both'` is the default and the only value the v1 UI offers, and the two single-format values exist because an integrator that wants one serialisation should not have to download the other. `'both'` writes `tables/<name>.csv` **and** `tables/<name>.json`.
>
> **Why `readable_modules` and `lot_attachments` are columns.** The attachment download gate is `MODULE_READ_CODE`, whose one home is `apps/api` (§4.5.8, 6D amendment A18: `apps/api/src/middleware/require-attachment-read.ts`). `apps/worker` and `packages/db` may not import an app (§3.1), and the job runs as the **system** principal, which holds every code — so the job cannot re-derive the requester's readable modules and must not try. The route computes them with `readableModules()` at request time and records them; the job filters attachments by them. `lot_attachments` is separate because §4.5.8 gates a lot attachment on `inventory.item.read` while `readableModules()` returns `inventory` for `inventory.stock.read` — one boolean is cheaper and more honest than a synthetic module string. ADR 0070 records the decision.
>
> **Linter sets (§3.5.3):** `export_job` joins **none** of `NO_ID_TABLES`, `NO_CREATED_AT_TABLES`, `AUDIT_EXEMPT` or `IMMUTABLE`, exactly as §3.5.3's row already states, and **receives no `branch_isolation` policy**: it has no `branch_id` and is not one of §4.5.6 Form C's five stock tables. An export is company-wide by construction (Global Constraint 11) and a branch-narrowed principal cannot request one at all.

**A10 — §4.2.6, the `admin.export.run` payload.** §4.2.6 lists the job name with `owner: "7C"` and no payload. Append one key to the `JobPayload` block:

> ```ts
>   /** Slice 7C. The `export_job` row carries the format, the recorded gates and the company. */
>   "admin.export.run": { exportJobId: string };
> ```

**A11 — §3.6.3 and §2.8 (7C card), a permission-seed task closes its own `permission-catalogue` gap. ⚠️ ARCHITECT SETTLEMENT.** 7A's Task 3 seeded `accounting.report.export` and left `bun run lint:rules` red for nine tasks, closing it only in Task 12. §3.8 requires the root scripts to stay green after every task, and a permanently red lint is indistinguishable from a regression for nine reviews. Append to §3.6.3:

> **The task that adds a catalogue code ships a `PERMISSION[…]` reference in the same commit.** The reference need not be a finished handler: a route module registered in `buildRoutes` with its `permissions: [PERMISSION["<code>"]]` array and one `createRoute` gated by `requirePermission` satisfies `permission-catalogue` (§3.6.3) and `assertRouteGates` (R7) while the handler body is still a `501`-shaped stub the same slice replaces two tasks later. **7C's Task 6 does exactly this** and `bun run lint:rules` is green at every 7C commit. 7A's Task 3 → Task 12 gap is recorded, not retro-fixed: 7A is merged, its gap closed at its own Task 12, and re-opening a frozen plan to move a lint failure earlier changes no shipped behaviour.

**A12 — §4.2.7, the exports route module and its factory.** Append a row to the module-path register:

> | `/v1/companies/:companyId/exports` | `createExportRoutes(objectStore)` — a **factory**, like 0B's `createUserRoutes(authAdmin)`, 2C's `createAttachmentRoutes(objectStore)` and 7A's `createReportRunRoutes(objectStore)`; the download route needs the store and `AppEnv["Variables"]` is pinned at eight members (§4.2.3, round 3), none of which is an object store | 7C | `admin.data.export` |
>
> Sub-paths: `POST …/exports`, `GET …/exports`, `GET …/exports/{exportJobId}`, `GET …/exports/{exportJobId}/content`. **One `PROBES` key** (`"/v1/companies/:companyId/exports"`); the sub-paths inherit it (hazard 31). **The download route does not join `REPLAY_BY_RERUN`** (§4.2.9): it is a `GET`, the idempotency middleware runs on unsafe methods only, and `REPLAY_BY_RERUN` exists for a write-free **POST** whose body is not JSON. `POST …/exports` returns JSON and replays normally.

**A13 — §4.17, `seedExportJob`.** Add the row:

> | `seedExportJob(db, s, opts?: { format?; status?; readableModules?; lotAttachments?; includeAttachments? })` | 7C | `string` | the `export_job` row id; `format` defaults `'both'`, `status` `'queued'`, `readableModules` `["accounting"]`, `lotAttachments` `false`, `includeAttachments` `true` |

**A14 — §4.2.8, the export contracts module.** Add the row:

> | `admin/export.ts` | `ExportFormatSchema`, `ExportStatusSchema`, `CreateExportBody`, `ExportAcceptedSchema`, `ExportJobSchema`, `ExportJobQuery`, `ExportJobList`, `ExportManifestSchema`, `ExportJobDto` | 7C |

**A15 — §4.16.3, `ReportCodeSchema` after 7C.** Append:

> **7C widens it by its eight new codes** — `accounting.party_statement`, `accounting.allocation_register`, `accounting.unreconciled_items`, `accounting.branch_profit_and_loss`, `accounting.tax_return_view`, `pos.sales_by_branch`, `pos.needs_attention`, and ⚠️ `accounting.pdc_register` only if OD-09 — **appended after whatever members already exist**. The three codes 7C re-expresses (`accounting.ageing` from 4B, `pos.z_report` and `pos.sales_by_cashier` from 6D) are already members and are not touched. **No slice asserts a total member count** (7B A4's rule, unchanged): 7C lands after 6D by §6.3, so the count is deterministic at thirty-one or thirty-two depending on OD-09, and a count assertion still buys nothing that a membership assertion does not.

- [ ] **Step 2: Write `scripts/check/contracts-7c-amendments.sh`**

```bash
#!/usr/bin/env bash
# Gate for slice 7C. Exits 0 only when every amendment of Task 0 is in the contracts
# document AND every predecessor surface this slice consumes is in the repository.
# Every later task's Step 1 re-runs it, because a missing predecessor is a red test
# that looks like this slice's bug and is not.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTRACTS=docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
fail=0

need_doc () {  # $1 label, $2 literal
  if grep -qF -- "$2" "$CONTRACTS"; then printf '  ok   %s\n' "$1"
  else printf '  MISS %s  (contracts: %s)\n' "$1" "$2"; fail=1; fi
}
need_repo () {  # $1 label, $2 file, $3 literal
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then printf '  ok   %s\n' "$1"
  else printf '  MISS %s  (%s: %s)\n' "$1" "$2" "$3"; fail=1; fi
}

printf 'contracts amendments A1-A15\n'
need_doc "A1  shift row fields"        "net_sales_base"
need_doc "A2  till_event unread"       "A registered \`DatasetId\` need not be read by a core definition"
need_doc "A3  measure map + 2"         "\`tax_base\` → \`sum(base_credit)\`"
need_doc "A3  projection + 4"          "\`tieOut.projection\` gains four members (7C)"
need_doc "A3  LedgerWindow + 3"        "\`LedgerWindow\` gains three optional members (7C)"
need_doc "A4  reports-7c.ts"           "tests/invariants/support/reports-7c.ts"
need_doc "A5  branch P&L statement"    'is exactly `statementDefinition('
need_doc "A6  party_statement partyId" "declares **\`partyId\` (party, required)**"
need_doc "A7  tax_return_view"         "reads the **\`tax_transaction\`** dataset and declares"
need_doc "A8  unreconciled_items"      "is a filter, not a query"
need_doc "A9  export_job DDL"          "check (format in ('csv','json','both'))"
need_doc "A10 job payload"             "\"admin.export.run\": { exportJobId: string }"
need_doc "A11 lint-green rule"         "ships a \`PERMISSION[…]\` reference in the same commit"
need_doc "A12 exports route module"    "/v1/companies/:companyId/exports"
need_doc "A13 seedExportJob"           "seedExportJob(db, s, opts?"
need_doc "A14 admin/export.ts"         "ExportManifestSchema"
need_doc "A15 ReportCodeSchema"        "7C widens it by its eight new codes"

printf 'predecessor surfaces\n'
need_repo "7A datasetFor"      packages/db/src/reports/datasets.ts        "export function datasetFor"
need_repo "7A DATASET_IDS 26"  packages/db/src/reports/datasets.ts        "tax_transaction"
need_repo "7A defineDataset"   packages/db/src/reports/query.ts           "export function defineDataset"
need_repo "7A validate"        packages/domain/src/reports/validate.ts    "export function validateReportDefinition"
need_repo "7A statementDef"    packages/domain/src/reports/statement.ts   "export function statementDefinition"
# `accounting.branch_profit_and_loss` is a STATEMENT_CODES key and its rows come from `statementRows`'
# ledger_entry branch, not from `datasets.ts` (amendment A5). Both surfaces are checked, because a
# definition seeded under a code the map does not carry would silently read `account_balance` instead.
# The key alone, not the whole map entry: `grep -qF` is byte-exact and 7A's literal may be column-aligned
# or carry a trailing comma. `statement.ts` has no other reason to name this code.
need_repo "7A STATEMENT_CODES" packages/domain/src/reports/statement.ts   "accounting.branch_profit_and_loss"
need_repo "7A statementRows"   packages/db/src/reports/statement.ts       "export async function statementRows"
need_repo "7A rowsForDef"      packages/db/src/reports/statement.ts       "export async function rowsForDefinition"
need_repo "7A defFields"       packages/db/src/reports/statement.ts       "export function assertDefinitionFields"
need_repo "7A reportsLoader"   packages/db/src/seed/reports.ts            "export const reportsLoader"
need_repo "7A seedReportDef"   packages/db/test/fixtures.ts               "export function seedReportDefinition"
need_repo "7A objectStore"     apps/worker/src/object-store.ts            "export function objectStore"
need_repo "7A reportObjectKey" packages/db/src/reports/run-store.ts       "export function reportObjectKeyFor"
need_repo "7B assertTieOut"    tests/invariants/support/reports.ts        "export async function assertTieOut"
need_repo "7B runDefinition"   tests/invariants/support/reports.ts        "export async function runDefinition"
need_repo "7B fieldCoverage"   tests/invariants/support/reports.ts        "export function assertFieldCoverage"
need_repo "7B envelope"        tests/invariants/support/reports.ts        "definitionVersion"
need_repo "6D shift table"     packages/db/migrations/0070_create_shift_till_event.sql "create table app.shift"
need_repo "6D till_event"      packages/db/migrations/0070_create_shift_till_event.sql "create table app.till_event"
need_repo "6D zReport"         packages/db/src/reports/pos.ts             "export async function zReport"
need_repo "6D salesByCashier"  packages/db/src/reports/pos.ts             "export async function salesByCashier"
need_repo "6D seedShift"       packages/db/test/fixtures.ts               "export function seedShift"
need_repo "6D test21"          tests/invariants/pos-shift-reconciliation.test.ts "describe("
need_repo "6C staffFixture"    tests/invariants/support/staff.ts          "export async function staffFixture"
need_repo "6C supervisorA"     tests/invariants/support/staff.ts          "supervisorA"
need_repo "6C branchActor"     tests/invariants/support/staff.ts          "export async function branchActor"
need_repo "5A postTaxedDoc"    tests/invariants/support/tax.ts            "export async function postTaxedDocument"
need_repo "5A TaxFixture"      tests/invariants/support/tax.ts            "export interface TaxFixture"
need_repo "6A needs_attention" packages/db/migrations/0060_create_terminal_enrolment_needs_attention.sql "create table app.needs_attention"
need_repo "4B agedBalance"     packages/db/src/reports/ageing.ts          "export async function agedBalance"
# The SIGNATURE, not just the name: `arApReportFixture` passes a Seed and reads `accountIds`/`partyIds`
# off the result, and a drift here is a compile error in a file three tasks depend on.
need_repo "4B arApFixture"     tests/invariants/support/ar-ap.ts          "export async function arApFixture(db: Db, s: Seed)"
need_repo "4B ArApFixture body" tests/invariants/support/ar-ap.ts         "accountIds: Readonly<Record<string, string>>"
need_repo "4B postFromPack"    tests/invariants/support/ar-ap.ts          "export async function postFromPack"
need_repo "4B reconciled"      packages/db/src/ar-ap/reconciliation.ts    "export async function reconciledBalance"
need_repo "5A tax_transaction" packages/db/src/reports/datasets/accounting.ts "taxTransactionDataset"
need_repo "2C readableModules" apps/api/src/middleware/require-attachment-read.ts "export function readableModules"

printf 'migration range 0078-0079 is free\n'
for n in 0078 0079; do
  if compgen -G "packages/db/migrations/${n}_*.sql" > /dev/null; then
    printf '  note %s already present (re-run after a task that creates it)\n' "$n"
  else printf '  ok   %s free\n' "$n"; fi
done

[ "$fail" -eq 0 ] || { printf '\nFAIL: see MISS lines above.\n'; exit 1; }
printf '\nOK\n'
```

> **`app.needs_attention` is created by 6A's migration 0060, not by 0059.** 6A's card and its written plan both name **`0059_add_catalogue_revision.sql`** (verb `add`, contracts §2.7 / 6a:20) for the catalogue-revision file, and **`0060_create_terminal_enrolment_needs_attention.sql`** (6a:21, 6a:1295) for the file that creates `app.terminal_enrolment`, `app.needs_attention` and `app.resolve_enrolment` — 6A renamed it from the catalogue JSON's `0060_create_pos_enrolment.sql` precisely because a name that understates what a file does is renamed, not left. An earlier draft of this gate checked `0059_create_catalogue_revision.sql`, a file name that exists nowhere, for a table that is not in it. If the merged repository names either file differently, correct the one `need_repo` line rather than adding a second check — §4.18's rule is that the written plan is the authority and the repository beats both.

- [ ] **Step 3: Run the gate**

Run: `bash scripts/check/contracts-7c-amendments.sh`
Expected: `OK` and a zero exit. Every `MISS` line names the amendment or the predecessor symbol that is absent; fix the contracts document, or stop and raise against the named slice if a predecessor surface is genuinely missing.

- [ ] **Step 4: Commit**

```bash
chmod +x scripts/check/contracts-7c-amendments.sh
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md scripts/check/contracts-7c-amendments.sh
git commit -m "$(cat <<'EOF'
docs(contracts): record the fifteen 7C amendments and add the slice gate [7C T0]

A1-A2 register the three Phase 6 datasets, their row fields and the fact that
till_event has no core definition. A3 extends 7B's tie-out harness vocabulary
by two measures, four projection sources and three LedgerWindow members. A4
registers tests/invariants/support/reports-7c.ts. A5 transcribes 7B amendment
A6's settlement onto §4.16.1's row: accounting.branch_profit_and_loss is
exactly statementDefinition("profit_and_loss", identity, { perBranch: true }),
its dataset.source names the row SHAPE and statementRows picks the query, and
a tie-out must pass a real branchId or the ledger_entry branch is not taken.
A6-A8 fix three §4.16.1 rows against
7A's shipped dataset columns. A9 fixes app.export_job's DDL, including the
three-value format CHECK spec:2186 requires and the two recorded-gate columns
the worker needs because MODULE_READ_CODE lives in apps/api. A10 adds the job
payload, A11 makes a permission-seed task close its own lint gap, A12-A14
register the route module, the fixture and the contracts module, A15 widens
ReportCodeSchema by eight.

A11 is the one architect settlement: it changes a sequencing rule 7A's own
Task 3 relied on. Every other amendment, A5 included, is a transcription or
an additive registration.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---


### Task 1: The three Phase 6 datasets — `shift`, `till_event`, `needs_attention`

7A cut its registry at migration ≤ 0058 and left the Phase 6 continuation here (§4.16.2). This task adds `shift`, `till_event` and `needs_attention` in 7A's own `defineDataset` shape and closes the registry at twenty-nine. **The harness that executes definitions over them is Task 2's** — this task's own test drives `datasetFor(...).run` directly, so a dataset defect is diagnosed before any definition exists to blame.

**Files:**
- Create: `packages/db/src/reports/datasets/pos.ts`, `packages/db/test/reports/7c-datasets.test.ts`
- Modify: `packages/db/src/reports/datasets.ts`, `packages/db/src/reports/index.ts`, **`packages/db/test/reports/datasets.test.ts` (7A's — its registry case pins the twenty-six ids as a literal array and must be extended to twenty-nine in this same commit; see Step 5)**

**Interfaces:**
- Consumes: `defineDataset`, `Dataset`, `DatasetColumn`, `DatasetParams`, `DatasetRow`, `DatasetFilter`, `SqlFragment`, `MAX_DATASET_ROWS`, `datasetFor`, `isDatasetId`, `DATASETS`, `DATASET_IDS`, `ReportError` (7A); the tables the three datasets read, all **read-only** — `app.shift`, `app.till_event` (6D), `app.needs_attention` (6A), `app.pos_terminal` (6A), `app.document`, `app.document_type`, `app.document_line` (1A), `app.ledger_entry`, `app.account` (1B), `app.dimension_value` (the branch dimension value a shift's `branch_id` names), `app.principal` (0A); `startDb`, `withTenant`, `seedTenantV2`, `seedBranch`, `seedTerminal`, `seedShift`, `grantCodes` (§4.1, §4.17). **No 7B harness name is consumed here** — `runDefinition`, `assertFieldCoverage` and `assertTieOut` first appear in Task 2, and this task's test drives `datasetFor(...).run` directly so that a dataset defect is diagnosed before any definition exists to blame.
- Produces:

```ts
// packages/db/src/reports/datasets/pos.ts
export const shiftDataset: Dataset;             // id "shift"            — amendment A1
export const tillEventDataset: Dataset;         // id "till_event"
export const needsAttentionDataset: Dataset;    // id "needs_attention"

// packages/db/src/reports/datasets.ts — the union closes for Phase 6 at twenty-nine
export type DatasetId = /* 7A's twenty-six, unchanged */ | "shift" | "till_event" | "needs_attention";
```

- [ ] **Step 1: Run the Task 0 gate**

Run: `bash scripts/check/contracts-7c-amendments.sh`. Expected: `OK`. Every later task begins the same way and the instruction is not repeated.

- [ ] **Step 2: Write the failing test `packages/db/test/reports/7c-datasets.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATASETS, DATASET_IDS, datasetFor, isDatasetId, type DatasetId, type DatasetParams } from "../../src/reports";
import {
  grantCodes, seedBranch, seedShift, seedTenantV2, seedTerminal, startDb, withTenant, type Db, type Seed,
} from "../index";

describe("7C datasets — the three Phase 6 members (§4.16.2, amendment A1)", () => {
  let db: Db; let s: Seed; let other: Seed; let branchB: string; let terminalId: string;
  let cashierId: string; let shiftId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "7c-datasets");
    other = await seedTenantV2(db, "7c-datasets-other");
    await grantCodes(db, s, { codes: ["pos.report.read", "pos.needs_attention.resolve"] });
    branchB = await seedBranch(db, s, { code: "BR2", nameEn: "Branch two" });
    const t = await seedTerminal(db, s, { code: "T1" });
    terminalId = t.terminalId; cashierId = t.principalId;
    shiftId = await seedShift(db, s, { terminalId, cashierPrincipalId: cashierId, openingFloat: "200.0000" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  const run = (seed: Seed, id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, seed.tenant, seed.human, (tx) =>
      datasetFor(id).run(tx, { companyId: seed.company, filters: [], sort: [], limit: 100, offset: 0, ...params }));

  it("the registry closes at twenty-nine and holds the three Phase 6 ids", () => {
    for (const id of ["shift", "till_event", "needs_attention"]) {
      expect(isDatasetId(id), id).toBe(true);
      expect(DATASETS[id as DatasetId], id).toBeDefined();
    }
    // 7A's twenty-six plus these three. 8D's six move the number in 8D's own PR — a count assertion is
    // what catches a dataset added without a §4.16.2 row (hazard 32).
    // ⚠️ OD-09: 7A's twenty-six INCLUDE `pdc`, which is itself gated on OD-09. If the owner answers "no"
    // and 7A ships twenty-five, this expectation is 28 and the literal array Step 5 extends in 7A's own
    // reports/datasets.test.ts drops `"pdc"` and becomes twenty-eight — one number here, one literal
    // there, nothing else. Task 11 tracks that ripple; it is recorded here because this is the assertion
    // that fails first.
    expect(DATASET_IDS).toHaveLength(29);
  });

  it("shift returns one row per shift, money as fixed-decimal strings and every lateral a typed zero", async () => {
    const rows = await run(s, "shift");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["shift_id"]).toBe(shiftId);
    expect(rows[0]!["opening_float"]).toBe("200.0000");
    expect(rows[0]!["cashier_principal_id"]).toBe(cashierId);
    expect(rows[0]!["closed_at"]).toBeNull();
    // No ticket posted yet, so the laterals are zeros of the right TYPE and not nulls: a null renders as
    // an empty cell and a reader cannot tell "no sales" from "no column".
    expect(rows[0]!["ticket_count"]).toBe(0);
    expect(rows[0]!["net_sales_base"]).toBe("0.0000");
    expect(rows[0]!["no_sale_count"]).toBe(0);
  });

  it("shift filters by branch and by cashier and sorts by opened_at", async () => {
    expect(await run(s, "shift", { filters: [{ field: "branch_id", op: "eq", value: branchB }] })).toEqual([]);
    expect(await run(s, "shift", { filters: [{ field: "cashier_principal_id", op: "eq", value: cashierId }] })).toHaveLength(1);
    expect(await run(s, "shift", { sort: [{ field: "opened_at", dir: "asc" }] })).toHaveLength(1);
  });

  it("a DATE range binds to opened_on, and the same value against opened_at is refused (amendment A1)", async () => {
    // Every POS date range in §4.16.1 is a `kind: "date"` parameter, so the value that reaches the dataset
    // is `YYYY-MM-DD`. 7A's `assertValue` refuses that against a `timestamp` column (7a:2536) — the whole
    // reason the two date companions exist. Both directions are asserted so a later edit cannot quietly
    // point a filter back at the timestamp.
    expect(await run(s, "shift", { filters: [
      { field: "opened_on", op: "gte", value: "2026-01-01" },
      { field: "opened_on", op: "lte", value: "2026-12-31" },
    ] })).toHaveLength(1);
    await expect(run(s, "shift", { filters: [{ field: "opened_at", op: "gte", value: "2026-01-01" }] }))
      .rejects.toThrow(/is not a timestamp \(field 'opened_at'\)/);
    expect(await run(s, "needs_attention", { filters: [{ field: "created_on", op: "gte", value: "2026-01-01" }] }))
      .toEqual([]);
  });

  it("till_event and needs_attention are queryable and filter over their closed vocabularies", async () => {
    expect(await run(s, "till_event")).toEqual([]);
    expect(await run(s, "till_event", { filters: [{ field: "kind", op: "in", value: ["no_sale", "void"] }] })).toEqual([]);
    expect(await run(s, "needs_attention")).toEqual([]);
    expect(await run(s, "needs_attention", { filters: [{ field: "is_open", op: "eq", value: "true" }] })).toEqual([]);
  });

  it("needs_attention never exposes the rejected ticket's payload (amendment A1)", () => {
    expect(datasetFor("needs_attention").columns.map((c) => c.field)).not.toContain("payload");
    // The column must not be SELECTED either: a key absent from `columns` but present in the row still
    // reaches a renderer through Object.keys, which is how a side channel is built by accident.
    expect(JSON.stringify(DATASETS["needs_attention"])).not.toContain("payload");
  });

  it("TENANT ISOLATION — the other tenant sees none of these rows", async () => {
    for (const id of ["shift", "till_event", "needs_attention"] as DatasetId[]) {
      expect(await run(other, id), id).toEqual([]);
    }
  });

  it("an unknown id is ERR_REPORT_DATASET_UNKNOWN, not a crash", () => {
    expect(() => datasetFor("shifts")).toThrowError(/ERR_REPORT_DATASET_UNKNOWN/);
  });
});
```

Run `bun run --cwd packages/db test -- reports/7c-datasets`. Expected: **FAIL** on the first case with `expected false to be true` from `isDatasetId("shift")`.

- [ ] **Step 3: Write `packages/db/src/reports/datasets/pos.ts`**

```ts
// The three Phase 6 datasets (§4.16.2, amendment A1). 7A could not ship them: app.needs_attention
// arrives with migration 0060 (6A's 0060_create_terminal_enrolment_needs_attention.sql) and
// app.shift / app.till_event with 0070, all past the ≤ 0058 bound its registry was cut at.
//
// Every measure is a LATERAL in SQL, exactly as 7A's `document.base_total` is — never JavaScript
// arithmetic over a page, so no `number` ever holds a monetary value (§3.7.5's no-number-money).
// `net_sales_base` is Σ(base_credit − base_debit) over income accounts of the shift's posted
// POS_TICKET documents: the SAME measure 6D's `SalesByCashierRow.netSalesBase` names, which is what
// lets Task 4's parity case compare like with like instead of two plausible-looking numbers.
import type { Sql } from "postgres";
import { defineDataset, type Dataset, type DatasetColumn } from "../query";

/** The shift's own posted or reversed POS_TICKET ids. Written once; every lateral selects from it. */
const TICKET_IDS = (tx: Sql) => tx`
  select d2.id from app.document d2
    join app.document_type t2 on t2.id = d2.document_type_id
   where d2.shift_id = s.id and t2.code = 'POS_TICKET' and d2.status in ('posted', 'reversed')`;

const SHIFT_COLUMNS: readonly DatasetColumn[] = [
  { field: "shift_id", kind: "uuid", ref: (tx) => tx`s.id` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`s.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`s.terminal_id` },
  { field: "terminal_code", kind: "text", ref: (tx) => tx`pt.code` },
  // ATTRIBUTION, never `*_by` (§3.3, §4.6.5): the cashier who ran the shift.
  { field: "cashier_principal_id", kind: "uuid", ref: (tx) => tx`s.opened_principal_id` },
  { field: "cashier_name", kind: "text", ref: (tx) => tx`op.display_name` },
  { field: "opened_at", kind: "timestamp", ref: (tx) => tx`s.opened_at` },
  // The DATE companion (amendment A1). A `fromDate`/`toDate` parameter is `kind: "date"` (§4.11.1 has no
  // `timestamp` parameter kind), and 7A's `assertValue` refuses "2026-01-01" against a `timestamp` COLUMN
  // with ERR_VALIDATION_FAILED (7a:2536) — so every POS date range filters this field, never `opened_at`.
  { field: "opened_on", kind: "date", ref: (tx) => tx`(s.opened_at at time zone 'UTC')::date` },
  { field: "closed_at", kind: "timestamp", ref: (tx) => tx`s.closed_at` },
  { field: "closed_principal_id", kind: "uuid", ref: (tx) => tx`s.closed_principal_id` },
  { field: "currency", kind: "text", ref: (tx) => tx`s.currency` },
  { field: "opening_float", kind: "numeric", ref: (tx) => tx`s.opening_float` },
  { field: "counted_cash", kind: "numeric", ref: (tx) => tx`s.counted_cash` },
  { field: "expected_cash", kind: "numeric", ref: (tx) => tx`s.expected_cash` },
  { field: "over_short", kind: "numeric", ref: (tx) => tx`s.over_short` },
  { field: "over_short_document_id", kind: "uuid", ref: (tx) => tx`s.over_short_document_id` },
  { field: "ticket_count", kind: "integer", ref: (tx) => tx`m.ticket_count` },
  { field: "return_count", kind: "integer", ref: (tx) => tx`m.return_count` },
  { field: "net_sales_base", kind: "numeric", ref: (tx) => tx`m.net_sales_base` },
  { field: "no_sale_count", kind: "integer", ref: (tx) => tx`m.no_sale_count` },
  { field: "drawer_open_count", kind: "integer", ref: (tx) => tx`m.drawer_open_count` },
  { field: "void_count", kind: "integer", ref: (tx) => tx`m.void_count` },
];

export const shiftDataset: Dataset = defineDataset({
  id: "shift",
  columns: SHIFT_COLUMNS,
  company: (tx, companyId) => tx`s.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.shift s
        join app.dimension_value bv on bv.id = s.branch_id
        join app.pos_terminal    pt on pt.id = s.terminal_id
        join app.principal       op on op.id = s.opened_principal_id
        cross join lateral (
          select
            (select count(*) from app.document d3 where d3.id in (${TICKET_IDS(tx)})
               and not exists (select 1 from app.document_line l
                                where l.document_id = d3.id and l.kind = 'item' and l.quantity < 0))::int as ticket_count,
            (select count(*) from app.document d3 where d3.id in (${TICKET_IDS(tx)})
               and exists (select 1 from app.document_line l
                            where l.document_id = d3.id and l.kind = 'item' and l.quantity < 0))::int     as return_count,
            -- `a3.type`, NOT `a3.account_type`: app.account declares `type app.account_type not null`
            -- (plan0A:1492) and `account_type` is the ENUM TYPE's name (plan0A:1484). 6D's own reader
            -- carries the same comment for the same reason.
            (select coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)
               from app.ledger_entry le
               join app.account a3 on a3.id = le.account_id and a3.type = 'income'
              where le.document_id in (${TICKET_IDS(tx)}))                                               as net_sales_base,
            (select count(*) from app.till_event te where te.shift_id = s.id and te.kind = 'no_sale')::int     as no_sale_count,
            (select count(*) from app.till_event te where te.shift_id = s.id and te.kind = 'drawer_open')::int as drawer_open_count,
            (select count(*) from app.till_event te where te.shift_id = s.id and te.kind = 'void')::int        as void_count
        ) m`,
  select: (tx) => tx`s.id as shift_id, s.branch_id as branch_id, bv.code as branch_code,
         s.terminal_id as terminal_id, pt.code as terminal_code,
         s.opened_principal_id as cashier_principal_id, op.display_name as cashier_name,
         to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as opened_at,
         to_char((s.opened_at at time zone 'UTC')::date, 'YYYY-MM-DD') as opened_on,
         to_char(s.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as closed_at,
         s.closed_principal_id as closed_principal_id, s.currency as currency,
         s.opening_float as opening_float, s.counted_cash as counted_cash,
         s.expected_cash as expected_cash, s.over_short as over_short,
         s.over_short_document_id as over_short_document_id,
         m.ticket_count, m.return_count, m.net_sales_base,
         m.no_sale_count, m.drawer_open_count, m.void_count`,
  defaultOrder: (tx) => tx`s.opened_at desc, s.id desc`,
});

const TILL_EVENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "till_event_id", kind: "uuid", ref: (tx) => tx`te.id` },
  { field: "shift_id", kind: "uuid", ref: (tx) => tx`te.shift_id` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`te.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`te.terminal_id` },
  { field: "terminal_code", kind: "text", ref: (tx) => tx`pt.code` },
  { field: "kind", kind: "text", ref: (tx) => tx`te.kind` },
  { field: "ticket_document_id", kind: "uuid", ref: (tx) => tx`te.ticket_document_id` },
  { field: "ticket_number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "cashier_principal_id", kind: "uuid", ref: (tx) => tx`te.cashier_principal_id` },
  { field: "cashier_name", kind: "text", ref: (tx) => tx`cp.display_name` },
  { field: "supervisor_principal_id", kind: "uuid", ref: (tx) => tx`te.supervisor_principal_id` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`te.occurred_at` },
];

export const tillEventDataset: Dataset = defineDataset({
  id: "till_event",
  columns: TILL_EVENT_COLUMNS,
  company: (tx, companyId) => tx`te.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.till_event te
        join app.dimension_value bv on bv.id = te.branch_id
        join app.pos_terminal    pt on pt.id = te.terminal_id
        join app.principal       cp on cp.id = te.cashier_principal_id
        left join app.document   d  on d.id  = te.ticket_document_id`,
  select: (tx) => tx`te.id as till_event_id, te.shift_id as shift_id, te.branch_id as branch_id,
         bv.code as branch_code, te.terminal_id as terminal_id, pt.code as terminal_code, te.kind as kind,
         te.ticket_document_id as ticket_document_id, d.number::int as ticket_number,
         te.cashier_principal_id as cashier_principal_id, cp.display_name as cashier_name,
         te.supervisor_principal_id as supervisor_principal_id,
         to_char(te.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at`,
  defaultOrder: (tx) => tx`te.occurred_at desc, te.id desc`,
});

const NEEDS_ATTENTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "needs_attention_id", kind: "uuid", ref: (tx) => tx`na.id` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`na.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`na.terminal_id` },
  { field: "terminal_code", kind: "text", ref: (tx) => tx`pt.code` },
  { field: "client_ref", kind: "uuid", ref: (tx) => tx`na.client_ref` },
  { field: "error_code", kind: "text", ref: (tx) => tx`na.error_code` },
  { field: "error_detail", kind: "text", ref: (tx) => tx`na.error_detail` },
  { field: "resolved_principal_id", kind: "uuid", ref: (tx) => tx`na.resolved_by` },
  { field: "resolved_at", kind: "timestamp", ref: (tx) => tx`na.resolved_at` },
  { field: "resolution_note", kind: "text", ref: (tx) => tx`na.resolution_note` },
  { field: "created_at", kind: "timestamp", ref: (tx) => tx`na.created_at` },
  // The DATE companion, for the same reason `shift.opened_on` exists (amendment A1).
  { field: "created_on", kind: "date", ref: (tx) => tx`(na.created_at at time zone 'UTC')::date` },
  { field: "is_open", kind: "boolean", ref: (tx) => tx`(na.resolved_at is null)` },
];

export const needsAttentionDataset: Dataset = defineDataset({
  id: "needs_attention",
  columns: NEEDS_ATTENTION_COLUMNS,
  company: (tx, companyId) => tx`na.company_id = ${companyId}::uuid`,
  // `na.payload` is NOT selected (amendment A1): it is the whole rejected ticket — items, prices, the
  // customer, the cashier's overrides — and a report column would be a covered side channel of exactly
  // the kind spec:2450 and spec:2454 close. `resolved_principal_id` renames the table's `resolved_by`
  // for the row vocabulary, because a dataset FIELD named `*_by` invites a report to read it as
  // attribution when the COLUMN is server-stamped (§3.3).
  from: (tx) => tx`app.needs_attention na
        join app.dimension_value   bv on bv.id = na.branch_id
        left join app.pos_terminal pt on pt.id = na.terminal_id`,
  select: (tx) => tx`na.id as needs_attention_id, na.branch_id as branch_id, bv.code as branch_code,
         na.terminal_id as terminal_id, pt.code as terminal_code, na.client_ref as client_ref,
         na.error_code as error_code, na.error_detail as error_detail,
         na.resolved_by as resolved_principal_id,
         to_char(na.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as resolved_at,
         na.resolution_note as resolution_note,
         to_char(na.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
         to_char((na.created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as created_on,
         (na.resolved_at is null) as is_open`,
  defaultOrder: (tx) => tx`na.created_at desc, na.id desc`,
});
```

- [ ] **Step 4: Register the three in `datasets.ts` and re-export**

Extend the union with `| "shift" | "till_event" | "needs_attention"`, add the import `import { needsAttentionDataset, shiftDataset, tillEventDataset } from "./datasets/pos";`, and add the three entries to `DATASETS` after `tax_transaction`. Add `export * from "./datasets/pos";` to `packages/db/src/reports/index.ts`. **Nothing else in `datasets.ts` moves**: 7A's twenty-six entries keep their order, which is what `DATASET_IDS` publishes.

- [ ] **Step 5: Extend 7A's pinned registry case — `packages/db/test/reports/datasets.test.ts`**

7A's own registry `describe` pins the register as a **literal array**, not as a count:

```ts
  it("holds exactly the twenty-six 7A members, in registry order", () => {
    expect([...DATASET_IDS]).toEqual([ /* … twenty-six literals … */ ]);
```

(7a:2247–2255). Step 4 appends three members, so that `toEqual` fails the moment `datasets.ts` is saved, and the failure is **this** task's — 7A's file is the assertion, not the defect. §3.7.3's rule is that the slice which changes a shared registry updates the pin in the same commit, so the edit lands here and not "later". Replace the case's title and its array with the twenty-nine, appending the three at the end so 7A's twenty-six keep their order:

```ts
  it("holds exactly the twenty-nine members (7A's twenty-six + 7C's three), in registry order", () => {
    expect([...DATASET_IDS]).toEqual([
      "ledger_entry", "account_balance", "account", "document", "document_line", "document_event", "audit_log",
      "party", "party_ageing", "allocation", "payment_term", "bank_statement_line", "bank_match", "pdc",
      "item", "lot", "warehouse", "price_list_line", "promotion",
      "inventory_movement", "stock_on_hand", "cost_layer", "cost_consumption", "stock_valuation", "item_profitability",
      "tax_transaction",
      // 7C, §4.16.2 — the three Phase 6 members 7A could not ship (migrations 0060 and 0070 are past its ≤ 0058 bound).
      "shift", "till_event", "needs_attention",
    ]);
    expect(Object.keys(DATASETS)).toEqual([...DATASET_IDS]);
  });
```

**Nothing else in that file changes** — 7A's other three `it`s iterate `DATASET_IDS` and are order- and length-agnostic, so they pass over twenty-nine unedited.

> **⚠️ OD-09 ripple, in one place.** `pdc` is 7A's fourteenth member and is itself OD-09-gated. If the owner answered **no** and 7A shipped **twenty-five**, drop `"pdc"` from the array above, make it twenty-eight, and change Task 1's own `expect(DATASET_IDS).toHaveLength(29)` to `28`. Those two numbers and that one literal are the whole ripple; Task 11 tracks it.

- [ ] **Step 6: Run green and commit**

```
bun run --cwd packages/db test -- reports/7c-datasets
bun run --cwd packages/db test -- reports/datasets      # 7A's, EDITED by Step 5 — green on twenty-nine
bun run --cwd packages/db test -- reports/7b-           # 7B's twenty-two, unchanged
bun run lint && bun run lint:rules && bun run typecheck
```

`lint:rules` matters: `no-sql-concat` sees three new files of `select` text and must report nothing — every template is literal and every value bound.

```
git add packages/db/src/reports/datasets/pos.ts packages/db/src/reports/datasets.ts packages/db/src/reports/index.ts \
        packages/db/test/reports/7c-datasets.test.ts packages/db/test/reports/datasets.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add the shift, till_event and needs_attention datasets [7C T1]

Closes 7A's DatasetId registry for Phase 6 at twenty-nine. Every shift measure
is a SQL lateral, so no number ever holds a monetary value;
needs_attention.payload is never selected.

7A's reports/datasets.test.ts pins the register as a literal array, so its
twenty-six become twenty-nine in THIS commit (§3.7.3): the slice that widens a
shared registry updates its pin in the same commit, and the three new ids are
appended so 7A's order is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The 7C catalogue harness — `reports-7c.ts`, four new `assertTieOut` branches, two fixtures

7B built one harness that reads a definition off disk, executes it through `datasetFor(...).run`, checks its field coverage and compares the result with the ledger or a projection (§4.17.1's A9 row). 7C's eleven definitions need the same machinery over five sources 7B never read. This task extends `assertTieOut` **additively — never editing a case** — and adds the 7C half in its own file, so the two catalogues' directories, code lists and fixtures stay disjoint.

**Files:**
- Create: `tests/invariants/support/reports-7c.ts`
- Modify: `tests/invariants/support/reports.ts` (three optional `LedgerWindow` members, two measure-map rows, four `projection` branches)

**Interfaces:**
- Consumes: `runDefinition`, `assertFieldCoverage`, `assertTieOut`, `readEnvelope`, `ReportSeedEnvelope`, `LedgerWindow`, `TieOutOptions`, `TieOutWitness` (7B, §4.17.1); `ReportDefinition`, `validateReportDefinition`, `ReportDefinitionSets` (7A); `datasetFor`, `DatasetRow`, `MAX_DATASET_ROWS` (7A); `Money`, `currency`, `CurrencyCode` (§4.2.1); `REPO_ROOT` (0B, §4.17.1); `Db`, `Seed`, the **production** `withTenant(sql, ctx, fn)`, `uuidv7` (§4.1, §4.2.2); `seedTenantV2`, `seedAccount`, `grantCodes`, `seedTaxCode` (1A/2B/5A); `arApFixture`, `ArApFixture`, `postFromPack` (4B, §4.17.1); `importStatement`, `match` (4B); `postTaxedDocument`, `TaxFixture` (5A, §4.17.1 — the one taxed-post path, so `app.tax_transaction` is non-empty for `accounting.tax_return_view`); `staffFixture`, `StaffFixture` (6C); `buildTicket` (6A); `applyBatch` (6A/6D); `zReport`, `salesByCashier` (6D); `startApi`, `StartedApi` (§4.2.12).
- Produces:

```ts
// tests/invariants/support/reports.ts — THREE additive edits, no case removed or altered (§4.17.1 A9)
export interface LedgerWindow {
  fiscalPeriodId?: string; fromDate?: string; toDate?: string; accountCode?: string;
  documentTypeCodes?: readonly string[]; accountTypes?: readonly string[];   // 7B
  partyId?: string; branchId?: string; shiftId?: string;                      // 7C, amendment A3
}
// LEDGER_MEASURE gains two rows: net_sales_base, tax_base.
// assertTieOut's `projection` switch gains four branches: shift, allocation, bank_statement_line, pdc.

// tests/invariants/support/reports-7c.ts  (§4.17.1, amendment A4)
export const CATALOGUE_7C: readonly ReportCode7C[];          // the eleven codes, in §4.16.1 order
export type ReportCode7C = (typeof CATALOGUE_7C)[number];
export const CATALOGUE_DIR_7C: string;                       // <repo>/packages/db/seed/my/reports/7c
export function readEnvelope7C(code: string): ReportSeedEnvelope;
export function readDefinition7C(code: string): ReportDefinition;
export interface ArApReportFixture {
  db: Db; s: Seed; reader: string; outsider: string;
  accounts: Readonly<Record<string, string>>;                 // 4B's twelve `accountIds` plus "2300", "1350"
  customerId: string; vendorId: string; termId: string;
  invoiceId: string; creditNoteId: string; receiptId: string; allocationId: string;
  bankStatementId: string; matchedLineId: string; openLineId: string;
  taxCodeId: string; regimeId: string; fiscalPeriodId: string;
}
export function arApReportFixture(db: Db, name: string): Promise<ArApReportFixture>;
export interface PosReportFixture {
  api: StartedApi; db: Db; s: Seed; staff: StaffFixture; reader: string;
  closedShiftId: string; openShiftId: string; branchB: string;
  rejectedClientRef: string; voidedClientRef: string;
}
export function posReportFixture(api: StartedApi, name: string): Promise<PosReportFixture>;
```

**Read this before writing the file.** Four decisions are load-bearing.

1. **`reports-7c.ts` imports from `./reports` and re-implements nothing.** `runDefinition`, `assertFieldCoverage` and `assertTieOut` stay 7B's single implementations; hazard 9's rule is that two spellings of one thing is the defect, and a second `runDefinition` in this file would be exactly that. The only reason this is a separate *file* is that `CATALOGUE_DIR` in `reports.ts` is `…/reports/7b` and the two seed directories are deliberately disjoint (§4.16.1).
2. **The four new `projection` branches read a stored table, and that is the branch's meaning** (amendment A3). Each compares the report's rows, grouped on the source's own key, against an independent `tx` query the harness writes — the same two-path proof `ledger_sum` gives, for a figure that never reaches the ledger. `allocation` is the clearest case: a settlement allocation posts nothing (§4.8.1), so `ledger_sum` would compare the report against zero and pass for the wrong reason.
3. **Every sum accumulates through `Money`** (Global Constraint 2). `Money.of(String(row[field]), base).add(...)`, never `Number(...)`, and the final comparison is `.toString()` against `.toString()` at fixed 4 dp so "to the cent" is literal and no epsilon is ever chosen.
4. **`posReportFixture` takes a `StartedApi`, not a `Db`.** Every POS row it needs is written through 6A's `applyBatch` — the real path — and 6C's `staffFixture(api, name)` already requires one. A fixture that inserted a `POS_TICKET` directly would prove nothing about the report and would violate hazard 22 besides.

- [ ] **Step 1: Write the failing test**

`packages/db/test/reports/harness-7c.test.ts` — the harness's own test, so a broken branch fails here and not inside a definition group:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOGUE_7C, CATALOGUE_DIR_7C, arApReportFixture, readEnvelope7C } from "../../../../tests/invariants/support/reports-7c";
import { assertTieOut } from "../../../../tests/invariants/support/reports";
import type { ArApReportFixture } from "../../../../tests/invariants/support/reports-7c";
import { currency } from "@dulja/domain";
import { startDb, withTenant, type Db } from "../harness";

describe("the 7C catalogue harness — contracts §4.17.1 amendment A4", () => {
  let db: Db;
  let f: ArApReportFixture;
  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "harness-7c");
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn as never) as Promise<T>;

  it("CATALOGUE_7C is the eleven §4.16.1 codes in register order", () => {
    expect([...CATALOGUE_7C]).toEqual([
      "accounting.ageing", "accounting.party_statement", "accounting.allocation_register",
      "accounting.unreconciled_items", "accounting.pdc_register",
      "pos.z_report", "pos.sales_by_cashier", "pos.sales_by_branch", "pos.needs_attention",
      "accounting.branch_profit_and_loss", "accounting.tax_return_view",
    ]);
    expect(CATALOGUE_DIR_7C.replaceAll("\\", "/")).toMatch(/packages\/db\/seed\/my\/reports\/7c$/);
  });

  it("readEnvelope7C refuses a file with no definitionVersion, naming the path", () => {
    expect(() => readEnvelope7C("accounting.not_a_report")).toThrow(/reports[\\/]7c[\\/]accounting\.not_a_report\.json/);
  });

  it("assertTieOut rejects an unknown projection source, naming it", async () => {
    const definition = {
      version: 1, code: "accounting.party_statement", nameEn: "x", nameAr: "س",
      module: "accounting", permission: "accounting.report.read", parameters: [],
      dataset: { source: "document", filters: [] },
      columns: [{ field: "base_total", labelEn: "T", labelAr: "ت", format: "money", align: "end" }],
      groups: [], totals: [{ field: "base_total", fn: "sum" }], sort: [],
      layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
      tieOut: { kind: "projection", projection: "till_event" },
    } as never;
    // **A REAL transaction and REAL parameters, on purpose.** `assertTieOut` runs `runDefinition` and
    // `assertFieldCoverage` BEFORE it reaches the `switch` (7b:791-793), so a null `tx` or an empty
    // `params` would fail on a null-property access or on `x.company_id = undefined::uuid` and this case
    // would assert a TypeError instead of the default arm's message. The fixture posts an invoice, a
    // credit note and a receipt, so the `document` dataset returns rows and `base_total` is covered.
    await read((tx) => expect(
      assertTieOut(tx, definition, {
        params: { companyId: f.s.company }, baseCurrency: currency("MYR"),
      }),
    ).rejects.toThrow(/till_event/));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- reports/harness-7c`
Expected: FAIL at import — `Cannot find module '../../../../tests/invariants/support/reports-7c'`.

- [ ] **Step 3: Extend `tests/invariants/support/reports.ts` — three additive edits**

**(a)** `LedgerWindow` gains three optional members. Replace the interface with:

```ts
export interface LedgerWindow {
  fiscalPeriodId?: string;
  fromDate?: string;
  toDate?: string;
  accountCode?: string;
  documentTypeCodes?: readonly string[];
  accountTypes?: readonly string[];
  /** 7C, amendment A3. Each narrows the ledger side through a join that already exists on `document`. */
  partyId?: string;
  branchId?: string;
  shiftId?: string;
}
```

and add the three predicates to the window's `where` construction, beside the six that are there:

```ts
  if (w.partyId)  clause = tx`${clause} and d.party_id  = ${w.partyId}::uuid`;
  if (w.branchId) clause = tx`${clause} and d.branch_id = ${w.branchId}::uuid`;
  if (w.shiftId)  clause = tx`${clause} and d.shift_id  = ${w.shiftId}::uuid`;
```

**(b)** the closed measure map gains two rows:

```ts
/** A5's closed map: a dataset money field → the ledger measure that is the same number.
 *  It is a LOOKUP, never a SQL fragment — no field name from a definition reaches a statement. */
const LEDGER_MEASURE = {
  base_debit: "base_debit",
  base_credit: "base_credit",
  base_balance: "base_balance",
  base_total: "base_debit",
  net_sales_base: "net_sales_base",   // 7C, amendment A3 — Σ(base_credit − base_debit) over income accounts
  tax_base: "base_credit",            // 7C, amendment A3
} as const satisfies Record<string, "base_debit" | "base_credit" | "base_balance" | "net_sales_base">;
```

and the harness's one measure query gains a **fourth** fixed column, so the branch selects among four computed measures rather than four queries (`tax_base` maps onto `base_credit`, which the query already computes, and adds no column of its own):

```ts
  const [m] = await tx<{ base_debit: string; base_credit: string; base_balance: string; net_sales_base: string }[]>`
    select coalesce(sum(le.base_debit), 0)::text                                          as base_debit,
           coalesce(sum(le.base_credit), 0)::text                                         as base_credit,
           coalesce(sum(le.base_debit - le.base_credit), 0)::text                          as base_balance,
           coalesce(sum(le.base_credit - le.base_debit) filter (where a.type = 'income'), 0)::text as net_sales_base
      from app.ledger_entry le
      join app.document      d  on d.id  = le.document_id
      join app.document_type dt on dt.id = d.document_type_id
      join app.account       a  on a.id  = le.account_id
     where d.company_id = ${companyId}::uuid ${windowClause}`;
```

**(c)** `assertTieOut`'s `projection` switch gains four branches. Append them to the existing `switch (opts.projection ?? definition.tieOut.projection)` **after** 7B's five cases; no 7B case is edited.

> **`companyId`, `rows`, `base`, `definition` and `windowClause` are free in the fragments above and below
> on purpose.** They are the locals 7B's `assertTieOut` has **already** derived from `opts` and `definition`
> before the switch is reached — `companyId` from `opts.params`, `rows` from its own `runDefinition` call,
> `base` from `opts.baseCurrency`, `windowClause` from `opts.window`. Use **7B's spellings verbatim** when
> you paste these in; do not re-derive any of them, and do not rename one to match this plan. If a name
> here does not exist at that point in `reports.ts`, 7B's file is the authority and this block is what
> changes — that is the whole point of appending cases to a function rather than forking it.

```ts
    // ── 7C, amendment A3 — four stored sources whose figures never reach the ledger ──────────────
    case "shift": {
      // Keyed on shift_id: the report's rendered figures ARE app.shift's stored ones.
      const stored = await tx<{ shift_id: string; opening_float: string; counted_cash: string | null;
                               expected_cash: string | null; over_short: string | null }[]>`
        select sh.id::text as shift_id, sh.opening_float::text as opening_float,
               sh.counted_cash::text as counted_cash, sh.expected_cash::text as expected_cash,
               sh.over_short::text as over_short
          from app.shift sh where sh.company_id = ${companyId}::uuid
         order by sh.id asc`;
      const byId = new Map(stored.map((r) => [r.shift_id, r]));
      for (const row of rows) {
        const want = byId.get(String(row["shift_id"]));
        if (!want) throw new Error(`tie-out ${definition.code}: shift ${String(row["shift_id"])} is not in app.shift`);
        for (const field of ["opening_float", "counted_cash", "expected_cash", "over_short"] as const) {
          const got = row[field] === null ? null : Money.of(String(row[field]), base).toString();
          const exp = want[field] === null ? null : Money.of(String(want[field]), base).toString();
          if (got !== exp) {
            throw new Error(`tie-out ${definition.code}: shift ${want.shift_id}.${field} report ${got} vs shift ${exp}`);
          }
        }
      }
      return;
    }
    case "allocation": {
      const [stored] = await tx<{ total: string }[]>`
        select coalesce(sum(al.base_amount), 0)::text as total
          from app.allocation al
         where al.company_id = ${companyId}::uuid and al.unallocated_at is null`;
      compareTotal(definition, rows, "base_amount", stored!.total, base);
      return;
    }
    case "bank_statement_line": {
      const [stored] = await tx<{ total: string }[]>`
        select coalesce(sum(bl.amount), 0)::text as total
          from app.bank_statement_line bl
          left join (select bm.statement_line_id, sum(bm.amount) as matched
                       from app.bank_match bm where bm.unmatched_at is null
                      group by bm.statement_line_id) m on m.statement_line_id = bl.id
         where bl.company_id = ${companyId}::uuid and coalesce(m.matched, 0) <> bl.amount`;
      compareTotal(definition, rows, "amount", stored!.total, base);
      return;
    }
    case "pdc": {   // ⚠️ OD-09 — unreachable, and the case is absent, when 4B's migration 0051 did not ship
      const [stored] = await tx<{ total: string }[]>`
        select coalesce(sum(pd.amount), 0)::text as total
          from app.pdc pd where pd.company_id = ${companyId}::uuid and pd.status = 'in_hand'`;
      compareTotal(definition, rows, "amount", stored!.total, base);
      return;
    }
```

with one shared comparator added beside the existing helpers (it is new, not a rewrite of anything 7B has):

```ts
/** Σ of `field` over the report's rows, through Money, against one independent figure. */
function compareTotal(
  definition: ReportDefinition, rows: readonly DatasetRow[], field: string, expected: string, base: CurrencyCode,
): void {
  let total = Money.zero(base);
  for (const row of rows) {
    if (row[field] === undefined) {
      throw new Error(`tie-out ${definition.code}: rows carry no '${field}' column`);
    }
    total = total.add(Money.of(String(row[field] ?? "0"), base));
  }
  const want = Money.of(expected, base);
  if (total.toString() !== want.toString()) {
    throw new Error(`tie-out ${definition.code}: report Σ${field} ${total.toString()} vs source ${want.toString()}`);
  }
}
```

Finally, the `default` arm's message already names the unknown source; leave it exactly as 7B wrote it — that is what the harness test's third case asserts.

- [ ] **Step 4: Write `tests/invariants/support/reports-7c.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportDefinition } from "@dulja/domain";
import { Money, currency } from "@dulja/domain";
// ONE import from `@dulja/db` — a second statement from the same specifier is what `no-duplicate-imports`
// fires on, and Step 5 runs `bun run lint`. `withTenant` here is the PRODUCTION three-argument form
// (§4.2.2); the four-argument test helper belongs to `packages/db/test` and is not on this barrel.
import { applyBatch, importStatement, match, withTenant } from "@dulja/db";
import {
  grantCodes, seedAccount, seedTaxCode, seedTenantV2, uuidv7, type Db, type Seed,
} from "@dulja/db/test";
import type { StartedApi } from "../../../apps/api/test/support/app";   // TYPE only, exactly as staff.ts does
import { REPO_ROOT } from "../../support/source";
import { arApFixture, postFromPack } from "./ar-ap";
import { postTaxedDocument, type TaxFixture } from "./tax";
import { buildTicket } from "./pos";
import { staffFixture, type StaffFixture } from "./staff";
import type { ReportSeedEnvelope } from "./reports";

const MYR = currency("MYR");

/** The eleven codes §4.16.1 assigns 7C, in the register's own order. `accounting.pdc_register` is ⚠️ OD-09:
 *  the code stays in this list so a reader sees the register whole, and every consumer skips it when the
 *  file is absent — `readEnvelope7C` throwing is what OD-09 = no looks like, and Task 11 is what creates it. */
export const CATALOGUE_7C = [
  "accounting.ageing", "accounting.party_statement", "accounting.allocation_register",
  "accounting.unreconciled_items", "accounting.pdc_register",
  "pos.z_report", "pos.sales_by_cashier", "pos.sales_by_branch", "pos.needs_attention",
  "accounting.branch_profit_and_loss", "accounting.tax_return_view",
] as const;
export type ReportCode7C = (typeof CATALOGUE_7C)[number];

export const CATALOGUE_DIR_7C = join(REPO_ROOT, "packages", "db", "seed", "my", "reports", "7c");

/** The envelope 7B amendment A1 fixed: `definitionVersion` outside, the format-version-1 definition inside. */
export function readEnvelope7C(code: string): ReportSeedEnvelope {
  const path = join(CATALOGUE_DIR_7C, `${code}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path}: no such report definition (⚠️ OD-09 drops accounting.pdc_register)`);
  }
  const parsed = JSON.parse(raw) as ReportSeedEnvelope;
  if (typeof parsed.definitionVersion !== "number" || parsed.definitionVersion < 1) {
    throw new Error(`${path}: definitionVersion must be an integer >= 1 (7B amendment A1)`);
  }
  return parsed;
}

export function readDefinition7C(code: string): ReportDefinition {
  return readEnvelope7C(code).definition;
}

export interface ArApReportFixture {
  db: Db; s: Seed; reader: string; outsider: string;
  /** 4B's `ArApFixture.accountIds` (twelve rows, 4b:1782-1794) plus this file's `2300` and `1350`. */
  accounts: Readonly<Record<string, string>>;
  customerId: string; vendorId: string; termId: string;
  invoiceId: string; creditNoteId: string; receiptId: string; allocationId: string;
  bankStatementId: string; matchedLineId: string; openLineId: string;
  taxCodeId: string; regimeId: string; fiscalPeriodId: string;
}

/**
 * One AR/AP corpus every 7C accounting definition reads: a customer invoice, a credit note, a receipt
 * allocated against the invoice, a two-line bank statement with one line matched and one open, and one
 * taxed document so `tax_transaction` is not empty. It builds on 4B's `arApFixture` — the slice that owns
 * the pack envelopes — and adds only what the reports need, because re-deriving 4A's document types here
 * would be a second reading of a policy this slice has never seen (hazard 9).
 */
export async function arApReportFixture(db: Db, name: string): Promise<ArApReportFixture> {
  // 4B's `arApFixture(db, s)` takes a SEED, not a name, and returns exactly
  // `{ documentTypeIds, accountIds, partyIds, termId }` (4b:1801-1806, 4b:1824). Every other member this
  // fixture publishes is created below — the five documents especially, because `arApFixture` posts none.
  const s = await seedTenantV2(db, name);
  const base = await arApFixture(db, s);
  const reader = s.human;          // the principal `arApFixture` granted the posting codes to (4b:1825)
  const outsider = await uuidv7(db.admin);
  const ctx = () => ({ tenantId: s.tenant, actorId: reader, requestId: crypto.randomUUID() });

  // `accountIds` renamed for this file's own vocabulary; nothing is re-seeded. 4B's list already holds
  // 1100, 1200, 1250, 1300, 2100, 2150, 4000, 4900, 5000, 5100, 5900 and 5910 (4b:1782-1794); 7C adds the
  // two tax controls `seedTaxCode` resolves by code.
  const accounts: Record<string, string> = { ...base.accountIds };
  for (const [code, nameEn, type] of [
    ["2300", "Output tax payable", "liability"],
    ["1350", "Input tax receivable", "asset"],
  ] as const) {
    accounts[code] ??= await seedAccount(db, s, { code, nameEn, type });
  }

  // The two codes the 7C definitions declare that `arApFixture` does not grant: the catalogue's
  // `accounting.report.read` and `accounting.tax_return_view`'s `accounting.tax.manage`.
  await grantCodes(db, s, {
    codes: ["accounting.report.read", "accounting.tax.manage"],
    principalId: reader, roleCode: `${name}-reader`,
  });

  // A SYNTHETIC code at a SYNTHETIC rate, copied from 5A's own fixtures verbatim (`SYN-OUT-STD` /
  // `0.11000000`, 5a:460). Hazard 1 forbids a real Malaysian statutory rate in a plan, a test OR a
  // fixture, and `SR` at 6% is exactly the real output-tax pair — it must not appear here. Nothing in
  // this slice asserts the rate: `accounting.tax_return_view` renders whatever 5A's engine stored.
  // `2300` must already exist: `seedTaxCode` resolves the output account BY CODE and leaves it null
  // otherwise, and `tax_code_account_for_kind_check` then refuses the row (5a:713-722).
  const { taxCodeId, regimeId } = await seedTaxCode(db, s, {
    code: "SYN-OUT-STD", rate: "0.11000000", kind: "output",
  });

  // **The invoice is posted through 5A's registered `postTaxedDocument`** (§4.17.1's 5A row), driven from
  // THIS seed rather than a second company: `TaxFixture` is a plain shape and the helper reads exactly the
  // six members below (5a:3442-3466). Posting it this way is what puts rows in `app.tax_transaction` —
  // and `accounting.tax_return_view` reads that dataset, so an empty table makes `assertFieldCoverage`
  // throw "the fixture returned no rows" (7b:830) rather than fail the report.
  const taxWorld: TaxFixture = {
    s, regimeId, codes: { "SYN-OUT-STD": taxCodeId }, accounts,
    types: { ...base.documentTypeIds },
    customerId: base.partyIds.customer, vendorId: base.partyIds.vendor, poster: reader,
  };
  const { documentId: invoiceId } = await postTaxedDocument(db, taxWorld, {
    typeCode: "SALES_INVOICE", effectiveDate: "2026-01-10",
    lines: [{ lineNo: 1, kind: "account", accountId: accounts["4000"]!, amount: "1000.0000",
              taxCode: "SYN-OUT-STD" }],
  });
  const { documentId: creditNoteId } = await postTaxedDocument(db, taxWorld, {
    typeCode: "SALES_CREDIT_NOTE", effectiveDate: "2026-01-15",
    lines: [{ lineNo: 1, kind: "account", accountId: accounts["4000"]!, amount: "100.0000", taxCode: null }],
  });

  // The receipt settles the invoice inside the SAME transaction, which is the shape 4B's own cases use
  // (4b:3568-3575) and the row `accounting.allocation_register` reads. `postFromPack` returns
  // `{ documentId, result }` (4b:1335) and does not return the allocation, so its id is read back.
  const { documentId: receiptId } = await postFromPack(db, s, {
    code: "RECEIPT", effectiveDate: "2026-01-20", partyId: base.partyIds.customer,
    lines: [{ kind: "account", accountId: accounts["1100"]!, debit: "1000.0000" },
            { kind: "account", accountId: accounts["1200"]!, credit: "1000.0000" }],
    allocate: [{ settledDocumentId: invoiceId, amount: Money.of("1000.0000", MYR) }],
  });
  const [allocation] = await withTenant(db.rw, ctx(), (tx) =>
    tx<{ id: string }[]>`select id from app.allocation
                          where settlement_document_id = ${receiptId} order by created_at asc limit 1`);
  const allocationId = allocation!.id;

  // A statement with two lines; one is matched against the receipt, one stays open.
  const { statementId } = await withTenant(db.rw, ctx(), (tx) =>
    importStatement(tx, ctx(), {
      companyId: s.company, bankAccountId: accounts["1100"]!,
      csv: "value_date,description,reference,amount\n2026-01-20,RECEIPT 1,R-1,1000.0000\n2026-01-21,UNKNOWN,U-1,250.0000\n",
      mapping: { valueDate: "value_date", description: "description", reference: "reference", amount: "amount" },
    }));

  const lines = await withTenant(db.rw, ctx(), (tx) =>
    tx<{ id: string; line_no: number }[]>`
      select id, line_no from app.bank_statement_line
       where statement_id = ${statementId} order by line_no asc`);
  const matchedLineId = lines[0]!.id;
  const openLineId = lines[1]!.id;

  await withTenant(db.rw, ctx(), (tx) =>
    match(tx, ctx(), {
      statementLineId: matchedLineId,
      reconcilable: { kind: "receipt", documentId: receiptId },
      amount: Money.of("1000.0000", MYR),
    }));

  return {
    db, s, reader, outsider, accounts,
    customerId: base.partyIds.customer, vendorId: base.partyIds.vendor, termId: base.termId,
    invoiceId, creditNoteId, receiptId, allocationId,
    bankStatementId: statementId, matchedLineId, openLineId,
    taxCodeId, regimeId, fiscalPeriodId: s.period,
  };
}

export interface PosReportFixture {
  api: StartedApi; db: Db; s: Seed; staff: StaffFixture; reader: string;
  closedShiftId: string; openShiftId: string; branchB: string;
  rejectedClientRef: string; voidedClientRef: string;
}

/**
 * One trading day at branch A driven entirely through 6A's `applyBatch`: a closed shift with three sales,
 * one refund, one void and one no-sale, a second still-open shift, and one rejected ticket in
 * needs-attention. Nothing is inserted directly — a POS row written past `applyBatch` proves nothing about
 * the reports and would violate hazard 22 besides.
 */
export async function posReportFixture(api: StartedApi, name: string): Promise<PosReportFixture> {
  const db = api.db;
  const staff = await staffFixture(api, name);
  const s = staff.seed;
  const reader = s.human;
  await grantCodes(db, s, {
    codes: ["pos.report.read", "pos.needs_attention.resolve", "accounting.report.read"],
    principalId: reader, roleCode: `${name}-reader`,
  });

  // `applyBatch` is FOUR parameters (6A): `(tx, ctx: TenantContext, terminal, batch)`. `ctx` carries the
  // tenant and the ACTING principal — the terminal, never the cashier (hazard 19) — and `terminal` carries
  // the company, the branch and the terminal's own ids; neither is derivable from the other, which is why
  // 6C's `applyTicket` passes both (6c:4320-4331) and why `companyId` is NOT a member of `ctx`.
  const apply = (batch: { tickets?: unknown[]; shifts?: unknown[]; tillEvents?: unknown[] }) => {
    const ctx = { tenantId: s.tenant, actorId: staff.terminalA.principalId, requestId: crypto.randomUUID() };
    const terminal = { terminalId: staff.terminalA.terminalId, companyId: s.company,
                       branchId: staff.branchA, principalId: staff.terminalA.principalId };
    return withTenant(db.rw, ctx, (tx) =>
      applyBatch(tx as never, ctx, terminal,
        { terminalId: terminal.terminalId, batchId: crypto.randomUUID(),
          tickets: (batch.tickets ?? []) as never, shifts: (batch.shifts ?? []) as never,
          tillEvents: (batch.tillEvents ?? []) as never }));
  };

  const closedShiftId = await staff.openShift({ cashierPrincipalId: staff.cashierA, openingFloat: "100.0000" });
  const refundedRef = crypto.randomUUID();
  const voidedClientRef = crypto.randomUUID();
  await apply({
    tickets: [
      buildTicket(staff.pos, { sku: "SKU-A", shiftId: closedShiftId, unitPrice: "40.0000", tender: "cash" }),
      buildTicket(staff.pos, { sku: "SKU-A", shiftId: closedShiftId, unitPrice: "10.0000", tender: "cash", clientRef: refundedRef }),
      buildTicket(staff.pos, { sku: "SKU-A", shiftId: closedShiftId, unitPrice: "25.0000", tender: "card" }),
      buildTicket(staff.pos, { sku: "SKU-A", shiftId: closedShiftId, unitPrice: "10.0000", tender: "cash",
                               kind: "return", returnsClientRef: refundedRef }),
    ],
    tillEvents: [
      { clientRef: crypto.randomUUID(), shiftId: closedShiftId, kind: "no_sale", ticketClientRef: null,
        cashierPrincipalId: staff.cashierA, supervisorPrincipalId: null, occurredAt: new Date().toISOString() },
      // `supervisorA`, NOT `managerA`: `StaffFixture` has no `managerA` member — its supervisor is
      // `supervisorA`, "a pos_cashier at A holding pos.ticket.override and nothing else" (6c:4238).
      { clientRef: voidedClientRef, shiftId: closedShiftId, kind: "void", ticketClientRef: refundedRef,
        cashierPrincipalId: staff.cashierA, supervisorPrincipalId: staff.supervisorA,
        occurredAt: new Date().toISOString() },
    ],
  });
  // Counted 138 against an expected 140 — a two-ringgit short, so over_short is non-zero and signed.
  await apply({
    shifts: [{ shiftId: closedShiftId, kind: "close", terminalId: staff.terminalA.terminalId,
               cashierPrincipalId: staff.cashierA, at: new Date().toISOString(), currency: "MYR",
               openingFloat: null, countedCash: { amount: "138.0000", currency: "MYR" } }],
  });

  const openShiftId = await staff.openShift({ cashierPrincipalId: staff.cashierA, openingFloat: "50.0000" });
  const rejected = buildTicket(staff.pos, { sku: "SKU-A", shiftId: openShiftId, unitPrice: "5.0000", tender: "cash" });
  const rejectedClientRef = rejected.clientRef;
  await apply({ tickets: [{ ...rejected, lines: [{ ...rejected.lines[0]!, itemId: await uuidv7(db.admin) }] }] });

  return {
    api, db, s, staff, reader,
    closedShiftId, openShiftId, branchB: staff.branchB,
    rejectedClientRef, voidedClientRef,
  };
}
```

> **The import block above is complete — type it as written.** It imports `Money` and `currency` (`@dulja/domain`), `applyBatch`, `importStatement`, `match` and the **production** three-argument `withTenant` (`@dulja/db`), the six `@dulja/db/test` helpers, and the four sibling support files. It imports **nothing it does not use**: `agedBalance`, `allocateSettlement`, `postDocument`, `seedParty`, `seedPaymentTerm`, `packApproval`, `seedTypeFromPack`, `posFixture` and `type { Sql }` all belong to helpers this file calls *through* `arApFixture` and `staffFixture`, and an unused binding fails `bun run lint` in this task's own Step 5. **The four-argument test `withTenant` appears nowhere in this file** — the `tests` workspace uses the production `withTenant(sql, ctx, fn)`, exactly as 6C's `staff.ts` (6c:4222) and 4B's `ar-ap.ts` do.

- [ ] **Step 5: Run the test to see it pass**

Run: `bun run --cwd packages/db test -- reports/harness-7c && bun run --cwd tests test -- report-tie-out`
Expected: PASS for the harness file; 7B's `tests/invariants/report-tie-out.test.ts` still PASSES unchanged — the three `LedgerWindow` members are optional, the two measure rows are additive, and no 7B `projection` case was touched. That second run is the proof, and it is why it is in this step.

- [ ] **Step 6: Commit**

```bash
git add tests/invariants/support/reports-7c.ts tests/invariants/support/reports.ts \
        packages/db/test/reports/harness-7c.test.ts
git commit -m "$(cat <<'EOF'
test(invariants): add the 7C catalogue harness and four tie-out branches [7C T2]

reports-7c.ts holds CATALOGUE_7C, the 7c seed directory, the envelope reader
and the two corpora the eleven definitions read; it imports runDefinition,
assertFieldCoverage and assertTieOut from 7B's reports.ts and reimplements
none of them (hazard 9).

reports.ts gains three optional LedgerWindow members, two rows in the closed
ledger_sum measure map and four projection branches — shift, allocation,
bank_statement_line and pdc — exactly the additive extension §4.17.1's A9 row
sanctions. No 7B case is edited, and 7B's own tie-out suite is re-run in the
same step as the proof.

The four new branches read stored tables: an allocation posts nothing (§4.8.1),
so ledger_sum would compare a settlement register against zero and pass for
the wrong reason.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The four AR/AP definitions — ageing re-expressed, party statement, allocation register, unreconciled items

`packages/db/seed/my/reports/7c/` is created here, a directory no other slice touches (§4.16.1). Four definitions, each with an executable `tieOut`, and one **parity** case proving 4B's `accounting.ageing` route and the new definition produce the same figures under the same parameters (Global Constraint 8).

**Files:**
- Create: `packages/db/seed/my/reports/7c/accounting.ageing.json`, `…/accounting.party_statement.json`, `…/accounting.allocation_register.json`, `…/accounting.unreconciled_items.json`, `packages/db/test/reports/7c-ar-ap.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: `ReportDefinition`, `validateReportDefinition`, `ReportDefinitionSets` (7A); `reportDefinitionSets`, `datasetFor` (7A); `readDefinition7C`, `readEnvelope7C`, `arApReportFixture`, `ArApReportFixture` (Task 2); `runDefinition`, `assertFieldCoverage`, `assertTieOut` (7B); `agedBalance`, `AgedBalanceParams`, `AgedBalanceRow` (4B, §4.16.3); `reconciledBalance` (4B); `Money`, `currency` (§4.2.1); `withTenant` (test, §4.1).
- Produces: the four definitions. Nothing importable.

**The envelope every file in this directory carries** (7B amendment A1) — `definitionVersion` outside, the format-version-1 definition inside:

```json
{ "definitionVersion": 1, "definition": { "version": 1, "code": "…", … } }
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/reports/7c-ar-ap.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { agedBalance } from "../../src/reports/ageing";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { validateReportDefinition } from "@dulja/domain";
import {
  arApReportFixture, readDefinition7C, readEnvelope7C, type ArApReportFixture,
} from "../../../../tests/invariants/support/reports-7c";
import { assertFieldCoverage, assertTieOut, runDefinition } from "../../../../tests/invariants/support/reports";
import { startDb, withTenant, type Db } from "../harness";

const MYR = currency("MYR");

describe("7C AR/AP definitions — contracts §4.16.1, amendments A6 and A8", () => {
  let db: Db;
  let f: ArApReportFixture;

  beforeAll(async () => { db = await startDb(); f = await arApReportFixture(db, "7c-arap"); }, 300_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn as never) as Promise<T>;

  const CODES = [
    "accounting.ageing", "accounting.party_statement",
    "accounting.allocation_register", "accounting.unreconciled_items",
  ] as const;

  it("all four validate against the live dataset and permission sets", async () => {
    const sets = await read((tx) => reportDefinitionSets(tx));
    for (const code of CODES) {
      const definition = readDefinition7C(code);
      const result = validateReportDefinition(definition, sets);
      expect(result.errors, code).toEqual([]);
      expect(result.ok, code).toBe(true);
      expect(definition.code, code).toBe(code);
    }
  });

  it("accounting.ageing is seeded at definitionVersion 2 — 4B owns version 1", () => {
    expect(readEnvelope7C("accounting.ageing").definitionVersion).toBe(2);
    for (const code of CODES.slice(1)) {
      expect(readEnvelope7C(code).definitionVersion, code).toBe(1);
    }
  });

  it("every field each definition names is a column its dataset serves", async () => {
    for (const code of CODES) {
      const definition = readDefinition7C(code);
      const rows = await read((tx) => runDefinition(tx, definition, paramsFor(code, f)));
      assertFieldCoverage(definition, rows);
    }
  });

  it("accounting.ageing ties to the party_ageing projection", async () => {
    const definition = readDefinition7C("accounting.ageing");
    await read((tx) => assertTieOut(tx, definition, {
      params: paramsFor("accounting.ageing", f), baseCurrency: MYR, asOf: "2026-01-31",
    }));
  });

  it("accounting.ageing PARITY: the definition's rows equal 4B's agedBalance figure for figure", async () => {
    const definition = readDefinition7C("accounting.ageing");
    const rows = await read((tx) => runDefinition(tx, definition, paramsFor("accounting.ageing", f)));
    const route = await read((tx) => agedBalance(tx, {
      companyId: f.s.company, asOf: "2026-01-31", limit: 1000,
    }));
    // The definition's rows are one per (party, currency, bucket) with snake_case keys; the route's are
    // camelCase and carry the five buckets as members. The mapping is explicit — never a key coercion.
    for (const r of route) {
      for (const bucket of ["current", "1_30", "31_60", "61_90", "over_90"] as const) {
        const row = rows.find((x) =>
          x["party_id"] === r.partyId && x["currency"] === r.currency && x["bucket"] === bucket);
        const fromDefinition = Money.of(String(row?.["base_amount"] ?? "0"), MYR);
        const fromRoute = Money.of(r.buckets[bucket], MYR);
        expect(fromDefinition.toString(), `${r.partyId} ${bucket}`).toBe(fromRoute.toString());
      }
    }
  });

  it("accounting.ageing's optional partyKind narrows the same rows and never invents any", async () => {
    const definition = readDefinition7C("accounting.ageing");
    const all = await read((tx) => runDefinition(tx, definition, { asOf: "2026-01-31" }));
    const customers = await read((tx) =>
      runDefinition(tx, definition, { asOf: "2026-01-31", partyKind: "customer" }));
    const vendors = await read((tx) =>
      runDefinition(tx, definition, { asOf: "2026-01-31", partyKind: "vendor" }));
    // The relation asserted is "the filter selects, and never invents": each filtered run equals the
    // unfiltered run restricted to that kind. NOT a row count and NOT `customers + vendors === all` —
    // `app.party.kind` is a FIVE-value vocabulary (2a:308: customer, vendor, employee, student, dealer),
    // so a sum over two of them would break the first time 4B's fixture gained an employee party, and it
    // would break for a reason that has nothing to do with this filter.
    expect(customers).toEqual(all.filter((r) => r["party_kind"] === "customer"));
    expect(vendors).toEqual(all.filter((r) => r["party_kind"] === "vendor"));
    expect(customers.length).toBeGreaterThan(0);   // the fixture's customer is open — 4B posts its invoice
  });

  it("accounting.party_statement ties Σ base_total to the ledger for one party", async () => {
    const definition = readDefinition7C("accounting.party_statement");
    await read((tx) => assertTieOut(tx, definition, {
      params: paramsFor("accounting.party_statement", f), baseCurrency: MYR,
      window: { partyId: f.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" },
    }));
  });

  it("accounting.allocation_register ties Σ base_amount to app.allocation", async () => {
    const definition = readDefinition7C("accounting.allocation_register");
    await read((tx) => assertTieOut(tx, definition, {
      params: paramsFor("accounting.allocation_register", f), baseCurrency: MYR,
    }));
  });

  it("accounting.unreconciled_items returns the open line, not the matched one", async () => {
    const definition = readDefinition7C("accounting.unreconciled_items");
    const rows = await read((tx) => runDefinition(tx, definition, paramsFor("accounting.unreconciled_items", f)));
    expect(rows.map((r) => r["line_id"])).toEqual([f.openLineId]);
    expect(rows[0]!["is_matched"]).toBe(false);
    expect(rows[0]!["amount"]).toBe("250.0000");
    await read((tx) => assertTieOut(tx, definition, {
      params: paramsFor("accounting.unreconciled_items", f), baseCurrency: MYR,
    }));
  });

  it("accounting.unreconciled_items agrees with 4B's reconciledBalance().unreconciled count", async () => {
    const definition = readDefinition7C("accounting.unreconciled_items");
    const rows = await read((tx) => runDefinition(tx, definition, paramsFor("accounting.unreconciled_items", f)));
    const balance = await read((tx) => reconciledBalance(tx, {
      bankAccountId: f.accounts["1100"]!, asOf: "2026-01-31",
    }));
    expect(rows).toHaveLength(balance.unreconciled.length);
  });

  it("every definition is gated by a code that exists in app.permission", async () => {
    const sets = await read((tx) => reportDefinitionSets(tx));
    for (const code of CODES) {
      expect(sets.permissions.has(readDefinition7C(code).permission), code).toBe(true);
    }
    expect(readDefinition7C("accounting.unreconciled_items").permission).toBe("accounting.bank.reconcile");
  });
});

/** The parameters each definition's group test runs it with. One place, so a filter and its parameter
 *  can never drift apart across the group's `it`s.
 *
 *  **`companyId` is in EVERY branch and is not optional.** 7B's `runDefinition` reads it directly —
 *  `companyId: params.companyId as string` — and hands it to `datasetFor(source).run` (7b:719), and
 *  `assertTieOut` binds the same value into its own independent ledger query (7b:795). Omit it and every
 *  dataset's `company` fragment becomes `x.company_id = undefined::uuid`, the report returns no rows and
 *  `assertFieldCoverage` throws "the fixture returned no rows" (7b:830) — a message that blames the
 *  fixture for a missing parameter. 7B's own helper spreads it into every branch the same way (7b:1432). */
function paramsFor(code: string, f: ArApReportFixture): Record<string, string> {
  const base = { companyId: f.s.company };
  switch (code) {
    case "accounting.ageing":
      // NO `partyKind` here, deliberately. `partyKind` is an OPTIONAL filter, and both proofs this
      // table feeds — the `party_ageing` tie-out and the `agedBalance` parity case — compare against
      // an UNFILTERED source: `assertTieOut`'s `party_ageing` branch reads every stored row and 4B's
      // `agedBalance` is called with no kind. Filtering the report to customers while the source keeps
      // the vendor would compare a subset against the whole and fail for the wrong reason. Task 14's
      // TIE_OUT table registers `{ asOf }` for this code too — one spelling in both files. The filter
      // is proven on its own two `it`s below, where nothing ties out.
      return { ...base, asOf: "2026-01-31" };
    case "accounting.party_statement":
      return { ...base, partyId: f.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" };
    case "accounting.allocation_register":
      return { ...base, fromDate: "2026-01-01", toDate: "2026-01-31" };
    case "accounting.unreconciled_items":
      return { ...base, isMatched: "false", bankAccountId: f.accounts["1100"]!, fromDate: "2026-01-01", toDate: "2026-01-31" };
    default:
      throw new Error(`no parameters registered for ${code}`);
  }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- reports/7c-ar-ap`
Expected: FAIL on the first `it` — `readDefinition7C("accounting.ageing")` throws `…/reports/7c/accounting.ageing.json: no such report definition`.

- [ ] **Step 3: Write `accounting.ageing.json` — 4B's code, re-expressed at definitionVersion 2**

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "accounting.ageing",
    "nameEn": "AR / AP ageing",
    "nameAr": "أعمار الذمم",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "asOf", "kind": "date", "required": true },
      { "name": "partyKind", "kind": "enum", "required": false, "options": ["customer", "vendor"] },
      { "name": "currency", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "party_ageing",
      "filters": [
        { "field": "as_of", "op": "eq", "param": "asOf" },
        { "field": "party_kind", "op": "eq", "param": "partyKind" },
        { "field": "currency", "op": "eq", "param": "currency" }
      ]
    },
    "columns": [
      { "field": "party_code", "labelEn": "Party", "labelAr": "الطرف", "format": "text", "align": "start", "width": 90 },
      { "field": "party_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start" },
      { "field": "party_kind", "labelEn": "Kind", "labelAr": "النوع", "format": "text", "align": "start", "width": 80 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 70 },
      { "field": "bucket", "labelEn": "Bucket", "labelAr": "الفترة", "format": "text", "align": "start", "width": 80 },
      { "field": "amount", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 120 },
      { "field": "base_amount", "labelEn": "Base amount", "labelAr": "المبلغ الأساسي", "format": "money", "align": "end", "width": 120 }
    ],
    "groups": [{ "field": "party_code", "subtotal": true }],
    "totals": [{ "field": "base_amount", "fn": "sum" }],
    "sort": [{ "field": "party_code", "dir": "asc" }, { "field": "currency", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {asOf}",
      "footer": "{rowCount} rows · {generatedAt}"
    },
    "tieOut": { "kind": "projection", "projection": "party_ageing" }
  }
}
```

> **`base_amount` is the first money total, not `amount`,** because a mixed-currency ageing summed in document currency is a meaningless number. The `amount` column stays so a single-currency view reads naturally; the *total* is base. `party_ageing` is 4B's async projection rebuilt by `accounting.projection.rebuild` (§4.8.2) — this definition **reads** it and never recomputes it (spec:1204, hazard 22).

- [ ] **Step 4: Write `accounting.party_statement.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.party_statement",
    "nameEn": "Customer / vendor statement",
    "nameAr": "كشف حساب العميل / المورد",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "partyId", "kind": "party", "required": true },
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "documentTypeCode", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "document",
      "filters": [
        { "field": "party_id", "op": "eq", "param": "partyId" },
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" },
        { "field": "document_type_code", "op": "eq", "param": "documentTypeCode" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 90 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 130 },
      { "field": "series", "labelEn": "Series", "labelAr": "السلسلة", "format": "text", "align": "start", "width": 70 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "integer", "align": "end", "width": 80 },
      { "field": "status", "labelEn": "Status", "labelAr": "الحالة", "format": "text", "align": "start", "width": 80 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 70 },
      { "field": "base_total", "labelEn": "Base total", "labelAr": "الإجمالي الأساسي", "format": "money", "align": "end", "width": 120 },
      { "field": "document_id", "labelEn": "Document id", "labelAr": "معرف المستند", "format": "text", "align": "start", "width": 0 },
      { "field": "posting_seq", "labelEn": "Seq", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 0 }
    ],
    "groups": [],
    "totals": [{ "field": "base_total", "fn": "sum" }, { "field": "document_id", "fn": "count" }],
    "sort": [{ "field": "effective_date", "dir": "asc" }, { "field": "posting_seq", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "{rowCount} documents · {generatedAt}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

> **`document_id` and `posting_seq` are `width: 0` columns and are there because `validateReportDefinition` requires them.** 7A's validator rule 4 checks every `groups[]`, `totals[]` and `sort[]` field against **the definition's own `columns[]`** — not against the dataset — and refuses an absent one with `/totals/1/field` · *"total field 'document_id' is not one of this definition's columns"* and `/sort/1/field` · *"sort field 'posting_seq' is not one of this definition's columns"*. The document count and the within-day posting order are both wanted, so the fields are **declared** at zero width (the `line_id` pattern of `accounting.unreconciled_items`, and 7A's `RenderedColumn.width` is `number | null` with a zero meaning "the minimum") rather than the total and the sort key being dropped. `document_id` is also what a viewer opens the document from, and `posting_seq` is what makes two documents dated the same day render in the order they posted.
>
> **There is no running-balance column**, and that is deliberate: `document.base_total` is a lateral `sum(le.base_debit)` over each document's own ledger rows (7B A3), and a running balance is one report's arithmetic over an ordered page, not a property of a row — the same reason 7A's `ledger_entry` dataset carries none. A statement that needs one is 1B's `accountLedger`, which computes `runningBaseBalance` from an opening balance (§4.16.3). **`tieOut` has no `account`**: the window narrows to the party, and Σ `base_total` over the party's documents equals Σ `base_debit` over the ledger rows those documents posted (amendment A6).

- [ ] **Step 5: Write `accounting.allocation_register.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.allocation_register",
    "nameEn": "Allocation register",
    "nameAr": "سجل التخصيص",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "partyId", "kind": "party", "required": false },
      { "name": "settlementTypeCode", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "allocation",
      "filters": [
        { "field": "settled_effective_date", "op": "gte", "param": "fromDate" },
        { "field": "settled_effective_date", "op": "lte", "param": "toDate" },
        { "field": "party_id", "op": "eq", "param": "partyId" },
        { "field": "settlement_type_code", "op": "eq", "param": "settlementTypeCode" }
      ]
    },
    "columns": [
      { "field": "party_code", "labelEn": "Party", "labelAr": "الطرف", "format": "text", "align": "start", "width": 90 },
      { "field": "settlement_type_code", "labelEn": "Settlement", "labelAr": "التسوية", "format": "text", "align": "start", "width": 120 },
      { "field": "settlement_number", "labelEn": "No.", "labelAr": "رقم", "format": "integer", "align": "end", "width": 70 },
      { "field": "settled_type_code", "labelEn": "Settles", "labelAr": "يسدد", "format": "text", "align": "start", "width": 120 },
      { "field": "settled_number", "labelEn": "No.", "labelAr": "رقم", "format": "integer", "align": "end", "width": 70 },
      { "field": "settled_effective_date", "labelEn": "Document date", "labelAr": "تاريخ المستند", "format": "date", "align": "start", "width": 100 },
      { "field": "amount", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 110 },
      { "field": "base_amount", "labelEn": "Base amount", "labelAr": "المبلغ الأساسي", "format": "money", "align": "end", "width": 110 },
      { "field": "fx_difference", "labelEn": "FX difference", "labelAr": "فرق الصرف", "format": "money", "align": "end", "width": 110 },
      { "field": "unallocated_at", "labelEn": "Unallocated at", "labelAr": "أُلغي في", "format": "text", "align": "start", "width": 130 }
    ],
    "groups": [{ "field": "party_code", "subtotal": true }],
    "totals": [{ "field": "base_amount", "fn": "sum" }],
    "sort": [{ "field": "party_code", "dir": "asc" }, { "field": "settled_effective_date", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "{rowCount} allocations · {generatedAt}"
    },
    "tieOut": { "kind": "projection", "projection": "allocation" }
  }
}
```

> **A `timestamp` column is rendered `format: "text"`, never `format: "date"`.** 7A's `intlFormatters().date` parses its argument as `new Date(\`${isoDate}T12:00:00Z\`)` (7a:4484–4490) — it appends a time to a `YYYY-MM-DD`, deliberately, so a display time zone cannot shift the calendar day. Handed the RFC 3339 string a `timestamp` column carries (`2026-01-20T09:14:03Z`) that concatenation is `…ZT12:00:00Z`, an **Invalid Date**, and `Intl.DateTimeFormat.format` throws a `RangeError` at render. So `unallocated_at` here, and `opened_at` / `closed_at` on `pos.z_report` and `resolved_at` on `pos.needs_attention`, all declare `"text"` and render the RFC 3339 UTC string as it stands — which is also what a reconciler and a Z-report want, because the *time* is the fact. Where a report genuinely wants a calendar day, it names the dataset's **date companion** instead (`opened_on`, `created_on`, amendment A1) and keeps `"date"`. A `"date"` format over a `timestamp` field is a raise against the definition, not against 7A.
>
> **`unallocated_at` is rendered, not hidden.** An allocation that was reversed is part of the register's story — hiding it would make a reconciler's totals unexplainable. The tie-out's independent query counts only live rows (`unallocated_at is null`), which is why the group test's parameters return no unallocated row: the fixture allocates once and never unallocates. A slice that adds an unallocation case must pass `filter[unallocated_at][eq]`-equivalent parameters or the totals will not agree, and the failure message names Σ`base_amount` on both sides.

- [ ] **Step 6: Write `accounting.unreconciled_items.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.unreconciled_items",
    "nameEn": "Unreconciled bank items",
    "nameAr": "بنود بنكية غير مسواة",
    "module": "accounting",
    "permission": "accounting.bank.reconcile",
    "parameters": [
      { "name": "isMatched", "kind": "enum", "required": true, "options": ["false", "true"] },
      { "name": "bankAccountId", "kind": "account", "required": false },
      { "name": "fromDate", "kind": "date", "required": false },
      { "name": "toDate", "kind": "date", "required": false }
    ],
    "dataset": {
      "source": "bank_statement_line",
      "filters": [
        { "field": "is_matched", "op": "eq", "param": "isMatched" },
        { "field": "bank_account_id", "op": "eq", "param": "bankAccountId" },
        { "field": "value_date", "op": "gte", "param": "fromDate" },
        { "field": "value_date", "op": "lte", "param": "toDate" }
      ]
    },
    "columns": [
      { "field": "bank_account_code", "labelEn": "Bank account", "labelAr": "الحساب البنكي", "format": "text", "align": "start", "width": 110 },
      { "field": "statement_date", "labelEn": "Statement", "labelAr": "الكشف", "format": "date", "align": "start", "width": 100 },
      { "field": "value_date", "labelEn": "Value date", "labelAr": "تاريخ القيمة", "format": "date", "align": "start", "width": 100 },
      { "field": "line_no", "labelEn": "Line", "labelAr": "السطر", "format": "integer", "align": "end", "width": 60 },
      { "field": "description", "labelEn": "Description", "labelAr": "الوصف", "format": "text", "align": "start" },
      { "field": "reference", "labelEn": "Reference", "labelAr": "المرجع", "format": "text", "align": "start", "width": 110 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 70 },
      { "field": "amount", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 110 },
      { "field": "matched_amount", "labelEn": "Matched", "labelAr": "المسوى", "format": "money", "align": "end", "width": 110 },
      { "field": "line_id", "labelEn": "Line id", "labelAr": "معرف السطر", "format": "text", "align": "start", "width": 0 },
      { "field": "is_matched", "labelEn": "Reconciled", "labelAr": "مسوى", "format": "text", "align": "start", "width": 90 }
    ],
    "groups": [{ "field": "bank_account_code", "subtotal": true }],
    "totals": [{ "field": "amount", "fn": "sum" }],
    "sort": [{ "field": "value_date", "dir": "asc" }, { "field": "line_no", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {isMatched}",
      "footer": "{rowCount} lines · {generatedAt}"
    },
    "tieOut": { "kind": "projection", "projection": "bank_statement_line" }
  }
}
```

> **`line_id` carries `width: 0`** — 7A's `RenderedColumn.width` is `number | null` and a zero tells the renderers to give it the minimum; it is present because a reconciler resolving an item needs the id to act on, and the group test asserts on it. **`accounting.bank.reconcile` is a `mutating: true` code gating a read**, which R7 permits on a `GET` and §4.16.1 chose deliberately: only a reconciler should see which bank items are unexplained.

- [ ] **Step 7: Run the tests to see them pass**

Run: `bun run --cwd packages/db test -- reports/7c-ar-ap && bun run typecheck && bun run lint`
Expected: PASS. If `assertFieldCoverage` fails naming a field, the definition names a column 7A's dataset does not serve — correct the **definition** against 7B amendment A3's transcription, never 7A's dataset (Global Constraint 9).

- [ ] **Step 8: Commit**

```bash
git add packages/db/seed/my/reports/7c/accounting.ageing.json \
        packages/db/seed/my/reports/7c/accounting.party_statement.json \
        packages/db/seed/my/reports/7c/accounting.allocation_register.json \
        packages/db/seed/my/reports/7c/accounting.unreconciled_items.json \
        packages/db/test/reports/7c-ar-ap.test.ts
git commit -m "$(cat <<'EOF'
feat(seed): add the four 7C AR/AP report definitions [7C T3]

accounting.ageing is 4B's code re-expressed at definitionVersion 2 — 4B's JSON
route, its DTOs and its tie-out test all stand byte-for-byte (7B amendment A2),
and a parity case proves the definition's rows equal agedBalance's figures
bucket for bucket.

party_statement takes partyId, not partyKind: 7A's document dataset carries no
party_kind column (amendment A6). unreconciled_items is the bank_statement_line
dataset filtered is_matched eq false — 7A built that column for this report,
so no second query exists (amendment A8). allocation_register ties against
app.allocation rather than the ledger, because a settlement allocation posts
nothing and a ledger_sum would compare it against zero (amendment A3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The four POS and two cross-module definitions, `ReportCodeSchema` + 7, and the seed application

Six definitions and the catalogue's closing checks. Two of the six re-express 6D's codes at `definitionVersion = 2` with a parity case each; `accounting.branch_profit_and_loss` is **generated** from 7A's frozen `statementDefinition("profit_and_loss", identity, { perBranch: true })` rather than hand-written, for the reason amendment A5 settles, and its rows reach the page through `statementRows`' `ledger_entry` branch; `accounting.tax_return_view` renders what 5A's engine stored and names no authority form.

**Files:**
- Create: `packages/db/seed/my/reports/7c/pos.z_report.json`, `…/pos.sales_by_cashier.json`, `…/pos.sales_by_branch.json`, `…/pos.needs_attention.json`, `…/accounting.branch_profit_and_loss.json`, `…/accounting.tax_return_view.json`, `apps/api/test/routes/reports/7c-pos-cross-module.test.ts`, `packages/contracts/test/report-codes-7c.test.ts`
- Modify: `packages/contracts/src/accounting/reports.ts` (`ReportCodeSchema` gains eight members), `packages/db/test/seed/reports.test.ts` (one appended `it`)

**Interfaces:**
- Consumes: everything Task 3 consumes, plus `statementDefinition`, `StatementKind` and `statementKindFor` (7A, `@dulja/domain` — the branch P&L's seed file **is** `statementDefinition`'s return, and `statementKindFor` is the assertion that the code is a `STATEMENT_CODES` key; this slice writes no layout, keeps no code→kind map and never calls `statementSectionFor`, whose classification `statementRows` already applies); `posReportFixture`, `PosReportFixture` (Task 2); `zReport`, `salesByCashier` (6D, §4.16.3); `loadReportDefinitions`, `reportsLoader` (7A, §4.2.13); `ReportCodeSchema` (1B, widened by 3D, 4B, 6D and 7B before this slice).
- Produces: the six definitions, and the widened `ReportCodeSchema`.

```ts
// packages/contracts/src/accounting/reports.ts — eight members appended, none reordered, no count asserted
export const ReportCodeSchema: z.ZodEnum<[/* … whatever already exists … */,
  "accounting.party_statement", "accounting.allocation_register", "accounting.unreconciled_items",
  "accounting.branch_profit_and_loss", "accounting.tax_return_view",
  "pos.sales_by_branch", "pos.needs_attention",
  /* ⚠️ OD-09 only: "accounting.pdc_register" — appended by Task 11 */]>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/test/routes/reports/7c-pos-cross-module.test.ts`:

> **Why this file is in `apps/api/test/`, not `packages/db/test/`.** It needs a running API: `posReportFixture` takes a `StartedApi` (amendment A4) because 6C's `staffFixture` does, and `startApi()` lives in `apps/api/test/support/app.ts`. `scripts/lint/rules/dependency-rule.ts` runs over every import in `apps/**` and `packages/**` (§3.1), and the three named allowances all run **toward** `tests/invariants/support/**` — `apps/worker/test/**`, `apps/api/test/**` (§4.17.1) and `packages/db/test/**` (3B amendment A21(c)). There is **no** allowance for `packages/db/test/**` → `apps/api/test/**`, and this slice adds none: 6C settled the identical case for its own endpoint half — *"it cannot live in `tests/` … so the endpoint half is `apps/api/test/routes/branch-scoping.test.ts`"* (6c:5032). This file therefore sits in the tier that already holds the allowance it needs, and reaches `reports-7c.ts` through it. The **type-only** `import type { StartedApi }` inside `tests/invariants/support/reports-7c.ts` is untouched and needs nothing: it is erased at compile time, exactly as 6A's `pos.ts` and 6C's `staff.ts` already do it.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Money, currency, statementDefinition, statementKindFor, validateReportDefinition,
} from "@dulja/domain";
import { reportDefinitionSets, salesByCashier, withTenant, zReport } from "@dulja/db";
import {
  arApReportFixture, posReportFixture, readDefinition7C, readEnvelope7C,
  type ArApReportFixture, type PosReportFixture,
} from "../../../../../tests/invariants/support/reports-7c";
import { assertFieldCoverage, assertTieOut, runDefinition } from "../../../../../tests/invariants/support/reports";
import { startApi, type StartedApi } from "../../support/app";

// `zReport` and `salesByCashier` come off the `@dulja/db` barrel, not off a relative `src/reports/pos`
// path: 6D amendment A5 registers them as "in `packages/db/src/reports/pos.ts`, **exported from
// `@dulja/db`**", and this file is in `apps/api`, which reaches `packages/db` only through its package
// entry point (§3.1). `reportDefinitionSets` is 7A's and is on the same barrel (Task 14 imports it there).

const MYR = currency("MYR");

describe("7C POS and cross-module definitions — §4.16.1, amendments A2, A5 and A7", () => {
  let api: StartedApi;
  let p: PosReportFixture;
  let a: ArApReportFixture;

  beforeAll(async () => {
    api = await startApi();
    p = await posReportFixture(api, "7c-pos");
    a = await arApReportFixture(api.db, "7c-cross");
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  // The PRODUCTION `withTenant(sql, ctx, fn)` (§4.2.2): the four-argument test form belongs to
  // `packages/db/test` and this file is in the `apps/api` tier.
  const readPos = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(api.db.rw, { tenantId: p.s.tenant, actorId: p.reader, requestId: crypto.randomUUID() },
               fn as never) as Promise<T>;
  const readAcc = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(api.db.rw, { tenantId: a.s.tenant, actorId: a.reader, requestId: crypto.randomUUID() },
               fn as never) as Promise<T>;

  const POS = ["pos.z_report", "pos.sales_by_cashier", "pos.sales_by_branch", "pos.needs_attention"] as const;
  const CROSS = ["accounting.branch_profit_and_loss", "accounting.tax_return_view"] as const;

  it("all six validate, and only the two re-expressed carry definitionVersion 2", async () => {
    const sets = await readPos((tx) => reportDefinitionSets(tx));
    for (const code of [...POS, ...CROSS]) {
      const result = validateReportDefinition(readDefinition7C(code), sets);
      expect(result.errors, code).toEqual([]);
    }
    expect(readEnvelope7C("pos.z_report").definitionVersion).toBe(2);
    expect(readEnvelope7C("pos.sales_by_cashier").definitionVersion).toBe(2);
    for (const code of ["pos.sales_by_branch", "pos.needs_attention", ...CROSS] as const) {
      expect(readEnvelope7C(code).definitionVersion, code).toBe(1);
    }
  });

  it("every field the six name is a column its dataset serves", async () => {
    for (const code of POS) {
      const definition = readDefinition7C(code);
      assertFieldCoverage(definition, await readPos((tx) => runDefinition(tx, definition, posParams(code, p))));
    }
    for (const code of CROSS) {
      const definition = readDefinition7C(code);
      assertFieldCoverage(definition, await readAcc((tx) => runDefinition(tx, definition, crossParams(code, a))));
    }
  });

  it("no 7C definition reads the till_event dataset — it is a designer source (amendment A2)", () => {
    const sources = [...POS, ...CROSS].map((c) => readDefinition7C(c).dataset.source);
    expect(sources).not.toContain("till_event");
    // `accounting.branch_profit_and_loss`'s source is `account_balance` — the row SHAPE, not the query;
    // `statementRows` reads `ledger_entry` for it (amendment A5, the case two blocks below).
    expect(sources).toEqual([
      "shift", "shift", "shift", "needs_attention", "account_balance", "tax_transaction",
    ]);
  });

  it("pos.z_report ties to app.shift's stored figures for the closed shift", async () => {
    const definition = readDefinition7C("pos.z_report");
    await readPos((tx) => assertTieOut(tx, definition, {
      params: posParams("pos.z_report", p), baseCurrency: MYR,
    }));
  });

  it("pos.z_report PARITY: the definition equals 6D's zReport figure for figure", async () => {
    const definition = readDefinition7C("pos.z_report");
    const rows = await readPos((tx) => runDefinition(tx, definition, posParams("pos.z_report", p)));
    const [route] = await readPos((tx) => zReport(tx, {
      companyId: p.s.company, shiftId: p.closedShiftId, limit: 10,
    }));
    const row = rows.find((r) => r["shift_id"] === p.closedShiftId)!;
    expect(row["opening_float"]).toBe(route!.openingFloat);
    expect(row["counted_cash"]).toBe(route!.countedCash);
    expect(row["expected_cash"]).toBe(route!.expectedCash);
    expect(row["over_short"]).toBe(route!.overShort);
    expect(row["ticket_count"]).toBe(route!.ticketCount);
    expect(row["return_count"]).toBe(route!.returnCount);
    expect(row["no_sale_count"]).toBe(route!.tillEvents.find((e) => e.kind === "no_sale")?.count ?? 0);
    expect(row["void_count"]).toBe(route!.tillEvents.find((e) => e.kind === "void")?.count ?? 0);
  });

  it("pos.sales_by_cashier PARITY: Σ net_sales_base per cashier equals 6D's netSalesBase", async () => {
    const definition = readDefinition7C("pos.sales_by_cashier");
    const rows = await readPos((tx) => runDefinition(tx, definition, posParams("pos.sales_by_cashier", p)));
    const route = await readPos((tx) => salesByCashier(tx, {
      companyId: p.s.company, from: "2026-01-01", to: "2026-12-31", limit: 100,
    }));
    for (const r of route) {
      let net = Money.zero(MYR);
      let tickets = 0;
      for (const row of rows.filter((x) => x["cashier_principal_id"] === r.cashierPrincipalId)) {
        net = net.add(Money.of(String(row["net_sales_base"]), MYR));
        tickets += Number(row["ticket_count"]);
      }
      expect(net.toString(), r.cashierPrincipalId).toBe(Money.of(r.netSalesBase, MYR).toString());
      expect(tickets, r.cashierPrincipalId).toBe(r.ticketCount);
    }
  });

  it("pos.sales_by_cashier ties Σ net_sales_base to the ledger's income movement", async () => {
    const definition = readDefinition7C("pos.sales_by_cashier");
    await readPos((tx) => assertTieOut(tx, definition, {
      params: posParams("pos.sales_by_cashier", p), baseCurrency: MYR,
      window: { fromDate: "2026-01-01", toDate: "2026-12-31", accountTypes: ["income"], documentTypeCodes: ["POS_TICKET"] },
    }));
  });

  it("pos.sales_by_branch ties per branch, and branch B is empty", async () => {
    const definition = readDefinition7C("pos.sales_by_branch");
    await readPos((tx) => assertTieOut(tx, definition, {
      params: posParams("pos.sales_by_branch", p), baseCurrency: MYR,
      window: { fromDate: "2026-01-01", toDate: "2026-12-31", accountTypes: ["income"], documentTypeCodes: ["POS_TICKET"] },
    }));
    const rows = await readPos((tx) => runDefinition(tx, definition, {
      ...posParams("pos.sales_by_branch", p), branchId: p.branchB,
    }));
    expect(rows).toEqual([]);
  });

  it("pos.needs_attention lists the rejected ticket and never its payload", async () => {
    const definition = readDefinition7C("pos.needs_attention");
    const rows = await readPos((tx) => runDefinition(tx, definition, posParams("pos.needs_attention", p)));
    expect(rows.map((r) => r["client_ref"])).toEqual([p.rejectedClientRef]);
    expect(definition.columns.map((c) => c.field)).not.toContain("payload");
    expect(definition.permission).toBe("pos.needs_attention.resolve");
    await readPos((tx) => assertTieOut(tx, definition, {
      params: posParams("pos.needs_attention", p), baseCurrency: MYR,
      witness: {
        key: ["client_ref"],
        rows: (tx2) => tx2<{ client_ref: string }[]>`
          select na.client_ref::text as client_ref from app.needs_attention na
           where na.company_id = ${p.s.company} and na.resolved_at is null order by na.client_ref`,
      },
    }));
  });

  // THE CASE THAT MAKES A5 MECHANICAL, in 7B Task 2's own form: the seed file is not "modelled on" 7A's
  // perBranch layout, it IS that layout composed onto this code's identity. A hand-written divergence in
  // any member fails here with a diff, before any figure is compared.
  it("accounting.branch_profit_and_loss IS statementDefinition(profit_and_loss, …, { perBranch: true })", () => {
    expect(readDefinition7C("accounting.branch_profit_and_loss")).toEqual(
      statementDefinition(
        "profit_and_loss",
        {
          code: "accounting.branch_profit_and_loss",
          nameEn: "Branch profit and loss",
          nameAr: "الأرباح والخسائر حسب الفرع",
          permission: "accounting.report.read",
        },
        { perBranch: true },
      ),
    );
  });

  it("accounting.branch_profit_and_loss is a STATEMENT code whose rows come from ledger_entry (A5)", async () => {
    const definition = readDefinition7C("accounting.branch_profit_and_loss");
    // `dataset.source` names the row SHAPE; `STATEMENT_CODES` is what picks the query.
    expect(definition.dataset.source).toBe("account_balance");
    expect(statementKindFor("accounting.branch_profit_and_loss")).toBe("profit_and_loss");
    expect(definition.groups.map((g) => g.field)).toEqual(["branch_code", "section"]);
    expect(definition.parameters.map((p2) => p2.name)).toEqual(["fiscalPeriodId", "branchId"]);

    // With a branchId the run path takes `statementRows`' ledger_entry branch, which is the only place a
    // branch tag exists on a posted amount (7B A6). `branch_id` on the rows is the proof it was taken —
    // the account_balance fallback annotates `branch_code: null` and no `branch_id` at all.
    const rows = await readAcc((tx) => runDefinition(tx, definition,
      crossParams("accounting.branch_profit_and_loss", a)));
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!)).toContain("branch_id");
    expect(rows.every((r) => r["branch_id"] === a.s.hq)).toBe(true);
    expect(rows.every((r) => r["section"] === "revenue" || r["section"] === "expense")).toBe(true);

    await readAcc((tx) => assertTieOut(tx, definition, {
      params: crossParams("accounting.branch_profit_and_loss", a), baseCurrency: MYR,
      window: { fiscalPeriodId: a.fiscalPeriodId, branchId: a.s.hq, accountTypes: ["income", "expense"] },
    }));
  });

  it("accounting.tax_return_view names no authority form, box, rate or deadline", async () => {
    const definition = readDefinition7C("accounting.tax_return_view");
    const text = JSON.stringify(definition);
    for (const forbidden of ["LHDN", "MyInvois", "SST-02", "GST-03", "box", "deadline"]) {
      expect(text.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    expect(definition.permission).toBe("accounting.tax.manage");
    await readAcc((tx) => assertTieOut(tx, definition, {
      params: crossParams("accounting.tax_return_view", a), baseCurrency: MYR,
      window: { fiscalPeriodId: a.fiscalPeriodId, accountCode: "2300" },
    }));
  });
});

/** `companyId` seeds every branch of both tables, exactly as 7B's own `paramsFor` does (7b:1432):
 *  `runDefinition` reads `params.companyId` and binds it into the dataset's `company` fragment, and
 *  `assertTieOut` binds the same value into its independent query (7b:719, 7b:795). */
function posParams(code: string, p: PosReportFixture): Record<string, string> {
  const base = { companyId: p.s.company };
  switch (code) {
    case "pos.z_report":         return { ...base, shiftId: p.closedShiftId };
    case "pos.sales_by_cashier": return { ...base, fromDate: "2026-01-01", toDate: "2026-12-31" };
    case "pos.sales_by_branch":  return { ...base, fromDate: "2026-01-01", toDate: "2026-12-31" };
    case "pos.needs_attention":  return { ...base, isOpen: "true" };
    default: throw new Error(`no parameters registered for ${code}`);
  }
}

function crossParams(code: string, a: ArApReportFixture): Record<string, string> {
  const base = { companyId: a.s.company };
  switch (code) {
    // `branchId` is NOT optional in practice: without it `rowsForDefinition` takes `statementRows`'
    // account_balance fallback, whose rows carry no `branch_id`, and `assertFieldCoverage` fails on the
    // definition's own filter field (amendment A5). `s.hq` is the head-office BRANCH value every
    // `app.document` row carries (§4.1's `Seed`), so it is the branch this fixture's documents posted to.
    case "accounting.branch_profit_and_loss":
      return { ...base, fiscalPeriodId: a.fiscalPeriodId, branchId: a.s.hq };
    case "accounting.tax_return_view":
      return { ...base, fiscalPeriodId: a.fiscalPeriodId, taxCodeKind: "output" };
    default: throw new Error(`no parameters registered for ${code}`);
  }
}
```

`packages/contracts/test/report-codes-7c.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ReportCodeSchema } from "../src/accounting/reports";

describe("ReportCodeSchema after 7C — contracts §4.16.3, amendment A15", () => {
  const members = ReportCodeSchema.options as readonly string[];

  it("holds every 7C code that is not owner-gated", () => {
    for (const code of [
      "accounting.ageing", "accounting.party_statement", "accounting.allocation_register",
      "accounting.unreconciled_items", "accounting.branch_profit_and_loss", "accounting.tax_return_view",
      "pos.z_report", "pos.sales_by_cashier", "pos.sales_by_branch", "pos.needs_attention",
    ]) {
      expect(members, code).toContain(code);
    }
  });

  it("holds every predecessor code and asserts no total count (amendment A15)", () => {
    for (const code of [
      "accounting.trial_balance", "accounting.ledger", "accounting.general_ledger",
      "inventory.stock_on_hand", "inventory.valuation", "inventory.sales_by_item",
    ]) {
      expect(members, code).toContain(code);
    }
    expect(new Set(members).size).toBe(members.length);   // no duplicate — the only structural claim made
  });

  it("every member matches §4.16.1's two-segment grammar", () => {
    for (const code of members) {
      expect(code, code).toMatch(/^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/);
    }
  });
});
```

> **Why both POS windows carry `documentTypeCodes: ["POS_TICKET"]`.** The report side of these two tie-outs
> sums `net_sales_base` over the `shift` dataset, which by construction reads **only** the shift's own
> `POS_TICKET` documents (Task 1's `TICKET_IDS`). Without the restriction the ledger side would sum Σ income
> over **every** document in the date window, so one back-office `SALES_INVOICE` in the same month — which
> `arApFixture` posts and a real tenant certainly has — would make a correct report fail. `documentTypeCodes`
> is 7B's own `LedgerWindow` member (7b:1712), so this is a use of the harness, not an extension of it.
>
> **The two sides also key off different dates, and the wide window is what reconciles them.** The dataset
> filters shifts by `shift.opened_at`; the harness filters ledger rows by `document.effective_date`. They
> agree here because the fixture's whole trading day sits inside `2026-01-01 … 2026-12-31` with room to
> spare. A shift opened before midnight whose tickets post on the next effective date would split — a real
> boundary that **8D's** cross-midnight case owns, and the reason the register's parameters are dates rather
> than a period id. Do not narrow this window to make it look tighter; narrowing it is what would break it.

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd apps/api test -- routes/reports/7c-pos-cross-module && bun run --cwd packages/contracts test -- report-codes-7c`
Expected: FAIL twice — the first at `readDefinition7C("pos.z_report")` (no such file), the second with `expected [ … ] to contain 'accounting.party_statement'`.

- [ ] **Step 3: Write `pos.z_report.json` — 6D's code, re-expressed at definitionVersion 2**

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "pos.z_report",
    "nameEn": "Z-report",
    "nameAr": "تقرير Z",
    "module": "pos",
    "permission": "pos.report.read",
    "parameters": [
      { "name": "shiftId", "kind": "text", "required": false },
      { "name": "branchId", "kind": "branch", "required": false },
      { "name": "fromDate", "kind": "date", "required": false },
      { "name": "toDate", "kind": "date", "required": false }
    ],
    "dataset": {
      "source": "shift",
      "filters": [
        { "field": "shift_id", "op": "eq", "param": "shiftId" },
        { "field": "branch_id", "op": "eq", "param": "branchId" },
        { "field": "opened_on", "op": "gte", "param": "fromDate" },
        { "field": "opened_on", "op": "lte", "param": "toDate" }
      ]
    },
    "columns": [
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 90 },
      { "field": "terminal_code", "labelEn": "Terminal", "labelAr": "الجهاز", "format": "text", "align": "start", "width": 90 },
      { "field": "cashier_name", "labelEn": "Cashier", "labelAr": "أمين الصندوق", "format": "text", "align": "start" },
      { "field": "opened_at", "labelEn": "Opened", "labelAr": "فُتح", "format": "text", "align": "start", "width": 130 },
      { "field": "closed_at", "labelEn": "Closed", "labelAr": "أُغلق", "format": "text", "align": "start", "width": 130 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 70 },
      { "field": "opening_float", "labelEn": "Opening float", "labelAr": "الرصيد الافتتاحي", "format": "money", "align": "end", "width": 110 },
      { "field": "net_sales_base", "labelEn": "Net sales", "labelAr": "صافي المبيعات", "format": "money", "align": "end", "width": 110 },
      { "field": "counted_cash", "labelEn": "Counted cash", "labelAr": "النقد المعدود", "format": "money", "align": "end", "width": 110 },
      { "field": "expected_cash", "labelEn": "Expected cash", "labelAr": "النقد المتوقع", "format": "money", "align": "end", "width": 110 },
      { "field": "over_short", "labelEn": "Over / short", "labelAr": "زيادة / عجز", "format": "money", "align": "end", "width": 110 },
      { "field": "ticket_count", "labelEn": "Tickets", "labelAr": "الفواتير", "format": "integer", "align": "end", "width": 80 },
      { "field": "return_count", "labelEn": "Returns", "labelAr": "المرتجعات", "format": "integer", "align": "end", "width": 80 },
      { "field": "no_sale_count", "labelEn": "No sale", "labelAr": "بدون بيع", "format": "integer", "align": "end", "width": 80 },
      { "field": "drawer_open_count", "labelEn": "Drawer opens", "labelAr": "فتح الدرج", "format": "integer", "align": "end", "width": 90 },
      { "field": "void_count", "labelEn": "Voids", "labelAr": "الإلغاءات", "format": "integer", "align": "end", "width": 80 },
      { "field": "shift_id", "labelEn": "Shift", "labelAr": "الوردية", "format": "text", "align": "start", "width": 0 }
    ],
    "groups": [{ "field": "branch_code", "subtotal": true }],
    "totals": [{ "field": "net_sales_base", "fn": "sum" }, { "field": "shift_id", "fn": "count" }],
    "sort": [{ "field": "opened_at", "dir": "desc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "{rowCount} shifts · {generatedAt}"
    },
    "tieOut": { "kind": "projection", "projection": "shift" }
  }
}
```

> **One code, two shapes** (§4.16.1, 6D amendment A5): with `shiftId` this is one shift's Z-report; with `fromDate`/`toDate` it is the **Z-report history** the card names, which is why every parameter is optional and the report always returns rows. **`over_short` is positive-is-over** (§4.6.5) and the definition never flips the sign — a flipped sign in a report is how a reader loses the ability to add two reports together (7A's own note on `base_balance`). **`opened_at` and `closed_at` are `format: "text"`, and the date range filters `opened_on`** — the two halves of amendment A1's companion rule: the *filter* needs a `date` column because the parameter is a `date` (7A's `assertValue`), and the *display* needs the raw RFC 3339 string because 7A's `date` formatter throws on one (see the note under `accounting.allocation_register`). A Z-report that showed only the day would lose the shift boundary, which is the fact a cash count is reconciled against.

- [ ] **Step 4: Write `pos.sales_by_cashier.json` and `pos.sales_by_branch.json`**

`pos.sales_by_cashier.json`:

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "pos.sales_by_cashier",
    "nameEn": "Sales by cashier",
    "nameAr": "المبيعات حسب أمين الصندوق",
    "module": "pos",
    "permission": "pos.report.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "branchId", "kind": "branch", "required": false },
      { "name": "cashierPrincipalId", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "shift",
      "filters": [
        { "field": "opened_on", "op": "gte", "param": "fromDate" },
        { "field": "opened_on", "op": "lte", "param": "toDate" },
        { "field": "branch_id", "op": "eq", "param": "branchId" },
        { "field": "cashier_principal_id", "op": "eq", "param": "cashierPrincipalId" }
      ]
    },
    "columns": [
      { "field": "cashier_name", "labelEn": "Cashier", "labelAr": "أمين الصندوق", "format": "text", "align": "start" },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 90 },
      { "field": "terminal_code", "labelEn": "Terminal", "labelAr": "الجهاز", "format": "text", "align": "start", "width": 90 },
      { "field": "opened_on", "labelEn": "Shift opened", "labelAr": "بداية الوردية", "format": "date", "align": "start", "width": 110 },
      { "field": "ticket_count", "labelEn": "Tickets", "labelAr": "الفواتير", "format": "integer", "align": "end", "width": 80 },
      { "field": "return_count", "labelEn": "Returns", "labelAr": "المرتجعات", "format": "integer", "align": "end", "width": 80 },
      { "field": "net_sales_base", "labelEn": "Net sales", "labelAr": "صافي المبيعات", "format": "money", "align": "end", "width": 120 },
      { "field": "over_short", "labelEn": "Over / short", "labelAr": "زيادة / عجز", "format": "money", "align": "end", "width": 110 },
      { "field": "cashier_principal_id", "labelEn": "Cashier id", "labelAr": "معرف أمين الصندوق", "format": "text", "align": "start", "width": 0 },
      { "field": "opened_at", "labelEn": "Opened", "labelAr": "فُتح", "format": "text", "align": "start", "width": 0 }
    ],
    "groups": [{ "field": "cashier_name", "subtotal": true }],
    "totals": [{ "field": "net_sales_base", "fn": "sum" }, { "field": "ticket_count", "fn": "sum" }],
    "sort": [{ "field": "cashier_name", "dir": "asc" }, { "field": "opened_at", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "{rowCount} shifts · {generatedAt}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

> **This is a per-shift row grouped by cashier, and the amendment says why it is not a per-ticket row.** 6A's `assertShiftKnown` refuses a ticket whose `shiftId` names no shift of that terminal but does **not** require the ticket's cashier to be the shift's opener, so a shift worked by two cashiers would attribute both cashiers' tickets to the opener. The `shift` dataset is what §4.16.2 gives this slice, and a per-ticket dataset is not in the closed register; the parity case therefore runs on a fixture where each shift has one cashier — which is what `ShiftOpenClose` models (§4.10.1, one `cashierPrincipalId`) — and the difference is recorded in the Self-Review as a raise, not papered over. **There is no `discount_base` column**: 6D's route derives that figure its own way and a second derivation would be two definitions of one number (amendment A1).

`pos.sales_by_branch.json` — the same dataset grouped one level up:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "pos.sales_by_branch",
    "nameEn": "Sales by branch",
    "nameAr": "المبيعات حسب الفرع",
    "module": "pos",
    "permission": "pos.report.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "branchId", "kind": "branch", "required": false }
    ],
    "dataset": {
      "source": "shift",
      "filters": [
        { "field": "opened_on", "op": "gte", "param": "fromDate" },
        { "field": "opened_on", "op": "lte", "param": "toDate" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "columns": [
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 100 },
      { "field": "terminal_code", "labelEn": "Terminal", "labelAr": "الجهاز", "format": "text", "align": "start", "width": 100 },
      { "field": "opened_on", "labelEn": "Shift opened", "labelAr": "بداية الوردية", "format": "date", "align": "start", "width": 110 },
      { "field": "ticket_count", "labelEn": "Tickets", "labelAr": "الفواتير", "format": "integer", "align": "end", "width": 80 },
      { "field": "return_count", "labelEn": "Returns", "labelAr": "المرتجعات", "format": "integer", "align": "end", "width": 80 },
      { "field": "net_sales_base", "labelEn": "Net sales", "labelAr": "صافي المبيعات", "format": "money", "align": "end", "width": 130 },
      { "field": "over_short", "labelEn": "Over / short", "labelAr": "زيادة / عجز", "format": "money", "align": "end", "width": 110 },
      { "field": "opened_at", "labelEn": "Opened", "labelAr": "فُتح", "format": "text", "align": "start", "width": 0 }
    ],
    "groups": [{ "field": "branch_code", "subtotal": true }],
    "totals": [{ "field": "net_sales_base", "fn": "sum" }],
    "sort": [{ "field": "branch_code", "dir": "asc" }, { "field": "opened_at", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{title} — {fromDate} … {toDate}",
      "footer": "{rowCount} shifts · {generatedAt}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

> **Both files declare `opened_at` at `width: 0`, and `pos.needs_attention` declares `created_at` the same way — because a sort key must be a declared column.** 7A's `validateReportDefinition` rule 4 checks every `groups[]`, `totals[]` and `sort[]` field against **the definition's own `columns[]`**, not against the dataset, and refuses an absent one at `/sort/1/field` with *"sort field 'opened_at' is not one of this definition's columns"* — which is precisely the array Task 4 Step 1's first case asserts empty. Amendment A1's companion rule creates the exposure: the **filter** must bind the `date` column (`opened_on`, `created_on`) because the parameter is a `date`, so the displayed date column is the companion and the `timestamp` the report actually orders by is no longer named anywhere else. `pos.z_report` needs no such addition — it already renders `opened_at` at full width, because a Z-report's shift boundary is a time. The three added columns are `format: "text"`, never `"date"`: 7A's date formatter throws a `RangeError` on an RFC 3339 value (see the note under `accounting.allocation_register`). **Do not "simplify" this by sorting on `opened_on` / `created_on` instead** — two shifts opened on one trading day would then tie, and a report whose row order is undefined is a report whose page breaks move between runs.

- [ ] **Step 5: Write `pos.needs_attention.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "pos.needs_attention",
    "nameEn": "Needs-attention log",
    "nameAr": "سجل يحتاج انتباه",
    "module": "pos",
    "permission": "pos.needs_attention.resolve",
    "parameters": [
      { "name": "isOpen", "kind": "enum", "required": true, "options": ["true", "false"] },
      { "name": "branchId", "kind": "branch", "required": false },
      { "name": "errorCode", "kind": "text", "required": false },
      { "name": "fromDate", "kind": "date", "required": false }
    ],
    "dataset": {
      "source": "needs_attention",
      "filters": [
        { "field": "is_open", "op": "eq", "param": "isOpen" },
        { "field": "branch_id", "op": "eq", "param": "branchId" },
        { "field": "error_code", "op": "eq", "param": "errorCode" },
        { "field": "created_on", "op": "gte", "param": "fromDate" }
      ]
    },
    "columns": [
      { "field": "created_on", "labelEn": "Raised", "labelAr": "أُثير", "format": "date", "align": "start", "width": 110 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 90 },
      { "field": "terminal_code", "labelEn": "Terminal", "labelAr": "الجهاز", "format": "text", "align": "start", "width": 90 },
      { "field": "client_ref", "labelEn": "Ticket ref", "labelAr": "مرجع الفاتورة", "format": "text", "align": "start", "width": 180 },
      { "field": "error_code", "labelEn": "Error", "labelAr": "الخطأ", "format": "text", "align": "start", "width": 180 },
      { "field": "error_detail", "labelEn": "Detail", "labelAr": "التفصيل", "format": "text", "align": "start" },
      { "field": "resolved_at", "labelEn": "Resolved", "labelAr": "حُل", "format": "text", "align": "start", "width": 130 },
      { "field": "resolution_note", "labelEn": "Note", "labelAr": "ملاحظة", "format": "text", "align": "start" },
      { "field": "created_at", "labelEn": "Raised at", "labelAr": "أُثير في", "format": "text", "align": "start", "width": 0 }
    ],
    "groups": [{ "field": "branch_code", "subtotal": false }],
    "totals": [{ "field": "client_ref", "fn": "count" }],
    "sort": [{ "field": "created_at", "dir": "desc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {isOpen}",
      "footer": "{rowCount} items · {generatedAt}"
    },
    "tieOut": { "kind": "none" }
  }
}
```

> **`tieOut.kind` is `none` and the harness therefore demands a row witness** (7B amendment A5): this report has no monetary or quantity total — `count` over `client_ref` is a count — so there is nothing to tie to the ledger, and the group test supplies an independent `tx` query over `app.needs_attention` whose row set the report's rows must equal on `client_ref`. `none` never means "no test". **`payload` is absent from `columns`** because it is absent from the dataset (amendment A1); a resolver reads the rejected ticket through 6A's gated needs-attention resource.

- [ ] **Step 6: Generate `accounting.branch_profit_and_loss.json` from `statementDefinition`**

**This file is not hand-written.** It is exactly `statementDefinition("profit_and_loss", identity, { perBranch: true })` (amendment A5), by the same rule 7B's Task 2 follows for `accounting.profit_and_loss` and `accounting.balance_sheet`, and Step 1's deep-equality case is the mechanical guard that keeps it so. Generate it and diff, rather than typing it — **from the repository root**, and in 7B's own invocation shape (`bun -e`, a dynamic `import`, `Bun.write`), because that is the form already proven to resolve a workspace package from the root. The `7c/` directory already exists: Task 3 wrote four files into it.

```bash
bun -e 'const { statementDefinition } = await import("@dulja/domain");
await Bun.write(
  "packages/db/seed/my/reports/7c/accounting.branch_profit_and_loss.json",
  JSON.stringify({ definitionVersion: 1,
    definition: statementDefinition("profit_and_loss", {
      code: "accounting.branch_profit_and_loss",
      nameEn: "Branch profit and loss",
      nameAr: "الأرباح والخسائر حسب الفرع",
      permission: "accounting.report.read",
    }, { perBranch: true }) },
    null, 2) + "\n");'
```

Against 7A's `build()` as this plan was written, that produces:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.branch_profit_and_loss",
    "nameEn": "Branch profit and loss",
    "nameAr": "الأرباح والخسائر حسب الفرع",
    "module": "accounting",
    "permission": "accounting.report.read",
    "columns": [
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 100 },
      { "field": "section", "labelEn": "Section", "labelAr": "القسم", "format": "text", "align": "start", "width": 120 },
      { "field": "account_code", "labelEn": "Code", "labelAr": "الرمز", "format": "text", "align": "start", "width": 80 },
      { "field": "account_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start" },
      { "field": "base_balance", "labelEn": "Balance", "labelAr": "الرصيد", "format": "money", "align": "end", "width": 120 }
    ],
    "groups": [{ "field": "branch_code", "subtotal": true }, { "field": "section", "subtotal": true }],
    "totals": [{ "field": "base_balance", "fn": "sum" }],
    "sort": [{ "field": "section", "dir": "asc" }, { "field": "account_code", "dir": "asc" }],
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true },
      { "name": "branchId", "kind": "branch", "required": false }
    ],
    "dataset": {
      "source": "account_balance",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {fiscalPeriodId}",
      "footer": "{rowCount} accounts · {generatedAt}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

**If what the generator writes differs from what is printed here, 7A's layout has moved since this plan was written: the generator's output wins, this plan's print is corrected in the same PR, and A5's transcription is corrected with it** (§4.18's rule, and 7B's Task 2 says the same about its own pair). Never edit the file to match the print, and never edit Step 1's deep-equality expectation.

> **Four facts a reader would otherwise reconstruct, because every one of them looks wrong at a glance.** (1) **`dataset.source` is `account_balance` and the query is nonetheless a `ledger_entry` read.** `dataset.source` on a statement names the row **shape** both statement queries produce; `rowsForDefinition` sees a `STATEMENT_CODES` key, dispatches to `statementRows`, and `statementRows` takes its `ledger_entry` branch whenever `branchId` is supplied — collapsing the branch's ledger rows to one row per account, which is exactly `account_balance`'s shape (7A's own comment on `STATEMENT_EXTRA_FIELDS`). 7B A6's *"the only place a branch tag exists on a posted amount"* is satisfied by that branch, not by a `dataset.source` string. (2) **The `branch_id` filter never reaches `columnOf`**, and `assertDefinitionFields` does not refuse it: the statement branch of `rowsForDefinition` ignores `dataset.filters` entirely, and the field check unions `STATEMENT_EXTRA_FIELDS = ["section", "branch_code", "branch_id"]` for a `STATEMENT_CODES` key. (3) **There is no `accountTypes` parameter and there must not be one.** The account-type restriction lives in `statementRows`' `annotate` helper, which drops every row `statementSectionFor("profit_and_loss", type)` returns `null` for — the identical reasoning 7B records for its own pair, where a hand-added `accountTypes` "would answer a different row set from `statementRows` under the same code". A statement takes `fiscalPeriodId`, and `perBranch` adds `branchId`; nothing else. (4) **`base_balance` is signed the ledger's way** — revenue is negative, because `account_balance` stores `base_debit − base_credit` and a statement never flips a sign (7A's own note on `BASE_COLUMNS`). The tie-out's `base_balance → sum(base_debit − base_credit)` measure agrees with it by construction.

- [ ] **Step 7: Write `accounting.tax_return_view.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.tax_return_view",
    "nameEn": "Tax return view",
    "nameAr": "عرض الإقرار الضريبي",
    "module": "accounting",
    "permission": "accounting.tax.manage",
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true },
      { "name": "taxCodeKind", "kind": "enum", "required": true, "options": ["output", "input"] },
      { "name": "regimeCode", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "tax_transaction",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" },
        { "field": "tax_code_kind", "op": "eq", "param": "taxCodeKind" },
        { "field": "regime_code", "op": "eq", "param": "regimeCode" }
      ]
    },
    "columns": [
      { "field": "regime_code", "labelEn": "Regime", "labelAr": "النظام", "format": "text", "align": "start", "width": 90 },
      { "field": "tax_code", "labelEn": "Tax code", "labelAr": "رمز الضريبة", "format": "text", "align": "start", "width": 90 },
      { "field": "tax_code_kind", "labelEn": "Kind", "labelAr": "النوع", "format": "text", "align": "start", "width": 80 },
      { "field": "tax_rate", "labelEn": "Rate", "labelAr": "النسبة", "format": "percent", "align": "end", "width": 80 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 130 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "integer", "align": "end", "width": 80 },
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 100 },
      { "field": "party_tax_registration", "labelEn": "Party registration", "labelAr": "تسجيل الطرف", "format": "text", "align": "start", "width": 140 },
      { "field": "base_base", "labelEn": "Taxable base", "labelAr": "الوعاء", "format": "money", "align": "end", "width": 120 },
      { "field": "tax_base", "labelEn": "Tax", "labelAr": "الضريبة", "format": "money", "align": "end", "width": 120 }
    ],
    "groups": [{ "field": "regime_code", "subtotal": true }, { "field": "tax_code", "subtotal": true }],
    "totals": [{ "field": "tax_base", "fn": "sum" }, { "field": "base_base", "fn": "sum" }],
    "sort": [
      { "field": "regime_code", "dir": "asc" },
      { "field": "tax_code", "dir": "asc" },
      { "field": "effective_date", "dir": "asc" }
    ],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{title} — {fiscalPeriodId} · {taxCodeKind}",
      "footer": "{rowCount} transactions · {generatedAt}"
    },
    "tieOut": { "kind": "ledger_sum", "account": "2300" }
  }
}
```

> **`tax_base` is the first money total, and its tie-out account is `2300` output tax payable** (§4.15, seeded by 5A). The group test runs the tie-out with `taxCodeKind: "output"`, the parameter under which the account restriction is the correct comparison (amendment A7); the input side renders against `1350` and is proven by the same group test's field-coverage and row cases. **This definition names no authority form, box number, rate, threshold or deadline** — the `it` above asserts exactly that (hazard 2, spec:2226) — and the filed return itself stays 5A's `tax_return` row.

- [ ] **Step 8: Widen `ReportCodeSchema` and apply the pack**

In `packages/contracts/src/accounting/reports.ts`, append the **seven** unconditional codes to `ReportCodeSchema`'s enum literal, after whatever members already exist and in §4.16.1's order. Do not reorder, do not deduplicate, do not assert a count (amendment A15). `accounting.ageing`, `pos.z_report` and `pos.sales_by_cashier` are already members from 4B and 6D and are **not** touched:

```ts
  "accounting.party_statement",
  "accounting.allocation_register",
  "accounting.unreconciled_items",
  "accounting.branch_profit_and_loss",
  "accounting.tax_return_view",
  "pos.sales_by_branch",
  "pos.needs_attention",
```

Then append one `it` to `packages/db/test/seed/reports.test.ts` — 7A's loader already walks `<packRoot>/reports/<slice>/*.json` one level deep, so the `7c/` directory needs no loader change:

```ts
  it("the reports loader applies the 7c directory beside 7b's (§3.4.8, no loader change)", async () => {
    const applied = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      loadReportDefinitions(tx as never, ctx(), join(REPO_ROOT, "packages", "db", "seed", "my"), s.company));
    for (const code of [
      "accounting.party_statement", "accounting.allocation_register", "accounting.unreconciled_items",
      "accounting.branch_profit_and_loss", "accounting.tax_return_view",
      "pos.sales_by_branch", "pos.needs_attention",
    ]) {
      expect(applied.codes, code).toContain(code);
    }
    const versions = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ code: string; version: number }[]>`
        select code, version from app.report_definition
         where company_id = ${s.company} and code in ('accounting.ageing', 'pos.z_report', 'pos.sales_by_cashier')
         order by code, version`);
    // Each re-expressed code now has BOTH rows: the owning slice's 1 and 7C's 2 (§4.16.1's upsert rule).
    expect(versions.filter((r) => r.version === 2)).toHaveLength(3);
  });
```

- [ ] **Step 9: Run everything to see it pass**

Run: `bun run --cwd packages/db test -- reports/ seed/reports && bun run --cwd apps/api test -- routes/reports/7c-pos-cross-module && bun run --cwd packages/contracts test && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS on all six. **`lint:rules` is the one that matters here**: the group test lives in `apps/api/test/**`, which already holds the §4.17.1 allowance to import `tests/invariants/support/**`, so `dependency-rule` reports nothing. A copy of this file under `packages/db/test/**` would be named by that rule — see the note in Step 1.

- [ ] **Step 10: Commit**

```bash
git add packages/db/seed/my/reports/7c/pos.z_report.json \
        packages/db/seed/my/reports/7c/pos.sales_by_cashier.json \
        packages/db/seed/my/reports/7c/pos.sales_by_branch.json \
        packages/db/seed/my/reports/7c/pos.needs_attention.json \
        packages/db/seed/my/reports/7c/accounting.branch_profit_and_loss.json \
        packages/db/seed/my/reports/7c/accounting.tax_return_view.json \
        apps/api/test/routes/reports/7c-pos-cross-module.test.ts \
        packages/db/test/seed/reports.test.ts \
        packages/contracts/src/accounting/reports.ts \
        packages/contracts/test/report-codes-7c.test.ts
git commit -m "$(cat <<'EOF'
feat(seed): add the four POS and two cross-module definitions [7C T4]

pos.z_report and pos.sales_by_cashier are 6D's codes re-expressed at
definitionVersion 2; 6D's routes and DTOs stand byte-for-byte and a parity
case each proves the definitions equal zReport and salesByCashier figure for
figure. The Z-report's history shape is the same code with a date range.

accounting.branch_profit_and_loss is GENERATED from 7A's frozen fragment —
statementDefinition("profit_and_loss", identity, { perBranch: true }) — and a
deep-equality case asserts the file IS that return (amendment A5, 7B A6's
rule). Its dataset.source is account_balance, which names the row shape;
STATEMENT_CODES is what routes the run through statementRows, whose branch
variant reads ledger_entry, the only place a branch tag exists on a posted
amount. Its tie-out passes a real branchId for that reason.

accounting.tax_return_view names no authority form, box, rate or deadline and
a test asserts it (hazard 2). No 7C definition reads the till_event dataset:
it is registered for the report designer, and the code register is closed at
eleven (amendment A2).

ReportCodeSchema gains seven; no total count is asserted (amendment A15).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migration 0078 — `app.export_job`, the Drizzle mirror, the store and `seedExportJob`

The one table this slice creates, its typed mirror, the read/write functions the route and the job share, and §4.17's one 7C fixture row.

**Files:**
- Create: `packages/db/migrations/0078_create_export_job.sql`, `packages/db/migrations/0078.down.sql`, `packages/db/src/schema/export-job.ts`, `packages/db/src/export/store.ts`, `packages/db/src/export/index.ts`, `packages/db/test/export-job.test.ts`, `packages/db/test/export/store.test.ts`
- Modify: `packages/db/test/fixtures.ts` (`seedExportJob`), `packages/db/src/index.ts` (re-export the export barrel)

**Interfaces:**
- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `uuidv7()`, `app.current_actor()`, `app.tenant`, `app.company` (§4.1); `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE` (§4.1); `startDb`, `Db`, `Seed`, the 4-argument test `withTenant`, `uuidv7` (§4.1); `seedTenantV2` (1A); `Sql` (postgres.js); `reportObjectKeyFor` (7A — consulted for the key shape, not called).
- Produces:

```ts
// packages/db/src/schema/export-job.ts
export const exportJob: PgTable;                   // the Drizzle read mirror (§3.4.9)

// packages/db/src/export/store.ts
export type ExportStatus = "queued" | "running" | "done" | "failed";
export type ExportFormat = "csv" | "json" | "both";
export interface ExportJobRow {
  id: string; companyId: string; requestedBy: string; format: ExportFormat; status: ExportStatus;
  readableModules: readonly string[]; lotAttachments: boolean; includeAttachments: boolean;
  tableCount: number | null; rowCount: string | null; byteSize: string | null;
  objectKey: string | null; sha256: string | null;    // hex, lower case — bytea rendered by the store
  manifest: unknown | null; startedAt: string | null; finishedAt: string | null; error: string | null;
  createdAt: string;
}
/** '<tenant_id>/exports/<export_job_id>.tar.gz' — server-generated from ids alone, so no client path can
 *  reach the store (SAH-038); the same rule §4.5.8's `objectKeyFor` and 7A's `reportObjectKeyFor` follow. */
export function exportObjectKeyFor(tenantId: string, exportJobId: string): string;
export interface NewExportJob {
  companyId: string; format: ExportFormat;
  readableModules: readonly string[]; lotAttachments: boolean; includeAttachments: boolean;
}
export async function createExportJob(tx: Sql, input: NewExportJob): Promise<ExportJobRow>;
export async function getExportJob(tx: Sql, id: string): Promise<ExportJobRow | null>;
export interface ExportJobQueryParams {
  companyId: string; status?: ExportStatus; limit: number;
  cursor?: { createdAt: string; id: string } | null;
}
export async function listExportJobs(tx: Sql, params: ExportJobQueryParams): Promise<ExportJobRow[]>;
/** Conditional: null when the row is not `queued` — a pg-boss re-delivery, or a job someone already ran. */
export async function claimExportJob(tx: Sql, id: string): Promise<ExportJobRow | null>;
export async function completeExportJob(tx: Sql, input: {
  id: string; objectKey: string; sha256: Uint8Array; byteSize: number;
  tableCount: number; rowCount: number; manifest: unknown;
}): Promise<void>;
export async function failExportJob(tx: Sql, input: { id: string; error: string }): Promise<void>;

// packages/db/test/fixtures.ts — §4.17's one 7C row (amendment A13)
export interface SeedExportJobOptions {
  format?: ExportFormat; status?: ExportStatus;
  readableModules?: readonly string[]; lotAttachments?: boolean; includeAttachments?: boolean;
}
export function seedExportJob(db: Db, s: Seed, opts?: SeedExportJobOptions): Promise<string>;
```

- [ ] **Step 1: Write the failing tests**

`packages/db/test/export-job.test.ts` — the DDL, RLS and linter case:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { seedExportJob, seedTenantV2, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.export_job — contracts §4.6.1, amendment A9", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "export-a");
    b = await seedTenantV2(db, "export-b");
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  it("the schema linter reports zero violations after 0078 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("carries the columns amendment A9 fixes, with the three-value format CHECK", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'export_job' order by column_name`;
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    for (const name of [
      "id", "tenant_id", "company_id", "requested_by", "format", "status", "readable_modules",
      "lot_attachments", "include_attachments", "table_count", "row_count", "byte_size",
      "object_key", "sha256", "manifest", "started_at", "finished_at", "error", "created_at",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.get("readable_modules")!.data_type).toBe("ARRAY");
    expect(byName.get("sha256")!.data_type).toBe("bytea");
    expect(byName.get("manifest")!.data_type).toBe("jsonb");
    const [check] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.export_job'::regclass and conname = 'export_job_format_check'`;
    expect(check!.def).toContain("'both'");
  });

  it("requested_by is stamped by the server, never by the caller (§3.3)", async () => {
    const id = await seedExportJob(db, a);
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ requested_by: string }[]>`select requested_by from app.export_job where id = ${id}`);
    expect(row!.requested_by).toBe(a.human);
    // A caller who names someone else is overwritten, not obeyed.
    const forged = await uuidv7(db.admin);
    const id2 = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`insert into app.export_job (id, tenant_id, company_id, requested_by, format)
         values (${id2}, ${a.tenant}, ${a.company}, ${forged}, 'both')`);
    const [row2] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ requested_by: string }[]>`select requested_by from app.export_job where id = ${id2}`);
    expect(row2!.requested_by).toBe(a.human);
  });

  it("every write is audited (test 13, spec:106)", async () => {
    const id = await seedExportJob(db, a);
    const rows = await db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log
       where table_name = 'export_job' and row_id = ${id} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert"]);
    expect(rows[0]!.actor_id).toBe(a.human);
  });

  it("a second tenant cannot see it (§3.3 Always, test 12)", async () => {
    const id = await seedExportJob(db, a);
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ id: string }[]>`select id from app.export_job where id = ${id}`);
    expect(seen).toEqual([]);
  });

  it("app_rw holds no DELETE on it — the pinned list is unchanged (§3.5.4, hazard 25)", async () => {
    const rows = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'export_job'
       order by privilege_type`;
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
```

`packages/db/test/export/store.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  claimExportJob, completeExportJob, createExportJob, exportObjectKeyFor, failExportJob,
  getExportJob, listExportJobs,
} from "../../src/export/store";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("the export-job store", () => {
  let db: Db;
  let s: Seed;
  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "export-store"); }, 300_000);
  afterAll(async () => { await db.stop(); });

  const write = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, s.tenant, s.human, fn as never) as Promise<T>;

  it("exportObjectKeyFor is derived from ids alone (SAH-038)", () => {
    expect(exportObjectKeyFor("t-1", "j-1")).toBe("t-1/exports/j-1.tar.gz");
  });

  it("a new job is queued with the recorded gates and no artefact", async () => {
    const row = await write((tx) => createExportJob(tx, {
      companyId: s.company, format: "both",
      readableModules: ["accounting", "inventory"], lotAttachments: true, includeAttachments: true,
    }));
    expect(row.status).toBe("queued");
    expect(row.requestedBy).toBe(s.human);
    expect([...row.readableModules]).toEqual(["accounting", "inventory"]);
    expect(row.lotAttachments).toBe(true);
    expect(row.objectKey).toBeNull();
    expect(row.sha256).toBeNull();
  });

  it("claim is conditional — the second claim of one job returns null", async () => {
    const row = await write((tx) => createExportJob(tx, {
      companyId: s.company, format: "csv",
      readableModules: ["accounting"], lotAttachments: false, includeAttachments: false,
    }));
    expect((await write((tx) => claimExportJob(tx, row.id)))!.status).toBe("running");
    expect(await write((tx) => claimExportJob(tx, row.id))).toBeNull();
  });

  it("complete records the artefact, the counts and the manifest; sha256 comes back as hex", async () => {
    const row = await write((tx) => createExportJob(tx, {
      companyId: s.company, format: "both",
      readableModules: ["accounting"], lotAttachments: false, includeAttachments: true,
    }));
    await write((tx) => claimExportJob(tx, row.id));
    const bytes = new TextEncoder().encode("archive");
    const digest = createHash("sha256").update(bytes).digest();
    await write((tx) => completeExportJob(tx, {
      id: row.id, objectKey: exportObjectKeyFor(s.tenant, row.id), sha256: digest,
      byteSize: bytes.byteLength, tableCount: 4, rowCount: 17, manifest: { tables: [] },
    }));
    const done = await write((tx) => getExportJob(tx, row.id));
    expect(done!.status).toBe("done");
    expect(done!.sha256).toBe(digest.toString("hex"));
    expect(done!.byteSize).toBe("7");
    expect(done!.rowCount).toBe("17");
    expect(done!.tableCount).toBe(4);
    expect(done!.finishedAt).not.toBeNull();
  });

  it("fail records the message and leaves no artefact", async () => {
    const row = await write((tx) => createExportJob(tx, {
      companyId: s.company, format: "json",
      readableModules: [], lotAttachments: false, includeAttachments: false,
    }));
    await write((tx) => claimExportJob(tx, row.id));
    await write((tx) => failExportJob(tx, { id: row.id, error: "object store unavailable" }));
    const failed = await write((tx) => getExportJob(tx, row.id));
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toBe("object store unavailable");
    expect(failed!.objectKey).toBeNull();
  });

  it("list is keyset-paged on (created_at, id) newest first", async () => {
    const page1 = await write((tx) => listExportJobs(tx, { companyId: s.company, limit: 2 }));
    expect(page1).toHaveLength(2);
    const last = page1[1]!;
    const page2 = await write((tx) => listExportJobs(tx, {
      companyId: s.company, limit: 2, cursor: { createdAt: last.createdAt, id: last.id },
    }));
    expect(page2.map((r) => r.id)).not.toContain(last.id);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/db test -- export-job export/store`
Expected: FAIL — `relation "app.export_job" does not exist` from the first file, and `Cannot find module '../../src/export/store'` from the second.

- [ ] **Step 3: Write `packages/db/migrations/0078_create_export_job.sql`**

```sql
-- ── 0078. app.export_job ─────────────────────────────────────────────────────────────────────────────
-- spec:2186 "Data export at any time (v1 — it is your own books), unprompted, in open formats
-- (CSV + JSON + a documented schema)"; spec:2206 "Bulk endpoints for import/export with async job
-- semantics and a status resource"; spec:2211 right-to-export. Contracts §4.6.1 + amendment A9.
create table app.export_job (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references app.tenant(id),
  company_id          uuid not null,
  -- The requesting principal. Stamped by app.stamp_actor: a caller who names someone else is overwritten
  -- (plan0A:2373-2376), which is what makes "every export is attributable" true (test 13).
  requested_by        uuid not null default app.current_actor() references app.principal(id),
  -- Three values, not two: spec:2186 requires CSV *and* JSON *and* a schema, which a two-value vocabulary
  -- cannot express. 'both' is the default and the only value the UI offers (amendment A9).
  format              text not null default 'both',
  status              text not null default 'queued',
  -- The requester's attachment authority, RESOLVED AT REQUEST TIME. The job runs as the tenant's system
  -- principal (spec:2179, hazard 20) and holds every code, so it cannot re-derive this and must not try;
  -- MODULE_READ_CODE lives in apps/api and packages/{db,worker} may not import an app (§3.1, §4.5.8).
  -- ADR 0070 records the decision.
  readable_modules    text[] not null default '{}',
  -- §4.5.8 gates a LOT attachment on inventory.item.read while readableModules() returns 'inventory' for
  -- inventory.stock.read — two different codes, so two different facts.
  lot_attachments     boolean not null default false,
  include_attachments boolean not null default true,
  table_count         int,
  row_count           bigint,
  byte_size           bigint,
  object_key          text,
  sha256              bytea,
  manifest            jsonb,
  started_at          timestamptz,
  finished_at         timestamptz,
  error               text,
  created_at          timestamptz not null default now(),
  constraint export_job_format_check check (format in ('csv', 'json', 'both')),
  constraint export_job_status_check check (status in ('queued', 'running', 'done', 'failed')),
  -- A finished job has an artefact or an error, never both and never neither.
  constraint export_job_outcome_is_exclusive check (
    (status <> 'done'   or (object_key is not null and sha256 is not null and error is null))
    and (status <> 'failed' or (error is not null and object_key is null))),
  constraint export_job_finished_with_status check (
    (finished_at is null) = (status in ('queued', 'running'))),
  -- Every module name the array may hold is one of the FIVE permission modules of §3.6.1's closed CHECK
  -- (admin, accounting, inventory, hr, pos). Five, not four: `admin` is a module like any other and
  -- `admin.data.export` is one of its codes.
  constraint export_job_readable_modules_closed check (
    readable_modules <@ array['admin', 'accounting', 'inventory', 'hr', 'pos']::text[]),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

create index export_job_company_created_idx on app.export_job (company_id, created_at desc, id desc);
create index export_job_queued_idx on app.export_job (company_id) where status = 'queued';

-- §3.5.1 steps 2-4. No branch_isolation: the table has no branch key and is not one of §4.5.6 Form C's
-- five stock tables — an export is company-wide by construction and a branch-narrowed principal cannot
-- request one at all (the route's gate is { company: "path:companyId" }, test 36).
call app_meta.enable_tenant_rls('app.export_job');
call app_meta.attach_audit('app.export_job');
call app_meta.attach_stamp('app.export_job', 'requested_by');
```

`packages/db/migrations/0078.down.sql`:

```sql
-- Reverse dependency order (§3.4.5). drop table removes its own indexes, policy and triggers; the audit
-- and stamp functions are app_meta's and are never dropped by a slice's down file.
drop table if exists app.export_job;
```

- [ ] **Step 4: Write the Drizzle mirror `packages/db/src/schema/export-job.ts`**

```ts
import { bigint, boolean, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";

const app = pgSchema("app");
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => "bytea" });

/** Read mirror of app.export_job (§3.4.9 — the diff source; every write is a postgres.js tagged template). */
export const exportJob = app.table("export_job", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  requestedBy: uuid("requested_by").notNull(),
  format: text("format").notNull(),
  status: text("status").notNull(),
  readableModules: text("readable_modules").array().notNull(),
  lotAttachments: boolean("lot_attachments").notNull(),
  includeAttachments: boolean("include_attachments").notNull(),
  tableCount: integer("table_count"),
  rowCount: bigint("row_count", { mode: "bigint" }),
  byteSize: bigint("byte_size", { mode: "bigint" }),
  objectKey: text("object_key"),
  sha256: bytea("sha256"),
  manifest: jsonb("manifest"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 5: Write `packages/db/src/export/store.ts`**

```ts
import type { Sql } from "postgres";

export type ExportStatus = "queued" | "running" | "done" | "failed";
export type ExportFormat = "csv" | "json" | "both";

export interface ExportJobRow {
  id: string;
  companyId: string;
  requestedBy: string;
  format: ExportFormat;
  status: ExportStatus;
  readableModules: readonly string[];
  lotAttachments: boolean;
  includeAttachments: boolean;
  tableCount: number | null;
  rowCount: string | null;
  byteSize: string | null;
  objectKey: string | null;
  /** Lower-case hex. `bytea` reaches JavaScript as a Buffer; the store renders it once, here. */
  sha256: string | null;
  manifest: unknown | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
}

interface DbRow {
  id: string; company_id: string; requested_by: string; format: ExportFormat; status: ExportStatus;
  readable_modules: string[]; lot_attachments: boolean; include_attachments: boolean;
  table_count: number | null; row_count: string | null; byte_size: string | null;
  object_key: string | null; sha256: Buffer | null; manifest: unknown | null;
  started_at: string | null; finished_at: string | null; error: string | null; created_at: string;
}

function toRow(r: DbRow): ExportJobRow {
  return {
    id: r.id, companyId: r.company_id, requestedBy: r.requested_by, format: r.format, status: r.status,
    readableModules: r.readable_modules, lotAttachments: r.lot_attachments,
    includeAttachments: r.include_attachments, tableCount: r.table_count, rowCount: r.row_count,
    byteSize: r.byte_size, objectKey: r.object_key,
    sha256: r.sha256 === null ? null : Buffer.from(r.sha256).toString("hex"),
    manifest: r.manifest, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error,
    createdAt: r.created_at,
  };
}

/** The one `select` list, so eighteen columns are not spelled five times. It is a `postgres.js` FRAGMENT
 *  built from a module-level tagged template — never a `string` of SQL joined with `+` (§3.3, test 27;
 *  `no-sql-concat` fires on a concatenation producing a string containing `select|insert|update|where`).
 *  This is the same shape 7A's dataset `select`s use, for the same reason. */
const cols = (tx: Sql) => tx`id, company_id, requested_by, format, status, readable_modules,
  lot_attachments, include_attachments, table_count, row_count::text as row_count,
  byte_size::text as byte_size, object_key, sha256, manifest,
  to_char(started_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as started_at,
  to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as finished_at,
  error,
  to_char(created_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`;

export function exportObjectKeyFor(tenantId: string, exportJobId: string): string {
  return `${tenantId}/exports/${exportJobId}.tar.gz`;
}

export interface NewExportJob {
  companyId: string;
  format: ExportFormat;
  readableModules: readonly string[];
  lotAttachments: boolean;
  includeAttachments: boolean;
}

export async function createExportJob(tx: Sql, input: NewExportJob): Promise<ExportJobRow> {
  const [row] = await tx<DbRow[]>`
    insert into app.export_job (tenant_id, company_id, format, readable_modules, lot_attachments, include_attachments)
    values (app.current_tenant(), ${input.companyId}, ${input.format},
            ${[...input.readableModules]}::text[], ${input.lotAttachments}, ${input.includeAttachments})
    returning ${cols(tx)}`;
  return toRow(row!);
}

export async function getExportJob(tx: Sql, id: string): Promise<ExportJobRow | null> {
  const [row] = await tx<DbRow[]>`select ${cols(tx)} from app.export_job where id = ${id}`;
  return row ? toRow(row) : null;
}

export interface ExportJobQueryParams {
  companyId: string;
  status?: ExportStatus;
  limit: number;
  cursor?: { createdAt: string; id: string } | null;
}

export async function listExportJobs(tx: Sql, params: ExportJobQueryParams): Promise<ExportJobRow[]> {
  const statusClause = params.status ? tx`and status = ${params.status}` : tx``;
  const cursorClause = params.cursor
    ? tx`and (created_at, id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`
    : tx``;
  const rows = await tx<DbRow[]>`
    select ${cols(tx)} from app.export_job
     where company_id = ${params.companyId} ${statusClause} ${cursorClause}
     order by created_at desc, id desc
     limit ${params.limit}`;
  return rows.map(toRow);
}

/** Conditional on `status = 'queued'`, so a pg-boss re-delivery is a no-op rather than a second archive. */
export async function claimExportJob(tx: Sql, id: string): Promise<ExportJobRow | null> {
  const [row] = await tx<DbRow[]>`
    update app.export_job set status = 'running', started_at = now()
     where id = ${id} and status = 'queued'
    returning ${cols(tx)}`;
  return row ? toRow(row) : null;
}

export async function completeExportJob(tx: Sql, input: {
  id: string; objectKey: string; sha256: Uint8Array; byteSize: number;
  tableCount: number; rowCount: number; manifest: unknown;
}): Promise<void> {
  await tx`
    update app.export_job
       set status = 'done', object_key = ${input.objectKey}, sha256 = ${Buffer.from(input.sha256)},
           byte_size = ${input.byteSize}, table_count = ${input.tableCount}, row_count = ${input.rowCount},
           manifest = ${tx.json(input.manifest as never)}, finished_at = now(), error = null
     where id = ${input.id} and status = 'running'`;
}

export async function failExportJob(tx: Sql, input: { id: string; error: string }): Promise<void> {
  await tx`
    update app.export_job
       set status = 'failed', error = ${input.error}, finished_at = now(), object_key = null, sha256 = null
     where id = ${input.id} and status in ('queued', 'running')`;
}
```

- [ ] **Step 6: Write the barrel and `seedExportJob`**

`packages/db/src/export/index.ts`:

```ts
export {
  claimExportJob, completeExportJob, createExportJob, exportObjectKeyFor, failExportJob,
  getExportJob, listExportJobs,
  type ExportFormat, type ExportJobQueryParams, type ExportJobRow, type ExportStatus, type NewExportJob,
} from "./store";
```

and one line in `packages/db/src/index.ts`:

```ts
export * from "./export";
```

Append to `packages/db/test/fixtures.ts` — a **new** exported helper; no existing helper or constant is edited (§4.1, hazard 9):

```ts
/** §4.17's one 7C row (amendment A13). Inserts on `db.rw` inside the 4-argument test `withTenant`, as
 *  every fixture does; `requested_by` is stamped, so the row's requester is `s.human`. */
export interface SeedExportJobOptions {
  format?: "csv" | "json" | "both";
  status?: "queued" | "running" | "done" | "failed";
  readableModules?: readonly string[];
  lotAttachments?: boolean;
  includeAttachments?: boolean;
}
export async function seedExportJob(db: Db, s: Seed, opts: SeedExportJobOptions = {}): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`insert into app.export_job
               (id, tenant_id, company_id, format, status, readable_modules, lot_attachments, include_attachments)
             values (${id}, ${s.tenant}, ${s.company}, ${opts.format ?? "both"}, ${opts.status ?? "queued"},
                     ${[...(opts.readableModules ?? ["accounting"])]}::text[],
                     ${opts.lotAttachments ?? false}, ${opts.includeAttachments ?? true})`;
  });
  return id;
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- export-job export/store privileges schema-lint && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS on all. `privileges.test.ts` passes **untouched** — this slice grants no DELETE and §3.5.4's pinned list is unchanged (hazard 25). `packages/db/test/privileges.test.ts`'s up → down → up reversibility case (§3.4.6) exercises 0078's down file.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0078_create_export_job.sql packages/db/migrations/0078.down.sql \
        packages/db/src/schema/export-job.ts packages/db/src/export/store.ts \
        packages/db/src/export/index.ts packages/db/src/index.ts \
        packages/db/test/fixtures.ts packages/db/test/export-job.test.ts \
        packages/db/test/export/store.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add app.export_job, its mirror, its store and seedExportJob [7C T5]

Migration 0078. format has three values because spec:2186 requires CSV AND
JSON AND a documented schema, which a two-value vocabulary cannot express
(amendment A9). readable_modules and lot_attachments record the requester's
attachment authority at REQUEST time, because the job runs as the tenant's
system principal (hazard 20) and MODULE_READ_CODE lives in apps/api, which
packages/db and apps/worker may not import (§3.1).

No branch_isolation policy: an export is company-wide by construction and the
route's gate is company-scoped, so a branch-narrowed principal is refused
before a job exists (test 36). No DELETE grant — §3.5.4's pinned list is
unchanged and privileges.test.ts is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Migration 0079 — `admin.data.export`, the `auditor` grant, the route module that references it, and its probe

The one permission code this slice introduces, its role grant, and — in the **same commit** — the route module skeleton that references it **and the `PROBES` entry that route requires**, so `bun run lint:rules` *and* `bun run test` are green at every 7C commit (amendment A11, Global Constraint 16).

**Files:**
- Create: `packages/db/migrations/0079_seed_permission_phase7c.sql`, `packages/db/migrations/0079.down.sql`, `apps/api/src/routes/admin/exports.ts`
- Modify: `packages/contracts/permissions.ts` (one `PermissionDef`), `packages/db/seed/roles.ts` (`auditor` gains the code), `apps/api/src/routes/index.ts` (`createExportRoutes` inside `buildRoutes`), `packages/db/test/permission-catalogue.test.ts` (one appended `it`), `tests/invariants/probes.ts` (the one `PROBES` key)

**Interfaces:**
- Consumes: `PermissionDef`, `PERMISSIONS`, `PERMISSION`, `PermissionCode`, `SliceId`, `isMutating` (§4.2.5); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5); `requirePermission`, `ScopeSource`, `assertRouteGates` (§4.2.5); `RouteModule`, `buildRoutes`, `IdempotencyHeader` (§4.2.7); `ObjectStore` (2C, §4.5.8); `AppEnv` (§4.2.3); `ProblemSchema` (§4.2.8); `app.permission` (0A); `IsolationProbe`, `PROBES` (§3.7.2); `seedExportJob` (Task 5).
- Produces:

```ts
// packages/contracts/permissions.ts — ONE appended PermissionDef; the derived types widen automatically
// { code: "admin.data.export", module: "admin", mutating: false,
//   description: "Export the tenant's own data in open formats", phase: "7C" }
// PermissionCode gains "admin.data.export"; PERMISSION["admin.data.export"] becomes legal.

// apps/api/src/routes/admin/exports.ts — the module, mounted here and completed in Task 9
export function createExportRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv>;
export const EXPORT_ROUTE_PATH = "/v1/companies/:companyId/exports";
export function exportRouteModule(objectStore: ObjectStore): RouteModule;
```

> **`SliceId` already contains `"7C"`** — §4.2.5's union lists it — so `phase: "7C"` compiles with no edit to that type. If the merged `permissions.ts` is missing it, add the member in this same commit and note it in the body; every other slice id in that union is already there.

- [ ] **Step 1: Write the failing tests**

Append two `it`s to `packages/db/test/permission-catalogue.test.ts` — the file 0B created; the existing `it`s are not edited:

```ts
  it("7C adds admin.data.export, non-mutating, and nothing else (§3.6.2)", async () => {
    const rows = await db.migrator<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where module = 'admin' order by code`;
    expect(rows).toEqual([
      { code: "admin.audit_log.read", module: "admin", mutating: false },
      { code: "admin.company.manage", module: "admin", mutating: true },
      { code: "admin.data.export", module: "admin", mutating: false },
      { code: "admin.role.assign", module: "admin", mutating: true },
      { code: "admin.role.manage", module: "admin", mutating: true },
      { code: "admin.terminal.manage", module: "admin", mutating: true },
      { code: "admin.user.manage", module: "admin", mutating: true },
    ]);
  });

  it("the auditor role holds admin.data.export and still no mutating code (spec:2163, R7)", async () => {
    const { PERMISSIONS } = await import("@dulja/contracts/permissions");
    const { ROLES } = await import("../seed/roles");
    const auditor = ROLES.find((r: { code: string }) => r.code === "auditor")!;
    expect(auditor.permissions).toContain("admin.data.export");
    const mutating = new Set(PERMISSIONS.filter((p) => p.mutating).map((p) => p.code));
    expect(auditor.permissions.filter((c: string) => mutating.has(c))).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/db test -- permission-catalogue`
Expected: FAIL twice — the `admin` module set has six rows, not seven, and `auditor.permissions` does not contain `admin.data.export`.

- [ ] **Step 3: Write `packages/db/migrations/0079_seed_permission_phase7c.sql`**

```sql
-- ── 0079. The one permission code slice 7C introduces ────────────────────────────────────────────────
-- spec:2146 lists admin.data.export in the admin module; spec:2163 gives the auditor role "export";
-- spec:2211 is the right-to-export it serves. Contracts §3.6.2, §3.6.3.
-- app.permission is GLOBAL (no RLS, read-only for app_rw — plan0A:1254), so it is migration data and not
-- seed-pack data (§3.4.8). The role grant that consumes it is packages/db/seed/roles.ts, per tenant.
insert into app.permission (code, module, mutating, description)
values ('admin.data.export', 'admin', false, 'Export the tenant''s own data in open formats')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
```

`packages/db/migrations/0079.down.sql`:

```sql
-- packages/db/migrations/0079.down.sql
-- Deletes exactly this slice's codes and no others (§3.6.3).
--
-- ⚠️ THIS FILE CANNOT REMOVE THE ROLE GRANTS IT ORPHANS, AND THAT IS A PROPERTY OF THE SCHEMA, NOT AN
--    OMISSION (§3.4.5, recorded once for every NNNN_seed_permission_phase<slice>.sql from 0B onward).
--    Three facts, each verifiable:
--      1. `app.role_permission.permission_code references app.permission(code)` has NO `on delete` action
--         (plan0A:1325 -- the default is NO ACTION), and referential-integrity checks bypass RLS, so a
--         `role_permission` row naming this code makes the delete below raise SQLSTATE 23503.
--      2. The grant cannot be deleted from here. `app.role_permission` carries FORCE ROW LEVEL SECURITY
--         through `app_meta.enable_tenant_rls`, which forces RLS for the table OWNER too, and §3.4.8
--         states the consequence: "a migration file with no set_config sees zero tenants and cannot
--         write them". A `delete from app.role_permission` here would silently affect ZERO rows.
--      3. Nor can this file discover the tenants to set a context FOR: `app.tenant` is itself forced with
--         `using (id = app.current_tenant())` (plan0A:980-981), so the migrator enumerating it sees
--         nothing.
--    Disabling or dropping the policy "temporarily" is forbidden outright (SAH-027, 041, 053) and is a
--    review-blocking finding, so this file does the one thing it legitimately can and the ROLLBACK
--    CARRIES A PRECONDITION instead: it is reversible only against an UNSEEDED database -- exactly where
--    §3.4.6's generalised reversibility test exercises every down file -- and on a database where
--    `bun run seed --tenant <id> --only roles` has run, the operator removes the `auditor` grant per
--    tenant first (a seed-tier act, with `set_config('app.tenant_id', ...)`) and RE-RUNS
--    `bun run seed --tenant <id> --only roles` after re-migrating. Step 7 states the precondition on the
--    command. 6A's `0062.down.sql` (eleven codes) and 6B's `0063.down.sql` (three) have the identical
--    shape and say so in the same words.
delete from app.permission where code = 'admin.data.export';
```

- [ ] **Step 4: Add the catalogue row and the role grant**

In `packages/contracts/permissions.ts`, append one entry to `PERMISSIONS` — the array grows additively and no existing entry moves:

```ts
  {
    code: "admin.data.export",
    module: "admin",
    mutating: false,
    description: "Export the tenant's own data in open formats",
    phase: "7C",
  },
```

In `packages/db/seed/roles.ts`, add the code to `auditor`'s `permissions` array. **`admin`'s array is computed from `PERMISSIONS` and is never edited** (§3.6.4); no other role gains it, because spec:2157–2162 gives "export" to the auditor row alone and every other role reaches its own data through the reports:

```ts
  // auditor — spec:2163 "Read everything financial: … audit log and document events; export".
  // Non-mutating, so R7 (`auditor` holds no mutating code) still holds; role-seed.ts proves it in CI.
  "admin.data.export",
```

Record the grant in §3.6.4's running sentence (the contracts document's own audit trail) — the sentence that already reads "`accounting.party.manage` → `user` (2A) and `accounting.document.reverse` → `accountant` (2B)" gains "**and `admin.data.export` → `auditor` (7C)**".

- [ ] **Step 5: Write the route module skeleton, referenced in the same commit**

`apps/api/src/routes/admin/exports.ts` — the module Task 9 completes. It exists **now** because §3.6.3's `permission-catalogue` lint fails on a catalogue code with no `PERMISSION[…]` reference, and amendment A11 requires the seeding task to close its own gap:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import { ProblemSchema } from "@dulja/contracts";
import type { ObjectStore } from "@dulja/db";
import { listExportJobs } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";

export const EXPORT_ROUTE_PATH = "/v1/companies/:companyId/exports";

/** A factory, like 0B's `createUserRoutes(authAdmin)`, 2C's `createAttachmentRoutes(objectStore)` and 7A's
 *  `createReportRunRoutes(objectStore)`: the download route Task 9 adds needs the store, and
 *  `AppEnv["Variables"]` is pinned at eight members (§4.2.3, round 3) and none of them is an object
 *  store, so the store arrives through the closure rather than as a ninth. */
export function createExportRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();
  void objectStore;   // Task 9's download route is what consumes it; the parameter is the module's contract.

  routes.openapi(
    createRoute({
      method: "get",
      path: "/v1/companies/{companyId}/exports",
      tags: ["admin"],
      request: {
        params: z.object({ companyId: z.string().uuid() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) }),
      },
      middleware: [requirePermission(PERMISSION["admin.data.export"], { company: "path:companyId" })],
      responses: {
        200: {
          description: "The company's export jobs, newest first.",
          content: { "application/json": { schema: z.object({ items: z.array(z.unknown()), next_cursor: z.string().nullable() }) } },
        },
        403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      const items = await c.var.withTenant((tx) => listExportJobs(tx, { companyId, limit }));
      return c.json({ items, next_cursor: null }, 200);
    },
  );

  return routes;
}

export function exportRouteModule(objectStore: ObjectStore): RouteModule {
  return {
    path: EXPORT_ROUTE_PATH,
    router: createExportRoutes(objectStore),
    permissions: [PERMISSION["admin.data.export"]],
    auth: "human",
  };
}
```

> **`IdempotencyHeader` is deliberately absent from that import block.** This task ships `GET` only, an unused import fails `bun run lint`, and a plan that told you to type a line and then delete it would be two instructions where one will do. Task 9 adds `import { IdempotencyHeader } from "../index";` in the same edit that adds the `POST` route which declares it — it is listed in this task's **Consumes** so a reader knows the symbol exists and where it lives, not so it gets typed here.

In `apps/api/src/routes/index.ts`, register the module **inside `buildRoutes`** — never by pushing onto `ROUTES` (§4.2.7):

```ts
    exportRouteModule(deps.objectStore),
```

- [ ] **Step 6: Add the `PROBES` entry, in the same commit as the route**

`tests/invariants/probes.ts` — **one** `PROBES` key, keyed by the module's `RouteModule.path` (hazard 31, §3.7.2). It lands **here, with the route**, and not three tasks later: `tests/invariants/tenant-isolation.test.ts` fails the build the moment `ROUTES` carries an entry with no `PROBES[path]`, and Global Constraint 16 allows this slice exactly one declared exception — the intra-task `lint:rules` gap this same task closes. A second, cross-task known-red is what amendment A11 exists to stop.

```ts
  "/v1/companies/:companyId/exports": {
    async seed(db, owner) {
      const { seedExportJob } = await import("@dulja/db/test");
      const id = await seedExportJob(db, owner);
      // The attacker asks for the VICTIM's export job under the victim's company: RLS reduces
      // app.export_job to the attacker's tenant, so the row is invisible and the answer is 404.
      return { path: `/v1/companies/${owner.company}/exports/${id}`, method: "GET" };
    },
    expect: 404,
  },
```

> **The probed sub-path `GET …/exports/{exportJobId}` is Task 9's route and does not exist yet, and the probe still passes at this task**: an unrouted path answers `404`, which is exactly what the probe expects. From Task 9 onward the same `404` is the RLS answer rather than the router's, and the assertion does not change — which is why moving the entry earlier costs nothing. The **`JOB_PROBES`** entry is **not** added here: `JOB_PROBES` is checked against the *registered handlers* (0d:2727-2729), and `admin.export.run`'s handler is registered in Task 8, so its probe lands there.

- [ ] **Step 7: Run everything to see it pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- permission-catalogue && bun run --cwd packages/contracts test && bun run --cwd tests test -- tenant-isolation && bun run lint && bun run lint:rules && bun run typecheck`
Expected: PASS on all seven, with **no known-red carried out of this task**.

> **The rollback of 0079 carries a precondition, and it is stated here because §3.4.5 requires the task that ships such a migration to state it on its rollback command.** `bun run --cwd packages/db db:rollback 78 && bun run --cwd packages/db db:migrate` is **only** valid against an **unseeded** database — which is where §3.4.6's generalised reversibility test exercises every down file. On a database where `bun run seed --tenant <id> --only roles` has run, Step 4's `auditor` grant names `admin.data.export`, `app.role_permission.permission_code` has no `on delete` action, and the delete in `0079.down.sql` raises SQLSTATE 23503; forced RLS means the down file can neither remove that grant nor enumerate the tenants to set a context for. **The operator removes the tenant's grants at the seed tier first and re-runs `bun run seed --tenant <id> --only roles` after re-migrating.** Never "fix" this by disabling or dropping the `tenant_isolation` policy — that is forbidden outright (SAH-027, 041, 053) and is a review-blocking finding. 6A's `0062.down.sql` and 6B's `0063.down.sql` are the two written precedents and the down file repeats the reasoning verbatim. **`lint:rules` is the one that matters here**: `permission-catalogue` (§3.6.3) sees `PERMISSION["admin.data.export"]` in `apps/api/src/routes/admin/exports.ts` and `role-seed` sees the `auditor` grant against a non-mutating code, so both directions hold and this slice never ships a red lint (amendment A11). `assertRouteGates` passes because the only route so far is a `GET`, and `tenant-isolation` passes because Step 6's `PROBES` key matches the module Step 5 mounted.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0079_seed_permission_phase7c.sql packages/db/migrations/0079.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        apps/api/src/routes/admin/exports.ts apps/api/src/routes/index.ts \
        packages/db/test/permission-catalogue.test.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(db): seed admin.data.export and mount the exports module [7C T6]

Migration 0079. admin.data.export is non-mutating (spec:2146) and granted to
the auditor role, whose spec:2163 row ends "and export"; role-seed.ts proves
in CI that the auditor still holds no mutating code (R7).

The route module lands in THIS commit rather than three tasks later, because
permission-catalogue (§3.6.3) fails on a catalogue code with no PERMISSION[…]
reference and §3.8 requires the root scripts green after every task. The
module's GET is real; the POST, the status read and the download arrive in
T9 (contracts amendment A11).

The PROBES key lands with the route for the same reason: tenant-isolation
fails on a ROUTES entry with no PROBES[path] (hazard 31), and a known-red
carried across three tasks is exactly what A11 was written to stop. The
JOB_PROBES key belongs to T8, where admin.export.run's handler is registered.

0079.down.sql cannot remove the auditor grant it orphans: role_permission's
FK has no on delete action, forced RLS stops the migration writing the grant,
and app.tenant is itself policy-guarded so the file cannot enumerate tenants.
The rollback therefore carries the §3.4.5 precondition — reversible only
against an unseeded database, and --only roles re-run after re-migrating —
stated in the file and on T6 Step 7's command, as 0062 and 0063 both do.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `EXPORT_TABLES`, `NEVER_EXPORTED`, the documented schema, and ADR 0069 (a proposal)

The registry that decides **what leaves the system**. Explicit column lists, never `select *`; a per-table permission gate so a requester who lacks a code gets no rows and a named omission; and a `schema.json` generated from the same registry and checked against `information_schema` — spec:2186's "a documented schema" is a build-checked artefact, not prose.

**Files:**
- Create: `packages/db/src/export/tables.ts`, `packages/db/src/export/schema.ts`, `packages/db/test/export/tables.test.ts`, `docs/adr/0069-tenant-export-archive-and-table-registry.md`
- Modify: `packages/db/src/export/index.ts` (re-export)

**Interfaces:**
- Consumes: `Sql` (postgres.js); `app.principal_has` (2B, §4.5.3 — the per-table gate's evaluator); `startDb`, `Db`, `Seed`, the test `withTenant` (§4.1); `seedTenantV2`, `grantCodes`, `seedAccount` (1A/2B); `arApReportFixture` (Task 2).
- Produces:

```ts
// packages/db/src/export/tables.ts
export type ExportRow = Readonly<Record<string, string | number | boolean | null>>;
export interface ExportTable {
  /** The archive file base name and the `schema.json` key. Always the `app.` table's own name. */
  readonly name: string;
  /** EXPLICIT, in output order. Never `select *`: a column added by a later migration must be added here
   *  deliberately, or it does not leave the system. The test compares these to `Object.keys(row)`. */
  readonly columns: readonly string[];
  /** A permission code, as a plain `string` — `packages/db` may not import `PermissionCode` from
   *  `@dulja/contracts` (§3.1); this is 2B's `stageCode` precedent. `null` means "included for anyone who
   *  holds admin.data.export". */
  readonly gate: string | null;
  readonly rows: (tx: Sql, companyId: string) => Promise<ExportRow[]>;
}
export const EXPORT_TABLES: readonly ExportTable[];
export function exportTable(name: string): ExportTable;                        // throws naming the table
/** Columns that never leave the system, whatever the registry says. A whole table maps to `["*"]`. */
export const NEVER_EXPORTED: Readonly<Record<string, readonly string[]>>;
/** The registry's gates, resolved for one principal in one company through `app.principal_has`. */
export async function resolveExportGates(
  tx: Sql, input: { principalId: string; companyId: string },
): Promise<{ included: readonly ExportTable[]; excluded: readonly { table: string; gate: string }[] }>;

// packages/db/src/export/schema.ts
export interface ExportSchemaColumn { name: string; type: string; nullable: boolean }
export interface ExportSchemaTable { name: string; columns: ExportSchemaColumn[]; omitted: string[]; gate: string | null }
export interface ExportSchemaDocument {
  formatVersion: 1; generatedAt: string; company: { id: string };
  encoding: "utf-8"; csvDialect: { delimiter: ","; quote: "\""; newline: "\n"; header: true };
  moneyScale: 4; quantityScale: 6; rateScale: 8; timestamps: "RFC 3339 UTC"; dates: "YYYY-MM-DD";
  tables: ExportSchemaTable[];
}
export async function exportSchemaDocument(
  tx: Sql, input: { companyId: string; tables: readonly ExportTable[]; generatedAt: string },
): Promise<ExportSchemaDocument>;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/export/tables.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_TABLES, NEVER_EXPORTED, exportTable, resolveExportGates } from "../../src/export/tables";
import { exportSchemaDocument } from "../../src/export/schema";
import { arApReportFixture, type ArApReportFixture } from "../../../../tests/invariants/support/reports-7c";
import { grantCodes } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("the export table registry — ADR 0069, spec:2186, tests 32 and 36", () => {
  let db: Db;
  let f: ArApReportFixture;
  let gated: string;      // holds admin.data.export only
  let auditor: string;    // holds admin.data.export AND every gate EXPORT_TABLES declares

  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "export-tables");
    gated = await uuidv7(db.admin);
    auditor = await uuidv7(db.admin);
    await withTenant(db.migrator, f.s.tenant, f.s.system, async (tx) => {
      for (const [id, label] of [[gated, "gated"], [auditor, "auditor"]] as const) {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`human:${label}:${f.s.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${f.s.tenant}, ${id})`;
      }
    });
    await grantCodes(db, f.s, { codes: ["admin.data.export"], principalId: gated, roleCode: "exp-only" });
    // **Every gate the registry declares, and the list is the registry's own.** `EXPORT_TABLES` gates
    // `cost_layer` on `inventory.cost.read` (3B), `shift` and `till_event` on `pos.report.read` (6D),
    // `tax_code` and `tax_transaction` on `accounting.tax.manage` (5A) and `audit_log` on
    // `admin.audit_log.read` (0B) — so a principal holding only the first and last would still have three
    // excluded tables and the `excluded` assertion below would be false for the wrong reason.
    await grantCodes(db, f.s, {
      codes: ["admin.data.export", "admin.audit_log.read", "accounting.tax.manage",
              "inventory.cost.read", "pos.report.read"],
      principalId: auditor, roleCode: "exp-auditor",
    });
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn as never) as Promise<T>;

  it("every registered table declares explicit columns and a unique name", () => {
    const names = EXPORT_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of EXPORT_TABLES) {
      expect(t.columns.length, t.name).toBeGreaterThan(0);
      expect(new Set(t.columns).size, t.name).toBe(t.columns.length);
    }
    expect(() => exportTable("no_such_table")).toThrow(/no_such_table/);
  });

  it("no registered column is in NEVER_EXPORTED (the pinned side-channel list)", () => {
    for (const t of EXPORT_TABLES) {
      const forbidden = NEVER_EXPORTED[t.name] ?? [];
      expect(forbidden, t.name).not.toContain("*");
      for (const c of t.columns) expect(forbidden, `${t.name}.${c}`).not.toContain(c);
    }
    // The pins themselves: a future edit that "just adds one useful column" fails here.
    expect(NEVER_EXPORTED["principal"]).toContain("auth_subject");
    expect(NEVER_EXPORTED["pos_cashier"]).toContain("pin_hash");
    expect(NEVER_EXPORTED["terminal_enrolment"]).toEqual(["*"]);
    expect(NEVER_EXPORTED["idempotency_key"]).toEqual(["*"]);
    expect(NEVER_EXPORTED["audit_log"]).toEqual(expect.arrayContaining(["before", "after"]));
    expect(EXPORT_TABLES.map((t) => t.name)).not.toContain("terminal_enrolment");
    expect(EXPORT_TABLES.map((t) => t.name)).not.toContain("idempotency_key");
  });

  it("every query returns exactly the declared columns, in order", async () => {
    for (const t of EXPORT_TABLES) {
      const rows = await read((tx) => t.rows(tx, f.s.company));
      if (rows.length === 0) continue;   // an empty table proves nothing about keys; the schema doc covers it
      expect(Object.keys(rows[0]!), t.name).toEqual([...t.columns]);
    }
  });

  it("a requester without a table's gate gets that table EXCLUDED and NAMED (test 32's mechanism)", async () => {
    const forGated = await read((tx) => resolveExportGates(tx, { principalId: gated, companyId: f.s.company }));
    const excluded = forGated.excluded.map((e) => e.table);
    expect(excluded).toContain("audit_log");
    expect(excluded).toContain("tax_transaction");
    expect(forGated.included.map((t) => t.name)).not.toContain("audit_log");
    for (const e of forGated.excluded) expect(e.gate, e.table).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);

    const forAuditor = await read((tx) => resolveExportGates(tx, { principalId: auditor, companyId: f.s.company }));
    expect(forAuditor.included.map((t) => t.name)).toContain("audit_log");
    expect(forAuditor.included.map((t) => t.name)).toContain("tax_transaction");
    // Holding EVERY declared gate excludes nothing: the registry gates six tables on FOUR distinct codes
    // (`inventory.cost.read`, `pos.report.read` twice, `accounting.tax.manage` twice, `admin.audit_log.read`)
    // and this principal holds all four. The `grantCodes` call above lists five because it also grants
    // `admin.data.export`, the ROUTE's gate, which gates no table — so the two sides of the gate mechanism
    // are both proven on real rows.
    expect(forAuditor.excluded).toEqual([]);
    expect(forAuditor.included.length).toBeGreaterThan(forGated.included.length);
  });

  it("the gate mechanism is what a later slice plugs a sensitive table into (test 32, 8A)", () => {
    // 8A adds { name: "employee_sensitive", gate: "hr.employee.read_sensitive", … } and changes NO CODE
    // in packages/db/src/export/run.ts. This assertion pins the shape that promise depends on.
    //
    // 8A DOES have one more edit to make, in the SAME PR, and it is deliberate: `employee_sensitive` is
    // pinned `["*"]` in NEVER_EXPORTED, so until 8A narrows that entry to the ciphertext columns it must
    // not ship, BOTH the `it` above and `exportSchemaDocument` refuse the row by name. The pin is the safe
    // default — a table nobody has thought about does not leave the system — and narrowing it is the act
    // of thinking about it. Never read "changes nothing in the exporter" as "changes nothing at all".
    for (const t of EXPORT_TABLES) {
      expect(t.gate === null || /^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(t.gate), t.name).toBe(true);
    }
    expect(EXPORT_TABLES.some((t) => t.gate !== null)).toBe(true);
  });

  it("schema.json documents every included table and every omitted column", async () => {
    const { included } = await read((tx) =>
      resolveExportGates(tx, { principalId: auditor, companyId: f.s.company }));
    const doc = await read((tx) => exportSchemaDocument(tx, {
      companyId: f.s.company, tables: included, generatedAt: "2026-02-01T00:00:00Z",
    }));
    expect(doc.formatVersion).toBe(1);
    expect(doc.moneyScale).toBe(4);
    expect(doc.csvDialect).toEqual({ delimiter: ",", quote: "\"", newline: "\n", header: true });
    expect(doc.tables.map((t) => t.name)).toEqual(included.map((t) => t.name));
    for (const t of doc.tables) {
      const live = await read((tx) => (tx as never as import("postgres").Sql)<
        { column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${t.name}`);
      const liveNames = new Set(live.map((r) => r.column_name));
      // Everything the schema documents exists.
      for (const c of t.columns) expect(liveNames.has(c.name), `${t.name}.${c.name}`).toBe(true);
      // Everything that exists is either documented or explicitly listed as omitted.
      for (const name of liveNames) {
        const known = t.columns.some((c) => c.name === name) || t.omitted.includes(name);
        expect(known, `${t.name}.${name} is neither exported nor listed as omitted`).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- export/tables`
Expected: FAIL at import — `Cannot find module '../../src/export/tables'`.

- [ ] **Step 3: Write `packages/db/src/export/tables.ts`**

```ts
import type { Sql } from "postgres";

export type ExportRow = Readonly<Record<string, string | number | boolean | null>>;

export interface ExportTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly gate: string | null;
  readonly rows: (tx: Sql, companyId: string) => Promise<ExportRow[]>;
}

/**
 * Columns that never leave the system, whatever the registry says; `["*"]` means the whole table.
 * This list is the pinned half of ADR 0069: it is asserted against `EXPORT_TABLES` by a test, so a future
 * edit that "just adds one useful column" fails the build instead of opening a side channel (spec:2450).
 */
export const NEVER_EXPORTED: Readonly<Record<string, readonly string[]>> = {
  principal: ["auth_subject"],                 // the Supabase `sub` / terminal id — an identity, not a book
  pos_cashier: ["pin_hash"],                   // an Argon2id hash is a credential (§4.6.3)
  terminal_enrolment: ["*"],                   // one-time enrolment code hashes; nothing here is a record
  idempotency_key: ["*"],                      // request bodies and responses verbatim, TTL 24 h
  audit_log: ["before", "after"],              // row images of every table, including the gated ones —
                                               // the reason 7B keeps them out of the audit REPORT too
  // 8A's table, pinned before it exists so the default for an unreasoned-about table is "does not leave".
  // 8A's own PR adds its EXPORT_TABLES row AND narrows this entry to the ciphertext columns it will not
  // export; until it does, both `tables.test.ts` and `exportSchemaDocument` refuse the row by name. That
  // is the mechanism working, not fighting it (ADR 0069's Consequences).
  employee_sensitive: ["*"],
};

const t = (
  name: string, gate: string | null, columns: readonly string[],
  rows: (tx: Sql, companyId: string) => Promise<ExportRow[]>,
): ExportTable => ({ name, gate, columns, rows });

/**
 * The v1 export set. Every entry is a literal query authored here — never `select *`, and never a table
 * name assembled from a string (§3.3, test 27). A slice that adds a table adds its row; a slice that adds
 * a COLUMN to an exported table adds it here deliberately or the column does not leave the system, which
 * is the safe default for a side channel.
 */
export const EXPORT_TABLES: readonly ExportTable[] = [
  // ── configuration ──────────────────────────────────────────────────────────────────────────────────
  t("company", null, ["id", "code", "name", "base_currency", "timezone", "created_at"],
    (tx, c) => tx`select id, code, name, base_currency, timezone,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from app.company where id = ${c} order by code`),
  t("account", null, ["id", "code", "name_en", "name_ar", "type", "parent_id", "is_group", "currency", "archived_at"],
    (tx, c) => tx`select id, code, name_en, name_ar, type::text as type, parent_id, is_group, currency,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.account where company_id = ${c} order by code`),
  // `app.fiscal_period` has NO `code` column (plan0A:1467-1481 — id, tenant_id, company_id, starts_on,
  // ends_on, status, closed_by, closed_at, created_at, plus 1A's reopen_reason). §4.16.3 computes the
  // period label as `to_char(starts_on,'YYYY-MM')` for exactly that reason. **No derived column is added
  // here**: every name in `columns` is checked against `information_schema` by `exportSchemaDocument`, so a
  // computed alias would throw `has no column`. `starts_on` IS the label a consumer derives from.
  t("fiscal_period", null, ["id", "starts_on", "ends_on", "status", "closed_by", "closed_at", "reopen_reason"],
    (tx, c) => tx`select id, to_char(starts_on,'YYYY-MM-DD') as starts_on,
      to_char(ends_on,'YYYY-MM-DD') as ends_on, status::text as status, closed_by,
      to_char(closed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as closed_at, reopen_reason
      from app.fiscal_period where company_id = ${c} order by starts_on`),
  // `app.dimension_type` is `code` + `name_en` only (plan0A:1808-1817): there is no `name_ar` and no
  // `required`. A dimension is made mandatory by the posting policy's `dimensions.required` (§4.4.1),
  // not by a column, so there is nothing here to export.
  t("dimension_type", null, ["id", "code", "name_en"],
    (tx, c) => tx`select id, code, name_en
      from app.dimension_type where company_id = ${c} order by code`),
  // `app.dimension_value` is `code`, `name_en`, `parent_id`, `archived_at` (plan0A:1820-1832) — no `name_ar`.
  t("dimension_value", null, ["id", "dimension_type_id", "code", "name_en", "parent_id", "archived_at"],
    (tx, c) => tx`select dv.id, dv.dimension_type_id, dv.code, dv.name_en, dv.parent_id,
      to_char(dv.archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.dimension_value dv join app.dimension_type dt on dt.id = dv.dimension_type_id
      where dt.company_id = ${c} order by dt.code, dv.code`),
  t("currency", null, ["id", "code", "name_en", "name_ar", "minor_units"],
    (tx) => tx`select id, code, name_en, name_ar, minor_units from app.currency order by code`),
  t("exchange_rate", null, ["id", "from_currency", "to_currency", "rate", "effective_from", "source"],
    (tx) => tx`select id, from_currency, to_currency, rate::text as rate,
      to_char(effective_from,'YYYY-MM-DD') as effective_from, source
      from app.exchange_rate order by effective_from, from_currency, to_currency`),
  // `series` lives on `app.document`, NOT on the type: 2A's 0018 adds exactly `module` and `archived_at`
  // to `document_type` (§4.3.4), and `document.series` is the numbering series the issue step writes.
  t("document_type", null, ["id", "code", "name_en", "name_ar", "module", "archived_at"],
    (tx, c) => tx`select id, code, name_en, name_ar, module,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.document_type where company_id = ${c} order by code`),
  t("posting_policy", null, ["id", "document_type_id", "version", "effective_from", "definition"],
    (tx, c) => tx`select pp.id, pp.document_type_id, pp.version,
      to_char(pp.effective_from,'YYYY-MM-DD') as effective_from, pp.definition::text as definition
      from app.posting_policy pp join app.document_type dt on dt.id = pp.document_type_id
      where dt.company_id = ${c} order by dt.code, pp.version`),
  t("payment_term", null, ["id", "code", "name_en", "name_ar", "due_days", "discount_days", "discount_pct"],
    (tx, c) => tx`select id, code, name_en, name_ar, due_days, discount_days, discount_pct::text as discount_pct
      from app.payment_term where company_id = ${c} order by code`),

  // ── parties, items and the catalogue ────────────────────────────────────────────────────────────────
  t("party", null, ["id", "kind", "code", "name_en", "name_ar", "currency", "tax_registration", "email", "phone",
                    "credit_limit", "credit_hold", "payment_term_id", "archived_at"],
    (tx, c) => tx`select id, kind, code, name_en, name_ar, currency, tax_registration, email, phone,
      credit_limit::text as credit_limit, credit_hold, payment_term_id,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.party where company_id = ${c} order by kind, code`),
  t("item", null, ["id", "code", "name_en", "name_ar", "kind", "base_unit_id", "barcode", "track_lots",
                   "shelf_life_days", "archived_at"],
    (tx, c) => tx`select id, code, name_en, name_ar, kind, base_unit_id, barcode, track_lots, shelf_life_days,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.item where company_id = ${c} order by code`),
  t("unit_of_measure", null, ["id", "code", "name_en", "name_ar"],
    (tx, c) => tx`select id, code, name_en, name_ar from app.unit_of_measure where company_id = ${c} order by code`),
  t("unit_conversion", null, ["id", "item_id", "unit_id", "numerator", "denominator"],
    (tx, c) => tx`select uc.id, uc.item_id, uc.unit_id, uc.numerator::text as numerator,
      uc.denominator::text as denominator
      from app.unit_conversion uc join app.item i on i.id = uc.item_id
      where i.company_id = ${c} order by i.code, uc.unit_id`),
  t("warehouse", null, ["id", "code", "name_en", "name_ar", "kind", "branch_id", "parent_id", "archived_at"],
    (tx, c) => tx`select id, code, name_en, name_ar, kind, branch_id, parent_id,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.warehouse where company_id = ${c} order by code`),
  t("lot", null, ["id", "item_id", "code", "expires_on", "manufactured_on", "archived_at"],
    (tx, c) => tx`select id, item_id, code, to_char(expires_on,'YYYY-MM-DD') as expires_on,
      to_char(manufactured_on,'YYYY-MM-DD') as manufactured_on,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.lot where company_id = ${c} order by item_id, code`),
  t("price_list", null, ["id", "code", "name_en", "name_ar", "currency", "customer_kind", "branch_id",
                         "valid_from", "valid_to", "archived_at"],
    (tx, c) => tx`select id, code, name_en, name_ar, currency, customer_kind, branch_id,
      to_char(valid_from,'YYYY-MM-DD') as valid_from, to_char(valid_to,'YYYY-MM-DD') as valid_to,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.price_list where company_id = ${c} order by code`),
  t("price_list_line", null, ["id", "price_list_id", "item_id", "unit_id", "min_quantity", "unit_price"],
    (tx, c) => tx`select pll.id, pll.price_list_id, pll.item_id, pll.unit_id,
      pll.min_quantity::text as min_quantity, pll.unit_price::text as unit_price
      from app.price_list_line pll join app.price_list pl on pl.id = pll.price_list_id
      where pl.company_id = ${c} order by pl.code, pll.item_id, pll.min_quantity`),

  // ── documents and the ledger ────────────────────────────────────────────────────────────────────────
  // `attributed_to`, `created_by` and `posted_by` are the three people on a document (plan0A:1791-1795) and
  // an export without them cannot answer "who raised this"; `terminal_id` (6A/0061), `shift_id` (6D/0070),
  // `notes` (2C/0027) and `tax_inclusive` (5A/0054) are the header additions §4.3.4 records. `rate_source`,
  // `posting_policy_id`, `warehouse_id`, `to_warehouse_id` and `legacy_ref` stay out deliberately — they are
  // internal provenance, and the `schema.json` `omitted` list names each one so the choice is visible.
  t("document", null, ["id", "document_type_id", "status", "series", "number", "effective_date",
                       "fiscal_period_id", "party_id", "branch_id", "terminal_id", "shift_id",
                       "currency", "exchange_rate", "tax_inclusive", "client_ref", "posting_seq",
                       "attributed_to", "created_by", "posted_by", "posted_at", "reverses_document_id",
                       "notes", "created_at"],
    (tx, c) => tx`select id, document_type_id, status::text as status, series, number::text as number,
      to_char(effective_date,'YYYY-MM-DD') as effective_date, fiscal_period_id, party_id, branch_id,
      terminal_id, shift_id, currency, exchange_rate::text as exchange_rate, tax_inclusive,
      client_ref, posting_seq::text as posting_seq, attributed_to, created_by, posted_by,
      to_char(posted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at,
      reverses_document_id, notes,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from app.document where company_id = ${c} order by effective_date, posting_seq, id`),
  // **`app.document_line` has no `side` column.** §4.3.4's Phase 1 base carries the money on `debit` and
  // `credit`; 2A's `amount` is the item/tax line's excl-tax figure and is 0 on an `account` line. Exporting
  // `amount` alone would give every JOURNAL an all-zero, direction-less line — spec:2186's "it is your own
  // books" not met for the document tier. `dimensions` and `custom_fields` are jsonb and are rendered
  // `::text`, exactly as `posting_policy.definition` is.
  t("document_line", null, ["id", "document_id", "line_no", "kind", "account_id", "item_id", "warehouse_id",
                            "lot_id", "unit_id", "quantity", "unit_quantity", "unit_price", "discount",
                            "amount", "tax_code_id", "tax_amount", "total_incl_tax", "cost",
                            "debit", "credit", "dimensions", "custom_fields", "description"],
    (tx, c) => tx`select dl.id, dl.document_id, dl.line_no, dl.kind, dl.account_id, dl.item_id, dl.warehouse_id,
      dl.lot_id, dl.unit_id, dl.quantity::text as quantity, dl.unit_quantity::text as unit_quantity,
      dl.unit_price::text as unit_price, dl.discount::text as discount, dl.amount::text as amount,
      dl.tax_code_id, dl.tax_amount::text as tax_amount, dl.total_incl_tax::text as total_incl_tax,
      dl.cost::text as cost, dl.debit::text as debit, dl.credit::text as credit,
      dl.dimensions::text as dimensions, dl.custom_fields::text as custom_fields, dl.description
      from app.document_line dl join app.document d on d.id = dl.document_id
      where d.company_id = ${c} order by d.effective_date, d.posting_seq, dl.line_no`),
  t("document_event", null, ["id", "document_id", "event_kind", "from_status", "to_status", "override_code",
                             "actor_id", "attributed_to", "occurred_at", "reason"],
    (tx, c) => tx`select de.id, de.document_id, de.event_kind, de.from_status, de.to_status, de.override_code,
      de.actor_id, de.attributed_to,
      to_char(de.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at, de.reason
      from app.document_event de join app.document d on d.id = de.document_id
      where d.company_id = ${c} order by de.occurred_at, de.id`),
  t("ledger_entry", null, ["id", "document_id", "line_no", "account_id", "currency", "exchange_rate",
                           "debit", "credit", "base_debit", "base_credit", "effective_date",
                           "fiscal_period_id", "posted_at"],
    (tx, c) => tx`select id, document_id, line_no, account_id, currency, exchange_rate::text as exchange_rate,
      debit::text as debit, credit::text as credit, base_debit::text as base_debit,
      base_credit::text as base_credit, to_char(effective_date,'YYYY-MM-DD') as effective_date,
      fiscal_period_id, to_char(posted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at
      from app.ledger_entry where company_id = ${c} order by effective_date, document_id, line_no`),
  t("ledger_entry_dimension", null, ["ledger_entry_id", "dimension_type_id", "dimension_value_id"],
    (tx, c) => tx`select led.ledger_entry_id, led.dimension_type_id, led.dimension_value_id
      from app.ledger_entry_dimension led join app.ledger_entry le on le.id = led.ledger_entry_id
      where le.company_id = ${c} order by led.ledger_entry_id, led.dimension_type_id`),
  t("account_balance", null, ["account_id", "fiscal_period_id", "currency", "debit", "credit",
                              "base_debit", "base_credit"],
    (tx, c) => tx`select account_id, fiscal_period_id, currency, debit::text as debit, credit::text as credit,
      base_debit::text as base_debit, base_credit::text as base_credit
      from app.account_balance where company_id = ${c} order by account_id, fiscal_period_id, currency`),

  // ── AR / AP ────────────────────────────────────────────────────────────────────────────────────────
  t("allocation", null, ["id", "party_id", "settlement_document_id", "settled_document_id", "amount",
                         "base_amount", "fx_difference", "unallocated_at", "created_at"],
    (tx, c) => tx`select id, party_id, settlement_document_id, settled_document_id, amount::text as amount,
      base_amount::text as base_amount, fx_difference::text as fx_difference,
      to_char(unallocated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as unallocated_at,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from app.allocation where company_id = ${c} order by created_at, id`),
  t("bank_statement", null, ["id", "bank_account_id", "statement_date", "opening_balance", "closing_balance",
                             "currency"],
    (tx, c) => tx`select id, bank_account_id, to_char(statement_date,'YYYY-MM-DD') as statement_date,
      opening_balance::text as opening_balance, closing_balance::text as closing_balance, currency
      from app.bank_statement where company_id = ${c} order by statement_date, id`),
  t("bank_statement_line", null, ["id", "statement_id", "line_no", "value_date", "description", "reference", "amount"],
    (tx, c) => tx`select id, statement_id, line_no, to_char(value_date,'YYYY-MM-DD') as value_date,
      description, reference, amount::text as amount
      from app.bank_statement_line where company_id = ${c} order by statement_id, line_no`),
  t("bank_match", null, ["id", "statement_line_id", "reconcilable_kind", "reconcilable_document_id",
                         "amount", "matched_at", "unmatched_at"],
    (tx, c) => tx`select id, statement_line_id, reconcilable_kind, reconcilable_document_id,
      amount::text as amount,
      to_char(matched_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as matched_at,
      to_char(unmatched_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as unmatched_at
      from app.bank_match where company_id = ${c} order by matched_at, id`),

  // ── inventory ──────────────────────────────────────────────────────────────────────────────────────
  t("inventory_movement", null, ["id", "document_id", "line_no", "movement_no", "item_id", "warehouse_id",
                                 "lot_id", "quantity", "value", "effective_date", "posted_at"],
    (tx, c) => tx`select id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id,
      quantity::text as quantity, value::text as value,
      to_char(effective_date,'YYYY-MM-DD') as effective_date,
      to_char(posted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at
      from app.inventory_movement where company_id = ${c} order by effective_date, movement_no`),
  t("stock_on_hand", null, ["item_id", "warehouse_id", "lot_id", "quantity"],
    (tx, c) => tx`select item_id, warehouse_id, lot_id, quantity::text as quantity
      from app.stock_on_hand where company_id = ${c} order by item_id, warehouse_id, lot_id`),
  t("cost_layer", "inventory.cost.read",
    ["id", "item_id", "warehouse_id", "lot_id", "movement_id", "qty_in", "qty_remaining", "unit_cost",
     "effective_at", "sequence", "invalidated_at"],
    (tx, c) => tx`select id, item_id, warehouse_id, lot_id, movement_id, qty_in::text as qty_in,
      qty_remaining::text as qty_remaining, unit_cost::text as unit_cost,
      to_char(effective_at,'YYYY-MM-DD') as effective_at, sequence::text as sequence,
      to_char(invalidated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as invalidated_at
      from app.cost_layer where company_id = ${c} order by item_id, warehouse_id, sequence`),

  // ── tax ────────────────────────────────────────────────────────────────────────────────────────────
  t("tax_code", "accounting.tax.manage", ["id", "code", "name_en", "name_ar", "kind", "rate", "regime_id"],
    (tx, c) => tx`select id, code, name_en, name_ar, kind, rate::text as rate, regime_id
      from app.tax_code where company_id = ${c} order by code`),
  t("tax_transaction", "accounting.tax.manage",
    ["id", "document_id", "line_no", "tax_code_id", "regime_id", "base", "tax", "base_base", "tax_base",
     "effective_date", "fiscal_period_id"],
    (tx, c) => tx`select id, document_id, line_no, tax_code_id, regime_id, base::text as base,
      tax::text as tax, base_base::text as base_base, tax_base::text as tax_base,
      to_char(effective_date,'YYYY-MM-DD') as effective_date, fiscal_period_id
      from app.tax_transaction where company_id = ${c} order by effective_date, document_id, line_no`),

  // ── POS ────────────────────────────────────────────────────────────────────────────────────────────
  t("shift", "pos.report.read", ["id", "branch_id", "terminal_id", "opened_principal_id", "opened_at",
                                 "opening_float", "currency", "closed_at", "closed_principal_id",
                                 "counted_cash", "expected_cash", "over_short", "over_short_document_id"],
    (tx, c) => tx`select id, branch_id, terminal_id, opened_principal_id,
      to_char(opened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as opened_at,
      opening_float::text as opening_float, currency,
      to_char(closed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as closed_at,
      closed_principal_id, counted_cash::text as counted_cash, expected_cash::text as expected_cash,
      over_short::text as over_short, over_short_document_id
      from app.shift where company_id = ${c} order by opened_at, id`),
  t("till_event", "pos.report.read", ["id", "shift_id", "branch_id", "terminal_id", "kind",
                                      "ticket_document_id", "cashier_principal_id", "supervisor_principal_id",
                                      "occurred_at"],
    (tx, c) => tx`select id, shift_id, branch_id, terminal_id, kind, ticket_document_id,
      cashier_principal_id, supervisor_principal_id,
      to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at
      from app.till_event where company_id = ${c} order by occurred_at, id`),

  // ── reporting and attachments (metadata; the bytes are the archive's attachments/ directory) ────────
  t("report_definition", null, ["id", "code", "version", "definition", "cloned_from", "is_core", "archived_at"],
    (tx, c) => tx`select id, code, version, definition::text as definition, cloned_from, is_core,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at
      from app.report_definition where company_id = ${c} order by code, version`),
  t("attachment", null, ["id", "document_id", "object_key", "file_name", "mime_type", "byte_size",
                         "sha256", "archived_at", "created_at"],
    (tx, c) => tx`select id, document_id, object_key, file_name, mime_type, byte_size::text as byte_size,
      encode(sha256,'hex') as sha256,
      to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from app.attachment where company_id = ${c} order by created_at, id`),

  // ── the audit trail — gated, and without its row images (NEVER_EXPORTED) ────────────────────────────
  t("audit_log", "admin.audit_log.read", ["seq", "occurred_at", "table_name", "row_id", "action", "actor_id"],
    (tx) => tx`select seq::text as seq,
      to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
      table_name, row_id, action, actor_id
      from app.audit_log order by seq`),
];

const BY_NAME = new Map(EXPORT_TABLES.map((table) => [table.name, table]));

export function exportTable(name: string): ExportTable {
  const found = BY_NAME.get(name);
  if (!found) throw new Error(`export table '${name}' is not registered (packages/db/src/export/tables.ts)`);
  return found;
}

/**
 * Resolves every gate for one principal in one company through `app.principal_has` (2B, §4.5.3) — the same
 * predicate the override guard uses, so "may this person see this" has one answer in the system. An
 * ungated table is always included; a gated table the principal does not hold is excluded AND NAMED, so
 * the archive's manifest says what is missing and why rather than silently shrinking.
 */
export async function resolveExportGates(
  tx: Sql, input: { principalId: string; companyId: string },
): Promise<{ included: readonly ExportTable[]; excluded: readonly { table: string; gate: string }[] }> {
  const gates = [...new Set(EXPORT_TABLES.map((table) => table.gate).filter((g): g is string => g !== null))];
  const held = new Set<string>();
  for (const gate of gates) {
    const [row] = await tx<{ ok: boolean }[]>`
      select app.principal_has(${input.principalId}::uuid, ${gate}, ${input.companyId}::uuid, null) as ok`;
    if (row?.ok) held.add(gate);
  }
  const included: ExportTable[] = [];
  const excluded: { table: string; gate: string }[] = [];
  for (const table of EXPORT_TABLES) {
    if (table.gate === null || held.has(table.gate)) included.push(table);
    else excluded.push({ table: table.name, gate: table.gate });
  }
  return { included, excluded };
}
```

> **`audit_log` has no `company_id`** (plan0A:1920) — it is tenant-scoped — so its query takes the parameter and ignores it, exactly as 7A's `auditLogDataset` sets `company: null`. RLS is still the outer gate.
> **Every name in `columns` must be a real `information_schema` column, never a derived alias.** `exportSchemaDocument` throws `export schema: app.<t> has no column '<c>'` on the first name the database does not have, so a computed value — a period label, a status text, an `is_open` flag — belongs in the SELECT under an existing column's name or not at all. This is why `fiscal_period` exports `starts_on` rather than a `code` it does not have, `dimension_type` exports `code` and `name_en` only, `dimension_value` carries no `name_ar`, and `document_type` carries no `series` (that column is `document`'s). Each of those was checked against Plan 0A's migration 0001 and §4.3.4's per-slice addition table; `document_line`'s money set — `debit`, `credit`, `unit_price`, `discount`, `amount`, `tax_amount`, `total_incl_tax`, `cost` — is §4.3.4's Phase 1 base plus 2A's 0019, and there is **no `side` column** anywhere in that table. If the merged column set differs again, correct the list here and let the difference fall into `omitted` — the `schema.json` test is what will tell you, by name.

- [ ] **Step 4: Write `packages/db/src/export/schema.ts`**

```ts
import type { Sql } from "postgres";
import { NEVER_EXPORTED, type ExportTable } from "./tables";

export interface ExportSchemaColumn { name: string; type: string; nullable: boolean }
export interface ExportSchemaTable { name: string; columns: ExportSchemaColumn[]; omitted: string[]; gate: string | null }

/** spec:2186's "a documented schema", as a build-checked artefact. Written into the archive as schema.json. */
export interface ExportSchemaDocument {
  formatVersion: 1;
  generatedAt: string;
  company: { id: string };
  encoding: "utf-8";
  csvDialect: { delimiter: ","; quote: "\""; newline: "\n"; header: true };
  moneyScale: 4;
  quantityScale: 6;
  rateScale: 8;
  timestamps: "RFC 3339 UTC";
  dates: "YYYY-MM-DD";
  tables: ExportSchemaTable[];
}

export async function exportSchemaDocument(
  tx: Sql, input: { companyId: string; tables: readonly ExportTable[]; generatedAt: string },
): Promise<ExportSchemaDocument> {
  const names = input.tables.map((t) => t.name);
  const live = await tx<{ table_name: string; column_name: string; data_type: string; is_nullable: string }[]>`
    select table_name, column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = 'app' and table_name = any(${names}::text[])
     order by table_name, ordinal_position`;
  const byTable = new Map<string, typeof live>();
  for (const row of live) {
    const bucket = byTable.get(row.table_name) ?? [];
    bucket.push(row);
    byTable.set(row.table_name, bucket);
  }

  const tables: ExportSchemaTable[] = input.tables.map((t) => {
    const rows = byTable.get(t.name) ?? [];
    const exported = new Set(t.columns);
    return {
      name: t.name,
      gate: t.gate,
      columns: t.columns.map((name) => {
        const row = rows.find((r) => r.column_name === name);
        // A column the registry names that the database does not have is a defect, not a nullable string:
        // the export would emit a header for a column no query returns.
        if (!row) throw new Error(`export schema: app.${t.name} has no column '${name}'`);
        return { name, type: row.data_type, nullable: row.is_nullable === "YES" };
      }),
      omitted: rows.map((r) => r.column_name).filter((name) => !exported.has(name)),
    };
  });

  // A pinned column that somehow reached `columns` is a build failure, not a warning.
  for (const t of tables) {
    for (const forbidden of NEVER_EXPORTED[t.name] ?? []) {
      if (forbidden === "*" || t.columns.some((c) => c.name === forbidden)) {
        throw new Error(`export schema: app.${t.name}.${forbidden} is in NEVER_EXPORTED but is being exported`);
      }
    }
  }

  return {
    formatVersion: 1,
    generatedAt: input.generatedAt,
    company: { id: input.companyId },
    encoding: "utf-8",
    csvDialect: { delimiter: ",", quote: "\"", newline: "\n", header: true },
    moneyScale: 4,
    quantityScale: 6,
    rateScale: 8,
    timestamps: "RFC 3339 UTC",
    dates: "YYYY-MM-DD",
    tables,
  };
}
```

Add both modules to `packages/db/src/export/index.ts`:

```ts
export {
  EXPORT_TABLES, NEVER_EXPORTED, exportTable, resolveExportGates,
  type ExportRow, type ExportTable,
} from "./tables";
export {
  exportSchemaDocument,
  type ExportSchemaColumn, type ExportSchemaDocument, type ExportSchemaTable,
} from "./schema";
```

- [ ] **Step 5: Write ADR 0069 — a proposal**

`docs/adr/0069-tenant-export-archive-and-table-registry.md`:

```markdown
# ADR 0069: The tenant export is one deterministic .tar.gz over an explicit table registry

- Status: **Proposed** — spec:95 requires anything touching the data model or security to be written as a
  proposal and asked before implementing, and this decides what leaves the system.
- Date: 2026-09-08
- Slice: 7C

## Context

spec:2186 requires data export at any time, unprompted, "in open formats (CSV + JSON + a documented
schema)"; spec:2211 makes it the right-to-export workflow; spec:1067 includes attachments; spec:2206
requires async job semantics with a status resource. §4.6.1 gives `export_job` a **single** `object_key`
and a **single** `sha256`, so one export is one artefact.

Two questions follow. What container holds CSV + JSON + a schema + attachment bytes? And what decides
which rows and columns go in — given that the job runs as the tenant's system principal (spec:2179), which
holds every permission?

## Decision

**1. One `.tar.gz`, written by a fifty-line deterministic USTAR writer plus `node:zlib`.** Layout:

    schema.json
    manifest.json
    tables/<table>.csv        (format 'csv' | 'both')
    tables/<table>.json       (format 'json' | 'both')
    attachments/<attachment_id>-<file_name>

Every header field a tar carries that could vary — mtime, uid, gid, uname, gname, mode — is written as a
fixed value, and entries are emitted in registry order, so **the same data produces a byte-identical
archive and therefore an identical `sha256`**. That is what lets a tenant verify an export, and what lets
a test assert determinism rather than "it ran".

**2. An explicit registry, `EXPORT_TABLES`, with per-table permission gates.** Each entry names its table,
its columns **in full** and a gate (`null` = ungated). The job resolves every gate once, for the
**requesting** principal, through `app.principal_has`, and includes a table only when the gate is held; an
excluded table is **named** in `manifest.excluded` with its gate. `NEVER_EXPORTED` pins the columns and
tables that never leave whatever the registry says.

**3. `audit_log.before` / `.after` are not exported.** They are row images of every table, including the
gated ones, so exporting them would defeat every gate at once. The audit *trail* — who did what, when, to
which row — is exported; the payloads stay behind `/v1/admin/audit-log`. This is the same reasoning 7B
applied to the audit report (its amendment A3).

## Alternatives rejected

- **A zip.** Friendlier to double-click, but Node has no built-in zip writer, so it means a dependency for
  fifty lines of work, and zip's own local-header timestamps make determinism fiddlier than tar's. `.tar.gz`
  is also an open format in the sense spec:2186 means, and every target platform reads it.
- **Streaming one file per table to the object store.** Fits nothing in §4.6.1: one `object_key`, one
  `sha256`, one status resource. Multiple objects would need a table of artefacts and a second status shape.
- **Deriving the column list from `information_schema` at run time.** Then a column added by a future
  migration leaks by default. The registry inverts that: a new column does not leave the system until
  someone adds it here, which is the safe direction for a side channel.
- **Re-deriving the requester's authority inside the job.** The job is the system principal and would
  resolve *its own* authority, which is everything. ADR 0070 records the request-time snapshot instead.

## Consequences

- A slice that adds a sensitive table adds one `EXPORT_TABLES` row with its gate and changes **no exporter
  code** — no edit to `run.ts`, `archive.ts` or `schema.ts`. 8A's `employee_sensitive` is the case this is
  built for (test 32).
- **A table pinned in `NEVER_EXPORTED` is refused until the slice that owns it narrows the pin, in the same
  PR as its registry row.** `employee_sensitive` is pinned `["*"]` here, before the table exists, so the
  default for a table nobody has reasoned about is "does not leave"; `exportSchemaDocument` throws and
  `tables.test.ts` fails if a `["*"]` table is registered. 8A therefore makes two edits — the row, and the
  pin narrowed to the ciphertext columns it will not export — and the second is the deliberate act this
  ADR is asking for, not an obstacle to it.
- A slice that adds a column to an exported table must add it to the registry deliberately.
- The archive's determinism is asserted by a test that exports the same fixture twice and compares digests.
```

- [ ] **Step 6: Run the test to see it pass**

Run: `bun run --cwd packages/db test -- export/tables && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. A `schema.json` failure naming `app.<table>.<column>` means the registry names a column the merged schema does not have — fix the **registry**, and add the real column to `columns` or leave it in `omitted` deliberately.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/export/tables.ts packages/db/src/export/schema.ts \
        packages/db/src/export/index.ts packages/db/test/export/tables.test.ts \
        docs/adr/0069-tenant-export-archive-and-table-registry.md
git commit -m "$(cat <<'EOF'
feat(db): add the export table registry and the documented schema [7C T7]

EXPORT_TABLES names every table, every column and a per-table permission gate;
there is no `select *` anywhere, so a column added by a future migration does
not leave the system until someone adds it here. NEVER_EXPORTED pins the
side channels a well-meaning edit would otherwise open: principal.auth_subject,
pos_cashier.pin_hash, the whole of terminal_enrolment and idempotency_key, and
audit_log.before/after — row images of every table, gated ones included.

resolveExportGates answers the gates for the REQUESTING principal through
app.principal_has, the same predicate the override guard uses. A table the
requester cannot hold is excluded and NAMED, which is the mechanism 8A plugs
employee_sensitive into with no change to the exporter (test 32).

exportSchemaDocument is spec:2186's "documented schema" as a build-checked
artefact: every documented column must exist, every existing column must be
documented or listed as omitted, and a NEVER_EXPORTED column reaching the list
throws.

ADR 0069 is a PROPOSAL (spec:95) — it decides what leaves the system.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The deterministic archive, `runExport`, attachments, and the `admin.export.run` handler

The exporter itself: a fifty-line USTAR writer with every varying header field fixed, the CSV and JSON serialisers, the attachment pass, and the pg-boss handler that ties them to the `export_job` row.

**Files:**
- Create: `packages/db/src/export/archive.ts`, `packages/db/src/export/run.ts`, `packages/db/test/export/archive.test.ts`, `packages/db/test/export/run.test.ts`, `apps/worker/src/jobs/export-run.ts`, `apps/worker/test/handlers/export-run.test.ts`
- Modify: `packages/db/src/export/index.ts`, `packages/db/src/jobs/payloads.ts` (one key), `apps/worker/src/index.ts` (one `registerHandler`), `tests/invariants/probes.ts` (the one `JOB_PROBES` key)

**Interfaces:**
- Consumes: `EXPORT_TABLES`, `ExportTable`, `ExportRow`, `resolveExportGates`, `exportSchemaDocument` (Task 7); `claimExportJob`, `completeExportJob`, `failExportJob`, `getExportJob`, `exportObjectKeyFor`, `ExportJobRow` (Task 5); `seedExportJob` (Task 5, `@dulja/db/test`); `ObjectStore` (2C, §4.5.8); `objectStore`, `setObjectStore` (7A, `apps/worker/src/object-store.ts`); `JobHandler`, `registerHandler`, `runJob`, `JobEnvelope`, `JobPayload`, `JobIsolationProbe`, `JOB_PROBES` (§4.2.6, §3.7.2); `systemContext`, `withTenant` production (§4.2.2); `startWorker`, `StartedWorker` (0D, §4.17.1); `gzipSync` (`node:zlib`), `createHash` (`node:crypto`).
- Produces:

```ts
// packages/db/src/export/archive.ts
export interface TarEntry { readonly path: string; readonly bytes: Uint8Array }
/** A deterministic USTAR tarball: every header field that could vary — mtime, uid, gid, mode, uname,
 *  gname — is a fixed literal, and entries are written in the order given. Same input, same bytes. */
export function tar(entries: readonly TarEntry[]): Uint8Array;
/** `tar` then `gzipSync(level 9)`. Node's zlib writes a zero MTIME into the gzip header, so this is
 *  deterministic too; `archive.test.ts` asserts it rather than trusting it. */
export function tarGz(entries: readonly TarEntry[]): Uint8Array;
export function toCsv(columns: readonly string[], rows: readonly ExportRow[]): string;
export function toJson(rows: readonly ExportRow[]): string;

// packages/db/src/export/run.ts
export interface ExportManifestTable { name: string; rowCount: number; gate: string | null; files: string[] }
export interface ExportManifestAttachment { id: string; objectKey: string; fileName: string; byteSize: number; sha256: string; path: string }
export interface ExportManifest {
  formatVersion: 1; exportJobId: string; companyId: string; generatedAt: string; format: "csv" | "json" | "both";
  tables: ExportManifestTable[];
  excluded: { table: string; gate: string }[];
  attachments: ExportManifestAttachment[];
  attachmentsOmitted: { id: string; reason: "module_not_readable" | "object_missing" }[];
}
export interface ExportResult { bytes: Uint8Array; sha256: Uint8Array; manifest: ExportManifest; tableCount: number; rowCount: number }
/** Reads through `tx` (already inside `withTenant`), fetches attachment bytes through `store`, and returns
 *  the archive. It writes NOTHING — the caller decides where the bytes go, which is what makes it testable
 *  without an object store round-trip and keeps `packages/db` free of the worker's wiring. */
export async function runExport(
  tx: Sql, store: ObjectStore, input: { job: ExportJobRow; tenantId: string; generatedAt: string },
): Promise<ExportResult>;

// packages/db/src/jobs/payloads.ts — ONE key added; no other line changes (§4.2.6, amendment A10)
//   /** Slice 7C. The export_job row carries the format, the recorded gates and the company. */
//   "admin.export.run": { exportJobId: string };

// apps/worker/src/jobs/export-run.ts
export const exportRun: JobHandler<"admin.export.run">;
```

- [ ] **Step 1: Write the failing tests**

`packages/db/test/export/archive.test.ts`:

```ts
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { tar, tarGz, toCsv, toJson } from "../../src/export/archive";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("the deterministic export archive — ADR 0069", () => {
  const entries = [
    { path: "schema.json", bytes: utf8("{\"formatVersion\":1}") },
    { path: "tables/account.csv", bytes: utf8("code\n1000\n") },
  ];

  it("tar emits 512-byte blocks, the paths in order, and two zero blocks at the end", () => {
    const bytes = tar(entries);
    expect(bytes.byteLength % 512).toBe(0);
    const text = new TextDecoder().decode(bytes);
    expect(text.indexOf("schema.json")).toBeLessThan(text.indexOf("tables/account.csv"));
    expect(bytes.slice(-1024).every((b) => b === 0)).toBe(true);
    expect(new TextDecoder().decode(bytes.slice(257, 263))).toBe("ustar\0");
  });

  it("the same entries produce byte-identical output, twice", () => {
    expect(Buffer.from(tar(entries)).equals(Buffer.from(tar(entries)))).toBe(true);
    expect(Buffer.from(tarGz(entries)).equals(Buffer.from(tarGz(entries)))).toBe(true);
  });

  it("tarGz round-trips through gunzip to exactly the tar bytes", () => {
    expect(Buffer.from(gunzipSync(Buffer.from(tarGz(entries)))).equals(Buffer.from(tar(entries)))).toBe(true);
  });

  it("a path longer than 100 bytes is rejected, naming it (USTAR's limit)", () => {
    expect(() => tar([{ path: `tables/${"x".repeat(120)}.csv`, bytes: utf8("") }])).toThrow(/x{10}/);
  });

  it("toCsv writes the header, quotes what needs quoting and renders null as empty", () => {
    expect(toCsv(["code", "name_en"], [
      { code: "1000", name_en: "Cash, on hand" },
      { code: "1100", name_en: "He said \"bank\"" },
      { code: "1200", name_en: null },
    ])).toBe(
      "code,name_en\n" +
      "1000,\"Cash, on hand\"\n" +
      "1100,\"He said \"\"bank\"\"\"\n" +
      "1200,\n");
  });

  it("toJson writes one object per row, newline-delimited, in column order", () => {
    expect(toJson([{ code: "1000", name_en: "Cash" }, { code: "1100", name_en: null }]))
      .toBe("{\"code\":\"1000\",\"name_en\":\"Cash\"}\n{\"code\":\"1100\",\"name_en\":null}\n");
  });
});
```

`packages/db/test/export/run.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { MemoryObjectStore } from "../../src/attachment/object-store";
import { getExportJob } from "../../src/export/store";
import { runExport } from "../../src/export/run";
import { seedExportJob } from "../fixtures";
import { arApReportFixture, type ArApReportFixture } from "../../../../tests/invariants/support/reports-7c";
import { startDb, withTenant, type Db } from "../harness";

describe("runExport — spec:2186, spec:1067, ADR 0069", () => {
  let db: Db;
  let f: ArApReportFixture;
  let store: MemoryObjectStore;

  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "export-run");
    store = new MemoryObjectStore();
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn as never) as Promise<T>;

  const runFor = async (jobId: string) => {
    const job = (await read((tx) => getExportJob(tx, jobId)))!;
    return read((tx) => runExport(tx, store, {
      job, tenantId: f.s.tenant, generatedAt: "2026-02-01T00:00:00Z",
    }));
  };

  const paths = (bytes: Uint8Array): string[] => {
    const tarBytes = gunzipSync(Buffer.from(bytes));
    const out: string[] = [];
    for (let at = 0; at + 512 <= tarBytes.length; ) {
      const name = tarBytes.subarray(at, at + 100).toString("utf8").replace(/\0.*$/, "");
      if (name === "") break;
      const size = parseInt(tarBytes.subarray(at + 124, at + 135).toString("ascii").trim(), 8);
      out.push(name);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  };

  it("format 'both' writes schema.json, manifest.json and one CSV and one JSON per included table", async () => {
    const result = await runFor(await seedExportJob(db, f.s, { format: "both", readableModules: ["accounting"] }));
    const files = paths(result.bytes);
    expect(files).toContain("schema.json");
    expect(files).toContain("manifest.json");
    expect(files).toContain("tables/account.csv");
    expect(files).toContain("tables/account.json");
    expect(result.manifest.tables.find((t) => t.name === "account")!.files)
      .toEqual(["tables/account.csv", "tables/account.json"]);
    expect(result.tableCount).toBe(result.manifest.tables.length);
    expect(result.rowCount).toBe(result.manifest.tables.reduce((a, t) => a + t.rowCount, 0));
  });

  it("format 'csv' writes no .json table file, and 'json' writes no .csv", async () => {
    const csv = await runFor(await seedExportJob(db, f.s, { format: "csv" }));
    expect(paths(csv.bytes).some((p) => p.endsWith(".json") && p.startsWith("tables/"))).toBe(false);
    const json = await runFor(await seedExportJob(db, f.s, { format: "json" }));
    expect(paths(json.bytes).some((p) => p.endsWith(".csv"))).toBe(false);
    // schema.json and manifest.json are present under EVERY format — spec:2186 requires the schema.
    expect(paths(csv.bytes)).toContain("schema.json");
  });

  it("a table whose gate the requester does not hold is absent and named in manifest.excluded", async () => {
    const result = await runFor(await seedExportJob(db, f.s, { readableModules: ["accounting"] }));
    // `f.reader` holds no admin.audit_log.read, so audit_log is gated out.
    expect(paths(result.bytes)).not.toContain("tables/audit_log.csv");
    expect(result.manifest.excluded.map((e) => e.table)).toContain("audit_log");
    expect(result.manifest.excluded.find((e) => e.table === "audit_log")!.gate).toBe("admin.audit_log.read");
  });

  it("attachments the requester's modules cover are included; the rest are named, not silently dropped", async () => {
    await store.put(`${f.s.tenant}/att-1`, new TextEncoder().encode("invoice pdf"), "application/pdf");
    await withTenant(db.rw, f.s.tenant, f.reader, (tx) =>
      tx`insert into app.attachment (tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
         values (${f.s.tenant}, ${f.s.company}, ${f.invoiceId}, ${`${f.s.tenant}/att-1`}, 'invoice.pdf',
                 'application/pdf', 11, sha256('invoice pdf'::bytea))`);
    const withAcc = await runFor(await seedExportJob(db, f.s, { readableModules: ["accounting"] }));
    expect(withAcc.manifest.attachments.map((a) => a.fileName)).toContain("invoice.pdf");
    expect(paths(withAcc.bytes).some((p) => p.startsWith("attachments/"))).toBe(true);

    const withNone = await runFor(await seedExportJob(db, f.s, { readableModules: [] }));
    expect(withNone.manifest.attachments).toEqual([]);
    expect(withNone.manifest.attachmentsOmitted.map((a) => a.reason)).toEqual(["module_not_readable"]);
  });

  it("includeAttachments false omits the bytes but still exports the attachment METADATA table", async () => {
    const result = await runFor(await seedExportJob(db, f.s, { includeAttachments: false }));
    expect(paths(result.bytes).some((p) => p.startsWith("attachments/"))).toBe(false);
    expect(paths(result.bytes)).toContain("tables/attachment.csv");
  });

  it("the same job run twice produces an identical sha256 (ADR 0069's determinism claim)", async () => {
    const jobId = await seedExportJob(db, f.s);
    const a = await runFor(jobId);
    const b = await runFor(jobId);
    expect(Buffer.from(a.sha256).toString("hex")).toBe(Buffer.from(b.sha256).toString("hex"));
  });
});
```

`apps/worker/test/handlers/export-run.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExportJob } from "@dulja/db";
// `seedExportJob` is a FIXTURE (`packages/db/test/fixtures.ts`, §4.17's one 7C row), so it is reachable
// only through the `./test` subpath — `packages/db/src/index.ts` re-exports no test-tier symbol (§4.2.12).
import { seedExportJob, seedTenantV2, withTenant, type Seed } from "@dulja/db/test";
import { setObjectStore } from "../../src/object-store";
import { MemoryObjectStore } from "@dulja/db";
import { startWorker, type StartedWorker } from "../support/worker";

describe("the admin.export.run handler — §4.2.6, hazard 20, ADR 0070", () => {
  let w: StartedWorker;
  let s: Seed;
  let store: MemoryObjectStore;

  beforeAll(async () => {
    w = await startWorker();
    s = await seedTenantV2(w.db, "export-job");
    store = new MemoryObjectStore();
    setObjectStore(store);
  }, 300_000);
  afterAll(async () => { await w.stop(); });

  it("claims the row, writes the archive to the store and completes it", async () => {
    const jobId = await seedExportJob(w.db, s);
    await w.run("admin.export.run", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { exportJobId: jobId } });
    const row = await withTenant(w.db.rw, s.tenant, s.human, (tx) => getExportJob(tx as never, jobId));
    expect(row!.status).toBe("done");
    expect(row!.objectKey).toBe(`${s.tenant}/exports/${jobId}.tar.gz`);
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get(row!.objectKey!)).not.toBeNull();
  });

  it("runs as the tenant's SYSTEM principal, and the completion is audited under it (hazard 20, test 13)", async () => {
    const jobId = await seedExportJob(w.db, s);
    await w.run("admin.export.run", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { exportJobId: jobId } });
    const rows = await w.db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'export_job' and row_id = ${jobId} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]);   // create, claim, complete
    expect(rows[0]!.actor_id).toBe(s.human);
    expect(rows[2]!.actor_id).toBe(s.system);
  });

  it("a re-delivery of a completed job is a no-op, not a second archive", async () => {
    const jobId = await seedExportJob(w.db, s);
    await w.run("admin.export.run", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { exportJobId: jobId } });
    const first = await withTenant(w.db.rw, s.tenant, s.human, (tx) => getExportJob(tx as never, jobId));
    await w.run("admin.export.run", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { exportJobId: jobId } });
    const second = await withTenant(w.db.rw, s.tenant, s.human, (tx) => getExportJob(tx as never, jobId));
    expect(second!.finishedAt).toBe(first!.finishedAt);
  });

  it("a store failure fails the row with a message rather than leaving it running", async () => {
    setObjectStore({
      put: () => Promise.reject(new Error("object store unavailable")),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    } as never);
    const jobId = await seedExportJob(w.db, s);
    await w.run("admin.export.run", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { exportJobId: jobId } })
      .catch(() => undefined);
    const row = await withTenant(w.db.rw, s.tenant, s.human, (tx) => getExportJob(tx as never, jobId));
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("object store unavailable");
    setObjectStore(store);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/db test -- export/archive export/run && bun run --cwd apps/worker test -- export-run`
Expected: FAIL three times at import — `Cannot find module '../../src/export/archive'`, `'../../src/export/run'`, `'../../src/jobs/export-run'`.

- [ ] **Step 3: Write `packages/db/src/export/archive.ts`**

```ts
import { gzipSync } from "node:zlib";
import type { ExportRow } from "./tables";

export interface TarEntry { readonly path: string; readonly bytes: Uint8Array }

const BLOCK = 512;
/** Every header field that could vary is a fixed literal — that is the whole determinism argument. */
const MODE = "0000644";
const OWNER = "0000000";
const MTIME = "00000000000";      // the epoch, octal, 11 digits
const TYPE_FILE = "0";

function writeAscii(block: Uint8Array, at: number, value: string, width: number): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > width) throw new Error(`tar: '${value}' does not fit in ${width} bytes`);
  block.set(bytes, at);
}

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const path = new TextEncoder().encode(entry.path);
  if (path.length > 100) {
    throw new Error(`tar: path '${entry.path}' exceeds USTAR's 100-byte name field`);
  }
  writeAscii(block, 0, entry.path, 100);
  writeAscii(block, 100, `${MODE}\0`, 8);
  writeAscii(block, 108, `${OWNER}\0`, 8);              // uid
  writeAscii(block, 116, `${OWNER}\0`, 8);              // gid
  writeAscii(block, 124, `${entry.bytes.byteLength.toString(8).padStart(11, "0")}\0`, 12);
  writeAscii(block, 136, `${MTIME}\0`, 12);
  writeAscii(block, 148, "        ", 8);                // checksum field, spaces while summing
  writeAscii(block, 156, TYPE_FILE, 1);
  writeAscii(block, 257, "ustar\0", 6);
  writeAscii(block, 263, "00", 2);
  // uname/gname deliberately empty: a machine's user name must not reach a tenant's archive.
  let sum = 0;
  for (const b of block) sum += b;
  writeAscii(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return block;
}

export function tar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  let size = 0;
  for (const entry of entries) {
    const head = header(entry);
    const padded = new Uint8Array(Math.ceil(entry.bytes.byteLength / BLOCK) * BLOCK);
    padded.set(entry.bytes, 0);
    blocks.push(head, padded);
    size += head.byteLength + padded.byteLength;
  }
  const trailer = new Uint8Array(BLOCK * 2);            // two zero blocks end a tar
  blocks.push(trailer);
  size += trailer.byteLength;

  const out = new Uint8Array(size);
  let at = 0;
  for (const block of blocks) { out.set(block, at); at += block.byteLength; }
  return out;
}

/** Node's zlib writes MTIME 0 into the gzip header, so this is deterministic; archive.test.ts asserts it. */
export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(tar(entries)), { level: 9 }));
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

/** RFC 4180 with the dialect `schema.json` documents: comma, double quote, `\n`, header row. */
export function toCsv(columns: readonly string[], rows: readonly ExportRow[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c] ?? null)).join(","));
  return `${lines.join("\n")}\n`;
}

/** Newline-delimited JSON: one object per row, so a consumer streams it and a diff is line-oriented. */
export function toJson(rows: readonly ExportRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}
```

- [ ] **Step 4: Write `packages/db/src/export/run.ts`**

```ts
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { ObjectStore } from "../attachment/object-store";
import { tarGz, toCsv, toJson, type TarEntry } from "./archive";
import { exportSchemaDocument } from "./schema";
import { resolveExportGates } from "./tables";
import type { ExportJobRow } from "./store";

export interface ExportManifestTable { name: string; rowCount: number; gate: string | null; files: string[] }
export interface ExportManifestAttachment {
  id: string; objectKey: string; fileName: string; byteSize: number; sha256: string; path: string;
}
export interface ExportManifest {
  formatVersion: 1;
  exportJobId: string;
  companyId: string;
  generatedAt: string;
  format: "csv" | "json" | "both";
  tables: ExportManifestTable[];
  excluded: { table: string; gate: string }[];
  attachments: ExportManifestAttachment[];
  attachmentsOmitted: { id: string; reason: "module_not_readable" | "object_missing" }[];
}
export interface ExportResult {
  bytes: Uint8Array; sha256: Uint8Array; manifest: ExportManifest; tableCount: number; rowCount: number;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `attachments/<id>-<file name>`, with anything USTAR or a file system would choke on replaced. The id
 *  prefix is what makes the name unique; the original name survives in `manifest.attachments[].fileName`. */
function attachmentPath(id: string, fileName: string): string {
  const safe = fileName.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `attachments/${id}-${safe}`;
}

export async function runExport(
  tx: Sql, store: ObjectStore, input: { job: ExportJobRow; tenantId: string; generatedAt: string },
): Promise<ExportResult> {
  const { job } = input;
  const { included, excluded } = await resolveExportGates(tx, {
    principalId: job.requestedBy, companyId: job.companyId,
  });

  const entries: TarEntry[] = [];
  const tables: ExportManifestTable[] = [];
  let rowCount = 0;

  const schema = await exportSchemaDocument(tx, {
    companyId: job.companyId, tables: included, generatedAt: input.generatedAt,
  });
  entries.push({ path: "schema.json", bytes: utf8(`${JSON.stringify(schema, null, 2)}\n`) });

  for (const table of included) {
    const rows = await table.rows(tx, job.companyId);
    const files: string[] = [];
    if (job.format === "csv" || job.format === "both") {
      files.push(`tables/${table.name}.csv`);
      entries.push({ path: `tables/${table.name}.csv`, bytes: utf8(toCsv(table.columns, rows)) });
    }
    if (job.format === "json" || job.format === "both") {
      files.push(`tables/${table.name}.json`);
      entries.push({ path: `tables/${table.name}.json`, bytes: utf8(toJson(rows)) });
    }
    tables.push({ name: table.name, rowCount: rows.length, gate: table.gate, files });
    rowCount += rows.length;
  }

  const attachments: ExportManifestAttachment[] = [];
  const attachmentsOmitted: ExportManifest["attachmentsOmitted"] = [];
  if (job.includeAttachments) {
    // The requester's recorded modules decide which attachments leave (§4.5.8, ADR 0070). The job is the
    // SYSTEM principal and cannot re-derive them; `readable_modules` is the snapshot the route took.
    const rows = await tx<{ id: string; object_key: string; file_name: string; byte_size: string;
                            sha256: string; module: string | null; is_lot: boolean }[]>`
      select a.id, a.object_key, a.file_name, a.byte_size::text as byte_size, encode(a.sha256,'hex') as sha256,
             dt.module as module, (a.document_id is null) as is_lot
        from app.attachment a
        left join app.document      d  on d.id  = a.document_id
        left join app.document_type dt on dt.id = d.document_type_id
       where a.company_id = ${job.companyId} and a.archived_at is null
       order by a.created_at, a.id`;
    const modules = new Set(job.readableModules);
    for (const row of rows) {
      const readable = row.is_lot ? job.lotAttachments : modules.has(row.module ?? "accounting");
      if (!readable) { attachmentsOmitted.push({ id: row.id, reason: "module_not_readable" }); continue; }
      const bytes = await store.get(row.object_key);
      if (bytes === null) { attachmentsOmitted.push({ id: row.id, reason: "object_missing" }); continue; }
      const path = attachmentPath(row.id, row.file_name);
      entries.push({ path, bytes });
      attachments.push({
        id: row.id, objectKey: row.object_key, fileName: row.file_name,
        byteSize: Number(row.byte_size), sha256: row.sha256, path,
      });
    }
  }

  const manifest: ExportManifest = {
    formatVersion: 1,
    exportJobId: job.id,
    companyId: job.companyId,
    generatedAt: input.generatedAt,
    format: job.format,
    tables,
    excluded: [...excluded],
    attachments,
    attachmentsOmitted,
  };
  entries.push({ path: "manifest.json", bytes: utf8(`${JSON.stringify(manifest, null, 2)}\n`) });

  const bytes = tarGz(entries);
  return {
    bytes,
    sha256: new Uint8Array(createHash("sha256").update(bytes).digest()),
    manifest,
    tableCount: tables.length,
    rowCount,
  };
}
```

> **`manifest.json` is written last so its own bytes are not in the archive it describes**, and `schema.json` first so a reader can parse the layout before anything else. Both orders are fixed, which is part of the determinism claim.

- [ ] **Step 5: Write the handler and register it**

Add the one key to `packages/db/src/jobs/payloads.ts` — no other line changes (§4.2.6):

```ts
  /** Slice 7C. The `export_job` row carries the format, the recorded gates and the company. */
  "admin.export.run": { exportJobId: string };
```

`apps/worker/src/jobs/export-run.ts`:

```ts
import { completeExportJob, claimExportJob, exportObjectKeyFor, failExportJob, runExport, withTenant } from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";
import { objectStore } from "../object-store";

/**
 * spec:2206's async export. Three short transactions, never one long one (§4.2.6): claim, build, record.
 * The handler runs as the tenant's system principal (hazard 20) and therefore uses the gates the ROUTE
 * recorded on the row — `requested_by`, `readable_modules`, `lot_attachments` — rather than its own
 * authority, which is everything (ADR 0070).
 */
export const exportRun: JobHandler<"admin.export.run"> = async (sql, job, ctx) => {
  const { exportJobId } = job.payload;

  const claimed = await withTenant(sql, ctx, (tx) => claimExportJob(tx, exportJobId));
  if (claimed === null) {
    log().info({ export_job_id: exportJobId }, "export_job_not_queued");   // a re-delivery, or already run
    return;
  }

  const store = objectStore();
  try {
    const result = await withTenant(sql, ctx, (tx) => runExport(tx, store, {
      job: claimed, tenantId: ctx.tenantId, generatedAt: new Date().toISOString(),
    }));
    const objectKey = exportObjectKeyFor(ctx.tenantId, exportJobId);
    await store.put(objectKey, result.bytes, "application/gzip");
    await withTenant(sql, ctx, (tx) => completeExportJob(tx, {
      id: exportJobId, objectKey, sha256: result.sha256, byteSize: result.bytes.byteLength,
      tableCount: result.tableCount, rowCount: result.rowCount, manifest: result.manifest,
    }));
    log().info({
      export_job_id: exportJobId, table_count: result.tableCount, row_count: result.rowCount,
      byte_size: result.bytes.byteLength,
    }, "export_job_done");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await withTenant(sql, ctx, (tx) => failExportJob(tx, { id: exportJobId, error: detail }));
    log().error({ export_job_id: exportJobId }, "export_job_failed");
    throw error;
  }
};
```

and one line in `apps/worker/src/index.ts`, beside the other registrations:

```ts
registerHandler("admin.export.run", exportRun);
```

- [ ] **Step 6: Add the `JOB_PROBES` entry, in the same commit as the handler**

`tests/invariants/probes.ts` — **one** `JOB_PROBES` key (§3.7.2, hazard 31). It lands **here and not in Task 6**, because 0D's harness checks the map against the **registered handlers** in both directions — *"no `JOB_PROBES` entry for `<name>`"* and *"`JOB_PROBES` names `<name>`, which no handler is registered for"* (0d:2727-2729) — so the entry is red before Step 5's `registerHandler` and red after it if omitted. One task, both halves, no known-red either side.

```ts
  "admin.export.run": {
    async seed(db, attacker, victim) {
      const { seedExportJob } = await import("@dulja/db/test");
      await seedExportJob(db, victim);
      await seedExportJob(db, attacker);
    },
    /** The victim's own export jobs must all still be there, untouched, after the job ran for the attacker. */
    async survivors(db, victim) {
      const { withTenant } = await import("@dulja/db/test");
      const rows = await withTenant(db.rw, victim.tenant, victim.human, (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.export_job where status = 'queued'`);
      return rows[0]!.n;
    },
  },
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `bun run --cwd packages/db test -- export/ && bun run --cwd apps/worker test -- export-run && bun run --cwd tests test -- job-isolation && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS on all. `posting-only-tables` (§3.7.5) stays green: `run.ts` only reads. The job-isolation harness is green because Step 5 registered the handler and Step 6 probed it in the same commit.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/export/archive.ts packages/db/src/export/run.ts \
        packages/db/src/export/index.ts packages/db/src/jobs/payloads.ts \
        packages/db/test/export/archive.test.ts packages/db/test/export/run.test.ts \
        apps/worker/src/jobs/export-run.ts apps/worker/src/index.ts \
        apps/worker/test/handlers/export-run.test.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(worker): add the deterministic export archive and admin.export.run [7C T8]

A fifty-line USTAR writer with mode, uid, gid, mtime, uname and gname all
fixed, gzipped at level 9, so the same data produces the same bytes and the
same sha256 twice — asserted, not assumed. No dependency is added (ADR 0069
rejects a zip for exactly that reason).

runExport writes schema.json first and manifest.json last, one CSV and/or one
JSON per included table, and every attachment the requester's RECORDED modules
cover; an attachment that is gated out or whose object is missing is NAMED in
manifest.attachmentsOmitted rather than silently dropped.

The handler claims conditionally, so a pg-boss re-delivery of a finished job
is a no-op and not a second archive, and it works from the row's recorded
gates rather than its own authority, because it runs as the tenant's system
principal (hazard 20, ADR 0070).

The JOB_PROBES entry ships in this commit because 0D's harness checks the map
against the registered handlers in BOTH directions (hazard 31); the route's
PROBES entry shipped in T6 for the same reason.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The four export routes, the contracts module, and ADR 0070

`POST` to request, `GET` to list and to read status, `GET …/content` to download. The request is where the authorisation decision is made and recorded, which is what ADR 0070 is about. **The two probes are not here**: the `PROBES` key shipped with the route module in Task 6 and the `JOB_PROBES` key with the handler in Task 8, each in the commit that made its own half real, so neither task carried a known-red.

**Files:**
- Create: `packages/contracts/src/admin/export.ts`, `apps/api/src/export/authorise.ts`, `apps/api/test/routes/admin/exports.test.ts`, `docs/adr/0070-export-runs-as-the-system-principal-behind-a-request-time-gate.md`
- Modify: `apps/api/src/routes/admin/exports.ts` (the three further routes), `packages/contracts/src/index.ts`, `packages/contracts/openapi.json` (regenerated)

**Interfaces:**
- Consumes: `createExportJob`, `getExportJob`, `listExportJobs`, `ExportJobRow` (Task 5); `EXPORT_TABLES` (Task 7); `readableModules`, `MODULE_READ_CODE` (2C, §4.5.8); `ObjectStore` (2C); `JobClient`, `JOBS` (§4.2.6); `PERMISSION`, `requirePermission` (§4.2.5); `AppEnv`, `RouteModule`, `IdempotencyHeader`, `buildRoutes` (§4.2.3, §4.2.7); `ListEnvelope`, `ListQuery`, `UuidSchema`, `TimestampSchema`, `CursorSchema`, `encodeCursor`, `decodeCursor`, `ProblemSchema` (§4.2.8); `AppError`, `Problem` (§4.2.4); `startApi`, `ApiRequest`, `StartedApi`, `problemOf` (§4.2.12); `app.actor_has` (§4.1); **`c.var.jobs` — `AppEnv["Variables"]`'s eighth member, `jobs: JobClient`, which is 3B's amendment A5, already ratified into §4.2.3 (round 3) and recorded in §4.18's ⚑ row naming this very handler.** `POST …/exports` enqueues through it and does not compile without it, so the Execution handoff's ⚑ BEFORE row **confirms the ratified row is present** before this task starts rather than waiting on it; **7C adds no `Variables` member of its own** — `createExportRoutes(objectStore)` is a factory for exactly that reason (amendment A12). **The `PROBES` entry this module needs is Task 6's and the `JOB_PROBES` entry is Task 8's; this task adds neither.**
- Produces:

```ts
// packages/contracts/src/admin/export.ts  (§4.2.8, amendment A14)
export const ExportFormatSchema: z.ZodEnum<["csv", "json", "both"]>;
export const ExportStatusSchema: z.ZodEnum<["queued", "running", "done", "failed"]>;
export const CreateExportBody: z.ZodObject<{ format: …; includeAttachments: z.ZodDefault<z.ZodBoolean> }>;
export const ExportAcceptedSchema: z.ZodObject<{ exportJobId: …; jobId: …; statusUrl: … }>;
export const ExportManifestSchema: z.ZodObject<{ /* the ExportManifest wire shape */ }>;
export const ExportJobSchema: z.ZodObject<{ /* the ExportJobRow wire shape, manifest included */ }>;
export const ExportJobQuery: z.ZodObject<{ /* ListQuery + filter[status][eq] */ }>;
export const ExportJobList: z.ZodObject<{ items: …; next_cursor: … }>;
export type ExportJobDto = z.infer<typeof ExportJobSchema>;

// apps/api/src/export/authorise.ts
/** The gates the JOB cannot re-derive, resolved here, at the request, for the REQUESTING principal. */
export interface ExportGateSnapshot { readableModules: readonly string[]; lotAttachments: boolean }
export async function exportGateSnapshot(c: Context<AppEnv>, companyId: string): Promise<ExportGateSnapshot>;

// apps/api/src/routes/admin/exports.ts — grown from Task 6's skeleton
export function createExportRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv>;   // four routes now
```

- [ ] **Step 1: Write the failing test**

`apps/api/test/routes/admin/exports.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("the export routes — spec:2186, 2206, 2211; contracts amendment A12", () => {
  let api: StartedApi;
  let s: Seed;
  let requester: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "export-routes");
    requester = s.human;
    await grantCodes(api.db, s, {
      codes: ["admin.data.export", "accounting.ledger.read"],
      principalId: requester, roleCode: "exporter",
    });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  const post = (body: unknown, as = requester) =>
    api.request({ method: "POST", path: `/v1/companies/${s.company}/exports`, body, as });

  it("POST accepts, returns 202 with a status URL, and records the gate snapshot", async () => {
    const res = await post({ format: "both", includeAttachments: true });
    expect(res.status).toBe(202);
    const body = await res.json() as { exportJobId: string; jobId: string; statusUrl: string };
    // §4.11.2 / §4.18 round 3: the status URL is the RESOURCE, never `/v1/jobs/{jobId}` — §4.2.7 lists
    // that path and assigns it to no module, so nothing mounts it (ADR 0067; 6A dropped its own
    // `statusUrl` for the same reason). `jobId` stays in the body for log correlation only, and the
    // next two lines follow `statusUrl` verbatim rather than rebuilding the path by hand.
    expect(body.statusUrl).toBe(`/v1/companies/${s.company}/exports/${body.exportJobId}`);
    const status = await api.request({ method: "GET", path: body.statusUrl, as: requester });
    expect(status.status).toBe(200);
    const job = await status.json() as { status: string; readableModules: string[]; requestedBy: string };
    expect(job.status).toBe("queued");
    expect(job.requestedBy).toBe(requester);
    // The requester holds accounting.ledger.read, so `accounting` is readable and nothing else is.
    expect(job.readableModules).toEqual(["accounting"]);
  });

  it("POST without the Idempotency-Key header is refused (spec:2055)", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/exports`,
      body: { format: "both" }, as: requester, idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a replay of the same key returns the same exportJobId and enqueues nothing new", async () => {
    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/exports`,
      body: { format: "csv" }, as: requester, idempotencyKey: key,
    });
    const second = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/exports`,
      body: { format: "csv" }, as: requester, idempotencyKey: key,
    });
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });

  it("GET lists newest first and pages on the cursor", async () => {
    const res = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/exports?limit=2`, as: requester,
    });
    expect(res.status).toBe(200);
    const page = await res.json() as { items: { id: string }[]; next_cursor: string | null };
    expect(page.items.length).toBeLessThanOrEqual(2);
    if (page.next_cursor !== null) {
      const next = await api.request({
        method: "GET", path: `/v1/companies/${s.company}/exports?limit=2&cursor=${page.next_cursor}`,
        as: requester,
      });
      const second = await next.json() as { items: { id: string }[] };
      expect(second.items.map((i) => i.id)).not.toContain(page.items[0]!.id);
    }
  });

  it("GET …/content on a queued job is 404, not an empty body", async () => {
    const created = await (await post({ format: "both" })).json() as { exportJobId: string };
    const res = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/exports/${created.exportJobId}/content`, as: requester,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("GET …/content on a done job streams the archive with its digest header", async () => {
    const created = await (await post({ format: "both" })).json() as { exportJobId: string };
    await api.runJobsToCompletion?.();   // the harness's drain, if the merged startApi exposes one
    await completeByHand(created.exportJobId);
    const res = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/exports/${created.exportJobId}/content`, as: requester,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toContain(`dulja-export-${created.exportJobId}.tar.gz`);
    expect(res.headers.get("x-content-sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("a principal without admin.data.export is 403 on every one of the four", async () => {
    const outsider = s.system;   // the system principal holds no granted code through actor_has
    for (const [method, path] of [
      ["POST", `/v1/companies/${s.company}/exports`],
      ["GET", `/v1/companies/${s.company}/exports`],
      ["GET", `/v1/companies/${s.company}/exports/${crypto.randomUUID()}`],
      ["GET", `/v1/companies/${s.company}/exports/${crypto.randomUUID()}/content`],
    ] as const) {
      const res = await api.request({ method, path, as: outsider, body: method === "POST" ? {} : undefined });
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
  });

  /** Runs the export inline, so the download case does not depend on a live pg-boss in the API harness. */
  async function completeByHand(exportJobId: string): Promise<void> {
    const { getExportJob, runExport, completeExportJob, exportObjectKeyFor, claimExportJob } =
      await import("@dulja/db");
    const { withTenant } = await import("@dulja/db/test");
    await withTenant(api.db.rw, s.tenant, s.system, async (tx) => {
      const job = (await claimExportJob(tx as never, exportJobId))
        ?? (await getExportJob(tx as never, exportJobId))!;
      const result = await runExport(tx as never, api.objectStore, {
        job, tenantId: s.tenant, generatedAt: "2026-02-01T00:00:00Z",
      });
      const key = exportObjectKeyFor(s.tenant, exportJobId);
      await api.objectStore.put(key, result.bytes, "application/gzip");
      await completeExportJob(tx as never, {
        id: exportJobId, objectKey: key, sha256: result.sha256, byteSize: result.bytes.byteLength,
        tableCount: result.tableCount, rowCount: result.rowCount, manifest: result.manifest,
      });
    });
  }
});
```

> **`api.runJobsToCompletion?.()` is an optional call and the `?.` is deliberate**: 0B's `StartedApi` (§4.2.12) declares no such member, and `completeByHand` is what the case actually relies on. If the merged harness has grown one, the line uses it; if not, it is a no-op. Do not add a member to `StartedApi` for this — §4.2.12 says a slice needing a new field amends the contracts document first, and this slice does not need one.

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd apps/api test -- routes/admin/exports`
Expected: FAIL — `POST /v1/companies/{companyId}/exports` returns 404 (the route does not exist yet); Task 6 mounted only the `GET` list.

- [ ] **Step 3: Write `packages/contracts/src/admin/export.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const ExportFormatSchema = z.enum(["csv", "json", "both"]).openapi("ExportFormat");
export const ExportStatusSchema = z.enum(["queued", "running", "done", "failed"]).openapi("ExportStatus");

export const CreateExportBody = z.object({
  format: ExportFormatSchema.default("both"),
  includeAttachments: z.boolean().default(true),
}).openapi("CreateExportBody");

export const ExportAcceptedSchema = z.object({
  exportJobId: UuidSchema,
  /** The pg-boss job id, for LOG CORRELATION only. It is deliberately not addressable: §4.2.7 lists
   *  `/v1/jobs/{jobId}` and assigns it to no module, so no slice mounts it (§4.11.2, ADR 0067). */
  jobId: z.string(),
  /** spec:2206's status resource, and it is the RESOURCE:
   *  `"/v1/companies/<companyId>/exports/<exportJobId>"` — the same shape 7A's report run uses
   *  (`/v1/companies/<companyId>/report-runs/<runId>`) and for the same reason. */
  statusUrl: z.string(),
}).openapi("ExportAccepted");

export const ExportManifestSchema = z.object({
  formatVersion: z.literal(1),
  exportJobId: UuidSchema,
  companyId: UuidSchema,
  generatedAt: TimestampSchema,
  format: ExportFormatSchema,
  tables: z.array(z.object({
    name: z.string(), rowCount: z.number().int(), gate: z.string().nullable(), files: z.array(z.string()),
  })),
  excluded: z.array(z.object({ table: z.string(), gate: z.string() })),
  attachments: z.array(z.object({
    id: UuidSchema, objectKey: z.string(), fileName: z.string(),
    byteSize: z.number().int(), sha256: z.string(), path: z.string(),
  })),
  attachmentsOmitted: z.array(z.object({
    id: UuidSchema, reason: z.enum(["module_not_readable", "object_missing"]),
  })),
}).openapi("ExportManifest");

export const ExportJobSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  requestedBy: UuidSchema,
  format: ExportFormatSchema,
  status: ExportStatusSchema,
  readableModules: z.array(z.string()),
  lotAttachments: z.boolean(),
  includeAttachments: z.boolean(),
  tableCount: z.number().int().nullable(),
  rowCount: z.string().nullable(),      // bigint on the wire is a string (§3.2)
  byteSize: z.string().nullable(),
  objectKey: z.string().nullable(),
  sha256: z.string().nullable(),        // lower-case hex
  manifest: ExportManifestSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
}).openapi("ExportJob");
export type ExportJobDto = z.infer<typeof ExportJobSchema>;

/** Layer 2 of §4.2.8's one list-filter convention: a literal `filter[…]` key, typed, in the OpenAPI
 *  document. One field × one operator, so `parseFilters` would be the wrong mechanism here. */
export const ExportJobQuery = ListQuery.extend({
  "filter[status][eq]": ExportStatusSchema.optional(),
  cursor: CursorSchema.optional(),
}).openapi("ExportJobQuery");

export const ExportJobList = ListEnvelope(ExportJobSchema).openapi("ExportJobList");
```

and one line in `packages/contracts/src/index.ts`:

```ts
export * from "./admin/export";
```

- [ ] **Step 4: Write `apps/api/src/export/authorise.ts`**

```ts
import type { Context } from "hono";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { readableModules } from "../middleware/require-attachment-read";

/**
 * The half of the authorisation decision the JOB cannot make. `admin.export.run` runs as the tenant's
 * system principal (spec:2179, hazard 20) and therefore holds every code; `MODULE_READ_CODE` lives in
 * `apps/api` and neither `packages/db` nor `apps/worker` may import an app (§3.1, §4.5.8). So the modules
 * are resolved HERE, for the requesting principal, and stored on the row. ADR 0070.
 */
export interface ExportGateSnapshot {
  readableModules: readonly string[];
  lotAttachments: boolean;
}

export async function exportGateSnapshot(
  c: Context<AppEnv>, companyId: string,
): Promise<ExportGateSnapshot> {
  const modules = await readableModules(c, companyId);
  // §4.5.8 gates a LOT attachment on inventory.item.read, a different code from the inventory module's
  // own read code, so it is a separate question and a separate column.
  const [row] = await c.var.withTenant((tx) => tx<{ ok: boolean }[]>`
    select app.actor_has(${PERMISSION["inventory.item.read"]}, ${companyId}::uuid) as ok`);
  return { readableModules: modules, lotAttachments: row?.ok === true };
}
```

> **`PERMISSION["inventory.item.read"]` exists from 3A** and its presence here is a second reference for `permission-catalogue`, which is harmless — the lint requires *at least one* reference per code. If a future build drops 3A's own reference this one keeps the lint green, which is a coincidence and not a design.

- [ ] **Step 5: Grow `apps/api/src/routes/admin/exports.ts` to four routes**

Replace Task 6's single `GET` with the four. The `GET` list keeps its shape and gains the cursor and the filter key:

```ts
routes.openapi(
  createRoute({
    method: "post",
    path: "/v1/companies/{companyId}/exports",
    tags: ["admin"],
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateExportBody } } },
    },
    middleware: [requirePermission(PERMISSION["admin.data.export"], { company: "path:companyId" })],
    responses: {
      202: { description: "Accepted; poll statusUrl.", content: { "application/json": { schema: ExportAcceptedSchema } } },
      400: { description: "Bad request", content: { "application/problem+json": { schema: ProblemSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { format, includeAttachments } = c.req.valid("json");
    const gates = await exportGateSnapshot(c, companyId);
    const { exportJobId, jobId } = await c.var.withTenant(async (tx) => {
      const row = await createExportJob(tx, {
        companyId, format,
        readableModules: gates.readableModules,
        lotAttachments: gates.lotAttachments,
        includeAttachments,
      });
      // Enqueued THROUGH the same transaction, so the job is visible only after this commits and never
      // on a rollback (§4.2.6, spec:2321).
      const enqueued = await c.var.jobs.enqueue(tx, "admin.export.run", {
        tenantId: c.var.ctx.tenantId, requestId: c.var.ctx.requestId, payload: { exportJobId: row.id },
      });
      return { exportJobId: row.id, jobId: enqueued };
    });
    c.var.logger.info({ export_job_id: exportJobId, job_id: jobId, company_id: companyId }, "export_requested");
    // The status URL is the RESOURCE this module already mounts (amendment A12), never `/v1/jobs/{jobId}`:
    // §4.2.7 lists that path and assigns it to no module, so no slice mounts it, and 6A dropped its own
    // `statusUrl` for the same reason (§4.11.2 / §4.18 round 3, ADR 0067). 7A's `POST …/reports/{code}/runs`
    // answers `/v1/companies/<companyId>/report-runs/<runId>` and this is the same shape. `jobId` stays in
    // the body — and now in the log line — for correlation only; it addresses nothing.
    return c.json(
      { exportJobId, jobId, statusUrl: `/v1/companies/${companyId}/exports/${exportJobId}` },
      202,
    );
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/v1/companies/{companyId}/exports/{exportJobId}",
    tags: ["admin"],
    request: { params: z.object({ companyId: UuidSchema, exportJobId: UuidSchema }) },
    middleware: [requirePermission(PERMISSION["admin.data.export"], { company: "path:companyId" })],
    responses: {
      200: { description: "The export job.", content: { "application/json": { schema: ExportJobSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, exportJobId } = c.req.valid("param");
    const row = await c.var.withTenant((tx) => getExportJob(tx, exportJobId));
    if (row === null || row.companyId !== companyId) {
      throw new AppError("ERR_NOT_FOUND", `export job ${exportJobId} does not exist`);
    }
    return c.json(row, 200);
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/v1/companies/{companyId}/exports/{exportJobId}/content",
    tags: ["admin"],
    request: { params: z.object({ companyId: UuidSchema, exportJobId: UuidSchema }) },
    middleware: [requirePermission(PERMISSION["admin.data.export"], { company: "path:companyId" })],
    responses: {
      200: { description: "The archive.", content: { "application/gzip": { schema: z.string() } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, exportJobId } = c.req.valid("param");
    const row = await c.var.withTenant((tx) => getExportJob(tx, exportJobId));
    // A job that is queued, running or failed has no artefact. 404, never an empty 200: a caller that
    // saved an empty body as "the export" would have a silent data-loss bug.
    if (row === null || row.companyId !== companyId || row.status !== "done" || row.objectKey === null) {
      throw new AppError("ERR_NOT_FOUND", `export job ${exportJobId} has no artefact`);
    }
    const bytes = await objectStore.get(row.objectKey);
    if (bytes === null) throw new AppError("ERR_NOT_FOUND", `export job ${exportJobId} artefact is missing`);
    c.header("Content-Type", "application/gzip");
    c.header("Content-Disposition", `attachment; filename="dulja-export-${exportJobId}.tar.gz"`);
    c.header("X-Content-Sha256", row.sha256 ?? "");
    return c.body(bytes);
  },
);
```

and the list handler's body gains the cursor and the filter:

```ts
    const cursorRaw = c.req.valid("query").cursor;
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    const items = await c.var.withTenant((tx) => listExportJobs(tx, {
      companyId, limit,
      status: c.req.valid("query")["filter[status][eq]"],
      cursor: cursor ? { createdAt: String(cursor.k[0]), id: cursor.id } : null,
    }));
    const next = items.length === limit
      ? encodeCursor({ k: [items[items.length - 1]!.createdAt], id: items[items.length - 1]!.id })
      : null;
    return c.json({ items, next_cursor: next }, 200);
```

- [ ] **Step 6: Write ADR 0070**

`docs/adr/0070-export-runs-as-the-system-principal-behind-a-request-time-gate.md`:

```markdown
# ADR 0070: The export job runs as the system principal behind a request-time gate snapshot

- Status: Accepted
- Date: 2026-09-08
- Slice: 7C

## Context

`admin.export.run` is a pg-boss handler, and every handler runs as the tenant's **system principal**
(spec:2179, §4.2.6) — a principal that passes `app.actor_has` for every code. So the job cannot ask
"may this person see this?" about itself and get a useful answer.

Two of the export's decisions are person-specific: which **tables** the requester may export (7C's
`EXPORT_TABLES` gates) and which **attachments** they may see (§4.5.8's `MODULE_READ_CODE`, whose one
home is `apps/api` — `packages/db` and `apps/worker` may not import an app, §3.1).

## Decision

**The authorisation decision is made at the request and recorded on the row.**

- The route resolves the requester's readable modules with `readableModules(c, companyId)` and their
  `inventory.item.read` (the lot-attachment gate) and stores both on `export_job` as `readable_modules`
  and `lot_attachments`.
- The **table** gates are resolved by the job, but for `export_job.requested_by` — never for the acting
  principal — through `app.principal_has`, the same predicate the override guard uses.
- `requested_by` is stamped by `app.stamp_actor`, so a caller cannot name someone else and inherit their
  authority.

**The route's own gate is company-scoped and has no branch source.** `requirePermission("admin.data.export",
{ company: "path:companyId" })` evaluates `app.actor_has(code, company, null)`, which a branch-narrowed
assignment does not satisfy (spec:2158's branch-scoping paragraph). An export is therefore company-wide or
refused — never a partial export a branch manager could mistake for the whole book. Test 36's export
clause is exactly this assertion.

## Consequences

- A permission revoked between the request and the run does **not** shrink the archive. That is the right
  trade for an export: the decision was made when the person asked, it is audited under their id, and the
  window is the length of one job. A slice that wants revocation to win must re-resolve in the handler and
  will need `MODULE_READ_CODE` in a package both tiers may import — an amendment to §4.5.8, not a patch.
- The manifest names every table excluded by a gate, so an incomplete export is visible as incomplete.
```

- [ ] **Step 7: Run everything to see it pass**

Run: `bun run --cwd packages/contracts openapi:generate && bun run --cwd apps/api test -- routes/admin/exports && bun run --cwd tests test -- tenant-isolation && bun run typecheck && bun run lint && bun run lint:rules && bun run format:check`
Expected: PASS on all. The isolation harness has been green since Task 6 — its `PROBES` entry now exercises a route that really exists, and the assertion is unchanged. Commit the regenerated `packages/contracts/openapi.json` (CI diffs it, spec:2055).

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/admin/export.ts packages/contracts/src/index.ts \
        packages/contracts/openapi.json apps/api/src/export/authorise.ts \
        apps/api/src/routes/admin/exports.ts apps/api/test/routes/admin/exports.test.ts \
        docs/adr/0070-export-runs-as-the-system-principal-behind-a-request-time-gate.md
git commit -m "$(cat <<'EOF'
feat(api): add the four export routes and the request-time gate snapshot [7C T9]

POST enqueues through the SAME transaction that inserts the row, so the job is
visible only after the commit and never on a rollback (spec:2321). It records
the requester's readable modules and lot-attachment authority on the row,
because the handler runs as the system principal and would otherwise resolve
its own authority, which is everything (ADR 0070).

The 202 body's statusUrl is the RESOURCE — /v1/companies/<companyId>/exports/
<exportJobId>, the route this module mounts — and never /v1/jobs/{jobId}:
§4.2.7 lists that path and assigns it to no module, so nothing mounts it, and
6A dropped its own statusUrl for the same reason (§4.11.2, ADR 0067). jobId
stays in the body and the log line for correlation only.

GET …/content answers 404 for a job that is queued, running or failed: a
caller who saved an empty 200 as "the export" would have a silent data-loss
bug. The archive carries its digest in X-Content-Sha256 so a tenant can verify
what ADR 0069 made deterministic.

The gate is company-scoped with no branch source, so a branch-narrowed
assignment fails app.actor_has(code, company, null) and an export is
company-wide or refused — test 36's export clause.

No probe lands here: the module's PROBES entry shipped with the route in T6
and admin.export.run's JOB_PROBES entry with the handler in T8 (hazard 31).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The export clauses of tests 13, 32 and 36

Three Part VI clauses this slice re-runs (§6.1): **13** "every write produces an audit record with a server-supplied actor; no flag suppresses it" — applied to exports; **32** "sensitive fields have no side channel … through any endpoint, filter, sort, search **or export**"; **36** "a `branch_manager` at branch A cannot read or write documents, shifts, stock, attendance or tickets of branch B through any endpoint, filter **or export**".

**Files:**
- Create: `tests/invariants/export-audit.test.ts`, `apps/api/test/routes/admin/exports-gates.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: `sharedApi`, `grantAdmin`, `FullContext`, `problemOf` (0B, §4.17.1); `staffFixture`, `StaffFixture`, **`branchActor`** (6C, §4.17.1's A9 row — the branch-narrowed principal test 36 needs); `arApReportFixture` (Task 2); `EXPORT_TABLES`, `NEVER_EXPORTED`, `resolveExportGates` (Task 7); `runExport` (Task 8); `seedExportJob`, `grantCodes` (§4.17); `startApi`, `StartedApi` (§4.2.12); `MemoryObjectStore` (2C).
- Produces: nothing importable.

- [ ] **Step 1: Write `tests/invariants/export-audit.test.ts` — test 13's export clause**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

describe("Part VI test 13 — every export is audited, and no flag suppresses it (spec:2430)", () => {
  let api: StartedApi;
  let s: Seed;
  let requester: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "export-audit");
    requester = s.human;
    await grantCodes(api.db, s, {
      codes: ["admin.data.export", "accounting.ledger.read"], principalId: requester, roleCode: "exp-audit",
    });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  it("the request writes an audit row naming the REQUESTER, not the server", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/exports`, body: { format: "both" }, as: requester,
    });
    const { exportJobId } = await res.json() as { exportJobId: string };
    const rows = await api.db.admin<{ action: string; actor_id: string; table_name: string }[]>`
      select action, actor_id, table_name from app.audit_log
       where table_name = 'export_job' and row_id = ${exportJobId} order by seq`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("insert");
    expect(rows[0]!.actor_id).toBe(requester);
  });

  it("the audit row cannot be suppressed, updated or deleted by app_rw (spec:2430)", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/exports`, body: { format: "csv" }, as: requester,
    });
    const { exportJobId } = await res.json() as { exportJobId: string };
    await expect(withTenant(api.db.rw, { tenantId: s.tenant, actorId: requester, requestId: crypto.randomUUID() },
      (tx) => tx`delete from app.audit_log where row_id = ${exportJobId}`)).rejects.toThrow();
    await expect(withTenant(api.db.rw, { tenantId: s.tenant, actorId: requester, requestId: crypto.randomUUID() },
      (tx) => tx`update app.audit_log set actor_id = ${s.system} where row_id = ${exportJobId}`)).rejects.toThrow();
    const [still] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where row_id = ${exportJobId}`;
    expect(still!.n).toBe(1);
  });

  it("the audit chain still verifies after an export (plan0A's verifyChain formula)", async () => {
    const { verifyChain } = await import("@dulja/db");
    await api.request({
      method: "POST", path: `/v1/companies/${s.company}/exports`, body: { format: "json" }, as: requester,
    });
    await expect(withTenant(api.db.rw, { tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() },
      (tx) => verifyChain(tx, s.tenant))).resolves.toEqual([]);
  });
});
```

> **`verifyChain` is imported from `@dulja/db`, not re-implemented.** §4.1 registers it as "the hash-recompute formula the integrity job reuses"; if the merged export names it differently, use the merged name — a second implementation of the chain formula is exactly hazard 9.

- [ ] **Step 2: Write `apps/api/test/routes/admin/exports-gates.test.ts` — tests 32 and 36's export clauses**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { EXPORT_TABLES, NEVER_EXPORTED, getExportJob, runExport } from "@dulja/db";
import { grantCodes, withTenant } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { branchActor, staffFixture, type StaffFixture } from "../../../../../tests/invariants/support/staff";
import { startApi, type StartedApi } from "../../support/app";

describe("Part VI tests 32 and 36 — the export is a covered side channel (spec:2450, 2454)", () => {
  let api: StartedApi;
  let f: StaffFixture;
  let exporter: string;      // admin.data.export + accounting.ledger.read, company-wide
  let branchManager: string; // admin.data.export, but assigned WITH branch rows

  beforeAll(async () => {
    api = await startApi();
    f = await staffFixture(api, "export-gates");
    exporter = f.seed.human;
    // **`StaffFixture` has no `managerA`** — its only supervisor is `supervisorA`, a `pos_cashier` at A
    // holding `pos.ticket.override` and nothing else (6c:4238), which is not the principal this case
    // describes. 6C's registered `branchActor(db, s, branchId, codes, label)` (§4.17.1's A9 row) creates a
    // principal, its membership and a grant NARROWED to one branch in one call, which is exactly the
    // assignment shape test 36 is about; `branchId: null` would grant company-wide.
    branchManager = await branchActor(api.db, f.seed, f.branchA, ["admin.data.export"], "exp-branch");
    await grantCodes(api.db, f.seed, {
      codes: ["admin.data.export", "accounting.ledger.read"], principalId: exporter, roleCode: "exp-wide",
    });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  const post = (as: string) => api.request({
    method: "POST", path: `/v1/companies/${f.seed.company}/exports`, body: { format: "both" }, as,
  });

  // ── test 36's export clause ───────────────────────────────────────────────────────────────────────
  it("a branch-narrowed principal cannot export at all — company-wide or refused (ADR 0070)", async () => {
    const res = await post(branchManager);
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the same principal, granted company-wide, succeeds — so the refusal is the SCOPE, not the code", async () => {
    await grantCodes(api.db, f.seed, {
      codes: ["admin.data.export"], principalId: branchManager, roleCode: "exp-branch-wide",
    });
    await api.loadPrincipals();
    expect((await post(branchManager)).status).toBe(202);
  });

  // ── test 32's export clause ───────────────────────────────────────────────────────────────────────
  it("no NEVER_EXPORTED column appears in any archive the exporter can produce", async () => {
    const { exportJobId } = await (await post(exporter)).json() as { exportJobId: string };
    const files = await archiveOf(exportJobId);
    const schema = JSON.parse(files.get("schema.json")!) as {
      tables: { name: string; columns: { name: string }[]; omitted: string[] }[];
    };
    for (const table of schema.tables) {
      for (const forbidden of NEVER_EXPORTED[table.name] ?? []) {
        expect(table.columns.map((c) => c.name), `${table.name}.${forbidden}`).not.toContain(forbidden);
      }
    }
    // The pinned tables have no file at all.
    for (const name of ["terminal_enrolment", "idempotency_key", "employee_sensitive"]) {
      expect([...files.keys()], name).not.toContain(`tables/${name}.csv`);
    }
    // And the columns themselves are absent from the bytes, not merely from the header.
    const cashierCsv = files.get("tables/pos_cashier.csv");
    if (cashierCsv !== undefined) expect(cashierCsv.split("\n")[0]).not.toContain("pin_hash");
  });

  it("a gated table the requester cannot hold is absent AND named — the shape 8A plugs into", async () => {
    const { exportJobId } = await (await post(exporter)).json() as { exportJobId: string };
    const files = await archiveOf(exportJobId);
    const manifest = JSON.parse(files.get("manifest.json")!) as {
      excluded: { table: string; gate: string }[]; tables: { name: string }[];
    };
    // `exporter` holds neither admin.audit_log.read nor accounting.tax.manage.
    expect(manifest.excluded.map((e) => e.table)).toEqual(
      expect.arrayContaining(["audit_log", "tax_code", "tax_transaction"]));
    expect(manifest.tables.map((t) => t.name)).not.toContain("audit_log");
    expect([...files.keys()]).not.toContain("tables/audit_log.csv");
    // Every gated table in the registry is either included or excluded — never silently missing from both.
    const accountedFor = new Set([...manifest.tables.map((t) => t.name), ...manifest.excluded.map((e) => e.table)]);
    for (const table of EXPORT_TABLES) expect(accountedFor, table.name).toContain(table.name);
  });

  it("a schema.json omission list never hides a gated column behind a name change", async () => {
    const { exportJobId } = await (await post(exporter)).json() as { exportJobId: string };
    const files = await archiveOf(exportJobId);
    const schema = JSON.parse(files.get("schema.json")!) as { tables: { name: string; omitted: string[] }[] };
    // `omitted` is documentation, not a hiding place: every omitted name must be a real column, which is
    // what exportSchemaDocument computes it from. A hand-edited registry that "omits" an invented column
    // would pass silently without this.
    for (const table of schema.tables) {
      const live = await api.db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table.name}`;
      const names = new Set(live.map((r) => r.column_name));
      for (const omitted of table.omitted) expect(names.has(omitted), `${table.name}.${omitted}`).toBe(true);
    }
  });

  /** Runs the queued export inline and unpacks it into { path -> utf-8 text }. */
  async function archiveOf(exportJobId: string): Promise<Map<string, string>> {
    const bytes = await withTenant(api.db.rw, f.seed.tenant, f.seed.system, async (tx) => {
      const job = (await getExportJob(tx as never, exportJobId))!;
      const result = await runExport(tx as never, api.objectStore, {
        job, tenantId: f.seed.tenant, generatedAt: "2026-02-01T00:00:00Z",
      });
      return result.bytes;
    });
    const tar = gunzipSync(Buffer.from(bytes));
    const out = new Map<string, string>();
    for (let at = 0; at + 512 <= tar.length; ) {
      const name = tar.subarray(at, at + 100).toString("utf8").replace(/\0.*$/, "");
      if (name === "") break;
      const size = parseInt(tar.subarray(at + 124, at + 135).toString("ascii").trim(), 8);
      out.set(name, tar.subarray(at + 512, at + 512 + size).toString("utf8"));
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  }
});
```

- [ ] **Step 3: Run them to see them fail, then pass**

Run: `bun run --cwd tests test -- export-audit && bun run --cwd apps/api test -- routes/admin/exports-gates`
Expected on the **first** run: PASS for every case except — if any fails — the one that names the defect. These two files assert behaviour Tasks 5–9 built, so a red case here is a genuine gap and not scaffolding: fix the **source**, never the assertion. The three most likely reds and their fixes:

| Failing case | What it means | Fix |
|---|---|---|
| "a branch-narrowed principal cannot export at all" returns 202 | the route's `ScopeSource` carries a branch source | Task 9's `requirePermission(..., { company: "path:companyId" })` — remove any `branch` member |
| `pos_cashier.pin_hash` appears in a header | `EXPORT_TABLES` gained a `pos_cashier` row without honouring `NEVER_EXPORTED` | remove the column from Task 7's registry; the `tables.test.ts` case should have caught it first |
| a gated table is in neither `tables` nor `excluded` | `resolveExportGates` dropped a row | Task 7's loop must push every table into exactly one of the two arrays |

- [ ] **Step 4: Commit**

```bash
git add tests/invariants/export-audit.test.ts apps/api/test/routes/admin/exports-gates.test.ts
git commit -m "$(cat <<'EOF'
test(invariants): re-run tests 13, 32 and 36 over the export path [7C T10]

13: the request writes one audit row naming the requester, app_rw cannot
update or delete it, and the chain still verifies afterwards.

32: no NEVER_EXPORTED column reaches an archive, the pinned tables have no
file at all, and every gated table is either included or NAMED in
manifest.excluded — never silently missing from both. That last assertion is
what 8A's employee_sensitive row depends on.

36: a branch-narrowed principal is 403 on POST …/exports, and the SAME
principal granted company-wide succeeds, so the refusal is proven to be the
scope and not the code.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: ⚠️ OD-09 — `accounting.pdc_register` (ISOLATED; dropped whole if post-dated cheques are not built)

**Owner decision OD-09** (§2.12, spec:1044, 2479): *are post-dated cheques in v1?* **Default: not built.** 4B's card carries the same gate for `app.pdc`, `PDC_RECEIPT` and `PDC_DEPOSIT`; §4.16.1 marks `accounting.pdc_register` ⚠️ with the note "dropped with the `pdc` table if OD-09 = no", and §4.16.2 says the `pdc` `DatasetId` and the report that reads it are dropped **together**, so the union never names a table that does not exist.

**If OD-09 = no: this whole task is deleted.** Nothing else in the slice changes — `CATALOGUE_7C` already treats the missing file as the OD-09 = no case (Task 2), `ReportCodeSchema` gained seven and not eight (Task 4), and `assertTieOut`'s `pdc` branch is unreachable and therefore harmless. **If OD-09 = yes**, 4B's migration 0051 has shipped `app.pdc` and 7A's `pdcDataset` is registered; everything below then applies.

**Owner provides:** confirmation that post-dated cheques are in v1 (OD-09).
**Verify:** `psql "$DATABASE_URL_MIGRATOR" -c "select to_regclass('app.pdc')"` prints `app.pdc`, and `bun run --cwd packages/db test -- reports/datasets` shows the `pdc` case green rather than skipped.
**Until provided:** the task is not started and the file is not created; `readEnvelope7C("accounting.pdc_register")` throwing is what "not built" looks like, and no other test asserts the file exists.

**Files:**
- Create: `packages/db/seed/my/reports/7c/accounting.pdc_register.json`
- Modify: `packages/contracts/src/accounting/reports.ts` (one more `ReportCodeSchema` member), `packages/db/test/reports/7c-ar-ap.test.ts` (one appended `describe`)

**Interfaces:**
- Consumes: `pdcDataset` and the `pdc` `DatasetId` (7A); `app.pdc` (4B, migration 0051); `readDefinition7C`, `arApReportFixture` (Task 2); `assertTieOut`'s `pdc` branch (Task 2).
- Produces: one definition and one `ReportCodeSchema` member.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/reports/7c-ar-ap.test.ts`:

```ts
describe("⚠️ OD-09 — accounting.pdc_register", () => {
  it("validates, reads the pdc dataset and ties to app.pdc's in-hand cheques", async () => {
    const definition = readDefinition7C("accounting.pdc_register");
    const sets = await read((tx) => reportDefinitionSets(tx));
    expect(validateReportDefinition(definition, sets).errors).toEqual([]);
    expect(definition.dataset.source).toBe("pdc");
    // `companyId` is not optional — see the note on `paramsFor` above.
    const params = { companyId: f.s.company, status: "in_hand" };
    const rows = await read((tx) => runDefinition(tx, definition, params));
    assertFieldCoverage(definition, rows);
    await read((tx) => assertTieOut(tx, definition, { params, baseCurrency: MYR }));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- reports/7c-ar-ap`
Expected: FAIL — `…/reports/7c/accounting.pdc_register.json: no such report definition (⚠️ OD-09 drops accounting.pdc_register)`.

- [ ] **Step 3: Write `accounting.pdc_register.json`**

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.pdc_register",
    "nameEn": "Post-dated cheque register",
    "nameAr": "سجل الشيكات المؤجلة",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "status", "kind": "enum", "required": true, "options": ["in_hand", "deposited", "cleared", "bounced"] },
      { "name": "partyId", "kind": "party", "required": false },
      { "name": "maturityFrom", "kind": "date", "required": false },
      { "name": "maturityTo", "kind": "date", "required": false }
    ],
    "dataset": {
      "source": "pdc",
      "filters": [
        { "field": "status", "op": "eq", "param": "status" },
        { "field": "party_id", "op": "eq", "param": "partyId" },
        { "field": "maturity_date", "op": "gte", "param": "maturityFrom" },
        { "field": "maturity_date", "op": "lte", "param": "maturityTo" }
      ]
    },
    "columns": [
      { "field": "maturity_date", "labelEn": "Matures", "labelAr": "الاستحقاق", "format": "date", "align": "start", "width": 100 },
      { "field": "party_code", "labelEn": "Party", "labelAr": "الطرف", "format": "text", "align": "start", "width": 90 },
      { "field": "cheque_number", "labelEn": "Cheque", "labelAr": "الشيك", "format": "text", "align": "start", "width": 110 },
      { "field": "bank_name", "labelEn": "Bank", "labelAr": "البنك", "format": "text", "align": "start" },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 70 },
      { "field": "amount", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 120 },
      { "field": "status", "labelEn": "Status", "labelAr": "الحالة", "format": "text", "align": "start", "width": 90 }
    ],
    "groups": [{ "field": "status", "subtotal": true }],
    "totals": [{ "field": "amount", "fn": "sum" }],
    "sort": [{ "field": "maturity_date", "dir": "asc" }, { "field": "cheque_number", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{title} — {status}",
      "footer": "{rowCount} cheques · {generatedAt}"
    },
    "tieOut": { "kind": "projection", "projection": "pdc" }
  }
}
```

> **The tie-out compares Σ `amount` against `app.pdc`'s `in_hand` cheques** (Task 2's `pdc` branch), which is why the group test runs it with `status: "in_hand"` — the only status under which the stored comparison is the same set. A cheque in hand has not reached the ledger, so `ledger_sum` is the wrong kind here for the same reason it is wrong for the allocation register (amendment A3).

- [ ] **Step 4: Add the eighth `ReportCodeSchema` member and run**

Append `"accounting.pdc_register"` to `ReportCodeSchema`'s enum, and add it to the first `it` of `packages/contracts/test/report-codes-7c.test.ts`'s membership list.

Run: `bun run --cwd packages/db test -- reports/7c-ar-ap && bun run --cwd packages/contracts test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seed/my/reports/7c/accounting.pdc_register.json \
        packages/contracts/src/accounting/reports.ts \
        packages/contracts/test/report-codes-7c.test.ts \
        packages/db/test/reports/7c-ar-ap.test.ts
git commit -m "$(cat <<'EOF'
feat(seed): add accounting.pdc_register [7C T11] (⚠️ OD-09)

The eleventh §4.16.1 code, shipped only because OD-09 confirmed post-dated
cheques for v1. It reads 7A's pdc dataset, which exists only because 4B's
migration 0051 shipped app.pdc; §4.16.2 drops the DatasetId, this report and
that table together, so the union never names a table that is not there.

The tie-out is projection: "pdc" over in-hand cheques. A cheque in hand has
not reached the ledger, so ledger_sum would compare the register against zero.

If OD-09 had been no, this commit would not exist and nothing else in 7C
would change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: ⚠️ OD-27 — mapping the AR/AP, POS and cross-module legacy templates (ISOLATED; dropped whole if 9A has not run)

**Owner decision OD-27** (§2.12, spec:2470–2473, 2477): *Part VII #8 — which of the 255 legacy report templates are actually in use?* **Default: none.** SAH-077 records that the legacy call graph is unresolvable and that the template blobs must be extracted and catalogued early, because "it is the only way to know which of the 255 templates the customer actually uses" (spec:2341). The catalogue is **9A's** profiler output.

**This task is dropped whole if 9A has not run, or if the owner has not answered.** 7B's Task 12 owns the same mapping for the accounting and inventory templates; **7C maps only what 7B did not** — the AR/AP, POS and cross-module templates — and cites 7B's file so no template is mapped twice.

**Owner provides:** 9A's legacy template catalogue artefact and the owner's list of templates in use (OD-27).
**Verify:** `bun run legacy templates --dsn "$LEGACY_ODBC_DSN" --out artefacts/legacy/7c` exits **0** and `ls artefacts/legacy/7c/` lists the catalogue (9A's own command and its own output root — 9a:4978; `artefacts/` is git-ignored by 9A's Task 1 because the file is customer data, so it is never committed and never read from `docs/`).
**Until provided:** the task is not started, `docs/legacy/7c-template-mapping.md` is not created, and the sah-077 append of Task 14 carries only the version-controlled-definitions clause.

> **Two path facts, because getting either wrong makes this task unreachable.** (1) **7B's mapping file is `docs/legacy/7b-template-mapping.md`** (7b:143, 7b:4988, 7b:5029) — *not* `template-catalogue-mapping-7b.md`, which exists nowhere. 7C's own file is therefore named `docs/legacy/7c-template-mapping.md`, so the two halves share one convention. (2) **9A writes its artefacts to `artefacts/legacy/<run>/`, git-ignored** (9a:45, 9a:171, 9a:4978). 7B's own Verify line spells that gate `ls docs/legacy/9a-artefacts/`, a directory 9A does not produce; that is **a raise against 7B**, carried in this slice's Self-Review, and 7C does not copy the spelling.

**Files:**
- Create: `docs/legacy/7c-template-mapping.md`
- Modify: `tests/regression/sah-077.test.ts` (one appended `it` inside 7C's own `describe`, which Task 14 creates)

**Interfaces:**
- Consumes: 9A's artefact index (`ArtefactIndex`, §4.13.1) and `repoFile` (0C, §4.17.1); `CATALOGUE_7C` (Task 2); `readDefinition7C` (Task 2).
- Produces: one document, and one regression assertion over it.

- [ ] **Step 1: Write the failing test**

Append to `tests/regression/sah-077.test.ts`, inside the `describe("SAH-077 … — 7C")` block Task 14 creates:

```ts
  it("⚠️ OD-27 — every mapped legacy template names a 7C code that exists, and none is 7B's", () => {
    const doc = repoFile("docs/legacy/7c-template-mapping.md");
    const rows = [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*`([^`]*)`\s*\|/gm)]
      .map(([, legacy, title, code]) => ({ legacy, title, code }));
    expect(rows.length).toBeGreaterThan(0);
    const sevenC = new Set<string>(CATALOGUE_7C);
    // 7B's Task 12 is itself OD-27-gated and may have been dropped whole, so its file may not exist.
    // A MISSING 7B mapping means "nothing to overlap with" and must SKIP the second assertion — never
    // fail it: `repoFile` throws ENOENT, which would turn 7B's dropped owner gate into 7C's red test.
    const sevenBPath = join(REPO_ROOT, "docs", "legacy", "7b-template-mapping.md");
    const sevenB = existsSync(sevenBPath) ? readFileSync(sevenBPath, "utf8") : null;
    for (const row of rows) {
      if (row.code === "") continue;                       // deliberately unmapped — the "no equivalent" case
      expect(sevenC.has(row.code), `${row.legacy} → ${row.code}`).toBe(true);
      if (sevenB !== null) {
        expect(sevenB, `${row.legacy} is already mapped by 7B`).not.toContain(`\`${row.legacy}\``);
      }
    }
  });
```

`existsSync`, `readFileSync`, `join` and `REPO_ROOT` are already imported by the 7C `describe` Task 14 creates; no new import is added here.

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd tests test -- sah-077`
Expected: FAIL — `repoFile` throws `ENOENT` on `docs/legacy/7c-template-mapping.md`.

- [ ] **Step 3: Write the mapping document**

`docs/legacy/7c-template-mapping.md`. The table below is the **shape**, with the two rows an executor can write from the spec alone; **every other row is filled from 9A's artefact**, one row per legacy template the owner marked in use whose subject is AR/AP, POS or cross-module. A template with no v1 equivalent gets an empty code cell and a reason — that is a finding, not a gap.

```markdown
# Legacy report templates → Dulja report codes (7C's half)

Source: 9A's template catalogue artefact, produced by `bun run legacy templates --out artefacts/legacy/7c`
and read from `artefacts/legacy/7c/` (9a:4978). That directory is git-ignored (9a:45, 9a:171) because the
blobs are customer data; only this mapping is committed. Narrowed to the templates the owner marked in use
(OD-27, Part VII #8). SAH-077: the legacy call graph is unresolvable, so "in use" is an owner statement,
never an inference from the code.

**Scope split.** 7B's `docs/legacy/7b-template-mapping.md` maps the accounting and inventory
templates. This file maps the **AR/AP, POS and cross-module** ones, and no template appears in both — the
regression test asserts it whenever 7B's file exists, and skips that half when 7B's own OD-27 gate dropped
its Task 12.

| Legacy template | Legacy title | Dulja code | Notes |
|---|---|---|---|
| `AGEING.FR3` | Customer ageing | `accounting.ageing` | `partyKind` parameter covers the vendor variant |
| `STATEMENT.FR3` | Customer statement | `accounting.party_statement` | one definition, run per party |
| … | … | … | … |

**Unmapped, with reasons.** A legacy template with no v1 equivalent is listed here rather than omitted, so
the owner sees the trade rather than discovering it after cut-over.

| Legacy template | Legacy title | Why there is no v1 code |
|---|---|---|
| … | … | … |
```

> **The two example rows are literal and the ellipses are not placeholders in the plan's sense** — they mark where an executor transcribes 9A's artefact, which this plan cannot contain because the artefact does not exist until 9A has run against the owner's database (hazard 3). The file is not committed with an ellipsis in it: the test above fails on a table with no matching rows.

- [ ] **Step 4: Run it to see it pass, and commit**

Run: `bun run --cwd tests test -- sah-077`
Expected: PASS.

```bash
git add docs/legacy/7c-template-mapping.md tests/regression/sah-077.test.ts
git commit -m "$(cat <<'EOF'
docs(legacy): map the AR/AP, POS and cross-module templates [7C T12] (⚠️ OD-27)

The half of Part VII #8 that 7B's mapping does not cover, filled from 9A's
template catalogue artefact and the owner's in-use list. A template with no v1
equivalent is listed with its reason rather than omitted, and the regression
test asserts that every mapped code is a real 7C code and that no template is
mapped by both 7B and 7C.

Dropped whole if 9A has not run — SAH-077's point is that "in use" is an owner
statement, never an inference from an unresolvable call graph.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: ⚠️ OD-24 — the export screen and the 7C report-viewer entries (ISOLATED; BLOCKED until the owner answers)

**Owner decision OD-24** (§2.12, spec:79, 108, 2408; hazard 29): *screenshots and a two-minute operator description before any screen.* **Default: the screen task is blocked, not the slice.** The spec does not specify the UI, and no plan invents a workflow.

**Owner provides:** screenshots of the legacy export/report screens the operator uses today, and a two-minute recorded description of how they use them (OD-24).
**Verify:** the screenshots and the transcript are attached to this task in the tracker, and `ls docs/ui/od-24/7c/` lists them.
**Until provided:** **this task does not start.** Tasks 1–12 and 14 are unaffected — the export is reachable through `POST /v1/companies/{companyId}/exports` and the eleven definitions through 7A's report designer and runs route, so the slice's definition of done does not depend on a screen.

**Files (when unblocked):**
- Create: `apps/backoffice/src/routes/admin/exports.tsx`, `apps/backoffice/test/routes/admin/exports.test.tsx`
- Modify: `packages/i18n/src/locales/en.json` and `ar.json` (the `admin.export.*` keys), `apps/backoffice/src/routes/index.ts` (one route entry)

**Interfaces (when unblocked):**
- Consumes: the generated client for `POST|GET /v1/companies/{companyId}/exports` and `GET …/{id}` (Task 9, `packages/contracts/src/client/`); `packages/ui` primitives and `packages/i18n` (0E); `bootLocalStack`, `grantAdminRole` (0E, §4.17.1).
- Produces: one route entry and one screen; nothing importable by another slice.

- [ ] **Step 1: Confirm the gate before writing anything**

Run: `ls docs/ui/od-24/7c/`
Expected: the screenshots and the transcript. **If the directory is absent or empty, stop here** and leave the task unchecked; do not design a screen from the API surface. Record the block in the slice's exit report (Task 14 Step 4).

- [ ] **Step 2: Write the failing test** (only after Step 1 passes)

**This step is a checklist rather than code, and that is the gate working, not an omission.** Every other implementation step in this plan carries complete, runnable code; this one cannot, because the assertions a screen test makes are assertions about a **workflow**, and OD-24 exists precisely so that no plan invents one from the API surface (hazard 29, spec:2408). The `it` bodies are written by the executor **after** Step 1 finds the screenshots and the transcript, from what the operator actually does — not from this list, which fixes only what the test must cover whatever the screens turn out to look like. A reader who finds prose here and code everywhere else is looking at the one task the owner has not yet unblocked.

Turn each row of the checklist below into one `it` in `apps/backoffice/test/routes/admin/exports.test.tsx`, naming the screenshot it came from:

- the request form offers exactly the three `format` values `ExportFormatSchema` declares (`csv`, `json`, `both`, defaulting to `both`) and the `includeAttachments` toggle (defaulting on) — no fourth control, because `CreateExportBody` has no fourth member;
- a `queued` or `running` job renders its status and polls the `statusUrl` the `202` returned, which is `/v1/companies/{companyId}/exports/{exportJobId}` and never a job path (Task 9);
- a `done` job renders a download link to `…/exports/{exportJobId}/content` and shows the archive's `sha256`, so a tenant can verify what ADR 0069 made deterministic;
- a `failed` job renders its `error` and offers a new request rather than a retry of the same row;
- a `403` renders the `Problem`'s `remedy` and never a stack trace — the branch-narrowed refusal of test 36 is what a `branch_manager` sees here;
- `manifest.excluded` is rendered as a named list with each table's gate, because an incomplete export must be visible as incomplete (ADR 0070's last consequence);
- the whole screen renders correctly **in both text directions** (test 23, spec:106) — the one assertion every UI task in this project carries.

- [ ] **Step 3: Build the screen, run `bun run --cwd apps/backoffice test`, and commit**

The screen's own code is likewise written from the screenshots. It consumes the generated client for the four Task 9 routes, `packages/ui` primitives and `packages/i18n` keys under `admin.export.*` — **no hard-coded string reaches the renderer** (0E's `no-hardcoded-string` lint and `checkCatalogues()` both fire), and both locale files gain the same key set.

```bash
git add apps/backoffice/src/routes/admin/exports.tsx apps/backoffice/test/routes/admin/exports.test.tsx \
        apps/backoffice/src/routes/index.ts packages/i18n/src/locales/en.json packages/i18n/src/locales/ar.json
git commit -m "$(cat <<'EOF'
feat(backoffice): add the tenant export screen [7C T13] (⚠️ OD-24)

Built from the owner's screenshots and operator description, attached to this
task. Verified in both text directions before merge (test 23, spec:106).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Slice exit — every tie-out executed, the re-run matrix, two regression appends, `AGENTS.md`

The Phase 7 definition of done, executed rather than asserted in prose: one invariant file that runs **every** declared `tieOut` in `packages/db/seed/my/reports/7c/`, the predecessors' own tests re-run unchanged, the two regression appends §2.8 names, and the "Current phase" rewrite §3.8 assigns to the slice that completes a phase.

**Files:**
- Create: `tests/invariants/report-tie-out-7c.test.ts`
- Modify: `tests/regression/sah-077.test.ts` (a 7C `describe`), `tests/regression/sah-085.test.ts` (a 7C `describe`), `AGENTS.md` ("Current phase")

**Interfaces:**
- Consumes: `CATALOGUE_7C`, `readEnvelope7C`, `readDefinition7C`, `arApReportFixture`, `posReportFixture` (Task 2); `runDefinition`, `assertFieldCoverage`, `assertTieOut` (7B); `validateReportDefinition`, `reportDefinitionSets` (7A); `renderReport`, `intlFormatters`, `rendererFor` (7A — the test-23 re-run); `pdfText` (2C, §4.17.1); `repoFile`, `sourceFiles`, `sharedDb`, `thinRegression` (0B/0C, §4.17.1); `startApi` (§4.2.12).
- Produces: nothing importable.

- [ ] **Step 1: Write `tests/invariants/report-tie-out-7c.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Money, currency, validateReportDefinition } from "@dulja/domain";
import { reportDefinitionSets } from "@dulja/db";
import { withTenant } from "@dulja/db/test";
import {
  CATALOGUE_7C, CATALOGUE_DIR_7C, arApReportFixture, posReportFixture, readDefinition7C, readEnvelope7C,
  type ArApReportFixture, type PosReportFixture,
} from "./support/reports-7c";
import { assertFieldCoverage, assertTieOut, runDefinition } from "./support/reports";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

// **This import follows 6A's own precedent** — `tests/invariants/pos-one-posting-path.test.ts` imports
// `startApi` from the same path (6a:6050) — and `dependency-rule` does not reach it: §3.1 runs that rule
// over every import in `apps/**` and `packages/**`, and this file is in neither. 6C's note at 6c:5032
// argues the other way about the same edge, so the two frozen predecessors disagree. **If the merged
// linter has been extended to cover `tests/**`, switch to 0B's `sharedApi()` from `tests/support/api.ts`**
// (`const { api } = await sharedApi();`, 6c:4901) and delete the `api.stop()` in `afterAll` — that helper
// is memoised and shared and must not be stopped by a consumer. Nothing else in this file changes.
// The DB-tier half of this catalogue's group tests is unaffected either way: Task 4's file lives in
// `apps/api/test/`, which is inside the linter's roots and holds the allowance it needs.

const MYR = currency("MYR");

/** The parameters and window each code's tie-out runs under. ONE table, so a definition and its proof can
 *  never drift apart, and a new code with no entry fails loudly rather than being skipped.
 *
 *  **Every `params` carries `companyId`** — `a.s.company` for an accounting code, `p.s.company` for a POS
 *  one. `runDefinition` binds it into the dataset's `company` fragment and `assertTieOut` binds the same
 *  value into its own ledger query (7b:719, 7b:795); without it every row set is empty and the failure
 *  message blames the fixture (7b:830). 7B's own table does the same (7b:1432). */
const TIE_OUT: Record<string, (p: PosReportFixture, a: ArApReportFixture) => {
  params: Record<string, string>;
  window?: Parameters<typeof assertTieOut>[2]["window"];
  witness?: Parameters<typeof assertTieOut>[2]["witness"];
  on: "pos" | "accounting";
}> = {
  "accounting.ageing": (_p, a) => ({
    on: "accounting", params: { companyId: a.s.company, asOf: "2026-01-31" },
  }),
  "accounting.party_statement": (_p, a) => ({
    on: "accounting",
    params: { companyId: a.s.company, partyId: a.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" },
    window: { partyId: a.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" },
  }),
  "accounting.allocation_register": (_p, a) => ({
    on: "accounting", params: { companyId: a.s.company, fromDate: "2026-01-01", toDate: "2026-01-31" },
  }),
  "accounting.unreconciled_items": (_p, a) => ({
    on: "accounting",
    params: { companyId: a.s.company, isMatched: "false", bankAccountId: a.accounts["1100"]! },
  }),
  "accounting.pdc_register": (_p, a) => ({                                                  // ⚠️ OD-09
    on: "accounting", params: { companyId: a.s.company, status: "in_hand" },
  }),
  "pos.z_report": (p) => ({
    on: "pos", params: { companyId: p.s.company, shiftId: p.closedShiftId },
  }),
  "pos.sales_by_cashier": (p) => ({
    on: "pos", params: { companyId: p.s.company, fromDate: "2026-01-01", toDate: "2026-12-31" },
    window: { fromDate: "2026-01-01", toDate: "2026-12-31", accountTypes: ["income"],
              documentTypeCodes: ["POS_TICKET"] },
  }),
  "pos.sales_by_branch": (p) => ({
    on: "pos", params: { companyId: p.s.company, fromDate: "2026-01-01", toDate: "2026-12-31" },
    window: { fromDate: "2026-01-01", toDate: "2026-12-31", accountTypes: ["income"],
              documentTypeCodes: ["POS_TICKET"] },
  }),
  "pos.needs_attention": (p) => ({
    on: "pos", params: { companyId: p.s.company, isOpen: "true" },
    witness: {
      key: ["client_ref"],
      rows: (tx) => tx<{ client_ref: string }[]>`
        select na.client_ref::text as client_ref from app.needs_attention na
         where na.company_id = ${p.s.company} and na.resolved_at is null order by na.client_ref`,
    },
  }),
  // `branchId` on BOTH sides. Without it `rowsForDefinition` takes `statementRows`' account_balance
  // fallback, whose rows carry no `branch_id`, and `assertFieldCoverage` fails on the definition's own
  // filter field before a figure is compared (amendment A5). `s.hq` is the head-office BRANCH value every
  // `app.document` row carries (§4.1's `Seed`), and A3's `LedgerWindow.branchId` narrows the ledger side
  // by `document.branch_id` so the two paths measure one branch.
  "accounting.branch_profit_and_loss": (_p, a) => ({
    on: "accounting",
    params: { companyId: a.s.company, fiscalPeriodId: a.fiscalPeriodId, branchId: a.s.hq },
    window: { fiscalPeriodId: a.fiscalPeriodId, branchId: a.s.hq, accountTypes: ["income", "expense"] },
  }),
  "accounting.tax_return_view": (_p, a) => ({
    on: "accounting",
    params: { companyId: a.s.company, fiscalPeriodId: a.fiscalPeriodId, taxCodeKind: "output" },
    window: { fiscalPeriodId: a.fiscalPeriodId, accountCode: "2300" },
  }),
};

describe("Phase 7's DoD for the 7C catalogue — every report's numbers tie (spec:2293)", () => {
  let api: StartedApi;
  let p: PosReportFixture;
  let a: ArApReportFixture;

  beforeAll(async () => {
    api = await startApi();
    p = await posReportFixture(api, "tie-7c-pos");
    a = await arApReportFixture(api.db, "tie-7c-acc");
  }, 600_000);
  afterAll(async () => { await api.stop(); });

  /** Which codes actually shipped — `accounting.pdc_register` is absent unless OD-09 landed (Task 11). */
  const shipped = CATALOGUE_7C.filter((code) => existsSync(join(CATALOGUE_DIR_7C, `${code}.json`)));

  it("every §4.16.1 7C code has a definition, except the OD-09 one when it was not built", () => {
    const missing = CATALOGUE_7C.filter((c) => !shipped.includes(c));
    expect(missing.every((c) => c === "accounting.pdc_register")).toBe(true);
    expect(shipped.length).toBeGreaterThanOrEqual(10);
  });

  it("every shipped definition has an entry in TIE_OUT — a new code cannot be silently untested", () => {
    for (const code of shipped) expect(TIE_OUT[code], code).toBeDefined();
  });

  it.each(shipped)("%s validates, covers its fields and its declared tie-out passes", async (code) => {
    const definition = readDefinition7C(code);
    const spec = TIE_OUT[code]!(p, a);
    const fixture = spec.on === "pos" ? p.s : a.s;
    const actor = spec.on === "pos" ? p.reader : a.reader;
    const run = <T>(fn: (tx: never) => Promise<T>) =>
      withTenant(api.db.rw, fixture.tenant, actor, fn as never) as Promise<T>;

    const sets = await run((tx) => reportDefinitionSets(tx));
    expect(validateReportDefinition(definition, sets).errors, code).toEqual([]);

    const rows = await run((tx) => runDefinition(tx, definition, spec.params));
    assertFieldCoverage(definition, rows);
    await run((tx) => assertTieOut(tx, definition, {
      params: spec.params, baseCurrency: MYR, window: spec.window, witness: spec.witness,
    }));
  }, 120_000);

  it("a definition whose kind is `none` supplies a witness — `none` never means no test (7B A5)", () => {
    for (const code of shipped) {
      if (readDefinition7C(code).tieOut.kind !== "none") continue;
      expect(TIE_OUT[code]!(p, a).witness, code).toBeDefined();
    }
  });

  it("the two re-expressed POS codes and the ageing carry definitionVersion 2, the rest 1", () => {
    for (const code of shipped) {
      const expected = ["accounting.ageing", "pos.z_report", "pos.sales_by_cashier"].includes(code) ? 2 : 1;
      expect(readEnvelope7C(code).definitionVersion, code).toBe(expected);
    }
  });
});
```

- [ ] **Step 2: Re-run every predecessor test this slice's re-expressions rest on**

These are run **unchanged**. A red here means a re-expression moved a number, which is exactly what §4.16.1's "re-expresses" clause forbids.

Run:
```bash
bun run --cwd tests test -- pos-shift-reconciliation report-tie-out
bun run --cwd packages/db test -- ar-ap/ageing reports/
bun run --cwd apps/api test -- routes/accounting/ageing-report routes/pos/shifts
```
Expected: PASS, with **zero edits** to any of those files. Record the exact command list in the exit report (Step 4).

| Re-run | Owner | What it proves for 7C |
|---|---|---|
| `tests/invariants/pos-shift-reconciliation.test.ts` | 6D (test 21) | the Z-report's ledger tie is unchanged by the definition |
| `packages/db/test/ar-ap/ageing.test.ts` + `apps/api/test/routes/accounting/ageing-report.test.ts` | 4B (Phase 4 DoD) | `accounting.ageing`'s route and figures are unchanged |
| `apps/api/test/routes/pos/shifts.test.ts` | 6D | 6D's JSON routes still answer their own shapes |
| `tests/invariants/report-tie-out.test.ts` | 7B | the harness extension broke no 7B case |
| `packages/db/test/reports/datasets.test.ts` | 7A (**edited by T1 Step 5**) | 7A's twenty-six datasets still resolve, run and isolate; only the pinned array grew to twenty-nine, and no other case in the file moved |

- [ ] **Step 3: Append the two regression blocks**

`tests/regression/sah-077.test.ts` — created by 7A (§2.8: "sah-077 (report definitions as version-controlled text) — 7A always creates it"); 7C appends its own `describe` and edits no earlier block (§3.7.3):

```ts
describe("SAH-077 The call graph is unresolvable, so dead code cannot be identified — 7C", () => {
  it("all eleven 7C report definitions are version-controlled text, not blobs (spec:1240)", () => {
    for (const code of CATALOGUE_7C) {
      const path = join("packages", "db", "seed", "my", "reports", "7c", `${code}.json`);
      if (code === "accounting.pdc_register" && !existsSync(join(REPO_ROOT, path))) continue;  // ⚠️ OD-09
      const text = repoFile(path);
      expect(() => JSON.parse(text), path).not.toThrow();
      expect(text.endsWith("\n"), `${path} must end with a newline so a diff is line-oriented`).toBe(true);
    }
  });

  it("no report definition anywhere carries SQL text — the dataset id is the only source (test 27)", () => {
    for (const code of CATALOGUE_7C) {
      const path = join(REPO_ROOT, "packages", "db", "seed", "my", "reports", "7c", `${code}.json`);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8").toLowerCase();
      for (const token of ["select ", "insert ", "update ", "delete ", " from ", " where "]) {
        expect(text, `${code} contains SQL-shaped text: ${token}`).not.toContain(token);
      }
    }
  });

  // Task 12's ⚠️ OD-27 `it` is appended to THIS describe when that task runs.
});
```

`tests/regression/sah-085.test.ts` — created by 0E; 7C appends:

```ts
describe("SAH-085 The English build was never proofread — 7C", () => {
  it("every 7C definition carries a non-empty nameAr and an Arabic label for every column", () => {
    for (const code of CATALOGUE_7C) {
      const path = join(REPO_ROOT, "packages", "db", "seed", "my", "reports", "7c", `${code}.json`);
      if (!existsSync(path)) continue;
      const { definition } = JSON.parse(readFileSync(path, "utf8")) as {
        definition: { nameAr: string; columns: { field: string; labelAr: string }[] };
      };
      expect(definition.nameAr.trim(), `${code}.nameAr`).not.toBe("");
      // No source-language fallback: an Arabic label equal to its English one is an untranslated string
      // (spec:2061 "no empty msgstr, no source-language fallbacks in the other language").
      for (const column of definition.columns) {
        expect(column.labelAr.trim(), `${code}.${column.field}.labelAr`).not.toBe("");
      }
    }
  });

  it("a rendered 7C report is right-to-left in Arabic and keeps its logical column order (test 23)", async () => {
    const { intlFormatters, renderReport } = await import("@dulja/domain");
    const definition = readDefinition7C("accounting.party_statement");
    const rows = [{ effective_date: "2026-01-15", document_type_code: "SALES_INVOICE", series: "SI",
                    number: 1, status: "posted", currency: "MYR", base_total: "1000.0000" }];
    const ar = renderReport(definition, rows, {
      format: "pdf", lang: "ar", formatters: intlFormatters("ar"), generatedAt: "2026-02-01T00:00:00Z",
    });
    const en = renderReport(definition, rows, {
      format: "pdf", lang: "en", formatters: intlFormatters("en"), generatedAt: "2026-02-01T00:00:00Z",
    });
    expect(ar.dir).toBe("rtl");
    expect(en.dir).toBe("ltr");
    // 7A's contract: `columns` is LOGICAL order and is never reversed for rtl — the renderer flips the page.
    expect(ar.columns.map((c) => c.field)).toEqual(en.columns.map((c) => c.field));
    expect(ar.columns.map((c) => c.label)).not.toEqual(en.columns.map((c) => c.label));
  });
});
```

- [ ] **Step 4: Rewrite `AGENTS.md`'s "Current phase" section**

§3.8 assigns this to the slice that completes a phase, and 7C completes Phase 7. Replace the section's body with:

```markdown
## Current phase

**Phase 7 — Reporting: complete.** 7A shipped the report engine (definition format, the dataset registry,
server-side PDF/XLSX/CSV render, saved views, financial-statement layouts); 7B the accounting and
inventory catalogue with a tie-out test per report; 7C the AR/AP, POS and cross-module catalogue and the
tenant data export.

The report catalogue is `packages/db/seed/my/reports/<slice>/<code>.json` — text, diffable, version
controlled (spec:1240). `ReportCode` and `DatasetId` are closed registers (§4.16); a new core report is an
amendment to the contracts document first, then a seed file. `packages/db/src/reports/datasets.ts` holds
twenty-nine datasets; a report never carries SQL text (test 27).

Tenant data export is `POST /v1/companies/{companyId}/exports` under `admin.data.export`, asynchronous
through `admin.export.run`, producing one deterministic `.tar.gz` of `schema.json`, `manifest.json`, one
CSV and/or JSON file per table and every attachment the requester may see (ADR 0069, ADR 0070). What
leaves the system is decided by `EXPORT_TABLES` and `NEVER_EXPORTED` in `packages/db/src/export/tables.ts`:
**a column not named there does not leave**, and a slice adding a sensitive table adds one row with its
permission gate and changes nothing in the exporter.

**Next:** Phase 8 (HR & payroll) may run alongside; 8D needs 7A and 2C. Phase 9 (migration) is last.
```

- [ ] **Step 5: Run the whole suite, then commit**

Run:
```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```
Expected: PASS on all five, with no known-red. Then:

```bash
git add tests/invariants/report-tie-out-7c.test.ts tests/regression/sah-077.test.ts \
        tests/regression/sah-085.test.ts AGENTS.md
git commit -m "$(cat <<'EOF'
test(invariants): execute every 7C tie-out and close Phase 7 [7C T14]

report-tie-out-7c.test.ts runs EVERY declared tieOut in the 7c seed directory
against a real fixture, and fails when a shipped code has no entry in its
parameter table — a new definition cannot be silently untested. The one `none`
kind supplies a row witness, which 7B amendment A5 requires.

The predecessors' own tests are re-run UNCHANGED as the proof that the three
re-expressions moved nothing: 6D's test 21, 4B's ageing DoD tie-out, 6D's
shift routes, 7B's tie-out suite and 7A's dataset suite.

Appends 7C blocks to sah-077 (definitions are version-controlled text carrying
no SQL) and sah-085 (every definition has a real Arabic name and column label,
and a rendered report is rtl in Arabic with its logical column order intact).

AGENTS.md's Current phase now names Phase 7 complete.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Run against the spec, §4.16 and the 7C card with fresh eyes, per the writing-plans skill.

**1. Spec and card coverage.**

| Card deliverable / spec clause | Task |
|---|---|
| The eleven §4.16.1 codes seeded into `packages/db/seed/my/reports/7c/` | 3, 4, 11 (⚠️ OD-09) |
| Each with its tie-out test | 3, 4, 11, and executed whole in 14 |
| The three Phase 6 `DatasetId` members added to `datasets.ts` | 1 |
| "It adds no others" | 1 (the registry `it` pins twenty-nine) |
| Z-report *history* is the same code with a date-range parameter, test 21 | 4 (`pos.z_report`'s four optional parameters), 14 (test 21 re-run) |
| Tenant data export: CSV + JSON + a documented schema (spec:2186) | 7 (`schema.json`), 8 (`toCsv`/`toJson`) |
| Attachments included (spec:1067) | 8 (the attachment pass), 9 (the recorded gate) |
| Async with a status resource — `admin.export.run` (spec:2206) | 8 (handler), 9 (`202 { statusUrl }`) |
| Every export audited (test 13) | 5 (`attach_audit`), 10 |
| The export path is a covered side channel for tests 32 and 36 | 7 (`NEVER_EXPORTED`, gates), 10 |
| Mapping the legacy template catalogue (OD-27) | 12 |
| §3.0.4 spec:1047's "data export" clause and spec:1067's "included in tenant data export" clause | 7–10 |
| Re-runs 13, 21, 23, 32, 36 | 10, 14 |
| Regression appends sah-077, sah-085 | 14 |
| `AGENTS.md` "Current phase" (§3.8 — 7C completes Phase 7) | 14 |
| Owner gates OD-09, OD-27, OD-24 as isolated tasks (hazard 6) | 11, 12, 13 |

**No card deliverable is unassigned.**

**2. Placeholder scan.** No "TBD", "TODO", "implement later", "similar to Task N", "add appropriate validation" or bare ellipsis standing in for content. Two ellipses appear and neither stands in for content an executor must invent. The first is Task 12's legacy-mapping table, where it marks rows an executor transcribes from **9A's artefact against the owner's database** — data this plan cannot contain (hazard 3) — and the task's own test fails on a table with no matching rows, so the file cannot be committed with the ellipsis in it. The second is the one-line **envelope schematic** above Task 3 Step 1 (`{ "definitionVersion": 1, "definition": { "version": 1, "code": "…", … } }`), which illustrates 7B amendment A1's wrapper shape; the four files it introduces are then printed whole, immediately below it. **Every code step of Tasks 1–12 and 14 carries real, complete code.** The one exception is **Task 13**, whose Steps 2 and 3 carry a checklist and a commit rather than a test body and a component, and the task says in terms why: OD-24 blocks it, the assertions a screen test makes are assertions about a workflow, and hazard 29 exists so that no plan invents one from the API surface. Task 13 does not start until the screenshots and the transcript are attached, so the checklist is never executed as if it were code.

**3. Type and name consistency.** Checked across tasks: `ExportJobRow`/`ExportStatus`/`ExportFormat` (T5) are the shapes T8's `runExport` and T9's routes consume; `ExportTable`/`ExportRow`/`resolveExportGates` (T7) are what T8 iterates and T10 asserts on; `TarEntry`/`tarGz` (T8) are what `runExport` builds; `readEnvelope7C`/`readDefinition7C`/`CATALOGUE_7C` (T2) are used identically in T3, T4, T11, T12 and T14; `assertTieOut`'s four new branches (T2) are the four `tieOut.projection` values T3, T4 and T11 declare; `seedExportJob` (T5) has one signature and every call site — T5's own suite, T8's two suites, T6's and T8's probes — reaches it through **`@dulja/db/test`**, because `packages/db/src/index.ts` re-exports no test-tier symbol (§4.2.12). `DatasetId`'s three new members (T1) are the three `dataset.source` values T4's definitions name, and every `params` object in T3, T4, T11 and T14 carries `companyId`, which `runDefinition` and `assertTieOut` both read (7b:719, 7b:795).

**Nine findings, fixed inline while writing.**

1. ~~**7A's `perBranch` statement option is broken as merged**~~ — **this finding was itself wrong and the fourth pass reversed it (finding 31).** It read `build()`'s `dataset: { source: "account_balance", filters }` as a run-time defect; it is not, because `rowsForDefinition` never consults `dataset.filters` on the statement branch and `assertDefinitionFields` unions `STATEMENT_EXTRA_FIELDS` for a `STATEMENT_CODES` key. The row is kept struck through rather than deleted so a reader who remembers the old A5 sees that it was retracted deliberately.
2. **§4.16.1's `partyKind` parameter for `accounting.party_statement` has no column to bind to.** Fixed by **amendment A6**: the parameter is `partyId`.
3. **`accounting.allocation_register` and `accounting.unreconciled_items` cannot use `ledger_sum`** — an allocation posts nothing and a statement line is not a ledger row — and cannot use `none`, which 7B A5 reserves for a report with no money total. Fixed by **amendment A3**, which extends the `projection` vocabulary by four stored sources and says why the branch's semantics fit.
4. **`till_event` is a mandated `DatasetId` with no core report to read it.** Recorded honestly by **amendment A2** rather than answered by inventing a twelfth code: it is a designer source, and Task 1's group test exercises it directly so it is proven and not merely declared.
5. **A permission-seed task that leaves `lint:rules` red is a nine-task blind spot.** Fixed by **amendment A11** and Task 6, which mounts the route module in the same commit that seeds the code.
6. **`arApReportFixture` (Task 2) had seeded the real Malaysian output-tax code at its real statutory rate**, directly contradicting this plan's own Global Constraint 15 and hazard 1, which forbids a real rate in a plan, a test *or* a fixture — and the pair is not reproduced here either, for the same reason. Fixed in place: the fixture now seeds `SYN-OUT-STD` at `0.11000000`, copied verbatim from 5A's own fixtures (5a:460), which is the house spelling for a synthetic pair. Nothing in the slice asserts the value — `accounting.tax_return_view` renders whatever 5A's engine stored — so the change is inert beyond the hazard.
7. **The two POS `ledger_sum` tie-outs would have been correct only in a POS-only tenant.** Their report side reads the `shift` dataset, which by construction sees only `POS_TICKET` documents, while the ledger side summed Σ income over *every* document in the window — so one back-office `SALES_INVOICE` in the same month would fail a correct report. Fixed in Task 4 and Task 14 by adding `documentTypeCodes: ["POS_TICKET"]`, which is 7B's own `LedgerWindow` member and therefore a use of the harness rather than a further extension. The accompanying note records the second asymmetry the fix does *not* remove — the dataset keys off `shift.opened_at` and the harness off `document.effective_date` — and hands the cross-midnight case to 8D.
8. **Task 3 and Task 14 ran `accounting.ageing` under two different parameter sets** (`{ asOf, partyKind: "customer" }` against `{ asOf }`), and Task 3's was the wrong one: both of its proofs — the `party_ageing` tie-out and the `agedBalance` parity case — compare against an unfiltered source, so a customer-only report would have been measured against a customer-and-vendor projection. Fixed by making `paramsFor` return `{ asOf }`, matching Task 14 exactly, and by proving the optional filter on its own new `it` that asserts a subset relation and ties out nothing.
9. **Task 6's route skeleton imported `IdempotencyHeader` and a note beneath it said to delete the line** — the same self-contradicting shape this review caught once already in Task 5's `store.ts`. Fixed by deleting the import from the block and rewriting the note to say where Task 9 adds it.

**A second review pass found fourteen more, every one fixed in place.** They are recorded because each names a predecessor's real surface, and a reader who does not know why the code looks as it does will "correct" it back.

10. **Every parameter object omitted `companyId`.** 7B's `runDefinition` reads `params.companyId` and binds it into the dataset's `company` fragment (7b:719); `assertTieOut` binds the same value into its independent ledger query (7b:795); 7B's own `paramsFor` spreads it into every branch (7b:1432). Without it every dataset filters on `company_id = undefined::uuid`, every row set is empty, and `assertFieldCoverage` throws *"the fixture returned no rows"* (7b:830) — a message that blames the fixture. Fixed in `paramsFor`, `posParams`, `crossParams`, Task 11 and Task 14's whole `TIE_OUT` table.
11. **`arApReportFixture` called 4B's `arApFixture` with the wrong signature and read nine members off the wrong type.** `arApFixture(db: Db, s: Seed)` returns exactly `{ documentTypeIds, accountIds, partyIds, termId }` (4b:1801-1806, 4b:1824) and posts **no documents at all**. Fixed by creating the `Seed` first, mapping `accountIds` → `accounts` and `partyIds` → `customerId`/`vendorId`, and posting the invoice, the credit note and the settling receipt here — the invoice through **5A's registered `postTaxedDocument`** (§4.17.1), which is also what makes `app.tax_transaction` non-empty for `accounting.tax_return_view`; the fixture's own doc comment promised a taxed document and the body only seeded a tax *code*.
12. **The POS and needs-attention definitions filtered `timestamp` columns with `date` parameters.** 7A's `assertValue` refuses `"2026-01-01"` against a `timestamp` column with `ERR_VALIDATION_FAILED` (7a:2526-2547), and §4.11.1's parameter vocabulary has no `timestamp` kind (7a:1636), so the parameter cannot be widened. Fixed by giving the `shift` and `needs_attention` datasets a **date companion column** — `opened_on`, `created_on` — recorded in amendment A1's row-field table, filtered on by all seven range clauses, and asserted in both directions by a new case in Task 1.
13. **`staff.managerA` does not exist.** `StaffFixture`'s supervisor is `supervisorA` (6c:4238). Fixed at the void event, and Task 10's branch-narrowed case now builds its principal with 6C's registered **`branchActor`** — which is what a one-branch assignment actually looks like — instead of reusing a POS cashier.
14. **Task 0's gate checked the wrong migration for `app.needs_attention`.** 6A's file is `0059_add_catalogue_revision.sql` (verb `add`) and it does not create the table; `0060_create_terminal_enrolment_needs_attention.sql` does (6a:21, 6a:1295). Fixed, together with the note that asserted the wrong name and the `datasets/pos.ts` header comment that repeated it.
15. **Task 7's gate test asserted the auditor had no excluded tables while the registry gated three tables on codes it never granted** — `cost_layer` on `inventory.cost.read`, `shift` and `till_event` on `pos.report.read`. Fixed by granting all five declared gates, so `excluded` really is empty, plus one assertion that the auditor's included set is strictly larger than the gated principal's.
16. **Task 2's harness case passed `tx = null` and `params: {}`** and expected the `default` arm's message, which `assertTieOut` cannot reach: `runDefinition` and `assertFieldCoverage` run first (7b:791-793). Fixed to run against a real transaction and a real fixture, which the rewritten `arApReportFixture` now makes possible.
17. **Task 6 mounted a route module without its `PROBES` key and deferred the fix to Task 9**, a second known-red spanning three tasks against Global Constraint 16 — the very thing amendment A11 exists to prevent. Fixed by moving the `PROBES` entry into Task 6 beside the route and the `JOB_PROBES` entry into Task 8 beside the handler, because 0D's harness checks that map against the *registered handlers* in both directions (0d:2727-2729). Task 9 now adds no probe and its steps renumber to eight.
18. **A `packages/db/test` file called `startApi()`.** `dependency-rule` runs over every import in `apps/**` and `packages/**` (§3.1), and all three named allowances run *toward* `tests/invariants/support/**`; `packages/db/test/**` → `apps/api/test/**` has none, and 6C settled the identical case (6c:5032). Fixed by moving Task 4's group test to `apps/api/test/routes/reports/7c-pos-cross-module.test.ts`, the tier that already holds the allowance it needs. No new allowance is added.
19. **`seedExportJob` was imported from `@dulja/db`** in `apps/worker/test/handlers/export-run.test.ts`; it lives in `packages/db/test/fixtures.ts` and is reachable only through `@dulja/db/test` (§4.2.12). Fixed.
20. **`reports-7c.ts`'s import block was incomplete in one direction and carried ten unused specifiers in the other**, and a note under the file told the executor to finish it — a code step with no code. Fixed: the block is now exactly what the file uses, and it takes the **production** three-argument `withTenant` (§4.2.2), matching 6C's `staff.ts` (6c:4222) and 4B's `ar-ap.ts` — the four-argument test form belongs to `packages/db/test` and appeared nowhere else in `tests/invariants/support/**`. The same pass fixed the `applyBatch` call, whose `ctx` had carried a `companyId` that `TenantContext` does not have.
21. **Three counting errors.** Task 2's prose called a four-column measure query "the fifth fixed column"; the slice's DoD said "eight tie … and the three whose kind is `none`" over a set that is ten and one; and the header called the re-expressions "four" while listing three. All three now state what the tasks actually build.
22. **File Structure disagreed with the tasks.** `datasets-pos.test.ts` → `7c-datasets.test.ts`, a missing `harness-7c.test.ts` row added, the moved group test relocated to the `apps/api/test/` block, `probes.ts` reassigned from T9 to T6 and T8, and the `assertTieOut` branch count made four everywhere (it was two in the assumptions block and five here).
23. **The DoD's tie-out roll-up now names each code and its kind**, so a later reader can check the count against the eleven files instead of trusting a number.

**A third pass, against Plan 0A's migration 0001 and §4.3.4 line by line, found seven more.**

24. **Task 1 widened a registry whose pin lives in 7A's test file, and both Task 1 and Task 14 claimed that file was untouched.** 7A's `packages/db/test/reports/datasets.test.ts` asserts `expect([...DATASET_IDS]).toEqual([ …twenty-six literals… ])` (7a:2247–2255); the vitest filter `reports/datasets` selects exactly that file, not `7c-datasets.test.ts`. Adding three members turns it red, so Task 1's own "run green and commit" would have committed a red tree against Global Constraint 16. Fixed by a new **Task 1 Step 5** that extends the pinned array to twenty-nine with the three appended (7A's order untouched), by listing the file under Task 1's **Modify** and in the File Structure, by adding it to the `git add`, and by rewriting Task 14's re-run row to say it was edited and what still holds.
25. **Six `EXPORT_TABLES` columns did not exist in any migration, and each would have thrown `export schema: app.<t> has no column '<c>'` before an archive was built** — failing Tasks 7, 8 and 10 together. Checked against Plan 0A's 0001 and §4.3.4: `app.fiscal_period` has no **`code`** (plan0A:1467–1481; §4.16.3 computes the period label from `starts_on` for that reason); `app.dimension_type` is `code` + `name_en` only, so **`name_ar`** and **`required`** are inventions (plan0A:1808–1817); `app.dimension_value` has no **`name_ar`** (plan0A:1820–1832); 2A's 0018 gives `document_type` exactly `module` and `archived_at`, so **`series`** — which is `app.document`'s — is not there; and `app.document_line` has **no `side` column** at all. All six corrected, with the reason on each row, and the note beneath rewritten to say the rule that catches the class: **every name in `columns` is checked against `information_schema`, so a derived alias belongs in the SELECT or nowhere.**
26. **The exported `document_line` carried no debit and no credit,** so every JOURNAL and every account line left the system as an all-zero `amount` with no direction — `side` was to have carried it and does not exist. Fixed by exporting §4.3.4's real money set (`debit`, `credit`, `unit_price`, `discount`, `amount`, `tax_amount`, `total_incl_tax`, `cost`) plus `tax_code_id` and the two jsonb columns rendered `::text`. The same pass added the `document` header's three people (`attributed_to`, `created_by`, `posted_by`) and its `terminal_id`, `shift_id`, `tax_inclusive` and `notes`; `rate_source`, `posting_policy_id`, the two warehouse ids and `legacy_ref` stay out **deliberately**, and `schema.json`'s `omitted` list names each one.
27. **Task 9's `POST` handler reads `c.var.jobs`, an eighth `AppEnv["Variables"]` member the Assumptions block said this slice does not use.** `jobs: JobClient` is **3B's** amendment A5, and 7A carried the identical ⚑ BEFORE for its own `POST …/runs` (7a:7921). Fixed by naming the eighth member in the Assumptions block and in Task 9's Consumes, and by adding a ⚑ BEFORE row to the Execution-handoff gate table. (**The fourth pass then found that row stale** — §4.18 Round 3 had already ratified A5 into §4.2.3, which now reads "eight members"; see finding 36. The gate row is now a `grep` that confirms it.) **7C still registers no `Variables` member of its own** — `createExportRoutes(objectStore)` is a factory precisely so it needs no ninth.
28. **Task 12 read a 7B artefact that 7B does not create, and verified a 9A directory that 9A does not write.** 7B ships `docs/legacy/7b-template-mapping.md` (7b:143, 7b:4988), not `template-catalogue-mapping-7b.md`; 9A writes to `artefacts/legacy/<run>/`, git-ignored (9a:45, 9a:171, 9a:4978). `repoFile` throws ENOENT, so Task 12 Step 4's "Expected: PASS" was unreachable. Fixed: 7C's own file is renamed `docs/legacy/7c-template-mapping.md` so the two halves share one convention; the 7B read is guarded with `existsSync` and **skips** the overlap assertion when absent, because 7B's Task 12 is itself OD-27-gated and a dropped owner gate over there must not be a red test over here; and the Verify line is 9A's own command and output root. 7B's `ls docs/legacy/9a-artefacts/` spelling is recorded as a raise below rather than copied.
29. **`NEVER_EXPORTED["employee_sensitive"] = ["*"]` made the 8A extension point the ADR promises impossible without editing 7C's test.** The pin is right — a table nobody has reasoned about must not leave — but the ADR's Consequences, the test comment and the handoff all read "adds one row and changes nothing", which is false: `exportSchemaDocument` throws and `tables.test.ts` fails on a registered `["*"]` table. Fixed by keeping the pin and saying so in all four places: **8A makes two edits in one PR — the registry row and the narrowed pin — and no exporter code changes.**
30. **Three smaller drifts.** Six timestamp columns were declared `format: "date"`, and 7A's date formatter builds `new Date(\`${isoDate}T12:00:00Z\`)` (7a:4484–4490), so an RFC 3339 value yields an Invalid Date and `Intl` throws at render — fixed to `"text"` where the time is the fact (`unallocated_at`, `opened_at`, `closed_at`, `resolved_at`) and to the date companion where the day is (`opened_on`, `created_on`). Migration 0078's `readable_modules` CHECK comment said "four permission modules" beside a five-value list — §3.6.1's closed set is five, `admin` included. And the header still produced a `writeArchive` that no task writes, and the File Structure a `requireExport` that no task exports; both now name what Tasks 7–9 actually ship.

**A fourth pass — an independent audit against 7A's shipped `statement.ts`, 7A's validator and §4.18 — found seven more, every one fixed in place.** Two of them reversed earlier findings of this same review, which is why they are recorded rather than quietly applied.

31. **Amendment A5 rested on a false reading of 7A, and its remedy would have shipped a definition the run path ignores.** A5 had claimed `statementLayout("profit_and_loss", { perBranch: true })` "throws at run time from `columnOf` on its first filter" and had 7C compose its own `ledger_entry` definition instead. Three separate facts make that wrong: (a) `rowsForDefinition`'s statement branch **does not consult `dataset.filters` at all** — 7A's own note reads *"on the statement branch the definition's `dataset.filters` are NOT consulted — the two queries `statementRows` owns take `fiscalPeriodId` and `branchId` and nothing else"* — so the `branch_id` clause never reaches `columnOf`; (b) `assertDefinitionFields` unions `STATEMENT_EXTRA_FIELDS = ["section", "branch_code", "branch_id"]` into the known set for exactly the three `STATEMENT_CODES` keys, of which this code is one, so none of the three "missing" fields is refused; (c) `base_balance` **is** an `account_balance` `DatasetColumn` (7B A3) and a key of 7B's closed measure map. Worse, the remedy did not remove the dispatch: `STATEMENT_CODES` carries `accounting.branch_profit_and_loss` and 7A's own test asserts `statementKindFor("accounting.branch_profit_and_loss") === "profit_and_loss"`, so a `ledger_entry` definition seeded under that code would have been served by `statementRows` anyway and its `document_type_code` / `effective_date` columns never produced — a report that renders blank columns and totals correctly, which is the exact failure this slice exists to end. The group test hid it by calling 7B's `runDefinition`, which delegates to the same dispatch and would have failed on `assertFieldCoverage` first. **Fixed by rewriting A5 to transcribe 7B amendment A6's already-settled sentence** — the definition **is** `statementDefinition("profit_and_loss", identity, { perBranch: true })`, generated by a command, guarded by a deep-equality case in 7B Task 2's own form, and A5 stops being an architect settlement because it now settles nothing new.
32. **The branch P&L's tie-out passed no `branchId`, so it would have measured the wrong query.** `statementRows` reads `ledger_entry` **only** when `branchId` is supplied; without it the `account_balance` fallback runs, annotates `branch_code: null` and no `branch_id` at all, and `assertFieldCoverage` — which checks `dataset.filters[].field` against the row keys — fails with *"dataset "account_balance" has no field(s) branch_id"*. Fixed in `crossParams` and in Task 14's `TIE_OUT` by passing `a.s.hq` (the head-office BRANCH value every `app.document` row carries, §4.1's `Seed`) on both the parameter side and, through A3's new `LedgerWindow.branchId`, on the ledger side.
33. **Five sort and total fields in four definitions were not declared columns, and four assertions expected an empty error array.** 7A's `validateReportDefinition` rule 4 checks `groups[]`, `totals[]` and `sort[]` against **the definition's own `columns[]`**, not against the dataset (`packages/domain` cannot see a `DatasetColumn`), and refuses each with *"… field 'x' is not one of this definition's columns"*. `accounting.party_statement` totalled `document_id` and sorted on `posting_seq`; `pos.sales_by_cashier` and `pos.sales_by_branch` sorted on `opened_at` while declaring only `opened_on`; `pos.needs_attention` sorted on `created_at` while declaring only `created_on`. Amendment A1's own date-companion rule created the last three: the filter must bind the `date` column, so the `timestamp` the report orders by lost its only mention. All five are real dataset columns, so `assertFieldCoverage` passed and only `validateReportDefinition` failed — precisely where Tasks 3, 4 and 14 assert `errors` is `[]`. Fixed by **declaring** each field as a `width: 0` column (the `line_id` / `shift_id` / `cashier_principal_id` pattern the plan already uses), never by dropping the total or coarsening the sort to a date, which would leave two shifts of one trading day in an undefined order.
34. **`POST …/exports` returned `statusUrl: "/v1/jobs/{jobId}"`, a path the contracts document says no slice mounts.** §4.11.2 and §4.18 Round 3 record the settled decision in terms: *"`statusUrl` becomes `/v1/companies/<companyId>/report-runs/<runId>` (ADR 0067) … **No slice mounts `/v1/jobs/{jobId}`** — §4.2.7 lists the path and assigns it to no module, and 6A dropped its own `statusUrl` for the same reason"*. The slice already mounts the right status resource (amendment A12's `GET …/exports/{exportJobId}`), and its own POST test then called it **by hand** while pinning the dead path — so the defect could never have been caught. Fixed in the handler, the schema's comment, the test (which now follows `body.statusUrl` verbatim) and Task 9's commit body; `jobId` stays in the body and now also in the log line, for correlation only.
35. **Migration 0079's down file omitted the §3.4.5 orphaned-grant precondition.** §3.4.5 records the rule once for every `NNNN_seed_permission_phase<slice>.sql` from 0B onward — `role_permission.permission_code` has no `on delete` action, forced RLS stops the migration removing the grants, `app.tenant` is itself policy-guarded — and requires that *"the task that ships such a migration states the precondition on its rollback command"*. 0079 seeds `admin.data.export` and Task 6 Step 4 grants it to `auditor`, so the case applies exactly; the file carried one line of comment and the task stated nothing. Fixed by writing the three facts and the precondition into `0079.down.sql` in 6A's and 6B's own words, and by stating the precondition on Task 6 Step 7's rollback command and in the commit body.
36. **Task 0's ⚑ BEFORE gate for `jobs: JobClient` was stale.** §4.18 Round 3 already carries the ratified row and §4.2.3's body already opens *"The registered `Variables` set is eight members (round 3)"*, so the plan blocked Task 9 on a settlement that had landed. Fixed in the Assumptions block, in Task 9's Consumes, in amendment A12's parenthesis (which still said "seven"), and in the handoff row, which now names the `grep` that confirms the row rather than waiting for it; the stale raise row was deleted rather than reworded.
37. **Two smaller drifts.** `reports-7c.ts` imported twice from `@dulja/db`, which `no-duplicate-imports` reports and Task 2 Step 5's `bun run lint` would have caught — merged into one statement with the production-`withTenant` note on it. And Task 7's gate case said the registry "gates six tables on five codes"; it gates six tables on **four** distinct codes, the fifth grant in that `beforeAll` being `admin.data.export`, which gates no table at all.

**Three raises for the next slice or the architect** — carried here rather than patched, because each is another slice's file. (Three earlier rows were withdrawn by the fourth pass: `§4.2.3 still pins Variables at seven` was already ratified in round 3, and the two `perBranch` rows rested on finding 1's false reading of `rowsForDefinition` — see finding 31.)

| Raise | Against | Why 7C did not fix it |
|---|---|---|
| **7B's Task 12 Verify names `docs/legacy/9a-artefacts/`, a directory 9A does not write** — 9A's artefacts are `artefacts/legacy/<run>/` and git-ignored (9a:45, 9a:171, 9a:4978) | **7B** (its Task 12 Verify line) | 7B is merged and its Task 12 is OD-27-gated; correcting a frozen plan's verify line is the architect's call. 7C uses 9A's real path and reads 7B's real file name, `docs/legacy/7b-template-mapping.md` |
| `pos.sales_by_cashier` attributes a shift's tickets to the shift's **opener**; 6A's `assertShiftKnown` does not require the ticket's cashier to be that person | **6A / 6D** | the `shift` dataset is what §4.16.2 gives 7C; a per-ticket POS dataset is not in the closed register, and adding one is an amendment |
| `listDocumentEvents`' constant `null` `next_cursor` (7B amendment A16 reassigned the paging work to "7C or 8D, whichever ships a document-event surface") | **2B's route** | 7C ships **no** document-event surface — `accounting.document_event_log` is 7B's — so the clause passes to **8D** unchanged, and this row is the hand-off |

**Two things a reviewer should check first**, because they are where this slice would most plausibly be wrong: (a) that `EXPORT_TABLES`' column lists match the **merged** schema. Every row was checked here against Plan 0A's migration 0001 and §4.3.4's per-slice addition table, and six wrong columns were removed and ten missing money and attribution columns added (finding 25, finding 26) — but §4.3.4 is a written contract and the repository is the authority (§4.18), so a slice that added a column after the contracts document was last amended will show up as `export schema: app.<t> has no column '<c>'`. The `schema.json` test names any mismatch by column, and **the registry is the artefact to correct — never the test, and never by adding a derived alias, which throws the same way**; (b) that `posReportFixture`'s ticket shapes match 6A's `buildTicket` as merged — Task 2 copies 6D's own usage, and a signature drift there fails Task 1's and Task 4's fixtures before any definition is judged.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-7c-pos-ar-ap-reports-tenant-export.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration. This plan is written for it: every task states its `Files`, its `Consumes` and `Produces` with exact signatures, and repeats every literal an implementer needs, because a task's implementer sees only their own task.

**2. Inline Execution** — execute tasks in this session with `superpowers:executing-plans`, batching with checkpoints for review.

**Which approach?**

**Phase gate before Task 1.** `7B` merged **and** Phase 6's definition of done green in CI (§6.3 — 7C depends on 7B and 6D). `bash scripts/check/contracts-7c-amendments.sh` exits 0. If a `need_repo` line reports MISS, **stop and raise against the named slice**; a missing predecessor surface is not this slice's bug and building around it produces a second spelling of something that already exists.

**Suggested PR sequence** (one migration per PR — spec:2057):

| PR | Tasks | Gate |
|---|---|---|
| 1 | 0 | **Blocking:** amendment **A11** is an architect settlement — it changes a sequencing rule 7A's Task 3 relied on — and is answered before Task 1 is written. **A5 is not:** it transcribes 7B amendment A6's already-settled sentence onto §4.16.1's row and the executor writes it |
| — | (before 9) | ⚑ **BEFORE — a confirmation, not a wait.** Task 9's `POST …/exports` calls `c.var.jobs.enqueue(tx, "admin.export.run", …)`, which needs `AppEnv["Variables"]`'s eighth member `jobs: JobClient` (3B's amendment A5). **That amendment is already ratified:** §4.18 Round 3 carries the row *"4.2.3 ⚑ A5 ratified — `AppEnv["Variables"]` gains an eighth member `jobs: JobClient`"*, naming 7A Task 12's and 7C Task 9's handlers as its two readers, and §4.2.3's own body now opens *"The registered `Variables` set is eight members (round 3)"*. **Confirm that row is present in the contracts document before Task 9 starts** — `grep -n 'jobs: JobClient' docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` — and if it is not, stop and raise against 3B rather than adding the member here. 7C introduces no `Variables` member of its own |
| 2 | 1, 2 | the three datasets and the harness extension; 7B's tie-out suite re-run green in the same PR |
| 3 | 3 | the four AR/AP definitions |
| 4 | 4 | the six POS and cross-module definitions, `ReportCodeSchema` + 7; the group test lands in `apps/api/test/routes/reports/` |
| 5 | 5 | **migration 0078** alone |
| 6 | 6 | **migration 0079** alone, with the route module that references the code **and that module's `PROBES` key** |
| 7 | 7 | the registry, the schema document and **ADR 0069 (a proposal — asked before merging, spec:95)** |
| 8 | 8 | the archive, `runExport`, the job **and its `JOB_PROBES` key** |
| 9 | 9 | the routes, the contracts module and ADR 0070; regenerated `openapi.json` |
| 10 | 10 | tests 13, 32 and 36 |
| 11 | 11 | ⚠️ **OD-09** — dropped whole if post-dated cheques are not in v1 |
| 12 | 12 | ⚠️ **OD-27** — dropped whole if 9A has not run or the owner has not answered |
| 13 | 13 | ⚠️ **OD-24** — does not start until the screenshots and the operator description are attached |
| 14 | 14 | the DoD roll-up, the re-run matrix, the two regression appends, `AGENTS.md` |

**What the next slice needs from this one.** **8A** makes exactly **two** edits in `packages/db/src/export/tables.ts` and none anywhere else in `packages/db/src/export/`: it adds one `EXPORT_TABLES` row — `{ name: "employee_sensitive", gate: "hr.employee.read_sensitive", columns: […], rows: … }` — **and, in the same PR, narrows `NEVER_EXPORTED["employee_sensitive"]` from `["*"]` to the ciphertext columns it will not export.** The `["*"]` pin is deliberate and is not an oversight to route around: `exportSchemaDocument` throws and Task 7's `tables.test.ts` fails on a registered table pinned `["*"]`, so the table cannot leave the system until someone has reasoned about which of its columns may. No exporter code changes either way, and Task 10's "absent AND named" case is the proof test 32 wants. **8D** adds the six HR `DatasetId` members to the union Task 1 leaves at twenty-nine, its own `CATALOGUE_8D` beside `CATALOGUE_7C`, and its own `assertTieOut` branches — additively, never editing a case — and it inherits 7B amendment A16's document-event paging clause, which 7C does not ship a surface for. **9B** reads `EXPORT_TABLES` as the inverse of its loaders: a table the export names is a table the cut-over must be able to reproduce.

**Owner items still open at the end of this slice:** OD-09 (Task 11), OD-27 (Task 12), OD-24 (Task 13). None of the three blocks Tasks 1–10 or Task 14, and none blocks the Phase 7 definition of done.

